-- =============================================================
-- Raniwala Earned Leave: HR gives a new joiner's opening balance (28 Oct 2026).
--
-- HR now types the Earned Leave a new joiner starts with on the Add Employee
-- form (web, allocate_leave). For employees ADDED from 29 Oct 2026 on:
--   * no automatic joining-month credit (1.5 / 1 / 0.5 / 0, 20261023_2) and no
--     back-filled monthly credits for months since a backdated join date;
--   * the 1.5 monthly credit starts on the 1st of the month after the month
--     they were added (and not before their join month, as before).
-- Employees added up to 28 Oct keep their balances and the old rule.
--
-- "Added" = profiles.created_at (IST date), not the join date, so a backdated
-- hire HR adds tomorrow still gets HR's figure only.
-- =============================================================

ALTER TABLE leave_types ADD COLUMN IF NOT EXISTS hr_opening_balance_from date;

COMMENT ON COLUMN leave_types.hr_opening_balance_from IS
  'Monthly-accrual types: employees added (profiles.created_at, IST) on/after this date get no automatic joining credit; HR enters their opening balance, and the monthly credit starts from the month after the one they were added in. NULL = off.';

UPDATE leave_types SET hr_opening_balance_from = DATE '2026-10-29'
WHERE joining_credit_from IS NOT NULL AND hr_opening_balance_from IS NULL;

-- ── 1. Joining credit: skip employees HR gives the balance to ──
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
      -- Added once HR gives the opening balance: HR's figure only.
      AND (hr_opening_balance_from IS NULL
           OR (v_p.created_at AT TIME ZONE 'Asia/Kolkata')::date < hr_opening_balance_from)
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

-- ── 2. Monthly 1.5: from the month after the one they were added ─
CREATE OR REPLACE FUNCTION run_monthly_leave_accrual(p_month date DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_month date := date_trunc('month', COALESCE(p_month, (now() AT TIME ZONE 'Asia/Kolkata')::date))::date;
BEGIN
  -- First, so a new joiner gets the joining credit before this month's 1.5.
  PERFORM run_joining_leave_credit();

  INSERT INTO leave_ledger (tenant_id, profile_id, leave_type_id, entry_type, days, effective_date, note)
  SELECT lt.tenant_id, p.id, lt.id, 'Accrual', lt.accrual_days, v_month,
         to_char(v_month, 'FMMonth YYYY') || ' monthly credit'
  FROM leave_types lt
  JOIN profiles p ON p.tenant_id = lt.tenant_id
  WHERE lt.accrual_frequency = 'monthly' AND lt.is_active AND lt.accrual_days > 0
    AND p.status = 'Active' AND NOT COALESCE(p.hr_support, false)
    AND (p.join_date IS NULL OR p.join_date < v_month)
    -- HR's opening balance covers the month they were added in.
    AND (lt.hr_opening_balance_from IS NULL
         OR (p.created_at AT TIME ZONE 'Asia/Kolkata')::date < lt.hr_opening_balance_from
         OR (p.created_at AT TIME ZONE 'Asia/Kolkata')::date < v_month)
    AND NOT EXISTS (
      SELECT 1 FROM leave_ledger l
      WHERE l.profile_id = p.id AND l.leave_type_id = lt.id AND l.entry_type = 'Accrual'
        AND l.effective_date >= v_month AND l.effective_date < (v_month + interval '1 month')::date
    );
END;
$$;
REVOKE ALL ON FUNCTION run_monthly_leave_accrual(date) FROM PUBLIC, anon, authenticated;
