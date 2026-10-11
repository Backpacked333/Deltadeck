# Project status

Last updated: 2026-10-11 by SDE (casual 6-max: PR-01 to PR-13, PR-18 and PR-19 live in #34 to #49, still unreachable from outside behind the exposure gate; PR-14 and PR-15 in progress). Earlier: landing page phases 1 and 2 (#30); rating P1-12 to P1-16 live; hands of a live match closed to clients; S7-11 waits on U-4

**Standing instructions from the user (2026-10-09):**

- **Merge when green.** Open a PR for each finished piece and merge it to `main` once CI passes. A merge deploys to production, so verify the deploy after each one.
- **Q1 is answered: B.** Rated heads-up uses fresh decks every hand, with the result luck-adjusted by settling all-in pots at equity.

## Landing v2: cinematic 3D (2026-10-10)

- **Approved design:** `.10x/specs/2026-10-10-landing-3d-design.md` and ADR-001.
- **Built and verified (SDE, QA, security):**
  - the 3D stage;
  - the beats;
  - How it works and Your free account;
  - the account CTAs in the header and on the score card;
  - phone tuning.
- **Tests:** 918 unit and 35 e2e pass, including the 3D path. Three lobby Worker tests fail on `main` too, locally.
- **Next:** PR, CI, merge (standing instruction).

## Landing page and onboarding (2026-10-10)

- **Scoped (PM) and designed (architect), scope B / design B:** `.10x/decisions/product-manager/landing-and-onboarding.md`, `.10x/decisions/architect/landing-and-onboarding.md` (see its §As built).
- **Phase 1 built (SDE), PR #30, not merged:**
  - the landing page with six pre-scored challenge hands and the score card;
  - `ScoreDO` with `/api/challenge/score`, `/api/events`, `/api/challenge/claim` and `/api/funnel`;
  - migration `20261010110000_landing.sql` (school badges, `challenge_scores`);
  - `#welcome/onboard` (score claim, username, school, first move).
- **Checks run locally:** 883 unit, 200 worker, 120 SQL and 33 e2e tests; entry bundle 142.9 kB of 150.
- **Before launch (yours):**
  - U-9 Google sign-in;
  - U-10 custom SMTP;
  - U-4 for claimed scores to reach Postgres.

  Merging #30 launches the landing page and applies the migration to production.

- **Phase 2 built, same PR:**
  - `/c/<receipt>` share links with a link preview (L-12);
  - the friend challenge on the same hand (L-13);
  - school codes by email (L-14, migration `20261010120000_school_email.sql`, needs U-11).

  Checks run locally: 893 unit, 212 worker, 126 SQL and 33 e2e tests; entry bundle 143.0 kB.

## Phase 1 progress (2026-10-10)

Merged and deployed, each one verified in production after its merge:

- **PR #10 (`811c1e6`):** the Glicko-2 rating module (P1-11), the launch evidence, and the Q1 = B decision.
- **PR #11 (`a9272a7`):**
  - luck-adjusted results in the engine (P1-02);
  - archive calls that can never succeed are parked with an incident (S7-13);
  - the rated-match design: the ADR amendment, P1-00.
- **PR #12 (`6d1bad4`), the rated-match archive (P1-01, database).** Production recorded `20261010010000 rated_matches` through the Supabase integration on merge, and a read-only check confirmed the final `record_match` v4 body. It also fixed a flaky address-limit test at its cause: the burst straddled a wall-clock minute window.

**PR #13 (`c7c2558`), the rated match in the table server (P1-01b-1).** The deployed Worker code was confirmed through the Cloudflare connector, because `verify-deploy` cannot see Worker-only changes. **PR #14 (`485f998`): the 60 s grace and the both-gone void (P1-01b-2).** **PR #15 (`c6abcee`): the rated queue behind the confirmed-email gate, and the outcome in the end text (P1-01b-3).** **PR #16 (`e8ca36e`): the lobby's Rated card and the match bar (P1-01c).** **Rated play is live:** a signed-in player with a confirmed email can play rated from the lobby. Matches are archived only after U-4.

- 40 fresh-deck hands, with the bank refilling at hand 21.
- The luck is settled after each hand, and the archived record carries it.
- The outcome comes from the luck-adjusted total and the ±2 bb draw band. A forfeit is a loss.
- It also fixes a pre-existing outbox race that could strand a match's result.
- Nobody can start a rated match yet: the lobby queue opens in P1-01b-3, after the grace rule (P1-01b-2). Then comes the UI (P1-01c).

**PR #17 (`d042683`), nothing to analyse on a rated table (P1-03).** A rated table no longer draws the equity ring or the break-even figure. A full 40-hand rated match is proven to send no analysis key and no unshown opponent card, and the frame allowlists are compiler-checked against the protocol. Production serves the build (`verify-deploy`).

**PRs #18 (`cfd0bd0`) and #19 (`6a79a93`): end of match and rematch (P1-04).**

- **#18:** `matches.rematch_of` and `record_match` v5. Recorded in production and checked read-only.
- **#19:** after a rated match, both players can press Rematch within 60 s for a new rated match with seats swapped, within 2 pairings per pair per day. The end panel reads "+12.5 bb · Win", the luck-adjusted total. A reload after the end shows the result again.
- **Deploy:** production serves the build (`verify-deploy`), and the deployed Worker carries the new code.
- **Your call:** one Devin finding about rematch links lost in long archive outages is open on #19 (decline recommended).

**PRs #20 (`33eae10`), #21 (`3ec0f0b`) and #23 (`989ed07`): accuracy against a model opponent (P1-08, P1-09).**

- **#20:** the population opponent model, with repeatable, key-seeded analysis tables.
- **#21:** `hand_grades`. Nobody reads a grade mid-match; afterwards only the match's two players do. `record_grades` refuses unverified and casual hands.
- **#23:** the grading consumer, which grades every move of a rated hand after verification, and the per-decision pot. Production holds migrations `20261010053000` and `20261010060000` (checked read-only), the deployed Worker carries the consumer, and `verify-deploy` passed.
- **QA attack** (`.10x/reviews/2026-10-10-qa-report.md`):
  - leaving moves to the clock dodged grading; fixed;
  - a plain mean barely separates raising every street from a thinking player; measured and documented, with the pot stored for the real-data comparison.

  The mission's sanity order holds.

**PR #24 (`c69fbf1`): accuracy, its grade distribution and luck versus skill (P1-10).** Live and verified.

**PRs #25 (`ba8ffaf`) and #26 (`a3b9aed`): the rating (P1-12, P1-13).**

- **#25:** a finished rated match changes both Glicko-2 ratings once (`ratings`, an append-only `rating_history`, `apply_rating` with compare-and-set). The end screen shows "Rating 1520 → 1534 (+14): beat a 1610 ± 80 player". Production holds `20261010080000` (checked read-only: anon cannot apply, the abandonment trigger is present). The Worker carries the rating outbox, and `verify-deploy` passed. No rated match had finished before the deploy, so none is unrated.
- **#26:** rated quick-match pairs the closest rating within 100 + 50 per minute of waiting, re-pairing every 15 s, under the 2-a-day pair cap. Devin found a real race (a search cancelled during the rating read could come back as a ghost), fixed in the same PR. The deployed Worker carries both, and `verify-deploy` passed. Simulated median wait: 29 s at 10 players online.

**PR #27 (`f27a364`): the ladder, the metrics query and a simulated season (P1-14).** `#ladder` and `#ladder/month` are public. Production holds `20261010090000`, checked read-only: the functions, `played_at` with two indexes, and the append-only trigger back on. `verify-deploy` passed. `supabase/metrics/rating-metrics.sql` reports "insufficient data" on production today. Devin's month-boundary finding (a match rated after midnight counted in the next month) was fixed before the merge.

**Casual 6-max (P2-01 to P2-05): in progress, 2026-10-11.** Plan: `.10x/decisions/engineering-manager/six-max-casual.md`; design: the ADR amendment in `.10x/decisions/architect/multiplayer-platform.md`.

- **Live (each merged green and its deploy verified):**
  - engine blinds, dead button, orbits and rebuy maths (#34, #35, #39, #40);
  - the `six_casual` migration and `record_hand` v2, applied to production and checked read-only (#41);
  - review pages named from `record.seats` (#42) and the `CashController` (#43);
  - sit and play (#44);
  - the six-seat ring (#45);
  - stand up and one table per account through lobby claims (#46);
  - sessions in the archive with rotation and cleanup (#48);
  - the six table in the live UI (#49).
  - #47 fixed two Supabase tests that timed out under load: their database boot moved into a hook.
- **Exposure gate:** no route creates a six table yet. The invite route sends no `kind`, the lobby queue refuses `six-casual`, and init refuses a six table with an opponent. The gate stays shut until PR-14 (rebuy) and PR-16 (sit-out and removal) land; PR-12 (claims) is in.
- **Next:**
  - PR-14 (rebuy, with the Rebuy and Stand up controls the plan lacked) and PR-15 (orbit bank) are being built;
  - then PR-16 (sit-out and removal, with the Sit out and Sit in controls) and PR-17 (60 s reconnect);
  - then PR-21 and PR-22 (side-pot display, chip motion), PR-23 to PR-25 (table registry, quick-sit, table list: these open the gate) and PR-26 (smoke evidence).
- **Open for the user:** Devin's security threads, fixed and replied to but left open for the owner: two on #46, and one on #44 that #46 closed.

**6-max arenas (P2-13/P2-14): stopped at the pre-check, 2026-10-10.** 100,000 simulated 6-max hands with 0 failures; 0 of the 1,000 human casual 6-max hands the gate needs, because casual 6-max is unbuilt and production archives nothing until U-4. Path: `.10x/decisions/architect/six-max-arena.md`.

**PR #29 (merged, verified live): P1-15/16.** `/u/<username>` with a link preview, the profile at `#u/<username>`, the public match review at `#match/<id>` (showdown cards only), the `#method` page and the share card. Counting profile views from outside the app is **not built**, so that PM metric needs instrumentation.

**Hands of a live match (Devin, #29; approved by the user).** Migration `20261010100000_hands_after_match.sql` adds a restrictive SELECT policy: no client role (anon or signed in, players included) reads `hands` of a match whose status is `playing`; they open the moment it is finished or void. A player's own `hand_holes` stay readable. `/api/stats` counts such hands once the match ends. Tests: `supabase/tests/hands-live.test.ts`; bench Q8c.

Q2 (when the third timeout forfeits) is unanswered. The build uses the recommendation, "immediately", which one rule can reverse.

## Phase

**Phase 0 milestone reached: two browsers play each other through the Worker.** Steps 1–6 of 7 done: quick-match lobby, shot clock with time bank and forfeit, provably fair deals ("Deck verified" in the browser), every hand archived to Postgres. Hosting is one Cloudflare Worker for site + game server; see the ADR amendment.

**Step 7 deployed 2026-10-09 23:31 UTC (PR #9 merged as `3cc9bd0` on your go).** Production serves the build, verified file by file, and both GitHub checks on `main` are green. Launch evidence: `.10x/reviews/2026-10-09-launch-verification.md`. The server now survives strangers and shows its failures:

- per-account frame and connect limits, oversize and illegal-frame closes with documented codes, invite caps and expiry, an address rate limit, and an Origin allowlist;
- every archived hand re-verified off the game path by a queue consumer, with incidents for anything that fails;
- card-free JSON logs with a sink test, hands/day at `/api/stats`, and a runbook;
- a CPU bench, pinned and least-privilege CI, a nightly seeded engine soak, a live-e2e guard and a deploy check;
- a 20-client smoke: 500 hands, p95 17 ms, 0 breaks;
- a chaos pass with 5/5 rows VERIFIED;
- players can verify their own folded cards;
- Fair play and Terms pages.

**Deploy prerequisites, 2026-10-09 (done in this session):**

- the DBA review ran;
- both new migrations are applied to production (`20261009213919 verify_hand`, `20261009213923 hands_created_index`);
- `wrangler deploy` now creates both queues itself;
- the Fair play report wording stays as written.

Still yours:

- **U-4:** the Worker's `SUPABASE_SECRET_KEY`, one real sign-in and one two-account match. Until then nothing is archived, and S7-11's last four rows stay open.
- **U-8:** the dashboard checks.

**DBA review 2026-10-09 (`.10x/reviews/2026-10-09-dba-review.md`):** no Critical or High open.

- **DB-1 (Medium) fixed and live.** `/api/stats` counted hands with full table scans, under a 3 s `anon` timeout. It now reads an index: 0.03 ms at 1M hands.
- **Retry safety proven** for repeats, failures part-way and reordering (PGlite), and for two sessions at once on a real PostgreSQL (8/8).
- **The Phase 1 schema is designed and measured** at 10k, 100k and 1M (`.10x/decisions/dba/phase1-schema.md`, `supabase/proposed/phase1.sql`; not applied). Eight defects in its first draft were fixed before anyone builds on it, including missing access rules.
- **Growth:** 4.9 kB per hand now, 6.5 kB with grades. The 8 GB disk lasts about 3 years at 1k hands/day.
- **New:** ticket S7-13 (Low), and questions Q6 and Q7 in tickets.

**Tickets 2026-10-09 (`.10x/tickets.md`):** the remaining plan is 49 tickets: Step 7 is 11, Phase 1 is 23, Phase 2 is 15. That is 134 half-days, about 90 session-hours at the measured Phase 0 pace. The ladder's critical path is 29.7 h; earliest ladder date 2026-10-13, planning date 2026-10-19. **Q1 is answered (B, 2026-10-09):** the same-pair duplicate format would let a player see the opponent's segment-2 cards, so rated play uses fresh decks with a luck adjustment.

**Security review 2026-10-09 (`.10x/reviews/2026-10-09-security-review.md`):** one High, three Medium and one Low fixed with red-then-green tests:

- lobby frame flood (High) and table frame flood (Medium);
- deck reveals that could hide a re-dealt card (Medium);
- dev tokens accepted with a short secret (Medium);
- the same-account join race (Low).

No Critical or High is open. Three Mediums are now Step 7 tickets: invite spam and storage growth, connection floods, and own folded cards being unverifiable (new S7-12). Held, with tests: auth, seat integrity, every frame type, a byte-equality side-channel test, and the full database access matrix. Four dashboard checks are yours (U-8 in tickets).

Supabase project `quantpoker` also carries an earlier line of work's schema (`20261007192620_learning_cloud`: `profiles`, `hand_results`, learning tables, AI-coach usage; all tables empty). Its migration file is now in the repo, byte-identical to production, so the repo and the live database have the same migrations (9 since 2026-10-09; the repo files carry the versions production recorded). Multiplayer tables are additive beside it.

## Repository (cleanup 2026-10-09)

- Default branch becomes **`main`** (the old default `devin/1791351254-quantpoker-learning-table` is renamed in GitHub settings, keeping its history). Cloudflare Workers Builds and the Supabase GitHub integration deploy from `main`. Vercel is retired.
- PR #8 (multiplayer Phase 0) lands as **one squash commit**; its 20 step commits stay readable on the PR page (`refs/pull/8/head`).
- PR #2 (Devin's earlier app line: AI coach, older learning studio, Vercel cloud saves) is **closed, not merged**; superseded by PR #7 and #8. Kept as `archive/context-aware-coach`, `archive/cinematic-poker`, `archive/supabase-vercel` and `refs/pull/{2,3,6}/head`. Pieces that exist only there, for a possible later port to the Worker: the AI coach (`server/coach.ts`, `src/lib/coach.ts`, `coach-stream.ts`) and the 3D terrain frontier/slice/camera (`Surface.tsx`, `terrain-camera.ts`).
- PR #5 (curriculum focus, atomic-save and memo fixes) is merged into `main`.
- All other branches had their content in the default branch already (checked by ancestry, patch equivalence and file content) and are deleted; tips archived as `archive/*` tags. A full mirror bundle of the repo before the cleanup was given to the user.
- Devin stays installed with PR monitoring turned off.

Note: `.10x/` was created this session. Discovery of the codebase was done inline by the PM (`[DISCOVERED]` entries in `.10x/decisions/product-manager/_index.md`) and verified by the Architect's design workflow. CTO strategic review has not run; the one build-vs-buy call (Cloudflare Durable Objects vs. a Node server vs. Supabase-only) was made by the user directly.

## Initiative

"Multiplayer QuantPoker": real online play-money poker between humans, chess.com-style rating + accuracy, public ladder/profile for quant talent. Two formats: heads-up duplicate and 6-max. Solo builder, AI-assisted, ship ASAP. Growth bet: curiosity + learning quant thinking through play; recruiters come months later.

## Stack (decided)

Site + game server: one Cloudflare Worker `quantpoker` (Workers Paid, Git-connected): static assets from the Vite build, `/api/*` and `/ws/*` to the Worker; Durable Objects (`TableDO` per match, `LobbyDO` singleton from Step 6), SQLite-backed, WebSocket hibernation, alarms. Auth + archive: Supabase project `quantpoker` in the Pro org "Quant Poker" (us-east-1, Postgres 17), ES256 JWTs verified in the Worker with `jose`. Grading (Phase 1): Cloudflare Queue consumer in the same Worker.

## Roadmap

| Phase             | Feature slugs                                                                                          | Exit criteria                                                                                                                                                                                            | Effort                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 0 — Foundation    | `multiplayer-platform`                                                                                 | Two browsers play a full HU match through the deployed Cloudflare Worker (site + game server; day-10 milestone); engine invariant suite green N=2..6; lobby quick-match; commitment + records; CI/deploy | 15 working days + 3 reserve (see ADR §Migration path); Step 7 re-estimated at 11.5 builder-days (≈ 14 h) in `.10x/tickets.md` |
| 1 — HU ladder     | `heads-up-duplicate-ladder`, `rating-and-leaderboard` v1, `integrity-and-trust` v1, review→lesson loop | Rated duplicate matches, Glicko-2 ± RD, accuracy, profile, ladder                                                                                                                                        | 3–4 weeks (tickets: 34 builder-days, ≈ 45 h)                                                                                  |
| 2 — 6-max         | `six-max-tables` casual + rated arenas, 6-max rating                                                   | 6 seats, N-seat `Table`, arenas, provisional rating                                                                                                                                                      | 3–4 weeks (tickets: 21.5 builder-days, ≈ 30 h)                                                                                |
| Later (triggered) | `integrity-and-trust` v2                                                                               | Fires on ≥1,000 players, first recruiter inbound, first credible cheating report, or a sponsored event                                                                                                   | —                                                                                                                             |

## Tasks

- [x] PM: problem, audience, constraints, success metrics; 5 feature specs; user alignment
- [x] Architect: Phase 0 system design (`.10x/decisions/architect/multiplayer-platform.md`) — engine, DOs, protocol, auth, data model, randomness/commitment, grading placement, client integration, lobby, failure modes, dev/CI, 7-step migration path, verified assumptions
- [ ] User: answer the 5 open questions in the ADR (commitment scheme, invite-link visibility, domain; the Vercel and Cloudflare-plan questions are settled: Cloudflare hosts everything) — `.10x/tickets.md` Q3 proposes closing the first three as built (per-slot commitment, link visible, `workers.dev` until a domain)
- [x] Staff Engineer / EM: tickets for Step 7, Phase 1 and Phase 2 with acceptance tests, critical path, lanes and metrics sources (`.10x/tickets.md`, 2026-10-09). Day-10 milestone was already reached in Step 4.
- [ ] User: the open questions in `.10x/tickets.md` (Q1 answered B; Q2 runs on the recommendation until you say otherwise; Q3–Q7 block nothing yet)
- [x] SDE: Step 1 — `src/engine/` + invariant, differential, redaction, commitment tests; `src/shared/protocol.ts`; `src/lib/presets.ts` (`.10x/decisions/sde/multiplayer-platform.md`). All gates green.
- [x] SDE: Step 2 — Supabase migrations applied (`players`, matches/hands archive, `record_hand`, FK index) with PGlite RLS tests; `#lobby` sign-in (email link; Google/GitHub when enabled), username, lobby shell; bundle guard; phone header fix. All gates green.
- [x] User: Cloudflare Workers Paid + Git-connected Worker; Supabase Pro org
- [ ] User: repo cleanup dashboard steps (rename default branch to `main`; Cloudflare and Supabase production branch → `main`; Cloudflare preview builds off; delete the Vercel project; Supabase Auth Site URL → workers.dev; optionally enable Google/GitHub) — see `.10x/handoff.md`
- [ ] SDE: first real sign-in on the deployed site, then decode the access token header and confirm `alg: ES256` (ADR day-5 check)
- [x] SDE: Step 3 — `worker/` + root `wrangler.jsonc`: `TableDO`, ES256 auth, invite-by-link matches, runtime `/api/config`; 9 Workers-runtime tests + a real two-client smoke run. All gates green.
- [x] SDE: Step 4 — live table in the browser (`src/net/client.ts`, `LiveTable`, `#play/<id>`, Play a friend by link); two-browser e2e against `wrangler dev`; full 20-hand match verified. All gates green.
- [x] SDE: Step 5 — turn clock + bank + auto check/fold + 3-timeout forfeit via one DO alarm; `hand_start` commitment, `hand_end` + `reveal`, in-browser "Deck verified" review; outbox → `record_match`/`record_hand` (new migration applied live, dry-run verified). 592 unit, 38 worker, 17 e2e; 20-hand smoke with a real 80 s timeout. (`.10x/decisions/sde/multiplayer-platform.md` §Step 5)
- [ ] User: create a Supabase secret key and add it to the Worker as `SUPABASE_SECRET_KEY` (until then nothing is archived)
- [x] SDE: Step 6 — `LobbyDO` quick-match (persisted queue, oldest-first pairing, ≤ 2 pairings per pair per day), one active table per account (queue resumes, invite 409/4409, self-healing), 30 s no-show (void match + abandonment; migration applied live), Find a match enabled with wait timer and 60 s bail-out. 605 unit, 52 worker, 18 e2e; real-time no-show smoke. (`.10x/decisions/sde/multiplayer-platform.md` §Step 6)
- [x] SDE: Step 7 build: limits, Origin allowlist, verify queue + DLQ, logs + sink test, bench, CI (pins, permissions, soak, live guard, deploy check), `/api/stats`, smoke, chaos pass, own-card verification, Fair play and Terms (`.10x/decisions/sde/multiplayer-platform.md` §Step 7). Not deployed
- [x] Before the Step 7 deploy (done 2026-10-09 on your "do that stuff"):
  - queues: `wrangler deploy` creates them, because both are named as producers; not yet seen on Workers Builds;
  - `verify_hand` and `hands_created_index` applied to production;
  - report contact: interim wording;
  - DBA review: done.
- [x] Step 7 deployed (PR #9 → `3cc9bd0`, 2026-10-09); `verify:deploy`, endpoints and the Origin allowlist VERIFIED in production
- [ ] User: U-4 (key, sign-in, one two-account match) to close S7-11; U-8 dashboard checks
- [ ] SDE: S7-05 (queue-wait and ack-latency telemetry) and S7-11 (launch gate, after your go)
- [x] QA: gap review of Steps 1–4 (`.10x/decisions/qa/multiplayer-platform.md`, `.10x/reviews/2026-10-08-qa-report.md`): 27 tests added (real ES256 auth, engine side pots at N=3–4, rejoin presence, live captions and offline states); 1 bug fixed (opponent shown disconnected after a rejoin). Gates: 577 unit, 25 worker, 17 e2e, all green. Release-ready for the invite-link beta; no blocking bugs.
- [x] Security: Phase 0 review, items 1–7 (`.10x/reviews/2026-10-09-security-review.md`, `.10x/decisions/security/multiplayer-platform.md`). Fixed SR-01 to SR-05; SR-06 to SR-13 are tickets or user actions with file:line.
- [ ] User: security dashboard checks U-8 in `.10x/tickets.md` (redirect allowlist, no `DEV_AUTH_SECRET` on the Worker, leaked-password protection, WAF rate limit)
- [x] DBA: Prompt 4 review of every migration plus the Phase 1 design (`.10x/reviews/2026-10-09-dba-review.md`, `.10x/decisions/dba/phase1-schema.md`).
  - DB-1 fixed and applied.
  - Retry safety: PGlite plus a real-Postgres concurrency script.
  - Growth model.
  - Phase 1 schema proposed, not applied.
- [x] Q6 answered by the accuracy mission: grades are readable only by the match's two players, after the match. Open: Q7 (`hands_private` retention) whenever you like
- [x] SDE: S7-13 (park an archive call that can never succeed; PR #11)
- [x] SDE: P1-11 Glicko-2 (PR #10), P1-02 luck adjustment (PR #11), P1-00 design (PR #11), P1-01 database (PR #12, live)
- [x] SDE: P1-01b-1, the rated match in `TableDO` (PR #13, live)
- [x] SDE: P1-01b-2 grace and both-gone void (PR #14)
- [x] SDE: P1-01b-3 rated queue and email gate, with the outcome in the end text (PR #15)
- [x] SDE: P1-01c, the lobby's Rated card and the match bar (PR #16, live)
- [x] SDE: P1-03, nothing to analyse on a rated table (PR #17, live)
- [x] SDE: P1-04, end of match and rematch (PRs #18, #19, live)
- [x] SDE: P1-08, the population model (PR #20, live); P1-09, grades and the consumer (PRs #21 and #23, live)
- [x] QA: attack on the accuracy grading (`.10x/decisions/qa/accuracy.md`): 13 scripted players, 1 exploit fixed, the averaging weakness documented, the ordering locked in CI
- [ ] SDE: P1-10, the accuracy shown (built; PR, merge and deploy check next)
- [ ] Next in Phase 1: P1-12 ratings (`ratings` migration, Glicko-2 at match end), S7-05 telemetry
- [ ] User: decide the open rematch-link finding on PR #19 (recommendation: leave it; it only undercounts rematches during an archive outage of about 15 minutes or more)
- [ ] SDE: a build marker in `/api/health` so `verify-deploy` sees Worker-only changes
