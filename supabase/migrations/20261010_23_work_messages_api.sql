-- =============================================================
-- Work 3/3: company messaging and the single entry point.
--
-- Messaging (apps/api/src/modules/work/messages.service.ts of the new
-- platform): #general for everyone, public and private channels, a channel
-- per project, direct messages (2–8 people), threads, @mentions, reactions,
-- edits, unread counts per person, and turning a message into a task.
--
-- Live updates use Supabase Realtime on work_messages (no polling): a client
-- subscribes with filter tenant_id=eq.<its company>, RLS below lets it hear
-- only channels it can see, and it then reads the formatted data through
-- work_api(). Reactions and thread replies bump the message so they are
-- heard too.
--
-- work_api(method, path, query, body) mirrors the platform's REST API
-- (/work/..., /directory) so the web app (and the mobile app, when it adopts
-- the register) call the same routes with the same rules.
-- Re-runnable.
-- =============================================================

-- ── 1. Who sees a channel ─────────────────────────────────────────────────
-- public — every employee; private / direct — members only; project — whoever sees the project.
CREATE OR REPLACE FUNCTION work_channel_visible(ch work_channels, p_tenant uuid, p_me uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT ch.tenant_id = p_tenant AND (
    ch.kind = 'public'
    OR (ch.kind IN ('private','direct') AND EXISTS (SELECT 1 FROM work_channel_members cm WHERE cm.channel_id = ch.id AND cm.profile_id = p_me))
    OR (ch.kind = 'project' AND EXISTS (SELECT 1 FROM projects vp WHERE vp.id = ch.project_id AND (vp.visibility = 'company'
          OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = vp.id AND pm.profile_id = p_me)))));
$$;

DO $$ BEGIN
  CREATE TYPE work_channel_access AS (id uuid, kind text, name text, project_id uuid, is_default boolean, archived boolean, member boolean, role text);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION work_channel_for(c work_ctx, p_id uuid)
RETURNS work_channel_access LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  a work_channel_access;
BEGIN
  SELECT ch.id, ch.kind, ch.name, ch.project_id, ch.is_default, ch.archived_at IS NOT NULL, cm.profile_id IS NOT NULL, cm.role
    INTO a.id, a.kind, a.name, a.project_id, a.is_default, a.archived, a.member, a.role
  FROM work_channels ch LEFT JOIN work_channel_members cm ON cm.channel_id = ch.id AND cm.profile_id = c.me
  WHERE ch.id = p_id AND work_channel_visible(ch, c.tenant, c.me);
  IF a.id IS NULL THEN PERFORM work_fail('NOT_FOUND', 'Channel not found.'); END IF;
  RETURN a;
END;
$$;

-- Realtime: a signed-in employee may read message rows of channels they can see (this is what
-- lets Realtime deliver the change; the app itself reads through work_api()).
CREATE OR REPLACE FUNCTION work_can_hear(p_channel uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM work_channels ch JOIN profiles me ON me.id = auth.uid() AND me.status = 'Active'
    WHERE ch.id = p_channel AND work_channel_visible(ch, me.tenant_id, me.id));
$$;
GRANT EXECUTE ON FUNCTION work_can_hear(uuid) TO authenticated;

GRANT SELECT ON work_messages TO authenticated;
DROP POLICY IF EXISTS "work_messages: channel readers" ON work_messages;
CREATE POLICY "work_messages: channel readers" ON work_messages FOR SELECT TO authenticated
  USING (tenant_id = (SELECT my_tenant_id()) AND work_can_hear(channel_id));

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'work_messages') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE work_messages;
  END IF;
END $$;

-- ── 2. Shapes ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION work_channel_json(c work_ctx, ch work_channels, p_counts boolean)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cm work_channel_members;
  v_people jsonb := '[]'::jsonb;
  v_last jsonb;
  v_unread int := 0;
  v_mentions int := 0;
BEGIN
  SELECT * INTO cm FROM work_channel_members WHERE channel_id = ch.id AND profile_id = c.me;
  IF ch.kind = 'direct' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('employeeId', x.profile_id, 'name', COALESCE(work_name(x.profile_id), 'Someone'))
                              ORDER BY COALESCE(work_name(x.profile_id), '')), '[]'::jsonb)
      INTO v_people
    FROM work_channel_members x WHERE x.channel_id = ch.id AND x.profile_id <> c.me;
  END IF;
  IF p_counts THEN
    IF cm.profile_id IS NOT NULL THEN
      SELECT count(*) FILTER (WHERE m.thread_root_id IS NULL AND m.author_id IS DISTINCT FROM c.me),
             count(*) FILTER (WHERE c.me = ANY (m.mentions))
        INTO v_unread, v_mentions
      FROM work_messages m WHERE m.channel_id = ch.id AND m.deleted_at IS NULL AND m.created_at > cm.last_read_at;
    END IF;
    SELECT jsonb_build_object('body', left(m.body, 140), 'author', work_name(m.author_id), 'at', work_iso(m.created_at), 'system', m.kind = 'system')
      INTO v_last
    FROM work_messages m WHERE m.channel_id = ch.id AND m.thread_root_id IS NULL AND m.deleted_at IS NULL
    ORDER BY m.created_at DESC LIMIT 1;
  END IF;
  RETURN jsonb_build_object(
    'id', ch.id, 'kind', ch.kind, 'name', ch.name,
    'title', CASE WHEN ch.kind = 'direct'
                  THEN COALESCE(NULLIF((SELECT string_agg(p->>'name', ', ') FROM jsonb_array_elements(v_people) p), ''), 'Just you')
                  ELSE '#' || ch.name END,
    'topic', ch.topic, 'projectId', ch.project_id, 'isDefault', ch.is_default, 'archived', ch.archived_at IS NOT NULL,
    'lastMessageAt', work_iso(ch.last_message_at), 'member', cm.profile_id IS NOT NULL, 'role', cm.role, 'muted', COALESCE(cm.muted, false),
    'unread', v_unread, 'mentions', v_mentions,
    'memberCount', (SELECT count(*) FROM work_channel_members x WHERE x.channel_id = ch.id),
    'people', v_people, 'last', v_last);
END;
$$;

CREATE OR REPLACE FUNCTION work_message_json(c work_ctx, m work_messages)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'id', m.id, 'channelId', m.channel_id,
    'author', CASE WHEN m.author_id IS NULL THEN NULL ELSE jsonb_build_object('employeeId', m.author_id, 'name', work_name(m.author_id)) END,
    'kind', m.kind,
    'body', CASE WHEN m.deleted_at IS NULL THEN m.body ELSE '' END,
    'deleted', m.deleted_at IS NOT NULL,
    'threadRootId', m.thread_root_id,
    'task', CASE WHEN m.task_id IS NULL THEN NULL ELSE (
      SELECT jsonb_build_object('id', t.id, 'key', COALESCE(p.key, 'T') || '-' || t.number, 'title', t.title, 'status', t.stage, 'assignee', work_name(t.assigned_to))
      FROM project_tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = m.task_id AND t.deleted_at IS NULL) END,
    'mentioned', COALESCE((SELECT jsonb_agg(jsonb_build_object('employeeId', x, 'name', COALESCE(work_name(x), 'Someone'))) FROM unnest(m.mentions) x), '[]'::jsonb),
    'replyCount', m.reply_count,
    'lastReplyAt', work_iso(m.last_reply_at),
    'reactions', COALESCE((SELECT jsonb_agg(jsonb_build_object('emoji', r.emoji, 'count', r.n, 'mine', r.mine) ORDER BY r.first)
                           FROM (SELECT x.emoji, count(*) AS n, bool_or(x.profile_id = c.me) AS mine, min(x.created_at) AS first
                                 FROM work_message_reactions x WHERE x.message_id = m.id GROUP BY x.emoji) r), '[]'::jsonb),
    'createdAt', work_iso(m.created_at),
    'editedAt', work_iso(m.edited_at),
    'mine', COALESCE(m.author_id = c.me, false));
$$;

CREATE OR REPLACE FUNCTION work_message_row(c work_ctx, p_id uuid)
RETURNS work_messages LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  m work_messages;
BEGIN
  SELECT x.* INTO m FROM work_messages x JOIN work_channels ch ON ch.id = x.channel_id
   WHERE x.id = p_id AND work_channel_visible(ch, c.tenant, c.me);
  IF m.id IS NULL THEN PERFORM work_fail('NOT_FOUND', 'Message not found.'); END IF;
  RETURN m;
END;
$$;

-- "Sales North!" → "sales-north".
CREATE OR REPLACE FUNCTION work_slug(p_name text)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v text := left(btrim(regexp_replace(regexp_replace(lower(btrim(p_name)), '^#', ''), '[^a-z0-9_-]+', '-', 'g'), '-'), 80);
BEGIN
  IF v !~ '^[a-z0-9][a-z0-9_-]{0,79}$' THEN
    RAISE EXCEPTION 'Use letters, numbers, dashes or underscores.' USING ERRCODE = 'P0001', DETAIL = 'CHANNEL_NAME';
  END IF;
  RETURN v;
END;
$$;

-- ── 3. Channels ───────────────────────────────────────────────────────────
-- The sidebar: channels I am in (with unread counts and the last message), plus public channels I could join.
CREATE OR REPLACE FUNCTION work_channels_list(c work_ctx)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Every company has #general (created the first time anyone opens Messages) with everyone in it;
  -- what was posted since someone joined the company counts as unread for them.
  INSERT INTO work_channels (tenant_id, kind, name, topic, is_default)
  SELECT c.tenant, 'public', 'general', 'Company-wide announcements and chat', true
  WHERE NOT EXISTS (SELECT 1 FROM work_channels WHERE tenant_id = c.tenant AND is_default)
  ON CONFLICT DO NOTHING;
  INSERT INTO work_channel_members (tenant_id, channel_id, profile_id, last_read_at)
  SELECT ch.tenant_id, ch.id, p.id, p.created_at FROM work_channels ch, profiles p
  WHERE ch.tenant_id = c.tenant AND ch.is_default AND p.id = c.me
  ON CONFLICT DO NOTHING;
  RETURN COALESCE((
    SELECT jsonb_agg(work_channel_json(c, ch, true) ORDER BY ch.is_default DESC, ch.last_message_at DESC NULLS LAST, ch.name)
    FROM work_channels ch
    WHERE ch.tenant_id = c.tenant AND ch.archived_at IS NULL AND work_channel_visible(ch, c.tenant, c.me)
      AND (ch.kind = 'public' OR EXISTS (SELECT 1 FROM work_channel_members cm WHERE cm.channel_id = ch.id AND cm.profile_id = c.me))), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION work_channel_get(c work_ctx, p_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  a work_channel_access := work_channel_for(c, p_id);
  ch work_channels;
BEGIN
  SELECT * INTO ch FROM work_channels WHERE id = p_id;
  RETURN work_channel_json(c, ch, false) || jsonb_build_object(
    'memberList', COALESCE((SELECT jsonb_agg(jsonb_build_object('employeeId', y.profile_id, 'name', y.name, 'role', y.role) ORDER BY (y.role = 'owner') DESC, lower(y.name))
                            FROM (SELECT m.profile_id, COALESCE(work_name(m.profile_id), 'Someone') AS name, m.role
                                  FROM work_channel_members m WHERE m.channel_id = p_id LIMIT 500) y), '[]'::jsonb),
    'project', CASE WHEN a.project_id IS NULL THEN NULL ELSE
      (SELECT jsonb_build_object('id', p.id, 'key', p.key, 'name', p.name) FROM projects p WHERE p.id = a.project_id) END);
END;
$$;

CREATE OR REPLACE FUNCTION work_active_ids(c work_ctx, p_ids uuid[])
RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(ARRAY(SELECT id FROM profiles WHERE id = ANY (p_ids) AND tenant_id = c.tenant AND status = 'Active'), '{}'::uuid[]);
$$;

CREATE OR REPLACE FUNCTION work_channel_create(c work_ctx, i jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_name text := btrim(COALESCE(i->>'name', ''));
  v_topic text := NULLIF(btrim(COALESCE(i->>'topic', '')), '');
  v_kind text := COALESCE(NULLIF(i->>'kind', ''), 'public');
  v_slug text;
  v_id uuid := gen_random_uuid();
  v_member uuid;
BEGIN
  IF char_length(v_name) NOT BETWEEN 1 AND 80 THEN PERFORM work_fail('VALIDATION', 'A channel needs a name of up to 80 characters.'); END IF;
  IF v_topic IS NOT NULL AND char_length(v_topic) > 250 THEN PERFORM work_fail('VALIDATION', 'The topic is too long.'); END IF;
  IF v_kind NOT IN ('public','private') THEN PERFORM work_fail('VALIDATION', 'Unknown channel kind.'); END IF;
  v_slug := work_slug(v_name);
  BEGIN
    INSERT INTO work_channels (id, tenant_id, kind, name, topic, created_by) VALUES (v_id, c.tenant, v_kind, v_slug, v_topic, c.me);
  EXCEPTION WHEN unique_violation THEN
    PERFORM work_fail('CONFLICT', 'A channel with this name already exists.');
  END;
  PERFORM work_ensure_member(c.tenant, v_id, c.me, 'owner');
  FOREACH v_member IN ARRAY work_active_ids(c, array_remove(work_uuids(i->'memberIds'), c.me)) LOOP
    PERFORM work_ensure_member(c.tenant, v_id, v_member);
  END LOOP;
  PERFORM work_post_system(c.tenant, v_id, format('%s created #%s%s', COALESCE(work_name(c.me), 'Someone'), v_slug,
                           CASE WHEN v_topic IS NOT NULL THEN ' — ' || v_topic ELSE '' END));
  RETURN v_id;
END;
$$;

-- The direct conversation with these people (opened if it already exists).
CREATE OR REPLACE FUNCTION work_channel_direct(c work_ctx, p_ids uuid[])
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_people uuid[] := ARRAY(SELECT DISTINCT x FROM unnest(p_ids || c.me) x WHERE x IS NOT NULL ORDER BY x);
  v_key text;
  v_id uuid;
  v_member uuid;
BEGIN
  IF cardinality(v_people) < 2 THEN PERFORM work_fail('VALIDATION', 'Choose who to message.'); END IF;
  IF cardinality(v_people) > 8 THEN PERFORM work_fail('VALIDATION', 'At most 8 people in a direct message; use a channel for more.'); END IF;
  IF cardinality(work_active_ids(c, v_people)) <> cardinality(v_people) THEN
    PERFORM work_fail('VALIDATION', 'Some of these people are not active employees.');
  END IF;
  v_key := array_to_string(v_people, ',');
  SELECT id INTO v_id FROM work_channels WHERE tenant_id = c.tenant AND direct_key = v_key;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  INSERT INTO work_channels (tenant_id, kind, direct_key, created_by) VALUES (c.tenant, 'direct', v_key, c.me)
  ON CONFLICT DO NOTHING;
  SELECT id INTO v_id FROM work_channels WHERE tenant_id = c.tenant AND direct_key = v_key;
  FOREACH v_member IN ARRAY v_people LOOP PERFORM work_ensure_member(c.tenant, v_id, v_member); END LOOP;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION work_channel_leave(c work_ctx, p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  a work_channel_access := work_channel_for(c, p_id);
BEGIN
  IF a.is_default THEN PERFORM work_fail('DEFAULT_CHANNEL', 'Everyone stays in #general (you can mute it).'); END IF;
  IF a.kind = 'direct' THEN PERFORM work_fail('DIRECT_CHANNEL', 'You cannot leave a direct conversation (you can mute it).'); END IF;
  DELETE FROM work_channel_members WHERE channel_id = p_id AND profile_id = c.me;
END;
$$;

CREATE OR REPLACE FUNCTION work_channel_add_members(c work_ctx, p_id uuid, p_ids uuid[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  a work_channel_access := work_channel_for(c, p_id);
  v_added uuid[] := work_active_ids(c, p_ids);
  v_member uuid;
BEGIN
  IF NOT a.member THEN PERFORM work_fail('FORBIDDEN', 'Join the channel first.'); END IF;
  IF a.kind = 'direct' THEN PERFORM work_fail('DIRECT_CHANNEL', 'Start a new direct message to include more people.'); END IF;
  IF cardinality(v_added) = 0 THEN RETURN; END IF;
  FOREACH v_member IN ARRAY v_added LOOP PERFORM work_ensure_member(c.tenant, p_id, v_member); END LOOP;
  PERFORM work_post_system(c.tenant, p_id, format('%s added %s', COALESCE(work_name(c.me), 'Someone'),
    (SELECT string_agg(COALESCE(work_name(x), 'Someone'), ', ') FROM unnest(v_added) x)));
END;
$$;

CREATE OR REPLACE FUNCTION work_channel_update(c work_ctx, p_id uuid, i jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  a work_channel_access := work_channel_for(c, p_id);
  v_owner boolean;
  v_archived boolean := (i->>'archived')::boolean;
BEGIN
  IF i ? 'muted' THEN
    PERFORM work_ensure_member(c.tenant, p_id, c.me);
    UPDATE work_channel_members SET muted = COALESCE((i->>'muted')::boolean, false) WHERE channel_id = p_id AND profile_id = c.me;
  END IF;
  IF i ? 'name' OR i ? 'topic' OR i ? 'archived' THEN
    v_owner := COALESCE(a.role = 'owner', false) OR (c.overseer AND a.kind = 'public');
    IF NOT v_owner OR a.kind IN ('direct','project') OR (a.is_default AND COALESCE(v_archived, false)) THEN
      PERFORM work_fail('FORBIDDEN', 'Only the channel owner can change this channel.');
    END IF;
    IF i ? 'topic' AND char_length(COALESCE(i->>'topic', '')) > 250 THEN PERFORM work_fail('VALIDATION', 'The topic is too long.'); END IF;
    BEGIN
      UPDATE work_channels SET
        name = CASE WHEN NULLIF(btrim(COALESCE(i->>'name', '')), '') IS NOT NULL THEN work_slug(i->>'name') ELSE name END,
        topic = CASE WHEN i ? 'topic' THEN NULLIF(btrim(COALESCE(i->>'topic', '')), '') ELSE topic END,
        archived_at = CASE WHEN v_archived IS NULL THEN archived_at WHEN v_archived THEN now() END
      WHERE id = p_id;
    EXCEPTION WHEN unique_violation THEN
      PERFORM work_fail('CONFLICT', 'A channel with this name already exists.');
    END;
  END IF;
END;
$$;

-- Marks the channel read up to now (clears its unread count).
CREATE OR REPLACE FUNCTION work_channel_read(c work_ctx, p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  a work_channel_access := work_channel_for(c, p_id);
BEGIN
  IF a.member THEN UPDATE work_channel_members SET last_read_at = now() WHERE channel_id = p_id AND profile_id = c.me; END IF;
END;
$$;

-- ── 4. Messages ───────────────────────────────────────────────────────────
-- Newest first (`before` = an older page), or only what is new or changed since `after`.
CREATE OR REPLACE FUNCTION work_messages_list(c work_ctx, p_channel uuid, q jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  a work_channel_access := work_channel_for(c, p_channel);
  v_limit int := LEAST(GREATEST(COALESCE(NULLIF(q->>'limit', '')::int, 50), 1), 100);
  v_before_at timestamptz;
  v_before_id uuid;
  v_after timestamptz := NULLIF(q->>'after', '')::timestamptz;
  v_rows work_messages[];
  v_more boolean;
  v_last work_messages;
BEGIN
  IF NULLIF(q->>'before', '') IS NOT NULL THEN
    BEGIN
      v_before_at := split_part(q->>'before', '|', 1)::timestamptz;
      v_before_id := split_part(q->>'before', '|', 2)::uuid;
    EXCEPTION WHEN OTHERS THEN
      PERFORM work_fail('VALIDATION', 'That page marker is not valid.');
    END;
  END IF;
  -- v_rows is newest first; the page is returned oldest first.
  SELECT array_agg(s.x ORDER BY (s.x).created_at DESC, (s.x).id DESC) INTO v_rows
  FROM (SELECT x FROM work_messages x
        WHERE x.channel_id = p_channel AND x.thread_root_id IS NULL
          AND (v_before_at IS NULL OR (x.created_at, x.id) < (v_before_at, v_before_id))
          AND (v_after IS NULL OR x.created_at > v_after OR x.edited_at > v_after OR x.deleted_at > v_after
               OR x.last_reply_at > v_after OR x.bumped_at > v_after)
        ORDER BY x.created_at DESC, x.id DESC
        LIMIT v_limit + 1) s;
  v_more := COALESCE(cardinality(v_rows), 0) > v_limit;
  IF v_more THEN v_rows := v_rows[1:v_limit]; END IF;
  v_last := v_rows[cardinality(v_rows)];
  RETURN jsonb_build_object(
    'data', COALESCE((SELECT jsonb_agg(work_message_json(c, v_rows[i]) ORDER BY i DESC) FROM generate_subscripts(v_rows, 1) i), '[]'::jsonb),
    'hasMore', v_more,
    'nextCursor', CASE WHEN v_more THEN to_char(v_last.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || v_last.id END,
    -- A few seconds of overlap: a message whose transaction began just before this read but committed
    -- after it is picked up by the next `after` read (the client merges by id, so repeats are harmless).
    'serverTime', work_iso(now() - interval '3 seconds'));
END;
$$;

CREATE OR REPLACE FUNCTION work_thread(c work_ctx, p_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  m work_messages := work_message_row(c, p_id);
BEGIN
  RETURN jsonb_build_object(
    'root', work_message_json(c, m),
    'replies', COALESCE((SELECT jsonb_agg(work_message_json(c, s.x) ORDER BY (s.x).created_at, (s.x).id)
                         FROM (SELECT x FROM work_messages x WHERE x.thread_root_id = p_id ORDER BY x.created_at, x.id LIMIT 500) s), '[]'::jsonb),
    'channelId', m.channel_id);
END;
$$;

-- Only people who can see the channel can be mentioned (a mention never leaks a private conversation).
CREATE OR REPLACE FUNCTION work_mentionable(c work_ctx, a work_channel_access, p_ids uuid[])
RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(ARRAY(
    SELECT e.id FROM profiles e
    WHERE e.id = ANY (p_ids[1:50]) AND e.tenant_id = c.tenant AND e.status = 'Active'
      AND (a.kind = 'public'
           OR EXISTS (SELECT 1 FROM work_channel_members m WHERE m.channel_id = a.id AND m.profile_id = e.id)
           OR (a.kind = 'project' AND EXISTS (SELECT 1 FROM projects p WHERE p.id = a.project_id AND (p.visibility = 'company'
                 OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.profile_id = e.id)))))), '{}'::uuid[]);
$$;

CREATE OR REPLACE FUNCTION work_message_post(c work_ctx, p_channel uuid, i jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  a work_channel_access := work_channel_for(c, p_channel);
  v_body text := btrim(COALESCE(i->>'body', ''));
  v_root uuid := work_uuid(i->>'threadRootId');
  v_key text := NULLIF(i->>'clientKey', '');
  v_mentions uuid[];
  v_id uuid;
  r work_messages;
  v_who text := COALESCE(work_name(c.me), 'Someone');
  v_others uuid[];
BEGIN
  IF v_body = '' THEN PERFORM work_fail('VALIDATION', 'Write something first.'); END IF;
  IF char_length(v_body) > 8000 THEN PERFORM work_fail('VALIDATION', 'A message is up to 8,000 characters.'); END IF;
  IF v_key IS NOT NULL AND char_length(v_key) > 80 THEN v_key := left(v_key, 80); END IF;
  IF a.archived THEN PERFORM work_fail('CHANNEL_ARCHIVED', 'This channel is archived.'); END IF;
  PERFORM work_ensure_member(c.tenant, p_channel, c.me);
  IF v_key IS NOT NULL THEN
    SELECT id INTO v_id FROM work_messages WHERE author_id = c.me AND client_key = v_key;
    IF v_id IS NOT NULL THEN RETURN v_id; END IF;   -- a retried send: already posted
  END IF;
  IF v_root IS NOT NULL THEN
    r := work_message_row(c, v_root);
    IF r.channel_id <> p_channel THEN PERFORM work_fail('VALIDATION', 'That thread is in another channel.'); END IF;
    IF r.thread_root_id IS NOT NULL THEN PERFORM work_fail('VALIDATION', 'Reply to the first message of the thread.'); END IF;
  END IF;
  v_mentions := work_mentionable(c, a, work_uuids(i->'mentions'));
  INSERT INTO work_messages (tenant_id, channel_id, author_id, kind, body, thread_root_id, mentions, client_key)
  VALUES (c.tenant, p_channel, c.me, 'text', v_body, v_root, v_mentions, v_key)
  RETURNING id INTO v_id;
  IF v_root IS NOT NULL THEN
    UPDATE work_messages SET reply_count = reply_count + 1, last_reply_at = now(), bumped_at = now() WHERE id = v_root;
  ELSE
    UPDATE work_channels SET last_message_at = now() WHERE id = p_channel;
  END IF;
  UPDATE work_channel_members SET last_read_at = now() WHERE channel_id = p_channel AND profile_id = c.me;

  -- Mentions and direct messages notify. A muted conversation notifies only for @mentions.
  v_mentions := array_remove(v_mentions, c.me);
  PERFORM work_notify(c.tenant, v_mentions, c.me, 'chat_mention',
    CASE WHEN a.kind = 'direct' THEN format('%s mentioned you', v_who) ELSE format('%s mentioned you in #%s', v_who, a.name) END,
    left(v_body, 200), 'messages', p_channel);
  IF a.kind = 'direct' THEN
    v_others := ARRAY(SELECT profile_id FROM work_channel_members
                      WHERE channel_id = p_channel AND profile_id <> c.me AND NOT muted AND NOT profile_id = ANY (v_mentions));
    PERFORM work_notify(c.tenant, v_others, c.me, 'chat_message', format('%s sent you a message', v_who), left(v_body, 200), 'messages', p_channel);
  END IF;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION work_message_edit(c work_ctx, p_id uuid, p_body text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  m work_messages := work_message_row(c, p_id);
  v_body text := btrim(COALESCE(p_body, ''));
BEGIN
  IF m.author_id IS DISTINCT FROM c.me OR m.deleted_at IS NOT NULL THEN PERFORM work_fail('FORBIDDEN', 'You can only edit your own messages.'); END IF;
  IF char_length(v_body) NOT BETWEEN 1 AND 8000 THEN PERFORM work_fail('VALIDATION', 'A message is 1–8,000 characters.'); END IF;
  UPDATE work_messages SET body = v_body, edited_at = now() WHERE id = p_id;
END;
$$;

CREATE OR REPLACE FUNCTION work_message_remove(c work_ctx, p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  m work_messages := work_message_row(c, p_id);
  a work_channel_access := work_channel_for(c, m.channel_id);
BEGIN
  IF m.author_id IS DISTINCT FROM c.me AND a.role IS DISTINCT FROM 'owner' THEN
    PERFORM work_fail('FORBIDDEN', 'You can only delete your own messages.');
  END IF;
  UPDATE work_messages SET body = '', deleted_at = now() WHERE id = p_id AND deleted_at IS NULL;
END;
$$;

CREATE OR REPLACE FUNCTION work_message_react(c work_ctx, p_id uuid, p_emoji text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  m work_messages := work_message_row(c, p_id);
BEGIN
  IF p_emoji IS NULL OR char_length(p_emoji) NOT BETWEEN 1 AND 16 THEN PERFORM work_fail('VALIDATION', 'Choose an emoji.'); END IF;
  DELETE FROM work_message_reactions WHERE message_id = p_id AND profile_id = c.me AND emoji = p_emoji;
  IF NOT FOUND THEN
    INSERT INTO work_message_reactions (tenant_id, message_id, profile_id, emoji) VALUES (c.tenant, p_id, c.me, p_emoji) ON CONFLICT DO NOTHING;
  END IF;
  UPDATE work_messages SET bumped_at = now() WHERE id = p_id;
  IF m.thread_root_id IS NOT NULL THEN UPDATE work_messages SET bumped_at = now() WHERE id = m.thread_root_id; END IF;
END;
$$;

-- Turns a message into a task (linked both ways); the thread gets "Turned into OPS-12".
CREATE OR REPLACE FUNCTION work_message_to_task(c work_ctx, p_id uuid, i jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  m work_messages := work_message_row(c, p_id);
  v_project uuid := work_uuid(i->>'projectId');
  v_title text;
  v_task uuid;
  t project_tasks;
BEGIN
  IF m.deleted_at IS NOT NULL THEN PERFORM work_fail('NOT_FOUND', 'Message not found.'); END IF;
  IF m.task_id IS NOT NULL THEN PERFORM work_fail('ALREADY_A_TASK', 'This message is already a task.'); END IF;
  IF v_project IS NULL THEN PERFORM work_fail('VALIDATION', 'Choose a project.'); END IF;
  v_title := COALESCE(NULLIF(btrim(COALESCE(NULLIF(btrim(COALESCE(i->>'title', '')), ''), left(split_part(m.body, E'\n', 1), 200))), ''), 'Task from a message');
  v_task := work_task_insert(c, jsonb_strip_nulls(jsonb_build_object(
      'projectId', v_project, 'title', v_title,
      'description', m.body || E'\n\n— ' || COALESCE(work_name(m.author_id), 'Someone') || ', from a message',
      'priority', NULLIF(i->>'priority', ''), 'dueDate', NULLIF(i->>'dueDate', '')))
      || jsonb_build_object('assigneeEmployeeId', work_uuid(i->>'assigneeEmployeeId')),
    jsonb_build_object('sourceMessageId', p_id));
  UPDATE work_messages SET task_id = v_task, bumped_at = now() WHERE id = p_id;
  SELECT * INTO t FROM project_tasks WHERE id = v_task;
  PERFORM work_post_system(c.tenant, m.channel_id,
    format('%s turned this into %s · %s', COALESCE(work_name(c.me), 'Someone'), work_task_ref(t, work_settings_of(c.tenant)), v_title),
    v_task, COALESCE(m.thread_root_id, p_id));
  RETURN v_task;
END;
$$;

-- Messages mentioning me, newest first (the "Mentions" view).
CREATE OR REPLACE FUNCTION work_mentions(c work_ctx, p_limit int)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(work_message_json(c, y.m) || jsonb_build_object('channelId', (y.m).channel_id,
           'channelName', CASE WHEN y.kind = 'direct' THEN NULL ELSE y.name END) ORDER BY (y.m).created_at DESC), '[]'::jsonb)
  FROM (SELECT m, ch.kind, ch.name FROM work_messages m JOIN work_channels ch ON ch.id = m.channel_id
        WHERE m.tenant_id = c.tenant AND c.me = ANY (m.mentions) AND m.deleted_at IS NULL AND work_channel_visible(ch, c.tenant, c.me)
        ORDER BY m.created_at DESC
        LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100)) y;
$$;

-- ── 5. The entry point ────────────────────────────────────────────────────
-- work_api('GET', '/work/tasks', '{"assignee":"me","open":"true"}') etc. — the same routes,
-- bodies and answers as the platform's REST API. Errors: MESSAGE = what to show, DETAIL = code
-- (REASON_REQUIRED, DUE_REQUIRED, DELIVERABLE_REQUIRED, FORBIDDEN, NOT_FOUND, VALIDATION, …).
CREATE OR REPLACE FUNCTION work_api_route(p_method text, p_path text, p_query jsonb, p_body jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  c work_ctx := work_ctx_load();
  m text := upper(COALESCE(p_method, 'GET'));
  seg text[] := string_to_array(btrim(COALESCE(p_path, ''), '/'), '/');
  n int;
  q jsonb := COALESCE(p_query, '{}'::jsonb);
  b jsonb := COALESCE(p_body, '{}'::jsonb);
  a text; x text; y text; z text;
  v_id uuid;
  -- A new id is fetched in its own statement: the STABLE readers below see only what was
  -- committed to the snapshot before their calling statement began.
  v_new uuid;
  v_follow uuid;
  v_chat boolean;
BEGIN
  n := COALESCE(array_length(seg, 1), 0);

  IF n = 1 AND seg[1] = 'directory' AND m = 'GET' THEN
    RETURN work_directory(c, NULLIF(btrim(COALESCE(q->>'q', '')), ''), NULLIF(q->>'limit', '')::int);
  END IF;
  IF n < 2 OR seg[1] <> 'work' THEN PERFORM work_fail('NOT_FOUND', 'Not found.'); END IF;
  a := seg[2]; x := seg[3]; y := seg[4]; z := seg[5];

  v_chat := a IN ('channels','messages');
  IF NOT ai_feature_enabled(c.tenant, c.outlet, CASE WHEN v_chat THEN 'team_chat' ELSE 'tasks' END) THEN
    PERFORM work_fail('FEATURE_DISABLED', CASE WHEN v_chat THEN 'Messages are switched off for this company.' ELSE 'Tasks are switched off for this company.' END);
  END IF;

  -- ── projects ──
  IF a = 'projects' THEN
    IF NOT ai_feature_enabled(c.tenant, c.outlet, 'projects') THEN
      IF n = 2 AND m = 'GET' THEN RETURN jsonb_build_object('data', '[]'::jsonb); END IF;
      PERFORM work_fail('FEATURE_DISABLED', 'Projects are switched off for this company.');
    END IF;
    IF n = 2 AND m = 'GET' THEN
      RETURN jsonb_build_object('data', work_project_list(c, COALESCE(q->>'includeArchived', '') IN ('true','1')));
    ELSIF n = 2 AND m = 'POST' THEN
      v_new := work_project_create(c, b); RETURN work_project_get(c, v_new);
    END IF;
    v_id := work_uuid(x);
    IF n = 3 AND m = 'GET' THEN RETURN work_project_get(c, v_id);
    ELSIF n = 3 AND m = 'PATCH' THEN PERFORM work_project_update(c, v_id, b); RETURN work_project_get(c, v_id);
    ELSIF n = 4 AND y = 'members' AND m = 'POST' THEN
      PERFORM work_project_add_members(c, v_id, work_uuids(b->'employeeIds'), COALESCE(b->>'role', 'member')); RETURN work_project_get(c, v_id);
    ELSIF n = 5 AND y = 'members' AND m = 'DELETE' THEN
      PERFORM work_project_remove_member(c, v_id, work_uuid(z)); RETURN work_project_get(c, v_id);
    ELSIF n = 4 AND y = 'archive' AND m = 'POST' THEN
      PERFORM work_project_archive(c, v_id, COALESCE((b->>'archived')::boolean, true)); RETURN work_project_get(c, v_id);
    END IF;

  -- ── tasks ──
  ELSIF a = 'tasks' THEN
    IF n = 2 AND m = 'GET' THEN RETURN jsonb_build_object('data', work_task_list(c, q));
    ELSIF n = 2 AND m = 'POST' THEN v_new := work_task_insert(c, b); RETURN work_task_get(c, v_new);
    END IF;
    v_id := work_uuid(x);
    IF n = 3 AND m = 'GET' THEN RETURN work_task_get(c, v_id);
    ELSIF n = 3 AND m = 'PATCH' THEN PERFORM work_task_update(c, v_id, b); RETURN work_task_get(c, v_id);
    ELSIF n = 3 AND m = 'DELETE' THEN PERFORM work_task_remove(c, v_id); RETURN jsonb_build_object('id', v_id, 'deleted', true);
    ELSIF n = 4 AND m = 'POST' AND y = 'move' THEN PERFORM work_task_move(c, v_id, b); RETURN work_task_get(c, v_id);
    ELSIF n = 4 AND m = 'POST' AND y = 'transition' THEN
      v_follow := work_task_transition(c, v_id, b);
      RETURN work_task_get(c, v_id) || CASE WHEN v_follow IS NOT NULL THEN jsonb_build_object('followUpTaskId', v_follow) ELSE '{}'::jsonb END;
    ELSIF n = 4 AND m = 'POST' AND y = 'flag' THEN PERFORM work_task_flag(c, v_id, b->>'reason'); RETURN work_task_get(c, v_id);
    ELSIF n = 4 AND m = 'POST' AND y = 'revise-due' THEN
      PERFORM work_task_revise_due(c, v_id, work_date(b->>'revisedDueDate', 'revised due date'), b->>'reason'); RETURN work_task_get(c, v_id);
    ELSIF n = 4 AND m = 'PUT' AND y = 'dependencies' THEN
      PERFORM work_task_set_dependencies(c, v_id, work_uuids(b->'taskIds')); RETURN work_task_get(c, v_id);
    ELSIF n = 4 AND m = 'PUT' AND y = 'recurrence' THEN PERFORM work_task_set_recurrence(c, v_id, b); RETURN work_task_get(c, v_id);
    ELSIF n = 4 AND m = 'DELETE' AND y = 'recurrence' THEN PERFORM work_task_stop_recurrence(c, v_id); RETURN work_task_get(c, v_id);
    ELSIF n = 4 AND m = 'POST' AND y = 'undelete' THEN PERFORM work_task_undelete(c, v_id); RETURN work_task_get(c, v_id);
    ELSIF n = 4 AND m = 'POST' AND y = 'comments' THEN
      PERFORM work_task_comment(c, v_id, b->>'body', work_uuids(b->'mentions')); RETURN work_task_get(c, v_id);
    ELSIF n = 5 AND m = 'DELETE' AND y = 'comments' THEN
      PERFORM work_task_delete_comment(c, v_id, work_uuid(z)); RETURN work_task_get(c, v_id);
    END IF;

  -- ── my work, workload, settings, drafts ──
  ELSIF a = 'me' AND x = 'summary' AND n = 3 AND m = 'GET' THEN RETURN work_summary(c, work_uuid(q->>'employeeId'));
  ELSIF a = 'me' AND x = 'view-as' AND n = 3 AND m = 'GET' THEN RETURN jsonb_build_object('data', work_view_as(c));
  ELSIF a = 'workload' AND n = 2 AND m = 'GET' THEN RETURN work_workload(c, q);
  ELSIF a = 'settings' AND n = 2 AND m = 'GET' THEN RETURN work_settings_json(c);
  ELSIF a = 'settings' AND n = 2 AND m = 'PATCH' THEN PERFORM work_settings_update(c, b); RETURN work_settings_json(c);
  ELSIF a = 'drafts' AND n = 2 AND m = 'GET' THEN RETURN jsonb_build_object('data', work_drafts(c, NULLIF(q->>'context', '')));
  ELSIF a = 'drafts' AND n = 2 AND m = 'POST' THEN RETURN work_draft_save(c, b);
  ELSIF a = 'drafts' AND n = 3 AND m = 'DELETE' THEN RETURN work_draft_delete(c, work_uuid(x));

  -- ── messaging ──
  ELSIF a = 'channels' THEN
    IF n = 2 AND m = 'GET' THEN RETURN jsonb_build_object('data', work_channels_list(c));
    ELSIF n = 2 AND m = 'POST' THEN v_new := work_channel_create(c, b); RETURN work_channel_get(c, v_new);
    ELSIF n = 3 AND x = 'direct' AND m = 'POST' THEN v_new := work_channel_direct(c, work_uuids(b->'employeeIds')); RETURN work_channel_get(c, v_new);
    END IF;
    v_id := work_uuid(x);
    IF n = 3 AND m = 'GET' THEN RETURN work_channel_get(c, v_id);
    ELSIF n = 3 AND m = 'PATCH' THEN PERFORM work_channel_update(c, v_id, b); RETURN work_channel_get(c, v_id);
    ELSIF n = 4 AND m = 'POST' AND y = 'join' THEN
      PERFORM work_channel_for(c, v_id); PERFORM work_ensure_member(c.tenant, v_id, c.me); RETURN work_channel_get(c, v_id);
    ELSIF n = 4 AND m = 'POST' AND y = 'leave' THEN PERFORM work_channel_leave(c, v_id); RETURN jsonb_build_object('left', true);
    ELSIF n = 4 AND m = 'POST' AND y = 'members' THEN
      PERFORM work_channel_add_members(c, v_id, work_uuids(b->'employeeIds')); RETURN work_channel_get(c, v_id);
    ELSIF n = 4 AND m = 'POST' AND y = 'read' THEN PERFORM work_channel_read(c, v_id); RETURN jsonb_build_object('read', true);
    ELSIF n = 4 AND m = 'GET' AND y = 'messages' THEN RETURN work_messages_list(c, v_id, q);
    ELSIF n = 4 AND m = 'POST' AND y = 'messages' THEN v_new := work_message_post(c, v_id, b); RETURN work_message_json(c, work_message_row(c, v_new));
    END IF;
  ELSIF a = 'messages' THEN
    IF n = 3 AND x = 'mentions' AND m = 'GET' THEN RETURN jsonb_build_object('data', work_mentions(c, NULLIF(q->>'limit', '')::int)); END IF;
    v_id := work_uuid(x);
    IF n = 4 AND m = 'GET' AND y = 'thread' THEN RETURN work_thread(c, v_id);
    ELSIF n = 3 AND m = 'PATCH' THEN PERFORM work_message_edit(c, v_id, b->>'body'); RETURN work_message_json(c, work_message_row(c, v_id));
    ELSIF n = 3 AND m = 'DELETE' THEN PERFORM work_message_remove(c, v_id); RETURN work_message_json(c, work_message_row(c, v_id));
    ELSIF n = 4 AND m = 'POST' AND y = 'reactions' THEN PERFORM work_message_react(c, v_id, b->>'emoji'); RETURN work_message_json(c, work_message_row(c, v_id));
    ELSIF n = 4 AND m = 'POST' AND y = 'task' THEN
      IF NOT ai_feature_enabled(c.tenant, c.outlet, 'tasks') THEN PERFORM work_fail('FEATURE_DISABLED', 'Tasks are switched off for this company.'); END IF;
      v_new := work_message_to_task(c, v_id, b); RETURN work_task_get(c, v_new);
    END IF;
  END IF;

  PERFORM work_fail('NOT_FOUND', 'Not found.');
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION work_api(p_method text, p_path text, p_query jsonb DEFAULT '{}'::jsonb, p_body jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_result jsonb;
BEGIN
  -- The register rules run inside; the legacy triggers on project_tasks step aside for this call only.
  PERFORM set_config('crewcore.work_rpc', 'on', true);
  v_result := work_api_route(p_method, p_path, p_query, p_body);
  PERFORM set_config('crewcore.work_rpc', 'off', true);
  RETURN v_result;
END;
$$;

-- Only the entry point is callable; every other work_* function is internal.
DO $$
DECLARE
  f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname LIKE 'work\_%' LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.sig);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION work_api(text, text, jsonb, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION work_can_hear(uuid) TO authenticated;

-- ── 6. Feature switch for Messages ────────────────────────────────────────
INSERT INTO features (key, name, category, description, sort_order, is_premium)
VALUES ('team_chat', 'Messages', 'General',
        'Company messaging: #general, channels, a channel per project, direct messages, threads, @mentions, reactions and turning a message into a task.',
        97, false)
ON CONFLICT (key) DO NOTHING;

-- A company that has Task Management switched off did not ask for a new module either:
-- Messages starts off there (HR turns it on in Toggle Services). Everyone else gets it by default.
INSERT INTO company_feature_toggles (tenant_id, outlet_id, feature_key, enabled)
SELECT t.tenant_id, NULL, 'team_chat', false
FROM company_feature_toggles t
WHERE t.feature_key = 'tasks' AND t.outlet_id IS NULL AND NOT t.enabled
  AND NOT EXISTS (SELECT 1 FROM company_feature_toggles x
                  WHERE x.tenant_id = t.tenant_id AND x.feature_key = 'team_chat' AND x.outlet_id IS NULL);
