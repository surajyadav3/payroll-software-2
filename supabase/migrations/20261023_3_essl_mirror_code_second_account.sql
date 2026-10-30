-- 20261023_3: one ESSL code feeding two accounts.
--
-- Raniwala HR wants a second account to show the same machine attendance as
-- the employee who really punches (ESSL code 242). essl_employee_code is
-- unique per tenant (profiles_essl_employee_code_tenant_uidx), so the second
-- account gets profiles.essl_mirror_code instead. When it is set, that profile
-- takes its device punches from the mirror code (its own essl_employee_code
-- is then ignored for machine data); the code's owner keeps getting them as
-- before. Every place that maps a feed row to a profile uses the same
-- effective code: COALESCE(essl_mirror_code, essl_employee_code).
--
-- Only HR (tenant admin), superadmin or the service role can set it, so an
-- employee can't point their own account at someone else's punches.

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS essl_mirror_code text;

COMMENT ON COLUMN public.profiles.essl_mirror_code IS
  'ESSL code whose machine punches this profile also gets (a second account of the same person). Overrides essl_employee_code for device attendance. HR only.';

CREATE INDEX IF NOT EXISTS profiles_essl_mirror_code_idx
  ON public.profiles (tenant_id, essl_mirror_code) WHERE essl_mirror_code IS NOT NULL;

-- ── Guard + history apply ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.trg_profiles_essl_mirror_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  NEW.essl_mirror_code := NULLIF(upper(trim(NEW.essl_mirror_code)), '');
  IF NEW.essl_mirror_code IS DISTINCT FROM (CASE WHEN TG_OP = 'UPDATE' THEN OLD.essl_mirror_code END)
     AND auth.uid() IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM profiles WHERE id = auth.uid()
         AND (role = 'superadmin' OR (tenant_id = NEW.tenant_id AND role = 'admin'))
     ) THEN
    RAISE EXCEPTION 'Only HR can change the mirrored ESSL code';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS profiles_essl_mirror_guard ON public.profiles;
CREATE TRIGGER profiles_essl_mirror_guard
  BEFORE INSERT OR UPDATE OF essl_mirror_code ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION trg_profiles_essl_mirror_guard();

-- Same as profiles_essl_code_sync: a new mirror code applies its history
-- right away (from the profile's join date, as for any code).
CREATE OR REPLACE FUNCTION public.trg_profiles_essl_mirror_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.essl_mirror_code IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.essl_mirror_code IS DISTINCT FROM OLD.essl_mirror_code) THEN
    PERFORM essl_apply_to_attendance(NEW.tenant_id, ARRAY[NEW.essl_mirror_code]);
  END IF;
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS profiles_essl_mirror_sync ON public.profiles;
CREATE TRIGGER profiles_essl_mirror_sync
  AFTER INSERT OR UPDATE OF essl_mirror_code ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION trg_profiles_essl_mirror_sync();

-- ── Live functions: map feed rows by the effective code ──────────────────
-- Patched in place from the live definitions (each replace must hit exactly
-- once, or the migration aborts).
DO $patch$
DECLARE
  v_def text;
  v_new text;
  p     record;
BEGIN
  FOR p IN
    SELECT * FROM (VALUES
      ('essl_apply_to_attendance(uuid,text[],date,date,boolean,boolean)',
       'JOIN profiles p ON p.tenant_id = d.tenant_id AND p.essl_employee_code = d.essl_employee_code',
       'JOIN profiles p ON p.tenant_id = d.tenant_id AND COALESCE(p.essl_mirror_code, p.essl_employee_code) = d.essl_employee_code'),
      ('essl_rescore_after_shift_end()',
       'SELECT array_agg(DISTINCT p.essl_employee_code) INTO v_codes',
       'SELECT array_agg(DISTINCT COALESCE(p.essl_mirror_code, p.essl_employee_code)) INTO v_codes'),
      ('essl_rescore_after_shift_end()',
       'AND p.essl_employee_code IS NOT NULL',
       'AND COALESCE(p.essl_mirror_code, p.essl_employee_code) IS NOT NULL'),
      ('early_late_release_hand_edit(uuid)',
       'p.essl_employee_code AS code',
       'COALESCE(p.essl_mirror_code, p.essl_employee_code) AS code'),
      ('essl_ingest_daily(uuid,jsonb,boolean)',
       'WHERE NOT EXISTS (SELECT 1 FROM profiles p WHERE p.tenant_id = p_tenant_id AND p.essl_employee_code = c)',
       'WHERE NOT EXISTS (SELECT 1 FROM profiles p WHERE p.tenant_id = p_tenant_id AND c IN (p.essl_employee_code, p.essl_mirror_code))')
    ) x(fn, old_s, new_s)
  LOOP
    v_def := pg_get_functiondef(('public.' || p.fn)::regprocedure);
    IF (length(v_def) - length(replace(v_def, p.old_s, ''))) / length(p.old_s) <> 1 THEN
      RAISE EXCEPTION '20261023_3: % - expected exactly one "%"', p.fn, p.old_s;
    END IF;
    v_new := replace(v_def, p.old_s, p.new_s);
    EXECUTE v_new;
  END LOOP;
END;
$patch$;
