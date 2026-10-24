-- Shift picked from the punch-in time (IndWell Hotel first).
--
-- IndWell's staff work many shifts and almost nobody has one assigned, so
-- every day was judged against the company's 09:00 and most days came out
-- Late. With tenants.auto_shift_from_punch on, each day's shift is the one
-- whose start is nearest the day's first punch (11:00 in -> the 11:00 shift),
-- stored on attendance.shift_id, and Late is measured from that start.
--
--   * Same start, more than one shift (10-7 and 10-8 UT/KST): a shift kept
--     for the employee's designation (shifts.for_designations) wins, then
--     once they clock out the one whose end is nearest the last punch.
--   * Exactly halfway between two starts (10:30): the earlier shift.
--   * shifts.auto_pick = false keeps a shift out of the picking.
--   * Split shifts (07-13 + 19-23) are one row: start 07:00, end 23:00.

SET lock_timeout = '5s';

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS auto_shift_from_punch boolean NOT NULL DEFAULT false;
ALTER TABLE shifts  ADD COLUMN IF NOT EXISTS auto_pick boolean NOT NULL DEFAULT true;
ALTER TABLE shifts  ADD COLUMN IF NOT EXISTS for_designations text[]; -- NULL = everyone; letters only, lower case ('K.s.t' -> 'kst')
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS shift_id uuid REFERENCES shifts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_attendance_shift_id ON attendance(shift_id) WHERE shift_id IS NOT NULL;

RESET lock_timeout;


-- ── The pick ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.auto_shift_pick(p_tenant_id uuid, p_profile_id uuid, p_first text, p_last text, p_closed boolean)
RETURNS uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH x AS (
    SELECT s.id, s.name, s.for_designations, s.total_hours,
           -- signed minutes from shift start to first punch, folded to -720..719
           (((EXTRACT(EPOCH FROM substr(p_first, 1, 8)::time - s.start_time) / 60)::numeric + 720) % 1440 + 1440) % 1440 - 720 AS d_in,
           CASE WHEN p_closed AND p_last IS NOT NULL THEN
             abs((((EXTRACT(EPOCH FROM substr(p_last, 1, 8)::time - s.end_time) / 60)::numeric + 720) % 1440 + 1440) % 1440 - 720)
           END AS d_out
      FROM shifts s
     WHERE s.tenant_id = p_tenant_id
       AND s.auto_pick
       AND (s.for_designations IS NULL OR EXISTS (
             SELECT 1 FROM profiles p
              WHERE p.id = p_profile_id
                AND regexp_replace(lower(COALESCE(p.designation, '')), '[^a-z]', '', 'g') = ANY (s.for_designations)))
  )
  SELECT id FROM x
   ORDER BY abs(d_in),
            (d_in < 0),                      -- halfway: the shift already started
            (for_designations IS NULL),      -- designation's own shift first
            d_out NULLS LAST,
            total_hours, name, id
   LIMIT 1
$function$;
REVOKE ALL ON FUNCTION public.auto_shift_pick(uuid, uuid, text, text, boolean) FROM PUBLIC;


-- ── Scoring: live definition (20261024_6) + the picked shift ─────────────
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


-- ── Re-score the day on the employee's own punch ─────────────────────────
-- Clock-in only inserts the attendance row (status worked out on the phone /
-- browser against the profile's timing) and a punch; nothing re-scored the
-- day until clock-out. Forced, like trg_punch_pending_notify, so an admin's
-- own punch is scored too. Someone else's punch (an HR correction) is left
-- alone - that stays a manual edit.
CREATE OR REPLACE FUNCTION public.trg_punch_auto_shift_rescore()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.approval_status <> 'approved' THEN
    RETURN NEW; -- pending: trg_punch_pending_notify re-scores the day
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM attendance a JOIN tenants t ON t.id = a.tenant_id
     WHERE a.id = NEW.attendance_id
       AND a.profile_id = auth.uid()
       AND t.auto_shift_from_punch
  ) THEN
    RETURN NEW;
  END IF;

  PERFORM set_config('app.punch_review', 'on', true);
  UPDATE attendance SET total_hours = total_hours WHERE id = NEW.attendance_id;
  PERFORM set_config('app.punch_review', 'off', true);
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_punch_auto_shift_rescore ON punches;
CREATE TRIGGER trg_punch_auto_shift_rescore
  AFTER INSERT ON punches
  FOR EACH ROW EXECUTE FUNCTION trg_punch_auto_shift_rescore();


-- ── Bulk re-score (Settings save, backfills): same picked shift ──────────
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
  v_auto boolean;
  v_day_shift uuid;
  v_last_type text;
BEGIN
  -- auth.uid() is NULL when run as a plain migration/service-role script
  -- (trusted, same as every DO block elsewhere in supabase/migrations/); a
  -- real end-user session must be admin/manager/superadmin for this tenant.
  IF auth.uid() IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND tenant_id = p_tenant_id AND role IN ('admin','manager','superadmin')
  ) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  SELECT COALESCE(t.auto_shift_from_punch, false) INTO v_auto FROM tenants t WHERE t.id = p_tenant_id;

  -- Same reason as every backfill before this one: the plain UPDATE below
  -- would otherwise be immediately recomputed back to Present/Half
  -- Day/Absent by trg_recompute_attendance_from_punches, which has no
  -- concept of 'Late' unless the caller is already an authenticated
  -- admin/manager/superadmin (it trusts those and returns early). USER (not
  -- ALL) — ALL also tries to disable internal RI_ConstraintTrigger_* FK
  -- triggers this role doesn't own.
  ALTER TABLE attendance DISABLE TRIGGER USER;

  FOR v_row IN
    SELECT a.id, a.status, a.profile_id, a.date, a.early_late_graced, a.early_late_flag, a.shift_id AS day_shift_id,
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

    SELECT COALESCE(min(pu.punch_time) FILTER (WHERE NOT pu.next_day), min(pu.punch_time)),
           COALESCE(max(pu.punch_time) FILTER (WHERE pu.next_day), max(pu.punch_time)),
           count(*)
      INTO v_g_first, v_g_last, v_g_n
    FROM punches pu WHERE pu.attendance_id = v_row.id AND pu.approval_status = 'approved';

    -- The day's shift from its punches (20261024_8), for tenants on that rule.
    v_day_shift := v_row.day_shift_id;
    IF v_auto AND v_g_first IS NOT NULL THEN
      SELECT pu.punch_type INTO v_last_type
      FROM punches pu WHERE pu.attendance_id = v_row.id AND pu.approval_status = 'approved'
      ORDER BY pu.next_day DESC, pu.punch_time DESC, pu.created_at DESC
      LIMIT 1;
      v_day_shift := auto_shift_pick(p_tenant_id, v_row.profile_id, v_g_first, v_g_last, v_last_type IS DISTINCT FROM 'in');
    END IF;

    v_shift_start := NULL;
    IF COALESCE(CASE WHEN v_auto THEN v_day_shift END, v_row.shift_id) IS NOT NULL THEN
      SELECT s.start_time INTO v_shift_start FROM shifts s
       WHERE s.id = COALESCE(CASE WHEN v_auto THEN v_day_shift END, v_row.shift_id);
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
    SELECT g.* INTO v_g FROM early_late_grace_score(
      v_row.id, v_row.profile_id, v_row.date, v_g_first, v_g_last, v_g_n,
      v_row.date >= (now() AT TIME ZONE 'Asia/Kolkata')::date, v_new_status) g;
    IF FOUND THEN
      v_new_status := v_g.status; v_graced := v_g.graced; v_counted := v_g.counted;
    END IF;

    IF v_new_status IS DISTINCT FROM v_row.status
       OR (v_graced, v_counted) IS DISTINCT FROM (v_row.early_late_graced, v_row.early_late_flag)
       OR v_day_shift IS DISTINCT FROM v_row.day_shift_id THEN
      UPDATE attendance SET status = v_new_status, late_grace_used = false,
             early_late_graced = v_graced, early_late_flag = v_counted,
             shift_id = v_day_shift
      WHERE id = v_row.id;
      v_updated := v_updated + 1;
    END IF;
  END LOOP;

  ALTER TABLE attendance ENABLE TRIGGER USER;

  RETURN v_updated;
END;
$function$;


-- ── IndWell Hotel: its shift list, picking on ────────────────────────────
DO $$
DECLARE
  v_t uuid := '71a81994-32f4-428e-93ab-6f20f64a1858';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = v_t) THEN
    RETURN;
  END IF;

  -- 00:00 - 21:00 "Afternoon 2" is not on the hotel's list.
  UPDATE shifts SET auto_pick = false
   WHERE tenant_id = v_t AND start_time = '00:00' AND end_time = '21:00';

  -- Already there: 07-16, 08-17, 10-19, 11-20, 14-23, 15-24. Add the rest.
  INSERT INTO shifts (tenant_id, name, start_time, end_time, total_hours, grace_minutes, early_exit_threshold_minutes, for_designations)
  SELECT v_t, x.name, x.st::time, x.en::time, x.hrs, 0, 0, x.des
    FROM (VALUES
      ('General 09:00 AM - 06:00 PM',                         '09:00', '18:00',  9, NULL::text[]),
      ('Store Driver 09:00 AM - 07:00 PM',                    '09:00', '19:00', 10, ARRAY['driver','storedriver']),
      ('UT/KST 10:00 AM - 08:00 PM',                          '10:00', '20:00', 10, ARRAY['ut','kst']),
      ('UT/KST 11:00 AM - 09:00 PM',                          '11:00', '21:00', 10, ARRAY['ut','kst']),
      ('UT/KST 02:00 PM - 12:00 AM',                          '14:00', '00:00', 10, ARRAY['ut','kst']),
      ('Split 07:00 AM - 01:00 PM / 07:00 PM - 11:00 PM',     '07:00', '23:00', 10, NULL),
      ('Split 07:00 AM - 01:00 PM / 06:00 PM - 11:00 PM',     '07:00', '23:00', 11, NULL),
      ('Split 08:00 AM - 02:00 PM / 08:00 PM - 11:00 PM',     '08:00', '23:00',  9, NULL),
      ('Security Guard 08:00 AM - 02:00 PM / 06:00 PM - 12:00 AM', '08:00', '00:00', 12, ARRAY['guard','securityguard'])
    ) AS x(name, st, en, hrs, des)
   WHERE NOT EXISTS (SELECT 1 FROM shifts s WHERE s.tenant_id = v_t AND s.name = x.name);

  UPDATE tenants SET auto_shift_from_punch = true WHERE id = v_t;
END $$;

NOTIFY pgrst, 'reload schema';
