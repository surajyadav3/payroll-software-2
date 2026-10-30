-- =============================================================
-- Comp off for working past the shift on a normal day (12 Oct 2026).
--
-- Until now trg_comp_off_credit_from_hours (20260928_4) credited comp off
-- only for a weekly off / holiday worked: 4h -> 0.5 day, 5h+ -> 1 day, and
-- only for profiles.comp_off_eligible.
--
-- New, per tenant: from tenants.comp_off_extra_hours_from (NULL = off),
-- an eligible employee who works past their own shift on a normal working
-- day earns comp off by the same slabs, measured on the time past the
-- shift: 4h extra -> 0.5 day, 5h+ extra -> 1 day. The shift is the
-- employee's outlet shift (shift_start -> shift_end), else the tenant's,
-- else 8h 30m. Raniwala: Office Staff 10:20-19:15 = 8h 55m, Factory
-- 09:30-18:00 = 8h 30m.
--
-- Same mechanics as before: the credit is stored on the day
-- (attendance.comp_off_credit) and the difference goes straight into
-- profiles.comp_off_balance, so a later correction of the hours moves the
-- balance by the difference and deleting the day takes the credit back.
-- comp_off_granted stays true only for weekly off / holiday days, so the
-- two reasons can be told apart in history and reports.
--
-- Days before comp_off_extra_hours_from are left exactly as they were.
-- Statuses that never earn: Leave, Comp Off, Absent, Pending Approval
-- (an app punch the manager has not approved yet), Mispunch.
--
-- Raniwala: switched on from 1 Oct 2026 (the current payroll month), and
-- the October days already worked are re-scored once below.
-- =============================================================

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS comp_off_extra_hours_from date;

COMMENT ON COLUMN public.tenants.comp_off_extra_hours_from IS
  'Comp off for time worked past the shift on a normal day (4h extra = 0.5, 5h+ = 1), from this date. NULL = off.';

-- Length of a shift in hours from 'HH:MM' text; crosses midnight; NULL when
-- either end is missing or not a time.
CREATE OR REPLACE FUNCTION public.shift_length_hours(p_start text, p_end text)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
  SELECT CASE
    WHEN p_start ~ '^\d{1,2}:\d{2}(:\d{2})?$' AND p_end ~ '^\d{1,2}:\d{2}(:\d{2})?$' THEN
      NULLIF(
        mod((extract(epoch FROM (p_end::time - p_start::time)) / 3600 + 24)::numeric, 24),
        0)
  END;
$$;

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
    -- Normal working day: time past the employee's own shift.
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

-- Raniwala: on from 1 Oct 2026.
UPDATE public.tenants
SET comp_off_extra_hours_from = DATE '2026-10-01'
WHERE id = '123c949a-329f-4a48-bb25-eed41a390cf4'
  AND comp_off_extra_hours_from IS NULL;

-- Re-score October's long days once. A no-op write fires the BEFORE
-- trigger above; app.regularize_apply makes the punch recompute trigger
-- skip, so only the comp off credit changes. 12h+ covers every shift
-- (8h 55m + 4h is the longest needed) without touching ordinary days.
SELECT set_config('app.regularize_apply', 'on', true);

UPDATE public.attendance a
SET total_hours = a.total_hours
FROM public.profiles p
WHERE p.id = a.profile_id
  AND p.comp_off_eligible
  AND a.tenant_id = '123c949a-329f-4a48-bb25-eed41a390cf4'
  AND a.date >= DATE '2026-10-01'
  AND COALESCE(a.comp_off_granted, false) = false
  AND a.total_hours >= 12;
