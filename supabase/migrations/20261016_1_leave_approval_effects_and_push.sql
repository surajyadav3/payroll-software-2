-- 20261016_1 — leave deductions on approval whoever approves, and real push
-- notifications for every app notification.
--
-- 1. Leave approval effects in the DB (user, 2026-10-16: "whoever approves —
--    assigned manager, HOD or HR — the leave deduction should be done on
--    approval no matter what").
--    Until now the web / app called record_leave_deduction and
--    adjust_comp_off_balance AFTER an approval, and both refuse any caller
--    whose role isn't admin / manager / superadmin. So when an HOD or
--    Management user gave the final approval, the leave stayed Approved but
--    no Earned Leave ledger line, no Comp Off deduction and no attendance
--    'Leave' marks were written (1 live case: an Earned Leave approved by an
--    HOD on 2026-10-12). Now AFTER triggers on leave_requests apply all three
--    the moment status becomes Approved, from any path (stage approval, HR
--    override, single-stage, self-approved insert, SQL).
--    leave_approval_effects records that it ran (once per request) and how
--    many Comp Off days it took, so the clients' own follow-up
--    adjust_comp_off_balance(-days) call — still in the web and app 2.2.4 —
--    becomes a no-op instead of deducting twice.
--
-- 2. Push: push-app-notification (Expo push for an app_notifications row)
--    was deployed but never connected — no webhook / trigger called it, so
--    no request notification ever reached a phone. An AFTER INSERT trigger
--    now calls it through pg_net, only for recipients with a registered
--    device (push_tokens), so it costs nothing for everyone else. Skipped:
--    clock_in / clock_out (send-notification already pushes those) and
--    birthday / anniversary rows (the app never shows them).
--    The Functions gateway wants a JWT; the public anon key is read from
--    Vault secret 'functions_anon_key' (stored at apply time, never in git).
--
-- 3. app_notifications joins the supabase_realtime publication so the app
--    can show a new request while it is open (Android has no push token
--    until Firebase is configured for the app).

-- ── 1. Leave approval effects ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.leave_approval_effects (
  leave_request_id       uuid PRIMARY KEY REFERENCES public.leave_requests(id) ON DELETE CASCADE,
  tenant_id              uuid NOT NULL,
  profile_id             uuid NOT NULL,
  comp_off_days          numeric NOT NULL DEFAULT 0,
  applied_at             timestamptz NOT NULL DEFAULT now(),
  applied_by             uuid,
  client_comp_off_ack_at timestamptz
);
COMMENT ON TABLE public.leave_approval_effects IS
  'One row per approved leave whose ledger / comp-off / attendance effects the DB applied (20261016_1). Internal — no client access.';

ALTER TABLE public.leave_approval_effects ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.leave_approval_effects FROM anon, authenticated;

CREATE INDEX IF NOT EXISTS leave_approval_effects_unacked_idx
  ON public.leave_approval_effects (profile_id, applied_at)
  WHERE comp_off_days > 0 AND client_comp_off_ack_at IS NULL;

-- Everything an approved leave changes. Idempotent: the attendance upsert is
-- naturally repeatable, the ledger / comp-off part runs once per request.
CREATE OR REPLACE FUNCTION public.apply_leave_approval_effects(p_leave_request_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_req  leave_requests%ROWTYPE;
  v_type uuid;
  v_day  date;
  v_comp numeric := 0;
BEGIN
  SELECT * INTO v_req FROM leave_requests WHERE id = p_leave_request_id;
  IF NOT FOUND OR v_req.status IS DISTINCT FROM 'Approved' THEN RETURN; END IF;

  -- Every day of the leave shows as 'Leave' on the attendance calendar (a
  -- half day is kept as punched by zz_leave_overrides_attendance_status).
  FOR v_day IN SELECT generate_series(v_req.start_date, v_req.end_date, interval '1 day')::date LOOP
    INSERT INTO attendance (tenant_id, profile_id, date, status, total_hours, location)
    VALUES (v_req.tenant_id, v_req.profile_id, v_day, 'Leave', 0, 'Office')
    ON CONFLICT (profile_id, date) DO UPDATE SET status = 'Leave', total_hours = 0;
  END LOOP;

  IF EXISTS (SELECT 1 FROM leave_approval_effects WHERE leave_request_id = p_leave_request_id) THEN RETURN; END IF;

  IF v_req.leave_type = 'Comp Off' THEN
    v_comp := CASE WHEN v_req.half_day IS NOT NULL THEN 0.5 ELSE (v_req.end_date - v_req.start_date) + 1 END;
    UPDATE profiles SET comp_off_balance = GREATEST(0, COALESCE(comp_off_balance, 0) - v_comp)
     WHERE id = v_req.profile_id;
  ELSIF NOT EXISTS (SELECT 1 FROM leave_ledger WHERE leave_request_id = p_leave_request_id) THEN
    SELECT id INTO v_type FROM leave_types WHERE tenant_id = v_req.tenant_id AND name = v_req.leave_type LIMIT 1;
    IF v_type IS NOT NULL THEN
      -- trg_leave_ledger_half_day cuts a half-day request's line to -0.5.
      INSERT INTO leave_ledger (tenant_id, profile_id, leave_type_id, entry_type, days, effective_date, leave_request_id, created_by)
      VALUES (v_req.tenant_id, v_req.profile_id, v_type, 'Deduction', -((v_req.end_date - v_req.start_date) + 1),
              v_req.start_date, p_leave_request_id, auth.uid());
    END IF;
  END IF;

  INSERT INTO leave_approval_effects (leave_request_id, tenant_id, profile_id, comp_off_days, applied_by)
  VALUES (p_leave_request_id, v_req.tenant_id, v_req.profile_id, v_comp, auth.uid());
END;
$function$;

REVOKE ALL ON FUNCTION public.apply_leave_approval_effects(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.trg_leave_approval_effects()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM apply_leave_approval_effects(NEW.id);
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.trg_leave_approval_effects() FROM PUBLIC, anon, authenticated;

-- Not "UPDATE OF status": at Raniwala the client writes manager_status /
-- hod_status / hr_status and enforce_leave_dual_approval derives status in a
-- BEFORE trigger, which a column-list trigger would never see.
DROP TRIGGER IF EXISTS zz_leave_approval_effects_ins ON public.leave_requests;
CREATE TRIGGER zz_leave_approval_effects_ins
  AFTER INSERT ON public.leave_requests
  FOR EACH ROW WHEN (NEW.status = 'Approved')
  EXECUTE FUNCTION public.trg_leave_approval_effects();

DROP TRIGGER IF EXISTS zz_leave_approval_effects_upd ON public.leave_requests;
CREATE TRIGGER zz_leave_approval_effects_upd
  AFTER UPDATE ON public.leave_requests
  FOR EACH ROW WHEN (NEW.status = 'Approved' AND OLD.status IS DISTINCT FROM 'Approved')
  EXECUTE FUNCTION public.trg_leave_approval_effects();

-- The clients still call this right after approving a Comp Off leave. The
-- trigger above already took those days, so a matching call within 10
-- minutes is acknowledged and ignored. Any other call is unchanged.
CREATE OR REPLACE FUNCTION public.adjust_comp_off_balance(p_profile_id uuid, p_delta numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_role   text;
  v_caller_tenant uuid;
  v_target_tenant uuid;
  v_ack           uuid;
BEGIN
  SELECT role, tenant_id INTO v_caller_role, v_caller_tenant FROM profiles WHERE id = auth.uid();
  SELECT tenant_id INTO v_target_tenant FROM profiles WHERE id = p_profile_id;

  IF v_target_tenant IS NULL THEN
    RAISE EXCEPTION 'Target profile not found';
  END IF;

  -- Post-approval Comp Off deduction already applied by the DB (20261016_1).
  IF p_delta < 0 AND v_caller_tenant = v_target_tenant THEN
    UPDATE leave_approval_effects e SET client_comp_off_ack_at = now()
     WHERE e.leave_request_id = (
       SELECT x.leave_request_id FROM leave_approval_effects x
        WHERE x.profile_id = p_profile_id AND x.comp_off_days = -p_delta
          AND x.client_comp_off_ack_at IS NULL AND x.applied_at > now() - interval '10 minutes'
        ORDER BY x.applied_at LIMIT 1)
    RETURNING e.leave_request_id INTO v_ack;
    IF v_ack IS NOT NULL THEN RETURN; END IF;
  END IF;

  IF NOT (v_caller_role IN ('admin','manager','superadmin') AND v_caller_tenant = v_target_tenant) THEN
    RAISE EXCEPTION 'Not authorized to adjust this employee''s comp-off balance';
  END IF;

  UPDATE profiles
  SET comp_off_balance = GREATEST(0, COALESCE(comp_off_balance, 0) + p_delta)
  WHERE id = p_profile_id;
END;
$function$;

-- Still called by the clients after an approval. The trigger has normally done
-- the work already, so this is a no-op. It now also accepts anyone who is
-- assigned to or decided a stage of this request (an HOD, Management), so
-- their client stops logging 'unauthorized'.
CREATE OR REPLACE FUNCTION public.record_leave_deduction(p_leave_request_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_req    RECORD;
  v_type   uuid;
  v_days   numeric;
  v_day    date;
BEGIN
  SELECT * INTO v_req FROM leave_requests WHERE id = p_leave_request_id;
  IF v_req IS NULL THEN RAISE EXCEPTION 'Leave request not found'; END IF;
  IF v_req.status <> 'Approved' THEN RAISE EXCEPTION 'Leave request is not Approved'; END IF;

  IF NOT (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND tenant_id = v_req.tenant_id AND role IN ('admin','manager','superadmin'))
    OR (auth.uid() = v_req.profile_id AND v_req.required_approver_role = 'self')
    OR auth.uid() IN (v_req.manager_id, v_req.hod_id, v_req.manager_decided_by, v_req.hod_decided_by,
                      v_req.hr_decided_by, v_req.management_decided_by)
  ) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  FOR v_day IN SELECT generate_series(v_req.start_date, v_req.end_date, interval '1 day')::date LOOP
    INSERT INTO attendance (tenant_id, profile_id, date, status, total_hours, location)
    VALUES (v_req.tenant_id, v_req.profile_id, v_day, 'Leave', 0, 'Office')
    ON CONFLICT (profile_id, date) DO UPDATE SET status = 'Leave', total_hours = 0;
  END LOOP;

  IF v_req.leave_type = 'Comp Off' THEN RETURN; END IF; -- balance handled by the approval trigger / adjust_comp_off_balance

  IF EXISTS (SELECT 1 FROM leave_ledger WHERE leave_request_id = p_leave_request_id) THEN RETURN; END IF;

  SELECT id INTO v_type FROM leave_types WHERE tenant_id = v_req.tenant_id AND name = v_req.leave_type LIMIT 1;
  IF v_type IS NULL THEN RETURN; END IF;

  v_days := (v_req.end_date - v_req.start_date) + 1;

  INSERT INTO leave_ledger (tenant_id, profile_id, leave_type_id, entry_type, days, effective_date, leave_request_id, created_by)
  VALUES (v_req.tenant_id, v_req.profile_id, v_type, 'Deduction', -v_days, v_req.start_date, p_leave_request_id, auth.uid());
END;
$function$;

-- Backfill: approved leaves whose final approver's role the old functions
-- refused (hod / management), with no ledger line yet — 1 Earned Leave on
-- 2026-10-16. Comp Off rows are left alone: the clients may already have
-- adjusted those balances.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT l.id FROM leave_requests l
     WHERE l.status = 'Approved' AND l.leave_type <> 'Comp Off'
       AND NOT EXISTS (SELECT 1 FROM leave_ledger g WHERE g.leave_request_id = l.id)
       AND EXISTS (SELECT 1 FROM leave_types lt WHERE lt.tenant_id = l.tenant_id AND lt.name = l.leave_type)
       AND (SELECT role FROM profiles WHERE id = COALESCE(l.management_decided_by, l.hr_decided_by, l.hod_decided_by, l.manager_decided_by))
           IN ('hod', 'management')
  LOOP
    PERFORM apply_leave_approval_effects(r.id);
  END LOOP;
END $$;

-- ── 2. Push every app notification to the recipient's phone ─────────────────

CREATE OR REPLACE FUNCTION public.trg_push_app_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_key text;
BEGIN
  IF NEW.type IN ('clock_in', 'clock_out') OR NEW.type ILIKE 'birthday%' OR NEW.type ILIKE '%anniversar%' THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM push_tokens WHERE profile_id = NEW.profile_id) THEN
    RETURN NULL;
  END IF;
  BEGIN
    SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'functions_anon_key' LIMIT 1;
    IF v_key IS NULL THEN
      RAISE WARNING 'Vault secret functions_anon_key missing — push skipped';
      RETURN NULL;
    END IF;
    PERFORM net.http_post(
      url := 'https://yxueywgrqrfgynqknsqs.supabase.co/functions/v1/push-app-notification',
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
      body := jsonb_build_object('type', 'INSERT', 'table', 'app_notifications', 'schema', 'public', 'record', to_jsonb(NEW)),
      timeout_milliseconds := 10000
    );
  EXCEPTION WHEN OTHERS THEN
    -- A push is best effort; it must never block the notification itself.
    RAISE WARNING 'push-app-notification call failed: %', SQLERRM;
  END;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.trg_push_app_notification() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS zz_push_app_notification ON public.app_notifications;
CREATE TRIGGER zz_push_app_notification
  AFTER INSERT ON public.app_notifications
  FOR EACH ROW EXECUTE FUNCTION public.trg_push_app_notification();

-- ── 3. Realtime for the in-app notification feed ─────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'app_notifications') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.app_notifications;
  END IF;
END $$;
