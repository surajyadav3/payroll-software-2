-- =============================================================
-- Office Staff: ignore a stray device scan well before shift start (6 Oct 2026)
-- + carries 20261005_1 (never applied live; this file supersedes it --
--   do NOT apply 20261005_1 after this, it would drop the part below).
--
-- Bug: Rajesh Jain (EMP 3) and EMP 1 (Raniwala, Office Staff 10:20-19:15)
-- scan the ESSL device around 09:20-09:35 almost every day, then again at
-- 10:00-10:28 when they actually arrive. The 09:31 scan became Clock In and
-- the real arrival became Clock Out, so the day read 0.7 h / Absent until the
-- evening punch (and stayed Absent on many September days).
--
-- Rule (outlets.ignore_early_punch_minutes, set to 40 for Raniwala Office
-- Staff only; NULL = off everywhere else):
--   a DEVICE punch more than N minutes before shift start is dropped when
--   another punch exists between (start - N) and (start + 90 min) -- that
--   later punch is the real arrival and becomes the Clock In. With no such
--   arrival punch the early scan is kept (someone who really came early and
--   punched only once more in the evening is not made Absent).
--   Day shifts only. Regularized days are untouched (as before).
--   The mirror (essl_daily_punches.first_in) still holds the early scan; it
--   is just never re-inserted while the arrival punch exists.
--
-- Backfill: every past Office Staff day with that pattern is re-applied
-- (31 days since 18 Aug, EMP 1 / 3 / 210; no Raniwala payroll run yet).
-- =============================================================

-- ── 20261005_1 (unchanged text below) ─────────────────────────
-- Early Left is only judged once the shift is over (5 Oct 2026).
--
-- Bug: Rajesh Jain (Raniwala, EMP 3, Office Staff 10:20-19:15) punched the
-- ESSL device at 09:27 and 10:20 this morning. The 2-minute sync scored the
-- day immediately: 10:20 was his "last" punch, more than 90 min before
-- 19:15, so the day showed Early Left / Late Arrival (graced) and Absent
-- (0.88 h) while he was still at work.
--
-- The rule itself is unchanged (20260923_1): Late Arrival = first punch
-- more than 90 min after shift start; Early Left = last punch more than 90
-- min before shift end; the first of either in a calendar month is graced,
-- every later one that month is counted.
--
-- Fix (essl_apply_to_attendance, live def = 20260928_8 + _9 + _11):
--   * While today's shift is still running (IST now < shift end), the day is
--     "open": status is Late/Present like a single-punch today (not scored
--     on hours so far), and only the late-arrival halves of the 90-minute
--     counter and the per-shift monthly allowance are checked. Early
--     departure waits until the shift has ended.
--   * New p_rescore (default false) re-scores days even when no new punch
--     arrived. A nightly job (01:50 IST, after the 01:40 reconcile) runs it
--     for yesterday, so someone who really left at 10:20 and never punched
--     again still gets Early Left / Half Day / Absent once the day is over.
--     The re-score skips single-punch days, so it never turns an old
--     forgot-to-punch-out day into Mispunch (unchanged behaviour there).
--   * The final UPDATE is skipped when nothing changed (lean on writes).
-- =============================================================

ALTER TABLE outlets ADD COLUMN IF NOT EXISTS ignore_early_punch_minutes integer
  CHECK (ignore_early_punch_minutes IS NULL OR ignore_early_punch_minutes BETWEEN 1 AND 300);
COMMENT ON COLUMN outlets.ignore_early_punch_minutes IS
  'Device punch more than this many minutes before shift start is a stray scan when a real arrival punch (start - N .. start + 90 min) follows. NULL = off.';

UPDATE outlets SET ignore_early_punch_minutes = 40
WHERE id = 'cb798dbe-32c4-467f-bfb4-5fd939cf2b59'   -- Raniwala "Office Staff"
  AND ignore_early_punch_minutes IS DISTINCT FROM 40;

DROP FUNCTION IF EXISTS public.essl_apply_to_attendance(uuid, text[], date, date, boolean);

CREATE OR REPLACE FUNCTION public.essl_apply_to_attendance(
  p_tenant_id uuid,
  p_codes     text[]  DEFAULT NULL,
  p_from      date    DEFAULT NULL,
  p_to        date    DEFAULT NULL,
  p_notify    boolean DEFAULT false,
  p_rescore   boolean DEFAULT false   -- re-score even when no new punch (nightly finalize)
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
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

REVOKE ALL ON FUNCTION public.essl_apply_to_attendance(uuid, text[], date, date, boolean, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.essl_apply_to_attendance(uuid, text[], date, date, boolean, boolean) TO authenticated, service_role;

-- ── Nightly finalize: re-score yesterday now that every shift is over ──
-- 01:50 IST (20:20 UTC): after the 01:40 IST 7-day reconcile pulls any late
-- punches. Only rows whose result changes are written.
select cron.unschedule('essl-finalize-yesterday')
where exists (select 1 from cron.job where jobname = 'essl-finalize-yesterday');

select cron.schedule(
  'essl-finalize-yesterday',
  '20 20 * * *',
  $$
  select essl_apply_to_attendance(t.id, NULL, d.y, d.y, false, true)
  from tenants t,
       (select ((now() AT TIME ZONE 'Asia/Kolkata')::date - 1) AS y) d
  where t.essl_attendance_from IS NOT NULL;
  $$
);

-- ── Re-score today right away so open days scored before this fix (e.g.
-- EMP 3's 10:20 "Early Left") drop back to Late/Present. ──
select essl_apply_to_attendance(t.id, NULL, (now() AT TIME ZONE 'Asia/Kolkata')::date,
                                (now() AT TIME ZONE 'Asia/Kolkata')::date, false, true)
from tenants t
where t.essl_attendance_from IS NOT NULL;

-- ── Backfill (20261006_1): past days with a stray early scan followed by a
-- real arrival, at outlets that have the rule on. Oldest first, so the
-- monthly Early Left / allowance counters read already-fixed earlier days.
-- Days without an arrival punch in the window are left alone. ──
DO $$
DECLARE
  d record;
BEGIN
  FOR d IN
    WITH emp AS (
      SELECT p.id, p.tenant_id, p.essl_employee_code, t.essl_attendance_from,
             o.ignore_early_punch_minutes AS n,
             substr(COALESCE(s.start_time::text, o.shift_start, t.shift_start, '10:30'), 1, 5)::time AS st
      FROM profiles p
      JOIN tenants t ON t.id = p.tenant_id AND t.essl_attendance_from IS NOT NULL
      JOIN outlets o ON o.id = p.outlet_id AND o.ignore_early_punch_minutes IS NOT NULL
      LEFT JOIN shifts s ON s.id = p.shift_id
      WHERE p.essl_employee_code IS NOT NULL
    )
    SELECT e.tenant_id, e.essl_employee_code, a.date
    FROM emp e
    JOIN attendance a ON a.profile_id = e.id AND a.date >= e.essl_attendance_from
                     AND a.date < (now() AT TIME ZONE 'Asia/Kolkata')::date
    WHERE EXISTS (SELECT 1 FROM punches pu
                  WHERE pu.attendance_id = a.id AND pu.source = 'device'
                    AND pu.punch_time::time < e.st - make_interval(mins => e.n))
      AND EXISTS (SELECT 1 FROM punches pu
                  WHERE pu.attendance_id = a.id AND pu.approval_status = 'approved'
                    AND pu.punch_time::time >= e.st - make_interval(mins => e.n)
                    AND pu.punch_time::time <  e.st + interval '90 minutes')
    ORDER BY a.date
  LOOP
    PERFORM essl_apply_to_attendance(d.tenant_id, ARRAY[d.essl_employee_code], d.date, d.date, false, true);
  END LOOP;
END $$;
