-- Raniwala: September 2026 paid in two runs, and payslips held until HR
-- releases them.
--
--   1. payroll_part_runs — one row per part of a month HR pays in two runs
--      (Sept 2026: 1–16 on the old PF rule, 17–30 on the new one; see
--      RANIWALA_SPLIT_MONTHS in src/lib/raniwalaPayroll.js). `lines` holds
--      every employee's figures for the part, frozen when HR ran it; the final
--      payslip (a normal payrolls/payslips run) adds the two parts up. A part
--      cannot be changed or undone once the month's final payroll exists.
--
--   2. payrolls.released_at — when employees may see the run's payslips.
--      Every existing run, and every new run of other tenants, is released at
--      once (the default). A Raniwala run starts held (NULL): HR checks it in
--      Run Payroll and releases it from there. Until then an employee cannot
--      read their own payslip — web, mobile app and the assistant all read
--      payslips through RLS, so the hold is a restrictive policy.
--
-- Size: two part rows a month (~270 lines of jsonb each), two columns on
-- payrolls. No new request on any screen except Raniwala's Run Payroll.

-- ── 1. Part runs ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.payroll_part_runs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  year       integer NOT NULL,
  month      integer NOT NULL CHECK (month BETWEEN 1 AND 12),
  part       smallint NOT NULL CHECK (part IN (1, 2)),
  from_date  date NOT NULL,
  to_date    date NOT NULL,
  pf_rule    text NOT NULL CHECK (pf_rule IN ('old', 'new')),
  lines      jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(lines) = 'array'),
  run_by     uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  run_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (to_date >= from_date),
  UNIQUE (tenant_id, year, month, part)
);

ALTER TABLE public.payroll_part_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payroll_part_runs FROM anon;

DROP POLICY IF EXISTS "payroll_part_runs: hr manages tenant" ON public.payroll_part_runs;
CREATE POLICY "payroll_part_runs: hr manages tenant" ON public.payroll_part_runs
  FOR ALL TO authenticated
  USING (tenant_id = (SELECT my_tenant_id()) AND (SELECT my_role()) IN ('admin', 'superadmin'))
  WITH CHECK (tenant_id = (SELECT my_tenant_id()) AND (SELECT my_role()) IN ('admin', 'superadmin'));

DROP POLICY IF EXISTS "hr support: no payroll" ON public.payroll_part_runs;
CREATE POLICY "hr support: no payroll" ON public.payroll_part_runs
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (NOT (SELECT my_is_hr_support()))
  WITH CHECK (NOT (SELECT my_is_hr_support()));

-- The final payslips were built from the parts: changing a part under them
-- would leave slips that no part adds up to.
CREATE OR REPLACE FUNCTION public.payroll_part_runs_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r public.payroll_part_runs;
BEGIN
  r := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  IF EXISTS (
    SELECT 1 FROM payrolls
    WHERE tenant_id = r.tenant_id AND year = r.year AND month = r.month
  ) THEN
    RAISE EXCEPTION 'The final payroll for this month is already processed — revert it before changing a part';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;

DROP TRIGGER IF EXISTS trg_payroll_part_runs_guard ON public.payroll_part_runs;
CREATE TRIGGER trg_payroll_part_runs_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_part_runs
  FOR EACH ROW EXECUTE FUNCTION public.payroll_part_runs_guard();

REVOKE ALL ON FUNCTION public.payroll_part_runs_guard() FROM PUBLIC, anon, authenticated;

-- ── 2. Release payslips to employees ────────────────────────────────────────
ALTER TABLE public.payrolls
  ADD COLUMN IF NOT EXISTS released_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS released_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

-- A Raniwala run is held from the moment it is processed, in the same
-- transaction as its payslips (process_payroll_by_country), so there is no
-- moment at which employees could see it.
CREATE OR REPLACE FUNCTION public.payrolls_hold_raniwala()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM tenants WHERE id = NEW.tenant_id AND company_name ILIKE '%Raniwala%') THEN
    NEW.released_at := NULL;
    NEW.released_by := NULL;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_payrolls_hold_raniwala ON public.payrolls;
CREATE TRIGGER trg_payrolls_hold_raniwala
  BEFORE INSERT ON public.payrolls
  FOR EACH ROW EXECUTE FUNCTION public.payrolls_hold_raniwala();

REVOKE ALL ON FUNCTION public.payrolls_hold_raniwala() FROM PUBLIC, anon, authenticated;

-- An employee (or manager) reads their own payslip only once its run is
-- released. HR keeps seeing every slip, held or not.
DROP POLICY IF EXISTS "payslips: own only once released" ON public.payslips;
CREATE POLICY "payslips: own only once released" ON public.payslips
  AS RESTRICTIVE FOR SELECT TO public
  USING (
    profile_id IS DISTINCT FROM (SELECT auth.uid())
    OR (SELECT my_role()) IN ('admin', 'superadmin')
    OR EXISTS (SELECT 1 FROM payrolls p WHERE p.id = payslips.payroll_id AND p.released_at IS NOT NULL)
  );
