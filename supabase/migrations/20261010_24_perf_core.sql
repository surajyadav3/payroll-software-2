-- =============================================================
-- Performance 1/2 — the performance system of the new CrewCore platform
-- (E:\CrewCore HRMS: database/migrations/0012–0016, 0034 and
-- apps/api/src/modules/pms), on this DB:
--
--   review cycles  → goal plans (weights add up to 100, measures, progress
--   check-ins, approval by the manager) → self review → manager review →
--   calibration → results (finalise, share, acknowledge / disagree).
--
-- New tables are prefixed perf_ and are reached only through perf_api()
-- (2/2). The earlier PMS (pms_* tables and RPCs, kras, reviews) is left
-- exactly as it is: nothing is dropped and the mobile app's legacy screens
-- keep reading their tables; the website simply no longer uses them.
--
-- Who is who (same mapping as Work): employee = profile; "manages X" = X is
-- in the caller's reporting tree (never oneself); HR = role admin/superadmin;
-- a review's reviewer = the employee's manager when the review opens.
-- Needs 20261010_21/22 (work_ctx, work_fail, work_name, work_notify, …).
-- Re-runnable.
-- =============================================================

-- ── 1. Rating scales, competencies, review forms (seeded per company on first use) ──
CREATE TABLE IF NOT EXISTS perf_scales (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','archived')),
  seed_key    text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, seed_key)
);
CREATE TABLE IF NOT EXISTS perf_scale_levels (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scale_id    uuid NOT NULL REFERENCES perf_scales(id) ON DELETE CASCADE,
  ordinal     smallint NOT NULL CHECK (ordinal BETWEEN 1 AND 10),
  value       numeric(5,2) NOT NULL,
  label       text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 60),
  description text NOT NULL DEFAULT '',
  -- A score from min_score to max_score maps to this level ("bands").
  min_score   numeric(5,2),
  max_score   numeric(5,2),
  UNIQUE (scale_id, ordinal),
  UNIQUE (scale_id, value)
);
CREATE TABLE IF NOT EXISTS perf_competencies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '',
  category    text NOT NULL DEFAULT 'custom' CHECK (category IN ('core','leadership','functional','custom')),
  is_active   boolean NOT NULL DEFAULT true,
  seed_key    text,
  UNIQUE (tenant_id, seed_key)
);
-- Which competencies a designation is rated on (none by default: reviews then rate goals and questions).
CREATE TABLE IF NOT EXISTS perf_designation_competencies (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  designation       text NOT NULL,
  competency_id     uuid NOT NULL REFERENCES perf_competencies(id) ON DELETE CASCADE,
  expected_level_id uuid REFERENCES perf_scale_levels(id) ON DELETE SET NULL,
  removed_at        timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS perf_designation_competencies_uq
  ON perf_designation_competencies(tenant_id, lower(designation), competency_id) WHERE removed_at IS NULL;
CREATE TABLE IF NOT EXISTS perf_templates (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  description         text NOT NULL DEFAULT '',
  goal_scale_id       uuid NOT NULL REFERENCES perf_scales(id),
  competency_scale_id uuid NOT NULL REFERENCES perf_scales(id),
  -- {mode, goalsWeight, competenciesWeight, questionsWeight, levelMapping, weightsRule, version}
  formula             jsonb NOT NULL CHECK (jsonb_typeof(formula) = 'object'),
  -- {selfReview, peerReview, calibration, acknowledgement, doubleBlind}
  steps               jsonb NOT NULL CHECK (jsonb_typeof(steps) = 'object'),
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','archived')),
  first_used_at       timestamptz,
  seed_key            text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, seed_key)
);
CREATE TABLE IF NOT EXISTS perf_template_questions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  template_id uuid NOT NULL REFERENCES perf_templates(id) ON DELETE CASCADE,
  ordinal     smallint NOT NULL CHECK (ordinal BETWEEN 1 AND 50),
  text        text NOT NULL CHECK (char_length(btrim(text)) BETWEEN 1 AND 1000),
  help_text   text NOT NULL DEFAULT '',
  scale_id    uuid REFERENCES perf_scales(id),   -- NULL = a comment-only question
  is_required boolean NOT NULL DEFAULT false,
  answered_by text NOT NULL DEFAULT 'both' CHECK (answered_by IN ('self','manager','both')),
  archived_at timestamptz
);

-- ── 2. Review cycles and who takes part ───────────────────────────────────
CREATE TABLE IF NOT EXISTS perf_cycles (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  type                text NOT NULL CHECK (type IN ('annual','half_yearly','quarterly','probation')),
  start_date          date NOT NULL,
  end_date            date NOT NULL,
  template_id         uuid NOT NULL REFERENCES perf_templates(id),
  goal_freeze_date    date,          -- last day goal definitions can change
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','closed','archived')),
  phase               text NOT NULL DEFAULT 'goal_setting' CHECK (phase IN ('goal_setting','self_review','manager_review','reviews_closed','results')),
  phase_locked        boolean NOT NULL DEFAULT false,
  self_review_due     date,
  manager_review_due  date,
  opened_at           timestamptz,
  launched_at         timestamptz,
  closed_at           timestamptz,
  deleted_at          timestamptz,
  deleted_by          uuid REFERENCES profiles(id) ON DELETE SET NULL,
  delete_reason       text CHECK (delete_reason IS NULL OR char_length(delete_reason) <= 500),
  deleted_from_status text CHECK (deleted_from_status IN ('draft','open','closed','archived')),
  created_by          uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  version             integer NOT NULL DEFAULT 1,
  CHECK (start_date <= end_date),
  CHECK (goal_freeze_date IS NULL OR goal_freeze_date BETWEEN start_date AND end_date),
  CHECK ((deleted_at IS NULL AND deleted_from_status IS NULL) OR (deleted_at IS NOT NULL AND status = 'archived' AND deleted_from_status IS NOT NULL))
);
-- A deleted (archived) cycle frees its name.
CREATE UNIQUE INDEX IF NOT EXISTS perf_cycles_name_uq ON perf_cycles(tenant_id, lower(name)) WHERE status <> 'archived';

CREATE TABLE IF NOT EXISTS perf_participants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  cycle_id        uuid NOT NULL REFERENCES perf_cycles(id) ON DELETE CASCADE,
  employee_id     uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'included' CHECK (status IN ('included','excluded','exited')),
  source          text NOT NULL DEFAULT 'rule' CHECK (source IN ('rule','manual','existing_goals')),
  -- Org facts when they joined the cycle (reports use this snapshot; access follows the live org).
  manager_id      uuid,
  department      text,
  designation     text,
  date_of_joining date,
  changed_at      timestamptz NOT NULL DEFAULT now(),
  changed_by      uuid REFERENCES profiles(id) ON DELETE SET NULL,
  UNIQUE (cycle_id, employee_id)
);
CREATE INDEX IF NOT EXISTS perf_participants_employee_idx ON perf_participants(employee_id);

-- ── 3. Goal plans, goals, measures, check-ins ─────────────────────────────
CREATE TABLE IF NOT EXISTS perf_goal_plans (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  cycle_id         uuid NOT NULL REFERENCES perf_cycles(id) ON DELETE CASCADE,
  employee_id      uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','returned','approved','rejected')),
  submission_no    integer NOT NULL DEFAULT 0,
  approver_id      uuid REFERENCES profiles(id) ON DELETE SET NULL,   -- who it waits for (NULL = HR)
  submitted_at     timestamptz,
  decided_at       timestamptz,
  decided_by       uuid REFERENCES profiles(id) ON DELETE SET NULL,
  decision_comment text CHECK (decision_comment IS NULL OR char_length(decision_comment) <= 2000),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          integer NOT NULL DEFAULT 1,
  UNIQUE (cycle_id, employee_id)
);
CREATE INDEX IF NOT EXISTS perf_goal_plans_employee_idx ON perf_goal_plans(employee_id);

CREATE TABLE IF NOT EXISTS perf_goals (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  level                 text NOT NULL DEFAULT 'individual' CHECK (level IN ('company','department','individual')),
  cycle_id              uuid REFERENCES perf_cycles(id) ON DELETE CASCADE,
  plan_id               uuid REFERENCES perf_goal_plans(id) ON DELETE CASCADE,
  owner_id              uuid REFERENCES profiles(id) ON DELETE CASCADE,
  department_id         uuid REFERENCES departments(id) ON DELETE SET NULL,
  title                 text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  description           text NOT NULL DEFAULT '' CHECK (char_length(description) <= 4000),
  weight                numeric(5,2) CHECK (weight > 0 AND weight <= 100),
  parent_goal_id        uuid REFERENCES perf_goals(id) ON DELETE SET NULL,
  status                text NOT NULL CHECK (status IN ('draft','pending_approval','active','returned','rejected','completed','archived')),
  origin                text NOT NULL CHECK (origin IN ('assigned','proposed','carried')),
  progress_percent      numeric(5,2) CHECK (progress_percent BETWEEN 0 AND 100),
  -- The owner's proposed edit of an approved goal: {title, description, weight, measures}; applied when the plan is approved.
  pending_change        jsonb CHECK (pending_change IS NULL OR jsonb_typeof(pending_change) = 'object'),
  change_submitted_at   timestamptz,
  proposed_submitted_at timestamptz,
  created_by            uuid REFERENCES profiles(id) ON DELETE SET NULL,
  approved_at           timestamptz,
  completed_at          timestamptz,
  archived_at           timestamptz,
  archive_reason        text CHECK (archive_reason IS NULL OR char_length(archive_reason) <= 500),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  version               integer NOT NULL DEFAULT 1,
  CHECK (level <> 'individual' OR (cycle_id IS NOT NULL AND plan_id IS NOT NULL AND owner_id IS NOT NULL AND weight IS NOT NULL)),
  CHECK ((status = 'archived') = (archived_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS perf_goals_plan_idx  ON perf_goals(plan_id);
CREATE INDEX IF NOT EXISTS perf_goals_owner_idx ON perf_goals(owner_id);

CREATE TABLE IF NOT EXISTS perf_goal_measures (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  goal_id       uuid NOT NULL REFERENCES perf_goals(id) ON DELETE CASCADE,
  ordinal       smallint NOT NULL CHECK (ordinal BETWEEN 1 AND 20),
  title         text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  kind          text NOT NULL CHECK (kind IN ('numeric','percentage','milestone','qualitative')),
  direction     text CHECK (direction IN ('increase','decrease')),
  unit          text NOT NULL DEFAULT '' CHECK (char_length(unit) <= 30),
  start_value   numeric(14,2),
  target_value  numeric(14,2),
  current_value numeric(14,2),
  is_done       boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS perf_goal_measures_current_uq ON perf_goal_measures(goal_id, ordinal) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS perf_goal_checkins (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  goal_id        uuid NOT NULL REFERENCES perf_goals(id) ON DELETE CASCADE,
  measure_id     uuid NOT NULL REFERENCES perf_goal_measures(id) ON DELETE CASCADE,
  value          numeric(14,2),
  is_done        boolean,
  note           text NOT NULL DEFAULT '' CHECK (char_length(note) <= 2000),
  progress_after numeric(5,2),
  author_id      uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS perf_goal_checkins_goal_idx ON perf_goal_checkins(goal_id, created_at DESC);

-- ── 4. Reviews, results, acknowledgements ─────────────────────────────────
CREATE TABLE IF NOT EXISTS perf_reviews (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  cycle_id             uuid NOT NULL REFERENCES perf_cycles(id) ON DELETE CASCADE,
  participant_id       uuid NOT NULL REFERENCES perf_participants(id) ON DELETE CASCADE,
  employee_id          uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  reviewer_id          uuid REFERENCES profiles(id) ON DELETE SET NULL,
  status               text NOT NULL CHECK (status IN ('blocked','not_started','self_in_progress','self_submitted','manager_in_progress',
                                                       'manager_submitted','finalised','shared','void')),
  blocked_reason       text CHECK (blocked_reason IN ('NO_PLAN','NO_GOALS','PLAN_PENDING','WEIGHTS_INCOMPLETE')),
  self_not_submitted   boolean NOT NULL DEFAULT false,   -- the manager reviewed without a submitted self review
  opened_at            timestamptz,
  self_submitted_at    timestamptz,
  manager_submitted_at timestamptz,
  proposed_score       numeric(5,2),
  proposed_level_id    uuid REFERENCES perf_scale_levels(id),
  score_inputs         jsonb,
  formula_version      integer,
  reopened_at          timestamptz,
  current_outcome_id   uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  version              integer NOT NULL DEFAULT 1,
  CHECK ((status = 'blocked') = (blocked_reason IS NOT NULL)),
  CHECK (reviewer_id IS NULL OR reviewer_id <> employee_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS perf_reviews_current_uq ON perf_reviews(participant_id) WHERE status <> 'void';
CREATE INDEX IF NOT EXISTS perf_reviews_employee_idx ON perf_reviews(employee_id);
CREATE INDEX IF NOT EXISTS perf_reviews_reviewer_idx ON perf_reviews(reviewer_id);
CREATE INDEX IF NOT EXISTS perf_reviews_cycle_idx    ON perf_reviews(cycle_id);

-- The immutable list of what is rated, snapshotted when the review opens.
CREATE TABLE IF NOT EXISTS perf_review_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  review_id         uuid NOT NULL REFERENCES perf_reviews(id) ON DELETE CASCADE,
  ordinal           smallint NOT NULL,
  item_type         text NOT NULL CHECK (item_type IN ('goal','competency','question')),
  ref_id            uuid NOT NULL,
  title             text NOT NULL,
  help_text         text NOT NULL DEFAULT '',
  weight            numeric(5,2),
  scale_id          uuid REFERENCES perf_scales(id),
  expected_level_id uuid REFERENCES perf_scale_levels(id),
  answered_by       text NOT NULL DEFAULT 'both' CHECK (answered_by IN ('self','manager','both')),
  is_required       boolean NOT NULL DEFAULT true,
  UNIQUE (review_id, ordinal)
);
CREATE TABLE IF NOT EXISTS perf_review_ratings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  review_id      uuid NOT NULL REFERENCES perf_reviews(id) ON DELETE CASCADE,
  review_item_id uuid NOT NULL REFERENCES perf_review_items(id) ON DELETE CASCADE,
  rater_role     text NOT NULL CHECK (rater_role IN ('self','manager')),
  author_id      uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  level_id       uuid REFERENCES perf_scale_levels(id),
  not_applicable boolean NOT NULL DEFAULT false,
  comment        text NOT NULL DEFAULT '' CHECK (char_length(comment) <= 2000),
  UNIQUE (review_item_id, rater_role, author_id),
  CHECK (NOT (not_applicable AND level_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS perf_review_ratings_review_idx ON perf_review_ratings(review_id);
CREATE TABLE IF NOT EXISTS perf_review_summaries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  review_id         uuid NOT NULL REFERENCES perf_reviews(id) ON DELETE CASCADE,
  rater_role        text NOT NULL CHECK (rater_role IN ('self','manager')),
  author_id         uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  comment           text NOT NULL DEFAULT '' CHECK (char_length(comment) <= 4000),
  overall_level_id  uuid REFERENCES perf_scale_levels(id),
  override_level_id uuid REFERENCES perf_scale_levels(id),
  override_reason   text CHECK (override_reason IS NULL OR char_length(override_reason) BETWEEN 3 AND 2000),
  UNIQUE (review_id, rater_role, author_id),
  CHECK ((override_level_id IS NULL) = (override_reason IS NULL)),
  CHECK (override_level_id IS NULL OR rater_role = 'manager')
);
-- One row per finalised result; reopening a review supersedes it and the next finalise makes a new version.
CREATE TABLE IF NOT EXISTS perf_review_outcomes (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  review_id            uuid NOT NULL REFERENCES perf_reviews(id) ON DELETE CASCADE,
  cycle_id             uuid NOT NULL REFERENCES perf_cycles(id) ON DELETE CASCADE,
  employee_id          uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  version_no           integer NOT NULL,
  reviewer_id          uuid,
  score                numeric(5,2),
  proposed_level_id    uuid REFERENCES perf_scale_levels(id),
  final_level_id       uuid NOT NULL REFERENCES perf_scale_levels(id),
  override_level_id    uuid REFERENCES perf_scale_levels(id),
  override_reason      text,
  score_inputs         jsonb,
  formula_version      integer,
  manager_submitted_at timestamptz,
  finalised_at         timestamptz NOT NULL DEFAULT now(),
  finalised_by         uuid REFERENCES profiles(id) ON DELETE SET NULL,
  shared_at            timestamptz,
  shared_by            uuid REFERENCES profiles(id) ON DELETE SET NULL,
  superseded_at        timestamptz,
  superseded_by        uuid REFERENCES profiles(id) ON DELETE SET NULL,
  superseded_reason    text,
  UNIQUE (review_id, version_no),
  CHECK (final_level_id = COALESCE(override_level_id, proposed_level_id))
);
CREATE UNIQUE INDEX IF NOT EXISTS perf_review_outcomes_current_uq ON perf_review_outcomes(review_id) WHERE superseded_at IS NULL;
CREATE TABLE IF NOT EXISTS perf_review_acks (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  outcome_id           uuid NOT NULL UNIQUE REFERENCES perf_review_outcomes(id) ON DELETE CASCADE,   -- one per result version; final
  review_id            uuid NOT NULL REFERENCES perf_reviews(id) ON DELETE CASCADE,
  employee_id          uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  acknowledged_at      timestamptz NOT NULL DEFAULT now(),
  comment              text NOT NULL DEFAULT '' CHECK (char_length(comment) <= 2000),
  disagrees            boolean NOT NULL DEFAULT false,
  disagreement_comment text CHECK (disagreement_comment IS NULL OR char_length(disagreement_comment) BETWEEN 3 AND 2000),
  resolution           text CHECK (resolution IN ('open','closed_with_note','reopened')),
  resolved_note        text,
  resolved_by          uuid REFERENCES profiles(id) ON DELETE SET NULL,
  resolved_at          timestamptz,
  CHECK (disagrees = (disagreement_comment IS NOT NULL)),
  CHECK (disagrees = (resolution IS NOT NULL))
);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['perf_scales','perf_scale_levels','perf_competencies','perf_designation_competencies','perf_templates',
                           'perf_template_questions','perf_cycles','perf_participants','perf_goal_plans','perf_goals','perf_goal_measures',
                           'perf_goal_checkins','perf_reviews','perf_review_items','perf_review_ratings','perf_review_summaries',
                           'perf_review_outcomes','perf_review_acks'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);   -- no policies: perf_api() only
  END LOOP;
END $$;

-- updated_at + optimistic version (the web app sends the version it read as If-Match).
CREATE OR REPLACE FUNCTION trg_perf_touch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['perf_cycles','perf_goal_plans','perf_goals','perf_reviews'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_touch', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION trg_perf_touch()', t || '_touch', t);
  END LOOP;
END $$;

-- ── 5. Defaults for a company (the platform seeds these for every organisation) ──
CREATE OR REPLACE FUNCTION perf_seed_tenant(p_tenant uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_scale uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM perf_templates WHERE tenant_id = p_tenant AND seed_key = 'default.template') THEN RETURN; END IF;
  INSERT INTO perf_scales (tenant_id, name, description, status, seed_key)
  VALUES (p_tenant, 'Standard 5-point scale', 'Default rating scale. Labels and descriptions can be edited to match your organisation.', 'active', 'default.scale.5')
  ON CONFLICT (tenant_id, seed_key) DO NOTHING;
  SELECT id INTO v_scale FROM perf_scales WHERE tenant_id = p_tenant AND seed_key = 'default.scale.5';
  INSERT INTO perf_scale_levels (tenant_id, scale_id, ordinal, value, label, description, min_score, max_score)
  SELECT p_tenant, v_scale, v.ordinal, v.value, v.label, v.description, v.band_min, v.band_max
  FROM (VALUES
    (1, 1.00, 'Needs improvement', 'Performance is consistently below what the role requires; clear improvement is needed.', 1.00, 1.49),
    (2, 2.00, 'Partially meets expectations', 'Meets some expectations of the role, but not consistently.', 1.50, 2.49),
    (3, 3.00, 'Meets expectations', 'Reliably delivers what the role requires.', 2.50, 3.49),
    (4, 4.00, 'Exceeds expectations', 'Frequently delivers beyond what the role requires.', 3.50, 4.49),
    (5, 5.00, 'Outstanding', 'Consistently delivers exceptional results and sets an example for others.', 4.50, 5.00)
  ) AS v(ordinal, value, label, description, band_min, band_max)
  ON CONFLICT (scale_id, ordinal) DO NOTHING;
  INSERT INTO perf_competencies (tenant_id, name, description, category, seed_key)
  SELECT p_tenant, c.name, c.description, c.category, c.seed_key
  FROM (VALUES
    ('starter.communication', 'Communication', 'core', 'Shares information clearly and listens actively, in writing and in conversation.'),
    ('starter.collaboration', 'Collaboration', 'core', 'Works well with others, shares knowledge and helps the team succeed.'),
    ('starter.ownership', 'Ownership and accountability', 'core', 'Takes responsibility for commitments and follows through on them.'),
    ('starter.problem_solving', 'Problem solving', 'core', 'Understands problems, weighs options and finds practical solutions.'),
    ('starter.customer_focus', 'Customer focus', 'core', 'Understands the needs of customers, internal or external, and acts on them.'),
    ('starter.quality', 'Quality and attention to detail', 'core', 'Produces accurate, reliable work and checks it before handing it on.'),
    ('starter.adaptability', 'Adaptability and learning', 'core', 'Adjusts to change and keeps building new skills.'),
    ('starter.planning', 'Planning and organisation', 'core', 'Prioritises work, plans ahead and meets deadlines.'),
    ('starter.people_leadership', 'People leadership', 'leadership', 'Sets direction, develops people and builds an effective team.')
  ) AS c(seed_key, name, category, description)
  ON CONFLICT (tenant_id, seed_key) DO NOTHING;
  INSERT INTO perf_templates (tenant_id, name, description, goal_scale_id, competency_scale_id, formula, steps, status, seed_key)
  VALUES (p_tenant, 'Standard review', 'Default template: goals 70 %, competencies 30 %, self review and acknowledgement on.', v_scale, v_scale,
          '{"mode":"weighted","goalsWeight":70,"competenciesWeight":30,"questionsWeight":0,"levelMapping":"bands","weightsRule":"sum_100","version":1}',
          '{"selfReview":true,"peerReview":false,"calibration":false,"acknowledgement":true,"doubleBlind":false}', 'active', 'default.template')
  ON CONFLICT (tenant_id, seed_key) DO NOTHING;
END;
$$;

-- ── 6. Access and small helpers ───────────────────────────────────────────
-- Manages this employee's goals and reviews (never their own).
CREATE OR REPLACE FUNCTION perf_manages(c work_ctx, p_employee uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT p_employee IS NOT NULL AND p_employee <> c.me AND (c.overseer OR p_employee = ANY (c.team));
$$;

-- 'none' | 'draft' | 'open' | 'frozen' (goal setting ended) | 'closed'
CREATE OR REPLACE FUNCTION perf_cycle_state(cy perf_cycles, p_today date)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN cy.id IS NULL THEN 'none'
              WHEN cy.status IN ('closed','archived') THEN 'closed'
              WHEN cy.status = 'open' AND cy.goal_freeze_date IS NOT NULL AND cy.goal_freeze_date < p_today THEN 'frozen'
              ELSE cy.status END;
$$;

CREATE OR REPLACE FUNCTION perf_cycle_row(c work_ctx, p_id uuid, p_lock boolean DEFAULT false, p_version text DEFAULT NULL, p_deleted boolean DEFAULT false)
RETURNS perf_cycles LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cy perf_cycles;
BEGIN
  IF p_lock THEN PERFORM 1 FROM perf_cycles WHERE id = p_id FOR UPDATE; END IF;
  SELECT * INTO cy FROM perf_cycles WHERE id = p_id AND tenant_id = c.tenant;
  IF cy.id IS NULL OR (cy.deleted_at IS NOT NULL AND NOT p_deleted) THEN PERFORM work_fail('NOT_FOUND', 'Review cycle not found.'); END IF;
  IF p_version IS NOT NULL AND p_version <> '' AND cy.version::text <> p_version THEN
    PERFORM work_fail('PRECONDITION_FAILED', 'This was changed by someone else. Reload and try again.');
  END IF;
  RETURN cy;
END;
$$;

CREATE OR REPLACE FUNCTION perf_assert_hr(c work_ctx)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT c.overseer THEN PERFORM work_fail('FORBIDDEN', 'Only HR can do that.'); END IF;
END;
$$;

CREATE OR REPLACE FUNCTION perf_cycle_json(cy perf_cycles)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'id', cy.id, 'name', cy.name, 'type', cy.type, 'startDate', cy.start_date, 'endDate', cy.end_date, 'templateId', cy.template_id,
    'goalFreezeDate', cy.goal_freeze_date, 'status', cy.status, 'phase', cy.phase, 'phaseLocked', cy.phase_locked,
    'selfReviewDue', cy.self_review_due, 'managerReviewDue', cy.manager_review_due, 'launchedAt', work_iso(cy.launched_at),
    'deleted', CASE WHEN cy.deleted_at IS NULL THEN NULL
                    ELSE jsonb_build_object('at', work_iso(cy.deleted_at), 'reason', cy.delete_reason, 'fromStatus', cy.deleted_from_status) END,
    'version', cy.version);
$$;

CREATE OR REPLACE FUNCTION perf_template_of(cy perf_cycles)
RETURNS perf_templates LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t FROM perf_templates t WHERE t.id = cy.template_id;
$$;

-- The employee's nearest active manager (who reviews them and approves their goal plan).
CREATE OR REPLACE FUNCTION perf_manager_of(p_employee uuid)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_at uuid := p_employee;
  v_mgr uuid;
  v_status text;
  i int := 0;
BEGIN
  LOOP
    i := i + 1;
    SELECT m.id, m.status INTO v_mgr, v_status FROM profiles a JOIN profiles m ON m.id = a.manager_id WHERE a.id = v_at;
    EXIT WHEN v_mgr IS NULL OR i > 10 OR v_mgr = p_employee;
    IF v_status = 'Active' THEN RETURN v_mgr; END IF;
    v_at := v_mgr;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION perf_notify(c work_ctx, p_to uuid[], p_type text, p_title text, p_body text DEFAULT NULL)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT work_notify(c.tenant, p_to, c.me, p_type, p_title, p_body, 'performance', NULL);
$$;

-- HR of a company (falls back where there is no manager to ask).
CREATE OR REPLACE FUNCTION perf_hr_ids(p_tenant uuid)
RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(ARRAY(SELECT id FROM profiles WHERE tenant_id = p_tenant AND role = 'admin' AND status = 'Active'), '{}'::uuid[]);
$$;

-- ── 7. Measures and progress ──────────────────────────────────────────────
-- Progress of one measure, 0–100 (NULL for a judgement).
CREATE OR REPLACE FUNCTION perf_measure_progress(m perf_goal_measures)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE m.kind
    WHEN 'qualitative' THEN NULL
    WHEN 'milestone' THEN CASE WHEN m.is_done THEN 100 ELSE 0 END
    ELSE round(LEAST(100, GREATEST(0,
           CASE WHEN m.direction = 'decrease' THEN (m.start_value - m.current_value) / NULLIF(m.start_value - m.target_value, 0)
                ELSE (m.current_value - m.start_value) / NULLIF(m.target_value - m.start_value, 0) END * 100)), 2)
  END;
$$;

CREATE OR REPLACE FUNCTION perf_refresh_progress(p_goal uuid)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v numeric;
BEGIN
  SELECT round(avg(perf_measure_progress(m)), 2) INTO v FROM perf_goal_measures m WHERE m.goal_id = p_goal AND m.archived_at IS NULL;
  UPDATE perf_goals SET progress_percent = v WHERE id = p_goal;
  RETURN v;
END;
$$;

-- Checks and tidies the measures sent by the web app; returns them in storage shape.
CREATE OR REPLACE FUNCTION perf_normalise_measures(p jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  m jsonb;
  out_ jsonb := '[]'::jsonb;
  i int := 0;
  v_title text; v_kind text; v_dir text; v_unit text; v_path text;
  v_start numeric; v_target numeric; v_current numeric;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'array' THEN RETURN out_; END IF;
  IF jsonb_array_length(p) > 20 THEN PERFORM work_fail('VALIDATION', 'A goal can have at most 20 measures.'); END IF;
  FOR m IN SELECT * FROM jsonb_array_elements(p) LOOP
    i := i + 1;
    v_path := 'Measure ' || i;
    v_title := btrim(COALESCE(m->>'title', ''));
    v_kind := m->>'kind';
    IF char_length(v_title) NOT BETWEEN 1 AND 200 THEN PERFORM work_fail('VALIDATION', v_path || ': a title is required (up to 200 characters).'); END IF;
    IF v_kind IS NULL OR v_kind NOT IN ('numeric','percentage','milestone','qualitative') THEN PERFORM work_fail('VALIDATION', v_path || ': unknown kind.'); END IF;
    IF v_kind IN ('milestone','qualitative') THEN
      out_ := out_ || jsonb_build_object('title', v_title, 'kind', v_kind, 'isDone', v_kind = 'milestone' AND COALESCE((m->>'isDone')::boolean, false));
      CONTINUE;
    END IF;
    v_dir := m->>'direction';
    v_unit := CASE WHEN v_kind = 'percentage' THEN '' ELSE btrim(COALESCE(m->>'unit', '')) END;
    IF v_dir IS NULL OR v_dir NOT IN ('increase','decrease') THEN PERFORM work_fail('VALIDATION', v_path || ': choose whether higher or lower is better.'); END IF;
    IF char_length(v_unit) > 30 THEN PERFORM work_fail('VALIDATION', v_path || ': the unit is too long.'); END IF;
    IF COALESCE(m->>'startValue', '') !~ '^-?\d{1,12}(\.\d{1,2})?$' THEN PERFORM work_fail('VALIDATION', v_path || ': the start value must be a number with at most 2 decimals.'); END IF;
    IF COALESCE(m->>'targetValue', '') = '' THEN PERFORM work_fail('VALIDATION', v_path || ': a target value is required.'); END IF;
    IF m->>'targetValue' !~ '^-?\d{1,12}(\.\d{1,2})?$' THEN PERFORM work_fail('VALIDATION', v_path || ': the target value must be a number with at most 2 decimals.'); END IF;
    v_start := (m->>'startValue')::numeric;
    v_target := (m->>'targetValue')::numeric;
    v_current := CASE WHEN COALESCE(m->>'currentValue', '') ~ '^-?\d{1,12}(\.\d{1,2})?$' THEN (m->>'currentValue')::numeric ELSE v_start END;
    IF v_kind = 'percentage' AND (v_start NOT BETWEEN 0 AND 100 OR v_target NOT BETWEEN 0 AND 100 OR v_current NOT BETWEEN 0 AND 100) THEN
      PERFORM work_fail('VALIDATION', v_path || ': percentage values must be between 0 and 100.');
    END IF;
    IF v_target = v_start THEN PERFORM work_fail('VALIDATION', v_path || ': the target must differ from the start value.'); END IF;
    IF v_dir = 'increase' AND v_target < v_start THEN PERFORM work_fail('VALIDATION', v_path || ': for "higher is better", the target must be above the start value.'); END IF;
    IF v_dir = 'decrease' AND v_target > v_start THEN PERFORM work_fail('VALIDATION', v_path || ': for "lower is better", the target must be below the start value.'); END IF;
    out_ := out_ || jsonb_build_object('title', v_title, 'kind', v_kind, 'direction', v_dir, 'unit', v_unit,
                                       'startValue', v_start, 'targetValue', v_target, 'currentValue', v_current, 'isDone', false);
  END LOOP;
  RETURN out_;
END;
$$;

-- Replaces a goal's measures. Progress already recorded is kept for a measure whose title and kind did not change.
CREATE OR REPLACE FUNCTION perf_replace_measures(p_tenant uuid, p_goal uuid, p_measures jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  m jsonb;
  old perf_goal_measures;
  i int := 0;
  v_current numeric;
  v_done boolean;
  v_olds perf_goal_measures[] := ARRAY(SELECT x FROM perf_goal_measures x WHERE x.goal_id = p_goal AND x.archived_at IS NULL);
BEGIN
  UPDATE perf_goal_measures SET archived_at = now() WHERE goal_id = p_goal AND archived_at IS NULL;
  FOR m IN SELECT * FROM jsonb_array_elements(p_measures) LOOP
    i := i + 1;
    v_current := (m->>'currentValue')::numeric;
    v_done := COALESCE((m->>'isDone')::boolean, false);
    FOREACH old IN ARRAY v_olds LOOP
      IF old.title = m->>'title' AND old.kind = m->>'kind' THEN
        IF old.kind = 'milestone' THEN v_done := old.is_done;
        ELSIF old.kind IN ('numeric','percentage') AND old.current_value IS NOT NULL
              AND old.current_value BETWEEN LEAST((m->>'startValue')::numeric, (m->>'targetValue')::numeric)
                                        AND GREATEST((m->>'startValue')::numeric, (m->>'targetValue')::numeric) THEN
          v_current := old.current_value;
        END IF;
        EXIT;
      END IF;
    END LOOP;
    INSERT INTO perf_goal_measures (tenant_id, goal_id, ordinal, title, kind, direction, unit, start_value, target_value, current_value, is_done)
    VALUES (p_tenant, p_goal, i, m->>'title', m->>'kind', m->>'direction', COALESCE(m->>'unit', ''), (m->>'startValue')::numeric,
            (m->>'targetValue')::numeric, CASE WHEN m->>'kind' IN ('numeric','percentage') THEN v_current END, v_done);
  END LOOP;
END;
$$;

-- ── 8. Goal and plan shapes ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION perf_goal_json(g perf_goals)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'id', g.id, 'level', g.level, 'cycleId', g.cycle_id, 'planId', g.plan_id, 'ownerEmployeeId', g.owner_id, 'departmentId', g.department_id,
    'title', g.title, 'description', g.description, 'weight', g.weight::text, 'parentGoalId', g.parent_goal_id, 'carriedFromGoalId', NULL,
    'status', g.status, 'origin', g.origin, 'progressPercent', g.progress_percent::text, 'pendingChange', g.pending_change,
    'changeSubmittedAt', work_iso(g.change_submitted_at), 'proposedSubmittedAt', work_iso(g.proposed_submitted_at),
    'measures', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', m.id, 'ordinal', m.ordinal, 'title', m.title, 'kind', m.kind, 'direction', m.direction, 'unit', m.unit,
        'startValue', m.start_value::text, 'targetValue', m.target_value::text, 'currentValue', m.current_value::text,
        'isDone', CASE WHEN m.kind = 'milestone' THEN m.is_done END, 'progressPercent', perf_measure_progress(m)::text) ORDER BY m.ordinal)
      FROM perf_goal_measures m WHERE m.goal_id = g.id AND m.archived_at IS NULL), '[]'::jsonb),
    'approvedAt', work_iso(g.approved_at), 'completedAt', work_iso(g.completed_at), 'archivedAt', work_iso(g.archived_at),
    'archiveReason', g.archive_reason, 'version', g.version, 'createdAt', work_iso(g.created_at), 'updatedAt', work_iso(g.updated_at));
$$;

-- What a plan's weights add up to (a proposed weight change counts as proposed).
CREATE OR REPLACE FUNCTION perf_plan_total(p_plan uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(round(sum(COALESCE((g.pending_change->>'weight')::numeric, g.weight)), 2), 0)
  FROM perf_goals g WHERE g.plan_id = p_plan AND g.status IN ('draft','returned','pending_approval','active','completed');
$$;

CREATE OR REPLACE FUNCTION perf_weights_rule(cy perf_cycles)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((SELECT t.formula->>'weightsRule' FROM perf_templates t WHERE t.id = cy.template_id), 'sum_100');
$$;

CREATE OR REPLACE FUNCTION perf_plan_get(c work_ctx, p_cycle uuid, p_employee uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cy perf_cycles := perf_cycle_row(c, p_cycle);
  pl perf_goal_plans;
  v_rule text := perf_weights_rule(cy);
  v_total numeric;
BEGIN
  IF p_employee IS DISTINCT FROM c.me AND NOT perf_manages(c, p_employee) THEN PERFORM work_fail('NOT_FOUND', 'Goal plan not found.'); END IF;
  SELECT * INTO pl FROM perf_goal_plans WHERE cycle_id = p_cycle AND employee_id = p_employee;
  v_total := CASE WHEN pl.id IS NULL THEN 0 ELSE perf_plan_total(pl.id) END;
  RETURN jsonb_build_object(
    'id', pl.id, 'cycleId', p_cycle, 'employeeId', p_employee, 'status', COALESCE(pl.status, 'draft'),
    'submissionNo', COALESCE(pl.submission_no, 0),
    -- The platform's approvals engine is not used here: the plan itself carries who decides it.
    'approvalInstanceId', NULL,
    'approver', CASE WHEN pl.approver_id IS NULL THEN NULL ELSE jsonb_build_object('employeeId', pl.approver_id, 'name', work_name(pl.approver_id)) END,
    'decisionComment', pl.decision_comment,
    'canDecide', pl.status = 'submitted' AND perf_manages(c, p_employee),
    'weightsRule', v_rule, 'totalWeight', to_char(v_total, 'FM990.00'),
    'weightsComplete', v_rule = 'equal' OR abs(v_total - 100) <= 0.01,
    'goals', COALESCE((SELECT jsonb_agg(perf_goal_json(g) ORDER BY g.created_at, g.id) FROM perf_goals g WHERE g.plan_id = pl.id), '[]'::jsonb),
    'version', COALESCE(pl.version, 0));
END;
$$;

-- Plans of the people the caller manages (everyone for HR), never their own.
CREATE OR REPLACE FUNCTION perf_plans_list(c work_ctx, p_cycle uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cy perf_cycles := perf_cycle_row(c, p_cycle);
  v_rule text := perf_weights_rule(cy);
BEGIN
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object('id', x.id, 'employeeId', x.employee_id, 'employeeName', x.name, 'status', x.status,
             'approvalInstanceId', NULL, 'totalWeight', to_char(x.total, 'FM990.00'),
             'weightsComplete', v_rule = 'equal' OR abs(x.total - 100) <= 0.01, 'submittedAt', work_iso(x.submitted_at)) ORDER BY x.name)
    FROM (SELECT pl.id, pl.employee_id, pl.status, pl.submitted_at, COALESCE(work_name(pl.employee_id), 'Employee') AS name, perf_plan_total(pl.id) AS total
          FROM perf_goal_plans pl
          WHERE pl.cycle_id = p_cycle AND pl.employee_id <> c.me AND (c.overseer OR pl.employee_id = ANY (c.team))) x), '[]'::jsonb);
END;
$$;

-- ── 9. Reviews: the 100 % gate, opening, the list of what is rated ────────
-- Why a participant's review cannot open yet (NULL = it may open).
CREATE OR REPLACE FUNCTION perf_gate_for(cy perf_cycles, p_employee uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  pl perf_goal_plans;
  v_approved int; v_pending int; v_total numeric;
BEGIN
  SELECT * INTO pl FROM perf_goal_plans WHERE cycle_id = cy.id AND employee_id = p_employee;
  IF pl.id IS NULL THEN RETURN 'NO_PLAN'; END IF;
  SELECT count(*) FILTER (WHERE status IN ('active','completed')),
         count(*) FILTER (WHERE status IN ('draft','returned','pending_approval') OR (status IN ('active','completed') AND pending_change IS NOT NULL)),
         COALESCE(sum(weight) FILTER (WHERE status IN ('active','completed')), 0)
    INTO v_approved, v_pending, v_total
  FROM perf_goals WHERE plan_id = pl.id;
  IF v_approved = 0 THEN RETURN CASE WHEN v_pending > 0 THEN 'PLAN_PENDING' ELSE 'NO_GOALS' END; END IF;
  -- Plans made only of manager-assigned goals never go through approval: "approved" = nothing pending.
  IF v_pending > 0 OR pl.status IN ('submitted','returned') THEN RETURN 'PLAN_PENDING'; END IF;
  IF perf_weights_rule(cy) <> 'equal' AND abs(v_total - 100) > 0.01 THEN RETURN 'WEIGHTS_INCOMPLETE'; END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION perf_snapshot_items(r perf_reviews, cy perf_cycles)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  t perf_templates := perf_template_of(cy);
  v_designation text := (SELECT designation FROM profiles WHERE id = r.employee_id);
BEGIN
  INSERT INTO perf_review_items (tenant_id, review_id, ordinal, item_type, ref_id, title, help_text, weight, scale_id, expected_level_id, answered_by, is_required)
  SELECT r.tenant_id, r.id, row_number() OVER (ORDER BY x.section, x.ord, x.ref_id), x.item_type, x.ref_id, x.title, x.help_text, x.weight,
         x.scale_id, x.expected_level_id, x.answered_by, x.is_required
  FROM (
    SELECT 1 AS section, extract(epoch FROM g.created_at) AS ord, 'goal' AS item_type, g.id AS ref_id, g.title, left(g.description, 1000) AS help_text,
           g.weight, t.goal_scale_id AS scale_id, NULL::uuid AS expected_level_id, 'both' AS answered_by, true AS is_required
    FROM perf_goals g JOIN perf_goal_plans pl ON pl.id = g.plan_id
    WHERE pl.cycle_id = cy.id AND pl.employee_id = r.employee_id AND g.status IN ('active','completed')
    UNION ALL
    SELECT 2, row_number() OVER (ORDER BY lower(cp.name)), 'competency', cp.id, cp.name, left(cp.description, 1000), NULL, t.competency_scale_id,
           dc.expected_level_id, 'both', true
    FROM perf_designation_competencies dc JOIN perf_competencies cp ON cp.id = dc.competency_id AND cp.is_active
    WHERE dc.tenant_id = r.tenant_id AND dc.removed_at IS NULL AND v_designation IS NOT NULL AND lower(dc.designation) = lower(v_designation)
    UNION ALL
    SELECT 3, q.ordinal, 'question', q.id, q.text, q.help_text, NULL, q.scale_id, NULL, q.answered_by, q.is_required
    FROM perf_template_questions q WHERE q.template_id = t.id AND q.archived_at IS NULL) x;
END;
$$;

-- Creates missing reviews for included participants (blocked or open), and re-checks blocked ones.
-- Only in a review phase. Returns how many opened now.
CREATE OR REPLACE FUNCTION perf_open_reviews(p_cycle uuid, p_only uuid DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cy perf_cycles;
  p perf_participants;
  r perf_reviews;
  v_reason text;
  v_opened int := 0;
BEGIN
  SELECT * INTO cy FROM perf_cycles WHERE id = p_cycle FOR UPDATE;
  IF cy.id IS NULL OR cy.status <> 'open' OR cy.phase NOT IN ('self_review','manager_review') THEN RETURN 0; END IF;
  FOR p IN SELECT * FROM perf_participants WHERE cycle_id = p_cycle AND status = 'included' AND (p_only IS NULL OR employee_id = p_only) LOOP
    SELECT * INTO r FROM perf_reviews WHERE participant_id = p.id AND status <> 'void' FOR UPDATE;
    IF r.id IS NULL THEN
      INSERT INTO perf_reviews (tenant_id, cycle_id, participant_id, employee_id, reviewer_id, status, blocked_reason)
      VALUES (p.tenant_id, p_cycle, p.id, p.employee_id, perf_manager_of(p.employee_id), 'blocked', 'NO_PLAN')
      RETURNING * INTO r;
    END IF;
    CONTINUE WHEN r.status <> 'blocked';
    v_reason := perf_gate_for(cy, p.employee_id);
    IF v_reason IS NOT NULL THEN
      IF v_reason IS DISTINCT FROM r.blocked_reason THEN UPDATE perf_reviews SET blocked_reason = v_reason WHERE id = r.id; END IF;
      CONTINUE;
    END IF;
    PERFORM perf_snapshot_items(r, cy);
    UPDATE perf_reviews SET status = 'not_started', blocked_reason = NULL, opened_at = now(),
           self_not_submitted = (cy.phase = 'manager_review') WHERE id = r.id;
    PERFORM work_notify(p.tenant_id, ARRAY[p.employee_id], NULL, 'performance_review',
                        'Your performance review is open: ' || cy.name, NULL, 'performance', NULL);
    v_opened := v_opened + 1;
  END LOOP;
  RETURN v_opened;
END;
$$;

-- ── 10. Goals: create, edit, archive, progress ────────────────────────────
CREATE OR REPLACE FUNCTION perf_goal_row(c work_ctx, p_id uuid, p_lock boolean DEFAULT false, p_version text DEFAULT NULL)
RETURNS perf_goals LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  g perf_goals;
BEGIN
  IF p_lock THEN PERFORM 1 FROM perf_goals WHERE id = p_id FOR UPDATE; END IF;
  SELECT * INTO g FROM perf_goals WHERE id = p_id AND tenant_id = c.tenant;
  -- Never confirm that someone else's goal exists.
  IF g.id IS NULL OR NOT (g.owner_id IS NOT DISTINCT FROM c.me OR perf_manages(c, g.owner_id)) THEN PERFORM work_fail('NOT_FOUND', 'Goal not found.'); END IF;
  IF p_version IS NOT NULL AND p_version <> '' AND g.version::text <> p_version THEN
    PERFORM work_fail('PRECONDITION_FAILED', 'This was changed by someone else. Reload and try again.');
  END IF;
  RETURN g;
END;
$$;

CREATE OR REPLACE FUNCTION perf_assert_goal_setting(cy perf_cycles, p_today date, p_must_be_open boolean)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  s text := perf_cycle_state(cy, p_today);
BEGIN
  IF s = 'closed' THEN PERFORM work_fail('CYCLE_CLOSED', 'The review cycle is closed.'); END IF;
  IF s = 'frozen' THEN PERFORM work_fail('GOALS_FROZEN', 'Goals for this cycle are frozen: only progress can change. HR can remove a goal with a reason.'); END IF;
  IF p_must_be_open AND s <> 'open' THEN PERFORM work_fail('CYCLE_NOT_OPEN', 'Goal setting has not started for this cycle.'); END IF;
END;
$$;

CREATE OR REPLACE FUNCTION perf_weight(p text)
RETURNS numeric LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF p IS NULL OR p !~ '^\d{1,3}(\.\d{1,2})?$' OR p::numeric <= 0 OR p::numeric > 100 THEN
    RAISE EXCEPTION 'A goal needs a weight from 0.01 to 100.' USING ERRCODE = 'P0001', DETAIL = 'VALIDATION';
  END IF;
  RETURN p::numeric;
END;
$$;

-- A new or changed proposal reopens a decided plan, so it can be sent for approval again.
CREATE OR REPLACE FUNCTION perf_reopen_plan(p_plan uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE perf_goal_plans SET status = 'draft' WHERE id = p_plan AND status IN ('approved','rejected');
$$;

-- A person's own goal starts as a draft proposal; a goal their manager adds is assigned and active at once.
CREATE OR REPLACE FUNCTION perf_goal_create(c work_ctx, i jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cycle uuid := work_uuid(i->>'cycleId');
  v_owner uuid := work_uuid(i->>'ownerEmployeeId');
  v_title text := btrim(COALESCE(i->>'title', ''));
  v_desc text := COALESCE(i->>'description', '');
  v_weight numeric;
  v_measures jsonb := perf_normalise_measures(i->'measures');
  cy perf_cycles;
  v_self boolean;
  v_plan uuid;
  v_id uuid := gen_random_uuid();
BEGIN
  IF COALESCE(i->>'level', 'individual') <> 'individual' THEN PERFORM work_fail('VALIDATION', 'Goals are set per person here.'); END IF;
  IF v_cycle IS NULL OR v_owner IS NULL OR NULLIF(i->>'weight', '') IS NULL THEN
    PERFORM work_fail('VALIDATION', 'A goal needs a review cycle, an owner and a weight.');
  END IF;
  IF char_length(v_title) NOT BETWEEN 1 AND 200 THEN PERFORM work_fail('VALIDATION', 'A goal needs a title of up to 200 characters.'); END IF;
  IF char_length(v_desc) > 4000 THEN PERFORM work_fail('VALIDATION', 'The details are too long.'); END IF;
  v_weight := perf_weight(i->>'weight');
  cy := perf_cycle_row(c, v_cycle);
  PERFORM perf_assert_goal_setting(cy, c.today, true);
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_owner AND tenant_id = c.tenant AND status = 'Active') THEN
    PERFORM work_fail('EMPLOYEE_INACTIVE', 'Goals can only be set for active employees.');
  END IF;
  v_self := v_owner = c.me;
  IF NOT v_self AND NOT perf_manages(c, v_owner) THEN PERFORM work_fail('FORBIDDEN', 'You can set goals for people in your team only.'); END IF;
  IF cy.launched_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM perf_participants WHERE cycle_id = v_cycle AND employee_id = v_owner AND status = 'included') THEN
    PERFORM work_fail('NOT_PARTICIPANT', 'This person is not part of this review cycle.');
  END IF;
  INSERT INTO perf_goal_plans (tenant_id, cycle_id, employee_id) VALUES (c.tenant, v_cycle, v_owner) ON CONFLICT (cycle_id, employee_id) DO NOTHING;
  SELECT id INTO v_plan FROM perf_goal_plans WHERE cycle_id = v_cycle AND employee_id = v_owner;
  INSERT INTO perf_goals (id, tenant_id, level, cycle_id, plan_id, owner_id, title, description, weight, status, origin, created_by, approved_at)
  VALUES (v_id, c.tenant, 'individual', v_cycle, v_plan, v_owner, v_title, v_desc, v_weight,
          CASE WHEN v_self THEN 'draft' ELSE 'active' END, CASE WHEN v_self THEN 'proposed' ELSE 'assigned' END, c.me,
          CASE WHEN v_self THEN NULL ELSE now() END);
  PERFORM perf_replace_measures(c.tenant, v_id, v_measures);
  PERFORM perf_refresh_progress(v_id);
  IF v_self THEN
    PERFORM perf_reopen_plan(v_plan);
  ELSE
    PERFORM perf_notify(c, ARRAY[v_owner], 'performance_goal', format('%s gave you a goal: %s', COALESCE(work_name(c.me), 'Your manager'), v_title), cy.name);
    PERFORM perf_open_reviews(v_cycle, v_owner);
  END IF;
  RETURN v_id;
END;
$$;

-- Title, details, weight and/or measures. A proposal is edited by its owner; an approved goal by the
-- owner's manager (at once) or by the owner (kept as a pending change until the plan is approved again).
CREATE OR REPLACE FUNCTION perf_goal_edit(c work_ctx, p_id uuid, p_version text, i jsonb, p_measures jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  g perf_goals := perf_goal_row(c, p_id, true, p_version);
  cy perf_cycles;
  pl perf_goal_plans;
  v_self boolean := g.owner_id IS NOT DISTINCT FROM c.me;
  v_title text := CASE WHEN i ? 'title' THEN btrim(COALESCE(i->>'title', '')) ELSE g.title END;
  v_desc text := CASE WHEN i ? 'description' THEN COALESCE(i->>'description', '') ELSE g.description END;
  v_weight numeric := CASE WHEN i ? 'weight' THEN perf_weight(i->>'weight') ELSE g.weight END;
  v_measures jsonb := CASE WHEN p_measures IS NULL THEN NULL ELSE perf_normalise_measures(p_measures) END;
  v_pc jsonb;
BEGIN
  SELECT * INTO cy FROM perf_cycles WHERE id = g.cycle_id;
  IF g.status IN ('archived','rejected') THEN PERFORM work_fail('GOAL_FINAL', format('A %s goal cannot be changed.', g.status)); END IF;
  IF g.status = 'pending_approval' THEN PERFORM work_fail('GOAL_IN_REVIEW', 'This goal is waiting for approval.'); END IF;
  IF char_length(v_title) NOT BETWEEN 1 AND 200 THEN PERFORM work_fail('VALIDATION', 'A goal needs a title of up to 200 characters.'); END IF;
  IF char_length(v_desc) > 4000 THEN PERFORM work_fail('VALIDATION', 'The details are too long.'); END IF;
  PERFORM perf_assert_goal_setting(cy, c.today, false);

  IF g.status IN ('draft','returned') AND NOT v_self THEN
    PERFORM work_fail('PROPOSAL_OWNED_BY_EMPLOYEE', 'Only the employee edits their proposal; send it back with a comment instead.');
  END IF;
  IF g.status IN ('draft','returned') OR perf_manages(c, g.owner_id) THEN
    UPDATE perf_goals SET title = v_title, description = v_desc, weight = v_weight WHERE id = p_id;
    IF v_measures IS NOT NULL THEN
      PERFORM perf_replace_measures(c.tenant, p_id, v_measures);
      PERFORM perf_refresh_progress(p_id);
    END IF;
    IF g.status IN ('active','completed') THEN PERFORM perf_open_reviews(g.cycle_id, g.owner_id); END IF;
    RETURN;
  END IF;

  -- The owner changing an approved goal: a proposal, applied when the plan is approved again.
  SELECT * INTO pl FROM perf_goal_plans WHERE id = g.plan_id FOR UPDATE;
  IF pl.status = 'submitted' THEN PERFORM work_fail('PLAN_IN_REVIEW', 'Your goal plan is waiting for approval. Wait for the decision first.'); END IF;
  v_pc := COALESCE(g.pending_change, '{}'::jsonb);
  IF i ? 'title' THEN v_pc := v_pc || jsonb_build_object('title', v_title); END IF;
  IF i ? 'description' THEN v_pc := v_pc || jsonb_build_object('description', v_desc); END IF;
  IF i ? 'weight' THEN v_pc := v_pc || jsonb_build_object('weight', v_weight); END IF;
  IF v_measures IS NOT NULL THEN v_pc := v_pc || jsonb_build_object('measures', v_measures); END IF;
  UPDATE perf_goals SET pending_change = v_pc WHERE id = p_id;
  PERFORM perf_reopen_plan(pl.id);
END;
$$;

CREATE OR REPLACE FUNCTION perf_goal_archive(c work_ctx, p_id uuid, p_version text, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  g perf_goals := perf_goal_row(c, p_id, true, p_version);
  cy perf_cycles;
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_state text;
BEGIN
  SELECT * INTO cy FROM perf_cycles WHERE id = g.cycle_id;
  v_state := perf_cycle_state(cy, c.today);
  IF g.status NOT IN ('draft','returned','active','completed') THEN
    PERFORM work_fail('GOAL_NOT_ARCHIVABLE', format('A %s goal cannot be removed.', replace(g.status, '_', ' ')));
  END IF;
  IF v_state = 'closed' THEN PERFORM work_fail('CYCLE_CLOSED', 'The review cycle is closed.'); END IF;
  IF g.status IN ('draft','returned') THEN
    IF NOT (g.owner_id IS NOT DISTINCT FROM c.me OR perf_manages(c, g.owner_id)) THEN PERFORM work_fail('FORBIDDEN', 'You cannot remove this goal.'); END IF;
  ELSE
    IF char_length(v_reason) < 3 THEN PERFORM work_fail('VALIDATION', 'A reason is required to remove an approved goal.'); END IF;
    IF v_state = 'frozen' THEN
      IF NOT c.overseer THEN PERFORM work_fail('FORBIDDEN', 'After the freeze date only HR can remove goals.'); END IF;
    ELSIF NOT perf_manages(c, g.owner_id) THEN
      PERFORM work_fail('FORBIDDEN', 'Only your manager can remove an approved goal.');
    END IF;
  END IF;
  UPDATE perf_goals SET status = 'archived', archived_at = now(), archive_reason = NULLIF(left(v_reason, 500), ''), pending_change = NULL WHERE id = p_id;
  PERFORM perf_open_reviews(g.cycle_id, g.owner_id);
END;
$$;

CREATE OR REPLACE FUNCTION perf_goal_checkin(c work_ctx, p_goal uuid, i jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  g perf_goals := perf_goal_row(c, p_goal, true);
  cy perf_cycles;
  m perf_goal_measures;
  v_note text := COALESCE(i->>'note', '');
  v_value numeric;
  v_done boolean;
  v_progress numeric;
  v_id uuid;
BEGIN
  SELECT * INTO cy FROM perf_cycles WHERE id = g.cycle_id;
  IF g.status <> 'active' THEN PERFORM work_fail('GOAL_NOT_ACTIVE', 'Progress can only be recorded on an active goal.'); END IF;
  IF perf_cycle_state(cy, c.today) = 'closed' THEN PERFORM work_fail('CYCLE_CLOSED', 'The review cycle is closed.'); END IF;
  IF char_length(v_note) > 2000 THEN PERFORM work_fail('VALIDATION', 'The note is too long.'); END IF;
  SELECT * INTO m FROM perf_goal_measures WHERE id = work_uuid(i->>'measureId') AND goal_id = g.id AND archived_at IS NULL FOR UPDATE;
  IF m.id IS NULL THEN PERFORM work_fail('NOT_FOUND', 'Measure not found.'); END IF;
  IF m.kind IN ('numeric','percentage') THEN
    IF COALESCE(i->>'value', '') !~ '^-?\d{1,12}(\.\d{1,2})?$' THEN PERFORM work_fail('VALIDATION', 'Enter where it stands now, as a number.'); END IF;
    v_value := (i->>'value')::numeric;
    IF m.kind = 'percentage' AND v_value NOT BETWEEN 0 AND 100 THEN PERFORM work_fail('VALIDATION', 'A percentage must be between 0 and 100.'); END IF;
    UPDATE perf_goal_measures SET current_value = v_value WHERE id = m.id;
  ELSIF m.kind = 'milestone' THEN
    IF NOT (i ? 'isDone') OR i->>'isDone' IS NULL THEN PERFORM work_fail('VALIDATION', 'A milestone takes done or not done.'); END IF;
    v_done := (i->>'isDone')::boolean;
    UPDATE perf_goal_measures SET is_done = v_done WHERE id = m.id;
  ELSIF btrim(v_note) = '' THEN
    PERFORM work_fail('VALIDATION', 'A judgement measure takes a note.');
  END IF;
  v_progress := perf_refresh_progress(g.id);
  INSERT INTO perf_goal_checkins (tenant_id, goal_id, measure_id, value, is_done, note, progress_after, author_id)
  VALUES (c.tenant, g.id, m.id, v_value, v_done, v_note, v_progress, c.me) RETURNING id INTO v_id;
  RETURN jsonb_build_object('checkinId', v_id, 'progressPercent', v_progress::text);
END;
$$;

CREATE OR REPLACE FUNCTION perf_goal_checkins(c work_ctx, p_goal uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  g perf_goals := perf_goal_row(c, p_goal);
BEGIN
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('id', x.id, 'measureId', x.measure_id, 'value', x.value::text, 'isDone', x.is_done, 'note', x.note,
                            'progressAfter', x.progress_after::text, 'authorEmployeeId', x.author_id, 'createdAt', work_iso(x.created_at))
                            ORDER BY x.created_at DESC, x.id DESC)
                   FROM (SELECT * FROM perf_goal_checkins WHERE goal_id = g.id ORDER BY created_at DESC LIMIT 500) x), '[]'::jsonb);
END;
$$;

-- ── 11. Goal plan: send for approval, decide ──────────────────────────────
CREATE OR REPLACE FUNCTION perf_plan_submit(c work_ctx, p_cycle uuid, p_employee uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cy perf_cycles := perf_cycle_row(c, p_cycle);
  pl perf_goal_plans;
  v_state text := perf_cycle_state(cy, c.today);
  v_total numeric;
  v_approver uuid;
  n int;
BEGIN
  IF p_employee IS DISTINCT FROM c.me THEN PERFORM work_fail('FORBIDDEN', 'Only the employee submits their own goal plan.'); END IF;
  SELECT * INTO pl FROM perf_goal_plans WHERE cycle_id = p_cycle AND employee_id = p_employee FOR UPDATE;
  IF pl.id IS NULL THEN PERFORM work_fail('NOTHING_TO_SUBMIT', 'There are no goals to submit.'); END IF;
  IF pl.status = 'submitted' THEN PERFORM work_fail('PLAN_IN_REVIEW', 'This goal plan is already waiting for approval.'); END IF;
  IF v_state = 'closed' THEN PERFORM work_fail('CYCLE_CLOSED', 'The review cycle is closed.'); END IF;
  IF v_state = 'frozen' THEN PERFORM work_fail('GOALS_FROZEN', 'Goal setting for this cycle is frozen.'); END IF;
  IF v_state <> 'open' THEN PERFORM work_fail('CYCLE_NOT_OPEN', 'Goal setting has not started for this cycle.'); END IF;
  SELECT count(*) INTO n FROM perf_goals
   WHERE plan_id = pl.id AND (status IN ('draft','returned') OR (status IN ('active','completed') AND pending_change IS NOT NULL));
  IF n = 0 THEN PERFORM work_fail('NOTHING_TO_SUBMIT', 'There are no new or changed goals to submit.'); END IF;
  v_total := perf_plan_total(pl.id);
  IF perf_weights_rule(cy) <> 'equal' AND abs(v_total - 100) > 0.01 THEN
    PERFORM work_fail('WEIGHTS_NOT_100', format('Goal weights total %s %%; they must total 100 %%.', to_char(v_total, 'FM990.00')));
  END IF;
  UPDATE perf_goals SET status = 'pending_approval', proposed_submitted_at = COALESCE(proposed_submitted_at, now())
   WHERE plan_id = pl.id AND status IN ('draft','returned');
  UPDATE perf_goals SET change_submitted_at = COALESCE(change_submitted_at, now())
   WHERE plan_id = pl.id AND status IN ('active','completed') AND pending_change IS NOT NULL;
  v_approver := perf_manager_of(p_employee);
  UPDATE perf_goal_plans SET status = 'submitted', submission_no = submission_no + 1, submitted_at = now(), decided_at = NULL,
         decided_by = NULL, decision_comment = NULL, approver_id = v_approver WHERE id = pl.id;
  -- The reporting manager decides; with no manager, HR does.
  PERFORM perf_notify(c, CASE WHEN v_approver IS NOT NULL THEN ARRAY[v_approver] ELSE perf_hr_ids(c.tenant) END, 'performance_goal_plan',
    format('%s sent their goal plan for approval', COALESCE(work_name(c.me), 'Someone')), cy.name);
END;
$$;

-- approve — the proposals become active and pending changes are applied;
-- return  — back to the employee with a comment (they edit and send it again);
-- reject  — the proposals are rejected (final), pending changes are dropped.
CREATE OR REPLACE FUNCTION perf_plan_decide(c work_ctx, p_cycle uuid, p_employee uuid, p_action text, p_comment text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cy perf_cycles := perf_cycle_row(c, p_cycle);
  pl perf_goal_plans;
  g perf_goals;
  v_comment text := NULLIF(btrim(COALESCE(p_comment, '')), '');
  v_who text := COALESCE(work_name(c.me), 'Your manager');
BEGIN
  IF NOT perf_manages(c, p_employee) THEN PERFORM work_fail('NOT_FOUND', 'Goal plan not found.'); END IF;
  SELECT * INTO pl FROM perf_goal_plans WHERE cycle_id = p_cycle AND employee_id = p_employee FOR UPDATE;
  IF pl.id IS NULL THEN PERFORM work_fail('NOT_FOUND', 'Goal plan not found.'); END IF;
  IF pl.status <> 'submitted' THEN PERFORM work_fail('PLAN_NOT_SUBMITTED', 'This goal plan is not waiting for approval.'); END IF;
  IF p_action IS NULL OR p_action NOT IN ('approve','return','reject') THEN PERFORM work_fail('VALIDATION', 'Unknown decision.'); END IF;
  IF perf_cycle_state(cy, c.today) = 'closed' THEN PERFORM work_fail('CYCLE_CLOSED', 'The review cycle is closed.'); END IF;
  IF v_comment IS NOT NULL AND char_length(v_comment) > 2000 THEN PERFORM work_fail('VALIDATION', 'The comment is too long.'); END IF;
  IF p_action <> 'approve' AND v_comment IS NULL THEN
    PERFORM work_fail('REASON_REQUIRED', CASE WHEN p_action = 'return' THEN 'Say what should change before you send it back.' ELSE 'Say why the plan is rejected.' END);
  END IF;

  IF p_action = 'approve' THEN
    UPDATE perf_goals SET status = 'active', approved_at = now() WHERE plan_id = pl.id AND status = 'pending_approval';
    FOR g IN SELECT * FROM perf_goals WHERE plan_id = pl.id AND status IN ('active','completed') AND pending_change IS NOT NULL LOOP
      -- A change sent in after goal setting ended can no longer be approved.
      IF perf_cycle_state(cy, c.today) = 'frozen'
         AND NOT (g.change_submitted_at IS NOT NULL AND (g.change_submitted_at AT TIME ZONE 'Asia/Kolkata')::date <= cy.goal_freeze_date) THEN
        PERFORM work_fail('GOALS_FROZEN', 'This change was submitted after the freeze date and can no longer be approved.');
      END IF;
      IF g.pending_change ? 'measures' THEN PERFORM perf_replace_measures(c.tenant, g.id, g.pending_change->'measures'); END IF;
      UPDATE perf_goals SET title = COALESCE(g.pending_change->>'title', title), description = COALESCE(g.pending_change->>'description', description),
             weight = COALESCE((g.pending_change->>'weight')::numeric, weight), pending_change = NULL, change_submitted_at = NULL, approved_at = now()
       WHERE id = g.id;
      PERFORM perf_refresh_progress(g.id);
    END LOOP;
    UPDATE perf_goal_plans SET status = 'approved', decided_at = now(), decided_by = c.me, decision_comment = v_comment WHERE id = pl.id;
    PERFORM perf_notify(c, ARRAY[p_employee], 'performance_goal_plan', format('%s approved your goal plan', v_who), cy.name);
    PERFORM perf_open_reviews(p_cycle, p_employee);
  ELSIF p_action = 'return' THEN
    UPDATE perf_goals SET status = 'returned' WHERE plan_id = pl.id AND status = 'pending_approval';
    UPDATE perf_goal_plans SET status = 'returned', decided_at = now(), decided_by = c.me, decision_comment = v_comment WHERE id = pl.id;
    PERFORM perf_notify(c, ARRAY[p_employee], 'performance_goal_plan', format('%s sent your goal plan back', v_who), left(v_comment, 300));
  ELSE
    UPDATE perf_goals SET status = 'rejected', pending_change = NULL, change_submitted_at = NULL WHERE plan_id = pl.id AND status IN ('pending_approval','returned');
    UPDATE perf_goals SET pending_change = NULL, change_submitted_at = NULL WHERE plan_id = pl.id AND status IN ('active','completed') AND pending_change IS NOT NULL;
    UPDATE perf_goal_plans SET status = 'rejected', decided_at = now(), decided_by = c.me, decision_comment = v_comment WHERE id = pl.id;
    PERFORM perf_notify(c, ARRAY[p_employee], 'performance_goal_plan', format('%s rejected your goal plan', v_who), left(v_comment, 300));
  END IF;
END;
$$;

-- ── 12. Review cycles (HR) ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION perf_cycles_list(c work_ctx, p_deleted boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM perf_seed_tenant(c.tenant);
  IF p_deleted THEN PERFORM perf_assert_hr(c); END IF;
  RETURN COALESCE((SELECT jsonb_agg(perf_cycle_json(cy) ORDER BY cy.start_date DESC, cy.id DESC)
                   FROM perf_cycles cy
                   WHERE cy.tenant_id = c.tenant
                     AND CASE WHEN p_deleted THEN cy.deleted_at IS NOT NULL ELSE cy.deleted_at IS NULL AND cy.status <> 'archived' END
                     -- A draft cycle is HR's until it is opened.
                     AND (c.overseer OR cy.status <> 'draft')), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION perf_check_cycle_dates(p_start date, p_end date, p_freeze date, p_self date, p_manager date)
RETURNS void LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF p_start IS NULL OR p_end IS NULL THEN PERFORM work_fail('VALIDATION', 'A cycle needs a start and an end date.'); END IF;
  IF p_start > p_end THEN PERFORM work_fail('VALIDATION', 'The end date must be on or after the start date.'); END IF;
  IF p_freeze IS NOT NULL AND p_freeze NOT BETWEEN p_start AND p_end THEN PERFORM work_fail('VALIDATION', 'The freeze date must fall within the cycle.'); END IF;
  IF (p_self IS NOT NULL AND p_self NOT BETWEEN p_start AND p_end) OR (p_manager IS NOT NULL AND p_manager NOT BETWEEN p_start AND p_end) THEN
    PERFORM work_fail('VALIDATION', 'The due date must fall within the cycle.');
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION perf_active_template(c work_ctx, p_id uuid)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_status text;
BEGIN
  SELECT status INTO v_status FROM perf_templates WHERE id = p_id AND tenant_id = c.tenant;
  IF v_status IS NULL THEN PERFORM work_fail('REFERENCE_NOT_FOUND', 'The review form does not exist.'); END IF;
  IF v_status <> 'active' THEN PERFORM work_fail('TEMPLATE_NOT_ACTIVE', 'A cycle needs an active review form.'); END IF;
  RETURN p_id;
END;
$$;

CREATE OR REPLACE FUNCTION perf_cycle_create(c work_ctx, i jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_name text := btrim(COALESCE(i->>'name', ''));
  v_type text := i->>'type';
  v_start date := work_date(i->>'startDate', 'start date');
  v_end date := work_date(i->>'endDate', 'end date');
  v_freeze date := work_date(i->>'goalFreezeDate', 'freeze date');
  v_template uuid;
  v_id uuid;
BEGIN
  PERFORM perf_assert_hr(c);
  PERFORM perf_seed_tenant(c.tenant);
  IF char_length(v_name) NOT BETWEEN 1 AND 120 THEN PERFORM work_fail('VALIDATION', 'A cycle needs a name of up to 120 characters.'); END IF;
  IF v_type IS NULL OR v_type NOT IN ('annual','half_yearly','quarterly','probation') THEN PERFORM work_fail('VALIDATION', 'Unknown cycle type.'); END IF;
  PERFORM perf_check_cycle_dates(v_start, v_end, v_freeze, NULL, NULL);
  v_template := perf_active_template(c, COALESCE(work_uuid(i->>'templateId'),
                  (SELECT id FROM perf_templates WHERE tenant_id = c.tenant AND status = 'active' ORDER BY (seed_key = 'default.template') DESC NULLS LAST, created_at LIMIT 1)));
  BEGIN
    INSERT INTO perf_cycles (tenant_id, name, type, start_date, end_date, template_id, goal_freeze_date, created_by)
    VALUES (c.tenant, v_name, v_type, v_start, v_end, v_template, v_freeze, c.me) RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    PERFORM work_fail('CONFLICT', 'A review cycle with this name already exists.');
  END;
  RETURN v_id;
END;
$$;

-- Draft: everything. Open: name, end date, freeze date and review due dates. Closed: nothing.
CREATE OR REPLACE FUNCTION perf_cycle_update(c work_ctx, p_id uuid, p_version text, i jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cy perf_cycles;
  n_name text; n_type text; n_start date; n_end date; n_template uuid; n_freeze date; n_self date; n_manager date;
BEGIN
  PERFORM perf_assert_hr(c);
  cy := perf_cycle_row(c, p_id, true, p_version);
  IF cy.status IN ('closed','archived') THEN PERFORM work_fail('CYCLE_CLOSED', 'A closed cycle cannot be edited.'); END IF;
  n_name := CASE WHEN i ? 'name' THEN btrim(COALESCE(i->>'name', '')) ELSE cy.name END;
  n_type := COALESCE(i->>'type', cy.type);
  n_start := COALESCE(work_date(i->>'startDate', 'start date'), cy.start_date);
  n_end := COALESCE(work_date(i->>'endDate', 'end date'), cy.end_date);
  n_template := COALESCE(work_uuid(i->>'templateId'), cy.template_id);
  n_freeze := CASE WHEN i ? 'goalFreezeDate' THEN work_date(i->>'goalFreezeDate', 'freeze date') ELSE cy.goal_freeze_date END;
  n_self := CASE WHEN i ? 'selfReviewDue' THEN work_date(i->>'selfReviewDue', 'self-review due date') ELSE cy.self_review_due END;
  n_manager := CASE WHEN i ? 'managerReviewDue' THEN work_date(i->>'managerReviewDue', 'manager review due date') ELSE cy.manager_review_due END;
  IF cy.status = 'open' AND (n_template <> cy.template_id OR n_type <> cy.type OR n_start <> cy.start_date) THEN
    PERFORM work_fail('CYCLE_OPEN', 'The review form, type and start date of an open cycle cannot change.');
  END IF;
  IF char_length(n_name) NOT BETWEEN 1 AND 120 THEN PERFORM work_fail('VALIDATION', 'A cycle needs a name of up to 120 characters.'); END IF;
  IF n_type NOT IN ('annual','half_yearly','quarterly','probation') THEN PERFORM work_fail('VALIDATION', 'Unknown cycle type.'); END IF;
  PERFORM perf_check_cycle_dates(n_start, n_end, n_freeze, n_self, n_manager);
  IF cy.phase IN ('reviews_closed','results') AND (n_self IS DISTINCT FROM cy.self_review_due OR n_manager IS DISTINCT FROM cy.manager_review_due) THEN
    PERFORM work_fail('REVIEWS_CLOSED', 'Reviews are closed for this cycle.');
  END IF;
  IF n_template <> cy.template_id THEN PERFORM perf_active_template(c, n_template); END IF;
  BEGIN
    UPDATE perf_cycles SET name = n_name, type = n_type, start_date = n_start, end_date = n_end, template_id = n_template,
           goal_freeze_date = n_freeze, self_review_due = n_self, manager_review_due = n_manager WHERE id = p_id;
  EXCEPTION WHEN unique_violation THEN
    PERFORM work_fail('CONFLICT', 'A review cycle with this name already exists.');
  END;
END;
$$;

-- Opens goal setting; the review form is locked from now on.
CREATE OR REPLACE FUNCTION perf_cycle_open(c work_ctx, p_id uuid, p_version text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cy perf_cycles;
BEGIN
  PERFORM perf_assert_hr(c);
  cy := perf_cycle_row(c, p_id, true, p_version);
  IF cy.status <> 'draft' THEN PERFORM work_fail('NOT_DRAFT', format('Only a draft cycle can be opened (this one is %s).', cy.status)); END IF;
  PERFORM perf_active_template(c, cy.template_id);
  UPDATE perf_templates SET first_used_at = COALESCE(first_used_at, now()) WHERE id = cy.template_id;
  UPDATE perf_cycles SET status = 'open', opened_at = now() WHERE id = p_id;
END;
$$;

-- Closing makes the cycle's goals and progress read-only.
CREATE OR REPLACE FUNCTION perf_cycle_close(c work_ctx, p_id uuid, p_version text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cy perf_cycles;
BEGIN
  PERFORM perf_assert_hr(c);
  cy := perf_cycle_row(c, p_id, true, p_version);
  IF cy.status <> 'open' THEN PERFORM work_fail('NOT_OPEN', format('Only an open cycle can be closed (this one is %s).', cy.status)); END IF;
  IF EXISTS (SELECT 1 FROM perf_goal_plans WHERE cycle_id = p_id AND status = 'submitted') THEN
    PERFORM work_fail('PLANS_PENDING', 'Some goal plans are still waiting for approval. Decide them before closing the cycle.');
  END IF;
  UPDATE perf_cycles SET status = 'closed', closed_at = now() WHERE id = p_id;
END;
$$;

-- Delete = archive + hide; nothing is erased and HR can restore it. The name is free again.
CREATE OR REPLACE FUNCTION perf_cycle_delete(c work_ctx, p_id uuid, p_version text, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cy perf_cycles;
  v_reason text := btrim(COALESCE(p_reason, ''));
BEGIN
  PERFORM perf_assert_hr(c);
  IF char_length(v_reason) NOT BETWEEN 4 AND 500 THEN PERFORM work_fail('VALIDATION', 'Say why the cycle is deleted (4–500 characters).'); END IF;
  cy := perf_cycle_row(c, p_id, true, p_version, true);
  IF cy.deleted_at IS NOT NULL THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM perf_goal_plans WHERE cycle_id = p_id AND status = 'submitted') THEN
    PERFORM work_fail('PLANS_PENDING', 'Some goal plans in this cycle are waiting for approval. Approve or return them first, then delete the cycle.');
  END IF;
  UPDATE perf_cycles SET status = 'archived', deleted_at = now(), deleted_by = c.me, delete_reason = v_reason, deleted_from_status = cy.status WHERE id = p_id;
END;
$$;

-- Brings a deleted cycle back, to exactly the status it had.
CREATE OR REPLACE FUNCTION perf_cycle_restore(c work_ctx, p_id uuid, p_version text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cy perf_cycles;
BEGIN
  PERFORM perf_assert_hr(c);
  cy := perf_cycle_row(c, p_id, true, p_version, true);
  IF cy.deleted_at IS NULL THEN PERFORM work_fail('NOT_DELETED', 'This cycle is not deleted.'); END IF;
  BEGIN
    UPDATE perf_cycles SET status = cy.deleted_from_status, deleted_at = NULL, deleted_by = NULL, delete_reason = NULL, deleted_from_status = NULL WHERE id = p_id;
  EXCEPTION WHEN unique_violation THEN
    PERFORM work_fail('CONFLICT', 'A review cycle with this name already exists. Rename that one first.');
  END;
END;
$$;

-- Everyone who would join: active employees, minus those already in another overlapping cycle of the same type.
CREATE OR REPLACE FUNCTION perf_candidates(c work_ctx, cy perf_cycles)
RETURNS TABLE (employee_id uuid, name text, overlap_cycle text, participant_status text, has_plan boolean, active boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT e.id, COALESCE(work_name(e.id), e.email),
         (SELECT oc.name FROM perf_participants op JOIN perf_cycles oc ON oc.id = op.cycle_id
           WHERE op.employee_id = e.id AND op.cycle_id <> cy.id AND op.status = 'included' AND oc.type = cy.type
             AND oc.status NOT IN ('closed','archived') AND oc.start_date <= cy.end_date AND cy.start_date <= oc.end_date LIMIT 1),
         (SELECT p.status FROM perf_participants p WHERE p.cycle_id = cy.id AND p.employee_id = e.id),
         EXISTS (SELECT 1 FROM perf_goal_plans gp WHERE gp.cycle_id = cy.id AND gp.employee_id = e.id),
         e.status = 'Active'
  FROM profiles e
  WHERE e.tenant_id = c.tenant AND e.role <> 'superadmin'
    AND (e.status = 'Active' OR EXISTS (SELECT 1 FROM perf_goal_plans gp WHERE gp.cycle_id = cy.id AND gp.employee_id = e.id));
$$;

CREATE OR REPLACE FUNCTION perf_cycle_preview(c work_ctx, p_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cy perf_cycles;
BEGIN
  PERFORM perf_assert_hr(c);
  cy := perf_cycle_row(c, p_id);
  RETURN (SELECT jsonb_build_object(
    'eligible', COALESCE(jsonb_agg(jsonb_build_object('employeeId', x.employee_id, 'name', x.name, 'source', 'rule',
                         'alreadyIncluded', x.participant_status = 'included') ORDER BY x.name) FILTER (WHERE x.active AND x.overlap_cycle IS NULL), '[]'::jsonb),
    'conflicts', COALESCE(jsonb_agg(jsonb_build_object('employeeId', x.employee_id, 'name', x.name, 'cycleName', x.overlap_cycle) ORDER BY x.name)
                          FILTER (WHERE x.active AND x.overlap_cycle IS NOT NULL), '[]'::jsonb),
    'ineligible', COALESCE(jsonb_agg(jsonb_build_object('employeeId', x.employee_id, 'name', x.name, 'reasons', jsonb_build_array('INACTIVE')) ORDER BY x.name)
                           FILTER (WHERE NOT x.active), '[]'::jsonb))
  FROM perf_candidates(c, cy) x);
END;
$$;

-- Adds every eligible employee; skips and reports overlaps. Re-runnable (late joiners).
CREATE OR REPLACE FUNCTION perf_cycle_launch(c work_ctx, p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cy perf_cycles;
  v_added int;
  v_already int;
  v_skipped jsonb;
BEGIN
  PERFORM perf_assert_hr(c);
  cy := perf_cycle_row(c, p_id, true);
  IF cy.status <> 'open' THEN PERFORM work_fail('CYCLE_NOT_OPEN', 'Open the cycle before adding participants.'); END IF;
  IF cy.phase IN ('reviews_closed','results') THEN PERFORM work_fail('REVIEWS_CLOSED', 'Reviews are closed for this cycle.'); END IF;
  SELECT count(*) FILTER (WHERE x.participant_status = 'included'),
         COALESCE(jsonb_agg(jsonb_build_object('employeeId', x.employee_id, 'name', x.name, 'cycleName', x.overlap_cycle))
                  FILTER (WHERE x.active AND x.overlap_cycle IS NOT NULL), '[]'::jsonb)
    INTO v_already, v_skipped
  FROM perf_candidates(c, cy) x;
  WITH ins AS (
    INSERT INTO perf_participants (tenant_id, cycle_id, employee_id, status, source, manager_id, department, designation, date_of_joining, changed_by)
    SELECT c.tenant, p_id, x.employee_id, 'included', 'rule', perf_manager_of(x.employee_id), e.department, e.designation, e.join_date, c.me
    FROM perf_candidates(c, cy) x JOIN profiles e ON e.id = x.employee_id
    WHERE x.active AND x.overlap_cycle IS NULL AND x.participant_status IS NULL
    ON CONFLICT (cycle_id, employee_id) DO NOTHING
    RETURNING 1)
  SELECT count(*) INTO v_added FROM ins;
  IF cy.launched_at IS NULL THEN UPDATE perf_cycles SET launched_at = now() WHERE id = p_id; END IF;
  PERFORM perf_open_reviews(p_id);
  RETURN jsonb_build_object('added', v_added, 'alreadyIncluded', v_already, 'skipped', v_skipped);
END;
$$;

-- Moves to the next stage: goal setting → self review → manager review → calibration → results.
CREATE OR REPLACE FUNCTION perf_cycle_advance(c work_ctx, p_id uuid, p_version text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cy perf_cycles;
  t perf_templates;
  v_next text;
  v_freeze date;
BEGIN
  PERFORM perf_assert_hr(c);
  cy := perf_cycle_row(c, p_id, true, p_version);
  IF cy.status <> 'open' THEN PERFORM work_fail('CYCLE_NOT_OPEN', 'The cycle is not open.'); END IF;
  IF cy.launched_at IS NULL THEN PERFORM work_fail('NOT_LAUNCHED', 'Add participants before starting reviews.'); END IF;
  t := perf_template_of(cy);
  v_next := CASE cy.phase WHEN 'goal_setting' THEN CASE WHEN COALESCE((t.steps->>'selfReview')::boolean, true) THEN 'self_review' ELSE 'manager_review' END
                          WHEN 'self_review' THEN 'manager_review' WHEN 'manager_review' THEN 'reviews_closed' WHEN 'reviews_closed' THEN 'results' END;
  IF v_next IS NULL THEN PERFORM work_fail('LAST_PHASE', 'The cycle is in its last stage. Close the cycle when results are done.'); END IF;
  v_freeze := cy.goal_freeze_date;
  IF cy.phase = 'goal_setting' AND (cy.goal_freeze_date IS NULL OR cy.goal_freeze_date >= c.today) THEN
    -- Goals are fixed for the review: goal setting ends yesterday (never before the cycle starts).
    v_freeze := LEAST(GREATEST(c.today - 1, cy.start_date), cy.end_date);
  END IF;
  IF v_next = 'manager_review' THEN
    -- The manager may now review without a submitted self review; those reviews are marked.
    UPDATE perf_reviews SET self_not_submitted = true WHERE cycle_id = p_id AND status IN ('not_started','self_in_progress');
  END IF;
  UPDATE perf_cycles SET phase = v_next, phase_locked = false, goal_freeze_date = v_freeze WHERE id = p_id;
  PERFORM perf_open_reviews(p_id);
  IF v_next = 'manager_review' THEN
    PERFORM perf_notify(c, ARRAY(SELECT DISTINCT reviewer_id FROM perf_reviews WHERE cycle_id = p_id AND status NOT IN ('void','blocked') AND reviewer_id IS NOT NULL),
                        'performance_review', 'Manager review: ' || cy.name, 'Write the reviews of your team.');
  END IF;
END;
$$;

-- Soft deadlines: HR may lock the current review stage (no more edits) and unlock it again.
CREATE OR REPLACE FUNCTION perf_cycle_lock_phase(c work_ctx, p_id uuid, p_version text, p_locked boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cy perf_cycles;
BEGIN
  PERFORM perf_assert_hr(c);
  cy := perf_cycle_row(c, p_id, true, p_version);
  IF cy.phase NOT IN ('self_review','manager_review') THEN PERFORM work_fail('NOT_REVIEW_PHASE', 'Only a review stage can be locked.'); END IF;
  UPDATE perf_cycles SET phase_locked = COALESCE(p_locked, true) WHERE id = p_id;
END;
$$;

-- ── 13. Reviews: read ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION perf_review_summary(r perf_reviews, p_name boolean)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object('id', r.id, 'cycleId', r.cycle_id, 'employeeId', r.employee_id,
    'employeeName', CASE WHEN p_name THEN COALESCE(work_name(r.employee_id), 'Employee') END,
    'reviewerEmployeeId', r.reviewer_id, 'status', r.status, 'blockedReason', r.blocked_reason, 'selfNotSubmitted', r.self_not_submitted,
    'openedAt', work_iso(r.opened_at), 'selfSubmittedAt', work_iso(r.self_submitted_at), 'managerSubmittedAt', work_iso(r.manager_submitted_at));
$$;

-- Who is looking: the reviewee first (even HR, for their own review), then the reviewer, then HR, then a manager up the chain.
CREATE OR REPLACE FUNCTION perf_viewer(c work_ctx, r perf_reviews)
RETURNS text LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF r.employee_id = c.me THEN RETURN 'reviewee'; END IF;
  IF r.reviewer_id IS NOT DISTINCT FROM c.me THEN RETURN 'reviewer'; END IF;
  IF c.overseer THEN RETURN 'hr'; END IF;
  IF r.employee_id = ANY (c.team) THEN RETURN 'overseer'; END IF;
  PERFORM work_fail('NOT_FOUND', 'Review not found.');
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION perf_review_row(c work_ctx, p_id uuid, p_lock boolean DEFAULT false)
RETURNS perf_reviews LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r perf_reviews;
BEGIN
  IF p_lock THEN PERFORM 1 FROM perf_reviews WHERE id = p_id FOR UPDATE; END IF;
  SELECT x.* INTO r FROM perf_reviews x JOIN perf_cycles cy ON cy.id = x.cycle_id AND cy.deleted_at IS NULL
   WHERE x.id = p_id AND x.tenant_id = c.tenant;
  IF r.id IS NULL THEN PERFORM work_fail('NOT_FOUND', 'Review not found.'); END IF;
  PERFORM perf_viewer(c, r);
  RETURN r;
END;
$$;

CREATE OR REPLACE FUNCTION perf_can_write_self(cy perf_cycles, r perf_reviews)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT cy.status = 'open' AND cy.phase = 'self_review' AND NOT cy.phase_locked AND r.status IN ('not_started','self_in_progress');
$$;
CREATE OR REPLACE FUNCTION perf_can_write_manager(cy perf_cycles, r perf_reviews)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT cy.status = 'open' AND r.status IN ('not_started','self_in_progress','self_submitted','manager_in_progress')
     AND CASE WHEN cy.phase IN ('reviews_closed','results') THEN r.reopened_at IS NOT NULL AND r.manager_submitted_at IS NULL
              ELSE cy.phase = 'manager_review' AND NOT cy.phase_locked END;
$$;

CREATE OR REPLACE FUNCTION perf_pack(p_review uuid, p_role text, p_author uuid, p_full boolean)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'authorEmployeeId', p_author,
    'ratings', COALESCE((SELECT jsonb_agg(jsonb_build_object('itemId', x.review_item_id, 'levelId', x.level_id, 'notApplicable', x.not_applicable, 'comment', x.comment))
                         FROM perf_review_ratings x WHERE x.review_id = p_review AND x.rater_role = p_role AND x.author_id = p_author), '[]'::jsonb),
    'summary', (SELECT jsonb_build_object('comment', s.comment,
                         -- The employee never sees the manager's proposed overall level or the override.
                         'overallLevelId', CASE WHEN p_full THEN s.overall_level_id END,
                         'override', CASE WHEN p_full AND s.override_level_id IS NOT NULL
                                          THEN jsonb_build_object('levelId', s.override_level_id, 'reason', COALESCE(s.override_reason, '')) END)
                FROM perf_review_summaries s WHERE s.review_id = p_review AND s.rater_role = p_role AND s.author_id = p_author));
$$;

CREATE OR REPLACE FUNCTION perf_result_json(o perf_review_outcomes, p_reviewee boolean, p_ack_required boolean)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'outcomeId', o.id, 'versionNo', o.version_no,
    'finalLevel', (SELECT jsonb_build_object('id', l.id, 'label', l.label, 'description', l.description) FROM perf_scale_levels l WHERE l.id = o.final_level_id),
    'finalScore', o.score::text,
    'proposedLevelId', CASE WHEN p_reviewee THEN NULL ELSE o.proposed_level_id END,
    'override', CASE WHEN NOT p_reviewee AND o.override_level_id IS NOT NULL THEN jsonb_build_object('levelId', o.override_level_id, 'reason', COALESCE(o.override_reason, '')) END,
    'finalisedAt', CASE WHEN p_reviewee THEN NULL ELSE work_iso(o.finalised_at) END,
    'sharedAt', work_iso(o.shared_at),
    'acknowledgementRequired', p_ack_required,
    'acknowledgement', (SELECT jsonb_build_object('id', a.id, 'acknowledgedAt', work_iso(a.acknowledged_at), 'comment', a.comment, 'disagrees', a.disagrees,
                                 'disagreementComment', a.disagreement_comment, 'resolution', a.resolution, 'resolvedNote', a.resolved_note,
                                 'resolvedAt', work_iso(a.resolved_at))
                        FROM perf_review_acks a WHERE a.outcome_id = o.id));
$$;

-- The review as the caller may see it.
CREATE OR REPLACE FUNCTION perf_review_get(c work_ctx, p_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r perf_reviews := perf_review_row(c, p_id);
  cy perf_cycles;
  t perf_templates;
  v_viewer text := perf_viewer(c, r);
  o perf_review_outcomes;
  v_self_submitted boolean := r.self_submitted_at IS NOT NULL;
  v_manager_submitted boolean := r.manager_submitted_at IS NOT NULL;
  v_blind boolean;
  v_ack boolean;
  v_see_self boolean; v_see_manager boolean; v_see_score boolean;
  v_result jsonb;
BEGIN
  SELECT * INTO cy FROM perf_cycles WHERE id = r.cycle_id;
  t := perf_template_of(cy);
  v_blind := COALESCE((t.steps->>'doubleBlind')::boolean, false);
  v_ack := COALESCE((t.steps->>'acknowledgement')::boolean, true);
  SELECT * INTO o FROM perf_review_outcomes WHERE review_id = r.id AND superseded_at IS NULL;
  IF v_viewer = 'reviewee' THEN
    -- The employee sees their result only once it is shared, and never the proposed level, override or history.
    IF o.shared_at IS NULL THEN o := NULL; END IF;
    v_see_self := true; v_see_manager := o.id IS NOT NULL; v_see_score := false;
  ELSE
    v_see_self := v_self_submitted AND (v_viewer <> 'reviewer' OR NOT v_blind OR v_manager_submitted);
    v_see_manager := true; v_see_score := true;
  END IF;
  IF o.id IS NOT NULL THEN v_result := perf_result_json(o, v_viewer = 'reviewee', v_ack); END IF;
  RETURN perf_review_summary(r, true) || jsonb_build_object(
    'viewer', v_viewer, 'phase', cy.phase, 'phaseLocked', cy.phase_locked,
    'canEditSelf', v_viewer = 'reviewee' AND perf_can_write_self(cy, r),
    'canEditManager', v_viewer = 'reviewer' AND perf_can_write_manager(cy, r),
    'canAcknowledge', v_viewer = 'reviewee' AND v_result IS NOT NULL AND v_ack AND v_result->'acknowledgement' = 'null'::jsonb AND cy.status = 'open',
    'items', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', i.id, 'ordinal', i.ordinal, 'itemType', i.item_type, 'refId', i.ref_id, 'title', i.title,
                         'helpText', i.help_text, 'weight', i.weight::text, 'scaleId', i.scale_id, 'expectedLevelId', i.expected_level_id,
                         'answeredBy', i.answered_by, 'isRequired', i.is_required) ORDER BY i.ordinal)
                       FROM perf_review_items i WHERE i.review_id = r.id), '[]'::jsonb),
    'self', CASE WHEN v_see_self THEN perf_pack(r.id, 'self', r.employee_id, false) END,
    'manager', CASE WHEN v_see_manager AND r.reviewer_id IS NOT NULL THEN perf_pack(r.id, 'manager', r.reviewer_id, v_see_score) END,
    'score', CASE WHEN v_see_score AND v_manager_submitted
                  THEN jsonb_build_object('proposedScore', r.proposed_score::text, 'proposedLevelId', r.proposed_level_id, 'formulaVersion', r.formula_version) END,
    'result', v_result,
    'version', r.version);
END;
$$;

CREATE OR REPLACE FUNCTION perf_reviews_mine(c work_ctx)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'asEmployee', COALESCE(jsonb_agg(perf_review_summary(r, true) ORDER BY r.created_at DESC) FILTER (WHERE r.employee_id = c.me), '[]'::jsonb),
    'asReviewer', COALESCE(jsonb_agg(perf_review_summary(r, true) ORDER BY work_name(r.employee_id)) FILTER (WHERE r.reviewer_id = c.me), '[]'::jsonb))
  FROM perf_reviews r JOIN perf_cycles cy ON cy.id = r.cycle_id AND cy.deleted_at IS NULL
  WHERE r.tenant_id = c.tenant AND r.status <> 'void' AND (r.employee_id = c.me OR r.reviewer_id = c.me);
$$;

-- Every review of a cycle the caller may see (HR: all; managers: their people; plus their own).
CREATE OR REPLACE FUNCTION perf_reviews_list(c work_ctx, p_cycle uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(perf_review_summary(s.x, true) ORDER BY work_name((s.x).employee_id)), '[]'::jsonb)
  FROM (SELECT x FROM perf_reviews x JOIN perf_cycles cy ON cy.id = x.cycle_id AND cy.deleted_at IS NULL
        WHERE x.tenant_id = c.tenant AND x.status <> 'void' AND (p_cycle IS NULL OR x.cycle_id = p_cycle)
          AND (c.overseer OR x.employee_id = c.me OR x.reviewer_id = c.me OR x.employee_id = ANY (c.team))
        LIMIT 1000) s;
$$;

-- ── 14. Reviews: write, score, submit ─────────────────────────────────────
CREATE OR REPLACE FUNCTION perf_review_save(c work_ctx, p_id uuid, p_role text, i jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r perf_reviews := perf_review_row(c, p_id, true);
  cy perf_cycles;
  t perf_templates;
  x jsonb;
  it perf_review_items;
  v_level uuid;
  v_na boolean;
  v_comment text;
  v_override jsonb := i->'override';
BEGIN
  SELECT * INTO cy FROM perf_cycles WHERE id = r.cycle_id;
  t := perf_template_of(cy);
  IF p_role = 'self' AND r.employee_id <> c.me THEN PERFORM work_fail('FORBIDDEN', 'Only the employee writes their self review.'); END IF;
  IF p_role = 'manager' AND r.reviewer_id IS DISTINCT FROM c.me THEN PERFORM work_fail('FORBIDDEN', 'Only the current reviewer writes the manager review.'); END IF;
  IF NOT (CASE WHEN p_role = 'self' THEN perf_can_write_self(cy, r) ELSE perf_can_write_manager(cy, r) END) THEN
    PERFORM work_fail('REVIEW_NOT_WRITABLE', CASE WHEN cy.phase_locked THEN 'This stage is locked by HR.'
      ELSE format('The %s review is not open.', CASE WHEN p_role = 'self' THEN 'self' ELSE 'manager' END) END);
  END IF;
  FOR x IN SELECT * FROM jsonb_array_elements(CASE WHEN jsonb_typeof(i->'ratings') = 'array' THEN i->'ratings' ELSE '[]'::jsonb END) LOOP
    SELECT * INTO it FROM perf_review_items WHERE id = work_uuid(x->>'itemId') AND review_id = r.id;
    IF it.id IS NULL THEN PERFORM work_fail('VALIDATION', 'One of the ratings is not an item of this review.'); END IF;
    IF it.answered_by <> 'both' AND it.answered_by <> p_role THEN
      PERFORM work_fail('VALIDATION', format('"%s" is answered by the %s only.', left(it.title, 60), CASE WHEN it.answered_by = 'self' THEN 'employee' ELSE 'manager' END));
    END IF;
    v_level := work_uuid(x->>'levelId');
    v_na := COALESCE((x->>'notApplicable')::boolean, false);
    v_comment := COALESCE(x->>'comment', '');
    IF v_level IS NOT NULL AND v_na THEN PERFORM work_fail('VALIDATION', 'Choose a level or not applicable, not both.'); END IF;
    IF v_level IS NOT NULL AND NOT EXISTS (SELECT 1 FROM perf_scale_levels l WHERE l.id = v_level AND l.scale_id = it.scale_id) THEN
      PERFORM work_fail('VALIDATION', 'A level does not belong to that item''s scale.');
    END IF;
    IF it.scale_id IS NULL AND v_na THEN PERFORM work_fail('VALIDATION', 'That item takes a comment only.'); END IF;
    IF char_length(v_comment) > 2000 THEN PERFORM work_fail('VALIDATION', 'A comment is too long.'); END IF;
    INSERT INTO perf_review_ratings (tenant_id, review_id, review_item_id, rater_role, author_id, level_id, not_applicable, comment)
    VALUES (c.tenant, r.id, it.id, p_role, c.me, v_level, v_na, v_comment)
    ON CONFLICT (review_item_id, rater_role, author_id) DO UPDATE SET level_id = EXCLUDED.level_id, not_applicable = EXCLUDED.not_applicable, comment = EXCLUDED.comment;
  END LOOP;
  IF jsonb_typeof(i->'summary') = 'object' THEN
    IF char_length(COALESCE(i #>> '{summary,comment}', '')) > 4000 THEN PERFORM work_fail('VALIDATION', 'The overall comment is too long.'); END IF;
    INSERT INTO perf_review_summaries (tenant_id, review_id, rater_role, author_id, comment)
    VALUES (c.tenant, r.id, p_role, c.me, COALESCE(i #>> '{summary,comment}', ''))
    ON CONFLICT (review_id, rater_role, author_id) DO UPDATE SET comment = EXCLUDED.comment;
  END IF;
  IF i ? 'override' THEN
    IF p_role <> 'manager' THEN PERFORM work_fail('VALIDATION', 'Only the manager can override the suggested rating.'); END IF;
    IF jsonb_typeof(v_override) = 'object' THEN
      IF NOT EXISTS (SELECT 1 FROM perf_scale_levels l WHERE l.id = work_uuid(v_override->>'levelId') AND l.scale_id = t.goal_scale_id) THEN
        PERFORM work_fail('VALIDATION', 'The overall rating does not belong to the result scale.');
      END IF;
      IF char_length(btrim(COALESCE(v_override->>'reason', ''))) < 3 THEN PERFORM work_fail('VALIDATION', 'A reason is required to use a different overall rating.'); END IF;
    END IF;
    INSERT INTO perf_review_summaries (tenant_id, review_id, rater_role, author_id, override_level_id, override_reason)
    VALUES (c.tenant, r.id, p_role, c.me, work_uuid(v_override->>'levelId'), NULLIF(btrim(COALESCE(v_override->>'reason', '')), ''))
    ON CONFLICT (review_id, rater_role, author_id) DO UPDATE SET override_level_id = EXCLUDED.override_level_id, override_reason = EXCLUDED.override_reason;
  END IF;
  UPDATE perf_reviews SET status = CASE WHEN p_role = 'self' THEN CASE WHEN status = 'not_started' THEN 'self_in_progress' ELSE status END
                                        ELSE 'manager_in_progress' END WHERE id = r.id;
END;
$$;

-- The suggested overall rating from the reviewer's ratings (the platform's "weighted" formula):
-- each section is the average of its ratings on a 0–1 scale (goals weighted by their weight), sections
-- are combined by the form's weights (a section with nothing rated gives its share to the others), the
-- result is put back on the scale and mapped to a level by the scale's bands.
CREATE OR REPLACE FUNCTION perf_score(r perf_reviews, t perf_templates)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_equal boolean := COALESCE(t.formula->>'weightsRule', 'sum_100') = 'equal';
  v_mapping text := COALESCE(t.formula->>'levelMapping', 'bands');
  v_min numeric; v_max numeric;
  v_goals numeric; v_comps numeric; v_ques numeric;
  v_wg numeric := COALESCE((t.formula->>'goalsWeight')::numeric, 70);
  v_wc numeric := COALESCE((t.formula->>'competenciesWeight')::numeric, 30);
  v_wq numeric := COALESCE((t.formula->>'questionsWeight')::numeric, 0);
  v_total numeric := 0; v_sum numeric := 0;
  v_score numeric;
  v_level uuid;
  v_inputs jsonb;
BEGIN
  SELECT min(value), max(value) INTO v_min, v_max FROM perf_scale_levels WHERE scale_id = t.goal_scale_id;
  WITH rated AS (
    SELECT i.item_type, i.weight, i.scale_id, i.is_required, i.answered_by, x.level_id, COALESCE(x.not_applicable, false) AS na,
           (SELECT (l.value - s.lo) / NULLIF(s.hi - s.lo, 0)
              FROM perf_scale_levels l, LATERAL (SELECT min(value) AS lo, max(value) AS hi FROM perf_scale_levels WHERE scale_id = l.scale_id) s
             WHERE l.id = x.level_id) AS norm
    FROM perf_review_items i
    LEFT JOIN perf_review_ratings x ON x.review_item_id = i.id AND x.rater_role = 'manager' AND x.author_id = r.reviewer_id
    WHERE i.review_id = r.id)
  SELECT sum(norm * CASE WHEN v_equal THEN 1 ELSE weight END) FILTER (WHERE item_type = 'goal' AND NOT na AND norm IS NOT NULL)
           / NULLIF(sum(CASE WHEN v_equal THEN 1 ELSE weight END) FILTER (WHERE item_type = 'goal' AND NOT na AND norm IS NOT NULL), 0),
         avg(norm) FILTER (WHERE item_type = 'competency' AND NOT na AND norm IS NOT NULL),
         avg(norm) FILTER (WHERE item_type = 'question' AND scale_id IS NOT NULL AND answered_by <> 'self' AND NOT na AND norm IS NOT NULL),
         jsonb_build_object(
           'goals', COALESCE(jsonb_agg(jsonb_build_object('weight', weight::text, 'levelId', level_id, 'notApplicable', na)) FILTER (WHERE item_type = 'goal'), '[]'::jsonb),
           'competencies', COALESCE(jsonb_agg(jsonb_build_object('levelId', level_id, 'notApplicable', na)) FILTER (WHERE item_type = 'competency'), '[]'::jsonb),
           'questions', COALESCE(jsonb_agg(jsonb_build_object('scaleId', scale_id, 'levelId', level_id, 'notApplicable', na))
                                 FILTER (WHERE item_type = 'question' AND scale_id IS NOT NULL AND answered_by <> 'self'), '[]'::jsonb))
    INTO v_goals, v_comps, v_ques, v_inputs
  FROM rated;
  IF v_wg > 0 AND v_goals IS NOT NULL THEN v_total := v_total + v_wg; v_sum := v_sum + v_goals * v_wg; END IF;
  IF v_wc > 0 AND v_comps IS NOT NULL THEN v_total := v_total + v_wc; v_sum := v_sum + v_comps * v_wc; END IF;
  IF v_wq > 0 AND v_ques IS NOT NULL THEN v_total := v_total + v_wq; v_sum := v_sum + v_ques * v_wq; END IF;
  IF v_total > 0 THEN
    v_score := round(v_min + (v_sum / v_total) * (v_max - v_min), 2);
    IF v_mapping = 'bands' THEN
      SELECT id INTO v_level FROM perf_scale_levels WHERE scale_id = t.goal_scale_id AND v_score BETWEEN min_score AND max_score ORDER BY ordinal LIMIT 1;
    END IF;
    IF v_level IS NULL THEN   -- nearest level; an exact tie goes to the higher one
      SELECT id INTO v_level FROM perf_scale_levels WHERE scale_id = t.goal_scale_id ORDER BY abs(value - v_score), value DESC LIMIT 1;
    END IF;
  END IF;
  RETURN jsonb_build_object('score', v_score, 'levelId', v_level,
    'inputs', COALESCE(v_inputs, '{}'::jsonb) || jsonb_build_object('formula', t.formula, 'computedAt', work_iso(now())));
END;
$$;

CREATE OR REPLACE FUNCTION perf_review_submit(c work_ctx, p_id uuid, p_role text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r perf_reviews := perf_review_row(c, p_id, true);
  cy perf_cycles;
  t perf_templates;
  v_missing text[];
  s jsonb;
  v_override uuid;
BEGIN
  SELECT * INTO cy FROM perf_cycles WHERE id = r.cycle_id;
  t := perf_template_of(cy);
  IF p_role = 'self' AND r.employee_id <> c.me THEN PERFORM work_fail('FORBIDDEN', 'Only the employee writes their self review.'); END IF;
  IF p_role = 'manager' AND r.reviewer_id IS DISTINCT FROM c.me THEN PERFORM work_fail('FORBIDDEN', 'Only the current reviewer writes the manager review.'); END IF;
  IF NOT (CASE WHEN p_role = 'self' THEN perf_can_write_self(cy, r) ELSE perf_can_write_manager(cy, r) END) THEN
    PERFORM work_fail('REVIEW_NOT_WRITABLE', CASE WHEN cy.phase_locked THEN 'This stage is locked by HR.'
      ELSE format('The %s review is not open.', CASE WHEN p_role = 'self' THEN 'self' ELSE 'manager' END) END);
  END IF;
  SELECT array_agg(left(i.title, 60) ORDER BY i.ordinal) INTO v_missing
  FROM perf_review_items i
  LEFT JOIN perf_review_ratings x ON x.review_item_id = i.id AND x.rater_role = p_role AND x.author_id = c.me
  WHERE i.review_id = r.id AND (i.answered_by = 'both' OR i.answered_by = p_role)
    AND NOT (i.item_type = 'question' AND NOT i.is_required)
    AND CASE WHEN i.scale_id IS NOT NULL THEN x.id IS NULL OR (x.level_id IS NULL AND NOT x.not_applicable)
             ELSE x.id IS NULL OR btrim(x.comment) = '' END;
  IF v_missing IS NOT NULL THEN
    PERFORM work_fail('REVIEW_INCOMPLETE', 'Rate every item (or mark it not applicable) before submitting: ' || array_to_string(v_missing[1:5], '; ')
                      || CASE WHEN cardinality(v_missing) > 5 THEN ' …' ELSE '' END);
  END IF;
  IF p_role = 'self' THEN
    UPDATE perf_reviews SET status = 'self_submitted', self_submitted_at = now() WHERE id = r.id;
    PERFORM perf_notify(c, ARRAY[r.reviewer_id], 'performance_review', format('%s submitted their self review', COALESCE(work_name(c.me), 'Someone')), cy.name);
    RETURN;
  END IF;
  s := perf_score(r, t);
  SELECT override_level_id INTO v_override FROM perf_review_summaries WHERE review_id = r.id AND rater_role = 'manager' AND author_id = c.me;
  IF v_override IS NOT NULL AND v_override::text = s->>'levelId' THEN
    PERFORM work_fail('OVERRIDE_SAME_AS_PROPOSED', 'The different overall rating is the same as the suggested one. Remove it, or choose another level.');
  END IF;
  UPDATE perf_reviews SET status = 'manager_submitted', manager_submitted_at = now(), proposed_score = (s->>'score')::numeric,
         proposed_level_id = work_uuid(s->>'levelId'), score_inputs = s->'inputs', formula_version = 1 WHERE id = r.id;
END;
$$;

-- ── 15. Results: finalise, share, acknowledge, disagreements ──────────────
-- NULL when finalised now, otherwise why not.
CREATE OR REPLACE FUNCTION perf_finalise_one(c work_ctx, r perf_reviews, cy perf_cycles)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s perf_review_summaries;
  v_final uuid;
  v_id uuid := gen_random_uuid();
BEGIN
  IF cy.status <> 'open' OR cy.phase <> 'results' THEN RETURN 'NOT_RESULTS_PHASE'; END IF;
  IF r.status IN ('finalised','shared') THEN RETURN 'ALREADY_FINALISED'; END IF;
  IF r.status <> 'manager_submitted' THEN RETURN 'NOT_SUBMITTED'; END IF;
  SELECT * INTO s FROM perf_review_summaries WHERE review_id = r.id AND rater_role = 'manager' AND author_id = r.reviewer_id;
  v_final := COALESCE(s.override_level_id, r.proposed_level_id);
  IF v_final IS NULL THEN RETURN 'NO_FINAL_LEVEL'; END IF;
  INSERT INTO perf_review_outcomes (id, tenant_id, review_id, cycle_id, employee_id, version_no, reviewer_id, score, proposed_level_id, final_level_id,
                                    override_level_id, override_reason, score_inputs, formula_version, manager_submitted_at, finalised_by)
  VALUES (v_id, r.tenant_id, r.id, r.cycle_id, r.employee_id, (SELECT COALESCE(max(version_no), 0) + 1 FROM perf_review_outcomes WHERE review_id = r.id),
          r.reviewer_id, r.proposed_score, r.proposed_level_id, v_final, s.override_level_id, s.override_reason, r.score_inputs, r.formula_version,
          r.manager_submitted_at, c.me);
  UPDATE perf_reviews SET status = 'finalised', current_outcome_id = v_id WHERE id = r.id;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION perf_finalise_all(c work_ctx, p_cycle uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cy perf_cycles;
  r perf_reviews;
  v_block text;
  v_done int := 0; v_already int := 0;
  v_skipped jsonb := '[]'::jsonb;
BEGIN
  PERFORM perf_assert_hr(c);
  cy := perf_cycle_row(c, p_cycle, true);
  IF cy.status <> 'open' OR cy.phase <> 'results' THEN
    PERFORM work_fail('NOT_RESULTS_PHASE', 'Results can only be finalised and shared in the results stage of an open cycle.');
  END IF;
  FOR r IN SELECT * FROM perf_reviews WHERE cycle_id = p_cycle AND status <> 'void' ORDER BY id FOR UPDATE LOOP
    v_block := perf_finalise_one(c, r, cy);
    IF v_block IS NULL THEN v_done := v_done + 1;
    ELSIF v_block = 'ALREADY_FINALISED' THEN v_already := v_already + 1;
    ELSE v_skipped := v_skipped || jsonb_build_object('reviewId', r.id, 'employeeId', r.employee_id, 'name', work_name(r.employee_id), 'status', r.status, 'reason', v_block);
    END IF;
  END LOOP;
  RETURN jsonb_build_object('finalised', v_done, 'alreadyFinalised', v_already, 'skipped', v_skipped);
END;
$$;

CREATE OR REPLACE FUNCTION perf_share_all(c work_ctx, p_cycle uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cy perf_cycles;
  r perf_reviews;
  v_done int := 0; v_already int := 0;
  v_skipped jsonb := '[]'::jsonb;
  v_to uuid[] := '{}';
BEGIN
  PERFORM perf_assert_hr(c);
  cy := perf_cycle_row(c, p_cycle, true);
  IF cy.status <> 'open' OR cy.phase <> 'results' THEN
    PERFORM work_fail('NOT_RESULTS_PHASE', 'Results can only be finalised and shared in the results stage of an open cycle.');
  END IF;
  FOR r IN SELECT * FROM perf_reviews WHERE cycle_id = p_cycle AND status <> 'void' ORDER BY id FOR UPDATE LOOP
    IF r.status = 'shared' THEN v_already := v_already + 1;
    ELSIF r.status <> 'finalised' THEN
      v_skipped := v_skipped || jsonb_build_object('reviewId', r.id, 'employeeId', r.employee_id, 'name', work_name(r.employee_id), 'status', r.status, 'reason', 'NOT_FINALISED');
    ELSE
      UPDATE perf_review_outcomes SET shared_at = now(), shared_by = c.me WHERE id = r.current_outcome_id AND shared_at IS NULL AND superseded_at IS NULL;
      UPDATE perf_reviews SET status = 'shared' WHERE id = r.id;
      v_to := v_to || r.employee_id;
      v_done := v_done + 1;
    END IF;
  END LOOP;
  PERFORM perf_notify(c, v_to, 'performance_review', 'Your performance review results are available: ' || cy.name, NULL);
  RETURN jsonb_build_object('shared', v_done, 'alreadyShared', v_already, 'skipped', v_skipped);
END;
$$;

CREATE OR REPLACE FUNCTION perf_acknowledge(c work_ctx, p_id uuid, i jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r perf_reviews := perf_review_row(c, p_id, true);
  cy perf_cycles;
  t perf_templates;
  o perf_review_outcomes;
  v_disagree boolean := COALESCE((i->>'disagree')::boolean, false);
  v_why text := NULLIF(btrim(COALESCE(i->>'disagreementComment', '')), '');
  v_comment text := btrim(COALESCE(i->>'comment', ''));
BEGIN
  IF r.employee_id <> c.me THEN PERFORM work_fail('FORBIDDEN', 'Only the employee acknowledges their result.'); END IF;
  SELECT * INTO cy FROM perf_cycles WHERE id = r.cycle_id;
  t := perf_template_of(cy);
  SELECT * INTO o FROM perf_review_outcomes WHERE review_id = r.id AND superseded_at IS NULL AND shared_at IS NOT NULL;
  IF o.id IS NULL THEN PERFORM work_fail('NOT_SHARED', 'There is no shared result to acknowledge.'); END IF;
  IF NOT COALESCE((t.steps->>'acknowledgement')::boolean, true) THEN PERFORM work_fail('NOT_ENABLED', 'This cycle does not ask for acknowledgement.'); END IF;
  IF cy.status <> 'open' THEN PERFORM work_fail('CYCLE_NOT_OPEN', 'The cycle is closed.'); END IF;
  IF EXISTS (SELECT 1 FROM perf_review_acks WHERE outcome_id = o.id) THEN
    PERFORM work_fail('ALREADY_ACKNOWLEDGED', 'This result has already been acknowledged. An acknowledgement is final.');
  END IF;
  IF v_disagree AND char_length(COALESCE(v_why, '')) < 3 THEN PERFORM work_fail('VALIDATION', 'Explain what you disagree with.'); END IF;
  IF char_length(v_comment) > 2000 OR char_length(COALESCE(v_why, '')) > 2000 THEN PERFORM work_fail('VALIDATION', 'That is too long.'); END IF;
  INSERT INTO perf_review_acks (tenant_id, outcome_id, review_id, employee_id, comment, disagrees, disagreement_comment, resolution)
  VALUES (c.tenant, o.id, r.id, c.me, v_comment, v_disagree, CASE WHEN v_disagree THEN v_why END, CASE WHEN v_disagree THEN 'open' END);
  IF v_disagree THEN
    PERFORM perf_notify(c, perf_hr_ids(c.tenant), 'performance_review',
                        format('%s disagrees with their review result', COALESCE(work_name(c.me), 'Someone')), cy.name);
  END IF;
END;
$$;

-- HR reopens a review after reviews closed: the result is withdrawn and its reviewer writes again.
CREATE OR REPLACE FUNCTION perf_reopen_review(c work_ctx, r perf_reviews, cy perf_cycles, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_next text := CASE WHEN r.status IN ('manager_submitted','finalised','shared') THEN 'manager_in_progress' ELSE r.status END;
  v_shared boolean := false;
BEGIN
  IF cy.status <> 'open' THEN PERFORM work_fail('CYCLE_NOT_OPEN', 'The cycle is closed.'); END IF;
  IF cy.phase NOT IN ('reviews_closed','results') THEN PERFORM work_fail('REVIEWS_NOT_CLOSED', 'A review can only be reopened after reviews close.'); END IF;
  IF r.status IN ('blocked','void') THEN PERFORM work_fail('NOT_REOPENABLE', 'Blocked and void reviews cannot be reopened.'); END IF;
  IF r.reopened_at IS NOT NULL AND r.manager_submitted_at IS NULL THEN
    PERFORM work_fail('ALREADY_OPEN', 'This review has already been reopened and is waiting for the reviewer.');
  END IF;
  IF r.current_outcome_id IS NOT NULL THEN
    UPDATE perf_review_outcomes SET superseded_at = now(), superseded_by = c.me, superseded_reason = left(p_reason, 500)
     WHERE id = r.current_outcome_id AND superseded_at IS NULL RETURNING shared_at IS NOT NULL INTO v_shared;
    UPDATE perf_review_acks SET resolution = 'reopened', resolved_note = left(p_reason, 2000), resolved_by = c.me, resolved_at = now()
     WHERE outcome_id = r.current_outcome_id AND resolution = 'open';
  END IF;
  UPDATE perf_reviews SET status = v_next, current_outcome_id = NULL, reopened_at = now(),
         manager_submitted_at = CASE WHEN v_next <> r.status THEN NULL ELSE manager_submitted_at END,
         proposed_score = CASE WHEN v_next <> r.status THEN NULL ELSE proposed_score END,
         proposed_level_id = CASE WHEN v_next <> r.status THEN NULL ELSE proposed_level_id END,
         score_inputs = CASE WHEN v_next <> r.status THEN NULL ELSE score_inputs END,
         formula_version = CASE WHEN v_next <> r.status THEN NULL ELSE formula_version END
   WHERE id = r.id;
  PERFORM perf_notify(c, ARRAY[r.reviewer_id], 'performance_review', format('The review of %s was reopened for you', COALESCE(work_name(r.employee_id), 'an employee')), cy.name);
  IF COALESCE(v_shared, false) THEN
    PERFORM perf_notify(c, ARRAY[r.employee_id], 'performance_review', 'Your review result was reopened and will be shared again', cy.name);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION perf_resolve(c work_ctx, p_ack uuid, p_action text, p_note text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  a perf_review_acks;
  r perf_reviews;
  cy perf_cycles;
  v_note text := btrim(COALESCE(p_note, ''));
BEGIN
  PERFORM perf_assert_hr(c);
  IF char_length(v_note) < 3 THEN PERFORM work_fail('VALIDATION', 'A note is required.'); END IF;
  SELECT * INTO a FROM perf_review_acks WHERE id = p_ack AND tenant_id = c.tenant FOR UPDATE;
  IF a.id IS NULL THEN PERFORM work_fail('NOT_FOUND', 'Acknowledgement not found.'); END IF;
  SELECT * INTO r FROM perf_reviews WHERE id = a.review_id FOR UPDATE;
  -- Never about oneself, even for HR.
  IF r.employee_id = c.me THEN PERFORM work_fail('FORBIDDEN', 'Someone else in HR resolves your own disagreement.'); END IF;
  SELECT * INTO cy FROM perf_cycles WHERE id = r.cycle_id;
  IF a.resolution IS DISTINCT FROM 'open' THEN PERFORM work_fail('NOT_OPEN', 'Only an open disagreement can be resolved.'); END IF;
  IF p_action = 'reopen' THEN
    PERFORM perf_reopen_review(c, r, cy, v_note);
  ELSIF p_action = 'close_with_note' THEN
    UPDATE perf_review_acks SET resolution = 'closed_with_note', resolved_note = left(v_note, 2000), resolved_by = c.me, resolved_at = now() WHERE id = a.id;
  ELSE
    PERFORM work_fail('VALIDATION', 'Unknown action.');
  END IF;
END;
$$;

-- What still needs attention in a cycle (HR: everyone; managers: their people). Never the caller's own review.
CREATE OR REPLACE FUNCTION perf_outcomes(c work_ctx, p_cycle uuid, p_state text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cy perf_cycles := perf_cycle_row(c, p_cycle);
  v_ack boolean := COALESCE(((perf_template_of(cy)).steps->>'acknowledgement')::boolean, true);
BEGIN
  IF p_state IS NULL OR p_state NOT IN ('unfinalised','unshared','unacknowledged','disagreements') THEN PERFORM work_fail('VALIDATION', 'Unknown filter.'); END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object('reviewId', r.id, 'employeeId', r.employee_id, 'name', COALESCE(work_name(r.employee_id), 'Employee'),
             'reviewerEmployeeId', r.reviewer_id, 'status', r.status, 'outcomeId', o.id, 'versionNo', o.version_no, 'finalLevelId', o.final_level_id,
             'finalScore', o.score::text, 'sharedAt', work_iso(o.shared_at), 'acknowledgementId', a.id, 'acknowledgedAt', work_iso(a.acknowledged_at),
             'disagrees', COALESCE(a.disagrees, false), 'resolution', a.resolution) ORDER BY work_name(r.employee_id))
    FROM perf_reviews r
    LEFT JOIN perf_review_outcomes o ON o.id = r.current_outcome_id
    LEFT JOIN perf_review_acks a ON a.outcome_id = o.id
    WHERE r.cycle_id = p_cycle AND r.status <> 'void' AND r.employee_id <> c.me AND (c.overseer OR r.employee_id = ANY (c.team))
      AND CASE p_state WHEN 'unfinalised' THEN r.status NOT IN ('finalised','shared')
                       WHEN 'unshared' THEN r.status = 'finalised'
                       WHEN 'unacknowledged' THEN v_ack AND r.status = 'shared' AND a.id IS NULL
                       ELSE a.resolution = 'open' END), '[]'::jsonb);
END;
$$;
