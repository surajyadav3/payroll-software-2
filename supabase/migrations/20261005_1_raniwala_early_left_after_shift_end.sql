-- =============================================================
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

    WITH incoming(t, typ) AS (
      VALUES (r.first_in, 'in'), (r.last_out, 'out')
    ), ins AS (
      INSERT INTO punches (attendance_id, punch_time, punch_type, source)
      SELECT v_att_id, i.t, i.typ, 'device'
      FROM incoming i
      WHERE i.t IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM punches pu
          WHERE pu.attendance_id = v_att_id AND pu.punch_time = i.t
            AND pu.punch_type = i.typ AND pu.source = 'device')
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

    -- Nothing new and the row already existed: status is already settled
    -- (unless this is the nightly finalize re-score).
    IF v_new_ids IS NULL AND v_old IS NOT NULL AND NOT p_rescore THEN
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
    IF p_rescore AND v_new_ids IS NULL AND v_n <= 1 THEN
      CONTINUE;
    END IF;

    -- Same precedence as resolveAttendanceSettings() / essl-punch.
    SELECT s.start_time::text AS start_time, s.end_time::text AS end_time,
           s.early_departure_after, s.late_arrival_allowance_until
      INTO v_shift FROM shifts s WHERE s.id = r.shift_id;
    SELECT o.shift_start, o.shift_end, o.late_threshold, o.min_half_day_hours, o.min_full_day_hours
      INTO v_outlet FROM outlets o WHERE o.id = r.outlet_id;

    v_start    := COALESCE(v_shift.start_time, v_outlet.shift_start, v_tenant.shift_start, '10:30');
    v_end      := COALESCE(v_shift.end_time,   v_outlet.shift_end,   v_tenant.shift_end,   '18:00');
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
