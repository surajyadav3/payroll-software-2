-- 20261028_5 — Raniwala birthday card: HR download only, not posted (user, 2026-10-28).
--
-- 20261028_4 put HR's birthday card on the automatic Birthday post. The user does not want the
-- card released: HR adds the photo on Announcements > Birthday cards, downloads the card and shares
-- it on WhatsApp groups themselves. So the daily post goes back to the plain post every tenant had
-- before (same title/body, no card). Kept from 20261028_4: tenants.birthday_card (turns HR's tab on),
-- profiles.birthday_photo, the birthday-photos bucket, set_birthday_photo, announcements.card
-- (unused until the card is released), and the 29 Feb → 28 Feb fix for non-leap years.

CREATE OR REPLACE FUNCTION public.comms_post_birthdays() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_end timestamptz := ((v_today + 1)::timestamp AT TIME ZONE 'Asia/Kolkata');
  v_md text := to_char(v_today, 'MM-DD');
  -- 28 Feb in a non-leap year also covers 29 Feb birthdays.
  v_leap_md text := CASE WHEN v_md = '02-28' AND to_char(v_today + 1, 'MM-DD') = '03-01' THEN '02-29' END;
  n integer := 0;
BEGIN
  INSERT INTO announcements (tenant_id, created_by, title, body, kind, status, requires_ack, audience,
                             audience_outlets, expires_at, subject_profile_id, auto_key, department)
  SELECT p.tenant_id, NULL,
         'Happy birthday, ' || p.first_name || '!',
         'Wishing ' || trim(concat_ws(' ', p.first_name, p.last_name)) || ' a wonderful birthday and a great year ahead.',
         'birthday', 'published', false,
         CASE WHEN p.outlet_id IS NULL THEN 'all' ELSE 'outlets' END,
         CASE WHEN p.outlet_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[p.outlet_id] END,
         v_end, p.id, 'birthday:' || p.id || ':' || v_today, 'All'
  FROM profiles p
  JOIN tenants t ON t.id = p.tenant_id AND t.auto_birthday_posts
  LEFT JOIN profile_details pd ON pd.profile_id = p.id
  WHERE p.status = 'Active'
    AND COALESCE(p.date_of_birth, pd.date_of_birth) IS NOT NULL
    AND to_char(COALESCE(p.date_of_birth, pd.date_of_birth), 'MM-DD') IN (v_md, v_leap_md)
  ON CONFLICT (auto_key) WHERE auto_key IS NOT NULL DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION public.comms_post_birthdays() FROM public, anon, authenticated;
