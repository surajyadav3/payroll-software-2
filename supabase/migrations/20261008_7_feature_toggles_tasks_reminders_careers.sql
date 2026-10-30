-- Superadmin Toggle Services: make the Tasks / Task Reminders / Careers Page
-- switches actually take effect on the server, not just hide web UI.
--
--   * 'tasks' off           → no daily due/overdue reminders (in-app or external).
--   * 'task_reminders' off  → nothing is queued for Slack / email / WhatsApp
--                             (the in-app bell and mobile push are untouched).
--   * 'careers_page' off    → the public /careers/<slug> page reads as "not found".
--
-- All three use the existing ai_feature_enabled(tenant, outlet, key) helper:
-- company-wide override, else features.is_premium default, else ON. Both new
-- keys default ON, so no company changes behaviour until a superadmin turns
-- one off. Function bodies are the live definitions with only the feature
-- check added. Additive; safe to re-run.

BEGIN;

-- Rows up front so Toggle Services lists them even before the web registry
-- sync runs (the sync upserts the same values).
INSERT INTO features (key, name, category, description, sort_order, is_premium) VALUES
  ('task_reminders', 'Task Reminders (Slack / Email / WhatsApp)', 'General',
   'Daily due/overdue digests and assignment/status alerts sent outside the app, over the channels HR sets up in Settings. The in-app bell and mobile push are not affected. Needs Task Management on.',
   96, false),
  ('careers_page', 'Careers Page', 'Hiring',
   'Public careers page (crewcore.in/careers/<company>) listing open job postings, with online applications and CV upload. HR still switches it on and picks the URL from Job Postings.',
   302, false)
ON CONFLICT (key) DO NOTHING;

-- 1. External notifications: honour Task Management + Task Reminders.
CREATE OR REPLACE FUNCTION public.notification_enqueue(p_tenant uuid, p_event text, p_task uuid, p_recipients uuid[], p_payload jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  c tenant_notification_channels;
BEGIN
  IF NOT ai_feature_enabled(p_tenant, NULL, 'tasks')
     OR NOT ai_feature_enabled(p_tenant, NULL, 'task_reminders') THEN
    RETURN;
  END IF;
  SELECT * INTO c FROM tenant_notification_channels WHERE tenant_id = p_tenant;
  IF NOT FOUND OR NOT (c.slack_enabled OR c.email_enabled OR c.whatsapp_enabled) THEN
    RETURN;
  END IF;
  IF p_event IN ('task_assigned','task_status') AND NOT c.notify_status_changes THEN
    RETURN;
  END IF;
  INSERT INTO notification_outbox (tenant_id, event, task_id, recipients, payload)
  VALUES (p_tenant, p_event, p_task, COALESCE(p_recipients, '{}'), COALESCE(p_payload, '{}'::jsonb));
END;
$function$;

-- 2. Daily reminder job: skip companies with Task Management off.
CREATE OR REPLACE FUNCTION public.task_send_due_reminders()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  r record;
  v_count int := 0;
BEGIN
  DROP TABLE IF EXISTS _due;
  CREATE TEMP TABLE _due ON COMMIT DROP AS
  SELECT t.id, t.tenant_id, t.title, COALESCE(t.revised_due_date, t.due_date) AS due_date, t.priority, t.assigned_to, t.created_by,
         CASE WHEN COALESCE(t.revised_due_date, t.due_date) < v_today THEN 'overdue'
              WHEN COALESCE(t.revised_due_date, t.due_date) = v_today THEN 'today' ELSE 'tomorrow' END AS bucket
  FROM project_tasks t
  JOIN profiles a ON a.id = t.assigned_to AND a.status = 'Active'
  WHERE t.status IN ('To Do','In Progress','Blocked')
    AND COALESCE(t.revised_due_date, t.due_date) IS NOT NULL
    AND COALESCE(t.revised_due_date, t.due_date) <= v_today + 1
    AND (t.last_reminded_on IS NULL OR t.last_reminded_on < v_today)
    AND NOT EXISTS (SELECT 1 FROM tenant_notification_channels c
                    WHERE c.tenant_id = t.tenant_id AND NOT c.daily_reminders)
    AND ai_feature_enabled(t.tenant_id, NULL, 'tasks');

  -- One digest per assignee.
  FOR r IN
    SELECT tenant_id, assigned_to,
           count(*) AS n,
           count(*) FILTER (WHERE bucket = 'overdue') AS n_over,
           count(*) FILTER (WHERE bucket = 'today') AS n_today,
           string_agg(format('• %s (%s)', title,
             CASE bucket WHEN 'overdue' THEN 'overdue since ' || to_char(due_date, 'DD Mon')
                         WHEN 'today' THEN 'due today' ELSE 'due tomorrow' END),
             E'\n' ORDER BY due_date, title) AS lines,
           jsonb_agg(jsonb_build_object('id', id, 'title', title, 'due_date', due_date, 'bucket', bucket, 'priority', priority)
                     ORDER BY due_date) AS items
    FROM _due GROUP BY tenant_id, assigned_to
  LOOP
    INSERT INTO app_notifications (tenant_id, profile_id, type, title, body, link_key)
    VALUES (r.tenant_id, r.assigned_to, 'task_reminder',
      CASE WHEN r.n_over > 0 THEN format('%s task%s overdue', r.n_over, CASE WHEN r.n_over = 1 THEN '' ELSE 's' END)
           ELSE format('%s task%s due soon', r.n, CASE WHEN r.n = 1 THEN '' ELSE 's' END) END,
      left(r.lines, 600), 'tasks');
    PERFORM notification_enqueue(r.tenant_id, 'reminder_digest', NULL, ARRAY[r.assigned_to],
      jsonb_build_object('kind', 'assignee', 'items', r.items));
    v_count := v_count + 1;
  END LOOP;

  -- Assigners: overdue tasks they gave to someone else.
  FOR r IN
    SELECT d.tenant_id, d.created_by, count(*) AS n,
           string_agg(format('• %s — %s', d.title, btrim(concat_ws(' ', a.first_name, a.last_name))), E'\n' ORDER BY d.due_date) AS lines
    FROM _due d JOIN profiles a ON a.id = d.assigned_to
    JOIN profiles c ON c.id = d.created_by AND c.status = 'Active'
    WHERE d.bucket = 'overdue' AND d.created_by IS DISTINCT FROM d.assigned_to
    GROUP BY d.tenant_id, d.created_by
  LOOP
    INSERT INTO app_notifications (tenant_id, profile_id, type, title, body, link_key)
    VALUES (r.tenant_id, r.created_by, 'task_reminder_assigner',
      format('%s task%s you assigned %s overdue', r.n, CASE WHEN r.n = 1 THEN '' ELSE 's' END, CASE WHEN r.n = 1 THEN 'is' ELSE 'are' END),
      left(r.lines, 600), 'tasks');
  END LOOP;

  UPDATE project_tasks t SET last_reminded_on = v_today FROM _due d WHERE d.id = t.id;
  RETURN v_count;
END;
$function$;

-- 3. Public careers page: hidden when the superadmin switches Careers Page off.
CREATE OR REPLACE FUNCTION public.careers_list_openings(p_slug text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT CASE WHEN t.id IS NULL THEN NULL ELSE jsonb_build_object(
    'company', t.company_name,
    'intro', t.careers_intro,
    'openings', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', j.id, 'title', j.title, 'department', j.department, 'location', j.location,
        'employment_type', j.employment_type, 'experience_required', j.experience_required,
        'openings', j.openings, 'description', j.description, 'responsibilities', j.responsibilities,
        'requirements', j.requirements, 'closing_date', j.closing_date, 'posted_on', j.created_at::date)
        ORDER BY j.created_at DESC)
      FROM job_postings j
      WHERE j.tenant_id = t.id AND j.status = 'Open'
        AND (j.closing_date IS NULL OR j.closing_date >= (now() AT TIME ZONE 'Asia/Kolkata')::date)
    ), '[]'::jsonb)) END
  FROM (SELECT NULL::uuid AS id) dummy
  LEFT JOIN tenants t ON t.careers_slug = lower(btrim(p_slug)) AND t.careers_enabled
                     AND ai_feature_enabled(t.id, NULL, 'careers_page');
$function$;

COMMIT;
