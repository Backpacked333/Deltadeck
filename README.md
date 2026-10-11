# QuantPoker

**Play the hand. Understand the odds.**

QuantPoker is a decision trainer disguised as a poker game. You play heads-up Texas Hold’em for play money against **Atlas**, a transparent practice bot. Before the math appears you commit to a read, then a live quant lab prices every option. After each hand you get chess-style grades on the decisions, with luck shown separately from skill.

This is an **educational web app played for play money only**, not a gambling service, trading tool or source of investment advice. Casual heads-up play against other people runs online (see [Online play](#online-play)); the trainer works fully offline without it.

## Run locally

Requirements: Node.js **22.12+** and npm (`.nvmrc` pins Node 22 LTS; Node 24 also works).

```sh
npm ci
npm run dev          # http://localhost:5173
```

No API keys, database, account or environment variables are needed for the trainer. Online play is optional: `.env.example` lists the two browser-safe values that turn on sign-in.

### The landing page

The bare URL is the home page: it always opens the landing page, and the logo leads back to it. The trainer is at `#table` (the Play tab). `#start` also opens the landing page. The one exception is a return from a sign-in redirect (`?code=…`) with no route to restore, which opens the app so the sign-in can finish. Signed-in visitors get "Play online" in place of the sign-up buttons.

- **The challenge:** one of six curated hands against Atlas, played from preset buttons (keys `1`–`6`), each decision graded on the spot.
  - With WebGL, it plays on a cinematic 3D table (`src/landing/stage/`, ADR-001): Atlas's likeliest hands rise as a cloud on the first decision, and a slow-motion verdict plays on the last.
  - Without WebGL, with reduced motion, or with `?motion=off`, it plays on the trainer's 2D table.
  - `?stageslow=<n>` slows the 3D clock for screenshots.
- **The rest of the page:** below the hand it explains how QuantPoker works and what a free account gives, with "Create free account" in the header and on the score card.
- **The score card:** the accuracy, a percentile ranked by the Worker (against model players until a hand has 200 real scores), the luck of the cards shown apart from the decisions, and Atlas's reasoning. Its CTA, "Save your score and get rated", leads to sign-up and a three-step onboarding (`#welcome/onboard`).
- **The trees:** every reachable decision is priced offline by the trainer's own grader into `src/challenge/trees.generated.json`. `src/challenge/generate.test.ts` rebuilds it on every test run and fails on any difference. To regenerate after changing a hand or the grader: `CHALLENGE_WRITE=1 npx vitest run src/challenge/generate.test.ts`.
- **The server side:** `ScoreDO` in the Worker re-scores each line by lookup, keeps the histograms, counts funnel events (`GET /api/funnel`, aggregates only) and sends claimed scores to Postgres through an outbox.
- **School badges:** a confirmed school email sets a badge (`20261010110000_landing.sql`). A player who signed in with another address can verify a school email by a six-digit code (`worker/src/school.ts`), once the Worker has `RESEND_API_KEY` and `SCHOOL_EMAIL_FROM`.
- **Sharing:** "Challenge a friend" shares `/c/<receipt>`. Its link preview names the hand and the score to beat, and it opens the same hand for the friend, ending in a head-to-head result. Links last 30 days.

### Online play

`#lobby` (the **Online** tab) signs you in with an email link, or with Google or GitHub when the Supabase project enables them, and asks for a public username. **Find a match** pairs you with the next player waiting; **Play a friend by link** opens a table and gives you a link to send. A match is 20 hands of heads-up no-limit hold'em for play money, on the same table UI as the trainer, with the quant lab switched off during play. Each decision has a 20-second clock plus a 60-second bank for the match; three missed decisions in a row forfeit. After each hand you can open its review; **Deck verified** means your browser checked the board, the shown hands and your own two cards against the deck commitment it received before the deal. [Fair play](https://quantpoker.bbcroysalman.workers.dev/#fair-play) and [Terms](https://quantpoker.bbcroysalman.workers.dev/#terms) (in the app: `#fair-play`, `#terms`) say what is and is not guaranteed.

How it is built (decisions in `.10x/decisions/architect/multiplayer-platform.md`):

- `src/engine/`: the server-authoritative N-player engine (2–6 seats, side pots, deck commitment, per-seat redaction). It is not used by the trainer, which keeps `src/lib/poker.ts`.
- `src/net/`: the online area, lazy-loaded. The account client never reaches the entry chunk (`scripts/check-bundle.mjs` fails the build if it does), and `src/net` may not import the trainer's analysis modules. `src/info/` holds the Fair play and Terms pages, also lazy.
- `worker/` + `wrangler.jsonc`: one Cloudflare Worker serves the built site and the table server (`/api/*`, `/ws/*`): a `TableDO` Durable Object per match and one `LobbyDO`. Every finished hand is archived to Postgres through an outbox, then re-verified off the game path by a queue consumer (`worker/src/verify.ts`). Limits, close codes and the operator's runbook are in [Operations](#operations-online-play).
- `supabase/migrations/`: players, matches, the hand archive and the verify functions, with row-level security, tested against a real Postgres (PGlite) in `supabase/tests/`. Apply new migrations to the project before deploying the code that calls them; CI never touches the database.
- `supabase/bench/` (DBA review 2026-10-09):
  - `plans.ts`: query plans and timings at 10k–1M generated rows, plus self-checks of the Phase 1 rules;
  - `concurrency.ts`: two real PostgreSQL sessions racing each archive write.
- `supabase/proposed/phase1.sql`: the Phase 1 schema, designed and measured but not applied (`.10x/decisions/dba/phase1-schema.md`).

Run it locally: `npm run worker:dev -- --var DEV_AUTH_SECRET:<s>` serves the site and the table server on :8787 (`<s>` at least 16 characters, letters, digits or `-`; shorter secrets leave dev tokens off). Set `sessionStorage['qp.devToken'] = 'dev.<name>.<s>'` in each browser to play without an account, or open two browsers with different names. `npm run worker:test` runs the server's tests inside Cloudflare's runtime. `npm run smoke` (with the server running and `<s>` = `smoke-local-secret-0001`) plays 500 hands with 20 clients and prints ack latency percentiles and the integrity checks; it refuses to touch production unless a person types its confirmation phrase.

Built for Phase 1 (rated heads-up ladder) to plug into without changing the protocol:

- **The hand queue.** `HAND_QUEUE` already carries `{ matchId, handNo }` for every archived hand, one per consumer invocation. Grading adds to `worker/src/verify.ts` after the verify step; `src/engine/bench.test.ts` pins the cost at under 500 ms CPU per decision.
- **`src/engine/project.ts`.** `stateToHeroGame` and `toHeroGame` project a live hand into the trainer's `Game`, which `gradeDecision` already grades (equality tested in `differential.test.ts`).
- **The controller seam.** `worker/src/controller.ts` decides each hand's deck, button and stacks; Phase 1's duplicate controller replaces `LocalController`. It is synchronous today and Durable Object storage is not, so reading a stored deck means making `nextHandPlan` async (or having the table pass the deck in).
- **`deck:<n>`.** Every hand's deck and secret stay in the table's storage for the whole match (the table deletes everything 10 minutes after it ends), so a later segment can deal deck _n_ again under a fresh secret. The duplicate format has an open product question first (Q1 in `.10x/tickets.md`).

```sh
npm run typecheck    # strict TypeScript, including e2e specs
npm run lint         # ESLint and React hooks rules
npm test             # unit and component tests (Vitest, jsdom)
npm run e2e          # Playwright end-to-end, accessibility, mobile and frame-time checks
npm run e2e:visual   # opt-in screenshot comparisons (baselines stay local)
npm run build        # type-check, production assets in dist/, entry-bundle budget
npm run preview      # serve the production build locally
```

The build is static: host `dist/` anywhere. There are no server routes or client-side routing requirements.

## The learning loop

1. **Read first.** On each street the lab stays locked until you guess how often your hand wins at showdown. Lock it in (Enter) and the lab opens, showing how close you were. Every read feeds your calibration statistics. You can skip, or turn this off in settings.
2. **Act at the table.** Fold, check, call, bet or raise, with ½-pot, ¾-pot, pot and all-in presets. Once you have made your read, the call button carries an **equity ring** with a tick at break-even, and every bet size shows its modeled EV. Keyboard: `F` `C` `R`, `1–4` for sizes, `Enter`, `P` to pause, `?` for help.
3. **See the decision.** The lab has two modes:
   - **Simple:** an equity meter against the price, a plain-language verdict, the EV of every action, how Atlas’s actions shifted its likely range, and next-card what-ifs.
   - **Analyst:** adds a 13×13 range grid of Atlas’s likely holdings, a 2D decision map (3D terrain on demand), quant metrics, a fold-probability override, and the optionality and protection lenses.
4. **Review the hand.** Each decision gets a grade (Best, Good, Inaccuracy, Mistake, Blunder). You can replay any decision with the lab frozen at that moment. The review shows result versus model expectation, a face-up equity-by-street graph after a showdown, and Atlas’s reasoning, revealed only once the hand is over.
5. **Track improvement.** The progress page charts luck versus skill (cumulative result against cumulative expectation), decision accuracy, grade distribution, read calibration with blind spots by hand type, and recent hands. You can export and import your progress.

New visitors get a welcome screen, a short spotlight tour, three **guided hands** (a big draw, a price-sensitive straight draw, a river bluff-catch) and then shuffled practice. **Learn** opens the full curriculum (below). Six short **quick lessons** with interactive widgets and quizzes (expected value, outs and pot odds, variance, ranges, options and insurance) sit inside it at `#learn/quick`.

The app has light, dark and system themes, and a bottom-sheet lab on phones. It respects reduced-motion preferences and is keyboard-operable, with automated axe checks in both themes.

### Table feel and motion

- **Cards and felt:** original vector card faces and court cards with a paper grain, a lit felt with a stitched leather rail, and chips that stack by denomination (1, 5, 25, 100, 500).
- **Choreography (Motion):** cards fly from the deck to their seats and lift as they turn over, and folded hands slide into the middle. When a hand ends all-in, both hands turn face up and the board is revealed one street at a time, with a pause before the river and equity bars that update after each card. Stacks, payouts and the review wait until the river lands.
- **Atlas:** a drawn face that breathes and blinks, glances while it thinks, and has a sweeping ring around it. On phones its actions pop out as compact tags. The winner's side of the felt lights up.
- **Lab:** meters, markers and EV bars move on springs, the Best tag glides between actions, tabs crossfade, and jargon (equity, break-even, EV, range) carries a definition on hover, focus or tap.
- **Desktop layout:** drag the bar between the table and the lab to share the width. The table scales with its column, the split is remembered, and a double-click (or Enter) springs it back to the default. Arrow keys, Home and End resize it from the keyboard.
- **Sound (optional):** cards snap, chips clack and checks knock, synthesized in the browser with no audio files. A volume slider appears in settings when sound is on.
- **Phones:** the lab sheet can be dragged between peek, half and full, follows a flick, and gives a short vibration on snap when sound is on.

Every animation stops or snaps under reduced motion. `?motion=off` forces that, and `?seed=<n>` makes deals and Atlas reproducible; both exist for tests and screenshots.

## Integrated curriculum

The table remains the default experience (`#table`). **Learn** opens Foundations at `#learn/path` (also `#learn` and `#learn/foundations`). Unit URLs use `#learn/unit/f01/brief` and steps `brief`, `predict`, `worked`, `practice`, `experiment`, `transfer`, `review`. The atlas is `#learn/map` (also `#learn/atlas`), the lab catalog is `#learn/lab`, pathways are `#learn/pathways`, delayed review reminders are `#learn/reviews`, and notes/evidence/export are `#learn/notebook`. Hash routes need no hosting rewrites. The **Core library** is `#learn/core`: original URLs such as `#learn/module/odds/learn` retain `learn`, `lab` and `check` tabs. Its legacy connection diagram remains at `#learn/connections`.

Opening the curriculum pauses the bot without resetting your hand, stacks, raise size, selected lens, results, or manual pause setting. A visible-information hand summary carries your cards, public board, pot, call cost, estimated equity, and (when facing a bet) break-even equity into the lesson. **Return to this hand** resumes the same game. Lab inputs are independent experiments, not edits to dealt cards or bankroll. Lab what-if selections and the 3D camera reset when you return; the game itself does not. The six interactive quick lessons live at `#learn/quick` (linked from the curriculum sidebar and from every lab view), and progress is at `#progress`.

| Stage            | Poker mechanic               | Finance connection                       | Experiment                                                                         |
| ---------------- | ---------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------- |
| Foundations      | Pot odds                     | Expected payoff and entry price          | Change pot, call cost, and equity                                                  |
| Foundations      | Outs                         | State spaces and probability             | Exact draws without replacement vs. rule of two/four                               |
| Foundations      | Equity                       | Physical vs. risk-neutral probabilities  | Combine wins and split pots                                                        |
| Decision science | Expected value               | Risk-neutral pricing                     | Separate physical forecasts from binomial pricing weights                          |
| Decision science | Fold equity                  | Contingent payoff trees                  | Mix folds with equity conditional on a call                                        |
| Market mechanics | Variance                     | Implied volatility                       | Compare poker dispersion with a synthetic option premium and IV inversion          |
| Market mechanics | Payoff accounting            | Delta hedging and put-call parity        | Replicate terminal payoffs and compare parity portfolios                           |
| Market mechanics | All-in cashouts and bankroll | Insurance premiums and credit protection | Compare cashout/run-twice settlements, Kelly sizing, ruin risk, and variance bands |

Each typed module in `src/curriculum/curriculum.ts` defines three objectives, recommended prerequisites, conceptual explanations, an explicit analogy boundary, a worked numerical example, formula notation, a lab, two mastery questions with feedback, notes, and a further-reading link. Prerequisites guide sequencing but never lock access. Both questions must be correct for local completion; retries are unlimited. The original three lens mini-lessons remain available from the table and retain their existing completion records.

Important distinctions are taught explicitly:

- Poker equity is **not** option delta; physical probabilities are **not** necessarily risk-neutral probabilities.
- The binomial lab assumes `0 < d < 1+r < u`, a frictionless non-dividend stock, and a simple risk-free rate for the full period. It prices by replication: `q = (1+r-d)/(u-d)` and `V = [qVu + (1-q)Vd]/(1+r)`.
- Delta is the stock quantity in an exact two-state hedge, not a probability. Put-call parity is `C-P = S-K/(1+r)` for matching European claims. This does not make real-world discrete hedging riskless.
- The variance experiment assumes independent binary ±100-chip payoffs; total mean scales with the number of hands and standard deviation with its square root.
- The separate Black–Scholes example assumes spot = strike = 100, one year, a 5% continuously compounded rate, and no dividends. It generates a **synthetic** premium and recovers IV by bisection; it does not fetch market prices or convert chip variance into annualized volatility.
- The fold-equity lab assumes equal new bets, no subsequent betting, and equity conditional on being called. It is a strategic payoff tree, not an arbitrage-pricing identity.
- The all-in risk lab uses a binary win/loss payoff with known physical equity. Two equal runouts are treated as independent, so they preserve EV and halve variance; real boards share a depleted deck. A cashout charges a percentage of the fair gross payout. The Kelly model repeats constant, independent odds, resizes after every result, and defines ruin as crossing a selected drawdown floor over a finite horizon—not literal bankruptcy.
- Cashing out sells the whole pot claim; loss-only insurance pays on a defined losing event while retaining the hand. The latter is the closer credit-default-swap analogy. The lab has no reference entity, default timing, recovery auction, credit-spread curve, discounting, collateral, or counterparty credit risk and does not produce a market CDS price.

Curriculum records now use `quantpoker.learning.v2`; valid learning-v1 notes and core completions migrate without becoming new foundation evidence. Normal migration leaves `quantpoker.learning.v1` untouched as a fallback. Table history and lens mini-lessons retain the separate `quantpoker.progress.v1` key, which curriculum reset never removes. Malformed records are preserved with recovery/export choices; storage failures retain work in the root session until the tab closes. JSON and Markdown exports, bounded retention, and multi-tab conflict warnings are included. There is no JSON importer, account, or cloud sync.

### R1 foundations and specialist laboratories

All ten introductory units have retrieval (including an explicitly recorded skip), persisted unaided predictions, a parallel worked example, a partial scaffold, changed practice, an experiment, at least three finance transfers and at least three changed reviews. They cover information/cash flows; conditional probability; price/EV; repetition and uncertainty; updating and forecasts; capital/compounding/preferences; dependence and pooling; contingent payments; protection/pricing/obligations; and independent finance transfer. Hints move through information, principle, computation and interpretation.

| Specialist lab | What it isolates                                                                    | Main boundary                                                                           |
| -------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Calibration    | Forecast groups, Brier/log scores, decisions, Bayes and Beta–Binomial updating      | Forecast quality is not decision value; finite samples do not certify calibration       |
| Selection      | Observed versus target populations, unequal recording and inverse weighting         | Unknown or zero recording rates make correction unavailable; no causal imputation       |
| Information    | Joint signal states, optional actions, EVSI/EVPI and research fees                  | Physical probabilities and specified terms; no endogenous price discovery               |
| Contracts      | Deductible/limited layers, stock-plus-put, call spread, occurrence versus aggregate | State payoff/profit identities are not market pricing identities or legal advice        |
| Solvency       | Exact independent/common-event mixture, claim funding, default and unpaid claims    | Fixed-loss homogeneous pool and stipulated pro-rata settlement, not regulatory capital  |
| Backtest       | Candidate search, frozen protocol, unrevealed holdout, costs and repeated testing   | Synthetic independent null data, not empirical returns or an implementation of PBO/CSCV |

The first F10 transfer/review bank contains three finance-only final cases: equipment service, seasonal inventory and a warranty book. Each has at least six scored items across setup, calculation, interpretation and limitation, plus critical ledger/probability checks, distinct hints and an ungraded written defense. Changed review regimes reverse research choice, floor feasibility or default. Original hypothetical contract terms are explicit; no external source is claimed to validate these businesses.

The four pathways link real introductory resources and prerequisite bridges. Atlas filters cover domain, pathway, mathematical level, availability and text; the lab catalog searches question, role and concepts. **Available** means selected introductory assessed mechanisms—not the entire research family. Broader/research mechanisms remain **partial/planned**, and future capstones are not playable links or included in progress denominators. Sources show claim-specific locators and verification status; citations do not prove QuantPoker improves learning.

Predictions are committed before structured answers/reveals. Hints and repeated exposed cases remain practice, not unaided demonstration. A fresh transfer needs at least 80% and all critical items correct; prose and simulated profits are never graded. Delayed review uses device-clock reminders at 3, then 10, then 30 days; failed/assisted reviews retry at 1 day. This editable local evidence is not secure certification.

Learning persistence is local and best-effort: the bounded 1 MiB envelope retains active drafts, first/recent evidence receipts and exposure/search summaries while older detailed attempts may be compacted. Quota or blocked-storage failures keep this tab's work, but refresh durability is not promised. If another tab changes the saved revision, export the unsaved work or explicitly reload saved progress; there is no silent last-write-wins merge. Recovery/export does not advertise a JSON import. Learning reset never resets the current table or its separate storage.

Specialist randomness uses versioned role-separated seeded streams, never the poker game's RNG. Backtest generates its holdout only after explicit protocol freeze/reveal, and worker messages carry run ID, parameter hash and generator version. Cancellation/parameter changes prevent stale results from publishing; a failed run retains committed inputs. Ordinary analytic recomputation is separate from mastery assessment.

See the [frozen developer contract and runnable test fixture](src/curriculum/core/README.md) for manifest, controller, case-fragment, persistence, route, deterministic-stream, worker, source and accessibility APIs. Automated component tests are not browser proof. **Browser acceptance has not been run for this integration and awaits parent approval**, including mobile/zoom, keyboard/screen-reader behavior, actual browser workers and WebGL/fallback performance.

The curriculum is lazy-loaded and its CSS is scoped to `.curriculum-workspace`, so it does not restyle the table or 3D panel. Specialist Entries/Views and workers are lazy chunks; case/source metadata is registered together. Core models live in `src/curriculum/lib/math.ts`, shared adapters in `src/curriculum/core/foundationMath.ts`, and specialist models under `src/curriculum/experiences/`. None receives the root game, opponent private cards or future deck. Add new resources through the typed registry and acceptance tests rather than marking static placeholders available.

## Atlas, a published strategy

Atlas estimates its own equity against a random hand (250 samples, using only its cards and the board), then follows a simple policy with three selectable styles:

| Style      | Extra equity wanted to continue | Weak hands defended\* | Value raise above | Value raise rate | Bluff rate | Bet sizes (× pot) |
| ---------- | ------------------------------- | --------------------- | ----------------- | ---------------- | ---------- | ----------------- |
| Tight      | +8 pts                          | 10%                   | 68%               | 60%              | 3%         | 0.5, 0.66         |
| Balanced   | +4 pts                          | 15%                   | 65%               | 65%              | 7%         | 0.33, 0.55, 0.75  |
| Aggressive | 0                               | 22%                   | 58%               | 75%              | 14%        | 0.66, 1           |

\*Weak-hand defence applies fully to bets up to about half pot and fades to zero against large overbets, so Atlas cannot be exploited by huge shoves.

Atlas never sees your cards. Its explanations are generated from its real inputs. During play the table shows only what it did; why it did it is revealed in the review.

## The math and its limits

### Atlas’s likely range (Bayesian, from public actions only)

Every unseen starting combination (up to 1,326) begins equally likely. For each public action Atlas took, each combo is reweighted by the probability that Atlas’s published policy takes that action with that combo’s equity on the board at the time. Atlas’s own estimation noise is modeled by smoothing its thresholds. Your equity is then measured against the resulting posterior. A toggle switches the lab to the classic **any hand** model (uniform over unseen hands).

The model is only as good as the strategy description. Against real opponents, ranges are far less predictable than Atlas’s.

### Showdown equity

Results are computed per opponent combo:

- exactly on the river and turn;
- with 80 sampled runouts per combo on the flop;
- with 24 per combo pre-flop.

They are then averaged under the selected model. Ties count as half. Each new spot first gets a fast 600-sample estimate, then the full analysis in a Web Worker. Expect a point or two of Monte Carlo noise, more for single next cards. Next-card what-ifs reprice every legal next card: exactly on the turn, by sampling on the flop.

### Expected value

For pot `P` (including all bets so far), call cost `C` and equity `p`:

```text
EV(call)        = p × P − (1 − p) × C
Break-even      = C / (P + C)
EV(raise to R)  = f × P + (1 − f) × [p_called × (P + A) − (1 − p_called) × R]
EV(fold)        = 0   (incremental; chips already in are sunk)
```

`f` is the chance Atlas folds to your raise, computed from its policy over its likely range. `A` is what Atlas must add to call. `p_called` is your equity against only the hands that continue. You can override `f`; the override then applies to the whole range. EV assumes **no betting after this decision**, no rake, and treats re-raises as calls. A free check is valued as its check-down share of the pot.

### Grades

A decision’s grade is the EV it gave up against the best modeled option at that moment, as a share of the pot:

| Grade      | EV given up |
| ---------- | ----------- |
| Best       | ≤ 3% of pot |
| Good       | ≤ 8%        |
| Inaccuracy | ≤ 18%       |
| Mistake    | ≤ 35%       |
| Blunder    | > 35%       |

The thresholds leave room for Monte Carlo noise. Accuracy is 100 for a best-EV choice, falling linearly to 0 at half a pot given up.

Bets above 1.5× pot are priced and shown, but they are not used as the grading benchmark unless you chose them. The model values calling as a check-down (no implied odds) while a shove has no later betting, which would otherwise bias grades toward huge bets.

Grades judge decisions under this model, not results, and not perfect play.

### Luck versus skill

Expected result = the EV of your final decision minus the chips you had already put in. Variance = the actual result minus the expected result. Hands that ended with no decision from you count as zero variance.

### Optionality and the market analogy

```text
Choice value              = max(0, EV(selected continuation))
EV sensitivity per point  = (1 − f) × (P + A + R) / 100   (f = 0, A = 0 for a call)
```

The kink at zero illustrates the convexity of being able to decline before committing. It is not an option price. Next-card swing is not implied volatility, the information clock is not theta, and local sensitivity is not a Black–Scholes Greek. The lesson separately covers a vanilla call’s expiration payoff, `max(S − K, 0) − premium`.

### Insurance

```text
Net outcome  = −loss + min(loss, coverage) − premium
Fair premium = loss probability × coverage
```

The loss probability comes from simulated losses (not `1 − equity`, which would misprice ties), times `1 − f` for raises. Coverage pays only in the losing state. Fair cover leaves the mean unchanged and lowers the spread. Real policies add expenses, exclusions and deductibles.

The Protection lens also previews an all-in cashout (1% fee), run-it-twice dispersion and a full-Kelly ceiling for the selected exposure, using `allInCashout` and `kellyFraction`. These treat the exposure as terminal, compress ties into equity, treat two runouts as independent and assume a known, repeatable edge.

These are **conceptual connections**, not measured correlations with financial assets.

## Architecture

| Area              | Implementation                                                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Interface         | React 19 + TypeScript, Vite, hand-written CSS with light/dark design tokens, Lucide icons, bundled DM Sans and Manrope                   |
| Motion            | `motion` with shared spring tokens (`src/motion.ts`); feature code loads lazily through `LazyMotion`, as does the lab                    |
| Poker engine      | `src/lib/poker.ts`: immutable transitions with a public action history                                                                   |
| Hand evaluator    | `src/lib/sim.ts`: bitmask evaluator on integer cards, checked score-for-score against the original readable evaluator                    |
| Atlas             | `src/lib/atlas.ts`: style-dependent probabilistic policy and explanations                                                                |
| Spot analysis     | `src/lib/range.ts`: range posterior, per-combo tables and next-card repricing, run in one long-lived Web Worker with caches              |
| Model and grading | `src/lib/model.ts`, `src/lib/grading.ts`, `src/lib/finance.ts`: pure functions shared by the UI and tests                                |
| App state         | `src/state/trainer.ts` (reducer for hands, decisions, guesses, guided path) and `src/state/spots.ts` (keyed analysis cache)              |
| Persistence       | `src/lib/storage.ts`: validated localStorage v2 with v1 migration, export/import, and a `SyncAdapter` seam for optional cloud sync later |
| 3D                | Lazy-loaded Three.js view, opened on demand. GL contexts are released on close                                                           |

Practice against Atlas is client-side. The trainer makes no analytics, AI or network requests beyond loading itself, and stores no credentials; only opening the **Online** tab contacts the account service, and only when a deployment configures one. Settings, lessons and the last 100 hands (with decision grades and reads) stay in the browser. Reloading deals a fresh hand.

## Validation

- **Engine:** the fast evaluator matches the reference evaluator on 6,000 random 5–7 card hands; also covered are categories, kickers, wheel straights, blinds, minimum raises, effective-stack caps, short and covered all-ins, chip conservation over 500 randomized hands, and immutability.
- **Atlas:** the policy is monotone in equity and sums to one, styles are ordered, explanations are generated, and outputs are independent of the hero's cards.
- **Range model:** the posterior is normalized and excludes visible cards; a bet strengthens the range; uniform mode agrees with the independent estimator; river results are exact; bigger raises fold more of the range; and raise EV matches the finance formula.
- **Grading:** grades are monotone; folding the nuts is a blunder; overbets are excluded from the grading bar.
- **Trainer:** the guided path has unique hand ids, decision snapshots are frozen, guesses attach once per street, and finished hands queue for recording.
- **Components:** the guess gate hides the math until a read is locked; the action bar and hand review are covered.
- **Table and curriculum integration (Vitest + Testing Library):** lens links to curriculum modules; the paused live-hand bridge shows only visible cards; Atlas waits while you study; pause state and notebook survive round trips; deep links; returning focuses the table; hands are saved before grading finishes.
- **End to end (Playwright):** the full guess, act and review loop by keyboard; persistence across reload; every analyst view and the 3D view opened repeatedly without GL context warnings; lessons; dark mode with reduced motion; axe accessibility in light and dark; a phone layout with no horizontal scroll and a lab sheet that drags between snap points; and a frame-time check through an all-in runout.
- **Budgets and visuals:** `npm run build` fails if the entry chunk exceeds 150 kB gzip. `npm run e2e:visual` compares 24 seeded screenshots (light and dark, desktop and phone); record baselines with `-- --update-snapshots` before a UI change.

These do not replace testing with real learners, screen-reader users and a range of devices.

## Operations (online play)

Production is the Worker `quantpoker` on Cloudflare (site, `/api/*`, `/ws/*`, Durable Objects, queues) and the Supabase project `quantpoker` (accounts and the hand archive). Nothing below needs SQL.

**Hands per day.** Open [`/api/stats`](https://quantpoker.bbcroysalman.workers.dev/api/stats): archived and verified hands for each of the last 7 UTC days, from the archive, cached for 5 minutes. `hands` minus `verified` is the backlog still being checked (normally zero within a minute).

**Logs.** Cloudflare → Workers & Pages → `quantpoker` → Observability → Logs. Every event is one JSON line with an `evt` field and ids only (`worker/src/log.ts`; never cards, decks, secrets, tokens or addresses):

| `evt`                                  | When                                                                                                                                                                                                                       | Useful fields                                                    |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `match_start`, `hand_end`, `match_end` | a table deals hand 1, finishes a hand, ends                                                                                                                                                                                | `matchId`, `handNo`, `reason` (`complete`, `forfeit`, …)         |
| `forfeit`, `no_show`                   | three timeouts in a row; a paired player who never came                                                                                                                                                                    | `matchId`, `seat`, `userId`                                      |
| `limit_hit`                            | a socket or request cut off (codes below)                                                                                                                                                                                  | `userId`, `code`, `reason` (`rate_limited`, `too_large`, …)      |
| `outbox_retry`                         | an archive call or queue send failed and will be retried                                                                                                                                                                   | `matchId`, `rpc`, `attempt`, `depth` (calls waiting)             |
| `outbox_parked`                        | an archive call Postgres refused for its data 12 times (class 22/23 error) was set aside so the calls behind it could go through (a hand's verification is set aside with it); an `archive_parked:<call>` incident follows | `matchId`, `rpc`, `code` (HTTP status), `detail` (Postgres code) |
| `verified`, `verify_failed`, `dlq`     | the verify consumer's verdict; a hand it gave up on after 5 retries                                                                                                                                                        | `matchId`, `handNo`, `detail` (problem words)                    |
| `error`                                | anything unexpected (engine fault, alarm, archive, consumer)                                                                                                                                                               | `reason`, `detail`                                               |

Queries worth saving in the Logs view: `evt = hand_end` grouped by day (hands/day from the live side); `evt = error`; `evt = verify_failed or evt = dlq or evt = outbox_parked`; `evt = outbox_retry` with `depth > 20` (Supabase is down or refusing calls); `evt = limit_hit` grouped by `reason`. Check them weekly until there is an alert for each.

**Find a failed hand, end to end.**

1. Start from what you have: a player's match link (`#play/<matchId>`), a `verify_failed`, `dlq` or `error` line, or an `incidents` row.
2. Logs, filtered by `matchId = <id>`: the match's story in order (`match_start`, one `hand_end` per hand, any `limit_hit`, `outbox_retry` or `error`, then `match_end` with its reason).
3. Supabase → Table Editor → `hands`, filter `id` = `<matchId>:<handNo>` (a rated match's hand arrives as the next hand starts, or at the match end, once its luck is settled into `record.luck`): `verified` true means the server replayed it from the full deck and it matched its record and commitment. `incidents`, filter `match_id`: `kind` is `verify_failed` (with the `problems` that disagreed: `commitment`, `result`, `board`, `shown`, `reveal`, `holes`, `replay`, `chips`), `dlq`, `engine_fault` (with the full state as evidence), or `archive_parked:match`, `:hand` or `:end`. Such a row holds the refused call itself (`detail.rpc`, `detail.body`): fix the cause, then replay it by calling that function with `detail.body` as `p`. The calls are idempotent, so a replay is safe. A replayed hand stays `verified = false` because its verification was set aside with it; that is expected, not a failure. This table is service-role only.
4. `verified` still false and no incident: look for `outbox_retry` (the archive is behind; it retries with backoff and catches up on its own; only a call refused 12 times for its data is ever parked, never one that failed for an outage or a missing key) or `error reason=verify` (the consumer is retrying).
5. The player's own view: they can open "Review hand n" during the match; its "Deck verified" check runs in their browser against the commitment they were sent before the deal.

**Close codes and limits** (`src/shared/protocol.ts`, `worker/src/limits.ts`): `4001` another tab took the seat; `4400` an oversized frame or more than 5 illegal frames in one hand (the seat may reconnect); `4404` the table has closed (finished tables delete themselves 10 minutes after the end, unjoined invites after 24 hours); `4409` playing at another table; `4429` more than 20 frames or connects per 5 s from one account. HTTP `403 origin` for a socket from another site; `429` for more than 30 new invite tables per account per UTC day, or 300 signed-in requests per minute from one address (approximate, per Cloudflare location; a WAF rate-limiting rule on `/ws/*` and `/api/*` is the stronger control).

**Deploys.** Cloudflare builds and deploys `main` on every push; `.github/workflows/deploy-check.yml` then waits for that build and compares production with the commit, file by file (`npm run verify:deploy` does the same by hand). Before a deploy that adds queues or migrations:

- **Queues:** the deploy creates any queue `wrangler.jsonc` names as a producer, and both are. If the build's token may not create queues, the build fails and the old version keeps serving; then run `npx wrangler queues create <name>`.
- **Migrations:** apply new `supabase/migrations/*` first, or the verify consumer fails. Then rename the repo file to the version Supabase recorded (`list_migrations`), so the repo and the live history stay identical.

## Deliberate boundaries

- **The trainer is not money-safe:** practice against Atlas runs entirely in the browser with `Math.random`, and its state is inspectable in developer tools. Online play is designed to be server-authoritative instead, and is still play money only.
- **Not a solver:** Atlas is a transparent practice opponent. Grades reflect a simplified one-decision model of Atlas, not game-theory-optimal play.
- **Heads-up only:** bets are capped at the effective stack, so side pots never arise.
- **Not a certification:** the lessons are an introduction to risk thinking, not a quantitative-finance curriculum.

Next steps should come from learner feedback: multi-street EV, opponent styles learned from your own play, more lessons, and optional cloud sync of progress through the existing `SyncAdapter` seam.
