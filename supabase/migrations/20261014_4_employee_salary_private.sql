-- =============================================================
-- Employee salary (gross, CTC, actual gross) kept private, with history
-- (14 Oct 2026).
--
-- User: "payroll ctc and gross should only be visible on hr portal and to
-- employees their respective gross and ctc".
--
-- Until now the monthly gross sat in profiles.ctc, and every role that can
-- read a profile row could read it: Raniwala managers / HODs see their team's
-- rows, and the HR Support login (no payroll) sees everyone. RLS is per row,
-- not per column, so the salary moves to its own table:
--
--   employee_salaries          one row per employee: gross (monthly, what
--                              payroll runs on), ctc (monthly cost to company
--                              = gross + employer PF + employer ESIC), and
--                              actual_gross (set only for staff paid on a
--                              lower actual gross than their structure gross;
--                              payroll deducts the difference).
--                              Read: payroll HR of the tenant (admin, not HR
--                              Support), the employee their own row, superadmin.
--                              Written only through set_employee_salary().
--   employee_salary_history    every change, old and new figures, source,
--                              effective date, note and who made it. Payroll
--                              HR only. Written only by the trigger.
--
-- Per tenant: tenants.salary_private (Raniwala on). For such a tenant any
-- write of a salary into profiles.ctc (Add Employee, the bulk import, an
-- increment, an edit, the create-employee-user edge function) is moved into
-- employee_salaries and profiles.ctc is set back to 0, so the profile row
-- never carries the salary. Only payroll HR (or the service role) can set a
-- salary that way; from anyone else the value is dropped.
--
-- Other tenants are unchanged: salary_private is off and profiles.ctc works
-- as before.
--
-- Also: the Raniwala advance rule (one year of service) can be skipped by an
-- import that carries over advances HR already gave (app.advance_import).
-- =============================================================

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS salary_private boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.tenants.salary_private IS
  'Salary lives in employee_salaries (HR + the employee only); writes to profiles.ctc are moved there.';

-- Payroll HR: an admin who is not the HR Support login, or the superadmin.
CREATE OR REPLACE FUNCTION public.my_is_payroll_hr()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE((
    SELECT p.role = 'superadmin' OR (p.role = 'admin' AND NOT COALESCE(p.hr_support, false))
    FROM profiles p WHERE p.id = auth.uid()
  ), false);
$$;

REVOKE ALL ON FUNCTION public.my_is_payroll_hr() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_is_payroll_hr() TO authenticated;

CREATE TABLE IF NOT EXISTS public.employee_salaries (
  profile_id    uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  tenant_id     uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  gross         numeric(12,2),
  ctc           numeric(12,2),
  actual_gross  numeric(12,2),
  updated_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employee_salaries_amounts_check CHECK (
    (gross IS NULL OR gross >= 0) AND (ctc IS NULL OR ctc >= 0) AND (actual_gross IS NULL OR actual_gross > 0)
  )
);

CREATE INDEX IF NOT EXISTS employee_salaries_tenant_idx ON public.employee_salaries (tenant_id);

COMMENT ON TABLE public.employee_salaries IS
  'Current monthly gross / CTC / actual gross per employee. HR and the employee only; write via set_employee_salary().';

CREATE TABLE IF NOT EXISTS public.employee_salary_history (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  profile_id          uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  gross               numeric(12,2),
  ctc                 numeric(12,2),
  actual_gross        numeric(12,2),
  prev_gross          numeric(12,2),
  prev_ctc            numeric(12,2),
  prev_actual_gross   numeric(12,2),
  effective_from      date,
  source              text NOT NULL DEFAULT 'manual',
  note                text,
  changed_by          uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  changed_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS employee_salary_history_profile_idx
  ON public.employee_salary_history (profile_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS employee_salary_history_tenant_idx
  ON public.employee_salary_history (tenant_id);

ALTER TABLE public.employee_salaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_salary_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "employee_salaries: payroll hr reads tenant" ON public.employee_salaries;
CREATE POLICY "employee_salaries: payroll hr reads tenant" ON public.employee_salaries
  FOR SELECT TO authenticated
  USING (tenant_id = (SELECT my_tenant_id()) AND (SELECT my_is_payroll_hr()));

DROP POLICY IF EXISTS "employee_salaries: employee reads own" ON public.employee_salaries;
CREATE POLICY "employee_salaries: employee reads own" ON public.employee_salaries
  FOR SELECT TO authenticated
  USING (profile_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "employee_salaries: superadmin reads" ON public.employee_salaries;
CREATE POLICY "employee_salaries: superadmin reads" ON public.employee_salaries
  FOR SELECT TO authenticated
  USING ((SELECT my_role()) = 'superadmin');

DROP POLICY IF EXISTS "employee_salary_history: payroll hr reads tenant" ON public.employee_salary_history;
CREATE POLICY "employee_salary_history: payroll hr reads tenant" ON public.employee_salary_history
  FOR SELECT TO authenticated
  USING ((tenant_id = (SELECT my_tenant_id()) AND (SELECT my_is_payroll_hr())) OR (SELECT my_role()) = 'superadmin');

REVOKE ALL ON public.employee_salaries, public.employee_salary_history FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.employee_salaries, public.employee_salary_history FROM authenticated;
GRANT SELECT ON public.employee_salaries, public.employee_salary_history TO authenticated;

-- History: one row per real change. Source / effective date / note come from
-- the writer (set_employee_salary sets them for its transaction).
CREATE OR REPLACE FUNCTION public.trg_employee_salaries_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.gross IS NOT DISTINCT FROM OLD.gross
     AND NEW.ctc IS NOT DISTINCT FROM OLD.ctc
     AND NEW.actual_gross IS NOT DISTINCT FROM OLD.actual_gross THEN
    RETURN NEW;
  END IF;

  INSERT INTO employee_salary_history (
    tenant_id, profile_id, gross, ctc, actual_gross,
    prev_gross, prev_ctc, prev_actual_gross,
    effective_from, source, note, changed_by
  ) VALUES (
    NEW.tenant_id, NEW.profile_id, NEW.gross, NEW.ctc, NEW.actual_gross,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.gross END,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.ctc END,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.actual_gross END,
    NULLIF(current_setting('app.salary_effective_from', true), '')::date,
    COALESCE(NULLIF(current_setting('app.salary_source', true), ''), 'manual'),
    NULLIF(current_setting('app.salary_note', true), ''),
    COALESCE(auth.uid(), NEW.updated_by)
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS employee_salaries_history ON public.employee_salaries;
CREATE TRIGGER employee_salaries_history
  AFTER INSERT OR UPDATE ON public.employee_salaries
  FOR EACH ROW EXECUTE FUNCTION public.trg_employee_salaries_history();

-- The one way to set a salary. NULL = keep what is there; 0 for ctc or
-- actual_gross = clear it. The caller must be payroll HR of the employee's
-- tenant (or the service role / a migration, where auth.uid() is NULL).
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
       OR (my_is_payroll_hr() AND my_tenant_id() = v_tenant)
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

REVOKE ALL ON FUNCTION public.set_employee_salary(uuid, numeric, numeric, numeric, date, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_employee_salary(uuid, numeric, numeric, numeric, date, text, text) TO authenticated;

-- A salary written into profiles.ctc of a salary_private tenant moves to
-- employee_salaries.gross; the profile keeps 0.
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
                      OR (my_is_payroll_hr() AND my_tenant_id() = NEW.tenant_id)) THEN
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

DROP TRIGGER IF EXISTS profiles_salary_to_private ON public.profiles;
CREATE TRIGGER profiles_salary_to_private
  BEFORE UPDATE OF ctc ON public.profiles
  FOR EACH ROW
  WHEN (NEW.ctc IS DISTINCT FROM 0)
  EXECUTE FUNCTION public.trg_profiles_salary_to_private();

DROP TRIGGER IF EXISTS profiles_salary_to_private_insert ON public.profiles;
CREATE TRIGGER profiles_salary_to_private_insert
  AFTER INSERT ON public.profiles
  FOR EACH ROW
  WHEN (NEW.ctc IS DISTINCT FROM 0)
  EXECUTE FUNCTION public.trg_profiles_salary_to_private();

-- Raniwala advance rule: an import of advances HR already gave skips the
-- one-year-of-service check (app.advance_import, set only by migrations).
CREATE OR REPLACE FUNCTION public.trg_raniwala_advance_rules()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  v_join     date;
  v_eligible date;
  v_today    date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = NEW.tenant_id AND company_name ILIKE '%Raniwala%') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' AND COALESCE(current_setting('app.advance_import', true), '') <> 'on' THEN
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

-- Raniwala: on, and the salaries already in profiles.ctc move over.
UPDATE public.tenants SET salary_private = true
WHERE id = '123c949a-329f-4a48-bb25-eed41a390cf4';

SELECT set_config('app.salary_source', 'moved from employee profile', true);

INSERT INTO public.employee_salaries (profile_id, tenant_id, gross, updated_at)
SELECT p.id, p.tenant_id, p.ctc, now()
FROM public.profiles p
WHERE p.tenant_id = '123c949a-329f-4a48-bb25-eed41a390cf4'
  AND p.ctc > 1
ON CONFLICT (profile_id) DO NOTHING;

SELECT set_config('app.salary_source', '', true);

UPDATE public.profiles SET ctc = 0
WHERE tenant_id = '123c949a-329f-4a48-bb25-eed41a390cf4'
  AND ctc <> 0;
