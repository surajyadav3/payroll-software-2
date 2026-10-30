-- 20261024_6 — Came in on an approved leave day: Present, and HR can give the day back.
--
-- User (2026-10-24), Raniwala: "if someone is on leave and then a punch shows
-- for him for that day, don't mark that person as on leave, mark it present
-- and give the leave back. Show a notification to HR for that case, then if HR
-- approves give the leave back to that employee, because he/she applied and
-- got approved but due to any reason was present in the office".
--
-- Until now every date of an approved full-day leave was forced to 'Leave'
-- (zz_leave_overrides_attendance_status, the recompute trigger), and the ESSL
-- apply kept a 'Leave' row as it was even after adding the device punches. In
-- Oct 2026, 7 Raniwala days had approved punches under 'Leave'.
--
-- * tenants.leave_worked_day_from: the rule is on from this date (Raniwala
--   2026-10-01 — September is closed from HR's sheet, 20261010_6).
-- * A date of an approved FULL-day leave that has an approved punch (device,
--   approved app punch, or regularized) is scored from its punches like any
--   working day (Present / Late / Half Day ...). leave_day_worked() decides it;
--   both attendance triggers and essl_apply_to_attendance use it.
-- * Half-day leave (user, same day: "if someone applies leave for half day,
--   calculate the day's hours according to it"): the day is scored from its
--   punches as before (20261013_2: their own half worked = 'Half Day'). If
--   the punches add up to a FULL day's hours (outlet / company
--   min_full_day_hours, Raniwala 8 h) they worked the leave half too: the day
--   keeps its Present / Late and is listed for HR like a full-day leave, half
--   a day back. Under a full day's hours nothing changes.
-- * The first such punch writes a leave_worked_days row (pending) and tells
--   HR (every Active admin) in app_notifications, link_key leave_worked_days.
--   A leave approved AFTER the punches does the same instead of overwriting
--   the day with 'Leave'.
-- * HR decides with hr_decide_leave_worked_day(id, approve, note):
--     approve = the day stays as punched and the leave is given back — Comp
--               Off to profiles.comp_off_balance (+ comp_off_adjustments
--               line), any other type as a +Allocation leave_ledger line
--               "Leave given back: ..." of the type the request deducted.
--               1 day for a full working day, 0.5 for Half Day (a half-day
--               leave: 0.5, and only for a full day's hours); never more
--               than the request deducted. Not while the day is still on, nor
--               for an Absent / Mispunch / Pending Approval day.
--     reject  = the day goes back to 'Leave' (a half-day leave: 'Half Day')
--               and stays deducted.
--   The employee is told either way. Nothing is refunded without HR.
-- * list_leave_worked_days(status) feeds the web Leave Management card.
-- * Backfill: Raniwala days from 2026-10-01 are re-scored and listed pending
--   for HR (HR gets the notices).

ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS leave_worked_day_from date;
COMMENT ON COLUMN public.tenants.leave_worked_day_from IS
  'Came in on an approved full-day leave day (20261024_6): from this date the day is scored from its punches and HR may give the leave day back. NULL = off.';

UPDATE public.tenants SET leave_worked_day_from = DATE '2026-10-01'
 WHERE id = '123c949a-329f-4a48-bb25-eed41a390cf4';

CREATE TABLE IF NOT EXISTS public.leave_worked_days (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  profile_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  leave_request_id uuid NOT NULL REFERENCES public.leave_requests(id) ON DELETE CASCADE,
  date             date NOT NULL,
  leave_type       text,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  refund_days      numeric NOT NULL DEFAULT 0,
  ledger_entry_id  uuid REFERENCES public.leave_ledger(id) ON DELETE SET NULL,
  decided_by       uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  decided_at       timestamptz,
  note             text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (leave_request_id, date)
);
CREATE INDEX IF NOT EXISTS leave_worked_days_tenant_status_idx ON public.leave_worked_days (tenant_id, status, date);
CREATE INDEX IF NOT EXISTS leave_worked_days_profile_date_idx ON public.leave_worked_days (profile_id, date);

ALTER TABLE public.leave_worked_days ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "leave_worked_days: own or HR can select" ON public.leave_worked_days;
CREATE POLICY "leave_worked_days: own or HR can select" ON public.leave_worked_days
  FOR SELECT TO authenticated
  USING ((tenant_id = (SELECT my_tenant_id())) AND ((profile_id = (SELECT auth.uid())) OR ((SELECT my_role()) = ANY (ARRAY['admin'::text, 'superadmin'::text]))));
-- Written only by the functions below.
REVOKE INSERT, UPDATE, DELETE ON public.leave_worked_days FROM anon, authenticated;
GRANT SELECT ON public.leave_worked_days TO authenticated;

-- ---------------------------------------------------------------------------
-- Does this date of an approved full-day leave count as worked? Tenant on the
-- rule, an approved punch on the day, and HR has not kept it as leave.
CREATE OR REPLACE FUNCTION public.leave_day_worked(p_profile_id uuid, p_date date, p_attendance_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT p_attendance_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM profiles p JOIN tenants t ON t.id = p.tenant_id
        WHERE p.id = p_profile_id AND t.leave_worked_day_from IS NOT NULL AND p_date >= t.leave_worked_day_from)
     AND EXISTS (
       SELECT 1 FROM punches pu WHERE pu.attendance_id = p_attendance_id AND pu.approval_status = 'approved')
     AND NOT EXISTS (
       SELECT 1 FROM leave_worked_days w
        WHERE w.profile_id = p_profile_id AND w.date = p_date AND w.status = 'rejected');
$$;
-- Called from attendance triggers that run as the signed-in user.
REVOKE EXECUTE ON FUNCTION public.leave_day_worked(uuid, date, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.leave_day_worked(uuid, date, uuid) TO authenticated;

-- Hours that make a full day for this employee (same precedence as the
-- recompute trigger): a half-day leave date with this many hours was worked
-- in full.
CREATE OR REPLACE FUNCTION public.leave_full_day_hours(p_profile_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE(o.min_full_day_hours, t.min_full_day_hours, 8)
    FROM profiles p
    JOIN tenants t ON t.id = p.tenant_id
    LEFT JOIN outlets o ON o.id = p.outlet_id
   WHERE p.id = p_profile_id;
$$;
REVOKE EXECUTE ON FUNCTION public.leave_full_day_hours(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.leave_full_day_hours(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- The three places that kept such a day as 'Leave' (a half-day leave:
-- 'Half Day') get one condition each.
-- Patched in the LIVE bodies at apply time (other migrations rewrite these
-- functions too, e.g. 20261024_5 essl late-night out): re-runnable, skips a
-- body that already has it, and fails if the anchor text is gone.
DO $patch$
DECLARE
  p     record;
  v_def text;
  v_n   int;
BEGIN
  FOR p IN
    SELECT * FROM (VALUES
      ('public.trg_leave_overrides_attendance_status()', $q$      AND NEW.date BETWEEN lr.start_date AND lr.end_date
      AND lr.half_day IS NULL
  ) THEN$q$, $q$      AND NEW.date BETWEEN lr.start_date AND lr.end_date
      AND lr.half_day IS NULL
  ) AND NOT leave_day_worked(NEW.profile_id, NEW.date, NEW.id) THEN
    -- (20261024_6: unless they came in that day -- then it is scored from
    -- its punches like any working day, and HR decides on the leave.)$q$),
      ('public.trg_leave_overrides_attendance_status()', $q$  -- They were only due for the other half: not Late, and no early-exit /
  -- late-arrival marks for the half they are on leave.
  IF NEW.status IN ('Present', 'Late') THEN$q$, $q$  -- Came in for the leave half too (20261024_6): a full day's hours keep
  -- the day as punched, and HR decides on the half day of leave.
  IF NEW.status IN ('Present', 'Late')
     AND COALESCE(NEW.total_hours, 0) >= leave_full_day_hours(NEW.profile_id)
     AND leave_day_worked(NEW.profile_id, NEW.date, NEW.id) THEN
    RETURN NEW;
  END IF;

  -- They were only due for the other half: not Late, and no early-exit /
  -- late-arrival marks for the half they are on leave.
  IF NEW.status IN ('Present', 'Late') THEN$q$),
      ('public.trg_recompute_attendance_from_punches()', $q$      AND NEW.date BETWEEN lr.start_date AND lr.end_date
      AND lr.half_day IS NULL
  ) THEN$q$, $q$      AND NEW.date BETWEEN lr.start_date AND lr.end_date
      AND lr.half_day IS NULL
  ) AND NOT leave_day_worked(NEW.profile_id, NEW.date, NEW.id) THEN
    -- (20261024_6: unless they came in that day -- then it is scored from
    -- its punches like any working day, and HR decides on the leave.)$q$),
      ('public.essl_apply_to_attendance(uuid,text[],date,date,boolean,boolean)', $q$    -- Keep every non-punch status as-is (punches were still added above).
    IF v_old IS NOT NULL AND v_old NOT IN ('Present','Late','Half Day','Absent','Mispunch') THEN$q$, $q$    -- Keep every non-punch status as-is (punches were still added above),
    -- except a day of approved leave they came in on (20261024_6): that one
    -- is scored from its punches.
    IF v_old IS NOT NULL AND v_old NOT IN ('Present','Late','Half Day','Absent','Mispunch')
       AND NOT (v_old = 'Leave' AND leave_day_worked(r.profile_id, r.date, v_att_id)) THEN$q$)
    ) v(fn, old_text, new_text)
  LOOP
    v_def := pg_get_functiondef(p.fn::regprocedure);
    IF position(p.new_text IN v_def) > 0 THEN
      CONTINUE;   -- already patched
    END IF;
    v_n := (length(v_def) - length(replace(v_def, p.old_text, ''))) / length(p.old_text);
    IF v_n <> 1 THEN
      RAISE EXCEPTION '20261024_6: % — expected the anchor once, found %', p.fn, v_n;
    END IF;
    EXECUTE replace(v_def, p.old_text, p.new_text);
  END LOOP;
END $patch$;

-- ---------------------------------------------------------------------------
-- List the day for HR (once per leave + date) and score it from its punches.
CREATE OR REPLACE FUNCTION public.register_leave_worked_day(p_attendance_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_att  RECORD;
  v_req  RECORD;
  v_id   uuid;
  v_prev text;
  v_name text;
  v_code text;
  v_in   text;
  v_out  text;
BEGIN
  SELECT a.id, a.tenant_id, a.profile_id, a.date, a.status, a.total_hours INTO v_att
    FROM attendance a WHERE a.id = p_attendance_id;
  IF NOT FOUND OR NOT leave_day_worked(v_att.profile_id, v_att.date, v_att.id) THEN
    RETURN NULL;
  END IF;

  -- A full-day leave; else a half-day leave they worked a full day's hours on.
  SELECT lr.id, lr.leave_type, lr.half_day INTO v_req
    FROM leave_requests lr
   WHERE lr.profile_id = v_att.profile_id AND lr.status = 'Approved'
     AND v_att.date BETWEEN lr.start_date AND lr.end_date
     AND (lr.half_day IS NULL
          OR (v_att.status IN ('Present', 'Late')
              AND COALESCE(v_att.total_hours, 0) >= leave_full_day_hours(v_att.profile_id)))
   ORDER BY lr.half_day IS NOT NULL, lr.created_at
   LIMIT 1;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  INSERT INTO leave_worked_days (tenant_id, profile_id, leave_request_id, date, leave_type)
  VALUES (v_att.tenant_id, v_att.profile_id, v_req.id, v_att.date, v_req.leave_type)
  ON CONFLICT (leave_request_id, date) DO NOTHING
  RETURNING id INTO v_id;

  -- Score the day from its punches (each new punch), forced so it runs
  -- whoever the caller is. The ESSL apply and an approved regularization
  -- score their own day (app.regularize_apply); a half-day date is never
  -- held as 'Leave', so it is scored as usual.
  IF v_req.half_day IS NULL AND COALESCE(current_setting('app.regularize_apply', true), '') <> 'on' THEN
    v_prev := current_setting('app.punch_review', true);
    PERFORM set_config('app.punch_review', 'on', true);
    UPDATE attendance SET total_hours = total_hours WHERE id = v_att.id;
    PERFORM set_config('app.punch_review', COALESCE(v_prev, 'off'), true);
  END IF;

  IF v_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT trim(concat_ws(' ', first_name, last_name)), employee_id INTO v_name, v_code
    FROM profiles WHERE id = v_att.profile_id;
  SELECT left(min(punch_time), 5), left(max(punch_time), 5) INTO v_in, v_out
    FROM punches WHERE attendance_id = v_att.id AND approval_status = 'approved';

  INSERT INTO app_notifications (tenant_id, profile_id, actor_id, type, title, body, link_key, related_id)
  SELECT v_att.tenant_id, p.id, v_att.profile_id, 'leave_worked_day',
         'Came in on a leave day',
         CASE WHEN v_req.half_day IS NULL THEN
           format('%s%s punched in at %s on %s, a day of approved %s. Approve it on Leave Management to give the leave day back, or keep it as leave.',
                  COALESCE(NULLIF(v_name, ''), 'An employee'),
                  CASE WHEN COALESCE(v_code, '') <> '' THEN ' (EMP ' || v_code || ')' ELSE '' END,
                  COALESCE(v_in, '?'), to_char(v_att.date, 'DD Mon'),
                  COALESCE(NULLIF(v_req.leave_type, ''), 'leave'))
         ELSE
           format('%s%s worked a full day on %s (%s – %s, %s h) although %s half was approved %s. Approve it on Leave Management to give the half day back, or keep it as leave.',
                  COALESCE(NULLIF(v_name, ''), 'An employee'),
                  CASE WHEN COALESCE(v_code, '') <> '' THEN ' (EMP ' || v_code || ')' ELSE '' END,
                  to_char(v_att.date, 'DD Mon'), COALESCE(v_in, '?'), COALESCE(v_out, '?'),
                  trim_scale(round(COALESCE(v_att.total_hours, 0), 2)),
                  CASE WHEN v_req.half_day = 'first_half' THEN 'the first' ELSE 'the second' END,
                  COALESCE(NULLIF(v_req.leave_type, ''), 'leave'))
         END,
         'leave_worked_days', v_id
    FROM profiles p
   WHERE p.tenant_id = v_att.tenant_id AND p.role = 'admin' AND p.status = 'Active'
     AND p.id <> v_att.profile_id;

  RETURN v_id;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.register_leave_worked_day(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.trg_punch_leave_worked_day()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  PERFORM register_leave_worked_day(NEW.attendance_id);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS zz_punch_leave_worked_day ON public.punches;
CREATE TRIGGER zz_punch_leave_worked_day
  AFTER INSERT OR UPDATE OF approval_status ON public.punches
  FOR EACH ROW WHEN (NEW.approval_status = 'approved')
  EXECUTE FUNCTION public.trg_punch_leave_worked_day();

-- A half-day leave date reaches a full day's hours as the punches come in
-- (or the leave is approved after the day was worked): list it for HR.
CREATE OR REPLACE FUNCTION public.trg_attendance_half_leave_worked_day()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF EXISTS (
       SELECT 1 FROM leave_requests lr
        WHERE lr.profile_id = NEW.profile_id AND lr.status = 'Approved'
          AND lr.half_day IS NOT NULL AND lr.start_date = NEW.date)
     AND NOT EXISTS (
       SELECT 1 FROM leave_worked_days w WHERE w.profile_id = NEW.profile_id AND w.date = NEW.date)
     AND COALESCE(NEW.total_hours, 0) >= leave_full_day_hours(NEW.profile_id) THEN
    PERFORM register_leave_worked_day(NEW.id);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS zzzz_half_leave_worked_day ON public.attendance;
CREATE TRIGGER zzzz_half_leave_worked_day
  AFTER INSERT OR UPDATE ON public.attendance
  FOR EACH ROW WHEN (NEW.status IN ('Present', 'Late'))
  EXECUTE FUNCTION public.trg_attendance_half_leave_worked_day();

-- ---------------------------------------------------------------------------
-- A leave approved after they had already punched that day: keep the punches,
-- list the day for HR. Otherwise as 20261016_1.
CREATE OR REPLACE FUNCTION public.apply_leave_approval_effects(p_leave_request_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_req  leave_requests%ROWTYPE;
  v_type uuid;
  v_day  date;
  v_comp numeric := 0;
  v_att  uuid;
BEGIN
  SELECT * INTO v_req FROM leave_requests WHERE id = p_leave_request_id;
  IF NOT FOUND OR v_req.status IS DISTINCT FROM 'Approved' THEN RETURN; END IF;

  -- Every day of the leave shows as 'Leave' on the attendance calendar (a
  -- half day is kept as punched by zz_leave_overrides_attendance_status).
  FOR v_day IN SELECT generate_series(v_req.start_date, v_req.end_date, interval '1 day')::date LOOP
    -- Came in that day anyway (20261024_6): the punches stand, HR decides
    -- on giving the day back.
    IF v_req.half_day IS NULL THEN
      SELECT id INTO v_att FROM attendance WHERE profile_id = v_req.profile_id AND date = v_day;
      IF v_att IS NOT NULL AND leave_day_worked(v_req.profile_id, v_day, v_att) THEN
        PERFORM register_leave_worked_day(v_att);
        CONTINUE;
      END IF;
    END IF;
    INSERT INTO attendance (tenant_id, profile_id, date, status, total_hours, location)
    VALUES (v_req.tenant_id, v_req.profile_id, v_day, 'Leave', 0, 'Office')
    ON CONFLICT (profile_id, date) DO UPDATE SET status = 'Leave', total_hours = 0;
  END LOOP;

  IF EXISTS (SELECT 1 FROM leave_approval_effects WHERE leave_request_id = p_leave_request_id) THEN RETURN; END IF;

  IF v_req.leave_type = 'Comp Off' THEN
    v_comp := CASE WHEN v_req.half_day IS NOT NULL THEN 0.5 ELSE (v_req.end_date - v_req.start_date) + 1 END;
    UPDATE profiles SET comp_off_balance = GREATEST(0, COALESCE(comp_off_balance, 0) - v_comp)
     WHERE id = v_req.profile_id;
  ELSIF NOT EXISTS (SELECT 1 FROM leave_ledger WHERE leave_request_id = p_leave_request_id) THEN
    SELECT id INTO v_type FROM leave_types WHERE tenant_id = v_req.tenant_id AND name = v_req.leave_type LIMIT 1;
    IF v_type IS NOT NULL THEN
      -- trg_leave_ledger_half_day cuts a half-day request's line to -0.5.
      INSERT INTO leave_ledger (tenant_id, profile_id, leave_type_id, entry_type, days, effective_date, leave_request_id, created_by)
      VALUES (v_req.tenant_id, v_req.profile_id, v_type, 'Deduction', -((v_req.end_date - v_req.start_date) + 1),
              v_req.start_date, p_leave_request_id, auth.uid());
    END IF;
  END IF;

  INSERT INTO leave_approval_effects (leave_request_id, tenant_id, profile_id, comp_off_days, applied_by)
  VALUES (p_leave_request_id, v_req.tenant_id, v_req.profile_id, v_comp, auth.uid());
END;
$function$;

-- ---------------------------------------------------------------------------
-- HR: give the leave day back (approve) or keep it as leave (reject).
CREATE OR REPLACE FUNCTION public.hr_decide_leave_worked_day(p_id uuid, p_approve boolean, p_note text DEFAULT '')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_w        leave_worked_days%ROWTYPE;
  v_req      leave_requests%ROWTYPE;
  v_att      RECORD;
  v_today    date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_days     numeric := 0;
  v_deducted numeric := 0;
  v_given    numeric := 0;
  v_type     uuid;
  v_type_name text;
  v_ledger   uuid;
  v_after    numeric;
  v_note     text := COALESCE(left(trim(p_note), 500), '');
  v_prev     text;
  v_what     text;
BEGIN
  SELECT * INTO v_w FROM leave_worked_days WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM profiles
     WHERE id = auth.uid() AND (role = 'superadmin' OR (tenant_id = v_w.tenant_id AND role = 'admin'))
  ) THEN
    RAISE EXCEPTION 'Only HR can decide this';
  END IF;
  IF v_w.status <> 'pending' THEN
    RAISE EXCEPTION 'Already %', CASE WHEN v_w.status = 'approved' THEN 'given back' ELSE 'kept as leave' END;
  END IF;

  SELECT * INTO v_req FROM leave_requests WHERE id = v_w.leave_request_id;
  SELECT a.id, a.status, a.total_hours INTO v_att
    FROM attendance a WHERE a.profile_id = v_w.profile_id AND a.date = v_w.date;
  v_type_name := CASE WHEN v_req.half_day IS NOT NULL THEN 'half-day ' ELSE '' END
                 || COALESCE(NULLIF(v_req.leave_type, ''), 'leave');

  IF p_approve THEN
    IF v_w.date >= v_today THEN
      RAISE EXCEPTION 'The day is not over yet — decide it from tomorrow';
    END IF;
    IF v_att.id IS NULL OR v_req.status IS DISTINCT FROM 'Approved'
       OR NOT leave_day_worked(v_w.profile_id, v_w.date, v_att.id) THEN
      RAISE EXCEPTION 'There is no approved punch on this day any more — keep it as leave';
    END IF;

    IF v_att.status = 'Leave' THEN
      v_prev := current_setting('app.punch_review', true);
      PERFORM set_config('app.punch_review', 'on', true);
      UPDATE attendance SET total_hours = total_hours WHERE id = v_att.id;
      PERFORM set_config('app.punch_review', COALESCE(v_prev, 'off'), true);
      SELECT a.id, a.status, a.total_hours INTO v_att FROM attendance a WHERE a.id = v_att.id;
    END IF;

    IF v_att.status IN ('Absent', 'Mispunch', 'Pending Approval', 'Leave') THEN
      RAISE EXCEPTION 'The day is % (% h) — not a working day. Fix the punches first, or keep it as leave',
        v_att.status, trim_scale(COALESCE(v_att.total_hours, 0));
    END IF;
    v_days := CASE WHEN v_att.status = 'Half Day' THEN 0.5 ELSE 1 END;
    -- Half-day leave: only a full day's hours means the leave half was worked.
    IF v_req.half_day IS NOT NULL THEN
      IF v_att.status NOT IN ('Present', 'Late')
         OR COALESCE(v_att.total_hours, 0) < leave_full_day_hours(v_w.profile_id) THEN
        RAISE EXCEPTION 'Only % h on a half-day leave, under a full day (% h): only their own half was worked. Keep it as leave',
          trim_scale(round(COALESCE(v_att.total_hours, 0), 2)), trim_scale(leave_full_day_hours(v_w.profile_id));
      END IF;
      v_days := 0.5;
    END IF;

    -- Never more than this request took off the balance.
    SELECT COALESCE(sum(refund_days), 0) INTO v_given
      FROM leave_worked_days WHERE leave_request_id = v_w.leave_request_id AND status = 'approved';

    IF v_req.leave_type = 'Comp Off' THEN
      SELECT COALESCE(comp_off_days, 0) INTO v_deducted FROM leave_approval_effects WHERE leave_request_id = v_req.id;
      v_days := GREATEST(0, LEAST(v_days, COALESCE(v_deducted, 0) - v_given));
      IF v_days > 0 THEN
        UPDATE profiles SET comp_off_balance = COALESCE(comp_off_balance, 0) + v_days
         WHERE id = v_w.profile_id
        RETURNING comp_off_balance INTO v_after;
        INSERT INTO comp_off_adjustments (tenant_id, profile_id, days, balance_after, note, created_by)
        VALUES (v_w.tenant_id, v_w.profile_id, v_days, v_after,
                'Leave given back: came in on ' || to_char(v_w.date, 'DD Mon YYYY')
                  || CASE WHEN v_note <> '' THEN ' — ' || v_note ELSE '' END,
                auth.uid());
      END IF;
    ELSE
      SELECT l.leave_type_id, -sum(l.days) INTO v_type, v_deducted
        FROM leave_ledger l JOIN leave_types t ON t.id = l.leave_type_id
       WHERE l.leave_request_id = v_req.id AND l.entry_type = 'Deduction' AND l.days < 0
         AND NOT COALESCE(t.is_unlimited, false)
       GROUP BY l.leave_type_id
       LIMIT 1;
      v_days := GREATEST(0, LEAST(v_days, COALESCE(v_deducted, 0) - v_given));
      IF v_type IS NOT NULL AND v_days > 0 THEN
        INSERT INTO leave_ledger (tenant_id, profile_id, leave_type_id, entry_type, days, effective_date, note, created_by)
        VALUES (v_w.tenant_id, v_w.profile_id, v_type, 'Allocation', v_days, v_w.date,
                'Leave given back: came in on ' || to_char(v_w.date, 'DD Mon YYYY')
                  || CASE WHEN v_note <> '' THEN ' — ' || v_note ELSE '' END,
                auth.uid())
        RETURNING id INTO v_ledger;
      ELSE
        v_days := 0;
      END IF;
    END IF;

    UPDATE leave_worked_days
       SET status = 'approved', refund_days = v_days, ledger_entry_id = v_ledger,
           decided_by = auth.uid(), decided_at = now(), note = NULLIF(v_note, '')
     WHERE id = v_w.id;

    v_what := CASE WHEN v_days > 0
      THEN format('HR gave %s day%s of %s back to your balance.', trim_scale(v_days),
                  CASE WHEN v_days = 1 THEN '' ELSE 's' END, v_type_name)
      ELSE 'It counts as a working day (no leave balance had been taken for it).' END;
    INSERT INTO app_notifications (tenant_id, profile_id, actor_id, type, title, body)
    VALUES (v_w.tenant_id, v_w.profile_id, auth.uid(), 'leave_worked_day_result',
            'Leave day given back',
            format('You came in on %s during your approved %s. %s', to_char(v_w.date, 'DD Mon'), v_type_name, v_what)
              || CASE WHEN v_note <> '' THEN ' Note: ' || left(v_note, 200) ELSE '' END);
  ELSE
    UPDATE leave_worked_days
       SET status = 'rejected', decided_by = auth.uid(), decided_at = now(), note = NULLIF(v_note, '')
     WHERE id = v_w.id;
    -- Back to 'Leave' (the attendance triggers now force it again; a
    -- half-day date turns back into 'Half Day', its hours kept).
    IF v_att.id IS NOT NULL THEN
      UPDATE attendance SET status = 'Leave', total_hours = 0 WHERE id = v_att.id;
    END IF;
    INSERT INTO app_notifications (tenant_id, profile_id, actor_id, type, title, body)
    VALUES (v_w.tenant_id, v_w.profile_id, auth.uid(), 'leave_worked_day_result',
            'Leave day kept as leave',
            format('You punched on %s during your approved %s. HR kept the leave, so it stays deducted.',
                   to_char(v_w.date, 'DD Mon'), v_type_name)
              || CASE WHEN v_note <> '' THEN ' Note: ' || left(v_note, 200) ELSE '' END);
  END IF;

  RETURN jsonb_build_object('status', CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END, 'refund_days', v_days);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.hr_decide_leave_worked_day(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hr_decide_leave_worked_day(uuid, boolean, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- HR list: one row per day, with the attendance and punches behind it.
CREATE OR REPLACE FUNCTION public.list_leave_worked_days(p_status text DEFAULT 'pending')
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_tenant uuid;
  v_role   text;
BEGIN
  SELECT tenant_id, role INTO v_tenant, v_role FROM profiles WHERE id = auth.uid();
  IF v_role IS DISTINCT FROM 'admin' AND v_role IS DISTINCT FROM 'superadmin' THEN
    RAISE EXCEPTION 'Only HR can see this';
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(row_to_json(x) ORDER BY x.status <> 'pending', x.date DESC, x.name)
    FROM (
      SELECT w.id, w.date, w.status, w.leave_type, w.refund_days, w.note, w.decided_at, w.created_at,
             w.profile_id, trim(concat_ws(' ', p.first_name, p.last_name)) AS name,
             p.employee_id, p.department, p.outlet_id,
             lr.start_date, lr.end_date, lr.reason, lr.half_day,
             a.status AS attendance_status, a.total_hours,
             (SELECT string_agg(left(pu.punch_time, 5) || ' ' || pu.punch_type, ', ' ORDER BY pu.punch_time)
                FROM punches pu WHERE pu.attendance_id = a.id AND pu.approval_status = 'approved') AS punches,
             trim(concat_ws(' ', d.first_name, d.last_name)) AS decided_by_name
        FROM leave_worked_days w
        JOIN profiles p ON p.id = w.profile_id
        JOIN leave_requests lr ON lr.id = w.leave_request_id
        LEFT JOIN attendance a ON a.profile_id = w.profile_id AND a.date = w.date
        LEFT JOIN profiles d ON d.id = w.decided_by
       WHERE w.tenant_id = v_tenant
         AND (p_status IS NULL OR p_status = 'all' OR w.status = p_status)
       ORDER BY w.date DESC
       LIMIT 500
    ) x
  ), '[]'::jsonb);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.list_leave_worked_days(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_leave_worked_days(text) TO authenticated;

-- ---------------------------------------------------------------------------
-- Backfill: days already punched under an approved full-day leave, from each
-- tenant's start date — re-scored and listed pending for HR.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT DISTINCT a.id
      FROM attendance a
      JOIN tenants t ON t.id = a.tenant_id AND t.leave_worked_day_from IS NOT NULL
      JOIN leave_requests lr ON lr.profile_id = a.profile_id AND lr.status = 'Approved' AND lr.half_day IS NULL
                            AND a.date BETWEEN lr.start_date AND lr.end_date
     WHERE a.date >= t.leave_worked_day_from
       AND EXISTS (SELECT 1 FROM punches pu WHERE pu.attendance_id = a.id AND pu.approval_status = 'approved')
  LOOP
    PERFORM register_leave_worked_day(r.id);
  END LOOP;

  -- Half-day leave dates with a full day's hours: re-score (they were held
  -- at 'Half Day'); the attendance trigger above lists them.
  PERFORM set_config('app.punch_review', 'on', true);
  UPDATE attendance a SET total_hours = a.total_hours
    FROM leave_requests lr, tenants t
   WHERE lr.profile_id = a.profile_id AND lr.status = 'Approved' AND lr.half_day IS NOT NULL
     AND lr.start_date = a.date AND t.id = a.tenant_id AND t.leave_worked_day_from IS NOT NULL
     AND a.date >= t.leave_worked_day_from
     AND COALESCE(a.total_hours, 0) >= leave_full_day_hours(a.profile_id)
     AND EXISTS (SELECT 1 FROM punches pu WHERE pu.attendance_id = a.id AND pu.approval_status = 'approved');
  PERFORM set_config('app.punch_review', 'off', true);
END $$;
