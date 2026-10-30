-- Rollback test for 20261008_1_comms_manage_archive.sql, on the user's own test tenant
-- (ed7b4ea0: admin Prakash ec70cb49 [HR, outlet 9879f8cc], employee Suraj 1016a8af [Team, outlet 9879f8cc],
--  employee Test 8c1caf8d [HR, outlet f71119e4]).
-- Run as one script AFTER the migration text, inside the same transaction; it always ends in
-- RAISE EXCEPTION carrying the results, so nothing is kept (notifications/webhook rows included).

CREATE TEMP TABLE t_res (step serial, name text, ok boolean, detail text) ON COMMIT DROP;
CREATE TEMP TABLE t_ids (name text PRIMARY KEY, id uuid) ON COMMIT DROP;
GRANT ALL ON t_res, t_ids TO authenticated;
GRANT USAGE ON SEQUENCE t_res_step_seq TO authenticated;

CREATE TEMP VIEW t_notif AS SELECT related_id, count(*) n FROM app_notifications GROUP BY related_id;

-- ── as admin Prakash ──
SELECT set_config('request.jwt.claims', '{"sub":"ec70cb49-7c53-4345-986a-ccc787f8d606","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

WITH ins AS (INSERT INTO announcements (tenant_id, created_by, title, body, kind, status, requires_ack)
  VALUES ('ed7b4ea0-b8f6-4389-a6e6-2baf400221aa', 'ec70cb49-7c53-4345-986a-ccc787f8d606', '[TEST] draft', 'b', 'important', 'draft', false) RETURNING id)
INSERT INTO t_ids SELECT 'draft', id FROM ins;

WITH ins AS (INSERT INTO announcements (tenant_id, created_by, title, body, kind, audience, audience_departments)
  VALUES ('ed7b4ea0-b8f6-4389-a6e6-2baf400221aa', 'ec70cb49-7c53-4345-986a-ccc787f8d606', '[TEST] HR only', 'b', 'update', 'departments', ARRAY['HR']) RETURNING id)
INSERT INTO t_ids SELECT 'hr', id FROM ins;

WITH ins AS (INSERT INTO announcements (tenant_id, created_by, title, body, kind, audience, audience_outlets)
  VALUES ('ed7b4ea0-b8f6-4389-a6e6-2baf400221aa', 'ec70cb49-7c53-4345-986a-ccc787f8d606', '[TEST] other outlet', 'b', 'alert', 'outlets', ARRAY['f71119e4-fdf0-42ab-8280-1c9ac82b332f'::uuid]) RETURNING id)
INSERT INTO t_ids SELECT 'outlet', id FROM ins;

WITH ins AS (INSERT INTO announcements (tenant_id, created_by, title, body, publish_at)
  VALUES ('ed7b4ea0-b8f6-4389-a6e6-2baf400221aa', 'ec70cb49-7c53-4345-986a-ccc787f8d606', '[TEST] scheduled', 'b', now() + interval '1 hour') RETURNING id)
INSERT INTO t_ids SELECT 'scheduled', id FROM ins;

WITH ins AS (INSERT INTO announcements (tenant_id, created_by, title, body, expires_at)
  VALUES ('ed7b4ea0-b8f6-4389-a6e6-2baf400221aa', 'ec70cb49-7c53-4345-986a-ccc787f8d606', '[TEST] expired', 'b', now() - interval '1 minute') RETURNING id)
INSERT INTO t_ids SELECT 'expired', id FROM ins;

-- App-style insert (only the old columns): must behave exactly as before.
WITH ins AS (INSERT INTO announcements (tenant_id, created_by, title, message)
  VALUES ('ed7b4ea0-b8f6-4389-a6e6-2baf400221aa', 'ec70cb49-7c53-4345-986a-ccc787f8d606', '[TEST] app style', 'from the app') RETURNING id)
INSERT INTO t_ids SELECT 'appstyle', id FROM ins;

WITH ins AS (INSERT INTO policies (tenant_id, created_by, title, body, status, category)
  VALUES ('ed7b4ea0-b8f6-4389-a6e6-2baf400221aa', 'ec70cb49-7c53-4345-986a-ccc787f8d606', '[TEST] draft policy', 'p', 'draft', 'hr') RETURNING id)
INSERT INTO t_ids SELECT 'policy', id FROM ins;

INSERT INTO t_res (name, ok, detail)
SELECT 'admin sees own drafts', count(*) = 7, count(*)::text FROM (
  SELECT id FROM announcements WHERE title LIKE '[TEST]%' UNION ALL SELECT id FROM policies WHERE title LIKE '[TEST]%') x;

-- Cross-tenant: an admin can't touch another company's rows.
DO $$ DECLARE n int; BEGIN
  UPDATE announcements SET title = title WHERE tenant_id <> 'ed7b4ea0-b8f6-4389-a6e6-2baf400221aa';
  GET DIAGNOSTICS n = ROW_COUNT;
  INSERT INTO t_res (name, ok, detail) VALUES ('admin cannot update other tenants', n = 0, n::text);
END $$;

RESET ROLE;
INSERT INTO t_res (name, ok, detail)
SELECT 'draft sends nothing', coalesce((SELECT n FROM t_notif WHERE related_id = (SELECT id FROM t_ids WHERE name = 'draft')), 0) = 0, '';
INSERT INTO t_res (name, ok, detail)
SELECT 'HR-only notifies HR dept minus author (2)', n = 2, n::text FROM (SELECT coalesce((SELECT n FROM t_notif WHERE related_id = (SELECT id FROM t_ids WHERE name = 'hr')), 0) n) x;
INSERT INTO t_res (name, ok, detail)
SELECT 'scheduled not sent yet', coalesce((SELECT n FROM t_notif WHERE related_id = (SELECT id FROM t_ids WHERE name = 'scheduled')), 0) = 0, '';
INSERT INTO t_res (name, ok, detail)
SELECT 'expired not sent', coalesce((SELECT n FROM t_notif WHERE related_id = (SELECT id FROM t_ids WHERE name = 'expired')), 0) = 0, '';
INSERT INTO t_res (name, ok, detail)
SELECT 'app-style post: published, ack on, everyone notified (7)',
  a.status = 'published' AND a.requires_ack AND a.audience = 'all' AND n.n = 7, a.status || ' ' || a.requires_ack || ' ' || coalesce(n.n, 0)
FROM announcements a LEFT JOIN t_notif n ON n.related_id = a.id WHERE a.id = (SELECT id FROM t_ids WHERE name = 'appstyle');
INSERT INTO t_res (name, ok, detail)
SELECT 'draft policy sends nothing', coalesce((SELECT n FROM t_notif WHERE related_id = (SELECT id FROM t_ids WHERE name = 'policy')), 0) = 0, '';

-- ── as employee Suraj (Team, outlet 9879f8cc) ──
SELECT set_config('request.jwt.claims', '{"sub":"1016a8af-ba5a-400a-9b9d-c6750a3125a9","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

INSERT INTO t_res (name, ok, detail)
SELECT 'employee sees only app-style post', string_agg(title, ',') = '[TEST] app style', string_agg(title, ',')
FROM announcements WHERE title LIKE '[TEST]%';
INSERT INTO t_res (name, ok, detail)
SELECT 'employee cannot see draft policy', count(*) = 0, count(*)::text FROM policies WHERE title LIKE '[TEST]%';

DO $$ BEGIN
  INSERT INTO announcements (tenant_id, created_by, title) VALUES ('ed7b4ea0-b8f6-4389-a6e6-2baf400221aa', '1016a8af-ba5a-400a-9b9d-c6750a3125a9', '[TEST] by employee');
  INSERT INTO t_res (name, ok, detail) VALUES ('employee cannot post', false, 'insert succeeded');
EXCEPTION WHEN others THEN
  INSERT INTO t_res (name, ok, detail) VALUES ('employee cannot post', true, SQLERRM);
END $$;

DO $$ BEGIN
  PERFORM announcement_receipts((SELECT id FROM t_ids WHERE name = 'appstyle'));
  INSERT INTO t_res (name, ok, detail) VALUES ('employee cannot read receipts', false, 'allowed');
EXCEPTION WHEN others THEN
  INSERT INTO t_res (name, ok, detail) VALUES ('employee cannot read receipts', true, SQLERRM);
END $$;

-- ── as employee Test (HR, outlet f71119e4) ──
SELECT set_config('request.jwt.claims', '{"sub":"8c1caf8d-7eb8-4f3c-9380-bc47d1eb1353","role":"authenticated"}', true);
INSERT INTO t_res (name, ok, detail)
SELECT 'HR/other-outlet employee sees HR + outlet + app posts', count(*) = 3, string_agg(title, ',')
FROM announcements WHERE title LIKE '[TEST]%';

-- ── admin: publish draft, release schedule, archive, policy versions, receipts ──
SELECT set_config('request.jwt.claims', '{"sub":"ec70cb49-7c53-4345-986a-ccc787f8d606","role":"authenticated"}', true);
UPDATE announcements SET status = 'published' WHERE id = (SELECT id FROM t_ids WHERE name = 'draft');
UPDATE policies SET status = 'published' WHERE id = (SELECT id FROM t_ids WHERE name = 'policy');
INSERT INTO t_res (name, ok, detail)
SELECT 'receipts list the audience (8 incl. admins)', count(*) = 8, count(*)::text FROM announcement_receipts((SELECT id FROM t_ids WHERE name = 'appstyle'));

UPDATE announcements SET status = 'archived' WHERE id = (SELECT id FROM t_ids WHERE name = 'hr');
INSERT INTO t_res (name, ok, detail)
SELECT 'archive stamps archived_at', archived_at IS NOT NULL, coalesce(archived_at::text, 'null') FROM announcements WHERE id = (SELECT id FROM t_ids WHERE name = 'hr');
DO $$ BEGIN
  UPDATE announcements SET title = 'x' WHERE id = (SELECT id FROM t_ids WHERE name = 'hr');
  INSERT INTO t_res (name, ok, detail) VALUES ('archived item cannot be edited', false, 'edited');
EXCEPTION WHEN others THEN
  INSERT INTO t_res (name, ok, detail) VALUES ('archived item cannot be edited', true, SQLERRM);
END $$;

RESET ROLE;
INSERT INTO t_res (name, ok, detail)
SELECT 'publishing draft notifies everyone minus author (7)', n = 7, n::text FROM (SELECT coalesce((SELECT n FROM t_notif WHERE related_id = (SELECT id FROM t_ids WHERE name = 'draft')), 0) n) x;
INSERT INTO t_res (name, ok, detail)
SELECT 'publishing policy notifies (7)', n = 7, n::text FROM (SELECT coalesce((SELECT n FROM t_notif WHERE related_id = (SELECT id FROM t_ids WHERE name = 'policy')), 0) n) x;

UPDATE announcements SET publish_at = now() - interval '1 minute' WHERE id = (SELECT id FROM t_ids WHERE name = 'scheduled');
SELECT comms_release_scheduled();
INSERT INTO t_res (name, ok, detail)
SELECT 'scheduled post released once (7)', n = 7, n::text FROM (SELECT coalesce((SELECT n FROM t_notif WHERE related_id = (SELECT id FROM t_ids WHERE name = 'scheduled')), 0) n) x;

-- Suraj acknowledges the policy, then HR publishes version 2 asking again.
INSERT INTO policy_acknowledgements (policy_id, profile_id, tenant_id, source)
VALUES ((SELECT id FROM t_ids WHERE name = 'policy'), '1016a8af-ba5a-400a-9b9d-c6750a3125a9', 'ed7b4ea0-b8f6-4389-a6e6-2baf400221aa', 'web');
SELECT set_config('request.jwt.claims', '{"sub":"ec70cb49-7c53-4345-986a-ccc787f8d606","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT policy_new_version((SELECT id FROM t_ids WHERE name = 'policy'), 'Leave rules changed', true);
RESET ROLE;
INSERT INTO t_res (name, ok, detail)
SELECT 'new version: v2, history kept with ack count, acks cleared, re-notified (14)',
  p.version_no = 2 AND jsonb_array_length(p.version_history) = 1 AND (p.version_history -> 0 ->> 'ack_count')::int = 1
  AND NOT EXISTS (SELECT 1 FROM policy_acknowledgements WHERE policy_id = p.id) AND n.n = 14,
  p.version_no || ' ' || p.version_history::text || ' notif ' || n.n
FROM policies p JOIN t_notif n ON n.related_id = p.id WHERE p.id = (SELECT id FROM t_ids WHERE name = 'policy');

SELECT set_config('request.jwt.claims', '{"sub":"1016a8af-ba5a-400a-9b9d-c6750a3125a9","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
DO $$ BEGIN
  PERFORM policy_new_version((SELECT id FROM t_ids WHERE name = 'policy'), 'x', true);
  INSERT INTO t_res (name, ok, detail) VALUES ('employee cannot version a policy', false, 'allowed');
EXCEPTION WHEN others THEN
  INSERT INTO t_res (name, ok, detail) VALUES ('employee cannot version a policy', true, SQLERRM);
END $$;
RESET ROLE;

-- Birthday posts: opt-in tenant, idempotent, quiet, outlet-scoped.
UPDATE tenants SET auto_birthday_posts = true WHERE id = 'ed7b4ea0-b8f6-4389-a6e6-2baf400221aa';
UPDATE profiles SET date_of_birth = ((now() AT TIME ZONE 'Asia/Kolkata')::date - interval '25 years')::date WHERE id = '1016a8af-ba5a-400a-9b9d-c6750a3125a9';
INSERT INTO t_res (name, ok, detail)
SELECT 'birthday job posts >= 1, then 0 (idempotent)', a >= 1 AND b = 0, a || ' then ' || b
FROM (SELECT comms_post_birthdays() a) x, LATERAL (SELECT comms_post_birthdays() b) y;
INSERT INTO t_res (name, ok, detail)
SELECT 'birthday post is quiet and outlet-scoped',
  a.kind = 'birthday' AND a.audience = 'outlets' AND coalesce(n.n, 0) = 0 AND a.notified_at IS NOT NULL, a.title || ' notif ' || coalesce(n.n, 0)
FROM announcements a LEFT JOIN t_notif n ON n.related_id = a.id WHERE a.subject_profile_id = '1016a8af-ba5a-400a-9b9d-c6750a3125a9';

SELECT set_config('request.jwt.claims', '{"sub":"8c1caf8d-7eb8-4f3c-9380-bc47d1eb1353","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
INSERT INTO t_res (name, ok, detail)
SELECT 'other-outlet employee does not see the birthday post', count(*) = 0, count(*)::text FROM announcements WHERE kind = 'birthday';
RESET ROLE;

DO $$ DECLARE s text; f int; BEGIN
  SELECT string_agg(format('%s %s %s — %s', step, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END, name, left(detail, 140)), E'\n' ORDER BY step),
         count(*) FILTER (WHERE NOT ok)
    INTO s, f FROM t_res;
  RAISE EXCEPTION E'ROLLBACK — % failed\n%', f, s;
END $$;
