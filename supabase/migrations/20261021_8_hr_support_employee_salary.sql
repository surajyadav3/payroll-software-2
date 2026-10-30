-- =============================================================
-- HR Support sees and sets an employee's salary (21 Oct 2026).
--
-- User: "hr support is responsible for adding employee so make sure he can
-- see and add details for an employee ... no payroll access".
--
-- Raniwala adds every new hire from the HR Support login (c18dfbde). Since
-- 20261014_4 only payroll HR could read or write employee_salaries, so every
-- hire added there was saved with no gross / CTC and HR saw an empty salary
-- on Edit. HR Support is now "employee HR": on the employee record it reads
-- and sets gross, CTC and actual gross like full HR.
--
-- Still payroll-HR only (unchanged): employee_salary_history, and every
-- payroll table under the "hr support: no payroll" restrictive policy from
-- 20261012_1 (payrolls, payslips, payroll part runs, salary additions,
-- payroll settings, promotions / increments, advances, tax slabs).
--
-- Managers / HODs / employees: unchanged.
-- =============================================================

-- Employee HR: any HR login of the tenant (full HR or HR Support), or the
-- superadmin. my_is_payroll_hr() stays for payroll.
CREATE OR REPLACE FUNCTION public.my_is_employee_hr()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE((SELECT p.role IN ('admin', 'superadmin') FROM profiles p WHERE p.id = auth.uid()), false);
$$;

REVOKE ALL ON FUNCTION public.my_is_employee_hr() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_is_employee_hr() TO authenticated;

DROP POLICY IF EXISTS "employee_salaries: payroll hr reads tenant" ON public.employee_salaries;
DROP POLICY IF EXISTS "employee_salaries: hr reads tenant" ON public.employee_salaries;
CREATE POLICY "employee_salaries: hr reads tenant" ON public.employee_salaries
  FOR SELECT TO authenticated
  USING (tenant_id = (SELECT my_tenant_id()) AND (SELECT my_is_employee_hr()));

CREATE OR REPLACE FUNCTION public.set_employee_salary(
  p_profile_id      uuid,
  p_gross           numeric DEFAULT NULL,
  p_ctc             numeric DEFAULT NULL,
  p_actual_gross    numeric DEFAULT NULL,
  p_effective_from  date DEFAULT NULL,
  p_source          text DEFAULT 'manual',
  p_note            text DEFAULT NULL
)
RETURNS public.employee_salaries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_tenant uuid;
  v_row    employee_salaries;
BEGIN
  SELECT tenant_id INTO v_tenant FROM profiles WHERE id = p_profile_id;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'Employee not found';
  END IF;

  IF auth.uid() IS NOT NULL AND NOT (
       my_role() = 'superadmin'
       OR (my_is_employee_hr() AND my_tenant_id() = v_tenant)
     ) THEN
    RAISE EXCEPTION 'Only HR can set an employee''s salary';
  END IF;

  IF COALESCE(p_gross, 0) < 0 OR COALESCE(p_ctc, 0) < 0 OR COALESCE(p_actual_gross, 0) < 0 THEN
    RAISE EXCEPTION 'Salary amounts cannot be negative';
  END IF;

  PERFORM set_config('app.salary_source', COALESCE(NULLIF(trim(p_source), ''), 'manual'), true);
  PERFORM set_config('app.salary_note', COALESCE(p_note, ''), true);
  PERFORM set_config('app.salary_effective_from', COALESCE(p_effective_from::text, ''), true);

  INSERT INTO employee_salaries AS s (profile_id, tenant_id, gross, ctc, actual_gross, updated_by, updated_at)
  VALUES (
    p_profile_id, v_tenant, p_gross, NULLIF(p_ctc, 0), NULLIF(p_actual_gross, 0), auth.uid(), now()
  )
  ON CONFLICT (profile_id) DO UPDATE SET
    gross        = COALESCE(p_gross, s.gross),
    ctc          = CASE WHEN p_ctc IS NULL THEN s.ctc ELSE NULLIF(p_ctc, 0) END,
    actual_gross = CASE WHEN p_actual_gross IS NULL THEN s.actual_gross ELSE NULLIF(p_actual_gross, 0) END,
    updated_by   = auth.uid(),
    updated_at   = now()
  RETURNING * INTO v_row;

  PERFORM set_config('app.salary_source', '', true);
  PERFORM set_config('app.salary_note', '', true);
  PERFORM set_config('app.salary_effective_from', '', true);
  RETURN v_row;
END;
$$;

-- A salary written into profiles.ctc (Add Employee, bulk import) by HR
-- Support is now kept too, instead of dropped.
CREATE OR REPLACE FUNCTION public.trg_profiles_salary_to_private()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = NEW.tenant_id AND salary_private) THEN
    RETURN NEW;
  END IF;

  -- 1 is the old "no salary yet" placeholder; only HR / the service role may
  -- set a salary.
  IF NEW.ctc > 1 AND (auth.uid() IS NULL OR my_role() = 'superadmin'
                      OR (my_is_employee_hr() AND my_tenant_id() = NEW.tenant_id)) THEN
    PERFORM set_employee_salary(NEW.id, NEW.ctc, NULL, NULL, NULL,
      CASE WHEN TG_OP = 'INSERT' THEN 'new employee' ELSE 'employee profile' END, NULL);
  END IF;

  -- An edit clears it on the way in; a new row (it has to exist first for
  -- employee_salaries' foreign key) right after.
  IF TG_OP = 'UPDATE' THEN
    NEW.ctc := 0;
  ELSE
    UPDATE profiles SET ctc = 0 WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
