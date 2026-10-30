-- =============================================================
-- Outlets that observe no holidays — only their weekly off (10 Oct 2026).
--
-- Raniwala's two showrooms (Delhi Experience Centre, Gurgaon Laa Polki
-- Stories) stay open on every holiday; their staff get the outlet's weekly
-- off and nothing else. Neither outlet has a holiday of its own — what
-- reaches them is the company-wide rows (holidays.outlet_id IS NULL:
-- Republic Day, Holi, Labour Day, Independence Day, Gandhi Jayanti,
-- Christmas). Those can't be deleted or split per outlet without taking
-- them away from Office / Factory / B2B and from the 18 active employees who
-- have no outlet yet, and every "All outlets" holiday HR adds later would
-- land on the showrooms again.
--
-- So the rule lives on the outlet: outlets.holidays_enabled (default true,
-- nothing changes for any other outlet or tenant). When false:
--
--   1. RLS hides every holidays row from that outlet's own staff
--      (employee / manager / hod / management). The website and the mobile
--      app both read `holidays` directly, so calendars, the home page, the
--      login celebration and the AI assistant show none without any client
--      change. HR (admin / superadmin) still sees the full list to manage it.
--   2. trg_comp_off_credit_from_hours no longer treats a holiday as an off
--      day for them — working on one is an ordinary working day (no comp-off
--      credit, Late stays Late). Weekly offs are unaffected.
--
-- Checked live before applying: no attendance exists for either outlet on
-- any past 2026 holiday, so no comp-off credit needs reversing.
-- Re-runnable.
-- =============================================================

ALTER TABLE outlets ADD COLUMN IF NOT EXISTS holidays_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN outlets.holidays_enabled IS
  'false = this outlet observes no holidays, only its weekly off. Holidays are hidden from its staff (RLS) and never count as an off day for comp-off.';

-- ── 1. Hide holidays from staff of a no-holiday outlet ─────────
-- True for anyone with no outlet, and for anon / service contexts.
CREATE OR REPLACE FUNCTION my_outlet_has_holidays()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((
    SELECT o.holidays_enabled
    FROM profiles p
    JOIN outlets o ON o.id = p.outlet_id
    WHERE p.id = auth.uid()
  ), true);
$$;
GRANT EXECUTE ON FUNCTION my_outlet_has_holidays() TO anon, authenticated, service_role;

DROP POLICY IF EXISTS "holidays: hidden from no-holiday outlets" ON holidays;
CREATE POLICY "holidays: hidden from no-holiday outlets" ON holidays
  AS RESTRICTIVE FOR SELECT
  USING (
    (SELECT my_outlet_has_holidays())
    OR (SELECT my_role()) IN ('admin', 'superadmin')
  );

-- ── 2. Comp-off: a holiday is not an off day at a no-holiday outlet ──
-- Live definition (20260928_4) + v_holidays; nothing else changed.
CREATE OR REPLACE FUNCTION trg_comp_off_credit_from_hours()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_flag     boolean;
  v_eligible boolean;
  v_outlet   uuid;
  v_off_days int[];
  v_holidays boolean;
  v_new      numeric := 0;
  v_old      numeric := 0;
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
         COALESCE(o.holidays_enabled, true)
  INTO v_flag, v_eligible, v_outlet, v_off_days, v_holidays
  FROM profiles p
  JOIN tenants t ON t.id = p.tenant_id
  LEFT JOIN outlets o ON o.id = p.outlet_id
  WHERE p.id = NEW.profile_id;

  IF NOT COALESCE(v_flag, false) THEN
    RETURN NEW;
  END IF;

  IF NOT (
    EXTRACT(DOW FROM NEW.date)::int = ANY (v_off_days)
    OR (v_holidays AND EXISTS (
      SELECT 1 FROM holidays h
      WHERE h.tenant_id = NEW.tenant_id
        AND h.date = NEW.date
        AND (h.outlet_id IS NULL OR h.outlet_id = v_outlet)
    ))
  ) THEN
    RETURN NEW;
  END IF;

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
$$;

-- ── 3. Raniwala: Delhi + Gurgaon showrooms observe no holidays ──
DO $$
DECLARE
  v_tenant_id uuid;
  v_count     int;
BEGIN
  SELECT id INTO v_tenant_id FROM tenants WHERE company_name ILIKE '%Raniwala%' LIMIT 1;
  IF v_tenant_id IS NULL THEN
    RAISE NOTICE 'Raniwala tenant not found — nothing to switch off';
    RETURN;
  END IF;

  UPDATE outlets SET holidays_enabled = false
  WHERE tenant_id = v_tenant_id
    AND (name ILIKE 'Delhi%' OR name ILIKE 'Gurgaon%' OR name ILIKE 'Gurugram%');
  GET DIAGNOSTICS v_count = ROW_COUNT;

  IF v_count <> 2 THEN
    RAISE EXCEPTION 'Expected exactly the Delhi and Gurgaon outlets, matched % — check outlets.name', v_count;
  END IF;
END $$;
