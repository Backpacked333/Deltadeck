-- Practice history on the account: every hand a signed-in player plays
-- against Atlas, and their trainer settings and lesson progress, so they
-- follow the player from device to device and can feed a personal history
-- later. The browser writes these rows itself, under row-level security: a
-- player reaches only their own rows, and nothing here is public. Deleting
-- the account deletes them.
--
-- Additive: two new tables and two trigger functions; nothing existing
-- changes. The earlier app's learning tables (20261007192620) stay unused
-- and untouched.
--
-- Rollback (deletes every stored practice hand and learning state):
--   drop table public.practice_hands, public.learning_state;
--   drop function private.practice_hands_guard(), private.learning_state_newer();
--   delete from supabase_migrations.schema_migrations
--     where version = '20261011100000';
--
-- Locks: the foreign keys to auth.users take a brief share lock on it (it
-- blocks sign-ups for the milliseconds the empty tables take to create). A
-- lock still queued after 5 s fails the migration instead; it is re-run.
set local lock_timeout = '5s';

-- One row per practice hand, keyed by the id the browser gave it. `record`
-- is the browser's HandRecord (src/lib/storage.ts) as it stands, at most
-- 8 KB (a long hand's is about 3 KB), and must carry the same id.
create table public.practice_hands (
  user_id uuid not null references auth.users (id) on delete cascade,
  id text not null check (char_length(id) between 1 and 120),
  played_at timestamptz not null,
  record jsonb not null check (
    jsonb_typeof(record) = 'object'
    and octet_length(record::text) <= 8192
    and record ->> 'id' = id
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);
-- A player's latest hands first (the pull on sign-in, a history page).
create index practice_hands_recent
  on public.practice_hands (user_id, played_at desc);
-- New hands in the last day (the daily cap below).
create index practice_hands_created
  on public.practice_hands (user_id, created_at);

-- One row per player: the trainer's settings, lessons and flags (jsonb, at
-- most 8 KB) and the curriculum's saved document, kept as the exact text the
-- browser stored (text, not jsonb, which would reorder its keys), each with
-- the time the browser changed it. hands_cleared_at is when the player last
-- cleared their practice history, so no device brings older hands back.
create table public.learning_state (
  user_id uuid primary key references auth.users (id) on delete cascade,
  trainer jsonb check (
    trainer is null
    or (jsonb_typeof(trainer) = 'object' and octet_length(trainer::text) <= 8192)
  ),
  trainer_updated_at timestamptz,
  curriculum text check (curriculum is null or octet_length(curriculum) <= 1200000),
  curriculum_updated_at timestamptz,
  hands_cleared_at timestamptz,
  updated_at timestamptz not null default now()
);

-- Writes from the browser are checked here, as the player (security
-- invoker, so the count below sees only their own rows):
-- - created_at is the server's, and never changes;
-- - a hand cannot be dated in the future;
-- - a graded hand is never replaced by its provisional record (graded
--   false: saved before its decisions were graded), which an older device
--   still holding that copy could send;
-- - at most 1,000 new hands per player per day. Updates to hands already
--   stored are always allowed: an upsert of an existing id passes.
create function private.practice_hands_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  new.played_at := least(new.played_at, now());
  if tg_op = 'UPDATE' then
    new.created_at := old.created_at;
    if (old.record ->> 'graded') is distinct from 'false'
       and new.record ->> 'graded' = 'false' then
      new.record := old.record;
      new.played_at := old.played_at;
    end if;
    return new;
  end if;
  new.created_at := now();
  if not exists (
       select 1 from public.practice_hands
       where user_id = new.user_id and id = new.id)
     and (select count(*) from public.practice_hands
          where user_id = new.user_id
            and created_at > now() - interval '1 day') >= 1000 then
    raise exception 'practice hand limit reached for today'
      using errcode = '54000';
  end if;
  return new;
end $$;
revoke all on function private.practice_hands_guard()
  from public, anon, authenticated;
create trigger practice_hands_guard
  before insert or update on public.practice_hands
  for each row execute function private.practice_hands_guard();

-- Two devices can save at once: each document keeps the newer of what is
-- stored and what arrives, by the time the browser changed it, and the
-- history's clear time only moves forward.
create function private.learning_state_newer() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.trainer_updated_at is not null
     and (new.trainer_updated_at is null
          or new.trainer_updated_at < old.trainer_updated_at) then
    new.trainer := old.trainer;
    new.trainer_updated_at := old.trainer_updated_at;
  end if;
  if old.curriculum_updated_at is not null
     and (new.curriculum_updated_at is null
          or new.curriculum_updated_at < old.curriculum_updated_at) then
    new.curriculum := old.curriculum;
    new.curriculum_updated_at := old.curriculum_updated_at;
  end if;
  new.hands_cleared_at := greatest(old.hands_cleared_at, new.hands_cleared_at);
  new.updated_at := now();
  return new;
end $$;
revoke all on function private.learning_state_newer()
  from public, anon, authenticated;
create trigger learning_state_newer
  before update on public.learning_state
  for each row execute function private.learning_state_newer();

-- Strictly per owner. Practice hands can be deleted (clearing the history);
-- the learning state is only ever replaced.
alter table public.practice_hands enable row level security;
alter table public.learning_state enable row level security;
revoke all on public.practice_hands, public.learning_state from anon, authenticated;
grant select, insert, update, delete on public.practice_hands to authenticated;
grant select, insert, update on public.learning_state to authenticated;

create policy practice_hands_own_select on public.practice_hands
  for select to authenticated using ((select auth.uid()) = user_id);
create policy practice_hands_own_insert on public.practice_hands
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy practice_hands_own_update on public.practice_hands
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy practice_hands_own_delete on public.practice_hands
  for delete to authenticated using ((select auth.uid()) = user_id);

create policy learning_state_own_select on public.learning_state
  for select to authenticated using ((select auth.uid()) = user_id);
create policy learning_state_own_insert on public.learning_state
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy learning_state_own_update on public.learning_state
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
