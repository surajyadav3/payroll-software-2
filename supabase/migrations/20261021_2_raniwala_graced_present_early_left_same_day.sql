-- =============================================================
-- Raniwala: a graced day is always Present, and Early Left is marked the
-- same evening (21 Oct 2026).
--
-- 1. Graced = Present. The month's one grace (late arrival, early left or
--    both, 20261021_1) now always makes the day Present. Before, a graced
--    early left on a day that also started normally Late (10:31 - 11:05)
--    stayed Late, and a shift without limits kept a short day Half Day.
--    Every later breach that month is still Late. October's graced days
--    are set to Present (HR-corrected days untouched).
--
-- 2. Early Left the same day. Device punches are scored by the 2-minute
--    sync as they arrive; while the shift is still running the out punch
--    cannot count as Early Left yet (20261005_1: someone still at work must
--    not be judged on a mid-day scan). Nothing re-scored the day until the
--    01:50 IST finalize, so Early Left (and short-hours Half Day) showed up
--    the next day, and the employee's notification, which is same-day only,
--    never went. essl_rescore_after_shift_end() re-scores each employee's
--    day once, 1 hour after their own shift ends (Factory 19:00, Office
--    20:15, Delhi / Gurgaon 11:00 20:30, Late Evening 21:00, Gurgaon 12:30
--    22:00 IST). Every 15 min, 17:35 - 23:20 IST, each run takes only the
--    shifts that ended 60 - 75 min ago, so a day is re-scored once. The
--    01:50 IST finalize stays as the backstop.
--
-- early_late_grace_score: live def (20261019_1 + 20261020_2) with the final
-- status block replaced.
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
             AND lr.half_day IS NOT NULL AND lr.start_date = p_date) THEN
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

-- ── Re-score today's day 1 hour after the employee's shift ends ────────
-- Same shift resolution as essl_apply_to_attendance. Only days still
-- scored from punches; essl_apply itself skips regularized days and
-- single-punch days on a re-score.
CREATE OR REPLACE FUNCTION public.essl_rescore_after_shift_end()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_now   timestamp := date_trunc('minute', now() AT TIME ZONE 'Asia/Kolkata');
  v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  t       RECORD;
  v_codes text[];
  v_n     int := 0;
BEGIN
  FOR t IN
    SELECT id, shift_start, shift_end FROM tenants
     WHERE early_late_grace_minutes IS NOT NULL AND essl_attendance_from IS NOT NULL
  LOOP
    SELECT array_agg(DISTINCT p.essl_employee_code) INTO v_codes
      FROM attendance a
      JOIN profiles p ON p.id = a.profile_id
      LEFT JOIN shifts s ON s.id = p.shift_id
      LEFT JOIN outlets o ON o.id = p.outlet_id
      CROSS JOIN LATERAL (
        SELECT substr(COALESCE(s.start_time::text, o.shift_start, t.shift_start, '10:30'), 1, 5)::time AS st,
               substr(COALESCE(s.end_time::text,   o.shift_end,   t.shift_end,   '18:00'), 1, 5)::time AS en
      ) x
     WHERE a.tenant_id = t.id AND a.date = v_today
       AND p.essl_employee_code IS NOT NULL
       AND a.status IN ('Present', 'Late', 'Half Day', 'Absent')
       AND x.en > x.st                                   -- day shifts only
       AND v_today + x.en + interval '60 min' >  v_now - interval '15 min'
       AND v_today + x.en + interval '60 min' <= v_now;

    IF v_codes IS NOT NULL THEN
      v_n := v_n + essl_apply_to_attendance(t.id, v_codes, v_today, v_today, false, true);
    END IF;
  END LOOP;
  RETURN v_n;
END;
$$;

REVOKE ALL ON FUNCTION public.essl_rescore_after_shift_end() FROM PUBLIC, anon, authenticated;

-- 12:05 - 17:50 UTC = 17:35 - 23:20 IST.
select cron.unschedule('essl-rescore-after-shift-end')
where exists (select 1 from cron.job where jobname = 'essl-rescore-after-shift-end');

select cron.schedule(
  'essl-rescore-after-shift-end',
  '5,20,35,50 12-17 * * *',
  $$ select public.essl_rescore_after_shift_end(); $$
);

-- ── October: every graced day Present ──────────────────────────────────
DO $$
DECLARE
  v_tenant uuid;
  v_n      int;
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE company_name ILIKE '%Raniwala%';
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'Raniwala tenant not found -- aborting, nothing changed';
  END IF;

  PERFORM set_config('app.regularize_apply', 'on', true);
  PERFORM set_config('app.early_late_quiet', 'on', true);

  UPDATE attendance a
     SET status = 'Present'
   WHERE a.tenant_id = v_tenant AND a.date >= '2026-10-01'
     AND a.early_late_graced AND NOT a.early_late_flag
     AND a.status IN ('Late', 'Half Day')
     AND NOT EXISTS (SELECT 1 FROM punches pu WHERE pu.attendance_id = a.id
                      AND (pu.source = 'manual' OR pu.approval_status <> 'approved'))
     AND NOT EXISTS (SELECT 1 FROM attendance_audit_log l WHERE l.attendance_id = a.id);
  GET DIAGNOSTICS v_n = ROW_COUNT;

  PERFORM set_config('app.regularize_apply', 'off', true);
  PERFORM set_config('app.early_late_quiet', 'off', true);
  RAISE NOTICE 'Raniwala graced days set to Present: %', v_n;
END $$;
