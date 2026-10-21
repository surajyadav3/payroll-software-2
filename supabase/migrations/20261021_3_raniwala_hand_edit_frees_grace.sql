-- =============================================================
-- Raniwala: a day edited by hand uses no grace (21 Oct 2026).
--
-- User decision: when a manager / HR edits a day by hand, their status
-- stands and that day uses no late arrival / early left grace. Hand edits
-- are the web's Edit Attendance ('Office (Manual)') and Bulk Regularize
-- ('Office (Regularized)'), each followed by an attendance_audit_log row.
-- If the day held the month's grace, the grace moves on: the rest of the
-- employee's month is re-scored from the device feed, so the next breach
-- becomes the graced (Present) day. An employee's approved regularization
-- request (apply_approved_regularize_request, which writes its audit row
-- with app.regularize_apply on) is not treated as a hand edit.
--
--   * early_late_grace_score skips a hand-edited day (audit row from
--     21 Oct 2026 on), so a later recompute cannot put the grace back.
--   * AFTER INSERT trigger on attendance_audit_log clears the day's grace /
--     Late-mark flags and re-scores the rest of the month.
--   * Hand edits made earlier today are run through the same once.
--
-- One-off (user, 21 Oct): employee 367, 7 Oct (manager set Half Day
-- "Early Leave" on 20 Oct) keeps the grace rule: graced -> Present. 10 Oct
-- stays Late.
--
-- early_late_grace_score: live def (20261021_2) + the hand-edit exclusion.
-- =============================================================

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
BEGIN
  SELECT t.early_late_grace_minutes, t.late_waived_after_hours, p.tenant_id, p.outlet_id,
         substr(COALESCE(s.start_time::text, o.shift_start, t.shift_start, '10:30'), 1, 5)::time,
         substr(COALESCE(s.end_time::text,   o.shift_end,   t.shift_end,   '18:00'), 1, 5)::time,
         s.late_arrival_allowance_until, s.early_departure_after,
         COALESCE(o.late_threshold, t.late_threshold, 0),
         COALESCE(
           NULLIF(o.weekly_off_days, '{}'::int[]),
           NULLIF(t.weekly_off_days::int[], '{}'::int[]),
           CASE WHEN t.weekly_off_day IS NOT NULL THEN ARRAY[t.weekly_off_day::int] END,
           ARRAY[0]
         ),
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
  -- "Office Staff" 12:00 / 17:30).
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

  v_late  := v_first > v_start + make_interval(mins => v_mins);
  v_early := p_n >= 2 AND NOT p_open AND v_last < v_end - make_interval(mins => v_mins);

  IF NOT (v_late OR v_early) THEN
    RETURN NEXT;
    RETURN;
  END IF;

  -- Past the shift's limit: the hours rule decides, the grace is not used.
  IF (v_late AND v_cap_in IS NOT NULL AND v_first > v_cap_in)
     OR (v_early AND v_cap_out IS NOT NULL AND v_last < v_cap_out)
     OR p_status = 'Absent' THEN
    RETURN NEXT;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM attendance a
     WHERE a.profile_id = p_profile_id
       AND a.id IS DISTINCT FROM p_att_id
       AND a.date >= date_trunc('month', p_date)::date
       AND a.date < p_date
       AND a.status NOT IN ('Leave', 'Comp Off')
       AND (a.early_late_graced OR a.early_late_flag)
  ) THEN
    counted := true;
  ELSE
    graced := true;
  END IF;

  -- A graced day is Present, whatever it was (late arrival, early left or
  -- both, a normal 10:31 - 11:05 Late on top, short hours from it): user,
  -- 21 Oct 2026. Every later one that month is Late.
  status := CASE WHEN counted THEN 'Late' ELSE 'Present' END;

  RETURN NEXT;
END;
$function$;

-- ── Free the grace on a hand-edited day ────────────────────────────────
CREATE OR REPLACE FUNCTION public.early_late_release_hand_edit(p_att_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  a       RECORD;
  v_prev  text := COALESCE(current_setting('app.regularize_apply', true), 'off');
  v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_to    date;
BEGIN
  SELECT at.id, at.tenant_id, at.date, at.location, at.early_late_graced, at.early_late_flag,
         p.essl_employee_code AS code, t.early_late_grace_minutes AS mins
    INTO a
    FROM attendance at
    JOIN profiles p ON p.id = at.profile_id
    JOIN tenants t ON t.id = at.tenant_id
   WHERE at.id = p_att_id;

  IF NOT FOUND OR a.mins IS NULL OR a.location NOT IN ('Office (Manual)', 'Office (Regularized)')
     OR NOT (a.early_late_graced OR a.early_late_flag) THEN
    RETURN;
  END IF;

  -- The editor's status stays: the recompute trigger stands aside.
  PERFORM set_config('app.regularize_apply', 'on', true);
  UPDATE attendance SET early_late_graced = false, early_late_flag = false WHERE id = p_att_id;

  -- It held the month's grace: the next breach this month gets it.
  IF a.early_late_graced AND a.code IS NOT NULL THEN
    v_to := LEAST((date_trunc('month', a.date) + interval '1 month - 1 day')::date, v_today);
    IF a.date < v_to THEN
      PERFORM essl_apply_to_attendance(a.tenant_id, ARRAY[a.code], a.date + 1, v_to, false, true);
    END IF;
  END IF;

  PERFORM set_config('app.regularize_apply', v_prev, true);
END;
$$;

REVOKE ALL ON FUNCTION public.early_late_release_hand_edit(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.trg_audit_hand_edit_frees_grace()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- An approved regularization request writes its row with this on.
  IF COALESCE(current_setting('app.regularize_apply', true), '') <> 'on' THEN
    PERFORM early_late_release_hand_edit(NEW.attendance_id);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS zz_hand_edit_frees_grace ON public.attendance_audit_log;
CREATE TRIGGER zz_hand_edit_frees_grace
  AFTER INSERT ON public.attendance_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.trg_audit_hand_edit_frees_grace();

-- ── Today's earlier hand edits + the 7 Oct one-off ─────────────────────
DO $$
DECLARE
  v_tenant uuid;
  r        RECORD;
  v_n      int := 0;
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE company_name ILIKE '%Raniwala%';
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'Raniwala tenant not found -- aborting, nothing changed';
  END IF;

  PERFORM set_config('app.early_late_quiet', 'on', true);

  FOR r IN
    SELECT a.id FROM attendance a
     WHERE a.tenant_id = v_tenant AND a.location IN ('Office (Manual)', 'Office (Regularized)')
       AND (a.early_late_graced OR a.early_late_flag)
       AND EXISTS (SELECT 1 FROM attendance_audit_log l
                    WHERE l.attendance_id = a.id AND l.created_at >= '2026-10-21 00:00:00+05:30')
     ORDER BY a.profile_id, a.date
  LOOP
    PERFORM early_late_release_hand_edit(r.id);
    v_n := v_n + 1;
  END LOOP;

  PERFORM set_config('app.regularize_apply', 'on', true);
  UPDATE attendance a
     SET status = 'Present'
    FROM profiles p
   WHERE p.id = a.profile_id AND a.tenant_id = v_tenant
     AND p.employee_id = '367' AND a.date = '2026-10-07'
     AND a.early_late_graced AND a.status = 'Half Day';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Employee 367, 7 Oct: graced Half Day not found -- aborting';
  END IF;

  PERFORM set_config('app.regularize_apply', 'off', true);
  PERFORM set_config('app.early_late_quiet', 'off', true);
  RAISE NOTICE 'Hand edits from today released: %; 367 / 7 Oct -> Present', v_n;
END $$;
