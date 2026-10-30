-- IndWell Hotel: employee codes come only from the outlet, never IW.
--
-- Code = outlet letters + number: brand 2 letters + location 2 letters
-- (LAMA CS → LMCS1001, Sutra MN → SUMN1001).
--
--   * A tenant whose outlets have code letters no longer falls back to the
--     company kiosk prefix (IW). An employee with no outlet gets no code until
--     HR sets the outlet; the outlet change then gives them the next code
--     (20261027_1).
--   * A new outlet of a kiosk tenant gets its letters automatically when it has
--     none: the brand's 2 letters from an existing outlet of the same brand
--     (Lama → LM, Rustic → RS, Sutra → SU), else the brand's first 2 letters,
--     plus the first 2 letters of the location word. One-word names use up to
--     4 letters of the name (OTH).
--   * IndWell: the 5 joiners with no outlet who punch at the Sutra MN geofence
--     (5-8 m from it; the next outlet is 532 m away) move to Sutra MN.

CREATE OR REPLACE FUNCTION public.outlet_code_prefix_for(p_tenant uuid, p_name text, p_outlet uuid DEFAULT NULL)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_words text[] := regexp_split_to_array(trim(COALESCE(p_name, '')), '[\s\-_]+');
  v_brand text := upper(regexp_replace(COALESCE(v_words[1], ''), '[^A-Za-z]', '', 'g'));
  v_loc   text := upper(regexp_replace(COALESCE(v_words[2], ''), '[^A-Za-z]', '', 'g'));
  v_b2    text;
BEGIN
  IF v_brand = '' THEN
    RETURN NULL;
  END IF;
  IF v_loc = '' THEN
    RETURN left(v_brand, 4);
  END IF;
  SELECT left(upper(trim(o.employee_code_prefix)), 2) INTO v_b2
    FROM outlets o
   WHERE o.tenant_id = p_tenant
     AND o.id IS DISTINCT FROM p_outlet
     AND length(trim(o.employee_code_prefix)) = 4
     AND upper(regexp_replace((regexp_split_to_array(trim(o.name), '[\s\-_]+'))[1], '[^A-Za-z]', '', 'g')) = v_brand
   ORDER BY o.created_at
   LIMIT 1;
  RETURN COALESCE(v_b2, left(v_brand, 2)) || left(v_loc, 2);
END;
$function$;

/** New outlets of a kiosk tenant get their code letters automatically. */
CREATE OR REPLACE FUNCTION public.trg_outlets_employee_code_prefix()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NULLIF(trim(NEW.employee_code_prefix), '') IS NULL
     AND EXISTS (SELECT 1 FROM kiosk_settings k
                  WHERE k.tenant_id = NEW.tenant_id AND k.enabled AND k.auto_assign_codes) THEN
    NEW.employee_code_prefix := outlet_code_prefix_for(NEW.tenant_id, NEW.name, NEW.id);
  END IF;
  RETURN NEW;
END;
$function$;

SET LOCAL lock_timeout = '5s';
DROP TRIGGER IF EXISTS outlets_employee_code_prefix ON public.outlets;
CREATE TRIGGER outlets_employee_code_prefix
  BEFORE INSERT OR UPDATE OF name, employee_code_prefix ON public.outlets
  FOR EACH ROW EXECUTE FUNCTION trg_outlets_employee_code_prefix();


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
      RETURN NEW;                               -- no outlet / outlet without letters: keep the code
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

  -- Outlet-coded tenant: no outlet yet = no code yet (never the company prefix).
  IF v_outlet IS NULL AND EXISTS (SELECT 1 FROM outlets o3
                                   WHERE o3.tenant_id = NEW.tenant_id
                                     AND NULLIF(trim(o3.employee_code_prefix), '') IS NOT NULL) THEN
    RETURN NEW;
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


-- ── IndWell Hotel ─────────────────────────────────────────────────────────
DO $$
DECLARE
  v_t    uuid := '71a81994-32f4-428e-93ab-6f20f64a1858';
  v_sumn uuid := 'd2b325f6-7575-4e53-a018-5ec8e0f9602c';   -- Sutra MN
BEGIN
  IF NOT EXISTS (SELECT 1 FROM outlets WHERE id = v_sumn AND tenant_id = v_t) THEN
    RETURN;
  END IF;

  -- Ankit Nath, Hemant Kumar, Deepak Kumar, Badal, Akash Bairwa (trigger re-codes).
  UPDATE profiles SET outlet_id = v_sumn, outlet_location = 'Sutra MN'
   WHERE tenant_id = v_t
     AND outlet_id IS NULL
     AND employee_id IN ('IW1349', 'IW1350', 'IW1352', 'IW1353', 'IW1355');
END $$;
