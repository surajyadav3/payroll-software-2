-- =============================================================
-- Raniwala: Late arrival / Early out, one grace a month (17 Oct 2026).
--
-- The rule HR gave, Office Staff (10:20 - 19:15, Late Allowed 10 min) as
-- the example:
--   up to 10:30          on time
--   10:31 - 11:05        Late, as before (Report Time + Late Allowed)
--   after 11:05          "late arrival": more than 45 min after shift start
--   before 18:30         "early out": more than 45 min before shift end
-- Late arrival and early out share ONE grace a month. The first one in a
-- calendar month is graced: the day is not Late, and short hours from it do
-- not make it a Half Day. Every one after that in the month is Late (counts
-- toward the Late deduction: 4 Lates = 1/2 day, 7 = 1 day).
--
-- How far the grace stretches is the limit already set on each shift
-- (shifts.late_arrival_allowance_until / early_departure_after: Office
-- 12:00 / 17:30, Factory 11:00 / 16:30, Delhi + Gurgaon 12:30 / 18:00).
-- Arriving after that limit, or leaving before it, falls back to the hours
-- rule (under 8 h = Half Day) and does not use the grace. A shift without
-- limits (3 one-off shifts) only gets the Late mark lifted / added; hours
-- still decide Half Day.
--
-- This replaces, for tenants with tenants.early_late_grace_minutes set
-- (Raniwala only):
--   * the per-shift "monthly allowance" (first breach of those limits free,
--     a repeat forced Half Day; attendance.monthly_allowance_used), and
--   * the 90-minute visibility counter (20260923_1).
-- attendance.early_late_graced = this day used the month's grace,
-- attendance.early_late_flag = counted as Late because the grace was
-- already used. The web (My Attendance, Employee Calendar) shows these two
-- columns. The employee also gets a notification (and push) the day it
-- happens.
--
-- Not used on: weekly off / holiday worked (no shift that day), half-day
-- leave days, Mispunch / Pending Approval / Leave days, regularized or
-- HR-corrected days.
--
-- Scored in one place, early_late_grace_score(), called from both scoring
-- paths: essl_apply_to_attendance (device punches) and
-- trg_recompute_attendance_from_punches (app punches), plus the Settings
-- re-score recompute_attendance_late_status. Function bodies otherwise
-- identical to the live definitions (essl_apply 20261006_1 + 20260928_11,
-- recompute trigger 20261017_1).
--
-- October 2026 is re-scored once at the end, without notifications.
-- =============================================================

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS early_late_grace_minutes int
  CHECK (early_late_grace_minutes IS NULL OR early_late_grace_minutes > 0);

COMMENT ON COLUMN public.tenants.early_late_grace_minutes IS
  'Late arrival / early out grace (20261017_3): first punch more than N min after shift start, or last punch more than N min before shift end, within the shift''s late_arrival_allowance_until / early_departure_after limits. First in a month graced, then Late. NULL = old per-shift Half Day allowance + 90-min counter.';

-- Returns no row when the tenant is not on this rule (the caller keeps its
-- own scoring). Otherwise the day's final status and the two flags.
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
  SELECT t.early_late_grace_minutes, p.tenant_id, p.outlet_id,
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
    INTO v_mins, v_tenant, v_outlet, v_start, v_end, v_cap_in, v_cap_out,
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

-- ── App punches: the recompute trigger (live 20261017_1 + grace) ──
CREATE OR REPLACE FUNCTION public.trg_recompute_attendance_from_punches()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_total numeric := 0;
  v_half  numeric;
  v_full  numeric;
  v_first text;
  v_last  text;
  v_last_type text;
  v_outlet_id uuid;
  v_shift_id uuid;
  v_shift_start text;
  v_late_min int;
  -- COALESCE: an unset GUC is NULL, which would make every NOT v_forced NULL.
  v_forced boolean := COALESCE(current_setting('app.punch_review', true), '') = 'on';
  v_pending boolean;
  v_unreviewed boolean;
  v_reviewing boolean;
  v_is_late boolean;
  v_single_mispunch boolean;
  v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_n int;
  v_g RECORD;
BEGIN
  -- A half-day leave (20261013_2) is scored from the punches as usual, then
  -- zz_leave_overrides_attendance_status settles it.
  IF EXISTS (
    SELECT 1 FROM leave_requests lr
    WHERE lr.profile_id = NEW.profile_id
      AND lr.status = 'Approved'
      AND NEW.date BETWEEN lr.start_date AND lr.end_date
      AND lr.half_day IS NULL
  ) THEN
    NEW.status := 'Leave';
    RETURN NEW;
  END IF;

  SELECT COALESCE(bool_or(approval_status = 'pending'), false),
         COALESCE(bool_or(approval_status <> 'approved'), false)
  INTO v_pending, v_unreviewed
  FROM punches WHERE attendance_id = NEW.id;

  IF my_role() IN ('admin','manager','superadmin')
     AND NOT v_forced
     AND (auth.uid() IS DISTINCT FROM NEW.profile_id OR NOT v_unreviewed) THEN
    RETURN NEW; -- trust manual admin corrections
  END IF;

  -- approved regularize request being applied by apply_approved_regularize_request()
  IF current_setting('app.regularize_apply', true) = 'on' THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'Mispunch' AND NOT v_forced
     AND (SELECT count(*) FROM punches WHERE attendance_id = NEW.id) <= 1 THEN
    RETURN NEW;
  END IF;

  SELECT min(punch_time), max(punch_time), count(*) INTO v_first, v_last, v_n
  FROM punches WHERE attendance_id = NEW.id AND approval_status = 'approved';

  SELECT punch_type INTO v_last_type
  FROM punches WHERE attendance_id = NEW.id AND approval_status = 'approved'
  ORDER BY punch_time DESC, created_at DESC
  LIMIT 1;

  IF v_first IS NOT NULL AND v_last IS NOT NULL THEN
    v_total := (
      (EXTRACT(EPOCH FROM (v_last::time - v_first::time))::numeric % 86400 + 86400) % 86400
    ) / 3600.0;
  END IF;

  SELECT p.outlet_id, p.shift_id INTO v_outlet_id, v_shift_id FROM profiles p WHERE p.id = NEW.profile_id;

  SELECT
    COALESCE(o.min_half_day_hours, t.min_half_day_hours, 4),
    COALESCE(o.min_full_day_hours, t.min_full_day_hours, 8)
  INTO v_half, v_full
  FROM tenants t
  LEFT JOIN outlets o ON o.id = v_outlet_id
  WHERE t.id = NEW.tenant_id;

  -- Report Time + Late Allowed - same precedence as recompute_attendance_late_status().
  IF v_shift_id IS NOT NULL THEN
    SELECT s.start_time INTO v_shift_start FROM shifts s WHERE s.id = v_shift_id;
  END IF;
  SELECT COALESCE(v_shift_start, o.shift_start, t.shift_start, '10:30'),
         COALESCE(o.late_threshold, t.late_threshold, 0),
         COALESCE(t.mark_single_punch_mispunch, false)
  INTO v_shift_start, v_late_min, v_single_mispunch
  FROM tenants t
  LEFT JOIN outlets o ON o.id = v_outlet_id
  WHERE t.id = NEW.tenant_id;

  v_reviewing := v_forced OR OLD.status = 'Pending Approval';
  v_is_late := v_first IS NOT NULL AND
    (EXTRACT(HOUR FROM v_first::time)::int * 60 + EXTRACT(MINUTE FROM v_first::time)::int)
    - (EXTRACT(HOUR FROM v_shift_start::time)::int * 60 + EXTRACT(MINUTE FROM v_shift_start::time)::int)
    > v_late_min;

  NEW.total_hours := GREATEST(round(v_total * 100) / 100, 0);
  NEW.status := CASE
    WHEN NEW.total_hours >= v_full THEN 'Present'
    WHEN NEW.total_hours >= v_half THEN 'Half Day'
    ELSE 'Absent'
  END;

  IF v_pending THEN
    NEW.status := 'Pending Approval';
  ELSIF v_last_type = 'in' AND (NEW.date >= v_today OR v_reviewing) THEN
    -- No clock-out yet: judged on arrival time, not (unfinished) hours. A
    -- past day that never got one is a Mispunch where the tenant opts in.
    NEW.status := CASE
      WHEN NEW.date < v_today AND v_single_mispunch THEN 'Mispunch'
      WHEN v_is_late THEN 'Late'
      ELSE 'Present'
    END;
  ELSIF OLD.status = 'Late' AND NEW.status = 'Present' THEN
    NEW.status := 'Late';
  ELSIF v_reviewing AND NEW.status = 'Present' AND v_is_late THEN
    NEW.status := 'Late';
  END IF;

  -- Late arrival / early out, one grace a month (20261017_3), for tenants
  -- on that rule. Replaces the client's monthly allowance / 90-min marks.
  IF NOT v_pending THEN
    SELECT g.* INTO v_g FROM early_late_grace_score(
      NEW.id, NEW.profile_id, NEW.date, v_first, v_last, v_n, v_last_type = 'in', NEW.status) g;
    IF FOUND THEN
      NEW.status := v_g.status;
      NEW.early_late_graced := v_g.graced;
      NEW.early_late_flag := v_g.counted;
      NEW.monthly_allowance_used := false;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

-- ── Device punches: essl_apply_to_attendance (live + grace) ──
CREATE OR REPLACE FUNCTION public.essl_apply_to_attendance(p_tenant_id uuid, p_codes text[] DEFAULT NULL::text[], p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date, p_notify boolean DEFAULT false, p_rescore boolean DEFAULT false)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_from      date;
  v_today     date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_now_time  time := (now() AT TIME ZONE 'Asia/Kolkata')::time;
  v_tenant    RECORD;
  r           RECORD;
  v_att_id    uuid;
  v_old       text;
  v_first     text;
  v_last      text;
  v_n         int;
  v_new_ids   uuid[];
  v_shift     RECORD;
  v_outlet    RECORD;
  v_start     text;
  v_end       text;
  v_late_min  int;
  v_half      numeric;
  v_full      numeric;
  v_total     numeric;
  v_status    text;
  v_is_late   boolean;
  v_open      boolean;
  v_allow     boolean;
  v_el_flag   boolean;
  v_el_grace  boolean;
  v_month     date;
  v_start_min int;
  v_cut_min   int;
  v_cut       time;
  v_real_first time;
  v_stray     boolean;
  v_fixed     boolean;
  v_applied   int := 0;
  v_g         RECORD;
BEGIN
  -- Direct RPC callers must be the tenant's HR (or service role, uid NULL).
  -- Called from profiles_essl_code_sync (pg_trigger_depth() > 0) it is
  -- trusted: that trigger only passes the saved row's own tenant + code, and
  -- an employee's own profile save must not fail because their code was
  -- just filled in from their EMP code.
  IF auth.uid() IS NOT NULL AND pg_trigger_depth() = 0 AND NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid()
      AND (role = 'superadmin' OR (tenant_id = p_tenant_id AND role = 'admin'))
  ) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  SELECT * INTO v_tenant FROM tenants WHERE id = p_tenant_id;
  IF v_tenant.essl_attendance_from IS NULL THEN
    RETURN 0;
  END IF;
  v_from := GREATEST(COALESCE(p_from, v_tenant.essl_attendance_from), v_tenant.essl_attendance_from);

  -- trg_recompute_attendance_from_punches would overwrite the status set
  -- below (it knows nothing of Late on a new row, the monthly allowance, or
  -- Mispunch with 2 punches). Its existing bypass flag is reused -- it also
  -- skips the geofence insert check, which never applies to a machine punch.
  -- Leave override and comp-off-by-hours triggers still run as normal.
  PERFORM set_config('app.regularize_apply', 'on', true);

  FOR r IN
    SELECT d.essl_employee_code, d.date, d.first_in, d.last_out,
           p.id AS profile_id, p.shift_id, p.outlet_id,
           upper(COALESCE(m.location, 'Office')) AS location
    FROM essl_daily_punches d
    JOIN profiles p ON p.tenant_id = d.tenant_id AND p.essl_employee_code = d.essl_employee_code
    LEFT JOIN essl_employee_master m ON m.tenant_id = d.tenant_id AND m.essl_employee_code = d.essl_employee_code
    WHERE d.tenant_id = p_tenant_id
      AND (p_codes IS NULL OR d.essl_employee_code = ANY (p_codes))
      AND d.date >= v_from
      AND (p.join_date IS NULL OR d.date >= p.join_date)   -- no attendance before joining
      AND (p_to IS NULL OR d.date <= p_to)
      AND (d.first_in IS NOT NULL OR d.last_out IS NOT NULL)
    ORDER BY p.id, d.date            -- monthly counters below read earlier days
  LOOP
    BEGIN
    SELECT id, status INTO v_att_id, v_old
    FROM attendance WHERE profile_id = r.profile_id AND date = r.date;

    -- Regularized day: HR/employee's approved times are the truth. Leave it.
    IF v_att_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM punches WHERE attendance_id = v_att_id AND source = 'manual'
    ) THEN
      CONTINUE;
    END IF;

    IF v_att_id IS NULL THEN
      INSERT INTO attendance (tenant_id, profile_id, date, status, total_hours, location)
      VALUES (p_tenant_id, r.profile_id, r.date, 'Present', 0, r.location || ' (Device)')
      ON CONFLICT (profile_id, date) DO NOTHING
      RETURNING id INTO v_att_id;
      IF v_att_id IS NULL THEN
        SELECT id, status INTO v_att_id, v_old FROM attendance WHERE profile_id = r.profile_id AND date = r.date;
      END IF;
    END IF;

    -- Same precedence as resolveAttendanceSettings() / essl-punch.
    -- (Read before the punch insert: the stray-scan check below needs it.)
    SELECT s.start_time::text AS start_time, s.end_time::text AS end_time,
           s.early_departure_after, s.late_arrival_allowance_until
      INTO v_shift FROM shifts s WHERE s.id = r.shift_id;
    SELECT o.shift_start, o.shift_end, o.late_threshold, o.min_half_day_hours, o.min_full_day_hours,
           o.ignore_early_punch_minutes
      INTO v_outlet FROM outlets o WHERE o.id = r.outlet_id;

    v_start    := COALESCE(v_shift.start_time, v_outlet.shift_start, v_tenant.shift_start, '10:30');
    v_end      := COALESCE(v_shift.end_time,   v_outlet.shift_end,   v_tenant.shift_end,   '18:00');

    -- Stray early scan (20261006_1): a device punch more than N min before
    -- shift start is dropped when a real arrival punch (start - N .. start +
    -- 90 min, from the feed or already stored) exists; that arrival becomes
    -- the Clock In. Day shifts only.
    v_stray := false; v_fixed := false; v_cut := NULL; v_real_first := NULL;
    v_start_min := (EXTRACT(EPOCH FROM substr(v_start, 1, 5)::time) / 60)::int;
    v_cut_min   := v_start_min - v_outlet.ignore_early_punch_minutes;
    IF v_cut_min > 0 AND substr(v_end, 1, 5)::time > substr(v_start, 1, 5)::time THEN
      v_cut := substr(v_start, 1, 5)::time - make_interval(mins => v_outlet.ignore_early_punch_minutes);
      SELECT min(x.t::time) INTO v_real_first
      FROM (
        SELECT r.first_in AS t UNION ALL SELECT r.last_out
        UNION ALL
        SELECT pu.punch_time FROM punches pu
        WHERE pu.attendance_id = v_att_id AND pu.approval_status = 'approved'
      ) x
      WHERE x.t IS NOT NULL AND x.t::time >= v_cut;
      v_stray := v_real_first IS NOT NULL
        AND (EXTRACT(EPOCH FROM v_real_first) / 60) < v_start_min + 90
        AND (r.first_in::time < v_cut OR EXISTS (
              SELECT 1 FROM punches pu
              WHERE pu.attendance_id = v_att_id AND pu.source = 'device'
                AND pu.punch_time::time < v_cut));
    END IF;

    WITH incoming(t, typ) AS (
      -- The arrival punch goes in as 'in'; stray scans are not inserted.
      SELECT x.t, CASE WHEN v_stray AND x.t::time = v_real_first THEN 'in' ELSE x.typ END
      FROM (VALUES (r.first_in, 'in'), (r.last_out, 'out')) x(t, typ)
      WHERE x.t IS NOT NULL
        AND NOT (v_stray AND x.t::time < v_cut)
        AND NOT (v_stray AND x.typ = 'out' AND x.t = r.first_in)   -- same scan twice
    ), ins AS (
      INSERT INTO punches (attendance_id, punch_time, punch_type, source)
      SELECT v_att_id, i.t, i.typ, 'device'
      FROM incoming i
      WHERE NOT EXISTS (
          SELECT 1 FROM punches pu
          WHERE pu.attendance_id = v_att_id AND pu.punch_time = i.t
            AND pu.source = 'device'
            -- after a stray fix the stored arrival is 'in' while the feed
            -- still calls it last_out: same scan, match on time alone
            AND (pu.punch_type = i.typ OR v_stray))
      RETURNING id, punch_time, punch_type
    ), notes AS (
      INSERT INTO app_notifications (tenant_id, profile_id, actor_id, type, title, body, link_key, related_id)
      SELECT p_tenant_id, r.profile_id, NULL,
             CASE WHEN ins.punch_type = 'in' THEN 'clock_in' ELSE 'clock_out' END,
             CASE WHEN ins.punch_type = 'in' THEN 'Clocked in' ELSE 'Clocked out' END,
             format('You clocked %s at %s (biometric device).', ins.punch_type, ins.punch_time),
             'attendance', v_att_id
      FROM ins
      WHERE p_notify AND r.date = v_today
      RETURNING 1
    )
    SELECT array_agg(id) INTO v_new_ids FROM ins;

    -- Stray scan already stored (it came in before the arrival punch): drop
    -- it, and make the arrival the Clock In.
    IF v_stray THEN
      DELETE FROM punches
      WHERE attendance_id = v_att_id AND source = 'device' AND punch_time::time < v_cut;
      v_fixed := FOUND;
      IF EXISTS (
        SELECT 1 FROM punches
        WHERE attendance_id = v_att_id AND punch_type = 'in' AND punch_time::time = v_real_first
      ) THEN
        -- the old essl-punch path stored some arrivals as both out + in
        DELETE FROM punches
        WHERE attendance_id = v_att_id AND source = 'device' AND punch_type = 'out'
          AND punch_time::time = v_real_first;
      ELSE
        UPDATE punches SET punch_type = 'in'
        WHERE id = (SELECT id FROM punches
                    WHERE attendance_id = v_att_id AND source = 'device' AND punch_type = 'out'
                      AND approval_status = 'approved' AND punch_time::time = v_real_first
                    LIMIT 1);
      END IF;
      v_fixed := v_fixed OR FOUND;
    END IF;

    -- Nothing new and the row already existed: status is already settled
    -- (unless this is the nightly finalize re-score or a stray fix).
    IF v_new_ids IS NULL AND NOT v_fixed AND v_old IS NOT NULL AND NOT p_rescore THEN
      CONTINUE;
    END IF;

    -- Keep every non-punch status as-is (punches were still added above).
    IF v_old IS NOT NULL AND v_old NOT IN ('Present','Late','Half Day','Absent','Mispunch') THEN
      v_applied := v_applied + 1;
      CONTINUE;
    END IF;

    SELECT min(punch_time), max(punch_time), count(*) INTO v_first, v_last, v_n
    FROM punches WHERE attendance_id = v_att_id AND approval_status = 'approved';

    -- The finalize re-score is only for days that have an exit punch to
    -- judge; it must not start turning old single-punch days into Mispunch.
    IF p_rescore AND v_new_ids IS NULL AND NOT v_fixed AND v_n <= 1 THEN
      CONTINUE;
    END IF;

    v_late_min := COALESCE(v_outlet.late_threshold, v_tenant.late_threshold, 0);
    v_half     := COALESCE(v_outlet.min_half_day_hours, v_tenant.min_half_day_hours, 4);
    v_full     := COALESCE(v_outlet.min_full_day_hours, v_tenant.min_full_day_hours, 8);

    v_is_late := (EXTRACT(EPOCH FROM (v_first::time - substr(v_start, 1, 5)::time)) / 60) > v_late_min;
    -- Today's shift still running: the last punch so far isn't a departure.
    -- (Day shifts only; an overnight shift is never treated as open.)
    v_open := r.date = v_today
              AND substr(v_end, 1, 5)::time > substr(v_start, 1, 5)::time
              AND v_now_time < substr(v_end, 1, 5)::time;
    v_allow := false; v_el_flag := false; v_el_grace := false;
    v_month := date_trunc('month', r.date)::date;

    IF v_n <= 1 THEN
      -- One punch. A past day is final -> Mispunch (tenant opt-in, same as
      -- the nightly mark_mispunches sweep); today it is just "clocked in".
      v_total := 0;
      IF r.date < v_today AND COALESCE(v_tenant.mark_single_punch_mispunch, false) THEN
        v_status := 'Mispunch';
      ELSE
        v_status := CASE WHEN v_is_late THEN 'Late' ELSE 'Present' END;
      END IF;
    ELSE
      -- First punch to last punch, either type (see 20260918_3).
      v_total := round(((EXTRACT(EPOCH FROM (v_last::time - v_first::time))::numeric % 86400 + 86400) % 86400) / 3600.0, 2);
      IF v_open THEN
        -- Hours so far say nothing about the day yet (same as an open app
        -- day in 20260929_1): Late/Present only.
        v_status := CASE WHEN v_is_late OR v_old = 'Late' THEN 'Late' ELSE 'Present' END;
      ELSE
        v_status := CASE WHEN v_total >= v_full THEN 'Present'
                         WHEN v_total >= v_half THEN 'Half Day'
                         ELSE 'Absent' END;
        IF v_status = 'Present' AND (v_is_late OR v_old = 'Late') THEN
          v_status := 'Late';
        END IF;
      END IF;

      -- Tenants on the late arrival / early out grace (20261017_3) are
      -- scored below instead of by these two older rules.
      IF v_tenant.early_late_grace_minutes IS NULL THEN
      -- Once-a-month allowance for an extreme early exit / late arrival
      -- (per-shift, opt-in); a repeat in the same month forces Half Day.
      -- The early-exit half waits for the shift to end.
      IF v_status <> 'Absent' AND (
           (NOT v_open AND v_shift.early_departure_after IS NOT NULL AND v_last::time < v_shift.early_departure_after)
        OR (v_shift.late_arrival_allowance_until IS NOT NULL AND v_first::time > v_shift.late_arrival_allowance_until)
      ) THEN
        IF EXISTS (
          SELECT 1 FROM attendance a
          WHERE a.profile_id = r.profile_id AND a.id <> v_att_id AND a.monthly_allowance_used
            AND a.date >= v_month AND a.date <= r.date
        ) THEN
          v_status := 'Half Day';
        ELSE
          v_allow := true;
        END IF;
      END IF;

      -- Early Left / Late Arrival monthly counter (visibility only), same
      -- 90-minute rule as computeEarlyLateBreach(). Early Left only once the
      -- shift is over.
      IF (EXTRACT(EPOCH FROM (v_first::time - substr(v_start, 1, 5)::time)) / 60) > 90
         OR (NOT v_open AND (EXTRACT(EPOCH FROM (substr(v_end, 1, 5)::time - v_last::time)) / 60) > 90) THEN
        IF EXISTS (
          SELECT 1 FROM attendance a
          WHERE a.profile_id = r.profile_id AND (a.early_late_flag OR a.early_late_graced)
            AND a.date >= v_month AND a.date < r.date
        ) THEN
          v_el_flag := true;
        ELSE
          v_el_grace := true;
        END IF;
      END IF;
      END IF;  -- early_late_grace_minutes IS NULL
    END IF;

    -- Late arrival / early out, one grace a month (20261017_3).
    IF v_tenant.early_late_grace_minutes IS NOT NULL THEN
      SELECT g.* INTO v_g FROM early_late_grace_score(
        v_att_id, r.profile_id, r.date, v_first, v_last, v_n, v_open, v_status) g;
      IF FOUND THEN
        v_status := v_g.status; v_el_grace := v_g.graced; v_el_flag := v_g.counted;
      END IF;
    END IF;

    UPDATE attendance
    SET status = v_status, total_hours = v_total,
        monthly_allowance_used = v_allow,
        early_late_flag = v_el_flag, early_late_graced = v_el_grace
        -- auto_marked is left as-is: attendance_employee_update_guard only
        -- lets admins change it, and nothing reads it once real punches exist.
    WHERE id = v_att_id
      AND (status, total_hours, monthly_allowance_used, early_late_flag, early_late_graced)
          IS DISTINCT FROM (v_status, v_total, v_allow, v_el_flag, v_el_grace);

    v_applied := v_applied + 1;

    EXCEPTION WHEN OTHERS THEN
      -- One bad day (e.g. punches_guard's 10-second cooldown if HR saves the
      -- code while a poll cycle is applying the same day) must not fail the
      -- whole batch. Poison this mirror row's count so the next ingest sees
      -- it as changed and retries just this day.
      RAISE WARNING 'essl apply skipped % % : %', r.essl_employee_code, r.date, SQLERRM;
      UPDATE essl_daily_punches SET punch_count = -1
      WHERE tenant_id = p_tenant_id AND essl_employee_code = r.essl_employee_code AND date = r.date;
    END;
  END LOOP;

  PERFORM set_config('app.regularize_apply', 'off', true);
  RETURN v_applied;
END;
$function$;

-- ── Settings re-score after a Report Time change (live 20260918_2 + grace) ──
CREATE OR REPLACE FUNCTION public.recompute_attendance_late_status(p_tenant_id uuid, p_outlet_id uuid, p_from_date date, p_to_date date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row RECORD;
  v_shift_start text;
  v_late_threshold int;
  v_first_in text;
  v_diff_min int;
  v_new_status text;
  v_updated int := 0;
  v_g RECORD;
  v_g_first text;
  v_g_last text;
  v_g_n int;
  v_graced boolean;
  v_counted boolean;
BEGIN
  -- auth.uid() is NULL when run as a plain migration/service-role script
  -- (trusted, same as every DO block elsewhere in supabase/migrations/); a
  -- real end-user session must be admin/manager/superadmin for this tenant.
  IF auth.uid() IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND tenant_id = p_tenant_id AND role IN ('admin','manager','superadmin')
  ) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  -- Same reason as every backfill before this one: the plain UPDATE below
  -- would otherwise be immediately recomputed back to Present/Half
  -- Day/Absent by trg_recompute_attendance_from_punches, which has no
  -- concept of 'Late' unless the caller is already an authenticated
  -- admin/manager/superadmin (it trusts those and returns early). USER (not
  -- ALL) — ALL also tries to disable internal RI_ConstraintTrigger_* FK
  -- triggers this role doesn't own.
  ALTER TABLE attendance DISABLE TRIGGER USER;

  FOR v_row IN
    SELECT a.id, a.status, a.profile_id, a.date, a.early_late_graced, a.early_late_flag,
           p.outlet_id, p.shift_id, p.tenant_id
    FROM attendance a
    JOIN profiles p ON p.id = a.profile_id
    WHERE p.tenant_id = p_tenant_id
      AND (p_outlet_id IS NULL OR p.outlet_id = p_outlet_id)
      AND a.date BETWEEN p_from_date AND p_to_date
      AND a.status IN ('Present', 'Late')
      AND a.location IN ('Office', 'Office (Device)')
    ORDER BY a.profile_id, a.date   -- the month's grace goes to the first day
  LOOP
    SELECT pu.punch_time INTO v_first_in
    FROM punches pu
    WHERE pu.attendance_id = v_row.id AND pu.punch_type = 'in'
    ORDER BY pu.punch_time
    LIMIT 1;

    IF v_first_in IS NULL THEN
      CONTINUE;
    END IF;

    v_shift_start := NULL;
    IF v_row.shift_id IS NOT NULL THEN
      SELECT s.start_time INTO v_shift_start FROM shifts s WHERE s.id = v_row.shift_id;
    END IF;

    -- Same outlet-then-tenant-then-hard-default precedence as
    -- resolveAttendanceSettings() in src/services/tenantService.js.
    SELECT
      COALESCE(v_shift_start, o.shift_start, t.shift_start, '10:30'),
      COALESCE(o.late_threshold, t.late_threshold, 0)
    INTO v_shift_start, v_late_threshold
    FROM tenants t
    LEFT JOIN outlets o ON o.id = v_row.outlet_id
    WHERE t.id = v_row.tenant_id;

    v_diff_min := (EXTRACT(HOUR FROM v_first_in::time)::int * 60 + EXTRACT(MINUTE FROM v_first_in::time)::int)
                - (EXTRACT(HOUR FROM v_shift_start::time)::int * 60 + EXTRACT(MINUTE FROM v_shift_start::time)::int);

    -- The whole rule: later than Report Time + Late Allowed minutes is Late.
    -- No grace waiver on top of this.
    v_new_status := CASE WHEN v_diff_min > v_late_threshold THEN 'Late' ELSE 'Present' END;

    -- Late arrival / early out grace (20261017_3), tenants on that rule.
    v_graced := v_row.early_late_graced; v_counted := v_row.early_late_flag;
    SELECT min(pu.punch_time), max(pu.punch_time), count(*) INTO v_g_first, v_g_last, v_g_n
    FROM punches pu WHERE pu.attendance_id = v_row.id AND pu.approval_status = 'approved';
    SELECT g.* INTO v_g FROM early_late_grace_score(
      v_row.id, v_row.profile_id, v_row.date, v_g_first, v_g_last, v_g_n,
      v_row.date >= (now() AT TIME ZONE 'Asia/Kolkata')::date, v_new_status) g;
    IF FOUND THEN
      v_new_status := v_g.status; v_graced := v_g.graced; v_counted := v_g.counted;
    END IF;

    IF v_new_status IS DISTINCT FROM v_row.status
       OR (v_graced, v_counted) IS DISTINCT FROM (v_row.early_late_graced, v_row.early_late_flag) THEN
      UPDATE attendance SET status = v_new_status, late_grace_used = false,
             early_late_graced = v_graced, early_late_flag = v_counted
      WHERE id = v_row.id;
      v_updated := v_updated + 1;
    END IF;
  END LOOP;

  ALTER TABLE attendance ENABLE TRIGGER USER;

  RETURN v_updated;
END;
$function$;

-- ── Tell the employee the day it happens (app_notifications -> push) ──
CREATE OR REPLACE FUNCTION public.trg_early_late_grace_notify()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_used date;
BEGIN
  IF COALESCE(current_setting('app.early_late_quiet', true), '') = 'on'
     OR NEW.date IS DISTINCT FROM (now() AT TIME ZONE 'Asia/Kolkata')::date
     OR NOT EXISTS (SELECT 1 FROM tenants WHERE id = NEW.tenant_id AND early_late_grace_minutes IS NOT NULL) THEN
    RETURN NULL;
  END IF;

  IF NEW.early_late_graced AND (TG_OP = 'INSERT' OR NOT OLD.early_late_graced) THEN
    INSERT INTO app_notifications (tenant_id, profile_id, actor_id, type, title, body, link_key, related_id)
    VALUES (NEW.tenant_id, NEW.profile_id, NULL, 'early_late_grace',
            'Late arrival / early out grace used',
            format('You used this month''s one late arrival / early out grace today (%s), so today is not marked Late. The next late arrival or early out in %s will be marked Late.',
                   to_char(NEW.date, 'DD Mon'), to_char(NEW.date, 'FMMonth')),
            'attendance', NEW.id);
  ELSIF NEW.early_late_flag AND (TG_OP = 'INSERT' OR NOT OLD.early_late_flag) THEN
    SELECT min(a.date) INTO v_used
      FROM attendance a
     WHERE a.profile_id = NEW.profile_id AND a.early_late_graced
       AND a.date >= date_trunc('month', NEW.date)::date AND a.date < NEW.date;
    INSERT INTO app_notifications (tenant_id, profile_id, actor_id, type, title, body, link_key, related_id)
    VALUES (NEW.tenant_id, NEW.profile_id, NULL, 'early_late_counted',
            'Marked Late: grace already used',
            format('Today (%s) is marked Late for a late arrival / early out. This month''s grace was already used%s.',
                   to_char(NEW.date, 'DD Mon'),
                   CASE WHEN v_used IS NOT NULL THEN ' on ' || to_char(v_used, 'DD Mon') ELSE '' END),
            'attendance', NEW.id);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS zzzz_early_late_grace_notify ON public.attendance;
-- No column list: the flags are set by BEFORE triggers, which UPDATE OF
-- does not see. The function only acts when a flag turns on.
CREATE TRIGGER zzzz_early_late_grace_notify
  AFTER INSERT OR UPDATE ON public.attendance
  FOR EACH ROW WHEN (NEW.early_late_graced OR NEW.early_late_flag)
  EXECUTE FUNCTION public.trg_early_late_grace_notify();

-- ── Raniwala on the rule + October re-scored once ──────────────────────
-- Only days scored from punches alone: regularized / HR-corrected days
-- (manual punches or an attendance_audit_log entry), days with a punch
-- still awaiting approval, and past single-punch days are left as they are.
-- Every October day first loses its old marks, so the month's grace is
-- worked out again from the 1st. Hours are not touched.
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

  UPDATE tenants SET early_late_grace_minutes = 45 WHERE id = v_tenant;
  SELECT * INTO v_t FROM tenants WHERE id = v_tenant;

  -- Scored here, so the recompute trigger stands aside (same flag
  -- essl_apply_to_attendance uses); no notifications for the re-score.
  PERFORM set_config('app.regularize_apply', 'on', true);
  PERFORM set_config('app.early_late_quiet', 'on', true);

  UPDATE attendance
     SET early_late_flag = false, early_late_graced = false, monthly_allowance_used = false
   WHERE tenant_id = v_tenant AND date >= '2026-10-01'
     AND (early_late_flag OR early_late_graced OR monthly_allowance_used);

  FOR r IN
    SELECT a.id, a.profile_id, a.date, a.status, a.total_hours, p.shift_id, p.outlet_id
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

    -- Same settings precedence and day scoring as essl_apply_to_attendance.
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

    -- Only days the new rule decides (a grace / counted day, or one the
    -- old allowance had pushed to Half Day) change status.
    IF v_g.graced OR v_g.counted OR (r.status = 'Half Day' AND v_g.status <> 'Half Day') THEN
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
  RAISE NOTICE 'Raniwala late arrival / early out grace: % October day(s) re-scored', v_changed;
END $$;
