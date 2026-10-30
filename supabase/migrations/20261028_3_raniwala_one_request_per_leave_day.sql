-- Raniwala: one leave per day, and no regularize / punch request on a leave day.
--
-- 1. A second leave request for a day that already has one (Pending or
--    Approved) is refused. Two halves of the same day stay allowed
--    (trg_leave_half_day already checks half against half / full).
--    Approving a leave is also refused when an approved leave already covers
--    one of its days, so duplicates sent before this migration can't be
--    deducted twice (2026-10-26: EMP 707 RAMESH YADAV had two Comp Off
--    requests for 20 Oct approved, 2 comp offs taken).
-- 2. A regularize request is refused for a day with an approved full-day leave.
-- 3. A self-made app punch that needs manager approval ("punch request",
--    outlets.app_punch_needs_approval) is refused on an approved full-day
--    leave day. Device (ESSL) punches still go in: the day is scored from the
--    punches and HR decides on giving the leave back (20261024_6
--    leave_worked_days / hr_decide_leave_worked_day). App punches that need no
--    approval (B2B) follow the same worked-day route.
-- Only tenants with tenants.one_request_per_leave_day (Raniwala) are touched.

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS one_request_per_leave_day boolean NOT NULL DEFAULT false;

UPDATE public.tenants SET one_request_per_leave_day = true
 WHERE id = '123c949a-329f-4a48-bb25-eed41a390cf4';

-- Approved full-day leave covering the date, if any.
CREATE OR REPLACE FUNCTION public.approved_full_day_leave_on(p_profile_id uuid, p_date date)
RETURNS text
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT lr.leave_type
    FROM leave_requests lr
   WHERE lr.profile_id = p_profile_id
     AND lr.status = 'Approved'
     AND lr.half_day IS NULL
     AND p_date BETWEEN lr.start_date AND lr.end_date
   ORDER BY lr.created_at
   LIMIT 1;
$$;

-- 1. Leave: one request per day.
CREATE OR REPLACE FUNCTION public.trg_leave_one_request_per_day()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_moved     boolean;
  v_approving boolean;
  v_other     record;
  v_day       date;
BEGIN
  IF NEW.status = 'Rejected'
     OR NOT COALESCE((SELECT one_request_per_leave_day FROM tenants WHERE id = NEW.tenant_id), false) THEN
    RETURN NEW;
  END IF;

  v_moved := TG_OP = 'INSERT'
     OR NEW.start_date IS DISTINCT FROM OLD.start_date
     OR NEW.end_date IS DISTINCT FROM OLD.end_date
     OR NEW.half_day IS DISTINCT FROM OLD.half_day;
  v_approving := TG_OP = 'UPDATE' AND NEW.status = 'Approved' AND OLD.status IS DISTINCT FROM 'Approved';
  IF NOT v_moved AND NOT v_approving THEN
    RETURN NEW;
  END IF;

  -- New or moved request: clashes with any open or approved one.
  -- Approval only: clashes with an approved one (of a duplicate pending pair
  -- one can still be approved).
  SELECT lr.leave_type, lr.status, lr.start_date, lr.end_date INTO v_other
    FROM leave_requests lr
   WHERE lr.profile_id = NEW.profile_id
     AND lr.id <> NEW.id
     AND (CASE WHEN v_moved THEN lr.status <> 'Rejected' ELSE lr.status = 'Approved' END)
     AND lr.start_date <= NEW.end_date AND lr.end_date >= NEW.start_date
     AND NOT (lr.half_day IS NOT NULL AND NEW.half_day IS NOT NULL AND lr.half_day <> NEW.half_day)
   ORDER BY lr.start_date
   LIMIT 1;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  v_day := GREATEST(v_other.start_date, NEW.start_date);
  IF v_other.status = 'Approved' AND v_approving THEN
    RAISE EXCEPTION '% already has an approved % leave on %. This request is a duplicate -- reject it instead.',
      (SELECT trim(first_name || ' ' || COALESCE(last_name, '')) FROM profiles WHERE id = NEW.profile_id),
      v_other.leave_type, to_char(v_day, 'DD Mon YYYY')
      USING ERRCODE = 'check_violation';
  END IF;
  RAISE EXCEPTION 'A leave request (%, %) is already there for %. You can send only one leave for a day.',
    v_other.leave_type, v_other.status, to_char(v_day, 'DD Mon YYYY')
    USING ERRCODE = 'check_violation';
END;
$$;

DROP TRIGGER IF EXISTS trg_leave_one_request_per_day ON public.leave_requests;
CREATE TRIGGER trg_leave_one_request_per_day
  BEFORE INSERT OR UPDATE OF start_date, end_date, half_day, status ON public.leave_requests
  FOR EACH ROW EXECUTE FUNCTION public.trg_leave_one_request_per_day();

-- 2. Regularize: not on a leave day.
CREATE OR REPLACE FUNCTION public.trg_regularize_not_on_leave()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_leave text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.date IS NOT DISTINCT FROM OLD.date THEN
    RETURN NEW;
  END IF;
  IF NOT COALESCE((SELECT one_request_per_leave_day FROM tenants WHERE id = NEW.tenant_id), false) THEN
    RETURN NEW;
  END IF;

  v_leave := approved_full_day_leave_on(NEW.profile_id, NEW.date);
  IF v_leave IS NOT NULL THEN
    RAISE EXCEPTION 'You are on leave (%) on %, so a regularization can''t be sent for that day.',
      v_leave, to_char(NEW.date, 'DD Mon YYYY')
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_regularize_not_on_leave ON public.regularize_requests;
CREATE TRIGGER trg_regularize_not_on_leave
  BEFORE INSERT OR UPDATE OF date ON public.regularize_requests
  FOR EACH ROW EXECUTE FUNCTION public.trg_regularize_not_on_leave();

-- 3. Punch request (app punch held for approval): not on a leave day.
CREATE OR REPLACE FUNCTION public.trg_punch_not_on_leave()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_profile uuid;
  v_tenant  uuid;
  v_date    date;
  v_leave   text;
BEGIN
  IF NEW.source IS DISTINCT FROM 'app'
     OR auth.uid() IS NULL
     OR current_setting('app.regularize_apply', true) = 'on' THEN
    RETURN NEW;
  END IF;

  SELECT profile_id, tenant_id, date INTO v_profile, v_tenant, v_date
    FROM attendance WHERE id = NEW.attendance_id;
  IF v_profile IS DISTINCT FROM auth.uid()
     OR NOT profile_app_punch_needs_approval(v_profile)
     OR NOT COALESCE((SELECT one_request_per_leave_day FROM tenants WHERE id = v_tenant), false) THEN
    RETURN NEW;
  END IF;

  v_leave := approved_full_day_leave_on(v_profile, v_date);
  IF v_leave IS NOT NULL THEN
    RAISE EXCEPTION 'You are on leave (%) on %, so a punch request can''t be sent for that day. If you came to work, punch on the office device -- HR will decide on giving the leave back.',
      v_leave, to_char(v_date, 'DD Mon YYYY')
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_punch_not_on_leave ON public.punches;
CREATE TRIGGER trg_punch_not_on_leave
  BEFORE INSERT ON public.punches
  FOR EACH ROW EXECUTE FUNCTION public.trg_punch_not_on_leave();
