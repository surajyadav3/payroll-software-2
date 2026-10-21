-- =============================================================
-- Raniwala Earned Leave: joining-month credit 1.5 / 1 / 0 (21 Oct 2026).
--
-- HR changed the joining-month rule from 20261021_5 (1 / 0.5):
--   joined on the 1st–15th  = 1.5 (the full month)
--   joined on the 16th–25th = 1
--   joined on the 26th+     = nothing for that month
-- The 1.5 on the 1st of every following month is unchanged.
--
--   1. sync_joining_leave_credit: the new amounts; no row when it's 0.
--   2. September joiners whose 30 Sep balance came from HR's sheet
--      (20261012_2 / 20261013_3 'Carry Forward' row): HR asked for the rule to
--      cover everyone who joined in September, so the sheet row is replaced by
--      the joining-month credit. October's 1.5 and any leave taken stay.
--   3. Rebuild every September / October joiner whose ledger holds only
--      automatic credits; the one with leave taken (464) gets the joining
--      credit row directly.
--
-- Inactive employees are not touched. Pre-change ledger backup:
-- Downloads/raniwala_sep_oct_joiners_leave_ledger_before_20261021_6.json.
-- Re-runnable.
-- =============================================================

COMMENT ON COLUMN leave_types.joining_credit_from IS
  'Monthly-accrual types: employees joining on/after this date get a joining-month credit (1st-15th = 1.5, 16th-25th = 1, 26th+ = 0) and the monthly credit for every month since. NULL = off.';

-- ── 1. New amounts ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION joining_month_leave_credit(p_join date)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN extract(day FROM p_join) <= 15 THEN 1.5
              WHEN extract(day FROM p_join) <= 25 THEN 1
              ELSE 0 END::numeric;
$$;

CREATE OR REPLACE FUNCTION sync_joining_leave_credit(p_profile uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_p     profiles%ROWTYPE;
  v_lt    RECORD;
  v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_month date;
BEGIN
  SELECT * INTO v_p FROM profiles WHERE id = p_profile;
  IF NOT FOUND OR v_p.status IS DISTINCT FROM 'Active' OR v_p.join_date IS NULL
     OR COALESCE(v_p.hr_support, false) THEN
    RETURN;
  END IF;

  FOR v_lt IN
    SELECT * FROM leave_types
    WHERE tenant_id = v_p.tenant_id AND accrual_frequency = 'monthly' AND is_active
      AND accrual_days > 0 AND joining_credit_from IS NOT NULL
      AND v_p.join_date >= joining_credit_from
  LOOP
    -- Anything but an automatic credit (a balance HR set, a leave taken, an
    -- HR adjustment) means HR owns this ledger now.
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM leave_ledger
      WHERE profile_id = p_profile AND leave_type_id = v_lt.id
        AND NOT (entry_type = 'Accrual' AND created_by IS NULL AND leave_request_id IS NULL)
    );

    -- Only automatic credits are left: rebuild them from the join date.
    DELETE FROM leave_ledger WHERE profile_id = p_profile AND leave_type_id = v_lt.id;

    -- Joining date still ahead: the daily sweep credits them on the day.
    CONTINUE WHEN v_p.join_date > v_today;

    IF joining_month_leave_credit(v_p.join_date) > 0 THEN
      INSERT INTO leave_ledger (tenant_id, profile_id, leave_type_id, entry_type, days, effective_date, note)
      VALUES (v_lt.tenant_id, p_profile, v_lt.id, 'Accrual', joining_month_leave_credit(v_p.join_date),
              v_p.join_date,
              to_char(v_p.join_date, 'FMMonth YYYY') || ' joining month credit (joined '
                || to_char(v_p.join_date, 'FMDD Mon') || ')');
    END IF;

    v_month := (date_trunc('month', v_p.join_date) + interval '1 month')::date;
    WHILE v_month <= v_today LOOP
      INSERT INTO leave_ledger (tenant_id, profile_id, leave_type_id, entry_type, days, effective_date, note)
      VALUES (v_lt.tenant_id, p_profile, v_lt.id, 'Accrual', v_lt.accrual_days, v_month,
              to_char(v_month, 'FMMonth YYYY') || ' monthly credit');
      v_month := (v_month + interval '1 month')::date;
    END LOOP;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION sync_joining_leave_credit(uuid) FROM PUBLIC, anon, authenticated;

-- ── 2. September joiners: HR sheet row -> joining-month credit ─
DELETE FROM leave_ledger l
USING profiles p, leave_types lt
WHERE l.profile_id = p.id AND l.leave_type_id = lt.id
  AND lt.joining_credit_from IS NOT NULL AND p.tenant_id = lt.tenant_id
  AND p.status = 'Active' AND p.join_date >= lt.joining_credit_from
  AND p.join_date < DATE '2026-10-01'
  AND l.entry_type = 'Carry Forward' AND l.effective_date = DATE '2026-09-30'
  AND l.note = 'Earned Leave balance as on 30 Sep 2026';

-- ── 3. Rebuild ─────────────────────────────────────────────────
SELECT sync_joining_leave_credit(p.id)
FROM profiles p
JOIN leave_types lt ON lt.tenant_id = p.tenant_id AND lt.joining_credit_from IS NOT NULL
WHERE p.status = 'Active' AND p.join_date >= lt.joining_credit_from;

-- Joiners with leave already taken keep their ledger; add the joining credit.
INSERT INTO leave_ledger (tenant_id, profile_id, leave_type_id, entry_type, days, effective_date, note)
SELECT lt.tenant_id, p.id, lt.id, 'Accrual', joining_month_leave_credit(p.join_date), p.join_date,
       to_char(p.join_date, 'FMMonth YYYY') || ' joining month credit (joined '
         || to_char(p.join_date, 'FMDD Mon') || ')'
FROM profiles p
JOIN leave_types lt ON lt.tenant_id = p.tenant_id AND lt.joining_credit_from IS NOT NULL
WHERE p.status = 'Active' AND NOT COALESCE(p.hr_support, false)
  AND p.join_date >= lt.joining_credit_from
  AND p.join_date <= (now() AT TIME ZONE 'Asia/Kolkata')::date
  AND joining_month_leave_credit(p.join_date) > 0
  AND NOT EXISTS (
    SELECT 1 FROM leave_ledger l
    WHERE l.profile_id = p.id AND l.leave_type_id = lt.id AND l.entry_type = 'Accrual'
      AND l.note LIKE '% joining month credit (joined %'
  );
