-- A rating moves only on a result its own verified hands support (audit
-- F07). apply_rating used to check that the payload agreed with the stored
-- result and nothing else: a match with no archived hand, a hand that
-- failed verification, or luck figures nobody recomputed could all set a
-- public rating. Now, in the same transaction that writes the rating:
--
--   * the match's hands are 1..n with no gap and all verified (the queue
--     consumer verifies each one, and from this release recomputes its
--     luck adjustment instead of trusting the table's: worker/src/verify.ts);
--   * each hand names the match's own players in their seats, and carries
--     the luck-adjusted net the rating settles on;
--   * those nets add up to each player's adjusted_chips;
--   * the outcome follows: a complete match has all handsTotal hands and its
--     outcome is the draw band's verdict on adjusted_chips; a forfeit has
--     the hands up to the forfeit and the forfeiter loses.
--
-- Evidence still on its way (a hand not yet archived or verified) is
-- 55000: the table's outbox retries the call (refusedForData counts only
-- classes 22 and 23). Evidence that cannot arrive or says otherwise (a hand
-- that failed verification or was parked, a hand that dead-lettered
-- unverified, luck that does not add up, a wrong outcome) is 23514: the
-- table parks the call with an incident, and the match is never rated.
-- A match already rated returns its change as before, so a duplicate call
-- still applies nothing twice.
--
-- DRAW_BAND_BB is 2 (src/rating/rules.ts; worker/src/rated.ts outcomes());
-- supabase/tests/rating-evidence.test.ts holds the two to the same edges.

create or replace function public.apply_rating(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_match uuid := (p ->> 'matchId')::uuid;
  v_format text := p ->> 'format';
  v_kind text;
  v_status text;
  v_config jsonb;
  v_result jsonb;
  -- When the match was played: inactivity counts from here, not from when
  -- a delayed rating happened to apply.
  v_at timestamptz := coalesce((p ->> 'finishedAt')::timestamptz, now());
  v_reason text;
  v_hands integer;
  v_last integer;
  v_verified integer;
  v_total integer;
  v_forfeit_hand integer;
  v_bb double precision;
  v_lead double precision;
  r jsonb;
  cur public.ratings;
begin
  select kind, status, config, result
  into v_kind, v_status, v_config, v_result
  from public.matches where id = v_match
  for update;
  if v_status is null or v_status = 'playing' then
    raise exception 'match % is not finished', v_match using errcode = 'P0002';
  end if;
  if v_kind <> 'hu-rated' or v_status <> 'finished'
     or v_format is distinct from 'hu-duplicate'
     or jsonb_array_length(p -> 'players') <> (
       select count(*) from public.match_players where match_id = v_match)
     or exists (
       select 1 from jsonb_array_elements(p -> 'players') x
       left join public.match_players mp
         on mp.match_id = v_match and mp.user_id = (x ->> 'userId')::uuid
       where mp.user_id is null or mp.outcome is distinct from x ->> 'outcome')
  then
    raise exception 'rating does not match the result of %', v_match
      using errcode = '23514';
  end if;

  if exists (
    select 1 from public.rating_history
    where match_id = v_match and kind = 'match'
  ) then
    return private.rating_change(v_match);
  end if;

  -- ---- The evidence (audit F07) ------------------------------------------
  v_reason := v_result ->> 'reason';
  v_total := (v_config ->> 'handsTotal')::integer;
  v_bb := (v_config -> 'blinds' ->> 'bb')::double precision;
  if v_reason is null or v_reason not in ('complete', 'forfeit')
     or v_total is null or v_bb is null then
    raise exception 'no rateable result for %', v_match using errcode = '23514';
  end if;

  -- A hand that cannot be trusted or will never arrive: never rated.
  if exists (
    select 1 from public.incidents i
    where i.match_id = v_match
      and (i.kind in ('verify_failed', 'archive_parked:hand')
           or (i.kind = 'dlq' and not exists (
             select 1 from public.hands h
             where h.match_id = v_match and h.hand_no = i.hand_no
               and h.verified)))
  ) then
    raise exception 'a hand of % failed its audit', v_match
      using errcode = '23514';
  end if;

  select count(*)::integer, coalesce(max(hand_no), 0),
         (count(*) filter (where verified))::integer
  into v_hands, v_last, v_verified
  from public.hands where match_id = v_match;

  if v_reason = 'complete' then
    if v_hands > v_total or v_last > v_total then
      raise exception '% has more hands than it deals', v_match
        using errcode = '23514';
    end if;
    if v_hands < v_total or v_last <> v_hands then
      raise exception 'hands of % are still being archived', v_match
        using errcode = '55000';
    end if;
  else
    -- The forfeit's own hand is archived if the timeout that ended the
    -- match also ended that hand (a fold); otherwise it never finished.
    select a.hand_no into v_forfeit_hand
    from public.abandonments a
    where a.match_id = v_match and a.kind = 'timeout_x3';
    if v_forfeit_hand is null or v_last > v_forfeit_hand
       or v_forfeit_hand > v_total then
      raise exception 'forfeit of % has no consistent hand', v_match
        using errcode = '23514';
    end if;
    if v_last <> v_hands or v_hands < v_forfeit_hand - 1 then
      raise exception 'hands of % are still being archived', v_match
        using errcode = '55000';
    end if;
  end if;
  if v_verified < v_hands then
    raise exception 'hands of % are still being verified', v_match
      using errcode = '55000';
  end if;

  -- Every hand: the match's players in their seats, and its adjusted nets.
  if exists (
    select 1 from public.hands h
    where h.match_id = v_match
      and (jsonb_typeof(h.record -> 'seats') is distinct from 'array'
           or jsonb_array_length(h.record -> 'seats') <> 2
           or exists (
             select 1 from jsonb_array_elements(h.record -> 'seats') s
             where not exists (
               select 1 from public.match_players mp
               where mp.match_id = v_match
                 and mp.user_id::text = s ->> 'userId'
                 and mp.seat::text = s ->> 'seat'))
           or jsonb_typeof(h.record #> '{luck,adjustedBySeat,0}') is distinct from 'number'
           or jsonb_typeof(h.record #> '{luck,adjustedBySeat,1}') is distinct from 'number')
  ) then
    raise exception 'a hand of % is not this match''s', v_match
      using errcode = '23514';
  end if;

  -- The hands' adjusted nets add up to each player's adjusted total (float
  -- sums in another order: equal to a millionth of a chip).
  if exists (
    select 1 from public.match_players mp
    where mp.match_id = v_match
      and (mp.adjusted_chips is null or abs(
        coalesce((
          select sum((h.record #>> array['luck', 'adjustedBySeat', mp.seat::text])::double precision)
          from public.hands h where h.match_id = v_match), 0)
        - mp.adjusted_chips) > 1e-6 * greatest(1, abs(mp.adjusted_chips)))
  ) then
    raise exception 'the adjusted total of % does not follow from its hands', v_match
      using errcode = '23514';
  end if;

  -- The outcome follows from the totals (the table decides it the same way).
  if v_reason = 'complete' then
    select ((select adjusted_chips from public.match_players
             where match_id = v_match and seat = 0)
          - (select adjusted_chips from public.match_players
             where match_id = v_match and seat = 1)) / 2
    into v_lead;
    if exists (
      select 1 from public.match_players mp
      where mp.match_id = v_match
        and mp.outcome is distinct from case
          when abs(v_lead) <= 2 * v_bb + 1e-9 then 'draw'
          when (v_lead > 0) = (mp.seat = 0) then 'win'
          else 'loss' end
    ) then
      raise exception 'the outcome of % does not follow from its totals', v_match
        using errcode = '23514';
    end if;
  elsif exists (
    select 1 from public.match_players mp
    where mp.match_id = v_match
      and mp.outcome is distinct from case
        when mp.seat::text = v_result ->> 'forfeit' then 'loss' else 'win' end)
  then
    raise exception 'the forfeit of % is not the outcome', v_match
      using errcode = '23514';
  end if;

  -- ---- The rating, as before ---------------------------------------------
  -- Rows are locked in user order, so two matches that share a player and
  -- are rated at once wait for each other instead of deadlocking (D2).
  for r in
    select value from jsonb_array_elements(p -> 'players')
    order by value ->> 'userId'
  loop
    insert into public.ratings (user_id, format)
    values ((r ->> 'userId')::uuid, v_format)
    on conflict do nothing;
    select * into cur from public.ratings
    where user_id = (r ->> 'userId')::uuid and format = v_format
    for update;
    if cur.version <> (r ->> 'version')::integer then
      raise exception 'stale rating version for %', cur.user_id
        using errcode = '40001';
    end if;
    insert into public.rating_history (
      user_id, format, kind, match_id, outcome,
      before_rating, before_rd, before_sigma,
      after_rating, after_rd, after_sigma, model_version, played_at)
    values (
      cur.user_id, v_format, 'match', v_match, r ->> 'outcome',
      cur.rating, cur.rd, cur.sigma,
      (r ->> 'rating')::float8, (r ->> 'rd')::float8, (r ->> 'sigma')::float8,
      p ->> 'modelVersion', v_at);
    update public.ratings
    set rating = (r ->> 'rating')::float8, rd = (r ->> 'rd')::float8,
        sigma = (r ->> 'sigma')::float8, matches = matches + 1,
        wins = wins + (r ->> 'outcome' = 'win')::int,
        draws = draws + (r ->> 'outcome' = 'draw')::int,
        -- An older match rated late never moves the last match backwards.
        last_match_at = greatest(coalesce(last_match_at, v_at), v_at),
        version = version + 1, updated_at = now()
    where user_id = cur.user_id and format = v_format;
  end loop;
  return private.rating_change(v_match);
end $$;
