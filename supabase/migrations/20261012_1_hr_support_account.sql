-- =============================================================
-- HR Support accounts (12 Oct 2026) — an HR login without payroll.
--
-- Raniwala asked for a second HR portal account, "RANIWALA HR SUPPORT"
-- (support@raniwalajewellers.com), that gets every request and approves
-- it AS HR, but never sees payroll.
--
-- It is a normal HR account (role 'admin'), so everything already aimed
-- at HR reaches it with no further change: every request notification goes
-- to all active admins (incl. the leave HR copy, 20261010_5), and HR may
-- decide any pending leave / punch / regularize / special request
-- (20261003_3). What sets it apart is profiles.hr_support:
--
--   1. profiles.hr_support — the website shows such an account the HR
--      portal minus Payroll (sidebar, routes, search, salary fields on
--      Employees, payroll reports in Master Report, pay settings).
--   2. my_is_hr_support() for policies.
--   3. Only a FULL HR (admin without hr_support) or superadmin may switch
--      the flag, and an HR Support account may not hand out the admin role
--      — otherwise it could lift its own restriction. The flag is cleared
--      if the account stops being an admin.
--   4. A restrictive policy on every payroll table: an HR Support account
--      reads and writes no payroll rows at all, whatever the page asks for.
--      Payroll RPCs are SECURITY DEFINER and unaffected for everyone else.
--
-- The account itself is created by a one-off script (auth user + profile),
-- not here, so no password is kept in the repo.
--
-- Mobile app: nothing to do. The account is a web HR login.
-- =============================================================

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS hr_support boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.profiles.hr_support IS
  'HR Support account: role admin without payroll (website hides payroll; restrictive RLS on payroll tables). Only a full HR / superadmin may change it.';

CREATE OR REPLACE FUNCTION public.my_is_hr_support()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE((SELECT hr_support FROM profiles WHERE id = auth.uid()), false);
$function$;

CREATE OR REPLACE FUNCTION public.guard_profile_hr_support()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_full_hr boolean := auth.uid() IS NULL  -- service role (edge functions, scripts)
    OR COALESCE(my_role(), '') = 'superadmin'
    OR (COALESCE(my_role(), '') = 'admin' AND NOT my_is_hr_support());
BEGIN
  IF NEW.role IS DISTINCT FROM 'admin' THEN
    NEW.hr_support := false;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.hr_support IS DISTINCT FROM OLD.hr_support AND NOT v_full_hr THEN
    RAISE EXCEPTION 'Only full HR can change HR Support access';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.hr_support AND NOT v_full_hr THEN
    RAISE EXCEPTION 'Only full HR can create an HR Support account';
  END IF;

  -- An HR Support account can't create a full HR (that would undo its own limit).
  IF NEW.role = 'admin' AND NOT NEW.hr_support
     AND (TG_OP = 'INSERT' OR OLD.role IS DISTINCT FROM 'admin' OR OLD.hr_support)
     AND auth.uid() IS NOT NULL AND my_is_hr_support() THEN
    RAISE EXCEPTION 'HR Support can''t give full HR access';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_guard_profile_hr_support ON public.profiles;
CREATE TRIGGER trg_guard_profile_hr_support
  BEFORE INSERT OR UPDATE OF hr_support, role ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_profile_hr_support();

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'payrolls', 'payslips', 'payroll_gl_entries', 'salary_components', 'salary_additions',
    'employee_payroll_settings', 'employee_promotions', 'advances', 'advance_repayments', 'tax_slabs'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "hr support: no payroll" ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY "hr support: no payroll" ON public.%I AS RESTRICTIVE FOR ALL TO authenticated '
      'USING (NOT (SELECT my_is_hr_support())) WITH CHECK (NOT (SELECT my_is_hr_support()))', t);
  END LOOP;
END $$;
