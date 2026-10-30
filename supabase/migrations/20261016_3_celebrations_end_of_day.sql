-- 20261016_3 — Birthdays and work anniversaries are a same-day visual, not stored history.
--
-- Problem (2026-10-16): Raniwala HR still saw "Happy birthday, YUVRAJ!" (13 Oct) on the 16th. The
-- automatic birthday post had expired at midnight, but the row stayed — and HR sees every
-- announcement, expired ones included (Announcements > Manage on the web; the app's Notices list
-- did not filter expiry at all). The daily birthday bell notifications (send_birthday_notifications,
-- types birthday_employee / birthday_hr_reminder) were also kept forever: 40 rows since 25 Sep.
--
-- Rule from here on (web and app alike, because it lives in the DB):
--   * a Birthday announcement — automatic or posted by HR — always ends at midnight IST of its day;
--   * at midnight IST a small daily job deletes the day's birthday posts (their acknowledgements
--     cascade), the "announcement" notifications that pointed at them, and every birthday /
--     anniversary notification from an earlier day.
-- The Home "Celebrations" cards (list_upcoming_celebrations) already compute from today forward and
-- store nothing, so work anniversaries need no cleanup; the anniversary notification types are
-- purged too in case any are ever added.

-- ───────────────────────── 1. birthday posts end with their day ─────────────────────────
CREATE OR REPLACE FUNCTION public.trg_birthday_post_expiry() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_day date;
  v_end timestamptz;
BEGIN
  IF NEW.kind = 'birthday' THEN
    v_day := (COALESCE(NEW.publish_at, NEW.created_at, now()) AT TIME ZONE 'Asia/Kolkata')::date;
    v_end := ((v_day + 1)::timestamp AT TIME ZONE 'Asia/Kolkata');
    IF NEW.expires_at IS NULL OR NEW.expires_at > v_end THEN
      NEW.expires_at := v_end;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_announcements_birthday_expiry ON public.announcements;
CREATE TRIGGER trg_announcements_birthday_expiry
  BEFORE INSERT OR UPDATE OF kind, publish_at, expires_at ON public.announcements
  FOR EACH ROW EXECUTE FUNCTION public.trg_birthday_post_expiry();

-- ───────────────────────── 2. delete them once the day is over ─────────────────────────
CREATE OR REPLACE FUNCTION public.purge_past_celebrations() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_day_start timestamptz := (((now() AT TIME ZONE 'Asia/Kolkata')::date)::timestamp AT TIME ZONE 'Asia/Kolkata');
  v_posts integer := 0;
  v_links integer := 0;
  v_notes integer := 0;
BEGIN
  WITH gone AS (
    DELETE FROM announcements
    WHERE kind = 'birthday' AND expires_at IS NOT NULL AND expires_at <= now()
    RETURNING id
  ), links AS (
    DELETE FROM app_notifications n
    USING gone g
    WHERE n.type = 'announcement' AND n.related_id = g.id
    RETURNING n.id
  )
  SELECT (SELECT count(*) FROM gone), (SELECT count(*) FROM links) INTO v_posts, v_links;

  DELETE FROM app_notifications
  WHERE (type ILIKE 'birthday%' OR type ILIKE '%anniversar%')
    AND created_at < v_day_start;
  GET DIAGNOSTICS v_notes = ROW_COUNT;

  RETURN v_posts + v_links + v_notes;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_past_celebrations(), public.trg_birthday_post_expiry() FROM public, anon, authenticated;

-- 18:30 UTC = 00:00 IST, just before comms-birthday-posts (18:35 UTC) posts the new day's birthdays.
SELECT cron.unschedule('celebrations-purge')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'celebrations-purge');
SELECT cron.schedule('celebrations-purge', '30 18 * * *', $$ SELECT public.purge_past_celebrations(); $$);

-- ───────────────────────── 3. clean up what is already there ─────────────────────────
-- Any open-ended birthday post gets its end-of-day expiry (fires the trigger), then the purge runs.
UPDATE public.announcements SET expires_at = expires_at WHERE kind = 'birthday';
SELECT public.purge_past_celebrations();
