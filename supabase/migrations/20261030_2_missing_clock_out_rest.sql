-- =============================================================
-- Missing Clock Out / wrong Mispunch, the rest (follows 20261030_1).
--
-- 1. essl_apply_to_attendance: the machine scan after an app Clock In is
--    the Clock Out only 2 h+ after it and while it is still open. A scan
--    soon after is the same arrival twice (12 Raniwala days since 26 Sep,
--    gap 2-59 min, e.g. app 10:21 + machine 10:25, out 19:19); 20261030_1
--    would have made that morning scan the Clock Out from today on.
-- 2. Mispunch tenants (Raniwala), finished day: a Clock In after the day's
--    Clock Out that was never closed (app tap after the machine scan out:
--    emp 523 28 Oct, emp 65 29 Oct) no longer makes the day Mispunch or
--    adds hours -- scored up to that Clock Out. Trigger + ESSL path agree.
-- 3. punches_guard: the employee's own app / web Clock In while already
--    clocked in that day is refused (IndWell OTH1043 25 Oct, OTH1052 13 Oct:
--    two Clock Ins, no Clock Out).
-- 4. Regularize request with Clock Out not after Clock In is refused
--    (AM / PM slips: 09:28 - 06:15 scored 20.78 h, two got a comp off),
--    except a real overnight: outlet next-day punch-out (Delhi), overnight
--    shift, or a tenant on auto shift (IndWell night shifts).
-- 5. Data: the two IndWell double-Clock-In days (2 h+ apart) get the
--    second as Clock Out; those and the Raniwala Oct days of rule 2 are
--    re-scored.
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
  v_tail      text;
  v_tail_out  text;
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
    -- 20261030_2: only 2 h+ after that app Clock In, and only while it is
    -- still open -- a scan soon after it is the same arrival made twice
    -- (app 10:21 + machine 10:25, then out 19:19), not a departure.
    v_app_in := r.first_in IS NOT NULL AND r.first_in::time >= time '02:00' AND EXISTS (
      SELECT 1 FROM punches pu
      WHERE pu.attendance_id = v_att_id AND pu.source <> 'device'
        AND pu.punch_type = 'in' AND NOT pu.next_day
        AND pu.punch_time::time <= r.first_in::time - interval '2 hours'
        AND NOT EXISTS (
          SELECT 1 FROM punches po
          WHERE po.attendance_id = v_att_id AND po.punch_type = 'out' AND NOT po.next_day
            AND po.punch_time::time >= pu.punch_time::time
            AND po.punch_time::time < r.first_in::time));

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

    -- Finished day, Mispunch tenants: a Clock In after the day's Clock Out
    -- that was never closed (an app tap after the machine scan out) adds no
    -- hours -- same rule as trg_recompute_attendance_from_punches (20261030_2).
    IF r.date < v_today AND COALESCE(v_tenant.mark_single_punch_mispunch, false) THEN
      SELECT punch_type INTO v_tail FROM punches
      WHERE attendance_id = v_att_id AND approval_status = 'approved'
      ORDER BY next_day DESC, punch_time DESC, created_at DESC LIMIT 1;
      IF v_tail = 'in' THEN
        SELECT max(o.punch_time) INTO v_tail_out FROM punches o
        WHERE o.attendance_id = v_att_id AND o.approval_status = 'approved'
          AND o.punch_type = 'out' AND NOT o.next_day
          AND EXISTS (SELECT 1 FROM punches i
                      WHERE i.attendance_id = v_att_id AND i.approval_status = 'approved'
                        AND i.punch_type = 'in' AND NOT i.next_day AND i.punch_time < o.punch_time);
        v_last := COALESCE(v_tail_out, v_last);
      END IF;
    END IF;

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

-- 2.
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
  v_auto boolean;
  v_tail_out text;
BEGIN
  -- A half-day leave (20261013_2) is scored from the punches as usual, then
  -- zz_leave_overrides_attendance_status settles it.
  IF EXISTS (
    SELECT 1 FROM leave_requests lr
    WHERE lr.profile_id = NEW.profile_id
      AND lr.status = 'Approved'
      AND NEW.date BETWEEN lr.start_date AND lr.end_date
      AND lr.half_day IS NULL
  ) AND NOT leave_day_worked(NEW.profile_id, NEW.date, NEW.id) THEN
    -- (20261024_6: unless they came in that day -- then it is scored from
    -- its punches like any working day, and HR decides on the leave.)
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

  -- A punch-out after midnight (next_day, 20261024_5) is the day's last.
  SELECT COALESCE(min(punch_time) FILTER (WHERE NOT next_day), min(punch_time)),
         COALESCE(max(punch_time) FILTER (WHERE next_day), max(punch_time)),
         count(*)
    INTO v_first, v_last, v_n
  FROM punches WHERE attendance_id = NEW.id AND approval_status = 'approved';

  SELECT punch_type INTO v_last_type
  FROM punches WHERE attendance_id = NEW.id AND approval_status = 'approved'
  ORDER BY next_day DESC, punch_time DESC, created_at DESC
  LIMIT 1;

  -- Mispunch tenants, finished day: a Clock In after the day's Clock Out
  -- that was never closed (an app tap after the machine scan out, emp 523
  -- 28 Oct 09:28 in / 21:02 out / 21:30 app in) is not an open day and adds
  -- no hours -- the day is scored up to that Clock Out, not Mispunch
  -- (20261030_2).
  IF v_last_type = 'in' AND NEW.date < v_today
     AND (SELECT COALESCE(t.mark_single_punch_mispunch, false) FROM tenants t WHERE t.id = NEW.tenant_id) THEN
    SELECT max(o.punch_time) INTO v_tail_out FROM punches o
    WHERE o.attendance_id = NEW.id AND o.approval_status = 'approved'
      AND o.punch_type = 'out' AND NOT o.next_day
      AND EXISTS (SELECT 1 FROM punches i
                  WHERE i.attendance_id = NEW.id AND i.approval_status = 'approved'
                    AND i.punch_type = 'in' AND NOT i.next_day AND i.punch_time < o.punch_time);
    IF v_tail_out IS NOT NULL THEN
      v_last := v_tail_out;
      v_last_type := 'out';
    END IF;
  END IF;

  IF v_first IS NOT NULL AND v_last IS NOT NULL THEN
    v_total := (
      (EXTRACT(EPOCH FROM (v_last::time - v_first::time))::numeric % 86400 + 86400) % 86400
    ) / 3600.0;
  END IF;

  SELECT p.outlet_id, p.shift_id INTO v_outlet_id, v_shift_id FROM profiles p WHERE p.id = NEW.profile_id;

  -- The day's shift from its punches (20261024_8), for tenants on that rule.
  SELECT t.auto_shift_from_punch INTO v_auto FROM tenants t WHERE t.id = NEW.tenant_id;
  v_auto := COALESCE(v_auto, false) AND v_first IS NOT NULL;
  IF v_auto THEN
    NEW.shift_id := auto_shift_pick(NEW.tenant_id, NEW.profile_id, v_first, v_last, v_last_type IS DISTINCT FROM 'in');
    v_shift_id := COALESCE(NEW.shift_id, v_shift_id);
  END IF;

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
  ELSIF v_auto AND NEW.status = 'Present' THEN
    -- Picked shift: Late from its start every time, never a Late the
    -- clock-in screen worked out against the company's timing.
    IF v_is_late THEN
      NEW.status := 'Late';
    END IF;
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

-- 3.
CREATE OR REPLACE FUNCTION public.punches_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_recent_count int;
  v_total_count  int;
BEGIN
  -- Cooldown: block a second punch of the same type within 10s (double-click,
  -- slow-network retry, or a client-side spam loop).
  SELECT count(*) INTO v_recent_count
  FROM punches
  WHERE attendance_id = NEW.attendance_id
    AND punch_type = NEW.punch_type
    AND created_at > now() - interval '10 seconds';

  IF v_recent_count > 0 THEN
    RAISE EXCEPTION 'Please wait a few seconds before punching again.'
      USING ERRCODE = 'P0001';
  END IF;

  -- The employee's own app / web Clock In while already clocked in that day
  -- (a stale screen): refused, or the day gets two Clock Ins and no Clock
  -- Out (IndWell OTH1043 25 Oct 10:18 in + 20:05 in) (20261030_2).
  IF NEW.punch_type = 'in' AND COALESCE(NEW.source, 'app') = 'app'
     AND NOT COALESCE(NEW.next_day, false)
     AND auth.uid() IS NOT NULL
     AND auth.uid() = (SELECT profile_id FROM attendance WHERE id = NEW.attendance_id)
     AND (SELECT pu.punch_type FROM punches pu
          WHERE pu.attendance_id = NEW.attendance_id
            AND pu.approval_status <> 'rejected' AND NOT pu.next_day
          ORDER BY pu.punch_time DESC, pu.created_at DESC
          LIMIT 1) = 'in' THEN
    RAISE EXCEPTION 'You are already clocked in today. Refresh and use Clock Out.'
      USING ERRCODE = 'P0001';
  END IF;

  -- Sanity cap: stop a scripted flood against one attendance record even if
  -- it's spaced out beyond the cooldown window above.
  SELECT count(*) INTO v_total_count
  FROM punches
  WHERE attendance_id = NEW.attendance_id;

  IF v_total_count >= 40 THEN
    RAISE EXCEPTION 'Too many punches recorded for this day. Contact your admin.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$function$;

-- 4.
CREATE OR REPLACE FUNCTION public.trg_regularize_out_after_in()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_ok boolean;
BEGIN
  IF NEW.clock_in_time IS NULL OR NEW.clock_out_time IS NULL
     OR NEW.clock_out_time > NEW.clock_in_time THEN
    RETURN NEW;
  END IF;
  SELECT (o.next_day_out_before IS NOT NULL AND NEW.clock_out_time < o.next_day_out_before)
      OR (s.end_time IS NOT NULL AND s.end_time < s.start_time)
      OR (NULLIF(o.shift_end, '')::time < NULLIF(o.shift_start, '')::time)
      OR COALESCE(t.auto_shift_from_punch, false)
    INTO v_ok
  FROM profiles p
  JOIN tenants t ON t.id = p.tenant_id
  LEFT JOIN outlets o ON o.id = p.outlet_id
  LEFT JOIN shifts s ON s.id = p.shift_id
  WHERE p.id = NEW.profile_id;
  IF COALESCE(v_ok, false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Clock Out (%) must be later than Clock In (%). Please check AM / PM.',
    to_char(NEW.clock_out_time, 'HH12:MI AM'), to_char(NEW.clock_in_time, 'HH12:MI AM')
    USING ERRCODE = 'P0001';
END;
$function$;

DROP TRIGGER IF EXISTS trg_regularize_out_after_in ON public.regularize_requests;
CREATE TRIGGER trg_regularize_out_after_in
  BEFORE INSERT OR UPDATE OF clock_in_time, clock_out_time ON public.regularize_requests
  FOR EACH ROW EXECUTE FUNCTION trg_regularize_out_after_in();

-- 5. Data.
CREATE TEMP TABLE _fix_double_in ON COMMIT DROP AS
SELECT (array_agg(p.id ORDER BY p.punch_time))[2] AS punch_id, a.id AS attendance_id
FROM attendance a JOIN punches p ON p.attendance_id = a.id
WHERE a.date < (now() AT TIME ZONE 'Asia/Kolkata')::date
GROUP BY a.id
HAVING count(*) = 2
   AND bool_and(p.punch_type = 'in' AND p.source = 'app' AND p.approval_status = 'approved' AND NOT p.next_day)
   AND max(p.punch_time)::time - min(p.punch_time)::time >= interval '2 hours';

UPDATE punches SET punch_type = 'out' WHERE id IN (SELECT punch_id FROM _fix_double_in);

CREATE TEMP TABLE _fix_rescore ON COMMIT DROP AS
SELECT attendance_id FROM _fix_double_in
UNION
SELECT a.id
FROM attendance a JOIN tenants t ON t.id = a.tenant_id
WHERE t.mark_single_punch_mispunch
  AND a.date >= DATE '2026-10-01' AND a.date < (now() AT TIME ZONE 'Asia/Kolkata')::date
  AND a.status IN ('Present','Late','Half Day','Absent','Mispunch')
  AND (SELECT pu.punch_type FROM punches pu
       WHERE pu.attendance_id = a.id AND pu.approval_status = 'approved'
       ORDER BY pu.next_day DESC, pu.punch_time DESC, pu.created_at DESC LIMIT 1) = 'in'
  AND EXISTS (SELECT 1 FROM punches o
              WHERE o.attendance_id = a.id AND o.approval_status = 'approved' AND o.punch_type = 'out'
                AND NOT o.next_day
                AND EXISTS (SELECT 1 FROM punches i
                            WHERE i.attendance_id = a.id AND i.approval_status = 'approved'
                              AND i.punch_type = 'in' AND NOT i.next_day AND i.punch_time < o.punch_time));

-- No-op update: recompute_attendance_from_punches re-scores the day.
UPDATE attendance SET total_hours = total_hours WHERE id IN (SELECT attendance_id FROM _fix_rescore);
