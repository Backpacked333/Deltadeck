# Tickets: Step 7, Phase 1, Phase 2

Written 2026-10-09 by Staff Engineer / EM (Prompt 2). No product code changed. Supersedes the status.md task "turn the 7 migration steps into tickets".

Inputs read: `.10x/status.md`; ADR `.10x/decisions/architect/multiplayer-platform.md` (§Migration path, §Out of scope, §Risks, §Durable Objects, §Data model, §Randomness, §Post-hand grading, §Failure modes); the five PM files; SDE log; QA log. **Two inputs are not on this branch or on `main`:** `.10x/prompts.md` exists only on the unmerged branch `claude/amazing-ride-4vip4x` (`a71a0bb`), and the Prompt 1 deploy verification (`.10x/reviews/2026-10-09-deploy-verification.md`) only on `claude/zen-darwin-0t5q1p` (`c5ccdd0`). Both were read from those branches with `git show`. Nothing here depends on them being merged: every ticket is self-contained.

## Summary

- **Total: 49 tickets, 134 half-days of builder effort, about 90 session-hours at the measured pace.** By phase: Step 7 is 11 tickets (23 hd, about 14 h); Phase 1 is 23 tickets (68 hd, about 45 h); Phase 2 is 15 tickets (43 hd, about 30 h). One more ticket (P2-16, 4 hd) is listed and recommended for cutting. Phase 1 comes out at 34 builder-days against the roadmap's "3–4 weeks", because the roadmap row predates this inventory. Step 7 comes out at 11.5 builder-days against the ADR's 1, because the ADR packed Step 7 into day 15.
- **Earliest ladder date at the calibrated pace: 2026-10-13. Planning date: 2026-10-19.** The ladder's critical path is 15 tickets and 29.7 session-hours. The earliest date assumes the 2026-10-08 pace (12.5 session-hours in one calendar day), two parallel sessions, and user gates answered the same day. The planning date assumes 6 session-hours a day, 20% for folding in review findings, and one calendar day per user gate on the path (the two Phase 0 user actions asked on 2026-10-08 were still open on 10-09). Arithmetic: §Calibration. Either way, the calendar is set by user gates, not by session time.
- **Risk 1: the duplicate format leaks segment 2 (finding; blocks P1-02 until Q1).** Segment-2 hand _i_ is, by the ADR's own rule, segment-1 deck _i_ with the button flipped. `dealSlots` deals relative to the button, so each player receives the other's segment-1 hole cards under the same board. The live table already lists every finished hand of the match, with your own cards and the board ("Review hand n"). Anyone who looks back, or writes 20 hands on paper, knows the opponent's cards and the runout of every segment-2 hand that reached a flop. A fresh commitment secret does not help: the index mapping is public by construction.
- **Risk 2: user-gated steps dominate.** Production still has 0 users, and neither the archive nor `SUPABASE_SECRET_KEY` is proven (Prompt 1). The Step 7 queues must be created in your Cloudflare account before S7-03 merges. The two Phase 0 user actions asked on 2026-10-08 (secret key, first sign-in) were still open on 10-09.
- **Risk 3: accuracy validity and one hot file.** The population opponent model (P1-08, confidence L) may fail the sanity ordering or the Spearman > 0.4 target. Separately, `worker/src/table.ts` (896 lines) sits on 9 of the 15 critical-path tickets, which serialises the worker lane. Parallel sessions only help off that lane (§Critical path).

## How a session uses this file

1. Pick the first ticket in §Critical path whose dependencies are merged, or any ticket in a free lane. Prepend the operating contract from `.10x/prompts.md` §0. Since 2026-10-10 that file lives on `main` and covers only the open tickets; the older version on `claude/amazing-ride-4vip4x` is superseded.
2. **The acceptance tests are the definition of done.** Write each one red first under the exact file and test name given, then make it green. Extra tests are welcome. Renaming a listed test needs a line in the SDE log.
3. **Respect the cut line.** If time runs out, ship what is above it, green, and list the rest as next steps.
4. **Fold in reviews first.** Before starting any S7 or P1 ticket, read the security and DBA reviews (Prompts 3 and 4) and apply anything they attached to that ticket id (§Review fold-in).
5. Repo conventions that make the lanes conflict-free:
   - **New SQL tests go in their own file.** Each goes in `supabase/tests/<feature>.test.ts`, using the shared harness that S7-03 extracts to `supabase/tests/harness.ts`. `migrations.test.ts` stays as is.
   - **`record_match`, `ladder()` and the queue dispatch in `worker/src/index.ts` are redefined whole.** That is `create or replace` for the two SQL functions and a full rewrite of the dispatch block. Tickets that touch the same one run in the order given and start from the latest merged version.
   - **Migrations are timestamped after the latest merged one, and each is independent of other in-flight tickets.** Apply them to production in timestamp order, only with your go-ahead.
   - **Close-out edits are append-only.** In `.10x/status.md` and `.10x/handoff.md`, tick and append only; never reflow other sections, so parallel close-outs merge cleanly.

## Calibration

| Item                                                             | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ADR plan for Steps 1–6                                           | 14 working days (days 1–14)                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Actual (commit timestamps on `refs/pull/8/head`, UTC 2026-10-08) | ADR 08:29 → Step 1 08:59 → Step 2 13:47 → Step 3 16:14 → Step 4 16:42 → QA 17:16 → Step 5 17:57 → Step 6 18:18 → post-merge engine fix 20:58. **9.8 h** to Step 6, **12.5 h** including QA and the fix                                                                                                                                                                                                                                                                         |
| Ratio                                                            | 12.5 h / 14 ADR-days = **0.89 h per ADR-day = 0.45 h per half-day** (about 1:9 against 8-hour days)                                                                                                                                                                                                                                                                                                                                                                            |
| Why the multipliers                                              | Phase 0 ran on a pre-verified ADR (spikes done). Calibrated hours = half-days × 0.45 h × **1.0 (H) / 1.5 (M) / 2.0 (L)**                                                                                                                                                                                                                                                                                                                                                       |
| What the ratio does not cover                                    | User gates. The secret key (asked 10-08 17:57) and the first sign-in (asked 10-08 13:47) were still open on 10-09 (0 auth users). **Plan one calendar day per user gate on the path.**                                                                                                                                                                                                                                                                                         |
| Ladder date arithmetic                                           | Critical path 29.7 h. **Earliest:** at 12.5 h/day from 2026-10-10 it is 2.4 days → done 10-12; S7-11 and P1-22 production proofs → **10-13**. **Planning:** 29.7 h × 1.2 (review fold-ins; the ADR's 3/15 reserve ratio) = 35.6 h at 6 h/day = 6 days → 10-15; + 1 day for the launch proof + 2 days of user-gate latency (U-3, U-4) → **10-18, rounded to 10-19**. One session at a time instead of three lanes: 59.6 h for S7 + P1 → about 10 days at 6 h/day → about 10-22. |
| Caveat                                                           | Commit time marks a session's end, not its start, and the first session's start is unrecorded. Treat the ratio as ±50%. The confidence letters already price Phase 1's missing ADR (P1-00 is the addendum) and the research-like tickets (P1-08 and P2-13 are L).                                                                                                                                                                                                              |

## Traceability: requirement → ticket

✓ = already done in Phase 0 (code is the evidence). "Deferred" = P1/P2 priority in the PM file and outside the roadmap's Phase 1–2, so not ticketed (not a gap).

| Source                    | Requirement                                                                                                                                                                                                  | Ticket(s)                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| PM platform P0-1          | Accounts: email + OAuth, username                                                                                                                                                                            | ✓                                                                                                                                  |
| PM platform P0-1          | Avatar, country, "studying / work" shown on profile                                                                                                                                                          | P1-15                                                                                                                              |
| PM platform P0-2          | N-player server engine, positions, side pots, CSPRNG, no foreign hole cards or deck                                                                                                                          | ✓ (engine N=2..6, `worker/src/shuffle.ts`, `src/engine/redact.ts`); rated frames P1-03; 6-max gate P2-01                           |
| PM platform P0-2          | Sit-out                                                                                                                                                                                                      | P2-04                                                                                                                              |
| PM platform P0-3          | WebSockets, resync, per-action ack                                                                                                                                                                           | ✓                                                                                                                                  |
| PM platform P0-3          | Action-to-render p95 < 150 ms                                                                                                                                                                                | S7-05 (measure), P2-11 (six seats)                                                                                                 |
| PM platform P0-4          | Lobby: Play rated 1v1 / 6-max / Practice vs Atlas                                                                                                                                                            | P1-01, P2-08, P2-13; Atlas ✓                                                                                                       |
| PM platform P0-5          | Rating-window queue that widens; bail-out                                                                                                                                                                    | P1-13; bail-out ✓                                                                                                                  |
| PM platform P0-6          | Table UI reuse, seats generalised to N, opponent avatar, turn timer and bank                                                                                                                                 | ✓ HU; N seats P2-05, P2-06                                                                                                         |
| PM platform P0-7          | Every hand persisted                                                                                                                                                                                         | ✓ (`record_hand`); proof S7-11                                                                                                     |
| PM platform P0-7          | Replayable in Hand Review, lab unlocked after                                                                                                                                                                | P1-05, P1-06                                                                                                                       |
| PM platform P0-8          | Postgres source of truth                                                                                                                                                                                     | ✓                                                                                                                                  |
| PM platform P0-8          | `SyncAdapter` Atlas sync                                                                                                                                                                                     | Deferred (P2)                                                                                                                      |
| PM platform P0-9          | Rate limits                                                                                                                                                                                                  | S7-02                                                                                                                              |
| PM platform P0-9          | One table per account; timers; auto-fold                                                                                                                                                                     | ✓                                                                                                                                  |
| PM platform P0-9          | Abandonment penalties                                                                                                                                                                                        | P1-12, P1-14, P1-18                                                                                                                |
| PM platform P0-10         | Review → lesson loop; each unit ends with "Play a rated match"                                                                                                                                               | P1-19, P1-20                                                                                                                       |
| PM platform P1            | Spectating, preset chat, region selection; "notify me when someone queues"                                                                                                                                   | Deferred                                                                                                                           |
| PM platform               | ToS, play money, 18+, no "cash" wording                                                                                                                                                                      | S7-10                                                                                                                              |
| HU duplicate format       | 2 segments × 20; segment 2 replays decks with seats swapped                                                                                                                                                  | P1-01 + P1-02 (variant per Q1)                                                                                                     |
| HU duplicate format       | Stacks reset to 100 bb; blinds 1/2 (= 10/20 chips)                                                                                                                                                           | ✓ (`stackPolicy` reset; R-10)                                                                                                      |
| HU duplicate format       | Result = net bb over both segments; ±2 bb draw                                                                                                                                                               | P1-01 (R-8)                                                                                                                        |
| HU duplicate format       | 20 s + 60 s bank **per segment**; auto-fold or check; visible clock                                                                                                                                          | P1-01 (bank per match today, R-11)                                                                                                 |
| HU duplicate format       | No lab, read-guess off during the match; lab and grades in review after                                                                                                                                      | P1-03, P1-06                                                                                                                       |
| HU duplicate format       | 60 s reconnect grace, then auto-fold; 3 timeouts = forfeit; abandonment = loss                                                                                                                               | P1-01 (Q2), P1-12                                                                                                                  |
| HU duplicate format       | Match lengths 10/20/40                                                                                                                                                                                       | Deferred (P1)                                                                                                                      |
| HU duplicate stories      | Understand duplicate; end screen with bb, rating change, accuracy, swings; compare on same deck; rematch                                                                                                     | P1-01 copy, P1-04, P1-12, P1-20, P1-06, P1-04                                                                                      |
| HU duplicate AC1–AC7      | Card-for-card seg 2; illegal actions rejected; no hole cards or deck before showdown; match produces result + grades + rating; compare view; lab not rendered or shipped; Playwright gates on the live table | P1-02; ✓ + P1-03; P1-03; P1-01, P1-09, P1-12; P1-06; P1-03; P1-07                                                                  |
| Rating                    | Glicko-2 per format, never merged                                                                                                                                                                            | P1-11, P1-12, P2-14                                                                                                                |
| Rating                    | HU input W/D/L                                                                                                                                                                                               | P1-12                                                                                                                              |
| Rating                    | Margin-scaled score                                                                                                                                                                                          | Deferred (P1)                                                                                                                      |
| Rating                    | 6-max luck-adjusted pairwise input                                                                                                                                                                           | P2-12, P2-14                                                                                                                       |
| Rating                    | Rating ± RD; provisional until RD < 100 **and** ≥ 20 matches                                                                                                                                                 | P1-12, P1-14, P1-15                                                                                                                |
| Rating                    | Ladder eligibility (not provisional, match in 30 d, abandonment < 10%)                                                                                                                                       | P1-14                                                                                                                              |
| Accuracy                  | Server-side after the hand; population model; exact label                                                                                                                                                    | P1-08, P1-09, P1-10                                                                                                                |
| Accuracy                  | HU fully graded; 6-max only when heads-up at the decision                                                                                                                                                    | P1-09, P2-09                                                                                                                       |
| Accuracy                  | Rolling 500, distribution, luck-vs-skill chart                                                                                                                                                               | P1-10                                                                                                                              |
| Rating P1                 | Quant Score; ladder filters                                                                                                                                                                                  | Deferred (P1)                                                                                                                      |
| Leaderboard               | Per format, all-time and this month, columns, ≥ 20 matches, "X matches to go"                                                                                                                                | P1-14                                                                                                                              |
| Public profile            | URL, numbers, rating graph, last 20 matches with review links, shown cards only                                                                                                                              | P1-15                                                                                                                              |
| Public profile            | OG share card; Method page                                                                                                                                                                                   | P1-16                                                                                                                              |
| Integrity v1              | Lab as RTA: no analysis data, lab hidden, `?seed`/`?motion` ignored on rated                                                                                                                                 | P1-03                                                                                                                              |
| Integrity v1              | Log per-action decision times                                                                                                                                                                                | ✓ (`HandRecordV1.actions[].decisionMs`); disclosure S7-10; visibility Q5                                                           |
| Integrity v1              | Randomised arena seating within band                                                                                                                                                                         | P2-13                                                                                                                              |
| Integrity v1              | ≤ 2 pairings per pair per day                                                                                                                                                                                | ✓ casual; rated and rematch P1-13, P1-04                                                                                           |
| Integrity v1              | Email verification for rated                                                                                                                                                                                 | P1-01                                                                                                                              |
| Integrity v1              | Rated tables human-only                                                                                                                                                                                      | P2-07, P2-13                                                                                                                       |
| Integrity v1              | Signed hand-history ids                                                                                                                                                                                      | R-6 (interpreted; signature deferred to the P2 JSON API)                                                                           |
| Integrity v1              | Review shows only cards shown at showdown                                                                                                                                                                    | ✓; archive path P1-05                                                                                                              |
| Integrity v1              | CSPRNG + per-hand commitment                                                                                                                                                                                 | ✓                                                                                                                                  |
| Integrity v1              | Server-side verification                                                                                                                                                                                     | S7-03                                                                                                                              |
| Integrity v1              | Public permanent hand histories (ToS)                                                                                                                                                                        | S7-10                                                                                                                              |
| Integrity v1              | Fair Play page                                                                                                                                                                                               | S7-10, P1-22                                                                                                                       |
| Integrity v1              | Abandonment > 10% removes eligibility                                                                                                                                                                        | P1-14                                                                                                                              |
| Integrity v1              | Manual sanctions, logged, one appeal, no auto-ban                                                                                                                                                            | P1-18                                                                                                                              |
| Integrity v1              | One-click report from review                                                                                                                                                                                 | P1-17                                                                                                                              |
| Integrity recruiter P1/P2 | Verified badge; public JSON API                                                                                                                                                                              | Deferred (metric computed without badge: R-18)                                                                                     |
| 6-max                     | 6 seats, 100 bb, rebuy when below; positions; dead-button rule                                                                                                                                               | P2-02, P2-03                                                                                                                       |
| 6-max                     | Side pots, award order, odd chip                                                                                                                                                                             | ✓ engine; gate P2-01                                                                                                               |
| 6-max                     | Clock 20 s + 30 s per orbit; sit-out after 2; removal after 3 orbits; 60 s reconnect                                                                                                                         | P2-04                                                                                                                              |
| 6-max                     | Table list; join next hand; quick-sit                                                                                                                                                                        | P2-08, P2-03                                                                                                                       |
| 6-max                     | Atlas bots on casual, labelled                                                                                                                                                                               | P2-07                                                                                                                              |
| 6-max                     | Arena: 60-min windows, announce, seat by band, rebalance                                                                                                                                                     | P2-13 (email = cut line, R-19)                                                                                                     |
| 6-max quality             | Same art, motion, keyboard; six seats; side-pot animation; phone legibility                                                                                                                                  | P2-05, P2-06                                                                                                                       |
| 6-max quality             | p95 < 150 ms; no long frames in a 3-way all-in                                                                                                                                                               | P2-06, P2-11                                                                                                                       |
| 6-max quality             | Review with lab per seat                                                                                                                                                                                     | P2-09                                                                                                                              |
| 6-max quality             | Safari background tabs                                                                                                                                                                                       | P2-11                                                                                                                              |
| 6-max                     | VPIP, PFR, aggression, adjusted bb/100 on profile                                                                                                                                                            | P2-10                                                                                                                              |
| 6-max gates               | 100k simulated + first 1,000 human hands with 0 failures; < 4 humans not rated; provisional < 500 hands                                                                                                      | P2-01, P2-11 / P2-13 pre-check, P2-13, P2-14                                                                                       |
| ADR Step 7                | `HAND_QUEUE`, verify consumer, DLQ                                                                                                                                                                           | S7-03                                                                                                                              |
| ADR Step 7                | `bench.test.ts`                                                                                                                                                                                              | S7-06                                                                                                                              |
| ADR Step 7                | `e2e/live.spec.ts` with second webServer                                                                                                                                                                     | ✓ (`playwright.config.ts`); proven in CI by S7-07                                                                                  |
| ADR Step 7                | `typecheck:worker`, `worker:test` in CI                                                                                                                                                                      | ✓                                                                                                                                  |
| ADR Step 7                | `deploy-worker.yml`                                                                                                                                                                                          | Superseded by the amendment; S7-07 adds a read-only deploy check (R-3)                                                             |
| ADR Step 7                | `engine-soak.yml`                                                                                                                                                                                            | S7-07                                                                                                                              |
| ADR Step 7                | Origin allowlist                                                                                                                                                                                             | Dropped per amendment (R-2); fold-in slot on S7-02                                                                                 |
| ADR Step 7                | Workers Logs                                                                                                                                                                                                 | ✓ (`observability.enabled`); alerts S7-04                                                                                          |
| ADR Step 7                | 20-client `smoke-ws.mjs`                                                                                                                                                                                     | S7-08 (target per Q4)                                                                                                              |
| ADR Step 7                | Fair Play stub, ToS copy, README                                                                                                                                                                             | S7-10                                                                                                                              |
| ADR Step 7                | Phase 1 hand-off notes                                                                                                                                                                                       | P1-00                                                                                                                              |
| ADR lifecycle             | `idle` deadline → `deleteAll()` (not built)                                                                                                                                                                  | S7-01                                                                                                                              |
| ADR failure modes         | Invariant halt writes `incidents` (today: `console.error` only, `table.ts:659`)                                                                                                                              | S7-03, S7-04                                                                                                                       |
| ADR failure modes         | Token bucket 20 / 5 s → 4429; > 5 rejections per hand → 4400                                                                                                                                                 | S7-02                                                                                                                              |
| ADR failure modes         | Outbox depth alert                                                                                                                                                                                           | S7-04                                                                                                                              |
| ADR client integration    | `POST /api/telemetry` ack → render (not built)                                                                                                                                                               | S7-05                                                                                                                              |
| ADR client integration    | `#review/<matchId>/<handNo>` from Supabase                                                                                                                                                                   | P1-05                                                                                                                              |
| ADR client integration    | Street-level curriculum links in review (not built)                                                                                                                                                          | P1-19                                                                                                                              |
| ADR decision 1            | Trainer migrates to `src/engine` in Phase 2                                                                                                                                                                  | P2-16 (no PM requirement: recommend cut)                                                                                           |
| Prompts 5–11 extras       | Chaos pass; account match-creation limit and per-IP cap; log-sink test; season simulation; Safari background                                                                                                 | S7-09 (ADR failure-mode table); S7-02 (PM "rate limits"; per-IP is doc-only); S7-04 (non-negotiable on secrets); P1-14 test; P2-11 |

**Gaps this inventory found.** These are requirements that had no owner before now, all ticketed:

- live-table keyboard and sounds (P1-07; deferred in Steps 4 and 5)
- idle cleanup (S7-01)
- incident writes (S7-03)
- ack-latency telemetry and queue-wait recording (S7-05)
- profile fields (P1-15)
- archive review route and curriculum links (P1-05, P1-19)
- arena email infrastructure (cut line, R-19)

**Scope creep check.** Every ticket traces to a row above except two, both justified:

- P2-16 traces only to the ADR, so it is recommended for cutting.
- The harness extraction inside S7-03 is a test refactor that enables parallel lanes (about 0.5 h).

---

## Step 7: hardening, CI, launch (Phase 0 exit)

Order on the worker lane: S7-01 → S7-02 → S7-03 → S7-04 → S7-05. S7-06, S7-07, S7-08 and S7-10 run in parallel lanes. S7-09 follows S7-05 and S7-08. S7-11 is last.

**Status 2026-10-09 (Step 7 build, Prompt 5; details in `.10x/decisions/sde/multiplayer-platform.md` §Step 7).** Built and tested, not deployed:

| Ticket | Status                                                                                                                                                                                                                                                        |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S7-01  | Done (+ invite expiry after 24 h, SR-06)                                                                                                                                                                                                                      |
| S7-02  | Done: per-account budget incl. connects, oversize and illegal-frame closes, `MATCH_CREATES_PER_DAY`, per-address request rate (binding), username cache, client messages, Origin allowlist (requested; supersedes R-2). Not done: SR-10 (UUID-shaped dev ids) |
| S7-03  | Done (outbox-entry producer, verify + DLQ consumers, migration `20261009213919_verify_hand.sql`, applied to production 2026-10-09; SR-09 closed)                                                                                                              |
| S7-04  | Done (`log.ts`, sink test, README §Operations; hands/day via `GET /api/stats`, counted on index `hands_created` since DBA DB-1, applied 2026-10-09). Alerts: saved queries checked weekly (alerting not verified)                                             |
| S7-05  | **Not started** (queue wait and ack-latency telemetry); the smoke measures ack latency locally meanwhile                                                                                                                                                      |
| S7-06  | Done (worst decision 212 ms of 500 over 10 runs)                                                                                                                                                                                                              |
| S7-07  | Done. Evidence: PR #9 `soak` green (seed 37906875949, 100k × N=2..6) and `e2e` live guard `live: 3 passed`; deploy-check runs on the first push to `main`                                                                                                     |
| S7-08  | Done: 500 hands, p95 17 ms, 0 failures (local)                                                                                                                                                                                                                |
| S7-09  | Done: 5 rows VERIFIED, no server bug found                                                                                                                                                                                                                    |
| S7-10  | Done. Report contact (U-6): the interim wording stays ("keep them for the report form that comes with rated play"); an address can replace it in `src/info/contact.ts`                                                                                        |
| S7-11  | Deployed 2026-10-09 (`3cc9bd0`). Verified: deploy matches, queues, endpoints, Origin 403. Open until U-4: ES256 token, an archived match, disjoint `hand_holes`, `verified` hands; smoke p95 waits on Q4                                                      |
| S7-12  | Done                                                                                                                                                                                                                                                          |
| S7-13  | Done 2026-10-10: class 22/23 refusals park after 12 tries with an `archive_parked` incident carrying the call; outages, 401/403 and missing functions never park                                                                                              |

### S7-01 · Finished tables clean up after themselves

- **Goal.** A finished or abandoned table deletes its Durable Object storage once its outbox is empty, as ADR §TableDO lifecycle specifies (the `idle` deadline was never built).
- **User-visible outcome.** Opening an old table link shows "This table has closed" rather than a stale table. No unbounded storage growth.
- **Files.** `worker/src/deadlines.ts` (add `idle` kind, `IDLE_MS = 600_000`), `worker/src/table.ts` (arm `idle` on finish; on fire: if outbox empty → `ctx.storage.deleteAll()` and `deleteAlarm()`, else re-arm), `worker/test/table.test.ts`.
- **Depends on.** Nothing.
- **Estimate.** 1 hd · H (≈ 0.5 session-h).
- **Acceptance tests.**
  - `worker/test/table.test.ts › 10 minutes after match_end with an empty outbox the table holds no storage keys` — the `storage.list()` size is 0 after `elapse(600_000)` and the alarm runs.
  - `worker/test/table.test.ts › cleanup waits for a pending outbox` — with Supabase failing, keys remain; after the archive succeeds and the next idle fire, they are gone.
  - `worker/test/table.test.ts › a socket to a cleaned-up table is refused as closed` — the close reason or liveness is `over` (or an unknown match), and no empty table is created.
- **Riskiest assumption → check.** That `deleteAll()` from inside `alarm()` leaves no re-armed alarm or half-written state. Cheapest check: one `runDurableObjectAlarm` test asserting `getAlarm()` returns null afterwards.
- **Cut line.** None; ship it whole.
- **Review fold-in.** DBA/Security: storage growth (Security item 6).

### S7-02 · Abuse limits on every inbound path

- **Goal.** No single account can flood a table, the lobby, or match creation (PM P0-9 "rate limits"; ADR §TableDO rate limit).
- **User-visible outcome.**
  - Normal play is unaffected.
  - A flooding or tampered client is disconnected with "Too many messages, reconnecting…", reconnects after backoff, and keeps its seat.
  - Invite spam gets "Too many new tables today".
- **Files.**
  - New `worker/src/limits.ts`: pure token bucket, clock from `worker/src/clock.ts`; `FRAMES_PER_WINDOW = 20`, `WINDOW_MS = 5_000`, `ILLEGAL_PER_HAND = 5`, `MATCH_CREATES_PER_DAY = 30`.
  - `worker/src/table.ts`: oversized frame → close 4400 before parse; bucket → 4429; illegal counter per seat per hand → 4400, seat keeps reconnect rights.
  - `worker/src/lobby.ts`: bucket; a `allowCreate(userId)` RPC with a persisted day counter.
  - `worker/src/index.ts`: `POST /api/matches` → 429 + `Retry-After`.
  - `src/shared/protocol.ts`: export `CLOSE_RATE_LIMITED = 4429`, `CLOSE_ABUSE = 4400`.
  - `src/net/client.ts`, `src/net/lobbyClient.ts`, `src/net/LiveTable.tsx`, `src/net/Lobby.tsx`: messages and backoff.
  - New `worker/test/limits.test.ts`.
- **Depends on.** S7-01 (same file, `table.ts`).
- **Estimate.** 3 hd · M (≈ 2.0 h).
- **Acceptance tests.**
  - `worker/test/limits.test.ts › the 21st table frame inside 5 s closes with 4429 and a reconnect resumes the same seat and hand` — `welcome` carries the same `handNo` and the player's own cards.
  - `worker/test/limits.test.ts › 20 frames spread over 5 s and one frame every 300 ms for 60 s are never limited` — no close; every `act` acknowledged.
  - `worker/test/limits.test.ts › a 4,097-byte frame closes with 4400 without being parsed` — close code 4400; no state change; `seq` unchanged.
  - `worker/test/limits.test.ts › the 6th illegal action in one hand closes with 4400 and the counter resets next hand` — 5 illegal in hand 1 plus 5 in hand 2 do not close.
  - `worker/test/limits.test.ts › 21 lobby frames in 5 s close the lobby socket with 4429 and drop its queue row` — `presence.queued` drops by 1.
  - `worker/test/limits.test.ts › POST /api/matches beyond MATCH_CREATES_PER_DAY returns 429 with Retry-After` — the 31st call that UTC day is refused; the next day is allowed.
  - `src/net/client.test.ts › a 4429 close shows "Too many messages" and reconnects after backoff` — status goes `reconnecting` → `open`.
- **Riskiest assumption → check.** That the in-memory bucket is enough even though hibernation drops it. A flooder keeps the object awake, so a reset only happens after about 10 s of silence, which is harmless. Cheapest check: a 15-minute test that sends 21 frames in one tick through `worker/test/helpers.ts` and sees code 4429, proving the harness can observe custom close codes.
- **Cut line.**
  - Must ship: per-socket bucket, oversize close, illegal counter (ADR-specified).
  - Next: the match-creation limit.
  - Documentation only: a per-IP cap. Cloudflare WAF rate-limiting rule as a dashboard step for you; Workers cannot cap sockets per IP natively.
- **Review fold-in.** Security item 6 (DoS) sets the numbers and may add an Origin check (R-2: about 1 h if asked).

### S7-03 · Every archived hand is re-verified off the game path

- **Goal.** Add the `HAND_QUEUE` producer, a verify consumer and a DLQ consumer, as in ADR §Post-hand grading placement. Each archived hand is replayed from the full deck, checked for chip conservation and commitment, and marked `hands.verified`. Failures, and invariant halts, become `incidents` rows; today `table.ts:659` only logs.
- **User-visible outcome.**
  - `hands.verified` turns true within a minute of each archived hand.
  - A broken hand is visible as an incident.
  - Play never waits on verification.
- **Files.**
  - `wrangler.jsonc`: `queues.producers` `HAND_QUEUE` → `quantpoker-hands`; consumers `quantpoker-hands` (`max_batch_size: 1`, `max_retries: 5`, `dead_letter_queue: quantpoker-hands-dlq`) and `quantpoker-hands-dlq` (`max_batch_size: 10`).
  - `worker/src/env.ts`; `worker/worker-configuration.d.ts` (regenerate with `npm run worker:types`).
  - `worker/src/index.ts`: export `queue(batch, env)`, dispatching on `batch.queue`.
  - New `worker/src/verify.ts`: loads `hands` and `hands_private` through PostgREST with the secret key, then runs `replayHand`, `assertInvariants`, `verifyDeal`.
  - `worker/src/supabase.ts`: a `select` helper plus the new RPCs.
  - `worker/src/table.ts`:
    - enqueue `{ matchId, handNo }` **only after `record_hand` returned 2xx** in the outbox flush, so the consumer never races the archive;
    - the halt path queues `record_incident` through the outbox, with the full state there and ids only in logs.
  - New `supabase/migrations/<ts>_verify_hand.sql`: `verify_hand(p)` sets `verified` idempotently; `record_incident(p)`; both `service_role` only.
  - New `supabase/tests/harness.ts`: PGlite setup extracted from `migrations.test.ts`, no behaviour change.
  - New `supabase/tests/verify.test.ts`; new `worker/test/verify.test.ts`.
- **Depends on.** S7-02 (`table.ts` lane).
- **User action before merge.** Create both queues: Cloudflare dashboard → Queues, or `npx wrangler queues create quantpoker-hands` and `npx wrangler queues create quantpoker-hands-dlq`. Without them the production deploy of `main` is expected to fail.
- **Estimate.** 4 hd · M (≈ 2.7 h).
- **Acceptance tests.**
  - `worker/test/verify.test.ts › an archived hand replays to its recorded stacks and commitment and is marked verified` — the `verify_hand` call body has `ok: true`.
  - `worker/test/verify.test.ts › a hand whose private deck was altered is not verified and writes one incident 'verify_failed'` — exactly one `record_incident` call; `verified` stays false.
  - `worker/test/verify.test.ts › a redelivered message writes no second verification or incident` — idempotent.
  - `worker/test/verify.test.ts › a message for a hand not archived yet is retried, not acked` — `message.retry()` is called.
  - `worker/test/verify.test.ts › the DLQ consumer records incident 'dlq' with matchId and handNo and acks` — the whole batch is acked.
  - `worker/test/archive.test.ts › nothing is enqueued while Supabase is down and play continues; the hand is enqueued after the outbox catches up` — producer ordering.
  - `worker/test/table.test.ts › an invariant failure halts the hand, sends match_end engine_fault and queues record_incident with the full state` — and `console` output carries ids only.
  - `supabase/tests/verify.test.ts › verify_hand and record_incident are executable by service_role only` — anon and authenticated get 42501.
  - `supabase/tests/verify.test.ts › verify_hand twice leaves one verified row and no duplicate incident`.
- **Riskiest assumption → check.**
  1. `@cloudflare/vitest-plugin` can drive a queue consumer (`createMessageBatch` plus `getQueueResult` from `cloudflare:test`). Check with a 10-line test before writing the consumer.
  2. The secret key can `select` `hands_private` through PostgREST, given the `revoke all` pattern used in `matches_hands.sql`. Check with a 5-line PGlite test as `service_role`.
  3. Deploy fails without the queues. Check with the Cloudflare docs search (MCP) before asking you.
- **Cut line.** Ship the verify consumer, DLQ and incident writes. Showing "server verified" in the UI is out of scope.
- **Review fold-in.**
  - DBA §3: retry safety of `verify_hand`, grants.
  - Security item 4: the consumer must never expose `hands_private`.

### S7-04 · One structured, card-free log line per event, and a runbook

- **Goal.** Every match lifecycle event and every limit hit is one JSON log line with ids only, so a failed hand can be traced end to end and hands/day read without SQL.
- **User-visible outcome.** None for players. For you: a README "Operations" section with saved Workers Observability queries (hands/day, forfeits, limit hits, outbox depth) and "find a failed hand" steps.
- **Files.**
  - New `worker/src/log.ts`: `logEvent(evt, fields)` with an allowlist of keys: `evt, matchId, handNo, userId, seat, code, reason, depth, attempt, ms`.
  - Replace the six `console.error` sites: `lobby.ts:186`, `supabase.ts:28`, `supabase.ts:35`, `table.ts:369`, `table.ts:659`, `table.ts:716`.
  - Add events `match_start`, `hand_end`, `match_end`, `forfeit`, `no_show`, `limit_hit`, `outbox_retry`, `verify_failed`.
  - New `worker/test/log.test.ts`; `README.md` §Operations.
- **Depends on.** S7-03.
- **Estimate.** 2 hd · M (≈ 1.4 h).
- **Acceptance tests.**
  - `worker/test/log.test.ts › a full 2-hand match plus a forced engine fault logs match_start, hand_end ×2 and match_end, and nothing matches the secret patterns` — the patterns are `/"(cards|deck|secret|holes|leaves)"|bearer\.|eyJ[\w-]{10,}|sb_secret_/` over all captured console output.
  - `worker/test/log.test.ts › every log line is one JSON object whose keys are all in the allowlist`.
  - `worker/test/log.test.ts › a limit close logs one limit_hit with userId and code`.
- **Riskiest assumption → check.** That Workers Observability can alert on a log query such as `outbox_retry depth > 20`. Check the Cloudflare docs search (5 min). If it can't, the alert becomes a weekly saved-query check in the runbook.
- **Cut line.** Ship the log lines, the sink test and the runbook. The alert can be documented as a manual check.
- **Review fold-in.** Security item 3 (logs); `table.ts:659` already found, listed in §Noticed in the handoff.

### S7-05 · Record queue wait and ack latency (two Phase 0 PM metrics)

- **Goal.** Make "median HU matchmaking wait" and "action latency p95 (server ack → render)" measurable. Neither is recorded today: there is no `/api/telemetry` and no wait time.
- **User-visible outcome.** None (instrumentation).
- **Files.**
  - `worker/src/lobby.ts`: pass `queuedMs` per seat into the table's `/init`.
  - `worker/src/table.ts`: `waitMs` in the `record_match` payload.
  - `src/net/client.ts`: stamp each `act`; on the acknowledging `state`, sample on the next `requestAnimationFrame` after the store commits; batch 20 samples.
  - `src/net/api.ts`: `postTelemetry`.
  - `worker/src/index.ts`: `POST /api/telemetry`, bearer auth, at most 50 integers in 0..60000, uses S7-02's limiter.
  - New `supabase/migrations/<ts>_telemetry.sql`: `match_players.queue_wait_ms int`; `ack_samples(id, user_id, at, samples int[])`; RPC `record_ack_samples` (service_role); `record_match` v3 (**`create or replace` from `20261008181317`**) stores `waitMs`.
  - New `supabase/tests/telemetry.test.ts`, `worker/test/telemetry.test.ts`.
- **Depends on.** S7-04 (`table.ts` lane; `record_match` order: S7-05 → P1-01 → P1-04).
- **Estimate.** 3 hd · M (≈ 2.0 h).
- **Acceptance tests.**
  - `src/net/client.test.ts › an act and its acknowledging state record one sample; 20 samples post one batch`.
  - `worker/test/telemetry.test.ts › POST /api/telemetry rejects no token, 51 samples, negative and > 60 s values; accepts a valid batch`.
  - `worker/test/lobby.test.ts › a paired match archives each seat's queue wait in milliseconds` — `waitMs` equals `pairedAt - since` under `freezeClock`.
  - `supabase/tests/telemetry.test.ts › record_match v3 stores queue_wait_ms and stays idempotent and no-show aware` — the no-show cases from `migrations.test.ts` still hold.
  - `supabase/tests/telemetry.test.ts › ack_samples is written only through record_ack_samples by service_role and read by no client role`.
- **Riskiest assumption → check.** That "render" can be observed without React internals: a `requestAnimationFrame` after `useSyncExternalStore` publishes. Check by logging samples in one `e2e/live.spec.ts` run (30 min); they should sit between 1 and 100 ms locally.
- **Cut line.** Queue wait (server only) ships first; ack telemetry second.
- **Review fold-in.**
  - DBA: table shape and retention (keep 90 days).
  - Security: telemetry endpoint abuse.

### S7-06 · Pin the grading CPU budget

- **Goal.** `src/engine/bench.test.ts` (ADR path), in a Node environment, measures `analyzeSpot` CPU on cold boards with `process.cpuUsage`, and fails above 500 ms per decision. It also records the one-time `preflopClassEquity` cost. `performance.now()` is frozen in deployed Workers, so it is not used.
- **User-visible outcome.** None. CI catches a grading slowdown before Phase 1 depends on it.
- **Files.** New `src/engine/bench.test.ts` (`// @vitest-environment node`).
- **Depends on.** Nothing.
- **Estimate.** 1 hd · H (≈ 0.5 h).
- **Acceptance tests.**
  - `src/engine/bench.test.ts › a cold flop, turn and river analyzeSpot each stay under 500 ms CPU` — median of 3 runs on 12 fixed boards.
  - `src/engine/bench.test.ts › the one-time preflop table costs under 1,000 ms CPU and is logged`.
- **Riskiest assumption → check.** CI runner noise. Use user+system CPU (not wall clock) and the median of 3. Check by running the suite 10× locally and once in CI and recording the spread in the SDE log.
- **Cut line.** Flop only.
- **Review fold-in.** None expected.

### S7-07 · CI guards what we deploy

- **Goal.** Pin actions by SHA, use least-privilege permissions, run a scheduled engine soak, prove the live e2e runs in CI, and add a read-only check that production serves `main`. The check automates what Prompt 1 did by hand and replaces the ADR's `deploy-worker.yml` (R-3).
- **User-visible outcome.** None. Red CI when production drifts from `main` or the engine soak fails.
- **Files.**
  - `.github/workflows/ci.yml`: SHA pins for `actions/checkout`, `actions/setup-node`, `actions/upload-artifact`; per-job `permissions`; after `npm run e2e`, assert the JSON reporter shows the 3 `live` tests passed.
  - New `.github/workflows/engine-soak.yml`: weekly, `workflow_dispatch`, and PRs touching `src/engine/**`; runs `npm run engine:soak`; the failing seed is printed (R-4).
  - New `.github/workflows/deploy-check.yml`: on push to `main`; waits for the Cloudflare build, then runs the script.
  - New `scripts/verify-deploy.mjs`: build, compare every `dist/assets/*` md5 with the live URL, assert `/api/config` has exactly `supabaseUrl` and `supabaseKey`.
  - New `scripts/verify-deploy.test.ts`.
- **Depends on.** Nothing.
- **Estimate.** 2 hd · H (≈ 0.9 h).
- **Acceptance tests.**
  - `scripts/verify-deploy.test.ts › fails when a built asset is missing or differs in production` (fake fetch).
  - `scripts/verify-deploy.test.ts › fails when /api/config has any field besides supabaseUrl and supabaseKey`.
  - Workflow evidence in the SDE log:
    - one green `engine-soak` dispatch run (100k hands per N=2..6);
    - one `ci` run whose e2e log lists 3 passing `live` tests;
    - one `deploy-check` run green on `main`.
- **Riskiest assumption → check.** How the job knows Cloudflare's build finished. Cheapest check: read the check runs and commit statuses on `22ccf8a` with the GitHub MCP (Workers Builds may post one). Otherwise poll the site until its `index.html` references this commit's hashed entry file (timeout 15 min).
- **Cut line.** Pins, permissions and the soak ship; deploy-check becomes `npm run verify:deploy` run by hand.
- **Review fold-in.** Security item 7 (CI/supply chain).

### S7-08 · Repeatable load and integrity smoke

- **Goal.** `scripts/smoke-ws.mjs` runs 20 concurrent clients (10 HU matches) to 500 hands total. It prints ack p50/p95/p99, checks invariants and redaction, verifies every commitment with `verifyDeal`, and exits non-zero above 300 ms p95 or on any break.
- **User-visible outcome.** None. One command answers "is it still correct and fast?".
- **Files.** New `scripts/smoke-ws.ts`, bundled with esbuild into `scripts/smoke-ws.mjs` by a `smoke` npm script; new `scripts/smoke-stats.test.ts`; `package.json` script `smoke`.
  - Node 22 global `WebSocket`; dev tokens `dev.<user>.<secret>`.
  - `--target` defaults to `http://localhost:8787`.
  - `--rated` and `--six` are added later by P1-22 and P2-11.
  - `--target` production refuses to run unless the confirmation phrase is typed **and** you have said go in that session (Q4).
- **Depends on.** Nothing (needs `wrangler dev`).
- **Estimate.** 2 hd · M (≈ 1.4 h).
- **Acceptance tests.**
  - `scripts/smoke-stats.test.ts › percentiles and the 300 ms p95 gate` — synthetic samples.
  - Run evidence in the SDE log: `npm run smoke -- --matches 10 --hands 50` against `wrangler dev` exits 0 and prints p50/p95/p99, `invariant failures 0`, `leaks 0`, `commitments 500/500`.
- **Riskiest assumption → check.** Engine imports from a script. Engine files import without `.ts` extensions, so Node type-stripping fails. Bundle with the esbuild that already ships with Vite (`npx esbuild --version`, 1 min).
- **Cut line.** A local-only run; staging or production per Q4 later.
- **Review fold-in.** None expected.

### S7-09 · Chaos pass against the failure-mode table

- **Goal.** Exercise each row of ADR §Failure modes on `wrangler dev` with real clients, and fix what breaks.
- **User-visible outcome.** Fewer surprises.
- **Files.** Depend on findings. A chaos table in `.10x/decisions/sde/multiplayer-platform.md` §Step 7; one regression test per bug in `worker/test/*.test.ts`.
- **Depends on.** S7-05, S7-08.
- **Estimate.** 2 hd · L (≈ 1.8 h).
- **Acceptance tests.** A row per case, each VERIFIED with what was seen, plus a red-then-green test for every bug fixed:
  - kill a socket mid-hand;
  - delay the alarm 60 s;
  - restart `wrangler dev` mid-hand;
  - two tabs on one account;
  - `SUPABASE_URL` pointed at a dead port for 60 s (outbox retries; play continues; rows arrive);
  - lobby restart while queued;
  - deploy mid-match (protocol `qp.v1` unchanged → clients resync).
- **Riskiest assumption → check.** That `wrangler dev` restarts reproduce production eviction. The restart test in `table.test.ts` already showed `abortAllDurableObjects` is the reliable path; use both.
- **Cut line.** Record every result. Any fix over half a day becomes its own ticket.
- **Review fold-in.** None expected.

### S7-10 · Fair Play, Terms and the play-money line

- **Goal.** Publish what the platform guarantees and what it does not, before strangers arrive.
- **User-visible outcome.**
  - `#fair-play` and `#terms` pages, linked from the lobby, the sign-in page and the README.
  - The sign-in page says "Play money only. No prizes, no deposits. 18+."
- **Files.**
  - New `src/info/InfoPages.tsx`, a lazy chunk: entry budget, `scripts/check-bundle.mjs`.
  - `src/App.tsx` (`parseRoute` adds the two routes); `src/net/Lobby.tsx`; `src/net/AuthGate.tsx`; `README.md` §Multiplayer.
  - New `src/info/InfoPages.test.tsx`.
- **Copy must say:**
  - the server owns the cards;
  - the lab is never on the live table;
  - every deck is committed before the deal and checked in your browser, and what that does not prove (a biased shuffle);
  - abandonment is counted;
  - **not detected yet:** collusion and real-time assistance;
  - rated hand histories are public and permanent;
  - per-action decision times are recorded (and public, unless Q5 changes it);
  - data lives in Supabase us-east-1;
  - how to report: the contact you choose (user action U-6) until P1-17.
- **Depends on.** Nothing.
- **Estimate.** 2 hd · H (≈ 0.9 h).
- **Acceptance tests.**
  - `src/info/InfoPages.test.tsx › Fair Play lists collusion and real-time assistance under "not detected"`.
  - `src/info/InfoPages.test.tsx › Terms state play money, no prizes, 18+, public hand histories and recorded decision times`.
  - `e2e/app.spec.ts › fair play and terms open from the lobby and have no serious axe violations`.
  - `npm run build` entry chunk stays < 150 kB (logged number).
- **Riskiest assumption → check.** Entry growth from two routes. `check-bundle` fails if the pages are not lazy; build once and look at the number.
- **Cut line.** Fair Play plus the sign-in line; Terms can follow the same week.
- **Review fold-in.** Security item 3: the Supabase Auth settings it finds go into the copy if user-relevant.

### S7-11 · Phase 0 launch gate

- **Goal.** Ship Step 7 to production with evidence, and close the two checks Prompt 1 left open.
- **User-visible outcome.** Strangers can play casual HU on the public URL.
- **Files.** New `.10x/reviews/<date>-launch-verification.md`.
- **Depends on.** S7-01…S7-10; the security and DBA reviews with no open Critical or High; user gates U-3 and U-4; your go-ahead (U-5).
- **Estimate.** 1 hd · H (≈ 0.5 h, plus user gates).
- **Acceptance tests.** One evidence row each, VERIFIED:
  - `npm run verify:deploy` green;
  - a real token header is `alg ES256`, `kid 146bb67a-…`;
  - one two-account match archived: counts in `matches`, `match_players`, `hands`, `hand_holes`;
  - role-scoped `hand_holes` queries are disjoint per player;
  - every hand of that match has `verified = true`;
  - a smoke run on the Q4 target with its p95.
- **Riskiest assumption → check.** That the deploy picks up the queue bindings. Check: `npm run verify:deploy` plus one `verified = true` row.
- **Cut line.** None.
- **Review fold-in.** All reviews must be closed.

### S7-12 · Players can verify their own folded cards (security review SR-08)

- **Goal.** After each hand, each seat also receives the openings of its **own** hole slots, so a player can check that the cards they folded were the committed ones. Today the reveal opens only the board and shown hands (`publicSlots`, `src/engine/deck.ts:199`).
- **User-visible outcome.** "Deck verified" also covers your own cards, folded or not.
- **Files.**
  - `src/shared/protocol.ts`: `Reveal` gains `own?: RevealedSlot[]`, sent per seat only.
  - `worker/src/table.ts`: `sendEnded` builds the per-seat part.
  - `src/engine/deck.ts`: new `verifyOwn(commitment, leaves, own, deal, seat, cards)`; `verifyDeal` is unchanged for public slots.
  - `src/net/useDeckCheck.ts`.
  - The public `hands.reveal` archive must **not** gain own slots; `hand_holes` already gives each player their cards.
  - Tests in `src/engine/deck.test.ts`, `worker/test/leaks.test.ts`, `src/net/review.test.tsx`.
- **Depends on.** Nothing. It must land before P1-22 (ladder launch); until then the Fair Play copy (S7-10) says "board and shown hands are checked".
- **Estimate.** 2 hd · M (≈ 1.4 h).
- **Acceptance tests.**
  - `src/engine/deck.test.ts › a player's own folded cards verify against the commitment, and a swapped own card fails`.
  - `worker/test/leaks.test.ts › each seat's reveal opens its own hole slots and never the other seat's unshown slots` (extends the frame allowlist with `own`).
  - `src/net/review.test.tsx › "Deck verified" covers your own folded cards`.
- **Riskiest assumption → check.** That a per-seat field fits the shared `reveal` frame without leaking across seats. The leak test's allowlist and byte-equality checks are the guard; write that test first.
- **Cut line.** Engine and server first; the UI wording can follow.
- **Review fold-in.** None; this ticket is itself a security finding.

---

### S7-13 · Park an archive call that can never succeed (DBA review DB-4)

- **Goal.** An outbox call that fails the same way every time stops blocking its match. Today it retries every 5 min forever (`outboxBackoff` caps at 300 s, `worker/src/deadlines.ts:68`) and, being first in key order, holds back every later archive call of that match (`flushOutbox`, `worker/src/table.ts`). Example: a seat whose account was deleted mid-match makes the `hand_holes` foreign key fail.
- **User-visible outcome.** None for players. For you: one `incident` row naming the stuck call instead of an alarm firing every 5 minutes.
- **Files.** `worker/src/table.ts` (`flushOutbox`: after `OUTBOX_MAX_ATTEMPTS` (proposal 12, ≈ 1 h) of failures whose Postgres code is class 22 or 23 (bad data or a broken constraint: a retry cannot change them), move the call to `parked:<key>`, report `record_incident` with the rpc and Postgres code only, continue the flush); `worker/test/archive.test.ts`.
- **Depends on.** Nothing.
- **Estimate.** 1 hd · L (≈ 0.7 h).
- **Acceptance tests.**
  - `worker/test/archive.test.ts › a call refused 12 times is parked with one incident, and the calls behind it are sent`.
  - `worker/test/archive.test.ts › a 5xx, a network failure, a 401 or a 403 is never parked`. Supabase down must keep retrying, and a missing or wrong key (U-4) must replay everything once it is fixed.
- **Riskiest assumption → check.** That a class 22/23 failure is permanent. A lost create race (23505, DB-3) is not; it succeeds on the next attempt, long before 12.
- **Cut line.** None; small.
- **Review fold-in.** This ticket is itself a DBA finding.

---

## Phase 1: rated HU ladder, rating v1, integrity v1, review → lesson loop

Rated matches use `MatchKind 'hu-rated'`. Everything below is additive; casual HU keeps working and stays tested (R-24).

### P1-00 · Architect addendum: rated heads-up match

**Status 2026-10-10: done.** See "Amendment 2026-10-10: Phase 1 rated heads-up" in `.10x/decisions/architect/multiplayer-platform.md`. Q2 takes the recommendation (immediately), which is reversible; say if you want segment-end forfeits.

- **Goal.** One ADR amendment that pins down everything P1-01…P1-04 and P1-12 need, so no SDE session designs on the fly. It also carries the ADR's "Phase 1 hand-off notes".
- **User-visible outcome.** None.
- **Files.** `.10x/decisions/architect/multiplayer-platform.md` (new section "Amendment: Phase 1 rated HU").
  - Correct the doc where code differs: `TableController` is a synchronous `nextHandPlan(handNo, config)` with no `onHandEnd`/`onSeatEvent`; `Deadline` has no `idle` kind until S7-01.
- **The amendment must answer:**
  - the Q1 outcome and the resulting deck rule;
  - DO storage for 2 × 20 hands (keys, size, restore);
  - bank per segment;
  - 60 s grace, then immediate auto-fold of a disconnected seat;
  - forfeit timing (Q2);
  - the `DRAW_BAND_BB = 2` constant, inclusive (R-8);
  - rematch vs pair cap (R-9);
  - no-show = void and not rated (R-14);
  - the failure matrix: DO restart mid-segment, one or both players gone, Supabase down at match end;
  - the rating-update transaction (CAS on `ratings.version`, P1-12);
  - the grading message flow (same queue, after verification);
  - the list of Phase 1 migrations reconciled with the DBA's `.10x/decisions/dba/phase1-schema.md` (Prompt 4).
- **Depends on.** Q1 and Q2 answered; DBA review (Prompt 4) preferred.
- **Estimate.** 2 hd · M (≈ 1.4 h).
- **Acceptance tests.** Documentation, no code. Each bullet above has a decision and the rejected alternative; every Phase 1 table named in P1-01…P1-18 appears in the migration list.
- **Riskiest assumption → check.** That the DBA's schema and this amendment agree. Read `phase1-schema.md` first; disagreements are listed, not silently resolved.
- **Cut line.** None; P1-01 cannot start without it.
- **Review fold-in.** DBA (schema), Security (deck rule).

### P1-01 · Rated queue and the rated match lifecycle

**Status 2026-10-10:**

- **Database: done and live** (PR #12, `6d1bad4`; `20261010010000 rated_matches` recorded in production). `record_match` v4 also refuses a rated finish missing a seat's result, and voids a match both players left (`abandoned`, one `leave_mid_hand` row each). It went first because S7-05 is not started, so this `record_match` is v4 and S7-05 defines the next version.
- **Rated rules in the table server.** Under B the "segments" below are halves that exist only for the clock: 40 hands, the bank refills at hand 21, and the match bar reads "Hand 7 of 40". The acceptance tests are in `worker/test/rated.test.ts` with that wording.
- **Table server: done.** P1-01b-1 is PR #13; the 60 s grace and the both-gone void are P1-01b-2 (PR #14).
- **Rated queue and the email gate: done** (P1-01b-3), with the end text reading the outcome. The gate asks Supabase Auth, not a token claim (the riskiest assumption, checked against the docs).
- **UI: done** (P1-01c): the Rated card, the refusal message with a re-check on retry, and the match bar. **P1-01 is done**, except for one manual check: a real confirmed account plays a real rated match once U-4 sets the Worker's secret key, so the result is archived.

- **Goal.** A signed-in player with a confirmed email can queue for a rated HU match and play 2 segments × 20 hands, with a 60 s bank per segment, a 60 s reconnect grace, the forfeit rule and a W/D/L result archived.
- **User-visible outcome.**
  - A "Play rated 1v1" card that explains duplicate in one line.
  - A match bar reading "Segment 1 · Hand 7 of 20".
  - At the end: "+3.5 bb · Win" (rating change comes with P1-12).
  - An account without a confirmed email sees why it cannot queue rated.
- **Files.**
  - `src/shared/protocol.ts`: `MatchKind` adds `'hu-rated'`; `MatchConfig.segments` and `handsPerSegment`; `SeatView.segment`; `ErrorCode` adds `unverified`.
  - `worker/src/controller.ts`: new `RatedController`, deck rule from P1-02.
  - `worker/src/table.ts`: bank reset per segment; grace; forfeit (Q2); result with `DRAW_BAND_BB`.
  - `worker/src/deadlines.ts`: `grace` kind.
  - `worker/src/lobby.ts`: separate queue per kind; the shared pair counter is unchanged (R-25).
  - `worker/src/auth.ts`: `Identity.emailConfirmed`.
  - New `supabase/migrations/<ts>_rated_matches.sql`: `matches.kind` check adds `'hu-rated'`; `record_match` v4 from S7-05's v3 stores `result.outcome` per user and `netBb`.
  - New `supabase/tests/rated.test.ts`.
  - `src/net/Lobby.tsx`, `src/net/LiveTable.tsx`.
  - New `worker/test/rated.test.ts`; `src/net/lobby.test.tsx`; `e2e/live.spec.ts`.
- **Depends on.** P1-00, S7-05 (`table.ts` lane and `record_match` order).
- **Estimate.** 4 hd · M (≈ 2.7 h).
- **Acceptance tests.**
  - `worker/test/rated.test.ts › a rated match deals 2 segments × 20 hands and ends with match_end complete and an outcome per player`.
  - `worker/test/rated.test.ts › the bank is 60 s per segment and unused segment-1 bank does not carry over`.
  - `worker/test/rated.test.ts › a player gone longer than 60 s has each turn auto-folded or auto-checked at once` — no clock wait after grace.
  - `worker/test/rated.test.ts › three consecutive timeouts end the match as decided in P1-00 (Q2), with one abandonments row timeout_x3 and outcome loss for that player`.
  - `worker/test/rated.test.ts › +40 chips (2.00 bb) over the match is a draw and +41 is a win` — `DRAW_BAND_BB = 2`, inclusive.
  - `worker/test/rated.test.ts › an account without a confirmed email gets error unverified on a rated queue and can still queue casual`.
  - `supabase/tests/rated.test.ts › record_match v4 stores kind hu-rated and the outcome, is idempotent and service_role only`.
  - `src/net/lobby.test.tsx › the Rated card queues hu-rated and an unconfirmed account sees why it cannot`.
  - `e2e/live.spec.ts › two players find a rated match and both see "Segment 1 · Hand 1 of 20"`.
- **Riskiest assumption → check.** That the verified JWT says whether the email is confirmed. Cheapest check (20 min): read GoTrue's access-token claims (`email_verified` in `user_metadata`, `amr`, `is_anonymous`) in the Supabase docs (MCP `search_docs`). Fallback: a security-definer RPC over `auth.users.email_confirmed_at`, as `reserve_coach_request` in `20261007192620_learning_cloud.sql` already does, called once per socket.
- **Cut line.** The segment indicator can be text only. The grace, forfeit, draw band and email gate must ship.
- **Review fold-in.**
  - Security item 1 (auth, email claim).
  - DBA (`record_match` v4, `kind` check).

### P1-02 · Segment decks: variant A (duplicate) or variant B (fresh decks, luck-adjusted). Q1 picks one.

**Q1 answered 2026-10-09: variant B.** Only the B goal, files and tests below apply.

**Status 2026-10-09:** the engine module is **done** (`src/engine/luck.ts`; `.10x/decisions/sde/heads-up-duplicate-ladder.md`). A preflop all-in costs ≈ 475 ms of CPU, which is over the 100 ms guess below but inside the table's 3 s gap between hands, so the adjustment stays in the table server. The `table.ts` wiring and `worker/test/rated.test.ts` come with P1-01.

- **Goal (A, same-pair duplicate).** Segment 2 hand _i_ deals a segment-1 deck with the button flipped. Flipping the button swaps the hole cards exactly, because `dealSlots` deals relative to the button. Each deal gets a fresh commitment secret. The mitigations Q1 chooses apply:
  - a secret random order π of the segment-2 decks, stored in DO storage;
  - no in-match review on rated tables (review unlocks at `match_end`);
  - a per-player `seg2 − seg1` asymmetry statistic recorded for integrity v2;
  - Fair Play disclosure.
- **Goal (B, fresh decks).** Every hand is a fresh CSPRNG deck. The match result is net bb with all-in pots settled at equity: exact enumeration of the remaining board, deterministic. The module is new `src/engine/luck.ts`, which P2-10 and P2-12 reuse.
- **User-visible outcome.** (A) Segment 2 feels like new hands while luck cancels. (B) The end screen shows "luck-adjusted +3.5 bb (actual +11 bb)".
- **Files.**
  - (A) `worker/src/controller.ts` (`DuplicateController`); `worker/src/table.ts` (`deck:<n>` and `perm` kept for the match); `src/net/LiveTable.tsx` (no "Review hand n" during a rated match); new `worker/test/duplicate.test.ts`.
  - (B) new `src/engine/luck.ts`, `src/engine/luck.test.ts`; `worker/src/table.ts` (adjusted result from the DO's full holes).
- **Depends on.** P1-01.
- **Estimate.** 3 hd · M (≈ 2.0 h), either variant.
- **Acceptance tests (A).**
  - `worker/test/duplicate.test.ts › segment 2 deals segment 1's decks, seats swapped, card-for-card` — each player's segment-2 hole cards equal the opponent's segment-1 cards for the same deck; boards identical.
  - `worker/test/duplicate.test.ts › no segment-2 commitment equals any segment-1 commitment`.
  - `worker/test/duplicate.test.ts › the segment-2 position of segment-1 deck 1 is uniform over 20 positions across 1,000 matches` — chi-square p > 0.01; only if π is chosen.
  - `worker/test/duplicate.test.ts › a restart between and within segments resumes with the same decks and order` — fresh instance asserted.
  - `worker/test/duplicate.test.ts › every segment-2 reveal verifies with verifyDeal`.
  - `src/net/LiveTable.test.tsx › a rated match offers no hand review until match_end`.
- **Acceptance tests (B).**
  - `src/engine/luck.test.ts › a preflop all-in where the loser was 82% ahead credits 0.82 of the pot` — hand-computed.
  - `src/engine/luck.test.ts › hands that reach showdown without an all-in are unchanged`.
  - `src/engine/luck.test.ts › the adjustment is zero-sum between the two seats`.
  - `worker/test/rated.test.ts › the match result uses the luck-adjusted net and the draw band applies to it`.
- **Riskiest assumption → check.**
  - (A) That flipping the button swaps exactly the hole slots: a 15-minute `dealSlots` test at N=2 with both buttons.
  - (B) That exact preflop enumeration (1.7M boards × 2 hands) fits between hands in the DO: time it in Node with `src/lib/sim.ts` `score()` (15 min). If it exceeds 100 ms, move the adjustment to the queue consumer and finalise the result there.
- **Cut line.** (A) π and the asymmetry statistic are the optional parts; no in-match review ships regardless. (B) Preflop and flop all-ins only.
- **Review fold-in.** Security item 4 (commitment and reuse).

### P1-03 · Nothing to analyse during a rated match

**Status 2026-10-10: done (PR #17).**

- **Built.** The five acceptance tests exist under their names. The allowlists moved to `worker/test/frames.ts`, checked against the protocol by the compiler.
- **One UI gap closed.** Rated tables no longer draw the locked equity ring or the break-even figure.
- **Recorded in the SDE log** (`.10x/decisions/sde/heads-up-duplicate-ladder.md` §P1-03):
  - `?motion=off` stays a cosmetic switch, since it equals the OS reduced-motion setting;
  - the face-up all-in runout equity stays, shown only after the server decided the hand.

- **Goal.** Prove that during a rated match no client receives or renders analysis, and that debug params change nothing. This is the integrity metric "analysis data during a live rated hand = 0 (network test in CI)".
- **User-visible outcome.** A rated table has no equity ring numbers, EV labels, lab, or guess bar.
- **Files.** New `worker/test/rated-leak.test.ts`; `src/net/LiveTable.tsx`; `src/env.ts` (`motionOff`/seed ignored when a rated welcome arrives); `src/net/LiveTable.test.tsx`; `e2e/live.spec.ts`.
- **Depends on.** P1-02.
- **Estimate.** 2 hd · H (≈ 0.9 h).
- **Acceptance tests.**
  - `worker/test/rated-leak.test.ts › every frame of a 40-hand rated match has exactly the allowed key set for its type` — no `equity`, `ev`, `range`, `grade` key anywhere, including after a reconnect, timeouts and reveals.
  - `worker/test/rated-leak.test.ts › opponent hole cards appear in no frame or close reason before that hand's showdown`.
  - `src/net/LiveTable.test.tsx › a rated table renders no equity value, EV label, lab button or guess bar`.
  - `src/net/LiveTable.test.tsx › ?seed=3&motion=off does not change a rated table`.
  - `e2e/live.spec.ts › during a rated hand neither browser receives analysis keys or opponent cards and no lab control is visible` — frame tap as in the existing leak test.
- **Riskiest assumption → check.** The allowlist must list every current field. Generate it from `src/shared/protocol.ts` types once and review by hand.
- **Cut line.** None.
- **Review fold-in.** Security item 3.

### P1-04 · End of match and rematch

**Status 2026-10-10: done** (PR #18 database, live; PR #19 table, lobby and screen). Under B, the headline is the luck-adjusted total ("+12.5 bb · Win") and the chips actually won appear beside it. The rating change waits for P1-12 and the swings for P1-20, with no placeholder. The acceptance tests exist under their names, plus `match_end` resent on reconnect; details are in the SDE log §P1-04.

- **Goal.** After a rated match each player sees the result in bb, W/D/L, the rating change (P1-12), the top swings (P1-20), and a rematch button that obeys the pair cap (R-9).
- **User-visible outcome.**
  - "Rematch": both press within 60 s and a new rated match starts.
  - At the cap the button reads "Rematch limit reached (2 per day)".
- **Files.**
  - New `src/net/MatchEnd.tsx`; `src/net/LiveTable.tsx`.
  - `src/shared/protocol.ts`: `rematch` ClientMsg; `rematch_state` ServerMsg with `waiting`, `starting`, `declined` or `limit`.
  - `worker/src/table.ts`; `worker/src/lobby.ts` (`rematch(a, b, matchId)` RPC uses the pair counter).
  - New `supabase/migrations/<ts>_rematch.sql`: `matches.rematch_of uuid`; `record_match` v5 from P1-01's v4.
  - New `worker/test/rematch.test.ts`, `src/net/MatchEnd.test.tsx`.
- **Depends on.** P1-03 (`table.ts` lane).
- **Estimate.** 3 hd · M (≈ 2.0 h).
- **Acceptance tests.**
  - `worker/test/rematch.test.ts › both players press Rematch within 60 s and a new rated match starts with rematch_of set`.
  - `worker/test/rematch.test.ts › one press alone expires as declined`.
  - `worker/test/rematch.test.ts › at the pair cap the state is limit and a forced rematch frame is refused`.
  - `worker/test/rematch.test.ts › rematch frames carry only the allowed keys` — redaction test for the new messages.
  - `src/net/MatchEnd.test.tsx › shows "+12.5 bb · Win", the rematch button, and the limit text at the cap`.
- **Riskiest assumption → check.** That the table can reach the lobby at match end while both sockets are on the table. The existing `release` RPC proves the path; reuse it.
- **Cut line.** Rematch ships; swings stay a placeholder until P1-20.
- **Review fold-in.** Security item 2 (seat and session integrity).

### P1-05 · Review any finished match from the archive

- **Goal.** `#review/<matchId>/<handNo>` loads a finished match from Supabase and replays it with "Deck verified". Opening it is recorded for the "review opened" metric.
- **User-visible outcome.** Review links work after the session ends, from the end screen and the profile.
- **Files.**
  - `src/App.tsx`: route → lazy `src/review/ArchiveReview.tsx`. The new chunk lives outside `src/net`, so P1-06 can add the lab without breaking `src/net/imports.test.ts`.
  - New `src/net/archive.ts`: `hands` plus own `hand_holes` via supabase-js.
  - `src/net/ReviewLive.tsx`: shared pieces.
  - New `supabase/migrations/<ts>_review_opened.sql`: `match_players.review_opened_at`; RPC `mark_review_opened(match_id)` for authenticated users, own row, set once.
  - New `supabase/tests/review.test.ts`, `src/net/archive.test.ts`; `e2e/live.spec.ts`.
- **Depends on.** S7-10 (same `parseRoute` in `src/App.tsx`).
- **Estimate.** 3 hd · M (≈ 2.0 h).
- **Acceptance tests.**
  - `src/net/archive.test.ts › loads a finished match with my hole cards and the opponent's only where shown`.
  - `supabase/tests/review.test.ts › mark_review_opened sets my row once and cannot touch another player's row; anon refused`.
  - `e2e/live.spec.ts › after a 2-hand match the review link opens #review/<id>/1 with "Deck verified"`.
  - `src/net/imports.test.ts` still passes.
- **Riskiest assumption → check.** That supabase-js reads under RLS from the new chunk without pulling `supabase` into the entry chunk. Check with `npm run build` and the `check-bundle` regex.
- **Cut line.** Review-opened tracking may slip one ticket; the route must ship.
- **Review fold-in.** DBA (RPC), Security item 5.

### P1-06 · Lab in review and "compare with opponent on the same deck"

- **Goal.** After a match ends, review shows the full lab and the grades. With variant A, it also shows each hand next to its twin, side by side.
- **User-visible outcome.** The lab is open in review and closed in play. Side by side: "You (seg 1) vs bob (seg 2) on deck 7", with the opponent's cards only where shown.
- **Files.** `src/review/ArchiveReview.tsx`; reuse `src/components/review/HandReview.tsx` and `src/components/lab/Lab.tsx` on `toHeroGame(record, seat)` from `src/engine/project.ts` with model `'population'` (P1-08) or `'uniform'`; new `src/review/CompareDeck.tsx`; tests alongside.
- **Depends on.** P1-05.
- **Estimate.** 3 hd · M (≈ 2.0 h).
- **Acceptance tests.**
  - `src/review/ArchiveReview.test.tsx › the lab is available for a finished match and absent while the match is playing`.
  - `src/review/CompareDeck.test.tsx › a segment-1 hand and its segment-2 twin render side by side with hidden cards where not shown` — variant A only. Under variant B the compare view is not built; AC5 is then answered by Q1's decision, recorded in P1-00.
- **Riskiest assumption → check.** That `HandReview` and the lab accept a projected `Game` with a human opponent. Check with a 30-minute jsdom render of `HandReview` on `toHeroGame(record, 0)`.
- **Cut line.** Lab in review ships; the compare view can follow.
- **Review fold-in.** Security item 3: the lab must never mount for a playing match.

### P1-07 · Live table keyboard, sounds and quality gates

- **Goal.** HU duplicate AC7: the live table passes the trainer's gates (keyboard loop, axe, mobile layout, frame time) with two clients. Keyboard and sounds were deferred in Steps 4 and 5.
- **User-visible outcome.** F/C/R, the 1–4 presets and Enter work on live tables; sounds match the trainer.
- **Files.**
  - `src/net/LiveTable.tsx`.
  - Extract `useTableSounds` from `src/App.tsx:332–361` into `src/lib/useTableSounds.ts`, with no trainer change.
  - Extract the trainer's key handler into `src/lib/useTableKeys.ts` if shared.
  - `e2e/live.spec.ts`, `e2e/mobile.spec.ts`, `e2e/motion.spec.ts`.
- **Depends on.** Nothing. Run it during Step 7, before P1-01 touches `LiveTable.tsx`.
- **Estimate.** 3 hd · M (≈ 2.0 h).
- **Acceptance tests.**
  - `e2e/live.spec.ts › keyboard loop plays a full live hand without the mouse`.
  - `e2e/live.spec.ts › the live table has no serious axe violations in light and dark`.
  - `e2e/mobile.spec.ts › the live table fits a phone without horizontal scroll`.
  - `e2e/motion.spec.ts › a live all-in runout animates without long frames`.
  - `src/net/LiveTable.test.tsx › keys send act frames only on your turn`.
- **Riskiest assumption → check.** That extracting the hooks leaves the trainer byte-identical in behaviour. The existing `e2e/app.spec.ts` keyboard test is the check: run it before and after.
- **Cut line.** Keyboard and gates; sounds can follow.
- **Review fold-in.** None expected.

### P1-08 · Population opponent model

**Status 2026-10-10: done** (PR #20, live). `src/lib/population.ts`: position-aware preflop shares and a human-typical postflop policy, every number with its reasoning; key-seeded analysis tables make grades repeatable. Sanity order holds (TAG > Atlas > station > folder). Details: SDE log `accuracy.md` §P1-08.

- **Goal.** Grade human decisions against a documented, position-aware population model, behind the same `OpponentModel` switch as `'uniform'` (`src/lib/model.ts`).
- **User-visible outcome.** None directly. It feeds accuracy (label: "Accuracy vs. a model opponent, not a solver.").
- **Files.**
  - `src/lib/model.ts`: `OpponentModel` adds `'population'`.
  - New `src/lib/population.ts`: SB/BB preflop ranges and a postflop continuation policy; every constant has a source comment.
  - `src/lib/atlas.ts`: `policy()` generalised (ADR: the only call site); `src/lib/range.ts`.
  - New `src/lib/population.test.ts`; new `src/lib/sanity.test.ts` (`// @vitest-environment node`).
- **Depends on.** Nothing (pure).
- **Estimate.** 4 hd · L (≈ 3.6 h).
- **Acceptance tests.**
  - `src/lib/sanity.test.ts › over 2,000 graded HU decisions a TAG script and Atlas's policy both beat always-call, which beats always-fold, by ≥ 5 accuracy points`.
  - `src/lib/sanity.test.ts › grading the same decisions twice is bit-identical`.
  - `src/lib/population.test.ts › the SB opening range is wider than the BB 3-bet range and every range weight is in [0,1]`.
- **Riskiest assumption → check.** That the sanity ordering holds at all. Cheapest check: run the sanity harness with the existing `'uniform'` model first (half a day). If uniform already orders correctly, population is a refinement. If neither does, stop and report before P1-09.
- **Cut line.** Ship accuracy on `'uniform'` with the same label, and record the gap.
- **Review fold-in.** None expected.

### P1-09 · Grading consumer and `hand_grades`

**Status 2026-10-10: done** (PR #21 `hand_grades`, live; PR #23 consumer, live). Every move of a rated heads-up hand is graded after verification, clock moves included (QA finding), with each decision's pot stored. Golden set (50 hands) equal to the trainer; redelivery idempotent; failures block nothing. Details: SDE log `accuracy.md` §P1-09, QA `accuracy.md`.

- **Goal.** Every archived rated HU hand gets per-decision grades for both seats, server-side, after verification. Grading is idempotent and never blocks play, the result or the rating; a failure degrades to "not graded yet" plus a retry.
- **User-visible outcome.** Review shows Best/Good/Inaccuracy/Mistake/Blunder after the match.
- **Files.**
  - New `worker/src/grade.ts`, chained in the `quantpoker-hands` consumer after `verify.ts`. It uses `toHeroGame` plus `gradeDecision` with each seat's **own** hole cards only.
  - `worker/src/index.ts` (dispatch).
  - New `supabase/migrations/<ts>_hand_grades.sql`: `hand_grades(hand_id, seat, idx, user_id, grade, ev_lost, accuracy, model_version)`, primary key `(hand_id, seat, idx)`; RLS select only when the match is `finished` (R-15); RPC `record_grades(p)` for `service_role`, `on conflict do nothing`.
  - New `supabase/tests/grades.test.ts`, `worker/test/grade.test.ts`, `src/engine/grading-golden.test.ts`.
- **Depends on.** S7-03, P1-01, P1-08 (or `'uniform'`).
- **Estimate.** 4 hd · M (≈ 2.7 h).
- **Acceptance tests.**
  - `worker/test/grade.test.ts › a finished rated hand gets one grade per decision for both seats with model_version`.
  - `worker/test/grade.test.ts › a redelivery writes no duplicate grades`.
  - `worker/test/grade.test.ts › a grading exception leaves the hand verified, retries, lands in the DLQ as an incident after max_retries, and the match result and rating are unaffected`.
  - `worker/test/grade.test.ts › casual hands are verified and not graded` (R-23).
  - `src/engine/grading-golden.test.ts › 50 recorded hands: consumer grades equal the trainer's gradeDecision on the same Game field for field`.
  - `supabase/tests/grades.test.ts › no role reads a grade while its match is playing; after finish everyone reads both seats; only service_role writes`.
- **Riskiest assumption → check.** CPU per invocation, 0.5–3 s per hand per the ADR. S7-06's bench pins the per-decision cost; also time one real 8-decision hand in `wrangler dev` with `process.cpuUsage` in the test.
- **Cut line.** Grades for the hero seat first, then both seats.
- **Review fold-in.** DBA (table, RLS by match status), Security item 3.

### P1-10 · Accuracy on the profile

**Status 2026-10-10: built** (this branch). `public.accuracy` (plain mean of the latest 500 graded decisions plus the distribution, public, written only by `private.refresh_accuracy` on finish and on late grades) and `public.rated_luck`; a "Rated play" panel in the lobby with the exact label and "Not graded yet", reusable on the P1-15 profile. Depends on P1-15 only for its final home.

- **Goal.** Rolling accuracy over the last 500 graded decisions, the grade distribution, and the luck-vs-skill chart across rated matches.
- **User-visible outcome.** A profile panel labelled exactly "Accuracy vs. a model opponent, not a solver.", with "Not graded yet" when empty.
- **Files.** New `supabase/migrations/<ts>_accuracy.sql` (`player_accuracy(user_id)` plus an index on `hand_grades (user_id, created_at desc)`); new `src/net/profile/AccuracyPanel.tsx`, reusing `src/components/progress/Charts.tsx` if `src/net/imports.test.ts` allows it; tests.
- **Depends on.** P1-09, P1-15.
- **Estimate.** 2 hd · M (≈ 1.4 h).
- **Acceptance tests.**
  - `supabase/tests/grades.test.ts › player_accuracy averages exactly the latest 500 graded decisions`.
  - `src/net/profile/AccuracyPanel.test.tsx › the label is exact and the empty state reads "Not graded yet"`.
  - `src/net/profile/AccuracyPanel.test.tsx › the luck-vs-skill series sums to the net result`.
- **Riskiest assumption → check.** That `Charts.tsx` imports no analysis module. Run `src/net/imports.test.ts` with the import added (5 min).
- **Cut line.** Number and distribution; the chart can follow.
- **Review fold-in.** DBA (query cost).

### P1-11 · Glicko-2 as a pure, versioned module

**Status 2026-10-09: done** (`src/rating/glicko2.ts`; `.10x/decisions/sde/rating-and-leaderboard.md`). "RD shrinks with play" is tested as "lower than sitting the period out"; see the log.

- **Goal.** `src/rating/glicko2.ts`: pure, no I/O, `VERSION = 'glicko2.v1'`, named and commented constants. τ = 0.5. One match is one rating period. Inactivity grows φ once per 30 days without a rated match. A draw scores 0.5.
- **User-visible outcome.** None.
- **Files.** New `src/rating/glicko2.ts`, `src/rating/glicko2.test.ts`; `eslint.config.js` (add `src/rating/**` to the engine block: no `Math.random`, timers or `Date.now`).
- **Depends on.** Nothing.
- **Estimate.** 2 hd · H (≈ 0.9 h).
- **Acceptance tests.**
  - `src/rating/glicko2.test.ts › reproduces Glickman's worked example to the printed digits` — 1500/200/0.06 vs 1400/30 win, 1550/100 loss, 1700/300 loss → 1464.06 / 151.52 / 0.05999.
  - `src/rating/glicko2.test.ts › a draw between equals leaves the rating and shrinks RD`.
  - `src/rating/glicko2.test.ts › properties over 10k random sequences` — RD shrinks with play and grows with inactivity; a win never lowers the rating; an upset moves more than an expected result.
- **Riskiest assumption → check.** None material; the published example is the oracle.
- **Cut line.** None.
- **Review fold-in.** None expected.

### P1-12 · Rating update when a rated match finishes

**Status 2026-10-10: built** (this branch). `ratings`, `rating_history`, `apply_rating` (returns the change; checks the archived result) and an abandonment trigger; the outbox `rate` step with compare-and-set retries; a `rating` frame and the end-screen line "Rating 1520 → 1534 (+14): beat a 1610 ± 80 player". Every acceptance test exists under its name or a close variant (SDE log §P1-12).

- **Goal.** Each finished rated match updates both players' ratings exactly once, in one transaction, with append-only history. Outcomes: forfeit or abandon = loss; no-show = void, not rated (R-14); draw = 0.5. Provisional while RD ≥ 100 or matches < 20.
- **User-visible outcome.** The end screen shows "1520 → 1534 (+14): beat a 1610 ± 80 player".
- **Files.**
  - New `supabase/migrations/<ts>_ratings.sql`:
    - `ratings(user_id, format, rating, rd, sigma, matches, version, updated_at)`;
    - `rating_history(match_id, user_id, format, before_*, after_*, outcome, kind, created_at)`, unique `(match_id, user_id)`, with a trigger refusing update and delete;
    - RPC `apply_rating(p)` for `service_role`, compare-and-set on `version`.
  - New `worker/src/rating.ts`: read, compute with `src/rating/glicko2.ts`, apply, retry on a version conflict.
  - `worker/src/table.ts`: outbox entry `rate` after `end`, rated matches only.
  - `src/net/MatchEnd.tsx`.
  - New `supabase/tests/ratings.test.ts`, `worker/test/rating.test.ts`.
- **Depends on.** P1-11, P1-04.
- **Estimate.** 4 hd · M (≈ 2.7 h).
- **Acceptance tests.**
  - `supabase/tests/ratings.test.ts › apply_rating twice for one match changes ratings once`.
  - `supabase/tests/ratings.test.ts › a stale version is refused and nothing is written`.
  - `supabase/tests/ratings.test.ts › rating_history refuses update and delete for every role`.
  - `supabase/tests/ratings.test.ts › anyone reads ratings and history; only service_role writes`.
  - `worker/test/rating.test.ts › a completed rated match applies Glicko-2 to both players and the end frame carries before, after and the change`.
  - `worker/test/rating.test.ts › a forfeit rates as a loss; a no-show is not rated`.
  - `worker/test/rating.test.ts › two matches finishing out of order for one player both apply, each against the then-current rating`.
  - `worker/test/rating.test.ts › with Supabase down at match end the rating applies later from the outbox`.
- **Riskiest assumption → check.** That CAS under retry is correct. Run a PGlite test with two interleaved `apply_rating` calls before writing the Worker side (30 min).
- **Cut line.** None; the ladder depends on it.
- **Review fold-in.** DBA §3 and §6 (integrity constraints).

### P1-13 · Rated quick-match near your rating

**Status 2026-10-10: built** (this branch, after P1-12). Window `100 + 50·min` of the longer waiter, closest first with ties to the longer waiter, pair cap kept, a 15 s alarm only while ≥ 2 rated players wait, "Widening search…" after a minute. Liquidity sim: median wait 29 s / 16 s / 10 s at 10 / 20 / 30 online (SDE log §P1-13).

- **Goal.** Rated pairing within `|Δ| ≤ 100 + 50·minutes` (ADR §Lobby), keeping ≤ 2 pairings per pair per day. A lobby alarm re-evaluates every 15 s only while ≥ 2 rated players wait; otherwise the lobby hibernates.
- **User-visible outcome.** Opponents near your rating. "Widening search…" after a minute.
- **Files.** `worker/src/lobby.ts` (rating in the queue row, read via `worker/src/supabase.ts` at queue time; unrated players queue as 1500 ± 350); `worker/test/lobby.test.ts`.
- **Depends on.** P1-12.
- **Estimate.** 2 hd · M (≈ 1.4 h).
- **Acceptance tests.**
  - `worker/test/lobby.test.ts › players 400 apart pair only after 6 minutes` (`freezeClock`).
  - `worker/test/lobby.test.ts › the closest eligible opponent is chosen, oldest first on ties`.
  - `worker/test/lobby.test.ts › a pair that met twice today is never paired again today, even alone in the queue`.
  - `worker/test/lobby.test.ts › no alarm is armed while fewer than 2 rated players wait`.
- **Riskiest assumption → check.** That a median wait under 60 s is reachable with this window at launch liquidity. Simulate Poisson arrivals at 10 to 30 concurrent players in a Node script (1 h) and record the median.
- **Cut line.** A fixed window first; widening second.
- **Review fold-in.** Security item 6 (queue flooding).

### P1-14 · The ladder

**Status 2026-10-10: built** (this branch). `ladder`, `ladder_month` and `abandonment_rate`; `#ladder` and `#ladder/month` (public); the metrics query `supabase/metrics/rating-metrics.sql` (production: insufficient data); the 200-player, 5,000-match season in PGlite (Spearman 0.975, all three metrics meet target). The acceptance tests exist under these names or close variants; the e2e is in `e2e/ladder.spec.ts` and `e2e/mobile.spec.ts`. Details: SDE log §P1-14 and `.10x/decisions/dba/ladder.md`.

- **Goal.** A public ladder per format, all-time and this month (R-16). It shows only eligible players: not provisional, ≥ 1 rated match in 30 days, abandonment < 10% over lifetime rated matches (R-13). Uses keyset pagination.
- **User-visible outcome.**
  - `#ladder`, inside the Online area and linked from the lobby, with no new top-nav item: the phone header overflowed at four items (SDE Step 2, deviation 6).
  - Columns: rank, player, rating ± RD, accuracy, matches, win rate, trend.
  - A provisional viewer sees "X matches to go".
- **Files.**
  - New `supabase/migrations/<ts>_ladder.sql`: `abandonment_rate(user_id)`; `ladder(format, period, after_rating, after_user, page_size)`; index `ratings (format, rating desc, user_id)`.
  - New `src/net/Ladder.tsx`; `src/net/LiveApp.tsx` (route).
  - New `supabase/tests/ladder.test.ts`, `supabase/tests/season.test.ts`, `src/net/Ladder.test.tsx`; `e2e/app.spec.ts`.
- **Depends on.** P1-12.
- **Estimate.** 4 hd · M (≈ 2.7 h).
- **Acceptance tests.**
  - `supabase/tests/ladder.test.ts › only eligible players appear; exactly 10% abandonment excludes`.
  - `supabase/tests/ladder.test.ts › pages of 50 over 1,000 players have no gaps or repeats`.
  - `supabase/tests/ladder.test.ts › this month lists players with a rated match this UTC month, with month-only matches, win rate and trend`.
  - `supabase/tests/season.test.ts › a simulated 200-player, 5,000-match season ranks players by true skill with Spearman > 0.8`.
  - `src/net/Ladder.test.tsx › columns and "X matches to go" for a provisional viewer`.
  - `e2e/app.spec.ts › the ladder paginates, has no serious axe violations and fits 320 px`.
- **Riskiest assumption → check.** That PGlite `EXPLAIN` matches hosted Postgres 17 plans. Record the plan from PGlite, and ask the DBA to `EXPLAIN` on production read-only (Prompt 4 does this).
- **Cut line.** All-time first; this month second.
- **Review fold-in.** DBA §2 (ladder query and indexes).

### P1-15 · Public profile

**Status 2026-10-10: built** (this branch). `/u/<username>` with a Worker link preview (escaped, edge-cached); `#u/<username>` with rating ± RD and its graph, volume, abandonment, sanctions "None", accuracy, and the last 20 rated matches linking to `#match/<id>`, a public hand-by-hand review that shows only showdown cards. Edit profile is not built (cut line). Details: SDE log §P1-15/16.

- **Goal.** `/u/<username>` (share URL) and `#u/<username>` (in-app). Shows rating ± RD over time, a provisional badge, accuracy (P1-10 fills it), volume, abandonment rate, the last 20 matches with review links, the sanctions field (empty until P1-18), and the optional fields. The optional fields are country and bio ("studying / where you work"); the avatar is the initial (no uploads, R-26).
- **User-visible outcome.** A shareable profile and an "Edit profile" form.
- **Files.**
  - `wrangler.jsonc`: `run_worker_first` adds `/u/*`.
  - `worker/src/index.ts`: `/u/:username` serves `dist/index.html` through `ASSETS` with `HTMLRewriter` OG tags; the username is escaped; unknown → 404.
  - `src/App.tsx`: `/u/<name>` → `#u/<name>` on load.
  - New `src/net/profile/Profile.tsx`, `src/net/profile/EditProfile.tsx`; `src/net/players.ts` (`country`, `bio`; columns and grants exist).
  - New `worker/test/profile.test.ts`, `src/net/profile/Profile.test.tsx`; `e2e/app.spec.ts`.
- **Depends on.** P1-14, P1-05.
- **Estimate.** 4 hd · M (≈ 2.7 h).
- **Acceptance tests.**
  - `worker/test/profile.test.ts › GET /u/alice returns the app with og:title "alice · QuantPoker" and the rating in og:description; unknown user 404`.
  - `worker/test/profile.test.ts › a username or bio cannot inject markup into meta tags`.
  - `src/net/profile/Profile.test.tsx › shows rating ± RD, provisional badge, matches, abandonment rate and 20 matches linking to #review/<id>/1`.
  - `src/net/profile/Profile.test.tsx › match cards show opponent cards only where shown`.
  - `e2e/app.spec.ts › /u/<name> renders, is axe-clean and fits 320 px`.
- **Riskiest assumption → check.** That `run_worker_first` with `/u/*` plus `ASSETS.fetch` plus `HTMLRewriter` coexists with hash routing. Spike in `wrangler dev` (20 min).
- **Cut line.** The profile ships; editing can follow.
- **Review fold-in.** Security item 5 (profile exposure).

### P1-16 · Share card, Method page, and counting external views

**Status 2026-10-10: partly built** (this branch). The share card `public/og-default.png` (static, the cut line), the `#method` page and the Share button are built. **Counting views from outside the app is not built.** The PM metric stays "needs instrumentation" until a follow-up adds `profile_views`.

- **Goal.** OG share card; `#method` page with formulas and versions (`glicko2.v1`, τ, provisional rule, draw band, eligibility, accuracy label and model version, what is not measured). Count profile views from outside the app, and share clicks.
- **User-visible outcome.** A LinkedIn preview of the profile; a Share button; Method linked from the profile and ladder.
- **Files.**
  - `worker/src/index.ts`: an external view counts when there is no same-origin `Referer` and no bot UA.
  - New `supabase/migrations/<ts>_profile_views.sql`: `profile_views(user_id, day, views, shares)`; RPCs for `service_role`; the owner can read their own counts.
  - New `src/info/Method.tsx` (lazy); `src/net/profile/Profile.tsx` (Share copies the link and POSTs `/api/profile/share`).
  - `public/og-default.png`.
  - Tests in `worker/test/profile.test.ts`, `supabase/tests/profile.test.ts`, `src/info/Method.test.tsx`.
- **Depends on.** P1-15.
- **Estimate.** 3 hd · M (≈ 2.0 h).
- **Acceptance tests.**
  - `worker/test/profile.test.ts › an external GET counts one view; same-origin and bot requests do not`.
  - `supabase/tests/profile.test.ts › views upsert per day; only service_role writes; owners read only their own counts`.
  - `src/info/Method.test.tsx › states glicko2.v1, τ, the provisional rule, the ±2 bb draw band and the accuracy label`.
  - `worker/test/profile.test.ts › og:image points at the share card`.
- **Riskiest assumption → check.** A dynamic PNG per player in a Worker needs resvg or satori WASM (size and CPU). Cut line first: a static `og-default.png` with dynamic text. Spike the dynamic image only if there is time.
- **Cut line.** Static image plus dynamic title and description.
- **Review fold-in.** Security item 5 (view-count abuse).

### P1-17 · Report a match

- **Goal.** One-click report from the review of a finished rated match: one per reporter per match, at most 10 per day, triaged weekly, SLA computable.
- **User-visible outcome.** A "Report" button with an optional note; it then reads "Reported".
- **Files.**
  - New `supabase/migrations/<ts>_reports.sql`: `reports(id, match_id, reporter_id, reported_id, reason in ('cheating','payout','other'), note ≤ 500, created_at, reviewed_at, reviewer_note, outcome)`, unique `(match_id, reporter_id)`.
    - Insert is allowed only for an authenticated participant of a finished rated match, never about themselves; a daily cap trigger applies.
    - Reporters read their own rows; `service_role` reads everything.
  - New `src/review/ReportButton.tsx`.
  - New `scripts/reports.mjs`: read-only triage list with age; takes the key from env and never prints it.
  - New `scripts/reports-resolve.mjs` (needs `--confirm`).
  - New `supabase/tests/reports.test.ts`; `e2e/live.spec.ts`.
- **Depends on.** P1-05.
- **Estimate.** 3 hd · H (≈ 1.4 h).
- **Acceptance tests.**
  - `supabase/tests/reports.test.ts › a participant reports a finished rated match once; a second report is refused`.
  - `supabase/tests/reports.test.ts › reports on a match you were not in, an unfinished match, yourself, or as anon are refused`.
  - `supabase/tests/reports.test.ts › the 11th report in a day is refused`.
  - `supabase/tests/reports.test.ts › a reported player cannot read reports about them`.
  - `e2e/live.spec.ts › a player reports from the review of a finished match`.
- **Riskiest assumption → check.** That RLS `with check` can see the match status and participants (subquery against `matches` and `match_players`). PGlite test first.
- **Cut line.** None.
- **Review fold-in.** Security (abuse), DBA (RLS matrix).

### P1-18 · Manual sanctions and appeals

- **Goal.** A logged, manual sanction: a profile flag, a rating reset, or ladder removal. One appeal per sanction. Nothing automatic.
- **User-visible outcome.** The profile shows "Sanctioned · <kind> · <date>"; a sanctioned player sees an "Appeal" field once.
- **Files.**
  - New `supabase/migrations/<ts>_sanctions.sql`: `sanctions(id, user_id, kind in ('flag','rating_reset','ladder_removal'), reason, decided_by, decided_at, appeal_text, appeal_at, appeal_outcome)`, publicly readable.
  - RPC `apply_sanction(p)` for `service_role`: the reset appends a `rating_history` row of kind `reset`.
  - RPC `appeal_sanction(id, text)`: own row, once.
  - `ladder()` v2 (from P1-14) excludes active removals.
  - New `scripts/sanction.mjs` (`--confirm`); `src/net/profile/Profile.tsx`.
  - New `supabase/tests/sanctions.test.ts`.
- **Depends on.** P1-15 (`ladder()` order: P1-14 → P1-18).
- **Estimate.** 3 hd · M (≈ 2.0 h).
- **Acceptance tests.**
  - `supabase/tests/sanctions.test.ts › apply_sanction is service_role only`.
  - `supabase/tests/sanctions.test.ts › rating_reset restores the provisional default and appends history; ladder_removal hides the player from ladder()`.
  - `supabase/tests/sanctions.test.ts › a player appeals their own sanction once and nobody else's`.
  - `src/net/profile/Profile.test.tsx › a sanctioned profile shows kind and date`.
- **Riskiest assumption → check.** That a reset can coexist with append-only history (the trigger allows inserts only). Covered by the first test.
- **Cut line.** None.
- **Review fold-in.** Security, DBA.

### P1-19 · Every graded mistake links to a lesson; every lesson links to rated play

- **Goal.** Map decision type × grade class to curriculum routes; each mapping is either a lesson or an explicit "none yet". Link each graded mistake in review to its lesson, with the situation pre-loaded where the lab supports it. End every unit with "Play a rated match".
- **User-visible outcome.**
  - "Mistake · river call → Pot odds" opens the lesson.
  - Finishing a unit shows "Play a rated match".
- **Files.**
  - New `src/learn/lessonMap.ts`: data, plus a gap list for what Learn does not teach. Targets are `LESSON_IDS` in `src/lib/storage.ts` (`equity`, `pot-odds`, `variance`, `ranges`, `options`, `insurance`) and unit or lab routes in `src/curriculum/core/routes.ts`.
  - New `src/learn/lessonMap.test.ts`; `src/review/ArchiveReview.tsx`; `src/curriculum/Curriculum.tsx` and `src/components/learn/LearnView.tsx` (the CTA).
- **Depends on.** P1-06, P1-09.
- **Estimate.** 3 hd · M (≈ 2.0 h).
- **Acceptance tests.**
  - `src/learn/lessonMap.test.ts › every grade class × decision type maps to a parseable route or is explicitly "none yet"`.
  - `src/review/ArchiveReview.test.tsx › a river-call Mistake links to the pot-odds lesson`.
  - `src/curriculum/Curriculum.test.tsx › finishing a unit shows "Play a rated match" linking to #lobby`.
- **Riskiest assumption → check.** Whether any curriculum lab accepts a spot through the URL. Read `src/curriculum/core/routes.ts` and the experiences (30 min). If none does, the cut line applies.
- **Cut line.** Links without a pre-loaded situation.
- **Review fold-in.** None expected.

### P1-20 · "What to review first"

- **Goal.** The end screen and review lead with each player's three biggest EV losses, each linked to its lesson.
- **User-visible outcome.** "Grading…" turns into three swings with links, usually within a minute.
- **Files.** New `supabase/migrations/<ts>_swings.sql` (`match_swings(match_id)`: top 3 `ev_lost` per player, finished matches only); `src/net/MatchEnd.tsx` (polls every 3 s for up to 60 s); tests.
- **Depends on.** P1-19, P1-04.
- **Estimate.** 2 hd · M (≈ 1.4 h).
- **Acceptance tests.**
  - `supabase/tests/grades.test.ts › match_swings returns the three largest losses per player only after finish`.
  - `src/net/MatchEnd.test.tsx › shows "Grading…" then three swings with lesson links`.
- **Riskiest assumption → check.** Grading latency after the last hand. Measure it during P1-09's `wrangler dev` run.
- **Cut line.** Swings on the review page only.
- **Review fold-in.** DBA (function).

### P1-21 · Metrics pack

- **Goal.** Every PM success metric (§Success metrics) is one read-only query, honest about "insufficient data". No migration, no production writes: you run the files in the Supabase SQL editor.
- **User-visible outcome.** For you: `supabase/metrics/*.sql` plus a README table.
- **Files.** New `supabase/metrics/*.sql` (one file per metric); new `supabase/tests/metrics.test.ts` (runs every file on an empty database and on the simulated season from P1-14).
- **Depends on.** P1-16, P1-17, P1-13 (their columns).
- **Estimate.** 3 hd · M (≈ 2.0 h).
- **Acceptance tests.**
  - `supabase/tests/metrics.test.ts › every metric returns "insufficient data" on an empty database`.
  - `supabase/tests/metrics.test.ts › on the simulated season, predictive validity at a gap ≥ 150 uses before-ratings from rating_history`.
  - `supabase/tests/metrics.test.ts › week-4 retention counts rated matches in days 21–27 after signup`.
  - `supabase/tests/metrics.test.ts › the verified-domain share reads auth.users and auth.identities only through the service role`.
- **Riskiest assumption → check.** That `auth.identities` exists in the PGlite stub. Extend the stub; the shape follows Supabase's docs.
- **Cut line.** The metrics whose data exists at launch first.
- **Review fold-in.** DBA (query cost).

### P1-22 · Ladder launch gate

- **Goal.** Turn rated play on for everyone, with evidence. Update the Fair Play page to describe exactly what now exists.
- **User-visible outcome.** The rated ladder is live.
- **Files.**
  - `src/info/InfoPages.tsx`: report, sanctions, method link; the duplicate disclosure if Q1 = A.
  - `scripts/smoke-ws.ts`: `--rated`.
  - `README.md`.
  - New `.10x/reviews/<date>-ladder-launch.md`.
- **Depends on.** All P1 tickets; S7-11; your go-ahead.
- **Estimate.** 2 hd · M (≈ 1.4 h).
- **Acceptance tests.**
  - On `wrangler dev`, `npm run smoke -- --rated` runs a 40-hand rated match with a DO restart mid-segment. It must end with the right result, archived rows, `verified` hands, grades and one rating update.
  - A 500-hand smoke has 0 commitment failures.
  - `e2e/app.spec.ts › Fair Play describes reports and sanctions`.
  - One production rated match between your two accounts, after your go-ahead.
- **Riskiest assumption → check.** That nothing in production differs from `wrangler dev` (queues, secret, CPU). S7-11 has already proven the path.
- **Cut line.** None.
- **Review fold-in.** All reviews must be closed.

---

## Phase 2: 6-max casual, then rated arenas

### P2-01 · 6-max engine gate

- **Goal.** Hard gate 1: 0 failures over ≥ 100k random 6-max hands against the reference (chip conservation, side-pot sums, legal sets, award order, odd chip), plus crafted cases.
- **User-visible outcome.** None for players. The 6-max hard gate is green and on record.
- **Files.** `src/engine/engine.test.ts`, `src/engine/testing.ts`, `src/engine/pots.ts` (`referencePots`).
- **Depends on.** Nothing.
- **Estimate.** 2 hd · H.
- **Acceptance tests.**
  - `src/engine/engine.test.ts › 6-max: all-ins on three streets with odd-chip splits award in order`.
  - `src/engine/engine.test.ts › folded dead money stays in the pot it entered`.
  - `src/engine/engine.test.ts › a short stack all-in below the big blind`.
  - `ENGINE_SOAK=1 › 100k hands at 6 players with 0 failures` (run log in the SDE log).
- **Riskiest assumption → check.** That reference coverage is thin. Count the side-pot share of hands already asserted (> 1% for N > 2) before adding cases.
- **Cut line.** None.

### P2-02 · Positions with a dead button, carry-over stacks and rebuy

- **Goal.** Use the standard dead-button rule (the big blind always advances one seat; the button may be dead), written into the ADR. Stacks carry over between hands. Rebuy to 100 bb when below. A joiner is dealt in next hand without posting (R-20).
- **User-visible outcome.** Blinds and the button move correctly as players come and go; short stacks rebuy to 100 bb between hands.
- **Files.** `src/engine/positions.ts`, `src/engine/types.ts`, `src/engine/hand.ts`; new `src/engine/positions.test.ts`; ADR amendment.
- **Depends on.** P2-01.
- **Estimate.** 3 hd · M.
- **Acceptance tests.**
  - `src/engine/positions.test.ts › when the next big blind leaves, the big blind still advances one seat and the button may be dead`.
  - `src/engine/positions.test.ts › no one posts the big blind twice in a row or skips it after departures` — 10k random join and leave sequences.
  - `src/engine/positions.test.ts › rebuy only below 100 bb and only between hands`.
- **Riskiest assumption → check.** That the engine's `stackPolicy` already supports carry-over. Read `src/engine/types.ts` (10 min).
- **Cut line.** None.

### P2-03 · Casual 6-max table service

- **Goal.** `MatchKind 'six-casual'`: a long-lived TableDO with up to 6 seats, `sit`, `stand` and `rebuy` messages, join next hand, and hands archived per hand.
- **User-visible outcome.** A player can sit at a casual 6-max table, play, stand up and rebuy.
- **Files.** `src/shared/protocol.ts`; `worker/src/controller.ts` (`CashController`); `worker/src/table.ts`; `worker/src/lobby.ts`; new `supabase/migrations/<ts>_six_casual.sql` (`kind` check); new `worker/test/six.test.ts`; `src/engine/redact.test.ts` (new messages).
- **Depends on.** P2-02, P1-22 (`table.ts` lane).
- **Estimate.** 4 hd · M.
- **Acceptance tests.**
  - `worker/test/six.test.ts › six clients sit, play and stand with chips conserved across 200 hands`.
  - `worker/test/six.test.ts › a sit during a hand is dealt in the next hand`.
  - `worker/test/six.test.ts › sit, stand and rebuy frames carry only allowed keys`.
  - `worker/test/six.test.ts › no seat ever sees another's hole cards before showdown at N=6` — over the wire.
- **Riskiest assumption → check.** That the `match`/`record_match` model fits a session that never "finishes". Decide the `idle` close plus one `matches` row per table session in the first hour.
- **Cut line.** Rebuy can follow.

### P2-04 · 6-max clock, sit-out and reconnect

- **Goal.** 20 s per decision plus 30 s of bank per orbit; sit-out after 2 consecutive timeouts; removal after 3 orbits sitting out; 60 s reconnect keeps the seat.
- **User-visible outcome.** A visible clock with an orbit bank. Idle players are sat out, then removed. A dropped connection keeps the seat for 60 s.
- **Files.** `worker/src/deadlines.ts`, `worker/src/table.ts`; new `worker/test/six-clock.test.ts`.
- **Depends on.** P2-03.
- **Estimate.** 2 hd · M.
- **Acceptance tests.**
  - `worker/test/six-clock.test.ts › the bank refills each orbit`.
  - `worker/test/six-clock.test.ts › two timeouts sit a player out and three orbits out remove them`.
  - `worker/test/six-clock.test.ts › a reconnect within 60 s keeps the seat and cards`.
- **Riskiest assumption → check.** The definition of "orbit" with joiners. Define it as button passes and pin it in a test first.
- **Cut line.** None.

### P2-05 · N-seat table UI

- **Goal.** Six seats with the trainer's card art, chips and spring choreography; a generic seat plate (Atlas's avatar is for Atlas only); a turn indicator and timer legible on phones; keyboard parity. `toHeroGame` is retired from the live path.
- **User-visible outcome.** A six-seat table that looks and feels like the trainer, readable on a phone and playable by keyboard.
- **Files.** New `src/net/SixRing.tsx` and `src/net/SeatPlate.tsx`, CSS in `src/net/live.css`; `src/net/LiveTable.tsx`; `src/engine/project.ts`; `e2e/live.spec.ts`, `e2e/mobile.spec.ts`.
- **Depends on.** P2-03.
- **Estimate.** 4 hd · L.
- **Acceptance tests.**
  - `src/net/SixRing.test.tsx › six seats render names, stacks, bets and the active timer`.
  - `e2e/mobile.spec.ts › a six-seat table fits 320 px without horizontal scroll`.
  - `e2e/live.spec.ts › keyboard loop at a six-seat table`.
- **Riskiest assumption → check.** That `Table.tsx` (2-seat `Game` with hero at index 0) can generalise rather than fork. Spike six plates at 320 px (half a day) before choosing.
- **Spike result (PR-18).** Fork: a new ring in the online chunk, and `Table.tsx` stays as it is (ADR, "Table UI (P2-05)"). The heads-up stage's absolute oval runs 61 px past a 320 px screen, so the ring is a grid: two rows of three plates around the board up to 680 px, the oval from 681 px.
- **Cut line.** A static six-seat layout without per-seat motion polish.

### P2-06 · Side-pot chips and the 3-way all-in frame gate

- **Goal.** Side pots appear and pay out as separate chip stacks, and a 3-way all-in runout stays smooth with six seats.
- **User-visible outcome.** Separate side-pot stacks paid in award order; no stutter in multiway all-ins.
- **Files.** `src/components/table/*` motion; `e2e/motion.spec.ts`.
- **Depends on.** P2-05.
- **Estimate.** 3 hd · M.
- **Acceptance tests.**
  - `e2e/motion.spec.ts › a 3-way all-in runout with two side pots has no long frames`.
  - `src/components/table/Table.test.tsx › side pots render separately and pay out in award order`.
- **Riskiest assumption → check.** Frame budget with six animated seats on CI hardware. Run the existing frame-time test at 6 seats first.
- **Cut line.** Side pots without animation.

### P2-07 · Atlas back-fill bots (casual only)

- **Goal.** Bots keep casual tables at ≥ 3 occupied seats, are labelled "Atlas (bot)", leave when humans sit, and are never seated at rated or arena tables (R-21).
- **User-visible outcome.** "Atlas (bot)" seats fill quiet casual tables and give way to humans.
- **Files.** New `worker/src/bot.ts` (cheap multiway policy); `worker/src/table.ts` (`botTurn` deadline, `players[i].bot`); `src/shared/protocol.ts` (`bot` flag in `SeatView`, also in `HandRecordV1.seats` for the human-share metric); new `worker/test/bots.test.ts`; new `src/engine/bot-bench.test.ts`.
- **Depends on.** P2-04.
- **Estimate.** 3 hd · M.
- **Acceptance tests.**
  - `worker/test/bots.test.ts › a lone human is joined by labelled bots within 3 s and bots leave as humans sit`.
  - `worker/test/bots.test.ts › a rated or arena table refuses a bot seat`.
  - `src/engine/bot-bench.test.ts › bot decisions are legal for 10k random states and take < 20 ms CPU`.
- **Riskiest assumption → check.** The bot's CPU inside the DO (`analyzeSpot` costs 80–200 ms and would stall the clock). Bench first; use Monte Carlo with a fixed budget if needed.
- **Cut line.** None.

### P2-08 · Table list and quick-sit

- **Goal.** The lobby lists running casual 6-max tables and seats a player at the best one in one click.
- **User-visible outcome.** A table list with seats, average pot and players/hour, plus a "Quick sit" button.
- **Files.** `worker/src/lobby.ts` (registry updated by `TableDO` after each hand: seats, average pot, players/hour); new `src/net/TableList.tsx`; `src/net/Lobby.tsx`.
- **Depends on.** P2-07.
- **Estimate.** 2 hd · M.
- **Acceptance tests.**
  - `worker/test/lobby.test.ts › the table list shows seats, average pot and players/hour`.
  - `worker/test/lobby.test.ts › quick-sit picks the fullest table with a free seat`.
  - `src/net/TableList.test.tsx › lists tables with seats taken of 6 and Quick sit navigates to the table the lobby chose`.
- **Riskiest assumption → check.** Lobby wake-ups per hand. Batch the updates to one per 30 s per table.
- **Cut line.** Without players/hour.

### P2-09 · 6-max review, heads-up-at-decision grading, payout reports

- **Goal.** Every 6-max hand is reviewable with the lab for the seat played. Decisions in pots that were heads-up at that moment are graded; multiway decisions are marked "not graded". Casual 6-max players can report a wrong payout.
- **User-visible outcome.** Review shows grades where the pot was heads-up, "not graded (n multiway)" otherwise, and a "Report payout" option.
- **Files.** `src/engine/project.ts` (project an N-seat state with exactly 2 live players to a 2-player `Game`, folded chips as dead money); `worker/src/grade.ts`; `src/review/ArchiveReview.tsx` ("not graded (n multiway)"); `supabase/migrations/<ts>_payout_reports.sql` (casual 6-max participants may report reason `payout`).
- **Depends on.** P2-03, P1-09.
- **Estimate.** 3 hd · M.
- **Acceptance tests.**
  - `src/engine/project.test.ts › a 6-max hand heads-up on the flop projects to a 2-player Game whose pot includes dead money`.
  - `worker/test/grade.test.ts › multiway decisions are stored as not graded with a count`.
  - `supabase/tests/reports.test.ts › a casual 6-max participant can report reason payout for a hand they played`.
- **Riskiest assumption → check.** That dead money in the projection keeps `gradeDecision`'s pot odds right. Hand-compute one case first.
- **Cut line.** Grading after review.

### P2-10 · 6-max stats on the profile

- **Goal.** VPIP, PFR, aggression, and luck-adjusted bb/100 (all-in EV adjustment from `src/engine/luck.ts`, P2-12 or P1-02 B).
- **User-visible outcome.** The profile shows VPIP, PFR, aggression and luck-adjusted bb/100 for 6-max.
- **Files.** New `supabase/migrations/<ts>_hand_stats.sql` (`hand_stats(hand_id, user_id, vpip, pfr, aggr_actions, calls, net, adj_net)`, written by the consumer); `worker/src/grade.ts`; `src/net/profile/SixStats.tsx`.
- **Depends on.** P2-12, P2-09.
- **Estimate.** 3 hd · M.
- **Acceptance tests.**
  - `worker/test/grade.test.ts › hand_stats for a scripted hand match hand-counted VPIP, PFR and aggression`.
  - `src/net/profile/SixStats.test.tsx › shows VPIP, PFR, aggression and adjusted bb/100, and an empty state before the first 6-max hand`.
- **Riskiest assumption → check.** jsonb-heavy SQL cost if computed on read. It is computed at write instead.
- **Cut line.** Without the adjusted bb/100.

### P2-11 · Six clients, 200 hands, real browsers

- **Goal.** Six clients (scripted Node plus ≥ 2 real browsers) play 200 hands with joins, leaves, timeouts and a reconnect: chips conserved, no console errors, ack→render p95 < 150 ms at six seats (S7-05 telemetry). Safari background tabs documented. It is also the pre-check that 0 invariant failures over the first 1,000 human casual hands, read from `hands.verified` and `incidents`, gates P2-13.
- **User-visible outcome.** None directly. Evidence that six-player tables are correct and fast enough to open to the public.
- **Files.** `scripts/smoke-ws.ts` (`--six`); `e2e/live.spec.ts`.
- **Depends on.** P2-06, P2-08, P2-09.
- **Estimate.** 2 hd · M.
- **Acceptance tests.** Run evidence: 200 hands, 0 invariant failures, 0 leaks, p95 printed; `e2e/live.spec.ts › two browsers at a six-seat table`.
- **Riskiest assumption → check.** Six-seat frame size and latency. A smoke run measures both.
- **Cut line.** None.

### P2-12 · Luck-adjusted pairwise results (pure)

- **Goal.** All-in pots settled at equity; per-session results converted to pairwise results per opponent, weighted by hands shared.
- **User-visible outcome.** None directly. Feeds the 6-max rating and stats.
- **Files.** `src/engine/luck.ts` (exists if Q1 = B); new `src/rating/pairwise.ts`; tests.
- **Depends on.** Nothing.
- **Estimate.** 3 hd · M (2 hd if P1-02 B shipped `luck.ts`).
- **Acceptance tests.**
  - `src/rating/pairwise.test.ts › the hand-computed example, including a runout where the loser was 95% ahead`.
  - `src/rating/pairwise.test.ts › pairwise results are zero-sum and symmetric`.
  - `src/rating/pairwise.test.ts › an unlucky player with better decisions does not lose rating against expectation` (simulated).
- **Riskiest assumption → check.** Exact enumeration cost multiway. Bench at 3-way preflop all-in first.
- **Cut line.** None.

### P2-13 · Arenas

- **Goal.**
  - Fixed 60-minute windows on a code-defined schedule, announced in the lobby with a countdown; email or notification is a cut line (R-19).
  - An `ArenaDO` seats humans only by rating band and rebalances at hand boundaries.
  - Fewer than 4 humans → played, not rated.
- **User-visible outcome.** A scheduled "Arena" card in the lobby with a countdown. Joining seats you at a rated, humans-only table by rating band.
- **Files.** New `worker/src/arena.ts`; `wrangler.jsonc` (binding plus migration `v3`, `new_sqlite_classes: ["ArenaDO"]`); `worker/src/index.ts`; `src/net/Lobby.tsx`; new `supabase/migrations/<ts>_arenas.sql` (`kind` `six-arena`, `rated` flag); new `worker/test/arena.test.ts`.
- **Depends on.** P2-11, **and the calendar gate:** 1,000 human casual hands with 0 failures.
- **Estimate.** 4 hd · L.
- **Acceptance tests.**
  - `worker/test/arena.test.ts › 12 joiners are seated at two tables by rating band`.
  - `worker/test/arena.test.ts › leavers trigger a rebalance at the next hand boundary keeping tables within one seat`.
  - `worker/test/arena.test.ts › fewer than 4 humans → hands archived with rated false`.
  - `worker/test/arena.test.ts › bots can never join`.
- **Riskiest assumption → check.** Moving a player between `TableDO`s mid-session. Spike a `claim`/`release`-style handover (half a day).
- **Cut line.** No email; no rebalance across more than two tables.

### P2-14 · 6-max rating

- **Goal.** Glicko-2 format `six-max` fed from P2-12 per arena session; provisional until ≥ 500 rated hands; the ladder lists provisional players separately; the profile shows HU and 6-max side by side.
- **User-visible outcome.** The profile and ladder show a separate 6-max rating ± RD, marked provisional until 500 rated hands.
- **Files.** `worker/src/rating.ts`; new `supabase/migrations/<ts>_six_rating.sql`; `src/net/Ladder.tsx`; `src/net/profile/Profile.tsx`.
- **Depends on.** P2-13, P2-12.
- **Estimate.** 3 hd · M.
- **Acceptance tests.**
  - `supabase/tests/ratings.test.ts › six-max and hu ratings never mix`.
  - `worker/test/rating.test.ts › an arena session rates each player against each opponent weighted by shared hands`.
  - `supabase/tests/ladder.test.ts › 6-max provisional players appear only in the provisional section`.
- **Riskiest assumption → check.** Glicko-2 with many simultaneous pairwise results in one period. Test against a hand-computed 3-player period.
- **Cut line.** None.

### P2-15 · Arena acceptance and 6-max metrics

- **Goal.** A scripted 60-minute arena with 12 test clients across 2 tables, in the test environment only (never Atlas bots, never production), rebalancing and producing plausible ratings. Add metric files for human seat share, attendance, hands per weekly active player, and payout reports.
- **User-visible outcome.** None for players. Evidence and metric queries for 6-max.
- **Files.** `scripts/smoke-ws.ts` (`--arena`); `supabase/metrics/six_*.sql`; `supabase/tests/metrics.test.ts`.
- **Depends on.** P2-14, P2-10.
- **Estimate.** 2 hd · M.
- **Acceptance tests.** Run evidence; `supabase/tests/metrics.test.ts › 6-max metrics return insufficient data on empty and numbers on the season`.
- **Riskiest assumption → check.** Two-table rebalance timing within an hour. Use the scripted run.
- **Cut line.** None.

### P2-16 · (Recommend cut) Trainer onto `src/engine`

- **Goal.** ADR decision 1: the Atlas trainer moves from `src/lib/poker.ts` to the N-player engine.
- **User-visible outcome.** None (internal refactor).
- **Why cut.** No PM requirement asks for it. `src/lib/poker.ts` is the N=2 oracle in `src/engine/differential.test.ts`, and bots (P2-07) run in the Worker, not the trainer.
- **Estimate.** 4 hd · L, not counted in the totals. Do it only if a later feature needs the trainer at N > 2.

---

## Critical path and parallel lanes

**Critical path to the ladder** (29.7 calibrated session-hours, 45 hd):

`S7-01 → S7-02 → S7-03 → S7-04 → S7-05 → P1-01 → P1-02 → P1-03 → P1-04 → P1-12 → P1-14 → P1-15 → P1-16 → P1-21 → P1-22`

- **Before it:** the security and DBA reviews (Prompts 3 and 4), run as two parallel sessions. They change different files, except for the append-only `.10x/` close-out.
- **Off the path:** Q1 is needed before P1-00, about 13 h in. P1-00 (1.4 h) runs during S7-03…S7-05.
- **To 6-max** (after the ladder, +16.7 h): `P2-03 → P2-05 → P2-06 → P2-11 → P2-13 → P2-14 → P2-15`. P2-13 is also calendar-gated by 1,000 human casual hands.

| Lane                        | Tickets, in order                                                                                      | Owns these files (others stay out)                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **W: worker core** (serial) | S7-01, S7-02, S7-03, S7-04, S7-05, P1-01, P1-02, P1-03, P1-04, P1-12, P1-13; later P2-03, P2-04, P2-07 | `worker/src/table.ts`, `worker/src/lobby.ts`, `worker/src/deadlines.ts`, `worker/src/controller.ts`, `src/shared/protocol.ts`, `record_match` SQL          |
| **T: tooling**              | S7-06, S7-07, S7-08, then S7-09 (joins W after S7-05)                                                  | `.github/workflows/*`, `scripts/*`, `src/engine/bench.test.ts`, `package.json` scripts                                                                     |
| **C: client and pages**     | P1-07 (must finish before P1-01), S7-10, P1-05, P1-06, P1-19                                           | `src/net/LiveTable.tsx` (until P1-01), `src/App.tsx` routes, `src/info/*`, `src/review/*`, `e2e/app.spec.ts`                                               |
| **M: pure modules**         | P1-08, P1-11, P2-01, P2-12 (any time)                                                                  | `src/lib/population.ts`, `src/lib/model.ts`, `src/lib/atlas.ts`, `src/rating/*`, `src/engine/engine.test.ts`                                               |
| **G: grading**              | P1-09 (after P1-01), P1-10, P1-20                                                                      | `worker/src/grade.ts`, `worker/src/verify.ts` (after S7-03), `hand_grades` SQL; one dispatch line in `worker/src/index.ts`, coordinated with W             |
| **D: data and profile**     | P1-14, P1-15, P1-16, P1-17, P1-18, P1-21                                                               | `supabase/tests/<feature>.test.ts`, `ladder()` SQL, `src/net/profile/*`, `src/net/Ladder.tsx`; `worker/src/index.ts` routes for `/u/*`, coordinated with W |

**Files that collide and the rule for each:**

| File                                | Tickets                                      | Rule                                                          |
| ----------------------------------- | -------------------------------------------- | ------------------------------------------------------------- |
| `worker/src/table.ts` (896 lines)   | S7-01…S7-05, P1-01…P1-04, P1-12, P2-03…P2-07 | Lane W only, one at a time                                    |
| `worker/src/index.ts`               | S7-02, S7-03, S7-05, P1-09, P1-15, P1-16     | Additive route and dispatch edits; rebase before merge        |
| `src/shared/protocol.ts`            | S7-02, P1-01, P1-04, P2-03, P2-07            | Lane W order                                                  |
| `record_match` (SQL)                | S7-05 v3 → P1-01 v4 → P1-04 v5               | Strictly in this order, each from the previous merged version |
| `ladder()` (SQL)                    | P1-14 → P1-18 → P2-14                        | Same                                                          |
| `src/net/LiveTable.tsx`             | P1-07, P1-01, P1-02, P1-03, P1-04, P2-05     | P1-07 before P1-01, then lane W                               |
| `src/App.tsx` `parseRoute`          | S7-10, P1-05, P1-15                          | Lane C order                                                  |
| `wrangler.jsonc`                    | S7-03, P1-15, P2-13                          | Never in parallel                                             |
| `src/net/Lobby.tsx`                 | S7-02, S7-10, P1-01, P2-08, P2-13            | Small edits; rebase                                           |
| `src/net/profile/Profile.tsx`       | P1-15, P1-16, P1-18, P1-10, P2-10, P2-14     | Lane D order                                                  |
| `supabase/tests/migrations.test.ts` | (none after S7-03)                           | New tests in their own files                                  |
| `.10x/status.md`, `.10x/handoff.md` | every ticket                                 | Append-only close-outs                                        |

**Maximum useful parallelism is three sessions:**

- W runs throughout.
- T, then C and M, during Step 7.
- G and D during Phase 1.

More sessions mostly add merge work: every W ticket rebases over `table.ts`.

## Reconciliation (resolved here, no question needed)

| #    | Conflict                                                                                                                                                                                                                                | Resolution                                                                                                                                                                                                                                                                                                        |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-1  | PM risk table: "players only know their opponent saw them from the other side". ADR: "memory effect (a shown hand's board recurs) is inherent". Code: segment-2 index public by construction; in-match review shows own segment-1 cards | **Not resolvable here → Q1.** The PM statement is incorrect for any hand that reached a flop, and the ADR understates it.                                                                                                                                                                                         |
| R-2  | ADR Step 7 and `prompts.md` Prompt 5: build an Origin allowlist. ADR amendment (newer, explicit): "no CORS, no Origin allowlist (bearer token, never a cookie)"                                                                         | Amendment wins: not built. If the security review asks for it, it is about 1 h inside S7-02. **Superseded 2026-10-09: the Step 7 prompt asked for it explicitly; built (same origin; localhost pages only on a local server).**                                                                                   |
| R-3  | ADR CI: `deploy-worker.yml`. Amendment: Cloudflare Git integration deploys                                                                                                                                                              | No deploy workflow. S7-07 adds a read-only deploy check.                                                                                                                                                                                                                                                          |
| R-4  | Engine soak: weekly (ADR) vs nightly (Prompt 5)                                                                                                                                                                                         | Weekly, plus manual, plus PRs touching `src/engine/**`. Catches engine changes when they happen, at the lowest cost.                                                                                                                                                                                              |
| R-5  | ADR: 20-client smoke "against production". Non-negotiables: no production writes; dev tokens are absent in production by design                                                                                                         | → Q4.                                                                                                                                                                                                                                                                                                             |
| R-6  | Integrity v1 "signed hand-history ids"; nothing is signed today                                                                                                                                                                         | Interpreted: hand rows are writable only by `service_role` (`record_hand`), and every deal is committed and verifiable. That keeps the guarantee against client tampering. A detached signature only adds value once histories leave the site, so it moves to the P2 public JSON API (integrity v2). PM can veto. |
| R-7  | Forfeit "at the segment end" (PM) vs immediate (Phase 0 code and ADR)                                                                                                                                                                   | → Q2.                                                                                                                                                                                                                                                                                                             |
| R-8  | "Within ±2 bb is a draw": is the boundary included?                                                                                                                                                                                     | "Within" is inclusive: \|net\| ≤ 40 chips at 10/20 is a draw. `DRAW_BAND_BB = 2`.                                                                                                                                                                                                                                 |
| R-9  | Rematch target ≥ 25% vs ≤ 2 pairings per pair per day                                                                                                                                                                                   | An accepted rematch is a pairing; at the cap the button reads "Rematch limit reached (2 per day)". The maximum rematch rate is 50% per pair-day, so the target stays reachable.                                                                                                                                   |
| R-10 | Blinds 1/2 (PM) vs 10/20 chips, 2,000 stack (ADR, code)                                                                                                                                                                                 | Same 100 bb ratio; the UI shows bb. The code is the truth; no change.                                                                                                                                                                                                                                             |
| R-11 | Bank 60 s per segment (PM) vs per match (code)                                                                                                                                                                                          | Rated uses per segment (P1-01); casual is unchanged.                                                                                                                                                                                                                                                              |
| R-12 | PM platform P0-2 "one Node process", Colyseus, a Fly VM; ADR overview mentions Vercel; ADR `TableController` has async `onHandEnd`/`onSeatEvent`                                                                                        | The ADR amendment and the code are the truth. A one-line note was added to the PM file. P1-00 corrects the ADR's controller and deadline text.                                                                                                                                                                    |
| R-13 | Abandonment rate window unspecified                                                                                                                                                                                                     | Abandoned rated matches divided by rated matches, over the lifetime: "until it falls" works by dilution. Simplest; no window to tune.                                                                                                                                                                             |
| R-14 | Rated no-show: "abandonment counts as a loss" (PM, about in-match disconnects) vs Phase 0 no-show = void                                                                                                                                | A no-show never sat down: the match is void and not rated, but it counts in the abandonment rate. Mid-match abandonment is a loss.                                                                                                                                                                                |
| R-15 | Who can read per-decision grades                                                                                                                                                                                                        | Nobody while the match is playing; everyone after it finishes, consistent with public rated hand histories. The simplest RLS.                                                                                                                                                                                     |
| R-16 | "This month" ladder undefined                                                                                                                                                                                                           | Current rating; players with ≥ 1 rated match this UTC month; matches, win rate and trend over the month.                                                                                                                                                                                                          |
| R-17 | "Store aggregated per-action timings only; disclose" vs `decisionMs` public in `hands.record`                                                                                                                                           | One number per action is the aggregate. Its public visibility is a product choice: Q5. S7-10 discloses whatever is true.                                                                                                                                                                                          |
| R-18 | Metric "verified email domain or phone ≥ 50%" needs the P1 verified badge                                                                                                                                                               | Computed from `auth.users` email domains and `auth.identities` providers via service-role SQL (P1-21). The badge stays P1.                                                                                                                                                                                        |
| R-19 | Arena "announced by email/notification"; no email infrastructure exists                                                                                                                                                                 | Lobby countdown only. Email or notification is the cut line, recorded as a gap; no other channel is invented.                                                                                                                                                                                                     |
| R-20 | "Join = sit immediately in the next hand" vs dead-button blind-posting conventions                                                                                                                                                      | Dealt in next hand without posting (play money, casual).                                                                                                                                                                                                                                                          |
| R-21 | Bots so "no table is empty": how many?                                                                                                                                                                                                  | Fill to 3 occupied seats; bots leave as humans sit.                                                                                                                                                                                                                                                               |
| R-22 | Roadmap: Phase 1 "3–4 weeks", Step 7 "1 day"                                                                                                                                                                                            | This inventory: 34 and 11.5 builder-days. The `status.md` roadmap now points here.                                                                                                                                                                                                                                |
| R-23 | Grade casual hands?                                                                                                                                                                                                                     | Rated only. Ratings and accuracy are rated-only, and grading costs 0.5–3 s CPU per hand.                                                                                                                                                                                                                          |
| R-24 | PM lobby lists only "Play rated 1v1"; casual HU exists                                                                                                                                                                                  | Casual stays as a secondary card. The code is the truth; removing it is extra work.                                                                                                                                                                                                                               |
| R-25 | Rated vs casual pair counter                                                                                                                                                                                                            | One shared counter (the existing `pairs:<day>:<a>:<b>`, no code change). Stricter than required; revisit if players complain.                                                                                                                                                                                     |
| R-26 | PM "avatar"                                                                                                                                                                                                                             | The initial avatar already in use. No uploads (storage and moderation cost).                                                                                                                                                                                                                                      |

## Questions for you (7)

1. **Same-pair duplicate leaks segment 2. Which format should rated HU use?** **Answered 2026-10-09: (B)**, fresh decks every hand with a luck-adjusted result. P1-02 builds variant B; the variant A parts of P1-02 and the deck-reuse questions in P1-00 are dropped.
   - **What happens today.** Segment-2 hand _i_ is segment-1 deck _i_ with the button flipped. Each player therefore holds the opponent's segment-1 cards under the same board. The live table already lets you reopen every finished hand of the match, with your own cards and the board.
   - **Effect.** From the flop on, a player who looks back, or keeps notes, knows the opponent's cards, the turn and the river. Fresh commitment secrets don't change that.
   - **(A)** Keep duplicate with mitigations: secret segment-2 order, no in-match review, an asymmetry statistic for later review, and an honest Fair Play line. Note-takers still win segment 2.
   - **(B) Recommended.** Fresh decks every hand, with the result luck-adjusted by settling all-in pots at equity, the adjustment your own principle 2 already lists. There is no leak, the effort is the same, and P2-12 gets cheaper. It costs more matches to reach the same true confidence.
   - **(C)** Cross-pair duplicate (A vs B and C vs D on mirrored decks). Leak-proof, but needs 4 players queued at once, which fights the cold start.
   - **What it blocks.** P1-00 and P1-02. Not Step 7.
2. **Rated forfeit: end the match immediately after the 3rd consecutive timeout, or play on to the segment end?**
   - The PM text says "forfeit at the segment end"; Phase 0 ends at once.
   - **Recommendation: immediately.** The result (loss plus abandonment) is identical, and the opponent doesn't sit through auto-folds.
3. **Profile URL, and closing two ADR questions as built.**
   - **Recommendation:** share profiles as `/u/<username>` on `quantpoker.bbcroysalman.workers.dev` now, and buy a domain before any recruiter outreach; the path does not change.
   - **ADR Q1:** per-slot commitment stays, as built and verified.
   - **ADR Q2:** "Play a friend by link" stays visible, as built.
   - Say "no" to any of these to reopen it.
4. **Where should the 20-client load test run?**
   - Production has no dev tokens, and 20 test accounts there would be production writes.
   - **Recommendation:** a `staging` Worker environment (archive in sink mode, dev tokens on). Production then gets only the two-account check in S7-11.
   - Creating it is outward-facing, so it needs your go-ahead when S7-08 reaches it.
   - Alternatives: local `wrangler dev` only, or test accounts in production.
5. **Should per-action decision times be public in rated hand histories?**
   - Today `decisionMs` is in the public `hands.record`. Opponents can mine your timing tells from it.
   - **Recommendation: no.** Keep them server-side (in `hands_private` or a service-only column) and show only "ran out of time" publicly. This is free now (0 hands archived in production) and a data migration later.
   - If yes: S7-10 discloses it, and nothing else changes.
   - If no: add a 1 hd ticket to lane W before S7-11.

6. **Per-decision grades after a match: everyone (R-15) or the two players (Prompt 7)?** (DBA review Q-DBA-1)
   - A grade is computed from the player's hole cards, so a public "blunder" on a fold says something about the folded hand. The Terms say "Your folded cards are never published".
   - **Recommendation:** the two players of the match, until a public need appears; the public accuracy number does not need per-decision rows. The policy gains one participant clause.
   - **What it blocks.** P1-09's policy only.
7. **Delete `hands_private` 90 days after a verified hand with no open report or incident?** (DBA review Q-DBA-2)
   - It holds every folded card, and nothing needs it after the report and appeal window. It is ≈ 8% of the archive, so this is minimization, not cost.
   - It deletes data by design, so it ships only on your yes.

## Success metrics → where the number comes from

"Needs instrumentation" means the data is not recorded today; the ticket that adds it is named. Every metric's query lives in `supabase/metrics/` (P1-21) unless it is a CI test.

| Metric (PM file)                                           | Target                 | Source                                                                                                                   | Status                            |
| ---------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| Registered players (platform)                              | ≥ 300                  | `count(*) from players`                                                                                                  | Exists                            |
| Week-4 retention (platform)                                | ≥ 20%                  | `players.created_at` + `matches(kind='hu-rated', finished_at)` via `match_players`                                       | Needs `hu-rated` kind → P1-01     |
| Median HU wait at peak (platform)                          | < 60 s                 | `match_players.queue_wait_ms`; peak = the busiest 2-hour UTC window of each ISO week by pairings                         | **Needs instrumentation → S7-05** |
| Match completion (platform, HU ladder)                     | ≥ 90%                  | Matches that dealt hand 1 (`status='finished'`) with no `match_players.abandoned`                                        | Exists                            |
| Action latency p95, ack → render (platform, 6-max)         | < 150 ms               | `ack_samples.samples`, `percentile_cont(0.95)` over `unnest`                                                             | **Needs instrumentation → S7-05** |
| Invariant failures (platform, 6-max)                       | 0                      | `incidents` where `kind in ('engine_fault','verify_failed')`, plus `hands.verified = false` older than 1 h               | **Needs writes → S7-03**          |
| Profile views from outside (platform, rating)              | ≥ 100                  | `profile_views.views`                                                                                                    | **Needs instrumentation → P1-16** |
| "≥ 10 players report sharing" (rating)                     | ≥ 10                   | Proxy: distinct owners with `profile_views.shares > 0`. The literal "report" needs a survey, which is out of code scope. | **Needs instrumentation → P1-16** |
| Rated matches per weekly active player (HU)                | ≥ 3                    | Weekly active player = ≥ 1 finished match in the ISO week; rated matches ÷ players                                       | P1-01                             |
| Rematch rate (HU)                                          | ≥ 25%                  | `matches.rematch_of is not null` ÷ finished rated                                                                        | **Needs instrumentation → P1-04** |
| Post-match review opened (HU)                              | ≥ 50% of matches       | Matches with any `match_players.review_opened_at`                                                                        | **Needs instrumentation → P1-05** |
| Draw share (HU)                                            | 5–15%                  | `matches.result` outcome `draw` ÷ finished rated                                                                         | P1-01                             |
| Non-provisional HU players (rating)                        | ≥ 100                  | `ratings where format='hu' and rd < 100 and matches >= 20`                                                               | P1-12                             |
| Predictive validity at gap ≥ 150 (rating)                  | ≥ 60%                  | `rating_history` before-ratings of both players + outcome                                                                | P1-12                             |
| Spearman(rating, accuracy) (rating)                        | > 0.4                  | `ratings` × `player_accuracy()` over non-provisional players                                                             | P1-10, P1-12                      |
| Median \|Δ rating\| for non-provisional (rating)           | < 15                   | `rating_history.after − before`                                                                                          | P1-12                             |
| Analysis data during a live rated hand (integrity)         | 0                      | CI tests `worker/test/rated-leak.test.ts`, `e2e/live.spec.ts` frame tap                                                  | P1-03                             |
| Deck-commitment verification failures (integrity)          | 0                      | `incidents kind='verify_failed'`; smoke `commitments n/n`                                                                | S7-03, S7-08                      |
| Reports reviewed within 7 days (integrity)                 | 100%                   | `reports.reviewed_at − created_at`                                                                                       | P1-17                             |
| Confirmed cheating per 1,000 rated matches (integrity)     | tracked                | `sanctions` (non-flag kinds) ÷ rated matches × 1,000                                                                     | P1-18                             |
| Eligible players with verified domain or phone (integrity) | ≥ 50%                  | `auth.users.email` domain (`.edu`, `.ac.*`) or `auth.identities.provider='github'`, among `ladder()` players             | P1-21 (R-18)                      |
| Human seats at casual tables at peak (6-max)               | ≥ 60%                  | `hands.record.seats[].bot`                                                                                               | **Needs instrumentation → P2-07** |
| Arena attendance (6-max)                                   | ≥ 10 humans per window | Distinct humans per arena session                                                                                        | P2-13                             |
| 6-max hands per weekly active player (6-max)               | ≥ 50                   | `hand_holes` joined to `hands` → `matches(kind like 'six-%')`                                                            | P2-03                             |
| Confirmed wrong-payout reports (6-max)                     | 0                      | `reports reason='payout' and outcome='confirmed'`                                                                        | P2-09                             |
| Hands/day (ADR §Verified assumptions row 8)                | read without SQL       | Workers Observability saved query on `evt = "hand_end"`                                                                  | S7-04                             |

## Review fold-in

The security (Prompt 3) and DBA (Prompt 4) reviews run after this file. Each finding lands on the ticket id named in it. If a finding needs a new ticket, use the next free id in its phase, e.g. S7-12.

Every S7 and P1 ticket above has a **Review fold-in** line. Most likely to change, in order:

1. **S7-02 (limits).** Numbers, a per-IP cap, possibly an Origin check.
2. **S7-03 (verify).** Grants and retry safety.
3. **S7-04 (logs).** The `table.ts:659` full-state log is already known.
4. **S7-05 (telemetry endpoint and table).**
5. **P1-12 (ratings CAS, append-only).**
6. **P1-14 (ladder plan and indexes).**
7. **P1-09 (grade RLS by match status).**
8. **P1-17 / P1-18 (reports and sanctions RLS).**
9. **P1-01 (email claim, `record_match` v4).**

### Security review results (2026-10-09, `.10x/reviews/2026-10-09-security-review.md`)

Already fixed on this branch, so these drop out of the tickets:

- the per-socket frame budget in the lobby and tables (20 frames per 5 s, close `4429`, applied moves refunded): the core of **S7-02**;
- `verifyDeal` duplicate slots;
- dev tokens with a short secret;
- the same-account join race;
- the shared SQL harness, `supabase/tests/harness.ts`, from **S7-03**.

What each ticket gains or loses:

- **S7-01**:
  - also expire **unjoined invites** (e.g. 24 h) with an `idle` deadline armed in `init` (`worker/src/table.ts:173`) (SR-06);
  - test: `worker/test/table.test.ts › an invite nobody joins is deleted after 24 hours`.
- **S7-02**, now:
  - the illegal-move counter (`4400`);
  - `MATCH_CREATES_PER_DAY` at `worker/src/index.ts:31` (SR-06: one account made 50/50 tables);
  - a per-account upgrade rate and a username cache for `worker/src/auth.ts:53` (SR-07);
  - refuse UUID-shaped dev ids at `worker/src/auth.ts:28`, moving `worker/test/archive.test.ts` to real ES256 tokens (SR-10);
  - the client message for `4429`.

  The tests `the 21st table frame…`, `20 frames spread over 5 s…` and `21 lobby frames…` are covered by `worker/test/limits.test.ts`. The oversized frame stays an `illegal` error, not a close (`limits.test.ts › refuses an oversized frame…`). Estimate: 3 → 2 hd.

- **S7-03 / S7-04**: the invariant-failure log at `worker/src/table.ts:674` prints the full state with the deck and every hole card. It must log ids only, and the state goes to `incidents` (SR-09).
- **S7-07**:
  - pin the actions by SHA at `.github/workflows/ci.yml:11,12,26,27,35` (SR-11);
  - bump `wrangler`/`@cloudflare/vitest-plugin` once a non-alpha `miniflare` ships a fixed `sharp` (SR-12; dev only, not in the deployed bundle).
- **S7-10**: say "board and shown hands are checked" until S7-12 ships (SR-08), and state that decision times are recorded (SR-15, Q5).
- **New S7-12** (above): players can verify their own folded cards (SR-08).
- **No change** for the Origin check (R-2 stands; nothing found needs it).

**Totals after the fold-in:** S7-12 adds 2 hd and S7-02 loses 1 hd, so 135 hd in all. The critical path is unchanged; S7-12 is off it.

The DBA's `phase1-schema.md`, if written first, replaces the SQL sketches in P1-01, P1-04, P1-05, P1-09, P1-12, P1-14, P1-16, P1-17 and P1-18. The tickets keep their tests.

**DBA fold-in, 2026-10-09 (Prompt 4).** `.10x/decisions/dba/phase1-schema.md` and `supabase/proposed/phase1.sql` now exist and replace those sketches. Per ticket, beyond the sketches:

- **P1-01:**
  - `record_match` v4 also sets `match_players.finished_at` (with a backfill) and `outcome`;
  - it counts a rated no-show in `ratings.abandoned` (R-14);
  - it calls `private.refresh_accuracy` for both players at the finish;
  - the kind check ships `NOT VALID` + `VALIDATE`.
- **P1-09:**
  - `hand_grades` gains `format`;
  - `record_grades` refreshes accuracy for grades that land after the match ended;
  - visibility follows R-15 (see Q6).
- **P1-10:** accuracy is stored on `ratings` (`accuracy`, `graded`) and shown from there; `player_accuracy` is the recomputation.
- **P1-12:**
  - `ratings` gains `wins`, `draws`, `abandoned`, `accuracy`, `graded`;
  - `apply_rating` locks in `user_id` order;
  - the CAS check now runs under true concurrency (`supabase/bench/concurrency.ts`).
- **P1-14:**
  - `ladder()` reads the counters (no per-candidate aggregates);
  - `ladder_month()` covers R-16, with its materialization trigger in D6.
- **P1-17:** reporters insert directly under policy `reports_file`; the cap trigger holds a per-reporter advisory lock.
- **P1-18:** `appeal_sanction` runs with invoker rights over a one-column grant; no browser-callable security definer.

Each migration adds its rows to `rls-matrix.test.ts`. The matching self-checks in `plans.ts` are its acceptance tests.

**Status 2026-10-09 (DBA session):**

- **U-2:** done (Prompt 3 earlier; Prompt 4 now).
- **U-3:** no longer yours. Both queues are named in `wrangler.jsonc` producers, and `wrangler deploy` creates a missing producer queue. Not yet seen working: whether the Workers Builds token may create queues. If it may not, the build fails, the old version keeps serving, and `deploy-check` goes red.
- **U-6:** decided. The interim wording stays.
- **Open:** U-4, U-8, and your go (U-5).

## User gates (what only you can do)

| Id   | Gate                                                                                                                                                                                                                                                                                                                                                    | Needed before               |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| U-1  | Answer Q1–Q5 (Q1 is the only blocker)                                                                                                                                                                                                                                                                                                                   | Q1 before P1-00             |
| U-2  | Run Prompts 3 and 4 (two sessions, can be parallel)                                                                                                                                                                                                                                                                                                     | S7-11; ideally before S7-02 |
| U-3  | Create Cloudflare queues `quantpoker-hands` and `quantpoker-hands-dlq`                                                                                                                                                                                                                                                                                  | S7-03 merging to `main`     |
| U-4  | Open from Prompt 1: `SUPABASE_SECRET_KEY` set; one real sign-in and its token header; one two-account match                                                                                                                                                                                                                                             | S7-11                       |
| U-5  | Explicit go-ahead for each production deploy (S7-11, P1-22) and for any staging Worker (Q4)                                                                                                                                                                                                                                                             | S7-11, P1-22                |
| U-6  | A contact address for "how to report" until P1-17 (never inferred from your account email)                                                                                                                                                                                                                                                              | S7-10                       |
| U-8  | Security review dashboard checks: (a) Supabase → Authentication → URL Configuration has no wildcard to a foreign host; (b) Cloudflare → Worker `quantpoker` → Variables and Secrets has no `DEV_AUTH_SECRET`; (c) enable leaked-password protection, or turn off password sign-in (SR-13); (d) a WAF rate-limiting rule on `/ws/*` and `/api/*` (SR-07) | S7-11                       |
| U-9  | Enable Google sign-in: Google Cloud OAuth client (web), redirect `https://dbkfuxczfkawxqmaieii.supabase.co/auth/v1/callback`, ID and secret into Supabase → Authentication → Providers → Google (`.10x/decisions/architect/landing-and-onboarding.md` §User gates)                                                                                      | Landing page launch         |
| U-10 | Custom SMTP: Resend account + verified sending domain, set in Supabase → Authentication → SMTP Settings, raise the email rate limit; keep the API key for the Worker secret `RESEND_API_KEY` (phase 2)                                                                                                                                                  | Landing page launch         |
| U-11 | School codes by email: `npx wrangler secret put RESEND_API_KEY` and `npx wrangler secret put SCHOOL_EMAIL_FROM` (`.10x/decisions/architect/landing-and-onboarding.md` §User gates)                                                                                                                                                                      | School email verification   |
| U-7  | Merge order: `claude/zen-darwin-0t5q1p` (deploy verification) and `claude/amazing-ride-4vip4x` (prompts) also edit `.10x/`; merge them before this branch or expect a small append conflict in `status.md` and `handoff.md`                                                                                                                             | Next merge                  |
