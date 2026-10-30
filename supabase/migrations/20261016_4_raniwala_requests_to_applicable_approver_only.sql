-- Raniwala: a request reaches ONLY the person in charge of approving it, as set
-- by the relation sheet (profiles.manager_id / hod_id, from HOD.xlsx by EMP CODE).
-- It doesn't matter whether that person is a manager, an HOD, or both.
--
-- User, 2026-10-16: "i am a manager for 5 people and hod for 1 department ...
-- the request should go to that individual who is applicable or incharge to
-- approve leave or any req for an employee".
--
-- Applicable approver
--   * Leave: the stage the leave is waiting on, i.e. leave_requests.manager_id
--     for the manager stage and hod_id for the HOD stage (4+ days). This is
--     unchanged from 20260926_10/_11.
--   * Every other request (regularize, punch, WFH, special, expense, travel):
--     the employee's active manager, or their HOD if they have no active
--     manager. This is the rule 20260929_4 gave regularize, now applied to all.
--
-- Before this, a manager's manager (the my_team_ids chain) and an HOD whose
-- department member has their own manager also got these requests and could
-- see / act on them while pending. Now, for Raniwala manager / HOD / management
-- logins:
--   1. Pending requests are visible only to their applicable approver
--      (restrictive RLS). Decided ones stay visible to the whole team as history.
--   2. Request notifications reach only the applicable approver
--      (trg_team_only_request_notifications). This also folds in 20261014_1's
--      fix, which was never applied live: a manager / HOD always gets the notice
--      about their OWN request.
--   3. Punch approvals: the pending list and review_punches use only the
--      punch's approver (approver_id), plus HR.
-- HR (admin / superadmin) is untouched and still sees and decides everything.
-- Web and app need no change: both read through RLS / these RPCs.

-- ── Who approves an employee's non-leave requests ─────────────────────────
CREATE OR REPLACE FUNCTION public.raniwala_request_approver(p_profile_id uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(m.id, h.id)
  FROM profiles e
  LEFT JOIN profiles m ON m.id = e.manager_id AND m.id <> e.id AND COALESCE(m.status, 'Active') = 'Active'
  LEFT JOIN profiles h ON h.id = e.hod_id     AND h.id <> e.id AND COALESCE(h.status, 'Active') = 'Active'
  WHERE e.id = p_profile_id;
$function$;

REVOKE ALL ON FUNCTION public.raniwala_request_approver(uuid) FROM PUBLIC, anon, authenticated;

-- Employees whose non-leave requests the caller approves.
CREATE OR REPLACE FUNCTION public.my_approvee_ids()
 RETURNS uuid[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(array_agg(e.id), '{}'::uuid[])
  FROM profiles e
  WHERE (e.manager_id = auth.uid() OR e.hod_id = auth.uid())
    AND e.id <> auth.uid()
    AND raniwala_request_approver(e.id) = auth.uid();
$function$;

REVOKE ALL ON FUNCTION public.my_approvee_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_approvee_ids() TO authenticated;

-- ── 1. Pending requests: only their applicable approver ───────────────────
DROP POLICY IF EXISTS "leaves: raniwala pending only to its approvers" ON public.leave_requests;
CREATE POLICY "leaves: raniwala pending only to its approvers" ON public.leave_requests
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (
    NOT ((SELECT my_role()) IN ('manager', 'hod', 'management') AND (SELECT my_is_raniwala()))
    OR status IS DISTINCT FROM 'Pending'
    OR profile_id = (SELECT auth.uid())
    OR (manager_id = (SELECT auth.uid()) AND manager_status IS DISTINCT FROM 'Not Required')
    OR (hod_id = (SELECT auth.uid()) AND hod_status IS DISTINCT FROM 'Not Required')
    OR ((SELECT my_role()) = 'management' AND current_stage = 'management')
  );

DO $$
DECLARE
  t text;
  v_expr text := $e$(
    NOT ((SELECT my_role()) IN ('manager', 'hod', 'management') AND (SELECT my_is_raniwala()))
    OR status IS DISTINCT FROM 'Pending'
    OR profile_id = (SELECT auth.uid())
    OR profile_id = ANY ((SELECT my_approvee_ids())::uuid[])
  )$e$;
BEGIN
  FOREACH t IN ARRAY ARRAY['regularize_requests', 'wfh_requests', 'special_requests', 'expense_claims', 'travel_requests'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || ': raniwala pending only to approver', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || ': raniwala pending decided by approver', t);
    EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR SELECT TO authenticated USING %s',
                   t || ': raniwala pending only to approver', t, v_expr);
    EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR UPDATE TO authenticated USING %s',
                   t || ': raniwala pending decided by approver', t, v_expr);
  END LOOP;
END $$;

-- ── 2. Request notifications: only the applicable approver ────────────────
CREATE OR REPLACE FUNCTION public.trg_team_only_request_notifications()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_role text;
  v_requester uuid;
  v_leave record;
BEGIN
  IF NEW.actor_id IS NULL OR NEW.actor_id = NEW.profile_id
     OR NEW.link_key IS NULL
     OR NEW.link_key NOT IN ('leave_requests', 'regularize_attendance', 'wfh_requests', 'special_requests',
                             'expense_claims', 'travel_requests', 'verification_requests') THEN
    RETURN NEW;
  END IF;

  SELECT p.role INTO v_role
  FROM profiles p JOIN tenants t ON t.id = p.tenant_id
  WHERE p.id = NEW.profile_id AND t.company_name ILIKE '%Raniwala%';

  IF v_role IN ('manager', 'hod', 'management') THEN
    -- (0) Their own request (e.g. HR approving their leave) always reaches them.
    v_requester := CASE NEW.link_key
         WHEN 'leave_requests'        THEN (SELECT r.profile_id FROM leave_requests r      WHERE r.id = NEW.related_id)
         WHEN 'regularize_attendance' THEN (SELECT r.profile_id FROM regularize_requests r WHERE r.id = NEW.related_id)
         WHEN 'wfh_requests'          THEN (SELECT r.profile_id FROM wfh_requests r        WHERE r.id = NEW.related_id)
         WHEN 'special_requests'      THEN (SELECT r.profile_id FROM special_requests r    WHERE r.id = NEW.related_id)
         WHEN 'expense_claims'        THEN (SELECT r.profile_id FROM expense_claims r      WHERE r.id = NEW.related_id)
         WHEN 'travel_requests'       THEN (SELECT r.profile_id FROM travel_requests r     WHERE r.id = NEW.related_id)
    END;
    IF v_requester = NEW.profile_id THEN
      RETURN NEW;
    END IF;

    IF NEW.link_key = 'verification_requests' THEN
      RETURN NULL;
    END IF;

    -- (1) Leave: only the manager / HOD on that leave (the stage notices and
    -- FYIs from trg_notify_leave_stage); the management stage goes to management.
    IF NEW.link_key = 'leave_requests' THEN
      SELECT r.manager_id, r.hod_id INTO v_leave FROM leave_requests r WHERE r.id = NEW.related_id;
      IF FOUND THEN
        IF NEW.profile_id IN (v_leave.manager_id, v_leave.hod_id) OR v_role = 'management' THEN
          RETURN NEW;
        END IF;
        RETURN NULL;
      END IF;
      IF NEW.profile_id IN (SELECT unnest(ARRAY[a.manager_id, a.hod_id]) FROM profiles a WHERE a.id = NEW.actor_id) THEN
        RETURN NEW;
      END IF;
      RETURN NULL;
    END IF;

    -- (2) Every other request: only the requester's own approver
    -- (active manager, else HOD).
    IF NEW.profile_id IS DISTINCT FROM raniwala_request_approver(NEW.actor_id) THEN
      RETURN NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

-- ── 3. Punch approvals: the punch's approver (+ HR) ──────────────────────
DO $$
DECLARE
  v_def text;
  v_old text;
  v_new text;
BEGIN
  -- list_punch_approvals: pending punches only to their approver; decided
  -- ones stay visible to approver / manager / HOD / reviewer as history.
  v_def := replace(pg_get_functiondef('public.list_punch_approvals(text, date)'::regprocedure), chr(13) || chr(10), chr(10));
  v_old := $o$      v_uid IN (pu.approver_id, e.manager_id, e.hod_id)
      OR v_role IN ('admin', 'superadmin')$o$;
  v_new := $n$      v_role IN ('admin', 'superadmin')
      OR (pu.approval_status = 'pending' AND v_uid = pu.approver_id)
      OR (pu.approval_status <> 'pending' AND v_uid IN (pu.approver_id, pu.reviewed_by, e.manager_id, e.hod_id))$n$;
  IF position(v_old IN v_def) = 0 THEN
    RAISE EXCEPTION 'list_punch_approvals: expected condition not found';
  END IF;
  EXECUTE replace(v_def, v_old, v_new);

  -- review_punches: only the punch's approver, or HR.
  v_def := replace(pg_get_functiondef('public.review_punches(uuid[], boolean)'::regprocedure), chr(13) || chr(10), chr(10));
  v_old := $o$      v_uid IN (r.approver_id, r.manager_id, r.hod_id)$o$;
  v_new := $n$      v_uid = r.approver_id$n$;
  IF position(v_old IN v_def) = 0 THEN
    RAISE EXCEPTION 'review_punches: expected condition not found';
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
END $$;
