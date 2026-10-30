-- =============================================================
-- Raniwala Delhi Experience Centre: Diwali holidays 8, 10, 11 Nov 2026
-- (24 Oct 2026).
--
-- Delhi has holidays_enabled = false, so company-wide holidays skip it, but
-- holidays added for the outlet itself apply everywhere (20261020_2): app +
-- website holiday lists (RLS), comp off for working it
-- (trg_comp_off_credit_from_hours), grace, sandwich rule, and the website's
-- attendance register / master report / paid days.
--
-- Delhi's weekly off is Monday, so 9 Nov is already off -> 8-11 Nov straight.
-- No Delhi attendance or leave on these dates yet; the re-score below only
-- matters if this is re-run later.
-- Re-runnable.
-- =============================================================

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
  SELECT v_tenant_id, o.id, 'Diwali', d.date, 'Festival'
  FROM outlets o
  CROSS JOIN (VALUES (DATE '2026-11-08'), (DATE '2026-11-10'), (DATE '2026-11-11')) AS d(date)
  WHERE o.tenant_id = v_tenant_id
    AND o.name ILIKE 'Delhi%'
  ON CONFLICT (tenant_id, outlet_id, date) DO UPDATE SET name = EXCLUDED.name, type = EXCLUDED.type;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  IF v_count <> 3 THEN
    RAISE EXCEPTION 'Expected 3 rows for the Delhi outlet only, got % — check outlets.name', v_count;
  END IF;

  -- Re-score attendance already on those days (fires trg_comp_off_credit_from_hours).
  UPDATE attendance a SET status = a.status
  FROM profiles p, outlets o
  WHERE p.id = a.profile_id AND o.id = p.outlet_id
    AND a.tenant_id = v_tenant_id
    AND a.date IN (DATE '2026-11-08', DATE '2026-11-10', DATE '2026-11-11')
    AND o.name ILIKE 'Delhi%';
END $$;
