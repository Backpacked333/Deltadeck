-- F07. New-gate cutover: deploy RPCs before the Worker. No legacy backfill,
-- rating rewrite, or inference of terminal proofs. Old unproven outboxes stay
-- pending. Shadow classification is read-only unless explicitly requested.
-- Parent deployment must provision a bounded Worker cron for scheduled().
alter table public.matches add column played_at timestamptz;
create table private.hand_archive_sources (
  hand_id text primary key references public.hands(id), body jsonb not null
);
create table private.hand_verifications (
  hand_id text primary key references public.hands(id),
  version text not null check(version = 'hand.v2'),
  source_token text not null, record_digest text not null, archive_digest text not null,
  verified_at timestamptz not null default now()
);
create table private.terminal_proofs (
  match_id uuid primary key references public.matches(id), body jsonb not null
);
create table private.settlement_certificates (
  id bigint generated always as identity primary key,
  match_id uuid not null references public.matches(id),
  source_token text not null, version text not null check(version = 'settlement.v1'),
  body jsonb not null, created_at timestamptz not null default now(),
  unique(match_id,source_token,version)
);
create table private.settlement_jobs (
  match_id uuid primary key references public.matches(id),
  state text not null default 'waiting-for-evidence' check(state in
    ('waiting-for-evidence','legacy-insufficient','quarantined','verified','rated','void')),
  reasons jsonb not null default '[]', current_certificate bigint references private.settlement_certificates(id),
  attempts integer not null default 0, next_attempt_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index settlement_due on private.settlement_jobs(next_attempt_at,match_id)
  where state in ('waiting-for-evidence','verified');
alter table private.hand_archive_sources enable row level security;
alter table private.hand_verifications enable row level security;
alter table private.terminal_proofs enable row level security;
alter table private.settlement_certificates enable row level security;
alter table private.settlement_jobs enable row level security;
revoke all on private.hand_archive_sources, private.hand_verifications,
  private.terminal_proofs, private.settlement_certificates, private.settlement_jobs
  from public, anon, authenticated, service_role;

-- Keep the original writer inside the private schema; there is no alternate
-- publicly callable path which can bypass the source capture or rating gate.
alter function public.record_hand(jsonb) rename to record_hand_pre_certificate;
alter function public.record_hand_pre_certificate(jsonb) set schema private;
revoke all on function private.record_hand_pre_certificate(jsonb) from public, anon, authenticated, service_role;
create function public.record_hand(p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.matches where id=(p->>'matchId')::uuid for update;
  if exists(select 1 from private.hand_archive_sources where hand_id=p->>'id' and body is distinct from p) then
    raise exception 'immutable archive conflict' using errcode='23514';
  end if;
  -- A legacy row cannot acquire retrospective provenance through redelivery.
  if exists(select 1 from public.hands where id=p->>'id') then return; end if;
  perform private.record_hand_pre_certificate(p);
  insert into private.hand_archive_sources values(p->>'id',p);
  update private.settlement_jobs set state='waiting-for-evidence',current_certificate=null,next_attempt_at=now() where match_id=(p->>'matchId')::uuid;
end $$;

create function public.record_terminal(p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare m uuid := (p->'proof'->>'matchId')::uuid; u uuid;
begin
  perform 1 from public.matches where id=m and kind='hu-rated' for update;
  if not found then raise exception 'rated match missing' using errcode='P0002'; end if;
  if p->'proof'->>'v' is distinct from '1' or p->'proof'->>'policyVersion' is distinct from 'terminal.v1'
     or jsonb_typeof(p->'proof'->'completedHands') is distinct from 'array' then
    raise exception 'terminal proof schema' using errcode='23514';
  end if;
  if exists(select 1 from private.terminal_proofs where match_id=m and body is distinct from p) then
    raise exception 'immutable terminal conflict' using errcode='23514';
  end if;
  insert into private.terminal_proofs values(m,p) on conflict do nothing;
  if not found then return; end if;
  update public.matches set played_at=to_timestamp((p->'proof'->>'finishedAt')::double precision/1000) where id=m;
  for u in select user_id from public.match_players where match_id=m loop
    perform private.refresh_accuracy(u,'hu-duplicate');
  end loop;
  insert into private.settlement_jobs(match_id) values(m) on conflict do nothing;
end $$;

create function private.hand_source(p_id text) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id',h.id,'matchId',h.match_id,'handNo',h.hand_no,
    'kind',m.kind,'commitment',h.commitment,'leaves',translate(encode(h.leaves,'base64'),E'\n',''),
    'reveal',h.reveal,'record',h.record,'deck',to_jsonb(hp.deck),
    'secret',translate(encode(hp.secret,'base64'),E'\n',''),'holes',hp.holes,
    'archive',a.body,'holesByUser',(select coalesce(jsonb_agg(to_jsonb(hh) order by hh.user_id),'[]') from public.hand_holes hh where hh.hand_id=h.id))
  from public.hands h join public.hands_private hp on hp.hand_id=h.id
  join public.matches m on m.id=h.match_id left join private.hand_archive_sources a on a.hand_id=h.id where h.id=p_id
$$;
create function private.source_token(p jsonb) returns text
language sql immutable strict set search_path = '' as $$
  select encode(sha256(convert_to(p::text,'UTF8')),'hex')
$$;
create or replace function public.audit_hand(p jsonb) returns jsonb
language sql stable security definer set search_path = '' as $$
  select s.body || jsonb_build_object('sourceToken',private.source_token(s.body),'verified',h.verified,
    'verification',(select jsonb_build_object('version',v.version,'recordDigest',v.record_digest,'archiveDigest',v.archive_digest)
      from private.hand_verifications v where v.hand_id=h.id and v.source_token=private.source_token(s.body)))
  from public.hands h cross join lateral (select private.hand_source(h.id) body) s where h.id=p->>'id'
$$;
create function public.verify_hand_v2(p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare s jsonb;
begin
  perform 1 from public.matches m join public.hands h on h.match_id=m.id where h.id=p->>'id' for update of m;
  s := private.hand_source(p->>'id');
  if s is null or s->'archive' is null or s->'archive'='null' then raise exception 'archive provenance missing' using errcode='P0002'; end if;
  if p->>'sourceToken' is distinct from private.source_token(s) then raise exception 'stale hand evidence' using errcode='40001'; end if;
  if p->>'version' is distinct from 'hand.v2' or coalesce(p->>'recordDigest','') !~ '^[0-9a-f]{64}$' or coalesce(p->>'archiveDigest','') !~ '^[0-9a-f]{64}$' then
    raise exception 'verifier schema' using errcode='23514'; end if;
  insert into private.hand_verifications values(p->>'id','hand.v2',p->>'sourceToken',p->>'recordDigest',p->>'archiveDigest',now())
  on conflict(hand_id) do update set source_token=excluded.source_token,record_digest=excluded.record_digest,archive_digest=excluded.archive_digest,verified_at=now();
  update public.hands set verified=true where id=p->>'id';
  update private.settlement_jobs set next_attempt_at=now(),state='waiting-for-evidence',current_certificate=null
    where match_id=(s->>'matchId')::uuid and state not in ('rated','void');
end $$;

create function private.settlement_source(p_match uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('matchId',m.id,'kind',m.kind,'status',m.status,'config',m.config,'result',m.result,
    'finishedAt',m.finished_at,'players',(select coalesce(jsonb_agg(jsonb_build_object('seat',mp.seat,'userId',mp.user_id,'outcome',mp.outcome) order by mp.seat),'[]') from public.match_players mp where mp.match_id=m.id),
    'terminal',(select body from private.terminal_proofs where match_id=m.id),
    'hands',(select coalesce(jsonb_agg(public.audit_hand(jsonb_build_object('id',h.id)) order by h.hand_no,h.id),'[]') from public.hands h where h.match_id=m.id))
  from public.matches m where m.id=p_match
$$;
create function public.audit_settlement(p jsonb) returns jsonb
language sql stable security definer set search_path = '' as $$
  select s || jsonb_build_object('sourceToken',private.source_token(s)) from private.settlement_source((p->>'matchId')::uuid) s
$$;

-- Structural verification is repeated at the database boundary. Cryptographic
-- replay/equity is the service verifier's responsibility, never a client flag.
create function private.check_certificate(c jsonb,s jsonb) returns boolean
language plpgsql stable set search_path = '' as $$
declare e jsonb; h jsonb; n integer:=0; a0 double precision:=0; a1 double precision:=0; proof jsonb:=s->'terminal'->'proof';
begin
  if c->>'version' is distinct from 'settlement.v1' or c->>'verifierVersion' is distinct from 'hand.v2'
     or c->>'rulesVersion' is distinct from 'hu-rated.v1' or c->>'drawBandVersion' is distinct from 'draw-band.v1'
     or c->>'matchId' is distinct from s->>'matchId' or c->>'sourceToken' is distinct from private.source_token(s)
     or coalesce(c->>'evidenceDigest','') !~ '^[0-9a-f]{64}$'
     or c->'players' is distinct from s->'players' or jsonb_array_length(c->'players')<>2
     or c->>'reason' is distinct from s->'terminal'->'proof'->>'reason'
     or c->'manifest' is distinct from s->'terminal'->'proof'->'completedHands'
     or jsonb_typeof(c->'manifest') is distinct from 'array'
     or c->'finishedAt' is distinct from s->'terminal'->'proof'->'finishedAt'
     or s->>'kind' is distinct from 'hu-rated' then return false; end if;
  if proof->>'v' is distinct from '1' or proof->>'policyVersion' is distinct from 'terminal.v1'
     or c->>'format' is distinct from 'hu-duplicate'
     or c->>'terminalPolicyVersion' is distinct from 'terminal.v1'
     or c->>'terminalProofId' is distinct from proof->>'id'
     or c->>'tableId' is distinct from proof->>'tableId'
     or c->>'activationId' is distinct from proof->>'activationId'
     or c->>'configDigest' is distinct from proof->>'configDigest'
     or proof->>'rulesVersion' is distinct from 'hu-rated.v1'
     or proof->>'matchId' is distinct from s->>'matchId'
     or (select jsonb_agg(jsonb_build_object('seat',x->'seat','userId',x->'userId') order by (x->>'seat')::int) from jsonb_array_elements(proof->'participants') x)
        is distinct from (select jsonb_agg(jsonb_build_object('seat',x->'seat','userId',x->'userId') order by (x->>'seat')::int) from jsonb_array_elements(s->'players') x)
     then return false; end if;
  if (c->>'disposition'='rated' and (s->>'status'<>'finished' or c->>'reason' not in ('complete','forfeit')))
     or (c->>'disposition'='void' and (s->>'status'<>'void' or c->>'reason' not in ('no_show','abandoned','engine_fault')))
     or coalesce(c->>'disposition','') not in ('rated','void') then return false; end if;
  if c->>'reason'='complete' and jsonb_array_length(c->'manifest')<>40 then return false; end if;
  if (c->>'reason'='complete' and proof->>'cause' is distinct from 'hand_limit')
     or (c->>'reason'='forfeit' and (proof->>'cause' is distinct from 'timeout_streak' or coalesce((proof->>'forfeitingSeat')::int,-1) not in (0,1) or coalesce(jsonb_array_length(proof->'timeoutEvidence'),0)<3))
     or (c->>'reason'='no_show' and (coalesce(proof->>'cause','') not in ('start_deadline','cancelled_before_deal') or jsonb_array_length(c->'manifest')<>0
       or (proof->>'cause'='cancelled_before_deal' and coalesce(proof->>'voluntaryCommandId','')='')))
     or (c->>'reason'='abandoned' and proof->>'cause' is distinct from 'mutual_absence')
     or (c->>'reason'='engine_fault' and proof->>'cause' is distinct from 'engine_fault') then return false; end if;
  if jsonb_array_length(c->'manifest')<>jsonb_array_length(s->'hands') then return false; end if;
  for e in select value from jsonb_array_elements(c->'manifest') loop
    n:=n+1;
    h:=s->'hands'->(n-1);
    if e->>'id' is distinct from (s->>'matchId')||':'||n or (e->>'handNo')::int<>n
       or h->>'id' is distinct from e->>'id' or e->>'requiredVerifier' is distinct from 'hand.v2'
       or h->'verification'->>'version' is distinct from 'hand.v2'
       or e->>'recordDigest' is distinct from h->'verification'->>'recordDigest'
       or e->>'archiveDigest' is distinct from h->'verification'->>'archiveDigest' then return false; end if;
    if jsonb_typeof(h->'record'->'luck'->'adjustedBySeat'->'0') is distinct from 'number'
       or jsonb_typeof(h->'record'->'luck'->'adjustedBySeat'->'1') is distinct from 'number' then return false; end if;
    a0:=a0+(h->'record'->'luck'->'adjustedBySeat'->>'0')::double precision;
    a1:=a1+(h->'record'->'luck'->'adjustedBySeat'->>'1')::double precision;
  end loop;
  if c->'adjustedBySeat' is distinct from jsonb_build_object('0',a0,'1',a1) then return false; end if;
  if c->>'disposition'='rated' and (c->'adjustedBySeat' is distinct from s->'result'->'adjustedBySeat'
    or s->'result'->'outcomeBySeat' is distinct from (select jsonb_object_agg(x->>'seat',x->'outcome') from jsonb_array_elements(c->'players') x)) then return false; end if;
  return true;
end $$;
create function public.record_settlement_verdict(p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare m uuid:=(p->>'matchId')::uuid; s jsonb; c jsonb:=p->'certificate'; cid bigint;
begin
  perform 1 from public.matches where id=m for update;
  s:=private.settlement_source(m);
  if s is null or p->>'sourceToken' is distinct from private.source_token(s) then raise exception 'stale settlement evidence' using errcode='40001'; end if;
  if p->>'state'='verified' then
    if not private.check_certificate(c,s) then raise exception 'invalid certificate' using errcode='23514'; end if;
    insert into private.settlement_certificates(match_id,source_token,version,body)
      values(m,p->>'sourceToken','settlement.v1',c) on conflict do nothing;
    select id into cid from private.settlement_certificates where match_id=m and source_token=p->>'sourceToken' and version='settlement.v1' and body=c;
    if cid is null then raise exception 'certificate conflict' using errcode='23514'; end if;
  elsif coalesce(p->>'state','') not in ('waiting-for-evidence','quarantined','legacy-insufficient') then
    raise exception 'invalid settlement verdict' using errcode='23514';
  end if;
  insert into private.settlement_jobs(match_id,state,reasons,current_certificate,next_attempt_at)
    values(m,case when c->>'disposition'='void' then 'void' else p->>'state' end,coalesce(p->'reasons','[]'),cid,now()+interval '1 minute')
  on conflict(match_id) do update set state=excluded.state,reasons=excluded.reasons,current_certificate=excluded.current_certificate,
    next_attempt_at=excluded.next_attempt_at,updated_at=now()
  where private.settlement_jobs.state<>'rated';
end $$;

-- Invalidation acquires the same match lock as apply_rating. A source edit
-- can never retain a usable certificate, including after a manual repair.
create function private.invalidate_settlement() returns trigger
language plpgsql security definer set search_path = '' as $$
declare m uuid; hand text;
begin
  if tg_op='UPDATE' and tg_table_name='hands' and (to_jsonb(new)-'verified')=(to_jsonb(old)-'verified') then return new; end if;
  if tg_table_name='matches' then m:=coalesce(new.id,old.id);
  elsif tg_table_name in ('match_players','hands','terminal_proofs') then m:=coalesce(new.match_id,old.match_id);
  else hand:=coalesce(new.hand_id,old.hand_id); select match_id into m from public.hands where id=hand;
  end if;
  perform 1 from public.matches where id=m for update;
  update private.settlement_jobs set current_certificate=null,state='waiting-for-evidence',next_attempt_at=now(),updated_at=now() where match_id=m;
  return coalesce(new,old);
end $$;
create trigger settlement_match_changed after update on public.matches for each row execute function private.invalidate_settlement();
create trigger settlement_players_changed after insert or update or delete on public.match_players for each row execute function private.invalidate_settlement();
create trigger settlement_hand_changed after insert or update or delete on public.hands for each row execute function private.invalidate_settlement();
create trigger settlement_private_changed after insert or update or delete on public.hands_private for each row execute function private.invalidate_settlement();
create trigger settlement_holes_changed after insert or update or delete on public.hand_holes for each row execute function private.invalidate_settlement();
create trigger settlement_archive_changed after insert or update or delete on private.hand_archive_sources for each row execute function private.invalidate_settlement();
create trigger settlement_terminal_changed after insert or update or delete on private.terminal_proofs for each row execute function private.invalidate_settlement();
create trigger settlement_verification_changed after insert or update or delete on private.hand_verifications for each row execute function private.invalidate_settlement();

create function public.settlement_candidates(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  with due as (
    select j.match_id from private.settlement_jobs j where j.state in ('waiting-for-evidence','verified') and j.next_attempt_at<=now()
    order by j.next_attempt_at,j.match_id for update skip locked limit least(greatest(coalesce((p->>'limit')::int,4),1),4)
  ), claimed as (
    update private.settlement_jobs j set next_attempt_at=now()+interval '5 minutes',attempts=attempts+1 from due where j.match_id=due.match_id returning j.match_id
  ) select coalesce(jsonb_agg(jsonb_build_object('matchId',c.match_id,'hands',(
    select coalesce(jsonb_agg(hh.hand_no),'[]') from (select h.hand_no from public.hands h
    where h.match_id=c.match_id and not exists(select 1 from private.hand_verifications v where v.hand_id=h.id and v.source_token=private.source_token(private.hand_source(h.id))) order by h.hand_no limit 2) hh))),'[]') into result from claimed c;
  return result;
end $$;

alter function public.apply_rating(jsonb) rename to apply_rating_pre_certificate;
alter function public.apply_rating_pre_certificate(jsonb) set schema private;
revoke all on function private.apply_rating_pre_certificate(jsonb) from public, anon, authenticated, service_role;
create function public.apply_rating(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare m uuid:=(p->>'matchId')::uuid; c jsonb; s jsonb; result jsonb;
begin
  perform 1 from public.matches where id=m for update;
  if exists(select 1 from public.matches where id=m and kind<>'hu-rated') then
    raise exception 'unsupported rating format' using errcode='23514'; end if;
  -- Re-delivery returns the historical result, never a second application,
  -- even if an operator subsequently quarantined the evidence.
  if exists(select 1 from public.rating_history where match_id=m and kind='match') then
    if p->>'format' is distinct from 'hu-duplicate' or jsonb_array_length(p->'players') is distinct from 2 or
      (select count(distinct x->>'userId') from jsonb_array_elements(p->'players') x)<>2 or exists(
        select 1 from jsonb_array_elements(p->'players') x where not exists(select 1 from public.rating_history h join public.match_players mp on mp.match_id=h.match_id and mp.user_id=h.user_id where h.match_id=m and h.kind='match' and h.user_id=(x->>'userId')::uuid and h.outcome=x->>'outcome' and mp.seat::text=x->>'seat')) then
      raise exception 'duplicate identity mismatch' using errcode='23514'; end if;
    return private.rating_change(m);
  end if;
  select cert.body into c from private.settlement_jobs j join private.settlement_certificates cert on cert.id=j.current_certificate where j.match_id=m and j.state='verified';
  if c is null then raise exception 'current certificate required' using errcode='P0002'; end if;
  s:=private.settlement_source(m);
  if not private.check_certificate(c,s) or c->>'disposition'<>'rated' or p->>'sourceToken' is distinct from c->>'sourceToken'
      or p->>'certificateDigest' is distinct from c->>'evidenceDigest' then raise exception 'stale or mismatched certificate' using errcode='40001'; end if;
  if p->>'format' is distinct from 'hu-duplicate' or p->>'modelVersion' is distinct from 'glicko2.v1'
      or (p->>'finishedAt')::timestamptz is distinct from to_timestamp((c->>'finishedAt')::double precision/1000)
      or jsonb_array_length(p->'players') is distinct from 2
      or (select count(distinct x->>'userId') from jsonb_array_elements(p->'players') x)<>2
      or exists(select 1 from jsonb_array_elements(p->'players') x where not exists(
        select 1 from jsonb_array_elements(c->'players') a where a->>'userId'=x->>'userId' and a->>'outcome'=x->>'outcome' and a->>'seat'=x->>'seat')) then
    raise exception 'rating identity/outcome mismatch' using errcode='23514'; end if;
  result:=private.apply_rating_pre_certificate(p);
  update private.settlement_jobs set state='rated',updated_at=now() where match_id=m;
  return result;
end $$;

revoke all on function private.hand_source(text),private.source_token(jsonb),private.settlement_source(uuid),private.check_certificate(jsonb,jsonb),private.invalidate_settlement()
  from public,anon,authenticated,service_role;
revoke all on function public.record_hand(jsonb),public.record_terminal(jsonb),public.verify_hand_v2(jsonb),public.audit_hand(jsonb),
  public.audit_settlement(jsonb),public.record_settlement_verdict(jsonb),public.settlement_candidates(jsonb),public.apply_rating(jsonb) from public,anon,authenticated;
grant execute on function public.record_hand(jsonb),public.record_terminal(jsonb),public.verify_hand_v2(jsonb),public.audit_hand(jsonb),
  public.audit_settlement(jsonb),public.record_settlement_verdict(jsonb),public.settlement_candidates(jsonb),public.apply_rating(jsonb) to service_role;

-- F13: archive/grade arrival time is not play order. Match finish (legacy
-- fallback: match creation), then hand number and decision index is stable.
create or replace function private.player_accuracy(p_user uuid,p_format text default 'hu-duplicate')
returns table(accuracy real,graded integer,best integer,good integer,inaccuracy integer,mistake integer,blunder integer)
language sql stable set search_path = '' as $$
  select avg(l.accuracy)::real,count(*)::int,count(*) filter(where l.grade='best')::int,
    count(*) filter(where l.grade='good')::int,count(*) filter(where l.grade='inaccuracy')::int,
    count(*) filter(where l.grade='mistake')::int,count(*) filter(where l.grade='blunder')::int
  from (select g.accuracy,g.grade from public.hand_grades g join public.hands h on h.id=g.hand_id join public.matches m on m.id=h.match_id
    where g.user_id=p_user and g.format=p_format and m.status<>'playing'
    order by coalesce(m.played_at,m.finished_at,m.created_at) desc,m.id desc,h.hand_no desc,g.idx desc,h.id desc limit 500) l
$$;

-- F12: sum actual match contributions, not snapshots crossing resets or
-- applications outside the selected played-time window.
create or replace function public.ladder(p_format text,p_after_rating double precision default null,p_after_user uuid default null,p_page integer default 50)
returns table(user_id uuid,username text,rating double precision,rd double precision,matches integer,wins integer,draws integer,accuracy real,trend double precision)
language sql stable set search_path = '' as $$
  select r.user_id,p.username,r.rating,r.rd,r.matches,r.wins,r.draws,a.accuracy,
    (select sum(h.after_rating-h.before_rating) from public.rating_history h where h.user_id=r.user_id and h.format=p_format and h.kind='match' and h.played_at>=now()-interval '30 days' and h.played_at<=now())
  from public.ratings r join public.players p on p.user_id=r.user_id left join public.accuracy a on a.user_id=r.user_id and a.format=r.format
  where r.format=p_format and r.rd<100 and r.matches>=20 and r.last_match_at>=now()-interval '30 days' and 10*r.abandoned<r.matches
    and (p_after_rating is null or r.rating<p_after_rating or (r.rating=p_after_rating and r.user_id>p_after_user))
  order by r.rating desc,r.user_id limit least(p_page,100)
$$;
create or replace function public.ladder_month(p_format text,p_after_rating double precision default null,p_after_user uuid default null,p_page integer default 50,p_month date default date_trunc('month',now() at time zone 'utc')::date)
returns table(user_id uuid,username text,rating double precision,rd double precision,matches integer,wins integer,draws integer,accuracy real,trend double precision)
language sql stable set search_path = '' as $$
  with month as(select h.user_id,count(*)::int matches,count(*) filter(where h.outcome='win')::int wins,count(*) filter(where h.outcome='draw')::int draws,sum(h.after_rating-h.before_rating) trend
    from public.rating_history h where h.format=p_format and h.kind='match'
      and h.played_at>=date_trunc('month',p_month::timestamp) at time zone 'utc'
      and h.played_at<(date_trunc('month',p_month::timestamp)+interval '1 month') at time zone 'utc' group by h.user_id)
  select r.user_id,p.username,r.rating,r.rd,mo.matches,mo.wins,mo.draws,a.accuracy,mo.trend from month mo
  join public.ratings r on r.user_id=mo.user_id and r.format=p_format join public.players p on p.user_id=r.user_id
  left join public.accuracy a on a.user_id=r.user_id and a.format=r.format
  where r.rd<100 and r.matches>=20 and r.last_match_at>=now()-interval '30 days' and 10*r.abandoned<r.matches
    and (p_after_rating is null or r.rating<p_after_rating or (r.rating=p_after_rating and r.user_id>p_after_user))
  order by r.rating desc,r.user_id limit least(p_page,100)
$$;
