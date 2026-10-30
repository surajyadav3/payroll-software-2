-- 20261008_1 — Announcements & policies: types, draft / scheduled / archived, pinning, expiry,
-- audience targeting, acknowledgement receipts, policy versions, birthday posts.
-- Ported from the new CrewCore platform (E:\CrewCore HRMS, database/migrations/0023_comms.sql).
--
-- Additive only. Every new column has a default that reproduces today's behaviour, so the mobile
-- app (select * from announcements / policies, inserts without the new columns) keeps working:
-- its posts land as published, for everyone, with an Acknowledge button, exactly as now.
--
-- Rules live in the DB so web and app follow them alike:
--   * employees only ever see published, already-live, unexpired items for their audience
--     (RESTRICTIVE select policies, added on top of the existing permissive ones);
--   * only admins of the same tenant (or superadmin) write — this also closes a cross-tenant hole:
--     the old "Admins and managers can manage announcements" policy had no tenant check;
--   * notifications go out once, on publish, to the audience only (in-app row -> the existing
--     app_notifications webhook pushes it). Replaces the old tenant-wide push on every INSERT,
--     which would have announced drafts and ignored targeting.
--   * scheduled posts are released by a 15-minute in-database job; birthday posts by a daily one
--     (opt-in per tenant: tenants.auto_birthday_posts, default off).

-- ───────────────────────────── announcements ─────────────────────────────
ALTER TABLE public.announcements
  ADD COLUMN IF NOT EXISTS kind                 text        NOT NULL DEFAULT 'update',
  ADD COLUMN IF NOT EXISTS status               text        NOT NULL DEFAULT 'published',
  ADD COLUMN IF NOT EXISTS pinned               boolean     NOT NULL DEFAULT false,
  -- Today every announcement has an Acknowledge button (web + app), so the default keeps that.
  ADD COLUMN IF NOT EXISTS requires_ack         boolean     NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS audience             text        NOT NULL DEFAULT 'all',
  ADD COLUMN IF NOT EXISTS audience_departments text[]      NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS audience_outlets     uuid[]      NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS publish_at           timestamptz,
  ADD COLUMN IF NOT EXISTS expires_at           timestamptz,
  ADD COLUMN IF NOT EXISTS notified_at          timestamptz,
  ADD COLUMN IF NOT EXISTS archived_at          timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at           timestamptz NOT NULL DEFAULT now(),
  -- Birthday posts made by the daily job: who it is about, and a key so a day is posted once.
  ADD COLUMN IF NOT EXISTS subject_profile_id   uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS auto_key             text;

ALTER TABLE public.announcements
  ADD CONSTRAINT announcements_kind_check     CHECK (kind IN ('important', 'update', 'birthday', 'alert')),
  ADD CONSTRAINT announcements_status_check   CHECK (status IN ('draft', 'published', 'archived')),
  ADD CONSTRAINT announcements_audience_check CHECK (audience IN ('all', 'departments', 'outlets')),
  ADD CONSTRAINT announcements_expiry_check   CHECK (expires_at IS NULL OR publish_at IS NULL OR expires_at > publish_at);

CREATE UNIQUE INDEX IF NOT EXISTS announcements_auto_key_uidx ON public.announcements (auto_key) WHERE auto_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS announcements_feed_idx ON public.announcements (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS announcements_due_idx ON public.announcements (publish_at) WHERE status = 'published' AND notified_at IS NULL;

-- Everything already posted was announced when it was created.
UPDATE public.announcements SET notified_at = created_at WHERE notified_at IS NULL;

-- ───────────────────────────── policies ─────────────────────────────
ALTER TABLE public.policies
  ADD COLUMN IF NOT EXISTS category        text        NOT NULL DEFAULT 'general',
  ADD COLUMN IF NOT EXISTS summary         text,
  ADD COLUMN IF NOT EXISTS status          text        NOT NULL DEFAULT 'published',
  ADD COLUMN IF NOT EXISTS requires_ack    boolean     NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS version_no      integer     NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS change_note     text,
  -- Earlier versions, newest last: [{version_no, change_note, published_at, ack_count}] (no row-per-version table).
  ADD COLUMN IF NOT EXISTS version_history jsonb       NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS published_at    timestamptz,
  ADD COLUMN IF NOT EXISTS archived_at     timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at      timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.policies
  ADD CONSTRAINT policies_category_check CHECK (category IN ('general', 'hr', 'leave', 'attendance', 'conduct', 'it', 'travel', 'finance', 'safety')),
  ADD CONSTRAINT policies_status_check   CHECK (status IN ('draft', 'published', 'archived')),
  ADD CONSTRAINT policies_change_note_len CHECK (change_note IS NULL OR length(change_note) <= 500);

UPDATE public.policies SET published_at = created_at WHERE published_at IS NULL AND status = 'published';

-- ───────────────────────────── tenant switch ─────────────────────────────
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS auto_birthday_posts boolean NOT NULL DEFAULT false;

-- ───────────────────────────── who may see what ─────────────────────────────
-- Can the signed-in user see this announcement? Admins see everything in their tenant
-- (drafts, scheduled, archived) so they can manage it; everyone else sees what is live for them.
CREATE OR REPLACE FUNCTION public.comms_can_see_announcement(
  p_tenant uuid, p_status text, p_publish_at timestamptz, p_expires_at timestamptz,
  p_audience text, p_departments text[], p_outlets uuid[]
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN me.role = 'superadmin' THEN true
    WHEN me.tenant_id IS DISTINCT FROM p_tenant THEN false
    WHEN me.role = 'admin' THEN true
    ELSE p_status = 'published'
     AND (p_publish_at IS NULL OR p_publish_at <= now())
     AND (p_expires_at IS NULL OR p_expires_at > now())
     AND (p_audience = 'all'
          OR (p_audience = 'departments' AND me.department = ANY (p_departments))
          OR (p_audience = 'outlets' AND me.outlet_id = ANY (p_outlets)))
  END
  FROM (SELECT p.role, p.tenant_id, p.department, p.outlet_id FROM profiles p WHERE p.id = auth.uid()) me;
$$;

CREATE OR REPLACE FUNCTION public.comms_is_tenant_admin(p_tenant uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles p WHERE p.id = auth.uid()
      AND (p.role = 'superadmin' OR (p.role = 'admin' AND p.tenant_id = p_tenant))
  );
$$;

-- RESTRICTIVE: must pass in addition to the existing permissive policies.
CREATE POLICY "announcements: visible to me (restrictive)" ON public.announcements
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (public.comms_can_see_announcement(tenant_id, status, publish_at, expires_at, audience, audience_departments, audience_outlets));
CREATE POLICY "announcements: tenant admin inserts (restrictive)" ON public.announcements
  AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (public.comms_is_tenant_admin(tenant_id));
CREATE POLICY "announcements: tenant admin updates (restrictive)" ON public.announcements
  AS RESTRICTIVE FOR UPDATE TO authenticated USING (public.comms_is_tenant_admin(tenant_id)) WITH CHECK (public.comms_is_tenant_admin(tenant_id));
CREATE POLICY "announcements: tenant admin deletes (restrictive)" ON public.announcements
  AS RESTRICTIVE FOR DELETE TO authenticated USING (public.comms_is_tenant_admin(tenant_id));

CREATE POLICY "policies: visible to me (restrictive)" ON public.policies
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (public.comms_is_tenant_admin(tenant_id) OR (tenant_id = public.my_tenant_id() AND status = 'published'));
CREATE POLICY "policies: tenant admin inserts (restrictive)" ON public.policies
  AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (public.comms_is_tenant_admin(tenant_id));
CREATE POLICY "policies: tenant admin updates (restrictive)" ON public.policies
  AS RESTRICTIVE FOR UPDATE TO authenticated USING (public.comms_is_tenant_admin(tenant_id)) WITH CHECK (public.comms_is_tenant_admin(tenant_id));
CREATE POLICY "policies: tenant admin deletes (restrictive)" ON public.policies
  AS RESTRICTIVE FOR DELETE TO authenticated USING (public.comms_is_tenant_admin(tenant_id));

-- ───────────────────────────── bookkeeping guard ─────────────────────────────
-- Keeps status timestamps honest whoever writes (web, app, SQL) and stops edits to archived items.
CREATE OR REPLACE FUNCTION public.trg_comms_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'archived' AND NEW.status = 'archived'
       AND (NEW.title IS DISTINCT FROM OLD.title OR NEW.body IS DISTINCT FROM OLD.body) THEN
      RAISE EXCEPTION 'This item is archived. Restore it before editing.' USING ERRCODE = 'P0001';
    END IF;
    NEW.updated_at := now();
  END IF;
  IF NEW.status = 'archived' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'archived') THEN
    NEW.archived_at := now();
  ELSIF NEW.status <> 'archived' THEN
    NEW.archived_at := NULL;
  END IF;
  -- Nested: announcements has no published_at, and PL/pgSQL resolves NEW.<field> when the
  -- statement runs, so this must only run for policies.
  IF TG_TABLE_NAME = 'policies' THEN
    IF NEW.status = 'published' AND NEW.published_at IS NULL THEN
      NEW.published_at := now();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_announcements_comms_guard BEFORE INSERT OR UPDATE ON public.announcements
  FOR EACH ROW EXECUTE FUNCTION public.trg_comms_guard();
CREATE TRIGGER trg_policies_comms_guard BEFORE INSERT OR UPDATE ON public.policies
  FOR EACH ROW EXECUTE FUNCTION public.trg_comms_guard();

-- ───────────────────────────── notify on publish ─────────────────────────────
-- Sends one in-app notification per audience member (the app_notifications webhook turns each
-- into a push), once. Quiet for birthday posts made by the daily job.
CREATE OR REPLACE FUNCTION public.comms_notify_announcement(p_id uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  a announcements%ROWTYPE;
  v_sent integer := 0;
BEGIN
  SELECT * INTO a FROM announcements WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR a.notified_at IS NOT NULL OR a.status <> 'published'
     OR (a.publish_at IS NOT NULL AND a.publish_at > now())
     OR (a.expires_at IS NOT NULL AND a.expires_at <= now()) THEN
    RETURN 0;
  END IF;

  UPDATE announcements SET notified_at = now() WHERE id = p_id;
  IF a.auto_key IS NOT NULL THEN
    RETURN 0;
  END IF;

  INSERT INTO app_notifications (tenant_id, profile_id, actor_id, type, title, body, link_key, related_id)
  SELECT a.tenant_id, p.id, a.created_by, 'announcement',
         CASE a.kind WHEN 'important' THEN 'Important: ' WHEN 'alert' THEN 'Alert: ' ELSE '' END || a.title,
         left(coalesce(nullif(a.body, ''), a.message, ''), 160),
         'announcements', a.id
  FROM profiles p
  WHERE p.tenant_id = a.tenant_id
    AND p.status = 'Active'
    AND p.id IS DISTINCT FROM a.created_by
    AND (a.audience = 'all'
         OR (a.audience = 'departments' AND p.department = ANY (a.audience_departments))
         OR (a.audience = 'outlets' AND p.outlet_id = ANY (a.audience_outlets)));
  GET DIAGNOSTICS v_sent = ROW_COUNT;
  RETURN v_sent;
END;
$$;

-- The old INSERT trigger pushed "Announcement: <title>" to the whole tenant on every insert
-- (drafts included). It now hands off to comms_notify_announcement, on publish.
CREATE OR REPLACE FUNCTION public.trg_notify_announcement_created() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.comms_notify_announcement(NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_announcement_created ON public.announcements;
CREATE TRIGGER on_announcement_created
  AFTER INSERT OR UPDATE OF status, publish_at ON public.announcements
  FOR EACH ROW WHEN (NEW.status = 'published' AND NEW.notified_at IS NULL)
  EXECUTE FUNCTION public.trg_notify_announcement_created();

-- Policies: notify the tenant when one goes live, and again when a new version asks everyone to
-- re-acknowledge (policy_new_version). Was: tenant-wide push on every INSERT.
CREATE OR REPLACE FUNCTION public.comms_notify_policy(p_id uuid, p_title text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_policy policies%ROWTYPE;
  v_sent integer := 0;
BEGIN
  SELECT * INTO v_policy FROM policies WHERE id = p_id;
  IF NOT FOUND OR v_policy.status <> 'published' THEN RETURN 0; END IF;
  INSERT INTO app_notifications (tenant_id, profile_id, actor_id, type, title, body, link_key, related_id)
  SELECT v_policy.tenant_id, p.id, v_policy.created_by, 'policy', p_title, v_policy.title, 'policies', v_policy.id
  FROM profiles p
  WHERE p.tenant_id = v_policy.tenant_id AND p.status = 'Active' AND p.id IS DISTINCT FROM auth.uid();
  GET DIAGNOSTICS v_sent = ROW_COUNT;
  RETURN v_sent;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_notify_policy_created() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'published' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'published') THEN
    PERFORM public.comms_notify_policy(NEW.id, 'New policy published');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_policy_created ON public.policies;
CREATE TRIGGER on_policy_created
  AFTER INSERT OR UPDATE OF status ON public.policies
  FOR EACH ROW EXECUTE FUNCTION public.trg_notify_policy_created();

-- ───────────────────────────── policy versions ─────────────────────────────
-- Publish what is now in the row as a new version: the old one goes into version_history with
-- its acknowledgement count; with p_reask, everyone is asked to acknowledge again.
CREATE OR REPLACE FUNCTION public.policy_new_version(p_policy_id uuid, p_change_note text, p_reask boolean DEFAULT true)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v policies%ROWTYPE;
  v_acks integer;
BEGIN
  SELECT * INTO v FROM policies WHERE id = p_policy_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Policy not found.' USING ERRCODE = 'P0002'; END IF;
  IF NOT public.comms_is_tenant_admin(v.tenant_id) THEN
    RAISE EXCEPTION 'Only HR / admins can publish a new version.' USING ERRCODE = '42501';
  END IF;
  IF v.status <> 'published' THEN
    RAISE EXCEPTION 'Publish the policy first; new versions are for live policies.' USING ERRCODE = 'P0001';
  END IF;
  IF length(coalesce(trim(p_change_note), '')) = 0 THEN
    RAISE EXCEPTION 'Say what changed in this version.' USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*) INTO v_acks FROM policy_acknowledgements WHERE policy_id = p_policy_id;
  UPDATE policies SET
    version_history = version_history || jsonb_build_array(jsonb_build_object(
      'version_no', v.version_no, 'change_note', v.change_note,
      'published_at', coalesce(v.published_at, v.created_at), 'ack_count', v_acks)),
    version_no = v.version_no + 1,
    change_note = left(trim(p_change_note), 500),
    published_at = now()
  WHERE id = p_policy_id;

  IF p_reask AND v.requires_ack THEN
    DELETE FROM policy_acknowledgements WHERE policy_id = p_policy_id;
  END IF;
  PERFORM public.comms_notify_policy(p_policy_id, 'Policy updated: version ' || (v.version_no + 1));
  RETURN v.version_no + 1;
END;
$$;
REVOKE ALL ON FUNCTION public.policy_new_version(uuid, text, boolean) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.policy_new_version(uuid, text, boolean) TO authenticated;

-- ───────────────────────────── receipts ─────────────────────────────
-- Who in the audience has / hasn't acknowledged — one call for the HR receipts drawer.
CREATE OR REPLACE FUNCTION public.announcement_receipts(p_id uuid)
RETURNS TABLE (profile_id uuid, name text, department text, acknowledged_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  a announcements%ROWTYPE;
BEGIN
  SELECT * INTO a FROM announcements WHERE id = p_id;
  IF NOT FOUND OR NOT public.comms_is_tenant_admin(a.tenant_id) THEN
    RAISE EXCEPTION 'Only HR / admins can see receipts.' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT p.id, trim(concat_ws(' ', p.first_name, nullif(p.middle_name, ''), p.last_name)), p.department, ack.acknowledged_at
  FROM profiles p
  LEFT JOIN announcement_acknowledgements ack ON ack.announcement_id = a.id AND ack.profile_id = p.id
  WHERE p.tenant_id = a.tenant_id AND p.status = 'Active' AND p.role <> 'superadmin'
    AND (a.audience = 'all'
         OR (a.audience = 'departments' AND p.department = ANY (a.audience_departments))
         OR (a.audience = 'outlets' AND p.outlet_id = ANY (a.audience_outlets)))
  ORDER BY ack.acknowledged_at IS NOT NULL, p.first_name;
END;
$$;
REVOKE ALL ON FUNCTION public.announcement_receipts(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.announcement_receipts(uuid) TO authenticated;

-- ───────────────────────────── jobs ─────────────────────────────
-- Releases scheduled announcements whose time has come (notifies their audience).
CREATE OR REPLACE FUNCTION public.comms_release_scheduled() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r record;
  n integer := 0;
BEGIN
  FOR r IN
    SELECT id FROM announcements
    WHERE status = 'published' AND notified_at IS NULL AND publish_at IS NOT NULL AND publish_at <= now()
    ORDER BY publish_at LIMIT 100
  LOOP
    PERFORM public.comms_notify_announcement(r.id);
    n := n + 1;
  END LOOP;
  RETURN n;
END;
$$;

-- One quiet Birthday post per person per day, for tenants that opted in. Seen by the person's
-- outlet (or everyone when they have none); hidden again at the end of the day.
CREATE OR REPLACE FUNCTION public.comms_post_birthdays() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_end timestamptz := ((v_today + 1)::timestamp AT TIME ZONE 'Asia/Kolkata');
  n integer := 0;
BEGIN
  INSERT INTO announcements (tenant_id, created_by, title, body, kind, status, requires_ack, audience,
                             audience_outlets, expires_at, subject_profile_id, auto_key, department)
  SELECT p.tenant_id, NULL,
         'Happy birthday, ' || p.first_name || '!',
         'Wishing ' || trim(concat_ws(' ', p.first_name, p.last_name)) || ' a wonderful birthday and a great year ahead.',
         'birthday', 'published', false,
         CASE WHEN p.outlet_id IS NULL THEN 'all' ELSE 'outlets' END,
         CASE WHEN p.outlet_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[p.outlet_id] END,
         v_end, p.id, 'birthday:' || p.id || ':' || v_today, 'All'
  FROM profiles p
  JOIN tenants t ON t.id = p.tenant_id AND t.auto_birthday_posts
  LEFT JOIN profile_details pd ON pd.profile_id = p.id
  WHERE p.status = 'Active'
    AND COALESCE(p.date_of_birth, pd.date_of_birth) IS NOT NULL
    AND to_char(COALESCE(p.date_of_birth, pd.date_of_birth), 'MM-DD') = to_char(v_today, 'MM-DD')
  ON CONFLICT (auto_key) WHERE auto_key IS NOT NULL DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION public.comms_notify_announcement(uuid), public.comms_notify_policy(uuid, text),
  public.comms_release_scheduled(), public.comms_post_birthdays() FROM public, anon, authenticated;

SELECT cron.schedule('comms-release-scheduled', '*/15 * * * *', $$ SELECT public.comms_release_scheduled(); $$);
-- 00:05 IST
SELECT cron.schedule('comms-birthday-posts', '35 18 * * *', $$ SELECT public.comms_post_birthdays(); $$);
