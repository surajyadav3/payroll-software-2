-- Raniwala: a manager / HOD now gets the notice about their OWN request.
--
-- trg_team_only_request_notifications drops a request notification sent to a
-- Raniwala manager/HOD when the actor isn't in their team. That rule is for
-- other people's requests, but it also swallowed the decision on the
-- manager's own leave (HR -> manager: "your leave was approved"), since HR is
-- not in the manager's team. 3 of 3 HR-approved manager leaves in Oct 2026
-- got no in-app notice (e.g. KANHAIYA KUMAWAT, EMP 15).
--
-- Fix: when related_id is a request filed by the recipient, always keep it.
-- Everything else is the live body unchanged.

CREATE OR REPLACE FUNCTION public.trg_team_only_request_notifications()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_role text;
  v_requester uuid;
BEGIN
  IF NEW.actor_id IS NULL OR NEW.actor_id = NEW.profile_id
     OR NEW.link_key IS NULL
     OR NEW.link_key NOT IN ('leave_requests', 'regularize_attendance', 'wfh_requests', 'special_requests',
                             'expense_claims', 'travel_requests', 'verification_requests') THEN
    RETURN NEW;
  END IF;

  SELECT p.role INTO v_role
  FROM profiles p JOIN tenants t ON t.id = p.tenant_id
  WHERE p.id = NEW.profile_id AND t.company_name ILIKE '%Raniwala%';

  IF v_role IN ('manager', 'hod') THEN
    -- (0) Their own request (e.g. HR approving their leave) always reaches them.
    v_requester := CASE NEW.link_key
         WHEN 'leave_requests'        THEN (SELECT r.profile_id FROM leave_requests r      WHERE r.id = NEW.related_id)
         WHEN 'regularize_attendance' THEN (SELECT r.profile_id FROM regularize_requests r WHERE r.id = NEW.related_id)
         WHEN 'wfh_requests'          THEN (SELECT r.profile_id FROM wfh_requests r        WHERE r.id = NEW.related_id)
         WHEN 'special_requests'      THEN (SELECT r.profile_id FROM special_requests r    WHERE r.id = NEW.related_id)
         WHEN 'expense_claims'        THEN (SELECT r.profile_id FROM expense_claims r      WHERE r.id = NEW.related_id)
         WHEN 'travel_requests'       THEN (SELECT r.profile_id FROM travel_requests r     WHERE r.id = NEW.related_id)
    END;
    IF v_requester = NEW.profile_id THEN
      RETURN NEW;
    END IF;
    IF NEW.link_key = 'verification_requests' THEN
      RETURN NULL;
    END IF;
    -- (2) Regularize: only the requester's own approver (manager, else HOD).
    IF NEW.link_key = 'regularize_attendance' THEN
      IF NEW.profile_id IS DISTINCT FROM
         (SELECT COALESCE(a.manager_id, a.hod_id) FROM profiles a WHERE a.id = NEW.actor_id) THEN
        RETURN NULL;
      END IF;
      RETURN NEW;
    END IF;
    IF NOT is_in_team_of(NEW.actor_id, NEW.profile_id) THEN
      RETURN NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
