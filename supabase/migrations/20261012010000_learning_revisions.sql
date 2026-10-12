-- Protected learning writer cutover. Deploy only with revision-aware clients.
-- Legacy tables remain readable; all writes below are owner-checked RPCs.
-- Rollback pauses saving; never regrant the unsafe last-arrival-wins writers.
/*
WORKSTREAM D COMPATIBILITY / CUTOVER RUNBOOK (not executed by this lane)

Prerequisites: earlier migrations through 20261012000000; a coordinated,
revision-aware client release. Apply using the normal transactional Supabase
migration runner, not an ad-hoc partial paste. Validate on synthetic staging
fixtures first; backfill volume and lock duration have not been tested on a
production-sized database. This migration's 5-second lock timeout fails safely;
investigate contention before retrying. Take the operator's usual backup first.

Compatibility: revision 1 imports existing practice_hands and learning_state
bytes as a CAS base only; it does not certify legacy grades or learning evidence.
read_learning_sync_v1 returns exact serialized bytes and SHA-256 for verification.
Protected writes mirror to legacy read tables transactionally. Direct legacy
and revision writes, including service_role, are deliberately revoked. Old apps
receive database permission failures and must upgrade/reconcile; protocol-aware
but unsupported RPC clients receive upgrade_required. Do not route denied writes
to a fallback upsert or re-enable last-arrival/timestamp writers. Existing earlier
unused learning_cloud tables are not an input to the revised account sync.

Suggested rollout by the parent/operator:
1. Prepare migration + revision-aware client artifacts together. Warn about old
   cached/offline clients; preserve their device work and offer recovery export.
2. Apply this migration in a transaction during the coordinated cutover, then
   release the new client. The old-client write outage is intentional fencing.
3. With synthetic accounts, verify initial read/digests, final-grade overlap,
   both CAS arrival orders, same-ID conflict export, delete then stale upload,
   direct-writer denial, failed reconciliation, export/discard sign-out and local
   storage removal. Account save must not be green on any error/unknown receipt.
4. Observe error/status categories without collecting learner payloads. A new
   client against an unmigrated server remains unable_to_verify and retains local
   work; a missing RPC must never trigger legacy writes. Live betting is separate.

Rollback/recovery: pause account saving, retain local journals/outboxes and offer
export. Restore or fix the revision-aware client/RPCs forward. Do not drop the
revision, receipt or generation tables and do not regrant unsafe direct writers;
either would remove delete/CAS protection. Choosing a conflict version is an
explicit correction, not a timestamp winner; old-generation work stays export-
only. Account deletion cascades scope/revisions/receipts via auth.users. All-scope
clear removes payloads, increments both generations and keeps payload-free receipts.

Local probes (Node 24): npx vitest run src/net/sync.test.ts
src/net/Session.test.tsx src/net/AccountPage.test.tsx
supabase/tests/learning-revisions.test.ts. Real IndexedDB API tests are opt-in:
INDEXEDDB_BROWSER_TESTS=1 npx vitest run src/net/syncOutbox.test.ts
(use PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH if the cached revision differs).
These are fake-transport/jsdom, PGlite SQL and headless storage API probes, not
real Supabase/auth/browser UX acceptance, production durability, or efficacy proof.

Evidence-lane seam: after PracticeSync.isReconciled(), obtain scope and learning
deletion generation, construct DurableOutbox(scope,generation,EventWriter), and
registerSaveParticipant before creating evidence. enqueue(stableId,payload)
resolves only after an event+job transaction commits. ACK requires exact
id+digest+deletionGeneration. Persist producer failures with reportSourceBlocked;
unsupported schemas are blocked/exportable, never dropped. stop is a fence, not
a purge; clearAccount and explicit sign-out perform privacy cleanup. Reconstruct
an adapter after a database-open/upgrade failure; never reset a database to retry.
No curriculum/core code is changed here; existing persistence events remain the
compatibility input, and noteCurriculum supplies a generic in-memory/error hook.
*/
set local lock_timeout = '5s';

create table public.learning_sync_scopes (
  user_id uuid primary key references auth.users(id) on delete cascade,
  practice bigint not null default 0 check (practice >= 0),
  learning bigint not null default 0 check (learning >= 0)
);
create table public.learning_revisions (
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('practice_hand','trainer','curriculum')),
  id text not null check (length(id) between 1 and 120),
  revision bigint not null check (revision > 0),
  generation bigint not null check (generation >= 0),
  serialized text not null,
  digest text not null,
  lifecycle text not null check (lifecycle in ('provisional','final','corrected')),
  received_at timestamptz not null default now(),
  primary key (user_id,kind,id)
);
-- Receipts retain only request hashes/results, not deleted learner payloads.
create table public.learning_mutations (
  user_id uuid not null references auth.users(id) on delete cascade,
  mutation_id text not null check (length(mutation_id) between 1 and 120),
  request_digest text not null,
  result jsonb not null,
  primary key (user_id,mutation_id)
);
alter table public.learning_sync_scopes enable row level security;
alter table public.learning_revisions enable row level security;
alter table public.learning_mutations enable row level security;
revoke all on public.learning_sync_scopes, public.learning_revisions, public.learning_mutations
  from public, anon, authenticated, service_role;
grant select on public.learning_sync_scopes, public.learning_revisions to authenticated;
create policy learning_scopes_read on public.learning_sync_scopes for select to authenticated
  using (user_id = (select auth.uid()));
create policy learning_revisions_read on public.learning_revisions for select to authenticated
  using (user_id = (select auth.uid()));

-- Import without certifying legacy provenance. Revision 1 is only a CAS base.
insert into public.learning_sync_scopes(user_id)
select user_id from public.practice_hands union select user_id from public.learning_state;
-- Fence upgraded offline copies against a pre-cutover history clear as well.
update public.learning_sync_scopes s set practice=1
from public.learning_state l where l.user_id=s.user_id and l.hands_cleared_at is not null;
insert into public.learning_revisions(user_id,kind,id,revision,generation,serialized,digest,lifecycle)
select h.user_id,'practice_hand',id,1,s.practice,record::text,
  encode(sha256(convert_to(record::text,'UTF8')),'hex'),
  case when record->>'graded' = 'false' then 'provisional' else 'final' end
from public.practice_hands h join public.learning_sync_scopes s using(user_id);
insert into public.learning_revisions(user_id,kind,id,revision,generation,serialized,digest,lifecycle)
select user_id,'trainer','trainer',1,0,trainer::text,
  encode(sha256(convert_to(trainer::text,'UTF8')),'hex'),'final'
from public.learning_state where trainer is not null;
insert into public.learning_revisions(user_id,kind,id,revision,generation,serialized,digest,lifecycle)
select user_id,'curriculum','curriculum',1,0,to_jsonb(curriculum)::text,
  encode(sha256(convert_to(to_jsonb(curriculum)::text,'UTF8')),'hex'),'final'
from public.learning_state where curriculum is not null;

revoke insert, update, delete, truncate on public.practice_hands, public.learning_state
  from public, anon, authenticated, service_role;

-- The protected RPC, not a legacy browser clock, now chooses projections.
create or replace function private.learning_state_newer() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.hands_cleared_at := greatest(old.hands_cleared_at, new.hands_cleared_at);
  new.updated_at := now();
  return new;
end $$;
revoke all on function private.learning_state_newer() from public, anon, authenticated, service_role;

create function public.read_learning_sync_v1(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  u uuid := auth.uid(); s public.learning_sync_scopes; answer jsonb; after_id text;
begin
  if u is null then raise exception 'authentication required' using errcode='42501'; end if;
  if (p->>'protocol') is distinct from '1' then return jsonb_build_object('status','upgrade_required'); end if;
  insert into public.learning_sync_scopes(user_id) values(u) on conflict do nothing;
  select * into s from public.learning_sync_scopes where user_id=u for share;
  after_id := coalesce(p->>'cursor','');
  select jsonb_build_object(
    'protocol',1,'accountId',u,'serverNow',now(),
    'deletionGenerations',jsonb_build_object('practice',s.practice,'learning',s.learning),
    'trainer',(select jsonb_build_object('revision',revision,'digest',digest,'serialized',serialized,'payload',serialized::jsonb,'lifecycle',lifecycle)
      from public.learning_revisions where user_id=u and kind='trainer'),
    'curriculum',(select jsonb_build_object('revision',revision,'digest',digest,'serialized',serialized,'payload',serialized::jsonb,'lifecycle',lifecycle)
      from public.learning_revisions where user_id=u and kind='curriculum'),
    'hands',coalesce((select jsonb_agg(jsonb_build_object('id',id,'revision',revision,'digest',digest,'serialized',serialized,'payload',serialized::jsonb,'lifecycle',lifecycle) order by id)
      from (select * from public.learning_revisions where user_id=u and kind='practice_hand' and id>after_id order by id limit 100) h),'[]'::jsonb),
    'cursor',(select case when count(*)=100 then max(id) else null end
      from (select id from public.learning_revisions where user_id=u and kind='practice_hand' and id>after_id order by id limit 100) h)
  ) into answer;
  return answer;
end $$;

create function public.write_learning_revision_v1(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  u uuid := auth.uid(); s public.learning_sync_scopes; r public.learning_revisions;
  receipt public.learning_mutations; g bigint; result jsonb; raw text := p->>'serialized';
  k text := p->>'kind'; target text := p->>'id'; life text := p->>'lifecycle';
  req text := encode(sha256(convert_to(p::text,'UTF8')),'hex'); payload jsonb;
begin
  if u is null or (p->>'accountId') is distinct from u::text then
    raise exception 'account mismatch' using errcode='42501'; end if;
  if (p->>'protocol') is distinct from '1' then return jsonb_build_object('status','upgrade_required'); end if;
  if k is null or k not in ('practice_hand','trainer','curriculum') or target is null or length(target) not between 1 and 120
    or (k <> 'practice_hand' and target <> k) or raw is null
    or life is null or life not in ('provisional','final','corrected')
    or coalesce(length(p->>'mutationId'),0) not between 1 and 120
    or coalesce(p->>'baseRevision','') !~ '^[0-9]+$'
    or coalesce(p->>'deletionGeneration','') !~ '^[0-9]+$' then
    return jsonb_build_object('status','blocked','reason','invalid_request'); end if;
  if octet_length(raw) > (case when k='curriculum' then 1200000 else 8192 end) then
    return jsonb_build_object('status','blocked','reason','size_limit'); end if;
  begin payload := raw::jsonb;
  exception when invalid_text_representation then return jsonb_build_object('status','blocked','reason','invalid_json'); end;
  if payload is distinct from p->'payload' or (p->>'digest') is distinct from encode(sha256(convert_to(raw,'UTF8')),'hex')
    or (k='practice_hand' and (jsonb_typeof(payload)<>'object' or (payload->>'id') is distinct from target))
    or (k='trainer' and jsonb_typeof(payload)<>'object')
    or (k='curriculum' and jsonb_typeof(payload)<>'string') then
    return jsonb_build_object('status','blocked','reason','invalid_payload'); end if;
  if k <> 'curriculum' and octet_length(payload::text) > 8192 then
    return jsonb_build_object('status','blocked','reason','size_limit'); end if;
  if k='practice_hand' and ((payload->>'graded'='false') is true) <> (life='provisional') then
    return jsonb_build_object('status','blocked','reason','invalid_lifecycle'); end if;
  insert into public.learning_sync_scopes(user_id) values(u) on conflict do nothing;
  select * into s from public.learning_sync_scopes where user_id=u for update;
  g := case when k='practice_hand' then s.practice else s.learning end;
  -- Generation is checked before receipt replay: a deleted write is never acknowledged again.
  if (p->>'deletionGeneration')::bigint <> g then
    return jsonb_build_object('status','deleted','reason','generation_changed','deletionGeneration',g); end if;
  select * into receipt from public.learning_mutations where user_id=u and mutation_id=p->>'mutationId';
  if found then
    if receipt.request_digest=req then return receipt.result; end if;
    return jsonb_build_object('status','blocked','reason','mutation_reused');
  end if;
  select * into r from public.learning_revisions where user_id=u and kind=k and id=target;
  if coalesce(r.revision,0) <> (p->>'baseRevision')::bigint then
    return jsonb_build_object('status','conflict','revision',coalesce(r.revision,0),'digest',r.digest,'serialized',r.serialized,
      'deletionGeneration',g,'current',r.serialized::jsonb,'lifecycle',r.lifecycle); end if;
  if k='practice_hand' and r.lifecycle in ('final','corrected') and
    (life <> 'corrected' or coalesce(p->>'supersedesRevision','') <> r.revision::text) then
    return jsonb_build_object('status','blocked','reason','final_requires_correction'); end if;
  if k='practice_hand' and r.revision is null and
    (select count(*) from public.practice_hands where user_id=u and created_at>now()-interval '1 day') >= 1000 then
    return jsonb_build_object('status','blocked','reason','daily_cap'); end if;
  insert into public.learning_revisions(user_id,kind,id,revision,generation,serialized,digest,lifecycle)
  values(u,k,target,coalesce(r.revision,0)+1,g,raw,p->>'digest',life)
  on conflict(user_id,kind,id) do update set revision=excluded.revision,serialized=excluded.serialized,
    digest=excluded.digest,lifecycle=excluded.lifecycle,received_at=now();
  -- Transactional compatibility projection. Its old timestamp trigger cannot select a winner.
  if k='practice_hand' then
    insert into public.practice_hands(user_id,id,played_at,record)
    values(u,target,case when jsonb_typeof(payload->'at')='number' then least(to_timestamp((payload->>'at')::double precision/1000),now()) else now() end,payload)
    on conflict(user_id,id) do update set record=excluded.record,played_at=excluded.played_at;
  elsif k='trainer' then
    insert into public.learning_state(user_id,trainer,trainer_updated_at) values(u,payload,now())
    on conflict(user_id) do update set trainer=excluded.trainer,trainer_updated_at=now();
  else
    insert into public.learning_state(user_id,curriculum,curriculum_updated_at) values(u,payload#>>'{}',now())
    on conflict(user_id) do update set curriculum=excluded.curriculum,curriculum_updated_at=now();
  end if;
  result := jsonb_build_object('status','accepted','mutationId',p->>'mutationId','revision',coalesce(r.revision,0)+1,
    'digest',p->>'digest','deletionGeneration',g,'receivedAt',now());
  insert into public.learning_mutations values(u,p->>'mutationId',req,result);
  return result;
end $$;

create function public.clear_learning_scope_v1(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare u uuid := auth.uid(); s public.learning_sync_scopes; receipt public.learning_mutations;
  scope text := p->>'scope'; result jsonb;
  req text := encode(sha256(convert_to(p::text,'UTF8')),'hex');
begin
  if u is null or (p->>'accountId') is distinct from u::text then raise exception 'account mismatch' using errcode='42501'; end if;
  if (p->>'protocol') is distinct from '1' then return jsonb_build_object('status','upgrade_required'); end if;
  if scope is null or scope not in ('practice','learning','all') or coalesce(length(p->>'mutationId'),0) not between 1 and 120 then
    return jsonb_build_object('status','blocked','reason','invalid_request'); end if;
  insert into public.learning_sync_scopes(user_id) values(u) on conflict do nothing;
  select * into s from public.learning_sync_scopes where user_id=u for update;
  select * into receipt from public.learning_mutations where user_id=u and mutation_id=p->>'mutationId';
  if found then
    if receipt.request_digest=req then
      if receipt.result->'deletionGenerations' is distinct from jsonb_build_object('practice',s.practice,'learning',s.learning) then
        return jsonb_build_object('status','conflict','deletionGenerations',jsonb_build_object('practice',s.practice,'learning',s.learning));
      end if;
      return receipt.result;
    end if;
    return jsonb_build_object('status','blocked','reason','mutation_reused'); end if;
  if (scope='all' and (p->'expectedGenerations' is distinct from jsonb_build_object('practice',s.practice,'learning',s.learning)))
    or (scope<>'all' and coalesce(p->>'expectedGeneration','') <> (case when scope='practice' then s.practice else s.learning end)::text) then
    return jsonb_build_object('status','conflict','deletionGenerations',jsonb_build_object('practice',s.practice,'learning',s.learning)); end if;
  if scope in ('practice','all') then
    delete from public.learning_revisions where user_id=u and kind='practice_hand';
    delete from public.practice_hands where user_id=u;
    s.practice := s.practice+1;
    insert into public.learning_state(user_id,hands_cleared_at) values(u,now())
      on conflict(user_id) do update set hands_cleared_at=now();
  end if;
  if scope in ('learning','all') then
    delete from public.learning_revisions where user_id=u and kind in ('trainer','curriculum');
    -- DELETE avoids legacy timestamp guards retaining the cleared document.
    delete from public.learning_state where user_id=u;
    s.learning := s.learning+1;
  end if;
  update public.learning_sync_scopes set practice=s.practice,learning=s.learning where user_id=u;
  result := jsonb_build_object('status','accepted','mutationId',p->>'mutationId','deletionGeneration',case when scope='practice' then s.practice else s.learning end,
    'deletionGenerations',jsonb_build_object('practice',s.practice,'learning',s.learning));
  insert into public.learning_mutations values(u,p->>'mutationId',req,result);
  return result;
end $$;

revoke all on function public.read_learning_sync_v1(jsonb), public.write_learning_revision_v1(jsonb), public.clear_learning_scope_v1(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.read_learning_sync_v1(jsonb), public.write_learning_revision_v1(jsonb), public.clear_learning_scope_v1(jsonb) to authenticated;
