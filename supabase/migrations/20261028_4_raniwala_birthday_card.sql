-- 20261028_4 — Raniwala birthday card (user request 2026-10-28).
--
-- Raniwala's automatic Birthday post (comms_post_birthdays, 00:05 IST, posted to the person's
-- outlet, deleted at midnight by purge_past_celebrations) becomes HR's card: the pink balloon
-- template with "Dear <Name>," + the employee's photo. HR collects the photos and uploads them on
-- Announcements > Birthday cards; a photo is kept on the profile and used every year.
--
-- What is stored (no generated images — web and app draw the card from the template asset):
--   * tenants.birthday_card      — which card template the tenant uses ('raniwala'); NULL = plain post
--   * profiles.birthday_photo    — storage path of HR's photo, bucket birthday-photos/<tenant>/...
--   * announcements.card         — {template, name, photo} on that day's post
-- The name is the employee's given names (first + middle) in proper case: Raniwala names are stored
-- in capitals ("KHUSHBOO MEENA" → "Dear Khushboo,", "RAM KISHORE SHARMA" → "Dear Ram Kishore,").
-- The post's title and body carry the same words, so older app builds still show the greeting.
--
-- Also for every tenant: a 29 February birthday is posted on 28 February in non-leap years
-- (to_char MM-DD never matched it before).

-- ───────────────────────── 1. columns ─────────────────────────
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS birthday_card text;
ALTER TABLE public.tenants DROP CONSTRAINT IF EXISTS tenants_birthday_card_check;
ALTER TABLE public.tenants ADD CONSTRAINT tenants_birthday_card_check CHECK (birthday_card IS NULL OR birthday_card IN ('raniwala'));
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS birthday_photo text;
ALTER TABLE public.announcements ADD COLUMN IF NOT EXISTS card jsonb;

UPDATE public.tenants SET birthday_card = 'raniwala' WHERE company_name ILIKE '%Raniwala%';

-- ───────────────────────── 2. photo bucket ─────────────────────────
-- Private; HR (admin) uploads to <tenant>/..., anyone in the tenant can read (the card is shown to
-- the person's outlet). App/web compress to a ~600 px JPEG first, so 512 KB is plenty.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('birthday-photos', 'birthday-photos', false, 524288, ARRAY['image/jpeg'])
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "birthday-photos: tenant members can read" ON storage.objects;
CREATE POLICY "birthday-photos: tenant members can read" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'birthday-photos' AND (storage.foldername(name))[1] = (SELECT my_tenant_id())::text);

DROP POLICY IF EXISTS "birthday-photos: admin can upload" ON storage.objects;
CREATE POLICY "birthday-photos: admin can upload" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'birthday-photos' AND (storage.foldername(name))[1] = (SELECT my_tenant_id())::text
              AND (SELECT my_role()) IN ('admin', 'superadmin'));

DROP POLICY IF EXISTS "birthday-photos: admin can delete" ON storage.objects;
CREATE POLICY "birthday-photos: admin can delete" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'birthday-photos' AND (storage.foldername(name))[1] = (SELECT my_tenant_id())::text
         AND (SELECT my_role()) IN ('admin', 'superadmin'));

-- ───────────────────────── 3. HR sets / removes a photo ─────────────────────────
-- Saves the path on the profile and puts it on today's card if the birthday post is already up.
CREATE OR REPLACE FUNCTION public.set_birthday_photo(p_profile uuid, p_path text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant uuid := my_tenant_id();
BEGIN
  IF my_role() IS DISTINCT FROM 'admin' AND my_role() IS DISTINCT FROM 'superadmin' THEN
    RAISE EXCEPTION 'Only HR can set birthday photos.' USING ERRCODE = '42501';
  END IF;
  IF p_path IS NOT NULL AND split_part(p_path, '/', 1) IS DISTINCT FROM v_tenant::text THEN
    RAISE EXCEPTION 'The photo must be uploaded to your company folder.' USING ERRCODE = '22023';
  END IF;

  UPDATE profiles SET birthday_photo = p_path WHERE id = p_profile AND tenant_id = v_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Employee not found.' USING ERRCODE = 'P0002';
  END IF;

  UPDATE announcements
     SET card = jsonb_set(card, '{photo}', COALESCE(to_jsonb(p_path), 'null'::jsonb))
   WHERE tenant_id = v_tenant AND subject_profile_id = p_profile AND kind = 'birthday'
     AND card IS NOT NULL AND (expires_at IS NULL OR expires_at > now());
END;
$$;

REVOKE ALL ON FUNCTION public.set_birthday_photo(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.set_birthday_photo(uuid, text) TO authenticated;

-- ───────────────────────── 4. the daily post ─────────────────────────
-- Based on the live definition (20261008_1). Tenants without a card keep the old title/body.
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
                             audience_outlets, expires_at, subject_profile_id, auto_key, department, card)
  SELECT p.tenant_id, NULL,
         CASE WHEN t.birthday_card IS NULL THEN 'Happy birthday, ' || p.first_name || '!'
              ELSE 'Happy Birthday, ' || nm.given || '!' END,
         CASE WHEN t.birthday_card IS NULL
              THEN 'Wishing ' || trim(concat_ws(' ', p.first_name, p.last_name)) || ' a wonderful birthday and a great year ahead.'
              ELSE 'Dear ' || nm.given || E',\nWishing you a day filled with smiles and laughter. May happiness bloom in your heart all year long.\nHappy Birthday!' END,
         'birthday', 'published', false,
         CASE WHEN p.outlet_id IS NULL THEN 'all' ELSE 'outlets' END,
         CASE WHEN p.outlet_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[p.outlet_id] END,
         v_end, p.id, 'birthday:' || p.id || ':' || v_today, 'All',
         CASE WHEN t.birthday_card IS NOT NULL
              THEN jsonb_build_object('template', t.birthday_card, 'name', nm.given, 'photo', p.birthday_photo) END
  FROM profiles p
  JOIN tenants t ON t.id = p.tenant_id AND t.auto_birthday_posts
  LEFT JOIN profile_details pd ON pd.profile_id = p.id
  CROSS JOIN LATERAL (
    SELECT initcap(regexp_replace(trim(concat_ws(' ', NULLIF(trim(p.first_name), ''), NULLIF(trim(p.middle_name), ''))), '\s+', ' ', 'g')) AS given
  ) nm
  WHERE p.status = 'Active'
    AND COALESCE(p.date_of_birth, pd.date_of_birth) IS NOT NULL
    AND to_char(COALESCE(p.date_of_birth, pd.date_of_birth), 'MM-DD') IN (v_md, v_leap_md)
  ON CONFLICT (auto_key) WHERE auto_key IS NOT NULL DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION public.comms_post_birthdays() FROM public, anon, authenticated;
