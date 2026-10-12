-- Private self-study evidence, not competitive ratings or certified learner data.
-- Apply only after 20261012010000 with coordinated revision-aware clients.
-- Shadow is the default: no assignment is created by this migration. Pilot
-- configuration/assignment is an operator decision; no efficacy is implied.
-- Rollback pauses ingestion/exposure; do not restore direct document writers.
set local lock_timeout = '5s';

create table public.learning_evidence_events (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null check (length(id) between 1 and 120),
  sequence bigint generated always as identity,
  generation bigint not null,
  kind text not null check (kind in ('submission','evaluation','exposure','invalidation','recommendation','feedback')),
  serialized text not null check (octet_length(serialized) <= 65536),
  digest text not null check (digest ~ '^[a-f0-9]{64}$'),
  payload jsonb not null,
  received_at timestamptz not null default clock_timestamp(),
  primary key (user_id,id), unique(sequence)
);
create index learning_evidence_owner_sequence on public.learning_evidence_events(user_id,sequence);
create table public.learning_evidence_evaluations (
  user_id uuid not null,
  event_id text not null,
  submission_id text not null,
  supersedes text,
  evaluator text not null,
  primary key(user_id,event_id),
  foreign key(user_id,event_id) references public.learning_evidence_events(user_id,id) on delete cascade,
  foreign key(user_id,submission_id) references public.learning_evidence_events(user_id,id) on delete cascade,
  foreign key(user_id,supersedes) references public.learning_evidence_evaluations(user_id,event_id),
  unique(user_id,supersedes)
);
create table public.learning_pilot_protocols (
  id text primary key,
  enabled boolean not null default false,
  policy text not null check (policy='targeted-practice.v1'),
  endpoint text not null,
  baseline text not null check (baseline='curriculum-order-review-date'),
  heldout_families text[] not null check (cardinality(heldout_families)>0),
  preregistration jsonb not null,
  created_at timestamptz not null default now()
);
create table public.learning_pilot_assignments (
  user_id uuid primary key references auth.users(id) on delete cascade,
  protocol_id text not null references public.learning_pilot_protocols(id),
  arm text not null check (arm in ('baseline','targeted')),
  stratum text not null,
  assigned_at timestamptz not null default now(),
  consent_at timestamptz,
  withdrawn_at timestamptz
);
alter table public.learning_evidence_events enable row level security;
alter table public.learning_evidence_evaluations enable row level security;
alter table public.learning_pilot_assignments enable row level security;
alter table public.learning_pilot_protocols enable row level security;
create policy evidence_owner on public.learning_evidence_events for select to authenticated using (user_id=auth.uid());
create policy evaluation_owner on public.learning_evidence_evaluations for select to authenticated using (user_id=auth.uid());
create policy pilot_owner on public.learning_pilot_assignments for select to authenticated using (user_id=auth.uid());
revoke all on public.learning_evidence_events, public.learning_evidence_evaluations, public.learning_pilot_assignments, public.learning_pilot_protocols from public, anon, authenticated, service_role;
grant select on public.learning_evidence_events, public.learning_evidence_evaluations, public.learning_pilot_assignments to authenticated;
-- Operators may configure a preregistered pilot, not forge evidence.
grant select,insert,update on public.learning_pilot_protocols, public.learning_pilot_assignments to service_role;

create function public.ingest_learning_evidence_v1(p jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare u uuid := auth.uid(); s public.learning_sync_scopes; e jsonb; prior public.learning_evidence_events;
  source public.learning_evidence_events; old_eval public.learning_evidence_evaluations;
  k text; hashed text;
begin
  if u is null or coalesce(p->>'accountId','') <> u::text then raise exception 'account mismatch'; end if;
  if p->>'protocol' is distinct from '1' then return jsonb_build_object('status','blocked','reason','upgrade_required'); end if;
  insert into public.learning_sync_scopes(user_id) values(u) on conflict do nothing;
  select * into s from public.learning_sync_scopes where user_id=u for update;
  if coalesce(p->>'deletionGeneration','') <> s.learning::text then return jsonb_build_object('status','blocked','reason','deleted_generation'); end if;
  if p->>'serialized' is null or octet_length(p->>'serialized') > 65536 then return jsonb_build_object('status','blocked','reason','size_limit'); end if;
  e := (p->>'serialized')::jsonb; k := e->>'kind';
  hashed := encode(sha256(convert_to(p->>'serialized','UTF8')),'hex');
  if hashed is distinct from p->>'digest' or e->>'accountId' is distinct from u::text or e->>'id' is distinct from p->>'id'
    or length(coalesce(e->>'id','')) not between 1 and 120 or e->>'schema' is distinct from '1' or e->>'trust' is distinct from 'client-reported'
    or e->>'observedAt' is null or k not in ('submission','evaluation','exposure','invalidation','recommendation','feedback') then
    return jsonb_build_object('status','blocked','reason','invalid_envelope'); end if;
  -- Validate syntax only: observedAt NEVER authorizes delayed/certified learning.
  perform (e->>'observedAt')::timestamptz;
  select * into prior from public.learning_evidence_events where user_id=u and id=e->>'id';
  if found then
    if prior.digest <> hashed then return jsonb_build_object('status','conflict','reason','immutable_id_reused'); end if;
    return jsonb_build_object('status','accepted','id',prior.id,'digest',prior.digest,'deletionGeneration',s.learning);
  end if;
  if k='submission' then
    if e->>'source' not in ('curriculum','practice') or e->>'clock' is distinct from 'device-uncertain'
      or e->>'mapping' is distinct from 'three-skills.v1' or e->>'assistance' not in ('assisted','reported-unaided','unknown')
      or e->>'mode' not in ('practice','diagnostic','independent','transfer','delayed')
      or length(coalesce(e->>'sourceId','')) not between 1 and 220 or length(coalesce(e->>'sourceRevision','')) not between 1 and 100
      or jsonb_typeof(e->'skills') is distinct from 'array' then return jsonb_build_object('status','blocked','reason','invalid_source'); end if;
    if e->>'source'='practice' then
      if e->'practice'->>'practiceGeneration' is distinct from s.practice::text or e->'attempt' is distinct from 'null'::jsonb
        or e->'skills' <> '[]'::jsonb or e->'family' is distinct from 'null'::jsonb then return jsonb_build_object('status','blocked','reason','invalid_practice_provenance'); end if;
    else
      if jsonb_typeof(e->'attempt') is distinct from 'object' or e->'attempt'->>'id' is distinct from e->>'sourceId'
        or e->'attempt'->>'submittedAt' is distinct from e->>'observedAt' or e->'attempt' ? 'evaluation'
        or jsonb_typeof(e->'attempt'->'answers') is distinct from 'object'
        or jsonb_typeof(e->'attempt'->'assistance') is distinct from 'object' then return jsonb_build_object('status','blocked','reason','invalid_submission'); end if;
    end if;
  elsif k='evaluation' then
    select * into source from public.learning_evidence_events where user_id=u and id=e->>'submissionId' and kind='submission';
    if not found then raise exception 'source_not_received' using errcode='40001'; end if;
    if length(coalesce(e->>'evaluator','')) not between 1 and 100 or jsonb_typeof(e->'reasons') is distinct from 'array'
      or jsonb_typeof(e->'errors') is distinct from 'array' or jsonb_typeof(e->'eligible') is distinct from 'boolean'
      or jsonb_typeof(e->'passed') not in ('boolean','null') then return jsonb_build_object('status','blocked','reason','invalid_evaluation'); end if;
    if e->>'supersedes' is not null then
      select * into old_eval from public.learning_evidence_evaluations where user_id=u and event_id=e->>'supersedes';
      if not found then raise exception 'prior_evaluation_not_received' using errcode='40001'; end if;
      if old_eval.submission_id <> e->>'submissionId' or exists(select 1 from public.learning_evidence_evaluations where user_id=u and supersedes=old_eval.event_id) then
        return jsonb_build_object('status','conflict','reason','evaluation_branch'); end if;
    elsif exists(select 1 from public.learning_evidence_evaluations where user_id=u and submission_id=e->>'submissionId') then
      return jsonb_build_object('status','conflict','reason','evaluation_requires_supersedes');
    end if;
  elsif k='exposure' then
    if length(coalesce(e->>'family','')) not between 1 and 220 or e->>'reason' not in ('preview','hint','solution','submitted') or e->>'sourceId' is null then
      return jsonb_build_object('status','blocked','reason','invalid_exposure'); end if;
  elsif k='invalidation' then
    if not exists(select 1 from public.learning_evidence_events where user_id=u and id=e->>'targetId' and kind in ('submission','evaluation')) then
      raise exception 'invalidation_source_not_received' using errcode='40001'; end if;
    if length(coalesce(e->>'reason','')) not between 1 and 1000 then return jsonb_build_object('status','blocked','reason','invalidation_reason_required'); end if;
  elsif k='recommendation' then
    if e->>'practiceGeneration' is distinct from s.practice::text then return jsonb_build_object('status','blocked','reason','deleted_practice_generation'); end if;
    if e->>'policy' is distinct from 'targeted-practice.v1' or e->>'projector' is distinct from 'learning-projection.v1'
      or jsonb_typeof(e->'cutoff') is distinct from 'array' or jsonb_typeof(e->'candidates') is distinct from 'array'
      or jsonb_typeof(e->'exclusions') is distinct from 'array' or e->>'exposure' not in ('shadow','limited-pilot') then
      return jsonb_build_object('status','blocked','reason','invalid_recommendation'); end if;
    if e->>'exposure'='limited-pilot' and not exists(select 1 from public.learning_pilot_assignments a join public.learning_pilot_protocols c on c.id=a.protocol_id
      where a.user_id=u and a.arm='targeted' and a.consent_at is not null and a.withdrawn_at is null and c.enabled) then
      return jsonb_build_object('status','blocked','reason','pilot_not_authorized'); end if;
  elsif k='feedback' then
    if e->>'response' not in ('does-not-fit','other-focus','started') then return jsonb_build_object('status','blocked','reason','invalid_feedback'); end if;
    if not exists(select 1 from public.learning_evidence_events where user_id=u and id=e->>'recommendationId' and kind='recommendation') then
      raise exception 'recommendation_not_received' using errcode='40001'; end if;
  end if;
  insert into public.learning_evidence_events(user_id,id,generation,kind,serialized,digest,payload) values(u,e->>'id',s.learning,k,p->>'serialized',hashed,e);
  if k='evaluation' then insert into public.learning_evidence_evaluations values(u,e->>'id',e->>'submissionId',e->>'supersedes',e->>'evaluator'); end if;
  return jsonb_build_object('status','accepted','id',e->>'id','digest',hashed,'deletionGeneration',s.learning);
exception when invalid_text_representation or datetime_field_overflow or invalid_datetime_format then
  return jsonb_build_object('status','blocked','reason','invalid_payload');
end $$;

create function public.read_learning_evidence_v1(p jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare u uuid := auth.uid(); page jsonb; last_seq bigint; assignment jsonb; generation bigint;
begin
  if u is null then raise exception 'authentication required'; end if;
  select learning into generation from public.learning_sync_scopes where user_id=u;
  select coalesce(jsonb_agg(jsonb_build_object('event',payload,'digest',digest,'receivedAt',received_at,'sequence',sequence) order by sequence),'[]'),max(sequence)
    into page,last_seq from (select * from public.learning_evidence_events where user_id=u and sequence>coalesce((p->>'after')::bigint,0) order by sequence limit 300) q;
  select jsonb_build_object('protocol',a.protocol_id,'arm',a.arm,'enabled',c.enabled,'consented',a.consent_at is not null,'withdrawn',a.withdrawn_at is not null,
    'endpoint',c.endpoint,'baseline',c.baseline) into assignment from public.learning_pilot_assignments a join public.learning_pilot_protocols c on c.id=a.protocol_id where a.user_id=u;
  return jsonb_build_object('accountId',u,'deletionGeneration',coalesce(generation,0),'rows',page,'cursor',last_seq,'serverNow',clock_timestamp(),'assignment',assignment);
end $$;
create function public.learning_pilot_consent_v1(p jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  if p->>'consent'='true' then
    update public.learning_pilot_assignments set consent_at=coalesce(consent_at,now()),withdrawn_at=null where user_id=auth.uid();
  elsif p->>'consent'='false' then update public.learning_pilot_assignments set withdrawn_at=now() where user_id=auth.uid();
  else raise exception 'explicit consent required'; end if;
  return jsonb_build_object('updated',found);
end $$;

create function public.purge_learning_evidence_generation_v1() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.learning <> old.learning then
    delete from public.learning_evidence_evaluations where user_id=new.user_id;
    delete from public.learning_evidence_events where user_id=new.user_id;
    delete from public.learning_pilot_assignments where user_id=new.user_id;
  elsif new.practice <> old.practice then
    delete from public.learning_evidence_evaluations where user_id=new.user_id and submission_id in (select id from public.learning_evidence_events where user_id=new.user_id and payload->>'source'='practice');
    -- Derived recommendation snapshots may contain practice provenance; drop them too.
    delete from public.learning_evidence_events where user_id=new.user_id and (payload->>'source'='practice' or kind in ('recommendation','feedback') or payload->>'submissionId' in (select id from public.learning_evidence_events where user_id=new.user_id and payload->>'source'='practice'));
  end if;
  return new;
end $$;
create trigger learning_evidence_generation after update on public.learning_sync_scopes for each row execute function public.purge_learning_evidence_generation_v1();

-- One row per assigned learner, including non-consent/non-return: no complete-case-only export.
-- No raw answers, notes or email. Analysts must split by learner AND heldout family,
-- predeclare endpoint/effort/missingness rules, and qualify all device-clock outcomes.
create function public.export_learning_pilot_v1(p_protocol text) returns jsonb
language sql security definer set search_path=public,pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('learner',a.user_id,'arm',a.arm,'stratum',a.stratum,'assignedAt',a.assigned_at,'consentAt',a.consent_at,'withdrawnAt',a.withdrawn_at,
    'decisions',(select coalesce(jsonb_agg(jsonb_build_object('receivedAt',e.received_at,'payload',e.payload)),'[]') from public.learning_evidence_events e where e.user_id=a.user_id and e.kind='recommendation'),
    'invalidations',(select coalesce(jsonb_agg(e.payload),'[]') from public.learning_evidence_events e where e.user_id=a.user_id and e.kind='invalidation'),
    'exposures',(select coalesce(jsonb_agg(jsonb_build_object('receivedAt',e.received_at,'recommendationId',e.payload->>'recommendationId','response',e.payload->>'response')),'[]') from public.learning_evidence_events e where e.user_id=a.user_id and e.kind='feedback'),
    'outcomes',(select coalesce(jsonb_agg(jsonb_build_object('evidenceId',s.id,'family',s.payload->>'family','heldout',(s.payload->>'family')=any(c.heldout_families),'mode',s.payload->>'mode','assistance',s.payload->>'assistance','observedAt',s.payload->>'observedAt','receivedAt',s.received_at,'clock','device-uncertain','evaluations',
      (select coalesce(jsonb_agg(jsonb_build_object('id',ev.id,'evaluator',ev.payload->>'evaluator','supersedes',ev.payload->>'supersedes','passed',ev.payload->'passed','eligible',ev.payload->'eligible','reasons',ev.payload->'reasons')),'[]') from public.learning_evidence_events ev where ev.user_id=a.user_id and ev.kind='evaluation' and ev.payload->>'submissionId'=s.id))), '[]')
      from public.learning_evidence_events s where s.user_id=a.user_id and s.kind='submission' and s.payload->>'source'='curriculum' and not exists(select 1 from public.learning_evidence_events i where i.user_id=a.user_id and i.kind='invalidation' and i.payload->>'targetId'=s.id)))), '[]')
  from public.learning_pilot_assignments a join public.learning_pilot_protocols c on c.id=a.protocol_id where a.protocol_id=p_protocol
$$;
revoke all on function public.ingest_learning_evidence_v1(jsonb),public.read_learning_evidence_v1(jsonb),public.learning_pilot_consent_v1(jsonb),public.purge_learning_evidence_generation_v1(),public.export_learning_pilot_v1(text) from public,anon,authenticated,service_role;
grant execute on function public.ingest_learning_evidence_v1(jsonb),public.read_learning_evidence_v1(jsonb),public.learning_pilot_consent_v1(jsonb) to authenticated;
grant execute on function public.export_learning_pilot_v1(text) to service_role;
