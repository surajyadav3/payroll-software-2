-- =============================================================
-- Weekly off per employee (Raniwala Gurgaon Laa Polki Stories, 23 Oct 2026).
--
-- Every Gurgaon employee has their own weekly off, already on their profile
-- (Employees -> Weekly Holiday): 460 Monday, 461 Wednesday, 470 Friday,
-- 471 Thursday. Nothing read profiles.weekly_holiday -- the outlet has no
-- weekly_off_days, so the company's Sunday was used for comp off, the
-- sandwich rule and the late / early grace, and the web reports, OT and
-- payroll showed Sunday as their weekly off.
--
-- New: outlets.weekly_off_per_employee. When on, an employee's weekly off is
-- their own profiles.weekly_holiday; "Flexible" or blank falls back to the
-- outlet -> company weekly off as before. Off everywhere else, so other
-- outlets and companies are unchanged (weekly_holiday defaults to 'Sunday'
-- for everybody, and Delhi's 14 "Sunday" profiles are really off Monday).
--
-- employee_weekly_off_days() is now the one place the database works out
-- an employee's weekly off; trg_comp_off_credit_from_hours,
-- early_late_grace_score and employee_off_day_kind (which
-- apply_leave_sandwich uses) call it. Bodies are otherwise the live ones.
--
-- A later change of an employee's Weekly Holiday is not re-scored: days
-- already worked keep the weekly off they were worked under (same as an
-- outlet transfer, 20261014_2).
--
-- One-time: Gurgaon's days from 1 Oct are re-scored for comp off.
--   460: Sun 4/11/18 -> working days (0), Mon 5/12/19 -> weekly off (+1 each): 4 -> 4
--   461: Sun 4/11/18 -> working days (0), Wed 7/14   -> weekly off (+1 each): 4 -> 3
--   470: Sun 18      -> working day (0)                                      : 1 -> 0
--   471: nothing worked on a Thursday or Sunday                             : 0 -> 0
--   2 Oct (Gurgaon's Gandhi Jayanti holiday) stays +1 for 460 and 461.
-- =============================================================

ALTER TABLE public.outlets
  ADD COLUMN IF NOT EXISTS weekly_off_per_employee boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.outlets.weekly_off_per_employee IS
  'When true, each employee''s weekly off is their own profiles.weekly_holiday (Flexible/blank -> outlet, then company weekly off).';

UPDATE public.outlets
SET weekly_off_per_employee = true
WHERE id = 'caf8f319-7aeb-4a9f-86d3-095963f5cbb0';  -- Raniwala Gurgaon Laa Polki Stories


CREATE OR REPLACE FUNCTION public.employee_weekly_off_days(p_profile_id uuid)
 RETURNS int[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
           CASE WHEN o.weekly_off_per_employee THEN
             CASE lower(btrim(p.weekly_holiday))
               WHEN 'sunday'    THEN ARRAY[0]
               WHEN 'monday'    THEN ARRAY[1]
               WHEN 'tuesday'   THEN ARRAY[2]
               WHEN 'wednesday' THEN ARRAY[3]
               WHEN 'thursday'  THEN ARRAY[4]
               WHEN 'friday'    THEN ARRAY[5]
               WHEN 'saturday'  THEN ARRAY[6]
             END
           END,
           NULLIF(o.weekly_off_days, '{}'::int[]),
           NULLIF(t.weekly_off_days::int[], '{}'::int[]),
           CASE WHEN t.weekly_off_day IS NOT NULL THEN ARRAY[t.weekly_off_day::int] END,
           ARRAY[0]
         )
  FROM profiles p
  JOIN tenants t ON t.id = p.tenant_id
  LEFT JOIN outlets o ON o.id = p.outlet_id
  WHERE p.id = p_profile_id;
$function$;

REVOKE ALL ON FUNCTION public.employee_weekly_off_days(uuid) FROM PUBLIC, anon, authenticated;


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
    WHEN EXTRACT(DOW FROM p_date)::int = ANY (employee_weekly_off_days(p.id))
      THEN 'weekly_off'
  END
  FROM profiles p
  LEFT JOIN outlets o ON o.id = p.outlet_id
  WHERE p.id = p_profile_id;
$function$;


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
         employee_weekly_off_days(p.id),
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

  -- Under 4 h (Absent) is not a working day: no grace, it stays free.
  -- Past the shift's limit the grace still applies (20261021_4).
  IF p_status = 'Absent' THEN
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

  -- A graced day is Present, whatever it was (late arrival, early left or
  -- both, a normal 10:31 - 11:05 Late on top, short hours, past the shift's
  -- limit): user, 21 Oct 2026. Every later one that month is Late; past
  -- the shift's limit its short hours still count, so under 8 h it is
  -- Half Day (20261021_4).
  status := CASE
    WHEN graced THEN 'Present'
    WHEN p_status = 'Half Day'
         AND ((v_late AND v_cap_in IS NOT NULL AND v_first > v_cap_in)
              OR (v_early AND v_cap_out IS NOT NULL AND v_last < v_cap_out)) THEN 'Half Day'
    ELSE 'Late'
  END;

  RETURN NEXT;
END;
$function$;


-- One-time: re-score Gurgaon's comp off from 1 Oct against each employee's
-- own weekly off. The punch recompute trigger skips (app.regularize_apply),
-- so only the comp-off trigger runs; statuses are left as they are.
SELECT set_config('app.regularize_apply', 'on', true);

UPDATE public.attendance a
SET total_hours = a.total_hours
FROM public.profiles p
WHERE p.id = a.profile_id
  AND p.outlet_id = 'caf8f319-7aeb-4a9f-86d3-095963f5cbb0'
  AND a.date >= DATE '2026-10-01';

SELECT set_config('app.regularize_apply', '', true);
