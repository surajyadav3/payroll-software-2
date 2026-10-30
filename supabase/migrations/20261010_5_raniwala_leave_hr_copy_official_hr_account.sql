-- =============================================================
-- Raniwala: HR gets a copy of EVERY leave request (10 Oct 2026).
--
-- raniwala1881@gmail.com ("RANIWALA HR", role admin) becomes the company's
-- official HR portal account, operated by the current HR (POOJA KHANDELWAL,
-- 357). Pooja keeps her own admin login, where she also acts as manager /
-- HOD of her own team.
--
-- The official account already received every punch, regularize, travel
-- and verification request (those notify all active admins). Leave was the
-- gap: trg_notify_leave_stage only tells whoever's stage is up, so a leave
-- waiting on a manager / HOD never reached HR - although HR can decide a
-- pending leave at any stage since 20261003_3.
--
--   1. trg_notify_leave_stage: on a NEW request that starts at the manager
--      / HOD stage, every active admin who is not that stage's approver
--      gets a 'leave_request_hr_copy' notification. Its own type, so
--      trg_dedupe_leave_notification can't swallow the later "needs your
--      approval" one when the request reaches the HR stage. Everything
--      else in the function is the live definition, unchanged.
--   2. One-time copy for the leaves that are pending right now and never
--      reached HR.
--   3. The official account's profile says what it is.
--
-- Only rows with manager_status set (Raniwala multi-stage leaves) reach
-- this code; every other tenant passes through as before.
--
-- Mobile app: 'leave_request_hr_copy' is a new app_notifications.type
-- (link_key 'leave_requests', related_id = the leave). Render it like
-- 'leave_request_submitted'.
-- =============================================================

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
  v_waiting_on text;
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

    -- HR always gets a new request too, as the record (and can decide it
    -- themselves at any stage) - even while it waits on the manager / HOD.
    IF v_fresh AND v_new_stage <> 'hr' THEN
      SELECT trim(concat_ws(' ', first_name, last_name)) INTO v_waiting_on
        FROM profiles WHERE id = v_ids[1];
      INSERT INTO app_notifications (tenant_id, profile_id, actor_id, type, title, body, link_key, related_id)
      SELECT NEW.tenant_id, r, v_actor, 'leave_request_hr_copy', 'New leave request',
             v_name || ' — ' || v_desc || ' — sent to '
               || COALESCE(NULLIF(v_waiting_on, ''),
                    'their ' || CASE v_new_stage WHEN 'manager' THEN 'manager' WHEN 'hod' THEN 'HOD' ELSE 'approver' END)
               || ' for approval.',
             'leave_requests', NEW.id
      FROM unnest(leave_stage_recipients(NEW, 'hr')) r
      WHERE r <> NEW.profile_id AND NOT (r = ANY (array_remove(v_ids, NULL)));
    END IF;
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

-- One-time: the leaves waiting on a manager / HOD right now, for every
-- active admin who has not been told about them yet.
INSERT INTO app_notifications (tenant_id, profile_id, actor_id, type, title, body, link_key, related_id)
SELECT l.tenant_id, hr.id, l.profile_id, 'leave_request_hr_copy', 'Leave request pending',
       trim(concat_ws(' ', e.first_name, e.last_name))
         || CASE WHEN COALESCE(e.outlet_location, '') <> '' THEN ' (' || e.outlet_location || ')' ELSE '' END
         || ' — ' || COALESCE(l.leave_type, 'Leave') || ', ' || to_char(l.start_date, 'DD Mon') || ' – '
         || to_char(l.end_date, 'DD Mon') || ' (' || COALESCE(l.duration_days, l.end_date - l.start_date + 1) || ' day'
         || CASE WHEN COALESCE(l.duration_days, 2) = 1 THEN '' ELSE 's' END || ')'
         || ' — waiting on '
         || COALESCE(NULLIF(trim(concat_ws(' ', a.first_name, a.last_name)), ''), 'their approver')
         || ' for approval.',
       'leave_requests', l.id
FROM leave_requests l
JOIN tenants t ON t.id = l.tenant_id AND t.company_name ILIKE '%Raniwala%'
JOIN profiles e ON e.id = l.profile_id
CROSS JOIN LATERAL (
  SELECT leave_current_stage(l.manager_status, l.hod_status, l.hr_status, l.management_status) AS stage
) s
LEFT JOIN profiles a ON a.id = CASE s.stage WHEN 'manager' THEN l.manager_id WHEN 'hod' THEN l.hod_id END
JOIN profiles hr ON hr.tenant_id = l.tenant_id AND hr.role = 'admin' AND hr.status = 'Active'
WHERE l.status = 'Pending'
  AND l.manager_status IS NOT NULL
  AND s.stage IN ('manager', 'hod')
  AND hr.id <> l.profile_id
  AND hr.id IS DISTINCT FROM a.id
  AND NOT EXISTS (
    SELECT 1 FROM app_notifications n WHERE n.related_id = l.id AND n.profile_id = hr.id
  );

-- The official HR portal account.
UPDATE profiles p
SET department = 'HR', designation = 'OFFICIAL HR ACCOUNT'
FROM tenants t
WHERE t.id = p.tenant_id AND t.company_name ILIKE '%Raniwala%'
  AND lower(p.email) = 'raniwala1881@gmail.com'
  AND p.role = 'admin';
