-- =============================================================
-- Raniwala Earned Leave: joining-month credit + 1.5 every month (21 Oct 2026).
--
-- Why: the employees who joined in September but were added to CrewCore after
-- the 30 Sep balance set-up (20261012_2 / 20261013_3) had no ledger at all,
-- so no October 1.5 — and run_monthly_leave_accrual only credited people
-- with no Earned Leave request in the previous month and skipped anyone whose
-- first ledger row was in that month.
--
-- HR's rule (21 Oct 2026):
--   * the month an employee joins: joined on the 1st–15th = 1 day,
--     joined on the 16th or later = 0.5 day, credited on the joining date;
--   * every month after that: 1.5 on the 1st, to every active employee,
--     leave taken or not.
--
--   1. leave_types.joining_credit_from — opt-in per leave type; employees who
--      joined on or after this date get the joining-month credit. Raniwala
--      Earned Leave = 1 Sep 2026 (the 30 Sep balances cover everyone before).
--   2. sync_joining_leave_credit(profile): joining credit + 1.5 for every
--      month since. Rebuilds only a ledger that holds nothing but automatic
--      credits, so a balance HR set, a leave taken or an HR adjustment is
--      never touched. Runs when a profile is added or its join date / status
--      / company changes, and from a daily sweep (someone added ahead of their
--      joining date gets credited on the day they join).
--   3. run_monthly_leave_accrual: 1.5 on the 1st to every active employee who
--      joined before that month (once per month), after the joining sweep.
--   4. Backfill: the 4 September + 7 October joiners, and the October 1.5 for
--      the 4 existing employees who never got it (600, 662, 678, Anand Sain).
--
-- Only Raniwala has a monthly-accrual leave type, so no other company changes.
-- Re-runnable.
-- =============================================================

-- ── 1. Opt-in date ─────────────────────────────────────────────
ALTER TABLE leave_types ADD COLUMN IF NOT EXISTS joining_credit_from date;
COMMENT ON COLUMN leave_types.joining_credit_from IS
  'Monthly-accrual types: employees joining on/after this date get a joining-month credit (1st-15th = 1 day, 16th+ = 0.5) and the monthly credit for every month since. NULL = off.';

UPDATE leave_types SET joining_credit_from = DATE '2026-09-01'
WHERE tenant_id = '123c949a-329f-4a48-bb25-eed41a390cf4'
  AND name = 'Earned Leave' AND accrual_frequency = 'monthly';

-- ── 2. Joining-month credit for one employee ───────────────────
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
     OR v_p.join_date > v_today OR COALESCE(v_p.hr_support, false) THEN
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

    INSERT INTO leave_ledger (tenant_id, profile_id, leave_type_id, entry_type, days, effective_date, note)
    VALUES (v_lt.tenant_id, p_profile, v_lt.id, 'Accrual',
            CASE WHEN extract(day FROM v_p.join_date) <= 15 THEN 1 ELSE 0.5 END,
            v_p.join_date,
            to_char(v_p.join_date, 'FMMonth YYYY') || ' joining month credit (joined '
              || to_char(v_p.join_date, 'FMDD Mon') || ')');

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

CREATE OR REPLACE FUNCTION trg_profiles_joining_leave_credit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM sync_joining_leave_credit(NEW.id);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS profiles_joining_leave_credit_insert ON profiles;
CREATE TRIGGER profiles_joining_leave_credit_insert
  AFTER INSERT ON profiles
  FOR EACH ROW WHEN (NEW.join_date IS NOT NULL)
  EXECUTE FUNCTION trg_profiles_joining_leave_credit();

DROP TRIGGER IF EXISTS profiles_joining_leave_credit_update ON profiles;
CREATE TRIGGER profiles_joining_leave_credit_update
  AFTER UPDATE OF join_date, status, tenant_id ON profiles
  FOR EACH ROW WHEN (NEW.join_date IS NOT NULL AND (
    OLD.join_date IS DISTINCT FROM NEW.join_date OR OLD.status IS DISTINCT FROM NEW.status
    OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id))
  EXECUTE FUNCTION trg_profiles_joining_leave_credit();

-- Daily sweep: new joiners with no ledger yet (added ahead of their joining
-- date, or the trigger fired before their company / join date was set).
CREATE OR REPLACE FUNCTION run_joining_leave_credit()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM sync_joining_leave_credit(p.id)
  FROM profiles p
  JOIN leave_types lt ON lt.tenant_id = p.tenant_id AND lt.accrual_frequency = 'monthly'
   AND lt.is_active AND lt.accrual_days > 0 AND lt.joining_credit_from IS NOT NULL
  WHERE p.status = 'Active' AND p.join_date >= lt.joining_credit_from
    AND p.join_date <= (now() AT TIME ZONE 'Asia/Kolkata')::date
    AND NOT EXISTS (SELECT 1 FROM leave_ledger l WHERE l.profile_id = p.id AND l.leave_type_id = lt.id);
END;
$$;
REVOKE ALL ON FUNCTION run_joining_leave_credit() FROM PUBLIC, anon, authenticated;

-- ── 3. Monthly credit: every active employee, once a month ─────
CREATE OR REPLACE FUNCTION run_monthly_leave_accrual()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_month date := date_trunc('month', (now() AT TIME ZONE 'Asia/Kolkata')::date)::date;
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
    AND NOT EXISTS (
      SELECT 1 FROM leave_ledger l
      WHERE l.profile_id = p.id AND l.leave_type_id = lt.id AND l.entry_type = 'Accrual'
        AND l.effective_date >= v_month AND l.effective_date < (v_month + interval '1 month')::date
    );
END;
$$;

SELECT cron.schedule('leave-joining-credit', '10 19 * * *', 'SELECT run_joining_leave_credit();');

-- ── 4. Backfill ────────────────────────────────────────────────
-- Sep + Oct joiners with no ledger: joining credit (+ October 1.5 for Sep).
SELECT run_joining_leave_credit();

-- Existing employees who never got October's 1.5.
INSERT INTO leave_ledger (tenant_id, profile_id, leave_type_id, entry_type, days, effective_date, note)
SELECT lt.tenant_id, p.id, lt.id, 'Accrual', lt.accrual_days, DATE '2026-10-01', 'October 2026 monthly credit'
FROM leave_types lt
JOIN profiles p ON p.tenant_id = lt.tenant_id
WHERE lt.tenant_id = '123c949a-329f-4a48-bb25-eed41a390cf4' AND lt.name = 'Earned Leave'
  AND p.status = 'Active' AND NOT COALESCE(p.hr_support, false)
  AND p.join_date < DATE '2026-10-01'
  AND NOT EXISTS (
    SELECT 1 FROM leave_ledger l
    WHERE l.profile_id = p.id AND l.leave_type_id = lt.id AND l.entry_type = 'Accrual'
      AND l.effective_date >= DATE '2026-10-01' AND l.effective_date < DATE '2026-11-01'
  );
