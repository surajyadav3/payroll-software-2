-- =============================================================
-- Admin attendance corrections re-scored from the OLD punches (17 Oct 2026).
--
-- Bug: trg_recompute_attendance_from_punches does
--   v_forced := current_setting('app.punch_review', true) = 'on';
-- On a pooled connection that never set the GUC, current_setting() returns
-- NULL, so v_forced is NULL and "my_role() IN (...) AND NOT v_forced AND ..."
-- is NULL: the "trust manual admin corrections" early return is skipped.
-- saveManualAttendance / regularizeAttendance upsert the attendance row
-- BEFORE they swap the punches, so the trigger scores the day from the
-- punches being replaced. Ashok Swami (EMP 87) 9 Oct: HR saved 09:20-18:40
-- (9.33 h, Present) over his own 09:20 / 06:40 entry and got
-- min..max = 06:40..09:20 = 2.67 h -> Absent. Same for 13 Oct (3.17 h) and
-- Arpita Jain (EMP 229) 3 + 9 Oct (single old punch -> 0 h -> Absent).
-- 20261008_3 worked around the same NULL in the mispunch sweeps only.
--
-- An approved regularize request (apply_approved_regularize_request) was not
-- hit: it swaps the punches first and scores the new clock-in/out itself.
--
-- Fix: COALESCE the GUC so v_forced is never NULL. Body otherwise identical
-- to the live definition (20261013_2). Then put the four broken days back to
-- what HR saved (their latest attendance_audit_log entry).
-- =============================================================

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

  SELECT min(punch_time), max(punch_time) INTO v_first, v_last
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

  RETURN NEW;
END;
$function$;

-- Repair: the days HR corrected that the bug overwrote. Restore HR's saved
-- status/hours (latest audit entry). regularize_apply makes the recompute
-- trigger keep them; the comp-off trigger still re-scores the credit.
DO $$
BEGIN
  PERFORM set_config('app.regularize_apply', 'on', true);

  WITH last_audit AS (
    SELECT DISTINCT ON (l.attendance_id) l.attendance_id, l.new_status, l.new_hours
    FROM attendance_audit_log l
    ORDER BY l.attendance_id, l.created_at DESC
  )
  UPDATE attendance a
  SET status = la.new_status, total_hours = la.new_hours
  FROM last_audit la, profiles p
  WHERE la.attendance_id = a.id
    AND p.id = a.profile_id
    AND a.tenant_id = '123c949a-329f-4a48-bb25-eed41a390cf4'
    AND (p.employee_id, a.date) IN (('87',  DATE '2026-10-09'), ('87',  DATE '2026-10-13'),
                                    ('229', DATE '2026-10-03'), ('229', DATE '2026-10-09'))
    AND a.status = 'Absent';

  PERFORM set_config('app.regularize_apply', 'off', true);
END $$;
