-- =============================================================
-- Promotion / Increment History keeps gross and CTC apart (24 Oct 2026).
--
-- User: "on increment and promotion history page for raniwala show both
-- current gross and current ctc of the employee and make sure to show ctc of
-- employee in ctc place and gross where gross need to show".
--
-- For a salary-private tenant (Raniwala, 20261014_4) the page put the monthly
-- gross under "Current CTC", and the new figure went to profiles.ctc, which
-- profiles_salary_to_private turns into the GROSS. The page now shows and
-- sets both through set_employee_salary; this adds the gross pair next to
-- the existing old_ctc / new_ctc so the history row records both.
--
-- With gross on the row, a salary-private tenant's increments are read like
-- employee_salaries: HR or the employee themself, not every colleague.
-- Other tenants: unchanged (any member of the tenant reads them).
--
-- Existing rows are left as they are (user: Seema's 24 Oct row stays).
-- =============================================================

ALTER TABLE public.employee_promotions
  ADD COLUMN IF NOT EXISTS old_gross numeric,
  ADD COLUMN IF NOT EXISTS new_gross numeric;

DROP POLICY IF EXISTS "ep_tenant_select" ON public.employee_promotions;
CREATE POLICY "ep_tenant_select" ON public.employee_promotions
  FOR SELECT
  USING (
    tenant_id IN (SELECT profiles.tenant_id FROM profiles WHERE profiles.id = (SELECT auth.uid()))
    AND (
      NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = employee_promotions.tenant_id AND t.salary_private)
      OR profile_id = (SELECT auth.uid())
      OR (SELECT my_is_employee_hr())
    )
  );
