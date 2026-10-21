-- =============================================================
-- Raniwala: late arrival / early left grace at 40 min, and each day says
-- which one it was (21 Oct 2026).
--
-- The rule (20261017_3) stays as it is, only the window moves from 45 to
-- 40 min:
--   first punch more than 40 min after shift start  = "late arrival"
--   last punch more than 40 min before shift end    = "early left"
-- Late arrival and early left share ONE grace per calendar month: the
-- first one is graced (marked Present, short hours from it excused), every
-- one after it that month is marked Late. Shift limits, the 9 h rule
-- (20261019_1) and every exclusion are unchanged; tenants.
-- early_late_grace_minutes is the only number early_late_grace_score reads.
--
-- New: attendance.early_late_kind = 'late_arrival' | 'early_left' | 'both'
-- on every graced / counted day, set by a BEFORE trigger from the day's
-- approved punches, so the web and the employee's notification say
-- "Late Arrival" or "Early Left" instead of "late arrival / early out".
--
-- Everything is measured against the employee's own shift (profile shift,
-- else the outlet's timings, else the company's; a staff member with no
-- shift takes the limits of the shift with the same timings):
--   shift                         late arrival  limit   early left   limit
--   Factory Staff / Office Shift 1  09:30 -> 10:10  11:00  18:00 -> 17:20  16:30
--   Office Staff                    10:20 -> 11:00  12:00  19:15 -> 18:35  17:30
--   Delhi / Gurgaon 11:00           11:00 -> 11:40  12:30  19:30 -> 18:50  18:00
--   Office Shift Late Evening       11:00 -> 11:40  12:30  20:00 -> 19:20  18:30
--   Gurgaon 12:30                   12:30 -> 13:10  14:00  21:00 -> 20:20  19:30
--   Office Consultant (00:00 start): no fixed start, exempt (user, 21 Oct).
-- "Office Shift Late Evening" had no limits; it gets 12:30 / 18:30, the same
-- start +90 / end -90 as the other shifts (user, 21 Oct).
--
-- October 2026 is re-scored once at the end (same pass as 20261019_1,
-- without notifications; regularized / HR-corrected days untouched). It
-- also clears a plain Late mark that is on time for the employee's current
-- shift (6 days, scored before an 11:00 shift was assigned; Late is sticky
-- once set, so later punches never lifted it).
-- =============================================================

ALTER TABLE public.attendance
  ADD COLUMN IF NOT EXISTS early_late_kind text
    CHECK (early_late_kind IN ('late_arrival', 'early_left', 'both'));

COMMENT ON COLUMN public.attendance.early_late_kind IS
  'Which breach made this day early_late_graced / early_late_flag: late_arrival, early_left or both (20261021_1).';

-- Same shift resolution as early_late_grace_score. Called only for a day
-- the score already flagged; NULL if the punches no longer show either
-- (a stale flag on a day re-scored some other way).
CREATE OR REPLACE FUNCTION public.early_late_kind_of(p_att_id uuid, p_profile_id uuid, p_date date)
RETURNS text
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_mins  int;
  v_start time;
  v_end   time;
  v_first time;
  v_last  time;
  v_n     int;
  v_open  boolean;
  v_late  boolean;
  v_early boolean;
BEGIN
  SELECT t.early_late_grace_minutes,
         substr(COALESCE(s.start_time::text, o.shift_start, t.shift_start, '10:30'), 1, 5)::time,
         substr(COALESCE(s.end_time::text,   o.shift_end,   t.shift_end,   '18:00'), 1, 5)::time
    INTO v_mins, v_start, v_end
    FROM profiles p
    JOIN tenants t ON t.id = p.tenant_id
    LEFT JOIN outlets o ON o.id = p.outlet_id
    LEFT JOIN shifts s ON s.id = p.shift_id
   WHERE p.id = p_profile_id;

  IF v_mins IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT min(punch_time)::time, max(punch_time)::time, count(*)
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
  v_early := v_n >= 2 AND NOT v_open AND v_last < v_end - make_interval(mins => v_mins);

  RETURN CASE
    WHEN v_late AND v_early THEN 'both'
    WHEN v_late             THEN 'late_arrival'
    WHEN v_early            THEN 'early_left'
  END;
END;
$$;

-- After every other BEFORE trigger (zz_leave_..., zzz_comp_off_...), so it
-- sees the flags the recompute / ESSL scoring settled on.
CREATE OR REPLACE FUNCTION public.trg_early_late_kind()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.early_late_graced OR NEW.early_late_flag THEN
    NEW.early_late_kind := early_late_kind_of(NEW.id, NEW.profile_id, NEW.date);
  ELSE
    NEW.early_late_kind := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS zzzz_early_late_kind ON public.attendance;
CREATE TRIGGER zzzz_early_late_kind
  BEFORE INSERT OR UPDATE ON public.attendance
  FOR EACH ROW EXECUTE FUNCTION public.trg_early_late_kind();

-- ── Notification names the breach (live 20261017_3 + kind) ─────────────
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
            format('Today (%s) you %s. This month''s one grace covers it, so today is marked Present. The next late arrival or early left in %s will be marked Late.',
                   to_char(NEW.date, 'DD Mon'), v_did, to_char(NEW.date, 'FMMonth')),
            'attendance', NEW.id);
  ELSIF NEW.early_late_flag AND (TG_OP = 'INSERT' OR NOT OLD.early_late_flag) THEN
    SELECT min(a.date) INTO v_used
      FROM attendance a
     WHERE a.profile_id = NEW.profile_id AND a.early_late_graced
       AND a.date >= date_trunc('month', NEW.date)::date AND a.date < NEW.date;
    INSERT INTO app_notifications (tenant_id, profile_id, actor_id, type, title, body, link_key, related_id)
    VALUES (NEW.tenant_id, NEW.profile_id, NULL, 'early_late_counted',
            'Marked ' || v_name,
            format('Today (%s) you %s. This month''s grace was already used%s, so today is marked Late.',
                   to_char(NEW.date, 'DD Mon'), v_did,
                   CASE WHEN v_used IS NOT NULL THEN ' on ' || to_char(v_used, 'DD Mon') ELSE '' END),
            'attendance', NEW.id);
  END IF;
  RETURN NULL;
END;
$function$;

-- ── Raniwala at 40 min + October re-scored once ────────────────────────
-- Same selection and day scoring as 20261019_1. Walked per employee in
-- date order, so the month's grace lands on the first breach again (a
-- 40 - 45 min day earlier in the month now takes it).
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

  UPDATE tenants SET early_late_grace_minutes = 40 WHERE id = v_tenant;
  SELECT * INTO v_t FROM tenants WHERE id = v_tenant;

  UPDATE shifts
     SET late_arrival_allowance_until = '12:30', early_departure_after = '18:30'
   WHERE tenant_id = v_tenant AND name = 'Office Shift Late Evening'
     AND start_time = '11:00' AND end_time = '20:00'
     AND late_arrival_allowance_until IS NULL AND early_departure_after IS NULL;

  PERFORM set_config('app.regularize_apply', 'on', true);
  PERFORM set_config('app.early_late_quiet', 'on', true);

  FOR r IN
    SELECT a.id, a.profile_id, a.date, a.status, a.total_hours, a.early_late_graced, a.early_late_flag,
           p.shift_id, p.outlet_id
      FROM attendance a
      JOIN profiles p ON p.id = a.profile_id
     WHERE a.tenant_id = v_tenant
       AND a.date BETWEEN '2026-10-01' AND v_today
       AND a.status IN ('Present', 'Late', 'Half Day', 'Absent')
       AND NOT EXISTS (SELECT 1 FROM punches pu WHERE pu.attendance_id = a.id
                        AND (pu.source = 'manual' OR pu.approval_status <> 'approved'))
       AND NOT EXISTS (SELECT 1 FROM attendance_audit_log l WHERE l.attendance_id = a.id)
     ORDER BY a.profile_id, a.date
  LOOP
    SELECT min(punch_time), max(punch_time), count(*) INTO v_first, v_last, v_n
      FROM punches WHERE attendance_id = r.id AND approval_status = 'approved';
    IF v_n = 0 OR (v_n = 1 AND r.date < v_today) THEN
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

    -- Only days this rule decides (flagged before or flagged now), and a
    -- plain Late that is on time for the employee's current shift.
    IF r.early_late_graced OR r.early_late_flag OR v_g.graced OR v_g.counted
       OR (r.status = 'Late' AND NOT v_is_late AND v_g.status = 'Present') THEN
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
  RAISE NOTICE 'Raniwala grace at 40 min: % October day(s) re-scored', v_changed;
END $$;
