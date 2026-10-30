-- =============================================================
-- Comp off: the weekly off is always the employee's own outlet's (14 Oct 2026).
--
-- Raniwala's Delhi Experience Centre is off on MONDAY, not Sunday. So for a
-- Delhi employee:
--   * Monday worked  = weekly off worked -> 4h = 0.5 day, 5h+ = 1 day.
--   * Sunday worked  = a normal working day -> comp off only for time past
--     their own shift (11:00-19:30 = 8h 30m): 4h extra = 0.5, 5h+ = 1.
-- trg_comp_off_credit_from_hours (20261012_4) already reads the outlet's
-- weekly_off_days, so new days are scored right. Two gaps fixed here:
--
-- 1. A day scored as a weekly off kept comp_off_granted = true even after a
--    re-score found it to be a normal day (the flag was only ever set, never
--    cleared), so reports and Leave Balances still called it "weekly off
--    worked". The normal-day branch now clears it.
--
-- 2. Days punched before an employee had an outlet were scored against the
--    company's weekly off (Sunday). HONEY MEHTA (EMP 467) joined on 7 Oct and
--    was put in Delhi after working Sunday 11 Oct, which earned a full comp
--    off day as a "weekly off". When an employee gets their first outlet,
--    their days from comp_off_extra_hours_from are now re-scored. A later
--    transfer between outlets does not re-score: those days were worked
--    under the old outlet's weekly off.
--
-- One-time: EMP 467's 11 Oct is re-scored (10h 03m on a Delhi working day =
-- 1h 33m past the shift -> 0; balance 1 -> 0).
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
    -- Weekly off / holiday worked (unchanged from 20260928_4).
    NEW.comp_off_granted := true;

    IF NEW.status = 'Late' THEN
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

-- First outlet assigned: re-score the employee's days since the extra-hours
-- rule started, now against that outlet's weekly off and shift. A no-op
-- write fires the BEFORE trigger above; app.regularize_apply makes the punch
-- recompute trigger skip (statuses and hours stay as they are), and the
-- previous value is put back so the rest of the transaction is unaffected.
CREATE OR REPLACE FUNCTION public.trg_profiles_first_outlet_rescore_comp_off()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_from date;
  v_prev text := current_setting('app.regularize_apply', true);
BEGIN
  SELECT comp_off_extra_hours_from INTO v_from FROM tenants WHERE id = NEW.tenant_id;
  IF v_from IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM set_config('app.regularize_apply', 'on', true);

  UPDATE attendance
  SET total_hours = total_hours
  WHERE profile_id = NEW.id
    AND date >= v_from;

  PERFORM set_config('app.regularize_apply', COALESCE(v_prev, ''), true);
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.trg_profiles_first_outlet_rescore_comp_off() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS profiles_first_outlet_rescore_comp_off ON public.profiles;
CREATE TRIGGER profiles_first_outlet_rescore_comp_off
  AFTER UPDATE OF outlet_id ON public.profiles
  FOR EACH ROW
  WHEN (OLD.outlet_id IS NULL AND NEW.outlet_id IS NOT NULL)
  EXECUTE FUNCTION public.trg_profiles_first_outlet_rescore_comp_off();

-- One-time: EMP 467 HONEY MEHTA, Sunday 11 Oct (Delhi working day).
SELECT set_config('app.regularize_apply', 'on', true);

UPDATE public.attendance a
SET total_hours = a.total_hours
FROM public.profiles p
WHERE p.id = a.profile_id
  AND p.tenant_id = '123c949a-329f-4a48-bb25-eed41a390cf4'
  AND p.employee_id = '467'
  AND a.date = DATE '2026-10-11';
