-- =============================================================
-- Weekly off worked: no shift time (14 Oct 2026).
--
-- On an employee's weekly off (their own outlet's: Delhi Experience Centre
-- Monday, Office / Factory Sunday) only the OT and comp off rules apply to
-- the eligible staff; there is no shift that day. So a weekly off / holiday
-- with hours worked is never Late, Half Day or Absent (short hours) -- it is
-- Present. Until now only Late was cleared; the punch recompute scored the
-- day against the shift, e.g. ~6h 35m at the Factory on Sun 11 Oct = Half
-- Day for 40+ people. Pay was never affected (a weekly off is a paid day
-- whatever its status), but reports showed them as Half Day / Short Fall.
--
-- Comp off is unchanged: weekly off worked 4h = 0.5, 5h+ = 1 (total hours,
-- no shift). OT is worked out by the web (raniwalaPayableOtHours): on the
-- weekly off every hour worked counts toward the slabs, no 8h 30m first.
--
-- Mispunch (one punch), Leave and Comp Off days stay as they are.
-- October's weekly offs / holidays worked are re-scored once below.
-- =============================================================

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
    v_off := EXTRACT(DOW FROM NEW.date)::int = ANY (v_off_days)
      OR (v_holidays AND EXISTS (
        SELECT 1 FROM holidays h
        WHERE h.tenant_id = NEW.tenant_id
          AND h.date = NEW.date
          AND (h.outlet_id IS NULL OR h.outlet_id = v_outlet)
      ));
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

-- Re-score October's off days with hours (status only; hours and comp off
-- credit stay the same). app.regularize_apply makes the punch recompute
-- trigger skip, so only the trigger above changes the status.
SELECT set_config('app.regularize_apply', 'on', true);

UPDATE public.attendance a
SET total_hours = a.total_hours
WHERE a.tenant_id = '123c949a-329f-4a48-bb25-eed41a390cf4'
  AND a.date >= DATE '2026-10-01'
  AND a.comp_off_granted
  AND a.status IN ('Late', 'Half Day', 'Absent')
  AND COALESCE(a.total_hours, 0) > 0;
