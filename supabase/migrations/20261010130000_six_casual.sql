-- P2-03a: casual 6-max sessions in the archive (ADR amendment 2026-10-10,
-- "Players in the archive", "Sessions in the archive"). One matches row per
-- table session, whose players change while it plays: a player sits down
-- after hand 1, stands up, sits again in another seat, and a freed seat goes
-- to someone else. So match_players is keyed by account, not seat; seat is
-- the last seat the account held, and who held a seat in a given hand is
-- read from that hand's record.seats, never from here. Additive for
-- heads-up: one more kind, the same rows, and record_match / record_hand
-- write exactly what they wrote before for every heads-up payload.
--
-- Locks (DBA review in the commit). Both tables are locked in the order the
-- archive's writes lock them (matches, then match_players), so an archive
-- call waiting behind this migration cannot deadlock with it. A lock still
-- queued after 5 s fails the migration instead of holding up every reader
-- behind it; it is then simply re-run.
-- Rollback (only while no six-casual match is archived; delete those first,
-- which cascades to their players and hands):
--   alter table public.match_players
--     drop constraint match_players_pkey,
--     add constraint match_players_pkey primary key (match_id, seat),
--     add constraint match_players_match_id_user_id_key unique (match_id, user_id);
--   alter table public.matches drop constraint matches_kind_check,
--     add constraint matches_kind_check check (kind in ('hu-casual', 'hu-rated'));
--   then restore the functions: the record_match statement of
--   20261010043000_rematch.sql (v5) and the record_hand statement of
--   20261008134322_record_hand.sql (v1, as create or replace); and
--   delete from supabase_migrations.schema_migrations
--     where version = '20261010130000';
--   so a later db push does not treat this migration as applied.
set local lock_timeout = '5s';

-- The same NOT VALID then VALIDATE as rated_matches: matches is small, so
-- the scan under the drop's exclusive lock takes milliseconds.
alter table public.matches drop constraint matches_kind_check;
alter table public.matches
  add constraint matches_kind_check
  check (kind in ('hu-casual', 'hu-rated', 'six-casual'))
  not valid;
alter table public.matches validate constraint matches_kind_check;

-- The key moves from (match_id, seat) to (match_id, user_id), which was
-- already unique: no row can fail it, and the new index replaces the old
-- unique one under the same columns. One statement, so one exclusive lock
-- and one index build. match_id still leads the key, so the cascade from
-- matches and every per-match read (record_grades by seat, the hand_grades
-- policy, refresh_finished_match) keep an index; match_players_user and
-- match_players_history are untouched. (match_id, seat) is no longer
-- unique: two accounts can have held one seat in a session. Heads-up rows
-- still never share one, since both calls below take seats from payloads
-- that name the same two seats every time.
alter table public.match_players
  drop constraint match_players_pkey,
  drop constraint match_players_match_id_user_id_key,
  add constraint match_players_pkey primary key (match_id, user_id);

-- v6: exactly v5 (rematch), plus:
-- - every call to a match in play upserts its players by account, with the
--   seat they hold now (v5 inserted on the first call only, so a player who
--   sat down later had no row). A heads-up call names the same two seats
--   every time, so its upsert writes nothing. Calls to a match that is over
--   still change nothing;
-- - six-casual: timeouts are keyed by account (a session total), nobody is
--   marked abandoned and no abandonments row is written. A seat may have had
--   several players in one session, and a six table forfeits nobody.
create or replace function public.record_match(p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_match uuid := (p ->> 'id')::uuid;
  v_status text;
  v_kind text;
  v_reason text := p -> 'result' ->> 'reason';
  v_final text;
  v_at timestamptz := now();
  v_six boolean;
begin
  -- One account twice would make the upsert below fail with 21000, which
  -- the Worker retries forever; 23505 is refused as data and parked.
  if (select count(*) <> count(distinct s ->> 'userId')
      from jsonb_array_elements(p -> 'players') s) then
    raise exception 'duplicate account in match %', v_match
      using errcode = '23505';
  end if;
  select status, kind into v_status, v_kind
  from public.matches where id = v_match for update;
  if v_status is null then
    -- v5: the rematch link, if its match is archived and finished.
    insert into public.matches (id, kind, status, config, rematch_of)
    values (v_match, p ->> 'kind', 'playing', p -> 'config',
      (select m.id from public.matches m
       where m.id = (p ->> 'rematchOf')::uuid
         and m.kind = 'hu-rated' and m.status = 'finished'));
    v_status := 'playing';
    v_kind := p ->> 'kind';
  end if;

  -- v6: on every call while the match plays, not just the first.
  if v_status = 'playing' then
    insert into public.match_players as mp (match_id, user_id, seat)
    select v_match, (s ->> 'userId')::uuid, (s ->> 'seat')::smallint
    from jsonb_array_elements(p -> 'players') s
    on conflict (match_id, user_id) do update set seat = excluded.seat
      where mp.seat <> excluded.seat;
  end if;

  if p -> 'result' is null or v_status <> 'playing' then
    return;
  end if;

  v_six := v_kind = 'six-casual';
  v_final := case when v_reason in ('engine_fault', 'no_show', 'abandoned')
    then 'void' else 'finished' end;
  -- v5: a link the first call could not make yet is made now.
  -- A six session's result also keeps its timeout totals by account, so a
  -- row a parked hand creates after the finish still gets its total.
  update public.matches
  set status = v_final, finished_at = v_at,
      result = case when v_six
        then p -> 'result' || jsonb_build_object('timeouts',
          coalesce(p -> 'timeouts', '{}'::jsonb))
        else p -> 'result' end,
      rematch_of = coalesce(rematch_of,
        (select m.id from public.matches m
         where m.id = (p ->> 'rematchOf')::uuid
           and m.kind = 'hu-rated' and m.status = 'finished'))
  where id = v_match;

  update public.match_players mp
  set timeouts = coalesce((p -> 'timeouts' ->> case when v_six
        then mp.user_id::text else mp.seat::text end)::smallint, 0),
      abandoned = not v_six and (
        coalesce(mp.seat::text = (p -> 'result' ->> 'forfeit'), false)
        or coalesce(p -> 'result' -> 'noShow' @> to_jsonb(mp.seat), false)
        or coalesce(p -> 'result' -> 'abandoned' @> to_jsonb(mp.seat), false)),
      finished_at = v_at,
      outcome = case when v_kind = 'hu-rated' and v_final = 'finished'
        then p -> 'result' -> 'outcomeBySeat' ->> mp.seat::text end,
      adjusted_chips = case when v_kind = 'hu-rated' and v_final = 'finished'
        then (p -> 'result' -> 'adjustedBySeat' ->> mp.seat::text)::double precision end
  where mp.match_id = v_match;

  -- A rated result missing a seat would archive as finished with a hole in
  -- it; refused instead (23502), so the Worker retries and then parks the
  -- call with an incident (S7-13).
  if v_kind = 'hu-rated' and v_final = 'finished' and exists (
    select 1 from public.match_players mp
    where mp.match_id = v_match
      and (mp.outcome is null or mp.adjusted_chips is null)
  ) then
    raise exception 'rated result incomplete for match %', v_match
      using errcode = '23502';
  end if;

  if v_six then
    return;
  end if;

  insert into public.abandonments (user_id, match_id, hand_no, kind)
  select mp.user_id, v_match, (p ->> 'handNo')::integer, 'timeout_x3'
  from public.match_players mp
  where mp.match_id = v_match and mp.seat::text = (p -> 'result' ->> 'forfeit');

  insert into public.abandonments (user_id, match_id, hand_no, kind)
  select mp.user_id, v_match, null, 'no_show'
  from public.match_players mp
  where mp.match_id = v_match
    and coalesce(p -> 'result' -> 'noShow' @> to_jsonb(mp.seat), false);

  insert into public.abandonments (user_id, match_id, hand_no, kind)
  select mp.user_id, v_match, (p ->> 'handNo')::integer, 'leave_mid_hand'
  from public.match_players mp
  where mp.match_id = v_match
    and coalesce(p -> 'result' -> 'abandoned' @> to_jsonb(mp.seat), false);
end $$;

revoke all on function public.record_match(jsonb) from public, anon, authenticated;
grant execute on function public.record_match(jsonb) to service_role;

-- v2: exactly v1 (record_hand), plus every account dealt into the hand
-- (record.seats) gets its row first, at the seat it held in this hand, so
-- the net of a player who sat down after the session's last record_match
-- call is added instead of silently dropped. A heads-up hand names the two
-- seats its match was created with, so this writes nothing there. A retry
-- of a hand already archived returns above and moves no seat back.
create or replace function public.record_hand(p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_hand text := p ->> 'id';
  v_match uuid := (p ->> 'matchId')::uuid;
begin
  -- As in record_match: refused as data (23505), never retried forever.
  if (select count(*) <> count(distinct s ->> 'userId')
      from jsonb_array_elements(p -> 'record' -> 'seats') s) then
    raise exception 'duplicate account in hand %', v_hand
      using errcode = '23505';
  end if;
  insert into public.hands (id, match_id, hand_no, segment, button, commitment, leaves, reveal, record)
  values (
    v_hand, v_match, (p ->> 'handNo')::integer, (p ->> 'segment')::smallint,
    (p ->> 'button')::smallint, p ->> 'commitment', decode(p ->> 'leaves', 'base64'),
    p -> 'reveal', p -> 'record')
  on conflict (id) do nothing;
  if not found then
    return;
  end if;

  insert into public.hands_private (hand_id, deck, secret, holes)
  values (
    v_hand,
    array(select jsonb_array_elements_text(p -> 'deck'))::smallint[],
    decode(p ->> 'secret', 'base64'),
    p -> 'holes');

  insert into public.hand_holes (hand_id, user_id, cards)
  select v_hand, (h ->> 'userId')::uuid,
         array(select jsonb_array_elements_text(h -> 'cards'))::smallint[]
  from jsonb_array_elements(p -> 'holesByUser') h;

  -- A hand parked and replayed after its session ended gives a new row the
  -- session's finish time, like every other row of a finished session.
  -- After the finish, a replayed hand only fills in a missing row (with
  -- the finish time and the session's timeout total) and never moves a
  -- seat: the finish recorded where everyone sat last.
  insert into public.match_players as mp
    (match_id, user_id, seat, finished_at, timeouts)
  select v_match, (s ->> 'userId')::uuid, (s ->> 'seat')::smallint,
         m.finished_at,
         coalesce((m.result -> 'timeouts' ->> (s ->> 'userId'))::smallint, 0)
  from jsonb_array_elements(p -> 'record' -> 'seats') s
  cross join (select finished_at, result from public.matches
              where id = v_match) m
  on conflict (match_id, user_id) do update set seat = excluded.seat
    where mp.seat <> excluded.seat and excluded.finished_at is null;

  update public.match_players mp
  set net_chips = mp.net_chips + n.value::integer
  from jsonb_each_text(p -> 'netByUser') n
  where mp.match_id = v_match and mp.user_id = n.key::uuid;
end $$;

revoke all on function public.record_hand(jsonb) from public, anon, authenticated;
grant execute on function public.record_hand(jsonb) to service_role;
