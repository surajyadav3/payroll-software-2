-- =============================================================
-- Raniwala showrooms: Gandhi Jayanti (2 Oct 2026) is a holiday (20 Oct 2026).
--
-- Delhi Experience Centre and Gurgaon Laa Polki Stories were switched to
-- "no holidays, weekly off only" by 20261010_1 (outlets.holidays_enabled =
-- false), which hid EVERY holiday from them. HR now wants 2 Oct as a holiday
-- at both showrooms too.
--
-- So holidays_enabled = false now means: the company-wide holidays
-- (outlet_id IS NULL) don't reach this outlet, but a holiday added for this
-- outlet itself (Settings -> Holidays with the outlet picked) does. Before
-- this, neither showroom had a holiday of its own, so nothing else changes.
--
--   1. RLS: staff of a no-holiday outlet see their own outlet's holidays.
--   2. trg_comp_off_credit_from_hours, early_late_grace_score and the
--      sandwich rule's employee_off_day_kind: an outlet's
--      own holiday is an off day for it (comp off for working it, no shift
--      that day). Live definitions (20261012_4 / 20261014_3, 20261019_1),
--      only the holiday check changed.
--   3. Gandhi Jayanti rows for Delhi + Gurgaon.
--   4. Re-score the two Gurgaon attendance rows already on 2 Oct (460 and
--      461 worked 8.5 h / 10.67 h) so they get the holiday-worked comp off
--      like every other outlet. Delhi has no attendance that day.
--
-- Website: lib/paidDays.js, lib/attendanceRegister.js and MyTeamPage follow
-- the same rule.
-- Re-runnable.
-- =============================================================

COMMENT ON COLUMN outlets.holidays_enabled IS
  'false = company-wide holidays do not apply to this outlet (weekly off only); holidays added for this outlet itself still do.';

-- ── 1. RLS ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION my_outlet_id()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT outlet_id FROM profiles WHERE id = auth.uid();
$$;
GRANT EXECUTE ON FUNCTION my_outlet_id() TO anon, authenticated, service_role;

DROP POLICY IF EXISTS "holidays: hidden from no-holiday outlets" ON holidays;
CREATE POLICY "holidays: hidden from no-holiday outlets" ON holidays
  AS RESTRICTIVE FOR SELECT
  USING (
    (SELECT my_outlet_has_holidays())
    OR outlet_id = (SELECT my_outlet_id())
    OR (SELECT my_role()) IN ('admin', 'superadmin')
  );

-- ── 2a. Comp off ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.trg_comp_off_credit_from_hours()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_flag       boolean;
  v_eligible   boolean;
  v_outlet     uuid;
  v_off_days   int[];
  v_holidays   boolean;
  v_extra_from date;
  v_shift      numeric;
  v_off        boolean := false;
  v_extra      numeric;
  v_new        numeric := 0;
  v_old        numeric := 0;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF COALESCE(OLD.comp_off_credit, 0) <> 0 THEN
      UPDATE profiles
      SET comp_off_balance = GREATEST(0, COALESCE(comp_off_balance, 0) - OLD.comp_off_credit)
      WHERE id = OLD.profile_id;
    END IF;
    RETURN OLD;
  END IF;

  SELECT t.auto_comp_off_on_weekly_off_worked, p.comp_off_eligible, p.outlet_id,
         COALESCE(
           NULLIF(o.weekly_off_days, '{}'::int[]),
           NULLIF(t.weekly_off_days::int[], '{}'::int[]),
           CASE WHEN t.weekly_off_day IS NOT NULL THEN ARRAY[t.weekly_off_day::int] END,
           ARRAY[0]
         ),
         COALESCE(o.holidays_enabled, true),
         t.comp_off_extra_hours_from,
         COALESCE(shift_length_hours(o.shift_start, o.shift_end),
                  shift_length_hours(t.shift_start, t.shift_end),
                  8.5)
  INTO v_flag, v_eligible, v_outlet, v_off_days, v_holidays, v_extra_from, v_shift
  FROM profiles p
  JOIN tenants t ON t.id = p.tenant_id
  LEFT JOIN outlets o ON o.id = p.outlet_id
  WHERE p.id = NEW.profile_id;

  IF NOT COALESCE(v_flag, false) AND v_extra_from IS NULL THEN
    RETURN NEW;
  END IF;

  IF COALESCE(v_flag, false) THEN
    -- The outlet's own holidays always count; company-wide ones only where
    -- the outlet observes holidays (20261020_2).
    v_off := EXTRACT(DOW FROM NEW.date)::int = ANY (v_off_days)
      OR EXISTS (
        SELECT 1 FROM holidays h
        WHERE h.tenant_id = NEW.tenant_id
          AND h.date = NEW.date
          AND (h.outlet_id = v_outlet OR (v_holidays AND h.outlet_id IS NULL))
      );
  END IF;

  IF v_off THEN
    -- Weekly off / holiday worked. No shift that day: never Late, Half Day
    -- or Absent for short hours -- any day with hours worked is Present.
    NEW.comp_off_granted := true;

    IF NEW.status = 'Late'
       OR (NEW.status IN ('Half Day', 'Absent') AND COALESCE(NEW.total_hours, 0) > 0) THEN
      NEW.status := 'Present';
    END IF;

    IF COALESCE(v_eligible, false) AND NEW.status NOT IN ('Leave', 'Comp Off') THEN
      v_new := CASE
        WHEN COALESCE(NEW.total_hours, 0) >= 5 THEN 1
        WHEN COALESCE(NEW.total_hours, 0) >= 4 THEN 0.5
        ELSE 0
      END;
    END IF;
  ELSIF v_extra_from IS NOT NULL AND NEW.date >= v_extra_from THEN
    -- Normal working day: time past the employee's own shift. Not a weekly
    -- off / holiday (any more), so clear a flag left by an earlier score.
    IF COALESCE(v_flag, false) THEN
      NEW.comp_off_granted := false;
    END IF;

    IF COALESCE(v_eligible, false)
       AND NEW.status NOT IN ('Leave', 'Comp Off', 'Absent', 'Pending Approval', 'Mispunch') THEN
      v_extra := COALESCE(NEW.total_hours, 0) - v_shift;
      v_new := CASE
        WHEN v_extra >= 5 THEN 1
        WHEN v_extra >= 4 THEN 0.5
        ELSE 0
      END;
    END IF;
  ELSE
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    v_old := COALESCE(OLD.comp_off_credit, 0);
  END IF;

  IF v_new <> v_old THEN
    UPDATE profiles
    SET comp_off_balance = GREATEST(0, COALESCE(comp_off_balance, 0) + v_new - v_old)
    WHERE id = NEW.profile_id;
  END IF;

  NEW.comp_off_credit := v_new;
  RETURN NEW;
END;
$function$;

-- ── 2b. Late / early grace ─────────────────────────────────────
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
BEGIN
  SELECT t.early_late_grace_minutes, t.late_waived_after_hours, p.tenant_id, p.outlet_id,
         substr(COALESCE(s.start_time::text, o.shift_start, t.shift_start, '10:30'), 1, 5)::time,
         substr(COALESCE(s.end_time::text,   o.shift_end,   t.shift_end,   '18:00'), 1, 5)::time,
         s.late_arrival_allowance_until, s.early_departure_after,
         COALESCE(o.late_threshold, t.late_threshold, 0),
         COALESCE(
           NULLIF(o.weekly_off_days, '{}'::int[]),
           NULLIF(t.weekly_off_days::int[], '{}'::int[]),
           CASE WHEN t.weekly_off_day IS NOT NULL THEN ARRAY[t.weekly_off_day::int] END,
           ARRAY[0]
         ),
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
  -- "Office Staff" 12:00 / 17:30).
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
             AND lr.half_day IS NOT NULL AND lr.start_date = p_date) THEN
    RETURN NEXT;
    RETURN;
  END IF;

  v_late  := v_first > v_start + make_interval(mins => v_mins);
  v_early := p_n >= 2 AND NOT p_open AND v_last < v_end - make_interval(mins => v_mins);

  IF NOT (v_late OR v_early) THEN
    RETURN NEXT;
    RETURN;
  END IF;

  -- Past the shift's limit: the hours rule decides, the grace is not used.
  IF (v_late AND v_cap_in IS NOT NULL AND v_first > v_cap_in)
     OR (v_early AND v_cap_out IS NOT NULL AND v_last < v_cap_out)
     OR p_status = 'Absent' THEN
    RETURN NEXT;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM attendance a
     WHERE a.profile_id = p_profile_id
       AND a.id IS DISTINCT FROM p_att_id
       AND a.date >= date_trunc('month', p_date)::date
       AND a.date < p_date
       AND a.status NOT IN ('Leave', 'Comp Off')
       AND (a.early_late_graced OR a.early_late_flag)
  ) THEN
    counted := true;
  ELSE
    graced := true;
  END IF;

  -- Within the shift's limits the short hours are excused; a shift with no
  -- limit for it leaves a short day Half Day.
  IF p_status = 'Half Day'
     AND ((v_late AND v_cap_in IS NULL) OR (v_early AND v_cap_out IS NULL)) THEN
    status := 'Half Day';
  ELSIF counted THEN
    status := 'Late';
  ELSE
    -- A graced late arrival is not Late; a graced early out on a day that
    -- started normally Late (10:31 - 11:05) still is.
    status := CASE
      WHEN NOT v_late AND v_first > v_start + make_interval(mins => v_late_min) THEN 'Late'
      ELSE 'Present'
    END;
  END IF;

  RETURN NEXT;
END;
$function$;

-- ── 2c. Sandwich rule's off-day kind ───────────────────────────
-- Definition from 20261020_1_raniwala_sandwich_rule; only the holiday check
-- changed.
CREATE OR REPLACE FUNCTION public.employee_off_day_kind(p_profile_id uuid, p_date date)
RETURNS text
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN EXISTS (
           SELECT 1 FROM holidays h
            WHERE h.tenant_id = p.tenant_id AND h.date = p_date
              AND (h.outlet_id = p.outlet_id
                   OR (COALESCE(o.holidays_enabled, true) AND h.outlet_id IS NULL)))
      THEN 'holiday'
    WHEN EXTRACT(DOW FROM p_date)::int = ANY (COALESCE(
           NULLIF(o.weekly_off_days, '{}'::int[]),
           NULLIF(t.weekly_off_days::int[], '{}'::int[]),
           CASE WHEN t.weekly_off_day IS NOT NULL THEN ARRAY[t.weekly_off_day::int] END,
           ARRAY[0]))
      THEN 'weekly_off'
  END
  FROM profiles p
  JOIN tenants t ON t.id = p.tenant_id
  LEFT JOIN outlets o ON o.id = p.outlet_id
  WHERE p.id = p_profile_id;
$function$;

-- ── 3 + 4. Gandhi Jayanti at the Delhi + Gurgaon showrooms ─────
DO $$
DECLARE
  v_tenant_id uuid;
  v_count     int;
BEGIN
  SELECT id INTO v_tenant_id FROM tenants WHERE company_name ILIKE '%Raniwala%' LIMIT 1;
  IF v_tenant_id IS NULL THEN
    RAISE NOTICE 'Raniwala tenant not found — nothing to add';
    RETURN;
  END IF;

  INSERT INTO holidays (tenant_id, outlet_id, name, date, type)
  SELECT v_tenant_id, o.id, 'Gandhi Jayanti', DATE '2026-10-02', 'National holiday'
  FROM outlets o
  WHERE o.tenant_id = v_tenant_id
    AND (o.name ILIKE 'Delhi%' OR o.name ILIKE 'Gurgaon%' OR o.name ILIKE 'Gurugram%')
  ON CONFLICT (tenant_id, outlet_id, date) DO UPDATE SET name = EXCLUDED.name, type = EXCLUDED.type;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  IF v_count <> 2 THEN
    RAISE EXCEPTION 'Expected exactly the Delhi and Gurgaon outlets, matched % — check outlets.name', v_count;
  END IF;

  -- Re-score attendance already on that day (fires trg_comp_off_credit_from_hours).
  UPDATE attendance a SET status = a.status
  FROM profiles p, outlets o
  WHERE p.id = a.profile_id AND o.id = p.outlet_id
    AND a.tenant_id = v_tenant_id AND a.date = DATE '2026-10-02'
    AND (o.name ILIKE 'Delhi%' OR o.name ILIKE 'Gurgaon%' OR o.name ILIKE 'Gurugram%');
END $$;
