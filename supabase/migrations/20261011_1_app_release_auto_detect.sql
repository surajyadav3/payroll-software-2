-- CrewCore app: detect a new store release by itself, so the "Update
-- available" prompt (app_releases, 20260927_1) no longer depends on someone
-- remembering to bump latest_version after each release. It was still at
-- 1.1.19 on 2026-10-11 while 2.0.5 was live in both stores, so nobody on an
-- old build was being prompted.
--
-- How it works: an install running a version ABOVE app_releases.latest_version
-- calls report_app_version() once per app open (installs at or below it never
-- call, so this costs nothing once the row is current). When 3 different
-- employees have reported the same newer version on a platform, it is treated
-- as live in that store and latest_version moves up to it; every older install
-- then shows the prompt on its next open. Three people keeps one tester, an
-- App Review account or a single sideloaded APK from triggering it.
--
-- Manual bumps still work exactly as before (see 20260927_1).

-- '2.1' and '2.1.0' compare equal; non-numeric parts never reach here.
create or replace function public.app_version_parts(p_version text)
returns int[]
language sql
immutable
as $$
  select (string_to_array(p_version, '.')::int[] || array[0, 0, 0, 0])[1:4];
$$;

create table if not exists public.app_release_sightings (
  platform   text not null check (platform in ('android', 'ios')),
  version    text not null,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  seen_at    timestamptz not null default now(),
  primary key (platform, version, profile_id)
);

-- Written only by report_app_version (security definer); no client access.
alter table public.app_release_sightings enable row level security;
revoke all on public.app_release_sightings from anon, authenticated;

create or replace function public.report_app_version(p_platform text, p_version text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_latest text;
  v_seen   int;
begin
  if auth.uid() is null
     or p_platform not in ('android', 'ios')
     or p_version !~ '^\d{1,4}(\.\d{1,4}){0,3}$' then
    return;
  end if;

  select latest_version into v_latest from app_releases where platform = p_platform;
  if v_latest is null or app_version_parts(p_version) <= app_version_parts(v_latest) then
    return;
  end if;

  insert into app_release_sightings (platform, version, profile_id)
  values (p_platform, p_version, auth.uid())
  on conflict do nothing;

  select count(*) into v_seen
    from app_release_sightings
   where platform = p_platform and version = p_version;

  if v_seen >= 3 then
    update app_releases
       set latest_version = p_version, updated_at = now()
     where platform = p_platform
       and app_version_parts(latest_version) < app_version_parts(p_version);
    delete from app_release_sightings
     where platform = p_platform
       and app_version_parts(version) <= app_version_parts(p_version);
  end if;
end;
$$;

revoke all on function public.report_app_version(text, text) from public, anon;
grant execute on function public.report_app_version(text, text) to authenticated;

-- 2.0.5 is live on the Play Store and the App Store (checked 2026-10-11).
-- Only ever moves the row up.
update public.app_releases
   set latest_version = '2.0.5', updated_at = now()
 where platform in ('android', 'ios')
   and public.app_version_parts(latest_version) < public.app_version_parts('2.0.5');
