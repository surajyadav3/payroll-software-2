-- =============================================================
-- Raniwala: HR can decide a pending leave at ANY stage (3 Oct 2026).
--
-- Some managers/HODs can't act on their pending leaves, and HR asked to
-- be able to approve (or reject) them directly. HR's decision is final:
--
--   * HR (admin/superadmin) writes hr_status = 'Approved' | 'Rejected' on
--     any leave still Pending, whatever its current_stage.
--   * Every other stage still 'Pending' (manager / HOD / management) is
--     set to 'Skipped', so the trail shows that HR stepped in and who
--     did. hr_decided_by / approved_by carry HR's id.
--   * The skipped manager / HOD each get a 'leave_request_fyi'
--     notification saying HR decided it on their behalf.
--
-- Stages already decided keep their decision. Normal flow is unchanged:
-- when it is HR's own turn the same path runs (a pending Management stage
-- is skipped too, since "HR approved = confirmed"; no active management
-- users exist at Raniwala as of today).
--
-- Only rows with manager_status set (Raniwala multi-stage leaves) are
-- affected; every other tenant passes through as before.
--
-- Mobile app: to let HR decide, write hr_status (+ hr_decided_by/at) on
-- any Pending row, not only current_stage = 'hr'. Render 'Skipped' as a
-- stage value (e.g. "Manager: Skipped — decided by HR").
-- =============================================================

CREATE OR REPLACE FUNCTION public.enforce_leave_dual_approval()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_role  text;
  v_uid   uuid := auth.uid();
  v_stage text;
  v_want_mgr  text := NEW.manager_status;
  v_want_hod  text := NEW.hod_status;
  v_want_hr   text := NEW.hr_status;
  v_want_mgmt text := NEW.management_status;
BEGIN
  IF OLD.manager_status IS NULL THEN
    RETURN NEW;
  END IF;

  v_stage := leave_current_stage(OLD.manager_status, OLD.hod_status, OLD.hr_status, OLD.management_status);

  IF v_uid IS NOT NULL THEN
    v_role := my_role();

    NEW.manager_status := OLD.manager_status; NEW.manager_decided_by := OLD.manager_decided_by; NEW.manager_decided_at := OLD.manager_decided_at;
    NEW.hod_status := OLD.hod_status;         NEW.hod_decided_by := OLD.hod_decided_by;         NEW.hod_decided_at := OLD.hod_decided_at;
    NEW.hr_status := OLD.hr_status;           NEW.hr_decided_by := OLD.hr_decided_by;           NEW.hr_decided_at := OLD.hr_decided_at;
    NEW.management_status := OLD.management_status; NEW.management_decided_by := OLD.management_decided_by; NEW.management_decided_at := OLD.management_decided_at;
    NEW.hod_id := OLD.hod_id; NEW.manager_id := OLD.manager_id;
    NEW.duration_days := OLD.duration_days; NEW.short_notice := OLD.short_notice;
    NEW.requires_hr_approval := OLD.requires_hr_approval;

    IF v_want_mgr IS DISTINCT FROM OLD.manager_status THEN
      IF OLD.manager_id IS DISTINCT FROM v_uid THEN
        RAISE EXCEPTION 'Not this leave request''s reporting manager';
      END IF;
      IF v_stage IS DISTINCT FROM 'manager' THEN
        RAISE EXCEPTION 'This request has already been reviewed by its manager';
      END IF;
      IF v_want_mgr NOT IN ('Approved', 'Rejected') THEN RAISE EXCEPTION 'Invalid decision'; END IF;
      NEW.manager_status := v_want_mgr; NEW.manager_decided_by := v_uid; NEW.manager_decided_at := now();

    ELSIF v_want_hod IS DISTINCT FROM OLD.hod_status THEN
      IF OLD.hod_id IS DISTINCT FROM v_uid THEN
        RAISE EXCEPTION 'Not this leave request''s HOD';
      END IF;
      IF v_stage IS DISTINCT FROM 'hod' THEN
        RAISE EXCEPTION 'It''s not the HOD''s turn to review this request';
      END IF;
      IF v_want_hod NOT IN ('Approved', 'Rejected') THEN RAISE EXCEPTION 'Invalid decision'; END IF;
      NEW.hod_status := v_want_hod; NEW.hod_decided_by := v_uid; NEW.hod_decided_at := now();

    ELSIF v_want_hr IS DISTINCT FROM OLD.hr_status THEN
      IF v_role NOT IN ('admin', 'superadmin') THEN
        RAISE EXCEPTION 'Only HR can decide the HR stage';
      END IF;
      -- HR may step in at any stage while the leave is still open.
      IF OLD.status IS DISTINCT FROM 'Pending' OR v_stage IS NULL THEN
        RAISE EXCEPTION 'This request has already been decided';
      END IF;
      IF v_want_hr NOT IN ('Approved', 'Rejected') THEN RAISE EXCEPTION 'Invalid decision'; END IF;
      NEW.hr_status := v_want_hr; NEW.hr_decided_by := v_uid; NEW.hr_decided_at := now();
      -- HR's decision is final: stages still waiting are skipped.
      IF NEW.manager_status = 'Pending' THEN NEW.manager_status := 'Skipped'; END IF;
      IF NEW.hod_status = 'Pending' THEN NEW.hod_status := 'Skipped'; END IF;
      IF NEW.management_status = 'Pending' THEN NEW.management_status := 'Skipped'; END IF;

    ELSIF v_want_mgmt IS DISTINCT FROM OLD.management_status THEN
      IF v_role <> 'management' THEN
        RAISE EXCEPTION 'Only Management can decide the Management stage';
      END IF;
      IF v_stage IS DISTINCT FROM 'management' THEN
        RAISE EXCEPTION 'Manager/HOD/HR approval is required before Management can act';
      END IF;
      IF v_want_mgmt NOT IN ('Approved', 'Rejected') THEN RAISE EXCEPTION 'Invalid decision'; END IF;
      NEW.management_status := v_want_mgmt; NEW.management_decided_by := v_uid; NEW.management_decided_at := now();
    END IF;
  END IF;

  IF NEW.manager_status = 'Rejected' THEN
    NEW.status := 'Rejected'; NEW.approved_by := NEW.manager_decided_by;
  ELSIF NEW.hod_status = 'Rejected' THEN
    NEW.status := 'Rejected'; NEW.approved_by := NEW.hod_decided_by;
  ELSIF NEW.hr_status = 'Rejected' THEN
    NEW.status := 'Rejected'; NEW.approved_by := NEW.hr_decided_by;
  ELSIF NEW.management_status = 'Rejected' THEN
    NEW.status := 'Rejected'; NEW.approved_by := NEW.management_decided_by;
  ELSIF leave_current_stage(NEW.manager_status, NEW.hod_status, NEW.hr_status, NEW.management_status) IS NULL THEN
    NEW.status := 'Approved';
    NEW.approved_by := COALESCE(NEW.management_decided_by, NEW.hr_decided_by, NEW.hod_decided_by, NEW.manager_decided_by);
  ELSE
    NEW.status := 'Pending';
  END IF;

  NEW.current_stage := CASE WHEN NEW.status = 'Pending'
    THEN leave_current_stage(NEW.manager_status, NEW.hod_status, NEW.hr_status, NEW.management_status) END;
  NEW.required_approver_role := CASE WHEN NEW.current_stage = 'hr' THEN 'admin'
    ELSE COALESCE(NEW.current_stage, NEW.required_approver_role) END;

  RETURN NEW;
END;
$function$;


-- Notifications: live body of trg_notify_leave_stage plus a FYI to the
-- manager / HOD whose stage HR skipped.
CREATE OR REPLACE FUNCTION public.trg_notify_leave_stage()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_name   text;
  v_desc   text;
  v_new_stage text := leave_current_stage(NEW.manager_status, NEW.hod_status, NEW.hr_status, NEW.management_status);
  v_old_stage text;
  v_ids    uuid[];
  v_actor  uuid := COALESCE(auth.uid(), NEW.profile_id);
  v_fresh  boolean := TG_OP = 'INSERT';
  v_hr_name text;
BEGIN
  IF NEW.manager_status IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT trim(concat_ws(' ', first_name, last_name))
         || CASE WHEN COALESCE(outlet_location, '') <> '' THEN ' (' || outlet_location || ')' ELSE '' END
    INTO v_name FROM profiles WHERE id = NEW.profile_id;

  v_desc := COALESCE(NEW.leave_type, 'Leave') || ', ' || to_char(NEW.start_date, 'DD Mon') || ' – '
            || to_char(NEW.end_date, 'DD Mon') || ' (' || COALESCE(NEW.duration_days, NEW.end_date - NEW.start_date + 1) || ' day'
            || CASE WHEN COALESCE(NEW.duration_days, 2) = 1 THEN '' ELSE 's' END || ')'
            || CASE WHEN NEW.short_notice THEN ' — applied less than 15 days in advance' ELSE '' END;

  IF TG_OP = 'UPDATE' THEN
    v_old_stage := leave_current_stage(OLD.manager_status, OLD.hod_status, OLD.hr_status, OLD.management_status);
    v_fresh := OLD.status = 'Pending' AND OLD.current_stage IS NULL;
  END IF;

  IF NEW.status = 'Pending' AND v_new_stage IS NOT NULL
     AND (v_fresh OR v_new_stage IS DISTINCT FROM v_old_stage) THEN
    v_ids := leave_stage_recipients(NEW, v_new_stage);
    INSERT INTO app_notifications (tenant_id, profile_id, actor_id, type, title, body, link_key, related_id)
    SELECT NEW.tenant_id, r, v_actor, 'leave_request_submitted',
           CASE WHEN v_fresh THEN 'New leave request' ELSE 'Leave request needs your approval' END,
           v_name || ' — ' || v_desc
             || CASE WHEN NOT v_fresh THEN '. Approved by '
                  || CASE v_old_stage WHEN 'manager' THEN 'Manager' WHEN 'hod' THEN 'HOD' WHEN 'hr' THEN 'HR' ELSE 'previous approver' END
                  || ', now needs yours.' ELSE '.' END,
           'leave_requests', NEW.id
    FROM unnest(v_ids) r WHERE r IS NOT NULL AND r <> NEW.profile_id;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.status IN ('Approved', 'Rejected') AND OLD.status = 'Pending' THEN
    IF NEW.hod_id IS NOT NULL AND COALESCE(NEW.hod_status, 'Not Required') = 'Not Required' THEN
      INSERT INTO app_notifications (tenant_id, profile_id, actor_id, type, title, body, link_key, related_id)
      VALUES (NEW.tenant_id, NEW.hod_id, v_actor, 'leave_request_fyi',
              'Team leave ' || lower(NEW.status), v_name || ' — ' || v_desc || '.', 'leave_requests', NEW.id);
    END IF;
    IF COALESCE(NEW.duration_days, 0) >= 4 AND NEW.hr_status = 'Not Required' THEN
      INSERT INTO app_notifications (tenant_id, profile_id, actor_id, type, title, body, link_key, related_id)
      SELECT NEW.tenant_id, r, v_actor, 'leave_request_fyi', 'Leave ' || lower(NEW.status),
             v_name || ' — ' || v_desc || '.', 'leave_requests', NEW.id
      FROM unnest(leave_stage_recipients(NEW, 'hr')) r;
    END IF;

    -- HR decided over a manager / HOD who hadn't acted yet: tell them who did.
    -- actor = the employee, so trg_team_only_request_notifications (which
    -- only lets team members' requests reach a Raniwala manager/HOD) keeps it.
    IF 'Skipped' IN (NEW.manager_status, NEW.hod_status) THEN
      SELECT trim(concat_ws(' ', first_name, last_name)) INTO v_hr_name FROM profiles WHERE id = NEW.hr_decided_by;
      INSERT INTO app_notifications (tenant_id, profile_id, actor_id, type, title, body, link_key, related_id)
      SELECT DISTINCT NEW.tenant_id, r, NEW.profile_id, 'leave_request_fyi',
             'Team leave ' || lower(NEW.status) || ' by HR',
             v_name || ' — ' || v_desc || '. ' || NEW.status || ' by HR'
               || COALESCE(' (' || NULLIF(v_hr_name, '') || ')', '') || ' on your behalf.',
             'leave_requests', NEW.id
      FROM unnest(ARRAY[
        CASE WHEN NEW.manager_status = 'Skipped' THEN NEW.manager_id END,
        CASE WHEN NEW.hod_status = 'Skipped' THEN NEW.hod_id END
      ]) r
      WHERE r IS NOT NULL AND r <> NEW.profile_id AND r IS DISTINCT FROM NEW.hr_decided_by;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;
