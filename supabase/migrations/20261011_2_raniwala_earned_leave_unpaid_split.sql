-- Raniwala: Earned Leave applied beyond the balance is split, not refused.
--
-- User (2026-10-11): "if anyone applies for a leave of 5 days but he got 3
-- balance so 3 will be paid leaves from earned leave balance and the rest 2
-- leaves will be unpaid leave but make sure the employee should aware of it".
--
-- * leave_requests.unpaid_days: days of the request NOT covered by the
--   Earned Leave balance. They are the LAST days of the request (the balance
--   covers the first ones). Decided by the insert trigger when the employee
--   applies, from: ledger balance - days already held by Pending (or
--   Approved but not yet ledgered) Earned Leave requests, whole days only.
--   0 for every other leave type, tenant and every earlier request.
-- * raniwala_earned_leave_split(profile, start, end[, exclude]) -> jsonb:
--   the same figures for the apply form's preview (web + app).
-- * A request with unpaid days gets the HOD + HR stages like Unpaid Leave.
-- * record_leave_deduction takes only the covered days off the balance.
-- * Approver notifications say "3 from Earned Leave, 2 unpaid"; the
--   employee gets a 'leave_unpaid_days' notification naming the unpaid dates.
-- * Payroll (src/lib/paidDays.js) treats the unpaid days as Loss of Pay.
--
-- The three CREATE OR REPLACE bodies below are the live definitions of
-- 2026-10-11 with only the marked additions.

ALTER TABLE public.leave_requests ADD COLUMN IF NOT EXISTS unpaid_days integer NOT NULL DEFAULT 0;
ALTER TABLE public.leave_requests DROP CONSTRAINT IF EXISTS leave_requests_unpaid_days_check;
ALTER TABLE public.leave_requests ADD CONSTRAINT leave_requests_unpaid_days_check
  CHECK (unpaid_days >= 0 AND unpaid_days <= GREATEST((end_date - start_date) + 1, 0));
COMMENT ON COLUMN public.leave_requests.unpaid_days IS
  'Raniwala Earned Leave: the last N days of the request that the balance did not cover (Loss of Pay). Set by enforce_leave_request_approval_tier.';

CREATE OR REPLACE FUNCTION public.raniwala_earned_leave_split(
  p_profile_id uuid, p_start date, p_end date, p_exclude_request uuid DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant    uuid;
  v_type      uuid;
  v_balance   numeric;
  v_held      numeric;
  v_requested integer;
  v_paid      integer;
BEGIN
  SELECT tenant_id INTO v_tenant FROM profiles WHERE id = p_profile_id;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'Employee not found'; END IF;
  IF auth.uid() IS DISTINCT FROM p_profile_id AND NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND tenant_id = v_tenant AND role IN ('admin', 'superadmin')
  ) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  v_requested := GREATEST((p_end - p_start) + 1, 0);
  SELECT id INTO v_type FROM leave_types WHERE tenant_id = v_tenant AND name = 'Earned Leave' LIMIT 1;
  SELECT COALESCE(sum(l.days), 0) INTO v_balance
    FROM leave_ledger l WHERE l.profile_id = p_profile_id AND l.leave_type_id = v_type;
  -- Days other requests already hold: Pending ones, and Approved ones whose
  -- deduction has not reached the ledger yet.
  SELECT COALESCE(sum((r.end_date - r.start_date) + 1 - r.unpaid_days), 0) INTO v_held
    FROM leave_requests r
   WHERE r.profile_id = p_profile_id AND r.leave_type = 'Earned Leave'
     AND r.id IS DISTINCT FROM p_exclude_request
     AND (r.status = 'Pending'
          OR (r.status = 'Approved' AND NOT EXISTS (SELECT 1 FROM leave_ledger l WHERE l.leave_request_id = r.id)));

  v_paid := LEAST(v_requested, GREATEST(floor(v_balance - v_held), 0)::int);
  RETURN jsonb_build_object(
    'balance', v_balance, 'held', v_held, 'available', v_balance - v_held,
    'requested', v_requested, 'paid_days', v_paid, 'unpaid_days', v_requested - v_paid);
END;
$function$;

REVOKE ALL ON FUNCTION public.raniwala_earned_leave_split(uuid, date, date, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.raniwala_earned_leave_split(uuid, date, date, uuid) TO authenticated;

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
  v_split        jsonb;
BEGIN
  IF auth.role() = 'authenticated' AND auth.uid() = NEW.profile_id THEN

    SELECT EXISTS (
      SELECT 1 FROM tenants WHERE id = NEW.tenant_id AND company_name ILIKE '%Raniwala%'
    ) INTO v_is_raniwala;

    IF v_is_raniwala THEN
      -- Earned Leave beyond the balance: the balance covers the first days,
      -- the rest are unpaid (Loss of Pay). Decided here, once, at applying.
      NEW.unpaid_days := 0;
      IF NEW.leave_type = 'Earned Leave' AND NEW.end_date >= NEW.start_date THEN
        v_split := raniwala_earned_leave_split(NEW.profile_id, NEW.start_date, NEW.end_date, NEW.id);
        NEW.unpaid_days := (v_split ->> 'unpaid_days')::int;
      END IF;

      SELECT * INTO v_route FROM raniwala_leave_route(
        NEW.profile_id, NEW.tenant_id, NEW.start_date, NEW.end_date, (now() AT TIME ZONE 'Asia/Kolkata')::date,
        NEW.leave_type);

      -- Unpaid days need HOD and HR like an Unpaid Leave request (20261010_3),
      -- on top of the Earned Leave route for the whole length. Manager = HOD =
      -- HR keeps its single approval.
      IF NEW.unpaid_days > 0 AND NOT (v_route.o_manager IS NULL AND v_route.o_hod IS NOT NULL
          AND (SELECT role FROM profiles WHERE id = v_route.o_hod) IN ('admin', 'superadmin')) THEN
        v_route.o_hod_status := CASE WHEN v_route.o_hod IS NULL THEN 'Not Required' ELSE 'Pending' END;
        v_route.o_hr_status := 'Pending';
      END IF;

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

CREATE OR REPLACE FUNCTION public.record_leave_deduction(p_leave_request_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_req    RECORD;
  v_type   uuid;
  v_days   numeric;
  v_day    date;
BEGIN
  SELECT * INTO v_req FROM leave_requests WHERE id = p_leave_request_id;
  IF v_req IS NULL THEN RAISE EXCEPTION 'Leave request not found'; END IF;
  IF v_req.status <> 'Approved' THEN RAISE EXCEPTION 'Leave request is not Approved'; END IF;

  IF NOT (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND tenant_id = v_req.tenant_id AND role IN ('admin','manager','superadmin'))
    OR (auth.uid() = v_req.profile_id AND v_req.required_approver_role = 'self')
  ) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  -- Mark every day of the approved leave as 'Leave' on the attendance
  -- calendar. Idempotent by nature of the upsert -- safe to re-run.
  FOR v_day IN SELECT generate_series(v_req.start_date, v_req.end_date, interval '1 day')::date LOOP
    INSERT INTO attendance (tenant_id, profile_id, date, status, total_hours, location)
    VALUES (v_req.tenant_id, v_req.profile_id, v_day, 'Leave', 0, 'Office')
    ON CONFLICT (profile_id, date) DO UPDATE SET status = 'Leave', total_hours = 0;
  END LOOP;

  IF v_req.leave_type = 'Comp Off' THEN RETURN; END IF; -- balance handled by adjust_comp_off_balance instead

  -- Idempotent — a second call for the same request is a no-op.
  IF EXISTS (SELECT 1 FROM leave_ledger WHERE leave_request_id = p_leave_request_id) THEN RETURN; END IF;

  SELECT id INTO v_type FROM leave_types WHERE tenant_id = v_req.tenant_id AND name = v_req.leave_type LIMIT 1;
  IF v_type IS NULL THEN RETURN; END IF; -- no matching configured leave type — nothing to ledger

  -- Only the days the Earned Leave balance covered; the unpaid days are Loss of Pay.
  v_days := (v_req.end_date - v_req.start_date) + 1 - COALESCE(v_req.unpaid_days, 0);
  IF v_days <= 0 THEN RETURN; END IF;

  INSERT INTO leave_ledger (tenant_id, profile_id, leave_type_id, entry_type, days, effective_date, leave_request_id, created_by)
  VALUES (v_req.tenant_id, v_req.profile_id, v_type, 'Deduction', -v_days, v_req.start_date, p_leave_request_id, auth.uid());
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_notify_leave_stage()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_name   text;
  v_desc   text;
  v_new_stage text := leave_current_stage(NEW.manager_status, NEW.hod_status, NEW.hr_status, NEW.management_status);
  v_old_stage text;
  v_ids    uuid[];
  v_actor  uuid := COALESCE(auth.uid(), NEW.profile_id);
  v_fresh  boolean := TG_OP = 'INSERT';
  v_hr_name text;
  v_waiting_on text;
BEGIN
  IF NEW.manager_status IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT trim(concat_ws(' ', first_name, last_name))
         || CASE WHEN COALESCE(outlet_location, '') <> '' THEN ' (' || outlet_location || ')' ELSE '' END
    INTO v_name FROM profiles WHERE id = NEW.profile_id;

  -- Half-day leave (20261013_2, may be applied before or after this file):
  -- read through to_jsonb so this compiles without its columns.
  v_desc := COALESCE(NEW.leave_type, 'Leave') || ', '
            || CASE WHEN to_jsonb(NEW) ->> 'half_day' IS NOT NULL
                 THEN to_char(NEW.start_date, 'DD Mon') || ' — half day, '
                      || CASE to_jsonb(NEW) ->> 'half_day' WHEN 'first_half' THEN 'first half' ELSE 'second half' END
                      || COALESCE(' (' || to_char((to_jsonb(NEW) ->> 'half_day_from')::time, 'FMHH12:MI AM') || ' – '
                                  || to_char((to_jsonb(NEW) ->> 'half_day_to')::time, 'FMHH12:MI AM') || ')', '')
                      || CASE WHEN COALESCE(NEW.unpaid_days, 0) > 0 THEN ', unpaid - no Earned Leave balance' ELSE '' END
                 ELSE to_char(NEW.start_date, 'DD Mon') || ' – '
            || to_char(NEW.end_date, 'DD Mon') || ' (' || COALESCE(NEW.duration_days, NEW.end_date - NEW.start_date + 1) || ' day'
            || CASE WHEN COALESCE(NEW.duration_days, 2) = 1 THEN '' ELSE 's' END
            || CASE WHEN COALESCE(NEW.unpaid_days, 0) <= 0 THEN ''
                    WHEN NEW.unpaid_days >= COALESCE(NEW.duration_days, NEW.end_date - NEW.start_date + 1) THEN ', all unpaid - no Earned Leave balance'
                    ELSE ': ' || (COALESCE(NEW.duration_days, NEW.end_date - NEW.start_date + 1) - NEW.unpaid_days)
                         || ' from Earned Leave, ' || NEW.unpaid_days || ' unpaid' END
            || ')'
               END
            || CASE WHEN NEW.short_notice THEN ' — applied less than 15 days in advance' ELSE '' END;

  IF TG_OP = 'UPDATE' THEN
    v_old_stage := leave_current_stage(OLD.manager_status, OLD.hod_status, OLD.hr_status, OLD.management_status);
    v_fresh := OLD.status = 'Pending' AND OLD.current_stage IS NULL;
  END IF;

  IF NEW.status = 'Pending' AND v_new_stage IS NOT NULL
     AND (v_fresh OR v_new_stage IS DISTINCT FROM v_old_stage) THEN
    v_ids := leave_stage_recipients(NEW, v_new_stage);
    INSERT INTO app_notifications (tenant_id, profile_id, actor_id, type, title, body, link_key, related_id)
    SELECT NEW.tenant_id, r, v_actor, 'leave_request_submitted',
           CASE WHEN v_fresh THEN 'New leave request' ELSE 'Leave request needs your approval' END,
           v_name || ' — ' || v_desc
             || CASE WHEN NOT v_fresh THEN '. Approved by '
                  || CASE v_old_stage WHEN 'manager' THEN 'Manager' WHEN 'hod' THEN 'HOD' WHEN 'hr' THEN 'HR' ELSE 'previous approver' END
                  || ', now needs yours.' ELSE '.' END,
           'leave_requests', NEW.id
    FROM unnest(v_ids) r WHERE r IS NOT NULL AND r <> NEW.profile_id;

    -- HR always gets a new request too, as the record (and can decide it
    -- themselves at any stage) - even while it waits on the manager / HOD.
    IF v_fresh AND v_new_stage <> 'hr' THEN
      SELECT trim(concat_ws(' ', first_name, last_name)) INTO v_waiting_on
        FROM profiles WHERE id = v_ids[1];
      INSERT INTO app_notifications (tenant_id, profile_id, actor_id, type, title, body, link_key, related_id)
      SELECT NEW.tenant_id, r, v_actor, 'leave_request_hr_copy', 'New leave request',
             v_name || ' — ' || v_desc || ' — sent to '
               || COALESCE(NULLIF(v_waiting_on, ''),
                    'their ' || CASE v_new_stage WHEN 'manager' THEN 'manager' WHEN 'hod' THEN 'HOD' ELSE 'approver' END)
               || ' for approval.',
             'leave_requests', NEW.id
      FROM unnest(leave_stage_recipients(NEW, 'hr')) r
      WHERE r <> NEW.profile_id AND NOT (r = ANY (array_remove(v_ids, NULL)));
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.status IN ('Approved', 'Rejected') AND OLD.status = 'Pending' THEN
    IF NEW.hod_id IS NOT NULL AND COALESCE(NEW.hod_status, 'Not Required') = 'Not Required' THEN
      INSERT INTO app_notifications (tenant_id, profile_id, actor_id, type, title, body, link_key, related_id)
      VALUES (NEW.tenant_id, NEW.hod_id, v_actor, 'leave_request_fyi',
              'Team leave ' || lower(NEW.status), v_name || ' — ' || v_desc || '.', 'leave_requests', NEW.id);
    END IF;
    IF COALESCE(NEW.duration_days, 0) >= 4 AND NEW.hr_status = 'Not Required' THEN
      INSERT INTO app_notifications (tenant_id, profile_id, actor_id, type, title, body, link_key, related_id)
      SELECT NEW.tenant_id, r, v_actor, 'leave_request_fyi', 'Leave ' || lower(NEW.status),
             v_name || ' — ' || v_desc || '.', 'leave_requests', NEW.id
      FROM unnest(leave_stage_recipients(NEW, 'hr')) r;
    END IF;

    -- HR decided over a manager / HOD who hadn't acted yet: tell them who did.
    -- actor = the employee, so trg_team_only_request_notifications (which
    -- only lets team members' requests reach a Raniwala manager/HOD) keeps it.
    IF 'Skipped' IN (NEW.manager_status, NEW.hod_status) THEN
      SELECT trim(concat_ws(' ', first_name, last_name)) INTO v_hr_name FROM profiles WHERE id = NEW.hr_decided_by;
      INSERT INTO app_notifications (tenant_id, profile_id, actor_id, type, title, body, link_key, related_id)
      SELECT DISTINCT NEW.tenant_id, r, NEW.profile_id, 'leave_request_fyi',
             'Team leave ' || lower(NEW.status) || ' by HR',
             v_name || ' — ' || v_desc || '. ' || NEW.status || ' by HR'
               || COALESCE(' (' || NULLIF(v_hr_name, '') || ')', '') || ' on your behalf.',
             'leave_requests', NEW.id
      FROM unnest(ARRAY[
        CASE WHEN NEW.manager_status = 'Skipped' THEN NEW.manager_id END,
        CASE WHEN NEW.hod_status = 'Skipped' THEN NEW.hod_id END
      ]) r
      WHERE r IS NOT NULL AND r <> NEW.profile_id AND r IS DISTINCT FROM NEW.hr_decided_by;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;


-- The employee is told which days are unpaid as soon as they apply.
CREATE OR REPLACE FUNCTION public.trg_notify_leave_unpaid_days()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_total integer := (NEW.end_date - NEW.start_date) + 1;
  v_paid  integer := v_total - COALESCE(NEW.unpaid_days, 0);
  v_from  date := NEW.start_date + v_paid;
BEGIN
  IF COALESCE(NEW.unpaid_days, 0) <= 0 THEN
    RETURN NEW;
  END IF;
  INSERT INTO app_notifications (tenant_id, profile_id, actor_id, type, title, body, link_key, related_id)
  VALUES (NEW.tenant_id, NEW.profile_id, NEW.profile_id, 'leave_unpaid_days',
    CASE WHEN v_paid = 0 THEN 'Your leave will be unpaid' ELSE 'Part of your leave will be unpaid' END,
    CASE WHEN v_paid = 0
      THEN 'You have no Earned Leave balance for ' || to_char(NEW.start_date, 'DD Mon')
           || CASE WHEN v_total > 1 THEN ' - ' || to_char(NEW.end_date, 'DD Mon') ELSE '' END
           || ', so all ' || v_total || ' day' || CASE WHEN v_total = 1 THEN '' ELSE 's' END
           || ' will be Unpaid Leave (Loss of Pay) and cut from your salary.'
      ELSE 'Your Earned Leave balance covers ' || v_paid || ' of the ' || v_total || ' days you applied for ('
           || to_char(NEW.start_date, 'DD Mon')
           || CASE WHEN v_paid > 1 THEN ' - ' || to_char(v_from - 1, 'DD Mon') ELSE '' END
           || '). The other ' || NEW.unpaid_days || ' day' || CASE WHEN NEW.unpaid_days = 1 THEN '' ELSE 's' END
           || ' (' || to_char(v_from, 'DD Mon')
           || CASE WHEN NEW.unpaid_days > 1 THEN ' - ' || to_char(NEW.end_date, 'DD Mon') ELSE '' END
           || ') will be Unpaid Leave (Loss of Pay) and cut from your salary.'
    END,
    'leave_requests', NEW.id);
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_notify_leave_unpaid_days ON public.leave_requests;
CREATE TRIGGER trg_notify_leave_unpaid_days AFTER INSERT ON public.leave_requests
  FOR EACH ROW EXECUTE FUNCTION trg_notify_leave_unpaid_days();
