-- Rollback test for 20261010_1_outlet_no_holidays.sql, on the user's own test tenant
-- (ed7b4ea0: admin Prakash ec70cb49 + employee Suraj 1016a8af share an outlet,
--  employee Test 8c1caf8d is in another one).
-- Run as one script AFTER the migration text, inside the same transaction; it always ends in
-- RAISE EXCEPTION carrying the results, so nothing is kept.

CREATE TEMP TABLE t_res (step serial, name text, ok boolean, detail text) ON COMMIT DROP;
GRANT ALL ON t_res TO authenticated;
GRANT USAGE ON SEQUENCE t_res_step_seq TO authenticated;

-- The migration itself: exactly the two Raniwala showrooms, nothing else anywhere.
INSERT INTO t_res (name, ok, detail)
SELECT 'only Delhi + Gurgaon are switched off', count(*) = 2 AND bool_and(t.company_name ILIKE '%Raniwala%'), string_agg(o.name, ', ' ORDER BY o.name)
FROM outlets o JOIN tenants t ON t.id = o.tenant_id WHERE NOT o.holidays_enabled;

INSERT INTO holidays (tenant_id, outlet_id, name, date, type) VALUES
  ('ed7b4ea0-b8f6-4389-a6e6-2baf400221aa', NULL, '[TEST] company-wide', '2031-01-15', 'Test'),
  ('ed7b4ea0-b8f6-4389-a6e6-2baf400221aa', (SELECT outlet_id FROM profiles WHERE id = '1016a8af-ba5a-400a-9b9d-c6750a3125a9'), '[TEST] own outlet', '2031-01-16', 'Test');

UPDATE tenants SET auto_comp_off_on_weekly_off_worked = true WHERE id = 'ed7b4ea0-b8f6-4389-a6e6-2baf400221aa';
UPDATE profiles SET comp_off_eligible = true
WHERE id IN ('1016a8af-ba5a-400a-9b9d-c6750a3125a9', '8c1caf8d-7eb8-4f3c-9380-bc47d1eb1353');

-- ── before: every outlet observes holidays (default) ──
SELECT set_config('request.jwt.claims', '{"sub":"1016a8af-ba5a-400a-9b9d-c6750a3125a9","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
INSERT INTO t_res (name, ok, detail)
SELECT 'default: employee sees holidays', count(*) FILTER (WHERE name LIKE '[TEST]%') = 2, count(*)::text FROM holidays;
RESET ROLE;

-- ── switch Suraj's (and Prakash's) outlet to no holidays ──
UPDATE outlets SET holidays_enabled = false
WHERE id = (SELECT outlet_id FROM profiles WHERE id = '1016a8af-ba5a-400a-9b9d-c6750a3125a9');

SELECT set_config('request.jwt.claims', '{"sub":"1016a8af-ba5a-400a-9b9d-c6750a3125a9","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
INSERT INTO t_res (name, ok, detail)
SELECT 'no-holiday outlet: employee sees none at all', count(*) = 0, count(*)::text FROM holidays;
RESET ROLE;

SELECT set_config('request.jwt.claims', '{"sub":"8c1caf8d-7eb8-4f3c-9380-bc47d1eb1353","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
INSERT INTO t_res (name, ok, detail)
SELECT 'other outlet: employee still sees holidays', count(*) FILTER (WHERE name LIKE '[TEST]%') = 2, count(*)::text FROM holidays;
RESET ROLE;

SELECT set_config('request.jwt.claims', '{"sub":"ec70cb49-7c53-4345-986a-ccc787f8d606","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
INSERT INTO t_res (name, ok, detail)
SELECT 'HR in the no-holiday outlet still sees them to manage', count(*) FILTER (WHERE name LIKE '[TEST]%') = 2, count(*)::text FROM holidays;
INSERT INTO t_res (name, ok, detail)
SELECT 'HR sees no other tenant''s holidays', count(*) = 0, count(*)::text FROM holidays WHERE tenant_id <> 'ed7b4ea0-b8f6-4389-a6e6-2baf400221aa';
RESET ROLE;

-- ── comp-off: working on the company-wide holiday (2031-01-15, a Wednesday) ──
INSERT INTO attendance (tenant_id, profile_id, date, status, total_hours, location) VALUES
  ('ed7b4ea0-b8f6-4389-a6e6-2baf400221aa', '1016a8af-ba5a-400a-9b9d-c6750a3125a9', '2031-01-15', 'Late', 8, 'Office'),
  ('ed7b4ea0-b8f6-4389-a6e6-2baf400221aa', '8c1caf8d-7eb8-4f3c-9380-bc47d1eb1353', '2031-01-15', 'Late', 8, 'Office');

INSERT INTO t_res (name, ok, detail)
SELECT 'no-holiday outlet: holiday worked = ordinary day, no comp-off',
  NOT COALESCE(comp_off_granted, false) AND COALESCE(comp_off_credit, 0) = 0 AND status = 'Late',
  format('granted %s credit %s status %s', comp_off_granted, comp_off_credit, status)
FROM attendance WHERE profile_id = '1016a8af-ba5a-400a-9b9d-c6750a3125a9' AND date = '2031-01-15';

INSERT INTO t_res (name, ok, detail)
SELECT 'other outlet: holiday worked still earns comp-off',
  COALESCE(comp_off_granted, false) AND comp_off_credit = 1 AND status = 'Present',
  format('granted %s credit %s status %s', comp_off_granted, comp_off_credit, status)
FROM attendance WHERE profile_id = '8c1caf8d-7eb8-4f3c-9380-bc47d1eb1353' AND date = '2031-01-15';

-- Weekly off still counts at the no-holiday outlet (2031-01-19 is a Sunday).
UPDATE outlets SET weekly_off_days = ARRAY[0]
WHERE id = (SELECT outlet_id FROM profiles WHERE id = '1016a8af-ba5a-400a-9b9d-c6750a3125a9');
INSERT INTO attendance (tenant_id, profile_id, date, status, total_hours, location) VALUES
  ('ed7b4ea0-b8f6-4389-a6e6-2baf400221aa', '1016a8af-ba5a-400a-9b9d-c6750a3125a9', '2031-01-19', 'Present', 8, 'Office');
INSERT INTO t_res (name, ok, detail)
SELECT 'no-holiday outlet: weekly off worked still earns comp-off',
  COALESCE(comp_off_granted, false) AND comp_off_credit = 1,
  format('granted %s credit %s', comp_off_granted, comp_off_credit)
FROM attendance WHERE profile_id = '1016a8af-ba5a-400a-9b9d-c6750a3125a9' AND date = '2031-01-19';

-- Switching the outlet back on restores both behaviours.
UPDATE outlets SET holidays_enabled = true
WHERE id = (SELECT outlet_id FROM profiles WHERE id = '1016a8af-ba5a-400a-9b9d-c6750a3125a9');
-- A fresh day on the outlet's own holiday (2031-01-16, a Thursday).
INSERT INTO attendance (tenant_id, profile_id, date, status, total_hours, location) VALUES
  ('ed7b4ea0-b8f6-4389-a6e6-2baf400221aa', '1016a8af-ba5a-400a-9b9d-c6750a3125a9', '2031-01-16', 'Present', 8, 'Office');
INSERT INTO t_res (name, ok, detail)
SELECT 'switched back on: holiday worked earns comp-off again',
  COALESCE(comp_off_granted, false) AND comp_off_credit = 1,
  format('granted %s credit %s', comp_off_granted, comp_off_credit)
FROM attendance WHERE profile_id = '1016a8af-ba5a-400a-9b9d-c6750a3125a9' AND date = '2031-01-16';

SELECT set_config('request.jwt.claims', '{"sub":"1016a8af-ba5a-400a-9b9d-c6750a3125a9","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
INSERT INTO t_res (name, ok, detail)
SELECT 'switched back on: employee sees holidays again', count(*) FILTER (WHERE name LIKE '[TEST]%') = 2, count(*)::text FROM holidays;
RESET ROLE;

DO $$ DECLARE s text; f int; BEGIN
  SELECT string_agg(format('%s %s %s — %s', step, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END, name, left(detail, 140)), E'\n' ORDER BY step),
         count(*) FILTER (WHERE NOT ok)
    INTO s, f FROM t_res;
  RAISE EXCEPTION E'ROLLBACK — % failed\n%', f, s;
END $$;
