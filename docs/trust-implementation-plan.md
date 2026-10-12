# DeltaDeck: earn trust first, then earn the right to personalize

## 1. The strategic decision

**Keep the architecture. Repair the boundaries where truth is lost. Build the redesigned experience on explicit contracts. Then turn trustworthy evidence into a useful, testable model of the learner.**

The ten high-priority findings are not ten unrelated bugs. They expose four missing guarantees:

1. **Ownership:** who owns the seat, table reservation, command and current decision after interruption?
2. **Completion:** when is a hand, upload, match or review actually finished—not merely started or apparently successful?
3. **Provenance:** which evidence justifies a result, rating, grade or learning claim?
4. **Reconciliation:** how does the system recover when different components have different partial histories?

Fixing those guarantees is more valuable than adding retries, longer animations or another dashboard. It prevents the same defect from resurfacing as a rebuy bug, a rating delay, an account-switch loss or a misleading “mastery” card.

### The intended product

A player should be able to say:

> “The game always tells me what happened. My results are defensible. My work survives interruptions. DeltaDeck can explain a specific weakness, give me the right practice, and show whether I can still do it later in a new situation.”

That preserves the whole vision: excellent poker, competition and community, and a serious path into quantitative reasoning and options/finance. Poker is the teaching environment and social return loop—not an acquisition trick to discard once the curriculum begins.

### Two release gates, not one endless project

| Gate | What it permits | What it must prove |
|---|---|---|
| **A — Trustworthy redesigned game** | Ship the redesigned play/review/account experience with honest existing learning features | Correct rules; recoverable commands and membership; bounded pacing; verified rated settlement; no silent learning-data loss; truthful metrics; actual browser acceptance |
| **B — Adaptive learning pilot, then claim** | Introduce targeted learning for a narrow skill set; later market demonstrated personalization benefits | Replayable evidence; defensible diagnoses; actionable interventions; fresh delayed reassessment; evidence that recommendations help beyond the existing curriculum-order/review-date baseline |

**Gate A does not require a sophisticated adaptive model. Gate B does require Gate A’s evidence foundation.** Visual exploration and component work can start immediately against fixtures. Broad release cannot bypass the trust gates. Until B is proven, say “targeted practice based on your recent evidence,” not “we understand your ability” or “proven mastery.”

### Scope and evidence

This is an implementation plan, not an implementation or a new production audit. It is grounded in the five-specialist foundation audit dated 12 October 2026, its technical appendix and targeted reading of current source. The checked-out revision exactly matches the audited revision: [9de1fd8](https://github.com/Backpacked333/Deltadeck/commit/9de1fd868f55358bd8e0926487750673752a914a).

The original audit reproduced defects locally. It did **not** establish corrupted production ratings, a player exploit, production data loss, real-device smoothness or learning efficacy. Its passing baseline tests are not evidence that these failures are fixed. This session changed no application code, database, deployment or rating. All schemas, state names, thresholds and flags below are proposals unless explicitly described as existing.

## 2. Preserve the good foundation; do not buy a rewrite

### Keep

- The server-authoritative `TableDO` live game and `LobbyDO` coordination.
- The deterministic injected-deck engine, action identity/deduplication, durable state and redacted snapshots.
- Fresh-deck rated heads-up, the existing all-in equity-adjusted result policy, and Glicko-2 with uncertainty. Casual six-max stays unrated unless separately designed and validated.
- Cloudflare Worker/Queues and Supabase. Keep Postgres/archive/learning analysis **off the live betting path**.
- Trainer/live separation. Practice can teach during a hand; live competition must not receive covert coaching through the new panels.
- Existing curriculum attempts, versioned rubrics, assistance/exposure tracking, transfer cases and delayed-review concepts.
- Owner-only learning data, account boundaries, deletion protections and the entry-bundle budget under 150 kB gzip.

### Add only the missing pieces

1. A small, explicit membership/command/recovery contract.
2. A server-controlled hand-completion schedule with a client presentation adapter.
3. A verified settlement certificate and database finalization gate.
4. Revision-aware durable learning synchronization.
5. An append-only **learning evidence layer**, with rebuildable projections and a deliberately simple recommendation policy.

This is **not** a proposal to event-source every subsystem, move live play into Postgres, add Kafka, introduce a vector database, replace Glicko, or put an LLM in the control path. Keep existing state machines; add durable identities and evidence only where their absence causes real failure.

### One truth, several projections

```text
Live command → TableDO durable transition → redacted snapshot → rendered table
                         │
                         └→ durable outbox → archive → hand verification
                                                  └→ match verification
                                                       └→ rated settlement

Practice / completed live review / curriculum / finance experiment
             └→ account-scoped durable evidence
                    ├→ source validation and versioned grading
                    ├→ skill + misconception + retention projections
                    └→ recommendation → intervention → delayed fresh check
```

The rendered table is not the game authority. A client “sent” flag is not acceptance. A queue acknowledgement is not a verified result. A successful HTTP response is not proof that the latest learning revision survived. A grade is not mastery. Those distinctions must become data contracts and visible UX states.

## 3. The release contract: ten findings, ten explicit proofs

Use the original audit IDs throughout implementation, test names, release evidence and incident triage. The extra host-double-table defect must not disappear simply because the abbreviated brief omitted it.

| Audit ID | Failure | Owning workstream | Required proof before Gate A |
|---|---|---|---|
| F01 | Short BB reduces multiway bring-in | Engine | At 10/20 and stacks 1000/1000/15, call is 20, minimum raise-to 40, actual short contribution remains 15, pots and refunds remain correct |
| F02 | New hand replaces unfinished reveal | Presentation + server lifecycle | Final board/result is available before replacement; supported normal delivery does not hide the next turn behind old animation; late clients catch up rather than replay obsolete timing |
| F03 | Lost Stand up leaves false accepted state | Command protocol + UI | Lost request and lost acknowledgement converge to authoritative seat/standing state; no legal action is hidden merely because a request was sent |
| F04 | Socket-losing restart creates spurious forfeit | Table recovery | Zero/one/two-socket restoration follows the documented grace/terminal policy; mutual absence cannot produce an accidental winner |
| F05 | Departed invite host strands guest | Membership lifecycle | Host-gone start is bounded; guest can cancel before deal and immediately reclaim availability after authoritative release, without waiting 24 hours |
| F06 | Host plays two invite tables under one active pointer | Lobby ownership | Competing activations produce one committed active membership; stale invite/cleanup cannot acquire or erase another membership |
| F07 | Rating uses unverified/incomplete evidence | Verification + SQL | Altered adjustment, missing hand, mismatched participants or invalid terminal evidence cannot finalize a rated result; duplicates cannot apply it twice |
| F08 | Old upload acknowledgement drops final grade | Account sync | Provisional upload overlaps final grading; final version reaches server with no extra user action; flush cannot claim success earlier |
| F09 | Devices overwrite independent curriculum changes | Curriculum sync | Both arrival orders preserve disjoint work or expose a recoverable conflict; no timestamp-selected silent winner |
| F10 | Uninitialized sync approves destructive sign-out | Sync + account UX | First pull fails, local work exists, sign-out cannot call it saved; recovery/export/discard are explicit and account-safe |

### Adjacent findings to include—not quietly postpone

The original audit also identifies P2 issues and an operating-evidence gap. They are cheap or essential enough to integrate into the owning work rather than create a cosmetic launch around them:

- **F11:** evaluate elapsed turn deadlines before accepting a move, even if the alarm is late.
- **F12–F13:** correct rating-trend arithmetic and “latest 500” accuracy ordering under delayed ingestion.
- **F14:** distinguish a genuine unrated player from an unavailable rating lookup; never silently turn service failure into a 1500 identity.
- **F15:** make the next-practice recommendation aware of fresh-case exhaustion; do not turn missing content into learner failure.
- **F16:** missing modeled EV remains unknown; compare realized and modeled values over the same covered subset.
- **F17:** reject auto-repeat/IME shortcut events in practice and preserve normal keyboard/text-entry behavior.
- **Operating-evidence gap:** measure acknowledgement-to-render and real browser recovery. Local Node acknowledgement latency is not visual smoothness. This is an additional release-proof obligation, not an invented eighteenth finding.

A narrow release may hide an unsupported metric or unavailable practice route instead of building it now. It may not keep displaying a number or promise known to be false.

## 4. Workstream A: recoverable gameplay, membership and control

### A1. Separate an invitation from active membership

**Key decision:** retain the intended ability to have an unfilled invitation while queueing elsewhere. Do not fix F06 by indiscriminately locking every open invite for 24 hours.

Model three things independently:

- **Invitation:** a discovery/share object, possibly long-lived, not permission to run a game.
- **Reservation:** a bounded attempt to start a particular table, with a token/generation and expiry.
- **Active membership:** the authoritative account-to-table claim that permits participation.

`LobbyDO` owns acquisition and release. `TableDO` must validate current authorization before crossing waiting → starting → playing, including the pre-seated host. Closing a listing is not enough to revoke a table’s authority.

**Proposed activation protocol:**

1. Lobby serializes the attempt to reserve both participants. Within its durable transaction/serialized ownership path, either both reservations are obtained or neither becomes committed. Verify the existing lobby topology before choosing the exact transaction primitive.
2. It issues an activation token bound to table, accounts and ownership generation. The table persists acceptance before starting.
3. Lobby commits the active claim; the table starts only with a valid committed activation. Retries retrieve the same outcome.
4. A crash between these steps leaves a durable incomplete activation record, not an inferred success. A reconciler completes or cancels it idempotently.
5. Cleanup is **compare-and-release**: release only if account, table and generation still match. An old callback cannot clear a new game.

This is a short recoverable coordination protocol, **not an imaginary distributed transaction across two Durable Objects**. Never hold a SQL transaction open across network calls; no Postgres involvement is required. Persistent fencing/token checks prevent a superseded object from continuing to activate.

Do not free a committed active membership merely because a lobby timer expired while the old table might still accept play. Reassignment requires confirmed terminal/revoked ownership, or an explicitly designed lease whose expiry the table itself enforces. A generation number stored only in the lobby does not fence a stale running table. Prefer conservative temporary unavailability with reconciliation over two concurrent authorities.

### A2. Bound starting states separately from invite expiry

Add explicit starting/no-show/cancel semantics when the guest is admitted. Use an existing compatible start timeout if appropriate; otherwise propose a short bounded window, for example 60 seconds, as a product policy to ratify—not a hidden constant.

- If the host is absent, show “Waiting for host” and a real Cancel action; optionally refuse admission if that creates a clearer experience.
- Pre-deal Cancel ends the reservation without a competitive penalty. Post-deal Leave follows the established game policy; do not conflate them.
- Deadline, cancellation and host return race through one authoritative transition. Cancellation that loses to the first deal returns “Game started” plus the current state, not fabricated success.
- Successful release unlocks the player independently of the link’s remaining lifetime.
- Queue, quick-sit, invite acceptance and resume all consult the same membership truth.

**Proof matrix:** two tabs, two devices, two invites, simultaneous guests, host leaves before/after acceptance, cancel races first deal, process dies after each activation step, old cleanup arrives after new ownership, and reconnect to a superseded link. Assert account ownership and actual accepted actions, not just lobby rows.

### A3. Make seat commands as trustworthy as poker actions

Extend the existing action-ID discipline to `stand`, `sit_out`, `sit_in`, and `rebuy`. Do not invent a second unrelated transport framework.

Proposed command envelope: `commandId`, command kind, table ID, membership/seat generation, expected state version, and hand ID where relevant. Server response: command ID, accepted/rejected/stale disposition, resulting state version and a machine-readable reason. A snapshot must expose sufficient **own-player** authoritative status to reconcile accepted-but-not-yet-executed standing, without leaking private information about others.

The important distinction is **accepted intent versus executed effect**. “Stand after this hand” can be accepted now and completed later. An acknowledgement is not permission to optimistically remove a seat or adjust chips.

Client states:

```text
idle → sending → accepted-pending-effect → completed
          ├→ rejected → actionable current state
          └→ outcome-unknown → resync → resolved or safe retry
```

- Never interpret `WebSocket.send()` as success.
- A watchdog expiry means unknown, not rejected or accepted.
- On reconnect, reconcile with a snapshot and durable command outcome. Re-send only the same still-applicable command ID after checking its scope; never blindly replay an old command into a new seat/hand.
- A retry of a rebuy must not buy chips twice. A retired seat’s retry must not stand up its new occupant.
- Retain deduplication outcomes for the supported retry/resume horizon. Beyond that, reject stale IDs and demand resync rather than guessing.
- Until Stand is accepted, betting controls continue to reflect legal server actions. Once accepted, render the server’s actual standing/auto-action policy.

### A4. Recover absence from state, not only socket callbacks

On restore, join, message and alarm, reconcile durable match state with the actual accepted socket set. Hibernation that preserves sockets is not the same as a restart that loses them.

Persist each established absence start/deadline. If recovery discovers absence without a prior close event, record a recovery observation and establish the policy-defined grace **once**. A new restart must not keep renewing it. Do not backdate an unknowable disconnect time and penalize the player as though it were proven.

Before ordinary timeout processing, evaluate the match-level both-absent rule. Explicit voluntary forfeit, one-player disappearance, both-player absence and infrastructure recovery need different terminal reasons. Preserve the current policy unless deliberately amended; do not silently create “disconnect to erase a losing match.” Track mutual-abandon patterns separately from competitive outcome and acknowledge that abuse controls are a later policy concern, not solved by this repair.

### A5. The deadline wins by policy, not callback timing

For F11, centralize deadline reconciliation before any state-mutating command. Capture server receipt time at ingress and define one equality rule, for example receipt at/after deadline is late. Specify how that interacts with event ordering and queued work; client timestamps cannot override it.

Apply all overdue relevant transitions in deterministic order, then validate the command against the resulting decision. An alarm is a wake-up mechanism, not the source of truth about whether time elapsed. Repeated alarms and repeated recovery must be idempotent.

**Exit:** no tested user becomes stranded; no command makes an unacknowledged irreversible claim; no recovery fabricates a competitive winner; deadline outcomes are independent of alarm lateness. Ship this before connecting a redesigned table to real users. [S1–S3]

## 5. Workstream B: correct betting and coherent hand presentation

### B1. Fix the short blind at the rules boundary

Represent the nominal preflop bring-in separately from actual chips posted. Audit every use of current bet in legal actions, round completion, raise reopening, effective-stack caps and refunds; changing only the displayed call amount is not a fix.

Golden example: 10/20 blinds, button/SB/BB stacks 1000/1000/15. The first deep player must call 20 or raise to at least 40. If both deeper players call, contributions are 20/20/15: main pot 45 eligible to all three, side pot 10 eligible only to the deeper players. Never manufacture the missing five chips for the BB.

Controls include BB below SB, both blinds short, 3–6 players, short heads-up blinds, only one opponent capable of further betting, short all-in reopening, uncalled excess, dead-button movement and odd-chip allocation. Assert chip conservation after every action. Preserve existing HU outcomes; this must not become an opportunistic engine rewrite. [S4]

### B2. The server owns time; the client owns presentation within that time

The current mismatch is concrete: `NEXT_HAND_MS = 3000`, while a preflop reveal can take about 4100 ms. Increasing 3000 to 5000 may contain it temporarily, but does not solve late frames, background tabs, reduced motion or future animations.

Introduce a versioned **hand-completion envelope**:

- completed hand identity and immutable final public snapshot;
- terminal state sequence and result availability;
- server completion timestamp;
- presentation schedule/version and earliest next-deal time;
- subsequent decision identity/deadline when it actually begins.

Choose the bounded schedule by event shape—fold, normal river, all-in from preflop/flop/turn—not by the current client’s animation duration. Derive the bound from reveal beats **plus a visible result hold**, then measure it. Reduced-motion mode shows the result immediately but does not independently accelerate a shared game.

**Do not wait indefinitely for all clients’ animation acknowledgements.** A client can be asleep, offline or malicious. Completion acknowledgements may provide telemetry or support a bounded future optimization; they cannot be a liveness dependency.

Client responsibilities:

1. Keep a completed-hand presentation object instead of rendering everything directly from the latest live snapshot.
2. On ordinary delivery, complete the permitted reveal/result phase before switching to the next hand.
3. On late delivery or wake, use server schedule/current state to compress or skip animation. If the next decision is already live, immediately show it and preserve the previous result in an accessible “Last hand” surface. Do **not** hide the current action timer behind a stale movie.
4. Never mix an old hand’s cards/pots with a new hand’s controls; key all animation and interaction by hand/decision identity.
5. Cancel obsolete animation work on resync, seat change and terminal match transitions. A payout animation remains attached to its original participant, not a reused seat.

No networked design can guarantee a sleeping/disconnected player sees every frame before the game continues. The honest guarantee is: **bounded normal pacing, no client-created hidden turn, authoritative catch-up, and durable access to the completed result.**

### B3. Give designers a state matrix, not just a happy-path mock

Design and implement at least: searching, waiting-for-host, reservation pending, seat rejected, acting, action pending, command unknown, reconnecting, resyncing, standing accepted, all-in reveal, result hold, match ended, rating pending, review unavailable, learning conflict and unsaved sign-out.

At 1366×768, the player’s cards, legal actions and turn clock must remain legible together. Maintain focus across action-bar changes, neutral action emphasis, “raise **to**” semantics, text contrast, long-name handling, keyboard-only operation and reduced motion. Fix shortcut repeat/composition guards rather than using a timing debounce as a substitute for intentional input.

**Exit:** the redesigned table passes deterministic timing tests and real browser fault scenarios. Preserve private-card redaction and prohibit live coaching imports. “Looks cinematic” is not an acceptance condition. [S5–S6]

## 6. Workstream C: close the rated-result evidence chain

### C1. Distinguish three products that share a match ID

1. **Gameplay result:** the authoritative table’s immediate outcome and chips.
2. **Verified competitive result:** an outcome justified by complete, policy-valid archived evidence.
3. **Published rating change:** an exactly-once application of that verified outcome to a particular rating state/model.

The first can be shown immediately. The second and third may be pending. Never block the next poker action on Postgres or exact-equity recomputation in an archive consumer.

Proposed lifecycle:

```text
ended → archive-pending → evidence-complete → verified → rating-applied
                           ├→ waiting-for-evidence
                           └→ quarantined → investigated → repaired/reverified or voided
```

“Pending” is normal eventual consistency. “Quarantined” means a specific validation failure, not a slow queue. DLQ/redrive needs a recoverable operator path. Never convert either state into an implicit win/loss.

### C2. Hand verification must verify the rating-bearing value

The existing verifier validates substantial replay/deck/result evidence but does not independently recompute the luck adjustment consumed by settlement. From the replayed terminal hand, recompute all-in point, equity, adjusted net and consistency with realized result under the applicable rules version.

Specify numeric canonicalization and tolerances deliberately; reject non-finite values, invalid seat keys and missing required adjustment fields. Exact board enumeration still produces floating values; do not use arbitrary broad tolerances that can move a match across the draw band. Include folds, river showdowns, preflop/flop/turn all-ins, ties, refunds and threshold-adjacent totals. Benchmark additional verification CPU, especially preflop enumeration, **in the actual Worker execution envelope**, not just Node.

Reusing a pure calculation module is reasonable production engineering. It is not independent assurance against a common bug in that module. Add independently reasoned golden fixtures, symmetry/conservation checks and a small alternative/offline oracle test set. Do not claim cryptographic proof that the poker/adjustment rules themselves are correct merely because the recorded deck commitment verifies. [S7]

### C3. Verify the match, not only a bag of individually valid hands

Create a server-controlled, versioned settlement certificate binding:

- match ID, rules/configuration version and participant/seat identities;
- ordered expected hand manifest: IDs, sequence, content digests and verified versions;
- terminal reason and its durable event evidence;
- verified adjusted totals, outcome and draw-band version;
- verifier version, evidence digest and completion timestamp.

A digest binds evidence; it does not make bad evidence trustworthy. Only an authorized verifier can create the certificate, and certificate creation must read validated source rows. Clients cannot submit “verified=true.” Changes to evidence invalidate or supersede its certificate. A boolean `hands.verified` from an older verifier is not enough for a new adjustment-validation policy.

**Required evidence depends on terminal reason:**

| Terminal class | Required evidence | Result treatment |
|---|---|---|
| Normal completed rated match | Configured hand count, contiguous unique manifest, verified hands, participants/config and aggregate consistency | Eligible for settlement |
| Explicit forfeit / policy-valid timeout | Verified completed prefix plus authoritative terminal transition, applicable clocks/grace/command history; incomplete current hand handled explicitly by policy | Eligible only after terminal-policy verification |
| No-show before play | Server admission/start/presence/deadline record satisfying the existing no-show policy | Apply only the policy-authorized outcome; never fabricate hands |
| Mutual absence / abandoned | Valid terminal reason and recovery provenance | Void/no competitive win-loss under current policy |
| Missing or contradictory evidence | Explainable failure or backlog status | Pending or quarantined, not finalized |

Do not require 40 hands for a legitimate early termination. Do not accept zero hands for a match labeled normally completed. Count alone is insufficient: duplicates, swapped identities, gaps and foreign hands must fail.

### C4. Put the gate where rating writes happen

The `apply_rating` database function must atomically require the correct current certificate, validate the match/certificate relationship, preserve optimistic rating-version checks and enforce a unique settlement identity. Application code alone is insufficient: retries, old Workers or administrative mistakes can otherwise bypass it.

Retain deterministic player lock order and stale-version recomputation. Treat delivery as **at least once with exactly-once effects**, not magical exactly-once queues. Return the already-applied change on duplicate finalization.

Move rating eligibility behind verification: either the verifier emits durable settlement-ready work, or an idempotent settlement reconciler discovers verified certificates. Include a periodic bounded catch-up scan so a lost wake-up cannot strand a valid match forever. The live table remains responsible for durable hand/terminal archiving, not deciding that async verification succeeded.

### C5. Fix metric semantics at the same boundary

- **Trend:** sum actual per-match rating deltas attributed to the chosen played-time window; do not subtract application-order snapshots sorted by play time. Resets/sanctions/corrections are separately typed.
- **Rating order:** retain existing application-order Glicko for the first repair and explicitly document it. It is not equivalent to chronological replay. If canonical chronological rating is wanted later, that is a separate versioned rating-policy migration with replay costs—not a stealth SQL tweak.
- **Latest 500 accuracy:** select by authoritative play/decision order, with stable tie-breakers, not archive arrival; recompute the affected window when late grades arrive.
- **Matchmaking:** distinguish `unrated` from `unavailable`. Proposed default: temporarily pause rated pairing or use an explicitly bounded, labeled last-known value under an approved policy. Casual play can remain available. No silent 1500 on read failure.
- Keep model accuracy, uncertainty, sample count, grading coverage, format and freshness visible. Six-max accuracy stays unsupported until a valid multiway grading model exists.

### C6. Do not “repair history” before measuring it

Roll out the stronger verifier in shadow mode against retained evidence first. Produce counts of verifiable, missing, failed and legacy-insufficient matches without altering ratings. Production inspection requires appropriate authorized read access; the audit did not establish database parity.

Default policy proposal: enforce the new gate for new matches from a clearly recorded cutover; label historical assurance honestly; separately decide what to do with genuinely affected history. Do not silently certify all old rows or reset every player.

If a wrongly settled historical result is found, simply subtracting its original rating delta does **not** generally repair Glicko: later results used changed states, including opponents’ states. Use a scoped dependency-aware replay from a checkpoint or a separately approved, transparently labeled correction policy. Preserve original entries plus superseding versions, with an auditable explanation. Never promise cheap exact repair before assessing the connected history.

**Exit:** the corrupt-adjustment and zero-archived-hand probes are rejected; all legitimate terminal classes work; queue loss/reorder/duplication converges; no unverified result can write public rating history. [S7–S10]

## 7. Workstream D: make learning saves genuinely durable

### D1. Replace “nothing queued” with an honest durability model

An empty queue is not proof that reconciliation ever happened. Proposed user-visible states:

`checking account`, `saved on this device`, `saving`, `saved to account`, `offline with local changes`, `conflict`, `blocked by storage/size/quota`, `unable to verify`.

“Saved to account” means the current account is established and the server has acknowledged the **specific latest revisions** included in the save barrier. It does not mean “no exception was thrown.”

Track account identity/epoch, reconciliation status, latest local revision, acknowledged revision and blocked/conflicted work. Register local modifications before readiness; persist them to an outbox or explicitly preserve a complete dirty snapshot for later discovery. Learning started during a failed first pull must not be invisible.

### D2. Immediate containment for the upload race

Keep a snapshot/hash or revision for each upload. On response, mark only that version acknowledged. Remove it from pending only if the current local version still matches; otherwise retain/requeue the newer version and continue draining without waiting for another user edit.

`flush` should return a structured result, not a boolean that conflates saved, timed out, unknown and blocked. Capture a target revision watermark; if sign-out is the caller, freeze edits or recheck after the barrier so work created during flush is not lost.

Also prevent the server from accepting a stale provisional overwrite after a final version, including from another device. Add a server revision/content precondition and an explicit record-lifecycle transition policy; a device-local sequence number is not a global ordering authority. A corrected final evaluation is a new version, not simply “final always wins.” The immediate client ACK fix closes the reproduced single-device race; server write rules close the broader last-arrival-wins variant.

Include oversized/capped records in blocked status. The inspected sync code has paths that remove too-large records or clear a too-large curriculum’s dirty flag; do not let a narrow F08 fix preserve another route to a misleading saved state. Test quota and storage exceptions explicitly; these are additional design checks, not newly claimed production incidents.

### D3. Minimum safe cloud concurrency: server revisions and conflicts

Add a server revision and compare-and-swap RPC for curriculum documents. A save includes account ID, base revision and document/content hash. In one transaction, the server either accepts and returns the new revision, or returns a conflict and the current revision. A timestamp is metadata, not an authority to overwrite another device.

Block direct whole-document writes that bypass the concurrency gate while preserving the intended RLS/security boundary. This is a tightening of authorized write semantics, not disabling protections. Older clients must receive an explicit upgrade/reconcile response, not silently continue last-write-wins writes.

Merge by meaning:

| Data type | Safe rule |
|---|---|
| Final submitted attempts / receipts | Union stable IDs; identical ID + divergent immutable content is a conflict, not “latest wins” |
| Exposure history | Monotonic union; never clear exposure just to create a “fresh” pass |
| Notes | Three-way merge using base/local/remote; same-field conflict preserves both versions for user choice |
| Drafts | Separate draft identity/device branch; no silent loss of an in-progress attempt |
| Preferences | Per-field revision policy; low-risk last-writer semantics only if explicitly chosen |
| Review schedule / skill state | Recompute from merged evidence using a versioned policy, not `max()` of a flattering state |
| Delete/reset/history-clear | Durable tombstone or deletion generation that dominates stale uploads; deletion cannot be undone by an offline device |

The first safe version can expose a conflict instead of implementing every automatic merge. It must preserve both versions and explain recovery. Event-oriented storage comes next where it reduces conflicts; a full CRDT framework is not a prerequisite.

### D4. Use a durable, account-scoped outbox for the evidence layer

For longer-term evidence, use IndexedDB transactions to commit the local event and its upload job together. Each event has stable identity; the server enforces uniqueness per account/event and returns accepted versions. Process retries independently of UI mounting. Persist backoff, handle schema upgrades, and recover across reload/crash.

Local storage remains fallible: browser eviction, private mode and quota cannot be made into cloud durability. Surface local-only status and an export path. Do not promise that a background service worker or `beforeunload` can guarantee a last-second save.

### D5. Sign-out is both a privacy operation and a durability decision

Recommended default on shared devices: clear local account data on completed sign-out. If cloud acknowledgement is missing, offer **Wait/retry**, **Export and sign out**, or **Discard unsaved work and sign out** with an explicit loss warning. Do not silently keep sensitive notes across sign-out in the name of safety.

A future “keep an account-bound recovery copy on this trusted device” option needs an explicit privacy/security design; browser storage namespaces are not encryption or access control. It is not necessary for the first fix.

Increment an account epoch on sign-out/switch. Abort or ignore late responses from the old epoch; never allow an old sync worker to merge old-account work into a new account. Unowned guest work requires an explicit claim/merge policy; do not infer ownership from whichever account next authenticates.

**Exit:** F08–F10 pass under delayed responses, reload, two tabs/devices, timestamp skew, auth expiry, full storage, size caps, account switching and history deletion. Importantly, a test must perform the overlap and then make **no unrelated edit** that could accidentally heal the race. [S11–S12]

## 8. Workstream E: trustworthy learning evidence before personalization

### E1. Keep the three measurement systems independent

| System | Question it answers | Evidence | What it must not imply |
|---|---|---|---|
| Competitive rating | How have I performed against opponents under this format’s rules? | Verified rated match outcomes, rating state and uncertainty | General intelligence, finance competence or individual-decision optimality |
| Modeled decision quality | How did my action compare with this model under its assumptions? | Decision-time inputs, supported evaluator, model version and coverage | Solver truth for unsupported situations, unaided understanding, or a guaranteed win |
| Demonstrated learning | What can I independently explain/apply, transfer and retain? | Eligible unaided attempts across fresh contexts and delayed checks | A single immutable ability score or immediate competence in real investing |

Link the three through provenance and review navigation, **not a weighted composite**. Rating RD, statistical uncertainty about a decision model, learner self-confidence and uncertainty in a skill diagnosis are four different things.

Never use realized poker wins as positive learning evidence by default. Never interpret a rating drop as proof of forgetting. Never use previously hidden opponent cards to justify what the player should have known at decision time. Post-match settlement equity and information-set-valid decision grading serve different purposes.

### E2. Extend current evidence primitives; do not throw them away

The current curriculum already has valuable concepts: `AttemptSnapshot`, `EvidenceReceipt`, `ReviewSchedule`, versioned content/rubrics, assistance and exposure exclusions. `LearningStoreV2` is a useful account document; it is **not yet** a longitudinal learner model.

Add a normalized evidence envelope that can reference those records and completed live/practice decisions. Proposed fields:

- **Identity:** event ID, account ID, source event ID/revision, session, mode and source trust tier.
- **Timing:** observed client time, server receipt time, trusted completion time if available, and time uncertainty.
- **Task provenance:** skill tags and mapping version, case/variant/family identity, content/rubric/model versions, task difficulty/context.
- **Information set:** what the learner could legitimately know at commitment; reference minimal inputs rather than duplicating private archives.
- **Response:** prediction, structured answer/rationale, confidence when collected, response duration and assistance/exposure history.
- **Evaluation:** raw response reference, evaluator version, outcome/coverage, critical error tags, uncertainty and eligibility reason codes.
- **Lifecycle:** provisional/final/superseded/invalidated/deleted, content digest and validation provenance.

Keep raw attempts, evaluations and derived receipts distinct. An uploaded client receipt can be useful private self-study evidence, but cannot become server-verified proof merely by being durable. For stronger learning claims, re-evaluate structured answers against trusted versioned rubrics server-side or otherwise validate source provenance. Do not quietly make the account a “certified learner” database.

**Local editing is mutable; submitted evidence is immutable.** A provisional hand is not overwritten into oblivion: a final grade references/supersedes its earlier revision. A corrected rubric produces a new evaluation and rebuilds projections. Deletion removes or redacts protected source data and derived projections under an explicit retention policy; an append-only architecture must not become an excuse to retain personal data forever.

### E3. Make every model state rebuildable

Use a small number of conventional Postgres tables or equivalent normalized structures for evidence, evaluations and versioned projections. Do not persist only an opaque “skill JSON” that cannot be explained or replayed.

Requirements:

- Ingest is idempotent and account-scoped; stable IDs survive offline retries and imports.
- A projection records evidence cutoff/watermark and projector version.
- Reordering, duplicate delivery and late finalization produce the same projection for the same valid evidence set.
- Invalidated evidence is removed from the next projection; model changes do not edit the original attempt.
- Backfills and version migrations run in shadow, compare outputs and can be stopped without blocking play.
- Legacy records retain what can be known. Missing assistance or exposure provenance is “unknown,” not retroactively “unaided.”

### E4. Fix the data semantics before adding a diagnosis

In practice statistics, replace `expectedNet ?? net` with explicit modeled coverage. For example: “Modeled result available for 12 of 20 hands”; compare actual and modeled totals on those same 12, and show the total actual result separately. Assisted, pending and ungraded records cannot silently enter a metric that claims independently modeled accuracy.

A coverage drop or a model-version change should appear as an explanation, not a surprising loss of “skill.” A model that grades only easy cases must not look better merely because hard cases remain ungraded. Show eligible, evaluated and excluded denominators, and stratify comparisons by format/model where necessary.

**Exit:** an engineer can reconstruct any displayed learning claim from its evidence IDs, eligibility rules and versioned calculation. A learner can understand why evidence counted or did not count. [S13–S15]

## 9. Workstream F: a learner model that is useful before it is clever

### F1. Start with a small, explicit skill graph

Use concepts as durable identities; courses, poker modes and screens are evidence sources—not separate definitions of the same skill.

Initial pilot: three well-supported skill families already aligned with the foundation curriculum:

1. **Incremental outcomes and sunk costs:** distinguish pot receipts from profit; construct net outcomes at the decision point.
2. **Conditioning and event definition:** distinguish improving a hand, winning, expected pot share and profitability; update on information actually observed.
3. **Expected value and decision thresholds:** combine state outcomes with probabilities, identify break-even assumptions and explain what would reverse the choice.

Expand later into variance/risk sizing, value of information, dependence, hedging and options only when the evidence and case design support it. Do not infer broad finance mastery from a few correct poker calls. A business/payoff task must test the actual transfer.

Each skill definition needs prerequisites, observable behaviors, misconception codes, eligible evidence sources, supported contexts and a mapping version. Avoid an enormous ontology before the first intervention works.

### F2. Store multiple dimensions, not one “mastery probability”

Proposed per-skill projection:

| Dimension | Meaning | Example display |
|---|---|---|
| Evidence coverage | Independent eligible attempts, contexts, freshness and recency | “Three eligible checks across two contexts” |
| Performance pattern | Which rubric elements succeed/fail | “Calculates probabilities correctly; net payoff setup is inconsistent” |
| Misconception hypotheses | Supported, contradicted or uncertain explanations | “May be counting returned stake as profit” |
| Demonstration stage | Observed, practiced, independent, transferred, retained | “Transferred once; delayed check not yet completed” |
| Retention state | Due date, actual delayed outcomes, time reliability | “Review due; retention currently unknown” |
| Calibration | Confidence versus correctness where collected | “High confidence on two setup errors” |
| Intervention response | What was tried, assistance, immediate and delayed response | “Ledger exercise helped immediately; transfer not tested” |

Missing evidence is not zero ability. Aging evidence reduces confidence in a current claim; it does not prove the learner forgot. A failed check may have an ambiguous cause. Show uncertainty and ask for a discriminating diagnostic rather than manufacturing precision.

### F3. Diagnosis must compete with alternative explanations

One poor poker action might reflect a misconception, a wrong opponent-range assumption, an interface slip, time pressure or a limitation of the grading model. Do not turn every loss of modeled EV into a permanent misconception tag.

For each candidate diagnosis:

1. Identify a specific observable error pattern.
2. Check repeated evidence across genuinely different tasks, not duplicated cases or ten actions from the same hand.
3. Check assistance/exposure and grading coverage.
4. Look for counterevidence and contextual exceptions.
5. If ambiguity remains, recommend a short diagnostic that separates hypotheses.
6. Promote only when the evidence meets a documented rule; demote/resolve when fresh counterevidence arrives.

Example: a learner repeatedly uses gross payout instead of net gain. One targeted question asks for cash flows before any probability calculation. If the ledger is correct but their threshold remains wrong, the diagnosis shifts from incremental accounting to probability/EV setup. The system should learn that it was uncertain, not insist on its first label.

### F4. Start interpretable; earn probabilistic complexity

First model: deterministic, versioned evidence rules with cautious stages and visible support counts. It is easier to debug and can be evaluated with small data. Do not train a neural learner model simply because one is fashionable.

For the pilot, a possible policy is: independent demonstration requires eligible unassisted checks across more than one task/context; transfer requires a fresh changed-domain case; retention requires a materially fresh check after the defined delay. The exact counts, interval and pass threshold must be documented as **product policy to validate**, not scientific facts.

Later, compare a calibrated probabilistic knowledge/forgetting model with this baseline. Require out-of-sample calibration, held-out-user evaluation, discrimination of correlated attempts and performance across source modes. Naïvely feeding every answer into an independent Beta update will overstate certainty when questions share a family or a session.

LLMs may draft explanations or suggest candidate tags behind strict validation. They must not be the sole source of grades, durable diagnoses or progression gates. Free-text notes are user data, not instructions to the evaluator; allowlisted structured outputs and deterministic checks prevent prompt text from controlling grades.

### F5. Make “why this practice?” a first-class product surface

Every recommendation should answer four questions:

1. **What did you notice?** Cite two or three relevant examples with their limits.
2. **What do you think is happening?** A plain-language, falsifiable skill hypothesis.
3. **Why this exercise?** Explain the targeted mechanism, estimated effort and assistance level.
4. **How will we know it helped?** State the fresh follow-up and delayed reassessment.

Offer “This does not fit,” “Show the evidence,” and “Choose another focus.” User disagreement is useful feedback, not proof that the original grade was wrong. Keep a deterministic record of recommendation policy, candidate set, chosen intervention, reasons and exclusions so behavior can be replayed.

## 10. Workstream G: close the intervention → transfer → retention loop

### G1. Recommendations should select the next useful uncertainty reduction

Do not begin by optimizing daily active users, points earned or immediate accuracy. Optimize the chance of **useful, retained improvement per reasonable unit of effort**, subject to learner choice and fatigue.

Use a transparent priority policy before any bandit/ranking model:

1. Honor an explicit learner goal when safe and supported.
2. Offer due delayed checks only when fresh eligible material exists.
3. Diagnose uncertain prerequisites that block the goal.
4. Remediate a supported, recurring high-impact misconception.
5. Test transfer after practice—not another copy of the coached task.
6. Expand the curriculum or offer optional challenge when no clear weakness is supported.

Use cooldowns, variety and skip controls. A repeatedly failing learner may need a different explanation or prerequisite, not ever more of the same exercise. Low confidence should often trigger a diagnostic, not aggressive remediation. Cold-start users should get a short optional diagnostic and a reasonable curriculum baseline, not an empty “AI profile.”

### G2. Build an intervention library, not a question generator

Each intervention has a target mechanism, prerequisite, dose, assistance policy, worked example, fading-support practice, immediate check, fresh transfer family and delayed check family. Examples:

- **Gross versus net confusion:** explicit outcome ledger → partial ledger → unaided poker threshold → fresh business-payoff task.
- **Conditioning error:** commit a probability before/after new information → enumerate the changed sample space → transfer to demand or warranty information.
- **Outcome bias:** compare paired decisions with identical ex-ante quality but different realizations → explain the choice without seeing the outcome → delayed new context.

Content creation is part of the critical path for adaptive learning. A better database cannot manufacture valid transfer cases.

### G3. Freshness belongs to families and exposure, not just case IDs

A new numeric seed is not necessarily a new reasoning problem. Track authored template/family, material transformations and prior exposure—including preview, hints, worked solutions and closely related variants.

Reserve reassessment families that the training recommender cannot consume. The learner cannot preview an answer and later claim it as fresh. Holdouts used to measure model efficacy must also remain separate from the intervention-authoring/calibration data.

Fix current exhaustion explicitly:

```text
review due + fresh case exists → offer fresh check
review due + no fresh case → content-limited state
    ├→ related skill / different eligible family
    ├→ labeled repeated practice (no new retention claim)
    └→ wait for validated content
```

An exhausted bank is a content-supply defect, not evidence of learner failure. Track it as an operational metric. Generative content may expand the bank only through constrained templates, solver/rubric checks, equivalence review and exposure-family tagging. Automatically generated prose is not automatically valid assessment.

### G4. Delayed means genuinely delayed

Record the relevant evidence times and their trust level. Offline completion with an untrusted device clock cannot silently become a certified delayed assessment. It may remain useful self-study evidence with a qualification until reconciled. Fixing sync must not accidentally upgrade the evidentiary strength of old clock data.

Choose initial intervals such as a next-week and a later follow-up only as pilot design parameters. Time must actually pass; no volume of parallel agents or accelerated tests proves retention. Store immediate performance, transfer and retention separately so a coached improvement cannot masquerade as a retained skill.

### G5. One complete worked journey

1. **Observe:** across eligible post-hand review and curriculum tasks, a learner appears to count the whole returned pot as profit. Several other tasks are correct; the diagnosis is tentative.
2. **Discriminate:** ask a short no-probability cash-flow question. Their error persists, supporting incremental-accounting difficulty rather than range uncertainty.
3. **Explain:** “You have twice counted returned stake as gain. That can make expensive calls look profitable. Let’s separate payments and receipts.” Link the evidence; never cite unrevealed opponent cards.
4. **Intervene:** a brief ledger exercise with fading hints. Mark it as assisted practice, not mastery evidence.
5. **Transfer:** give a previously unseen business-payoff case. Success changes the stage to “fresh transfer demonstrated”; failure triggers a different next step.
6. **Delay:** schedule an eligible new family after the required interval. Until then, retention is unknown.
7. **Reassess:** a fresh unaided pass supports “retained in these tested contexts.” An error updates the hypothesis and intervention choice without erasing history.
8. **Keep domains separate:** the user’s competitive rating is unaffected by this learning progression. Modeled poker accuracy may change over time, but is not the evidence that the finance transfer succeeded.

This is the smallest meaningful version of “DeltaDeck learns the player.” Build this vertical slice before expanding to dozens of skills.

## 11. Prove the learning loop helps before scaling its claims

### Three distinct evaluation layers

**1. Engineering validity.** Same evidence set → same projection; invalidated grades disappear; duplicate events do not increase confidence; exposed/hinted cases cannot create unaided receipts; fresh-case exhaustion resolves honestly. A domain reviewer checks diagnosis/explanation fidelity on curated examples and counterexamples.

**2. Predictive validity.** Does the learner state predict held-out unaided transfer and delayed performance better than simple baselines? Split by learner and case family where appropriate, avoid training/test leakage, report calibration and coverage, and inspect errors by prior skill and mode. Accuracy only on easy-to-grade tasks is not sufficient.

**3. Intervention efficacy.** Does the recommended practice improve later fresh performance more than the existing curriculum-order/review-date approach, for comparable effort?

### A credible pilot

- Narrow to the three initial skill families with enough distinct authored transfer/review content.
- Use shadow recommendations first; reviewers inspect unsupported diagnoses and content gaps without changing learners’ experience.
- Then run a clearly scoped pilot with a fixed baseline and versioned policies. Randomize at the learner level where feasible to reduce cross-session contamination; stratify by baseline proficiency.
- Predeclare the primary endpoint: delayed, fresh, unaided assessment on held-out families under a common rubric. Immediate coached scores, completion, return rate and enjoyment are secondary outcomes/guardrails.
- Keep effort comparable or explicitly model/report differences. More practice time alone is not evidence of a better recommendation algorithm.
- Track assignment, exposure, adherence, assistance, dropout and missing follow-up. Report intention-to-treat estimates and attrition/sensitivity analyses; do not report only the enthusiasts who return.
- Estimate sample size after obtaining baseline variance and choosing a worthwhile effect. Do not invent “100 users proves it.” Use uncertainty intervals and a planned stopping rule rather than watching significance until it turns favorable.
- At low traffic, use repeated within-person diagnostics and blinded qualitative review to refine the system, but do not market those observations as causal proof.

**Gate B:** safe engineering, explainable recommendations, adequate content and no false claims permit a limited pilot. Broad claims of improved learning require favorable delayed-transfer evidence with acceptable uncertainty and no material harm or trust regressions. A null result means adjust the intervention/policy, not re-label activity as learning.

## 12. Execution architecture: parallelize bounded work, not shared-file chaos

### First decisions to write down

Before implementation, produce short contracts—not a new 100-page design bureaucracy—for:

1. Membership ownership and compare-and-release generations.
2. Command acceptance/effect/retry semantics.
3. Recovery/deadline/terminal-reason policy.
4. Hand-completion schedule and catch-up behavior.
5. Settlement certificate and database write gate.
6. Sync revisions, conflicts, sign-out and deletion semantics.
7. Evidence eligibility, skill taxonomy and the three separate measurement domains.

Each contract includes examples, illegal transitions, compatibility rules, source-of-truth owner and executable acceptance tests. The contract should be small enough that an implementer can actually keep it in mind.

### Recommended workstreams and ownership

These are bounded engineering lanes, suitable for an AI-agent implementation with a single accountable integration/release owner. They are not a request to launch implementation agents in this planning session.

| Lane | Responsibility / likely code seams | Dependencies and handoff |
|---|---|---|
| A — Live reliability | `table.ts`, `lobby.ts`, `deadlines.ts`, `games.ts`, protocol membership/commands | Owns Worker state transitions; supplies command/recovery fixtures to UI and terminal evidence to C |
| B — Rules + presentation | `engine/hand.ts`, runout state, table UI, action controls | Rules patch independently reviewable; server pacing edits integrated by A after shared lifecycle contract |
| C — Rated integrity | `verify.ts`, `rating.ts`, `rated.ts`, certificate/ladder SQL | Terminal evidence depends on A; database boundary reviewed separately from app verifier |
| D — Learning durability | `sync.ts`, account UI, account-data migrations/RPCs | Locks identity/revision/tombstone contract before E relies on it |
| E — Learning model + content | Curriculum core, evidence schema, projections, recommendation/case policy | Can design taxonomy/content now; production model writes depend on D and source validation |
| F — Independent acceptance | Worker/engine fault harness, SQL replay, real browser scenarios, bundle/privacy checks | Writes adversarial tests against agreed behavior; cannot self-certify the implementation it authored |

Do not let three agents independently edit `worker/src/table.ts`, shared protocol unions or the same migration sequence. Use worktrees/branches, explicit seam ownership and small integration commits. The integration owner resolves contract mismatches; specialist review should attack invariants, not merely approve code style.

Every lane returns: focused diff, affected invariant IDs, failed-before/passed-after tests, compatibility/migration notes, telemetry added, remaining uncertainty and a rollback-safe version. Passing lint is necessary, not the handoff itself.

### Dependency graph

```text
Contract + adversarial-test lock
    ├→ short-blind correction ───────────────────────────────────┐
    ├→ membership / command / recovery ─→ terminal evidence ─┐   │
    │                └→ presentation integration ───────────┼───┤
    ├→ exact-version sync ─→ conflict/sign-out safety ───────┼───┤
    └→ hand verifier ─→ match certificate + DB gate ─────────┘   │
                                                              ├→ Gate A
Redesign fixtures + component work ─→ integrated browser proof ┘

Durable evidence + source validation ─→ skill projection
Authored intervention + reserved fresh cases ─────────────┤
                                                        └→ shadow → pilot
                                                                  → real delayed follow-up → Gate B claims
```

### Order of implementation slices

| Slice | Deliverable | Exit | Safe to parallelize? |
|---|---|---|---|
| 0 | Reproduction-to-regression conversion; contracts; migration/protocol inventory | Every F01–F10 has an owned assertion and known expected behavior | Yes, with one protocol/schema integrator |
| 1 | Small containment: rules, lost-command UI truth, exact-upload ACK, initial-sync/sign-out status, honest unknown metrics | The most direct user harm is removed in focused tests | Mostly; no claim that this alone is release-ready |
| 2 | Membership/restart lifecycle, bounded hand timing, CAS conflicts, strong hand/match verification | Full fault matrix and integration contracts converge | Separate lanes; serialize shared table/schema edits |
| 3 | Database settlement gate, history semantics, compatible migrations, operator tooling | Direct write-gate probes fail closed; backlog/retry/correction paths work | Integrate carefully; old writers must not bypass new rules |
| 4 | Redesign wired to real states, browser/device acceptance, staged canary | Gate A evidence and rollback rehearsal accepted | UI and validation can overlap after contracts stabilize |
| 5 | Narrow evidence → diagnosis → intervention → reassessment vertical slice | Rebuildable state, useful explanations, adequate fresh content | Content and model work in parallel after schema contract |
| 6 | Shadow, controlled pilot, delayed follow-up, calibrated claims | Gate B criteria; expand only what worked | Human retention intervals cannot be compressed |

Do not promise calendar dates before knowing implementation capacity and rollout traffic. Engineering can parallelize substantially; compatibility cutovers, realistic browser observation and actual delayed reassessment remain genuine critical-path time. Release by evidence gates, not a date that pressures teams to call pending evidence “done.”

## 13. Release evidence: test the failure boundaries, not only the features

### The regression method

For each audit reproduction, retain a test that **fails on the audited revision with the desired invariant**, then passes after the focused fix. The previous “passing reproduction” tests often asserted defective behavior; invert/rewrite those assertions rather than relabeling them as proof of repair.

Use controlled clocks, delayed promises, message-drop/reorder injection and restart harnesses. Avoid sleeps as the core proof. Add a bounded generated/model-based sequence suite for membership and hand state; record failing seeds for replay. Fix misleading harness failures/warnings so the release evidence is intelligible.

### Acceptance pack

| Layer | Required adversarial coverage | Observable oracle |
|---|---|---|
| Poker | Short blinds; short raises/reopening; side pots; ties/odd chips; refunds; all-in ordering; seated ownership changes | Legal actions match policy, chip totals conserved, eligible winners correct |
| Commands | Duplicate click; duplicate delivery; request lost; ACK lost; reconnect after effect; stale hand/decision/seat generation | One effect, honest pending/unknown state, authoritative convergence |
| Membership | Host gone; competing invites/guests; queue-to-invite races; cancellation-to-deal race; late release callbacks | One active membership and bounded recovery; no zombie activated table |
| Recovery | Zero/one/two sockets; restart before/after recorded grace; repeated restarts; late alarms; action at boundary | Stable deadlines, policy-correct terminal reason, no accidental rating winner |
| Presentation | All-in from each street; last match hand; reduced motion; late frames; reload/background/laptop sleep | No mixed hand identities; result accessible; current decision never hidden by obsolete animation |
| Settlement | Missing/gapped/duplicate hands; corrupt/missing luck; wrong participant; early terminal; queue duplicate/reorder/DLQ; two concurrent settlements | No certificate for invalid evidence; one valid finalization; recoverable pending/quarantine |
| Rating/history | Out-of-order completion/application; stale optimistic versions; rating service unavailable; delayed older accuracy record | Correct documented trend/window; no silent default identity; preserved uncertainty |
| Learning sync | Provisional/final overlap; both device arrival orders; first pull failure; refresh; auth switch; quota; size cap; deletion then stale device | Latest intended work acknowledged or recoverable; no false saved state or resurrected delete |
| Learning model | Duplicate/superseded evidence; invalid rubric; assistance; repeated family; clock uncertainty; exhausted review bank | Rebuildable honest projection and explanation; no fake retention |
| Privacy / UX | Cross-account reads/writes; unrevealed cards; logs; keyboard repeat/IME; focus; contrast; narrow layout | Account isolation and redaction preserved; supported controls accessible |

### Browser proof must measure the whole user-visible path

Test the actual supported desktop browsers, including Safari/WebKit behavior if Safari is supported, on laptop-size and constrained CPU/network profiles. Record versions, hardware class, geography/RTT, packet-loss profile and sample count. Include two-player/two-device sessions; two tabs alone do not reproduce all device and storage conditions.

Measure `intent → sent → server accepted → state frame received → matching state rendered`. Use monotonic timestamps for same-device spans. Do not subtract wall clocks across client/server without a synchronization/error model. Capture decision IDs/state versions to prove the rendered state is the acknowledged one.

Starting **proposed budgets**, not observations or launch claims:

- Local visual pending feedback: p95 within 100 ms on the supported laptop profile.
- Frame received → correct state rendered: p95 within 50 ms, with p99 and long tasks reported.
- Preserve the existing under-150 kB gzip entry budget; lazy-load heavier review/model surfaces.
- End-to-end network/reconnect/settlement objectives: set after baseline measurements for an explicit network/geography/load envelope. A global number without an envelope is not meaningful.

Make correctness zero-tolerance in the agreed test matrix. For performance, record distributions and investigate tails; do not hide p99 failures in a median. A minimum sample/coverage requirement and a load model must be set before the canary, not reverse-engineered from whatever happened to pass.

### Gate A release packet

One indexed packet must contain: commit and schema/protocol versions; F01–F10 regression mapping; adjacent findings disposition; Worker/SQL/fault-harness results; browser recordings and timing distributions; redaction/account-isolation checks; legacy migration results; pending-settlement and sync-recovery runbook drills; known limitations; canary/rollback approvals.

Run repository typechecks, Worker typechecks, lint, unit/integration tests and production build using the documented scripts, plus the new SQL and browser acceptance paths. No implementation is certified here: these are future release requirements, not checks performed by this planning session.

## 14. Operate the promises: observability and recovery

### Instrument invariants rather than raw activity

| Area | Metric / denominator | Action it should enable |
|---|---|---|
| Ownership | Conflicting activation attempts, stale releases rejected, stranded reservations past bound | Find lifecycle defects; drain/cancel safely |
| Commands | Accepted/rejected/unknown per command kind; pending age; retry/dedupe rate | Distinguish poor connectivity from missing acknowledgement logic |
| Recovery | Reconcile reasons, remaining grace, terminal classifications after restore | Detect accidental forfeits and repeated grace extension |
| Rendering | Intent-to-render distributions by browser/network; old-animation catch-up count | Identify perceived lag and hidden-turn regressions |
| Rated integrity | Pending age; missing evidence count; verification failure reasons; certificate-to-settlement lag; DLQ age | Pause finalization, repair evidence and redrive without duplicates |
| Saves | Local-to-ack lag; dirty age; conflict rate; initial-reconcile failures; blocked records; unknown sign-out | Detect silent-loss risk before a user discovers it |
| Evidence | Source-valid/eligible/evaluated coverage; excluded reasons; projector lag/version | Prevent misleading aggregate confidence |
| Learning | Fresh-case supply; content-limited recommendations; transfer/retention by exposure; intervention adherence | Separate content shortage, weak diagnosis and ineffective practice |

Log correlation IDs, protocol/model versions, terminal reasons and coarse state transitions. Do not log credentials, full notes, unrevealed cards, unrestricted action payloads or full learner responses. Use restricted pseudonymous identifiers; keep IDs out of high-cardinality metric labels and place them in access-controlled traces instead. Set retention/access/deletion policy deliberately.

### Runbooks required before wider release

- **Stranded player:** inspect current membership generation; reconcile/cancel only the matching claim; never blindly wipe an account’s active pointer.
- **Pending match:** identify archive, verification or settlement stage; repair/redrive idempotently; preserve the visible pending status.
- **Quarantine:** inspect reason/version/evidence; no manual `verified=true` shortcut; repair through a validated re-verification path.
- **Sync incident:** preserve account-scoped local/export copies; stop destructive actions; reconcile exact versions and tombstones; do not ask users to clear browser storage as a first response.
- **Bad learner projection:** freeze affected recommendations, keep evidence, rebuild from the last good projector/policy, explain changed claims.

Use synthetic test accounts and purpose-built canaries for production exercises. Privileged fault injection and real-user data inspection require explicit operational authorization; the plan does not grant it.

## 15. Migration, rollout and rollback without reopening the holes

### M1. Establish a compatibility floor

Inventory current deployed Worker/client/protocol versions and actual Supabase migrations before implementation cutover. The prior audit could not establish production database parity. List every writer: current client, cached older client, Worker outbox, verifier, SQL function and maintenance task.

Support at least the needed upgrade window with additive fields and explicit capability negotiation. If a stale client cannot safely write the new sync protocol or seat commands, make it read-only for that operation and explain refresh/reconciliation. Do not silently discard pending offline work on forced refresh. Resume export/recovery before upgrade when needed.

### M2. Expand, verify, cut over, then contract

1. **Additive preparation:** certificate/revision/evidence structures, indexes, observability and backup/restore rehearsal. Keep old source data readable.
2. **Reader compatibility:** deploy code that understands old/new state and preserves unknown fields where required. Exercise rolling Worker/client versions.
3. **Shadow verification/projection:** measure differences, missing evidence and cost without changing ratings or learner claims.
4. **Protected writer cutover:** require revisions/certificates atomically at the persistence boundary. Ensure old writers cannot bypass. Use a planned maintenance/limited-write window if dual compatibility cannot be made safe.
5. **Historical reconciliation:** classify legacy records, migrate idempotently in bounded batches, compare counts/digests/eligibility, retain reversible mappings and deletion semantics.
6. **Contract cleanup:** remove old paths only after traffic/protocol telemetry shows safe retirement and recovery has been rehearsed.

If compatibility requires dual-writing, designate one authoritative store and reconcile persistently. Do not add two independently successful writes and call it safe; partial dual-write failure needs an outbox/transactional recovery story.

### M3. Rollout by capability, not a single “new UI” flag

Use the existing configuration mechanism where practical; choose a flag service only if there is a real operational need. Proposed controls: new table presentation, new membership protocol admission, rated matchmaking admission, rating finalization pause, account-sync protocol admission, learner projections and recommendation exposure.

Safety invariants are not optional experiments. **Do not A/B-test verified versus unverified settlement, correct versus incorrect betting rules, or lossless versus unsafe saves.** A kill switch pauses a capability; it does not restore a known corruption path.

Rollout cohorts:

1. Automated staging faults and controlled human/agent acceptance.
2. Internal/synthetic accounts against the production-compatible environment.
3. Small opt-in beta, all safety gates on, clear limitations.
4. Gradually expanded ordinary users after minimum traffic/scenario coverage and an agreed observation window.
5. Separate adaptive-learning pilot after evidence/content readiness; marketing claims only after delayed outcome evaluation.

Do not “graduate” a quiet canary with no meaningful events. Review actual volume of restarts, overlapping saves, early terminals and late archives, plus deliberately exercised cases.

### M4. Rollback stops harm; it does not undo history

- Presentation regression: fall back to a previously validated compatible view; keep protocol and engine fixes.
- Ownership/recovery uncertainty: stop admitting new affected tables and drain/reconcile existing ones; do not revoke membership randomly.
- Verification overload: pause new rated admissions if backlog threatens the agreed bound; keep existing matches’ evidence durable and ratings pending.
- Settlement failure: stop finalization; do not allow the old ungated function as a fallback.
- Sync failure: preserve local/account data, disable unsafe destructive actions and offer export; do not revert to silent last-write-wins.
- Model failure: disable recommendations or fall back to curriculum order with honest labels; never delete evidence to improve apparent metrics.

Retain schema/backward compatibility for the rollback window. Restore snapshots only with a reconciliation plan; blindly restoring a database can lose valid later matches, recreate deleted personal data and duplicate already-applied side effects.

### Immediate stop conditions

Any reproduced chip-conservation failure, card/privacy leak, invalid rated finalization, silent acknowledged-data loss, duplicate active membership or unexpected mutual-absence winner blocks expansion and triggers incident handling. Significant latency, conflict, pending-age or content-exhaustion regressions hold expansion while investigated under agreed thresholds. “No errors in the build” never overrides a user-visible invariant failure.

## 16. Decision register: explicit choices and recommended defaults

These decisions belong in the implementation kickoff. They are not requests to stop this planning task and wait.

| Decision | Recommended default | Reason / cost |
|---|---|---|
| Scope of “redesign shipped” | Gate A first; adaptive pilot separately labeled | Preserves momentum without pretending personalization is proven |
| Open invite versus active claim | Unfilled invite remains discoverable; activation must acquire fenced active ownership | Preserves existing ability to queue elsewhere while preventing double play |
| Waiting host policy | Visible bounded waiting plus authoritative pre-deal cancellation | Guest never depends on a 24-hour link expiry for recovery |
| Both-absent/infrastructure outcome | Preserve documented abandonment/void semantics; log distinct causes; review abuse separately | Avoid accidental winners without hiding the policy tradeoff |
| Presentation synchronization | Server bounded schedule, late-client catch-up, durable last-hand result | Smooth normal play without client veto over multiplayer progress |
| Rating-history order | Keep application-order rating; sum actual deltas for played-time trends | Minimal defensible repair; chronological replay remains a separate product choice |
| Legacy rating assurance | Read-only stronger audit, cutover for new matches, explicit legacy status | No unsupported claim of historical corruption or universal verification |
| Same-note conflict | Preserve both versions, user resolution | Slight friction is better than irreversible silent loss |
| Unsaved sign-out | Wait/retry, export, or explicit discard; clear local data on completed shared-device sign-out | Balances privacy and durability; no misleading automatic success |
| First learner model | Small rule-based skill projections, evidence counts and uncertainty | Explainable, testable, low data requirement |
| New assessment content | Authored/validated families with reserved delayed holdouts | Assessment validity matters more than generation volume |
| Success criterion | Fresh delayed unaided transfer, with honest coverage and attrition | Measures the intended learning outcome, not proxy engagement |

### What to consciously defer

- A universal skill/ability score, or a public learning-ability leaderboard.
- A full rewrite of the engine, transport, storage or curriculum.
- Unrestricted LLM-generated assessment, opaque model diagnoses and automated “certification.”
- Chronological recomputation of all ratings unless the historical audit/policy requires it.
- Rated six-max or six-max accuracy based on a heads-up grading model.
- Broad claims of anti-collusion, multi-account or real-time-assistance protection. This audit did not establish them; a serious public competitive expansion needs a separately scoped abuse/threat review.
- Promises about finance/investing performance beyond what fresh transfer tasks actually test.

### The finish line

**Gate A is done when a skeptical reviewer can interrupt the game, the network, the archive and the save process without producing a lie about what happened or what was saved.**

**Gate B is done when DeltaDeck can show why it chose a lesson, what changed after the intervention, and whether that change survives a new problem after a real delay.**

That is the path from a redesigned interface to a credible learning product: not more impressive scores, but stronger promises backed by evidence.

## 17. Source map and verification limits

Source files below are pinned to the audited revision. They establish the current architecture and remediation seams; proposed mechanisms in this document are not claimed to exist yet. The original consolidated audit and technical appendix supplied the reproduction evidence; targeted source inspection in this session checked the principal boundaries. No new reproduction suite or application browser test was run for this planning task.

- **S1 — Table lifecycle, commands, restoration, archiving:** [worker/src/table.ts](https://github.com/Backpacked333/Deltadeck/blob/9de1fd868f55358bd8e0926487750673752a914a/worker/src/table.ts).
- **S2 — Lobby and live-games ownership:** [worker/src/lobby.ts](https://github.com/Backpacked333/Deltadeck/blob/9de1fd868f55358bd8e0926487750673752a914a/worker/src/lobby.ts), [worker/src/games.ts](https://github.com/Backpacked333/Deltadeck/blob/9de1fd868f55358bd8e0926487750673752a914a/worker/src/games.ts).
- **S3 — Deadlines and live protocol:** [worker/src/deadlines.ts](https://github.com/Backpacked333/Deltadeck/blob/9de1fd868f55358bd8e0926487750673752a914a/worker/src/deadlines.ts), [src/shared/protocol.ts](https://github.com/Backpacked333/Deltadeck/blob/9de1fd868f55358bd8e0926487750673752a914a/src/shared/protocol.ts).
- **S4 — Legal actions and multiplayer hand setup:** [src/engine/hand.ts](https://github.com/Backpacked333/Deltadeck/blob/9de1fd868f55358bd8e0926487750673752a914a/src/engine/hand.ts), [worker/src/controller.ts](https://github.com/Backpacked333/Deltadeck/blob/9de1fd868f55358bd8e0926487750673752a914a/worker/src/controller.ts).
- **S5 — Reveal timing:** [src/state/runout.ts](https://github.com/Backpacked333/Deltadeck/blob/9de1fd868f55358bd8e0926487750673752a914a/src/state/runout.ts), table next-hand lifecycle in S1.
- **S6 — Client control and six-max UI:** [src/net/SixTable.tsx](https://github.com/Backpacked333/Deltadeck/blob/9de1fd868f55358bd8e0926487750673752a914a/src/net/SixTable.tsx), [src/net/client.ts](https://github.com/Backpacked333/Deltadeck/blob/9de1fd868f55358bd8e0926487750673752a914a/src/net/client.ts), [src/net/useTable.ts](https://github.com/Backpacked333/Deltadeck/blob/9de1fd868f55358bd8e0926487750673752a914a/src/net/useTable.ts).
- **S7 — Replay verification and adjustment:** [worker/src/verify.ts](https://github.com/Backpacked333/Deltadeck/blob/9de1fd868f55358bd8e0926487750673752a914a/worker/src/verify.ts), [src/engine/luck.ts](https://github.com/Backpacked333/Deltadeck/blob/9de1fd868f55358bd8e0926487750673752a914a/src/engine/luck.ts).
- **S8 — Rated rules and rating application:** [worker/src/rated.ts](https://github.com/Backpacked333/Deltadeck/blob/9de1fd868f55358bd8e0926487750673752a914a/worker/src/rated.ts), [worker/src/rating.ts](https://github.com/Backpacked333/Deltadeck/blob/9de1fd868f55358bd8e0926487750673752a914a/worker/src/rating.ts).
- **S9 — Rating persistence and ladder/history semantics:** [supabase/migrations/20261010080000_ratings.sql](https://github.com/Backpacked333/Deltadeck/blob/9de1fd868f55358bd8e0926487750673752a914a/supabase/migrations/20261010080000_ratings.sql), [supabase/migrations/20261010090000_ladder.sql](https://github.com/Backpacked333/Deltadeck/blob/9de1fd868f55358bd8e0926487750673752a914a/supabase/migrations/20261010090000_ladder.sql). Rating gate tests must inspect the defining `apply_rating` migration and every subsequent replacement.
- **S10 — Existing rating model:** [src/rating/glicko2.ts](https://github.com/Backpacked333/Deltadeck/blob/9de1fd868f55358bd8e0926487750673752a914a/src/rating/glicko2.ts).
- **S11 — Practice/curriculum synchronization:** [src/net/sync.ts](https://github.com/Backpacked333/Deltadeck/blob/9de1fd868f55358bd8e0926487750673752a914a/src/net/sync.ts), [supabase/migrations/20261011100000_practice_history.sql](https://github.com/Backpacked333/Deltadeck/blob/9de1fd868f55358bd8e0926487750673752a914a/supabase/migrations/20261011100000_practice_history.sql).
- **S12 — Sign-out:** [src/net/AccountPage.tsx](https://github.com/Backpacked333/Deltadeck/blob/9de1fd868f55358bd8e0926487750673752a914a/src/net/AccountPage.tsx).
- **S13 — Learning evidence and evaluation:** [src/curriculum/core/types.ts](https://github.com/Backpacked333/Deltadeck/blob/9de1fd868f55358bd8e0926487750673752a914a/src/curriculum/core/types.ts), [src/curriculum/core/assessment.ts](https://github.com/Backpacked333/Deltadeck/blob/9de1fd868f55358bd8e0926487750673752a914a/src/curriculum/core/assessment.ts).
- **S14 — Current summaries and EV coverage:** [src/curriculum/core/summary.ts](https://github.com/Backpacked333/Deltadeck/blob/9de1fd868f55358bd8e0926487750673752a914a/src/curriculum/core/summary.ts), [src/lib/practiceStats.ts](https://github.com/Backpacked333/Deltadeck/blob/9de1fd868f55358bd8e0926487750673752a914a/src/lib/practiceStats.ts).
- **S15 — Curriculum content and current deployment configuration:** [src/curriculum/content/foundations.ts](https://github.com/Backpacked333/Deltadeck/blob/9de1fd868f55358bd8e0926487750673752a914a/src/curriculum/content/foundations.ts), [wrangler.jsonc](https://github.com/Backpacked333/Deltadeck/blob/9de1fd868f55358bd8e0926487750673752a914a/wrangler.jsonc).

Prepared 12 October 2026. Planning session: https://app.devin.ai/sessions/3fa004bf5e004d3dbd025933615dfc69.
