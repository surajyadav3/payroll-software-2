-- Raniwala: half-day leave - the first or second half of the employee's own shift.
--
-- User (2026-10-13): "allow employees to send a leave for half day first half
-- and second half according to the shift of that employee" (web + app).
--
-- * leave_requests.half_day: NULL = whole day(s); 'first_half' / 'second_half'
--   = that half of ONE date (start_date = end_date).
--   half_day_from / half_day_to: the half's clock times, stamped from the
--   employee's shift when they apply - shift start .. midpoint, or midpoint ..
--   shift end. Stored on the row so a later shift change does not move it.
-- * leave_half_day_window(profile, half): shift = profiles.shift_id, else the
--   outlet's, else the tenant's (same order as essl_apply_to_attendance).
--   my_leave_half_day_windows() gives the apply forms (web + app) both halves.
-- * A half day routes like a 1-day leave (duration_days stays 1) and counts
--   0.5: the ledger deduction is cut to -0.5 by a leave_ledger trigger, so it
--   holds whichever record_leave_deduction is live (20261011_2 is not applied
--   yet and replaces it).
-- * Attendance: an approved half day never makes the day 'Leave'. The worked
--   half is 'Half Day' (they were only due for the other half, so no Late and
--   no early-exit / late-arrival marks); no punches = no row, as before.
--   Both halves approved on one date = a full 'Leave' day.
-- * Clashes are refused: the same half twice, a half day inside a full-day
--   leave, or a full-day leave over a half day (Rejected requests don't count).
-- * Notifications name the half and its times.

ALTER TABLE public.leave_requests
  ADD COLUMN IF NOT EXISTS half_day text,
  ADD COLUMN IF NOT EXISTS half_day_from time,
  ADD COLUMN IF NOT EXISTS half_day_to time;

ALTER TABLE public.leave_requests DROP CONSTRAINT IF EXISTS leave_requests_half_day_check;
ALTER TABLE public.leave_requests ADD CONSTRAINT leave_requests_half_day_check
  CHECK (half_day IS NULL OR (half_day IN ('first_half', 'second_half') AND end_date = start_date));

COMMENT ON COLUMN public.leave_requests.half_day IS
  'NULL = full day(s). first_half / second_half = half of one date, counted as 0.5 day (20261013_2).';
COMMENT ON COLUMN public.leave_requests.half_day_from IS
  'Start of the half-day leave, from the employee''s shift when they applied. Set by trg_leave_half_day.';
COMMENT ON COLUMN public.leave_requests.half_day_to IS
  'End of the half-day leave, from the employee''s shift when they applied. Set by trg_leave_half_day.';

-- ---------------------------------------------------------------------------
-- The two halves of an employee's shift.

CREATE OR REPLACE FUNCTION public.leave_half_day_window(
  p_profile_id uuid, p_half text,
  OUT o_from time, OUT o_to time,
  OUT o_shift_name text, OUT o_shift_start time, OUT o_shift_end time)
 RETURNS record
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_len int;
  v_mid time;
BEGIN
  SELECT s.name,
         COALESCE(s.start_time, substr(NULLIF(o.shift_start, ''), 1, 5)::time,
                  substr(NULLIF(t.shift_start, ''), 1, 5)::time, '10:30'::time),
         COALESCE(s.end_time, substr(NULLIF(o.shift_end, ''), 1, 5)::time,
                  substr(NULLIF(t.shift_end, ''), 1, 5)::time, '18:00'::time)
    INTO o_shift_name, o_shift_start, o_shift_end
    FROM profiles p
    JOIN tenants t ON t.id = p.tenant_id
    LEFT JOIN outlets o ON o.id = p.outlet_id
    LEFT JOIN shifts s ON s.id = p.shift_id
   WHERE p.id = p_profile_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Minutes in the shift (an overnight shift wraps past midnight).
  v_len := ((EXTRACT(EPOCH FROM (o_shift_end - o_shift_start)) / 60)::int + 1440) % 1440;
  IF v_len = 0 THEN v_len := 1440; END IF;
  v_mid := o_shift_start + make_interval(mins => v_len / 2);

  IF p_half = 'first_half' THEN
    o_from := o_shift_start; o_to := v_mid;
  ELSIF p_half = 'second_half' THEN
    o_from := v_mid; o_to := o_shift_end;
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.leave_half_day_window(uuid, text) FROM PUBLIC, anon, authenticated;

-- For the apply forms: the signed-in employee's own two halves.
CREATE OR REPLACE FUNCTION public.my_leave_half_day_windows()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'shift_name',  f.o_shift_name,
    'shift_start', to_char(f.o_shift_start, 'HH24:MI'),
    'shift_end',   to_char(f.o_shift_end, 'HH24:MI'),
    'first_half',  jsonb_build_object('from', to_char(f.o_from, 'HH24:MI'), 'to', to_char(f.o_to, 'HH24:MI')),
    'second_half', jsonb_build_object('from', to_char(s.o_from, 'HH24:MI'), 'to', to_char(s.o_to, 'HH24:MI')))
  FROM leave_half_day_window(auth.uid(), 'first_half') f,
       leave_half_day_window(auth.uid(), 'second_half') s
  WHERE f.o_shift_start IS NOT NULL;
$function$;

REVOKE ALL ON FUNCTION public.my_leave_half_day_windows() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_leave_half_day_windows() TO authenticated;

-- 'first half (10:20 AM – 2:47 PM)'
CREATE OR REPLACE FUNCTION public.leave_half_day_label(p_half text, p_from time, p_to time)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE p_half WHEN 'first_half' THEN 'first half' WHEN 'second_half' THEN 'second half' END
         || COALESCE(' (' || to_char(p_from, 'FMHH12:MI AM') || ' – ' || to_char(p_to, 'FMHH12:MI AM') || ')', '');
$function$;

-- ---------------------------------------------------------------------------
-- Check + stamp a half-day request.

CREATE OR REPLACE FUNCTION public.trg_leave_half_day()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_other record;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.half_day IS NOT DISTINCT FROM OLD.half_day
     AND NEW.start_date IS NOT DISTINCT FROM OLD.start_date
     AND NEW.end_date IS NOT DISTINCT FROM OLD.end_date THEN
    -- The times are only ever set here.
    NEW.half_day_from := OLD.half_day_from;
    NEW.half_day_to := OLD.half_day_to;
    RETURN NEW;
  END IF;

  IF NEW.half_day IS NULL THEN
    NEW.half_day_from := NULL;
    NEW.half_day_to := NULL;
    IF TG_OP = 'INSERT' THEN
      SELECT lr.start_date, lr.half_day INTO v_other
        FROM leave_requests lr
       WHERE lr.profile_id = NEW.profile_id AND lr.status <> 'Rejected'
         AND lr.half_day IS NOT NULL
         AND lr.start_date BETWEEN NEW.start_date AND NEW.end_date
       LIMIT 1;
      IF FOUND THEN
        RAISE EXCEPTION 'You already have a half-day leave (%) on %.',
          leave_half_day_label(v_other.half_day, NULL, NULL), to_char(v_other.start_date, 'DD Mon YYYY');
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.half_day NOT IN ('first_half', 'second_half') THEN
    RAISE EXCEPTION 'Half day must be the first half or the second half.';
  END IF;
  IF NEW.end_date IS DISTINCT FROM NEW.start_date THEN
    RAISE EXCEPTION 'A half-day leave is for one date only.';
  END IF;

  SELECT lr.half_day INTO v_other
    FROM leave_requests lr
   WHERE lr.profile_id = NEW.profile_id AND lr.id <> NEW.id AND lr.status <> 'Rejected'
     AND NEW.start_date BETWEEN lr.start_date AND lr.end_date
     AND (lr.half_day IS NULL OR lr.half_day = NEW.half_day)
   LIMIT 1;
  IF FOUND THEN
    IF v_other.half_day IS NULL THEN
      RAISE EXCEPTION 'You already have a leave request for %.', to_char(NEW.start_date, 'DD Mon YYYY');
    END IF;
    RAISE EXCEPTION 'You already asked for the % of %.',
      leave_half_day_label(NEW.half_day, NULL, NULL), to_char(NEW.start_date, 'DD Mon YYYY');
  END IF;

  SELECT w.o_from, w.o_to INTO NEW.half_day_from, NEW.half_day_to
    FROM leave_half_day_window(NEW.profile_id, NEW.half_day) w;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_leave_half_day ON public.leave_requests;
CREATE TRIGGER trg_leave_half_day BEFORE INSERT OR UPDATE ON public.leave_requests
  FOR EACH ROW EXECUTE FUNCTION public.trg_leave_half_day();

-- ---------------------------------------------------------------------------
-- A half day takes 0.5 off the balance, whatever record_leave_deduction wrote.

CREATE OR REPLACE FUNCTION public.trg_leave_ledger_half_day()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.entry_type = 'Deduction' AND NEW.leave_request_id IS NOT NULL AND NEW.days < -0.5
     AND EXISTS (SELECT 1 FROM leave_requests WHERE id = NEW.leave_request_id AND half_day IS NOT NULL) THEN
    NEW.days := -0.5;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_leave_ledger_half_day ON public.leave_ledger;
CREATE TRIGGER trg_leave_ledger_half_day BEFORE INSERT ON public.leave_ledger
  FOR EACH ROW EXECUTE FUNCTION public.trg_leave_ledger_half_day();

-- ---------------------------------------------------------------------------
-- Attendance. Live definition of 2026-10-13; only the half-day parts are new.

CREATE OR REPLACE FUNCTION public.trg_leave_overrides_attendance_status()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_halves int;
BEGIN
  IF EXISTS (
    SELECT 1 FROM leave_requests lr
    WHERE lr.profile_id = NEW.profile_id
      AND lr.status = 'Approved'
      AND NEW.date BETWEEN lr.start_date AND lr.end_date
      AND lr.half_day IS NULL
  ) THEN
    NEW.status := 'Leave';
    NEW.total_hours := 0;
    RETURN NEW;
  END IF;

  -- Half-day leave (20261013_2): half leave, half work.
  SELECT count(DISTINCT lr.half_day) INTO v_halves
    FROM leave_requests lr
   WHERE lr.profile_id = NEW.profile_id AND lr.status = 'Approved'
     AND lr.half_day IS NOT NULL AND lr.start_date = NEW.date;
  IF v_halves = 0 THEN
    RETURN NEW;
  END IF;
  IF v_halves = 2 THEN
    NEW.status := 'Leave';
    NEW.total_hours := 0;
    RETURN NEW;
  END IF;

  -- record_leave_deduction upserts every date of an approved leave as
  -- 'Leave' with 0 hours. Not for a half day: no row until they punch, and a
  -- day already punched keeps what it had (its upsert goes on to the UPDATE
  -- branch below).
  IF NEW.status = 'Leave' AND TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM attendance a WHERE a.profile_id = NEW.profile_id AND a.date = NEW.date) THEN
      RETURN NULL;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = 'Leave' AND OLD.status IS DISTINCT FROM 'Leave' THEN
    NEW.status := OLD.status;
    NEW.total_hours := OLD.total_hours;
  END IF;

  -- They were only due for the other half: not Late, and no early-exit /
  -- late-arrival marks for the half they are on leave.
  IF NEW.status IN ('Present', 'Late') THEN
    NEW.status := 'Half Day';
  END IF;
  NEW.early_late_flag := false;
  NEW.early_late_graced := false;
  NEW.monthly_allowance_used := false;
  RETURN NEW;
END;
$function$;

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
  v_forced boolean := current_setting('app.punch_review', true) = 'on';
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

  -- Report Time + Late Allowed — same precedence as recompute_attendance_late_status().
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

-- ---------------------------------------------------------------------------
-- Notifications name the half. Live definitions of 2026-10-13; only v_desc /
-- the body text change.

CREATE OR REPLACE FUNCTION public.trg_notify_leave_stage()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_name   text;
  v_desc   text;
  v_new_stage text := leave_current_stage(NEW.manager_status, NEW.hod_status, NEW.hr_status, NEW.management_status);
  v_old_stage text;
  v_ids    uuid[];
  v_actor  uuid := COALESCE(auth.uid(), NEW.profile_id);
  v_fresh  boolean := TG_OP = 'INSERT';
  v_hr_name text;
  v_waiting_on text;
BEGIN
  IF NEW.manager_status IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT trim(concat_ws(' ', first_name, last_name))
         || CASE WHEN COALESCE(outlet_location, '') <> '' THEN ' (' || outlet_location || ')' ELSE '' END
    INTO v_name FROM profiles WHERE id = NEW.profile_id;

  v_desc := COALESCE(NEW.leave_type, 'Leave') || ', '
            || CASE WHEN NEW.half_day IS NOT NULL
                 THEN to_char(NEW.start_date, 'DD Mon') || ' — half day, '
                      || leave_half_day_label(NEW.half_day, NEW.half_day_from, NEW.half_day_to)
                 ELSE to_char(NEW.start_date, 'DD Mon') || ' – '
                      || to_char(NEW.end_date, 'DD Mon') || ' (' || COALESCE(NEW.duration_days, NEW.end_date - NEW.start_date + 1) || ' day'
                      || CASE WHEN COALESCE(NEW.duration_days, 2) = 1 THEN '' ELSE 's' END || ')'
               END
            || CASE WHEN NEW.short_notice THEN ' — applied less than 15 days in advance' ELSE '' END;

  IF TG_OP = 'UPDATE' THEN
    v_old_stage := leave_current_stage(OLD.manager_status, OLD.hod_status, OLD.hr_status, OLD.management_status);
    v_fresh := OLD.status = 'Pending' AND OLD.current_stage IS NULL;
  END IF;

  IF NEW.status = 'Pending' AND v_new_stage IS NOT NULL
     AND (v_fresh OR v_new_stage IS DISTINCT FROM v_old_stage) THEN
    v_ids := leave_stage_recipients(NEW, v_new_stage);
    INSERT INTO app_notifications (tenant_id, profile_id, actor_id, type, title, body, link_key, related_id)
    SELECT NEW.tenant_id, r, v_actor, 'leave_request_submitted',
           CASE WHEN v_fresh THEN 'New leave request' ELSE 'Leave request needs your approval' END,
           v_name || ' — ' || v_desc
             || CASE WHEN NOT v_fresh THEN '. Approved by '
                  || CASE v_old_stage WHEN 'manager' THEN 'Manager' WHEN 'hod' THEN 'HOD' WHEN 'hr' THEN 'HR' ELSE 'previous approver' END
                  || ', now needs yours.' ELSE '.' END,
           'leave_requests', NEW.id
    FROM unnest(v_ids) r WHERE r IS NOT NULL AND r <> NEW.profile_id;

    -- HR always gets a new request too, as the record (and can decide it
    -- themselves at any stage) - even while it waits on the manager / HOD.
    IF v_fresh AND v_new_stage <> 'hr' THEN
      SELECT trim(concat_ws(' ', first_name, last_name)) INTO v_waiting_on
        FROM profiles WHERE id = v_ids[1];
      INSERT INTO app_notifications (tenant_id, profile_id, actor_id, type, title, body, link_key, related_id)
      SELECT NEW.tenant_id, r, v_actor, 'leave_request_hr_copy', 'New leave request',
             v_name || ' — ' || v_desc || ' — sent to '
               || COALESCE(NULLIF(v_waiting_on, ''),
                    'their ' || CASE v_new_stage WHEN 'manager' THEN 'manager' WHEN 'hod' THEN 'HOD' ELSE 'approver' END)
               || ' for approval.',
             'leave_requests', NEW.id
      FROM unnest(leave_stage_recipients(NEW, 'hr')) r
      WHERE r <> NEW.profile_id AND NOT (r = ANY (array_remove(v_ids, NULL)));
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.status IN ('Approved', 'Rejected') AND OLD.status = 'Pending' THEN
    IF NEW.hod_id IS NOT NULL AND COALESCE(NEW.hod_status, 'Not Required') = 'Not Required' THEN
      INSERT INTO app_notifications (tenant_id, profile_id, actor_id, type, title, body, link_key, related_id)
      VALUES (NEW.tenant_id, NEW.hod_id, v_actor, 'leave_request_fyi',
              'Team leave ' || lower(NEW.status), v_name || ' — ' || v_desc || '.', 'leave_requests', NEW.id);
    END IF;
    IF COALESCE(NEW.duration_days, 0) >= 4 AND NEW.hr_status = 'Not Required' THEN
      INSERT INTO app_notifications (tenant_id, profile_id, actor_id, type, title, body, link_key, related_id)
      SELECT NEW.tenant_id, r, v_actor, 'leave_request_fyi', 'Leave ' || lower(NEW.status),
             v_name || ' — ' || v_desc || '.', 'leave_requests', NEW.id
      FROM unnest(leave_stage_recipients(NEW, 'hr')) r;
    END IF;

    -- HR decided over a manager / HOD who hadn't acted yet: tell them who did.
    -- actor = the employee, so trg_team_only_request_notifications (which
    -- only lets team members' requests reach a Raniwala manager/HOD) keeps it.
    IF 'Skipped' IN (NEW.manager_status, NEW.hod_status) THEN
      SELECT trim(concat_ws(' ', first_name, last_name)) INTO v_hr_name FROM profiles WHERE id = NEW.hr_decided_by;
      INSERT INTO app_notifications (tenant_id, profile_id, actor_id, type, title, body, link_key, related_id)
      SELECT DISTINCT NEW.tenant_id, r, NEW.profile_id, 'leave_request_fyi',
             'Team leave ' || lower(NEW.status) || ' by HR',
             v_name || ' — ' || v_desc || '. ' || NEW.status || ' by HR'
               || COALESCE(' (' || NULLIF(v_hr_name, '') || ')', '') || ' on your behalf.',
             'leave_requests', NEW.id
      FROM unnest(ARRAY[
        CASE WHEN NEW.manager_status = 'Skipped' THEN NEW.manager_id END,
        CASE WHEN NEW.hod_status = 'Skipped' THEN NEW.hod_id END
      ]) r
      WHERE r IS NOT NULL AND r <> NEW.profile_id AND r IS DISTINCT FROM NEW.hr_decided_by;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_notify_leave_status_changed()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('Approved', 'Rejected') THEN
    PERFORM notify_via_edge_function(jsonb_build_object(
      'tenant_id', NEW.tenant_id, 'target', 'user:' || NEW.profile_id,
      'type', CASE WHEN NEW.status = 'Approved' THEN 'leave_approved' ELSE 'leave_rejected' END,
      'title', CASE WHEN NEW.status = 'Approved' THEN 'Leave Approved' ELSE 'Leave Rejected' END,
      'body', NEW.leave_type || ' ('
              || CASE WHEN NEW.half_day IS NOT NULL
                   THEN NEW.start_date || ', ' || leave_half_day_label(NEW.half_day, NEW.half_day_from, NEW.half_day_to)
                   ELSE NEW.start_date || ' to ' || NEW.end_date END
              || ') was ' || lower(NEW.status) || '.'
    ));
  END IF;
  RETURN NEW;
END;
$function$;
