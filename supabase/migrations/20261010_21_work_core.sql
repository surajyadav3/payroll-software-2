-- =============================================================
-- Work (tasks, projects, messages) — the task register, project boards and
-- company messaging of the new CrewCore platform (E:\CrewCore HRMS,
-- database/migrations/0025_work.sql + 0033_task_register.sql), on this DB.
--
-- 1/3: schema, helpers and the project_tasks compatibility triggers.
--      (2/3 = tasks + projects rules, 3/3 = messaging + the work_api entry.)
--
-- project_tasks stays THE task table (the mobile app reads it and updates
-- `status` directly). The seven stages of the register map onto the existing
-- columns, so nothing the app reads changes meaning:
--
--   stage        status          review_status   is_backlog
--   backlog      To Do           —               true
--   todo         To Do           —               false
--   in_progress  In Progress     — / Sent back   false
--   blocked      Blocked         —               false
--   in_review    Done            Pending         false
--   done         Done            Approved        false
--   cancelled    Cancelled       —               false
--
-- The website writes only through work_api() (3/3), which applies the
-- register rules itself and sets crewcore.work_rpc = 'on' so the legacy
-- guard / notification triggers step aside. Direct writes (the app) keep
-- the legacy rules of 20261005_2 exactly as they were, and the sync
-- triggers below keep the new columns, the status timeline and the change
-- log complete for them too.
--
-- Additive and re-runnable. Nothing is dropped.
-- =============================================================

-- ── 1. Settings (one row per company, created on first use) ───────────────
CREATE TABLE IF NOT EXISTS work_settings (
  tenant_id            uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  task_visibility      text NOT NULL DEFAULT 'restricted' CHECK (task_visibility IN ('restricted','company')),
  task_key_prefix      text NOT NULL DEFAULT 'T' CHECK (task_key_prefix ~ '^[A-Z][A-Z0-9]{0,5}$'),
  require_due_to_start boolean NOT NULL DEFAULT true,
  require_deliverable  boolean NOT NULL DEFAULT true,
  reason_on_every_move boolean NOT NULL DEFAULT false,
  digest_enabled       boolean NOT NULL DEFAULT false,
  digest_time          time NOT NULL DEFAULT '21:15',
  weekly_digest_dow    smallint NOT NULL DEFAULT 1 CHECK (weekly_digest_dow BETWEEN 0 AND 6),
  next_task_number     integer NOT NULL DEFAULT 1,
  updated_at           timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE work_settings ENABLE ROW LEVEL SECURITY;

-- ── 2. Messaging tables (projects point at their channel) ─────────────────
CREATE TABLE IF NOT EXISTS work_channels (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('public','private','project','direct')),
  -- Lower-case slug for named channels (#general, #sales-north); direct messages have no name.
  name            text CHECK (name IS NULL OR name ~ '^[a-z0-9][a-z0-9_-]{0,79}$'),
  topic           text CHECK (topic IS NULL OR char_length(topic) <= 250),
  project_id      uuid REFERENCES projects(id) ON DELETE CASCADE,
  is_default      boolean NOT NULL DEFAULT false,   -- #general: every employee belongs
  direct_key      text,                             -- sorted member ids of a direct conversation
  archived_at     timestamptz,
  last_message_at timestamptz,
  created_by      uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT work_channels_shape CHECK ((kind = 'direct') = (name IS NULL) AND (kind = 'direct') = (direct_key IS NOT NULL)
                                        AND (kind = 'project') = (project_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS work_channels_name_uq    ON work_channels(tenant_id, name) WHERE name IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS work_channels_direct_uq  ON work_channels(tenant_id, direct_key) WHERE direct_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS work_channels_default_uq ON work_channels(tenant_id) WHERE is_default;
CREATE INDEX IF NOT EXISTS work_channels_project_idx       ON work_channels(project_id) WHERE project_id IS NOT NULL;
ALTER TABLE work_channels ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS work_channel_members (
  channel_id   uuid NOT NULL REFERENCES work_channels(id) ON DELETE CASCADE,
  profile_id   uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role         text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  muted        boolean NOT NULL DEFAULT false,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  joined_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, profile_id)
);
CREATE INDEX IF NOT EXISTS work_channel_members_profile_idx ON work_channel_members(profile_id);
ALTER TABLE work_channel_members ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS work_messages (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel_id     uuid NOT NULL REFERENCES work_channels(id) ON DELETE CASCADE,
  author_id      uuid REFERENCES profiles(id) ON DELETE SET NULL,   -- NULL = a system message
  kind           text NOT NULL DEFAULT 'text' CHECK (kind IN ('text','system')),
  body           text NOT NULL CHECK (char_length(body) <= 8000),
  thread_root_id uuid REFERENCES work_messages(id) ON DELETE CASCADE,
  task_id        uuid REFERENCES project_tasks(id) ON DELETE SET NULL,
  mentions       uuid[] NOT NULL DEFAULT '{}',
  reply_count    integer NOT NULL DEFAULT 0,
  last_reply_at  timestamptz,
  client_key     text CHECK (client_key IS NULL OR char_length(client_key) <= 80),
  created_at     timestamptz NOT NULL DEFAULT now(),
  edited_at      timestamptz,
  deleted_at     timestamptz,
  -- Bumped on anything a reader should pick up (reaction, linked task) — also the Realtime signal.
  bumped_at      timestamptz
);
CREATE INDEX IF NOT EXISTS work_messages_channel_idx  ON work_messages(channel_id, created_at DESC, id DESC) WHERE thread_root_id IS NULL;
CREATE INDEX IF NOT EXISTS work_messages_thread_idx   ON work_messages(thread_root_id, created_at) WHERE thread_root_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS work_messages_mentions_idx ON work_messages USING gin (mentions) WHERE cardinality(mentions) > 0;
CREATE UNIQUE INDEX IF NOT EXISTS work_messages_client_key_uq ON work_messages(author_id, client_key) WHERE client_key IS NOT NULL;
ALTER TABLE work_messages ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS work_message_reactions (
  message_id uuid NOT NULL REFERENCES work_messages(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  emoji      text NOT NULL CHECK (char_length(emoji) BETWEEN 1 AND 16),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, profile_id, emoji)
);
ALTER TABLE work_message_reactions ENABLE ROW LEVEL SECURITY;

-- ── 3. Projects: key, colour, who sees it, admins, its channel ────────────
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS key              text,
  ADD COLUMN IF NOT EXISTS color            text NOT NULL DEFAULT 'iris',
  ADD COLUMN IF NOT EXISTS visibility       text NOT NULL DEFAULT 'company',
  ADD COLUMN IF NOT EXISTS lead_id          uuid REFERENCES profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS channel_id       uuid REFERENCES work_channels(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS next_task_number integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS archived_at      timestamptz;
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_key_check;
ALTER TABLE projects ADD CONSTRAINT projects_key_check CHECK (key IS NULL OR key ~ '^[A-Z][A-Z0-9]{1,9}$');
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_color_check;
ALTER TABLE projects ADD CONSTRAINT projects_color_check CHECK (color IN ('iris','aqua','ember','emerald','amber','rose','sky','ink'));
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_visibility_check;
ALTER TABLE projects ADD CONSTRAINT projects_visibility_check CHECK (visibility IN ('company','private'));

ALTER TABLE project_members
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'member';
ALTER TABLE project_members DROP CONSTRAINT IF EXISTS project_members_role_check;
ALTER TABLE project_members ADD CONSTRAINT project_members_role_check CHECK (role IN ('admin','member'));

-- Projects made before this migration: members-only (as they were), a key from the name,
-- the creator as lead + admin, tasks numbered in creation order.
DO $$
DECLARE
  r record;
  v_key text;
  v_try text;
  n int;
BEGIN
  FOR r IN SELECT * FROM projects WHERE key IS NULL ORDER BY created_at LOOP
    v_key := upper(regexp_replace(r.name, '[^A-Za-z0-9 ]', ' ', 'g'));
    v_key := (SELECT string_agg(left(w, 1), '') FROM regexp_split_to_table(btrim(v_key), '\s+') w WHERE w <> '');
    IF v_key IS NULL OR char_length(v_key) < 2 THEN
      v_key := left(upper(regexp_replace(r.name, '[^A-Za-z0-9]', '', 'g')), 4);
    END IF;
    v_key := left(v_key, 6);
    IF v_key IS NULL OR v_key !~ '^[A-Z][A-Z0-9]{1,9}$' THEN v_key := 'PRJ'; END IF;
    v_try := v_key; n := 1;
    WHILE EXISTS (SELECT 1 FROM projects WHERE tenant_id = r.tenant_id AND key = v_try) LOOP
      n := n + 1; v_try := left(v_key, 8) || n::text;
    END LOOP;
    UPDATE projects SET key = v_try, visibility = 'private', lead_id = COALESCE(lead_id, created_by),
           archived_at = CASE WHEN status = 'Active' THEN NULL ELSE COALESCE(archived_at, now()) END
     WHERE id = r.id;
    IF r.created_by IS NOT NULL THEN
      INSERT INTO project_members (tenant_id, project_id, profile_id, role_on_project, role)
      VALUES (r.tenant_id, r.id, r.created_by, 'Admin', 'admin')
      ON CONFLICT (project_id, profile_id) DO UPDATE SET role = 'admin';
    END IF;
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS projects_key_uq  ON projects(tenant_id, key) WHERE key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS projects_name_uq ON projects(tenant_id, lower(name));

-- ── 4. project_tasks: the register's columns ──────────────────────────────
ALTER TABLE project_tasks
  ADD COLUMN IF NOT EXISTS number            integer,
  ADD COLUMN IF NOT EXISTS is_backlog        boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS labels            text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS approver_id       uuid REFERENCES profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS submitted_at      timestamptz,
  ADD COLUMN IF NOT EXISTS completed_late    boolean,
  ADD COLUMN IF NOT EXISTS rework_count      integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS flagged_at        timestamptz,
  ADD COLUMN IF NOT EXISTS flag_reason       text,
  ADD COLUMN IF NOT EXISTS flagged_by        uuid REFERENCES profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS status_changed_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS position          double precision NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS source_message_id uuid REFERENCES work_messages(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS department        text,
  ADD COLUMN IF NOT EXISTS deleted_at        timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by        uuid REFERENCES profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS recurrence_id     uuid;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'project_tasks' AND column_name = 'stage') THEN
    ALTER TABLE project_tasks ADD COLUMN stage text GENERATED ALWAYS AS (
      CASE status
        WHEN 'To Do'       THEN CASE WHEN is_backlog THEN 'backlog' ELSE 'todo' END
        WHEN 'In Progress' THEN 'in_progress'
        WHEN 'Blocked'     THEN 'blocked'
        WHEN 'Done'        THEN CASE WHEN review_status = 'Pending' THEN 'in_review' ELSE 'done' END
        ELSE 'cancelled'
      END) STORED;
  END IF;
END $$;

ALTER TABLE project_tasks DROP CONSTRAINT IF EXISTS project_tasks_priority_check;
ALTER TABLE project_tasks ADD CONSTRAINT project_tasks_priority_check
  CHECK (priority IN ('None','Low','Medium','High','Urgent'));
ALTER TABLE project_tasks DROP CONSTRAINT IF EXISTS project_tasks_title_len;
ALTER TABLE project_tasks ADD CONSTRAINT project_tasks_title_len CHECK (char_length(title) BETWEEN 1 AND 250);
ALTER TABLE project_tasks DROP CONSTRAINT IF EXISTS project_tasks_labels_len;
ALTER TABLE project_tasks ADD CONSTRAINT project_tasks_labels_len CHECK (cardinality(labels) <= 10);
ALTER TABLE project_tasks DROP CONSTRAINT IF EXISTS project_tasks_flag_reason_len;
ALTER TABLE project_tasks ADD CONSTRAINT project_tasks_flag_reason_len CHECK (flag_reason IS NULL OR char_length(flag_reason) <= 500);
ALTER TABLE project_tasks DROP CONSTRAINT IF EXISTS project_tasks_backlog_is_todo;
ALTER TABLE project_tasks ADD CONSTRAINT project_tasks_backlog_is_todo CHECK (NOT is_backlog OR status = 'To Do');

CREATE INDEX IF NOT EXISTS idx_project_tasks_stage    ON project_tasks(tenant_id, stage) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_project_tasks_approver ON project_tasks(approver_id) WHERE approver_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_project_tasks_waiting  ON project_tasks USING gin (waiting_on) WHERE cardinality(waiting_on) > 0;

-- ── 5. Status timeline, change log, comments, repeats, drafts ─────────────
CREATE TABLE IF NOT EXISTS work_task_history (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id     uuid NOT NULL REFERENCES project_tasks(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('move','submit','approve','send_back','flag','reopen','cancel','restore','revise_due')),
  from_status text,
  to_status   text,
  reason      text CHECK (reason IS NULL OR char_length(reason) <= 500),
  note        text CHECK (note IS NULL OR char_length(note) <= 2000),
  from_due    date,
  to_due      date,
  actor_id    uuid REFERENCES profiles(id) ON DELETE SET NULL,
  at          timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS work_task_history_task_idx ON work_task_history(task_id, at);
ALTER TABLE work_task_history ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS work_task_activity (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id   uuid NOT NULL REFERENCES project_tasks(id) ON DELETE CASCADE,
  actor_id  uuid REFERENCES profiles(id) ON DELETE SET NULL,
  action    text NOT NULL,
  changes   jsonb NOT NULL DEFAULT '{}'::jsonb,
  at        timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS work_task_activity_task_idx ON work_task_activity(task_id, at DESC);
ALTER TABLE work_task_activity ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS work_task_comments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id    uuid NOT NULL REFERENCES project_tasks(id) ON DELETE CASCADE,
  author_id  uuid REFERENCES profiles(id) ON DELETE SET NULL,
  body       text NOT NULL CHECK (char_length(body) <= 8000),
  mentions   uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at  timestamptz,
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS work_task_comments_task_idx ON work_task_comments(task_id, created_at);
ALTER TABLE work_task_comments ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS work_task_recurrences (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_task_id  uuid NOT NULL UNIQUE REFERENCES project_tasks(id) ON DELETE CASCADE,
  frequency       text NOT NULL CHECK (frequency IN ('weekly','monthly')),
  weekday         smallint CHECK (weekday BETWEEN 0 AND 6),
  month_day       smallint CHECK (month_day BETWEEN 1 AND 28),
  due_offset_days smallint NOT NULL DEFAULT 0 CHECK (due_offset_days BETWEEN 0 AND 30),
  next_run_on     date NOT NULL,
  active          boolean NOT NULL DEFAULT true,
  created_by      uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT work_task_recurrences_rule CHECK ((frequency = 'weekly' AND weekday IS NOT NULL AND month_day IS NULL)
                                            OR (frequency = 'monthly' AND month_day IS NOT NULL AND weekday IS NULL))
);
CREATE INDEX IF NOT EXISTS work_task_recurrences_due_idx ON work_task_recurrences(next_run_on) WHERE active;
ALTER TABLE work_task_recurrences ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS work_task_occurrences (
  recurrence_id uuid NOT NULL REFERENCES work_task_recurrences(id) ON DELETE CASCADE,
  occurs_on     date NOT NULL,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id       uuid REFERENCES project_tasks(id) ON DELETE SET NULL,
  PRIMARY KEY (recurrence_id, occurs_on)
);
ALTER TABLE work_task_occurrences ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS work_task_drafts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  context    text NOT NULL DEFAULT '' CHECK (char_length(context) <= 120),
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(payload) <= 65536),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS work_task_drafts_owner_idx ON work_task_drafts(profile_id, updated_at DESC);
ALTER TABLE work_task_drafts ENABLE ROW LEVEL SECURITY;

-- All work_* tables are reached through work_api() only (SECURITY DEFINER). The one
-- client-readable table is work_messages, for Realtime (policy in 3/3).

-- ── 6. Small helpers ──────────────────────────────────────────────────────
-- Errors carry a machine code in DETAIL (the web app shows MESSAGE and branches on DETAIL).
CREATE OR REPLACE FUNCTION work_fail(p_code text, p_message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%', p_message USING ERRCODE = 'P0001', DETAIL = p_code;
END;
$$;

CREATE OR REPLACE FUNCTION work_iso(p timestamptz)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT to_char(p AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
$$;

CREATE OR REPLACE FUNCTION work_name(p uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT NULLIF(btrim(concat_ws(' ', NULLIF(btrim(first_name), ''), NULLIF(btrim(middle_name), ''), NULLIF(btrim(last_name), ''))), '')
  FROM profiles WHERE id = p;
$$;

-- Everyone below p in the reporting tree (same walk as my_team_ids(), for any person).
CREATE OR REPLACE FUNCTION work_team_ids(p uuid)
RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH RECURSIVE tree(id, depth) AS (
    SELECT x.id, 1 FROM profiles x WHERE (x.manager_id = p OR x.hod_id = p) AND x.id <> p
    UNION
    SELECT x.id, t.depth + 1 FROM profiles x JOIN tree t ON x.manager_id = t.id
    WHERE t.depth < 10 AND x.id <> p
  )
  SELECT COALESCE(array_agg(DISTINCT id), '{}'::uuid[]) FROM tree;
$$;

CREATE OR REPLACE FUNCTION work_uuid(p text)
RETURNS uuid LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF p IS NULL OR p = '' THEN RETURN NULL; END IF;
  RETURN p::uuid;
EXCEPTION WHEN invalid_text_representation THEN
  RAISE EXCEPTION 'Not found.' USING ERRCODE = 'P0001', DETAIL = 'NOT_FOUND';
END;
$$;

CREATE OR REPLACE FUNCTION work_date(p text, p_field text DEFAULT 'date')
RETURNS date LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF p IS NULL OR p = '' THEN RETURN NULL; END IF;
  IF p !~ '^\d{4}-\d{2}-\d{2}$' THEN
    RAISE EXCEPTION 'Use YYYY-MM-DD for the %.', p_field USING ERRCODE = 'P0001', DETAIL = 'VALIDATION';
  END IF;
  RETURN p::date;
EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
  RAISE EXCEPTION 'That % does not exist.', p_field USING ERRCODE = 'P0001', DETAIL = 'VALIDATION';
END;
$$;

CREATE OR REPLACE FUNCTION work_uuids(p jsonb)
RETURNS uuid[] LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(ARRAY(SELECT DISTINCT work_uuid(x) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p) = 'array' THEN p ELSE '[]'::jsonb END) x), '{}'::uuid[]);
$$;

CREATE OR REPLACE FUNCTION work_settings_of(p_tenant uuid)
RETURNS work_settings LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s work_settings;
BEGIN
  SELECT * INTO s FROM work_settings WHERE tenant_id = p_tenant;
  IF NOT FOUND THEN
    s.tenant_id := p_tenant; s.task_visibility := 'restricted'; s.task_key_prefix := 'T';
    s.require_due_to_start := true; s.require_deliverable := true; s.reason_on_every_move := false;
    s.digest_enabled := false; s.digest_time := '21:15'; s.weekly_digest_dow := 1; s.next_task_number := 1;
  END IF;
  RETURN s;
END;
$$;

-- In-app notifications (these also become mobile pushes through the existing webhook).
CREATE OR REPLACE FUNCTION work_notify(p_tenant uuid, p_recipients uuid[], p_actor uuid, p_type text, p_title text, p_body text, p_link_key text, p_related uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO app_notifications (tenant_id, profile_id, actor_id, type, title, body, link_key, related_id)
  SELECT p_tenant, pr.id, p_actor, p_type, left(p_title, 200), left(p_body, 600), p_link_key, p_related
  FROM (SELECT DISTINCT unnest(p_recipients) AS r) x
  JOIN profiles pr ON pr.id = x.r AND pr.tenant_id = p_tenant AND pr.status = 'Active'
  WHERE x.r IS DISTINCT FROM p_actor;
$$;

-- ── 7. The flow (pure; same map as the platform's task-flow.ts) ───────────
-- Forward, no skipping: backlog / todo → in_progress → in_review → done.
-- Around it: blocked, sent back (rework), cancelled, reopen, restore.
CREATE OR REPLACE FUNCTION work_flow(p_from text)
RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_from
    WHEN 'backlog'     THEN ARRAY['todo','in_progress','cancelled']
    WHEN 'todo'        THEN ARRAY['backlog','in_progress','cancelled']
    WHEN 'in_progress' THEN ARRAY['todo','backlog','blocked','in_review','done','cancelled']
    WHEN 'blocked'     THEN ARRAY['in_progress','cancelled']
    WHEN 'in_review'   THEN ARRAY['in_progress','done','cancelled']
    WHEN 'done'        THEN ARRAY['in_progress']
    WHEN 'cancelled'   THEN ARRAY['todo','backlog']
    ELSE ARRAY[]::text[] END;
$$;

CREATE OR REPLACE FUNCTION work_move_kind(p_from text, p_to text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_to = 'cancelled' THEN 'cancel'
    WHEN p_from = 'cancelled' THEN 'restore'
    WHEN p_from = 'done' THEN 'reopen'
    WHEN p_from = 'in_review' AND p_to = 'done' THEN 'approve'
    WHEN p_from = 'in_review' AND p_to = 'in_progress' THEN 'send_back'   -- "withdraw" when the assignee does it
    WHEN p_to IN ('in_review','done') THEN 'submit'
    ELSE 'move' END;
$$;

CREATE OR REPLACE FUNCTION work_stage_label(p text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p WHEN 'backlog' THEN 'Backlog' WHEN 'todo' THEN 'To do' WHEN 'in_progress' THEN 'In progress'
                WHEN 'blocked' THEN 'Blocked' WHEN 'in_review' THEN 'Pending review' WHEN 'done' THEN 'Done'
                WHEN 'cancelled' THEN 'Cancelled' ELSE p END;
$$;

-- Who is asking, once per request.
DO $$ BEGIN
  CREATE TYPE work_ctx AS (me uuid, tenant uuid, role text, overseer boolean, team uuid[], today date, outlet uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- The caller's relation to one task.
DO $$ BEGIN
  CREATE TYPE work_actor AS (is_assignee boolean, is_creator boolean, is_manager boolean, can_approve boolean, project_admin boolean, project_member boolean);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- null when allowed, otherwise why not.
CREATE OR REPLACE FUNCTION work_who_may(p_kind text, a work_actor)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_kind = 'approve' THEN CASE WHEN a.can_approve THEN NULL ELSE 'Only the reviewer or a manager of the assignee can approve this task.' END
    WHEN p_kind = 'send_back' THEN CASE WHEN a.can_approve OR a.is_assignee THEN NULL ELSE 'Only the reviewer, a manager or the assignee can move this task back.' END
    WHEN p_kind IN ('cancel','reopen','restore') THEN CASE WHEN a.is_manager THEN NULL ELSE 'Only the task creator or a manager can do that.' END
    ELSE CASE WHEN a.is_assignee OR a.is_manager THEN NULL ELSE 'Only the assignee or a manager can change the status of this task.' END
  END;
$$;

CREATE OR REPLACE FUNCTION work_moves(p_from text, a work_actor)
RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(array_agg(x.t ORDER BY x.o), ARRAY[]::text[])
  FROM unnest(work_flow(p_from)) WITH ORDINALITY AS x(t, o)
  WHERE work_who_may(CASE WHEN work_move_kind(p_from, x.t) = 'send_back' AND a.is_assignee AND NOT a.can_approve THEN 'withdraw'
                          ELSE work_move_kind(p_from, x.t) END, a) IS NULL;
$$;

-- Deliverable links: http(s) only, trimmed, unique, at most 10. Stored in project_tasks.deliverables as [{url}].
CREATE OR REPLACE FUNCTION work_clean_links(p jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v text;
  out_ text[] := '{}';
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'array' THEN RETURN '[]'::jsonb; END IF;
  FOR v IN SELECT btrim(x) FROM jsonb_array_elements_text(p) x LOOP
    CONTINUE WHEN v = '';
    IF char_length(v) > 500 OR v !~* '^https?://\S+$' THEN
      PERFORM work_fail('VALIDATION', 'Links must be http(s) addresses, at most 10.');
    END IF;
    IF NOT v = ANY (out_) THEN out_ := out_ || v; END IF;
  END LOOP;
  IF cardinality(out_) > 10 THEN PERFORM work_fail('VALIDATION', 'Links must be http(s) addresses, at most 10.'); END IF;
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('url', u) ORDER BY o) FROM unnest(out_) WITH ORDINALITY AS x(u, o)), '[]'::jsonb);
END;
$$;

-- Labels: trimmed, lower-case, unique, at most 10 of 30 characters each.
CREATE OR REPLACE FUNCTION work_clean_labels(p jsonb)
RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(ARRAY(
    SELECT l FROM (
      SELECT DISTINCT ON (l) l, o FROM (
        SELECT left(regexp_replace(lower(btrim(x)), '[{}",\\]', '', 'g'), 30) AS l, o
        FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p) = 'array' THEN p ELSE '[]'::jsonb END) WITH ORDINALITY AS t(x, o)) a
      WHERE l <> '' ORDER BY l, o) b
    ORDER BY o LIMIT 10), '{}'::text[]);
$$;

-- ── 8. Recurrence dates (weekday: 0 = Sunday; month_day: 1–28) ────────────
CREATE OR REPLACE FUNCTION work_first_on_or_after(p_from date, p_frequency text, p_weekday int, p_month_day int)
RETURNS date LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_frequency = 'weekly'
    THEN p_from + ((p_weekday - extract(dow FROM p_from)::int + 7) % 7)
    ELSE CASE WHEN make_date(extract(year FROM p_from)::int, extract(month FROM p_from)::int, p_month_day) >= p_from
              THEN make_date(extract(year FROM p_from)::int, extract(month FROM p_from)::int, p_month_day)
              ELSE (make_date(extract(year FROM p_from)::int, extract(month FROM p_from)::int, p_month_day) + interval '1 month')::date END
  END;
$$;

-- "Monthly MIS · Oct 2026" / "Stand-up notes · 6 Oct 2026" (any older suffix is replaced).
CREATE OR REPLACE FUNCTION work_occurrence_title(p_title text, p_on date, p_frequency text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  WITH x AS (
    SELECT regexp_replace(p_title, '\s·\s(\d{1,2}\s)?[A-Z][a-z]{2}\s\d{4}$', '') AS base,
           CASE WHEN p_frequency = 'monthly' THEN to_char(p_on, 'Mon YYYY') ELSE to_char(p_on, 'FMDD Mon YYYY') END AS suffix)
  SELECT left(base, 250 - char_length(suffix) - 3) || ' · ' || suffix FROM x;
$$;

-- ── 9. Legacy guard: step aside for work_api() ────────────────────────────
-- Same functions as 20261005_2 with one early exit each, so direct writes (the app)
-- keep exactly the rules they had. Patched in place from the live definition
-- (line endings in the stored source vary, hence the regular expressions).
DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'trg_project_tasks_guard';
  IF v_def IS NULL THEN RAISE EXCEPTION 'trg_project_tasks_guard is missing — apply 20261005_2 first.'; END IF;
  IF position('crewcore.work_rpc' IN v_def) = 0 THEN
    v_def := regexp_replace(v_def, 'BEGIN(\r?\n)(\s*)v_trusted := v_uid IS NULL OR v_system;',
      'BEGIN\1\2-- work_api() applies the register rules itself (20261010_22).\1\2IF COALESCE(current_setting(''crewcore.work_rpc'', true), '''') = ''on'' THEN\1\2  NEW.updated_at := now();\1\2  RETURN NEW;\1\2END IF;\1\2v_trusted := v_uid IS NULL OR v_system;');
    IF position('crewcore.work_rpc' IN v_def) = 0 THEN
      RAISE EXCEPTION 'trg_project_tasks_guard has changed — add the work_rpc early exit by hand.';
    END IF;
    EXECUTE v_def;
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'trg_project_tasks_after';
  IF v_def IS NULL THEN RAISE EXCEPTION 'trg_project_tasks_after is missing — apply 20261005_2 first.'; END IF;
  IF position('crewcore.work_rpc' IN v_def) = 0 THEN
    v_def := regexp_replace(v_def, 'BEGIN(\r?\n)(\s*)SELECT btrim\(concat_ws\('' '', first_name, last_name\)\) INTO v_actor_name FROM profiles WHERE id = v_actor;',
      'BEGIN\1\2-- work_api() writes its own timeline, change log and notifications (20261010_22).\1\2IF COALESCE(current_setting(''crewcore.work_rpc'', true), '''') = ''on'' THEN\1\2  RETURN NEW;\1\2END IF;\1\2SELECT btrim(concat_ws('' '', first_name, last_name)) INTO v_actor_name FROM profiles WHERE id = v_actor;');
    IF position('crewcore.work_rpc' IN v_def) = 0 THEN
      RAISE EXCEPTION 'trg_project_tasks_after has changed — add the work_rpc early exit by hand.';
    END IF;
    EXECUTE v_def;
  END IF;
END $$;

-- ── 10. Sync triggers for direct writes (the app, service-role jobs) ──────
-- BEFORE (runs after project_tasks_guard — triggers fire in name order): numbers the task,
-- places it on the board and keeps the review bookkeeping the register reads.
CREATE OR REPLACE FUNCTION trg_project_tasks_work_sync()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_stage_old text;
  v_stage_new text;
BEGIN
  IF COALESCE(current_setting('crewcore.work_rpc', true), '') = 'on' THEN RETURN NEW; END IF;

  v_stage_new := CASE NEW.status WHEN 'To Do' THEN 'todo' WHEN 'In Progress' THEN 'in_progress' WHEN 'Blocked' THEN 'blocked'
                   WHEN 'Done' THEN CASE WHEN NEW.review_status = 'Pending' THEN 'in_review' ELSE 'done' END ELSE 'cancelled' END;

  IF TG_OP = 'INSERT' THEN
    NEW.is_backlog := false;
    IF NEW.number IS NULL THEN
      IF NEW.project_id IS NOT NULL THEN
        UPDATE projects SET next_task_number = next_task_number + 1 WHERE id = NEW.project_id
        RETURNING next_task_number - 1 INTO NEW.number;
      ELSE
        INSERT INTO work_settings (tenant_id, next_task_number) VALUES (NEW.tenant_id, 2)
        ON CONFLICT (tenant_id) DO UPDATE SET next_task_number = work_settings.next_task_number + 1
        RETURNING next_task_number - 1 INTO NEW.number;
      END IF;
    END IF;
    NEW.position := COALESCE((SELECT max(position) FROM project_tasks
                               WHERE tenant_id = NEW.tenant_id AND project_id IS NOT DISTINCT FROM NEW.project_id AND stage = v_stage_new), 0) + 1024;
    NEW.department := COALESCE(NEW.department, (SELECT department FROM profiles WHERE id = COALESCE(NEW.assigned_to, NEW.created_by)));
    NEW.status_changed_at := now();
    -- "started" means work began; a task created straight into Cancelled never started.
    IF NEW.status = 'Cancelled' THEN NEW.started_at := NULL; END IF;
    RETURN NEW;
  END IF;

  -- These belong to the register (work_api) and to nobody else.
  NEW.number := OLD.number;
  NEW.deleted_at := OLD.deleted_at; NEW.deleted_by := OLD.deleted_by;
  NEW.source_message_id := OLD.source_message_id; NEW.recurrence_id := OLD.recurrence_id;
  NEW.flagged_at := OLD.flagged_at; NEW.flag_reason := OLD.flag_reason; NEW.flagged_by := OLD.flagged_by;
  NEW.rework_count := OLD.rework_count; NEW.position := OLD.position; NEW.labels := OLD.labels;
  NEW.approver_id := OLD.approver_id; NEW.submitted_at := OLD.submitted_at; NEW.completed_late := OLD.completed_late;
  NEW.status_changed_at := OLD.status_changed_at;
  NEW.is_backlog := OLD.is_backlog AND NEW.status = 'To Do';

  v_stage_old := OLD.stage;
  IF v_stage_new = 'todo' AND NEW.is_backlog THEN v_stage_new := 'backlog'; END IF;

  IF NEW.assigned_to IS DISTINCT FROM OLD.assigned_to AND NEW.assigned_to IS NOT NULL THEN
    NEW.department := COALESCE((SELECT department FROM profiles WHERE id = NEW.assigned_to), OLD.department);
  END IF;

  IF v_stage_new IS DISTINCT FROM v_stage_old THEN
    NEW.status_changed_at := now();
    NEW.position := COALESCE((SELECT max(position) FROM project_tasks
                               WHERE tenant_id = NEW.tenant_id AND project_id IS NOT DISTINCT FROM NEW.project_id AND stage = v_stage_new), 0) + 1024;
    IF OLD.started_at IS NULL AND NEW.status = 'Cancelled' THEN NEW.started_at := NULL; END IF;
    IF v_stage_new IN ('in_review','done') AND v_stage_old NOT IN ('in_review','done') THEN
      NEW.submitted_at := now();
      NEW.completed_late := COALESCE(NEW.revised_due_date, NEW.due_date) < task_today();
    END IF;
    IF v_stage_new = 'in_review' THEN
      NEW.approver_id := task_default_approver(NEW.assigned_to, NEW.created_by, NEW.reviewer_id);
      NEW.completed_at := NULL;   -- done only once approved
    ELSIF v_stage_new = 'done' THEN
      NEW.approver_id := NULL;
      NEW.flagged_at := NULL; NEW.flag_reason := NULL; NEW.flagged_by := NULL;
    ELSIF v_stage_old = 'in_review' AND v_stage_new = 'in_progress' AND NEW.review_status = 'Sent back' THEN
      NEW.rework_count := OLD.rework_count + 1;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS project_tasks_work_sync ON project_tasks;
CREATE TRIGGER project_tasks_work_sync BEFORE INSERT OR UPDATE ON project_tasks
  FOR EACH ROW EXECUTE FUNCTION trg_project_tasks_work_sync();

-- AFTER: the status timeline and change log for direct writes.
CREATE OR REPLACE FUNCTION trg_project_tasks_work_log()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_kind text;
  v_changes jsonb := '{}'::jsonb;
BEGIN
  IF COALESCE(current_setting('crewcore.work_rpc', true), '') = 'on' THEN RETURN NEW; END IF;

  IF TG_OP = 'INSERT' THEN
    INSERT INTO work_task_history (tenant_id, task_id, kind, to_status, actor_id, note)
    VALUES (NEW.tenant_id, NEW.id, 'move', NEW.stage, v_actor, CASE WHEN NEW.repeat_of IS NOT NULL THEN 'Created by a repeating task' END);
    INSERT INTO work_task_activity (tenant_id, task_id, actor_id, action, changes)
    VALUES (NEW.tenant_id, NEW.id, v_actor, 'created', jsonb_build_object('title', NEW.title, 'status', NEW.stage));
    RETURN NEW;
  END IF;

  IF NEW.stage IS DISTINCT FROM OLD.stage THEN
    v_kind := work_move_kind(OLD.stage, NEW.stage);
    IF v_kind = 'send_back' AND v_actor IS NOT DISTINCT FROM NEW.assigned_to THEN v_kind := 'move'; END IF;
    INSERT INTO work_task_history (tenant_id, task_id, kind, from_status, to_status, reason, actor_id)
    VALUES (NEW.tenant_id, NEW.id, v_kind, OLD.stage, NEW.stage, left(NEW.status_note, 500), v_actor);
    v_changes := v_changes || jsonb_build_object('status', jsonb_build_object('from', OLD.stage, 'to', NEW.stage));
  END IF;
  IF NEW.title IS DISTINCT FROM OLD.title THEN
    v_changes := v_changes || jsonb_build_object('title', jsonb_build_object('from', OLD.title, 'to', NEW.title)); END IF;
  IF NEW.description IS DISTINCT FROM OLD.description THEN
    v_changes := v_changes || jsonb_build_object('description', jsonb_build_object('from', left(OLD.description, 300), 'to', left(NEW.description, 300))); END IF;
  IF NEW.priority IS DISTINCT FROM OLD.priority THEN
    v_changes := v_changes || jsonb_build_object('priority', jsonb_build_object('from', lower(OLD.priority), 'to', lower(NEW.priority))); END IF;
  IF NEW.assigned_to IS DISTINCT FROM OLD.assigned_to THEN
    v_changes := v_changes || jsonb_build_object('assignee_employee_id', jsonb_build_object('from', OLD.assigned_to, 'to', NEW.assigned_to)); END IF;
  IF NEW.reviewer_id IS DISTINCT FROM OLD.reviewer_id THEN
    v_changes := v_changes || jsonb_build_object('reviewer_employee_id', jsonb_build_object('from', OLD.reviewer_id, 'to', NEW.reviewer_id)); END IF;
  IF NEW.due_date IS DISTINCT FROM OLD.due_date THEN
    v_changes := v_changes || jsonb_build_object('due_date', jsonb_build_object('from', OLD.due_date, 'to', NEW.due_date)); END IF;
  IF NEW.revised_due_date IS DISTINCT FROM OLD.revised_due_date THEN
    v_changes := v_changes || jsonb_build_object('revised_due_date', jsonb_build_object('from', OLD.revised_due_date, 'to', NEW.revised_due_date));
    INSERT INTO work_task_history (tenant_id, task_id, kind, from_due, to_due, actor_id)
    VALUES (NEW.tenant_id, NEW.id, 'revise_due', COALESCE(OLD.revised_due_date, OLD.due_date), COALESCE(NEW.revised_due_date, NEW.due_date), v_actor);
  END IF;
  IF NEW.deliverables IS DISTINCT FROM OLD.deliverables THEN
    v_changes := v_changes || jsonb_build_object('links', jsonb_build_object('from', jsonb_array_length(OLD.deliverables), 'to', jsonb_array_length(NEW.deliverables))); END IF;
  IF NEW.waiting_on IS DISTINCT FROM OLD.waiting_on THEN
    v_changes := v_changes || jsonb_build_object('waiting_on', jsonb_build_object('from', cardinality(OLD.waiting_on), 'to', cardinality(NEW.waiting_on))); END IF;
  IF NEW.parent_task_id IS DISTINCT FROM OLD.parent_task_id THEN
    v_changes := v_changes || jsonb_build_object('parent_task_id', jsonb_build_object('from', OLD.parent_task_id, 'to', NEW.parent_task_id)); END IF;

  IF v_changes <> '{}'::jsonb THEN
    INSERT INTO work_task_activity (tenant_id, task_id, actor_id, action, changes)
    VALUES (NEW.tenant_id, NEW.id, v_actor, CASE WHEN v_changes ? 'status' THEN 'status_changed' ELSE 'updated' END, v_changes);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS project_tasks_work_log ON project_tasks;
CREATE TRIGGER project_tasks_work_log AFTER INSERT OR UPDATE ON project_tasks
  FOR EACH ROW EXECUTE FUNCTION trg_project_tasks_work_log();

REVOKE EXECUTE ON FUNCTION trg_project_tasks_work_sync() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION trg_project_tasks_work_log()  FROM PUBLIC, anon, authenticated;

-- ── 11. Backfill existing tasks ───────────────────────────────────────────
-- Numbers in creation order (per project, and per company for standalone tasks), a place
-- on the board, the department, and the first line of each timeline.
DO $$
DECLARE
  r record;
BEGIN
  PERFORM set_config('crewcore.work_rpc', 'on', true);
  FOR r IN SELECT id, tenant_id, project_id, assigned_to, created_by,
                  row_number() OVER (PARTITION BY tenant_id, project_id ORDER BY created_at, id) AS n
           FROM project_tasks WHERE number IS NULL LOOP
    UPDATE project_tasks t SET number = r.n, position = r.n * 1024,
           department = COALESCE(t.department, (SELECT department FROM profiles WHERE id = COALESCE(r.assigned_to, r.created_by))),
           status_changed_at = COALESCE(t.completed_at, t.started_at, t.created_at),
           approver_id = CASE WHEN t.status = 'Done' AND t.review_status = 'Pending'
                              THEN task_default_approver(t.assigned_to, t.created_by, t.reviewer_id) END,
           submitted_at = CASE WHEN t.status = 'Done' THEN COALESCE(t.completed_at, t.updated_at) END,
           completed_at = CASE WHEN t.status = 'Done' AND t.review_status = 'Pending' THEN NULL ELSE t.completed_at END
     WHERE t.id = r.id;
  END LOOP;
  PERFORM set_config('crewcore.work_rpc', 'off', true);

  UPDATE projects p SET next_task_number = GREATEST(p.next_task_number, COALESCE((SELECT max(number) FROM project_tasks t WHERE t.project_id = p.id), 0) + 1);
  INSERT INTO work_settings (tenant_id, next_task_number)
  SELECT tenant_id, max(number) + 1 FROM project_tasks WHERE project_id IS NULL AND number IS NOT NULL GROUP BY tenant_id
  ON CONFLICT (tenant_id) DO UPDATE SET next_task_number = GREATEST(work_settings.next_task_number, EXCLUDED.next_task_number);

  INSERT INTO work_task_history (tenant_id, task_id, kind, to_status, actor_id, at)
  SELECT t.tenant_id, t.id, 'move', 'todo', t.created_by, t.created_at
  FROM project_tasks t WHERE NOT EXISTS (SELECT 1 FROM work_task_history h WHERE h.task_id = t.id);
  INSERT INTO work_task_history (tenant_id, task_id, kind, from_status, to_status, reason, actor_id, at)
  SELECT a.tenant_id, a.task_id, 'move',
         CASE a.from_value WHEN 'To Do' THEN 'todo' WHEN 'In Progress' THEN 'in_progress' WHEN 'Blocked' THEN 'blocked' WHEN 'Done' THEN 'done' ELSE 'cancelled' END,
         CASE a.to_value WHEN 'To Do' THEN 'todo' WHEN 'In Progress' THEN 'in_progress' WHEN 'Blocked' THEN 'blocked' WHEN 'Done' THEN 'done' ELSE 'cancelled' END,
         NULLIF(left(a.body, 500), ''), a.actor_id, a.created_at
  FROM task_activity a
  WHERE a.kind = 'status'
    AND NOT EXISTS (SELECT 1 FROM work_task_history h WHERE h.task_id = a.task_id AND h.from_status IS NOT NULL);
  INSERT INTO work_task_comments (tenant_id, task_id, author_id, body, created_at)
  SELECT a.tenant_id, a.task_id, a.actor_id, a.body, a.created_at
  FROM task_activity a
  WHERE a.kind = 'comment' AND NOT EXISTS (SELECT 1 FROM work_task_comments c WHERE c.task_id = a.task_id AND c.created_at = a.created_at);
END $$;

ALTER TABLE project_tasks ALTER COLUMN number SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS project_tasks_number_uq ON project_tasks(tenant_id, COALESCE(project_id, '00000000-0000-0000-0000-000000000000'::uuid), number);

-- ── 12. The app must not see soft-deleted tasks ───────────────────────────
DROP POLICY IF EXISTS "project_tasks: involved people can select" ON project_tasks;
CREATE POLICY "project_tasks: involved people can select" ON project_tasks FOR SELECT USING (
  tenant_id = (SELECT my_tenant_id())
  AND deleted_at IS NULL
  AND (
    assigned_to = auth.uid()
    OR created_by = auth.uid()
    OR reviewer_id = auth.uid()
    OR approver_id = auth.uid()
    OR (SELECT my_role()) IN ('admin','superadmin')
    OR assigned_to = ANY ((SELECT my_team_ids())::uuid[])
    OR (project_id IS NOT NULL AND (
          (SELECT my_role()) = 'manager'
          OR EXISTS (SELECT 1 FROM project_members pm
                     WHERE pm.project_id = project_tasks.project_id AND pm.profile_id = auth.uid())))
  )
);

-- The daily reminder skips deleted tasks (patched in place from the live definition).
DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'task_send_due_reminders';
  IF v_def IS NOT NULL AND position('t.deleted_at IS NULL' IN v_def) = 0 THEN
    v_def := replace(v_def, 'WHERE t.status IN (''To Do'',''In Progress'',''Blocked'')',
                            'WHERE t.status IN (''To Do'',''In Progress'',''Blocked'') AND t.deleted_at IS NULL');
    IF position('t.deleted_at IS NULL' IN v_def) = 0 THEN
      RAISE EXCEPTION 'task_send_due_reminders has changed — add the deleted_at filter by hand.';
    END IF;
    EXECUTE v_def;
  END IF;
END $$;

REVOKE EXECUTE ON FUNCTION work_fail(text, text)            FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION work_team_ids(uuid)              FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION work_name(uuid)                  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION work_settings_of(uuid)           FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION work_notify(uuid, uuid[], uuid, text, text, text, text, uuid) FROM PUBLIC, anon, authenticated;
