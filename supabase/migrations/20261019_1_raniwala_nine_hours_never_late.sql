-- =============================================================
-- Raniwala: a day of 9 hours or more is never Late (19 Oct 2026).
--
-- HR: an employee who arrives late but still works 9 hours or more that
-- day (first punch to last punch) is Present, not Late. That covers both
-- the normal Late (Office 10:31 - 11:05) and a late arrival / early out
-- counted Late after the month's grace (20261017_3). Such a day does not
-- use the month's grace either: it is not a late day at all.
--
-- Only a finished day is judged on hours: two or more approved punches and
-- the last one a departure. Until then the day stays Late/Present on arrival
-- time as before, and is re-scored when the clock-out comes in.
--
-- Gate: tenants.late_waived_after_hours (9, Raniwala only). Applied inside
-- early_late_grace_score(), which every Raniwala scoring path already calls
-- (essl_apply_to_attendance, trg_recompute_attendance_from_punches,
-- recompute_attendance_late_status), so a tenant must also be on the grace
-- rule (early_late_grace_minutes) for it to apply. Function body otherwise
-- identical to the live 20261017_3 definition.
--
-- October 2026 is re-scored once at the end, without notifications.
-- =============================================================

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS late_waived_after_hours numeric
  CHECK (late_waived_after_hours IS NULL OR late_waived_after_hours > 0);

COMMENT ON COLUMN public.tenants.late_waived_after_hours IS
  'A finished day of at least this many hours (first to last punch) is Present, never Late, and does not use the late arrival / early out grace (20261019_1). Needs early_late_grace_minutes. NULL = off.';

CREATE OR REPLACE FUNCTION public.early_late_grace_score(
  p_att_id     uuid,
  p_profile_id uuid,
  p_date       date,
  p_first      text,     -- first approved punch
  p_last       text,     -- last approved punch
  p_n          int,      -- approved punch count
  p_open       boolean,  -- last punch is not a departure (yet)
  p_status     text      -- status from hours + the normal Late rule
) RETURNS TABLE (status text, graced boolean, counted boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
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
     -- weekly off / holiday worked: no shift that day (20261014_3)
     OR EXTRACT(DOW FROM p_date)::int = ANY (v_off_days)
     OR (v_holidays AND EXISTS (
          SELECT 1 FROM holidays h
           WHERE h.tenant_id = v_tenant AND h.date = p_date
             AND (h.outlet_id IS NULL OR h.outlet_id = v_outlet)))
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

  -- Within the shift's limits the short hours are excused; a shift with no
  -- limit for it leaves a short day Half Day.
  IF p_status = 'Half Day'
     AND ((v_late AND v_cap_in IS NULL) OR (v_early AND v_cap_out IS NULL)) THEN
    status := 'Half Day';
  ELSIF counted THEN
    status := 'Late';
  ELSE
    -- A graced late arrival is not Late; a graced early out on a day that
    -- started normally Late (10:31 - 11:05) still is.
    status := CASE
      WHEN NOT v_late AND v_first > v_start + make_interval(mins => v_late_min) THEN 'Late'
      ELSE 'Present'
    END;
  END IF;

  RETURN NEXT;
END;
$$;
REVOKE ALL ON FUNCTION public.early_late_grace_score(uuid, uuid, date, text, text, int, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.early_late_grace_score(uuid, uuid, date, text, text, int, boolean, text) TO authenticated, service_role;

-- ── Raniwala on the rule + October re-scored once ──────────────────────
-- Same day selection and base scoring as the 20261017_3 re-score (days
-- scored from punches alone). Only days this rule touches change: a Late
-- day of 9 h+, a day that held the grace / a counted Late, and a later day
-- the freed grace now falls on. Processed in date order so each month's
-- grace moves to the next late arrival / early out.
DO $$
DECLARE
  v_tenant   uuid;
  v_t        RECORD;
  r          RECORD;
  v_g        RECORD;
  v_today    date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_now      time := (now() AT TIME ZONE 'Asia/Kolkata')::time;
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
  SELECT id INTO v_tenant FROM tenants WHERE company_name ILIKE '%Raniwala%';
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'Raniwala tenant not found -- aborting, nothing changed';
  END IF;

  UPDATE tenants SET late_waived_after_hours = 9 WHERE id = v_tenant;
  SELECT * INTO v_t FROM tenants WHERE id = v_tenant;

  PERFORM set_config('app.regularize_apply', 'on', true);
  PERFORM set_config('app.early_late_quiet', 'on', true);

  FOR r IN
    SELECT a.id, a.profile_id, a.date, a.status, a.total_hours, a.early_late_graced, a.early_late_flag,
           p.shift_id, p.outlet_id
      FROM attendance a
      JOIN profiles p ON p.id = a.profile_id
     WHERE a.tenant_id = v_tenant
       AND a.date BETWEEN '2026-10-01' AND v_today
       AND a.status IN ('Present', 'Late', 'Half Day', 'Absent')
       AND NOT EXISTS (SELECT 1 FROM punches pu WHERE pu.attendance_id = a.id
                        AND (pu.source = 'manual' OR pu.approval_status <> 'approved'))
       AND NOT EXISTS (SELECT 1 FROM attendance_audit_log l WHERE l.attendance_id = a.id)
     ORDER BY a.profile_id, a.date
  LOOP
    SELECT min(punch_time), max(punch_time), count(*) INTO v_first, v_last, v_n
      FROM punches WHERE attendance_id = r.id AND approval_status = 'approved';
    IF v_n = 0 OR (v_n = 1 AND r.date < v_today) THEN
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
      RAISE EXCEPTION 'early_late_grace_score returned nothing for Raniwala -- aborting';
    END IF;

    -- A plain Late day changes only for the 9 h rule, not because today's
    -- shift settings differ from the day it was scored.
    IF r.early_late_graced OR r.early_late_flag OR v_g.graced OR v_g.counted
       OR (r.status = 'Late' AND v_g.status = 'Present' AND v_n >= 2 AND NOT v_open
           AND ((EXTRACT(EPOCH FROM (v_last::time - v_first::time))::numeric % 86400 + 86400) % 86400) / 3600.0
               >= v_t.late_waived_after_hours) THEN
      UPDATE attendance
         SET status = v_g.status, early_late_graced = v_g.graced, early_late_flag = v_g.counted
       WHERE id = r.id
         AND (status, early_late_graced, early_late_flag) IS DISTINCT FROM (v_g.status, v_g.graced, v_g.counted);
      IF FOUND THEN
        v_changed := v_changed + 1;
      END IF;
    END IF;
  END LOOP;

  PERFORM set_config('app.regularize_apply', 'off', true);
  PERFORM set_config('app.early_late_quiet', 'off', true);
  RAISE NOTICE 'Raniwala 9 h never Late: % October day(s) re-scored', v_changed;
END $$;
