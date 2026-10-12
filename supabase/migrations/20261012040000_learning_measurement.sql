-- Qualified self-study instrumentation, not a retained-skill certificate.
-- Only issuance/receipt intervals are server-timed; content, answers, assistance
-- and effort remain client-reported. Bundled holdouts are not secrecy-protected.
set local lock_timeout = '5s';
alter function public.ingest_learning_evidence_v1(jsonb) set search_path = '';
alter function public.read_learning_evidence_v1(jsonb) set search_path = '';
alter function public.learning_pilot_consent_v1(jsonb) set search_path = '';
alter function public.purge_learning_evidence_generation_v1() set search_path = '';
alter function public.export_learning_pilot_v1(text) set search_path = '';

create table public.learning_assessment_issues (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  generation bigint not null,
  family text not null,
  anchor_id text not null,
  anchor_received_at timestamptz not null,
  due_at timestamptz not null,
  issued_at timestamptz not null default clock_timestamp(),
  unique(user_id,generation,family),
  foreign key(user_id,anchor_id) references public.learning_evidence_events(user_id,id) on delete cascade,
  check (due_at >= anchor_received_at + interval '7 days'),
  check (issued_at >= due_at)
);
alter table public.learning_assessment_issues enable row level security;
revoke all on public.learning_assessment_issues from public,anon,authenticated,service_role;
grant select on public.learning_assessment_issues to authenticated;
create policy assessment_owner on public.learning_assessment_issues for select to authenticated using(user_id=auth.uid());

create function public.issue_learning_assessment_v1(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare u uuid:=auth.uid(); g bigint; target_family text; anchor public.learning_evidence_events;
  issue public.learning_assessment_issues; due timestamptz;
begin
  if u is null or p->>'accountId' is distinct from u::text then raise exception 'account mismatch' using errcode='42501'; end if;
  select learning into g from public.learning_sync_scopes where user_id=u for update;
  if p->>'protocol' is distinct from '1' or p->>'deletionGeneration' is distinct from g::text then
    return jsonb_build_object('status','blocked','reason','reconcile_required'); end if;
  target_family := case p->>'skill' when 'incremental' then 'targeted-incremental-delayed-warranty'
    when 'conditioning' then 'targeted-conditioning-delayed-quality' when 'thresholds' then 'targeted-thresholds-delayed-capacity' end;
  if target_family is null then return jsonb_build_object('status','blocked','reason','unknown_skill'); end if;
  -- Anchor eligibility is explicitly self-reported. The server only owns receipt time.
  select s.* into anchor from public.learning_evidence_events s where s.user_id=u and s.generation=g
    and s.kind='submission' and s.payload->>'mode'='transfer' and s.payload->>'context'='business'
    and s.payload->'skills' ? (p->>'skill') and s.payload->>'assistance'='reported-unaided'
    and exists(select 1 from public.learning_evidence_events e where e.user_id=u and e.kind='evaluation'
      and e.payload->>'submissionId'=s.id and e.payload->>'passed'='true' and e.payload->>'eligible'='true'
      and not exists(select 1 from public.learning_evidence_evaluations x where x.user_id=u and x.supersedes=e.id)
      and not exists(select 1 from public.learning_evidence_events i where i.user_id=u and i.kind='invalidation' and i.payload->>'targetId' in (s.id,e.id)))
    order by s.received_at,s.id limit 1;
  if not found then return jsonb_build_object('status','blocked','reason','no_transfer_anchor'); end if;
  select * into issue from public.learning_assessment_issues where user_id=u and generation=g and family=target_family;
  if found then return jsonb_build_object('status','issued','issueId',issue.id,'caseId',issue.family,'issuedAt',issue.issued_at,'dueAt',issue.due_at,'anchorId',issue.anchor_id); end if;
  due := anchor.received_at + interval '7 days';
  if clock_timestamp()<due then return jsonb_build_object('status','waiting','dueAt',due,'serverNow',clock_timestamp()); end if;
  if exists(select 1 from public.learning_evidence_events e where e.user_id=u and e.payload->>'family'=target_family and e.kind in ('submission','exposure')) then
    return jsonb_build_object('status','blocked','reason','family_already_exposed'); end if;
  insert into public.learning_assessment_issues(user_id,generation,family,anchor_id,anchor_received_at,due_at)
    values(u,g,target_family,anchor.id,anchor.received_at,due) returning * into issue;
  return jsonb_build_object('status','issued','issueId',issue.id,'caseId',issue.family,'issuedAt',issue.issued_at,'dueAt',issue.due_at,'anchorId',issue.anchor_id);
end $$;
revoke all on function public.issue_learning_assessment_v1(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.issue_learning_assessment_v1(jsonb) to authenticated;

create function private.check_assessment_issue() returns trigger
language plpgsql security definer set search_path = '' as $$
declare issue public.learning_assessment_issues; requested text:=new.payload->'attempt'->>'assessmentIssueId';
begin
  if new.kind<>'submission' or requested is null then return new; end if;
  select * into issue from public.learning_assessment_issues where user_id=new.user_id and id::text=requested and generation=new.generation;
  if not found or new.payload->>'mode' is distinct from 'delayed' or new.payload->>'family' is distinct from issue.family
    or new.payload->'attempt'->>'caseId' is distinct from issue.family or new.received_at<issue.issued_at then
    raise exception 'invalid assessment issue' using errcode='23514'; end if;
  return new;
end $$;
revoke all on function private.check_assessment_issue() from public,anon,authenticated,service_role;
create trigger assessment_issue_before_evidence before insert on public.learning_evidence_events for each row execute function private.check_assessment_issue();

create or replace function public.read_learning_evidence_v1(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare u uuid := auth.uid(); page jsonb; last_seq bigint; assignment jsonb; generation bigint;
begin
  if u is null then raise exception 'authentication required'; end if;
  select learning into generation from public.learning_sync_scopes where user_id=u;
  select coalesce(jsonb_agg(jsonb_build_object('event',payload,'digest',digest,'receivedAt',received_at,'sequence',sequence,
    'timing',(select jsonb_build_object('issueId',i.id,'anchorId',i.anchor_id,'anchorReceivedAt',i.anchor_received_at,'dueAt',i.due_at,'issuedAt',i.issued_at,'provenance','server-receipt')
      from public.learning_assessment_issues i where i.user_id=u and i.id::text=payload->'attempt'->>'assessmentIssueId')) order by sequence),'[]'),max(sequence)
    into page,last_seq from (select * from public.learning_evidence_events where user_id=u and sequence>coalesce((p->>'after')::bigint,0) order by sequence limit 300) q;
  select jsonb_build_object('protocol',a.protocol_id,'arm',a.arm,'enabled',c.enabled,'consented',a.consent_at is not null,'withdrawn',a.withdrawn_at is not null,
    'endpoint',c.endpoint,'baseline',c.baseline) into assignment from public.learning_pilot_assignments a join public.learning_pilot_protocols c on c.id=a.protocol_id where a.user_id=u;
  return jsonb_build_object('accountId',u,'deletionGeneration',coalesce(generation,0),'rows',page,'cursor',last_seq,'serverNow',clock_timestamp(),'assignment',assignment);
end $$;

-- Extend the analyst export without exposing raw answers/notes or calling
-- client telemetry a trusted measure of attention.
alter function public.export_learning_pilot_v1(text) rename to export_learning_pilot_pre_measurement;
alter function public.export_learning_pilot_pre_measurement(text) set schema private;
revoke all on function private.export_learning_pilot_pre_measurement(text) from public,anon,authenticated,service_role;
create function public.export_learning_pilot_v1(p_protocol text) returns jsonb
language sql security definer set search_path = '' as $$
  select coalesce(jsonb_agg(learner || jsonb_build_object('measurement',
    (select coalesce(jsonb_agg(jsonb_build_object('evidenceId',e.id,'effort',e.payload->'attempt'->'effort','effortTrust','client-monotonic-not-attention-proof',
      'timing',(select jsonb_build_object('issueId',i.id,'anchorId',i.anchor_id,'anchorReceivedAt',i.anchor_received_at,'dueAt',i.due_at,'issuedAt',i.issued_at,'receivedAt',e.received_at,'trust','server-receipt-only')
        from public.learning_assessment_issues i where i.user_id=e.user_id and i.id::text=e.payload->'attempt'->>'assessmentIssueId'))),'[]')
      from public.learning_evidence_events e where e.user_id=(learner->>'learner')::uuid and e.kind='submission'))),'[]')
  from jsonb_array_elements(private.export_learning_pilot_pre_measurement(p_protocol)) learner
$$;
revoke all on function public.export_learning_pilot_v1(text) from public,anon,authenticated,service_role;
grant execute on function public.export_learning_pilot_v1(text) to service_role;
