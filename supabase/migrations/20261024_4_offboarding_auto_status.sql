-- 20261024_4: Offboarding — applied-on date, status follows the exit date,
-- employee goes Inactive after the exit date.
--
-- HR starts an offboarding today (applied_on = today, IST) and fills the exit
-- date = the employee's last day. From then on the status is not picked by
-- hand, it follows the dates:
--   * today <= exit_date  -> 'In Progress'  (still working their notice)
--   * today >  exit_date  -> 'Completed'    and the employee is set Inactive
--   * 'Cancelled' stays as HR set it.
-- A daily job at 00:15 IST moves every offboarding whose exit date has passed
-- to Completed. Starting one with an exit date already in the past completes
-- it at once. Moving the exit date into the future (or cancelling) a
-- Completed offboarding sets the employee Active again, unless another
-- Completed offboarding still covers them.
--
-- Rules live in the DB so the mobile app gets the same behaviour.

-- ── Applied-on date ──────────────────────────────────────────────────────
ALTER TABLE public.offboarding_processes
  ADD COLUMN IF NOT EXISTS applied_on date NOT NULL DEFAULT ((now() AT TIME ZONE 'Asia/Kolkata')::date);

COMMENT ON COLUMN public.offboarding_processes.applied_on IS
  'Date the offboarding was started / applied (IST). exit_date is the employee''s last day.';

-- Existing rows: the day they were created.
UPDATE public.offboarding_processes
SET applied_on = (created_at AT TIME ZONE 'Asia/Kolkata')::date
WHERE applied_on IS DISTINCT FROM (created_at AT TIME ZONE 'Asia/Kolkata')::date;

-- ── Status follows the exit date ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.trg_offboarding_auto_status()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM 'Cancelled' THEN
    NEW.status := CASE
      WHEN NEW.exit_date < (now() AT TIME ZONE 'Asia/Kolkata')::date THEN 'Completed'
      ELSE 'In Progress'
    END;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS offboarding_auto_status ON public.offboarding_processes;
CREATE TRIGGER offboarding_auto_status
  BEFORE INSERT OR UPDATE OF status, exit_date ON public.offboarding_processes
  FOR EACH ROW EXECUTE FUNCTION public.trg_offboarding_auto_status();

-- ── Completed -> employee Inactive (and back) ────────────────────────────
CREATE OR REPLACE FUNCTION public.trg_offboarding_profile_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.status = 'Completed' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'Completed') THEN
    UPDATE profiles SET status = 'Inactive'
    WHERE id = NEW.profile_id AND status = 'Active';
  ELSIF TG_OP = 'UPDATE' AND OLD.status = 'Completed' AND NEW.status <> 'Completed'
        AND NOT EXISTS (
          SELECT 1 FROM offboarding_processes
          WHERE profile_id = NEW.profile_id AND id <> NEW.id AND status = 'Completed'
        ) THEN
    UPDATE profiles SET status = 'Active'
    WHERE id = NEW.profile_id AND status = 'Inactive';
  END IF;
  RETURN NULL;
END;
$$;

-- exit_date is listed too: an exit-date edit changes status through the
-- BEFORE trigger, and a column-list trigger only sees columns in the SET.
DROP TRIGGER IF EXISTS offboarding_profile_status ON public.offboarding_processes;
CREATE TRIGGER offboarding_profile_status
  AFTER INSERT OR UPDATE OF status, exit_date ON public.offboarding_processes
  FOR EACH ROW EXECUTE FUNCTION public.trg_offboarding_profile_status();

-- ── Daily: complete every offboarding whose exit date has passed ─────────
CREATE OR REPLACE FUNCTION public.offboarding_complete_due()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_n integer;
BEGIN
  UPDATE offboarding_processes SET status = 'Completed'
  WHERE status = 'In Progress' AND exit_date < (now() AT TIME ZONE 'Asia/Kolkata')::date;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

REVOKE ALL ON FUNCTION public.offboarding_complete_due() FROM PUBLIC, anon, authenticated;

-- 18:45 UTC = 00:15 IST.
SELECT cron.unschedule('offboarding-complete-due')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'offboarding-complete-due');
SELECT cron.schedule('offboarding-complete-due', '45 18 * * *', $$ SELECT public.offboarding_complete_due(); $$);

-- ── Existing rows ────────────────────────────────────────────────────────
SELECT public.offboarding_complete_due();

-- Completed before this migration but the employee was left Active.
UPDATE public.profiles p SET status = 'Inactive'
WHERE p.status = 'Active'
  AND EXISTS (
    SELECT 1 FROM public.offboarding_processes o
    WHERE o.profile_id = p.id AND o.status = 'Completed'
      AND o.exit_date < (now() AT TIME ZONE 'Asia/Kolkata')::date
  );
