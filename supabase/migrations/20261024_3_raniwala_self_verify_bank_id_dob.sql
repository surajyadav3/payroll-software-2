-- =============================================================
-- Raniwala: the employee verifies their own Bank / PAN / Aadhaar / DOB
-- (24 Oct 2026). Replaces the unapplied 20261023_4_dob_sync_raniwala_no_id_verification.sql.
--
-- "Employee can approve their own verification details — I fill bank
-- details, account no, IFSC, DOB, Aadhaar, PAN, press Verify in front of it
-- and it is marked verified; HR just gets to see what the employee filled,
-- for record (especially account no, IFSC and DOB)."
--
-- 1. DOB is one value everywhere (all tenants): profiles.date_of_birth (HR
--    record) and profile_details.date_of_birth (My Profile) copy each other.
-- 2. DOB joins Bank / PAN / Aadhaar as a verifiable group: field_group
--    'dob', profiles.dob_verified_at.
-- 3. Raniwala: pressing Verify (= a profile_verification_requests insert,
--    from the app or the web) applies the values to profiles at once,
--    stamps *_verified_at and stores the row as Approved with reviewed_by =
--    the employee. That table is HR's record of what the employee filled
--    (Verification Requests page). HR is not asked to review. Older app
--    builds ("Submit for Verification") take the same path.
-- 4. A value changed any other way (HR edit, import, My Profile DOB edit)
--    is Not Verified until the employee presses Verify again — the
--    20260923_5 rule, now covering DOB too.
-- Other tenants keep HR / manager approval.
-- =============================================================

-- ---- 1a. profile_details -> profiles -----------------------------------
-- BEFORE: an empty DOB in a My Profile save keeps the HR record's DOB.
CREATE OR REPLACE FUNCTION trg_profile_details_dob_keep()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.date_of_birth IS NULL THEN
    NEW.date_of_birth := (SELECT p.date_of_birth FROM profiles p WHERE p.id = NEW.profile_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profile_details_dob_keep ON profile_details;
CREATE TRIGGER profile_details_dob_keep
  BEFORE INSERT OR UPDATE OF date_of_birth ON profile_details
  FOR EACH ROW EXECUTE FUNCTION trg_profile_details_dob_keep();

-- AFTER: the employee's DOB becomes the HR record's DOB. SECURITY DEFINER
-- because an employee can't update their own profiles row.
CREATE OR REPLACE FUNCTION trg_profile_details_dob_to_profile()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE profiles SET date_of_birth = NEW.date_of_birth
   WHERE id = NEW.profile_id AND date_of_birth IS DISTINCT FROM NEW.date_of_birth;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS profile_details_dob_to_profile ON profile_details;
CREATE TRIGGER profile_details_dob_to_profile
  AFTER INSERT OR UPDATE OF date_of_birth ON profile_details
  FOR EACH ROW WHEN (NEW.date_of_birth IS NOT NULL)
  EXECUTE FUNCTION trg_profile_details_dob_to_profile();

-- ---- 1b. profiles -> profile_details -----------------------------------
-- Creates the My Profile row when the employee has none yet. The nested
-- profile_details write finds the same DOB on the way back, so it stops.
CREATE OR REPLACE FUNCTION trg_profiles_dob_to_details()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.date_of_birth IS NULL THEN
    UPDATE profile_details SET date_of_birth = NULL
     WHERE profile_id = NEW.id AND date_of_birth IS NOT NULL;
  ELSE
    INSERT INTO profile_details (profile_id, tenant_id, date_of_birth)
    VALUES (NEW.id, NEW.tenant_id, NEW.date_of_birth)
    ON CONFLICT (profile_id) DO UPDATE SET date_of_birth = EXCLUDED.date_of_birth, updated_at = now()
      WHERE profile_details.date_of_birth IS DISTINCT FROM EXCLUDED.date_of_birth;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS profiles_dob_to_details_insert ON profiles;
CREATE TRIGGER profiles_dob_to_details_insert
  AFTER INSERT ON profiles
  FOR EACH ROW WHEN (NEW.date_of_birth IS NOT NULL)
  EXECUTE FUNCTION trg_profiles_dob_to_details();

DROP TRIGGER IF EXISTS profiles_dob_to_details_update ON profiles;
CREATE TRIGGER profiles_dob_to_details_update
  AFTER UPDATE OF date_of_birth ON profiles
  FOR EACH ROW WHEN (OLD.date_of_birth IS DISTINCT FROM NEW.date_of_birth)
  EXECUTE FUNCTION trg_profiles_dob_to_details();

-- ---- 1c. Backfill ------------------------------------------------------
-- Two different DOBs: the employee's own entry wins.
UPDATE profiles p SET date_of_birth = d.date_of_birth
  FROM profile_details d
 WHERE d.profile_id = p.id AND d.date_of_birth IS NOT NULL
   AND p.date_of_birth IS DISTINCT FROM d.date_of_birth;

-- HR-only DOBs reach My Profile (creates the row where missing).
INSERT INTO profile_details (profile_id, tenant_id, date_of_birth)
SELECT p.id, p.tenant_id, p.date_of_birth
  FROM profiles p
 WHERE p.date_of_birth IS NOT NULL
ON CONFLICT (profile_id) DO UPDATE SET date_of_birth = EXCLUDED.date_of_birth, updated_at = now()
  WHERE profile_details.date_of_birth IS DISTINCT FROM EXCLUDED.date_of_birth;

-- ---- 2. DOB as a verifiable group --------------------------------------
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS dob_verified_at timestamptz;

ALTER TABLE profile_verification_requests DROP CONSTRAINT IF EXISTS profile_verification_requests_field_group_check;
ALTER TABLE profile_verification_requests ADD CONSTRAINT profile_verification_requests_field_group_check
  CHECK (field_group IN ('bank', 'pan', 'aadhar', 'dob'));

-- ---- 3a. Raniwala: Verify applies at once -------------------------------
CREATE OR REPLACE FUNCTION trg_pvr_raniwala_apply_now()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_new jsonb := NEW.new_value;
  v_now timestamptz := now();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = NEW.tenant_id AND t.company_name ILIKE '%Raniwala%') THEN
    RETURN NEW;
  END IF;

  IF NEW.field_group = 'bank' THEN
    UPDATE profiles SET
      bank_acc  = COALESCE(v_new->>'bank_acc', bank_acc),
      bank_name = COALESCE(v_new->>'bank_name', bank_name),
      ifsc_code = COALESCE(v_new->>'ifsc_code', ifsc_code),
      bank_verified_at = v_now
    WHERE id = NEW.profile_id;
  ELSIF NEW.field_group = 'pan' THEN
    UPDATE profiles SET pan = COALESCE(v_new->>'pan', pan), pan_verified_at = v_now
    WHERE id = NEW.profile_id;
  ELSIF NEW.field_group = 'aadhar' THEN
    UPDATE profiles SET aadhar = COALESCE(v_new->>'aadhar', aadhar), aadhar_verified_at = v_now
    WHERE id = NEW.profile_id;
  ELSIF NEW.field_group = 'dob' THEN
    UPDATE profiles SET date_of_birth = COALESCE((v_new->>'date_of_birth')::date, date_of_birth), dob_verified_at = v_now
    WHERE id = NEW.profile_id;
  END IF;

  NEW.status := 'Approved';
  NEW.reviewed_by := NEW.profile_id;
  NEW.reviewed_at := v_now;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pvr_raniwala_apply_now ON profile_verification_requests;
CREATE TRIGGER pvr_raniwala_apply_now
  BEFORE INSERT ON profile_verification_requests
  FOR EACH ROW EXECUTE FUNCTION trg_pvr_raniwala_apply_now();

-- RLS WITH CHECK runs after BEFORE triggers, so the insert policy must let a
-- Raniwala employee's row land as Approved. Other tenants: Pending only.
DROP POLICY IF EXISTS "pvr: employee can insert own pending" ON profile_verification_requests;
CREATE POLICY "pvr: employee can insert own pending"
  ON profile_verification_requests FOR INSERT
  WITH CHECK (
    tenant_id = my_tenant_id() AND profile_id = auth.uid()
    AND (status = 'Pending' OR (status = 'Approved' AND (select my_is_raniwala())))
  );

-- ---- 3b. Raniwala requests still Pending: the employee asked, so apply --
DO $$
DECLARE
  r profile_verification_requests;
BEGIN
  FOR r IN
    SELECT q.* FROM profile_verification_requests q JOIN tenants t ON t.id = q.tenant_id
     WHERE q.status = 'Pending' AND t.company_name ILIKE '%Raniwala%'
     ORDER BY q.created_at
  LOOP
    IF r.field_group = 'bank' THEN
      UPDATE profiles SET
        bank_acc  = COALESCE(r.new_value->>'bank_acc', bank_acc),
        bank_name = COALESCE(r.new_value->>'bank_name', bank_name),
        ifsc_code = COALESCE(r.new_value->>'ifsc_code', ifsc_code),
        bank_verified_at = now()
      WHERE id = r.profile_id;
    ELSIF r.field_group = 'pan' THEN
      UPDATE profiles SET pan = COALESCE(r.new_value->>'pan', pan), pan_verified_at = now() WHERE id = r.profile_id;
    ELSIF r.field_group = 'aadhar' THEN
      UPDATE profiles SET aadhar = COALESCE(r.new_value->>'aadhar', aadhar), aadhar_verified_at = now() WHERE id = r.profile_id;
    END IF;
    UPDATE profile_verification_requests
       SET status = 'Approved', reviewed_by = r.profile_id, reviewed_at = now()
     WHERE id = r.id;
  END LOOP;
END;
$$;

-- ---- 3c. Raniwala: no "needs your review" notice -----------------------
-- Older app builds still send it to HR after saving.
CREATE OR REPLACE FUNCTION trg_raniwala_no_verification_review_notice()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.type = 'verification_request_submitted'
     AND EXISTS (SELECT 1 FROM tenants t WHERE t.id = NEW.tenant_id AND t.company_name ILIKE '%Raniwala%') THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_raniwala_no_verification_review_notice ON app_notifications;
CREATE TRIGGER trg_raniwala_no_verification_review_notice
  BEFORE INSERT ON app_notifications
  FOR EACH ROW EXECUTE FUNCTION trg_raniwala_no_verification_review_notice();

-- ---- 4. Unverify on any non-Verify change (now incl. DOB) ---------------
CREATE OR REPLACE FUNCTION profiles_clear_stale_verification()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF (NEW.bank_acc, NEW.bank_name, NEW.ifsc_code) IS DISTINCT FROM (OLD.bank_acc, OLD.bank_name, OLD.ifsc_code)
     AND NEW.bank_verified_at IS NOT DISTINCT FROM OLD.bank_verified_at THEN
    NEW.bank_verified_at := NULL;
  END IF;
  IF NEW.pan IS DISTINCT FROM OLD.pan AND NEW.pan_verified_at IS NOT DISTINCT FROM OLD.pan_verified_at THEN
    NEW.pan_verified_at := NULL;
  END IF;
  IF NEW.aadhar IS DISTINCT FROM OLD.aadhar AND NEW.aadhar_verified_at IS NOT DISTINCT FROM OLD.aadhar_verified_at THEN
    NEW.aadhar_verified_at := NULL;
  END IF;
  IF NEW.date_of_birth IS DISTINCT FROM OLD.date_of_birth AND NEW.dob_verified_at IS NOT DISTINCT FROM OLD.dob_verified_at THEN
    NEW.dob_verified_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_profiles_clear_stale_verification ON profiles;
CREATE TRIGGER trg_profiles_clear_stale_verification
  BEFORE UPDATE OF bank_acc, bank_name, ifsc_code, pan, aadhar, date_of_birth ON profiles
  FOR EACH ROW EXECUTE FUNCTION profiles_clear_stale_verification();

-- ---- 5. HR / manager review (other tenants) also handles DOB -----------
CREATE OR REPLACE FUNCTION review_verification_request(p_request_id uuid, p_approve boolean)
RETURNS profile_verification_requests
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_req  profile_verification_requests;
  v_role text := my_role();
  v_now  timestamptz := now();
  v_new  jsonb;
BEGIN
  SELECT * INTO v_req FROM profile_verification_requests WHERE id = p_request_id FOR UPDATE;
  IF v_req.id IS NULL THEN
    RAISE EXCEPTION 'Verification request not found';
  END IF;
  IF v_req.tenant_id IS DISTINCT FROM my_tenant_id() AND v_role <> 'superadmin' THEN
    RAISE EXCEPTION 'Not allowed to review this request';
  END IF;
  IF NOT (v_role IN ('admin', 'superadmin') OR is_reporting_manager_of(v_req.profile_id)) THEN
    RAISE EXCEPTION 'Only HR or this employee''s reporting manager can review this request';
  END IF;
  IF v_req.profile_id = auth.uid() THEN
    RAISE EXCEPTION 'You cannot review your own verification request';
  END IF;
  IF v_req.status <> 'Pending' THEN
    RAISE EXCEPTION 'This request has already been reviewed.';
  END IF;

  UPDATE profile_verification_requests
     SET status = CASE WHEN p_approve THEN 'Approved' ELSE 'Rejected' END,
         reviewed_by = auth.uid(),
         reviewed_at = v_now
   WHERE id = p_request_id
   RETURNING * INTO v_req;

  IF p_approve THEN
    v_new := v_req.new_value;
    IF v_req.field_group = 'bank' THEN
      UPDATE profiles SET
        bank_acc  = COALESCE(v_new->>'bank_acc', bank_acc),
        bank_name = COALESCE(v_new->>'bank_name', bank_name),
        ifsc_code = COALESCE(v_new->>'ifsc_code', ifsc_code),
        bank_verified_at = v_now
      WHERE id = v_req.profile_id;
    ELSIF v_req.field_group = 'pan' THEN
      UPDATE profiles SET pan = COALESCE(v_new->>'pan', pan), pan_verified_at = v_now
      WHERE id = v_req.profile_id;
    ELSIF v_req.field_group = 'aadhar' THEN
      UPDATE profiles SET aadhar = COALESCE(v_new->>'aadhar', aadhar), aadhar_verified_at = v_now
      WHERE id = v_req.profile_id;
    ELSIF v_req.field_group = 'dob' THEN
      UPDATE profiles SET date_of_birth = COALESCE((v_new->>'date_of_birth')::date, date_of_birth), dob_verified_at = v_now
      WHERE id = v_req.profile_id;
    END IF;
  END IF;

  RETURN v_req;
END;
$$;

REVOKE ALL ON FUNCTION review_verification_request(uuid, boolean) FROM public;
GRANT EXECUTE ON FUNCTION review_verification_request(uuid, boolean) TO authenticated;
