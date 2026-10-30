-- =============================================================
-- Raniwala Jewellers: Unpaid Leave as a second requestable leave type,
-- next to Earned Leave.
--
--   - No balance: is_unlimited, so it is never blocked by (and never shown
--     as) a remaining count. is_paid = false marks it Loss of Pay.
--   - Approval: Manager -> HOD -> HR, ALL of them, whatever the length --
--     unlike Earned Leave, where a short leave stops at the manager. No
--     Management stage. Approvers are the same people as for Earned Leave
--     (profiles.manager_id / hod_id, see resolve_leave_approvers):
--       * no manager on record            -> HOD -> HR
--       * manager is also the HOD         -> HOD -> HR
--       * neither on record               -> HR
--       * manager = HOD = HR (an admin)   -> that one approval, as before
--     HR can still decide at any stage and that decision is final
--     (20261003_3) -- unchanged.
--
-- The rule lives in the DB so the website and the mobile app route the
-- same way: the app only has to send leave_type = 'Unpaid Leave'.
--
-- raniwala_leave_route keeps its 5-argument form untouched (Earned Leave
-- behaves exactly as before); the new 6-argument form takes the leave type
-- and is what the insert trigger now calls. Every other tenant's branch of
-- enforce_leave_request_approval_tier is copied over unchanged.
--
-- On approval record_leave_deduction marks the days 'Leave' on attendance
-- and posts the days against the Unpaid Leave type in leave_ledger, which
-- for an unlimited type is simply the running count of unpaid days taken.
-- =============================================================

DO $$
DECLARE
  v_tenant uuid;
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE company_name ILIKE '%Raniwala%';
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'Raniwala Jewellers tenant not found -- aborting, nothing changed';
  END IF;

  INSERT INTO leave_types (tenant_id, name, is_paid, carry_forward, max_carry_forward_days, accrual_frequency, accrual_days, annual_quota, encashable, max_continuous_days, is_active, is_unlimited)
  VALUES (v_tenant, 'Unpaid Leave', false, false, 0, 'none', 0, 0, false, NULL, true, true)
  ON CONFLICT (tenant_id, name) DO UPDATE SET
    is_paid = false, carry_forward = false, max_carry_forward_days = 0,
    accrual_frequency = 'none', accrual_days = 0, annual_quota = 0,
    encashable = false, max_continuous_days = NULL, is_active = true, is_unlimited = true;
END $$;


CREATE OR REPLACE FUNCTION public.raniwala_leave_route(
  p_profile_id uuid, p_tenant_id uuid, p_start date, p_end date, p_applied_on date, p_leave_type text,
  OUT o_manager uuid, OUT o_hod uuid, OUT o_duration integer,
  OUT o_manager_status text, OUT o_hod_status text, OUT o_hr_status text,
  OUT o_management_status text, OUT o_short_notice boolean)
 RETURNS record
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_hod_role text;
BEGIN
  SELECT r.o_manager, r.o_hod, r.o_duration, r.o_manager_status, r.o_hod_status,
         r.o_hr_status, r.o_management_status, r.o_short_notice
    INTO o_manager, o_hod, o_duration, o_manager_status, o_hod_status,
         o_hr_status, o_management_status, o_short_notice
    FROM raniwala_leave_route(p_profile_id, p_tenant_id, p_start, p_end, p_applied_on) r;

  IF p_leave_type IS DISTINCT FROM 'Unpaid Leave' THEN
    RETURN;
  END IF;

  -- Manager, HOD and HR are one and the same person: their one approval stands.
  SELECT role INTO v_hod_role FROM profiles WHERE id = o_hod;
  IF o_manager IS NULL AND o_hod IS NOT NULL AND v_hod_role IN ('admin', 'superadmin') THEN
    RETURN;
  END IF;

  -- Manager stage is already Pending whenever there is a manager.
  o_hod_status := CASE WHEN o_hod IS NULL THEN 'Not Required' ELSE 'Pending' END;
  o_hr_status := 'Pending';
  o_management_status := 'Not Required';
END;
$function$;


CREATE OR REPLACE FUNCTION public.enforce_leave_request_approval_tier()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_tenant       record;
  v_quota        record;
  v_chain_role   text;
  v_self_limit   integer;
  v_tier         text;
  v_is_raniwala  boolean;
  v_route        record;
BEGIN
  IF auth.role() = 'authenticated' AND auth.uid() = NEW.profile_id THEN

    SELECT EXISTS (
      SELECT 1 FROM tenants WHERE id = NEW.tenant_id AND company_name ILIKE '%Raniwala%'
    ) INTO v_is_raniwala;

    IF v_is_raniwala THEN
      SELECT * INTO v_route FROM raniwala_leave_route(
        NEW.profile_id, NEW.tenant_id, NEW.start_date, NEW.end_date, (now() AT TIME ZONE 'Asia/Kolkata')::date,
        NEW.leave_type);

      NEW.duration_days := v_route.o_duration;
      NEW.manager_id := v_route.o_manager;
      NEW.hod_id := v_route.o_hod;
      NEW.status := 'Pending';
      NEW.approved_by := NULL;
      NEW.approval_level := NULL;
      NEW.manager_status := v_route.o_manager_status;
      NEW.hod_status := v_route.o_hod_status;
      NEW.hr_status := v_route.o_hr_status;
      NEW.management_status := v_route.o_management_status;
      NEW.short_notice := v_route.o_short_notice;
      NEW.requires_hr_approval := NEW.hr_status = 'Pending';
      NEW.current_stage := leave_current_stage(NEW.manager_status, NEW.hod_status, NEW.hr_status, NEW.management_status);
      NEW.required_approver_role := CASE WHEN NEW.current_stage = 'hr' THEN 'admin' ELSE NEW.current_stage END;
      RETURN NEW;
    END IF;

    SELECT leave_auto_approval_enabled, leave_auto_approval_limit
      INTO v_tenant
      FROM tenants WHERE id = NEW.tenant_id;

    SELECT self_approved_count, manager_approved_count
      INTO v_quota
      FROM request_quotas
      WHERE tenant_id = NEW.tenant_id AND profile_id = NEW.profile_id
        AND month = EXTRACT(MONTH FROM now())::smallint
        AND year  = EXTRACT(YEAR  FROM now())::int;

    SELECT step ->> 'role'
      INTO v_chain_role
      FROM approval_chains ac,
           LATERAL jsonb_array_elements(ac.steps) AS step
      WHERE ac.tenant_id = NEW.tenant_id AND ac.entity_type = 'leave_requests' AND ac.is_active = true
      ORDER BY (step ->> 'order')::int
      LIMIT 1;

    v_self_limit := CASE WHEN COALESCE(v_tenant.leave_auto_approval_enabled, true)
                          THEN COALESCE(v_tenant.leave_auto_approval_limit, 3)
                          ELSE 0 END;

    IF v_chain_role IS NOT NULL THEN
      v_tier := v_chain_role;
    ELSIF v_self_limit > 0 AND COALESCE(v_quota.self_approved_count, 0) < v_self_limit THEN
      v_tier := 'self';
    ELSIF COALESCE(v_quota.manager_approved_count, 0) < 5 THEN
      v_tier := 'manager';
    ELSE
      v_tier := 'admin';
    END IF;

    NEW.required_approver_role := v_tier;
    IF v_tier = 'self' THEN
      NEW.status := 'Approved';
      NEW.approval_level := 'self';
    ELSE
      NEW.status := 'Pending';
      NEW.approval_level := NULL;
      NEW.approved_by := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
