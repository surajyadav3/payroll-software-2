-- Task Management end-to-end + authorization test. SAFE TO RUN ON PROD:
-- one DO block that always ends by raising 'TASK TEST REPORT', which aborts
-- and rolls back every row it touched (tasks, activity, notifications, outbox,
-- channel settings, the temporary manager link, queued pg_net calls).
-- Uses only the CrewCore test tenant ed7b4ea0 (HR Prakash + Suraj + colleagues).
-- A line starting with "FAIL" is a failed assertion.
DO $test$
DECLARE
  ten uuid := 'ed7b4ea0-b8f6-4389-a6e6-2baf400221aa';
  hr  uuid := 'ec70cb49-7c53-4345-986a-ccc787f8d606';   -- admin
  s   uuid := '1016a8af-ba5a-400a-9b9d-c6750a3125a9';   -- employee (Suraj)
  d   uuid := 'd1d1ecd4-c445-4507-aa92-490cb06aea42';   -- employee, temporarily reports to s
  o   uuid := '54dcaabd-3ae0-47b0-a4fd-49d9a1196d23';   -- employee, no manager (outsider)
  t1 uuid; t2 uuid; t3 uuid; t4 uuid; n int; v text; ok boolean;
  log text[] := '{}';
  td date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
BEGIN
  -- fixtures (as postgres): d reports to s for the manager-path checks
  UPDATE profiles SET manager_id = s WHERE id = d;
  EXECUTE 'SET LOCAL ROLE authenticated';

  -- ── HR creates + assigns ──────────────────────────────────────────────
  PERFORM set_config('request.jwt.claims', json_build_object('sub', hr, 'role', 'authenticated')::text, true);
  INSERT INTO project_tasks (tenant_id, title, description, assigned_to, due_date, priority, created_by, source)
  VALUES (ten, '  [TEST] Prepare report  ', 'x', s, td, 'High', s, 'web') RETURNING id INTO t1;
  SELECT (created_by = hr AND title = '[TEST] Prepare report' AND status = 'To Do') INTO ok FROM project_tasks WHERE id = t1;
  log := log || (CASE WHEN ok THEN 'ok ' ELSE 'FAIL ' END || 'HR creates task: created_by forced to caller, title trimmed, default To Do');
  SELECT count(*) INTO n FROM app_notifications WHERE related_id = t1;
  log := log || (CASE WHEN n = 0 THEN 'ok ' ELSE 'FAIL ' END || 'HR cannot read the assignee''s notification');
  SELECT count(*) INTO n FROM task_activity WHERE task_id = t1 AND kind = 'created';
  log := log || (CASE WHEN n = 1 THEN 'ok ' ELSE 'FAIL ' END || 'activity: created logged');
  INSERT INTO project_tasks (tenant_id, title) VALUES (ten, '[TEST] personal') RETURNING id INTO t2;
  SELECT assigned_to = hr INTO ok FROM project_tasks WHERE id = t2;
  log := log || (CASE WHEN ok THEN 'ok ' ELSE 'FAIL ' END || 'no assignee -> personal task for creator');
  BEGIN INSERT INTO project_tasks (tenant_id, title, assigned_to) VALUES (gen_random_uuid(), '[TEST] x', hr); log := log || 'FAIL cross-tenant insert accepted'::text;
  EXCEPTION WHEN OTHERS THEN log := log || ('ok cross-tenant insert blocked: ' || SQLERRM); END;
  BEGIN INSERT INTO project_tasks (tenant_id, title, assigned_to, priority) VALUES (ten, '[TEST] x', s, 'Critical'); log := log || 'FAIL bad priority accepted'::text;
  EXCEPTION WHEN OTHERS THEN log := log || 'ok invalid priority rejected'::text; END;

  -- external channel on (email) -> outbox rows for events
  INSERT INTO tenant_notification_channels (tenant_id, email_enabled, slack_enabled)
  VALUES (ten, true, true)
  ON CONFLICT (tenant_id) DO UPDATE SET email_enabled = true, slack_enabled = true, slack_webhook_url = NULL, notify_status_changes = true;
  SELECT NOT slack_enabled INTO ok FROM tenant_notification_channels WHERE tenant_id = ten;
  log := log || (CASE WHEN ok THEN 'ok ' ELSE 'FAIL ' END || 'Slack cannot be on without a webhook URL');

  -- ── Assignee (Suraj): status only ─────────────────────────────────────
  PERFORM set_config('request.jwt.claims', json_build_object('sub', s, 'role', 'authenticated')::text, true);
  SELECT count(*) INTO n FROM project_tasks WHERE id = t1;
  log := log || (CASE WHEN n = 1 THEN 'ok ' ELSE 'FAIL ' END || 'assignee sees task');
  SELECT count(*) INTO n FROM app_notifications WHERE related_id = t1 AND type = 'task_assigned';
  log := log || (CASE WHEN n = 1 THEN 'ok ' ELSE 'FAIL ' END || 'assignee notified (in-app), got ' || n);
  UPDATE project_tasks SET status = 'In Progress' WHERE id = t1;
  SELECT status INTO v FROM project_tasks WHERE id = t1;
  log := log || (CASE WHEN v = 'In Progress' THEN 'ok ' ELSE 'FAIL ' END || 'assignee moves To Do -> In Progress');
  PERFORM set_config('request.jwt.claims', json_build_object('sub', hr, 'role', 'authenticated')::text, true);
  SELECT count(*) INTO n FROM app_notifications WHERE related_id = t1 AND profile_id = hr AND type = 'task_status';
  log := log || (CASE WHEN n = 1 THEN 'ok ' ELSE 'FAIL ' END || 'creator notified of status change, got ' || n);
  EXECUTE 'RESET ROLE';
  SELECT count(*) INTO n FROM notification_outbox WHERE task_id = t1 AND event = 'task_status';
  log := log || (CASE WHEN n = 1 THEN 'ok ' ELSE 'FAIL ' END || 'status change queued for email channel (outbox), got ' || n);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claims', json_build_object('sub', s, 'role', 'authenticated')::text, true);
  BEGIN UPDATE project_tasks SET title = 'hacked' WHERE id = t1; log := log || 'FAIL assignee renamed task'::text;
  EXCEPTION WHEN OTHERS THEN log := log || ('ok assignee cannot edit fields: ' || SQLERRM); END;
  BEGIN UPDATE project_tasks SET due_date = td + 30 WHERE id = t1; log := log || 'FAIL assignee moved due date'::text;
  EXCEPTION WHEN OTHERS THEN log := log || 'ok assignee cannot move due date'::text; END;
  BEGIN UPDATE project_tasks SET status = 'Cancelled' WHERE id = t1; log := log || 'FAIL assignee cancelled'::text;
  EXCEPTION WHEN OTHERS THEN log := log || ('ok assignee cannot cancel: ' || SQLERRM); END;
  UPDATE project_tasks SET status = 'Blocked' WHERE id = t1;
  UPDATE project_tasks SET status = 'Done' WHERE id = t1;
  SELECT (status = 'Done' AND completed_at IS NOT NULL) INTO ok FROM project_tasks WHERE id = t1;
  log := log || (CASE WHEN ok THEN 'ok ' ELSE 'FAIL ' END || 'Blocked -> Done sets completed_at');
  SELECT count(*) INTO n FROM task_activity WHERE task_id = t1 AND kind = 'status';
  log := log || (CASE WHEN n = 3 THEN 'ok ' ELSE 'FAIL ' END || '3 status changes logged, got ' || n);
  UPDATE project_tasks SET status = 'In Progress' WHERE id = t1;
  SELECT completed_at IS NULL INTO ok FROM project_tasks WHERE id = t1;
  log := log || (CASE WHEN ok THEN 'ok ' ELSE 'FAIL ' END || 'reopen clears completed_at');
  DELETE FROM project_tasks WHERE id = t1; GET DIAGNOSTICS n = ROW_COUNT;
  log := log || (CASE WHEN n = 0 THEN 'ok ' ELSE 'FAIL ' END || 'assignee cannot delete task');
  INSERT INTO task_activity (tenant_id, task_id, actor_id, kind, body) VALUES (ten, t1, s, 'comment', 'On it');
  SELECT count(*) INTO n FROM task_activity WHERE task_id = t1 AND kind = 'comment';
  log := log || (CASE WHEN n = 1 THEN 'ok ' ELSE 'FAIL ' END || 'assignee comments');
  BEGIN INSERT INTO task_activity (tenant_id, task_id, actor_id, kind, from_value, to_value) VALUES (ten, t1, s, 'status', 'Done', 'To Do'); log := log || 'FAIL forged activity row'::text;
  EXCEPTION WHEN OTHERS THEN log := log || 'ok cannot forge status activity'::text; END;
  BEGIN INSERT INTO task_activity (tenant_id, task_id, actor_id, kind, body) VALUES (ten, t1, hr, 'comment', 'as HR'); log := log || 'FAIL comment as someone else'::text;
  EXCEPTION WHEN OTHERS THEN log := log || 'ok cannot comment as another person'::text; END;
  BEGIN INSERT INTO project_tasks (tenant_id, title, assigned_to) VALUES (ten, '[TEST] to outsider', o); log := log || 'FAIL employee assigned outside team'::text;
  EXCEPTION WHEN OTHERS THEN log := log || ('ok employee cannot assign outside team: ' || SQLERRM); END;

  -- ── Suraj as d's manager ──────────────────────────────────────────────
  SELECT count(*) INTO n FROM task_assignable_people() p WHERE (p.id = s AND NOT p.is_team) OR (p.id = d AND p.is_team);
  SELECT count(*) = 2 AND n = 2 INTO ok FROM task_assignable_people();
  log := log || (CASE WHEN ok THEN 'ok ' ELSE 'FAIL ' END || 'picker = self + team (d flagged is_team)');
  INSERT INTO project_tasks (tenant_id, title, assigned_to, due_date) VALUES (ten, '[TEST] team task', d, td - 2) RETURNING id INTO t3;
  UPDATE project_tasks SET title = '[TEST] team task v2', priority = 'Urgent' WHERE id = t3;
  SELECT title = '[TEST] team task v2' INTO ok FROM project_tasks WHERE id = t3;
  log := log || (CASE WHEN ok THEN 'ok ' ELSE 'FAIL ' END || 'manager assigns to report and edits it');
  PERFORM set_config('request.jwt.claims', json_build_object('sub', d, 'role', 'authenticated')::text, true);
  BEGIN UPDATE project_tasks SET priority = 'Low' WHERE id = t3; log := log || 'FAIL report edited priority'::text;
  EXCEPTION WHEN OTHERS THEN log := log || 'ok report limited to status'::text; END;
  SELECT count(*) INTO n FROM project_tasks WHERE id = t1;
  log := log || (CASE WHEN n = 0 THEN 'ok ' ELSE 'FAIL ' END || 'report cannot see manager''s own task');

  -- ── Outsider ──────────────────────────────────────────────────────────
  PERFORM set_config('request.jwt.claims', json_build_object('sub', o, 'role', 'authenticated')::text, true);
  SELECT count(*) INTO n FROM project_tasks WHERE id IN (t1, t2, t3);
  log := log || (CASE WHEN n = 0 THEN 'ok ' ELSE 'FAIL ' END || 'outsider sees none of the tasks, got ' || n);
  UPDATE project_tasks SET status = 'Done' WHERE id = t1; GET DIAGNOSTICS n = ROW_COUNT;
  log := log || (CASE WHEN n = 0 THEN 'ok ' ELSE 'FAIL ' END || 'outsider cannot update');
  BEGIN INSERT INTO task_activity (tenant_id, task_id, actor_id, kind, body) VALUES (ten, t1, o, 'comment', 'peek'); log := log || 'FAIL outsider commented on hidden task'::text;
  EXCEPTION WHEN OTHERS THEN log := log || 'ok outsider cannot comment on hidden task'::text; END;
  SELECT count(*) INTO n FROM task_activity WHERE task_id = t1;
  log := log || (CASE WHEN n = 0 THEN 'ok ' ELSE 'FAIL ' END || 'outsider cannot read activity');
  SELECT count(*) INTO n FROM tenant_notification_channels;
  log := log || (CASE WHEN n = 0 THEN 'ok ' ELSE 'FAIL ' END || 'employee cannot read channel settings (Slack webhook)');

  -- ── HR oversight ──────────────────────────────────────────────────────
  PERFORM set_config('request.jwt.claims', json_build_object('sub', hr, 'role', 'authenticated')::text, true);
  SELECT count(*) INTO n FROM project_tasks WHERE id IN (t1, t2, t3);
  log := log || (CASE WHEN n = 3 THEN 'ok ' ELSE 'FAIL ' END || 'HR sees all 3');
  UPDATE project_tasks SET status = 'Cancelled' WHERE id = t2;
  SELECT status INTO v FROM project_tasks WHERE id = t2;
  log := log || (CASE WHEN v = 'Cancelled' THEN 'ok ' ELSE 'FAIL ' END || 'HR can cancel');

  -- ── Daily reminders (cron path, no JWT) ───────────────────────────────
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  INSERT INTO project_tasks (tenant_id, title, assigned_to, created_by, due_date) VALUES (ten, '[TEST] due tomorrow', s, hr, td + 1) RETURNING id INTO t4;
  PERFORM task_send_due_reminders();
  SELECT count(*) INTO n FROM app_notifications WHERE profile_id = d AND type = 'task_reminder' AND body LIKE '%team task v2%overdue%';
  log := log || (CASE WHEN n = 1 THEN 'ok ' ELSE 'FAIL ' END || 'overdue digest to assignee, got ' || n);
  SELECT count(*) INTO n FROM app_notifications WHERE profile_id = s AND type = 'task_reminder_assigner' AND body LIKE '%team task v2%';
  log := log || (CASE WHEN n = 1 THEN 'ok ' ELSE 'FAIL ' END || 'assigner told about overdue task, got ' || n);
  SELECT count(*) INTO n FROM app_notifications WHERE profile_id = s AND type = 'task_reminder' AND body LIKE '%due tomorrow%' AND body LIKE '%Prepare report%due today%';
  log := log || (CASE WHEN n = 1 THEN 'ok ' ELSE 'FAIL ' END || 'one digest for Suraj with today + tomorrow, got ' || n);
  SELECT count(*) INTO n FROM notification_outbox WHERE tenant_id = ten AND event = 'reminder_digest';
  log := log || (CASE WHEN n >= 2 THEN 'ok ' ELSE 'FAIL ' END || 'digests queued for email channel, got ' || n);
  PERFORM task_send_due_reminders();
  SELECT count(*) INTO n FROM app_notifications WHERE profile_id = s AND type = 'task_reminder' AND body LIKE '%due tomorrow%';
  log := log || (CASE WHEN n = 1 THEN 'ok ' ELSE 'FAIL ' END || 'second run same day sends nothing new');

  RAISE EXCEPTION 'TASK TEST REPORT%', E'\n' || array_to_string(log, E'\n');
END
$test$;
