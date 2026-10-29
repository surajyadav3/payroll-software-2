-- =============================================================
-- Raniwala late arrival / early left grace: the user's full rule
-- (29 Oct 2026), and approved regularize requests go through it.
--
-- One grace a calendar month; whichever comes first, late arrival or
-- early left, uses it. Office (10:20 - 19:15, late allowed 10):
--   in by 10:30, out 19:00+            hours (8 h+ Present)
--   in 10:30 - 11:00 (basic Late)      9 h+ Present, 8 h+ Late,
--                                      4 h+ Half Day, else Absent
--   in 11:00 - 12:10, out 19:00+       first breach: Present (graced)
--                                      9 h+ uses the grace too; grace
--                                      already used: Late (8 h+) / hours
--   in after 11:00, out before 19:00   Half Day, no grace
--   out 17:30 - 19:00 (early left)     first breach: Present (graced);
--                                      came in 10:30 - 11:00: Late (graced)
--                                      8 h+ already: hours stand, no grace
--   past the limits / grace used       hours decide
-- Early left was "more than 40 min before the end" (18:35); now it is
-- more than tenants.early_left_minutes (15) before the end: 19:00 for
-- Office, the same 15 min against every other outlet's own shift end.
-- Late arrival stays more than 40 min after the start (11:00).
--
-- Approved regularize requests: apply_approved_regularize_request scored
-- the day by hours only and the grace never ran (emp 305 Ekta Rathore,
-- 20 Oct 10:31 - 18:00: graced, then Half Day when HR approved her
-- same-times request on 27 Oct). Now a breach on the requested times goes
-- through early_late_grace_score (app.early_late_request = 'on' lets the
-- score past its hand-edit exclusion) and the rest of the month is
-- re-scored. A request day with no breach keeps the hours status as
-- before. HR's own hand edits (Edit Attendance, Bulk Regularize) still
-- stand and take no grace (20261021_3).
--
-- 20 Oct (Dussehra), Office: the shift ended at 18:00, so out at / after
-- 18:00 = Present, or Late when they came in late; that day uses no grace
-- (user, 30 Oct). Ekta 305 (in 10:31) = Late, 539 / 350 = Present.
-- 20 Oct, Factory: out at / after 16:00 = Present, no grace used either
-- (user, 30 Oct).
--
-- October re-scored once: punched days as 20261028_6 did, plus days whose
-- last change was an approved request. No notifications.
--
-- Functions: live defs of 29 Oct (score, kind_of, notify md5
-- 99925d78..., apply_approved_regularize_request) with these changes.
-- =============================================================

SET lock_timeout = '5s';

ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS early_left_minutes int;
COMMENT ON COLUMN public.tenants.early_left_minutes IS
  'Early left = last punch more than this many minutes before the shift end (Raniwala 15). NULL: early_late_grace_minutes.';

UPDATE public.tenants SET early_left_minutes = 15
 WHERE company_name ILIKE '%Raniwala%' AND early_late_grace_minutes IS NOT NULL;

CREATE OR REPLACE FUNCTION public.early_late_grace_score(p_att_id uuid, p_profile_id uuid, p_date date, p_first text, p_last text, p_n integer, p_open boolean, p_status text)
 RETURNS TABLE(status text, graced boolean, counted boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_mins     int;
  v_out_mins int;
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
  v_basic    boolean;
  v_late     boolean;
  v_early    boolean;
  v_nine     boolean;
  v_past     boolean;
  v_hr       text;
BEGIN
  SELECT t.early_late_grace_minutes, COALESCE(t.early_left_minutes, t.early_late_grace_minutes),
         t.late_waived_after_hours, p.tenant_id, p.outlet_id,
         substr(COALESCE(s.start_time::text, o.shift_start, t.shift_start, '10:30'), 1, 5)::time,
         substr(COALESCE(s.end_time::text,   o.shift_end,   t.shift_end,   '18:00'), 1, 5)::time,
         s.late_arrival_allowance_until, s.early_departure_after,
         COALESCE(o.late_threshold, t.late_threshold, 0),
         employee_weekly_off_days(p.id),
         COALESCE(o.holidays_enabled, true)
    INTO v_mins, v_out_mins, v_waive, v_tenant, v_outlet, v_start, v_end, v_cap_in, v_cap_out,
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
  -- "Office Staff" 12:10 / 17:30).
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

  -- Basic Late (Office 10:30 - 11:00), late arrival (after 11:00), early
  -- left (before 19:00: early_left_minutes before the end, 29 Oct 2026).
  v_basic := COALESCE(v_first > v_start + make_interval(mins => v_late_min), false);
  v_late  := COALESCE(v_first > v_start + make_interval(mins => v_mins), false);
  -- v_last >= v_first: a punch-out after midnight is not Early Left (20261024_5)
  v_early := COALESCE(p_n >= 2 AND NOT p_open AND v_last >= v_first
                      AND v_last < v_end - make_interval(mins => v_out_mins), false);
  -- A finished day of late_waived_after_hours+ (first to last punch, same
  -- sum as total_hours), 20261019_1.
  v_nine := COALESCE(v_waive IS NOT NULL
     AND p_status IN ('Present', 'Late')
     AND p_first IS NOT NULL AND p_n >= 2 AND NOT p_open
     AND ((EXTRACT(EPOCH FROM (v_last - v_first))::numeric % 86400 + 86400) % 86400) / 3600.0 >= v_waive, false);

  -- 9 h+ is Present and uses no grace, unless they came in after 11:00:
  -- then it is a late arrival like any other (user, 29 Oct 2026).
  IF v_nine AND NOT v_late THEN
    status := 'Present';
    RETURN NEXT;
    RETURN;
  END IF;

  IF p_status NOT IN ('Present', 'Late', 'Half Day', 'Absent')
     OR p_first IS NULL
     OR v_start = '00:00'::time                       -- no fixed start (Office Consultant)
     OR v_end <= v_start                              -- day shifts only
     -- weekly off / holiday worked: no shift that day (20261014_3); the
     -- outlet's own holidays always count (20261020_2)
     OR EXTRACT(DOW FROM p_date)::int = ANY (v_off_days)
     OR EXISTS (
          SELECT 1 FROM holidays h
           WHERE h.tenant_id = v_tenant AND h.date = p_date
             AND (h.outlet_id = v_outlet OR (v_holidays AND h.outlet_id IS NULL)))
     -- half-day leave: only due for the other half (20261013_2)
     OR EXISTS (
          SELECT 1 FROM leave_requests lr
           WHERE lr.profile_id = p_profile_id AND lr.status = 'Approved'
             AND lr.half_day IS NOT NULL AND lr.start_date = p_date)
     -- edited by hand by a manager / HR from 21 Oct 2026 (20261021_3):
     -- their status stands and the day uses no grace. An approved
     -- regularize request is scored (app.early_late_request, 20261029_1).
     OR (COALESCE(current_setting('app.early_late_request', true), '') <> 'on' AND EXISTS (
          SELECT 1 FROM attendance a2
            JOIN attendance_audit_log l ON l.attendance_id = a2.id
           WHERE a2.id = p_att_id AND a2.location IN ('Office (Manual)', 'Office (Regularized)')
             AND l.created_at >= '2026-10-21 00:00:00+05:30')) THEN
    IF v_nine THEN
      status := 'Present';
    END IF;
    RETURN NEXT;
    RETURN;
  END IF;

  -- HR's call on this day (20261028_1): marked graced = Present with the
  -- month's grace, however late / early (a 10:35 Late too).
  SELECT h.action INTO v_hr FROM early_late_grace_hr h WHERE h.attendance_id = p_att_id;
  IF v_hr = 'granted' THEN
    status := 'Present'; graced := true;
    RETURN NEXT;
    RETURN;
  END IF;

  IF NOT (v_late OR v_early) THEN
    RETURN NEXT;
    RETURN;
  END IF;

  -- Under 4 h (Absent) is not a working day: no grace, no mark.
  IF p_status = 'Absent' THEN
    RETURN NEXT;
    RETURN;
  END IF;

  -- Early left with 8 h+ already worked: the hours stand (Present, or Late
  -- after a 10:30 - 11:00 arrival), no grace, no mark (user, 29 Oct 2026).
  IF NOT v_late AND p_status IN ('Present', 'Late') THEN
    RETURN NEXT;
    RETURN;
  END IF;

  -- The grace covers ONE breach within the shift's limits (Office in by
  -- 12:10 / out from 17:30), the first of the month (user, 27 Oct 2026).
  -- Past a limit no grace: the hours decide and the grace stays free.
  v_past := NOT (
       (v_late AND (v_cap_in IS NULL OR v_first <= v_cap_in))
    OR (v_early AND (v_cap_out IS NULL OR v_last >= v_cap_out)));

  -- Late arrival AND early left on one day (20261028_6): no grace, Half Day.
  IF v_late AND v_early THEN
    status := 'Half Day'; counted := true;
    RETURN NEXT;
    RETURN;
  END IF;

  -- HR took the grace off this day: no grace, the hours decide. A day HR
  -- marked graced holds the month's grace whether it is before or after
  -- this one.
  IF NOT v_past AND v_hr IS DISTINCT FROM 'removed' AND NOT EXISTS (
    SELECT 1 FROM attendance a
     WHERE a.profile_id = p_profile_id
       AND a.id IS DISTINCT FROM p_att_id
       AND a.date >= date_trunc('month', p_date)::date
       AND a.date < (date_trunc('month', p_date) + interval '1 month')::date
       AND a.status NOT IN ('Leave', 'Comp Off')
       AND a.early_late_graced
       AND (a.date < p_date OR EXISTS (
             SELECT 1 FROM early_late_grace_hr h
              WHERE h.attendance_id = a.id AND h.action = 'granted'))
  ) THEN
    graced := true;
    -- An early left after a 10:30 - 11:00 arrival: the grace covers the
    -- early left, the late arrival still stands (user, 29 Oct 2026).
    status := CASE WHEN v_early AND v_basic THEN 'Late' ELSE 'Present' END;
  ELSE
    counted := true;
    -- After 11:00 with no grace: never Present, 9 h+ included.
    IF v_late AND p_status IN ('Present', 'Late') THEN
      status := 'Late';
    END IF;
  END IF;

  RETURN NEXT;
END;
$function$;

-- ── Early left in the breach name: early_left_minutes ──────────────────
CREATE OR REPLACE FUNCTION public.early_late_kind_of(p_att_id uuid, p_profile_id uuid, p_date date)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_mins     int;
  v_out_mins int;
  v_start    time;
  v_end      time;
  v_first    time;
  v_last     time;
  v_n        int;
  v_open     boolean;
  v_late     boolean;
  v_early    boolean;
BEGIN
  SELECT t.early_late_grace_minutes, COALESCE(t.early_left_minutes, t.early_late_grace_minutes),
         substr(COALESCE(s.start_time::text, o.shift_start, t.shift_start, '10:30'), 1, 5)::time,
         substr(COALESCE(s.end_time::text,   o.shift_end,   t.shift_end,   '18:00'), 1, 5)::time
    INTO v_mins, v_out_mins, v_start, v_end
    FROM profiles p
    JOIN tenants t ON t.id = p.tenant_id
    LEFT JOIN outlets o ON o.id = p.outlet_id
    LEFT JOIN shifts s ON s.id = p.shift_id
   WHERE p.id = p_profile_id;

  IF v_mins IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(min(punch_time) FILTER (WHERE NOT next_day), min(punch_time))::time,
         COALESCE(max(punch_time) FILTER (WHERE next_day), max(punch_time))::time,
         count(*)
    INTO v_first, v_last, v_n
    FROM punches
   WHERE attendance_id = p_att_id AND approval_status = 'approved';

  IF v_n = 0 THEN
    RETURN NULL;
  END IF;

  -- Today, before shift end: the day is still open, so no early left yet.
  v_open := p_date = (now() AT TIME ZONE 'Asia/Kolkata')::date
            AND v_end > v_start
            AND (now() AT TIME ZONE 'Asia/Kolkata')::time < v_end;

  v_late  := v_first > v_start + make_interval(mins => v_mins);
  v_early := v_n >= 2 AND NOT v_open AND v_last >= v_first
             AND v_last < v_end - make_interval(mins => v_out_mins);

  RETURN CASE
    WHEN v_late AND v_early THEN 'both'
    WHEN v_late             THEN 'late_arrival'
    WHEN v_early            THEN 'early_left'
  END;
END;
$function$;

-- ── Notification: early left minutes; graced but Late ──────────────────
CREATE OR REPLACE FUNCTION public.trg_early_late_grace_notify()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_used     date;
  v_mins     int;
  v_out_mins int;
  v_name     text;
  v_did      text;
BEGIN
  SELECT early_late_grace_minutes, COALESCE(early_left_minutes, early_late_grace_minutes)
    INTO v_mins, v_out_mins FROM tenants WHERE id = NEW.tenant_id;
  IF COALESCE(current_setting('app.early_late_quiet', true), '') = 'on'
     OR NEW.date IS DISTINCT FROM (now() AT TIME ZONE 'Asia/Kolkata')::date
     OR v_mins IS NULL THEN
    RETURN NULL;
  END IF;

  v_name := CASE NEW.early_late_kind
    WHEN 'late_arrival' THEN 'Late Arrival'
    WHEN 'early_left'   THEN 'Early Left'
    WHEN 'both'         THEN 'Late Arrival + Early Left'
    ELSE 'Late Arrival / Early Left'
  END;
  v_did := CASE NEW.early_late_kind
    WHEN 'late_arrival' THEN format('came in more than %s min after your shift start', v_mins)
    WHEN 'early_left'   THEN format('left more than %s min before your shift end', v_out_mins)
    WHEN 'both'         THEN format('came in more than %s min after your shift start and left more than %s min before it ended', v_mins, v_out_mins)
    ELSE format('came in or left outside your shift')
  END;

  IF NEW.early_late_graced AND (TG_OP = 'INSERT' OR NOT OLD.early_late_graced) THEN
    INSERT INTO app_notifications (tenant_id, profile_id, actor_id, type, title, body, link_key, related_id)
    VALUES (NEW.tenant_id, NEW.profile_id, NULL, 'early_late_grace',
            v_name || ': this month''s grace used',
            CASE WHEN NEW.status = 'Present' THEN
              format('Today (%s) you %s. This month''s one grace covers it, so today is marked Present. The next late arrival or early left in %s goes by your hours.',
                     to_char(NEW.date, 'DD Mon'), v_did, to_char(NEW.date, 'FMMonth'))
            ELSE
              format('Today (%s) you %s. This month''s one grace covers it, but you also came in late, so today is marked %s. The next late arrival or early left in %s goes by your hours.',
                     to_char(NEW.date, 'DD Mon'), v_did, NEW.status, to_char(NEW.date, 'FMMonth'))
            END,
            'attendance', NEW.id);
  ELSIF NEW.early_late_flag AND (TG_OP = 'INSERT' OR NOT OLD.early_late_flag) THEN
    SELECT min(a.date) INTO v_used
      FROM attendance a
     WHERE a.profile_id = NEW.profile_id AND a.early_late_graced
       AND a.date >= date_trunc('month', NEW.date)::date AND a.date < NEW.date;
    INSERT INTO app_notifications (tenant_id, profile_id, actor_id, type, title, body, link_key, related_id)
    VALUES (NEW.tenant_id, NEW.profile_id, NULL, 'early_late_counted',
            'Marked ' || v_name,
            format('Today (%s) you %s. %s, so today is marked %s.',
                   to_char(NEW.date, 'DD Mon'), v_did,
                   CASE WHEN NEW.early_late_kind = 'both'
                        THEN 'The grace covers a late arrival or an early left, not both on one day'
                        WHEN v_used IS NOT NULL
                        THEN 'This month''s grace was already used on ' || to_char(v_used, 'DD Mon')
                        ELSE 'That is past your shift''s grace limit, so the grace does not cover it' END,
                   NEW.status),
            'attendance', NEW.id);
  END IF;
  RETURN NULL;
END;
$function$;

-- ── Approved regularize request: through the grace ─────────────────────
CREATE OR REPLACE FUNCTION public.apply_approved_regularize_request()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_att_id    uuid;
  v_old_stat  text;
  v_old_hours numeric;
  v_half      numeric;
  v_full      numeric;
  v_hours     numeric := 0;
  v_status    text;
  v_existed   boolean;
  v_start     text;
  v_late_min  int;
  v_base      text;
  v_g         RECORD;
BEGIN
  IF NEW.status <> 'Approved' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'Approved' THEN RETURN NEW; END IF;
  IF NEW.clock_in_time IS NULL OR NEW.clock_out_time IS NULL THEN RETURN NEW; END IF;

  PERFORM set_config('app.regularize_apply', 'on', true);

  SELECT
    COALESCE(o.min_half_day_hours, t.min_half_day_hours, 4),
    COALESCE(o.min_full_day_hours, t.min_full_day_hours, 8),
    COALESCE(s.start_time::text, o.shift_start, t.shift_start, '10:30'),
    COALESCE(o.late_threshold, t.late_threshold, 0)
  INTO v_half, v_full, v_start, v_late_min
  FROM tenants t
  LEFT JOIN profiles p ON p.id = NEW.profile_id
  LEFT JOIN outlets  o ON o.id = p.outlet_id
  LEFT JOIN shifts   s ON s.id = p.shift_id
  WHERE t.id = NEW.tenant_id;

  v_hours := round((
    (EXTRACT(EPOCH FROM (NEW.clock_out_time - NEW.clock_in_time))::numeric % 86400 + 86400) % 86400
  ) / 3600.0, 2);
  v_status := CASE
    WHEN v_hours >= v_full THEN 'Present'
    WHEN v_hours >= v_half THEN 'Half Day'
    ELSE 'Absent'
  END;

  SELECT id, status, total_hours INTO v_att_id, v_old_stat, v_old_hours
    FROM attendance WHERE profile_id = NEW.profile_id AND date = NEW.date;
  v_existed := v_att_id IS NOT NULL;

  IF v_att_id IS NULL THEN
    INSERT INTO attendance (tenant_id, profile_id, date, status, total_hours, location)
    VALUES (NEW.tenant_id, NEW.profile_id, NEW.date, v_status, v_hours, 'Office (Regularized)')
    ON CONFLICT (profile_id, date) DO NOTHING
    RETURNING id INTO v_att_id;
    IF v_att_id IS NULL THEN
      SELECT id INTO v_att_id FROM attendance WHERE profile_id = NEW.profile_id AND date = NEW.date;
    END IF;
  END IF;

  DELETE FROM punches WHERE attendance_id = v_att_id;
  INSERT INTO punches (attendance_id, punch_time, punch_type, source) VALUES
    (v_att_id, to_char(NEW.clock_in_time,  'HH24:MI'), 'in',  'manual'),
    (v_att_id, to_char(NEW.clock_out_time, 'HH24:MI'), 'out', 'manual');

  -- Late arrival / early left grace (20261029_1): a breach on the requested
  -- times is scored like a punched day; no breach keeps the hours status.
  v_base := v_status;
  IF v_base = 'Present'
     AND (EXTRACT(EPOCH FROM (NEW.clock_in_time - substr(v_start, 1, 5)::time)) / 60) > v_late_min THEN
    v_base := 'Late';
  END IF;
  PERFORM set_config('app.early_late_request', 'on', true);
  SELECT g.* INTO v_g FROM early_late_grace_score(
    v_att_id, NEW.profile_id, NEW.date,
    to_char(NEW.clock_in_time, 'HH24:MI'), to_char(NEW.clock_out_time, 'HH24:MI'), 2, false, v_base) g;
  PERFORM set_config('app.early_late_request', 'off', true);

  IF FOUND AND (v_g.graced OR v_g.counted) THEN
    v_status := v_g.status;
    UPDATE attendance
       SET status = v_status, total_hours = v_hours, location = 'Office (Regularized)',
           early_late_graced = v_g.graced, early_late_flag = v_g.counted, monthly_allowance_used = false
     WHERE id = v_att_id;
  ELSE
    UPDATE attendance
       SET status = v_status, total_hours = v_hours, location = 'Office (Regularized)',
           early_late_graced = false, early_late_flag = false
     WHERE id = v_att_id;
  END IF;

  INSERT INTO attendance_audit_log
    (tenant_id, attendance_id, profile_id, changed_by, date, action,
     old_status, new_status, old_hours, new_hours, reason)
  VALUES
    (NEW.tenant_id, v_att_id, NEW.profile_id, COALESCE(NEW.reviewed_by, auth.uid(), NEW.profile_id), NEW.date,
     CASE WHEN v_existed THEN 'update' ELSE 'create' END,
     v_old_stat, v_status, v_old_hours, v_hours, NEW.reason);

  -- The month's grace may have moved to or from this day (no-op for
  -- companies without the grace).
  PERFORM early_late_rescore_month(NEW.profile_id, NEW.date);

  PERFORM set_config('app.regularize_apply', 'off', true);
  RETURN NEW;
END;
$function$;

-- ── 20 Oct, Office: the shift ended at 18:00 (user, 30 Oct 2026) ───────
-- Dussehra: Office Staff out at / after 18:00 left on time. In on time
-- (shift start + late allowed, Office 10:30) = Present; came in late = Late
-- (9 h+ from in by 11:00 Present, as every day); a lone evening scan =
-- Present. No grace used and no mark on this day: the grace it held goes
-- to the employee's next October breach in the re-score below. Done like
-- an HR hand edit (punches manual, 'Office (Manual)', audit by HR
-- e2a0476b) so later ESSL passes and the score leave it alone. Replaces
-- the 23 Oct one-off for these rows, and covers rows it left out
-- (388, 413, 132, Mispunch 253 / 286 / 474, user's pick).
-- Factory Staff the same way (user, 30 Oct): the factory closed at 16:00,
-- so out at / after 16:00 = Present whatever time they came in, a lone
-- scan from 16:00 too; a half-day leave day keeps its status. Replaces
-- the 26 Oct one-off and covers the auto-graced rows it left out.
DO $$
DECLARE
  v_tenant   uuid;
  v_t        RECORD;
  r          RECORD;
  v_first    time;
  v_last     time;
  v_n        int;
  v_start    time;
  v_late_min int;
  v_target   text;
  v_close    time;
  v_done     int := 0;
  v_factory  int := 0;
BEGIN
  SELECT * INTO v_t FROM tenants WHERE company_name ILIKE '%Raniwala%';
  v_tenant := v_t.id;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'Raniwala tenant not found -- aborting, nothing changed';
  END IF;

  PERFORM set_config('app.regularize_apply', 'on', true);
  PERFORM set_config('app.early_late_quiet', 'on', true);

  FOR r IN
    SELECT a.id, a.profile_id, a.status, a.total_hours, a.early_late_graced, a.early_late_flag,
           p.shift_id, p.outlet_id, ol.name AS outlet_name
      FROM attendance a
      JOIN profiles p ON p.id = a.profile_id
      JOIN outlets ol ON ol.id = p.outlet_id AND ol.name IN ('Office Staff', 'Factory Staff')
     WHERE a.tenant_id = v_tenant
       AND a.date = '2026-10-20'
       AND a.status IN ('Present', 'Late', 'Half Day', 'Absent', 'Mispunch')
       AND NOT EXISTS (SELECT 1 FROM punches pu WHERE pu.attendance_id = a.id AND pu.approval_status <> 'approved')
       AND (ol.name = 'Office Staff' OR NOT EXISTS (
             SELECT 1 FROM leave_requests lr
              WHERE lr.profile_id = a.profile_id AND lr.status = 'Approved'
                AND lr.half_day IS NOT NULL AND lr.start_date = a.date))
  LOOP
    SELECT COALESCE(min(punch_time) FILTER (WHERE NOT next_day), min(punch_time))::time,
           COALESCE(max(punch_time) FILTER (WHERE next_day), max(punch_time))::time,
           count(*)
      INTO v_first, v_last, v_n
      FROM punches WHERE attendance_id = r.id AND approval_status = 'approved';
    v_close := CASE WHEN r.outlet_name = 'Factory Staff' THEN '16:00' ELSE '18:00' END;
    IF v_n = 0 OR v_last < v_close THEN
      CONTINUE;
    END IF;

    SELECT substr(COALESCE(s.start_time::text, o.shift_start, v_t.shift_start, '10:30'), 1, 5)::time,
           COALESCE(o.late_threshold, v_t.late_threshold, 0)
      INTO v_start, v_late_min
      FROM (SELECT 1) one
      LEFT JOIN shifts s ON s.id = r.shift_id
      LEFT JOIN outlets o ON o.id = r.outlet_id;

    v_target := CASE
      WHEN r.outlet_name = 'Factory Staff' THEN 'Present'
      WHEN v_n = 1 THEN 'Present'
      WHEN v_first <= v_start + make_interval(mins => v_late_min) THEN 'Present'
      WHEN v_first <= v_start + make_interval(mins => v_t.early_late_grace_minutes)
           AND EXTRACT(EPOCH FROM (v_last - v_first)) / 3600.0 >= v_t.late_waived_after_hours THEN 'Present'
      ELSE 'Late'
    END;

    IF (r.status, r.early_late_graced, r.early_late_flag) IS NOT DISTINCT FROM (v_target, false, false) THEN
      CONTINUE;
    END IF;

    UPDATE punches SET source = 'manual' WHERE attendance_id = r.id AND source IS DISTINCT FROM 'manual';
    UPDATE attendance
       SET status = v_target, early_late_graced = false, early_late_flag = false, location = 'Office (Manual)'
     WHERE id = r.id;
    INSERT INTO attendance_audit_log
      (tenant_id, attendance_id, profile_id, changed_by, date, action,
       old_status, new_status, old_hours, new_hours, reason)
    VALUES
      (v_tenant, r.id, r.profile_id, 'e2a0476b-c353-485f-9964-6ceba8b726e7', '2026-10-20', 'update',
       r.status, v_target, r.total_hours, r.total_hours,
       CASE WHEN r.outlet_name = 'Factory Staff'
            THEN 'Dussehra 20 Oct: factory closed at 16:00. Out at / after 16:00 = Present; no grace used.'
            ELSE 'Dussehra 20 Oct: Office closed at 18:00. Out at / after 18:00 = Present, Late if came in late; no grace used.' END);
    v_done := v_done + 1;
    IF r.outlet_name = 'Factory Staff' THEN
      v_factory := v_factory + 1;
    END IF;
  END LOOP;

  PERFORM set_config('app.regularize_apply', 'off', true);
  PERFORM set_config('app.early_late_quiet', 'off', true);
  RAISE NOTICE 'Raniwala 20 Oct early closing: % day(s) set (% Factory)', v_done, v_factory;
END $$;

-- ── October re-scored once ─────────────────────────────────────────────
-- Punched days (no manual punch, no audit) as 20261028_6, plus days whose
-- last change was an approved regularize request (scored with
-- app.early_late_request). One pass per employee in date order, so the
-- month's grace goes to the first breach.
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
  v_req      int := 0;
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE company_name ILIKE '%Raniwala%';
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'Raniwala tenant not found -- aborting, nothing changed';
  END IF;

  SELECT * INTO v_t FROM tenants WHERE id = v_tenant;

  PERFORM set_config('app.regularize_apply', 'on', true);
  PERFORM set_config('app.early_late_quiet', 'on', true);

  FOR r IN
    SELECT a.id, a.profile_id, a.date, a.status, a.total_hours, a.early_late_graced, a.early_late_flag,
           p.shift_id, p.outlet_id, ol.name AS outlet_name, q.from_request
      FROM attendance a
      JOIN profiles p ON p.id = a.profile_id
      LEFT JOIN outlets ol ON ol.id = p.outlet_id
      CROSS JOIN LATERAL (
        SELECT EXISTS (
          SELECT 1
            FROM (SELECT l.reason, l.created_at FROM attendance_audit_log l
                   WHERE l.attendance_id = a.id ORDER BY l.created_at DESC LIMIT 1) last_l
            JOIN regularize_requests rr
              ON rr.profile_id = a.profile_id AND rr.date = a.date AND rr.status = 'Approved'
             AND rr.reason IS NOT DISTINCT FROM last_l.reason
             AND abs(EXTRACT(EPOCH FROM (last_l.created_at - rr.reviewed_at))) < 60
        ) AS from_request
      ) q
     WHERE a.tenant_id = v_tenant
       AND a.date BETWEEN '2026-10-01' AND v_today
       AND a.status IN ('Present', 'Late', 'Half Day', 'Absent')
       AND NOT EXISTS (SELECT 1 FROM punches pu WHERE pu.attendance_id = a.id AND pu.approval_status <> 'approved')
       AND (q.from_request
            OR NOT EXISTS (SELECT 1 FROM punches pu WHERE pu.attendance_id = a.id AND pu.source = 'manual')
               AND NOT EXISTS (SELECT 1 FROM attendance_audit_log l WHERE l.attendance_id = a.id))
     ORDER BY a.profile_id, a.date
  LOOP
    SELECT COALESCE(min(punch_time) FILTER (WHERE NOT next_day), min(punch_time)),
           COALESCE(max(punch_time) FILTER (WHERE next_day), max(punch_time)),
           count(*)
      INTO v_first, v_last, v_n
      FROM punches WHERE attendance_id = r.id AND approval_status = 'approved';
    IF v_n = 0 OR (v_n = 1 AND r.date < v_today) THEN
      CONTINUE;
    END IF;
    -- 20 Oct early closing (HR, 23 + 26 Oct): Office out at / after 18:00
    -- and Factory out at / after 16:00 are Present. Punched days are left
    -- as they are; a request the approval turned Half Day gets Present back.
    IF r.date = '2026-10-20'
       AND ((r.outlet_name = 'Office Staff'  AND v_last::time >= '18:00')
         OR (r.outlet_name = 'Factory Staff' AND v_last::time >= '16:00')) THEN
      IF r.from_request AND (r.status <> 'Present' OR r.early_late_graced OR r.early_late_flag) THEN
        UPDATE attendance
           SET status = 'Present', early_late_graced = false, early_late_flag = false
         WHERE id = r.id;
        v_changed := v_changed + 1;
        v_req := v_req + 1;
      ELSIF r.early_late_graced AND EXISTS (
        SELECT 1 FROM attendance a3
         WHERE a3.profile_id = r.profile_id AND a3.early_late_graced
           AND a3.date >= '2026-10-01' AND a3.date < r.date) THEN
        -- An earlier request day now holds the month's grace: this
        -- early-closing day stays Present without it.
        UPDATE attendance SET early_late_graced = false, early_late_flag = false WHERE id = r.id;
        v_changed := v_changed + 1;
      END IF;
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

    PERFORM set_config('app.early_late_request', CASE WHEN r.from_request THEN 'on' ELSE 'off' END, true);
    SELECT g.* INTO v_g FROM early_late_grace_score(
      r.id, r.profile_id, r.date, v_first, v_last, v_n, v_open, v_base) g;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'early_late_grace_score returned nothing for Raniwala -- aborting';
    END IF;

    -- Only days this rule decides: flagged before or flagged now. A request
    -- day that loses its flags goes back to the hours status it was approved
    -- with (Present for 8 h+, as the approval set it).
    IF r.early_late_graced OR r.early_late_flag OR v_g.graced OR v_g.counted THEN
      IF r.from_request AND NOT (v_g.graced OR v_g.counted) THEN
        v_g.status := CASE WHEN r.total_hours >= v_full THEN 'Present'
                           WHEN r.total_hours >= v_half THEN 'Half Day'
                           ELSE 'Absent' END;
      END IF;
      UPDATE attendance
         SET status = v_g.status, early_late_graced = v_g.graced, early_late_flag = v_g.counted
       WHERE id = r.id
         AND (status, early_late_graced, early_late_flag) IS DISTINCT FROM (v_g.status, v_g.graced, v_g.counted);
      IF FOUND THEN
        v_changed := v_changed + 1;
        IF r.from_request THEN
          v_req := v_req + 1;
        END IF;
      END IF;
    END IF;
  END LOOP;

  PERFORM set_config('app.early_late_request', 'off', true);

  -- Name the breach on every flagged day the loop left unchanged.
  UPDATE attendance a
     SET early_late_kind = early_late_kind_of(a.id, a.profile_id, a.date)
   WHERE a.tenant_id = v_tenant AND a.date >= '2026-10-01'
     AND (a.early_late_graced OR a.early_late_flag)
     AND a.early_late_kind IS DISTINCT FROM early_late_kind_of(a.id, a.profile_id, a.date);

  PERFORM set_config('app.regularize_apply', 'off', true);
  PERFORM set_config('app.early_late_quiet', 'off', true);
  RAISE NOTICE 'Raniwala grace rules 29 Oct: % October day(s) re-scored (% from approved requests)', v_changed, v_req;
END $$;
