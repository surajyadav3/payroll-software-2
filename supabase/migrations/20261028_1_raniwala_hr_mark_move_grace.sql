-- =============================================================
-- Raniwala: HR marks, removes or moves the month's late arrival / early
-- left grace by hand (28 Oct 2026).
--
-- User: in Attendance Log's edit for an employee, Raniwala HR can mark a
-- day as graced when the system did not (a 10 - 15 min delay, a personal
-- reason), as a Late Arrival or an Early Left. The grace stays one a
-- month: if it is already used on another day, HR can take it off that
-- day and put it on this one.
--
--   Mark as graced    the day is Present and holds the month's grace,
--                     whatever its punches say (a normal 10:35 Late too).
--                     The day that held it before goes by its hours
--                     (Half Day / Late, counted).
--   Remove grace      the day takes no grace: its hours decide. The
--                     month's grace is free again, so the next late
--                     arrival / early left within the limits takes it
--                     (same as 20261021_3's hand edit).
--   Back to automatic HR's mark is dropped, the normal rule decides.
--
-- HR's call is kept in early_late_grace_hr (one row per day), so the
-- device feed, the evening re-score and the nightly finalize keep it.
-- Only days scored from their punches: a day edited by hand (Edit
-- Attendance / Bulk Regularize / approved regularization) keeps its own
-- status and takes no grace (20261021_3).
--
-- Changes on live defs:
--   early_late_grace_score (20261027_2 + 20261028_6 late + early same
--     day = Half Day, no grace; apply 28_6 first): HR's mark first; "removed" means
--     no grace; a day HR marked holds the grace for the whole month, not
--     only for later days.
--   trg_early_late_kind (20261021_4): HR's Late Arrival / Early Left
--     names the graced day.
-- New: early_late_rescore_month (the 20261027_2 October pass, one employee
-- one month) and hr_set_early_late_grace (RPC, tenant admin).
-- =============================================================

SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.early_late_grace_hr (
  attendance_id uuid PRIMARY KEY REFERENCES public.attendance(id) ON DELETE CASCADE,
  tenant_id     uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  profile_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  date          date NOT NULL,
  action        text NOT NULL CHECK (action IN ('granted', 'removed')),
  kind          text CHECK (kind IN ('late_arrival', 'early_left', 'both')),
  reason        text NOT NULL DEFAULT '',
  set_by        uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  set_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS early_late_grace_hr_profile_date
  ON public.early_late_grace_hr (profile_id, date);

ALTER TABLE public.early_late_grace_hr ENABLE ROW LEVEL SECURITY;

-- Read: the employee their own days, the company's admin all. Writes only
-- through hr_set_early_late_grace.
DROP POLICY IF EXISTS "early_late_grace_hr: self or tenant admin read" ON public.early_late_grace_hr;
CREATE POLICY "early_late_grace_hr: self or tenant admin read" ON public.early_late_grace_hr
  FOR SELECT USING (
    profile_id = (SELECT auth.uid())
    OR (tenant_id = (SELECT my_tenant_id()) AND (SELECT my_role()) = 'admin')
    OR (SELECT my_role()) = 'superadmin'
  );

REVOKE INSERT, UPDATE, DELETE ON public.early_late_grace_hr FROM anon, authenticated;
GRANT SELECT ON public.early_late_grace_hr TO authenticated;

-- ── Score: HR's mark first ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.early_late_grace_score(p_att_id uuid, p_profile_id uuid, p_date date, p_first text, p_last text, p_n integer, p_open boolean, p_status text)
 RETURNS TABLE(status text, graced boolean, counted boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_mins     int;
  v_waive    numeric;
  v_tenant   uuid;
  v_outlet   uuid;
  v_start    time;
  v_end      time;
  v_cap_in   time;
  v_cap_out  time;
  v_late_min int;
  v_off_days int[];
  v_holidays boolean;
  v_first    time := p_first::time;
  v_last     time := p_last::time;
  v_late     boolean;
  v_early    boolean;
  v_past     boolean;
  v_hr       text;
BEGIN
  SELECT t.early_late_grace_minutes, t.late_waived_after_hours, p.tenant_id, p.outlet_id,
         substr(COALESCE(s.start_time::text, o.shift_start, t.shift_start, '10:30'), 1, 5)::time,
         substr(COALESCE(s.end_time::text,   o.shift_end,   t.shift_end,   '18:00'), 1, 5)::time,
         s.late_arrival_allowance_until, s.early_departure_after,
         COALESCE(o.late_threshold, t.late_threshold, 0),
         employee_weekly_off_days(p.id),
         COALESCE(o.holidays_enabled, true)
    INTO v_mins, v_waive, v_tenant, v_outlet, v_start, v_end, v_cap_in, v_cap_out,
         v_late_min, v_off_days, v_holidays
    FROM profiles p
    JOIN tenants t ON t.id = p.tenant_id
    LEFT JOIN outlets o ON o.id = p.outlet_id
    LEFT JOIN shifts s ON s.id = p.shift_id
   WHERE p.id = p_profile_id;

  IF v_mins IS NULL THEN
    RETURN;
  END IF;
  -- Reached from triggers as the employee; never answer for another company.
  IF auth.uid() IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND (tenant_id = v_tenant OR role = 'superadmin')
  ) THEN
    RETURN;
  END IF;

  -- No shift (44 Raniwala staff) or a shift without limits: the limits of
  -- the company's shift with the same timings (Office 10:20 - 19:15 ->
  -- "Office Staff" 12:10 / 17:30).
  IF v_cap_in IS NULL AND v_cap_out IS NULL THEN
    SELECT s2.late_arrival_allowance_until, s2.early_departure_after
      INTO v_cap_in, v_cap_out
      FROM shifts s2
     WHERE s2.tenant_id = v_tenant
       AND s2.start_time = v_start AND s2.end_time = v_end
       AND (s2.late_arrival_allowance_until IS NOT NULL OR s2.early_departure_after IS NOT NULL)
     ORDER BY s2.name
     LIMIT 1;
  END IF;

  status := p_status; graced := false; counted := false;

  -- Worked the full day and more (20261019_1): a finished day of
  -- late_waived_after_hours+ (first to last punch, same sum as total_hours)
  -- is Present, and the month's grace is not used.
  IF v_waive IS NOT NULL
     AND p_status IN ('Present', 'Late')
     AND p_first IS NOT NULL AND p_n >= 2 AND NOT p_open
     AND ((EXTRACT(EPOCH FROM (v_last - v_first))::numeric % 86400 + 86400) % 86400) / 3600.0 >= v_waive THEN
    status := 'Present';
    RETURN NEXT;
    RETURN;
  END IF;

  IF p_status NOT IN ('Present', 'Late', 'Half Day', 'Absent')
     OR p_first IS NULL
     OR v_start = '00:00'::time                       -- no fixed start (Office Consultant)
     OR v_end <= v_start                              -- day shifts only
     -- weekly off / holiday worked: no shift that day (20261014_3); the
     -- outlet's own holidays always count (20261020_2)
     OR EXTRACT(DOW FROM p_date)::int = ANY (v_off_days)
     OR EXISTS (
          SELECT 1 FROM holidays h
           WHERE h.tenant_id = v_tenant AND h.date = p_date
             AND (h.outlet_id = v_outlet OR (v_holidays AND h.outlet_id IS NULL)))
     -- half-day leave: only due for the other half (20261013_2)
     OR EXISTS (
          SELECT 1 FROM leave_requests lr
           WHERE lr.profile_id = p_profile_id AND lr.status = 'Approved'
             AND lr.half_day IS NOT NULL AND lr.start_date = p_date)
     -- edited by hand by a manager / HR from 21 Oct 2026 (20261021_3):
     -- their status stands and the day uses no grace
     OR EXISTS (
          SELECT 1 FROM attendance a2
            JOIN attendance_audit_log l ON l.attendance_id = a2.id
           WHERE a2.id = p_att_id AND a2.location IN ('Office (Manual)', 'Office (Regularized)')
             AND l.created_at >= '2026-10-21 00:00:00+05:30') THEN
    RETURN NEXT;
    RETURN;
  END IF;

  -- HR's call on this day (20261028_1): marked graced = Present with the
  -- month's grace, however late / early (a 10:35 Late too).
  SELECT h.action INTO v_hr FROM early_late_grace_hr h WHERE h.attendance_id = p_att_id;
  IF v_hr = 'granted' THEN
    status := 'Present'; graced := true;
    RETURN NEXT;
    RETURN;
  END IF;

  v_late  := v_first > v_start + make_interval(mins => v_mins);
  -- v_last >= v_first: a punch-out after midnight is not Early Left (20261024_5)
  v_early := p_n >= 2 AND NOT p_open AND v_last >= v_first
             AND v_last < v_end - make_interval(mins => v_mins);

  IF NOT (v_late OR v_early) THEN
    RETURN NEXT;
    RETURN;
  END IF;

  -- Under 4 h (Absent) is not a working day, and a day the hours already
  -- make Present needs no grace: no grace, no mark, it stays free.
  IF p_status IN ('Absent', 'Present') THEN
    RETURN NEXT;
    RETURN;
  END IF;

  -- The grace covers ONE breach within the shift's limits (Office in by
  -- 12:10 / out from 17:30), the first of the month (user, 27 Oct 2026).
  -- Past a limit no grace: the hours decide and the grace stays free.
  v_past := NOT (
       (v_late AND (v_cap_in IS NULL OR v_first <= v_cap_in))
    OR (v_early AND (v_cap_out IS NULL OR v_last >= v_cap_out)));

  -- Late arrival AND early left on one day (20261028_6): no grace, Half Day.
  IF v_late AND v_early THEN
    status := 'Half Day'; counted := true;
    RETURN NEXT;
    RETURN;
  END IF;

  -- HR took the grace off this day: no grace, the hours decide. A day HR
  -- marked graced holds the month's grace whether it is before or after
  -- this one.
  IF NOT v_past AND v_hr IS DISTINCT FROM 'removed' AND NOT EXISTS (
    SELECT 1 FROM attendance a
     WHERE a.profile_id = p_profile_id
       AND a.id IS DISTINCT FROM p_att_id
       AND a.date >= date_trunc('month', p_date)::date
       AND a.date < (date_trunc('month', p_date) + interval '1 month')::date
       AND a.status NOT IN ('Leave', 'Comp Off')
       AND a.early_late_graced
       AND (a.date < p_date OR EXISTS (
             SELECT 1 FROM early_late_grace_hr h
              WHERE h.attendance_id = a.id AND h.action = 'granted'))
  ) THEN
    graced := true;
    status := 'Present';
  ELSE
    counted := true;
  END IF;

  RETURN NEXT;
END;
$function$;

-- ── Kind: HR's Late Arrival / Early Left on a day they marked ──────────
CREATE OR REPLACE FUNCTION public.trg_early_late_kind()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status IN ('Mispunch', 'Pending Approval', 'Leave', 'Comp Off') THEN
    NEW.early_late_graced := false;
    NEW.early_late_flag := false;
  END IF;
  IF NEW.early_late_graced OR NEW.early_late_flag THEN
    NEW.early_late_kind := COALESCE(
      CASE WHEN NEW.early_late_graced THEN (
        SELECT h.kind FROM early_late_grace_hr h
         WHERE h.attendance_id = NEW.id AND h.action = 'granted') END,
      early_late_kind_of(NEW.id, NEW.profile_id, NEW.date));
  ELSE
    NEW.early_late_kind := NULL;
  END IF;
  RETURN NEW;
END;
$function$;

-- ── One employee's month re-scored (the 20261027_2 October pass) ───────
CREATE OR REPLACE FUNCTION public.early_late_rescore_month(p_profile_id uuid, p_month date)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_t        RECORD;
  r          RECORD;
  v_g        RECORD;
  v_today    date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_now      time := (now() AT TIME ZONE 'Asia/Kolkata')::time;
  v_from     date := date_trunc('month', p_month)::date;
  v_to       date := LEAST((date_trunc('month', p_month) + interval '1 month - 1 day')::date,
                           (now() AT TIME ZONE 'Asia/Kolkata')::date);
  v_prev_reg text := COALESCE(current_setting('app.regularize_apply', true), 'off');
  v_prev_q   text := COALESCE(current_setting('app.early_late_quiet', true), 'off');
  v_first    text;
  v_last     text;
  v_n        int;
  v_start    text;
  v_end      text;
  v_late_min int;
  v_half     numeric;
  v_full     numeric;
  v_is_late  boolean;
  v_open     boolean;
  v_base     text;
  v_changed  int := 0;
BEGIN
  SELECT t.* INTO v_t
    FROM profiles p JOIN tenants t ON t.id = p.tenant_id
   WHERE p.id = p_profile_id;
  IF v_t.early_late_grace_minutes IS NULL THEN
    RETURN 0;
  END IF;

  -- The recompute trigger stands aside; no same-day notifications.
  PERFORM set_config('app.regularize_apply', 'on', true);
  PERFORM set_config('app.early_late_quiet', 'on', true);

  FOR r IN
    SELECT a.id, a.profile_id, a.date, a.status, a.total_hours, a.early_late_graced, a.early_late_flag,
           p.shift_id, p.outlet_id, ol.name AS outlet_name
      FROM attendance a
      JOIN profiles p ON p.id = a.profile_id
      LEFT JOIN outlets ol ON ol.id = p.outlet_id
     WHERE a.profile_id = p_profile_id
       AND a.date BETWEEN v_from AND v_to
       AND a.status IN ('Present', 'Late', 'Half Day', 'Absent')
       AND NOT EXISTS (SELECT 1 FROM punches pu WHERE pu.attendance_id = a.id
                        AND (pu.source = 'manual' OR pu.approval_status <> 'approved'))
       AND NOT EXISTS (SELECT 1 FROM attendance_audit_log l WHERE l.attendance_id = a.id)
     ORDER BY a.date
  LOOP
    SELECT COALESCE(min(punch_time) FILTER (WHERE NOT next_day), min(punch_time)),
           COALESCE(max(punch_time) FILTER (WHERE next_day), max(punch_time)),
           count(*)
      INTO v_first, v_last, v_n
      FROM punches WHERE attendance_id = r.id AND approval_status = 'approved';
    IF v_n = 0 OR (v_n = 1 AND r.date < v_today) THEN
      CONTINUE;
    END IF;
    -- 20 Oct early closing (HR, 23 + 26 Oct): left as they are.
    IF r.date = '2026-10-20'
       AND ((r.outlet_name = 'Office Staff'  AND v_last::time >= '18:00')
         OR (r.outlet_name = 'Factory Staff' AND v_last::time >= '16:00')) THEN
      CONTINUE;
    END IF;

    SELECT COALESCE(s.start_time::text, o.shift_start, v_t.shift_start, '10:30'),
           COALESCE(s.end_time::text,   o.shift_end,   v_t.shift_end,   '18:00'),
           COALESCE(o.late_threshold, v_t.late_threshold, 0),
           COALESCE(o.min_half_day_hours, v_t.min_half_day_hours, 4),
           COALESCE(o.min_full_day_hours, v_t.min_full_day_hours, 8)
      INTO v_start, v_end, v_late_min, v_half, v_full
      FROM (SELECT 1) one
      LEFT JOIN shifts s ON s.id = r.shift_id
      LEFT JOIN outlets o ON o.id = r.outlet_id;

    v_is_late := (EXTRACT(EPOCH FROM (v_first::time - substr(v_start, 1, 5)::time)) / 60) > v_late_min;
    v_open := r.date = v_today
              AND substr(v_end, 1, 5)::time > substr(v_start, 1, 5)::time
              AND v_now < substr(v_end, 1, 5)::time;

    IF v_n = 1 OR v_open THEN
      v_base := CASE WHEN v_is_late THEN 'Late' ELSE 'Present' END;
    ELSE
      v_base := CASE WHEN r.total_hours >= v_full THEN 'Present'
                     WHEN r.total_hours >= v_half THEN 'Half Day'
                     ELSE 'Absent' END;
      IF v_base = 'Present' AND v_is_late THEN
        v_base := 'Late';
      END IF;
    END IF;

    SELECT g.* INTO v_g FROM early_late_grace_score(
      r.id, r.profile_id, r.date, v_first, v_last, v_n, v_open, v_base) g;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    -- Only days this rule decides: flagged before or flagged now.
    IF r.early_late_graced OR r.early_late_flag OR v_g.graced OR v_g.counted THEN
      UPDATE attendance
         SET status = v_g.status, early_late_graced = v_g.graced, early_late_flag = v_g.counted
       WHERE id = r.id
         AND (status, early_late_graced, early_late_flag) IS DISTINCT FROM (v_g.status, v_g.graced, v_g.counted);
      IF FOUND THEN
        v_changed := v_changed + 1;
      END IF;
    END IF;
  END LOOP;

  PERFORM set_config('app.regularize_apply', v_prev_reg, true);
  PERFORM set_config('app.early_late_quiet', v_prev_q, true);
  RETURN v_changed;
END;
$$;

REVOKE ALL ON FUNCTION public.early_late_rescore_month(uuid, date) FROM PUBLIC, anon, authenticated;

-- ── HR: mark / remove / move the grace ─────────────────────────────────
-- p_action: 'grant' (mark as graced), 'remove' (take it off), 'auto' (drop
-- HR's mark). p_move: on 'grant', take the grace off the day that holds it.
CREATE OR REPLACE FUNCTION public.hr_set_early_late_grace(
  p_attendance_id uuid,
  p_action        text,
  p_kind          text DEFAULT NULL,
  p_reason        text DEFAULT '',
  p_move          boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  a          RECORD;
  v_prev_q   text := COALESCE(current_setting('app.early_late_quiet', true), 'off');
  v_month    date;
  v_hold_id  uuid;
  v_hold_on  date;
  v_now      RECORD;
  v_other    date;
  v_label    text;
  v_title    text;
  v_body     text;
BEGIN
  SELECT at.id, at.tenant_id, at.profile_id, at.date, at.status, at.location,
         at.early_late_graced, at.early_late_flag, t.early_late_grace_minutes AS mins
    INTO a
    FROM attendance at
    JOIN tenants t ON t.id = at.tenant_id
   WHERE at.id = p_attendance_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Attendance day not found';
  END IF;

  IF auth.uid() IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid()
      AND (role = 'superadmin' OR (tenant_id = a.tenant_id AND role = 'admin'))
  ) THEN
    RAISE EXCEPTION 'Only HR can change the late arrival / early left grace';
  END IF;
  IF a.mins IS NULL THEN
    RAISE EXCEPTION 'This company has no late arrival / early left grace';
  END IF;
  IF p_action NOT IN ('grant', 'remove', 'auto') THEN
    RAISE EXCEPTION 'Unknown action %', p_action;
  END IF;
  IF p_action <> 'auto' AND btrim(COALESCE(p_reason, '')) = '' THEN
    RAISE EXCEPTION 'A reason is required';
  END IF;
  IF p_action = 'grant' AND p_kind NOT IN ('late_arrival', 'early_left', 'both') THEN
    RAISE EXCEPTION 'Pick Late Arrival or Early Left';
  END IF;

  -- Hand-edited / regularized days keep their own status (20261021_3).
  IF a.location IN ('Office (Manual)', 'Office (Regularized)')
     OR EXISTS (SELECT 1 FROM punches WHERE attendance_id = a.id AND source = 'manual')
     OR EXISTS (SELECT 1 FROM attendance_audit_log WHERE attendance_id = a.id) THEN
    RAISE EXCEPTION 'This day was edited by hand, so its status stands and it takes no grace. Change it with Edit Attendance instead.';
  END IF;
  IF EXISTS (SELECT 1 FROM punches WHERE attendance_id = a.id AND approval_status <> 'approved') THEN
    RAISE EXCEPTION 'This day has punches waiting for approval. Approve or reject them first.';
  END IF;

  v_month := date_trunc('month', a.date)::date;

  IF p_action = 'grant' THEN
    IF a.status NOT IN ('Late', 'Half Day', 'Absent')
       OR NOT EXISTS (SELECT 1 FROM punches WHERE attendance_id = a.id AND approval_status = 'approved') THEN
      RAISE EXCEPTION 'Only a day with punches (Late, Half Day, Absent) can be graced. This day is %.', a.status;
    END IF;
    IF a.early_late_graced THEN
      RAISE EXCEPTION 'This day already holds the grace';
    END IF;

    -- The day holding the month's grace now.
    SELECT at.id, at.date INTO v_hold_id, v_hold_on
      FROM attendance at
     WHERE at.profile_id = a.profile_id AND at.id <> a.id AND at.early_late_graced
       AND at.date >= v_month AND at.date < (v_month + interval '1 month')::date
     ORDER BY at.date
     LIMIT 1;
    IF v_hold_id IS NOT NULL AND NOT p_move THEN
      RAISE EXCEPTION 'GRACE_USED:%', v_hold_on;
    END IF;
  END IF;

  IF p_action = 'auto' THEN
    DELETE FROM early_late_grace_hr WHERE attendance_id = a.id;
  ELSE
    INSERT INTO early_late_grace_hr (attendance_id, tenant_id, profile_id, date, action, kind, reason, set_by, set_at)
    VALUES (a.id, a.tenant_id, a.profile_id, a.date,
            CASE WHEN p_action = 'grant' THEN 'granted' ELSE 'removed' END,
            CASE WHEN p_action = 'grant' THEN p_kind END,
            btrim(p_reason), auth.uid(), now())
    ON CONFLICT (attendance_id) DO UPDATE
      SET action = EXCLUDED.action, kind = EXCLUDED.kind, reason = EXCLUDED.reason,
          set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at;
  END IF;

  -- Moving it: an earlier HR mark on the old day goes.
  IF v_hold_id IS NOT NULL THEN
    DELETE FROM early_late_grace_hr WHERE attendance_id = v_hold_id AND action = 'granted';
  END IF;

  PERFORM set_config('app.early_late_quiet', 'on', true);
  PERFORM early_late_rescore_month(a.profile_id, a.date);

  -- A day the re-score cannot reach (hand-edited, regularized) that still
  -- held the grace gives it up; its own status stands.
  IF p_action = 'grant' THEN
    UPDATE attendance
       SET early_late_graced = false, early_late_flag = false
     WHERE profile_id = a.profile_id AND id <> a.id AND early_late_graced
       AND date >= v_month AND date < (v_month + interval '1 month')::date;
  END IF;
  PERFORM set_config('app.early_late_quiet', v_prev_q, true);

  SELECT at.status, at.early_late_graced, at.early_late_kind INTO v_now FROM attendance at WHERE at.id = a.id;
  IF p_action = 'grant' AND NOT v_now.early_late_graced THEN
    RAISE EXCEPTION 'This day cannot take the grace (it is %, on a weekly off, holiday or half-day leave, or worked 9 h+)', v_now.status;
  END IF;

  SELECT min(at.date) INTO v_other
    FROM attendance at
   WHERE at.profile_id = a.profile_id AND at.id <> a.id AND at.early_late_graced
     AND at.date >= v_month AND at.date < (v_month + interval '1 month')::date;

  -- Tell the employee.
  v_label := CASE COALESCE(p_kind, v_now.early_late_kind)
    WHEN 'late_arrival' THEN 'late arrival'
    WHEN 'early_left'   THEN 'early left'
    WHEN 'both'         THEN 'late arrival and early left'
    ELSE 'late arrival / early left' END;
  IF p_action = 'grant' THEN
    v_title := 'Grace given for ' || to_char(a.date, 'DD Mon');
    v_body  := format('HR marked your %s on %s as graced, so the day is Present. This is %s''s one late arrival / early left grace.',
                      v_label, to_char(a.date, 'DD Mon'), to_char(a.date, 'FMMonth'))
            || CASE WHEN v_hold_id IS NOT NULL
                    THEN format(' It was on %s, which now goes by your hours (%s).',
                                to_char(v_hold_on, 'DD Mon'),
                                (SELECT status FROM attendance WHERE id = v_hold_id))
                    ELSE '' END;
  ELSIF p_action = 'remove' AND a.early_late_graced THEN
    v_title := 'Grace removed for ' || to_char(a.date, 'DD Mon');
    v_body  := format('HR removed the late arrival / early left grace from %s, so the day goes by your hours and is marked %s.',
                      to_char(a.date, 'DD Mon'), v_now.status)
            || CASE WHEN v_other IS NOT NULL
                    THEN format(' This month''s grace now covers %s.', to_char(v_other, 'DD Mon'))
                    ELSE ' This month''s grace is free for your next late arrival or early left.' END;
  END IF;
  IF v_title IS NOT NULL THEN
    INSERT INTO app_notifications (tenant_id, profile_id, actor_id, type, title, body, link_key, related_id)
    VALUES (a.tenant_id, a.profile_id, auth.uid(),
            CASE WHEN p_action = 'grant' THEN 'early_late_grace' ELSE 'early_late_counted' END,
            v_title, v_body, 'attendance', a.id);
  END IF;

  RETURN jsonb_build_object(
    'status', v_now.status,
    'graced', v_now.early_late_graced,
    'moved_from', v_hold_on,
    'grace_on', CASE WHEN v_now.early_late_graced THEN a.date ELSE v_other END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.hr_set_early_late_grace(uuid, text, text, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hr_set_early_late_grace(uuid, text, text, text, boolean) TO authenticated;
