-- =============================================================
-- Push goes to whoever is signed in on the phone; every notification is
-- pushed; employees can delete their own notifications (17 Oct 2026).
--
-- Bug: push_tokens.token is UNIQUE and RLS lets a user touch only their own
-- rows. The app registers with upsert(..., onConflict 'token'), so when a
-- second account signs in on the same phone the ON CONFLICT DO UPDATE hits
-- the first account's row, RLS refuses it, and the token stays with the
-- first account. Seen 17 Oct: a phone signed in as Pooja (Raniwala) got
-- Suraj's 09:00 "task overdue" push; Pooja had no token at all.
--
-- 1. BEFORE INSERT trigger on push_tokens: a signed-in user registering a
--    token takes it over — any other profile's row for that token is deleted
--    first, so the upsert inserts cleanly. Works with every app version
--    already installed (they re-register on each launch).
-- 2. trg_push_app_notification: push every type (clock in/out, birthdays and
--    anniversaries were skipped). Still only for people with a device, and
--    not the rows send-notification already pushed itself.
-- 3. app_notifications DELETE policy (own rows) for the app's "Delete all".
-- =============================================================

CREATE OR REPLACE FUNCTION public.trg_push_token_claim_device()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND NEW.profile_id = auth.uid() THEN
    DELETE FROM push_tokens WHERE token = NEW.token AND profile_id <> NEW.profile_id;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.trg_push_token_claim_device() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_push_token_claim_device ON public.push_tokens;
CREATE TRIGGER trg_push_token_claim_device
  BEFORE INSERT ON public.push_tokens
  FOR EACH ROW EXECUTE FUNCTION public.trg_push_token_claim_device();

CREATE OR REPLACE FUNCTION public.trg_push_app_notification()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_key text;
BEGIN
  -- Every notification type is pushed (20261017_2), except rows the
  -- send-notification Edge Function writes (service role, no link/actor/
  -- related id): it already pushed them itself.
  IF auth.role() = 'service_role'
     AND NEW.link_key IS NULL AND NEW.actor_id IS NULL AND NEW.related_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM push_tokens WHERE profile_id = NEW.profile_id) THEN
    RETURN NULL;
  END IF;
  BEGIN
    SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'functions_anon_key' LIMIT 1;
    IF v_key IS NULL THEN
      RAISE WARNING 'Vault secret functions_anon_key missing - push skipped';
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

DROP POLICY IF EXISTS "app_notifications: user deletes own" ON public.app_notifications;
CREATE POLICY "app_notifications: user deletes own"
  ON public.app_notifications FOR DELETE
  USING (profile_id = (SELECT auth.uid()));
