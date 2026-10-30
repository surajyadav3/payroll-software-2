-- =============================================================
-- Machine scan after an app clock-in is the day's Clock Out.
--
-- Raniwala staff who clock in on the app and scan the ESSL machine only on
-- the way out (emp 357 Pooja 7 + 14 Oct, and 32 other days since 26 Sep):
-- the feed has one scan that day, so first_in = the evening scan and
-- essl_apply_to_attendance stored it as a second 'in'. The day showed the
-- hours but Clock Out "-", and when the app punch was approved later the
-- recompute trigger saw "last punch is an in" on a past day -> Mispunch
-- (Pooja 14 Oct: red, 9 h 4 min).
--
-- 1. essl_apply_to_attendance: a feed scan after an app/web Clock In that
--    day goes in as 'out' (first_in only; last_out is already 'out').
-- 2. Repair: such device 'in' punches (latest punch of a day with an
--    earlier non-device 'in' and no 'out') become 'out'.
-- 3. Re-score the repaired days that are Mispunch now (from 1 Oct; the
--    other days were already scored first-to-last punch, so their hours and
--    status stay as they are).
-- =============================================================

-- 1.
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
  v_own_cut   time;
  v_moved     boolean;
  v_shift_in  boolean;
  v_nd_ids    uuid[];
  v_app_in    boolean;
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
           upper(COALESCE(m.location, 'Office')) AS location,
           -- Late-night punch-out (20261024_5), outlets with
           -- next_day_out_before: a machine scan before that time is the
           -- previous day's punch-out when the employee worked that day.
           -- own_cut: this day's scans before it are not this day's.
           CASE WHEN o.next_day_out_before IS NOT NULL
                 AND d.date >= COALESCE(o.next_day_out_from, d.date)
                 AND EXISTS (
                   SELECT 1 FROM essl_daily_punches pv
                   WHERE pv.tenant_id = d.tenant_id AND pv.essl_employee_code = d.essl_employee_code
                     AND pv.date = d.date - 1
                     AND (pv.first_in::time >= o.next_day_out_before
                          OR pv.last_out::time >= o.next_day_out_before))
                THEN o.next_day_out_before END AS own_cut,
           -- next_first / next_last: the next day's scans before it, which
           -- are this day's punch-out.
           CASE WHEN nx.first_in::time < o.next_day_out_before THEN nx.first_in END AS next_first,
           CASE WHEN nx.last_out::time < o.next_day_out_before THEN nx.last_out END AS next_last
    FROM essl_daily_punches d
    JOIN profiles p ON p.tenant_id = d.tenant_id AND p.essl_employee_code = d.essl_employee_code
    LEFT JOIN essl_employee_master m ON m.tenant_id = d.tenant_id AND m.essl_employee_code = d.essl_employee_code
    LEFT JOIN outlets o ON o.id = p.outlet_id
    LEFT JOIN essl_daily_punches nx
      ON nx.tenant_id = d.tenant_id AND nx.essl_employee_code = d.essl_employee_code
     AND nx.date = d.date + 1
     AND o.next_day_out_before IS NOT NULL
     AND d.date + 1 >= COALESCE(o.next_day_out_from, d.date + 1)
     AND (d.first_in::time >= o.next_day_out_before OR d.last_out::time >= o.next_day_out_before)
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

    -- The only scans today are last night's punch-out: no day of its own
    -- (e.g. a weekly off after working past midnight).
    v_own_cut := r.own_cut;
    IF v_att_id IS NULL AND v_own_cut IS NOT NULL
       AND COALESCE(r.first_in::time < v_own_cut, true)
       AND COALESCE(r.last_out::time < v_own_cut, true) THEN
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
        WHERE pu.attendance_id = v_att_id AND pu.approval_status = 'approved' AND NOT pu.next_day
      ) x
      WHERE x.t IS NOT NULL AND x.t::time >= v_cut;
      v_stray := v_real_first IS NOT NULL
        AND (EXTRACT(EPOCH FROM v_real_first) / 60) < v_start_min + 90
        AND (r.first_in::time < v_cut OR EXISTS (
              SELECT 1 FROM punches pu
              WHERE pu.attendance_id = v_att_id AND pu.source = 'device' AND NOT pu.next_day
                AND pu.punch_time::time < v_cut));
    END IF;

    -- Last night's punch-out stored on this day by the older rule: it is
    -- the previous day's (that day's own pass adds it there).
    v_moved := false;
    IF v_own_cut IS NOT NULL THEN
      DELETE FROM punches
      WHERE attendance_id = v_att_id AND source = 'device' AND NOT next_day
        AND punch_time::time < v_own_cut;
      v_moved := FOUND;
    END IF;
    -- With last night's scan as the feed's first_in, the arrival shows up
    -- as last_out: it is this day's Clock In.
    v_shift_in := v_own_cut IS NOT NULL AND r.first_in::time < v_own_cut
      AND NOT EXISTS (SELECT 1 FROM punches
                      WHERE attendance_id = v_att_id AND punch_type = 'in' AND NOT next_day);
    -- Clocked in on the app, scanned the machine only on the way out: the
    -- feed calls that scan first_in, but it is the day's Clock Out
    -- (20261030_1). Any approval state counts, so a later decision on the
    -- app punch never makes a re-run store the same scan again as 'in'.
    v_app_in := r.first_in IS NOT NULL AND EXISTS (
      SELECT 1 FROM punches pu
      WHERE pu.attendance_id = v_att_id AND pu.source <> 'device'
        AND pu.punch_type = 'in' AND NOT pu.next_day
        AND pu.punch_time::time < r.first_in::time);

    -- The next day's scan before next_day_out_before: this day's punch-out.
    -- created_at is the scan's own time (kept 11 s back even if the device
    -- clock runs ahead), so punches_guard's 10-second same-type cooldown
    -- never takes it for a double tap of this day's own Clock Out arriving
    -- in the same batch.
    WITH nd_ins AS (
      INSERT INTO punches (attendance_id, punch_time, punch_type, source, next_day, created_at)
      SELECT DISTINCT v_att_id, x.t, 'out', 'device', true,
             LEAST(((r.date + 1) + x.t::time) AT TIME ZONE 'Asia/Kolkata', now() - interval '11 seconds')
      FROM (VALUES (r.next_first), (r.next_last)) x(t)
      WHERE x.t IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM punches pu
          WHERE pu.attendance_id = v_att_id AND pu.next_day AND pu.punch_time = x.t)
      RETURNING id, punch_time
    ), nd_notes AS (
      INSERT INTO app_notifications (tenant_id, profile_id, actor_id, type, title, body, link_key, related_id)
      SELECT p_tenant_id, r.profile_id, NULL, 'clock_out', 'Clocked out',
             format('You clocked out at %s (biometric device). It counts on %s, the day you worked.',
                    nd_ins.punch_time, to_char(r.date, 'DD Mon')),
             'attendance', v_att_id
      FROM nd_ins
      WHERE p_notify AND r.date + 1 = v_today
      RETURNING 1
    )
    SELECT array_agg(id) INTO v_nd_ids FROM nd_ins;

    WITH incoming(t, typ) AS (
      -- The arrival punch goes in as 'in'; stray scans are not inserted.
      SELECT x.t, CASE WHEN v_stray AND x.t::time = v_real_first THEN 'in'
                       WHEN v_shift_in AND x.t = r.last_out THEN 'in'
                       WHEN v_app_in AND x.t = r.first_in THEN 'out'
                       ELSE x.typ END
      FROM (VALUES (r.first_in, 'in'), (r.last_out, 'out')) x(t, typ)
      WHERE x.t IS NOT NULL
        AND (v_own_cut IS NULL OR x.t::time >= v_own_cut)
        AND NOT (v_stray AND x.t::time < v_cut)
        AND NOT (v_stray AND x.typ = 'out' AND x.t = r.first_in)   -- same scan twice
    ), ins AS (
      INSERT INTO punches (attendance_id, punch_time, punch_type, source)
      SELECT v_att_id, i.t, i.typ, 'device'
      FROM incoming i
      WHERE NOT EXISTS (
          SELECT 1 FROM punches pu
          WHERE pu.attendance_id = v_att_id AND pu.punch_time = i.t
            AND pu.source = 'device' AND NOT pu.next_day
            -- after a stray fix (or a late-night punch-out moved off this
            -- day) the stored arrival is 'in' while the feed still calls it
            -- last_out: same scan, match on time alone (also after an
            -- app clock-in turned the feed's first_in into the Clock Out)
            AND (pu.punch_type = i.typ OR v_stray OR v_own_cut IS NOT NULL OR v_app_in))
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
    v_new_ids := array_cat(v_new_ids, v_nd_ids);

    -- Late-night punch-out moved off this day: its first remaining scan is
    -- the Clock In; a day left with no scans at all is no day.
    IF v_own_cut IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM punches WHERE attendance_id = v_att_id AND punch_type = 'in' AND NOT next_day
    ) THEN
      UPDATE punches SET punch_type = 'in'
      WHERE id = (SELECT id FROM punches
                  WHERE attendance_id = v_att_id AND source = 'device' AND NOT next_day
                    AND approval_status = 'approved'
                  ORDER BY punch_time LIMIT 1);
      v_moved := v_moved OR FOUND;
    END IF;
    IF v_moved AND NOT EXISTS (SELECT 1 FROM punches WHERE attendance_id = v_att_id) THEN
      DELETE FROM attendance
      WHERE id = v_att_id AND status IN ('Present','Late','Half Day','Absent','Mispunch');
      CONTINUE;
    END IF;

    -- Stray scan already stored (it came in before the arrival punch): drop
    -- it, and make the arrival the Clock In.
    IF v_stray THEN
      DELETE FROM punches
      WHERE attendance_id = v_att_id AND source = 'device' AND NOT next_day
        AND punch_time::time < v_cut;
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
    v_fixed := v_fixed OR v_moved;
    IF v_new_ids IS NULL AND NOT v_fixed AND v_old IS NOT NULL AND NOT p_rescore THEN
      CONTINUE;
    END IF;

    -- Keep every non-punch status as-is (punches were still added above),
    -- except a day of approved leave they came in on (20261024_6): that one
    -- is scored from its punches.
    IF v_old IS NOT NULL AND v_old NOT IN ('Present','Late','Half Day','Absent','Mispunch')
       AND NOT (v_old = 'Leave' AND leave_day_worked(r.profile_id, r.date, v_att_id)) THEN
      v_applied := v_applied + 1;
      CONTINUE;
    END IF;

    -- A punch-out after midnight (next_day) is the day's last punch.
    SELECT COALESCE(min(punch_time) FILTER (WHERE NOT next_day), min(punch_time)),
           COALESCE(max(punch_time) FILTER (WHERE next_day), max(punch_time)),
           count(*)
      INTO v_first, v_last, v_n
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


-- 2. Repair. Days to re-score are kept for step 3.
CREATE TEMP TABLE _essl_app_in_fix ON COMMIT DROP AS
SELECT pu.id AS punch_id, a.id AS attendance_id, a.tenant_id, a.date, a.status,
       p.essl_employee_code
FROM punches pu
JOIN attendance a ON a.id = pu.attendance_id
JOIN profiles p ON p.id = a.profile_id
WHERE pu.source = 'device' AND pu.punch_type = 'in' AND NOT pu.next_day
  AND EXISTS (
    SELECT 1 FROM punches x
    WHERE x.attendance_id = a.id AND x.source <> 'device' AND x.punch_type = 'in'
      AND NOT x.next_day AND x.punch_time::time < pu.punch_time::time)
  AND NOT EXISTS (
    SELECT 1 FROM punches x
    WHERE x.attendance_id = a.id AND x.id <> pu.id
      AND (x.punch_type = 'out' OR x.next_day OR x.punch_time::time > pu.punch_time::time));

UPDATE punches SET punch_type = 'out'
WHERE id IN (SELECT punch_id FROM _essl_app_in_fix);

-- 3. Re-score the Mispunch ones through the ESSL path (p_rescore).
DO $$
DECLARE f RECORD;
BEGIN
  FOR f IN
    SELECT DISTINCT tenant_id, essl_employee_code, date FROM _essl_app_in_fix
    WHERE status = 'Mispunch' AND date >= DATE '2026-10-01' AND essl_employee_code IS NOT NULL
  LOOP
    PERFORM essl_apply_to_attendance(f.tenant_id, ARRAY[f.essl_employee_code], f.date, f.date, false, true);
  END LOOP;
END $$;
