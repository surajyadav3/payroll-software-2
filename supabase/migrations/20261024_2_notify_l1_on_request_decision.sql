-- 20261024_2: tell the L1 how the requests they filed were decided.
--
-- An L1 (20261024_1) files leave / regularize for employees who don't use the
-- app, so the employee's own "Leave Approved" notice often reaches nobody.
-- When a request with submitted_by (the L1) is finally Approved or Rejected —
-- by the manager, HOD or HR, from the app or the website — the L1 gets an app
-- notification (and push, via zz_push_app_notification) naming the employee.
-- A multi-stage leave notifies once, when its overall status is decided.
--
-- type 'l1_request_decided', link_key 'l1_requests' (outside the request
-- link_keys that trg_team_only_request_notifications filters), related_id =
-- the EMPLOYEE's profile id, so the app can open that person's L1 screen.

CREATE OR REPLACE FUNCTION public.trg_notify_l1_request_decided()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_name    text;
  v_what    text;
  v_decider uuid;
  v_by      text;
BEGIN
  IF NEW.submitted_by IS NULL OR NEW.submitted_by = NEW.profile_id
     OR NEW.status IS NOT DISTINCT FROM OLD.status OR NEW.status NOT IN ('Approved', 'Rejected') THEN
    RETURN NULL;
  END IF;

  SELECT concat_ws(' ', first_name, last_name) || COALESCE(' (' || employee_id || ')', '')
    INTO v_name FROM profiles WHERE id = NEW.profile_id;

  IF TG_TABLE_NAME = 'leave_requests' THEN
    v_what := NEW.leave_type || ', ' || CASE
      WHEN NEW.half_day IS NOT NULL
        THEN to_char(NEW.start_date, 'DD Mon') || ' (' || leave_half_day_label(NEW.half_day, NEW.half_day_from, NEW.half_day_to) || ')'
      WHEN NEW.start_date = NEW.end_date THEN to_char(NEW.start_date, 'DD Mon')
      ELSE to_char(NEW.start_date, 'DD Mon') || ' – ' || to_char(NEW.end_date, 'DD Mon') END;
    v_decider := NEW.approved_by;
  ELSE
    v_what := 'Regularize, ' || to_char(NEW.date, 'DD Mon')
      || COALESCE(' (' || to_char(NEW.clock_in_time, 'HH24:MI') || ' – ' || to_char(NEW.clock_out_time, 'HH24:MI') || ')', '');
    v_decider := NEW.reviewed_by;
  END IF;

  SELECT concat_ws(' ', first_name, last_name) INTO v_by FROM profiles WHERE id = v_decider;

  INSERT INTO app_notifications (tenant_id, profile_id, actor_id, type, title, body, link_key, related_id)
  VALUES (NEW.tenant_id, NEW.submitted_by, v_decider, 'l1_request_decided',
          NEW.status || ': ' || COALESCE(v_name, 'your employee'),
          v_what || ' — ' || lower(NEW.status) || COALESCE(' by ' || NULLIF(v_by, ''), '') || '.',
          'l1_requests', NEW.profile_id);
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS zz_notify_l1_request_decided ON public.leave_requests;
CREATE TRIGGER zz_notify_l1_request_decided
  AFTER UPDATE OF status ON public.leave_requests
  FOR EACH ROW
  WHEN (NEW.submitted_by IS NOT NULL AND NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('Approved', 'Rejected'))
  EXECUTE FUNCTION trg_notify_l1_request_decided();

DROP TRIGGER IF EXISTS zz_notify_l1_request_decided ON public.regularize_requests;
CREATE TRIGGER zz_notify_l1_request_decided
  AFTER UPDATE OF status ON public.regularize_requests
  FOR EACH ROW
  WHEN (NEW.submitted_by IS NOT NULL AND NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('Approved', 'Rejected'))
  EXECUTE FUNCTION trg_notify_l1_request_decided();
