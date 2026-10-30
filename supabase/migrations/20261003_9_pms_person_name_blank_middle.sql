-- =============================================================
-- PMS QA fix: profiles.middle_name defaults to '' (not NULL), and concat_ws
-- only skips NULLs, so every PMS name came out as "First  Last" (double
-- space) in notifications, validation messages and the workspace.
-- Signature, volatility and grants unchanged. Re-runnable.
-- =============================================================
CREATE OR REPLACE FUNCTION public.pms_person_name(p_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT NULLIF(btrim(concat_ws(' ', NULLIF(btrim(first_name), ''), NULLIF(btrim(middle_name), ''), NULLIF(btrim(last_name), ''))), '')
  FROM profiles WHERE id = p_id;
$$;
