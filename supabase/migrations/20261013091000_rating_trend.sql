-- The ladder's trend is the sum of each rated match's own rating change
-- (audit F12). It was a difference of two snapshots: the current (or last)
-- rating minus the "before" of the first match by played time. Ratings are
-- applied in the order matches finish their archive, not the order they
-- were played, so a match rated late had a "before" that already counted
-- matches played after it, and the difference left those out (a +35 month
-- could read 0). The all-time trend also counted reset rows. Summing
-- after - before over the window's match rows does not depend on the order
-- they were applied in. Rating itself stays applied in arrival order
-- (Glicko-2 per match, ADR P1-12); only the trend's arithmetic changes.

-- ladder() as in *_ladder.sql, with the trend summed.
create or replace function public.ladder(
  p_format text, p_after_rating double precision default null,
  p_after_user uuid default null, p_page integer default 50)
returns table (user_id uuid, username text, rating double precision,
               rd double precision, matches integer, wins integer,
               draws integer, accuracy real, trend double precision)
language sql stable set search_path = '' as $$
  select l.*, (
      select sum(h.after_rating - h.before_rating)
      from public.rating_history h
      where h.user_id = l.user_id and h.format = p_format
        and h.kind = 'match'
        and h.played_at >= now() - interval '30 days') as trend
  from (
    select r.user_id, p.username, r.rating, r.rd, r.matches, r.wins, r.draws,
           a.accuracy
    from public.ratings r
    join public.players p on p.user_id = r.user_id
    left join public.accuracy a on a.user_id = r.user_id and a.format = r.format
    where r.format = p_format
      and r.rd < 100 and r.matches >= 20
      and r.last_match_at >= now() - interval '30 days'
      and 10 * r.abandoned < r.matches
      and (p_after_rating is null
           or r.rating < p_after_rating
           or (r.rating = p_after_rating and r.user_id > p_after_user))
    order by r.rating desc, r.user_id
    limit least(p_page, 100)
  ) l
  order by l.rating desc, l.user_id
$$;

-- ladder_month() as in *_ladder.sql, with the trend summed.
create or replace function public.ladder_month(
  p_format text, p_after_rating double precision default null,
  p_after_user uuid default null, p_page integer default 50,
  p_month date default date_trunc('month', now() at time zone 'utc')::date)
returns table (user_id uuid, username text, rating double precision,
               rd double precision, matches integer, wins integer,
               draws integer, accuracy real, trend double precision)
language sql stable set search_path = '' as $$
  with month as (
    select h.user_id, count(*)::int as matches,
           count(*) filter (where h.outcome = 'win')::int as wins,
           count(*) filter (where h.outcome = 'draw')::int as draws,
           sum(h.after_rating - h.before_rating) as trend
    from public.rating_history h
    where h.format = p_format and h.kind = 'match'
      -- The UTC month containing p_month, whichever day of it is passed.
      and h.played_at >= date_trunc('month', p_month::timestamp) at time zone 'utc'
      and h.played_at < (date_trunc('month', p_month::timestamp)
                         + interval '1 month') at time zone 'utc'
    group by h.user_id)
  select r.user_id, p.username, r.rating, r.rd, mo.matches, mo.wins, mo.draws,
         a.accuracy, mo.trend
  from month mo
  join public.ratings r on r.user_id = mo.user_id and r.format = p_format
  join public.players p on p.user_id = r.user_id
  left join public.accuracy a on a.user_id = r.user_id and a.format = r.format
  where r.rd < 100 and r.matches >= 20
    and r.last_match_at >= now() - interval '30 days'
    and 10 * r.abandoned < r.matches
    and (p_after_rating is null
         or r.rating < p_after_rating
         or (r.rating = p_after_rating and r.user_id > p_after_user))
  order by r.rating desc, r.user_id
  limit least(p_page, 100)
$$;
