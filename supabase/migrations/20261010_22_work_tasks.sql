-- =============================================================
-- Work 2/3: the task register and projects — the rules of the new CrewCore
-- platform (apps/api/src/modules/work: tasks.service, task-flow, task-store,
-- task-register.service, projects.service), as SECURITY DEFINER functions.
--
-- Nothing here is callable by clients: everything is reached through
-- work_api() (3/3), which resolves the caller once (work_ctx) and passes it in.
--
-- Who is who:
--   employee id  = profiles.id            reporter = created_by
--   assignee     = assigned_to            reviewer = reviewer_id
--   "manages"    = the assignee is in the caller's reporting tree
--   "overseer"   = HR / admin (role admin, superadmin)
-- Re-runnable.
-- =============================================================

-- ── 1. Caller, settings, access ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION work_ctx_load()
RETURNS work_ctx LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  c work_ctx;
  v_status text;
BEGIN
  SELECT p.id, p.tenant_id, p.role, p.outlet_id, p.status
    INTO c.me, c.tenant, c.role, c.outlet, v_status
  FROM profiles p WHERE p.id = auth.uid();
  IF c.me IS NULL OR c.tenant IS NULL OR v_status IS DISTINCT FROM 'Active' THEN
    PERFORM work_fail('FORBIDDEN', 'Work is for employees: your login has no employee record here.');
  END IF;
  c.overseer := c.role IN ('admin','superadmin');
  c.team := work_team_ids(c.me);
  c.today := task_today();
  RETURN c;
END;
$$;

DO $$ BEGIN
  CREATE TYPE work_project_access AS (id uuid, key text, name text, archived boolean, visibility text, channel_id uuid, role text);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The project and the caller's role in it; "not found" when it is not visible to them.
CREATE OR REPLACE FUNCTION work_project_for(c work_ctx, p_id uuid)
RETURNS work_project_access LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  a work_project_access;
BEGIN
  SELECT p.id, p.key, p.name, p.archived_at IS NOT NULL, p.visibility, p.channel_id, pm.role
    INTO a.id, a.key, a.name, a.archived, a.visibility, a.channel_id, a.role
  FROM projects p LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.profile_id = c.me
  WHERE p.id = p_id AND p.tenant_id = c.tenant AND (p.visibility = 'company' OR pm.profile_id IS NOT NULL);
  IF a.id IS NULL THEN PERFORM work_fail('NOT_FOUND', 'Project not found.'); END IF;
  RETURN a;
END;
$$;

CREATE OR REPLACE FUNCTION work_actor_of(t project_tasks, c work_ctx)
RETURNS work_actor LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  a work_actor;
  v_role text;
  v_manage boolean := COALESCE(t.assigned_to = ANY (c.team), false);
BEGIN
  IF t.project_id IS NOT NULL THEN
    SELECT role INTO v_role FROM project_members WHERE project_id = t.project_id AND profile_id = c.me;
  END IF;
  a.is_assignee := COALESCE(t.assigned_to = c.me, false);
  a.is_creator := COALESCE(t.created_by = c.me, false);
  a.project_member := v_role IS NOT NULL;
  a.project_admin := COALESCE(v_role = 'admin', false);
  a.is_manager := a.is_creator OR v_manage OR a.project_admin OR c.overseer;
  a.can_approve := NOT a.is_assignee AND (COALESCE(t.approver_id = c.me, false) OR v_manage OR c.overseer);
  RETURN a;
END;
$$;

-- Deleted tasks are never visible. Project tasks follow the project (an archived project
-- hides its tasks); standalone tasks follow the company setting.
CREATE OR REPLACE FUNCTION work_task_visible(t project_tasks, c work_ctx, s work_settings)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF t.deleted_at IS NOT NULL OR t.tenant_id IS DISTINCT FROM c.tenant THEN RETURN false; END IF;
  IF t.project_id IS NOT NULL THEN
    RETURN EXISTS (SELECT 1 FROM projects p
                   WHERE p.id = t.project_id AND p.archived_at IS NULL
                     AND (p.visibility = 'company'
                          OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.profile_id = c.me)));
  END IF;
  RETURN s.task_visibility = 'company' OR c.overseer
      OR COALESCE(t.assigned_to = c.me, false) OR COALESCE(t.created_by = c.me, false)
      OR COALESCE(t.reviewer_id = c.me, false) OR COALESCE(t.approver_id = c.me, false)
      OR COALESCE(t.assigned_to = ANY (c.team), false);
END;
$$;

CREATE OR REPLACE FUNCTION work_task_ref(t project_tasks, s work_settings)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((SELECT p.key FROM projects p WHERE p.id = t.project_id), s.task_key_prefix, 'T') || '-' || t.number;
$$;

-- One task the caller can see (row-locked when p_lock), else "not found".
CREATE OR REPLACE FUNCTION work_task_row(c work_ctx, s work_settings, p_id uuid, p_lock boolean DEFAULT false)
RETURNS project_tasks LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  t project_tasks;
BEGIN
  IF p_lock THEN PERFORM 1 FROM project_tasks WHERE id = p_id FOR UPDATE; END IF;
  SELECT * INTO t FROM project_tasks x WHERE x.id = p_id;
  IF t.id IS NULL OR NOT work_task_visible(t, c, s) THEN PERFORM work_fail('NOT_FOUND', 'Task not found.'); END IF;
  RETURN t;
END;
$$;

-- Goals a task is linked to. Filled in by the performance migration.
CREATE OR REPLACE FUNCTION work_task_goals(p_task uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$ SELECT '[]'::jsonb $$;

-- The register row as the web app reads it (same shape as the platform's task view).
CREATE OR REPLACE FUNCTION work_task_json(t project_tasks, c work_ctx, s work_settings)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  p projects;
  a work_actor := work_actor_of(t, c);
  v_sub_total int;
  v_sub_done int;
BEGIN
  IF t.project_id IS NOT NULL THEN SELECT * INTO p FROM projects WHERE id = t.project_id; END IF;
  SELECT count(*), count(*) FILTER (WHERE x.stage IN ('done','cancelled')) INTO v_sub_total, v_sub_done
  FROM project_tasks x WHERE x.parent_task_id = t.id AND x.deleted_at IS NULL;
  RETURN jsonb_build_object(
    'id', t.id,
    'key', COALESCE(p.key, s.task_key_prefix, 'T') || '-' || t.number,
    'project', CASE WHEN t.project_id IS NULL THEN NULL ELSE jsonb_build_object('id', p.id, 'key', p.key, 'name', p.name, 'color', p.color) END,
    'number', t.number,
    'title', t.title,
    'description', t.description,
    'status', t.stage,
    'priority', lower(t.priority),
    'assignee', CASE WHEN t.assigned_to IS NULL THEN NULL ELSE jsonb_build_object('employeeId', t.assigned_to, 'name', work_name(t.assigned_to)) END,
    'reporter', CASE WHEN t.created_by IS NULL THEN NULL ELSE jsonb_build_object('employeeId', t.created_by, 'name', work_name(t.created_by)) END,
    'reviewer', CASE WHEN t.reviewer_id IS NULL THEN NULL ELSE jsonb_build_object('employeeId', t.reviewer_id, 'name', work_name(t.reviewer_id)) END,
    'approver', CASE WHEN t.approver_id IS NULL THEN NULL ELSE jsonb_build_object('employeeId', t.approver_id, 'name', work_name(t.approver_id)) END,
    'department', CASE WHEN COALESCE(t.department, '') = '' THEN NULL ELSE jsonb_build_object('id', t.department, 'name', t.department) END,
    'dueDate', t.due_date,
    'revisedDueDate', t.revised_due_date,
    'effectiveDueDate', COALESCE(t.revised_due_date, t.due_date),
    'labels', to_jsonb(t.labels),
    'links', COALESCE((SELECT jsonb_agg(d->>'url') FROM jsonb_array_elements(t.deliverables) d WHERE d->>'url' IS NOT NULL), '[]'::jsonb),
    'parentTaskId', t.parent_task_id,
    'position', t.position,
    'sourceMessageId', t.source_message_id,
    'startedAt', work_iso(t.started_at),
    'submittedAt', work_iso(t.submitted_at),
    'approvedAt', CASE WHEN t.stage = 'done' AND t.review_status = 'Approved' THEN work_iso(t.reviewed_at) END,
    'completedAt', work_iso(t.completed_at),
    'completedLate', t.completed_late,
    'reworkCount', t.rework_count,
    'flag', CASE WHEN t.flagged_at IS NULL THEN NULL ELSE jsonb_build_object('at', work_iso(t.flagged_at), 'reason', t.flag_reason) END,
    'statusChangedAt', work_iso(t.status_changed_at),
    'repeats', EXISTS (SELECT 1 FROM work_task_recurrences rr WHERE rr.source_task_id = t.id AND rr.active),
    'createdAt', work_iso(t.created_at),
    'updatedAt', work_iso(t.updated_at),
    'subtasks', jsonb_build_object('total', v_sub_total, 'done', v_sub_done),
    'waitingOnOpen', (SELECT count(*) FROM project_tasks w WHERE w.id = ANY (t.waiting_on) AND w.deleted_at IS NULL AND w.stage NOT IN ('done','cancelled')),
    'comments', (SELECT count(*) FROM work_task_comments cm WHERE cm.task_id = t.id AND cm.deleted_at IS NULL),
    'version', 1,
    'can', jsonb_build_object(
      'edit', a.is_assignee OR a.is_manager OR a.project_member,
      'plan', a.is_manager,
      'approve', a.can_approve AND t.stage = 'in_review',
      'delete', a.is_manager,
      'moves', to_jsonb(work_moves(t.stage, a))));
END;
$$;

-- ── 2. Bookkeeping: change log, timeline, channel notes, alerts ───────────
CREATE OR REPLACE FUNCTION work_log(p_tenant uuid, p_task uuid, p_actor uuid, p_action text, p_changes jsonb)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO work_task_activity (tenant_id, task_id, actor_id, action, changes) VALUES (p_tenant, p_task, p_actor, p_action, COALESCE(p_changes, '{}'::jsonb));
$$;

CREATE OR REPLACE FUNCTION work_history(p_tenant uuid, p_task uuid, p_kind text, p_from text, p_to text, p_actor uuid,
                                        p_reason text DEFAULT NULL, p_note text DEFAULT NULL, p_from_due date DEFAULT NULL, p_to_due date DEFAULT NULL)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO work_task_history (tenant_id, task_id, kind, from_status, to_status, reason, note, from_due, to_due, actor_id)
  VALUES (p_tenant, p_task, p_kind, p_from, p_to, p_reason, left(p_note, 2000), p_from_due, p_to_due, p_actor);
$$;

-- Task events appear as system messages in the project channel, and in the thread of the
-- message a task was made from.
CREATE OR REPLACE FUNCTION work_post_system(p_tenant uuid, p_channel uuid, p_body text, p_task uuid DEFAULT NULL, p_thread_root uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_channel IS NULL THEN RETURN; END IF;
  INSERT INTO work_messages (tenant_id, channel_id, author_id, kind, body, task_id, thread_root_id)
  VALUES (p_tenant, p_channel, NULL, 'system', left(p_body, 8000), p_task, p_thread_root);
  IF p_thread_root IS NOT NULL THEN
    UPDATE work_messages SET reply_count = reply_count + 1, last_reply_at = now(), bumped_at = now() WHERE id = p_thread_root;
  ELSE
    UPDATE work_channels SET last_message_at = now() WHERE id = p_channel;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION work_notify_assigned(c work_ctx, t project_tasks, s work_settings, p_assignee uuid, p_system boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_assignee IS NULL OR (NOT p_system AND p_assignee = c.me) THEN RETURN; END IF;
  PERFORM work_notify(c.tenant, ARRAY[p_assignee], CASE WHEN p_system THEN NULL ELSE c.me END, 'task_assigned',
    CASE WHEN p_system THEN format('A repeating task %s is assigned to you', work_task_ref(t, s))
         ELSE format('%s assigned %s to you', COALESCE(work_name(c.me), 'Someone'), work_task_ref(t, s)) END,
    t.title, 'tasks', t.id);
END;
$$;

-- Stage alerts (always on): blocked → manager + HOD; sent for review → approver; outcomes → assignee.
CREATE OR REPLACE FUNCTION work_stage_alert(c work_ctx, t project_tasks, s work_settings, p_kind text, p_to text, p_reason text, p_approver uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_to uuid[] := '{}';
  v_event text;
  v_who text := COALESCE(work_name(c.me), 'Someone');
  v_ref text := work_task_ref(t, s);
  v_title text;
BEGIN
  IF p_to = 'blocked' THEN
    v_event := 'blocked';
    IF t.assigned_to IS NOT NULL THEN
      SELECT ARRAY[a.manager_id, a.hod_id] INTO v_to FROM profiles a WHERE a.id = t.assigned_to;
    ELSIF t.created_by IS NOT NULL THEN
      v_to := ARRAY[t.created_by];
    END IF;
  ELSIF p_kind = 'submit' AND p_to = 'in_review' AND p_approver IS NOT NULL THEN
    v_event := 'submitted'; v_to := ARRAY[p_approver];
  ELSIF p_kind IN ('approve','send_back','flag','reopen','cancel') THEN
    v_event := CASE p_kind WHEN 'send_back' THEN 'sent_back' WHEN 'approve' THEN 'approved' WHEN 'flag' THEN 'flagged'
                           WHEN 'reopen' THEN 'reopened' ELSE 'cancelled' END;
    v_to := ARRAY[t.assigned_to];
  END IF;
  IF v_event IS NULL THEN RETURN; END IF;
  v_title := CASE v_event
    WHEN 'blocked'   THEN format('%s marked %s as blocked', v_who, v_ref)
    WHEN 'submitted' THEN format('%s sent %s for your review', v_who, v_ref)
    WHEN 'approved'  THEN format('%s approved %s', v_who, v_ref)
    WHEN 'sent_back' THEN format('%s sent %s back for rework', v_who, v_ref)
    WHEN 'flagged'   THEN format('%s flagged %s as not done', v_who, v_ref)
    WHEN 'reopened'  THEN format('%s reopened %s', v_who, v_ref)
    ELSE format('%s cancelled %s', v_who, v_ref) END;
  PERFORM work_notify(c.tenant, v_to, c.me,
    CASE WHEN v_event IN ('submitted','approved','sent_back','flagged') THEN 'task_review' ELSE 'task_status' END,
    v_title, CASE WHEN p_reason IS NOT NULL THEN format('%s — “%s”', t.title, left(p_reason, 200)) ELSE t.title END, 'tasks', t.id);
END;
$$;

-- After a change: the change log, and the notes in the project channel / source thread.
CREATE OR REPLACE FUNCTION work_after_change(c work_ctx, t project_tasks, s work_settings, p_changes jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_who text := COALESCE(work_name(c.me), 'Someone');
  v_ref text := work_task_ref(t, s);
  v_channel uuid;
  v_source_channel uuid;
  v_to uuid;
  v_body text;
  v_status_to text := p_changes #>> '{status,to}';
BEGIN
  IF p_changes IS NULL OR p_changes = '{}'::jsonb THEN RETURN; END IF;
  PERFORM work_log(c.tenant, t.id, c.me, CASE WHEN p_changes ? 'status' THEN 'status_changed' ELSE 'updated' END, p_changes);
  IF t.project_id IS NOT NULL THEN SELECT channel_id INTO v_channel FROM projects WHERE id = t.project_id; END IF;
  IF t.source_message_id IS NOT NULL THEN SELECT channel_id INTO v_source_channel FROM work_messages WHERE id = t.source_message_id; END IF;

  IF p_changes ? 'status' THEN
    v_body := format('%s moved %s to %s', v_who, v_ref, work_stage_label(v_status_to));
    -- Done / Cancelled are news for the project channel; every note goes to the source thread.
    IF v_channel IS NOT NULL AND v_status_to IN ('done','cancelled') THEN
      PERFORM work_post_system(c.tenant, v_channel, v_body || ' · ' || t.title, t.id);
    END IF;
    IF v_source_channel IS NOT NULL THEN PERFORM work_post_system(c.tenant, v_source_channel, v_body, t.id, t.source_message_id); END IF;
  END IF;
  IF p_changes ? 'assignee_employee_id' THEN
    v_to := work_uuid(p_changes #>> '{assignee_employee_id,to}');
    v_body := CASE WHEN v_to IS NOT NULL THEN format('%s assigned %s to %s', v_who, v_ref, COALESCE(work_name(v_to), 'Someone'))
                   ELSE format('%s unassigned %s', v_who, v_ref) END;
    IF v_to IS NOT NULL AND v_to <> c.me THEN PERFORM work_notify_assigned(c, t, s, v_to); END IF;
    IF v_channel IS NOT NULL THEN PERFORM work_post_system(c.tenant, v_channel, v_body || ' · ' || t.title, t.id); END IF;
    IF v_source_channel IS NOT NULL THEN PERFORM work_post_system(c.tenant, v_source_channel, v_body, t.id, t.source_message_id); END IF;
  END IF;
END;
$$;

-- ── 3. Checks shared by create and edit ───────────────────────────────────
-- Who can be given a task. In a project: any active employee who can see it (members of a
-- private project). Standalone: yourself, anyone in your reporting tree, or anyone for HR.
CREATE OR REPLACE FUNCTION work_check_assignee(c work_ctx, p work_project_access, p_assignee uuid)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_assignee IS NULL THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles x WHERE x.id = p_assignee AND x.tenant_id = c.tenant AND x.status = 'Active') THEN
    PERFORM work_fail('ASSIGNEE_INVALID', 'That person is not an active employee.');
  END IF;
  IF p.id IS NOT NULL THEN
    IF p.visibility = 'private'
       AND NOT EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = p.id AND m.profile_id = p_assignee) THEN
      PERFORM work_fail('ASSIGNEE_INVALID', 'Only members of this private project can be assigned.');
    END IF;
    RETURN;
  END IF;
  IF NOT (p_assignee = c.me OR c.overseer OR p_assignee = ANY (c.team)) THEN
    PERFORM work_fail('ASSIGNEE_INVALID', 'You can give a task to yourself or to people in your team. Use a project to work with others.');
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION work_check_reviewer(c work_ctx, p_reviewer uuid, p_assignee uuid)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_reviewer IS NOT DISTINCT FROM p_assignee THEN PERFORM work_fail('VALIDATION', 'The reviewer cannot be the assignee.'); END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_reviewer AND tenant_id = c.tenant AND status = 'Active') THEN
    PERFORM work_fail('VALIDATION', 'The reviewer must be an active employee.');
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION work_check_parent(c work_ctx, p_project uuid, p_parent uuid, p_self uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  x project_tasks;
BEGIN
  IF p_parent = p_self THEN PERFORM work_fail('VALIDATION', 'A task cannot be its own parent.'); END IF;
  SELECT * INTO x FROM project_tasks
   WHERE id = p_parent AND tenant_id = c.tenant AND project_id IS NOT DISTINCT FROM p_project AND deleted_at IS NULL;
  IF x.id IS NULL THEN
    PERFORM work_fail('VALIDATION', CASE WHEN p_project IS NOT NULL THEN 'The parent must be a task in the same project.'
                                         ELSE 'The parent must be a task outside any project.' END);
  END IF;
  IF x.parent_task_id IS NOT NULL THEN PERFORM work_fail('VALIDATION', 'Sub-tasks go one level deep.'); END IF;
END;
$$;

CREATE OR REPLACE FUNCTION work_end_of(p_tenant uuid, p_project uuid, p_stage text)
RETURNS double precision LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(max(position), 0) + 1024 FROM project_tasks
   WHERE tenant_id = p_tenant AND project_id IS NOT DISTINCT FROM p_project AND stage = p_stage;
$$;

-- Approver: the named reviewer, else the creator (when not the assignee), else the
-- assignee's nearest active manager.
CREATE OR REPLACE FUNCTION work_resolve_approver(t project_tasks)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_at uuid := t.assigned_to;
  v_mgr uuid;
  v_status text;
  i int := 0;
BEGIN
  IF t.reviewer_id IS NOT NULL AND t.reviewer_id IS DISTINCT FROM t.assigned_to THEN RETURN t.reviewer_id; END IF;
  IF t.created_by IS NOT NULL AND t.created_by IS DISTINCT FROM t.assigned_to THEN RETURN t.created_by; END IF;
  IF t.assigned_to IS NULL THEN RETURN NULL; END IF;
  LOOP
    i := i + 1;
    SELECT m.id, m.status INTO v_mgr, v_status
    FROM profiles a JOIN profiles m ON m.id = a.manager_id WHERE a.id = v_at;
    EXIT WHEN v_mgr IS NULL OR i > 10 OR v_mgr = t.assigned_to;
    IF v_status = 'Active' THEN RETURN v_mgr; END IF;
    v_at := v_mgr;
  END LOOP;
  RETURN NULL;
END;
$$;

-- Done is refused while a sub-task or a task this one waits on is still open.
CREATE OR REPLACE FUNCTION work_assert_nothing_open(t project_tasks)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_subs int;
  v_deps int;
BEGIN
  SELECT count(*) INTO v_subs FROM project_tasks x
   WHERE x.parent_task_id = t.id AND x.deleted_at IS NULL AND x.stage NOT IN ('done','cancelled');
  SELECT count(*) INTO v_deps FROM project_tasks w
   WHERE w.id = ANY (t.waiting_on) AND w.deleted_at IS NULL AND w.stage NOT IN ('done','cancelled');
  IF v_subs > 0 OR v_deps > 0 THEN
    PERFORM work_fail('OPEN_DEPENDENCIES', 'Finish ' || concat_ws(' and ',
      CASE WHEN v_subs > 0 THEN v_subs || ' open sub-task' || CASE WHEN v_subs > 1 THEN 's' ELSE '' END END,
      CASE WHEN v_deps > 0 THEN v_deps || ' task' || CASE WHEN v_deps > 1 THEN 's' ELSE '' END || ' it is waiting on' END) || ' first.');
  END IF;
END;
$$;

-- ── 4. Create ─────────────────────────────────────────────────────────────
-- o: sourceMessageId, system (a repeating task), trustAssignee, recurrenceId, reporterId.
CREATE OR REPLACE FUNCTION work_task_insert(c work_ctx, i jsonb, o jsonb DEFAULT '{}'::jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s work_settings := work_settings_of(c.tenant);
  p work_project_access;
  v_project uuid := work_uuid(i->>'projectId');
  v_stage text := COALESCE(NULLIF(i->>'status', ''), 'todo');
  v_system boolean := COALESCE((o->>'system')::boolean, false);
  v_trust boolean := COALESCE((o->>'trustAssignee')::boolean, false);
  v_title text := btrim(COALESCE(i->>'title', ''));
  v_desc text := COALESCE(i->>'description', '');
  v_priority text := COALESCE(NULLIF(i->>'priority', ''), 'medium');
  v_due date := work_date(i->>'dueDate', 'due date');
  v_assignee uuid;
  v_reviewer uuid := work_uuid(i->>'reviewerEmployeeId');
  v_parent uuid := work_uuid(i->>'parentTaskId');
  v_reporter uuid;
  v_links jsonb := work_clean_links(i->'links');
  v_n int;
  v_id uuid := gen_random_uuid();
  t project_tasks;
BEGIN
  IF char_length(v_title) NOT BETWEEN 1 AND 250 THEN PERFORM work_fail('VALIDATION', 'A task needs a title of up to 250 characters.'); END IF;
  IF char_length(v_desc) > 20000 THEN PERFORM work_fail('VALIDATION', 'The description is too long.'); END IF;
  IF v_priority NOT IN ('urgent','high','medium','low','none') THEN PERFORM work_fail('VALIDATION', 'Unknown priority.'); END IF;
  IF v_project IS NOT NULL THEN
    p := work_project_for(c, v_project);
    IF p.archived THEN PERFORM work_fail('PROJECT_ARCHIVED', 'This project is archived.'); END IF;
  END IF;
  IF v_stage NOT IN ('backlog','todo','in_progress') THEN
    PERFORM work_fail('VALIDATION', 'New tasks start in Backlog, To do or In progress.');
  END IF;
  IF v_stage = 'in_progress' AND s.require_due_to_start AND v_due IS NULL THEN
    PERFORM work_fail('DUE_REQUIRED', 'Set a due date before starting this task.');
  END IF;
  -- A standalone task nobody was named for is the creator's own; an explicit null leaves it open.
  v_assignee := CASE WHEN NOT (i ? 'assigneeEmployeeId') AND p.id IS NULL AND NOT v_system THEN c.me
                     ELSE work_uuid(i->>'assigneeEmployeeId') END;
  IF NOT v_system AND NOT v_trust THEN PERFORM work_check_assignee(c, p, v_assignee); END IF;
  IF v_reviewer IS NOT NULL THEN PERFORM work_check_reviewer(c, v_reviewer, v_assignee); END IF;
  IF v_parent IS NOT NULL THEN PERFORM work_check_parent(c, p.id, v_parent); END IF;
  v_reporter := CASE WHEN o ? 'reporterId' THEN work_uuid(o->>'reporterId') ELSE c.me END;

  IF p.id IS NOT NULL THEN
    UPDATE projects SET next_task_number = next_task_number + 1 WHERE id = p.id RETURNING next_task_number - 1 INTO v_n;
  ELSE
    INSERT INTO work_settings (tenant_id, next_task_number) VALUES (c.tenant, 2)
    ON CONFLICT (tenant_id) DO UPDATE SET next_task_number = work_settings.next_task_number + 1
    RETURNING next_task_number - 1 INTO v_n;
  END IF;

  INSERT INTO project_tasks (id, tenant_id, project_id, number, title, description, status, is_backlog, priority, assigned_to, created_by,
                             reviewer_id, department, due_date, labels, deliverables, parent_task_id, position, source_message_id,
                             started_at, start_date, recurrence_id, source, status_changed_at)
  VALUES (v_id, c.tenant, p.id, v_n, v_title, v_desc,
          CASE v_stage WHEN 'in_progress' THEN 'In Progress' ELSE 'To Do' END, v_stage = 'backlog', initcap(v_priority),
          v_assignee, v_reporter, v_reviewer,
          (SELECT department FROM profiles WHERE id = COALESCE(v_assignee, v_reporter)),
          v_due, work_clean_labels(i->'labels'), v_links, v_parent, work_end_of(c.tenant, p.id, v_stage),
          work_uuid(o->>'sourceMessageId'),
          CASE WHEN v_stage = 'in_progress' THEN now() END, CASE WHEN v_stage = 'in_progress' THEN c.today END,
          work_uuid(o->>'recurrenceId'), CASE WHEN v_system THEN 'system' ELSE 'web' END, now())
  RETURNING * INTO t;

  IF i ? 'goalIds' AND jsonb_array_length(COALESCE(i->'goalIds', '[]'::jsonb)) > 0 THEN
    PERFORM work_set_goals(c, v_id, work_uuids(i->'goalIds'));
  END IF;
  PERFORM work_log(c.tenant, v_id, CASE WHEN v_system THEN NULL ELSE c.me END, 'created', jsonb_build_object('title', v_title, 'status', v_stage));
  PERFORM work_history(c.tenant, v_id, 'move', NULL, v_stage, CASE WHEN v_system THEN NULL ELSE c.me END, NULL,
                       CASE WHEN o->>'recurrenceId' IS NOT NULL THEN 'Created by a repeating task' END);
  IF p.id IS NOT NULL THEN
    PERFORM work_post_system(c.tenant, p.channel_id,
      format('%s created %s-%s · %s%s', CASE WHEN v_system THEN 'A repeating task' ELSE COALESCE(work_name(c.me), 'Someone') END, p.key, v_n, v_title,
             CASE WHEN v_assignee IS NOT NULL THEN ' — assigned to ' || COALESCE(work_name(v_assignee), 'Someone') ELSE '' END), v_id);
  END IF;
  IF v_assignee IS NOT NULL AND v_assignee <> c.me THEN PERFORM work_notify_assigned(c, t, s, v_assignee, v_system); END IF;
  RETURN v_id;
END;
$$;

-- Goal links arrive with the performance migration; until then linking is refused.
CREATE OR REPLACE FUNCTION work_set_goals(c work_ctx, p_task uuid, p_goals uuid[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF cardinality(p_goals) > 0 THEN PERFORM work_fail('VALIDATION', 'One of those goals does not exist.'); END IF;
END;
$$;

-- ── 5. The flow: every status change ──────────────────────────────────────
-- The map, who may, reasons, dates, review, dependencies, the timeline and alerts.
-- Returns the follow-up task id when an approval created one.
CREATE OR REPLACE FUNCTION work_task_apply_transition(c work_ctx, t project_tasks, s work_settings, i jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_from text := t.stage;
  v_to text := i->>'to';
  a work_actor := work_actor_of(t, c);
  v_kind text;
  v_denied text;
  v_reason text := NULLIF(btrim(COALESCE(i->>'reason', '')), '');
  v_note text := NULLIF(btrim(COALESCE(i->>'note', '')), '');
  v_due date := t.due_date;
  v_links jsonb := t.deliverables;
  v_final text;
  v_approver uuid;
  v_late boolean := false;
  v_started boolean;
  v_follow jsonb := i->'followUp';
  v_follow_assignee uuid;
  n project_tasks;
BEGIN
  IF v_to IS NULL OR v_to NOT IN ('backlog','todo','in_progress','blocked','in_review','done','cancelled') THEN
    PERFORM work_fail('VALIDATION', 'Unknown status.');
  END IF;
  IF v_from = v_to THEN RETURN NULL; END IF;
  IF NOT v_to = ANY (work_flow(v_from)) THEN
    PERFORM work_fail('INVALID_MOVE', format('A task cannot move from %s to %s.%s', work_stage_label(v_from), work_stage_label(v_to),
                      CASE WHEN v_from IN ('backlog','todo') THEN ' Start it first.' ELSE '' END));
  END IF;
  v_kind := work_move_kind(v_from, v_to);
  IF v_kind = 'send_back' AND a.is_assignee AND NOT a.can_approve THEN v_kind := 'withdraw'; END IF;
  v_denied := work_who_may(v_kind, a);
  IF v_denied IS NOT NULL THEN PERFORM work_fail('FORBIDDEN', v_denied); END IF;

  IF v_reason IS NOT NULL AND char_length(v_reason) NOT BETWEEN 4 AND 500 THEN
    PERFORM work_fail('VALIDATION', 'A reason is 4–500 characters.');
  END IF;
  IF v_note IS NOT NULL AND char_length(v_note) > 2000 THEN PERFORM work_fail('VALIDATION', 'The note is too long.'); END IF;

  -- Due date: needed once work starts; the caller may provide it in the same move.
  v_started := v_to IN ('in_progress','blocked','in_review','done');
  IF v_started AND v_due IS NULL AND NULLIF(i->>'dueDate', '') IS NOT NULL THEN
    IF NOT (a.is_assignee OR a.is_manager) THEN PERFORM work_fail('FORBIDDEN', 'Only the assignee or a manager can set the due date.'); END IF;
    v_due := work_date(i->>'dueDate', 'due date');
  END IF;
  IF v_started AND v_due IS NULL AND s.require_due_to_start THEN
    PERFORM work_fail('DUE_REQUIRED', 'Set a due date before starting this task.');
  END IF;
  IF i ? 'links' THEN v_links := work_clean_links(i->'links'); END IF;

  v_final := v_to;
  IF v_kind = 'submit' THEN
    v_late := COALESCE(c.today > COALESCE(t.revised_due_date, v_due), false);
    PERFORM work_assert_nothing_open(t);
    v_approver := work_resolve_approver(t);
    -- No approver, or the approver is the one completing: done straight away.
    v_final := CASE WHEN v_approver IS NOT NULL AND v_approver <> c.me THEN 'in_review' ELSE 'done' END;
    IF v_final = 'in_review' AND s.require_deliverable AND jsonb_array_length(v_links) = 0 AND v_note IS NULL THEN
      PERFORM work_fail('DELIVERABLE_REQUIRED', 'Add a link to the work, or a completion note, before sending it for review.');
    END IF;
  END IF;
  IF v_kind = 'approve' THEN PERFORM work_assert_nothing_open(t); END IF;

  IF v_reason IS NULL AND (s.reason_on_every_move OR v_final = 'blocked' OR v_kind IN ('send_back','cancel','reopen')
                           OR (v_kind = 'submit' AND v_late)) THEN
    PERFORM work_fail('REASON_REQUIRED', CASE
      WHEN v_final = 'blocked' THEN 'Say what is blocking the task.'
      WHEN v_kind = 'send_back' THEN 'Say what needs to be redone.'
      WHEN v_kind = 'cancel' THEN 'Say why the task is cancelled.'
      WHEN v_kind = 'reopen' THEN 'Say why the task is reopened.'
      WHEN v_late THEN 'The task is past its due date: say why it finished late.'
      ELSE 'Give a reason for this move.' END);
  END IF;

  v_started := v_final IN ('in_progress','blocked','in_review','done');
  UPDATE project_tasks x SET
    due_date = v_due,
    deliverables = v_links,
    status = CASE v_final WHEN 'backlog' THEN 'To Do' WHEN 'todo' THEN 'To Do' WHEN 'in_progress' THEN 'In Progress'
                          WHEN 'blocked' THEN 'Blocked' WHEN 'cancelled' THEN 'Cancelled' ELSE 'Done' END,
    is_backlog = (v_final = 'backlog'),
    review_status = CASE WHEN v_final = 'in_review' THEN 'Pending' WHEN v_final = 'done' THEN 'Approved'
                         WHEN v_kind = 'send_back' THEN 'Sent back' END,
    reviewed_by = CASE WHEN v_final = 'done' THEN CASE WHEN v_kind = 'approve' OR v_approver = c.me THEN c.me END
                       WHEN v_kind = 'send_back' THEN c.me END,
    reviewed_at = CASE WHEN v_final = 'done' OR v_kind = 'send_back' THEN now() END,
    status_note = v_reason,
    status_changed_at = now(),
    position = work_end_of(c.tenant, x.project_id, v_final),
    completed_at = CASE WHEN v_final = 'done' THEN now() END,
    started_at = CASE WHEN v_started AND x.started_at IS NULL THEN now() ELSE x.started_at END,
    start_date = CASE WHEN v_started AND x.started_at IS NULL THEN COALESCE(x.start_date, c.today) ELSE x.start_date END,
    submitted_at = CASE WHEN v_kind = 'submit' THEN now() ELSE x.submitted_at END,
    completed_late = CASE WHEN v_kind = 'submit' THEN v_late ELSE x.completed_late END,
    approver_id = CASE WHEN v_kind = 'submit' THEN CASE WHEN v_final = 'in_review' THEN v_approver END ELSE x.approver_id END,
    flagged_at = CASE WHEN v_final = 'done' THEN NULL ELSE x.flagged_at END,
    flag_reason = CASE WHEN v_final = 'done' THEN NULL ELSE x.flag_reason END,
    flagged_by = CASE WHEN v_final = 'done' THEN NULL ELSE x.flagged_by END,
    rework_count = x.rework_count + CASE WHEN v_kind = 'send_back' THEN 1 ELSE 0 END
  WHERE x.id = t.id
  RETURNING * INTO n;

  PERFORM work_history(c.tenant, t.id, CASE WHEN v_kind = 'withdraw' THEN 'move' ELSE v_kind END, v_from, v_final, c.me, v_reason, v_note);
  IF v_due IS DISTINCT FROM t.due_date THEN
    PERFORM work_history(c.tenant, t.id, 'revise_due', NULL, NULL, c.me, NULL, 'Due date set when work started', t.due_date, v_due);
  END IF;
  PERFORM work_after_change(c, n, s, jsonb_build_object('status', jsonb_build_object('from', v_from, 'to', v_final)));
  PERFORM work_stage_alert(c, n, s, v_kind, v_final, v_reason, v_approver);

  -- Approval may hand over to the next task right away (a sub-task of the approved one, or its sibling).
  IF v_kind = 'approve' AND NULLIF(btrim(COALESCE(v_follow->>'title', '')), '') IS NOT NULL THEN
    v_follow_assignee := COALESCE(work_uuid(v_follow->>'assigneeEmployeeId'), t.assigned_to);
    RETURN work_task_insert(c, jsonb_build_object(
      'projectId', t.project_id, 'title', v_follow->>'title', 'assigneeEmployeeId', v_follow_assignee,
      'dueDate', NULLIF(v_follow->>'dueDate', ''), 'parentTaskId', COALESCE(t.parent_task_id, t.id), 'status', 'todo'),
      jsonb_build_object('trustAssignee', v_follow_assignee IS NOT DISTINCT FROM t.assigned_to));
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION work_task_transition(c work_ctx, p_id uuid, i jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s work_settings := work_settings_of(c.tenant);
  t project_tasks := work_task_row(c, s, p_id, true);
BEGIN
  IF t.project_id IS NOT NULL AND (work_project_for(c, t.project_id)).archived THEN
    PERFORM work_fail('PROJECT_ARCHIVED', 'This project is archived.');
  END IF;
  RETURN work_task_apply_transition(c, t, s, i);
END;
$$;

-- ── 6. Edit ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION work_task_update(c work_ctx, p_id uuid, i jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s work_settings := work_settings_of(c.tenant);
  t project_tasks;
  p work_project_access;
  a work_actor;
  v_editor boolean;
  v_changes jsonb := '{}'::jsonb;
  v_self_assign boolean;
  v_rest jsonb := i - 'status' - 'reason';
  n_title text; n_desc text; n_priority text; n_labels text[]; n_links jsonb;
  n_assignee uuid; n_reviewer uuid; n_parent uuid; n_due date; n_department text;
BEGIN
  -- Status goes through the rules; other fields in the same request are applied first.
  IF i ? 'status' THEN
    IF v_rest <> '{}'::jsonb THEN PERFORM work_task_update(c, p_id, v_rest); END IF;
    PERFORM work_task_transition(c, p_id, jsonb_build_object('to', i->>'status', 'reason', i->>'reason'));
    RETURN;
  END IF;

  t := work_task_row(c, s, p_id, true);
  IF t.project_id IS NOT NULL THEN
    p := work_project_for(c, t.project_id);
    IF p.archived THEN PERFORM work_fail('PROJECT_ARCHIVED', 'This project is archived.'); END IF;
  END IF;
  a := work_actor_of(t, c);
  v_editor := a.is_assignee OR a.is_manager OR a.project_member;
  n_title := t.title; n_desc := t.description; n_priority := lower(t.priority); n_labels := t.labels; n_links := t.deliverables;
  n_assignee := t.assigned_to; n_reviewer := t.reviewer_id; n_parent := t.parent_task_id; n_due := t.due_date; n_department := t.department;

  -- Taking an unassigned task for yourself is always allowed to someone who can edit it.
  IF i ? 'assigneeEmployeeId' AND work_uuid(i->>'assigneeEmployeeId') IS DISTINCT FROM t.assigned_to THEN
    n_assignee := work_uuid(i->>'assigneeEmployeeId');
    v_self_assign := n_assignee IS NOT DISTINCT FROM c.me AND t.assigned_to IS NULL AND v_editor;
    PERFORM work_check_assignee(c, p, n_assignee);
    IF NOT v_self_assign AND NOT a.is_manager THEN PERFORM work_fail('FORBIDDEN', 'Only the task creator or a manager can reassign this task.'); END IF;
    v_changes := v_changes || jsonb_build_object('assignee_employee_id', jsonb_build_object('from', t.assigned_to, 'to', n_assignee));
    n_department := COALESCE((SELECT department FROM profiles WHERE id = n_assignee), t.department);
  END IF;
  IF NULLIF(i->>'reviewerEmployeeId', '') IS NOT NULL THEN PERFORM work_check_reviewer(c, work_uuid(i->>'reviewerEmployeeId'), n_assignee); END IF;
  IF NULLIF(i->>'parentTaskId', '') IS NOT NULL THEN PERFORM work_check_parent(c, t.project_id, work_uuid(i->>'parentTaskId'), p_id); END IF;

  IF i ? 'title' AND btrim(COALESCE(i->>'title', '')) IS DISTINCT FROM t.title THEN
    n_title := btrim(COALESCE(i->>'title', ''));
    IF char_length(n_title) NOT BETWEEN 1 AND 250 THEN PERFORM work_fail('VALIDATION', 'A task needs a title of up to 250 characters.'); END IF;
    IF NOT v_editor THEN PERFORM work_fail('FORBIDDEN', 'You cannot edit this task.'); END IF;
    v_changes := v_changes || jsonb_build_object('title', jsonb_build_object('from', t.title, 'to', n_title));
  END IF;
  IF i ? 'description' AND COALESCE(i->>'description', '') IS DISTINCT FROM t.description THEN
    n_desc := COALESCE(i->>'description', '');
    IF char_length(n_desc) > 20000 THEN PERFORM work_fail('VALIDATION', 'The description is too long.'); END IF;
    IF NOT v_editor THEN PERFORM work_fail('FORBIDDEN', 'You cannot edit this task.'); END IF;
    v_changes := v_changes || jsonb_build_object('description', jsonb_build_object('from', left(t.description, 300), 'to', left(n_desc, 300)));
  END IF;
  IF i ? 'priority' AND COALESCE(i->>'priority', 'medium') IS DISTINCT FROM lower(t.priority) THEN
    n_priority := COALESCE(i->>'priority', 'medium');
    IF n_priority NOT IN ('urgent','high','medium','low','none') THEN PERFORM work_fail('VALIDATION', 'Unknown priority.'); END IF;
    IF NOT v_editor THEN PERFORM work_fail('FORBIDDEN', 'You cannot edit this task.'); END IF;
    v_changes := v_changes || jsonb_build_object('priority', jsonb_build_object('from', lower(t.priority), 'to', n_priority));
  END IF;
  IF i ? 'labels' AND work_clean_labels(i->'labels') IS DISTINCT FROM t.labels THEN
    n_labels := work_clean_labels(i->'labels');
    IF NOT v_editor THEN PERFORM work_fail('FORBIDDEN', 'You cannot edit this task.'); END IF;
    v_changes := v_changes || jsonb_build_object('labels', jsonb_build_object('from', to_jsonb(t.labels), 'to', to_jsonb(n_labels)));
  END IF;
  IF i ? 'links' AND work_clean_links(i->'links') IS DISTINCT FROM t.deliverables THEN
    n_links := work_clean_links(i->'links');
    IF NOT v_editor THEN PERFORM work_fail('FORBIDDEN', 'You cannot edit this task.'); END IF;
    v_changes := v_changes || jsonb_build_object('links', jsonb_build_object('from', jsonb_array_length(t.deliverables), 'to', jsonb_array_length(n_links)));
  END IF;
  IF i ? 'reviewerEmployeeId' AND work_uuid(i->>'reviewerEmployeeId') IS DISTINCT FROM t.reviewer_id THEN
    n_reviewer := work_uuid(i->>'reviewerEmployeeId');
    IF NOT a.is_manager THEN PERFORM work_fail('FORBIDDEN', 'Only the task creator or a manager can change the reviewer.'); END IF;
    v_changes := v_changes || jsonb_build_object('reviewer_employee_id', jsonb_build_object('from', t.reviewer_id, 'to', n_reviewer));
  END IF;
  IF i ? 'parentTaskId' AND work_uuid(i->>'parentTaskId') IS DISTINCT FROM t.parent_task_id THEN
    n_parent := work_uuid(i->>'parentTaskId');
    IF NOT a.is_manager THEN PERFORM work_fail('FORBIDDEN', 'Only the task creator or a manager can change the parent task.'); END IF;
    v_changes := v_changes || jsonb_build_object('parent_task_id', jsonb_build_object('from', t.parent_task_id, 'to', n_parent));
  END IF;
  IF i ? 'dueDate' AND work_date(i->>'dueDate', 'due date') IS DISTINCT FROM t.due_date THEN
    n_due := work_date(i->>'dueDate', 'due date');
    -- The original due date is the commitment: editable before work starts, then frozen (a revision instead).
    -- A task that started without one may get it once, from its assignee or a manager.
    IF t.started_at IS NOT NULL AND t.due_date IS NOT NULL THEN
      PERFORM work_fail('DUE_FROZEN', 'Work has started, so the original due date is fixed. Ask a manager to set a revised due date.');
    END IF;
    IF t.started_at IS NULL AND t.due_date IS NOT NULL AND NOT a.is_manager AND NOT a.is_assignee THEN
      PERFORM work_fail('FORBIDDEN', 'Only the assignee or a manager can change the due date.');
    END IF;
    IF t.started_at IS NOT NULL AND NOT a.is_manager AND NOT a.is_assignee THEN
      PERFORM work_fail('FORBIDDEN', 'Only the assignee or a manager can set the due date.');
    END IF;
    IF t.started_at IS NULL AND t.due_date IS NULL AND NOT v_editor THEN PERFORM work_fail('FORBIDDEN', 'You cannot edit this task.'); END IF;
    IF t.revised_due_date IS NOT NULL AND n_due IS NOT NULL AND n_due > t.revised_due_date THEN
      PERFORM work_fail('VALIDATION', 'The due date cannot be after the revised due date.');
    END IF;
    v_changes := v_changes || jsonb_build_object('due_date', jsonb_build_object('from', t.due_date, 'to', n_due));
  END IF;
  IF i ? 'goalIds' THEN
    IF NOT v_editor THEN PERFORM work_fail('FORBIDDEN', 'You cannot edit this task.'); END IF;
    PERFORM work_set_goals(c, p_id, work_uuids(i->'goalIds'));
    v_changes := v_changes || jsonb_build_object('goals', jsonb_build_object('from', NULL, 'to', jsonb_array_length(COALESCE(i->'goalIds', '[]'::jsonb))));
  END IF;

  IF v_changes = '{}'::jsonb THEN RETURN; END IF;
  UPDATE project_tasks SET title = n_title, description = n_desc, priority = initcap(n_priority), labels = n_labels, deliverables = n_links,
         assigned_to = n_assignee, department = n_department, reviewer_id = n_reviewer, parent_task_id = n_parent, due_date = n_due
   WHERE id = p_id RETURNING * INTO t;
  PERFORM work_after_change(c, t, s, v_changes);
END;
$$;

-- A reviewer marks a submission as not really done: the owner is told, the chip stays until approval.
CREATE OR REPLACE FUNCTION work_task_flag(c work_ctx, p_id uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s work_settings := work_settings_of(c.tenant);
  t project_tasks := work_task_row(c, s, p_id, true);
  v_reason text := btrim(COALESCE(p_reason, ''));
BEGIN
  IF t.stage <> 'in_review' THEN PERFORM work_fail('NOT_IN_REVIEW', 'Only a task waiting for review can be flagged.'); END IF;
  IF NOT (work_actor_of(t, c)).can_approve THEN PERFORM work_fail('FORBIDDEN', 'Only the reviewer or a manager of the assignee can flag this task.'); END IF;
  IF char_length(v_reason) NOT BETWEEN 4 AND 500 THEN PERFORM work_fail('VALIDATION', 'A reason is 4–500 characters.'); END IF;
  UPDATE project_tasks SET flagged_at = now(), flag_reason = v_reason, flagged_by = c.me WHERE id = p_id RETURNING * INTO t;
  PERFORM work_history(c.tenant, p_id, 'flag', t.stage, t.stage, c.me, v_reason);
  PERFORM work_stage_alert(c, t, s, 'flag', t.stage, v_reason, NULL);
END;
$$;

-- Re-planning: a revised due date (never before the original), by a task manager, with a reason.
CREATE OR REPLACE FUNCTION work_task_revise_due(c work_ctx, p_id uuid, p_revised date, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s work_settings := work_settings_of(c.tenant);
  t project_tasks := work_task_row(c, s, p_id, true);
  v_reason text := btrim(COALESCE(p_reason, ''));
BEGIN
  IF NOT (work_actor_of(t, c)).is_manager THEN PERFORM work_fail('FORBIDDEN', 'Only the task creator or a manager can revise the due date.'); END IF;
  IF t.due_date IS NULL THEN PERFORM work_fail('NO_DUE_DATE', 'Set the due date first; a revision changes an existing commitment.'); END IF;
  IF t.stage IN ('done','cancelled') THEN PERFORM work_fail('TASK_CLOSED', 'The task is finished.'); END IF;
  IF p_revised IS NOT NULL AND p_revised < t.due_date THEN PERFORM work_fail('VALIDATION', 'A revised due date cannot be before the original due date.'); END IF;
  IF char_length(v_reason) NOT BETWEEN 4 AND 500 THEN PERFORM work_fail('VALIDATION', 'A reason is 4–500 characters.'); END IF;
  IF p_revised IS NOT DISTINCT FROM t.revised_due_date THEN RETURN; END IF;
  UPDATE project_tasks SET revised_due_date = p_revised WHERE id = p_id;
  PERFORM work_history(c.tenant, p_id, 'revise_due', NULL, NULL, c.me, v_reason, NULL, COALESCE(t.revised_due_date, t.due_date), COALESCE(p_revised, t.due_date));
  PERFORM work_log(c.tenant, p_id, c.me, 'updated', jsonb_build_object('revised_due_date', jsonb_build_object('from', t.revised_due_date, 'to', p_revised)));
END;
$$;

-- Board drag and drop: a new column and/or a place between two cards. Column changes follow the flow.
CREATE OR REPLACE FUNCTION work_task_move(c work_ctx, p_id uuid, i jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s work_settings := work_settings_of(c.tenant);
  t project_tasks := work_task_row(c, s, p_id, true);
  v_to text := i->>'status';
  v_stage text;
  v_above double precision;
  v_below double precision;
BEGIN
  IF t.project_id IS NOT NULL AND (work_project_for(c, t.project_id)).archived THEN
    PERFORM work_fail('PROJECT_ARCHIVED', 'This project is archived.');
  END IF;
  IF v_to IS DISTINCT FROM t.stage THEN
    PERFORM work_task_apply_transition(c, t, s, jsonb_build_object('to', v_to, 'reason', i->>'reason', 'dueDate', i->>'dueDate'));
  END IF;
  SELECT stage INTO v_stage FROM project_tasks WHERE id = p_id;
  IF v_stage IS DISTINCT FROM v_to THEN RETURN; END IF;   -- a "done" drop that went to review stays where review put it
  SELECT position INTO v_above FROM project_tasks
   WHERE id = work_uuid(i->>'beforeId') AND tenant_id = c.tenant AND project_id IS NOT DISTINCT FROM t.project_id AND stage = v_stage;
  SELECT position INTO v_below FROM project_tasks
   WHERE id = work_uuid(i->>'afterId') AND tenant_id = c.tenant AND project_id IS NOT DISTINCT FROM t.project_id AND stage = v_stage;
  IF v_above IS NULL AND v_below IS NULL THEN RETURN; END IF;
  UPDATE project_tasks SET position = CASE WHEN v_above IS NOT NULL AND v_below IS NOT NULL THEN (v_above + v_below) / 2
                                           WHEN v_above IS NOT NULL THEN v_above + 1024 ELSE v_below - 1024 END
   WHERE id = p_id;
END;
$$;

-- ── 7. Delete / undo (nothing is hard deleted) ────────────────────────────
CREATE OR REPLACE FUNCTION work_task_remove(c work_ctx, p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s work_settings := work_settings_of(c.tenant);
  t project_tasks := work_task_row(c, s, p_id, true);
BEGIN
  IF NOT (work_actor_of(t, c)).is_manager THEN PERFORM work_fail('FORBIDDEN', 'Only the task creator or a manager can delete this task.'); END IF;
  IF t.source_message_id IS NOT NULL THEN PERFORM work_fail('TASK_FROM_MESSAGE', 'This task was created from a message; cancel it instead.'); END IF;
  UPDATE project_tasks SET deleted_at = now(), deleted_by = c.me WHERE (id = p_id OR parent_task_id = p_id) AND deleted_at IS NULL;
  UPDATE work_task_recurrences SET active = false WHERE source_task_id = p_id;
  PERFORM work_log(c.tenant, p_id, c.me, 'deleted', '{}'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION work_task_undelete(c work_ctx, p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  t project_tasks;
BEGIN
  SELECT * INTO t FROM project_tasks WHERE id = p_id AND tenant_id = c.tenant AND deleted_at IS NOT NULL FOR UPDATE;
  IF t.id IS NULL OR NOT (COALESCE(t.deleted_by = c.me, false) OR COALESCE(t.created_by = c.me, false) OR c.overseer) THEN
    PERFORM work_fail('NOT_FOUND', 'Task not found.');
  END IF;
  UPDATE project_tasks SET deleted_at = NULL, deleted_by = NULL WHERE (id = p_id OR parent_task_id = p_id) AND deleted_at IS NOT NULL;
  PERFORM work_log(c.tenant, p_id, c.me, 'restored', '{}'::jsonb);
END;
$$;

-- ── 8. Dependencies ("waiting on") ────────────────────────────────────────
-- Replaces the tasks this one waits on (no cycles, at most 20, each must be visible).
CREATE OR REPLACE FUNCTION work_task_set_dependencies(c work_ctx, p_id uuid, p_ids uuid[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s work_settings := work_settings_of(c.tenant);
  t project_tasks := work_task_row(c, s, p_id, true);
  a work_actor := work_actor_of(t, c);
  v_ids uuid[] := ARRAY(SELECT DISTINCT x FROM unnest(p_ids) x WHERE x IS NOT NULL AND x <> p_id);
BEGIN
  IF NOT (a.is_assignee OR a.is_manager OR a.project_member) THEN PERFORM work_fail('FORBIDDEN', 'You cannot edit this task.'); END IF;
  IF cardinality(v_ids) > 20 THEN PERFORM work_fail('VALIDATION', 'A task can wait on at most 20 others.'); END IF;
  IF cardinality(v_ids) > 0 THEN
    IF (SELECT count(*) FROM project_tasks x WHERE x.id = ANY (v_ids) AND work_task_visible(x, c, s)) <> cardinality(v_ids) THEN
      PERFORM work_fail('VALIDATION', 'One of those tasks does not exist or is not visible to you.');
    END IF;
    -- A cycle: one of the new prerequisites (transitively) waits on this task.
    IF EXISTS (
      WITH RECURSIVE chain(id) AS (
        SELECT unnest(v_ids)
        UNION
        SELECT w FROM chain ch JOIN project_tasks d ON d.id = ch.id CROSS JOIN LATERAL unnest(d.waiting_on) w)
      SELECT 1 FROM chain WHERE id = p_id) THEN
      PERFORM work_fail('DEPENDENCY_CYCLE', 'That would make tasks wait on each other in a circle.');
    END IF;
  END IF;
  UPDATE project_tasks SET waiting_on = v_ids WHERE id = p_id;
  PERFORM work_log(c.tenant, p_id, c.me, 'updated', jsonb_build_object('waiting_on', jsonb_build_object('from', NULL, 'to', cardinality(v_ids))));
END;
$$;

-- ── 9. Comments ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION work_task_comment(c work_ctx, p_id uuid, p_body text, p_mentions uuid[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s work_settings := work_settings_of(c.tenant);
  t project_tasks := work_task_row(c, s, p_id);
  v_body text := btrim(COALESCE(p_body, ''));
  v_who text := COALESCE(work_name(c.me), 'Someone');
  v_ref text;
  v_mentioned uuid[] := ARRAY(SELECT DISTINCT x FROM unnest(p_mentions) x WHERE x IS NOT NULL AND x <> c.me);
  v_others uuid[];
BEGIN
  IF char_length(v_body) NOT BETWEEN 1 AND 8000 THEN PERFORM work_fail('VALIDATION', 'Write a comment of up to 8,000 characters.'); END IF;
  INSERT INTO work_task_comments (tenant_id, task_id, author_id, body, mentions) VALUES (c.tenant, p_id, c.me, v_body, v_mentioned);
  PERFORM work_log(c.tenant, p_id, c.me, 'commented', '{}'::jsonb);
  v_ref := work_task_ref(t, s);
  v_others := ARRAY(SELECT x FROM unnest(ARRAY[t.assigned_to, t.created_by]) x WHERE x IS NOT NULL AND x <> c.me AND NOT x = ANY (v_mentioned));
  PERFORM work_notify(c.tenant, v_mentioned, c.me, 'task_mention', format('%s mentioned you on %s', v_who, v_ref), t.title, 'tasks', p_id);
  PERFORM work_notify(c.tenant, v_others, c.me, 'task_comment', format('%s commented on %s', v_who, v_ref), t.title, 'tasks', p_id);
END;
$$;

CREATE OR REPLACE FUNCTION work_task_delete_comment(c work_ctx, p_task uuid, p_comment uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s work_settings := work_settings_of(c.tenant);
  t project_tasks := work_task_row(c, s, p_task);
BEGIN
  UPDATE work_task_comments SET deleted_at = now(), body = ''
   WHERE id = p_comment AND task_id = t.id AND author_id = c.me AND deleted_at IS NULL;
  IF NOT FOUND THEN PERFORM work_fail('NOT_FOUND', 'Comment not found.'); END IF;
END;
$$;

-- ── 10. Read ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION work_task_list(c work_ctx, q jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s work_settings := work_settings_of(c.tenant);
  v_project uuid := work_uuid(q->>'projectId');
  v_standalone boolean := COALESCE(q->>'standalone', '') IN ('true','1');
  v_assignee uuid := CASE WHEN q->>'assignee' = 'me' THEN c.me ELSE work_uuid(q->>'assignee') END;
  v_scope text := q->>'scope';
  v_statuses text[] := CASE WHEN COALESCE(q->>'statuses', '') <> '' THEN string_to_array(q->>'statuses', ',')
                            WHEN COALESCE(q->>'status', '') <> '' THEN ARRAY[q->>'status'] END;
  v_open boolean := COALESCE(q->>'open', '') IN ('true','1');
  v_overdue boolean := COALESCE(q->>'overdue', '') IN ('true','1');
  v_department text := (SELECT name FROM departments WHERE id = work_uuid(q->>'departmentId') AND tenant_id = c.tenant);
  v_from date := work_date(q->>'dueFrom');
  v_to date := work_date(q->>'dueTo');
  v_q text := NULLIF(btrim(COALESCE(q->>'q', '')), '');
  v_limit int := LEAST(GREATEST(COALESCE(NULLIF(q->>'limit', '')::int, 500), 1), 500);
BEGIN
  IF v_project IS NOT NULL THEN PERFORM work_project_for(c, v_project); END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(work_task_json(y.t, c, s) ORDER BY y.ord)
    FROM (
      SELECT t, row_number() OVER (ORDER BY
               CASE WHEN v_project IS NOT NULL THEN t.position END,
               CASE WHEN v_project IS NOT NULL THEN t.number END,
               CASE WHEN v_project IS NULL THEN COALESCE(t.revised_due_date, t.due_date) END NULLS LAST,
               CASE WHEN v_project IS NULL THEN CASE t.priority WHEN 'Urgent' THEN 0 WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 WHEN 'Low' THEN 3 ELSE 4 END END,
               CASE WHEN v_project IS NULL THEN t.updated_at END DESC, t.id) AS ord
      FROM project_tasks t
      WHERE t.tenant_id = c.tenant AND t.deleted_at IS NULL
        AND (v_project IS NULL OR t.project_id = v_project)
        AND (NOT v_standalone OR t.project_id IS NULL)
        AND (v_assignee IS NULL OR t.assigned_to = v_assignee)
        AND CASE v_scope
              WHEN 'mine' THEN t.assigned_to = c.me
              WHEN 'created' THEN t.created_by = c.me
              WHEN 'review' THEN t.stage = 'in_review' AND t.assigned_to IS DISTINCT FROM c.me
                                 AND (c.overseer OR COALESCE(t.approver_id = c.me, false) OR COALESCE(t.assigned_to = ANY (c.team), false))
              WHEN 'team' THEN t.assigned_to = ANY (c.team)
              ELSE true END
        AND (v_statuses IS NULL OR t.stage = ANY (v_statuses))
        AND (NOT v_open OR t.stage NOT IN ('done','cancelled'))
        AND (NOT v_overdue OR (t.stage NOT IN ('done','cancelled') AND COALESCE(t.revised_due_date, t.due_date) < c.today))
        AND (q->>'departmentId' IS NULL OR t.department = v_department)
        AND (v_from IS NULL OR COALESCE(t.revised_due_date, t.due_date) >= v_from)
        AND (v_to IS NULL OR COALESCE(t.revised_due_date, t.due_date) <= v_to)
        AND (v_q IS NULL OR t.title ILIKE '%' || v_q || '%' OR work_task_ref(t, s) ILIKE v_q || '%')
        AND work_task_visible(t, c, s)
      ORDER BY ord
      LIMIT v_limit) y), '[]'::jsonb);
END;
$$;

-- One task with sub-tasks, dependencies, goals, comments, status timeline, history and where it came from.
CREATE OR REPLACE FUNCTION work_task_get(c work_ctx, p_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s work_settings := work_settings_of(c.tenant);
  t project_tasks;
  v_source jsonb;
BEGIN
  SELECT * INTO t FROM project_tasks x WHERE x.id = p_id;
  IF t.id IS NULL OR NOT work_task_visible(t, c, s) THEN PERFORM work_fail('NOT_FOUND', 'Task not found.'); END IF;
  IF t.source_message_id IS NOT NULL THEN
    SELECT jsonb_build_object('messageId', m.id, 'channelId', m.channel_id,
                              'channelName', CASE WHEN ch.kind = 'direct' THEN 'a direct message' ELSE '#' || ch.name END)
      INTO v_source
    FROM work_messages m JOIN work_channels ch ON ch.id = m.channel_id WHERE m.id = t.source_message_id;
  END IF;
  RETURN work_task_json(t, c, s) || jsonb_build_object(
    'subtasks', COALESCE((SELECT jsonb_agg(work_task_json(x, c, s) ORDER BY x.number)
                          FROM project_tasks x WHERE x.parent_task_id = p_id AND x.deleted_at IS NULL), '[]'::jsonb),
    'waitingOn', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', w.id, 'key', work_task_ref(w, s),
                             'title', CASE WHEN work_task_visible(w, c, s) THEN w.title ELSE 'A task you cannot see' END, 'status', w.stage) ORDER BY w.number)
                           FROM project_tasks w WHERE w.id = ANY (t.waiting_on) AND w.deleted_at IS NULL), '[]'::jsonb),
    'blocking', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', b.id, 'key', work_task_ref(b, s),
                             'title', CASE WHEN work_task_visible(b, c, s) THEN b.title ELSE 'A task you cannot see' END, 'status', b.stage) ORDER BY b.number)
                          FROM project_tasks b WHERE b.tenant_id = c.tenant AND p_id = ANY (b.waiting_on) AND b.deleted_at IS NULL), '[]'::jsonb),
    'goals', work_task_goals(p_id),
    'recurrence', (SELECT jsonb_build_object('id', r.id, 'frequency', r.frequency, 'weekday', r.weekday, 'monthDay', r.month_day,
                                             'dueOffsetDays', r.due_offset_days, 'nextRunOn', r.next_run_on)
                   FROM work_task_recurrences r WHERE r.source_task_id = p_id AND r.active),
    'comments', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', cm.id, 'authorEmployeeId', cm.author_id, 'author', work_name(cm.author_id),
                             'body', CASE WHEN cm.deleted_at IS NULL THEN cm.body ELSE '' END, 'deleted', cm.deleted_at IS NOT NULL,
                             'createdAt', work_iso(cm.created_at), 'editedAt', work_iso(cm.edited_at), 'mine', COALESCE(cm.author_id = c.me, false))
                             ORDER BY cm.created_at)
                          FROM work_task_comments cm WHERE cm.task_id = p_id), '[]'::jsonb),
    'timeline', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', h.id, 'kind', h.kind, 'from', h.from_status, 'to', h.to_status, 'reason', h.reason,
                             'note', h.note, 'fromDue', h.from_due, 'toDue', h.to_due, 'actor', work_name(h.actor_id), 'at', work_iso(h.at))
                             ORDER BY h.at, h.id)
                          FROM work_task_history h WHERE h.task_id = p_id), '[]'::jsonb),
    'activity', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', x.id, 'actor', work_name(x.actor_id), 'action', x.action,
                             'changes', x.changes, 'at', work_iso(x.at)) ORDER BY x.at DESC)
                          FROM (SELECT * FROM work_task_activity WHERE task_id = p_id ORDER BY at DESC LIMIT 100) x), '[]'::jsonb),
    'source', v_source);
END;
$$;

-- ── 11. My work: today tiles, view-as, workload ───────────────────────────
-- p_employee = view as a team member (their managers and HR only; counts include only
-- tasks the caller can see).
CREATE OR REPLACE FUNCTION work_summary(c work_ctx, p_employee uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s work_settings := work_settings_of(c.tenant);
  v_who uuid := COALESCE(p_employee, c.me);
  v_team uuid[];
  r record;
BEGIN
  IF v_who <> c.me AND NOT c.overseer AND NOT v_who = ANY (c.team) THEN
    PERFORM work_fail('FORBIDDEN', 'You can view the dashboard of people in your team only.');
  END IF;
  v_team := CASE WHEN v_who = c.me THEN c.team ELSE work_team_ids(v_who) END;
  SELECT count(*) FILTER (WHERE mine AND is_open) AS n_open,
         count(*) FILTER (WHERE mine AND is_open AND due = c.today) AS due_today,
         count(*) FILTER (WHERE mine AND is_open AND stage <> 'in_review' AND due < c.today) AS overdue,
         count(*) FILTER (WHERE mine AND is_open AND due BETWEEN c.today AND c.today + 6) AS due_this_week,
         count(*) FILTER (WHERE mine AND stage = 'blocked') AS blocked,
         count(*) FILTER (WHERE mine AND stage = 'in_review') AS awaiting_review,
         count(*) FILTER (WHERE mine AND is_open AND flagged) AS flagged,
         count(*) FILTER (WHERE mine AND is_open AND due IS NULL) AS no_due_date,
         count(*) FILTER (WHERE mine AND stage = 'done' AND completed_at >= now() - interval '7 days') AS done_7d,
         count(*) FILTER (WHERE mine AND stage = 'done' AND completed_at >= now() - interval '30 days' AND completed_late) AS late_30d,
         count(*) FILTER (WHERE mine AND stage = 'done' AND completed_at >= now() - interval '30 days') AS done_30d,
         count(*) FILTER (WHERE stage = 'in_review' AND NOT mine AND (approver_is OR in_team)) AS to_review
    INTO r
  FROM (SELECT t.stage, COALESCE(t.revised_due_date, t.due_date) AS due, t.completed_at, COALESCE(t.completed_late, false) AS completed_late,
               t.flagged_at IS NOT NULL AS flagged, t.stage NOT IN ('done','cancelled') AS is_open,
               COALESCE(t.assigned_to = v_who, false) AS mine, COALESCE(t.approver_id = v_who, false) AS approver_is,
               COALESCE(t.assigned_to = ANY (v_team), false) AS in_team
        FROM project_tasks t
        WHERE t.tenant_id = c.tenant AND t.deleted_at IS NULL
          AND (t.assigned_to = v_who OR t.stage = 'in_review')
          AND work_task_visible(t, c, s)) x;
  RETURN jsonb_build_object(
    'employeeId', v_who, 'name', work_name(v_who), 'today', c.today,
    'open', r.n_open, 'dueToday', r.due_today, 'overdue', r.overdue, 'dueThisWeek', r.due_this_week, 'blocked', r.blocked,
    'awaitingReview', r.awaiting_review, 'flagged', r.flagged, 'noDueDate', r.no_due_date, 'toReview', r.to_review, 'done7d', r.done_7d,
    'onTimeRate30d', CASE WHEN r.done_30d > 0 THEN round(((r.done_30d - r.late_30d)::numeric / r.done_30d) * 100) END);
END;
$$;

-- People the caller may "view as": their whole reporting tree (everyone active for HR).
CREATE OR REPLACE FUNCTION work_view_as(c work_ctx)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('employeeId', x.id, 'name', x.name, 'designation', x.designation) ORDER BY x.name), '[]'::jsonb)
  FROM (SELECT p.id, COALESCE(work_name(p.id), p.email) AS name, NULLIF(p.designation, '') AS designation
        FROM profiles p
        WHERE p.tenant_id = c.tenant AND p.status = 'Active' AND p.id <> c.me AND (c.overseer OR p.id = ANY (c.team))
        ORDER BY 2 LIMIT 500) x;
$$;

-- Workload: one row per person with open work in Overdue · This week · Next week · Later ·
-- No due date, plus blocked and in review. Scope: my team (default), a department or everyone (HR).
CREATE OR REPLACE FUNCTION work_workload(c work_ctx, q jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s work_settings := work_settings_of(c.tenant);
  v_this date := c.today + ((7 - extract(dow FROM c.today)::int) % 7);   -- through Sunday
  v_next date;
  v_department text := (SELECT name FROM departments WHERE id = work_uuid(q->>'departmentId') AND tenant_id = c.tenant);
  v_all boolean := q->>'scope' = 'all';
BEGIN
  v_next := v_this + 7;
  IF q->>'departmentId' IS NOT NULL AND NOT c.overseer THEN
    PERFORM work_fail('FORBIDDEN', 'Only the department head or an overseer can see that workload.');
  END IF;
  IF v_all AND NOT c.overseer THEN PERFORM work_fail('FORBIDDEN', 'Only overseers can see everyone’s workload.'); END IF;
  RETURN jsonb_build_object('today', c.today, 'weeks', jsonb_build_object('thisWeekEnd', v_this, 'nextWeekEnd', v_next),
    'people', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('employeeId', y.id, 'name', y.name, 'open', y.n_open, 'overdue', y.overdue, 'thisWeek', y.this_week,
                                          'nextWeek', y.next_week, 'later', y.later, 'noDueDate', y.no_due, 'blocked', y.blocked, 'inReview', y.in_review)
                       ORDER BY y.n_open DESC, y.name)
      FROM (
        SELECT x.id, COALESCE(work_name(x.id), x.email) AS name,
               count(t.id) FILTER (WHERE t.stage <> 'in_review' AND COALESCE(t.revised_due_date, t.due_date) < c.today) AS overdue,
               count(t.id) FILTER (WHERE COALESCE(t.revised_due_date, t.due_date) BETWEEN c.today AND v_this) AS this_week,
               count(t.id) FILTER (WHERE COALESCE(t.revised_due_date, t.due_date) > v_this AND COALESCE(t.revised_due_date, t.due_date) <= v_next) AS next_week,
               count(t.id) FILTER (WHERE COALESCE(t.revised_due_date, t.due_date) > v_next) AS later,
               count(t.id) FILTER (WHERE t.id IS NOT NULL AND COALESCE(t.revised_due_date, t.due_date) IS NULL) AS no_due,
               count(t.id) FILTER (WHERE t.stage = 'blocked') AS blocked,
               count(t.id) FILTER (WHERE t.stage = 'in_review') AS in_review,
               count(t.id) AS n_open
        FROM profiles x
        LEFT JOIN project_tasks t ON t.assigned_to = x.id AND t.tenant_id = c.tenant AND t.deleted_at IS NULL
                                 AND t.stage NOT IN ('done','cancelled') AND work_task_visible(t, c, s)
        WHERE x.tenant_id = c.tenant AND x.status = 'Active'
          AND CASE WHEN q->>'departmentId' IS NOT NULL THEN x.department = v_department
                   WHEN v_all THEN true
                   ELSE x.id = c.me OR x.id = ANY (c.team) END
        GROUP BY x.id, x.email
        ORDER BY count(t.id) DESC, 2
        LIMIT 500) y), '[]'::jsonb));
END;
$$;

-- ── 12. Settings ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION work_settings_json(c work_ctx)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object('taskVisibility', s.task_visibility, 'taskKeyPrefix', s.task_key_prefix, 'requireDueToStart', s.require_due_to_start,
    'requireDeliverable', s.require_deliverable, 'reasonOnEveryMove', s.reason_on_every_move, 'digestEnabled', s.digest_enabled,
    'digestTime', to_char(s.digest_time, 'HH24:MI'), 'weeklyDigestDow', s.weekly_digest_dow)
  FROM work_settings_of(c.tenant) s;
$$;

CREATE OR REPLACE FUNCTION work_settings_update(c work_ctx, i jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT c.overseer THEN PERFORM work_fail('FORBIDDEN', 'Only work administrators can change task settings.'); END IF;
  IF i ? 'taskVisibility' AND i->>'taskVisibility' NOT IN ('restricted','company') THEN PERFORM work_fail('VALIDATION', 'Unknown visibility.'); END IF;
  IF i ? 'taskKeyPrefix' AND i->>'taskKeyPrefix' !~ '^[A-Z][A-Z0-9]{0,5}$' THEN PERFORM work_fail('VALIDATION', 'The task prefix is 1–6 capital letters or digits.'); END IF;
  INSERT INTO work_settings (tenant_id) VALUES (c.tenant) ON CONFLICT DO NOTHING;
  UPDATE work_settings SET
    task_visibility      = COALESCE(i->>'taskVisibility', task_visibility),
    task_key_prefix      = COALESCE(i->>'taskKeyPrefix', task_key_prefix),
    require_due_to_start = COALESCE((i->>'requireDueToStart')::boolean, require_due_to_start),
    require_deliverable  = COALESCE((i->>'requireDeliverable')::boolean, require_deliverable),
    reason_on_every_move = COALESCE((i->>'reasonOnEveryMove')::boolean, reason_on_every_move),
    digest_enabled       = COALESCE((i->>'digestEnabled')::boolean, digest_enabled),
    digest_time          = COALESCE((i->>'digestTime')::time, digest_time),
    weekly_digest_dow    = COALESCE((i->>'weeklyDigestDow')::smallint, weekly_digest_dow),
    updated_at           = now()
  WHERE tenant_id = c.tenant;
END;
$$;

-- ── 13. Repeating tasks ───────────────────────────────────────────────────
-- Makes a task repeat (the task is the template). Assignee, creator or manager; sub-tasks cannot repeat.
CREATE OR REPLACE FUNCTION work_task_set_recurrence(c work_ctx, p_id uuid, i jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s work_settings := work_settings_of(c.tenant);
  t project_tasks := work_task_row(c, s, p_id, true);
  a work_actor := work_actor_of(t, c);
  v_freq text := i->>'frequency';
  v_weekday int := (i->>'weekday')::int;
  v_month_day int := (i->>'monthDay')::int;
  v_offset int := COALESCE((i->>'dueOffsetDays')::int, 0);
BEGIN
  IF v_freq IS NULL OR v_freq NOT IN ('weekly','monthly')
     OR (v_freq = 'weekly' AND (v_weekday IS NULL OR v_weekday NOT BETWEEN 0 AND 6))
     OR (v_freq = 'monthly' AND (v_month_day IS NULL OR v_month_day NOT BETWEEN 1 AND 28))
     OR v_offset NOT BETWEEN 0 AND 30 THEN
    PERFORM work_fail('VALIDATION', 'Weekly repeats need a weekday (0–6); monthly repeats need a day of the month (1–28).');
  END IF;
  IF NOT (a.is_assignee OR a.is_manager) THEN PERFORM work_fail('FORBIDDEN', 'Only the assignee, the creator or a manager can make this task repeat.'); END IF;
  IF t.parent_task_id IS NOT NULL THEN PERFORM work_fail('SUBTASK_CANNOT_REPEAT', 'A sub-task cannot repeat.'); END IF;
  IF t.recurrence_id IS NOT NULL THEN PERFORM work_fail('COPY_CANNOT_REPEAT', 'This task is itself a repeat; set the repeat on the original.'); END IF;
  INSERT INTO work_task_recurrences (tenant_id, source_task_id, frequency, weekday, month_day, due_offset_days, next_run_on, created_by)
  VALUES (c.tenant, p_id, v_freq, CASE WHEN v_freq = 'weekly' THEN v_weekday END, CASE WHEN v_freq = 'monthly' THEN v_month_day END, v_offset,
          work_first_on_or_after(c.today + 1, v_freq, v_weekday, v_month_day), c.me)
  ON CONFLICT (source_task_id) DO UPDATE SET frequency = EXCLUDED.frequency, weekday = EXCLUDED.weekday, month_day = EXCLUDED.month_day,
         due_offset_days = EXCLUDED.due_offset_days, next_run_on = EXCLUDED.next_run_on, active = true;
  PERFORM work_log(c.tenant, p_id, c.me, 'updated', jsonb_build_object('repeat', jsonb_build_object('from', NULL, 'to', i)));
END;
$$;

-- Stops repeating; copies already made stay.
CREATE OR REPLACE FUNCTION work_task_stop_recurrence(c work_ctx, p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s work_settings := work_settings_of(c.tenant);
  t project_tasks := work_task_row(c, s, p_id, true);
  a work_actor := work_actor_of(t, c);
BEGIN
  IF NOT (a.is_assignee OR a.is_manager) THEN PERFORM work_fail('FORBIDDEN', 'Only the assignee, the creator or a manager can stop this repeat.'); END IF;
  UPDATE work_task_recurrences SET active = false WHERE source_task_id = p_id AND active;
  PERFORM work_log(c.tenant, p_id, c.me, 'updated', jsonb_build_object('repeat', jsonb_build_object('from', 'on', 'to', NULL)));
END;
$$;

-- Daily job: creates the due copies of repeating tasks for every company. Idempotent (one
-- work_task_occurrences row per repeat and date); a missed run creates only the latest due copy.
CREATE OR REPLACE FUNCTION work_run_recurrences(p_today date DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_day date := COALESCE(p_today, task_today());
  r work_task_recurrences;
  src project_tasks;
  c work_ctx;
  v_on date;
  v_n date;
  v_assignee uuid; v_reporter uuid; v_reviewer uuid;
  v_id uuid;
  v_made int := 0;
BEGIN
  PERFORM set_config('crewcore.work_rpc', 'on', true);
  FOR r IN SELECT * FROM work_task_recurrences WHERE active AND next_run_on <= v_day ORDER BY next_run_on FOR UPDATE SKIP LOCKED LIMIT 500 LOOP
    -- Each repeat on its own: one broken source task never undoes the others.
    BEGIN
      v_on := r.next_run_on;
      LOOP   -- the latest occurrence that is due (a missed week creates one copy, not a backlog of them)
        v_n := work_first_on_or_after(v_on + 1, r.frequency, r.weekday, r.month_day);
        EXIT WHEN v_n > v_day;
        v_on := v_n;
      END LOOP;
      IF NOT EXISTS (SELECT 1 FROM work_task_occurrences WHERE recurrence_id = r.id AND occurs_on = v_on) THEN
        SELECT * INTO src FROM project_tasks WHERE id = r.source_task_id;
        v_assignee := (SELECT id FROM profiles WHERE id = src.assigned_to AND status = 'Active');
        v_reporter := (SELECT id FROM profiles WHERE id = src.created_by AND status = 'Active');
        v_reviewer := (SELECT id FROM profiles WHERE id = src.reviewer_id AND status = 'Active');
        IF src.id IS NULL OR src.deleted_at IS NOT NULL OR COALESCE(v_assignee, v_reporter) IS NULL
           OR NOT ai_feature_enabled(r.tenant_id, NULL, 'tasks')
           OR (src.project_id IS NOT NULL AND EXISTS (SELECT 1 FROM projects WHERE id = src.project_id AND archived_at IS NOT NULL)) THEN
          UPDATE work_task_recurrences SET active = false WHERE id = r.id;
          CONTINUE;
        END IF;
        c.me := COALESCE(v_assignee, v_reporter); c.tenant := r.tenant_id; c.role := 'system'; c.overseer := true; c.team := '{}'; c.today := v_day;
        v_id := work_task_insert(c, jsonb_build_object(
          'projectId', src.project_id, 'title', work_occurrence_title(src.title, v_on, r.frequency), 'description', src.description,
          'priority', lower(src.priority), 'assigneeEmployeeId', v_assignee,
          'reviewerEmployeeId', CASE WHEN v_reviewer IS DISTINCT FROM v_assignee THEN v_reviewer END,
          'dueDate', (v_on + r.due_offset_days)::text, 'labels', to_jsonb(src.labels), 'status', 'todo'),
          jsonb_build_object('system', true, 'recurrenceId', r.id, 'reporterId', v_reporter));
        INSERT INTO work_task_occurrences (recurrence_id, occurs_on, tenant_id, task_id) VALUES (r.id, v_on, r.tenant_id, v_id);
        v_made := v_made + 1;
      END IF;
      UPDATE work_task_recurrences SET next_run_on = work_first_on_or_after(v_on + 1, r.frequency, r.weekday, r.month_day) WHERE id = r.id;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'repeating task % failed: %', r.id, SQLERRM;
    END;
  END LOOP;
  PERFORM set_config('crewcore.work_rpc', 'off', true);
  RETURN v_made;
END;
$$;

-- 00:10 IST every day (18:40 UTC): one small indexed scan; does nothing when no repeat is due.
SELECT cron.unschedule('work-repeating-tasks') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'work-repeating-tasks');
SELECT cron.schedule('work-repeating-tasks', '40 18 * * *', $$ SELECT work_run_recurrences() WHERE EXISTS (SELECT 1 FROM work_task_recurrences WHERE active AND next_run_on <= task_today()); $$);

-- ── 14. Private drafts ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION work_drafts(c work_ctx, p_context text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', d.id, 'context', d.context, 'payload', d.payload, 'updatedAt', work_iso(d.updated_at)) ORDER BY d.updated_at DESC), '[]'::jsonb)
  FROM (SELECT * FROM work_task_drafts WHERE profile_id = c.me AND (p_context IS NULL OR context = p_context) ORDER BY updated_at DESC LIMIT 100) d;
$$;

CREATE OR REPLACE FUNCTION work_draft_save(c work_ctx, i jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id uuid := work_uuid(i->>'id');
  v_context text := left(COALESCE(i->>'context', ''), 120);
  v_payload jsonb := COALESCE(i->'payload', '{}'::jsonb);
BEGIN
  IF jsonb_typeof(v_payload) <> 'object' THEN PERFORM work_fail('VALIDATION', 'A draft needs a payload.'); END IF;
  IF v_id IS NOT NULL THEN
    UPDATE work_task_drafts SET payload = v_payload, context = v_context, updated_at = now() WHERE id = v_id AND profile_id = c.me;
    IF NOT FOUND THEN PERFORM work_fail('NOT_FOUND', 'Draft not found.'); END IF;
    RETURN jsonb_build_object('id', v_id);
  END IF;
  IF (SELECT count(*) FROM work_task_drafts WHERE profile_id = c.me) >= 100 THEN
    PERFORM work_fail('TOO_MANY_DRAFTS', 'You have 100 drafts; delete some first.');
  END IF;
  INSERT INTO work_task_drafts (tenant_id, profile_id, context, payload) VALUES (c.tenant, c.me, v_context, v_payload) RETURNING id INTO v_id;
  RETURN jsonb_build_object('id', v_id);
END;
$$;

CREATE OR REPLACE FUNCTION work_draft_delete(c work_ctx, p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM work_task_drafts WHERE id = p_id AND profile_id = c.me;
  IF NOT FOUND THEN PERFORM work_fail('NOT_FOUND', 'Draft not found.'); END IF;
  RETURN jsonb_build_object('id', p_id, 'deleted', true);
END;
$$;

-- ── 15. Projects ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION work_project_json(c work_ctx, p projects, p_counts boolean)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'id', p.id, 'key', p.key, 'name', p.name, 'description', p.description, 'color', p.color, 'visibility', p.visibility,
    'status', CASE WHEN p.archived_at IS NULL THEN 'active' ELSE 'archived' END,
    'channelId', p.channel_id,
    'lead', CASE WHEN p.lead_id IS NULL THEN NULL ELSE jsonb_build_object('employeeId', p.lead_id, 'name', work_name(p.lead_id)) END,
    'myRole', (SELECT pm.role FROM project_members pm WHERE pm.project_id = p.id AND pm.profile_id = c.me),
    'counts', jsonb_build_object(
      'open', CASE WHEN p_counts THEN (SELECT count(*) FROM project_tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL AND t.stage NOT IN ('done','cancelled')) ELSE 0 END,
      'done', CASE WHEN p_counts THEN (SELECT count(*) FROM project_tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL AND t.stage = 'done') ELSE 0 END,
      'mine', CASE WHEN p_counts THEN (SELECT count(*) FROM project_tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL AND t.assigned_to = c.me AND t.stage NOT IN ('done','cancelled')) ELSE 0 END,
      'overdue', CASE WHEN p_counts THEN (SELECT count(*) FROM project_tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL AND t.stage NOT IN ('done','cancelled') AND COALESCE(t.revised_due_date, t.due_date) < c.today) ELSE 0 END,
      'members', (SELECT count(*) FROM project_members x WHERE x.project_id = p.id)));
$$;

-- Projects I can see, with my role and the open / my / overdue task counts.
CREATE OR REPLACE FUNCTION work_project_list(c work_ctx, p_include_archived boolean)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(work_project_json(c, p, true) ORDER BY (pm.role IS NULL), lower(p.name)), '[]'::jsonb)
  FROM projects p LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.profile_id = c.me
  WHERE p.tenant_id = c.tenant AND p.key IS NOT NULL
    AND (p.visibility = 'company' OR pm.profile_id IS NOT NULL)
    AND (p_include_archived OR p.archived_at IS NULL);
$$;

CREATE OR REPLACE FUNCTION work_project_get(c work_ctx, p_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  p projects;
BEGIN
  PERFORM work_project_for(c, p_id);
  SELECT * INTO p FROM projects WHERE id = p_id;
  RETURN work_project_json(c, p, false) || jsonb_build_object('memberList', COALESCE((
    SELECT jsonb_agg(jsonb_build_object('employeeId', m.profile_id, 'name', COALESCE(work_name(m.profile_id), 'Someone'), 'role', m.role)
                     ORDER BY (m.role = 'admin') DESC, lower(COALESCE(work_name(m.profile_id), '')))
    FROM project_members m WHERE m.project_id = p_id), '[]'::jsonb));
END;
$$;

-- Joins a channel the caller can see (posting or opening a public / company-project channel joins it).
CREATE OR REPLACE FUNCTION work_ensure_member(p_tenant uuid, p_channel uuid, p_profile uuid, p_role text DEFAULT 'member')
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO work_channel_members (tenant_id, channel_id, profile_id, role) VALUES (p_tenant, p_channel, p_profile, p_role)
  ON CONFLICT DO NOTHING;
$$;

CREATE OR REPLACE FUNCTION work_project_add_members_in(c work_ctx, p_project uuid, p_channel uuid, p_ids uuid[], p_role text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_ids uuid[] := ARRAY(SELECT DISTINCT x FROM unnest(p_ids) x WHERE x IS NOT NULL);
  v_id uuid;
BEGIN
  IF cardinality(v_ids) = 0 THEN RETURN; END IF;
  IF (SELECT count(*) FROM profiles WHERE id = ANY (v_ids) AND tenant_id = c.tenant AND status = 'Active') <> cardinality(v_ids) THEN
    PERFORM work_fail('VALIDATION', 'Some of these people are not active employees.');
  END IF;
  INSERT INTO project_members (tenant_id, project_id, profile_id, role_on_project, role)
  SELECT c.tenant, p_project, x, initcap(p_role), p_role FROM unnest(v_ids) x
  ON CONFLICT (project_id, profile_id) DO UPDATE
    SET role = CASE WHEN EXCLUDED.role = 'admin' THEN 'admin' ELSE project_members.role END,
        role_on_project = CASE WHEN EXCLUDED.role = 'admin' THEN 'Admin' ELSE project_members.role_on_project END;
  IF p_channel IS NOT NULL THEN
    FOREACH v_id IN ARRAY v_ids LOOP
      PERFORM work_ensure_member(c.tenant, p_channel, v_id, CASE WHEN p_role = 'admin' THEN 'owner' ELSE 'member' END);
    END LOOP;
  END IF;
END;
$$;

-- Creates the project, makes the creator its admin and lead, adds members, and opens its channel.
CREATE OR REPLACE FUNCTION work_project_create(c work_ctx, i jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_key text := upper(btrim(COALESCE(i->>'key', '')));
  v_name text := btrim(COALESCE(i->>'name', ''));
  v_desc text := COALESCE(i->>'description', '');
  v_color text := COALESCE(NULLIF(i->>'color', ''), 'iris');
  v_vis text := COALESCE(NULLIF(i->>'visibility', ''), 'company');
  v_members uuid[] := work_uuids(i->'memberIds');
  v_id uuid := gen_random_uuid();
  v_channel uuid := gen_random_uuid();
  v_constraint text;
BEGIN
  IF v_key !~ '^[A-Z][A-Z0-9]{1,9}$' THEN PERFORM work_fail('VALIDATION', 'The key is 2–10 letters or digits, starting with a letter.'); END IF;
  IF char_length(v_name) NOT BETWEEN 1 AND 120 THEN PERFORM work_fail('VALIDATION', 'A project needs a name of up to 120 characters.'); END IF;
  IF char_length(v_desc) > 4000 THEN PERFORM work_fail('VALIDATION', 'The description is too long.'); END IF;
  IF v_color NOT IN ('iris','aqua','ember','emerald','amber','rose','sky','ink') THEN PERFORM work_fail('VALIDATION', 'Unknown colour.'); END IF;
  IF v_vis NOT IN ('company','private') THEN PERFORM work_fail('VALIDATION', 'Unknown visibility.'); END IF;
  IF cardinality(v_members) > 200 THEN PERFORM work_fail('VALIDATION', 'Add at most 200 people at once.'); END IF;
  BEGIN
    INSERT INTO projects (id, tenant_id, key, name, description, color, visibility, lead_id, created_by, status)
    VALUES (v_id, c.tenant, v_key, v_name, v_desc, v_color, v_vis, c.me, c.me, 'Active');
    INSERT INTO work_channels (id, tenant_id, kind, name, topic, project_id, created_by)
    VALUES (v_channel, c.tenant, 'project', lower(v_key), left(v_name || ' — tasks and discussion', 250), v_id, c.me);
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    PERFORM work_fail('CONFLICT', CASE v_constraint
      WHEN 'projects_key_uq' THEN 'Another project already uses this key.'
      WHEN 'projects_name_uq' THEN 'Another project already has this name.'
      WHEN 'work_channels_name_uq' THEN 'A channel with this name already exists — choose another project key.'
      ELSE 'That project already exists.' END);
  END;
  UPDATE projects SET channel_id = v_channel WHERE id = v_id;
  PERFORM work_project_add_members_in(c, v_id, v_channel, ARRAY[c.me], 'admin');
  PERFORM work_project_add_members_in(c, v_id, v_channel, array_remove(v_members, c.me), 'member');
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION work_project_update(c work_ctx, p_id uuid, i jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  p work_project_access := work_project_for(c, p_id);
  v_lead uuid := work_uuid(i->>'leadEmployeeId');
BEGIN
  IF p.role IS DISTINCT FROM 'admin' AND NOT c.overseer THEN PERFORM work_fail('FORBIDDEN', 'Only the project admins can do that.'); END IF;
  IF i ? 'name' AND char_length(btrim(COALESCE(i->>'name', ''))) NOT BETWEEN 1 AND 120 THEN PERFORM work_fail('VALIDATION', 'A project needs a name of up to 120 characters.'); END IF;
  IF i ? 'description' AND char_length(COALESCE(i->>'description', '')) > 4000 THEN PERFORM work_fail('VALIDATION', 'The description is too long.'); END IF;
  IF i ? 'color' AND i->>'color' NOT IN ('iris','aqua','ember','emerald','amber','rose','sky','ink') THEN PERFORM work_fail('VALIDATION', 'Unknown colour.'); END IF;
  IF i ? 'visibility' AND i->>'visibility' NOT IN ('company','private') THEN PERFORM work_fail('VALIDATION', 'Unknown visibility.'); END IF;
  IF v_lead IS NOT NULL AND NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_lead AND tenant_id = c.tenant AND status = 'Active') THEN
    PERFORM work_fail('VALIDATION', 'The lead must be an active employee.');
  END IF;
  BEGIN
    UPDATE projects SET
      name = COALESCE(NULLIF(btrim(COALESCE(i->>'name', '')), ''), name),
      description = COALESCE(i->>'description', description),
      color = COALESCE(i->>'color', color),
      visibility = COALESCE(i->>'visibility', visibility),
      lead_id = COALESCE(v_lead, lead_id)
    WHERE id = p_id;
  EXCEPTION WHEN unique_violation THEN
    PERFORM work_fail('CONFLICT', 'Another project already has this name.');
  END;
END;
$$;

CREATE OR REPLACE FUNCTION work_project_add_members(c work_ctx, p_id uuid, p_ids uuid[], p_role text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  p work_project_access := work_project_for(c, p_id);
BEGIN
  IF p.role IS DISTINCT FROM 'admin' AND NOT c.overseer THEN PERFORM work_fail('FORBIDDEN', 'Only the project admins can do that.'); END IF;
  IF p.archived THEN PERFORM work_fail('PROJECT_ARCHIVED', 'This project is archived.'); END IF;
  IF cardinality(p_ids) = 0 THEN PERFORM work_fail('VALIDATION', 'Choose who to add.'); END IF;
  PERFORM work_project_add_members_in(c, p_id, p.channel_id, p_ids, CASE WHEN p_role = 'admin' THEN 'admin' ELSE 'member' END);
END;
$$;

CREATE OR REPLACE FUNCTION work_project_remove_member(c work_ctx, p_id uuid, p_member uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  p work_project_access := work_project_for(c, p_id);
BEGIN
  IF p_member IS DISTINCT FROM c.me AND p.role IS DISTINCT FROM 'admin' AND NOT c.overseer THEN
    PERFORM work_fail('FORBIDDEN', 'Only the project admins can do that.');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM project_members WHERE project_id = p_id AND role = 'admin' AND profile_id <> p_member) THEN
    PERFORM work_fail('LAST_ADMIN', 'A project needs at least one admin.');
  END IF;
  DELETE FROM project_members WHERE project_id = p_id AND profile_id = p_member;
  IF p.visibility = 'private' AND p.channel_id IS NOT NULL THEN
    DELETE FROM work_channel_members WHERE channel_id = p.channel_id AND profile_id = p_member;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION work_project_archive(c work_ctx, p_id uuid, p_archived boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  p work_project_access := work_project_for(c, p_id);
BEGIN
  IF p.role IS DISTINCT FROM 'admin' AND NOT c.overseer THEN PERFORM work_fail('FORBIDDEN', 'Only the project admins can do that.'); END IF;
  UPDATE projects SET archived_at = CASE WHEN p_archived THEN COALESCE(archived_at, now()) END,
                      status = CASE WHEN p_archived THEN 'Completed' ELSE 'Active' END
   WHERE id = p_id;
  IF p.channel_id IS NOT NULL THEN
    UPDATE work_channels SET archived_at = CASE WHEN p_archived THEN now() END WHERE id = p.channel_id;
  END IF;
END;
$$;

-- Projects made before this migration get their channel (and its members) now.
DO $$
DECLARE
  r record;
  v_channel uuid;
  v_name text;
  n int;
BEGIN
  FOR r IN SELECT * FROM projects WHERE channel_id IS NULL AND key IS NOT NULL LOOP
    v_name := lower(r.key); n := 1;
    WHILE EXISTS (SELECT 1 FROM work_channels WHERE tenant_id = r.tenant_id AND name = v_name) LOOP
      n := n + 1; v_name := lower(r.key) || '-' || n;
    END LOOP;
    INSERT INTO work_channels (tenant_id, kind, name, topic, project_id, created_by, archived_at)
    VALUES (r.tenant_id, 'project', v_name, left(r.name || ' — tasks and discussion', 250), r.id, r.created_by, r.archived_at)
    RETURNING id INTO v_channel;
    UPDATE projects SET channel_id = v_channel WHERE id = r.id;
    INSERT INTO work_channel_members (tenant_id, channel_id, profile_id, role)
    SELECT m.tenant_id, v_channel, m.profile_id, CASE WHEN m.role = 'admin' THEN 'owner' ELSE 'member' END
    FROM project_members m WHERE m.project_id = r.id
    ON CONFLICT DO NOTHING;
  END LOOP;
END $$;

-- The directory every employee may use (pickers and @mentions): active colleagues by name.
CREATE OR REPLACE FUNCTION work_directory(c work_ctx, p_q text, p_limit int)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object('data', COALESCE(jsonb_agg(jsonb_build_object(
           'id', x.id, 'fullName', x.name,
           'department', CASE WHEN COALESCE(x.department, '') = '' THEN NULL ELSE jsonb_build_object('id', x.department, 'name', x.department) END,
           'designation', CASE WHEN COALESCE(x.designation, '') = '' THEN NULL ELSE jsonb_build_object('id', x.designation, 'name', x.designation) END)
           ORDER BY x.rank, x.name), '[]'::jsonb),
         'page', jsonb_build_object('nextCursor', NULL, 'hasMore', false))
  FROM (SELECT p.id, COALESCE(work_name(p.id), p.email) AS name, p.department, p.designation,
               CASE WHEN p_q IS NULL THEN 1 WHEN lower(COALESCE(work_name(p.id), '')) LIKE lower(p_q) || '%' THEN 0 ELSE 1 END AS rank
        FROM profiles p
        WHERE p.tenant_id = c.tenant AND p.status = 'Active'
          AND (p_q IS NULL OR COALESCE(work_name(p.id), '') ILIKE '%' || p_q || '%' OR p.employee_id ILIKE p_q || '%')
        ORDER BY 5, 2
        LIMIT LEAST(GREATEST(COALESCE(p_limit, 8), 1), 50)) x;
$$;
