-- 20261023_4: a mirror account is a full copy of the owner's attendance.
--
-- 20261023_3 fed a mirror account (profiles.essl_mirror_code) the owner's
-- machine punches only. The owner (Raniwala EMP 82) mostly punches from the
-- app and gets regularized days, so HR wants everything the owner has to show
-- on the mirror account too. Now the mirror account's day is a copy of the
-- owner's day: status, hours, location and every approved punch (device, app
-- or manual), refreshed whenever the owner's attendance row or punches change.
--
-- The owner is the profile whose essl_employee_code = the mirror's
-- essl_mirror_code (same tenant). Pending / rejected punches are not copied,
-- so the mirror never raises a second approval request; the owner's
-- 'Pending Approval' status is copied as-is and refreshed on review.
--
-- The ESSL feed no longer writes to mirror accounts directly (the 20261023_3
-- function patches are reverted): with two writers the shift-end re-score
-- could score the mirror by its own shift and drift from the owner.

COMMENT ON COLUMN public.profiles.essl_mirror_code IS
  'ESSL code of the account this profile copies: its attendance is a full copy of that owner''s days (status, hours, approved punches). HR only.';

-- ── Revert the 20261023_3 feed patches ───────────────────────────────────
DO $patch$
DECLARE
  v_def text;
  p     record;
BEGIN
  FOR p IN
    SELECT * FROM (VALUES
      ('essl_apply_to_attendance(uuid,text[],date,date,boolean,boolean)',
       'JOIN profiles p ON p.tenant_id = d.tenant_id AND COALESCE(p.essl_mirror_code, p.essl_employee_code) = d.essl_employee_code',
       'JOIN profiles p ON p.tenant_id = d.tenant_id AND p.essl_employee_code = d.essl_employee_code'),
      ('essl_rescore_after_shift_end()',
       'SELECT array_agg(DISTINCT COALESCE(p.essl_mirror_code, p.essl_employee_code)) INTO v_codes',
       'SELECT array_agg(DISTINCT p.essl_employee_code) INTO v_codes'),
      ('essl_rescore_after_shift_end()',
       'AND COALESCE(p.essl_mirror_code, p.essl_employee_code) IS NOT NULL',
       'AND p.essl_employee_code IS NOT NULL'),
      ('early_late_release_hand_edit(uuid)',
       'COALESCE(p.essl_mirror_code, p.essl_employee_code) AS code',
       'p.essl_employee_code AS code'),
      ('essl_ingest_daily(uuid,jsonb,boolean)',
       'WHERE NOT EXISTS (SELECT 1 FROM profiles p WHERE p.tenant_id = p_tenant_id AND c IN (p.essl_employee_code, p.essl_mirror_code))',
       'WHERE NOT EXISTS (SELECT 1 FROM profiles p WHERE p.tenant_id = p_tenant_id AND p.essl_employee_code = c)')
    ) x(fn, old_s, new_s)
  LOOP
    v_def := pg_get_functiondef(('public.' || p.fn)::regprocedure);
    IF (length(v_def) - length(replace(v_def, p.old_s, ''))) / length(p.old_s) <> 1 THEN
      RAISE EXCEPTION '20261023_4: % - expected exactly one "%"', p.fn, p.old_s;
    END IF;
    EXECUTE replace(v_def, p.old_s, p.new_s);
  END LOOP;
END;
$patch$;

-- ── Copy one owner day to every mirror account ───────────────────────────
CREATE OR REPLACE FUNCTION public.attendance_mirror_sync_day(p_owner uuid, p_date date)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_src   attendance%ROWTYPE;
  v_found boolean;
  m       RECORD;
  v_att   uuid;
  v_reg   text := COALESCE(current_setting('app.regularize_apply', true), 'off');
  v_quiet text := COALESCE(current_setting('app.early_late_quiet', true), 'off');
BEGIN
  IF COALESCE(current_setting('app.mirror_sync', true), '') = 'on' THEN
    RETURN;
  END IF;

  SELECT * INTO v_src FROM attendance WHERE profile_id = p_owner AND date = p_date;
  v_found := FOUND;

  -- Writes below are a copy, not a punch: skip geofence / recompute / app
  -- pending rules (regularize_apply), the grace notices (early_late_quiet)
  -- and these same triggers on the mirror's rows (mirror_sync).
  PERFORM set_config('app.mirror_sync', 'on', true);
  PERFORM set_config('app.regularize_apply', 'on', true);
  PERFORM set_config('app.early_late_quiet', 'on', true);

  FOR m IN
    SELECT mp.id, mp.tenant_id
      FROM profiles o
      JOIN profiles mp ON mp.tenant_id = o.tenant_id AND mp.essl_mirror_code = o.essl_employee_code
     WHERE o.id = p_owner AND o.essl_employee_code IS NOT NULL AND mp.id <> o.id
  LOOP
    IF NOT v_found THEN
      DELETE FROM attendance WHERE profile_id = m.id AND date = p_date;
      CONTINUE;
    END IF;

    INSERT INTO attendance (tenant_id, profile_id, date, status, total_hours, location, auto_marked)
    VALUES (m.tenant_id, m.id, p_date, v_src.status, v_src.total_hours, v_src.location, v_src.auto_marked)
    ON CONFLICT (profile_id, date) DO NOTHING;
    SELECT id INTO v_att FROM attendance WHERE profile_id = m.id AND date = p_date;

    DELETE FROM punches pu
     WHERE pu.attendance_id = v_att
       AND NOT EXISTS (
         SELECT 1 FROM punches s
          WHERE s.attendance_id = v_src.id AND s.approval_status = 'approved'
            AND (s.punch_time, s.punch_type, s.source) = (pu.punch_time, pu.punch_type, pu.source));

    -- created_at is kept from the owner's punch, so punches_guard's 10-second
    -- same-type cooldown never trips on a copy.
    INSERT INTO punches (attendance_id, punch_time, punch_type, source, approval_status, created_at, reviewed_by, reviewed_at)
    SELECT v_att, s.punch_time, s.punch_type, s.source, 'approved', s.created_at, s.reviewed_by, s.reviewed_at
      FROM punches s
     WHERE s.attendance_id = v_src.id AND s.approval_status = 'approved'
       AND NOT EXISTS (
         SELECT 1 FROM punches pu
          WHERE pu.attendance_id = v_att
            AND (pu.punch_time, pu.punch_type, pu.source) = (s.punch_time, s.punch_type, s.source));

    UPDATE attendance
       SET status = v_src.status, total_hours = v_src.total_hours, location = v_src.location,
           out_of_geofence = v_src.out_of_geofence, late_grace_used = v_src.late_grace_used,
           monthly_allowance_used = v_src.monthly_allowance_used,
           early_late_flag = v_src.early_late_flag, early_late_graced = v_src.early_late_graced
     WHERE id = v_att
       AND (status, total_hours, location, out_of_geofence, late_grace_used,
            monthly_allowance_used, early_late_flag, early_late_graced)
           IS DISTINCT FROM
           (v_src.status, v_src.total_hours, v_src.location, v_src.out_of_geofence, v_src.late_grace_used,
            v_src.monthly_allowance_used, v_src.early_late_flag, v_src.early_late_graced);
  END LOOP;

  PERFORM set_config('app.early_late_quiet', v_quiet, true);
  PERFORM set_config('app.regularize_apply', v_reg, true);
  PERFORM set_config('app.mirror_sync', 'off', true);
END;
$function$;

REVOKE ALL ON FUNCTION public.attendance_mirror_sync_day(uuid, date) FROM PUBLIC, anon, authenticated;

-- ── Triggers on the owner's rows ─────────────────────────────────────────
-- The first check is a tiny partial-index probe, so tenants with no mirror
-- accounts pay almost nothing.
CREATE OR REPLACE FUNCTION public.trg_attendance_mirror_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_profile uuid;
  v_date    date;
BEGIN
  IF COALESCE(current_setting('app.mirror_sync', true), '') = 'on'
     OR NOT EXISTS (SELECT 1 FROM profiles WHERE essl_mirror_code IS NOT NULL) THEN
    RETURN NULL;
  END IF;

  IF TG_TABLE_NAME = 'attendance' THEN
    v_profile := CASE WHEN TG_OP = 'DELETE' THEN OLD.profile_id ELSE NEW.profile_id END;
    v_date    := CASE WHEN TG_OP = 'DELETE' THEN OLD.date ELSE NEW.date END;
  ELSE
    SELECT a.profile_id, a.date INTO v_profile, v_date
      FROM attendance a
     WHERE a.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.attendance_id ELSE NEW.attendance_id END;
    IF v_profile IS NULL THEN
      RETURN NULL;   -- day itself is being deleted; its own trigger handles it
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM profiles o JOIN profiles mp
      ON mp.tenant_id = o.tenant_id AND mp.essl_mirror_code = o.essl_employee_code AND mp.id <> o.id
     WHERE o.id = v_profile
  ) THEN
    PERFORM attendance_mirror_sync_day(v_profile, v_date);
  END IF;
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS zzzzz_attendance_mirror_sync ON public.attendance;
CREATE TRIGGER zzzzz_attendance_mirror_sync
  AFTER INSERT OR UPDATE OR DELETE ON public.attendance
  FOR EACH ROW EXECUTE FUNCTION trg_attendance_mirror_sync();

DROP TRIGGER IF EXISTS zzzzz_punches_mirror_sync ON public.punches;
CREATE TRIGGER zzzzz_punches_mirror_sync
  AFTER INSERT OR UPDATE OR DELETE ON public.punches
  FOR EACH ROW EXECUTE FUNCTION trg_attendance_mirror_sync();

-- ── Setting a mirror code copies the owner's whole history ───────────────
CREATE OR REPLACE FUNCTION public.trg_profiles_essl_mirror_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_owner uuid;
  d       date;
BEGIN
  IF NEW.essl_mirror_code IS NULL
     OR (TG_OP = 'UPDATE' AND NEW.essl_mirror_code IS NOT DISTINCT FROM OLD.essl_mirror_code) THEN
    RETURN NULL;
  END IF;

  SELECT id INTO v_owner FROM profiles
   WHERE tenant_id = NEW.tenant_id AND essl_employee_code = NEW.essl_mirror_code AND id <> NEW.id;
  IF v_owner IS NULL THEN
    RETURN NULL;
  END IF;

  -- Owner's days, plus any day the mirror has that the owner doesn't (removed).
  FOR d IN
    SELECT date FROM attendance WHERE profile_id = v_owner
    UNION
    SELECT date FROM attendance WHERE profile_id = NEW.id
  LOOP
    PERFORM attendance_mirror_sync_day(v_owner, d);
  END LOOP;
  RETURN NULL;
END;
$function$;

-- ── One-off: copy history for mirrors set before this migration ──────────
DO $backfill$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT o.id AS owner, x.date
      FROM profiles mp
      JOIN profiles o ON o.tenant_id = mp.tenant_id AND o.essl_employee_code = mp.essl_mirror_code AND o.id <> mp.id
      CROSS JOIN LATERAL (
        SELECT date FROM attendance WHERE profile_id = o.id
        UNION
        SELECT date FROM attendance WHERE profile_id = mp.id
      ) x
     WHERE mp.essl_mirror_code IS NOT NULL
  LOOP
    PERFORM attendance_mirror_sync_day(r.owner, r.date);
  END LOOP;
END;
$backfill$;
