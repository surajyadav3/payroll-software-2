-- =============================================================
-- A new joiner's setup fixed after they were added re-pulls their days.
--
-- profiles_essl_code_sync applies the ESSL feed only when the ESSL code is
-- set or changed, and essl-finalize-yesterday re-scores only yesterday. So
-- when HR adds someone and fixes their record afterwards, the days already
-- in the feed were never redone:
--   * join date moved EARLIER (added with the wrong date): the scans
--     between the true and the saved join date never became attendance
--     (essl_apply skips days before joining) -> Absent, unpaid;
--   * join date moved LATER: device days before it stayed Present on the
--     calendars (payroll already pays no day before joining);
--   * shift / outlet set or changed in the first days: those days stayed
--     scored on the old (or the outlet's default) shift times.
--
-- 1. attendance_rescore_range(profile, from, to): every punch-scored day
--    (Present / Late / Half Day / Absent) in date order on the employee's
--    shift now -- hours, Late, and the late arrival / early left grace
--    (early_late_grace_score), so the month's one grace is counted again.
--    Same days left alone as early_late_rescore_month (20261028_1): edited
--    by hand (audit row), a manual punch, a punch awaiting approval, a
--    single punch on a past day, 20 Oct early closing.
-- 2. profiles_setup_refresh_attendance (AFTER UPDATE OF join_date,
--    shift_id, outlet_id), tenants on the ESSL feed:
--    * join date changed (anyone): device-only days before the new join
--      date are removed; the feed is applied from the earlier of the two
--      dates (adds the missing days) and those days re-scored;
--    * shift / outlet changed for someone who joined in the last 45 days:
--      their days from joining are re-scored on the new shift. An
--      established employee's transfer or shift change applies from the
--      change on, as before.
--    Never a month already in payroll (a processed run or a part run), or
--    before the tenant's essl_attendance_from. The raw feed is untouched,
--    so moving the join date back brings removed days back.
-- The ESSL code change itself is still handled by profiles_essl_code_sync.
-- =============================================================

-- 1.
CREATE OR REPLACE FUNCTION public.attendance_rescore_range(p_profile_id uuid, p_from date, p_to date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_t        RECORD;
  r          RECORD;
  v_g        RECORD;
  v_today    date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_now      time := (now() AT TIME ZONE 'Asia/Kolkata')::time;
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
  v_status   text;
  v_graced   boolean;
  v_counted  boolean;
  v_changed  int := 0;
BEGIN
  -- Called from the profiles trigger only (it passes the saved row's own id).
  IF pg_trigger_depth() = 0 AND auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  SELECT t.* INTO v_t
    FROM profiles p JOIN tenants t ON t.id = p.tenant_id
   WHERE p.id = p_profile_id;

  -- The recompute trigger stands aside; no same-day notifications.
  PERFORM set_config('app.regularize_apply', 'on', true);
  PERFORM set_config('app.early_late_quiet', 'on', true);

  FOR r IN
    SELECT a.id, a.date, a.status, a.total_hours, a.early_late_graced, a.early_late_flag,
           p.shift_id, p.outlet_id, ol.name AS outlet_name
      FROM attendance a
      JOIN profiles p ON p.id = a.profile_id
      LEFT JOIN outlets ol ON ol.id = p.outlet_id
     WHERE a.profile_id = p_profile_id
       AND a.date BETWEEN p_from AND LEAST(p_to, v_today)
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
      v_status := CASE WHEN v_is_late THEN 'Late' ELSE 'Present' END;
    ELSE
      v_status := CASE WHEN r.total_hours >= v_full THEN 'Present'
                       WHEN r.total_hours >= v_half THEN 'Half Day'
                       ELSE 'Absent' END;
      IF v_status = 'Present' AND v_is_late THEN
        v_status := 'Late';
      END IF;
    END IF;
    v_graced := false; v_counted := false;

    IF v_t.early_late_grace_minutes IS NOT NULL THEN
      SELECT g.* INTO v_g FROM early_late_grace_score(
        r.id, p_profile_id, r.date, v_first, v_last, v_n, v_open, v_status) g;
      IF FOUND THEN
        v_status := v_g.status; v_graced := v_g.graced; v_counted := v_g.counted;
      END IF;
    END IF;

    UPDATE attendance
       SET status = v_status, early_late_graced = v_graced, early_late_flag = v_counted
     WHERE id = r.id
       AND (status, early_late_graced, early_late_flag) IS DISTINCT FROM (v_status, v_graced, v_counted);
    IF FOUND THEN
      v_changed := v_changed + 1;
    END IF;
  END LOOP;

  PERFORM set_config('app.regularize_apply', v_prev_reg, true);
  PERFORM set_config('app.early_late_quiet', v_prev_q, true);
  RETURN v_changed;
END;
$function$;

REVOKE ALL ON FUNCTION public.attendance_rescore_range(uuid, date, date) FROM PUBLIC, anon, authenticated;

-- 2.
CREATE OR REPLACE FUNCTION public.trg_profiles_setup_refresh_attendance()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today     date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_open_from date;
  v_from      date;
  v_join      boolean := NEW.join_date IS DISTINCT FROM OLD.join_date;
  v_setup     boolean := NEW.shift_id IS DISTINCT FROM OLD.shift_id
                      OR NEW.outlet_id IS DISTINCT FROM OLD.outlet_id;
BEGIN
  -- The code itself changed: profiles_essl_code_sync applies the feed.
  IF NEW.essl_employee_code IS NULL
     OR NEW.essl_employee_code IS DISTINCT FROM OLD.essl_employee_code THEN
    RETURN NULL;
  END IF;
  IF NOT v_join AND NOT (v_setup AND NEW.join_date >= v_today - 45) THEN
    RETURN NULL;
  END IF;

  -- First day not yet in payroll, and on the feed.
  SELECT GREATEST(
           t.essl_attendance_from,
           (SELECT (max(make_date(p.year, p.month, 1)) + interval '1 month')::date
              FROM payrolls p WHERE p.tenant_id = t.id),
           (SELECT (max(make_date(r.year, r.month, 1)) + interval '1 month')::date
              FROM payroll_part_runs r WHERE r.tenant_id = t.id))
    INTO v_open_from
  FROM tenants t WHERE t.id = NEW.tenant_id AND t.essl_attendance_from IS NOT NULL;
  IF v_open_from IS NULL THEN
    RETURN NULL;
  END IF;

  -- Join date later than before: no attendance before joining. Device-only
  -- punch days go (punches cascade); anything regularized, app-punched or
  -- leave stays for HR to look at.
  IF v_join AND NEW.join_date IS NOT NULL THEN
    DELETE FROM attendance a
    WHERE a.profile_id = NEW.id
      AND a.date >= v_open_from
      AND a.date < NEW.join_date
      AND a.status IN ('Present', 'Late', 'Half Day', 'Absent', 'Mispunch')
      AND EXISTS (SELECT 1 FROM punches pu WHERE pu.attendance_id = a.id)
      AND NOT EXISTS (SELECT 1 FROM punches pu WHERE pu.attendance_id = a.id AND pu.source <> 'device');
  END IF;

  v_from := CASE WHEN v_join THEN LEAST(COALESCE(OLD.join_date, NEW.join_date), COALESCE(NEW.join_date, OLD.join_date))
                 ELSE NEW.join_date END;
  v_from := GREATEST(COALESCE(v_from, v_open_from), v_open_from);
  IF v_from > v_today THEN
    RETURN NULL;
  END IF;

  -- Missing days in (new rows only; existing rows are re-scored below,
  -- which leaves hand-edited days alone).
  PERFORM essl_apply_to_attendance(NEW.tenant_id, ARRAY[NEW.essl_employee_code], v_from, v_today, false, false);
  PERFORM attendance_rescore_range(NEW.id, v_from, v_today);
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS profiles_setup_refresh_attendance ON public.profiles;
CREATE TRIGGER profiles_setup_refresh_attendance
  AFTER UPDATE OF join_date, shift_id, outlet_id ON public.profiles
  FOR EACH ROW
  WHEN (OLD.join_date IS DISTINCT FROM NEW.join_date
        OR OLD.shift_id IS DISTINCT FROM NEW.shift_id
        OR OLD.outlet_id IS DISTINCT FROM NEW.outlet_id)
  EXECUTE FUNCTION public.trg_profiles_setup_refresh_attendance();
