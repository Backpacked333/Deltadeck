# Private learning evidence / narrow pilot

This is qualified self-study, not a rating, a certified assessment or evidence of
learning effectiveness. Raw immutable submissions, versioned evaluations,
invalidations, projections and policy snapshots are distinct. Only three skills
are mapped. Existing unmapped curriculum and trainer history is retained but
does not silently acquire skill provenance. No live cards, realized winnings or
rating records enter the learner projection.

## Connection and durability

`Curriculum` starts `startLearningEvidence()` and attaches its `LearningSession`.
The singleton remains active after leaving learning. It waits for the account
sync's reconciliation and deletion generations, registers a save participant,
then captures curriculum attempts and practice record revisions with stable IDs
through `DurableOutbox`. The participant includes already-started capture in its
barrier. Rejected enqueues are never called durable. Unsupported data is blocked
and exportable. Account epoch checks guard late responses and in-memory sessions.

**Parent integration:** also invoke the lazy initializer once from the account-ready
bootstrap, outside this lane's ownership:

```ts
void import('./curriculum/learning/runtime').then(m => m.startLearningEvidence())
```

Without that call, first-time trainer-only use is not observed until learning is
opened; only the bounded available practice history can be backfilled. Do not
claim complete trainer capture before this integration. Use the existing
revision writer for raw trainer durability regardless.

The additive `20261012030000_learning_evidence.sql` migration follows the revision
migration. RPCs: `ingest_learning_evidence_v1`, `read_learning_evidence_v1`,
`learning_pilot_consent_v1`; account deletion fences purge dependent evidence.
`cleanupDeletedEvidence` uses the public `openOutbox` schema-v1 seam to remove
explicitly server-deleted events and jobs in one epoch-checked transaction;
unrelated and future-generation work is preserved. No sync/account file is edited.
Migration application and release coordination belong to the parent release gate.

## Rebuild, content and claim limits

`project(rows, accountId, serverNow)` is a deterministic versioned rebuild.
Duplicate IDs dedupe; divergent IDs conflict. Grades are checked against the
supported versioned rubric. A superseded invalidated grade cannot resurrect its
predecessor. Specific error signatures across independent contexts support only
a *hypothesis*; successful counterevidence contests it. Later failure can lower
the current stage. Arbitrary wrong answers do not establish a misconception.

Sixteen authored tasks cover worked ledgers, fading support, unaided poker,
business transfer and held-out families. Reserved sequential joint sampling and
opportunity-cost comparison change structure, not only numbers. Exposed or
repeated families never become fresh on regrade. Family exhaustion explicitly
falls back to revisiting for practice or choosing another focus.

Every source remains `client-reported`, with uncertain device completion time.
Server receipt anchors the earliest review invitation, **not** verified completion
after the delay. Consequently `retained` is never awarded by this projector.
Server-issued assessment/timing provenance is future work, not a hidden upgrade.

## Shadow and pilot

`#learn/targeted` shows qualified evidence and a fixed learner-selected practice
sequence. Targeted selection remains shadow unless an operator has configured an
enabled protocol and targeted assignment and the learner explicitly consents.
Baseline assignments retain curriculum order and review dates. There are no
default assignments, efficacy claims or sample-size conclusions.

Recommendation snapshots include source cutoff, policy/projector versions,
candidate ranking and exclusions, evidence links, falsifiable hypothesis,
mechanism, estimated effort/assistance and follow-up. Their deterministic epoch
`observedAt` is a snapshot sentinel; use the separate server `receivedAt` for
exposure chronology. Mismatch and alternate-focus feedback are immutable inputs.

`export_learning_pilot_v1(protocol)` is service-only and includes all assignments,
including non-consent/non-return, arm/stratum, exposure/start/decline records and
raw outcomes/versions with held-out-family flags. Analysts must resolve
supersession/invalidation, separate learner and family splits, predeclare missing
outcome handling, and qualify device-clock data. It is an analysis foundation,
not a causal estimate. Actual effort instrumentation, server-verified delayed
assessment, protocol approval, expert content review and a powered efficacy study
remain release/pilot work. Deletion removes participant-level rows rather than
retaining a hidden study copy.

## Local checks

Use Node 24. `npm run typecheck`, `npm run lint`, `npm run build`;
`npx vitest run src/curriculum src/net/sync.test.ts supabase/tests/learning-evidence.test.ts supabase/tests/learning-revisions.test.ts`.
Real storage probes: `INDEXEDDB_BROWSER_TESTS=1 PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=$(command -v google-chrome) npx vitest run src/curriculum/learning/cleanup.test.ts src/net/syncOutbox.test.ts`.
These use a bare headless document, not application UI acceptance. Runtime RPC
unit mocks and PGlite SQL tests are separate layers; deployed end-to-end acceptance
is not claimed. No production migration, user data access or browser testing was
performed in this lane.
