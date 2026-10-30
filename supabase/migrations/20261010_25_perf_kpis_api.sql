-- =============================================================
-- Performance 2/2 — the monthly KPI register and the single entry point.
--
-- KPI register (the new platform's database/migrations/0035_pms_kpis.sql and
-- apps/api/src/modules/pms/kpi*.ts): KPIs for a person, a department or the
-- company; a target per month; each month an Expected and an Actual value
-- (late entries are accepted and tagged Delayed, never blocked); draft →
-- submitted → confirmed / returned by an approver who is never the
-- submitter; achievement %, health, quarter- and year-to-date.
--
-- perf_api(method, path, query, body) mirrors the platform's REST routes
-- (/pms/…, /departments/tree) the way work_api() does for Work.
-- Needs 20261010_21–24. Re-runnable.
-- =============================================================

-- ── 1. Tables ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS perf_kpi_settings (
  tenant_id        uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  fy_start_month   smallint NOT NULL DEFAULT 4 CHECK (fy_start_month BETWEEN 1 AND 12),
  expected_due_day smallint NOT NULL DEFAULT 15 CHECK (expected_due_day BETWEEN 1 AND 28),
  actual_due_day   smallint NOT NULL DEFAULT 10 CHECK (actual_due_day BETWEEN 1 AND 28),
  score_cap        numeric(5,2) NOT NULL DEFAULT 120 CHECK (score_cap BETWEEN 100 AND 200),
  next_number      integer NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS perf_kpis (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number        integer NOT NULL,
  level         text NOT NULL CHECK (level IN ('company','department','individual')),
  owner_id      uuid REFERENCES profiles(id) ON DELETE CASCADE,
  department_id uuid REFERENCES departments(id) ON DELETE CASCADE,
  title         text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  definition    text NOT NULL DEFAULT '' CHECK (char_length(definition) <= 4000),
  unit          text NOT NULL DEFAULT '' CHECK (char_length(unit) <= 40),
  kind          text NOT NULL DEFAULT 'volume' CHECK (kind IN ('volume','rate','average','snapshot','milestone','rubric','zero_incidents')),
  direction     text NOT NULL DEFAULT 'higher' CHECK (direction IN ('higher','lower')),
  aggregation   text NOT NULL DEFAULT 'sum' CHECK (aggregation IN ('sum','average','latest')),
  frequency     text NOT NULL DEFAULT 'monthly' CHECK (frequency IN ('monthly','quarterly','annual')),
  kra           text CHECK (kra IS NULL OR char_length(kra) <= 120),
  weight        numeric(5,2) CHECK (weight > 0 AND weight <= 100),
  is_priority   boolean NOT NULL DEFAULT false,
  goal_id       uuid REFERENCES perf_goals(id) ON DELETE SET NULL,
  submitter_id  uuid REFERENCES profiles(id) ON DELETE SET NULL,
  approver_id   uuid REFERENCES profiles(id) ON DELETE SET NULL,
  milestones    jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(milestones) = 'array'),   -- [{id, title, weight}]
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  archived_at   timestamptz,
  created_by    uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  version       integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, number),
  CHECK ((level = 'individual' AND owner_id IS NOT NULL AND department_id IS NULL)
      OR (level = 'department' AND department_id IS NOT NULL AND owner_id IS NULL)
      OR (level = 'company' AND department_id IS NULL AND owner_id IS NULL)),
  CHECK (kind <> 'zero_incidents' OR direction = 'lower')
);
CREATE INDEX IF NOT EXISTS perf_kpis_owner_idx ON perf_kpis(owner_id) WHERE owner_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS perf_kpi_targets (
  kpi_id     uuid NOT NULL REFERENCES perf_kpis(id) ON DELETE CASCADE,
  period     date NOT NULL CHECK (extract(day FROM period) = 1),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  target     numeric(18,4) NOT NULL,
  updated_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kpi_id, period)
);
CREATE TABLE IF NOT EXISTS perf_kpi_entries (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kpi_id               uuid NOT NULL REFERENCES perf_kpis(id) ON DELETE CASCADE,
  period               date NOT NULL CHECK (extract(day FROM period) = 1),
  expected             numeric(18,4),
  actual               numeric(18,4),
  numerator            numeric(18,4),
  denominator          numeric(18,4) CHECK (denominator IS NULL OR denominator > 0),
  completed_milestones text[] NOT NULL DEFAULT '{}',
  not_applicable       boolean NOT NULL DEFAULT false,
  note                 text NOT NULL DEFAULT '' CHECK (char_length(note) <= 2000),
  status               text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','confirmed','returned')),
  expected_filled_at   timestamptz,
  actual_filled_at     timestamptz,
  expected_delayed     boolean NOT NULL DEFAULT false,
  actual_delayed       boolean NOT NULL DEFAULT false,
  submitted_by         uuid REFERENCES profiles(id) ON DELETE SET NULL,
  submitted_at         timestamptz,
  decided_by           uuid REFERENCES profiles(id) ON DELETE SET NULL,
  decided_at           timestamptz,
  return_reason        text CHECK (return_reason IS NULL OR char_length(return_reason) <= 500),
  version              integer NOT NULL DEFAULT 1,
  UNIQUE (kpi_id, period),
  CHECK ((status = 'returned') = (return_reason IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS perf_kpi_entry_events (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entry_id  uuid NOT NULL REFERENCES perf_kpi_entries(id) ON DELETE CASCADE,
  kind      text NOT NULL CHECK (kind IN ('save','submit','confirm','return','reopen')),
  actor_id  uuid REFERENCES profiles(id) ON DELETE SET NULL,
  reason    text,
  changes   jsonb NOT NULL DEFAULT '{}'::jsonb,
  at        timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS perf_kpi_entry_events_entry_idx ON perf_kpi_entry_events(entry_id, at DESC);

-- Tasks linked to goals (shown on the task; the link is by people who can see both).
CREATE TABLE IF NOT EXISTS work_task_goal_links (
  task_id   uuid NOT NULL REFERENCES project_tasks(id) ON DELETE CASCADE,
  goal_id   uuid NOT NULL REFERENCES perf_goals(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, goal_id)
);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['perf_kpi_settings','perf_kpis','perf_kpi_targets','perf_kpi_entries','perf_kpi_entry_events','work_task_goal_links'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);   -- no policies: perf_api() / work_api() only
  END LOOP;
END $$;
DROP TRIGGER IF EXISTS perf_kpis_touch ON perf_kpis;
CREATE TRIGGER perf_kpis_touch BEFORE UPDATE ON perf_kpis FOR EACH ROW EXECUTE FUNCTION trg_perf_touch();

-- Task ↔ goal links now exist (placeholders from 20261010_22).
CREATE OR REPLACE FUNCTION work_task_goals(p_task uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', g.id, 'title', g.title) ORDER BY g.title), '[]'::jsonb)
  FROM work_task_goal_links l JOIN perf_goals g ON g.id = l.goal_id WHERE l.task_id = p_task;
$$;
CREATE OR REPLACE FUNCTION work_set_goals(c work_ctx, p_task uuid, p_goals uuid[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_ids uuid[] := ARRAY(SELECT DISTINCT x FROM unnest(p_goals) x WHERE x IS NOT NULL);
BEGIN
  IF cardinality(v_ids) > 10 THEN PERFORM work_fail('VALIDATION', 'Link at most 10 goals.'); END IF;
  IF (SELECT count(*) FROM perf_goals g WHERE g.id = ANY (v_ids) AND g.tenant_id = c.tenant
        AND (g.owner_id IS NOT DISTINCT FROM c.me OR perf_manages(c, g.owner_id))) <> cardinality(v_ids) THEN
    PERFORM work_fail('VALIDATION', 'One of those goals does not exist.');
  END IF;
  DELETE FROM work_task_goal_links WHERE task_id = p_task AND NOT goal_id = ANY (v_ids);
  INSERT INTO work_task_goal_links (task_id, goal_id, tenant_id) SELECT p_task, x, c.tenant FROM unnest(v_ids) x ON CONFLICT DO NOTHING;
END;
$$;

-- ── 2. KPI numbers and reporting windows (pure) ───────────────────────────
CREATE OR REPLACE FUNCTION perf_fy_start(p_period date, p_start_month int)
RETURNS date LANGUAGE sql IMMUTABLE AS $$
  SELECT make_date(extract(year FROM p_period)::int - CASE WHEN extract(month FROM p_period)::int >= p_start_month THEN 0 ELSE 1 END, p_start_month, 1);
$$;
CREATE OR REPLACE FUNCTION perf_quarter_start(p_period date, p_start_month int)
RETURNS date LANGUAGE sql IMMUTABLE AS $$
  SELECT (perf_fy_start(p_period, p_start_month)
          + make_interval(months => (((extract(year FROM age(p_period, perf_fy_start(p_period, p_start_month))) * 12
                                       + extract(month FROM age(p_period, perf_fy_start(p_period, p_start_month))))::int) / 3) * 3))::date;
$$;
-- Is a result due for this month? Quarterly: the quarter's last month; annual: the year's last month.
CREATE OR REPLACE FUNCTION perf_kpi_due(p_frequency text, p_period date, p_start_month int)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_frequency WHEN 'monthly' THEN true
    WHEN 'quarterly' THEN (perf_quarter_start(p_period, p_start_month) + interval '2 months')::date = p_period
    ELSE (perf_fy_start(p_period, p_start_month) + interval '11 months')::date = p_period END;
$$;
-- Achievement % (direction-aware); NULL when it cannot be computed.
CREATE OR REPLACE FUNCTION perf_achievement(p_actual numeric, p_target numeric, p_direction text, p_kind text)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_actual IS NULL THEN NULL
    WHEN p_kind = 'zero_incidents' THEN CASE WHEN p_actual = 0 THEN 100 ELSE 0 END
    WHEN p_target IS NULL THEN NULL
    WHEN p_direction = 'lower' THEN CASE WHEN p_actual <= p_target THEN 100 WHEN p_actual = 0 THEN NULL ELSE round(p_target / p_actual * 100, 2) END
    WHEN p_target = 0 THEN NULL
    ELSE round(p_actual / p_target * 100, 2) END;
$$;
-- Green ≥ 100 %, amber 70–99 %, red < 70 %.
CREATE OR REPLACE FUNCTION perf_health(p_pct numeric)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_pct IS NULL THEN NULL WHEN p_pct >= 100 THEN 'green' WHEN p_pct >= 70 THEN 'amber' ELSE 'red' END;
$$;
CREATE OR REPLACE FUNCTION perf_period(p text)
RETURNS date LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF p IS NULL OR p = '' THEN RETURN NULL; END IF;
  IF p ~ '^\d{4}-\d{2}$' THEN RETURN (p || '-01')::date; END IF;
  IF p ~ '^\d{4}-\d{2}-01$' THEN RETURN p::date; END IF;
  RAISE EXCEPTION 'Use YYYY-MM for the month.' USING ERRCODE = 'P0001', DETAIL = 'VALIDATION';
END;
$$;
CREATE OR REPLACE FUNCTION perf_kpi_settings_of(p_tenant uuid)
RETURNS perf_kpi_settings LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s perf_kpi_settings;
BEGIN
  SELECT * INTO s FROM perf_kpi_settings WHERE tenant_id = p_tenant;
  IF NOT FOUND THEN
    s.tenant_id := p_tenant; s.fy_start_month := 4; s.expected_due_day := 15; s.actual_due_day := 10; s.score_cap := 120; s.next_number := 1;
  END IF;
  RETURN s;
END;
$$;
-- The reporting window of a month: Expected opens with the month, Actual once it has ended; late is tagged, not blocked.
CREATE OR REPLACE FUNCTION perf_kpi_window(p_today date, p_period date, s perf_kpi_settings)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'canEditExpected', p_period <= date_trunc('month', p_today)::date,
    'canEditActual', p_period < date_trunc('month', p_today)::date,
    'expectedDueOn', p_period + (s.expected_due_day - 1),
    'actualDueOn', (p_period + interval '1 month')::date + (s.actual_due_day - 1),
    'expectedLate', p_today > p_period + (s.expected_due_day - 1),
    'actualLate', p_today > (p_period + interval '1 month')::date + (s.actual_due_day - 1));
$$;

-- ── 3. Access ─────────────────────────────────────────────────────────────
-- The caller's relation to a KPI. Managing follows the level: company — HR; department — HR or
-- the department's HOD / management; individual — the owner's managers (never the owner).
DO $$ BEGIN
  CREATE TYPE perf_kpi_rel AS (visible boolean, manages boolean, can_enter boolean, approver uuid, is_approver boolean);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION perf_kpi_relation(c work_ctx, k perf_kpis)
RETURNS perf_kpi_rel LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r perf_kpi_rel;
  v_dept text;
  v_my_dept text;
BEGIN
  IF k.level = 'company' THEN
    r.manages := c.overseer;
    r.visible := true;
  ELSIF k.level = 'department' THEN
    SELECT name INTO v_dept FROM departments WHERE id = k.department_id;
    SELECT department INTO v_my_dept FROM profiles WHERE id = c.me;
    r.manages := c.overseer OR (c.role IN ('hod','management') AND v_my_dept IS NOT NULL AND lower(v_my_dept) = lower(COALESCE(v_dept, '')));
    r.visible := r.manages OR (v_my_dept IS NOT NULL AND lower(v_my_dept) = lower(COALESCE(v_dept, '')));
  ELSE
    r.manages := perf_manages(c, k.owner_id);
    r.visible := r.manages OR k.owner_id = c.me;
  END IF;
  r.visible := r.visible OR COALESCE(k.submitter_id = c.me, false) OR COALESCE(k.approver_id = c.me, false);
  r.can_enter := COALESCE(k.submitter_id = c.me, false) OR (k.level = 'individual' AND k.owner_id = c.me) OR r.manages OR c.overseer;
  -- Approver: the named one while active; else the owner's manager (a person's KPI); else HR decides.
  r.approver := COALESCE((SELECT id FROM profiles WHERE id = k.approver_id AND status = 'Active'),
                         CASE WHEN k.level = 'individual' THEN perf_manager_of(k.owner_id) END);
  r.is_approver := COALESCE(r.approver = c.me, false);
  RETURN r;
END;
$$;

CREATE OR REPLACE FUNCTION perf_kpi_row(c work_ctx, p_id uuid, p_lock boolean DEFAULT false)
RETURNS perf_kpis LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  k perf_kpis;
BEGIN
  IF p_lock THEN PERFORM 1 FROM perf_kpis WHERE id = p_id FOR UPDATE; END IF;
  SELECT * INTO k FROM perf_kpis WHERE id = p_id AND tenant_id = c.tenant;
  IF k.id IS NULL OR NOT (perf_kpi_relation(c, k)).visible THEN PERFORM work_fail('NOT_FOUND', 'KPI not found.'); END IF;
  RETURN k;
END;
$$;

-- ── 4. Shapes ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION perf_kpi_json(k perf_kpis)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'id', k.id, 'key', 'KPI-' || k.number, 'level', k.level,
    'owner', CASE WHEN k.owner_id IS NULL THEN NULL ELSE jsonb_build_object('employeeId', k.owner_id, 'name', work_name(k.owner_id)) END,
    'department', CASE WHEN k.department_id IS NULL THEN NULL ELSE jsonb_build_object('id', k.department_id, 'name', (SELECT name FROM departments WHERE id = k.department_id)) END,
    'title', k.title, 'definition', k.definition, 'unit', k.unit, 'kind', k.kind, 'direction', k.direction, 'aggregation', k.aggregation,
    'frequency', k.frequency, 'kra', k.kra, 'weight', k.weight, 'isPriority', k.is_priority,
    'goal', CASE WHEN k.goal_id IS NULL THEN NULL ELSE jsonb_build_object('id', k.goal_id, 'title', (SELECT title FROM perf_goals WHERE id = k.goal_id)) END,
    'submitter', CASE WHEN k.submitter_id IS NULL THEN NULL ELSE jsonb_build_object('employeeId', k.submitter_id, 'name', work_name(k.submitter_id)) END,
    'approver', CASE WHEN k.approver_id IS NULL THEN NULL ELSE jsonb_build_object('employeeId', k.approver_id, 'name', work_name(k.approver_id)) END,
    'milestones', k.milestones, 'status', k.status, 'version', k.version);
$$;

CREATE OR REPLACE FUNCTION perf_kpi_entry_json(e perf_kpi_entries)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN e.id IS NULL THEN NULL ELSE jsonb_build_object(
    'id', e.id, 'period', e.period, 'expected', e.expected, 'actual', e.actual, 'numerator', e.numerator, 'denominator', e.denominator,
    'completed', to_jsonb(e.completed_milestones), 'notApplicable', e.not_applicable, 'note', e.note, 'status', e.status,
    'expectedFilledAt', work_iso(e.expected_filled_at), 'actualFilledAt', work_iso(e.actual_filled_at),
    'expectedDelayed', e.expected_delayed, 'actualDelayed', e.actual_delayed,
    'submittedBy', CASE WHEN e.submitted_by IS NULL THEN NULL ELSE jsonb_build_object('employeeId', e.submitted_by, 'name', work_name(e.submitted_by)) END,
    'submittedAt', work_iso(e.submitted_at), 'decidedBy', work_name(e.decided_by), 'decidedAt', work_iso(e.decided_at),
    'returnReason', e.return_reason, 'version', e.version) END;
$$;

-- Target, actual and achievement rolled up over a run of months (N/A and missing months are skipped).
CREATE OR REPLACE FUNCTION perf_kpi_to_date(k perf_kpis, p_from date, p_to date, p_skip_returned boolean)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_target numeric;
  v_actual numeric;
BEGIN
  SELECT CASE k.aggregation WHEN 'sum' THEN sum(t.target) WHEN 'average' THEN avg(t.target)
                            ELSE (array_agg(t.target ORDER BY m.period DESC) FILTER (WHERE t.target IS NOT NULL))[1] END,
         CASE k.aggregation WHEN 'sum' THEN sum(e.actual) WHEN 'average' THEN avg(e.actual)
                            ELSE (array_agg(e.actual ORDER BY m.period DESC) FILTER (WHERE e.actual IS NOT NULL))[1] END
    INTO v_target, v_actual
  FROM (SELECT g::date AS period FROM generate_series(p_from::timestamp, p_to::timestamp, interval '1 month') g) m
  LEFT JOIN perf_kpi_targets t ON t.kpi_id = k.id AND t.period = m.period
  LEFT JOIN perf_kpi_entries e ON e.kpi_id = k.id AND e.period = m.period AND NOT e.not_applicable AND (NOT p_skip_returned OR e.status <> 'returned');
  v_target := round(v_target, 2);
  v_actual := round(v_actual, 2);
  RETURN jsonb_build_object('target', v_target, 'actual', v_actual, 'achievement', perf_achievement(v_actual, v_target, k.direction, k.kind));
END;
$$;

-- One KPI's row in the register for a month: target, entry, achievement, health, year to date, what the caller may do.
CREATE OR REPLACE FUNCTION perf_kpi_register_row(c work_ctx, k perf_kpis, p_period date, s perf_kpi_settings, w jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  rel perf_kpi_rel := perf_kpi_relation(c, k);
  e perf_kpi_entries;
  v_target numeric;
  v_actual numeric;
  v_pct numeric;
  v_status text;
  v_open boolean;
  v_decides boolean;
BEGIN
  SELECT * INTO e FROM perf_kpi_entries WHERE kpi_id = k.id AND period = p_period;
  SELECT target INTO v_target FROM perf_kpi_targets WHERE kpi_id = k.id AND period = p_period;
  v_actual := CASE WHEN e.id IS NOT NULL AND NOT e.not_applicable THEN e.actual END;
  v_pct := perf_achievement(v_actual, v_target, k.direction, k.kind);
  v_status := COALESCE(e.status, 'draft');
  v_open := v_status IN ('draft','returned');
  v_decides := (rel.is_approver OR c.overseer) AND e.submitted_by IS DISTINCT FROM c.me;
  RETURN jsonb_build_object(
    'kpi', perf_kpi_json(k),
    'due', perf_kpi_due(k.frequency, p_period, s.fy_start_month),
    'target', v_target,
    'entry', perf_kpi_entry_json(e),
    'achievement', v_pct,
    'health', perf_health(v_pct),
    'ytd', perf_kpi_to_date(k, perf_fy_start(p_period, s.fy_start_month), p_period, true),
    'can', jsonb_build_object(
      'enter', rel.can_enter AND v_status <> 'confirmed',
      'editExpected', rel.can_enter AND v_open AND (w->>'canEditExpected')::boolean,
      'editActual', rel.can_enter AND (v_open OR v_status = 'submitted') AND (w->>'canEditActual')::boolean,
      'submit', rel.can_enter AND v_open,
      'decide', e.id IS NOT NULL AND v_status = 'submitted' AND v_decides,
      'reopen', e.id IS NOT NULL AND v_status = 'confirmed' AND (rel.is_approver OR c.overseer)));
END;
$$;

-- ── 5. The register, one KPI, departments ─────────────────────────────────
CREATE OR REPLACE FUNCTION perf_kpi_register(c work_ctx, q jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s perf_kpi_settings := perf_kpi_settings_of(c.tenant);
  v_period date := COALESCE(perf_period(q->>'period'), date_trunc('month', c.today)::date);
  v_scope text := COALESCE(NULLIF(q->>'scope', ''), 'mine');
  v_dept uuid := work_uuid(q->>'departmentId');
  v_dept_name text := (SELECT name FROM departments WHERE id = work_uuid(q->>'departmentId') AND tenant_id = c.tenant);
  v_employee uuid := work_uuid(q->>'employeeId');
  w jsonb;
  k perf_kpis;
  v_row jsonb;
  v_rows jsonb := '[]'::jsonb;
  n_fill int := 0; n_submit int := 0; n_await int := 0; n_review int := 0; n_confirmed int := 0; n_delayed int := 0; n_red int := 0;
  st text;
BEGIN
  w := perf_kpi_window(c.today, v_period, s);
  FOR k IN
    SELECT g.* FROM perf_kpis g LEFT JOIN profiles ge ON ge.id = g.owner_id
    WHERE g.tenant_id = c.tenant AND g.status = 'active'
      AND CASE v_scope
            WHEN 'team' THEN g.level = 'individual' AND g.owner_id = ANY (c.team)
            WHEN 'department' THEN v_dept IS NOT NULL AND (g.department_id = v_dept OR lower(COALESCE(ge.department, '')) = lower(COALESCE(v_dept_name, '~')))
            WHEN 'company' THEN g.level = 'company'
            WHEN 'all' THEN true
            ELSE CASE WHEN v_employee IS NOT NULL THEN g.owner_id = v_employee ELSE g.owner_id = c.me OR g.submitter_id = c.me END
          END
      AND (perf_kpi_relation(c, g)).visible
    ORDER BY g.is_priority DESC, g.level, g.number
    LIMIT 1000
  LOOP
    v_row := perf_kpi_register_row(c, k, v_period, s, w);
    v_rows := v_rows || v_row;
    CONTINUE WHEN NOT (v_row->>'due')::boolean;
    st := COALESCE(v_row #>> '{entry,status}', 'none');
    IF st IN ('none','draft','returned') THEN
      IF (v_row #>> '{can,enter}')::boolean THEN n_fill := n_fill + 1; END IF;
      IF v_row->'entry' <> 'null'::jsonb AND (v_row #>> '{can,submit}')::boolean
         AND ((v_row #>> '{entry,notApplicable}')::boolean OR v_row #> '{entry,expected}' <> 'null'::jsonb OR v_row #> '{entry,actual}' <> 'null'::jsonb) THEN
        n_submit := n_submit + 1;
      END IF;
    END IF;
    IF st = 'submitted' THEN n_await := n_await + 1; END IF;
    IF st = 'submitted' AND (v_row #>> '{can,decide}')::boolean THEN n_review := n_review + 1; END IF;
    IF st = 'confirmed' THEN n_confirmed := n_confirmed + 1; END IF;
    IF COALESCE((v_row #>> '{entry,expectedDelayed}')::boolean, false) OR COALESCE((v_row #>> '{entry,actualDelayed}')::boolean, false) THEN n_delayed := n_delayed + 1; END IF;
    IF v_row->>'health' = 'red' THEN n_red := n_red + 1; END IF;
  END LOOP;
  RETURN jsonb_build_object('period', v_period, 'today', c.today, 'window', w, 'rows', v_rows,
    'counts', jsonb_build_object('toFill', n_fill, 'toSubmit', n_submit, 'awaitingReview', n_await, 'toReview', n_review,
                                 'confirmed', n_confirmed, 'delayed', n_delayed, 'red', n_red));
END;
$$;

-- One KPI with its year: targets and entries month by month, quarter- and year-to-date, and the history.
CREATE OR REPLACE FUNCTION perf_kpi_get(c work_ctx, p_id uuid, p_period text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  k perf_kpis := perf_kpi_row(c, p_id);
  s perf_kpi_settings := perf_kpi_settings_of(c.tenant);
  v_at date := COALESCE(perf_period(p_period), date_trunc('month', c.today)::date);
  v_fy date;
  v_last date;
BEGIN
  v_fy := perf_fy_start(v_at, s.fy_start_month);
  v_last := (v_fy + interval '11 months')::date;
  RETURN perf_kpi_json(k) || jsonb_build_object(
    'canManage', (perf_kpi_relation(c, k)).manages,
    'fyStart', v_fy,
    'months', (SELECT jsonb_agg(jsonb_build_object(
                 'period', m.period, 'target', t.target, 'expected', e.expected,
                 'actual', CASE WHEN e.id IS NOT NULL AND NOT e.not_applicable THEN e.actual END,
                 'notApplicable', COALESCE(e.not_applicable, false), 'status', e.status,
                 'delayed', COALESCE(e.expected_delayed OR e.actual_delayed, false),
                 'achievement', perf_achievement(CASE WHEN e.id IS NOT NULL AND NOT e.not_applicable THEN e.actual END, t.target, k.direction, k.kind)) ORDER BY m.period)
               FROM (SELECT g::date AS period FROM generate_series(v_fy::timestamp, v_last::timestamp, interval '1 month') g) m
               LEFT JOIN perf_kpi_targets t ON t.kpi_id = k.id AND t.period = m.period
               LEFT JOIN perf_kpi_entries e ON e.kpi_id = k.id AND e.period = m.period),
    'toDate', jsonb_build_object(
      'qtd', perf_kpi_to_date(k, perf_quarter_start(LEAST(v_at, v_last), s.fy_start_month), LEAST(v_at, v_last), false),
      'ytd', perf_kpi_to_date(k, v_fy, LEAST(v_at, v_last), false)),
    'history', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', x.id, 'period', x.period, 'kind', x.kind, 'reason', x.reason, 'changes', x.changes,
                           'actor', work_name(x.actor_id), 'at', work_iso(x.at)) ORDER BY x.at DESC)
                         FROM (SELECT ev.id, e.period, ev.kind, ev.reason, ev.changes, ev.actor_id, ev.at
                               FROM perf_kpi_entry_events ev JOIN perf_kpi_entries e ON e.id = ev.entry_id
                               WHERE e.kpi_id = k.id ORDER BY ev.at DESC LIMIT 100) x), '[]'::jsonb));
END;
$$;

CREATE OR REPLACE FUNCTION perf_departments(c work_ctx)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object('data', COALESCE(jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name, 'isActive', true, 'parentDepartmentId', NULL) ORDER BY d.name), '[]'::jsonb))
  FROM departments d WHERE d.tenant_id = c.tenant;
$$;

-- ── 6. KPI definitions and targets ────────────────────────────────────────
CREATE OR REPLACE FUNCTION perf_kpi_create(c work_ctx, i jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_level text := i->>'level';
  v_owner uuid := work_uuid(i->>'ownerEmployeeId');
  v_dept uuid := work_uuid(i->>'departmentId');
  v_title text := btrim(COALESCE(i->>'title', ''));
  v_kind text := COALESCE(NULLIF(i->>'kind', ''), 'volume');
  v_direction text;
  v_frequency text := COALESCE(NULLIF(i->>'frequency', ''), 'monthly');
  v_weight numeric := NULLIF(i->>'weight', '')::numeric;
  v_submitter uuid := work_uuid(i->>'submitterEmployeeId');
  v_approver uuid := work_uuid(i->>'approverEmployeeId');
  v_ms jsonb := CASE WHEN jsonb_typeof(i->'milestones') = 'array' THEN i->'milestones' ELSE '[]'::jsonb END;
  v_people uuid[];
  k perf_kpis;
  n int;
  v_id uuid := gen_random_uuid();
  v_total numeric;
BEGIN
  IF v_level IS NULL OR v_level NOT IN ('company','department','individual') THEN PERFORM work_fail('VALIDATION', 'Choose whose KPI this is.'); END IF;
  IF v_level = 'individual' AND v_owner IS NULL THEN PERFORM work_fail('VALIDATION', 'Choose whose KPI this is.'); END IF;
  IF v_level = 'department' AND v_dept IS NULL THEN PERFORM work_fail('VALIDATION', 'Choose the department.'); END IF;
  IF char_length(v_title) NOT BETWEEN 1 AND 200 THEN PERFORM work_fail('VALIDATION', 'A KPI needs a title of up to 200 characters.'); END IF;
  IF char_length(COALESCE(i->>'definition', '')) > 4000 OR char_length(COALESCE(i->>'unit', '')) > 40 THEN PERFORM work_fail('VALIDATION', 'That is too long.'); END IF;
  IF v_kind NOT IN ('volume','rate','average','snapshot','milestone','rubric','zero_incidents') THEN PERFORM work_fail('VALIDATION', 'Unknown kind.'); END IF;
  IF v_frequency NOT IN ('monthly','quarterly','annual') THEN PERFORM work_fail('VALIDATION', 'Unknown reporting frequency.'); END IF;
  IF v_weight IS NOT NULL AND (v_weight <= 0 OR v_weight > 100) THEN PERFORM work_fail('VALIDATION', 'The weight is between 1 and 100.'); END IF;
  v_direction := CASE WHEN v_kind = 'zero_incidents' THEN 'lower' ELSE COALESCE(NULLIF(i->>'direction', ''), 'higher') END;
  IF v_direction NOT IN ('higher','lower') THEN PERFORM work_fail('VALIDATION', 'Unknown direction.'); END IF;

  -- Who may define it follows the level (same rule as managing it afterwards).
  k.level := v_level; k.owner_id := CASE WHEN v_level = 'individual' THEN v_owner END; k.department_id := CASE WHEN v_level = 'department' THEN v_dept END;
  IF v_level = 'department' AND NOT EXISTS (SELECT 1 FROM departments WHERE id = v_dept AND tenant_id = c.tenant) THEN
    PERFORM work_fail('REFERENCE_NOT_FOUND', 'That department does not exist.');
  END IF;
  IF NOT (perf_kpi_relation(c, k)).manages THEN
    PERFORM work_fail('FORBIDDEN', CASE v_level WHEN 'company' THEN 'Only HR defines company KPIs.'
                                               WHEN 'department' THEN 'Only HR or the department''s head defines its KPIs.'
                                               ELSE 'You can define KPIs for people in your team only.' END);
  END IF;
  v_people := ARRAY(SELECT DISTINCT x FROM unnest(ARRAY[k.owner_id, v_submitter, v_approver]) x WHERE x IS NOT NULL);
  IF (SELECT count(*) FROM profiles WHERE id = ANY (v_people) AND tenant_id = c.tenant AND status = 'Active') <> cardinality(v_people) THEN
    PERFORM work_fail('REFERENCE_NOT_FOUND', 'Owner, submitter and approver must be active employees.');
  END IF;
  IF v_kind = 'milestone' THEN
    -- Milestones: ids unique, titles present, weights positive and adding up to 100.
    IF jsonb_array_length(v_ms) = 0 THEN PERFORM work_fail('VALIDATION', 'A milestone KPI needs at least one milestone.'); END IF;
    IF (SELECT count(DISTINCT m->>'id') FROM jsonb_array_elements(v_ms) m) <> jsonb_array_length(v_ms) THEN PERFORM work_fail('VALIDATION', 'Milestone ids must be unique.'); END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_ms) m WHERE btrim(COALESCE(m->>'title', '')) = '' OR COALESCE((m->>'weight')::numeric, 0) <= 0) THEN
      PERFORM work_fail('VALIDATION', 'Every milestone needs a title and a positive weight.');
    END IF;
    SELECT round(sum((m->>'weight')::numeric), 2) INTO v_total FROM jsonb_array_elements(v_ms) m;
    IF v_total <> 100 THEN PERFORM work_fail('VALIDATION', format('Milestone weights must add up to 100 (now %s).', trim_scale(v_total))); END IF;
  ELSE
    v_ms := '[]'::jsonb;
  END IF;
  INSERT INTO perf_kpi_settings (tenant_id, next_number) VALUES (c.tenant, 2)
  ON CONFLICT (tenant_id) DO UPDATE SET next_number = perf_kpi_settings.next_number + 1
  RETURNING next_number - 1 INTO n;
  INSERT INTO perf_kpis (id, tenant_id, number, level, owner_id, department_id, title, definition, unit, kind, direction, aggregation, frequency, kra,
                         weight, is_priority, submitter_id, approver_id, milestones, created_by)
  VALUES (v_id, c.tenant, n, v_level, k.owner_id, k.department_id, v_title, COALESCE(i->>'definition', ''), COALESCE(i->>'unit', ''), v_kind, v_direction,
          -- Counts add up; rates, averages and ratings average; snapshots and milestones take the latest.
          COALESCE(NULLIF(i->>'aggregation', ''), CASE WHEN v_kind IN ('volume','zero_incidents') THEN 'sum' WHEN v_kind IN ('snapshot','milestone') THEN 'latest' ELSE 'average' END),
          v_frequency, NULLIF(btrim(COALESCE(i->>'kra', '')), ''), v_weight, COALESCE((i->>'isPriority')::boolean, false), v_submitter, v_approver, v_ms, c.me);
  RETURN v_id;
END;
$$;

-- Sets targets month by month (targets are history: send a new value to change one).
CREATE OR REPLACE FUNCTION perf_kpi_set_targets(c work_ctx, p_id uuid, p_targets jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  k perf_kpis := perf_kpi_row(c, p_id, true);
BEGIN
  IF NOT (perf_kpi_relation(c, k)).manages THEN PERFORM work_fail('FORBIDDEN', 'Only the people who manage this KPI set its targets.'); END IF;
  IF jsonb_typeof(p_targets) <> 'array' OR jsonb_array_length(p_targets) = 0 THEN RETURN; END IF;
  IF jsonb_array_length(p_targets) > 36 THEN PERFORM work_fail('VALIDATION', 'Send at most 36 months at a time.'); END IF;
  INSERT INTO perf_kpi_targets (kpi_id, period, tenant_id, target, updated_by)
  SELECT k.id, perf_period(x->>'period'), c.tenant, (x->>'target')::numeric, c.me FROM jsonb_array_elements(p_targets) x
  WHERE x->>'target' IS NOT NULL
  ON CONFLICT (kpi_id, period) DO UPDATE SET target = EXCLUDED.target, updated_by = EXCLUDED.updated_by, updated_at = now();
END;
$$;

-- ── 7. Monthly results: save, submit the month, decide ────────────────────
CREATE OR REPLACE FUNCTION perf_kpi_event(p_tenant uuid, p_entry uuid, p_kind text, p_actor uuid, p_reason text, p_changes jsonb)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO perf_kpi_entry_events (tenant_id, entry_id, kind, actor_id, reason, changes) VALUES (p_tenant, p_entry, p_kind, p_actor, p_reason, COALESCE(p_changes, '{}'::jsonb));
$$;

-- Saves the entry for a KPI and month (creating it). Expected is locked once submitted; Actual until decided.
CREATE OR REPLACE FUNCTION perf_kpi_save_entry(c work_ctx, p_id uuid, p_period text, i jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  k perf_kpis := perf_kpi_row(c, p_id);
  s perf_kpi_settings := perf_kpi_settings_of(c.tenant);
  v_period date := perf_period(p_period);
  w jsonb;
  rel perf_kpi_rel;
  e perf_kpi_entries;
  v_changes jsonb := '{}'::jsonb;
  v_submitted boolean;
  n_expected numeric; n_actual numeric; n_num numeric; n_den numeric; n_done text[]; n_na boolean; n_note text;
  v_value_given boolean := i ? 'actual' OR i ? 'numerator' OR i ? 'denominator' OR i ? 'completed';
BEGIN
  IF v_period IS NULL THEN PERFORM work_fail('VALIDATION', 'Choose the month.'); END IF;
  IF k.status <> 'active' THEN PERFORM work_fail('KPI_ARCHIVED', 'This KPI is archived.'); END IF;
  w := perf_kpi_window(c.today, v_period, s);
  rel := perf_kpi_relation(c, k);
  IF NOT rel.can_enter THEN PERFORM work_fail('FORBIDDEN', 'Only the KPI owner, its submitter or its managers can enter results.'); END IF;
  IF NOT perf_kpi_due(k.frequency, v_period, s.fy_start_month) THEN PERFORM work_fail('NOT_DUE', format('This %s KPI has no result for that month.', k.frequency)); END IF;
  INSERT INTO perf_kpi_entries (tenant_id, kpi_id, period) VALUES (c.tenant, k.id, v_period) ON CONFLICT (kpi_id, period) DO NOTHING;
  SELECT * INTO e FROM perf_kpi_entries WHERE kpi_id = k.id AND period = v_period FOR UPDATE;
  IF e.status = 'confirmed' THEN PERFORM work_fail('ENTRY_CONFIRMED', 'This result is confirmed. Ask the approver to reopen it.'); END IF;
  v_submitted := e.status = 'submitted';
  n_expected := e.expected; n_actual := e.actual; n_num := e.numerator; n_den := e.denominator; n_done := e.completed_milestones;
  n_na := e.not_applicable; n_note := e.note;

  IF i ? 'expected' AND (i->>'expected')::numeric IS DISTINCT FROM e.expected THEN
    IF v_submitted THEN PERFORM work_fail('EXPECTED_LOCKED', 'The expected value was submitted and is locked for this month.'); END IF;
    IF NOT (w->>'canEditExpected')::boolean THEN PERFORM work_fail('NOT_OPEN', 'The expected value opens on the first day of the month.'); END IF;
    n_expected := (i->>'expected')::numeric;
    v_changes := v_changes || jsonb_build_object('expected', jsonb_build_object('from', e.expected, 'to', n_expected));
  END IF;

  IF v_value_given THEN
    IF NOT (w->>'canEditActual')::boolean THEN PERFORM work_fail('NOT_OPEN', 'The actual result opens once the month has ended.'); END IF;
    IF k.kind IN ('rate','average') THEN
      n_num := (i->>'numerator')::numeric; n_den := (i->>'denominator')::numeric;
      IF n_num IS NULL OR n_den IS NULL THEN PERFORM work_fail('VALIDATION', 'Enter both the numerator and the denominator.'); END IF;
      IF n_den <= 0 THEN PERFORM work_fail('VALIDATION', 'The denominator must be more than zero.'); END IF;
      IF n_num < 0 THEN PERFORM work_fail('VALIDATION', 'The numerator cannot be negative.'); END IF;
      IF k.kind = 'rate' AND n_num > n_den THEN PERFORM work_fail('VALIDATION', 'Successful outcomes cannot exceed eligible outcomes.'); END IF;
      n_actual := round(n_num / n_den * CASE WHEN k.kind = 'rate' THEN 100 ELSE 1 END, 2);
    ELSIF k.kind = 'milestone' THEN
      n_done := ARRAY(SELECT DISTINCT x FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(i->'completed') = 'array' THEN i->'completed' ELSE '[]'::jsonb END) x
                      WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(k.milestones) m WHERE m->>'id' = x));
      n_actual := round(COALESCE((SELECT sum((m->>'weight')::numeric) FROM jsonb_array_elements(k.milestones) m WHERE m->>'id' = ANY (n_done)), 0), 2);
      n_num := NULL; n_den := NULL;
    ELSE
      n_actual := (i->>'actual')::numeric;
      IF n_actual IS NOT NULL AND k.kind = 'rubric' AND n_actual NOT IN (1, 2, 3, 4, 5) THEN PERFORM work_fail('VALIDATION', 'Choose a rating from 1 to 5.'); END IF;
      IF n_actual IS NOT NULL AND k.kind = 'zero_incidents' AND (n_actual < 0 OR n_actual <> trunc(n_actual)) THEN
        PERFORM work_fail('VALIDATION', 'Incidents are a whole number, zero or more.');
      END IF;
      n_num := NULL; n_den := NULL;
    END IF;
    IF n_actual IS DISTINCT FROM e.actual OR i ? 'numerator' OR i ? 'completed' THEN
      v_changes := v_changes || jsonb_build_object('actual', jsonb_build_object('from', e.actual, 'to', n_actual));
    END IF;
  END IF;

  IF i ? 'notApplicable' AND COALESCE((i->>'notApplicable')::boolean, false) IS DISTINCT FROM e.not_applicable THEN
    IF v_submitted THEN PERFORM work_fail('EXPECTED_LOCKED', 'A submitted month cannot change to "not applicable". Ask the approver to return it.'); END IF;
    n_na := COALESCE((i->>'notApplicable')::boolean, false);
    v_changes := v_changes || jsonb_build_object('notApplicable', jsonb_build_object('from', e.not_applicable, 'to', n_na));
  END IF;
  IF i ? 'note' AND left(COALESCE(i->>'note', ''), 2000) IS DISTINCT FROM e.note THEN
    n_note := left(COALESCE(i->>'note', ''), 2000);
    v_changes := v_changes || jsonb_build_object('note', jsonb_build_object('from', NULL, 'to', 'changed'));
  END IF;
  IF v_changes = '{}'::jsonb THEN RETURN; END IF;
  IF n_na AND char_length(btrim(n_note)) < 4 THEN PERFORM work_fail('VALIDATION', 'Say why this month is not applicable (4 characters or more).'); END IF;

  UPDATE perf_kpi_entries SET
    expected = n_expected, actual = n_actual, numerator = n_num, denominator = n_den, completed_milestones = n_done, not_applicable = n_na, note = n_note,
    expected_filled_at = CASE WHEN v_changes ? 'expected' THEN now() ELSE expected_filled_at END,
    expected_delayed = CASE WHEN v_changes ? 'expected' THEN (w->>'expectedLate')::boolean ELSE expected_delayed END,
    actual_filled_at = CASE WHEN v_changes ? 'actual' THEN now() ELSE actual_filled_at END,
    actual_delayed = CASE WHEN v_changes ? 'actual' THEN (w->>'actualLate')::boolean ELSE actual_delayed END,
    -- A returned entry being corrected goes back to draft.
    status = CASE WHEN status = 'returned' THEN 'draft' ELSE status END,
    return_reason = CASE WHEN status = 'returned' THEN NULL ELSE return_reason END,
    version = version + 1
  WHERE id = e.id;
  PERFORM perf_kpi_event(c.tenant, e.id, 'save', c.me, NULL, v_changes);
END;
$$;

-- Submits a month: the given KPIs, or every entry of a department, or the caller's own.
-- Value-less drafts are skipped, never submitted. One notice per approver.
CREATE OR REPLACE FUNCTION perf_kpi_submit(c work_ctx, i jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_period date := perf_period(i->>'period');
  v_ids uuid[] := work_uuids(i->'kpiIds');
  v_dept uuid := work_uuid(i->>'departmentId');
  v_dept_name text := (SELECT name FROM departments WHERE id = work_uuid(i->>'departmentId') AND tenant_id = c.tenant);
  k perf_kpis;
  e perf_kpi_entries;
  rel perf_kpi_rel;
  v_submitted int := 0;
  v_skipped jsonb := '[]'::jsonb;
  v_by jsonb := '{}'::jsonb;   -- approver id → how many
  v_key text;
BEGIN
  IF v_period IS NULL THEN PERFORM work_fail('VALIDATION', 'Choose the month.'); END IF;
  IF v_dept IS NOT NULL AND cardinality(v_ids) = 0 THEN
    k := NULL; k.level := 'department'; k.department_id := v_dept;
    IF NOT (perf_kpi_relation(c, k)).manages THEN PERFORM work_fail('FORBIDDEN', 'Only the department head or HR can submit the whole department.'); END IF;
  END IF;
  FOR k IN
    SELECT g.* FROM perf_kpis g LEFT JOIN profiles ge ON ge.id = g.owner_id
    WHERE g.tenant_id = c.tenant AND g.status = 'active'
      AND CASE WHEN cardinality(v_ids) > 0 THEN g.id = ANY (v_ids)
               WHEN v_dept IS NOT NULL THEN g.department_id = v_dept OR lower(COALESCE(ge.department, '')) = lower(COALESCE(v_dept_name, '~'))
               ELSE g.owner_id = c.me OR g.submitter_id = c.me END
  LOOP
    rel := perf_kpi_relation(c, k);
    CONTINUE WHEN NOT rel.visible;
    SELECT * INTO e FROM perf_kpi_entries WHERE kpi_id = k.id AND period = v_period AND status IN ('draft','returned') FOR UPDATE;
    CONTINUE WHEN e.id IS NULL;
    IF NOT rel.can_enter THEN v_skipped := v_skipped || jsonb_build_object('kpiId', k.id, 'reason', 'not yours to submit'); CONTINUE; END IF;
    IF NOT (e.not_applicable OR e.expected IS NOT NULL OR e.actual IS NOT NULL) THEN
      v_skipped := v_skipped || jsonb_build_object('kpiId', k.id, 'reason', 'no value yet'); CONTINUE;
    END IF;
    UPDATE perf_kpi_entries SET status = 'submitted', submitted_at = now(), submitted_by = c.me, return_reason = NULL, decided_at = NULL, decided_by = NULL,
           version = version + 1 WHERE id = e.id;
    PERFORM perf_kpi_event(c.tenant, e.id, 'submit', c.me, NULL, NULL);
    v_submitted := v_submitted + 1;
    IF rel.approver IS NOT NULL AND rel.approver <> c.me THEN
      v_by := v_by || jsonb_build_object(rel.approver::text, COALESCE((v_by->>rel.approver::text)::int, 0) + 1);
    END IF;
  END LOOP;
  FOR v_key IN SELECT jsonb_object_keys(v_by) LOOP
    PERFORM perf_notify(c, ARRAY[v_key::uuid], 'performance_kpi',
      format('%s submitted %s KPI result%s for %s', COALESCE(work_name(c.me), 'Someone'), v_by->>v_key,
             CASE WHEN (v_by->>v_key)::int > 1 THEN 's' ELSE '' END, to_char(v_period, 'FMMonth YYYY')), NULL);
  END LOOP;
  RETURN jsonb_build_object('period', v_period, 'submitted', v_submitted, 'skipped', v_skipped);
END;
$$;

-- Confirm, return (reason) or reopen (reason) a month's result. Never by the person who submitted it.
CREATE OR REPLACE FUNCTION perf_kpi_decide(c work_ctx, p_id uuid, p_period text, p_action text, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  k perf_kpis := perf_kpi_row(c, p_id);
  v_period date := perf_period(p_period);
  e perf_kpi_entries;
  rel perf_kpi_rel := perf_kpi_relation(c, k);
  v_why text := btrim(COALESCE(p_reason, ''));
BEGIN
  IF k.status <> 'active' THEN PERFORM work_fail('KPI_ARCHIVED', 'This KPI is archived.'); END IF;
  SELECT * INTO e FROM perf_kpi_entries WHERE kpi_id = k.id AND period = v_period FOR UPDATE;
  IF e.id IS NULL THEN PERFORM work_fail('NOT_FOUND', 'Result not found.'); END IF;
  IF e.submitted_by IS NOT DISTINCT FROM c.me THEN PERFORM work_fail('FORBIDDEN', 'Your own submission needs another approver.'); END IF;
  IF NOT (rel.is_approver OR c.overseer) THEN PERFORM work_fail('FORBIDDEN', 'Only the approver of this KPI can decide its results.'); END IF;
  IF p_action = 'confirm' THEN
    IF e.status <> 'submitted' THEN PERFORM work_fail('NOT_SUBMITTED', 'Only a submitted result can be confirmed.'); END IF;
    UPDATE perf_kpi_entries SET status = 'confirmed', decided_at = now(), decided_by = c.me, version = version + 1 WHERE id = e.id;
  ELSIF p_action = 'return' THEN
    IF e.status <> 'submitted' THEN PERFORM work_fail('NOT_SUBMITTED', 'Only a submitted result can be returned.'); END IF;
    IF char_length(v_why) < 4 THEN PERFORM work_fail('REASON_REQUIRED', 'Say what needs correcting (4 characters or more).'); END IF;
    UPDATE perf_kpi_entries SET status = 'returned', return_reason = left(v_why, 500), decided_at = now(), decided_by = c.me, version = version + 1 WHERE id = e.id;
  ELSIF p_action = 'reopen' THEN
    IF e.status <> 'confirmed' THEN PERFORM work_fail('NOT_CONFIRMED', 'Only a confirmed result can be reopened.'); END IF;
    IF char_length(v_why) < 4 THEN PERFORM work_fail('REASON_REQUIRED', 'Say why the result is reopened (4 characters or more).'); END IF;
    UPDATE perf_kpi_entries SET status = 'returned', return_reason = left(v_why, 500), decided_at = now(), decided_by = c.me, version = version + 1 WHERE id = e.id;
  ELSE
    PERFORM work_fail('VALIDATION', 'Unknown decision.');
  END IF;
  PERFORM perf_kpi_event(c.tenant, e.id, p_action, c.me, NULLIF(v_why, ''), NULL);
  IF p_action <> 'confirm' THEN
    PERFORM perf_notify(c, ARRAY[e.submitted_by], 'performance_kpi',
      format('%s %s KPI-%s for %s', COALESCE(work_name(c.me), 'Someone'), CASE WHEN p_action = 'reopen' THEN 'reopened' ELSE 'returned' END,
             k.number, to_char(v_period, 'FMMonth YYYY')), left(v_why, 300));
  END IF;
END;
$$;

-- ── 8. Read-only configuration the screens need ───────────────────────────
CREATE OR REPLACE FUNCTION perf_scales_json(c work_ctx)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object('data', COALESCE(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'status', s.status,
           'levels', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', l.id, 'ordinal', l.ordinal, 'value', l.value::text, 'label', l.label, 'description', l.description) ORDER BY l.ordinal), '[]'::jsonb)
                      FROM perf_scale_levels l WHERE l.scale_id = s.id)) ORDER BY s.created_at), '[]'::jsonb))
  FROM perf_scales s WHERE s.tenant_id = c.tenant;
$$;
CREATE OR REPLACE FUNCTION perf_templates_json(c work_ctx)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object('data', COALESCE(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'description', t.description, 'status', t.status,
           'formula', t.formula, 'steps', t.steps) ORDER BY (t.seed_key = 'default.template') DESC NULLS LAST, t.created_at), '[]'::jsonb))
  FROM perf_templates t WHERE t.tenant_id = c.tenant;
$$;

-- ── 9. The entry point ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION perf_api_route(p_method text, p_path text, p_query jsonb, p_body jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  c work_ctx := work_ctx_load();
  m text := upper(COALESCE(p_method, 'GET'));
  seg text[] := string_to_array(btrim(COALESCE(p_path, ''), '/'), '/');
  n int;
  q jsonb := COALESCE(p_query, '{}'::jsonb);
  b jsonb := COALESCE(p_body, '{}'::jsonb);
  a text; x text; y text; z text; u text;
  v_id uuid;
  v_emp uuid;
  v_new uuid;
  v_ver text := NULLIF(q->>'ifMatch', '');
  v_goals boolean;
  v_reviews boolean;
  v_json jsonb;
BEGIN
  n := COALESCE(array_length(seg, 1), 0);
  v_goals := ai_feature_enabled(c.tenant, c.outlet, 'performance_kras');
  v_reviews := ai_feature_enabled(c.tenant, c.outlet, 'performance_reviews');
  IF NOT (v_goals OR v_reviews) THEN PERFORM work_fail('FEATURE_DISABLED', 'Performance is switched off for this company.'); END IF;

  IF n = 2 AND seg[1] = 'departments' AND seg[2] = 'tree' AND m = 'GET' THEN RETURN perf_departments(c); END IF;
  IF n < 2 OR seg[1] <> 'pms' THEN PERFORM work_fail('NOT_FOUND', 'Not found.'); END IF;
  a := seg[2]; x := seg[3]; y := seg[4]; z := seg[5]; u := seg[6];

  -- ── review cycles, goal plans ──
  IF a = 'cycles' THEN
    IF n = 2 AND m = 'GET' THEN RETURN jsonb_build_object('data', perf_cycles_list(c, COALESCE(q->>'deleted', '') IN ('true','1')));
    ELSIF n = 2 AND m = 'POST' THEN v_new := perf_cycle_create(c, b); RETURN perf_cycle_json(perf_cycle_row(c, v_new));
    END IF;
    v_id := work_uuid(x);
    IF n = 3 AND m = 'GET' THEN RETURN perf_cycle_json(perf_cycle_row(c, v_id));
    ELSIF n = 3 AND m = 'PATCH' THEN PERFORM perf_cycle_update(c, v_id, v_ver, b); RETURN perf_cycle_json(perf_cycle_row(c, v_id));
    ELSIF n = 4 AND m = 'POST' AND y = 'open' THEN PERFORM perf_cycle_open(c, v_id, v_ver); RETURN perf_cycle_json(perf_cycle_row(c, v_id));
    ELSIF n = 4 AND m = 'POST' AND y = 'advance' THEN PERFORM perf_cycle_advance(c, v_id, v_ver); RETURN perf_cycle_json(perf_cycle_row(c, v_id));
    ELSIF n = 4 AND m = 'POST' AND y = 'lock-phase' THEN
      PERFORM perf_cycle_lock_phase(c, v_id, v_ver, (b->>'locked')::boolean); RETURN perf_cycle_json(perf_cycle_row(c, v_id));
    ELSIF n = 4 AND m = 'POST' AND y = 'close' THEN PERFORM perf_cycle_close(c, v_id, v_ver); RETURN perf_cycle_json(perf_cycle_row(c, v_id));
    ELSIF n = 4 AND m = 'POST' AND y = 'delete' THEN
      PERFORM perf_cycle_delete(c, v_id, v_ver, b->>'reason'); RETURN perf_cycle_json(perf_cycle_row(c, v_id, false, NULL, true));
    ELSIF n = 4 AND m = 'POST' AND y = 'restore' THEN PERFORM perf_cycle_restore(c, v_id, v_ver); RETURN perf_cycle_json(perf_cycle_row(c, v_id));
    ELSIF n = 4 AND m = 'POST' AND y = 'launch' THEN RETURN perf_cycle_launch(c, v_id);
    ELSIF n = 5 AND m = 'POST' AND y = 'participants' AND z = 'preview' THEN RETURN perf_cycle_preview(c, v_id);
    ELSIF n = 4 AND m = 'POST' AND y = 'finalise' THEN RETURN perf_finalise_all(c, v_id);
    ELSIF n = 4 AND m = 'POST' AND y = 'share' THEN RETURN perf_share_all(c, v_id);
    ELSIF n = 4 AND m = 'GET' AND y = 'outcomes' THEN RETURN jsonb_build_object('data', perf_outcomes(c, v_id, q->>'state'));
    ELSIF n = 4 AND m = 'GET' AND y = 'plans' THEN RETURN jsonb_build_object('data', perf_plans_list(c, v_id));
    ELSIF y = 'plans' AND n >= 5 THEN
      v_emp := work_uuid(z);
      IF n = 5 AND m = 'GET' THEN RETURN perf_plan_get(c, v_id, v_emp);
      ELSIF n = 6 AND m = 'POST' AND u = 'submit' THEN PERFORM perf_plan_submit(c, v_id, v_emp); RETURN perf_plan_get(c, v_id, v_emp);
      ELSIF n = 6 AND m = 'POST' AND u = 'decision' THEN
        PERFORM perf_plan_decide(c, v_id, v_emp, b->>'action', b->>'comment'); RETURN perf_plan_get(c, v_id, v_emp);
      END IF;
    END IF;

  ELSIF a = 'templates' AND n = 2 AND m = 'GET' THEN PERFORM perf_seed_tenant(c.tenant); RETURN perf_templates_json(c);
  ELSIF a = 'scales' AND n = 2 AND m = 'GET' THEN PERFORM perf_seed_tenant(c.tenant); RETURN perf_scales_json(c);

  -- ── goals ──
  ELSIF a = 'goals' THEN
    IF n = 2 AND m = 'POST' THEN v_new := perf_goal_create(c, b); RETURN perf_goal_json(perf_goal_row(c, v_new)); END IF;
    v_id := work_uuid(x);
    IF n = 3 AND m = 'GET' THEN RETURN perf_goal_json(perf_goal_row(c, v_id));
    ELSIF n = 3 AND m = 'PATCH' THEN PERFORM perf_goal_edit(c, v_id, v_ver, b, NULL); RETURN perf_goal_json(perf_goal_row(c, v_id));
    ELSIF n = 4 AND m = 'PUT' AND y = 'measures' THEN PERFORM perf_goal_edit(c, v_id, v_ver, '{}'::jsonb, COALESCE(b->'measures', '[]'::jsonb)); RETURN perf_goal_json(perf_goal_row(c, v_id));
    ELSIF n = 4 AND m = 'POST' AND y = 'archive' THEN PERFORM perf_goal_archive(c, v_id, v_ver, b->>'reason'); RETURN perf_goal_json(perf_goal_row(c, v_id));
    ELSIF n = 4 AND m = 'GET' AND y = 'check-ins' THEN RETURN jsonb_build_object('data', perf_goal_checkins(c, v_id));
    ELSIF n = 4 AND m = 'POST' AND y = 'check-ins' THEN
      v_json := perf_goal_checkin(c, v_id, b); RETURN v_json || jsonb_build_object('goal', perf_goal_json(perf_goal_row(c, v_id)));
    END IF;

  -- ── reviews and results ──
  ELSIF a = 'me' AND x = 'reviews' AND n = 3 AND m = 'GET' THEN
    IF NOT v_reviews THEN RETURN jsonb_build_object('asEmployee', '[]'::jsonb, 'asReviewer', '[]'::jsonb); END IF;
    RETURN perf_reviews_mine(c);
  ELSIF a IN ('reviews','acknowledgements') THEN
    IF NOT v_reviews THEN PERFORM work_fail('FEATURE_DISABLED', 'Performance reviews are switched off for this company.'); END IF;
    IF a = 'reviews' AND n = 2 AND m = 'GET' THEN RETURN jsonb_build_object('data', perf_reviews_list(c, work_uuid(q->>'cycleId'))); END IF;
    v_id := work_uuid(x);
    IF a = 'acknowledgements' AND n = 4 AND m = 'POST' AND y = 'resolve' THEN
      PERFORM perf_resolve(c, v_id, b->>'action', b->>'note'); RETURN jsonb_build_object('resolved', true);
    ELSIF a = 'reviews' AND n = 3 AND m = 'GET' THEN RETURN perf_review_get(c, v_id);
    ELSIF a = 'reviews' AND n = 4 AND m = 'PUT' AND y IN ('self','manager') THEN PERFORM perf_review_save(c, v_id, y, b); RETURN perf_review_get(c, v_id);
    ELSIF a = 'reviews' AND n = 5 AND m = 'POST' AND y IN ('self','manager') AND z = 'submit' THEN PERFORM perf_review_submit(c, v_id, y); RETURN perf_review_get(c, v_id);
    ELSIF a = 'reviews' AND n = 4 AND m = 'POST' AND y = 'acknowledge' THEN PERFORM perf_acknowledge(c, v_id, b); RETURN perf_review_get(c, v_id);
    END IF;

  -- ── KPIs ──
  ELSIF a IN ('kpi-register','kpis','kpi-entries') THEN
    IF NOT v_goals THEN PERFORM work_fail('FEATURE_DISABLED', 'KPIs are switched off for this company.'); END IF;
    IF a = 'kpi-register' AND n = 2 AND m = 'GET' THEN RETURN perf_kpi_register(c, q);
    ELSIF a = 'kpi-entries' AND n = 3 AND x = 'submit' AND m = 'POST' THEN RETURN perf_kpi_submit(c, b);
    ELSIF a = 'kpis' AND n = 2 AND m = 'POST' THEN v_new := perf_kpi_create(c, b); RETURN perf_kpi_get(c, v_new, NULL);
    END IF;
    v_id := work_uuid(x);
    IF a = 'kpis' AND n = 3 AND m = 'GET' THEN RETURN perf_kpi_get(c, v_id, q->>'period');
    ELSIF a = 'kpis' AND n = 4 AND m = 'PUT' AND y = 'targets' THEN PERFORM perf_kpi_set_targets(c, v_id, b->'targets'); RETURN perf_kpi_get(c, v_id, NULL);
    ELSIF a = 'kpis' AND n = 5 AND m = 'PUT' AND y = 'entries' THEN PERFORM perf_kpi_save_entry(c, v_id, z, b); RETURN jsonb_build_object('saved', true);
    ELSIF a = 'kpis' AND n = 6 AND m = 'POST' AND y = 'entries' AND u = 'decision' THEN
      PERFORM perf_kpi_decide(c, v_id, z, b->>'action', b->>'reason'); RETURN jsonb_build_object('decided', true);
    END IF;
  END IF;

  PERFORM work_fail('NOT_FOUND', 'Not found.');
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION perf_api(p_method text, p_path text, p_query jsonb DEFAULT '{}'::jsonb, p_body jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN perf_api_route(p_method, p_path, p_query, p_body);
END;
$$;

-- Only the entry point is callable; every other perf_* function is internal.
DO $$
DECLARE
  f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND (p.proname LIKE 'perf\_%' OR p.proname IN ('work_task_goals', 'work_set_goals', 'trg_perf_touch')) LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.sig);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION perf_api(text, text, jsonb, jsonb) TO authenticated;
