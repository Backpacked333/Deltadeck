-- Profile pictures. A player uploads one square WebP to the public `avatars`
-- bucket as <their user id>.webp; the browser resizes it first (256 px,
-- src/lib/avatar.ts), so the 1 MB cap is far above any real upload. Pictures
-- go live at once, without review: anyone signed in can report one, and an
-- operator reads the reports in the dashboard.
--
-- players.avatar_version is null when a player has no picture, and otherwise
-- a number the browser picks on each upload. It goes in the picture's URL
-- (?v=<n>), so a new picture is never hidden by a cached old one. Players
-- may write it on their own row like username, country and bio (the column
-- grant and players_update_own policy of 20261008133809_players.sql); the
-- check below keeps it a value the Worker accepts. set_avatar and
-- remove_avatar are that write by name, as the player (security invoker,
-- like clear_learning_progress: no browser-callable security definer).
--
-- Additive: a bucket, its policies, a column, a table and three functions.
--
-- Rollback (forgets every picture and report; the files stay in the bucket
-- until deleted from the dashboard):
--   drop function public.set_avatar(integer), public.remove_avatar(),
--     public.report_avatar(uuid);
--   drop table public.avatar_reports;
--   revoke update (avatar_version) on public.players from authenticated;
--   alter table public.players drop column avatar_version;
--   drop policy avatars_read on storage.objects;
--   drop policy avatars_insert_own on storage.objects;
--   drop policy avatars_update_own on storage.objects;
--   drop policy avatars_delete_own on storage.objects;
--   delete from supabase_migrations.schema_migrations
--     where version = '20261012000000';
set local lock_timeout = '5s';

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 1048576, array['image/webp'])
on conflict (id) do nothing;

-- Anyone may read a picture (the bucket is public, so its URLs work without
-- these too); a signed-in player writes only the one object named after them.
create policy avatars_read on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'avatars');
create policy avatars_insert_own on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and name = (select auth.uid())::text || '.webp');
create policy avatars_update_own on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and name = (select auth.uid())::text || '.webp')
  with check (bucket_id = 'avatars' and name = (select auth.uid())::text || '.webp');
create policy avatars_delete_own on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and name = (select auth.uid())::text || '.webp');

alter table public.players
  add column avatar_version integer
    check (avatar_version is null or avatar_version between 1 and 1000000000);
grant update (avatar_version) on public.players to authenticated;

-- The caller's picture is now the one uploaded with this version.
create function public.set_avatar(p_version integer) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if p_version is null or p_version not between 1 and 1000000000 then
    raise exception 'bad avatar version' using errcode = '22023';
  end if;
  update public.players set avatar_version = p_version
  where user_id = auth.uid();
end $$;
revoke all on function public.set_avatar(integer) from public, anon;
grant execute on function public.set_avatar(integer) to authenticated;

-- The caller has no picture. The file itself is deleted by the browser.
create function public.remove_avatar() returns void
language plpgsql security invoker set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  update public.players set avatar_version = null
  where user_id = auth.uid();
end $$;
revoke all on function public.remove_avatar() from public, anon;
grant execute on function public.remove_avatar() to authenticated;

-- One row per reporter, player and day: reporting the same picture again
-- the same day adds nothing. A player may only add reports in their own
-- name, and nobody reads them through the API (an operator does, in the
-- dashboard).
create table public.avatar_reports (
  reporter uuid not null references public.players (user_id) on delete cascade,
  player uuid not null references public.players (user_id) on delete cascade,
  day date not null default current_date,
  created_at timestamptz not null default now(),
  primary key (reporter, player, day),
  check (reporter <> player)
);
create index avatar_reports_player on public.avatar_reports (player, created_at desc);
alter table public.avatar_reports enable row level security;
revoke all on public.avatar_reports from anon, authenticated;
grant insert on public.avatar_reports to authenticated;
create policy avatar_reports_insert_own on public.avatar_reports
  for insert to authenticated
  with check (reporter = (select auth.uid()) and player <> reporter);

create function public.report_avatar(p_player uuid) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if p_player is null or p_player = auth.uid() then
    raise exception 'cannot report this picture' using errcode = '22023';
  end if;
  insert into public.avatar_reports (reporter, player)
  select auth.uid(), p.user_id from public.players p
  where p.user_id = p_player and p.avatar_version is not null
  on conflict do nothing;
end $$;
revoke all on function public.report_avatar(uuid) from public, anon;
grant execute on function public.report_avatar(uuid) to authenticated;
