-- 20261024_1: L1 SPOC — a colleague who uses the app for employees who can't.
--
-- Raniwala factory staff often don't know how to use the app. HR names an
-- "L1" (single point of contact) for them, e.g. Vishnu Rajawat (694) for the
-- filing/ghat/polish workers. The L1 keeps using the app for themselves, and
-- for each employee assigned to them can:
--   * see attendance (calendar, punches), leave requests, regularize requests,
--     leave balance and comp-off balance,
--   * apply leave and request regularization on the employee's behalf.
--
-- The L1 is NOT an approver. A request filed by the L1 is the employee's own
-- request in every way: it routes to the employee's manager / HOD / HR exactly
-- as if the employee had sent it from their own phone (raniwala_leave_route,
-- the regularize window, stage notifications, …). Only submitted_by records
-- that the L1 typed it.
--
-- How "exactly as if the employee sent it" works: the request triggers read
-- auth.uid() (who is submitting) for routing, the window check and the
-- notifications. l1_request_leave / l1_request_regularize check the L1 link,
-- then switch the transaction's JWT subject to the employee just for the one
-- INSERT and switch it back. The triggers therefore need no change.

-- ── Link ──────────────────────────────────────────────────────────────────
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS l1_spoc_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.profiles.l1_spoc_id IS
  'L1 SPOC: colleague who can view this employee''s attendance/leave and file leave + regularize requests for them. Not an approver. HR only.';

CREATE INDEX IF NOT EXISTS profiles_l1_spoc_id_idx
  ON public.profiles (l1_spoc_id) WHERE l1_spoc_id IS NOT NULL;

-- Who typed a request when it wasn't the employee (an L1). NULL = the employee.
ALTER TABLE public.leave_requests
  ADD COLUMN IF NOT EXISTS submitted_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;
ALTER TABLE public.regularize_requests
  ADD COLUMN IF NOT EXISTS submitted_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

-- ── Guard: only HR sets the L1, same tenant, never yourself ────────────────
CREATE OR REPLACE FUNCTION public.trg_profiles_l1_spoc_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.l1_spoc_id IS NOT DISTINCT FROM (CASE WHEN TG_OP = 'UPDATE' THEN OLD.l1_spoc_id END) THEN
    RETURN NEW;
  END IF;
  IF auth.uid() IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM profiles WHERE id = auth.uid()
         AND (role = 'superadmin' OR (tenant_id = NEW.tenant_id AND role = 'admin'))
     ) THEN
    RAISE EXCEPTION 'Only HR can change an employee''s L1';
  END IF;
  IF NEW.l1_spoc_id = NEW.id THEN
    RAISE EXCEPTION 'An employee can''t be their own L1';
  END IF;
  IF NEW.l1_spoc_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM profiles WHERE id = NEW.l1_spoc_id AND tenant_id = NEW.tenant_id
     ) THEN
    RAISE EXCEPTION 'The L1 must be in the same company';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS profiles_l1_spoc_guard ON public.profiles;
CREATE TRIGGER profiles_l1_spoc_guard
  BEFORE INSERT OR UPDATE OF l1_spoc_id ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION trg_profiles_l1_spoc_guard();

-- ── Who I am L1 for ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.my_l1_member_ids()
RETURNS uuid[]
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(array_agg(e.id), '{}'::uuid[])
  FROM profiles e
  WHERE e.l1_spoc_id = auth.uid() AND e.id <> auth.uid() AND COALESCE(e.status, 'Active') = 'Active';
$function$;

REVOKE ALL ON FUNCTION public.my_l1_member_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_l1_member_ids() TO authenticated, service_role;

-- The L1's list, with only what the screens need (no bank / PAN / pay).
CREATE OR REPLACE FUNCTION public.my_l1_members()
RETURNS TABLE (
  id uuid, first_name text, middle_name text, last_name text, employee_id text,
  role text, department text, designation text, division text,
  outlet_id uuid, outlet_location text, phone text, join_date date,
  shift_id uuid, weekly_holiday text,
  comp_off_balance numeric, comp_off_eligible boolean, overtime_applicable boolean,
  manager_id uuid, manager_name text, hod_id uuid, hod_name text
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT e.id, e.first_name, e.middle_name, e.last_name, e.employee_id,
         e.role, e.department, e.designation, e.division,
         e.outlet_id, e.outlet_location, e.phone, e.join_date,
         e.shift_id, e.weekly_holiday,
         e.comp_off_balance, e.comp_off_eligible, e.overtime_applicable,
         e.manager_id, NULLIF(concat_ws(' ', m.first_name, m.last_name), ''),
         e.hod_id, NULLIF(concat_ws(' ', h.first_name, h.last_name), '')
  FROM profiles e
  LEFT JOIN profiles m ON m.id = e.manager_id
  LEFT JOIN profiles h ON h.id = e.hod_id
  WHERE e.l1_spoc_id = auth.uid() AND e.id <> auth.uid() AND COALESCE(e.status, 'Active') = 'Active'
  ORDER BY e.first_name, e.last_name;
$function$;

REVOKE ALL ON FUNCTION public.my_l1_members() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_l1_members() TO authenticated, service_role;

-- ── Read access to the L1's people (SELECT only) ───────────────────────────
-- Punches follow attendance: their read policy is "attendance rows I can see".
-- leave_balances_detail is a security_invoker view over leave_ledger.
DROP POLICY IF EXISTS "attendance: l1 sees own people" ON public.attendance;
CREATE POLICY "attendance: l1 sees own people" ON public.attendance
  FOR SELECT TO authenticated USING (profile_id = ANY ((SELECT my_l1_member_ids())::uuid[]));

DROP POLICY IF EXISTS "leave_requests: l1 sees own people" ON public.leave_requests;
CREATE POLICY "leave_requests: l1 sees own people" ON public.leave_requests
  FOR SELECT TO authenticated USING (profile_id = ANY ((SELECT my_l1_member_ids())::uuid[]));

DROP POLICY IF EXISTS "regularize_requests: l1 sees own people" ON public.regularize_requests;
CREATE POLICY "regularize_requests: l1 sees own people" ON public.regularize_requests
  FOR SELECT TO authenticated USING (profile_id = ANY ((SELECT my_l1_member_ids())::uuid[]));

DROP POLICY IF EXISTS "wfh_requests: l1 sees own people" ON public.wfh_requests;
CREATE POLICY "wfh_requests: l1 sees own people" ON public.wfh_requests
  FOR SELECT TO authenticated USING (profile_id = ANY ((SELECT my_l1_member_ids())::uuid[]));

DROP POLICY IF EXISTS "leave_ledger: l1 sees own people" ON public.leave_ledger;
CREATE POLICY "leave_ledger: l1 sees own people" ON public.leave_ledger
  FOR SELECT TO authenticated USING (profile_id = ANY ((SELECT my_l1_member_ids())::uuid[]));

DROP POLICY IF EXISTS "comp_off_adjustments: l1 sees own people" ON public.comp_off_adjustments;
CREATE POLICY "comp_off_adjustments: l1 sees own people" ON public.comp_off_adjustments
  FOR SELECT TO authenticated USING (profile_id = ANY ((SELECT my_l1_member_ids())::uuid[]));

-- ── Acting for the employee ────────────────────────────────────────────────
-- Checks the caller is the employee's L1 and returns the employee's tenant.
CREATE OR REPLACE FUNCTION public.l1_check_member(p_employee uuid)
RETURNS uuid
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant uuid;
BEGIN
  SELECT e.tenant_id INTO v_tenant
  FROM profiles e
  JOIN profiles me ON me.id = auth.uid() AND me.tenant_id = e.tenant_id
                  AND COALESCE(me.status, 'Active') = 'Active'
  WHERE e.id = p_employee AND e.l1_spoc_id = auth.uid() AND e.id <> auth.uid()
    AND COALESCE(e.status, 'Active') = 'Active';
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'You are not the L1 for this employee.' USING ERRCODE = '42501';
  END IF;
  RETURN v_tenant;
END;
$function$;

REVOKE ALL ON FUNCTION public.l1_check_member(uuid) FROM PUBLIC, anon, authenticated;

-- Points auth.uid() at p_subject for the rest of the transaction (or until
-- called again). Internal only — never granted to clients.
CREATE OR REPLACE FUNCTION public.l1_set_jwt_subject(p_subject uuid, p_claims text, p_sub text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF p_subject IS NULL THEN
    -- Restore what PostgREST set.
    PERFORM set_config('request.jwt.claims', COALESCE(p_claims, ''), true);
    PERFORM set_config('request.jwt.claim.sub', COALESCE(p_sub, ''), true);
  ELSE
    PERFORM set_config('request.jwt.claims',
      (COALESCE(NULLIF(p_claims, '')::jsonb, '{}'::jsonb)
        || jsonb_build_object('sub', p_subject::text, 'role', 'authenticated'))::text, true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.l1_set_jwt_subject(uuid, text, text) FROM PUBLIC, anon, authenticated;

-- Leave for an employee. Same columns the app inserts for itself; the
-- leave triggers fill in the route, stages and notifications.
CREATE OR REPLACE FUNCTION public.l1_request_leave(
  p_employee uuid, p_leave_type text, p_start_date date, p_end_date date,
  p_half_day text, p_reason text
)
RETURNS SETOF public.leave_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_me     uuid := auth.uid();
  v_tenant uuid := l1_check_member(p_employee);
  v_claims text := current_setting('request.jwt.claims', true);
  v_sub    text := current_setting('request.jwt.claim.sub', true);
  v_row    leave_requests;
BEGIN
  IF COALESCE(trim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'Please provide a reason.';
  END IF;

  PERFORM l1_set_jwt_subject(p_employee, v_claims, v_sub);
  INSERT INTO leave_requests (tenant_id, profile_id, leave_type, start_date, end_date, half_day, reason, status, submitted_by)
  VALUES (v_tenant, p_employee, p_leave_type, p_start_date, p_end_date, NULLIF(p_half_day, ''), trim(p_reason), 'Pending', v_me)
  RETURNING * INTO v_row;
  PERFORM l1_set_jwt_subject(NULL, v_claims, v_sub);

  RETURN NEXT v_row;
END;
$function$;

REVOKE ALL ON FUNCTION public.l1_request_leave(uuid, text, date, date, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.l1_request_leave(uuid, text, date, date, text, text) TO authenticated;

-- Regularize for an employee. The window check and approval tier triggers see
-- the employee as the submitter. The app sends the approver notification
-- afterwards, as it does for the employee's own request.
CREATE OR REPLACE FUNCTION public.l1_request_regularize(
  p_employee uuid, p_date date, p_clock_in time, p_clock_out time, p_reason text
)
RETURNS SETOF public.regularize_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_me     uuid := auth.uid();
  v_tenant uuid := l1_check_member(p_employee);
  v_claims text := current_setting('request.jwt.claims', true);
  v_sub    text := current_setting('request.jwt.claim.sub', true);
  v_row    regularize_requests;
BEGIN
  IF COALESCE(trim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'Reason is required.';
  END IF;
  IF EXISTS (SELECT 1 FROM regularize_requests
             WHERE profile_id = p_employee AND date = p_date AND status IN ('Pending', 'Approved')) THEN
    RAISE EXCEPTION 'There is already a pending or approved regularization for %.', to_char(p_date, 'DD Mon');
  END IF;

  PERFORM l1_set_jwt_subject(p_employee, v_claims, v_sub);
  INSERT INTO regularize_requests (tenant_id, profile_id, date, clock_in_time, clock_out_time, reason, status, submitted_by)
  VALUES (v_tenant, p_employee, p_date, p_clock_in, p_clock_out, trim(p_reason), 'Pending', v_me)
  RETURNING * INTO v_row;
  PERFORM l1_set_jwt_subject(NULL, v_claims, v_sub);

  RETURN NEXT v_row;
END;
$function$;

REVOKE ALL ON FUNCTION public.l1_request_regularize(uuid, date, time, time, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.l1_request_regularize(uuid, date, time, time, text) TO authenticated;

-- The employee's shift halves, for the half-day choice on the L1's leave form.
CREATE OR REPLACE FUNCTION public.l1_member_half_day_windows(p_employee uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM l1_check_member(p_employee);
  RETURN (
    SELECT jsonb_build_object(
      'shift_name',  f.o_shift_name,
      'shift_start', to_char(f.o_shift_start, 'HH24:MI'),
      'shift_end',   to_char(f.o_shift_end, 'HH24:MI'),
      'first_half',  jsonb_build_object('from', to_char(f.o_from, 'HH24:MI'), 'to', to_char(f.o_to, 'HH24:MI')),
      'second_half', jsonb_build_object('from', to_char(s.o_from, 'HH24:MI'), 'to', to_char(s.o_to, 'HH24:MI')))
    FROM leave_half_day_window(p_employee, 'first_half') f,
         leave_half_day_window(p_employee, 'second_half') s
    WHERE f.o_shift_start IS NOT NULL);
END;
$function$;

REVOKE ALL ON FUNCTION public.l1_member_half_day_windows(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.l1_member_half_day_windows(uuid) TO authenticated;
