-- =============================================================
-- Regularize any day of the current month (11 Oct 2026, Raniwala request).
--
-- With tenants.regularize_current_month = true, an employee may raise a
-- regularize request for any day from the 1st of the current month (IST) up
-- to today, at any point in that month. The normal regularize_window_days
-- rule still applies on top (LEAST of the two), so on the 1st–2nd of a month
-- the last days of the previous month can still be fixed as before.
-- Future dates stay blocked.
--
-- Web (src/lib/helpers.js regularizeMinDate / regularizeWindowLabel) and the
-- CrewCore app (lib/helpers.ts) read the same column for the date picker
-- limits and labels; this trigger is the real gate. HR/manager-created rows
-- (auth.uid() <> profile_id) are not limited, as before.
-- =============================================================

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS regularize_current_month boolean NOT NULL DEFAULT false;

-- Live def (20260929_2) + the current-month rule.
CREATE OR REPLACE FUNCTION public.enforce_regularize_request_window()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_today  date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_window integer;
  v_ext_from  date;
  v_ext_until date;
  v_month  boolean;
  v_min    date;
BEGIN
  IF auth.role() = 'authenticated' AND auth.uid() = NEW.profile_id THEN
    SELECT COALESCE(regularize_window_days, 3), regularize_extended_from, regularize_extended_until,
           COALESCE(regularize_current_month, false)
      INTO v_window, v_ext_from, v_ext_until, v_month
      FROM tenants WHERE id = NEW.tenant_id;
    v_window := COALESCE(v_window, 3);

    IF NEW.date > v_today THEN
      RAISE EXCEPTION 'Cannot request regularization for a future date.'
        USING ERRCODE = 'check_violation';
    END IF;

    v_min := v_today - (v_window - 1);
    -- Whole current month: anything since the 1st (never narrower than the N-day window).
    IF v_month THEN
      v_min := LEAST(v_min, date_trunc('month', v_today)::date);
    END IF;

    -- Extended window still open: anything since regularize_extended_from.
    IF v_ext_from IS NOT NULL AND v_ext_until IS NOT NULL AND v_today <= v_ext_until THEN
      IF NEW.date < LEAST(v_ext_from, v_min) THEN
        RAISE EXCEPTION 'Regularization can only be requested for dates from % (until %).',
            to_char(LEAST(v_ext_from, v_min), 'DD Mon'), to_char(v_ext_until, 'DD Mon')
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END IF;

    IF NEW.date < v_min THEN
      RAISE EXCEPTION '%', CASE
          WHEN v_month THEN format('Regularization can only be requested for dates from %s to today.', to_char(v_min, 'DD Mon'))
          WHEN v_window = 1 THEN 'Regularization can only be requested for today.'
          WHEN v_window = 2 THEN 'Regularization can only be requested for today or yesterday.'
          ELSE format('Regularization can only be requested for today and the previous %s days.', v_window - 1) END
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

UPDATE tenants SET regularize_current_month = true
WHERE id = '123c949a-329f-4a48-bb25-eed41a390cf4';  -- Raniwala Jewellers
