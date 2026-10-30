-- =============================================================
-- Employees can't see their own gross / CTC for now (14 Oct 2026).
--
-- User: "for now hide to the employee end to see there ctc and gross once i
-- will confirm with hr then you can show it".
--
-- tenants.salary_visible_to_employee (default off): while off, the
-- "employee reads own" policy on employee_salaries returns nothing, so
-- neither the web (My Payslips) nor the mobile app can read it. Payroll HR
-- still sees everyone's (an HR login looking at its OWN salary goes through
-- the HR policy, so HR keeps seeing theirs in the HR portal).
--
-- To show it later (once HR confirms):
--   UPDATE tenants SET salary_visible_to_employee = true WHERE id = '<tenant>';
-- =============================================================

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS salary_visible_to_employee boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.tenants.salary_visible_to_employee IS
  'Employees may read their own employee_salaries row (gross / CTC). Off until HR confirms the figures.';

DROP POLICY IF EXISTS "employee_salaries: employee reads own" ON public.employee_salaries;
CREATE POLICY "employee_salaries: employee reads own" ON public.employee_salaries
  FOR SELECT TO authenticated
  USING (
    profile_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1 FROM public.tenants t
      WHERE t.id = employee_salaries.tenant_id AND t.salary_visible_to_employee
    )
  );
