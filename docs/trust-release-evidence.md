# Trust integration: release evidence and operator handoff

## Verdict and scope

This is an **implementation handoff, not authorization to release**. Gate A is
locally implemented and regression-tested, with recorded app acceptance and
production compatibility/cutover still required. Gate B is an instrumented,
three-skill **qualified self-study** pilot, shadow by default; effectiveness and
retained-skill claims are not established. The projector never awards `retained`.

Integration branch: `devin/1791832700-trust-integration`, rooted at
`9de1fd868f55358bd8e0926487750673752a914a`. Shared ancestors were merged once:
client `634e921`, rated-integrity `929111a`, learning-evidence `d393497c`,
rules/practice `ed1ef69`, including live `b51e7e7`, learning-durability `3bab6e7`
and contracts `4fe1ac9`. No PR, merge to main, deploy, production migration or
production data mutation was performed by this integration lane.

**Local tests do not prove production correctness, browser smoothness,
real-device recovery, or learning efficacy.** Parent owns recorded browser
acceptance on the final integrated revision. Full deployment/DB parity, real
two-device account recovery, cloud CPU headroom and an elapsed human study are
separate gates. Synthetic rating-season tests exercise mathematics/ordering as
DB owner, not certification of 5,000 real poker matches.

## Independent acceptance repair: F07 rating write privileges

Repair branch: `devin/1791837388-rating-write-gate`, directly based on integrated
revision `510d71752ad5d88a31c162cdf74d79c55bf52ff0`. Independent acceptance found
that `service_role` could directly insert/update `ratings` and insert forged
`rating_history` despite the certificate-gated RPC. This lane reproduced the
failure locally and adds `20261012050000_rating_write_privileges.sql`; it has
**not** applied the migration to any production or hosted database.

- Both rating tables are SELECT-only for `anon`, `authenticated` and
  `service_role`. The migration revokes PUBLIC and role-specific table grants
  and independently granted column rights, then explicitly restores reads.
- Authorized `SECURITY DEFINER` settlement and abandonment accounting retain
  owner privileges. Certificate validation, optimistic rating versions, sorted
  locks, duplicate-result semantics, RLS and append-only triggers are unchanged.
  No client/Worker protocol, learning-sync or account-isolation behavior changes.
- Six new F07 tests in `supabase/tests/verified-settlement.test.ts` cover the
  final table/column ACL catalog; real SELECT and rejected INSERT/upsert,
  UPDATE, DELETE and TRUNCATE as all three roles; zero-evidence forged history
  blocked before it can enter the duplicate-result path; and idempotent
  migration reapplication after independent column grants, including PUBLIC.
  Empty UPDATE/DELETE predicates prove privilege denial rather than relying on
  the row-level append-only trigger. Service-role tests use actual BYPASSRLS.
- The three service-role/catalog regression tests fail with the new migration
  omitted (rating upsert and forged history insertion succeed). Restoring
  it passes the full 23-test settlement suite. The access matrix now requires
  service-role DML denial, and the ordered migration inventory includes the
  additive repair; neither fence was weakened to make old tests pass.

Database owners/superusers and separately authorized admin operations are still
trusted. The migration does not inspect, re-certify or alter pre-existing rating
rows; it cannot establish whether the old privilege was ever misused. Deployed
role memberships, ownership, grants and function-body parity require a separate
authorized cutover check. A rollback must pause rating finalization, **not**
re-grant the bypass. The parent still owns final browser acceptance and all
previously listed production, real-device, performance and learning-efficacy
gates. This repair performs no UI-driven testing or production access.

### F07 execution record

Local Node `v24.21.0`, npm `11.19.0`, lockfile installed with `npm ci`:

| Check | Result on this repair branch |
| --- | --- |
| `npx vitest run supabase/tests` | **20 files, 197 tests passed**, including all 23 settlement tests and existing certified-rating/abandonment writer tests. Fresh PGlite applies every source migration. |
| `npm run worker:test` | **33 files, 529 tests passed** in local workerd. The focused rating/settlement/archive run also passed 33 tests. |
| `npm run typecheck`; `npm run typecheck:worker`; `npm run lint` | Passed. |
| `npx prettier --check` for the three changed SQL test files | Passed. |
| `npm run build` | Passed; entry `index-C4fTm6wG.js` **146.1 kB gzip** / 150 kB budget. Existing mixed static/dynamic solvency import warning remains. |
| `git diff --check` | Passed. |

The Worker run still emits test-double `supabase.test` DNS/internal-error and
event-handler-return warnings despite passing; it is not deployed backend
evidence. The root frontend suite, IndexedDB browser probes and application
Playwright acceptance were **not rerun by this F07 lane**. Their older execution
records below are historical, not results for this final revision. SQL tests
use Supabase role/auth stubs in PGlite, not hosted PostgREST/Auth or independent
PostgreSQL sessions.

## Independent acceptance repair: F08 and F10

Repair branch: `devin/1791835277-evidence-repair`, directly based on integrated
revision `7c7a4dbf84ea83544e0363d6a14f6de75faa9f05`. Both independently supplied
regressions failed on that revision before the repair. This branch changes only
client evidence recovery/capture, their tests, and this evidence record; it does
not change SQL migrations, Worker rules, rating certificates, delayed-assessment
timing, privacy/redaction contracts or rollout controls.

- **F10 / initialization is a save participant:** `SessionKeeper` synchronously
  installs `startEvidenceBootstrap` before importing the evidence runtime.
  Account reconciliation, module loading, deletion cleanup, local restoration,
  source capture and remote verification must succeed before that participant
  is ready. Failure stays blocked; ordinary account flush/sign-out retry reruns
  initialization without requiring a curriculum mount. Stopped accounts/epochs
  cannot register a late runtime, and changed deletion generations invalidate
  readiness. A partial runtime is stopped/unregistered on failure.
- **F10 / account recovery is independent of runtime registration:** whole-account
  export reads all IndexedDB stores at the database's existing version and filters
  every row by exact account ID, including unregistered and future-schema rows.
  It does not create an empty database, write/clear rows, or export another
  account. An account switch before export completion rejects the result.
  Unsupported data is recovery material, not permission to upload or claim saved.
- **F08 / current source draining:** capture requests arriving during hashing,
  enqueue, or the promise-cleanup microtask window trigger another pass using the
  latest sources. Save barriers capture current sources, extend evidence watermarks
  after delayed ACKs, and recheck participant state at account-save completion.
  Export waits for an active capture. A document changed after its own barrier
  remains unsaved unless its autosave completed; retry captures a new barrier.
  Continuous edits or service failure can still time out/block, never certify an
  older revision as the current account save.

Regression mapping:

| Boundary | Executable local evidence |
| --- | --- |
| Original bootstrap failure | `src/curriculum/learning/independent-review.test.ts` (F10) |
| Original final-grade race and promise-cleanup gap | `src/curriculum/learning/independent-capture-review.test.ts` (F08); both assert before an extra barrier/capture |
| Cleanup/restore/offline retry, no-mount initialization, account switch, delayed evidence ACK | `src/curriculum/learning/runtimeBootstrap.test.ts` (F08/F10) |
| Pre-import fence, first-read retry, generation/epoch drift, final participant recheck, late export rejection | `src/net/evidenceBootstrap.test.ts` (F08/F10) |
| Failed bootstrap cannot invoke sign-out privacy cleanup | `src/net/AccountPage.test.tsx` (F10), component test only |
| Unregistered future-schema whole-account export and no-database export | `src/net/syncOutbox.test.ts` (F10), actual headless IndexedDB API only |

Removing the final promise-cleanup re-drain reproduced the new F08 microtask
regression; restoring it passed. No application UI/manual browser testing or
production access was performed in this repair lane. Parent must run recorded
application acceptance on the repaired revision, including cold account start,
cleanup failure, recovery export/retry, final-grade save and account switching.

## Reproduce local checks

Use Node 24 (`. "$HOME/.nvm/nvm.sh" && nvm use 24`) and `npm ci` on a clean clone.
No production credentials are needed for these commands:

```sh
npm run typecheck
npm run typecheck:worker
npm run lint
npm test
npm run worker:test
npm run build
npx playwright install chromium
INDEXEDDB_BROWSER_TESTS=1 npx vitest run src/net/syncOutbox.test.ts src/curriculum/learning/cleanup.test.ts
VISUAL= npm run e2e -- --project=desktop --project=mobile --project=live
```

The SQL suite applies every source migration to fresh PGlite. It is not a
PostgREST/Auth deployment or a multi-process PostgreSQL concurrency test. Worker
tests run local workerd and fault/restart harnesses. IndexedDB tests use bare
headless documents (not application UI acceptance). CLI Playwright uses static
preview, intercepted account data and a local Worker/dev-token pair; no real
account/rating backend is configured. Visual pixel baselines are opt-in and not
claimed. Missing browser binaries must be installed at the lockfile's version,
not worked around by skipping the storage tests.

Local result totals are recorded in the final handoff section below. Entry gzip
must remain below 150 kB (`scripts/check-bundle.mjs`); the account, evidence,
curriculum and live chunks are lazy. The static/dynamic solvency import warning
does not weaken the entry-budget check.

## F01–F17 evidence index

These are actual implemented regression files and representative test names,
not the proposed names in the original plan. Full suites include more cases.

| ID | Invariant / actual regression evidence | Scope and remaining acceptance |
| --- | --- | --- |
| F01 | `src/engine/short-blind.test.ts`: `F01_nominal_bb_1000_1000_15`; both blinds short, lone bettor, dead small blind, reopening, odd chips; seeded conservation across 2–6 seats | Engine oracle; not a production exploit finding. |
| F02 | `worker/test/live-trust.test.ts`: `B2_completion_is_immutable_bounded_and_last_hand_survives_next_deal`, `B2_preflop_runout_has_4100ms_bounded_schedule_and_public_allowlist`; `src/net/LiveTable.test.tsx` presentation catch-up coverage | Immutable completion, server-owned bounded schedule, cancellation of stale presentation when a live decision arrives. Parent must inspect late frames, reduced motion and final-hand rendering in browser. |
| F03 | `worker/test/live-trust.test.ts`: `F03_lost_ack_resyncs_accepted_stand`, `F03_duplicate_rebuy_one_effect and journal survives restart`, `F03_stale_seat_retry_rejected and old unscoped controls are safe`; `src/net/clientTrust.test.ts`: `lost acknowledgement recovers accepted-pending-effect from a snapshot, then completion` | Sent ≠ accepted ≠ completed; scope-fenced retry, durable journal, no duplicate effects. |
| F04 | `worker/test/live-trust.test.ts`: `F04_restore_zero_one_two_sockets retained=%i`; existing table/alarm/reconnect suites | Restoration with zero/one/two retained sockets, absence anchored durably. Real suspend/background/poor-network device acceptance remains. |
| F05 | `worker/test/live-trust.test.ts`: `F05_host_absent_cancel_reclaims_membership; cancelled frames pass the allowlist`, `F05_cancel_races_first_deal returns game_started when the deal won`; client cancellation tests | Bounded server-owned absence and explicit cancellation outcome; first deal wins legitimately. |
| F06 | `worker/test/live-trust.test.ts`: `F06_competing_invites_one_playable_table`, `F06_old_release_cannot_erase_new_generation`, `F06_uncommitted_local_fence_cannot_release_ownership`, `F06_crash_after_each_activation_step: reserve/prepare/commit/local-commit replay` | Reserve/prepare/commit/local-commit recovery, generation fencing; TTL is not release authority. |
| F07 | `worker/test/settlement.test.ts`: exact equity replay, source substitution, zero/gapped manifest, missing archives, quarantine and bounded catch-up. `supabase/tests/verified-settlement.test.ts`: certificate, source-token and immutable duplicate-result checks; `F07 rating base-table write fence` tests final catalog, role-switched DML denial, PUBLIC/column grants and forged zero-evidence history. | Current hand receipts, terminal proof, complete manifest and certificate required by SQL rating gate; service_role has no direct rating/history write bypass. Five-minute scheduled catch-up declared/tested. Cloud preflop CPU and queue/backlog SLO remain unmeasured. |
| F08 | `src/net/sync.test.ts`: `F08_provisional_final_overlap_drains_without_edit`, changed curriculum during ACK, wrong digest, quota/size cap; `supabase/tests/learning-revisions.test.ts`; `src/net/syncOutbox.test.ts` | Exact digest/revision/generation ACK only, stable retry ID, blocked data exportable, real IndexedDB transaction probes. |
| F09 | `src/net/sync.test.ts`: `F09_both_device_arrival_orders_preserve_or_conflict (%s)`; SQL CAS and deletion generation tests; `src/curriculum/core/integration.test.ts` | Concurrent curriculum snapshots preserve an explicit conflict; device timestamp does not silently choose a winner. Live multi-device Supabase exercise deferred. |
| F10 | `src/net/Session.test.tsx`: `F10 failed first pull never calls ready and exposes unverified state`; `src/net/AccountPage.test.tsx`: failed initial pull, export failure, storage removal failure, explicit discard; `src/components/progress/ProgressView.test.tsx`: no blanket saved claim | Account/epoch-fenced producers, sign-out participant barrier, retry/export/discard; schema-unsupported account E2E explicitly confirms discard. No automatic data loss masquerading as save success. |
| F11 | `worker/test/live-trust.test.ts`: receipt −1/0/+1 boundary cases; `F11_timely_queued_receipt_not_processing_time` | Deadline judged against captured server receipt time, not delayed processing or device clock. |
| F12 | `supabase/tests/verified-settlement.test.ts`: `F12 sums actual deltas despite delayed application and resets`; `supabase/tests/ladder.test.ts` | Trends sum real deltas in played-time order; rating calculation retains application-order Glicko policy, not chronological replay. |
| F13 | `supabase/tests/verified-settlement.test.ts`: `F13 latest-500 ignores later archive/grade arrival for older play and orders decision indices` | Latest 500 by authoritative play and decision order, not arrival order; intentionally may show fewer eligible graded decisions. |
| F14 | `worker/test/live-trust.test.ts`: `F14_unavailable_is_not_unrated`; `worker/test/lobby.test.ts`: `F14 admission pause rejects rated queues while casual remains available` | Read failure never invents 1500; existing memberships resume; admission pause does not restore a default rating on failure. |
| F15 | `src/curriculum/learning/projector.test.ts`: `F15 changed numbers in a named family do not make existing curriculum fresh`; `src/curriculum/learning/LearningWorkspace.test.tsx`: `F15 exhausted family bank explains limitation instead of pretending changed numbers are fresh` | Finite family bank exhaustion is explicit. Parameter changes/regrades do not create fresh evidence. Content review remains a human pilot gate. |
| F16 | `src/lib/practiceStats.test.ts`: `F16_unknown_ev_same_covered_subset`; `src/components/progress/ProgressView.test.tsx`: unknown and equal-subset chart labels | Actual total separately shown; no invented zero for missing modeled EV, no skill claim from the realized/model gap. |
| F17 | `src/App.test.tsx`: autorepeat, held Enter across hand, consumed events, shadow-root text entry; composition tests in shortcut suite | Intentional shortcuts only; no held-key duplicate or IME/text-entry interference. |

Security coverage is orthogonal: `supabase/tests/rls-matrix.test.ts` inventories
every public/private table and security-definer function, checks exact grants,
owner isolation and pinned search paths. Worker frame allowlists and live client
architecture tests reject private deck/hole/archive and trainer-analysis leakage.

## Compatibility and additive schema cutover

`qp.v1` remains the transport envelope. New presentation, completion, own-control
and rating availability fields expand readers; commands use scoped versioned
envelopes. Legacy unscoped seat-changing messages fail closed. A cached old
client is not entitled to mutate under obsolete semantics; show upgrade/reload,
retain recovery data, and test the mixed-version boundary before admission.

Apply in source order **only after operator approval and parity review**:

1. `20261012010000_learning_revisions.sql`: revision/digest/mutation receipts,
   CAS and deletion generations; old timestamp/direct writers blocked.
2. `20261012020000_verified_settlement.sql`: private source versions, hand.v2
   receipts, terminal proofs, settlement certificates/jobs and rating gate.
3. `20261012030000_learning_evidence.sql`: append-only private owner evidence,
   evaluations, pilot protocol/assignment/consent and analysis export.
4. `20261012040000_learning_measurement.sql`: server-issued delayed-check
   timing; account/family/generation binding, owner-only issue reads, empty
   search paths for evidence RPCs, qualified effort/timing export extension.

The new fourth migration is additive; it hardens the third without rewriting
its historical text. Direct source writes, certificate writes and internal
pre-certificate rating math remain revoked from browser/service roles unless
explicitly allowed by the authoritative service API. The owner-only rating math
fixture in `season.test.ts` is not an application fallback.

Account saves require compatible revision RPCs. Permission failure,
`upgrade_required` or unsupported schema means blocked/unknown with export and
retry, **not** a fallback to timestamp overwrite. Current evidence bootstraps
lazily at account-ready setup and also at curriculum mount; it starts only after
reconciliation and fences account changes and deletion generations.

### Narrow production inventory supplied by parent

Parent's read-only inventory at 2026-10-12 18:36 UTC reported
`GET https://deltadeck.net/api/health` → `{ok:true, protocol:"qp.v1"}` and 22
migration ledger entries through avatars (`20261012000000`). Early production
versions differ from source filenames: learning_cloud `20261007192620`, players
`20261008133809`, matches_hands `20261008134201`, record_hand `20261008134322`,
abandonments_match_index `20261008134345`, record_match `20261008173914`,
record_match_no_show `20261008181317`, verify_hand `20261009213919`,
hands_created_index `20261009213923`; later baseline versions match source.
This is **ledger presence only**, not migration-body/schema parity or historical
correctness. No new migration was applied and no user data was inspected.
Do not rename source history or stamp ledger versions to simulate parity.

Before cutover: compare deployed function bodies, columns/constraints, grants,
RLS, trigger ordering, indexes and ledgers to source; test a copy/scratch DB,
mixed clients, protected-writer errors and rollback pause paths. Drain/admit
clients deliberately; do not deploy an old writer after revoking its contract.

## Gate B: what the usable measurement does and does not establish

`#learn/targeted` shows a fixed manual sequence and qualified evidence. Explicit
operator assignment + enabled protocol + learner consent + targeted arm are all
required to expose the limited recommendation. Baseline arm keeps curriculum
order/review dates. No default assignment, estimated benefit or efficacy claim.

CasePlayer checkpoints `EffortClock` with each save and visibility change:
visible monotonic elapsed milliseconds, activity capped 60 seconds after last
interaction, hidden time excluded, and resumed-session count. Provenance is
`client-monotonic`, not attention, effort honesty or learning proof. Unsupported
or corrupt metadata is rejected by persistence validation.

A passed, client-reported business-transfer submission received by the account
service anchors a seven-day server interval. The delayed-check RPC refuses early
issuance even if the client clock claims the year 2999, returns the same issue
on retry, and rejects prior heldout-family exposure. The saved submission binds
the issued case, account and deletion generation. Server read/export supplies
anchor receipt/due/issue/receipt timing independently from device completion.
Generation deletion cascades the issues; tests cover account/family theft,
early requests, repeated requests, prior exposure and stale generation.

This proves **only server receipt/issuance chronology**. Answers, assistance and
transfer evaluation remain client-reported; bundled case content is inspectable,
no proctoring exists, and delayed responses are still excluded from a retained
claim. `server-timed-self-study` is a provenance label, not a mastery stage.
The endpoint is not a hidden certified assessment. Remaining Gate B requirements:
expert content/measurement review, family/learner-separated study design,
predeclared endpoint and missingness rules, consent/recruitment, genuine elapsed
follow-up, effort-quality assessment, powered baseline comparison, harms and
uncertainty review. None can be replaced by synthetic passing tests.

The service-only export contains all assignments, including non-consent and
non-return, raw versioned outcomes/invalidations and qualified measurement. No
raw prose/answers/email are exported. Analysts must reconcile invalidation and
supersession, handle missing outcomes and withdrawal/deletion explicitly, and
not condition analysis solely on returned successful learners.

## Rollout, pause and rollback runbook

Safety invariants are not flags: nominal bring-in, private-card redaction,
membership fencing, receipt-time deadlines, certificate gate and revision CAS
cannot be disabled to recover traffic.

| Control | Actual semantics / safe use |
| --- | --- |
| Worker `TRUST_PAUSE_RATED_ADMISSION=true` | Reject new rated enqueue and skip waiting rated pairs. Existing active membership resumes; casual play remains available. Environment/operator-controlled, not browser input. |
| Worker `TRUST_PAUSE_RATING_FINALIZATION=true` | `applyRating` returns retryable 503 before certificate/rating calls. Durable outbox retains work; verification/archive can continue. Catch-up may update evidence/certificates but cannot apply ratings while paused. |
| `learning_pilot_protocols.enabled=false` | Stops limited-pilot exposure/ingest authorization. Returns to honest fixed/shadow behavior; does not imply evidence is proven or restore unsafe writes. Require client refresh/re-read during cutover. |
| Account sync pause | Operator can revoke protected RPC execution while preserving reads/export; client shows blocked/unknown and retains work. No direct-write fallback. Coordinate account UI compatibility and privacy checks. |
| Settlement scheduled recovery | `*/5 * * * *` calls `catchUpSettlements`: four leased candidate matches, at most two hand replays each. Queue is a wake-up, not truth. Removing the cron alone is not a complete finalization pause. |

These are future operator actions, not actions taken by this lane. Stage first;
record owner, prior config, change revision and time. Re-enable only after the
invariant-specific problem and backlog are understood. A rollback may pause a
capability or roll back presentation, but never regrant legacy source writers,
rate an unverified match, default an unavailable rating, or call unsaved data saved.

### Settlement incident

1. Keep authoritative play separate from analysis. If backlog/CPU is unsafe,
   pause new rated admission and/or finalization; preserve hand/terminal outboxes.
2. Inspect match ID, logs (`verify_failed`, `outbox_retry`, `outbox_parked`,
   `error reason=settlement_catchup`) and authorized `audit_settlement` output.
   Avoid exporting private deck/hole evidence into ordinary logs/client frames.
3. Run `classifySettlement(env,id)` **without** `write:true` for read-only shadow
   classification. Missing archive/verification is pending; failed evidence is
   quarantined; old proofless matches are legacy-unproven, not newly rated.
4. Investigate source token/verifier version/terminal manifest/reason and lease
   state. Bounded scheduled recovery can replay current missing evidence. Do not
   invent a terminal proof or bypass the certificate transaction.
5. A rated source changed later requires approved dependency-aware correction;
   immutable historical effects are not “fixed” by applying twice. Old archive
   replay can invalidate certificates; reverify before any further finalization.

### Account or evidence incident

1. Capture current account/epoch, scope generation, source kind/id, revision,
   digest and blocked/conflict status, without logging answer bodies.
2. Retry reconciliation; preserve divergent local/remote documents. Export is
   recovery, not proof the account save succeeded. Never clear dirty bits on
   quota/cap/permission failures.
3. On sign-out, wait for current uploads/producers; on failure offer stay/retry,
   verified download + explicit confirmation, or second-confirmation discard.
   Failed removal is a visible privacy failure and must not finish silently.
4. Clear scopes using the generation-fenced RPC, then clean the current account's
   IndexedDB rows atomically. No stale callback or issue may resurrect old data.

## Metrics limitations and acceptance checklist

Client latency spans use local monotonic intent/sent/frame/render timestamps
with decision identity; server receipt/application/presentation timestamps are
separate. Do not subtract unsynchronized clocks into an end-to-end latency claim.
Completion timing/count tests establish bounds, not smoothness percentiles.
Local exact-equity wall time is not deployed Worker CPU quota headroom. No
production rate, p95/p99, measured learning effect or operational SLO has been
established. Define owners/budgets and collect minimized pilot telemetry before
widening admission. Practice EV coverage, displayed ratings and structured
learning evidence remain separate constructs.

- [x] Implemented cross-lane seams, protected fixtures and local provenance tests.
- [ ] Parent recorded app acceptance on final revision (including new delayed flow).
- [ ] Deployed protocol/schema/function-body parity and staged mixed-client cutover.
- [ ] Real-device/suspension and real two-account/two-device recovery acceptance.
- [ ] Deployed verification CPU/backlog, scheduled wake-up, alarms and operator drills.
- [ ] Human pilot protocol/content/ethics review and genuine delayed follow-up.
- [ ] Statistical efficacy evaluation and a separately approved recommendation rollout.

## Historical integration execution record (before independent repairs)

- Frontend full suite: **131 files, 1,537 tests passed**, with 11 browser-gated
  tests skipped by default. Final changed-learning/runtime/Session/Progress rerun:
  **5 files, 38 tests passed** (two gated storage tests excluded here and already
  exercised in the explicit browser run). An earlier CasePlayer/FoundationWorkspace
  component run also passed **3 files, 33 tests**.
- Worker full suite on the pause-control revision: **33 files, 529 tests passed**.
- Explicit real IndexedDB probes: **2 files, 11 tests passed** (the default skips
  above were exercised separately, not waived).
- CLI Playwright: initial complete run **60 passed / 2 stale assertions failed**;
  repaired and reran both, **2 passed**. The sign-out fixture intentionally lacks
  the new account RPCs, so it now asserts blocked save and two-step discard. The
  progress test uses the honest model-coverage heading, not “Luck versus skill”.
  All 62 scenarios passed across full+targeted runs; not a fresh monolithic rerun.
- Frontend typecheck, Worker typecheck, ESLint and production build passed during
  integration and again after final runtime/selection hardening. Entry
  **146.1 kB gzip**, under 150 kB. Final `git diff --check` passed.
- Worker negative-input tests intentionally log rejected frames/table reports;
  local fake-host DNS warnings occurred with the suite still passing. No cloud
  runtime claim is inferred from these logs.
- No active Git pre-commit hook was present (`.git/hooks` contains samples only).

## F08/F10 independent-repair execution record (prior revision)

Executed locally with Node **24.21.0** against the repaired source, 2026-10-12:

- Final clean-revision `npm test`: **135 files, 1,556 tests passed**; two optional
  storage files / 13 tests skipped by the default browser gate, not waived.
- Explicit `INDEXEDDB_BROWSER_TESTS=1 npx vitest run src/net/syncOutbox.test.ts
  src/curriculum/learning/cleanup.test.ts`: **2 files, all 13 tests passed**.
  Installed the lockfile-selected Chromium via the documented
  `npx playwright install chromium`; these are bare-document API tests only.
- Final focused rerun of the two independent probes, runtime/bootstrap,
  practice-sync, Session and AccountPage suites: **8 files, 73 tests passed**.
- `npm run worker:test`: **33 files, 529 tests passed**. No Worker source changed.
  Existing workerd negative-input/fake-host DNS warnings were emitted; not
  interpreted as production observations.
- Final `npm run typecheck`, `npm run typecheck:worker`, `npm run lint`,
  `npm run build` and `git diff --check`: **passed**. Entry **146.1 kB gzip**
  (Vite raw display 146.15 kB), below the unchanged 150 kB budget. Evidence
  runtime and IndexedDB writer/recovery module remain lazy-loaded.
- No active Git pre-commit hook. No PR, merge, deploy, production query/mutation,
  app UI/manual browser test or CI/security-control change in this repair lane.
  An optional Chromium-cache environment suggestion is approval-gated and is
  not a repository or production configuration change.

The remaining acceptance and release gates above are unchanged. These local
results are not new evidence of production parity, real-device/browser recovery,
operational performance or learner effectiveness.
