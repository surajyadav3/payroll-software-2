-- =============================================================
-- Monthly leave credit: checked every day, not only once on the 1st (21 Oct 2026).
--
-- HR: everyone must get their 1.5 on the first day of every month.
-- leave-monthly-accrual ran once, at 06:30 IST on the 1st; if that one run
-- failed, nobody got the month's credit. Now it runs every day at 00:40 IST:
-- on the 1st it credits everyone just after midnight, and any later day
-- fills in whoever is still missing this month's credit (an outage on the
-- 1st, an employee switched back to Active) — always dated the 1st, never
-- twice in a month. It also does the joining-month sweep first, so the
-- separate leave-joining-credit job (20261021_5) is dropped.
--
-- run_monthly_leave_accrual takes an optional month so it can be tested for
-- a future month inside a rolled-back transaction. Body otherwise as
-- 20261021_5. Only cron calls it, so anon / authenticated lose EXECUTE.
-- Re-runnable.
-- =============================================================

DROP FUNCTION IF EXISTS run_monthly_leave_accrual();

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
    AND NOT EXISTS (
      SELECT 1 FROM leave_ledger l
      WHERE l.profile_id = p.id AND l.leave_type_id = lt.id AND l.entry_type = 'Accrual'
        AND l.effective_date >= v_month AND l.effective_date < (v_month + interval '1 month')::date
    );
END;
$$;
REVOKE ALL ON FUNCTION run_monthly_leave_accrual(date) FROM PUBLIC, anon, authenticated;

-- 19:10 UTC = 00:40 IST, every day.
SELECT cron.schedule('leave-monthly-accrual', '10 19 * * *', 'SELECT run_monthly_leave_accrual();');
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'leave-joining-credit';
