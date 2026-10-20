-- 20261020_1 — Sandwich rule: a weekly off between two leave days is a leave day.
--
-- User (2026-10-20), Raniwala: "if anyone applies leave then weekly off count
-- as leave day and balance deducts accordingly … for office weekly off is
-- sunday and for delhi monday is the weekoff". Holidays stay paid: "absent on
-- 1 oct, then holiday, then 3 oct absent = 2 absent because holiday is paid".
--
-- tenants.sandwich_rule_enabled was switched on for Raniwala by 20260917_2,
-- but no live function reads it any more: the record_leave_deduction rewrites
-- after 20260917_4 dropped the bridging (probed 2026-10-20 — no function body
-- mentions it). This puts the leave half back, now on the approval trigger
-- (20261016_1) so it runs whoever approves:
--
-- * When a full-day leave becomes Approved, walk from the day before it (and
--   the day after it) across the employee's off days — their outlet's weekly
--   off (Office / Factory Sunday, Delhi Monday), else the company's, and
--   holidays of their outlet — to the first working day. If ANOTHER Approved
--   full-day leave of theirs covers that working day, every WEEKLY OFF in the
--   run becomes a leave day: attendance 'Leave' and one day off a balance.
--   Holidays in the run are stepped over and stay paid.
-- * The day is charged to the first of the two leaves (this one, then the
--   other) whose type is paid and still has a day of balance — Comp Off from
--   profiles.comp_off_balance, any other type from its leave_ledger sum. If
--   neither can pay, the weekly off is unpaid (Loss of Pay in payroll).
-- * leave_sandwich_days keeps one row per bridged weekly off (paid or not),
--   which Run Payroll reads; it also makes the rule run once per date.
-- * A weekly off the employee actually worked is left alone.
-- * tenants.sandwich_rule_from: no bridging for dates before it. Raniwala
--   2026-10-01 (September is closed from HR's sheet, 20261010_6).
--
-- A request covering a weekly off itself (Sat–Mon in one request) already
-- counts every day of its range — unchanged.
--
-- The absence half — weekly off between two absent days is unpaid, a holiday
-- is not — has no DB side: there is no nightly absent sweep, an absent day
-- has no attendance row, so it is worked out by Run Payroll
-- (src/lib/paidDays.js) and the Master Report register.

ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS sandwich_rule_from date;
COMMENT ON COLUMN public.tenants.sandwich_rule_from IS
  'Sandwich rule applies to weekly offs on or after this date (NULL = no start limit). See 20261020_1.';

UPDATE public.tenants SET sandwich_rule_from = '2026-10-01'
 WHERE id = '123c949a-329f-4a48-bb25-eed41a390cf4';

CREATE TABLE IF NOT EXISTS public.leave_sandwich_days (
  profile_id         uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  date               date NOT NULL,
  tenant_id          uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  leave_request_id   uuid REFERENCES public.leave_requests(id) ON DELETE SET NULL,
  other_request_id   uuid REFERENCES public.leave_requests(id) ON DELETE SET NULL,
  charged_leave_type text,
  paid               boolean NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, date)
);
COMMENT ON TABLE public.leave_sandwich_days IS
  'Weekly offs counted as leave because approved leave sits on both sides (sandwich rule, 20261020_1). paid = false: no balance could pay it, Loss of Pay. Written only by apply_leave_sandwich.';

CREATE INDEX IF NOT EXISTS leave_sandwich_days_tenant_date_idx ON public.leave_sandwich_days (tenant_id, date);

ALTER TABLE public.leave_sandwich_days ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.leave_sandwich_days FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.leave_sandwich_days FROM authenticated;
GRANT SELECT ON public.leave_sandwich_days TO authenticated;

DROP POLICY IF EXISTS "leave_sandwich_days: own or HR can select" ON public.leave_sandwich_days;
CREATE POLICY "leave_sandwich_days: own or HR can select" ON public.leave_sandwich_days
  FOR SELECT TO authenticated
  USING (tenant_id = (SELECT my_tenant_id())
         AND (profile_id = (SELECT auth.uid()) OR (SELECT my_role()) = ANY (ARRAY['admin', 'superadmin'])));

-- 'holiday', 'weekly_off' or NULL (a working day) for this employee. Same
-- days as trg_comp_off_credit_from_hours and the web's dayTypeFor: outlet
-- weekly off → company weekly off → Sunday; holidays tenant-wide or of their
-- outlet, none for an outlet with holidays switched off. A holiday that falls
-- on the weekly off is 'holiday' here: a holiday is always paid.
CREATE OR REPLACE FUNCTION public.employee_off_day_kind(p_profile_id uuid, p_date date)
RETURNS text
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN COALESCE(o.holidays_enabled, true) AND EXISTS (
           SELECT 1 FROM holidays h
            WHERE h.tenant_id = p.tenant_id AND h.date = p_date
              AND (h.outlet_id IS NULL OR h.outlet_id = p.outlet_id))
      THEN 'holiday'
    WHEN EXTRACT(DOW FROM p_date)::int = ANY (COALESCE(
           NULLIF(o.weekly_off_days, '{}'::int[]),
           NULLIF(t.weekly_off_days::int[], '{}'::int[]),
           CASE WHEN t.weekly_off_day IS NOT NULL THEN ARRAY[t.weekly_off_day::int] END,
           ARRAY[0]))
      THEN 'weekly_off'
  END
  FROM profiles p
  JOIN tenants t ON t.id = p.tenant_id
  LEFT JOIN outlets o ON o.id = p.outlet_id
  WHERE p.id = p_profile_id;
$function$;

REVOKE ALL ON FUNCTION public.employee_off_day_kind(uuid, date) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.apply_leave_sandwich(p_leave_request_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_req     leave_requests%ROWTYPE;
  v_other   leave_requests%ROWTYPE;
  v_cand    leave_requests%ROWTYPE;
  v_enabled boolean;
  v_from    date;
  v_dir     int;
  v_day     date;
  v_kind    text;
  v_offs    date[];
  v_off     date;
  v_i       int;
  v_type    uuid;
  v_paid    boolean;
  v_balance numeric;
  v_charged text;
  v_ok      boolean;
BEGIN
  SELECT * INTO v_req FROM leave_requests WHERE id = p_leave_request_id;
  IF NOT FOUND OR v_req.status IS DISTINCT FROM 'Approved' OR v_req.half_day IS NOT NULL THEN RETURN; END IF;

  SELECT sandwich_rule_enabled, sandwich_rule_from INTO v_enabled, v_from
    FROM tenants WHERE id = v_req.tenant_id;
  IF NOT COALESCE(v_enabled, false) THEN RETURN; END IF;

  FOREACH v_dir IN ARRAY ARRAY[-1, 1] LOOP
    v_day := CASE WHEN v_dir < 0 THEN v_req.start_date - 1 ELSE v_req.end_date + 1 END;
    v_offs := '{}';
    v_kind := NULL;
    -- A run of off days is a weekly off plus a holiday or two at most; stop
    -- after a week so a misconfigured calendar can't loop.
    FOR v_i IN 1..7 LOOP
      v_kind := employee_off_day_kind(v_req.profile_id, v_day);
      EXIT WHEN v_kind IS NULL;
      IF v_kind = 'weekly_off' THEN v_offs := v_offs || v_day; END IF;
      v_day := v_day + v_dir;
    END LOOP;
    CONTINUE WHEN v_kind IS NOT NULL OR cardinality(v_offs) = 0;

    -- v_day is the first working day past the run.
    SELECT * INTO v_other FROM leave_requests
     WHERE profile_id = v_req.profile_id AND id <> v_req.id AND status = 'Approved'
       AND half_day IS NULL AND v_day BETWEEN start_date AND end_date
     ORDER BY created_at LIMIT 1;
    CONTINUE WHEN NOT FOUND;

    FOREACH v_off IN ARRAY v_offs LOOP
      CONTINUE WHEN v_from IS NOT NULL AND v_off < v_from;
      CONTINUE WHEN EXISTS (SELECT 1 FROM leave_sandwich_days WHERE profile_id = v_req.profile_id AND date = v_off);
      -- Came in on the weekly off: it was worked, not part of the leave.
      CONTINUE WHEN EXISTS (
        SELECT 1 FROM attendance
         WHERE profile_id = v_req.profile_id AND date = v_off
           AND (COALESCE(total_hours, 0) > 0 OR status NOT IN ('Absent', 'Leave')));

      v_charged := NULL;
      FOREACH v_cand IN ARRAY ARRAY[v_req, v_other] LOOP
        IF v_cand.leave_type = 'Comp Off' THEN
          UPDATE profiles SET comp_off_balance = comp_off_balance - 1
           WHERE id = v_req.profile_id AND COALESCE(comp_off_balance, 0) >= 1;
          v_ok := FOUND;
        ELSE
          SELECT id, is_paid INTO v_type, v_paid FROM leave_types
           WHERE tenant_id = v_req.tenant_id AND name = v_cand.leave_type LIMIT 1;
          v_ok := false;
          IF v_type IS NOT NULL AND v_paid IS NOT FALSE THEN
            SELECT COALESCE(sum(days), 0) INTO v_balance FROM leave_ledger
             WHERE profile_id = v_req.profile_id AND leave_type_id = v_type;
            IF v_balance >= 1 THEN
              INSERT INTO leave_ledger (tenant_id, profile_id, leave_type_id, entry_type, days, effective_date, leave_request_id, note, created_by)
              VALUES (v_req.tenant_id, v_req.profile_id, v_type, 'Deduction', -1, v_off, v_cand.id,
                      'Sandwich rule: weekly off ' || to_char(v_off, 'DD Mon YYYY') || ' between two leave days', auth.uid());
              v_ok := true;
            END IF;
          END IF;
        END IF;
        IF v_ok THEN
          v_charged := v_cand.leave_type;
          EXIT;
        END IF;
      END LOOP;

      INSERT INTO attendance (tenant_id, profile_id, date, status, total_hours, location)
      VALUES (v_req.tenant_id, v_req.profile_id, v_off, 'Leave', 0, 'Office')
      ON CONFLICT (profile_id, date) DO UPDATE SET status = 'Leave', total_hours = 0;

      INSERT INTO leave_sandwich_days (profile_id, date, tenant_id, leave_request_id, other_request_id, charged_leave_type, paid)
      VALUES (v_req.profile_id, v_off, v_req.tenant_id, v_req.id, v_other.id, v_charged, v_charged IS NOT NULL);
    END LOOP;
  END LOOP;
END;
$function$;

REVOKE ALL ON FUNCTION public.apply_leave_sandwich(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.trg_leave_sandwich()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM apply_leave_sandwich(NEW.id);
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.trg_leave_sandwich() FROM PUBLIC, anon, authenticated;

-- After zz_leave_approval_effects_* (trigger names fire in order), so the
-- leave's own days and ledger line are in place first. Same WHEN as those:
-- Raniwala derives status in a BEFORE trigger, so no column list.
DROP TRIGGER IF EXISTS zzz_leave_sandwich_ins ON public.leave_requests;
CREATE TRIGGER zzz_leave_sandwich_ins
  AFTER INSERT ON public.leave_requests
  FOR EACH ROW WHEN (NEW.status = 'Approved' AND NEW.half_day IS NULL)
  EXECUTE FUNCTION public.trg_leave_sandwich();

DROP TRIGGER IF EXISTS zzz_leave_sandwich_upd ON public.leave_requests;
CREATE TRIGGER zzz_leave_sandwich_upd
  AFTER UPDATE ON public.leave_requests
  FOR EACH ROW WHEN (NEW.status = 'Approved' AND OLD.status IS DISTINCT FROM 'Approved' AND NEW.half_day IS NULL)
  EXECUTE FUNCTION public.trg_leave_sandwich();

-- Backfill: leaves already approved that touch a date on or after the start.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT l.id FROM leave_requests l JOIN tenants t ON t.id = l.tenant_id
     WHERE t.sandwich_rule_enabled AND l.status = 'Approved' AND l.half_day IS NULL
       AND (t.sandwich_rule_from IS NULL OR l.end_date >= t.sandwich_rule_from - 7)
     ORDER BY l.start_date, l.created_at
  LOOP
    PERFORM apply_leave_sandwich(r.id);
  END LOOP;
END $$;
