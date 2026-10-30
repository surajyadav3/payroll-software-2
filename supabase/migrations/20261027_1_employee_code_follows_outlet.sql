-- Employee code follows the outlet (IndWell Hotel), so nobody is left on IW.
--
-- 20261024_9 gave each outlet a code prefix (LMCS, RSMN, ...) but only at
-- INSERT. The Add Employee form sent no outlet, so every new joiner was
-- inserted with outlet_id NULL, got the company kiosk prefix (IW1348..IW1356),
-- and kept it when HR set the outlet later with Transfer.
--
--   * The code trigger now also runs when outlet_id changes. If the code is
--     blank or an auto-style code (the kiosk prefix or any outlet prefix of
--     the tenant + digits), it becomes the next code of the new outlet's
--     prefix. A code HR typed by hand (anything else) is kept, and so is a
--     code changed in the same save as the outlet.
--   * Moving between two outlets that share a prefix (Rustic CS / Rustic-Cs)
--     keeps the code.
--   * IndWell: active staff with no outlet whose Branch Name text is exactly
--     an outlet's name get that outlet (and so its code). Inactive staff still
--     on IW get their outlet's next codes, A-Z by name, after the active ones.

CREATE OR REPLACE FUNCTION public.trg_profiles_kiosk_employee_code()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_kiosk  text;
  v_outlet text;
  v_prefix text;
  v_code   text := upper(NULLIF(trim(NEW.employee_id), ''));
BEGIN
  IF NEW.tenant_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Only an outlet change re-codes, and never over a code edited in this save.
    IF NEW.outlet_id IS NOT DISTINCT FROM OLD.outlet_id
       OR NEW.employee_id IS DISTINCT FROM OLD.employee_id THEN
      RETURN NEW;
    END IF;
  ELSIF v_code IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT k.code_prefix, NULLIF(upper(trim(o.employee_code_prefix)), '')
    INTO v_kiosk, v_outlet
  FROM kiosk_settings k
  LEFT JOIN outlets o ON o.id = NEW.outlet_id AND o.tenant_id = k.tenant_id
  WHERE k.tenant_id = NEW.tenant_id AND k.enabled AND k.auto_assign_codes;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF v_outlet IS NULL THEN
      RETURN NEW;                               -- no outlet / outlet without a prefix: keep the code
    END IF;
    IF v_code IS NOT NULL THEN
      IF v_code ~ ('^' || v_outlet || '\d+$') THEN
        RETURN NEW;                             -- already in this outlet's series
      END IF;
      IF NOT (COALESCE(v_code ~ ('^' || upper(v_kiosk) || '\d+$'), false)
              OR EXISTS (SELECT 1 FROM outlets o2
                          WHERE o2.tenant_id = NEW.tenant_id
                            AND NULLIF(trim(o2.employee_code_prefix), '') IS NOT NULL
                            AND v_code ~ ('^' || upper(trim(o2.employee_code_prefix)) || '\d+$'))) THEN
        RETURN NEW;                             -- hand-typed code: keep it
      END IF;
    END IF;
  END IF;

  v_prefix := COALESCE(v_outlet, v_kiosk);
  IF v_prefix IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('kiosk_codes:' || upper(v_prefix)));
  NEW.employee_id := kiosk_next_employee_code(NEW.tenant_id, v_prefix);
  RETURN NEW;
END;
$function$;

SET LOCAL lock_timeout = '5s';
DROP TRIGGER IF EXISTS profiles_kiosk_employee_code ON public.profiles;
CREATE TRIGGER profiles_kiosk_employee_code
  BEFORE INSERT OR UPDATE OF outlet_id ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION trg_profiles_kiosk_employee_code();


-- ── IndWell Hotel ─────────────────────────────────────────────────────────
DO $$
DECLARE
  v_t uuid := '71a81994-32f4-428e-93ab-6f20f64a1858';
  r   record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = v_t) THEN
    RETURN;
  END IF;

  -- Branch Name typed as the outlet's exact name → that outlet (trigger re-codes).
  UPDATE profiles p SET outlet_id = o.id
    FROM outlets o
   WHERE p.tenant_id = v_t
     AND p.status = 'Active'
     AND p.outlet_id IS NULL
     AND o.tenant_id = v_t
     AND lower(trim(o.name)) = lower(trim(p.outlet_location));

  -- Inactive staff with an outlet still on an IW code.
  FOR r IN
    SELECT p.id, upper(trim(o.employee_code_prefix)) AS prefix
      FROM profiles p
      JOIN outlets o ON o.id = p.outlet_id
     WHERE p.tenant_id = v_t
       AND p.status <> 'Active'
       AND NULLIF(trim(o.employee_code_prefix), '') IS NOT NULL
       AND upper(p.employee_id) ~ '^IW\d+$'
     ORDER BY upper(trim(o.employee_code_prefix)), lower(trim(p.first_name)),
              lower(trim(COALESCE(p.middle_name, ''))), lower(trim(COALESCE(p.last_name, ''))),
              p.created_at, p.id
  LOOP
    UPDATE profiles SET employee_id = kiosk_next_employee_code(v_t, r.prefix) WHERE id = r.id;
  END LOOP;
END $$;
