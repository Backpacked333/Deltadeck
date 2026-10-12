# DeltaDeck trust contracts — implementation lock v1

Status: **proposed implementation contracts, not shipped guarantees**. Source inspected at
[`9de1fd868f55358bd8e0926487750673752a914a`](https://github.com/Backpacked333/Deltadeck/commit/9de1fd868f55358bd8e0926487750673752a914a).
The [original 17-section plan](trust-implementation-plan.md) is preserved verbatim. This
document narrows its seams for the bounded lanes; it does not replace its release gates.
This branch changes only those two documents. No migration, production inspection,
deployment, browser acceptance, efficacy study, or application repair is claimed here.
**Production schema/Worker/client parity is unverified.** Historical `.10x` merge/deploy
instructions are overridden by the current code-only, parent-controlled release brief.

## 0. Integration rules and observed baseline

`TableDO` remains game authority; the **single `LobbyDO` named `global`** owns account
claims (`worker/src/lobby.ts:lobbyStub`). Its `forUsers()` mutex serializes accounts but
does not survive process loss. SQL, exact verification, grading, and projections stay
off the betting path. Rated means fresh-deck heads-up, persisted format `hu-duplicate`
(a legacy name, **not** duplicate decks). Six-max is casual/ungraded. Trainer is a
separate browser engine. No live module imports coaching or learner diagnosis.

### Owners and sequencing

| Owner | Exclusive seams | Consumers / order |
| --- | --- | --- |
| live | `worker/src/{table,lobby,deadlines,games,controller}.ts`, `src/shared/protocol.ts`, live helpers/tests; archive serialization in `supabase.ts` only | Supplies contracts 1–4 and terminal/manifest types to rating and presentation. Both branch from live. |
| rules | `src/engine/hand.ts` and needed engine types/tests, practice shortcuts (`src/App.tsx`), `src/lib/practiceStats.ts`, display consumers outside net/curriculum | F01/F16/F17; send net/curriculum display patches as requests to their owners. Do not edit luck/deck/runout. |
| sync | `src/net/sync.ts`, `AccountPage.tsx`, `Session.tsx`, new sync helpers/tests, `20261012010000_learning_revisions.sql` | Publishes generic outbox and status interfaces below. Learning branches from sync. |
| rating | `worker/src/{verify,rating,rated,grade,stats,supabase}.ts`, new settlement helpers; only necessary `index.ts`/`env.ts` routing, rating/history display helpers, `20261012020000_verified_settlement.sql` | Consumes live terminal proof. Cannot change table/lobby/protocol without parent handoff. |
| presentation | `src/net/{client,useTable,LiveTable,SixTable,MatchEnd,TurnClock}`, relevant UI/CSS/tests, `src/state/runout.ts`, trust-state e2e specs | Consumes actual live protocol; cannot author a competing protocol. |
| learning | `src/curriculum/**`, new lazy evidence modules/tests, `20261012030000_learning_evidence.sql` | Uses sync adapter, not sync internals; no live coaching wiring. |
| parent / independent acceptance | shared-file integration, browser/SQL/Worker fault acceptance, release decision | Owns cross-lane conflicts, release packet, real-browser timing, production authorization. |

Only additive uniquely named migrations above may be introduced by their owner; do
not edit old migrations or CI/security merge controls. DB permission tightening required
by these contracts preserves RLS; it is not permission to weaken access policies.

### Existing policy constants to keep

| Policy | Observed definition | Contract |
| --- | --- | --- |
| Start | `lobby.ts:START_WITHIN_MS = 30_000` | Use for admitted invite/paired start; do not substitute 60 seconds. |
| Reservation | `games.ts:RESERVE_MS = 60_000` | Accepted guest reservation, distinct from admitted start window; use same bound for internal uncommitted activation lease. |
| Reconnect | `rated.ts:GRACE_MS = 60_000` | Rated and six; persist observation/deadline, never refresh on restart. |
| Timeout | `deadlines.ts:FORFEIT_TIMEOUTS = 3`, `SIT_OUT_TIMEOUTS = 2` | HU forfeits; six sits out, not competitive forfeit. |
| Match rules | `RATED_CONFIG`: 40 hands, 2000 chips, 10/20, 20s decision + 60s bank, refill every 20 hands | Casual HU 20 hands; six 20s + 30s bank with orbit refill. |
| End policy | `table.ts:VOID = ['no_show','engine_fault','abandoned']` | All three remain void/unrated; a no-show must not become a win. |
| Retention | `deadlines.ts:IDLE_MS = 600_000`, invite TTL 24h | Neither is authority to release a playable membership. |
| Six seating | 6-hand / 120s stand cooldown; 3-orbit / 300s sit-out removal (whichever first) | Keep existing restrictions; retry never creates a fresh seat entitlement. |
| Rating | `DRAW_BAND_BB = 2`; `outcomes()` uses `+ 1e-9` chips at boundary | Keep draw policy and application-order Glicko `glicko2.v1`. |
| Saves | record 8192 bytes, curriculum 1,200,000 bytes, 1000 new practice hands/day | Limits produce explicit blocked status, never discard-to-success. |
| Review | `assessment.ts`: first 3 days, then 10/30 after passes, 1 after failed/assisted review | Preserve existing self-study schedule; time provenance controls retention claims. |

### Common notation

The following are **exact proposed public names and payloads**, to implement in the
owning files, not executable stubs in this branch. Imported baseline types retain their
meaning. JSON integer fields must be safe nonnegative integers; seats are 0–5 (rated
exactly 0,1); milliseconds are server epoch milliseconds unless explicitly monotonic.
`Digest` means SHA-256 lowercase hex of UTF-8 canonical JSON: recursively sorted object
keys, array order retained, finite JSON numbers only, normalize `-0` to `0`, no undefined
properties. Implement one cross-runtime canonicalizer with TS/SQL golden vectors.
No private archive object is ever spread into a frame.

```ts
type Digest = string
type Generation = number
type HandKey = { tableId: string; matchId: string; handNo: number }
type DecisionKey = HandKey & { actionIndex: number; seat: number }
type MembershipRef = { tableId: string; userId: string; generation: Generation }
type SeatScope = { membership: MembershipRef; seat: number; seatGeneration: Generation }
```

`tableId` stays fixed for a six table; `matchId` is its current session id. `handNo`
alone is never globally unique. `seq` remains frame ordering; new `stateVersion`
increments on durable authoritative transitions, not ping/presence-only frames.

## 1. Membership, generations, and fenced activation — live

**Authority:** global LobbyDO stores invitation separately from reserved/active claims.
TableDO stores the accepted/committed activation and refuses start/play without it.
An unfilled invitation is shareable while its host queues elsewhere; pre-seating the
host conveys no active claim. Activation reserves *both* HU participants, not just guest.

```ts
type MembershipClaim = MembershipRef & {
  v: 2; activationId: string; state: 'reserved' | 'active'; reservedUntil: number
}
type ActivationV1 = {
  v: 1; activationId: string; tableId: string
  members: MembershipRef[] // canonical userId order; two for HU, one for six sit
  state: 'reserved' | 'prepared' | 'committed' | 'cancelled' | 'released'
  reservedUntil: number; committedAt: number | null
}
type ActivationResult =
  | { status: 'reserved' | 'committed'; activation: ActivationV1 }
  | { status: 'busy'; tableId: string }
  | { status: 'cancelled' | 'expired' | 'unavailable' }
// Internal authenticated DO RPCs; never browser-supplied account identities.
interface MembershipRPC {
  reserveActivation(input: { activationId: string; tableId: string;
    userIds: string[] }): Promise<ActivationResult>
  commitActivation(input: { activationId: string }): Promise<ActivationResult>
  activationStatus(input: { activationId: string }): Promise<ActivationResult>
  releaseMembership(input: { member: MembershipRef;
    terminalOrRevocationId: string }): Promise<{ released: boolean }>
}
interface TableActivationRPC {
  prepareActivation(activation: ActivationV1): Promise<{ prepared: boolean }>
  confirmActivation(input: { activationId: string }): Promise<{ committed: boolean }>
  revokeActivation(input: { activationId: string; revocationId: string }):
    Promise<{ revoked: boolean; alreadyPlaying: boolean }>
}
```

Durable keys: `member:v2:<userId>`, `member-generation:<userId>` (never reset on release),
`activation:<id>` in lobby; `activation:<id>` and irreversible revocation tombstone in
table. Table seat generations increase every seat reassignment, not reconnect.

1. Under account serialization **and one local storage transaction**, lobby either
   writes all reservations + generations + activation or none. Never await a network
   call inside a storage transaction. Reuse `activationId` on all retries. Set the
   uncommitted lease once to `reservedAt + RESERVE_MS`; retry does not renew it.
2. Table validates identities/current invitation eligibility, durably prepares token;
   preparation cannot deal. Lobby commits only if all matching reservations still
   exist and are unexpired. Persist commit before confirming to table.
3. Table reads lobby's committed status, matches all generations, then persists local
   commitment before entering starting/playing. Commit authorizes ownership; it does
   not skip start/presence/deadline rules. Conflicting/superseded tickets fail closed.
4. A reconciler resumes durable records after every interruption. Prepared but
   uncommitted may expire: lobby records cancellation; table cannot confirm it.
   Once lobby committed, **no TTL release**: terminal/revocation must be durably
   acknowledged by the table first. Revocation fences future deal/action admission;
   delayed prepare/confirm cannot undo a revocation tombstone. When uncertain, retain
   claim and reconcile, never make another playable authority.
5. Compare-and-release matches **account + table + generation**, with corresponding
   durable terminal/revocation id. Old cleanup cannot clear a newer seat/table. A
   consumed invitation token cannot reacquire ownership. Listings and heartbeat expiry
   are discovery concerns only.

Invited guest admission starts the existing 30s start bound. Cancel before first deal
revokes the activation, releases both matching claims, and returns `cancelled`; no
competitive penalty. At/after first deal return `game_started` and current snapshot,
not success. Deadline expiry before deal is `no_show` (void) and authoritative release;
pre-deal user cancel is a separate noncompetitive cancellation, not an abandonment
penalty. The invite may be closed without changing the history of other claims.
Quick-sit, queue, rematch, invite and resume all use this same ownership path.

**F14 rating read:** replace `Promise<number>` with
`{status:'rated',rating:number,version:number} | {status:'unrated'} |
{status:'unavailable',retryAfterMs:number}`. Successful empty row is unrated/default
1500; failed/malformed read or missing production configuration is unavailable.
Rated queue returns `rating_unavailable` and does not pair; casual remains usable.

**Compatibility:** migrate old `active:<userId>` string by asking the old table's
durable state. Fence or finish old playable authority before issuing v2. An `open`
liveness response alone cannot free a still-authorized old table; adopt/fence it first.
Unknown or unreachable table stays unavailable. New invites carry no legacy active
pointer. No generation-only lobby implementation qualifies as fencing.

**Forbidden:** guest-only acquisition; release on heartbeat/TTL; prepare → playing;
cancelled → committed; stale release → new claim deletion. Example: host H has links
T1/T2; simultaneous guests produce exactly one committed H claim; loser never deals.
Assertions: `F05_host_absent_cancel_reclaims_membership`,
`F05_cancel_races_first_deal`, `F06_competing_invites_one_playable_table`,
`F06_crash_after_each_activation_step`, `F06_old_release_cannot_erase_new_generation`,
`F14_unavailable_is_not_unrated`.

## 2. Seat commands, accepted intent, and retry — live → presentation

Extend the existing `reqId` discipline; do not add a second socket transport. Poker
`act` retains its decision-key checks. New own-player snapshot fields and command
outcomes are private to the account's accepted socket. Spectators get neither.

```ts
type SeatCommandV1 = {
  t: 'seat_command'; v: 1; commandId: string; tableId: string
  kind: 'stand' | 'sit_out' | 'sit_in' | 'rebuy'
  membershipGeneration: Generation; seatGeneration: Generation
  expectedStateVersion: number; hand: HandKey | null
}
type CommandOutcomeV1 = {
  t: 'command_outcome'; v: 1; commandId: string
  disposition: 'accepted' | 'rejected' | 'stale' | 'unknown'
  effect: 'pending' | 'completed' | 'none'; stateVersion: number
  reason: 'ok' | 'wrong_membership' | 'wrong_seat' | 'wrong_hand' |
    'state_changed' | 'illegal_now' | 'id_reused' | 'retry_expired' |
    'upgrade_required' | 'not_found'; scope: SeatScope | null
}
type OwnControlV1 = {
  scope: SeatScope | null; stateVersion: number
  pendingIntent: { commandId: string; kind: SeatCommandV1['kind'];
    acceptedAtVersion: number; appliesAfter: HandKey | null } | null
  standing: boolean; commandOutcomes: CommandOutcomeV1[]
}
type CancelStartV1 = { t: 'cancel_start'; v: 1; commandId: string;
  tableId: string; activationId: string; membershipGeneration: Generation }
type CancelStartResultV1 = { t: 'cancel_start_result'; commandId: string;
  status: 'cancelled' | 'game_started' | 'stale'; stateVersion: number }
type CommandQueryV1 = { t: 'command_status'; commandId: string }
```

`unknown/not_found` is a status-query result, not acceptance or permission to replay;
`scope:null` covers unavailable/retired owner scope without leaking another occupant.

Use validated id syntax already used for `reqId` (1–64 URL-safe characters). The server
derives user identity from socket auth. A durable journal indexed by owner/id stores
payload digest, scope, disposition/effect and creation time, **atomically with mutation**.
Exact duplicate returns stored result, no new effect. Same id/different payload rejects.
Recognized old-scope outcomes may be returned to their original owner but never applied
to a new scope. No new occupant's data is included. Keep outcomes at least the existing
10-minute resume window; persist a retry floor/id retirement policy so an evicted id
cannot execute as new (scoped expectedStateVersion plus retained compact retirement
metadata). Beyond the supported horizon return `retry_expired` and demand resync.

On stand: accepted intent is durable now, actual seat removal may await the current
hand; snapshot exposes standing/automatic action policy from server. Betting controls
continue following legal actions until acceptance. On rebuy: chips and receipt commit
together. Concurrent stand/sit-out/rebuy must either serialize a legal result or reject
with actionable latest state; acceptance does not optimistically change chips.

Client reducer: `idle → sending → accepted-pending-effect → completed`; negative result
→ `rejected`; watchdog/disconnect → `outcome-unknown`, not accepted. Proposed watchdog
5s is feedback only, not a server timeout policy. Reconnect first resyncs own scope and
queries id; retry the identical still-applicable id only. A changed hand/seat/version
requires a new explicit user intent. Pending state must not conceal legal controls.
`cancel_start` uses the same journal, with first-deal/cancel atomic ordering.

**Compatibility:** introduce `qp.v2` subprotocol for these semantics. Keep `qp.v1`
reader/upgrade path during the approved window but reject old unscoped stand/sit/rebuy
mutations with `upgrade_required`, never infer scope for them. Do not force-refresh away
unexported local work. New `sit` admission receives its generation through membership
activation; it must not bypass contract 1. Existing `act` remains supported only where
its authenticated seat/decision scope is provably current.

**Forbidden:** `send()` → accepted; timeout → success; old rebuy → duplicate chips;
old stand → new occupant removal. Assertions: `F03_lost_request_keeps_legal_actions`,
`F03_lost_ack_resyncs_accepted_stand`, `F03_duplicate_rebuy_one_effect`,
`F03_stale_seat_retry_rejected`, `F03_legacy_unscoped_mutation_requires_upgrade`.

## 3. Recovery, deadlines, and terminal provenance — live → rating

**Authority:** durable table state, accepted socket set, server ingress time. Socket
callbacks and alarms are wakeups, never proof that an unobserved disconnect occurred.
Persist both the observation and cause; do not backdate missing callbacks.

```ts
type AbsenceV1 = { userId: string; seat: number; seatGeneration: Generation;
  observedAt: number; deadlineAt: number; source: 'socket_close' | 'recovery' }
type DeadlineEvidenceV1 = {
  id: string; decision: DecisionKey; deadlineAt: number; processedAt: number
  action: 'check' | 'fold'; consecutiveTimeouts: number
}
type HandManifestEntryV1 = {
  id: string; handNo: number; terminalStateVersion: number; completedAt: number
  recordDigest: Digest; archiveDigest: Digest; requiredVerifier: 'hand.v2'
}
type TerminalProofV1 = {
  v: 1; id: string; matchId: string; tableId: string; activationId: string
  policyVersion: 'terminal.v1'; rulesVersion: 'hu-rated.v1'; configDigest: Digest
  participants: (MembershipRef & { seat: number; seatGeneration: Generation })[]
  reason: 'complete' | 'forfeit' | 'no_show' | 'engine_fault' | 'abandoned'
  cause: 'hand_limit' | 'timeout_streak' | 'voluntary' | 'start_deadline' |
    'mutual_absence' | 'engine_fault'
  terminalStateVersion: number; finishedAt: number; startedAt: number | null
  startDeadlineAt: number | null; firstPresenceAt: Record<string, number>
  absences: AbsenceV1[]; timeoutEvidence: DeadlineEvidenceV1[]
  voluntaryCommandId: string | null; forfeitingSeat: number | null
  completedHands: HandManifestEntryV1[]
  interruptedHand: { hand: HandKey; actionIndex: number;
    disposition: 'excluded_incomplete'; archiveDigest: Digest } | null
}
```

Terminal proof and ordered manifest are service-only durable outbox data, not public
frames. `archiveDigest` binds record, commitment, public reveal, private deck/secret
and dealt identities via canonical hashing; it is not authorization to disclose them.
`recordDigest` binds immutable public hand record including final luck values. Append
manifest entry only after final hand/adjustment is fixed. Archive proof and interrupted
hand evidence before deleting DO storage. Missing rows leave settlement pending.

### Deterministic ingress rule

Capture `receivedAt = clock()` before awaits. Serialize table mutations so later ingress
cannot overtake earlier ingress. At receipt **equal to or later than deadline is late**;
client timestamps never override. Process prior admitted commands in receipt order,
then reconcile due transitions at that command's receipt time, then validate its scope.
A timely packet queued behind other work is not made late by processing delay. Alarms
participate in the same serialized transition ordering; each uses its captured time.

Order before a mutation: validate auth/capability → reconcile accepted socket ownership
and establish missing absences once → resolve match-level mutual absence/start terminal
rules → expire relevant grace/turn transitions → next-hand/start → validate command.
Process all due transitions against their hand/decision key, with a bounded loop and
immediate re-arm if needed. Never skip due transitions to accept a stale action.

### Policy matrix

| Observed state | Required transition |
| --- | --- |
| Restored with two valid sockets | No artificial absence; retain actual decision deadline. |
| One absent, no recorded absence | Set recovery observation and +60s grace once; reconnect clears only its matching absence. |
| Zero sockets | Establish/retain both absences; evaluate both-expired before any individual timeout forfeit. |
| Both absent, one grace still running | No accidental competitive terminal from absence-driven timeout streak. Keep/defer that terminal until presence/grace policy resolves; do not shorten the other grace. |
| Both absent and both graces expired | `abandoned`/`mutual_absence`, void, not winner by loop order. |
| One absent past grace, opponent present | Existing instant check/fold on absent turns; three consecutive timeouts forfeit. |
| Six absent past grace | Sit out from next hand; current hand follows clock, never rated forfeit; normal removal/cooldown rules. |
| Paired/admitted invite missing player at 30s | `no_show`/`start_deadline`, void; absence record proves who did not arrive. |
| Complete rated match | Exactly 40 completed hands and manifest, outcome from adjusted totals. |
| Engine fault | Void with restricted incident evidence. |

Repeated restart must not extend an existing grace. A late reconnect cannot undo an
already effective terminal transition; deadline reconciliation precedes acknowledging
the new connection's participation. Abandonment statistics remain distinct from win/loss.
There is no baseline explicit HU forfeit client frame: do not label disconnect as
voluntary. If introduced by an approved control, require a durably accepted owner command
and bind its id; otherwise `cause:'voluntary'` is not a valid proof.

Compatibility: normalize stored v1 match/deadline records on restore, leaving evidence
of what was genuinely observed. Legacy unknown disconnect time becomes a new observation,
not invented past evidence. Cannot relabel legacy matches `terminal.v1` without proof.
Terminal prefix excludes an unfinished current hand from chip/adjusted sums; forfeit
outcome overrides completed-prefix totals, while explicit interrupted evidence explains it.

**Forbidden:** restore → inferred backdated forfeit; restart → renewed grace; stale alarm
→ new decision fold; complete with zero hands; no-show → rating win.
Assertions: `F04_restore_zero_one_two_sockets`, `F04_restarts_do_not_extend_grace`,
`F04_mutual_absence_precedes_forfeit`, `F11_receipt_equal_deadline_is_late`,
`F11_timely_queued_receipt_not_processing_time`, `F11_late_alarm_cannot_accept_move`.

## 4. Hand completion, short blinds, and presentation — live → presentation; rules

**Authority:** engine owns chips/legal actions; server owns completion schedule. UI owns
only rendering inside the bound. Baseline `NEXT_HAND_MS=3000` conflicts with current
runout's 900 + 900 + 1400 + 900 = 4100ms preflop. Replace duration guessing with one envelope.

```ts
type PublicCompletedHandV1 = {
  hand: HandKey; board: number[]; shown: { seat: number; cards: [number, number] }[]
  participants: { seat: number; seatGeneration: Generation; username: string }[]
  stacksBySeat: Record<number, number>; pots: { amount: number; eligible: number[] }[]
  awards: { seat: number; amount: number }[]; netBySeat: Record<number, number>
  showdown: boolean // no folded holes, deck, secret, luck equity or account notes
}
type HandCompletionV1 = {
  v: 1; hand: HandKey; terminalStateVersion: number; completedAt: number
  resultAvailable: true; final: PublicCompletedHandV1
  schedule: { version: 'completion.v1'; shape: 'fold' | 'river' |
    'all_in_preflop' | 'all_in_flop' | 'all_in_turn';
    beats: { offsetMs: number; boardCount: 0 | 3 | 4 | 5 }[];
    resultHoldMs: number; earliestNextDealAt: number }
}
type DecisionTimingV1 = { decision: DecisionKey; stateVersion: number;
  startedAt: number; deadlineAt: number }
// Add to welcome/state; hand_end carries the same persisted completion.
type PresentationStateV1 = { completion: HandCompletionV1 | null;
  currentDecision: DecisionTimingV1 | null; serverNow: number }
```

Proposed schedule v1 uses existing reveal beats and a **900ms visible result hold**:
fold/normal river have immediate result, earliest deal +3000ms (preserve existing
pause); all-in preflop beats +900/1800/3200ms for 3/4/5 cards, earliest +4100ms; flop
beats +900/2300ms for 4/5, earliest +3200ms; turn beat +1400ms for 5, earliest +3000ms
(minimum ordinary pause). Zero-card beat may describe preflop starting board. Compute
schedule from replay/event shape, not whichever client happened to observe prior state.
Final match hand gets same envelope even though no next deal occurs. Completion/result
must be durably stored before next-hand deadline; no animation acknowledgements gate play.

Client retains immutable completion independently from latest view. Normal delivery
shows permitted beats then result hold. If a newer decision is live, **show that decision
immediately**, skipping obsolete animation; never spend another 4100ms replaying history.
Late/background/resync uses current `serverNow`/schedule and monotonic elapsed time, not
unbounded wall-clock subtraction. Uncertain clock/delivery age favors snapping to current
state. Reduced motion shows final immediately but never accelerates shared schedule.
Expose Last hand at least until replaced by a newer completion, and link durable post-match
review where available. Missing archive is “review pending/unavailable”, not fabricated data.
Own cards from a prior hand must remain owner-scoped; never keep them through account switch.
Cancel callbacks on hand/seat generation, resync, reduced-motion change and terminal transition.

**F01 rule seam:** on multiway preflop use nominal BB as bring-in, separate from actual
posted chips. In 10/20 with BTN/SB/BB stacks 1000/1000/15, deep call is 20, minimum raise
to 40, paid contributions remain 20/20/15: main pot 45 (three eligible), side pot 10
(deep two). Audit completion, raise reopening, effective caps and refunds, not only labels.
When only one funded opponent can contest additional chips, preserve HU cap/refund policy;
never manufacture blind deficit. No changes to luck/deck modules. Every action conserves chips.

UI matrix: searching, waiting host, reserving, seat rejected, acting/action pending,
command unknown, reconnecting/resyncing, standing accepted, reveal/result hold, match ended,
rating pending, review unavailable, learning conflict, unsaved sign-out. Account states belong
to sync UI. At 1366×768 cards/actions/clock remain together, “raise **to**”, stable keyboard
focus, neutral controls, reduced motion. F17 practice keyboard rejects `repeat`, `isComposing`,
modifiers, prevented events and input/textarea/select/contenteditable targets without stealing
normal typing. Keep browser shortcut defaults outside intentional game handling.

Telemetry adapter: correlate command/decision/hand + stateVersion with local monotonic
`intentAt`, `sentAt`, `frameAt`, `renderedAt`; server acceptance has a separate server span.
Never subtract timestamps across machines. No hands/notes/tokens in telemetry. Report p95/p99,
sample size/network/browser envelope; 100ms feedback and 50ms frame→render are proposed budgets,
not observations. Entry gzip remains <150kB; heavy review/learning loads lazily.

Compatibility: missing envelope on legacy replay means snap to final/current, not simulate
an authoritative timeline. New live admission requires matching protocol; older completion
versions have a safe no-animation fallback. Public final snapshot has its own redaction allowlist.
Assertions: `F01_nominal_bb_1000_1000_15`, `F01_short_blind_conservation_matrix`,
`F02_allin_schedule_includes_result_hold`, `F02_live_turn_cancels_obsolete_runout`,
`F02_last_hand_survives_catchup_without_mixed_controls`, `F17_repeat_ime_typing_ignored`.

## 5. Hand verification, certificate, SQL gate, and metrics — rating

**Authority:** TableDO emits evidence, not verified status. Async verifier replays the
private archive and creates validated attestations; SQL gates the rating write atomically.
Existing `hands.verified` (old verifier skipped luck and returns early when true) is
insufficient for `hand.v2`. New matches must not queue ungated finalization as success.

```ts
type HandVerificationV2 = {
  v: 2; handId: string; recordDigest: Digest; archiveDigest: Digest
  verifierVersion: 'hand.v2'; verifiedAt: number
  allInAt: 0 | 3 | 4 | null; equity: Record<0 | 1, number> | null
  adjustedBySeat: Record<0 | 1, number>
}
type SettlementCertificateV1 = {
  v: 1; id: string; matchId: string; evidenceRevision: number
  rulesVersion: 'hu-rated.v1'; configDigest: Digest
  participants: { userId: string; seat: 0 | 1 }[]
  manifest: HandManifestEntryV1[]; terminalProofId: string; terminalDigest: Digest
  adjustedBySeat: Record<0 | 1, number>
  outcomeBySeat: Record<0 | 1, 'win' | 'draw' | 'loss'> | null
  disposition: 'eligible' | 'void'; drawBandVersion: 'draw-band.v1'
  verifierVersion: 'settlement.v1'; evidenceDigest: Digest; completedAt: number
}
type SettlementState = 'ended' | 'archive_pending' | 'waiting_for_evidence' |
  'evidence_complete' | 'verified' | 'quarantined' | 'investigated' |
  'repaired_reverified' | 'rating_applied' | 'void' | 'legacy_insufficient'
```

`ended → archive_pending → evidence_complete → verified → rating_applied`; incomplete
evidence goes to `waiting_for_evidence` and returns when complete. Contradiction goes to
`quarantined → investigated → repaired_reverified → verified` or `void`. Every repair
appends operator identity/reason/source revision and reruns verifier; investigation alone
cannot promote status. Valid no-show/mutual-absence/fault routes to `void` after provenance
validation. `rating_applied` cannot transition back to another application. Record separate
immutable incidents for subsequently discovered defects; correction needs a new approved plan.
`evidenceDigest` hashes canonical `{rulesVersion,configDigest,participants,manifest,
terminalDigest,adjustedBySeat,outcomeBySeat,drawBandVersion,verifierVersion}`; certificate id
is SHA-256 of canonical `{matchId,evidenceRevision,evidenceDigest}`. Store it as text digest,
not a random UUID. Sorting participants by seat and manifest by handNo is mandatory.

Validate exact seat set, required fields, finite numbers, config, participant identities,
all-in point, equity and adjusted result from replayed terminal hand using `luckAdjusted`.
Folds/river require `equity:null`, `allInAt:null`, adjusted==realized; HU all-in includes
all required fields. No `null`/NaN/extra seat silently coerced to zero. Tolerance v1:
equity absolute error ≤1e-12, adjusted chips ≤1e-7 per seat/hand, net conservation ≤1e-7.
**Always aggregate recomputed values**, never archived values within tolerance. Use the
existing 2bb +1e-9 draw test on deterministic handNo-ordered recomputed sums. Thus tolerated
storage noise cannot move settlement across the draw band. Canonical digests bind exact
stored finite values; tolerances apply only to numeric verification. Golden fold/river/tie/
refund fixtures, independent board-count oracle cases, seat-swap symmetry and conservation
must accompany reuse of shared luck code. Benchmark preflop cost in Worker/workerd and
record actual execution budget; Node alone is not Worker capacity evidence.

Required manifest: contiguous unique handNo=1..N, exact match/seat/config, matching record
and private archive digests, current `hand.v2` for every completed hand. Complete→N=40;
forfeit→valid verified prefix (possibly zero) **and** terminal proof (deadline/command
history, interrupted-hand disposition); no-show→zero play + start/admission/presence proof,
**void**; mutual absence/engine fault→valid provenance, **void**. Contradictions quarantine;
missing expected evidence waits. Do not require 40 hands for a real forfeit or accept an
empty manifest for a normal completion. Archived claimed outcomes alone are not proof.

### Proposed RPC boundary (PostgREST `{p: ...}`)

All service RPCs below are `SECURITY DEFINER SET search_path=''`, fully qualified tables,
EXECUTE only service_role (no PUBLIC/anon/authenticated). Private evidence/certificates
are not client-writable/readable; expose only safe settlement state to participants.

| Function | Exact JSON payload | Return / invariant |
| --- | --- | --- |
| `record_match(p jsonb)` (replacement) | existing payload + `evidenceVersion:1`, `terminalProof:TerminalProofV1` on end | Idempotent same content; divergent same terminal identity quarantines, not overwrite. |
| `record_hand(p jsonb)` (replacement) | existing payload + `completedAt:number`, `terminalStateVersion:number`, `recordDigest:Digest`, `archiveDigest:Digest` | Verify canonical digest against stored payload; exact retry no-op; mutation increments evidence revision/invalidate certificate. |
| `record_hand_verification_v2(p jsonb)` | `{handId, archiveDigest, verification:HandVerificationV2}` | Reject changed source digest; store versioned attestation, not boolean promotion. |
| `certify_match_v1(p jsonb)` | `{matchId, expectedEvidenceRevision, terminalDigest, verifierVersion:'settlement.v1'}` | Read/lock validated source rows; construct certificate in transaction, not accept client totals/manifest; return `{state, certificateId?, reasonCodes:string[]}`. |
| `apply_rating(p jsonb)` (replacement) | existing `{matchId,format,modelVersion,finishedAt,players:[{userId,outcome,version,rating,rd,sigma}]}` + `certificateId`, `evidenceRevision`, `settlementId` | Existing change-array return; duplicate returns identical stored change. `settlementId` is certificate id for first finalization; unique match application cannot be evaded with a new id. |
| `settlement_candidates_v1(p jsonb)` | `{afterMatchId:string|null, limit:number}` (1..100) | Service-only bounded pending list; fair continuation/wrap includes aged retries. |

Migration adds `private.hand_verifications`, `private.match_terminal_evidence`,
`private.settlement_certificates`, `private.settlement_jobs`; match evidence revision/current
certificate link, rating-history certificate/settlement identity. Unique `(match_id,user_id)`
match-history effect remains; unique current certificate per match/evidence revision. Durable
job carries state, attempts, nextAttemptAt, reasonCodes. Certificate creation trusts authorized
verifier attestations for CPU-heavy replay but independently validates relational/manifest/
terminal consistency; SQL does not do exact poker enumeration. Document this trust boundary.

Gate ordering under match lock: validate current certificate identity/revision/digest/rules,
eligible nonvoid outcome and exact unique two participants; reject missing/invalid proof;
if same settlement already applied, return stored result even if rating versions are now
stale; otherwise lock rating rows in sorted userId order, check versions, write
both changes atomically. `40001` retains five bounded Worker recomputations; missing
evidence is retryable `P0002`; invalid proof/shape `23514`; missing certificate payload
fails closed for old Workers. Existing RPC `finishedAt` remains an ISO timestamp string;
its parsed instant must equal proof time, not caller's clock. Glicko calculation remains
in `rating.ts`; SQL validates authorized payload, versions and certificate relationship.
Invalidate unfinalized certificates on source changes; an already applied history is
immutable, flagged for separately approved dependency-aware correction, never applied twice.
Do not expose a retained legacy SQL overload or writable base-table route around this gate.

Verifier writes durable settlement-ready job in same transaction as attestation/certificate
state. Queue message is only a wakeup. Consumer + scheduled bounded catch-up scan converge
after dropped/duplicate/reordered wakes. Live outbox continues archiving proof and hands;
rating lane handles legacy `apply_rating` outbox calls as reconciliation requests requiring
certificate, not alternate finalizers. Pending UI is normal; quarantined UI uses safe reason
codes. Operator redrive never writes `verified=true`. DO deletion must await durable archive,
not Postgres grading or rating completion.

F12: trend = `sum(after_rating - before_rating)` over kind='match' and authoritative
played-time window; do not difference application-order endpoints sorted by play time.
Resets/decay/corrections are separately typed. Application-order Glicko stays unchanged.
F13: add authoritative hand completed-at/order; latest 500 decisions ordered
`completed_at DESC, match_id DESC, hand_no DESC, idx DESC` (stable ties), not `hands.created_at`.
Backdated ingestion/late grade triggers recompute affected player window; unknown legacy
play time is labeled/excluded from an “authoritative latest” claim, not invented as arrival.
Expose model version, format, graded/eligible/excluded counts and freshness; six accuracy
remains unsupported. `rated_luck` charts must also not confuse archive order with play order.

Compatibility: shadow classifications before approved cutover, **no historic rating changes**.
Cutover is explicit durable version/capability marker on new matches; inspect all current
writers before enablement. Legacy insufficient matches remain labeled and cannot use an
unguarded fallback. Read-only classification tooling defaults to synthetic/local input;
production read is separately authorized. Rollback pauses finalization, not the certificate gate.
Assertions: `F07_altered_luck_rejected`, `F07_zero_hand_complete_rejected`,
`F07_foreign_duplicate_gapped_manifest_rejected`, `F07_valid_terminal_classes`,
`F07_sql_gate_old_worker_cannot_bypass`, `F07_concurrent_finalization_one_effect`,
`F07_lost_wakeup_catchup`, `F12_out_of_order_play_trend_sums_deltas`,
`F13_delayed_old_grade_preserves_latest500`.

## 6. Revision ACKs, conflicts, sign-out, deletion, and outbox — sync → learning

**Authority:** server-issued revisions and deletion generations, not client timestamps.
`saved_to_account` requires established account, successful reconciliation, no blocked/
conflicted work and ACK of the exact current barrier revisions. Local-only is not cloud saved.

```ts
type SyncScope = { accountId: string; epoch: number }
type SyncTarget = { kind: 'practice_hand' | 'trainer' | 'curriculum' | 'evidence';
  id: string; localRevision: number; digest: Digest }
type SyncStatus = 'checking_account' | 'saved_on_device' | 'saving' |
  'saved_to_account' | 'offline_local_changes' | 'conflict' | 'blocked' |
  'unable_to_verify'
type SaveBarrier = { scope: SyncScope; watermark: number; targets: SyncTarget[] }
type RevisionCursor = { target: SyncTarget; serverRevision: number | null;
  acknowledgedLocalRevision: number | null; acknowledgedDigest: Digest | null;
  deletionGeneration: number; dirtySinceWatermark: number | null }
type FlushResult = { barrier: SaveBarrier; status: 'saved' | 'timeout' |
  'unknown' | 'blocked' | 'conflict' | 'account_changed';
  pending: SyncTarget[]; reasons: string[] }
type RevisionWrite = {
  protocol: 1; mutationId: string; accountId: string
  kind: 'practice_hand' | 'trainer' | 'curriculum'; id: string
  baseRevision: number; deletionGeneration: number; digest: Digest
  lifecycle: 'provisional' | 'final' | 'corrected'; supersedesRevision: number | null
  payload: unknown // HandRecord / TrainerDoc / exact curriculum JSON text, by kind
}
type RevisionResult =
  | { status: 'accepted'; mutationId: string; revision: number;
      digest: Digest; deletionGeneration: number; receivedAt: string }
  | { status: 'conflict'; revision: number; digest: Digest;
      deletionGeneration: number; current: unknown }
  | { status: 'deleted' | 'blocked' | 'upgrade_required'; reason: string;
      deletionGeneration: number }
```

`epoch` is a per-running-account cancellation fence, **not server ordering authority**.
Every promise callback/reducer mutation checks exact account + epoch. Stop/abort old worker
on sign-out/switch; a late old-account response cannot apply a merge or clear new-account work.

### Proposed owner RPCs and durable storage

| RPC | Input / output |
| --- | --- |
| `read_learning_sync_v1(p jsonb)` | `{protocol:1, cursor:string|null}` → `{protocol:1, accountId:string, deletionGenerations:{practice:number,learning:number}, trainer:{revision:number,digest:Digest,payload:unknown}|null, curriculum:{revision:number,digest:Digest,payload:unknown}|null, hands:{id:string,revision:number,digest:Digest,payload:unknown}[], serverNow:string, cursor:string|null}`; bounded hand pagination by stable id/order. `auth.uid()` is identity. |
| `write_learning_revision_v1(p jsonb)` | `RevisionWrite` → `RevisionResult`; lock target/account generation, validate auth, size/schema/hash, CAS and lifecycle, idempotent mutation receipt atomically. Same mutation id/different content conflicts. Revision 0 means create-if-absent only. |
| `clear_learning_scope_v1(p jsonb)` | `{protocol:1, mutationId, accountId, scope:'practice'|'learning'|'all', expectedGeneration:number}` → `{status:'accepted'|'conflict', deletionGeneration:number}`; atomic generation bump + deletion + durable tombstone, never two separate browser writes. For `all`, validate/update both generations via an explicit pair rather than a single ambiguous expected value. |

Use explicit pair for all-scope request: `{expectedGenerations:{practice:number,learning:number}}`
and return `{deletionGenerations:{practice:number,learning:number}}`; single-scope shapes above
are unchanged. RPC signatures are all `(p jsonb) returns jsonb`. Derive owner from auth and
reject mismatched `accountId`. `SECURITY DEFINER` with empty search_path and explicit owner
checks is permitted for controlled writes; retain owner SELECT RLS. Revoke direct browser
INSERT/UPDATE/DELETE on revision-controlled base tables at protected cutover, and revoke
unsafe old writer functions. Do not use a client-settable “bypass trigger” flag. Cached old
clients see explicit write rejection/upgrade path, not silent server no-op as saved.

Server revision columns on practice rows and per-document trainer/curriculum; separate
server account-scope deletion counters, immutable mutation receipts (owner/mutation unique),
and lifecycle/evaluation revision metadata. Replace timestamp winner and silent “preserve
old graded row” trigger behavior with explicit CAS result. Provisional→final requires current
base; final→provisional forbidden; corrected final is a new explicit revision referencing
prior final. Same-base independent device writes conflict in either arrival order. Keep both
local/base/remote payloads in recoverable storage; no silent overwrite. A stale deletion
generation rejects even if payload time is future or id is new. Require reconciliation
before creating fresh work in new generation; never simply re-stamp a rejected stale payload.

Meaningful merge: immutable attempts/receipts union by stable id only when content matches;
divergent same id conflicts. Exposure is monotonic family union. Drafts retain device branch.
Notes use base/local/remote three-way merge, conflicts retain both. Preferences use per-field
base comparison or explicit conflict. Review/skill projections recompute from merged evidence,
not greatest/streak/max. Initial implementation may expose recoverable whole-doc conflicts
rather than invent semantic merge. Guest work is **unclaimed**, never assigned to next login;
offer explicit import/claim with identity confirmation, otherwise leave out of account writes.

F08: snapshot exact serialized bytes/digest/local revision when sending. ACK updates only
that revision; remove pending only if latest still matches. If final grade changed during
provisional upload, immediately continue drain, **no unrelated edit required**. `flush(ms)`
captures barrier and returns `FlushResult`; it cannot succeed before readiness, while a
drain/grade is in flight, or while size/cap/quota errors block work. Detect unsent modifications
before initial pull readiness; failed local persistence means blocked, not successful queueing.

### Generic account outbox seam (sync owns; learning consumes)

```ts
type OutboxEventV1 = { id: string; accountId: string; schemaVersion: 1;
  stream: 'learning-evidence'; revision: number; digest: Digest;
  deletionGeneration: number; payload: unknown }
type OutboxAckV1 = { id: string; revision: number; digest: Digest;
  serverRevision: number; deletionGeneration: number }
type OutboxJobV1 = { accountId: string; eventId: string; revision: number;
  schemaVersion: 1; attempts: number; nextAttemptAt: number;
  lease: { epoch: number; tabId: string; until: number } | null }
interface AccountOutbox {
  append(scope: SyncScope, event: OutboxEventV1): Promise<void>
  drain(scope: SyncScope, send: (events: OutboxEventV1[]) =>
    Promise<OutboxAckV1[]>): Promise<void>
  barrier(scope: SyncScope): Promise<SaveBarrier>
  flush(barrier: SaveBarrier, timeoutMs: number): Promise<FlushResult>
  exportAccount(scope: SyncScope): Promise<Blob>
  clearAccount(scope: SyncScope): Promise<void>
  stop(scope: SyncScope): void
}
```

Local account epoch belongs to the current job lease, not immutable evidence provenance;
resuming the same authenticated owner after reload safely obtains a new fenced lease.

IndexedDB schema v1: `events` + `jobs` + `meta` + `conflicts`, account-scoped compound keys.
One readwrite transaction persists event and upload job with stable id; identical duplicate
no-op, divergent duplicate conflict. A job stores nextAttemptAt, attempts and exact revision;
ACK never consumes a later revision. Persist exponential backoff (reuse 5s–300s sync bounds),
schema upgrade failure and quota state. Multiple tabs safely compete through transactional
job claims with expiring local leases; remote idempotency is final duplicate defense. Outbox
survives reload and drains under account sync lifecycle without curriculum mounting. Event
jobs from old deletion generation are blocked/purged only after explicit reconciliation;
never resurrect deletes. Server ownership/generation beats stale local job lease/epoch.
Export includes unsent/conflicting work and manifest, not credentials. Legacy localStorage
import is account-confirmed, idempotent, and removes source only after transactional success.

Sign-out: freeze edits/producers or recheck latest watermark after barrier (including outbox).
Only `status:'saved'` for the still-current account/watermark permits automatic clear. Otherwise
show Wait/retry, Export and sign out, Discard unsaved work and sign out with loss warning.
Export must produce usable download before clearing. On completed sign-out clear memory,
localStorage, IndexedDB events/jobs/conflicts and all account backups; invalidate epoch and
sign out this browser. A storage-removal error is a visible privacy failure, not “all cleared”.
Auth expiry/account switch must stop display/write of old work without silently pretending it
was uploaded; no old account data merges into new account. Shared-device privacy takes priority
over silently retaining readable notes after completed sign-out.

**Forbidden:** first failed pull + empty queue → saved; HTTP 200 → latest ACK without digest;
too-large row → removed from pending; timestamp skew → winning curriculum; delete then stale
upload → resurrection. Assertions: `F08_provisional_final_overlap_drains_without_edit`,
`F08_size_cap_quota_block_flush`, `F09_both_device_arrival_orders_preserve_or_conflict`,
`F09_stale_upload_cannot_undo_delete`, `F10_failed_initial_pull_blocks_saved_signout`,
`F10_old_epoch_response_cannot_touch_new_account`, `F10_guest_requires_explicit_claim`.

## 7. Evidence eligibility, skill taxonomy, and separate domains — learning

**Authority:** raw attempts are immutable submissions; evaluation and projection are separate
versioned products. Durable client evidence remains self-study, not server-certified learning.
Allowlist structured inputs; free-text rationale is data, never evaluator instructions.

```ts
type SkillId = 'incremental-outcomes' | 'conditioning-events' | 'ev-thresholds'
type TrustTier = 'client_self_study' | 'server_regraded' | 'server_live_archive'
type EvidenceEnvelopeV1 = {
  v: 1; eventId: string; accountId: string; sourceId: string; sourceRevision: string
  sessionId: string; mode: 'curriculum' | 'practice' | 'completed_live_review' | 'experiment'
  sourceTrust: TrustTier; observedAt: string; receivedAt: string | null
  trustedCompletedAt: string | null; timeTrust: 'server' | 'device' | 'unknown'
  skills: SkillId[]; mappingVersion: 'skills.v1'; familyId: string; caseId: string
  contentVersion: string; rubricVersion: string; modelVersion: string | null
  context: 'poker' | 'business-payoff' | 'finance-experiment'; difficulty: string
  informationSetRef: string; responseRef: string; confidencePercent: number | null
  durationMs: number | null; assistance: 'unaided' | 'assisted' | 'unknown'
  exposedFamilyIds: string[]; exposureKnown: boolean
  lifecycle: 'provisional' | 'final' | 'superseded' | 'invalidated' | 'deleted'
  supersedesEventId: string | null; digest: Digest; deletionGeneration: number
}
type EvaluationV1 = {
  id: string; eventId: string; sourceDigest: Digest; evaluatorVersion: string
  rubricVersion: string; coverage: 'supported' | 'partial' | 'unsupported'
  passed: boolean | null; criticalErrorCodes: string[]; eligible: boolean
  reasonCodes: string[]; supersedesEvaluationId: string | null
}
type SkillProjectionV1 = {
  skill: SkillId; projectorVersion: 'learner.v1'; mappingVersion: 'skills.v1'
  evidenceSetDigest: Digest; watermark: string; evidenceIds: string[]
  stage: 'unknown' | 'observed' | 'practiced' | 'independent' | 'transferred' | 'retained'
  eligibleAttempts: number; families: string[]; contexts: string[]
  performance: { component: string; passes: number; checks: number }[]
  hypotheses: { code: string; state: 'tentative' | 'supported' | 'contradicted';
    supports: string[]; counters: string[] }[]
  retention: { status: 'unknown' | 'due' | 'checked'; dueAt: string | null;
    timeTrust: 'server' | 'device' | 'unknown' }
}
```

Server fills receipt/trusted times/trust tier only after source validation; client cannot
promote these fields. An online server receipt proves receipt time, not offline completion
time. Server regrading can strengthen answer validity but not certify missing assistance or
freshness provenance. Legacy missing assistance/exposure stays unknown. Completed live
review adapters reference only decision-time own/public information: shown-at-end opponent
cards, wins and rating changes cannot justify what the player should have known earlier.

Migration creates conventional owner-scoped evidence, evaluation, projection, recommendation,
intervention and pilot-assignment/exposure/outcome tables. Unique `(account_id,event_id)`
and immutable source/content checks; RLS owner SELECT, validated RPC writes only. Proposed
`append_learning_evidence_v1(p jsonb)` accepts `{protocol:1, accountId, deletionGeneration,
events:EvidenceEnvelopeV1[]}` (bounded batch 100) and returns `{accepted:OutboxAckV1[],
conflicts:{id,reason}[], rejected:{id,reason}[]}`. Treat posted provenance as a request;
validate/recompute protected fields. Outbox id = eventId, revision = 1 for each immutable
event; correction uses a new eventId and supersedesEventId, not a revision overwrite.
ACK digest binds exactly the submitted allowed source payload (excluding digest itself);
server-stamped receipt/provenance is separate metadata, never mutates that ACK identity.
`read_learning_projection_v1(p jsonb)` accepts
`{skillIds:SkillId[]}` and returns current owner projections plus source eligibility reasons.
Submitted event corrections append linked events/evaluations; lifecycle transitions are
append-only invalidation/supersession records, not destructive edits of source attempts.
Physical deletion/redaction of personal source and derived rows is supported by account
deletion and scope tombstones; append-only is not a retention exemption. Sync generation
must participate in ingest transaction so stale jobs cannot re-create removed evidence.

### Deterministic pilot policy v1 (product rules to validate, not science)

| Skill | Prerequisite / observable behavior | Candidate misconceptions |
| --- | --- | --- |
| incremental-outcomes | none; separate payments, returned stake and incremental gain at decision point | `gross_as_net`, `sunk_cost_in_threshold` |
| conditioning-events | explicit event definitions; distinguish improve/win/share/profit, condition only on observed info | `improve_equals_win`, `condition_ignored` |
| ev-thresholds | incremental-outcomes + conditioning-events; weighted outcomes, break-even and reversal assumption | `wrong_denominator`, `probability_payoff_mismatch` |

Map existing unit f01 primarily to incremental outcomes, f02 to conditioning/events,
f03 to EV; mapping is per rubric component/case, not blanket unit completion. Unit ids
are lowercase content identifiers, unrelated to uppercase audit F01–F17.

Same valid evidence set yields same projection irrespective of duplicates/order. Normalize
by event identity/content, resolve explicit supersession chain, reject forks as conflict,
exclude deleted/invalidated/unsupported data, sort stable identities before calculation.
Store evidence ids/cutoff/version for every claim. Independent stage: ≥2 eligible unaided
passes across ≥2 distinct authored families; transfer: a fresh changed-domain family pass;
retention: a materially fresh reserved review family passed unaided after actual policy
delay with trustworthy timing. Client/device-only evidence may show qualified self-study
stages but not stronger verified retention. Aging means unknown current retention, not
failure. Count correlated family/session observations once per independence support unit.
Supported misconception requires ≥2 distinct eligible families exhibiting the same specific
critical error; single/ambiguous error is tentative and triggers discriminating diagnostic.
Store counterevidence; fresh correct diagnostics can demote/contradict the hypothesis.
Confidence calibration is separate from skill stage. Hints/solutions never create unaided
receipts. Use existing delay schedule for now with explicit trust labels, not accelerated
tests as retention proof.

### Connected loop and recommendation record

Emit evidence through AccountOutbox from existing submit/finalize paths, not an unused
parallel store. Grade structured answers with versioned trusted rubric; link raw attempt,
evaluation and receipt. Rebuild projections and route existing curriculum entrypoints to
lazy why-this-practice surface. For practice events needing `App.tsx` wiring, send the
parent a named adapter signature (no competing App edits by learning and rules).

```ts
type RecommendationV1 = {
  id: string; policyVersion: 'practice.v1'; evidenceSetDigest: Digest
  status: 'shadow' | 'offered' | 'content_limited' | 'baseline'
  skill: SkillId; candidates: string[]; chosen: string | null
  exclusions: { candidateId: string; reason: string }[]; evidenceIds: string[]
  hypothesis: string; mechanism: string; effortMinutes: number
  assistance: 'worked' | 'fading' | 'unaided'; immediateCheckFamily: string | null
  transferFamily: string | null; delayedFamily: string | null
  followupDelayDays: number; feedback: 'none' | 'does_not_fit' | 'other_focus'
}
```

Priority: explicit safe goal → due **fresh** review → uncertain prerequisite diagnostic →
recurring high-impact misconception remediation → transfer → curriculum baseline. Stable
tie-break by candidate id; save candidates/exclusions/reasons so decisions replay. Reserve
family ids for transfer/delayed holdouts; recommender cannot consume them as training.
New numeric seeds or previews do not reset exposure. F15: due + exhausted fresh families
returns `content_limited`, related eligible focus/repeated practice labeled non-assessment,
or wait for content; never a learner failure or dead route. Cold-start gets optional short
diagnostic or ordinary curriculum. Include cooldown/skip/other focus and “does not fit”.

Minimum authored chain per pilot skill: discriminating diagnostic → worked example →
fading-support practice → unaided poker check → unseen business transfer → separately
reserved delayed family. Gross/net journey specifically uses cash-flow ledger before any
probability question; correct ledger + bad threshold must move hypothesis toward EV, not
insist on gross/net. Each recommendation explains observed examples/limits, falsifiable
hypothesis, mechanism/effort/assistance, and fresh follow-up. Expand the three families only
after adequate independent content exists. Shadow by default; explicit pilot exposure flag.

Three domains must remain separate: competitive rating from certified match results;
modeled decision quality from information-set-valid supported evaluator; demonstrated
learning from eligible attempts. No composite ability score. F16 practice stats return
`actualAll`, `modeledCovered:number|null`, `actualCovered:number|null`, `coveredCount`,
`totalCount` plus eligible/evaluated/excluded denominators; charts compare same ordered
covered subset. Missing expected EV never falls back to realized net. Assisted/provisional/
ungraded/unsupported evidence excluded from independently-modeled claims with reason counts.
Rules owns stats; parent/rating owns net-profile display, learning owns curriculum labels.

Pilot data records stable learner assignment unit, baseline vs targeted arm, policy/content
versions, assignedAt, exposure/adherence/assistance, heldout family, endpoint due/completed
times, missing-followup/dropout and effort. Owner-safe export separates ITT assignment from
completers. No fabricated sample size, causal benefit or delayed outcomes; no raw notes in
aggregate exports. Broad claims require actual held-out delayed transfer evaluation.

**Forbidden:** upload → certified; device clock → proven delay; new seed → fresh family;
assisted pass → mastery; win/rating delta → skill evidence. Assertions:
`F15_exhausted_due_review_is_content_limited`, `F15_family_preview_blocks_freshness`,
`F15_projection_duplicate_order_invalidation_invariant`,
`F15_clock_unknown_cannot_certify_retention`, `F16_unknown_ev_same_covered_subset`.

## 8. Repository writer and migration inventory

This is a **repository-only inventory**, not a claim about applied production migrations.
Every implementation lane must retain a writer-cutover checklist, including cached clients
and durable jobs from older binaries. New schema must be replayed locally from all migrations.

| Writer / reader boundary at baseline | Current mechanism | Required change |
| --- | --- | --- |
| `table.ts`, `lobby.ts` | DO `match`, deadlines, `active:<userId>`, `current`, outbox; in-memory per-user locks | Durable claims/tickets/commands; protocol v2; never infer fencing from listing. |
| `table.ts` → `supabase.ts` archive | `record_match`, `record_hand`, `record_incident`; queue after archive success | Persist manifest/terminal evidence; match end cannot certify rating. |
| `table.ts` outbox → `rating.ts` | `apply_rating` read/compute/write, five stale retries | Certificate-only finalization; legacy work requests reconciliation. |
| `verify.ts`, `grade.ts` | `audit_hand`, `verify_hand`, `record_grades`, incidents/DLQ | Version/digest attestation, luck verification, certificate jobs/catch-up. |
| `src/net/sync.ts` | direct `practice_hands` upsert/delete and `learning_state` upsert | Authenticated CAS + deletion RPCs; exact ACK, conflict and blocked status. |
| `Session.tsx`, `AccountPage.tsx` | start/stop sync, boolean flush, local clear | Epoch/barrier/status and explicit unsaved sign-out choices. |
| `src/lib/storage.ts`, curriculum persistence/session | localStorage documents/events; client attempts/receipts | Dirty registration before readiness; outbox adapter; no inferred guest ownership. |
| `src/net/ladder.ts`, `profile/`, `accuracy.ts`, `publicMatch.ts` | ladder RPC/direct public rating/history/accuracy/result reads | Truthful trend/window, pending status and assurance labels; keep privacy gates. |
| `worker/src/{challenge,school}.ts` via outbox | `record_challenge_claim`, `set_player_school` | Unchanged non-learning/rating writers; do not falsely promote challenge scores. |
| players/onboarding/profile + avatar Worker/SQL | owner profile/player/avatar mutations | Unchanged; not a path around learning or certificate gates. |
| old learning-cloud API / cached clients | owner DML on profiles/hand_results/lesson_progress/practice_attempts/coach_messages; `clear_learning_progress()` | Inventory actual retirement at cutover; old tables cannot repopulate new revision/evidence data. |
| scripts / operator / service credentials | repository SQL tests and manual RPC possibilities | Local synthetic classification/redrive only now; no manual certificate boolean shortcut. |

All 22 baseline migration filenames (in execution order), with the defining/replacing seams:

| Migration | Relevant boundary |
| --- | --- |
| `20261007192620_learning_cloud.sql` | Legacy learning owner tables, `clear_learning_progress`, coach quota. |
| `20261008133809_players.sql` | Players identity/public profile boundary. |
| `20261008134201_matches_hands.sql` | Match/player/public/private hand archive tables. |
| `20261008134322_record_hand.sql` | Initial service `record_hand`. |
| `20261008134345_abandonments_match_index.sql` | Abandonment indexing. |
| `20261008173914_record_match.sql` | Match archival service function. |
| `20261008181317_record_match_no_show.sql` | Replacement with no-show treatment. |
| `20261009213919_verify_hand.sql` | `audit_hand`/`verify_hand` service boundary. |
| `20261009213923_hands_created_index.sql` | Archive arrival-time index (not play order). |
| `20261010010000_rated_matches.sql` | Rated columns/record_match replacement. |
| `20261010043000_rematch.sql` | Rematch link + record_match replacement. |
| `20261010053000_hand_grades.sql` | Grading table / `record_grades`. |
| `20261010060000_hand_grades_pot.sql` | Pot-aware grades / replacement. |
| `20261010070000_accuracy.sql` | `player_accuracy`, `refresh_accuracy`, `record_grades` replacement, `rated_luck`. |
| `20261010080000_ratings.sql` | Ratings/history, original `apply_rating`, stable locks/idempotency. |
| `20261010090000_ladder.sql` | **Last baseline `apply_rating` replacement**, played_at, ladder/ladder_month trend. |
| `20261010100000_hands_after_match.sql` | Hand privacy after match. |
| `20261010110000_landing.sql` | Challenge claims / schools. |
| `20261010120000_school_email.sql` | Service school-email verification. |
| `20261010130000_six_casual.sql` | **Last baseline record_match/record_hand replacements** and six sessions. |
| `20261011100000_practice_history.sql` | Direct owner DML; practice guard silently refuses downgrade, curriculum timestamp winner. |
| `20261012000000_avatars.sql` | Avatar/report functions; unrelated, preserve. |

Integration status and actual tests are indexed in [trust-release-evidence.md](trust-release-evidence.md).
The integration also adds `20261012040000_learning_measurement.sql` for qualified
effort and server-issued delayed-check timing; this does not award retained status.

New migrations in reserved order: `20261012010000_learning_revisions.sql` (sync),
`20261012020000_verified_settlement.sql` (rating), `20261012030000_learning_evidence.sql`
(learning). No production application is authorized. Reader expansion → local migration/
old-client tests → shadow classification → approved protected-writer cutover. Old writers
must fail closed, export/reconcile before upgrade, and cannot continue silently unsafe.
Rollback pauses admission/finalization/sync or recommendations; never restores known-unsafe
betting, unverified ratings, timestamp overwrite, or misleading saved state.

## 9. Executable acceptance lock and remaining release decisions

These are **required future `it()` names/oracles**, not tests added or passing on this
documentation branch. Convert each desired assertion to a failing-before/passing-after
regression on the pinned baseline. Use controlled clocks/deferred promises and restart/fault
injection, no healing unrelated edits. Independent acceptance must challenge actual behavior.

| ID | Primary assertion name | Owner / harness and oracle |
| --- | --- | --- |
| F01 | `F01_nominal_bb_1000_1000_15` | rules, engine Vitest; call20/raiseTo40, paid15, 45+10 pots; 2–6 players, short blinds, refunds, reopening, odd chips/conservation after every action. |
| F02 | `F02_live_turn_cancels_obsolete_runout` | live Worker + presentation fake-timer/component/e2e; every all-in street, last hand, late frame/reduced motion; no mixed hand and no hidden live turn. |
| F03 | `F03_lost_ack_resyncs_accepted_stand` | live/presentation drop request/ACK; legal action retained until acceptance, duplicate rebuy one effect, stale generation refused. |
| F04 | `F04_restore_zero_one_two_sockets` | live Worker restart at each grace stage; stable deadlines, both-expired void, no accidental winner. |
| F05 | `F05_host_absent_cancel_reclaims_membership` | live/presentation, 30s and cancel/deal race; authoritative release independent of 24h link. |
| F06 | `F06_competing_invites_one_playable_table` | live, two guests/tabs/invites/queue/rematch/six, crash each activation step, stale callbacks; assert accepted play not just rows. |
| F07 | `F07_sql_gate_old_worker_cannot_bypass` | rating Worker + full SQL replay, alter luck/missing/wrong/gapped/duplicate hands, all terminal classes, concurrent settlement, DLQ/redrive and lost wakeup; no invalid history writes. |
| F08 | `F08_provisional_final_overlap_drains_without_edit` | sync deferred upload ACK, grade final during request, no further edit; final ACK before flush saved; size/cap/quota blocked. |
| F09 | `F09_both_device_arrival_orders_preserve_or_conflict` | sync SQL/CAS + two stores; disjoint work preserved or both versions recoverable; skew irrelevant; stale deletion cannot resurrect. |
| F10 | `F10_failed_initial_pull_blocks_saved_signout` | sync AccountPage + storage exceptions; local dirty before ready, wait/export/discard, epoch/account isolation, private clear. |
| F11 | `F11_receipt_equal_deadline_is_late` | live controlled ingress/alarm order; equality rejected after timeout, queued timely receipt respected; repeats idempotent. |
| F12 | `F12_out_of_order_play_trend_sums_deltas` | rating SQL/history; played-window deltas correct in both application orders and reset boundaries. |
| F13 | `F13_delayed_old_grade_preserves_latest500` | rating SQL, >500 decisions and late ingestion/grade; authoritative order stable and window recomputed. |
| F14 | `F14_unavailable_is_not_unrated` | live lobby fetch fault/empty/malformed rows; only real empty gets default rating, unavailable cannot pair rated. |
| F15 | `F15_exhausted_due_review_is_content_limited` | learning unit/integration; family exposure, invalidation, duplication/reordering, unknown time, connected diagnostic→intervention→fresh checks, no fake retention. |
| F16 | `F16_unknown_ev_same_covered_subset` | rules stats/display; 12/20 covered compares same12, separate actual20, all-missing unknown, assisted/pending excluded. |
| F17 | `F17_repeat_ime_typing_ignored` | rules practice keyboard DOM events, held key/IME/inputs/modifiers normal typing and single intentional action. |

Additional cross-cutting obligations: frame redaction allowlists; account/RLS isolation; live
import fence; entry bundle <150kB; two-device/browser recovery and keyboard/focus at 1366×768;
monotonic intent→render spans, environment/sample-size distributions, interrupted migrations,
backlog/sync/export/deletion runbook drills. Parent owns UI-driven acceptance; none is run here.

### Decisions to ratify before exposure (not reasons to skip implementation)

1. Approve proposed completion.v1 schedule/900ms result hold through browser measurement;
   server bounded catch-up and immediate live decision visibility are non-negotiable.
2. Confirm command retention floor at least 10 minutes and capacity/compact retirement
   strategy for long six sessions; never evict-and-reexecute. The 5s client watchdog is UX only.
3. Approve protocol/client compatibility window and safe read-only upgrade UX; deployment
   inventory and production schema parity remain unknown until separately authorized.
4. Approve new-match certificate cutover version and legacy-insufficient handling. No history
   recalculation/reset is authorized; no void no-show winner policy is being introduced.
5. Domain-review authored family independence and cautious diagnosis thresholds; validate
   self-study vs stronger evidence wording. Choose pilot exposure/endpoint/effort/stopping
   rules only from real baseline variance; actual elapsed follow-up is still required.

Gate A still requires implementation + independent Worker/SQL/browser fault evidence, schema/
protocol compatibility, operational runbooks and release approval. Gate B additionally needs
adequate validated content, source-valid replayable evidence, shadow review, an approved pilot
and real delayed fresh unaided transfer outcomes. Passing baseline checks or this contract
review proves neither gate and says nothing about production damage or learning effectiveness.
