-- Employee codes by outlet (IndWell Hotel first), for the face kiosk.
--
-- The kiosk finds an employee by the code typed in (profiles.employee_id).
-- IndWell's codes were one company-wide run (IW1001..IW1355, kiosk
-- auto-assign, 20261016 face_kiosk). HR wants the restaurant in the code:
-- LMCS1001, LMCS1002, ... per outlet, numbered in name order.
--
--   * outlets.employee_code_prefix: the outlet's code letters. A new
--     employee of a kiosk tenant gets the next code of their outlet's
--     prefix, else the tenant's kiosk prefix as before.
--   * IndWell's active staff with an outlet are renumbered from 1001 per
--     prefix, A-Z by name. Two outlet rows can share a prefix (Rustic CS /
--     Rustic-Cs) and are numbered as one. Inactive staff and staff with no
--     outlet keep their IW code.

ALTER TABLE outlets ADD COLUMN IF NOT EXISTS employee_code_prefix text;

/** New employees of a kiosk tenant get a code automatically. */
CREATE OR REPLACE FUNCTION public.trg_profiles_kiosk_employee_code()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_prefix text;
BEGIN
  IF NULLIF(trim(NEW.employee_id), '') IS NOT NULL OR NEW.tenant_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT COALESCE(NULLIF(trim(o.employee_code_prefix), ''), k.code_prefix) INTO v_prefix
  FROM kiosk_settings k
  LEFT JOIN outlets o ON o.id = NEW.outlet_id AND o.tenant_id = k.tenant_id
  WHERE k.tenant_id = NEW.tenant_id AND k.enabled AND k.auto_assign_codes;
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
  v_t uuid := '71a81994-32f4-428e-93ab-6f20f64a1858';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = v_t) THEN
    RETURN;
  END IF;

  UPDATE outlets o SET employee_code_prefix = x.prefix
    FROM (VALUES
      ('93fbe476-a337-499d-a03b-f4279c483fed'::uuid, 'LMCS'),  -- LAMA CS
      ('29a44b28-4f3a-444a-a487-25fd5e23bd49'::uuid, 'LMMN'),  -- LAMA MN
      ('2e7040be-5137-4e44-929c-91ad7274738d'::uuid, 'LMSI'),  -- Lama Sirsi
      ('5aa36d3e-868a-44a4-bedc-c8350bfd2ea8'::uuid, 'LMSI'),  -- LAMA Sirsi Road
      ('c27e45ce-79e1-4b91-9106-ef2795076cdd'::uuid, 'LMVS'),  -- Lama Vs
      ('d558b4a6-8f5e-4a9e-abf5-2b7557108182'::uuid, 'OTH'),   -- OTH
      ('3cb9079d-dd41-4a66-a8a1-647a884277fc'::uuid, 'RSCS'),  -- Rustic CS
      ('3ba50652-4377-49e9-bac7-382f86cb891f'::uuid, 'RSCS'),  -- Rustic-Cs
      ('5be756ee-b391-4c00-aa12-099b165f4242'::uuid, 'RSMN'),  -- Rustic MN
      ('bbe487a9-5bc4-4d68-b342-09b8db42a358'::uuid, 'RSSI'),  -- Rustic Sirsi
      ('844f6b4f-7585-473f-b250-9b810a30b084'::uuid, 'RSSI'),  -- Rustic Sirsi Road
      ('8b0bf19a-cafa-4691-a327-56db25d3f876'::uuid, 'SUCS'),  -- Sutra CS
      ('d2b325f6-7575-4e53-a018-5ec8e0f9602c'::uuid, 'SUMN'),  -- Sutra MN
      ('0d4bce09-26c0-434b-a13b-f5200d102c7e'::uuid, 'SUVS')   -- Sutra VS
    ) AS x(id, prefix)
   WHERE o.id = x.id AND o.tenant_id = v_t;

  UPDATE profiles p SET employee_id = n.code
    FROM (
      SELECT p2.id,
             o.employee_code_prefix || (1000 + row_number() OVER (
               PARTITION BY o.employee_code_prefix
               ORDER BY lower(trim(p2.first_name)), lower(trim(COALESCE(p2.middle_name, ''))),
                        lower(trim(COALESCE(p2.last_name, ''))), p2.created_at, p2.id))::text AS code
        FROM profiles p2
        JOIN outlets o ON o.id = p2.outlet_id
       WHERE p2.tenant_id = v_t
         AND p2.status = 'Active'
         AND o.employee_code_prefix IS NOT NULL
    ) n
   WHERE p.id = n.id;
END $$;
