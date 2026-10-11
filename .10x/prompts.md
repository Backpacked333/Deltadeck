# 10x prompts for what is left

Rewritten 2026-10-10 against `main` at `a3b9aed` (PR #26), refreshed the same day at `13fe865` (PR #39) and again at `a91da97` (PR #45) `0920e4a` (PR #51) `c56cd5b` (PR #54) `a194c55` (PR #55) and `615e2db` (PR #63). It replaces the 2026-10-09 version that lived only on the branch `claude/amazing-ride-4vip4x`. That version's Prompts 1–5 are done, its Prompt 6 was written for the same-deck duplicate format that Q1 = B dropped, and most of its Prompts 7 and 8 is built.

Order: **finish Phase 0 → Phase 1 → Phase 2 → Later.** One prompt per fresh Claude Code session, top to bottom, except where "Runs after" allows two at once. Each prompt names the tickets it closes; the acceptance tests under those tickets in `.10x/tickets.md` are the definition of done.

| #   | Phase | Prompt                                         | Tickets             | Header                          | Runs after                       |
| --- | ----- | ---------------------------------------------- | ------------------- | ------------------------------- | -------------------------------- |
| 0   | all   | Operating contract (after the header)          | —                   | —                               | —                                |
| 1   | 0     | Production proof of the rated pipeline         | S7-11               | `/10x-Team:sre`                 | U-4 (your Supabase key)          |
| 2   | 0     | Queue wait, ack latency and a build marker     | S7-05               | `/10x-Team:sde`                 | nothing; can run beside 3        |
| 3   | 1     | Live table keyboard, sounds and quality gates  | P1-07               | `/10x-Team:sde`                 | nothing; can run beside 2        |
| 4   | 1     | Your own review of a finished match            | P1-05, P1-06        | `/10x-Team:sde`                 | 3 (both edit `src/App.tsx`)      |
| 5   | 1     | ~~The ladder~~ (done, PR #27)                  | P1-14               | —                               | —                                |
| 6   | 1     | Count profile views and shares (rest of P1-16) | P1-16               | `/10x-Team:sde`                 | nothing; can run beside 2 or 3   |
| 7   | 1     | Reports, sanctions and appeals                 | P1-17, P1-18        | `/10x-Team:sde`                 | 4                                |
| 8   | 1     | Mistakes to lessons, and what to review first  | P1-19, P1-20        | `/10x-Team:sde`                 | 4; can run beside 7              |
| 9   | 1     | Metrics pack and ladder launch                 | P1-21, P1-22        | `/10x-Team:sre`                 | 1–8                              |
| 10  | 2     | Multiway luck and pairwise results             | P2-12               | `/10x-Team:sde`                 | nothing; pure code, any time     |
| 11  | 2     | ~~Sit-out and reconnect~~ (done, PRs #52, #53) | P2-04b, P2-04c      | —                               | —                                |
| 12  | 2     | Quick-sit and the table list                   | P2-08b, P2-08c      | `/10x-Team:sde`                 | can start now                    |
| 13  | 2     | 6-max review, stats, bots, acceptance          | P2-07, P2-09–P2-11  | `/10x-Team:sde`                 | 12, and S7-05 (Prompt 2)         |
| 14  | 2     | Arenas and the 6-max rating                    | P2-13, P2-14, P2-15 | `/10x-Team:principal-architect` | 13, and 1,000 human casual hands |
| 15  | Later | Integrity v2 (only when triggered)             | —                   | `/10x-Team:security-engineer`   | a trigger                        |
| 16  | Later | Optional: port the AI coach                    | —                   | `/10x-Team:sde`                 | nothing                          |

P2-16 (the trainer onto `src/engine`) stays cut, as the tickets recommend.

**Phase 2 has its own PR plan.** `.10x/decisions/engineering-manager/six-max-casual.md` splits casual 6-max into PR-01…PR-26, and the ADR's "Amendment 2026-10-10: Phase 2 casual 6-max" settles the rules. Both win over the older P2 ticket text. You gave the go-ahead for casual 6-max on 2026-10-10, so it no longer waits for the ladder launch (P1-22). Prompts 10–13 name the plan's PR numbers.

**How to paste.** In a fresh session send, as one message: the prompt's header line (for example `/10x-Team:sde`), a blank line, the operating contract (#0), a blank line, the prompt. The header loads the right 10x role skill first; the prompt names any mid-task role switches inline.

**Why not the `/10x-Team:10x-team` orchestrator.** It starts every task with brainstorming and roams across all twelve roles. These prompts are already decided and scoped, so one focused role per prompt, with named switches, drifts less.

**Already done, so no prompt asks for it** (all merged to `main` and deployed):

- Phase 0 Steps 1–7, with the security and DBA reviews; S7-12 and S7-13.
- P1-00 the rated-match design; P1-01 the rated queue and match; P1-02 the luck adjustment; P1-03 nothing to analyse on a rated table; P1-04 rematch and the end panel.
- P1-08 the population model; P1-09 per-decision grades and the grading consumer; P1-10 accuracy, its distribution and luck versus skill (shown in the lobby until the profile exists).
- P1-11 Glicko-2; P1-12 the rating update at match end; P1-13 pairing near your rating.
- P1-14 the ladder (`#ladder`, `#ladder/month`) and the rating metrics query; P1-15 the public profile at `/u/<username>`; most of P1-16 (share card, `#method`, Share button); the public match review at `#match/<id>` (showdown cards only); hands of a live match closed to every client (PRs #27, #29, #31).
- Phase 2: the casual 6-max rules (ADR amendment) and the PR plan; P2-01 the 6-max engine gate (PR-01, PR-02); P2-02a explicit blind seats and the dead button (PR-04); every frame type checked against its allowlist, with leak tests by seat (PR-07, PR-08) (PRs #32, #34, #35, #36, #39).
- Outside the multiplayer plan: the landing page, onboarding, share links and school codes (PR #30), the 3D landing (PR #37), and accounts with email, Google or Apple sign-in, the account header, and practice hands and lessons saved to the account (PRs #56, #57, #59–#63).

**Not prompts, yours to do or decide:**

- **U-4:** add `SUPABASE_SECRET_KEY` to the Worker, sign in once, and be ready to play one rated match between two of your accounts. Until then production saves nothing, so verification, grading and ratings have never run on a real match. Prompt 1 needs it.
- **U-8:** the four dashboard checks in `.10x/tickets.md` §User gates.
- **Q3** (profile URL), **Q4** (where load tests run), **Q5** (public decision times), **Q7** (`hands_private` retention). Each has a recommendation in `.10x/tickets.md` §Questions; the prompts use it, reversibly, until you answer.
- The open rematch-link finding on PR #19 (recommendation: leave it).
- The landing page's own gates (U-9 Google sign-in, U-10 custom SMTP, U-11 for school codes by email): see `.10x/status.md` §Landing page and onboarding.

---

## 0. Operating contract (goes after the header line, before every prompt)

```
OPERATING CONTRACT — read fully before touching anything.

Context. QuantPoker: a quant-poker trainer plus online play-money poker with a chess-style rating. One Cloudflare Worker serves the site and the game server (Durable Objects TableDO and LobbyDO, plus Queue consumers that verify every archived hand and grade rated ones); Supabase holds auth and the hand archive. Rated heads-up is live: 40 fresh-deck hands, a luck-adjusted result, per-decision grades, accuracy, Glicko-2 ratings, rematch, pairing near your rating, the ladder, public profiles and a public match review. No client reads the hands of a match that is still playing. Casual 6-max is being built from the plan in .10x/decisions/engineering-manager/six-max-casual.md. Solo builder, AI-assisted, shipping fast but trusted: a rating on a résumé is only worth what its fairness is worth.

Decided, do not reopen:
- Q1 = B: fresh decks every hand, all-in pots settled at equity. No deck is ever reused, so there is no "same deck" comparison anywhere.
- Q2: the third timeout in a row forfeits immediately.
- Q6: per-decision grades, and anything derived from them, are readable only by the match's two players, and only after the match ends.
Open: Q3 profile URL, Q4 load-test target, Q5 public decision times, Q7 hands_private retention. When you reach one, use the recommendation in .10x/tickets.md §Questions, keep it reversible, and write it down.

Branch, PR and deploy rules. The user's standing instruction is "merge when green".
- Work only on the branch this session gives you; never push elsewhere. Commit in small steps with messages that say why.
- Open one PR per finished, shippable piece (usually a ticket, or a ticket's database part) and merge it to main once CI is green.
- A merge deploys: Cloudflare Workers Builds deploys the Worker and the site, and the Supabase GitHub integration applies new migrations to production. After each merge run npm run verify:deploy; for a Worker-only change also confirm the deployed Worker carries it; for a migration confirm it read-only (the migration list and the table or function you changed). Say what you checked.
- Before merging a migration, make sure its timestamp is later than every migration on main; rename it if a parallel PR merged first.
- Everything else outward-facing needs my explicit go-ahead in this session: dashboard changes, deleting anything, force-pushes, writes to production data, load against production, sending anything outside.

Orient (mandatory, in this order; parallelise independent reads with subagents):
1. .10x/status.md  2. the latest section of .10x/handoff.md  3. git log origin/main -15 (parallel sessions merge often; start from the newest main)  4. every ticket this prompt names, in full, in .10x/tickets.md  5. the files the prompt names.
For a new table or function, start from .10x/decisions/dba/phase1-schema.md and supabase/proposed/phase1.sql; where they differ from the shipped migrations in supabase/migrations, the shipped migrations win.
The ADR (including its 2026-10-10 Phase 1 amendment) and the PM specs are decided; do not re-litigate. Where the code disagrees with a doc, the code is the truth: say so and fix the doc. Where the spec is silent, choose the simplest option that keeps the specified guarantees and write the decision down.

Definition of done. The acceptance tests under each named ticket, with their exact file and test names, plus the prompt's DONE WHEN. Extra tests are welcome. A ticket written before Q1 = B or before later tickets shipped may name a stale detail (a record_match version, a file that moved); follow the prompt's correction and log it.

Method (follow it, do not shortcut it):
1. PLAN FIRST. Before editing, write a plan of at most 15 lines: the smallest change that meets the definition of done, the files you will touch, the riskiest assumption, and how you will test that assumption first. Verify the riskiest assumption before building on it.
2. RED THEN GREEN. For every behaviour change, write the failing test first, run it, see it fail for the right reason, then make it pass. Bug fix = a test that reproduces the bug. Never write a test that cannot fail.
3. SMALLEST SCOPE. Do exactly the task. Note adjacent problems in the handoff under "Noticed, not done"; do not fix them here.
4. ADVERSARIAL SELF-REVIEW. Before each commit, reread your own diff as a hostile reviewer: what input, ordering, retry, restart, or malicious client breaks this? Fix what you find or record it.
5. VERIFY LIKE A USER. Tests passing is necessary, not sufficient. Run the real thing (wrangler dev, two real browsers, a killed socket, a restarted DO) and say what you saw, and what the local setup could not show you.

Non-negotiables:
- Server owns the cards. No client ever receives an opponent's hole cards, the deck, or analysis data during a live rated hand. worker/test/rated-leak.test.ts stays green, and every new message type gets an allowlist and redaction test.
- Entry bundle stays under 150 kB (npm run build runs scripts/check-bundle.mjs). Lobby, network, review and lab code stay in lazy chunks; src/net/imports.test.ts stays green.
- src/engine and src/rating: no Math.random, timers or globals; never await inside the evaluator hot path.
- Never skip, disable, loosen or delete a test to get green. A flaky test is a bug with a cause; find it.
- Migrations are additive, live in supabase/migrations, ship with PGlite tests in supabase/tests, and add their rows to supabase/tests/rls-matrix.test.ts. record_match, ladder() and the queue dispatch in worker/src/index.ts are redefined whole, each from the latest merged version.
- Secrets are never printed, logged, committed, or sent anywhere except their one intended host. Never ask me to paste a full token or key.

Gates (run them; paste the real command output summary with counts):
npm run typecheck && npm run typecheck:worker && npm run lint && npm test && npm run worker:test && npm run build && npm run e2e
npm test includes the SQL suites in supabase/tests. If a gate fails, you are not done. If a gate does not exist, say so; never claim a pass you did not see.

Evidence standard. Every claim in your final report is one of: VERIFIED (you ran it, say how), INFERRED (from code or docs, say which), or UNKNOWN (say what would settle it). No unlabeled confidence. Failing tests, skipped steps and workarounds are stated plainly.

Missing inputs. If a file the task tells you to read does not exist yet, say so in your plan and use the fallback the task names; never invent its contents.

Unfinished work. If the task cannot be completed in this session, stop at a green, merged, shippable point and list exactly what remains as ready-to-run next steps. Never leave the branch or main red.

Stop and ask me (one concise question with your recommendation) only when: the spec forces a product tradeoff I have not decided; an action is outward-facing beyond the merge rule above; or two documented requirements contradict and neither is clearly newer. Otherwise decide, document, continue.

Close-out (all five, in this order):
a) .10x/tickets.md: a dated Status line under each ticket you touched.
b) .10x/status.md: tick tasks, update the phase line and date. Append and tick only; never reflow other sections.
c) Append a dated section to .10x/handoff.md in the existing format: Read first / User actions / What to test / What to review / Noticed, not done / Next step.
d) Append your log to .10x/decisions/<role>/<feature>.md: what you built, deviations from the tickets or ADR and why, numbers measured.
e) Final message: 5 lines max — what is now true, evidence, what I must do, what is next.
```

---

# PHASE 0: finish `multiplayer-platform`

## 1. Production proof of the rated pipeline (closes S7-11)

**Header:** `/10x-Team:sre`. Read-only ground truth on production. Run it as soon as U-4 is done; Prompts 2–8 do not wait for it.

```
MISSION. Everything built since Step 7 passes its tests and is deployed, but production has never saved a match: without the Worker's SUPABASE_SECRET_KEY nothing was archived, so hand verification, grading, accuracy and ratings have never run on a real hand. Prove the whole rated pipeline on production with one real match, read-only, and close S7-11.

PRE-CHECK: ask me whether U-4 is done (SUPABASE_SECRET_KEY set on the Worker in Cloudflare). If not, stop and give me the exact dashboard steps, nothing else.

READ: .10x/tickets.md S7-11; .10x/reviews/2026-10-09-launch-verification.md (rows already VERIFIED); worker/src/{verify,grade,rating,supabase}.ts; every file in supabase/migrations; supabase/tests/rls-matrix.test.ts.

DO (read-only against production: the Supabase MCP on project quantpoker with SELECT only, and plain HTTPS GETs. If this session cannot see that project, say so and give me the exact SQL to paste into the Supabase SQL editor instead):
1. Migrations: production's list equals the files in supabase/migrations, names and order. Drift is a finding.
2. Token: ask me to sign in once and give you ONLY the base64url of the access token's first segment. Decode it and check alg ES256 and a kid that matches the project JWKS (146bb67a-…).
3. One real rated match: ask me to play one rated match between two of my accounts, both with confirmed emails. Then check with SELECTs:
   - matches (kind hu-rated, status finished, its result), match_players, hands and hand_holes: counts consistent with the hands played;
   - every hand verified = true within a few minutes, and no incidents rows for the match;
   - hand_grades rows for both seats on every hand, with model_version;
   - ratings rows for both players that count this match; exactly two rating_history rows for it; public.accuracy refreshed for both;
   - access by role, not by reading policy text: as player A and as player B, each reads only their own hand_holes and both seats' grades; as a third account and as anon, no hand_holes and no grades; nobody reads hands_private.
4. GET /api/stats counts the new hands; /api/health and /api/config are unchanged.
5. The smoke row: Q4 is unanswered. Record it as Open (Q4) with the local numbers. Do not run load against production.
6. Record anything surprising as findings: grading latency after the last hand, console errors, log lines, outbox retries.

DONE WHEN: the launch verification review is updated so every S7-11 row is VERIFIED or Open with its reason, with new rows for verification, grades, rating and accuracy on the real match; every failing row has a proposed fix and an owner (you or me); S7-11 is ticked in tickets.md and status.md only if proven.

DO NOT: change infrastructure or dashboards, write to production data, apply migrations, add features, or print a token.
```

## 2. Queue wait, ack latency and a build marker (S7-05)

**Header:** `/10x-Team:sde`. The last Phase 0 build ticket, plus the deploy-check gap every Worker merge has hit since.

```
MISSION. Two Phase 0 success metrics are still unmeasured: median matchmaking wait and action latency (server ack to render). And verify-deploy cannot see a Worker-only change, so every Worker merge has needed a manual look at the deployed code. Fix both.

READ: .10x/tickets.md S7-05 in full; worker/src/{lobby,pairing,table,index,limits}.ts; src/net/{client,api}.ts; supabase/migrations/20261010043000_rematch.sql (record_match v5, the latest); supabase/tests/{rated,rematch,migrations}.test.ts; scripts/verify-deploy.ts and its test; .github/workflows/deploy-check.yml.

BUILD (failing test first for each):
1. S7-05 as ticketed, corrected for what shipped since:
   - record_match is v5 now (rated outcome, rematch_of, the no-show and both-gone voids). Write v6 with create or replace from v5's body, adding queue_wait_ms. Every test in the three SQL suites above stays green.
   - Two queues pair players now: casual (oldest first) and rated (worker/src/pairing.ts, a window that widens with the wait). Record the wait for both, from queue entry to pairing. A rematch has no queue wait: store null, not 0.
   - The ticket's cut line holds: queue wait first, ack telemetry second.
2. Build marker: /api/health also returns the deployed build's identity (a commit or the Worker version id), and verify-deploy compares it with what main should be serving. Riskiest assumption: how the Worker learns its identity on Workers Builds (the version metadata binding, or a value set at build time). Check the Cloudflare docs before building. Tests: health returns the field; verify-deploy fails on a mismatch (fake fetch).

DONE WHEN: S7-05's acceptance tests pass under their names; a two-client run in wrangler dev logs real ack samples between 1 and 100 ms and stores a queue wait for both seats; gates green; merged, and the production health endpoint shows the new build's identity.

DO NOT: change pairing rules or the clock, or let any client role read the samples.
```

---

# PHASE 1: HU ladder (what is left of `heads-up-duplicate-ladder`, `rating-and-leaderboard` v1, `integrity-and-trust` v1, and the review→lesson loop)

## 3. Live table keyboard, sounds and quality gates (P1-07)

**Header:** `/10x-Team:sde`.

```
MISSION. The live table still plays only by mouse and in silence: LiveTable passes shortcuts={false} and plays no sounds, while the trainer has both. The ladder spec makes the trainer's bar (keyboard loop, axe, mobile layout, frame time) an acceptance criterion for live tables, casual and rated.

READ: .10x/tickets.md P1-07; src/net/LiveTable.tsx and its tests; src/components/table/ActionBar.tsx (the shortcuts prop and key hints); src/App.tsx (the trainer's keydown handler and its playSound calls; the ticket's line numbers are stale); src/lib/sound.ts; e2e/{live,mobile,motion,app}.spec.ts; worker/test/rated-leak.test.ts.

BUILD as ticketed: extract the trainer's sound triggers and key handler into hooks in src/lib (the ticket calls them useTableSounds and useTableKeys) with no change to the trainer (run e2e/app.spec.ts's keyboard test before and after); wire both into LiveTable for casual and rated tables; keys act only on your turn.

Also, since the ticket was written:
- A rated table stays analysis-free: no new frame field, no lab or equity shortcut, rated-leak tests green.
- The rated match bar, turn clock, end panel and Rematch button are reachable and usable by keyboard (Tab order, Enter), and the axe check covers them.
- Sounds follow the trainer's volume and mute settings.

DONE WHEN: P1-07's acceptance tests pass under their names; you played one live hand in two browsers against wrangler dev without touching the mouse, and say what you heard; gates green; merged and verified.

DO NOT: change the trainer's behaviour, add new sounds, or touch worker code.
```

## 4. Your own review of a finished match (P1-05, P1-06)

**Header:** `/10x-Team:sde`.

```
MISSION. PR #29 shipped a public match review at #match/<id>: every hand of a finished match with showdown cards only and the server's "verified" mark. What a player still cannot do is review their own match: their own hole cards, a deck check in their own browser, their grades and the lab. That is where a rated match turns into learning, and reports (P1-17) and lesson links (P1-19) hang off it.

READ: .10x/tickets.md P1-05 and P1-06; src/net/{MatchReview,publicMatch,reviewText,ReviewLive,useDeckCheck,MatchEnd,AccuracyPanel}.ts(x) and src/net/imports.test.ts; src/net/profile/Profile.tsx (its links to #match/<id>); src/components/review/HandReview.tsx; src/components/lab/Lab.tsx; src/engine/project.ts (toHeroGame); src/App.tsx (parseRoute); supabase/migrations/20261010053000_hand_grades.sql, 20261010060000_hand_grades_pot.sql and 20261010100000_hands_after_match.sql; scripts/check-bundle.mjs.

BUILD:
1. P1-05, built on #match/<id> rather than a second route: when the viewer played the match, the page adds their own hole cards (their hand_holes), "Deck verified" checked in the browser for the board, shown hands and their own cards (the same check as the live review), and review_opened_at with its RPC as ticketed. Everyone else keeps today's public view. Link to it from the end panel (MatchEnd) and the lobby's Rated play panel.
2. P1-06 under Q1 = B: the lab and the grades for the match's two players. The lab cannot load inside src/net (imports.test.ts forbids analysis modules), so put the player view's lab in a lazy chunk outside it, src/review/, as the ticket planned. There is no "compare with opponent on the same deck" view, because no deck repeats; record that under the ticket. Grades show only to the two players, after the match (Q6, already enforced by RLS); others see a line saying grades are visible to the two players. Grade names Best, Good, Inaccuracy, Mistake, Blunder; the accuracy label exactly "Accuracy vs. a model opponent, not a solver."
3. Q5 is open: the public hand record carries per-action decision times. Review shows none of them except "ran out of time" on clock moves.
4. The lab never mounts for a match that is still playing (test it). hands_after_match already hides the hands of a playing match from every client; keep it that way.

DONE WHEN: P1-05's acceptance tests pass under their names (adapted to #match/<id>; log the rename); for P1-06, the lab test passes and the variant A compare test is replaced by tests that no compare view exists and that a non-player sees no grades or hole cards; imports.test.ts and check-bundle pass with the entry bundle under 150 kB; gates green; merged and verified. Say what you could exercise locally and what needs the real archive (Prompt 1 covers production).

DO NOT: put supabase-js or the lab in the entry chunk, show hole cards that were not shown at showdown to anyone but their owner, or change the public view for non-players.
```

## 5. ~~The ladder (P1-14)~~: done

Merged as PR #27 on 2026-10-10: `#ladder` and `#ladder/month`, `supabase/metrics/rating-metrics.sql`, and the simulated season (Spearman 0.975). Nothing to paste.

## 6. Count profile views and shares (the rest of P1-16)

**Header:** `/10x-Team:sde`. Small; it can run beside Prompt 2 or 3.

```
MISSION. PR #29 shipped the public profile, the share card, the Method page and the Share button, but nothing counts how often a profile is opened from outside the app or shared. Two PM success metrics ("profile views from outside" and "players who share") read those counts, so they stay "needs instrumentation" until this lands.

READ: .10x/tickets.md P1-16 (its Status line says what is missing) and §Success metrics; worker/src/index.ts (the /u/<username> handler) and worker/test/profile.test.ts; src/net/profile/{Profile,profile}.ts(x) (the Share button); wrangler.jsonc (run_worker_first already covers /u/*); .10x/decisions/dba/phase1-schema.md and supabase/proposed/phase1.sql (profile_views, if sketched there).

BUILD (failing test first): the remaining P1-16 pieces as ticketed. A profile_views(user_id, day, views, shares) migration with service-role RPCs and the owner reading only their own counts; the Worker counts a GET of /u/<username> as an external view only without a same-origin Referer and with no bot user agent; the Share button posts /api/profile/share under the existing rate limits; rows in rls-matrix.test.ts; and a query for both metrics next to supabase/metrics/rating-metrics.sql.

DONE WHEN: P1-16's remaining acceptance tests (the external-view, upsert and owner-read tests) pass under their names; gates green; merged and verified, including one curl of a production /u/<name> that is counted and one with a same-origin Referer that is not.

DO NOT: store IP addresses or user agents, show anyone else's counts, or count the app's own navigation.
```

## 7. Reports, sanctions and appeals (P1-17, P1-18)

**Header:** `/10x-Team:sde`. The prompt ends with a switch to `/10x-Team:security-engineer` for an adversarial pass.

```
MISSION. Integrity v1: a cheap, abuse-proof way to report a match, and a logged, manual way to act on a report, with one appeal. Nothing automatic. These make the ladder defensible before any detector exists.

PRE-CHECK: the player review (Prompt 4) is merged; the ladder and the profile already are (PRs #27, #29). If not, stop and say what is missing.

READ: .10x/tickets.md P1-17 and P1-18 and their DBA fold-ins; supabase/migrations/20261010090000_ladder.sql (ladder v1, which P1-18 redefines); src/net/profile/Profile.tsx (its sanctions line reads "None" today); supabase/proposed/phase1.sql (reports, policy reports_file, the per-reporter daily cap with its advisory lock, sanctions, appeal_sanction with invoker rights); supabase/migrations/20261010080000_ratings.sql (rating_history kind 'reset' is reserved for sanctions; the append-only trigger); the integrity-and-trust PM file (v1 column, Sanctions v1); src/info/InfoPages.tsx and src/info/contact.ts.

BUILD:
1. P1-17 as ticketed: the reports table and policy; a Report button in the player review of a finished rated match (Prompt 4), for its two players only; the triage script and the resolve script (the key comes from the environment and is never printed; resolve needs --confirm).
2. P1-18 as ticketed: sanctions; apply_sanction for the service role, where a rating reset appends a rating_history row of kind 'reset' and never updates history; appeal_sanction, own row, once; ladder() v2 from the merged v1, excluding active removals; "Sanctioned · <kind> · <date>" on the profile and the one-time appeal field.
3. Fair Play: replace the interim "how to report" wording with the Report button, and describe sanctions exactly as built.
4. Rows for both tables in rls-matrix.test.ts.

FINISH by invoking /10x-Team:security-engineer for an adversarial pass: two concurrent reports at the daily cap; reporting a match you were not in, one still playing, or yourself; reading reports about yourself; calling apply_sanction or appeal_sanction as another user or as anon; markup injected through a note or an appeal. Record each as EXPLOITED or HELD with the artifact, and fix anything exploited with a red-then-green test.

DONE WHEN: P1-17's and P1-18's acceptance tests pass under their names; the security pass is recorded in the security log; gates green; merged and verified.

DO NOT: auto-sanction anyone, publish report contents or reporter identities, or build v2 detectors.
```

## 8. Mistakes to lessons, and what to review first (P1-19, P1-20)

**Header:** `/10x-Team:sde`. The prompt switches to `/10x-Team:product-manager` for the lesson map, a product judgement about what to teach.

```
MISSION. The loop that brings people back: every graded mistake points at the lesson that fixes it, every lesson ends with "Play a rated match", and the end of a match leads with the three hands most worth reviewing.

PRE-CHECK: the player review with grades (Prompt 4) is merged. If not, stop.

READ: .10x/tickets.md P1-19 and P1-20; src/lib/{grading,grader,gradeHand,storage}.ts (grade classes, decision types, LESSON_IDS); src/curriculum/core/routes.ts and src/curriculum/Curriculum.tsx; src/components/learn/LearnView.tsx; the player review from Prompt 4 (src/net/MatchReview.tsx and src/review/); src/net/MatchEnd.tsx; supabase/migrations/20261010053000_hand_grades.sql and 20261010060000_hand_grades_pot.sql; the multiplayer-platform PM file (the review→lesson loop).

BUILD:
1. (Invoke /10x-Team:product-manager for this item.) src/learn/lessonMap.ts as ticketed: every decision type × grade class maps to a lesson or to an explicit "none yet", plus a gap list of what Learn does not teach yet. Choose from what Learn already has; invent no lessons.
2. P1-19 as ticketed: a lesson link on each graded mistake in the player review; a pre-loaded situation only where a lab already accepts a spot by URL (otherwise the cut line: links only); "Play a rated match" at the end of every unit, linking to the lobby.
3. P1-20 as ticketed: match_swings, the three largest EV losses per player for finished matches, readable only by the match's two players (the same rule as grades, Q6); shown on the end panel ("Grading…" while grades land) and at the top of the review, each with its lesson link.

DONE WHEN: P1-19's and P1-20's acceptance tests pass under their names; the time from a match's last hand to its grades is measured and recorded (the end panel polls for 60 s; if grading takes longer, say so and propose the fix); gates green; merged and verified.

DO NOT: invent lessons, show swings to anyone but the two players, or change how grading works.
```

## 9. Metrics pack and ladder launch (P1-21, P1-22)

**Header:** `/10x-Team:sre`. The prompt switches to `/10x-Team:dba` for the metric queries.

```
MISSION. Close Phase 1 with evidence: every PM success metric as one honest query, and the ladder opened to everyone only after a full rated run proves every part of the pipeline.

PRE-CHECK: every other Phase 1 ticket has a done Status line in tickets.md, and S7-11 is closed (Prompt 1). If not, stop and list what is missing.

READ: .10x/tickets.md P1-21, P1-22 and §Success metrics; the success metrics in all five PM files; scripts/smoke-ws.mjs and scripts/smoke/; src/info/InfoPages.tsx; README.md; the latest launch verification review.

BUILD:
1. (Invoke /10x-Team:dba for this item.) P1-21 as ticketed, extending what exists (supabase/metrics/rating-metrics.sql from P1-14, and the profile-view query from Prompt 6): supabase/metrics/*.sql, one read-only query per metric, each returning "insufficient data" honestly when it is; a README table; supabase/tests/metrics.test.ts on an empty database and on the simulated season from P1-14. Queue wait and ack latency read S7-05's columns.
2. P1-22 as ticketed: smoke --rated, a 40-hand rated match on wrangler dev with a DO restart in the middle, ending with the right result, archived rows, verified hands, grades and exactly one rating update; a 500-hand smoke with 0 commitment failures; the Fair Play page describes exactly what now exists (fresh decks with the luck adjustment, reports, sanctions, the Method link, and what is still not detected); README.
3. Then ask me for the go-ahead. With it, I play one production rated match between my two accounts and you check it read-only end to end, as in Prompt 1.

DONE WHEN: P1-21's and P1-22's acceptance tests pass; .10x/reviews/<date>-ladder-launch.md has every row VERIFIED or Open with its reason; gates green; merged and verified.

DO NOT: seed fake data into production, run load against production, or claim on the Fair Play page anything a test or a log does not back.
```

---

# PHASE 2: 6-max (`six-max-tables` casual, then rated arenas)

Every Phase 2 prompt follows `.10x/decisions/engineering-manager/six-max-casual.md` (the PR plan, PR-01…PR-26) and the ADR's "Amendment 2026-10-10: Phase 2 casual 6-max" (the rules). Where they differ from the P2 tickets, they win. Done: PR-01, PR-02 (P2-01), PR-03 (the amendment), PR-04 (P2-02a), PR-05, PR-06 (P2-02b/c, PR #40), PR-07, PR-08 (frame allowlists), PR-09 to PR-14 (P2-03a–f: the archive migration, CashController, sit and play, stand up, the session lifecycle, rebuy; PRs #41, #43, #44, #46, #48, #50), PR-15 to PR-17 (P2-04a–c: the orbit bank, sit-out and removal, the 60 s reconnect; PRs #51–#53), PR-21 and PR-22 (P2-06a/b: side pots shown apart, chip motion with a six-seat frame-time gate; PRs #54, #55), PR-23 (P2-08a, the six-table registry, PR #58), PR-18 (P2-05a, the six-seat ring, PR #45) and PR-19 (P2-05b, six-casual at the live table with Sit here and keys, PR #49).

## 10. Multiway luck and pairwise results (P2-12)

**Header:** `/10x-Team:sde`. Pure code, so it can run any time. PR-05 and PR-06 (P2-02b/c) merged as PR #40.

```
MISSION. The 6-max rating (Prompt 14) and the luck-adjusted bb/100 stat (Prompt 13) need two pure pieces that do not exist: all-in luck settled at equity when three or more players are all in, and luck-adjusted results turned into pairwise results per opponent.

READ: .10x/tickets.md P2-12; src/engine/luck.ts and its test (heads-up only today); src/rating/glicko2.ts; the six-max-tables and rating-and-leaderboard PM files (§6-max).

BUILD (red first): P2-12 as ticketed. Extend src/engine/luck.ts to multiway all-ins: bench a 3-way preflop all-in first, and if exact enumeration is too slow, use a fixed Monte Carlo budget with a fixed seed and say so. Add src/rating/pairwise.ts. Heads-up results must not change: the existing luck tests stay green, bit for bit.

DONE WHEN: P2-12's acceptance tests pass under their names; gates green; merged and verified.

DO NOT: touch worker code, the UI, or the ratings tables.
```

## 11. ~~Casual 6-max: sit-out and reconnect (P2-04b, P2-04c)~~: done

Merged as PRs #52 and #53 on 2026-10-11, after P2-03a–f and P2-04a. Casual 6-max tables now sit people out, remove them, and hold a dropped seat for 60 s. Nothing to paste.

## 12. Quick-sit and the table list (P2-08b, P2-08c)

**Header:** `/10x-Team:sde`.

```
MISSION. Six seats already play at the live table on the new ring, with side pots shown apart and smooth chip motion (PR-18, PR-19, PR-21, PR-22). One thing is left before casual 6-max feels finished: the lobby already keeps a registry of six tables (PR-23); players still need quick-sit and a list that finds a table in one click.

PRE-CHECK: PR-13's session lifecycle (PR #48) and PR-19 (PR #49) are merged. Start from the newest main.

READ: the PR plan's PR-23 to PR-25 and the registry PR #58 merged; the ADR amendment's rows on the table UI and on the table list and quick-sit; .10x/tickets.md P2-08; the six-max-tables PM file; src/components/table/* and the six-seat ring from PR #45; src/motion.ts; src/net/{LiveTable,Lobby}.tsx; worker/src/lobby.ts; e2e/{live,mobile,motion}.spec.ts.

BUILD, in the plan's order, red first:
- Done: PR-21 and PR-22 (P2-06a/b), side pots and chip motion (PRs #54, #55).
- Done: PR-23 (P2-08a) the table registry, counts only (PR #58).
- Left: PR-24 (P2-08b) quick-sit (fullest table with a free seat; on table_full or sit_cooldown try the next, or open one) and PR-25 (P2-08c) TableList in the lobby.
- PR-20 (moving heads-up onto the ring) stays optional; skip it unless it is free.

QUALITY GATES: the six-seat frame-time gate from PR-22 stays green; no serious axe violations in light and dark; no horizontal scroll at 320 px; heads-up tables look and behave as before, with their e2e green.

DONE WHEN: every PR's named tests pass; you played at a six-seat table in two real browsers against wrangler dev, including a quick-sit from the lobby into a running table, and say what you saw; gates green; each PR merged and verified.

DO NOT: change the heads-up table's look or the entry bundle, or ship rated 6-max.
```

## 13. 6-max review, stats, bots and six-client acceptance (P2-07, P2-09, P2-10, P2-11)

**Header:** `/10x-Team:sde`. The prompt switches to `/10x-Team:qa-engineer` for the acceptance run, whose job is to break the tables.

```
MISSION. Close casual 6-max: every hand reviewable, 6-max stats on the profile, bots so a quiet table is still playable, and the evidence that six-player tables are correct and fast enough to open to the public.

PRE-CHECK: Prompts 11 and 12 are merged, and S7-05's ack telemetry (Prompt 2) is live, because the acceptance run's p95 reads it. If not, stop and say which.

READ: .10x/tickets.md P2-07, P2-09, P2-10 and P2-11; the PR plan's PR-26 and §(3) (its point 13: casual hands are not graded); the ADR amendment's row on grading and rating; src/engine/project.ts; src/net/MatchReview.tsx and the player review from Prompt 4; src/engine/luck.ts and src/rating/pairwise.ts from Prompt 10; src/net/profile/; scripts/smoke-ws.mjs.

BUILD:
1. P2-09, without grading: the amendment and R-23 say casual hands are verified and not graded, which replaces the ticket's heads-up-at-decision grading. Every 6-max hand opens in review with the lab for the seat the viewer played (hand-compute one dead-money projection case first); casual 6-max players can report a wrong payout (reason payout).
2. P2-10 as ticketed: hand_stats written by the hands consumer after verification; VPIP, PFR, aggression and luck-adjusted bb/100 (multiway luck from Prompt 10) on the profile.
3. P2-07: bots are not in the amendment. First append a short amendment section: when bots sit (fill to 3 occupied seats, R-21), how they leave as humans sit, their label "Atlas (bot)", that they never sit at rated or arena tables, and how the human-seat metric reads them. Then build as ticketed, with the bot benched under 20 ms of CPU per decision inside the Durable Object.
4. Invoke /10x-Team:qa-engineer for PR-26 (P2-11): six clients (scripted Node plus at least two real browsers) play 200 hands with joins, leaves, timeouts and a reconnect; chips conserved, 0 leaks, no console errors, ack-to-render p95 under 150 ms; Safari background tabs documented.

DONE WHEN: the four tickets' acceptance tests pass (P2-09's grading tests replaced by "casual 6-max hands are not graded", logged); the PR-26 evidence is in the QA log; gates green; each PR merged and verified.

DO NOT: grade or rate casual hands, or let a bot near a rated or arena table.
```

## 14. Arenas and the 6-max rating (P2-13, P2-14, P2-15)

**Header:** `/10x-Team:principal-architect`. ArenaDO (seating by band, rebalancing) is new architecture. The prompt asks for a short design note, then switches to `/10x-Team:sde`.

```
MISSION. Give 6-max a rating people can believe: scheduled humans-only arenas, pairwise luck-adjusted results into a separate Glicko-2 rating, provisional until the data supports it.

PRE-CHECK (stop if it fails): Prompt 13 is merged, and production shows 0 invariant failures over the first 1,000 human casual 6-max hands (hands.verified and incidents, read-only). Report the counts. This check already stopped once, on 2026-10-10, with 0 of 1,000 hands: see .10x/decisions/architect/six-max-arena.md. It cannot pass before casual 6-max is live and U-4 is done.

READ: .10x/decisions/architect/six-max-arena.md; .10x/tickets.md P2-13, P2-14 and P2-15; the six-max-tables PM file §Format (Arena) and §Gates; the rating-and-leaderboard PM file §6-max; the casual 6-max ADR amendment (table ids versus session ids); src/rating/{glicko2,pairwise}.ts; worker/src/{rating,lobby,table}.ts; supabase/migrations/20261010080000_ratings.sql (the format '6max' is already allowed); the ladder and profile code.

DESIGN NOTE (at most half a page, appended to the ADR): ArenaDO's ownership of seating, the rating-band rules, the rebalancing algorithm, what happens to a hand in progress during a rebalance, and the failure matrix. Spike the claim and release handover between TableDOs (half a day) before committing to it. Then invoke /10x-Team:sde for BUILD.

BUILD as ticketed:
1. P2-13: code-defined 60-minute windows with a lobby countdown (email or notifications only if that infrastructure exists; otherwise record the gap, R-19); ArenaDO seats humans only, by band, and rebalances at hand boundaries; fewer than 4 humans means played, not rated.
2. P2-14: format '6max' fed from pairwise results per arena session; provisional until 500 rated hands; the ladder lists provisional players separately; the profile shows the HU and 6-max ratings side by side. Formats never mix.
3. P2-15: a scripted 60-minute arena with 12 test-account clients across 2 tables, in a test environment only (never Atlas bots, never production), and the 6-max metric files.

DONE WHEN: the three tickets' acceptance tests pass under their names; the scripted arena rebalances correctly and produces plausible ratings; gates green; merged and verified.

DO NOT: build collusion detection (Prompt 15), or treat a provisional rating as final anywhere in the UI.
```

---

# LATER (triggered)

## 15. Integrity v2 (run only when a trigger fires)

Triggers: 1,000 registered players, the first recruiter or firm inbound, the first credible cheating report, or a sponsored event.

**Header:** `/10x-Team:security-engineer`. The prompt switches to `/data:statistical-analysis` for precision, recall and false-positive estimates.

```
MISSION. Defend the ladder with evidence, not vibes. Build detectors against the real data we now have and apply them retroactively to public rated histories. Humans decide sanctions; the system produces ranked, explainable review packets.

READ: the integrity-and-trust PM file (v2 column); the reports and sanctions tables and the triage log (P1-17, P1-18); per-action decision times in the hand archive and whatever Q5 decided about them; hand_grades, public.accuracy and rating_history; the Fair Play page; the security reviews.

BUILD, each as an offline job first and a review queue second, never an auto-ban:
1. External-RTA screen: accuracy and timing-variance distributions against the population; outliers with a confidence and a review packet (hands, timings, comparison with peers).
2. Collusion and chip dumping (6-max): a seat co-occurrence score, soft play in checked-down pots between linked accounts, large all-in losses with weak holdings to the same account.
3. Win-trade graph for HU: the match-pair graph and decayed gains against repeat opponents.
4. Multi-account soft linkage (device, IP) and verified email-domain badges; phone verification for the ladder only if the data justifies it.
5. A public read-only profile JSON API for firms, with signed hand-history ids (R-6 moved them here).

FOR EVERY DETECTOR (invoke /data:statistical-analysis for the evaluation): evaluate on seeded synthetic cheaters AND on the real population; report precision and recall, the false-positive budget (innocent players per 1,000 flagged), and what it cannot catch. If a detector is noise, say so and do not ship it. Update the Fair Play page to describe exactly what exists.

DONE WHEN: each shipped detector has an evaluation report, a human review workflow and an appeal path; the API respects the profile's privacy rules.

DO NOT: auto-sanction, publish raw suspicion scores, or ship anything whose false-positive rate you did not measure.
```

## 16. Optional: port the AI coach to the Worker

**Header:** `/10x-Team:sde`. The prompt switches to `/10x-Team:security-engineer` for the abuse and prompt-injection tests. The code lives in the tag `archive/context-aware-coach` and `refs/pull/2/head`.

```
MISSION. Bring back the AI coach on the new stack without weakening fairness or exposing keys. It explains finished hands; it must be impossible to use as real-time assistance.

READ: git show archive/context-aware-coach for server/coach.ts, src/lib/coach.ts, coach-stream.ts and their tests; .10x/status.md §Repository; worker/src/index.ts; hand_grades and the player review (src/net/MatchReview.tsx, src/review/); the security reviews.

BUILD: a Worker route with streaming; per-account usage limits in Postgres (an additive migration with its RLS test); the model key as a Worker secret, never sent to the client; grounded only in finished-hand data the requester may see (their own hole cards, shown cards, and grades under Q6); refused server-side whenever the requester has a live rated hand, including races where a hand starts mid-request (test them); a lazy chunk that keeps the entry bundle under budget; the ported tests. Then invoke /10x-Team:security-engineer for abuse tests: rate limits; prompt injection through opponent usernames, bios, report notes or hand text cannot widen data access or tool use; output never echoes secrets.

DONE WHEN: the coach works on a finished hand in wrangler dev, is refused during a live rated hand, and all gates are green; merged and verified.

DO NOT: port the 3D terrain frontier, slice or camera (a separate task), or let the coach see hidden cards of any hand.
```
