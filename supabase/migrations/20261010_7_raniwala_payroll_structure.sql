-- =============================================================
-- Raniwala Jewellers: payroll structure.
--
-- The salary rules themselves (Basic/HRA split, PF, ESIC, retention) are
-- arithmetic on the gross salary and live in src/lib/raniwalaPayroll.js, where
-- Run Payroll, Salary Structure and the payslip all read them. This migration
-- is what those screens need from the database:
--
--   1. payslips.work_days becomes numeric. Raniwala's paid days can end in a
--      half day (27.5); the integer column stored that as 28 while the money
--      was for 27.5, so the slip showed the wrong number of days.
--
--   2. employee_payroll_settings: one row per employee with what HR decides
--      for payroll -- father's name (printed on the slip), the probation
--      completion date, the retention rate (0 / 5 / 10 % of gross, only taken
--      while on probation), the monthly TDS amount, and whether PF / ESIC
--      apply to the employee at all. HR (admin) only; an employee can read
--      their own row. No row means the defaults: no retention, no TDS, PF and
--      ESIC by the rules.
--
--   3. An advance needs one completed year of service (Raniwala's policy) and
--      a monthly deduction between Rs.1 and the advance amount. Enforced on
--      the advances table so the website and the app follow the same rule.
--
--   4. process_payroll_by_country now records what each payslip recovered
--      (advance_repayments) and which one-off pay items it paid
--      (salary_additions.paid_payslip_id). Both were missing, so reverting a
--      run left advance balances reduced and arrears marked Paid.
--
--   5. revert_payroll_atomic puts both back, and checks who is calling. It had
--      no check at all and was executable by anon: anyone holding a payroll id
--      could delete that run and its payslips.
--
-- The two functions are shared by every tenant. Apart from the bookkeeping in
-- 4 and 5 and the caller checks, their behaviour is unchanged.
-- =============================================================


-- ── 1. Paid days can be a half day ───────────────────────────────────────────
ALTER TABLE public.payslips ALTER COLUMN work_days TYPE numeric;


-- ── 2. Per-employee payroll settings ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.employee_payroll_settings (
  profile_id         uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  tenant_id          uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  father_name        text NOT NULL DEFAULT '',
  probation_end_date date,
  retention_percent  numeric NOT NULL DEFAULT 0,
  tds_monthly        numeric NOT NULL DEFAULT 0,
  pf_applicable      boolean NOT NULL DEFAULT true,
  esic_applicable    boolean NOT NULL DEFAULT true,
  updated_by         uuid,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employee_payroll_settings_retention_check CHECK (retention_percent IN (0, 5, 10)),
  CONSTRAINT employee_payroll_settings_tds_check CHECK (tds_monthly >= 0)
);

CREATE INDEX IF NOT EXISTS idx_employee_payroll_settings_tenant
  ON public.employee_payroll_settings (tenant_id);

CREATE OR REPLACE FUNCTION public.trg_employee_payroll_settings_stamp()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Definer, so the check sees the profile whoever is writing; who may write
  -- is the policies' business.
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = NEW.profile_id AND tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'This employee does not belong to the company';
  END IF;
  NEW.father_name := btrim(COALESCE(NEW.father_name, ''));
  NEW.updated_by  := auth.uid();
  NEW.updated_at  := now();
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.trg_employee_payroll_settings_stamp() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS employee_payroll_settings_stamp ON public.employee_payroll_settings;
CREATE TRIGGER employee_payroll_settings_stamp
  BEFORE INSERT OR UPDATE ON public.employee_payroll_settings
  FOR EACH ROW EXECUTE FUNCTION public.trg_employee_payroll_settings_stamp();

ALTER TABLE public.employee_payroll_settings ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.employee_payroll_settings FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.employee_payroll_settings TO authenticated;

DROP POLICY IF EXISTS "employee_payroll_settings: hr manages tenant" ON public.employee_payroll_settings;
CREATE POLICY "employee_payroll_settings: hr manages tenant" ON public.employee_payroll_settings
  FOR ALL TO authenticated
  USING (tenant_id = (SELECT my_tenant_id()) AND (SELECT my_role()) = 'admin')
  WITH CHECK (tenant_id = (SELECT my_tenant_id()) AND (SELECT my_role()) = 'admin');

DROP POLICY IF EXISTS "employee_payroll_settings: employee sees own" ON public.employee_payroll_settings;
CREATE POLICY "employee_payroll_settings: employee sees own" ON public.employee_payroll_settings
  FOR SELECT TO authenticated
  USING (profile_id = (SELECT auth.uid()));


-- ── 3. Raniwala: who can get an advance, and how it is recovered ─────────────
CREATE OR REPLACE FUNCTION public.trg_raniwala_advance_rules()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_join     date;
  v_eligible date;
  v_today    date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = NEW.tenant_id AND company_name ILIKE '%Raniwala%') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT join_date INTO v_join FROM profiles WHERE id = NEW.profile_id;
    IF v_join IS NULL THEN
      RAISE EXCEPTION 'This employee has no date of joining on record, so one year of service cannot be checked';
    END IF;
    v_eligible := (v_join + interval '1 year')::date;
    IF v_eligible > v_today THEN
      RAISE EXCEPTION 'An advance can be given only after one year of service. This employee completes one year on %',
        to_char(v_eligible, 'DD Mon YYYY');
    END IF;
  END IF;

  IF COALESCE(NEW.amount, 0) <= 0 THEN
    RAISE EXCEPTION 'Enter the advance amount';
  END IF;
  IF COALESCE(NEW.emi, 0) <= 0 OR NEW.emi > NEW.amount THEN
    RAISE EXCEPTION 'The monthly deduction must be between Rs.1 and the advance amount';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.trg_raniwala_advance_rules() FROM PUBLIC, anon, authenticated;

-- Not fired by payroll: a run only moves paid / balance / status.
DROP TRIGGER IF EXISTS raniwala_advance_rules ON public.advances;
CREATE TRIGGER raniwala_advance_rules
  BEFORE INSERT OR UPDATE OF amount, emi ON public.advances
  FOR EACH ROW EXECUTE FUNCTION public.trg_raniwala_advance_rules();


-- ── 4. A payslip remembers what it recovered and what it paid ────────────────
ALTER TABLE public.salary_additions
  ADD COLUMN IF NOT EXISTS paid_payslip_id uuid REFERENCES public.payslips(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_salary_additions_paid_payslip
  ON public.salary_additions (paid_payslip_id) WHERE paid_payslip_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.process_payroll_by_country(p_tenant_id uuid, p_month integer, p_year integer, p_country_group text, p_data jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_payroll_id uuid;
  v_payslip_id uuid;
  v_slip       jsonb;
  v_adv        jsonb;
  v_adv_amount numeric;
  v_dept       RECORD;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid()
      AND tenant_id = p_tenant_id
      AND role IN ('admin', 'manager', 'superadmin')
  ) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  -- Same rule as the "raniwala hr only" policies on payrolls / payslips.
  IF my_role() = 'manager' AND my_is_raniwala() THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  INSERT INTO payrolls (tenant_id, month, year, country_group, status)
  VALUES (p_tenant_id, p_month, p_year, p_country_group, 'Processed')
  RETURNING id INTO v_payroll_id;

  FOR v_slip IN SELECT * FROM jsonb_array_elements(p_data) LOOP
    INSERT INTO payslips (
      payroll_id, tenant_id, profile_id,
      emp_name, department, designation,
      ctc, work_days, total_work_days,
      gross_earnings, total_deductions, advance_deduction,
      net_pay, breakdown
    ) VALUES (
      v_payroll_id,
      p_tenant_id,
      (v_slip->>'profile_id')::uuid,
      v_slip->>'emp_name',
      COALESCE(v_slip->>'department', ''),
      COALESCE(v_slip->>'designation', ''),
      (v_slip->>'ctc')::numeric,
      (v_slip->>'work_days')::numeric,
      (v_slip->>'total_work_days')::numeric,
      (v_slip->>'gross_earnings')::numeric,
      (v_slip->>'total_deductions')::numeric,
      (v_slip->>'advance_deduction')::numeric,
      (v_slip->>'net_pay')::numeric,
      v_slip->'breakdown'
    )
    RETURNING id INTO v_payslip_id;

    FOR v_adv IN SELECT * FROM jsonb_array_elements(COALESCE(v_slip->'advances', '[]'::jsonb)) LOOP
      v_adv_amount := (v_adv->>'amount')::numeric;
      UPDATE advances
      SET
        paid    = paid + v_adv_amount,
        balance = GREATEST(0, balance - v_adv_amount),
        status  = CASE
                    WHEN balance - v_adv_amount <= 0 THEN 'Completed'
                    ELSE 'Active'
                  END
      WHERE id = (v_adv->>'id')::uuid AND tenant_id = p_tenant_id;

      -- The recovery, per payslip: this is what a revert reads to put the
      -- balance back.
      IF FOUND THEN
        INSERT INTO advance_repayments (tenant_id, advance_id, payslip_id, amount, month, year)
        VALUES (p_tenant_id, (v_adv->>'id')::uuid, v_payslip_id, v_adv_amount, p_month, p_year);
      END IF;
    END LOOP;

    -- Mark any salary_additions rows this slip paid out as 'Paid' so they
    -- aren't picked up again in a future month's payroll.
    IF v_slip ? 'salary_addition_ids' THEN
      UPDATE salary_additions
      SET status = 'Paid', paid_payslip_id = v_payslip_id
      WHERE id IN (SELECT (jsonb_array_elements_text(v_slip->'salary_addition_ids'))::uuid)
        AND tenant_id = p_tenant_id;
    END IF;
  END LOOP;

  -- Department-level GL journal, aggregated straight from the payload
  -- that was just inserted as payslips -- one small debit/credit set per
  -- department rather than a full ledger UI.
  FOR v_dept IN
    SELECT
      COALESCE(s->>'department', '(Unassigned)') AS department,
      SUM((s->>'gross_earnings')::numeric)                                    AS gross,
      SUM((s->>'net_pay')::numeric)                                           AS net,
      SUM((s->>'total_deductions')::numeric + (s->>'advance_deduction')::numeric) AS deductions
    FROM jsonb_array_elements(p_data) s
    GROUP BY COALESCE(s->>'department', '(Unassigned)')
  LOOP
    IF v_dept.gross > 0 THEN
      INSERT INTO payroll_gl_entries (payroll_id, tenant_id, department, entry_side, account_name, amount)
      VALUES (v_payroll_id, p_tenant_id, v_dept.department, 'debit', 'Salary Expense', v_dept.gross);
    END IF;
    IF v_dept.net > 0 THEN
      INSERT INTO payroll_gl_entries (payroll_id, tenant_id, department, entry_side, account_name, amount)
      VALUES (v_payroll_id, p_tenant_id, v_dept.department, 'credit', 'Salary Payable', v_dept.net);
    END IF;
    IF v_dept.deductions > 0 THEN
      INSERT INTO payroll_gl_entries (payroll_id, tenant_id, department, entry_side, account_name, amount)
      VALUES (v_payroll_id, p_tenant_id, v_dept.department, 'credit', 'Statutory & Other Deductions Payable', v_dept.deductions);
    END IF;
  END LOOP;

  RETURN v_payroll_id;
END;
$function$;


-- ── 5. Reverting a run undoes all of it, and only for the people who may ─────
CREATE OR REPLACE FUNCTION public.revert_payroll_atomic(p_payroll_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant    uuid;
  v_repayment RECORD;
BEGIN
  SELECT tenant_id INTO v_tenant FROM payrolls WHERE id = p_payroll_id;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'Payroll run not found';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid()
      AND tenant_id = v_tenant
      AND role IN ('admin', 'manager', 'superadmin')
  ) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  IF my_role() = 'manager' AND my_is_raniwala() THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  -- 1. Restore advance balances from what this run's payslips recovered
  FOR v_repayment IN
    SELECT advance_id, amount
    FROM advance_repayments
    WHERE payslip_id IN (SELECT id FROM payslips WHERE payroll_id = p_payroll_id)
  LOOP
    UPDATE advances
    SET
      paid = GREATEST(0, paid - v_repayment.amount),
      balance = balance + v_repayment.amount,
      status = 'Active'
    WHERE id = v_repayment.advance_id;
  END LOOP;

  -- 2. One-off pay items this run paid are due again
  UPDATE salary_additions
  SET status = 'Approved', paid_payslip_id = NULL
  WHERE paid_payslip_id IN (SELECT id FROM payslips WHERE payroll_id = p_payroll_id);

  -- 3. Delete payslips (cascades to their advance_repayments)
  DELETE FROM payslips WHERE payroll_id = p_payroll_id;

  -- 4. Delete the payroll record (cascades to its GL entries)
  DELETE FROM payrolls WHERE id = p_payroll_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.process_payroll_by_country(uuid, integer, integer, text, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.revert_payroll_atomic(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.process_payroll_by_country(uuid, integer, integer, text, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.revert_payroll_atomic(uuid) TO authenticated, service_role;
