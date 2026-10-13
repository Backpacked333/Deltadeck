-- When each hand was played (audit F13). `hands.created_at` is when the
-- archive received a hand, and the table's outbox can deliver an old hand
-- late (an outage, a parked call replayed): "the latest 500 decisions" and
-- the luck chart took such a hand for new play and pushed real new play out
-- of their windows. The table now sends its own clock at the hand's end as
-- `playedAt`; hands archived before this keep a null and are ordered by
-- arrival, as before.

alter table public.hands add column played_at timestamptz;

-- record_hand as in *_six_casual.sql, plus played_at. A time ahead of the
-- database's clock (skew) is taken as now; a call without one (queued by a
-- table from before this migration) leaves it null.
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
  insert into public.hands (id, match_id, hand_no, segment, button, commitment, leaves, reveal, record, played_at)
  values (
    v_hand, v_match, (p ->> 'handNo')::integer, (p ->> 'segment')::smallint,
    (p ->> 'button')::smallint, p ->> 'commitment', decode(p ->> 'leaves', 'base64'),
    p -> 'reveal', p -> 'record',
    case when p ? 'playedAt'
      then least((p ->> 'playedAt')::timestamptz, now()) end)
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

-- player_accuracy as in *_accuracy.sql, ordered by when the hands were
-- played. Ties (and hands without a time) keep the old order.
create or replace function private.player_accuracy(p_user uuid, p_format text default 'hu-duplicate')
returns table (accuracy real, graded integer, best integer, good integer,
               inaccuracy integer, mistake integer, blunder integer)
language sql stable set search_path = '' as $$
  select avg(l.accuracy)::real, count(*)::int,
         count(*) filter (where l.grade = 'best')::int,
         count(*) filter (where l.grade = 'good')::int,
         count(*) filter (where l.grade = 'inaccuracy')::int,
         count(*) filter (where l.grade = 'mistake')::int,
         count(*) filter (where l.grade = 'blunder')::int
  from (
    select g.accuracy, g.grade from public.hand_grades g
    join public.hands h on h.id = g.hand_id
    join public.matches m on m.id = h.match_id
    where g.user_id = p_user and g.format = p_format and m.status <> 'playing'
    order by coalesce(h.played_at, h.created_at) desc, h.match_id,
             h.hand_no desc, g.idx desc
    limit 500
  ) l
$$;
revoke all on function private.player_accuracy(uuid, text) from public, anon, authenticated;

-- Every stored accuracy is recomputed in the new order once.
select private.refresh_accuracy(a.user_id, a.format) from public.accuracy a;

-- rated_luck as in *_accuracy.sql, in the order the hands were played.
create or replace function public.rated_luck(p_user uuid, p_limit integer default 2000)
returns table (match_id uuid, hand_no integer, net real, adjusted real)
language sql stable set search_path = '' as $$
  select l.match_id, l.hand_no, l.net, l.adjusted from (
    select h.match_id, h.hand_no,
           coalesce(h.played_at, h.created_at) as played,
           (h.record -> 'netBySeat' ->> mp.seat::text)::real as net,
           coalesce((h.record -> 'luck' -> 'adjustedBySeat' ->> mp.seat::text)::real,
                    (h.record -> 'netBySeat' ->> mp.seat::text)::real) as adjusted
    from public.match_players mp
    join public.matches m on m.id = mp.match_id
    join public.hands h on h.match_id = m.id
    where mp.user_id = p_user and m.kind = 'hu-rated' and m.status <> 'playing'
    order by played desc, h.match_id desc, h.hand_no desc
    limit least(greatest(p_limit, 1), 5000)
  ) l
  order by l.played, l.match_id, l.hand_no
$$;
