-- =============================================================
-- Raniwala: late arrival AND early left on one day = Half Day, no grace
-- (28 Oct 2026).
--
-- User: "if this happens late arrival and an early leave its not graced
-- its come under half day only". 20261027_2 used the month's grace on such
-- a day (Gayatri 421, 8 Oct: graced, Half Day by hours). Now the day takes
-- no grace and is Half Day (marked, early_late_flag); the month's grace
-- stays free for the next single late arrival or early left within the
-- shift's limits. Under 4 h stays Absent and 9 h+ stays Present, as before.
--
-- October days that held the grace this way (421 8 Oct, 201 15 Oct,
-- 171 19 Oct, 394 20 Oct) lose it; the re-score gives it to that
-- employee's next single breach in October, if any. 20 Oct early-closing
-- rows (Office out >= 18:00, Factory >= 16:00, e.g. emp 65) are skipped
-- as before. Hand-edited days untouched. No notifications.
--
-- Functions: live defs (early_late_grace_score + trg_early_late_grace_notify
-- of 20261027_2, checked identical 28 Oct) with this change. 20261028_1
-- (not applied yet) carries the same change in its copy of the score.
-- =============================================================

SET lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.early_late_grace_score(p_att_id uuid, p_profile_id uuid, p_date date, p_first text, p_last text, p_n integer, p_open boolean, p_status text)
 RETURNS TABLE(status text, graced boolean, counted boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_mins     int;
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
  v_late     boolean;
  v_early    boolean;
  v_past     boolean;
BEGIN
  SELECT t.early_late_grace_minutes, t.late_waived_after_hours, p.tenant_id, p.outlet_id,
         substr(COALESCE(s.start_time::text, o.shift_start, t.shift_start, '10:30'), 1, 5)::time,
         substr(COALESCE(s.end_time::text,   o.shift_end,   t.shift_end,   '18:00'), 1, 5)::time,
         s.late_arrival_allowance_until, s.early_departure_after,
         COALESCE(o.late_threshold, t.late_threshold, 0),
         employee_weekly_off_days(p.id),
         COALESCE(o.holidays_enabled, true)
    INTO v_mins, v_waive, v_tenant, v_outlet, v_start, v_end, v_cap_in, v_cap_out,
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

  -- Worked the full day and more (20261019_1): a finished day of
  -- late_waived_after_hours+ (first to last punch, same sum as total_hours)
  -- is Present, and the month's grace is not used.
  IF v_waive IS NOT NULL
     AND p_status IN ('Present', 'Late')
     AND p_first IS NOT NULL AND p_n >= 2 AND NOT p_open
     AND ((EXTRACT(EPOCH FROM (v_last - v_first))::numeric % 86400 + 86400) % 86400) / 3600.0 >= v_waive THEN
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
     -- their status stands and the day uses no grace
     OR EXISTS (
          SELECT 1 FROM attendance a2
            JOIN attendance_audit_log l ON l.attendance_id = a2.id
           WHERE a2.id = p_att_id AND a2.location IN ('Office (Manual)', 'Office (Regularized)')
             AND l.created_at >= '2026-10-21 00:00:00+05:30') THEN
    RETURN NEXT;
    RETURN;
  END IF;

  v_late  := v_first > v_start + make_interval(mins => v_mins);
  -- v_last >= v_first: a punch-out after midnight is not Early Left (20261024_5)
  v_early := p_n >= 2 AND NOT p_open AND v_last >= v_first
             AND v_last < v_end - make_interval(mins => v_mins);

  IF NOT (v_late OR v_early) THEN
    RETURN NEXT;
    RETURN;
  END IF;

  -- Under 4 h (Absent) is not a working day, and a day the hours already
  -- make Present needs no grace: no grace, no mark, it stays free.
  IF p_status IN ('Absent', 'Present') THEN
    RETURN NEXT;
    RETURN;
  END IF;

  -- The grace covers ONE breach within the shift's limits (Office in by
  -- 12:10 / out from 17:30), the first of the month (user, 27 Oct 2026).
  -- Past a limit no grace: the hours decide and the grace stays free.
  v_past := NOT (
       (v_late AND (v_cap_in IS NULL OR v_first <= v_cap_in))
    OR (v_early AND (v_cap_out IS NULL OR v_last >= v_cap_out)));

  -- Late arrival AND early left on one day (user, 28 Oct 2026): the grace
  -- covers one breach a day, never both, so this day takes NO grace (it
  -- stays free for the month's next single breach) and is Half Day.
  IF v_late AND v_early THEN
    status := 'Half Day'; counted := true;
    RETURN NEXT;
    RETURN;
  END IF;

  IF NOT v_past AND NOT EXISTS (
    SELECT 1 FROM attendance a
     WHERE a.profile_id = p_profile_id
       AND a.id IS DISTINCT FROM p_att_id
       AND a.date >= date_trunc('month', p_date)::date
       AND a.date < p_date
       AND a.status NOT IN ('Leave', 'Comp Off')
       AND a.early_late_graced
  ) THEN
    graced := true;
    status := 'Present';
  ELSE
    counted := true;
  END IF;

  RETURN NEXT;
END;
$function$;

-- ── "Marked" notification: say why a late + early day is Half Day ──────
CREATE OR REPLACE FUNCTION public.trg_early_late_grace_notify()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_used date;
  v_mins int;
  v_name text;
  v_did  text;
BEGIN
  SELECT early_late_grace_minutes INTO v_mins FROM tenants WHERE id = NEW.tenant_id;
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
    WHEN 'early_left'   THEN format('left more than %s min before your shift end', v_mins)
    WHEN 'both'         THEN format('came in more than %s min after your shift start and left more than %s min before it ended', v_mins, v_mins)
    ELSE format('came in or left more than %s min outside your shift', v_mins)
  END;

  IF NEW.early_late_graced AND (TG_OP = 'INSERT' OR NOT OLD.early_late_graced) THEN
    INSERT INTO app_notifications (tenant_id, profile_id, actor_id, type, title, body, link_key, related_id)
    VALUES (NEW.tenant_id, NEW.profile_id, NULL, 'early_late_grace',
            v_name || ': this month''s grace used',
            CASE WHEN NEW.status = 'Present' THEN
              format('Today (%s) you %s. This month''s one grace covers it, so today is marked Present. The next late arrival or early left in %s goes by your hours.',
                     to_char(NEW.date, 'DD Mon'), v_did, to_char(NEW.date, 'FMMonth'))
            ELSE
              format('Today (%s) you %s. This month''s one grace covers one of them, not both, so today goes by your hours worked (%s h) and is marked %s.',
                     to_char(NEW.date, 'DD Mon'), v_did, NEW.total_hours, NEW.status)
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

-- ── October re-scored once ─────────────────────────────────────────────
-- Same pass as 20261027_2; first / last punch as essl_apply sees them
-- (a Delhi scan marked next_day is the day's punch-out, 20261024_5).
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

  SELECT * INTO v_t FROM tenants WHERE id = v_tenant;

  PERFORM set_config('app.regularize_apply', 'on', true);
  PERFORM set_config('app.early_late_quiet', 'on', true);

  FOR r IN
    SELECT a.id, a.profile_id, a.date, a.status, a.total_hours, a.early_late_graced, a.early_late_flag,
           p.shift_id, p.outlet_id, ol.name AS outlet_name
      FROM attendance a
      JOIN profiles p ON p.id = a.profile_id
      LEFT JOIN outlets ol ON ol.id = p.outlet_id
     WHERE a.tenant_id = v_tenant
       AND a.date BETWEEN '2026-10-01' AND v_today
       AND a.status IN ('Present', 'Late', 'Half Day', 'Absent')
       AND NOT EXISTS (SELECT 1 FROM punches pu WHERE pu.attendance_id = a.id
                        AND (pu.source = 'manual' OR pu.approval_status <> 'approved'))
       AND NOT EXISTS (SELECT 1 FROM attendance_audit_log l WHERE l.attendance_id = a.id)
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
    -- and Factory out at / after 16:00 are Present; left as they are.
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

    -- Only days this rule decides: flagged before or flagged now.
    IF r.early_late_graced OR r.early_late_flag OR v_g.graced OR v_g.counted THEN
      UPDATE attendance
         SET status = v_g.status, early_late_graced = v_g.graced, early_late_flag = v_g.counted
       WHERE id = r.id
         AND (status, early_late_graced, early_late_flag) IS DISTINCT FROM (v_g.status, v_g.graced, v_g.counted);
      IF FOUND THEN
        v_changed := v_changed + 1;
      END IF;
    END IF;
  END LOOP;

  -- Name the breach on every flagged day the loop left unchanged.
  UPDATE attendance a
     SET early_late_kind = early_late_kind_of(a.id, a.profile_id, a.date)
   WHERE a.tenant_id = v_tenant AND a.date >= '2026-10-01'
     AND (a.early_late_graced OR a.early_late_flag)
     AND a.early_late_kind IS DISTINCT FROM early_late_kind_of(a.id, a.profile_id, a.date);

  PERFORM set_config('app.regularize_apply', 'off', true);
  PERFORM set_config('app.early_late_quiet', 'off', true);
  RAISE NOTICE 'Raniwala late + early same day = Half Day: % October day(s) re-scored', v_changed;
END $$;
