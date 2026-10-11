# Casual 6-max: heads-up assumptions and PR order

Date: 2026-10-10 · Produced by six parallel code readers and a synthesis, all line numbers checked at `6296feb`. Where this file and the ADR amendment (`.10x/decisions/architect/multiplayer-platform.md`, "Amendment 2026-10-10: Phase 2 casual 6-max") disagree, the amendment wins: it settles the decisions PR-03 lists below.

I checked the conflicting line numbers against HEAD `6296feb`, and the citations below are correct at that commit. Three of the reports cite wrong lines:

- **Lobby report:** it was written at `ccd5d5a`. Its `table.ts` numbers are about 2 lines early: `net` is at **275**, not 273; the "table full" check is at **329**, not 328.
- **Protocol report:** it cites `controller.ts:76-80`. The file has 44 lines; the hardcode is at **`controller.ts:33-37`**.
- **Table report:** it cites `rated.ts:184-187`. `outcomes()` is at **`rated.ts:35-43`** and `RATED_CONFIG` is at **`rated.ts:11`**.

Six things I found that the reports missed:

- **`gradeHand.ts`:** `src/lib/gradeHand.ts:31` returns `[]` for anything that is not heads-up.
- **`match_players` keys:** the table's primary key is `(match_id, seat)` and it is also unique on `(match_id, user_id)`. Both are at `supabase/migrations/20261008134201_matches_hands.sql:16-26`.
- **`record_match`:** it inserts `match_players` only on the first call (`20261010043000_rematch.sql:32-45`).
- **`record_hand`:** it adds net chips only to rows that already exist (`20261008134322_record_hand.sql:31-34`).
- **The newest migration:** `20261010100000_hands_after_match.sql:15-19` hides hands from clients while `matches.status='playing'`.
- **Per-socket state keyed by seat:** `sendEnded` and `lastAck` both use the seat number. `table.ts:1616,1624` pick `own` from the socket's stored seat, and `table.ts:203,417,684` key `lastAck` by seat.

---

## (1) Every heads-up assumption that must change, grouped by file

### src/engine/types.ts

- `:5-6`: `SeatId` is documented as "0..5", but `hand.ts:64` allows 2 to 10 players. Pick 6 as the single limit.
- `:16-22` `HandConfig` has:
  - no `sb`/`bb` seat;
  - no way to say the button or small blind is dead;
  - no "dealt in without posting" or sitting-out flag.
- `stackPolicy` does not exist in the engine. It appears only in the ADR (`.10x/decisions/architect/multiplayer-platform.md:97`) and in `tickets.md:65`.

### src/engine/hand.ts

- `:64-65`: 2 to 10 seats are allowed. Cap at 6.
- `:74-75`: "The button must be a seated player". This must be relaxed for a dead button.
- `:113-118`: blinds always come from `blindSeats(button)`. The engine needs to accept explicit `sb` (which may be null) and `bb`.
- These already work with an empty button seat, so leave them: `:194` (`advance(button)` after the flop) and `:201-202,220-230` (odd-chip order).

### src/engine/positions.ts

- `:9-13`: the comment documents a dead **small blind**, which contradicts the ticket.
- `:30-33`: `blindSeats` switches to "button is the small blind" as soon as `seats.length===2`. There is no rule for going from 3 players to 2.
- `:36-37`: `nextButton` is the "Phase 0" rule and is only used in tests.
- `:39-56`: `positionNames` returns `{}` for more than 6 seats and assumes a live button with the small blind next to it.

### src/engine/project.ts

- `:22` throws unless there are exactly 2 players.
- `:23-26` builds a me/opponent pair.
- `:36` uses `index===0?1:0`.
- `:70` takes the winner from the sign of net.
- `:73-80` writes the result text for one opponent.
- `:90-104` (`stateToHeroGame`, `kind:'hu-casual'`) is used by server grading. Keep it.

### Other src/ engine and library files

- `src/engine/luck.ts:28`: heads-up only. Rated only, so no change.
- `src/lib/gradeHand.ts:31`: returns `[]` unless there are 2 seats. This fits R-23 (casual hands are not graded).
- `src/lib/poker.ts:5,24-47`: `Player=0|1` and `Game` built from pairs. This is the trainer; do not generalise it.
- `src/lib/showdown.ts:9`: equity for exactly two hands.

### worker/src/controller.ts

- `:21-43`: the whole `LocalController`.
  - Seats are fixed at `0` and `1` (`:33-36`).
  - Stacks reset to the starting stack every hand.
  - The button is `(handNo-1)%2` (`:37`).
  - It returns null once `handNo > handsTotal` (`:29`).

### worker/src/table.ts

**Config and init**

- `:67-74`: `DEFAULT_CONFIG.kind 'hu-casual'`, with `bankMs 60_000`.
- `:258-263`: `handsTotal` is clamped to 1..100, which does not fit a session that never ends.
- `:264`: the rated flag.
- `:275-276`: `net` and `adjusted` start as `{0:0,1:0}`, so seat 2 and up gets **NaN** at `:695-696, :799-800, :943-944`.

**Seating**

- `:152,355-358`: `Attachment{userId,seat}` is fixed when the socket is accepted.
- `:279-280`: seats 0 and 1 are hardcoded.
- `:302`: `liveness` uses `===2`.
- `:329,339`: "table full" means `>=2` players.
- `:343`: the joiner is always `newPlayer(1…)`.
- `:362`: the match starts on `seated(0)&&seated(1)`.

**Per-socket state keyed by seat**

- `lastAck`: `:203,417,684,1601`.
- `illegalCount`: `:213,477-479`.
- The view is built from the stored seat: `:1594,1644`.
- `own` is picked by the stored seat: `:1616,1624`.

**Away and forfeit**

- `:505-517` and `:522`: casual seats get no grace or away state.
- `:559-565`: the match is abandoned only when every player is away.
- `:693,700-712`: 3 timeouts by one seat end the match.

**Hand data and archive**

- `:783`: `stacks` is a positional list.
- `:846,894`: `segment: 1`.
- `:189,1131`: 4-digit `outbox:` keys plus `outbox:9999:end`, so a match holds at most 9998 hands.
- `:763-766`: `deck:<n>` keys are only removed by `deleteAll` (`:1080`).

**End of match**

- `:1092-1097`: no-show triggers if any seat is absent.
- `:1109,1114-1120`: the forfeit outcome is written as `{0,1}`.
- `:1161-1174`: the lobby is released only at the end of the match.
- `:1229,1247-1250`: rematch logic for two players.

### worker/src/deadlines.ts

- `:39`: `FORFEIT_TIMEOUTS=3` ends the match. The ticket wants sit-out after 2.
- The bank refill is counted in hands (`bankRefillEvery`), not orbits.

### worker/src/rated.ts, rating.ts and grade.ts

- `rated.ts:35-43`, `rating.ts:42,94`, `grade.ts:14`.
- These are heads-up rated only. Leave them, but never let `six-casual` reach them.

### worker/src/lobby.ts

- `:324-360`: `startMatch(a,b)`.
- `:410,423`: `const [a,b]`.
- `:452-462`: `liveActive` drops `open` tables. A six table with one seated player is `open`, so that seat does not hold the account.
- `:436-440`: `release` is only called at match end.
- `:383-406`: the daily `creates` cap applies only to invites.

### worker/src/index.ts

- `:76`: the invite body is `{matchId,creator}`, with no kind.

### src/shared/protocol.ts

- `:15`: `PROTOCOL`.
- `:35`: `MatchKind`.
- `:36-49`: `MatchConfig` has no seat count, uses `handsTotal`, and refills the bank by hand count.
- `:65`: `rematch`.
- `:98-103`: `MatchInfo.players` has no stack, status or empty seats.
- `:114-123`: `SeatView.players` is ordered by seat, not keyed by it.
- `:178-191`: `RematchState`.
- `:213`: `welcome.seat` must be a seat number.
- `:218-225`: `hand_start.stacks` is a plain `number[]`.
- `:228-243`: `match_end` has a single `forfeit` seat.
- `:338-339`: the parser accepts only the two `hu-*` queue kinds.

### supabase

- `20261010010000_rated_matches.sql:13`: the `kind` check.
- `20261008134201_matches_hands.sql:16-26`: `match_players` keyed by `(match_id, seat)` and unique on `(match_id, user_id)`. This breaks seat reuse and re-sitting within one session.
- `20261010043000_rematch.sql:32-45`: players are inserted on the first call only, so late joiners get no row. Timeouts and abandoned are keyed by seat (`:60-66`).
- `20261008134322_record_hand.sql:31-34`: a late joiner's net is silently dropped.
- `20261010100000_hands_after_match.sql:15-19`: a session that stays `playing` hides all its hands.
- `ratings.sql:147-148` and `ladder.sql:56`: they require `hu-rated` / `hu-duplicate`. Leave them.

### UI

**`src/components/table/Table.tsx`**

- `:20,41`: `Spot` / `BetChips` know only hero and Atlas.
- `:82-84`: `versus` takes a single opponent name.
- `:102-105`: bets for `[0,1]` only.
- `:117-130`: pays the winner or splits in half; no side pots.
- `:149-158`: pot and runout as pairs; `faceUpEquity` for two hands.
- `:174-191`: "Heads-up · 10/20" label.
- `:235-239`: two spotlights.
- `:248-314`: one `.seat-atlas`; folded is detected from the text at `:249`.
- `:316,327,366`: `bets[1]` / `bets[0]`.
- `:410-436`: two runout rows.

**Other components**

- `ActionBar.tsx:186,245`: one opponent name.
- `PlayingCard.tsx:25,64,89`: `deal` is `'hero'|'atlas'|'board'`.

**`src/net/LiveTable.tsx`**

- `:86,121,178`: one opponent picked by `find`.
- `:129-145`: disconnect and clock copy for one opponent.
- `:206-222`: `full===2`, "Both players are here", invite link.
- `:261,267`: `toHeroGame` and `legalActions` on a 2-seat game.
- `:344`: `shortcuts={false}`, so no keyboard play.
- `:350,366-373`: rated flag and forfeit copy.

**Other src/net files**

- `MatchEnd.tsx:20,30,43,134,143` (rematch only, so it can stay).
- `matchResult.ts:73`.
- `MatchReview.tsx:223` drops seats 2-5.
- `Lobby.tsx:142-147` shows "Coming after heads-up."

**CSS (`styles.css`)**

- `:867-881`: two centred seat slots.
- `:1012-1026`: the bubble always opens to the right.
- `:1171-1178`: bet positions.
- `:1220-1258`: flight coordinates.
- `:1440-1445`: fold-muck motion.
- `:4141-4182`: phone overrides.
- `:4489-4502`: two spotlights.

### Tests

- `worker/test/leaks.test.ts:141-147`: seat pairs `[0,1]/[1,0]`, and `players[other]` indexed by array position.
- `worker/test/rated-leak.test.ts:46-55,146,258,263-264`.
- `src/shared/protocol.test.ts:26-33,55,108`.
- `worker/test/rating.test.ts:299-303`: the frame is never run through `checkFrame`.
- `e2e/live.spec.ts:60,110,127-146,177,248`.
- `e2e/mobile.spec.ts`: no table test.

---

## (2) PR order

Every PR goes red first: write the named test, show it failing in the PR description, then make it pass. Merge when green. "Lane W" means the PR edits `worker/src/table.ts`; `tickets.md:1042` serialises those PRs behind P1-22. Phases A and C-prep never edit `table.ts`, so they can start now.

### Phase A: engine, decisions, security harness (no table.ts)

**PR-01 · P2-01 crafted engine cases and soak record**

- **Files:** `src/engine/engine.test.ts`; `src/engine/testing.ts` (a deck builder for crafted hands); a log entry in the `.10x` SDE log (seed 20261010, 100k hands per size, CI run link).
- **Tests:**
  - `6-max: all-ins on three streets with odd-chip splits award in order`
  - `folded dead money stays in the pot it entered`
  - `a short stack all-in below the big blind`
  - an assertion that more than 1% of N>2 hands have a side pot (the line at `engine.test.ts:152` is already there; record the share in the log).
- **Red first:** the engine is probably already correct, so prove each test can fail. Temporarily reverse the odd-chip walk at `hand.ts:220-230` and the folded-chips rule in `pots.ts:9-33`, show red, revert, and write this in the PR.
- **Risk:** expected values copied from engine output prove nothing. Derive them by hand or from `referencePots`.

**PR-02 · 6-seat cap and `positions.test.ts` baseline**

- **Files:** `hand.ts:64-65` (2 to 6 players); new `src/engine/positions.test.ts`.
- **Tests:**
  - red: `validateConfig rejects 7 seats`;
  - baseline (green): `positionNames` for 2, 3, 5 and 6 seats; `nextButton` wraps around a gap.
- **Risk:** none. `randomTable` (`testing.ts:75-91`) never makes more than 6 seats.

**PR-03 · ADR amendment: six-casual rules (doc only; decision gate for PR-04/05/09/11/13/15)**

It records eleven decisions:

1. Standard dead button (`tickets.md:1025`) instead of the dead small blind at `positions.ts:9-13`.
2. The rule for dropping from 3 players to 2.
3. How R-20 (joiner dealt in without posting) fits with "never skip the big blind", plus a rule against standing up to dodge blinds.
4. Rebuy only between hands, topping up to exactly 100 bb.
5. Orbit = the big blind has moved past every seated player, pinned in a test (P2-04).
6. Session model:
   - one `matches` row per table session;
   - the session closes after `IDLE_MS` (600 s) with no hands;
   - the session rotates well before the 9998-hand outbox cap.
7. `match_players` keyed by user.
8. The `hands_after_match` exposure (see section 4).
9. Seatless sockets get no `SeatView`.
10. Protocol changes are additive, with no `qp.v2` bump until a field is removed.
11. Quick-sit is decoupled from P2-07.

The PR also fixes the comment at `positions.ts:9-13`.

- **Risk:** it needs architect sign-off. Every engine and worker rule below depends on it.

**PR-04 · P2-02a explicit blind seats and dead button in the engine**

- **Files:**
  - `types.ts:16-22`: add optional `sb?: SeatId|null` and `bb?: SeatId`.
  - `hand.ts:60-83`: when explicit blinds are given, the button may be unseated and `bb` must be seated.
  - `hand.ts:113-118`: use explicit seats when present, else `blindSeats`.
  - `positions.ts:48-56`: `positionNames` takes the optional `{sb, bb}`.
- **Tests (red):**
  - `dead button: empty button seat, no small blind, bb posts, first seat after bb opens`
  - `dead small blind`
  - `odd chip from the seat after an empty button`
  - `replay and verifyDeal accept a dead-button config` (`deck.ts:200-249`)
  - extend the random-hand test (`engine.test.ts:103-155`) so 10% of hands use explicit dead-button configs.
- **Risk:** `HandRecordV1.config` now carries `sb` and `bb`. Replays from the archive and the differential test (`differential.test.ts:94`) must stay byte-stable for heads-up, so leave the fields out when unused.

**PR-05 · P2-02b blind rotation between hands**

- **Files:** `positions.ts` gets `nextBlinds(prev:{button,sb,bb}, seated, joiners) → {button,sb,bb,dealtIn}`.
- **Tests (red):**
  - `when the next big blind leaves, the big blind still advances one seat and the button may be dead`
  - `no one posts the big blind twice in a row or skips it after departures` (10k random join/leave sequences)
  - `3→2 players: no big blind repeats`
  - `a joiner is dealt in next hand without posting` (R-20)
- **Risk:** the joiner rule can conflict with "skips it". Write the PR-03 interpretation into the test names.

**PR-06 · P2-02c carry-over and rebuy rule (pure functions)**

- **Files:** `positions.ts` or a new `src/engine/stacks.ts` with `rebuyTo(stack, bb, between: boolean)`. Optionally a `StackPolicy = 'reset'|'carry'` type in `types.ts` to make the ticket's assumption true.
- **Tests (red):** `rebuy only below 100 bb and only between hands`; it tops up to exactly 100 bb and never accepts an amount from the client.
- **Risk:** low. Enforcement in the worker comes in PR-14.

**PR-07 · Security harness for the six-seat wire (worker tests only)**

- **Files:**
  - `worker/test/frames.ts`: record each type seen by `checkFrame`.
  - `worker/test/rating.test.ts:299-303`: run the rating frame through `checkFrame` and check the nested `change` keys.
  - `worker/test/leaks.test.ts:141-147` and `rated-leak.test.ts:258`: loop over every (viewer, other) pair and find players by `seat`.
  - `e2e/live.spec.ts:110,248`: use `find(p=>p.seat!==you)`.
- **Tests (red):** `every FRAME_KEYS type passes checkFrame in some test`. This fails today because of the rating frame.
- **Risk:** test-only changes, but the heads-up assertions must not get weaker.

**PR-08 · Lobby frame allowlist**

- **Files:** `worker/test/frames.ts` gets `LOBBY_FRAME_KEYS: Record<LobbyMsg['t'], string[]>` via `keysOf`, plus `checkLobbyFrame`; `worker/test/lobby.test.ts`.
- **Tests (red):** `queued/matched/presence/error carry only allowed keys`, plus lobby type coverage.
- **Risk:** none.

**PR-09 · P2-03a `six-casual` kind and archive schema (no table.ts)**

- **Files:**
  - `protocol.ts:35`: add `six-casual`. The queue parser at `:338-339` still rejects it.
  - `protocol.ts:36-49`: add `maxSeats?: number`.
  - new `supabase/migrations/<ts>_six_casual.sql`:
    - add `six-casual` to the `kind` check;
    - change the `match_players` primary key to `(match_id, user_id)` and keep `seat` as the last seat;
    - `record_match` v6 inserts players on every call (`on conflict do nothing`); for `six-casual`, timeouts and abandoned are keyed by user.
  - `worker/test/archive.test.ts`; the migrations test.
- **Tests (red):**
  - `record_match adds a player who joins after hand 1`
  - `record_hand credits net to a late joiner`
  - `one session archives two accounts that used the same seat`
  - `apply_rating still refuses six-casual`
- **Risk:** this changes a primary key on a production table. It needs DBA review: lock time, rated count checks at `ratings.sql:140-155`, the `match_players_user` index, RLS on `match_players`.

**PR-10 · P2-03b `CashController` (controller.ts only)**

- **Files:**
  - `worker/src/controller.ts`: the interface becomes `nextHandPlan(handNo, config, roster?)`.
  - `CashController` uses `nextBlinds` and carried stacks, skips empty and sitting-out seats, and returns null when fewer than 2 seats are dealt in.
  - new `worker/test/controller.test.ts`.
- **Tests (red):**
  - `carries stacks`
  - `skips empty seats with gaps 0,2,5`
  - `dead button after the big blind leaves`
  - `null with one seated`
  - `deck from shuffleWith(randomInt), secret 32 bytes`
- **Risk:** `LocalController` must behave exactly as before. Pin it with a snapshot test.

### Phase B: TableDO, lane W (after P1-22 or an explicit lane release)

**PR-11 · P2-03c six-casual table: sit, play, carry-over (no stand yet)**

Files and changes, all in `worker/src/table.ts` unless noted:

- `init` (`:256-295`): handle `six-casual` with no opponent, an `idle` deadline, and no `handsTotal`.
- New `sit {seat?}` client message (`protocol.ts` parser plus `protocol.test.ts` accept, reject and fuzz lists).
- Seatless sockets get `welcome{seat:null, view:null}` (`protocol.ts:209-216`).
- Joining (`:329,339,343`) picks a free seat; the match starts at 2 or more seated (`:362`); `liveness` updated (`:302`).
- `net` and `adjusted` are built from the players present (`:275-276`).
- Stacks are stored on `Player`.
- `hand_start` gets an additive `seats:{seat,stack}[]` (`:783`, `protocol.ts:224`, `frames.ts`).
- Change seat keys to user keys:
  - the socket's seat is looked up from `match.players` by `userId` at every send (`:1594,1644,1616`);
  - `lastAck` and `illegalCount` keyed by user (`:203,213,417,684`);
  - `own` delivery through `record.seats` userId (`:1624`).
- New `worker/test/six.test.ts`.

Tests (red):

- `a sit during a hand is dealt in the next hand`
- `no seat ever sees another's hole cards before showdown at N=6`
- `a folded seat's cards never appear in views, record.shown or reveal.slots when the others reach showdown`
- `an all-in seat's cards stay hidden while two others keep betting`
- `gap seats 0,2,5`
- the differential swap test at `leaks.test.ts:273-309`, extended to every unseen seat (undealt slots are 17-51)
- `six clients … chips conserved across 200 hands` (without standing up)
- `sit frames carry only allowed keys`

Risks:

- Rated and casual heads-up paths regress. Run `leaks`, `rated-leak`, `seats` and `rematch` unchanged.
- The stored `Match` changes for existing DOs. Use additive optional fields and keep `v:1`.

**PR-12 · P2-03d stand up and seat reuse**

- **Files:**
  - `table.ts`: `stand` means auto-fold when the action reaches you, and the seat frees at the end of the hand. A freed seat cannot be taken until that hand is over.
  - Call `lobby.claim` on sit and `lobby.release` on stand (`:332,1161-1174`).
  - Add a per-user "is seated" RPC so `liveActive` (`lobby.ts:452-462`) does not drop `open` six tables.
- **Tests (red):**
  - `six clients sit, play and stand with chips conserved across 200 hands`
  - `a new occupant of seat k never receives the previous occupant's cards, own openings or acks`, including through `resync` and reconnect right after the hand
  - `stand frames carry only allowed keys`
  - `one table per account across six tables`
- **Risk:** this is where hole cards are most likely to leak (see section 4).

**PR-13 · P2-03e session lifecycle**

- **Files:**
  - `table.ts`: idle close calls `finish('complete')`, which writes the `record_match` result and releases the lobby.
  - Rotate to a new session and matchId at a hand cap fixed in PR-03, well under 9998 (`:189,1131`).
  - Delete `deck:<n>` once its `record_hand` has flushed (`:763-766`).
- **Tests (red):**
  - `idle table closes its session and archives the result`
  - `rotation keeps seats and stacks and starts a new matches row`
  - `deck keys do not accumulate`
- **Risk:** stacks and seats must survive the rotation. It also interacts with `hands_after_match`.
- **Contracts from PR-09's migration** (`20261010130000_six_casual.sql`):
  - `record_match` reads six-casual `timeouts` keyed by **userId** (session totals). `table.ts` sends them keyed by seat today, so PR-13 must switch the key for six tables, or every timeout is stored as 0.
  - Before the first six session is archived, the public review page (`src/net/publicMatch.ts`, `src/net/MatchReview.tsx`) must name players from each hand's `record.seats`, not `match_players.seat`. `(match_id, seat)` is no longer unique, so a six review would show the wrong names. This lands as its own small PR before PR-13.

- **Left by PR-11's review** (`worker/src/table.ts` at PR-11):
  - PR-12: a player who stands mid-hand must stay in `match.players` until that hand ends. `playerIn(seat)` reads the dealt account from there, and `applyActionNow`'s `player!` would otherwise throw inside `blockConcurrencyWhile` and reset the Durable Object.
  - PR-13: `setGameDeadline` drops `idle` deadlines, so a six table that falls back to `waiting` after its first deal has no idle deadline. Re-arm it in `waitForPlayers`.
  - PR-13: a six table that finishes (only `engine_fault` today) sends `match_end` to sockets without a seat too; six sessions send no `match_end` (ADR "Table and session"). Gate it with the session work.

- **Exposure gate (Devin, #44):** nothing may create a six table from outside (PR-24's route and quick-sit) until these have landed:
  - PR-12: lobby claims, so one account cannot sit at two tables (Devin's security finding). Landed in #46;
  - PR-16: busted or sitting-out players are stood up after 3 orbits or 5 minutes without a dealt hand, so busted occupants cannot fill a table for good. Built on branch `six-w16` (below);
  - PR-14 rebuy, or its ADR cut line (automatic top-up). Rebuy itself is built on branch `six-w14` (below); the cut line is not needed.
  - PR-17's "when the grace ends they sit out" (`sitOut(player)`), added after PR-16's review. A disconnected player keeps the status `playing`, and `funded()` counts only connected players, so at a table that cannot deal (fewer than two funded players connected) nobody times them out: nothing sits them out, PR-16 never stands them up, and `idle()` keeps any table someone sits at. One connected player and five disconnected ones fill a table for good, and quick-sit would find it full or send newcomers to a table that waits. PR-16's removal only starts once a player sits out; PR-17 is what sits out the ones who left. Built on branch `six-w16` (below), with the same protection for sockets a restart drops without a close.

  Until then six tables exist only through the table's own `/init`, which no route calls.

- **Left by PR-19's review** (`src/net` at PR-19). PR-12 and PR-13 landed first, so PR-19 settles both itself. The first needs no change: PR-12 keeps a player who stood in `match.players`, and so in the roster, until the hand ends. The second is done: the client starts its hands afresh under a new matchId.
  - PR-12: `plates()` in `SixTable.tsx` builds the ring from the roster (`MatchInfo.players`) alone. Once a player can stand mid-hand and leave the roster, their seat would show "Empty" or "Sit here" while their chips are still in the hand. Draw the seats dealt into the hand from `view.players` too.
  - PR-13: `HandSeen` in `client.ts` (`seen()`, `withView`) is keyed by `handNo` alone, and eviction drops the smallest keys. After the rotation restarts `handNo` at 1, the new session's hands would be evicted first, and `nameOf` in `SixTable.tsx` could read the old session's `record.seats` for the same number. Key it by `matchId:handNo`.

**PR-14 · P2-03f rebuy (cut line), and the seat controls: Rebuy and Stand up**

The plan gave `rebuy` (here) and `stand` (PR-12) server messages but no control to send them from the table. PR-14 now carries both controls; Sit out / Sit in controls go with PR-16's messages.

- **Files:** `protocol.ts` (`rebuy`, error codes `in_hand` and `not_below`), `table.ts`; uses `rebuyTo` and `buyIn` from PR-06. `SixTable.tsx`, `client.ts`, `useTable.ts`, `LiveTable.tsx`, `live.css` (lazy chunk); `e2e/sixTable.ts`.
- **Tests (red):**
  - `rebuy refused during a hand and above 100 bb`
  - `rebuy frames carry only allowed keys`
  - `a rebuy between hands tops up from the hand's final stack, once`
  - `a rebuy at 0 chips deals the player in at the next hand`
  - `a rebuy that funds a second player at a waiting table deals at once`
  - `between hands the roster carries the stacks the hand left`
  - `a rebuy between hands survives a restart before the next deal` (review)
  - `an account that stands and sits again before the next deal brings a fresh buy-in, not the hand's final stack` (review)
  - chip conservation counts rebuys: `six clients bust and rebuy, chips equal buy-ins plus rebuys across 200 hands`.
  - parser: `accepts a rebuy only bare, so no amount ever reaches the server`.
  - UI (`LiveTable.test.tsx`): Rebuy only below 100 bb out of the hand being played, bare `{t:'rebuy'}`; Stand up sends bare `{t:'stand'}`; "Leaving after this hand" after a stand from a live hand. After the review: no seat control while the socket reconnects or the table has closed, nor after the hand a player stood from ends; a double press sends one frame; a player who busts hears "No chips left: rebuy to be dealt in." from the seat controls' live region; "Leaving after this hand" survives a reload. e2e: the six-seat keyboard loop and a mid-hand stand.
- **Risk:** an amount sent by the client must be ignored. The parser refuses any `rebuy` that carries more than its type.
- **As built (branch `six-w14`):**
  - The rule is the ADR's: a seated account not dealt into the hand being played (one who sat after the deal is not in it; one who folded still is), below 100 bb, tops up to exactly 100 bb. Refusals: `not_seated`, `in_hand`, `not_below`; `illegal` at a heads-up table.
  - The finished hand's stacks reach `match.players` only at the next deal (`settleStacks`). A rebuy between hands reads the final stack and settles the hand itself before adding the top-up, so the deal does not overwrite it. The stack is credited before any await: a second rebuy finds 100 bb.
  - **Roster stacks between hands (ADR amended; signed off by the architect, 2026-10-11).** `MatchInfo.players[].stack` was "as of the last deal", so between hands it showed the stack a player began the hand with, and the client could not tell who may rebuy. It is now the chips outside the hand being played: as of the deal while the player is dealt into it (unchanged), otherwise what the next hand deals them (the hand's final stack, or 100 bb after a rebuy). The PR-14 review confirmed it is safe: a socket without a seat still gets no per-action `state`, `hand_start`, `hand_end` or `reveal`, and it sees a hand's final stacks at its end rather than at the next deal, 3 s later, numbers the next deal would show it anyway. Even with the old frame code, the early settle a rebuy needs would put final stacks in its roster broadcast, so the ADR's wording had to change, not the code. The ADR's "Sockets without a seat" row now says this (it said "stacks as of the last hand start"), and its "Wire" row lists `not_below`.
  - `worker/test/frames.ts` lists every `ErrorCode` (typed both ways) and `checkFrame` refuses an unlisted code, and refuses six-only codes in heads-up flows.
  - The stakes live in `src/engine/stacks.ts` (`SIX_BLINDS`), read by the worker's `SIX_CONFIG` and by the live table to know 100 bb. The server tops up from the table's stored `match.config.blinds`; if stakes ever vary per table, 100 bb must come over the wire.
  - **After the review:** the rebuy's own storage write has a restart test. `settleStacks` and `stackOf` skip a player marked `justSat` (sat since the deal), so an account that stands and sits again before the next deal keeps its fresh buy-in; only the 2-minute cooldown prevented it before. Rebuy, and Stand up between hands, hide once sent until the answer changes the hand, the stack or the seat, or the socket drops. The pending-stand marker is kept per tab in `sessionStorage` (`qp.six.stoodFrom` = `matchId:handNo:seat`).
  - **Open (product):** Stand up during a hand takes one press, right under the action bar, and folds at the next action. A confirm step for the mid-hand case only is the reviewer's suggestion; not built.
- **Left for PR-16:** the ADR says a player at 0 chips sits out. Today their status stays `playing` and the controller and the deal skip them for having no chips. PR-16's removal rule (stood up after 3 orbits or 5 minutes without a dealt hand) must count a busted player's undealt hands, or a busted player who never rebuys holds the seat for good. The client says "No chips left: rebuy to be dealt in." to that player.

**PR-15 · P2-04a orbit bank**

- **Files:** `deadlines.ts` gets `orbitDone(...)`; `MatchConfig` gets `bankRefill:'orbit'`, while rated keeps `bankRefillEvery`; `table.ts:743-745`; new `worker/test/six-clock.test.ts`.
- **Tests (red):** first the orbit-definition test, then `the bank refills each orbit` (30 s bank, 20 s decision).
- **Risk:** the dead button or joiners could stretch an orbit.
- **Left by PR-15 for PR-16:**
  - An orbit starts in one place: the deal in `startNextHandNow`, when `orbitDone(...)` returns `refill`. Count "the third orbit start after they sat out" from that event, not in hands, and keep the count in `match` (by account) so it survives a restart and a session rotation, as `orbitTravel` does.
  - The refill sets every seated player's bank, so a player sitting out has the whole bank when they `sit_in`. That is the ADR's "every seated player"; change it there first if sitting out should keep a spent bank.
  - A corrupt `orbitTravel` halts the table, as a bad stored deck does. That is not a pattern to copy for the per-account counts: see "Clarifications from PR-15" in the ADR before choosing what a bad count does.

**PR-16 · P2-04b sit-out and removal**

- **Files:**
  - `table.ts:693,712`: for `six-casual`, 2 timeouts in a row means sitting out. Heads-up keeps `FORFEIT_TIMEOUTS=3`.
  - The controller skips sitting-out seats.
  - A seat is removed after 3 orbits sitting out.
  - New `sit_in` client message.
  - `MatchInfo.players` gains `status` (`protocol.ts:98-103`, `frames.ts`).
  - **Sit out / Sit in controls** in `SixTable.tsx`, next to PR-14's Rebuy and Stand up in the "Your seat" group (the plan had no UI for them): Sit out sends `sit_out`, Sit in sends `sit_in`, keyboard and screen reader friendly like the other seat controls.
- **Tests (red):**
  - `two timeouts sit a player out and three orbits out remove them`
  - `a busted player who never rebuys is stood up after 3 orbits or 5 minutes` (PR-14 left a player at 0 chips `playing`; the deal skips them).
  - frame allowlist for the new message and status field.
  - UI: Sit out and Sit in appear only when allowed and send their bare messages.
- **Risk:** a sitting-out seat must still be released from the lobby when it is removed.
- **As built (branch `six-w16`):**
  - **Statuses.** `Player.status` (already on the wire as `MatchInfo.players[].status`) turns `sitting_out` on the second missed decision in a row (`SIT_OUT_TIMEOUTS = 2` in `deadlines.ts`, read only `if six`), on a `sit_out`, or when a hand ends with the player on 0 chips (both end paths: a hand played out and one the blinds finish at the deal). It turns `playing` on a `sit_in` (timeouts back to 0) or a rebuy from 0 chips. The hand being played is not touched: a player who sits out during it plays it out on the normal clock, and the next deal leaves them out (the CashController already dealt only `playing` seats with chips). Every change is a roster broadcast, sockets without a seat included. A `sit_in` that makes two players to deal at a waiting table deals at once.
  - **Messages and refusals.** `sit_out` and `sit_in` are bare (parser tests). Without a seat: `not_seated`; at a heads-up table: `illegal`. Repeating one changes nothing (a `sit_in` from a playing player does not reset their count). A `sit_in` with no chips: new typed code `no_chips` (an honest client can send it during the hand that busts it, so not `illegal`). `no_chips` is in `ERROR_CODES` and the six-only codes in `worker/test/frames.ts`; new flow `FLOW_TYPES.sitOut`.
  - **Removal.** `Player.outOrbits` counts orbit starts since the player sat out, at the one place PR-15 defines (`orbitDone(...).refill` in `startNextHandNow`, whatever `bankRefill` says); `Player.outSince` is when they sat out. Both run from the first sit-out since the player was last dealt in: a `sit_in` (or a rebuy from 0) keeps them, and only a deal that deals the player in clears them (after the review: a `sit_in` and `sit_out` with no hand between used to restart both, so two clicks every few minutes held a seat for good). At the third orbit start (`SIT_OUT_ORBITS`, as that hand is dealt) or `SIT_OUT_MS` (5 min) after `outSince`, whichever comes first, they are stood up: the stand path (unseat, a welcome with `seat: null`, a roster broadcast, `releaseSeats`) with **no sit cooldown**. One `sitout` deadline at the earliest due time is recomputed inside `armAlarm` (`syncSitOut`) and kept by `setGameDeadline`. A player dealt into the hand being played is never stood up during it, and has no deadline until it ends.
  - **Bad counts.** An `outOrbits` that is not 0 to 2, or an `outSince` that is not a number from 0 (1970) to now (`outSinceOk`; after the review, which found a future time never repaired and a far-past one making `setAlarm` throw), is reset (to 0, or to now), logged (`evt: error`, `reason: sitout_count`) and recorded as an incident `sitout_count:<userId>` with what was stored. The table plays on. A bad time is read as due now so the alarm repairs it at once; before this, a non-number time made `setAlarm(NaN)` throw on every write that armed the alarm.
  - **UI** (`SixTable.tsx`, lazy chunk): Sit out (a seated player who is playing, during a hand too) and Sit in (sitting out with chips; a busted player gets Rebuy instead), one bare frame per press with the button hidden until the answer. The seat controls' live line: "Sitting out from the next hand." while they still play that hand, "Sitting out: sit in to be dealt in." after it, "Back in from the next hand." after a sit in until they are dealt. A plate dealt into the hand being played shows as playing until it ends. A player the table stands up reads "You were stood up after sitting out." (inferred by the client: no wire marker). e2e: Sit out and Sit in in the six-seat keyboard loop.
  - **Tests** (`worker/test/six-sitout.test.ts`): `a voluntary sit_out takes effect from the next hand`; `sit_in deals a player in at the next hand and resets their timeouts`; `a sit_in at a waiting table that makes two players to deal in deals at once`; `two timeouts sit a player out and three orbits out remove them`; `a removed player's lobby claim is released`; `a player sitting out is stood up after 5 minutes without a dealt hand`; `a player who sits out during a hand they are dealt into keeps the seat until it ends`; heads-up guard `a heads-up table sits nobody out, refuses sit_in and sit_out, and still forfeits on the third timeout`; `a busted player sits out until a rebuy deals them in, without sit_in`; `a player who loses their last chips in a hand over at the deal sits out`; `a busted player who never rebuys is stood up after 3 orbits or 5 minutes`; `statuses, orbit counts and the five-minute timer survive a Durable Object restart`; `a bad orbit count is reset to 0 and recorded, and the table plays on`; `a bad sit-out time is reset to now and recorded, and the alarm keeps running`; `sit_in and sit_out frames carry only allowed keys`. Parser: `accepts a sit_in or sit_out only bare, whatever else it carries`. UI: five `LiveTable.test.tsx` cases and one `client.test.ts` case.
  - **After the review** (blocker: two clicks held a seat for good; nits). New: `a sit_in and sit_out with no dealt hand between keeps the five-minute clock`; `a sit_in and sit_out with no dealt hand between keeps the orbit count` (one of its toggles is a rebuy from 0); `a dealt hand spends the removal clocks, so the next sit_out starts them again`; UI `a player sitting out who stood during her hand and reloaded is not told the table stood her up` and `a stand that never reached the table does not hide a later removal`. Made able to fail (each reviewer mutation that survived is now red): a `sit_in` while playing keeps one missed decision; a rebuy from 0 clears a stored miss; the alarm removal leaves no cooldown (the player sits straight back down); `sit_out` stores its own `sitout` deadline. `a bad sit-out time ...` gained a time a day ahead and one at -1e300. Declined: a cooldown after removal (trade-off in the ADR's "Removal is a stand without the cooldown").
  - Decisions where the ADR was silent are in the ADR's "Clarifications from PR-16".
- **Left by PR-16 for PR-17:**
  - PR-17 is now on the exposure gate (above): until it lands, disconnected players at a table that cannot deal are never sat out, so never stood up.
  - A disconnected six player with status `playing` is still dealt in today: `funded()` (connected) only decides whether a hand can be dealt, and the plan deals every `playing` seat with chips. Such a player now times out twice and sits out, which is the protection the exposure gate wanted. PR-17's "when grace ends they sit out" should call `sitOut(player)`, so `outSince` and the removal clock start there and the roster broadcast goes out; it must not unseat anyone dealt into the hand being played (`leavable`).
  - Away turns count as timeouts (ADR "Reconnect"), so with the grace a player can sit out by timeouts before the grace ends; both paths set the same status, and `sitOut` is a no-op the second time.
  - The removal timer runs from the sit-out, not from the disconnect: a player who drops for 60 s and then sits out has 5 more minutes.

**PR-17 · P2-04c 60 s reconnect for six-casual**

- **Files:** `table.ts`: apply the grace and away handling (`:505-575`) to `six-casual`. When grace runs out the seat sits out, never ends the table. The "every player away" rule becomes "fewer than 2 active, then pause". `GRACE_MS` is at `rated.ts:25`.
- **Tests (red):** `a reconnect within 60 s keeps the seat and cards`; the reconnect `welcome` has only that user's cards for the current hand.
- **Risk:** away turns still count as timeouts, so they interact with the 2-timeout sit-out.
- **As built (branch `six-w16`):**
  - **The grace.** A six player who is `playing` and whose last socket closes gets the rated `GRACE_MS` (60 s), as a `grace` deadline that carries their `userId` (seats change hands; heads-up graces are stored as before, seat only). During it nothing changes: they are still dealt in when the table deals, their turns run on the normal clock, and their timeouts count, so two of them sit the player out first. Back within it (`back()`), the grace ends; missed decisions stay until their own move or `sit_in`. When it ends without them (`sixGraceOver`), they sit out through PR-16's `sitOut(player)`, which starts the removal clock and tells everyone, seatless sockets included. No rated "away" state, no instant turns, no forfeit, no void: a hand they are dealt into goes on with their turns on the normal clock, and they are stood up 5 minutes (or 3 orbit starts) later unless they `sit_in`.
  - **Pause.** "Fewer than two active, then pause" is `funded()` at the deal, unchanged: seated, `playing`, chips, socket open. A player in their grace does not make the table deal but is dealt in when it does. A two-player table pauses the moment one drops and deals again when they are back within the grace (or after `sit_in` once it has run out).
  - **Sockets closed without a close.** A restart drops every socket and the restarted object hears no close, so the alarm starts a grace for every seated `playing` player with no socket and none running (`graceForAbsent`), and after the review so does every join. After the review a `sit` that lands after its socket closed during the lobby claim takes no seat and releases the claim (unless a second tab's `sit` is still claiming). A removal or stand clears the player's grace, so one stood up during it who sits again gets a whole 60 s.
  - **UI** (`SeatPlate.tsx`, `SixTable.tsx`, `live.css`, lazy chunk): a seat whose player's socket is closed (`MatchInfo.players[].connected`, already on the wire) says "Disconnected", with an icon hidden from screen readers, inside the seat's group; `data-away` marks the plate. No new frame field. e2e: the 320 px fit test drops two of the widest plates (`fakeSixTable({ away })`). After the review, only a viewer with a seat sees it (`plates(..., seated)`): a socket without a seat gets no frame when a player drops or comes back, so its `connected` can be stale.
  - **Tests** (`worker/test/six-reconnect.test.ts`): `a reconnect within 60 s keeps the seat and cards`; `the reconnect welcome has only that user's cards for the current hand` (over the wire, with a seat not dealt in and a seatless socket also back, `FLOW_TYPES.reconnect`); `a player gone past 60 s sits out and is not dealt in after reconnecting until sit_in`; `away turns count as timeouts and two of them sit the player out`; `a table whose active players drop below two pauses and resumes`; `a grace that began before a Durable Object restart still ends with a sit-out` (and one back within it after the restart keeps playing); `a player whose socket a restart closed unseen gets the grace at the next alarm`; `is not seated, and its lobby claim is released` (lobby claim race; after the review, it asserted a grace before); `a player stood up during their grace gets a whole grace when they sit again and drop`; guard `heads-up casual has no grace, and rated keeps its grace, instant turns and void`. UI: `a seat whose player has dropped says Disconnected on its plate until they are back`.
  - **After the review** (blockers: no test dealt a hand during a grace; the marker was wrong for sockets without a seat; nits). New tests: `a player in their grace is dealt in when the table deals` (three players, seat 4 drops between hands, hand 3 deals [0,2,4] with seat 4 on the normal clock, its timeout counted, then sitting out at the grace end); `reconnecting within the grace keeps the decisions missed during it`; `a grace begun at a waiting table arms the alarm for its end`; `the first player back after a restart starts the grace of everyone still away`; `leaves the claim to a second tab whose sit is still waiting`; UI `a viewer without a seat is never told who has dropped`. Changed: the restart test lets the turn alarm start both graces before anyone is back, so the alarm sweep stays tested beside the join's; the away-turns test checks a player sitting out gets no new grace; the heads-up guard plays on to the third miss and the forfeit, as its comment claimed. Code: the join sweep, the sit that takes no seat for a closed socket, the seated-only marker. Each test that pins existing behaviour was shown red by the review's mutation (M1, M5, M6, M7) or one of our own. Declined: keeping the first grace's end across reconnects (flapping), recorded in the ADR as the same trade-off as PR-16's re-sit script.
  - Decisions where the ADR was silent are in the ADR's "Clarifications from PR-17".
- **Left by PR-17:**
  - Every item on the exposure gate is now built: PR-12 landed in #46, PR-14 is in this branch's base, and PR-16 and PR-17 are on `six-w16`. The gate can lift once this branch is reviewed and merged.
  - For the architect: the plan's "every player away" became "fewer than 2 active", and PR-17 reads "active" as connected (`funded()`), so a player in their grace does not make the table deal but is dealt in when it does. Rated's "away" means past the grace, so the literal reading would count players in their grace as active and deal to an empty chair at a two-player table for up to 60 s. Recorded with the alternative in the ADR's first PR-17 clarification; `a player in their grace is dealt in when the table deals` and `a table whose active players drop below two pauses and resumes` pin the two halves.
  - Seat-holding by scripts (PR-16's re-sit, PR-17's flapping) has one answer if it shows up: per-account counts of removals and grace sit-outs, then longer refusals to sit.

### Phase C: UI (spike first; PR-18 can start after PR-09; PR-19 needs PR-11)

**Spike (half a day, not merged).** Six plates at 320 px. Recommendation: build a new ring in the online chunk instead of generalising `Table.tsx`.

- `Table.tsx` and `ActionBar.tsx` are in the entry chunk (`App.tsx:65-66`).
- The entry chunk has about 7.7 kB of gzip headroom left under the 150 kB limit in `scripts/check-bundle.mjs:6`.
- The decision goes into the ticket or ADR.

**PR-18 · P2-05a ring layout and `SeatPlate`**

- **Files:** new `src/net/SeatPlate.tsx` and the ring, `src/net/SixRing.tsx` (imported only from the `LiveApp` path); slot = `(seat−you+6)%6`; CSS in `src/net/live.css`. No `lib/atlas` or `lib/scripted` imports (`src/net/imports.test.ts:9-22`).
- **Tests (red):** `src/net/SixRing.test.tsx › six seats render names, stacks, bets and the active timer`; `role=group` and `aria-label` per seat.
- **Risk:** check-bundle must keep the entry chunk flat; record its output in the PR.

**PR-19 · P2-05b wire six-casual into `LiveTable`, keyboard, phone fit**

- **Files:**
  - `LiveTable.tsx`: choose the component by kind; render straight from `SeatView`, no `toHeroGame` (`:261,267`); turn on keyboard (`:344`).
  - "6-max · Hand N" match bar.
  - `e2e/mobile.spec.ts`: fake the socket with `page.routeWebSocket` and log in with `sessionStorage['qp.devToken']`.
  - `e2e/live.spec.ts`.
- **Tests (red):**
  - `mobile.spec › a six-seat table fits 320 px without horizontal scroll`
  - `live.spec › keyboard loop at a six-seat table`
- **Risk:** the board is already 260 px against about 242 px of felt at 320 px; it needs `--card-md-w:40px`.
- **From the PR-18 review:**
  - The board also overflows the oval's middle column from 681 px to about 860 px: about 239 px wide at 681 px, while five cards at the default `--card-md-w: 60px` need about 316 px. Set `--card-md-w` to 40–44 px inside `.six-ring` below about 860 px, or move the breakpoint.
  - Which slot is the bottom, and which way is clockwise, lives only in the grid areas in `live.css`; the unit test checks only `data-slot`. `mobile.spec` asserts that the slot 0 plate is the lowest and that slot 1 is to its left.
  - Add a test that no file outside `src/net` imports `SixRing` or `SeatPlate`, so the ring stays in the online chunk.

**PR-20 · P2-05c (optional) move the heads-up live table onto the ring and take `toHeroGame` out of the live path**

- **Files:** `LiveTable.tsx`. Keep `project.ts:90-104` for grading.
- **Tests:** the existing `live.spec` heads-up flow stays green.
- **Risk:** this is a heads-up visual regression for little gain. It can wait.

**PR-21 · P2-06a side-pot stacks without animation (cut line)**

- **Files:** the ring and pot rendering, from `view.pot.layers` and `result.awards`.
- **Tests (red):** `Table.test › side pots render separately and pay out in award order` (last side pot first, `types.ts:175-176`).
- **As built** (`SixTable.tsx` `SidePots`, `live.css`, lazy chunk; no frame field, no server change):
  - **What the wire carries.** `pot.layers` is the engine's `state.pots`: during a hand, the chips gathered on finished streets only (pre-flop it is empty; this street's bets are on the plates, and in `pot.total`), with eligibility already narrowed by folds. At the result it is the final pots, which `result.awards[].pot` indexes.
  - **One pot keeps today's look.** With fewer than two layers the middle reads "Pot <total>" during the hand and nothing at the result, as before. With a side pot the total line stays and a list "Pots" follows it: "Main pot", "Side pot 1", "Side pot 2", each with a colon and its amount ("Main pot: 1,200"), and for screen readers who can still win it by name ("between bob, you and dave"; always two or more, since a pot down to one seat leaves every other player all in or folded and the engine runs the hand out in the same act). Both lists carry `role="list"`, which Safari otherwise drops under `list-style: none`.
  - **The result.** An ordered list "Pots paid" in award order (the order of each pot's first award, so the last side pot first and the main pot last), each pot "Side pot 2: 800 to you" or "Main pot: 1,000, split: you 500, dave 500" (screen readers hear "chips" after the amount). As in `resultText`, only seats that were paid chips are named; every share is at least 1 chip, since each seat that can win a pot put at least 1 chip into it. The result line under the table (`resultText`) is unchanged.
  - **Tests.** `src/net/LiveTable.test.tsx`: `side pots render separately and pay out in award order`, `a split side pot shows each winner's share`, `the pots paid name who was dealt in, after a seat changes hands`, `a player seated after the deal sees the side pots by name`, guard `a hand with a single pot still reads Pot and its total`. e2e: `a six-seat table with two side pots fits 320 px, in the hand and at its result` (`fakeSixTable({ sidePots })` scripts two all-ins to the river; the board and the pot list clear every plate from 320 to 860 px, during the hand and with three "Pots paid" lines naming the longest username); `a six-seat table fits 320 px when its side pots are split between the longest names` (`fakeSixTable({ sidePots, split })` deals a royal flush on the board, so every pot is split four, five and six ways).

**PR-22 · P2-06b per-seat chip motion and the frame gate**

- **Files:** per-seat `--fx/--fy/--tx/--ty` flights; drop `backdrop-filter` at ≤680 px; `e2e/motion.spec.ts`.
- **Tests (red):** `a 3-way all-in runout with two side pots has no long frames` (median ≤ 34 ms, at most 3 frames over 150 ms).
- **Risk:** CI hardware. Run the existing frame test at 6 seats first.
- **As built** (`SixFlights.tsx`, `live.css`, lazy chunk; no frame field, no server change; `Table.tsx` and `styles.css` untouched):
  - **Baseline first.** `fakeSixTable({ runout })` scripts a 3-way all-in with two side pots: evangeline_marten all in for 940 pre-flop, bartholomew_99 for 1,500 on the flop, ozymandias_kings for 2,600 on the turn, each called by maximilian_okafor; the river runs out and three pots go to three seats. The engine runs a board out in the act that closes the betting, as a real table does, so the street-by-street pace comes from the all-ins landing on successive streets (a move every 600 ms), and every frame is one a real table could send. The frame test samples `requestAnimationFrame` exactly as the heads-up one (now a shared helper, thresholds unchanged) and records its numbers as a report annotation. Before any motion, three runs: 427/426/442 frames, median 16.7 ms, 0 over 150 ms, longest 50.1 ms.
  - **Choreography.** When the board grows or the result arrives, each seat that had chips out sends one flight from its bet row to the pot: what it put in since the last frame and no longer has in front of it (`(invested - bet) - (invested before - bet before)`), so an uncalled part handed back does not fly, nor a bet made on a later street that a reconnect's welcome skipped to. At the result each award flies from its pot (its own pill when there are side pots) to its winner's plate, in award order: the first pot 600 ms after the result, once the bets have landed, each next pot 350 ms later; a split pot's winners leave together, one flight each. The trainer's 0.6 s curve; a short fade-in keeps a pot on its pill hidden until its turn.
  - **Positions.** Measured once, in a layout effect when flights launch, from the boxes SixRing laid out (`data-seat` on each plate, `data-pot` on each pill; the pot line, or at the result the pots paid or the board), and set per flight as `--fx/--fy/--tx/--ty`; flights move by transform alone. A fixed spot per slot was not used: the ring's rows are as tall as what is in them (board, pots, hole cards, a plate's extra line), so it would miss the plates. The layer clips its flights, since a transformed box counts toward the page's width: the 320 px side-pot fit test caught a flight measured at 860 px still in the air after the window narrowed.
  - **Decoration only.** The layer is `aria-hidden` and `pointer-events: none`; nothing launches under reduced motion (`useReducedMotionConfig`, so `?motion=off` too), and live.css hides any under the media query. Timers clear on unmount; a new hand takes the last hand's chips off at once, and so do a hand gone from the page (a stand's welcome has no view) and a new seat for the viewer (`SixFlights` takes SixRing's `you`), since either moves the places the chips fly between.
  - **backdrop-filter.** The only one on a six table's page is the sticky header's; at ≤ 680 px a six table makes it a solid bar (`body:has(.six-table) .header`, live.css). Measured ad hoc on Pixel 7 emulation with the plates scrolled under it: no difference (588/589/589 frames vs 589/588/587, median 16.7 ms either way), so it is a precaution for weaker phone GPUs.
  - **Tests.** `src/net/LiveTable.test.tsx`: `when a street closes each seat's bet flies from that seat to the pot`, `at the result each pot flies from its pill to its winner, the last side pot first`, `a split pot sends a flight to each winner at once, after the last bets are gathered`, `a flight starts at its seat's bet and lands on its pot or winner, wherever the ring puts them` (boxes stubbed; red when a seat is found by its ring slot), `no chips fly under reduced motion`, `chips leave the ring once they land, and a new hand takes any still flying`, guard `a heads-up live table keeps the trainer's chip flights`; from the review, `a bet nobody called flies only its called part to the pot`, `a result sent again flies its pots once`, `chips in the air go at once when the hand leaves the page or the ring turns to a new seat`, `a reconnect that lands on a later street flies only the last street's chips, not a bet made since` (flight amounts read off the drawn chips). e2e: `a 3-way all-in runout with two side pots has no long frames` (motion.spec; it also records every flight the page launches and samples one in the air), `Sit here takes a click through the chip flights' layer` (motion.spec), `the header is solid over a six-seat table on a phone, and keeps its blur on the trainer` (mobile.spec). Each test was shown red by its own mutation (commit bodies).
  - **Frame numbers with motion.** Three runs in a row, one worker: 452/449/472 frames, median 16.7 ms, 0 over 150 ms, longest 50.1 ms. With the CPU throttled 4x (ad hoc): 472/471/474, median 16.7 ms, p95 33.4 ms, the same as the baseline throttled (p95 33.4 ms).
  - **Review fixes** (each red first; each mutation the review found surviving now fails a test, shown in the commit bodies):
    - F1, reconnect double-fly: the gather was `bet before + invested change`, right only once the bet is back to 0, so a welcome landing on a later street flew the seat's new bet while it was still on the plate (300 for 100 in the test). Now `(invested - bet)` before and after.
    - F2, chips left in the air: a stand's welcome (no view) or a new seat for the viewer turned the ring under flights still flying. Both now clear them like a new hand.
    - T1, real flights in the frame test: a MutationObserver records each `.six-flight` (flop, turn and result gathers, then pot-2, pot-1 and pot-0 to their winners, then the next hand's), and the first one is sampled mid-air: opacity above 0, transform moving, animation `FLY_MS` long, keyframes on opacity and transform only. Kills C8 (nothing rendered), C10 (`display: none`), C11 (6 s) and C1 (left/top keyframes).
    - T2, uncalled bet (M10b); T3, the same result frame twice and a welcome with the result (M4); T4, a single pot leaving the board's centre (M12); T5, the payout's exact schedule, `[600, 950, 1300]` ms with `FLY_MS`, `PAY_MS` and `NEXT_POT_MS` exported, and a split pot's winners no sooner than `FLY_MS` (M11a, M11b).
    - T6, a mouse click on Sit here through the flights' layer reaches the table (C5, `pointer-events: none` removed).
    - T7, the header test runs six table first, then back to the trainer with no reload and live.css still loaded (C3, the rule widened to `.header`), and checks 681 px keeps the blur (C4).
    - T8, a stall per launch: one hand that runs out on the turn closes at most three streets, so the fake now plays the next hand too (`nextHand()`, dealt 3 s after the result as the table does; the bust player sits out, the dead-button blinds come from `nextBlinds`, and the viewer folds her big blind by mouse). Four launches in the window, so C9 (250 ms per launch) gives 4 long frames against the gate's 3. Thresholds unchanged.
    - Frame numbers after the review, three runs in a row, one worker: six seats 668/653/662 frames (the next hand makes the window longer), median 16.7 ms, 0 over 150 ms, longest 66.7/50.1/50.1 ms; heads-up 204/210/205 frames, median 33.3 ms (its bimodal median, below), 0 over 150 ms, longest 66.7/83.4/83.4 ms.
- **Left by PR-22:**
  - The heads-up frame test is bimodal on this container on identical code: its median is 16.7 ms in some batches and 33.3 ms in others, 0.7 ms under its 34 ms limit, reproduced on the build before PR-22. Removing every `backdrop-filter` on the trainer's page (seat plates, runout panel, header) makes it 16.7 ms in every run. Worth its own change to `styles.css`, with the heads-up visual baselines, since it touches the trainer's look.
- **Left for later** (product calls for the PM, not defects):
  - A card-by-card runout at six seats: a six table shows a run-out board at once with the result, since the server deals it in one act; the heads-up table reveals it card by card (`useRunout`), which here would be a client-side choice.
  - Holding the plates' final stacks until the payout chips land: at the result a six table's plates show the final stacks at once, before the pots' chips land, while the heads-up table holds its stacks through its runout. Holding them for the payout (about 1.9 s) is a product call.

### Phase D: lobby (P2-08, decoupled from P2-07; needs PR-11)

**PR-23 · P2-08a table registry**

- **Files:** `lobby.ts` stores `table:<id>` → `{seated, maxSeats, avgPot, playersPerHour, updatedAt}`, with a `reportTable` RPC. TableDO reports from the hand-over branch (`table.ts:691-704`), at most once per 30 s, and removes the entry on idle (`:1066-1090`).
- **Tests (red):** `lobby.test › the table list shows seats, average pot and players/hour`.
- **Risk:** lobby wake-ups. This is a single global DO (`lobby.ts:68-72`).
- **As built** (branch `claude/sharp-cannon-4150j6`; new `worker/src/registry.ts`, `lobby.ts`, `table.ts`; no frame field, no client change, no route):
  - **Definitions.** Nothing defined the figures, so they are in the ADR's "Clarifications from PR-23":
    - `avgPot` is the mean final pot (the sum of `result.awards`, so an uncalled bet is not counted) of the last 20 hands that ended within the hour, in chips, or `null` when none did.
    - `playersPerHour` is the number of distinct accounts dealt into a hand that ended within the hour. It is not extrapolated and is capped at 100.
    - `seated` counts the accounts holding a seat, sitting out included. `maxSeats` is 6.
    - `updatedAt` is the lobby's clock when the report landed.
  - **Lobby.** `table:<tableId>` holds the four counts and `updatedAt`. `reportTable` copies the counts by name in one `put`; `removeTable` is one `delete`. `tables()` lists the fresh entries in quick-sit's order (a free seat first, fullest first, then full tables, ties by id) and deletes entries more than 20 minutes old (`REGISTRY_STALE_MS`, twice `IDLE_MS`). Nothing outside the Worker's own objects calls it.
  - **Table.** A six table reports when a hand ends (both end paths), when a seat is taken, and when a seat frees between hands (stand, removal by the `sitout` alarm or at a deal). It also refreshes at every idle check that keeps it. It is removed when it deletes itself (sent once the sockets are closed and `deleteAll` is done, so no sit lands between the decision and the deletion) and when it halts (`finish`).
    - The throttle is at most one report per 30 s by the table's clock (`REPORT_MS`). A change inside the window sets `listing.pending` and goes out with the first alarm (`sendHeldReport`, at the end of `alarm()`) or change after it.
    - A held change has no deadline of its own, so every existing alarm time is unchanged: `six-reconnect.test.ts` pins two of them exactly. The cost is that at a waiting table a held change can lag until the next idle check.
    - Reports are fire-and-forget through a chain (`listingCalls`), so they reach the lobby in order. A failure is logged as `lobby_report` and held again.
    - `listing` (the window, `reportedAt`, `pending`) is stored with the write it describes and read back after a restart.
    - A session rotation changes nothing in the registry. Heads-up tables never report and write no new key.
  - **Why not the outbox.** Its calls are ordered and stop at the first failure, so a Supabase outage would freeze the list though the lobby is up. A report is last-writer-wins, so retrying an old one is pointless, and queued reports would add storage writes.
  - **Tests.**
    - `worker/test/lobby.test.ts` › the six-table registry: `the table list shows seats, average pot and players/hour`; `lists the fullest table with a free seat first, and full tables last`; `an entry not refreshed for 20 minutes is not listed, and is dropped`; `an entry holds counts only, whatever a report carries`; `a table removed from the list is no longer listed`.
    - `worker/test/six-registry.test.ts`: `reports at most once per 30 s per table; a change held back goes out at the first alarm after`; `avgPot and playersPerHour cover the hour before a report, and avgPot at most the last 20 hands`; `what a table sends names no account: four counts`; guard `a heads-up table never reports, nor leaves a list it was never on`; `a table that deletes itself removes its entry`; `a six table that halts leaves the list`; `a waiting table refreshes its entry at each idle check, so it never goes stale`; `a report the lobby refuses stops neither the hand nor the table, and is sent again`; `a restart keeps the 30 s throttle and the hour of figures`; `a session rotation keeps the entry and its figures under the table id`; `no client path lists or creates six tables yet` (the exposure gate: `GET /api/tables` is 404, the lobby answers `tables` and a `six-casual` queue with `illegal`, no lobby frame names the table, and `POST /api/matches` still makes a `hu-casual` table); and two on the figures (the cap of 100, and the window's edge to the millisecond).
    - Each test was shown red by its own mutation (commit bodies). The six-table helpers `sixTable`, `sitDown`, `playOut` and `eventually` are now in `worker/test/helpers.ts`; the older six test files keep their local copies.
- **Left by PR-23 for PR-24:**
  - Quick-sit reads `LobbyDO.tables()`. An entry can lag a held change by up to one idle check and can name a table that died within the last 20 minutes. So quick-sit must treat `table_full`, `sit_cooldown` and a table that answers `closed` alike: try the next table, and drop an entry whose table answered `closed`.
  - The `tables` frame (or `GET /api/tables`) needs `LOBBY_FRAME_KEYS` entries. Its rows should be exactly `tableId` plus the four counts; `updatedAt` is the lobby's own business.
  - The 50-table cap has to be counted. `tables()` lists only tables that have reported, which means tables someone has sat at.
  - **Open (PM):** `playersPerHour` is read literally as distinct players. If "players/hour" meant hands per hour (H/hr) or players per flop, rename the field before PR-25 shows it.

**PR-24 · P2-08b quick-sit**

- **Files:** a lobby `sit` client message, which resumes the player's current table first (`lobby.ts:232-238`); a global cap on lobby-created tables; a `tables` frame or `GET /api/tables`; a distinct "table full" answer for retries (today it is a 403 JSON response at `table.ts:329-330`).
- **Tests (red):**
  - `quick-sit picks the fullest table with a free seat`
  - `quick-sit retries the next table on full`
  - the `tables` frame passes `LOBBY_FRAME_KEYS`.

**PR-25 · P2-08c `TableList`**

- **Files:** new `src/net/TableList.tsx`; `Lobby.tsx:142-147`; `lobbyClient.ts:13-26,179-205`.
- **Tests (red):** `TableList.test › lists tables with seats taken of 6 and Quick sit navigates to the table the lobby chose`.

### Phase E

**PR-26 · P2-11 evidence**

- **Files:** `scripts/smoke-ws.ts --six`; `e2e/live.spec.ts › two browsers at a six-seat table`.
- **Result to show:** 200 hands with joins, leaves, timeouts and a reconnect; 0 invariant failures; 0 leaks; p95 printed.
- **Blocked by:** P2-09 and S7-05 telemetry for p95. Counting the first 1,000 human hands also needs U-4 (`SUPABASE_SECRET_KEY` plus a real match).

---

## (3) Contradictions between tickets and code

1. **P2-02's riskiest assumption is false.** `stackPolicy` exists only in `multiplayer-platform.md:97`, and `tickets.md:65` marks it ✓. The engine has no policy field (`types.ts:16-22`), and the worker resets stacks itself (`controller.ts:33-36`).
2. **Dead button vs dead small blind.** The ticket (`tickets.md:1025`) asks for a dead button; the comment at `positions.ts:9-13` says dead small blind. Neither is implemented, and `hand.ts:74-75` refuses a dead button outright.
3. **Seat-count limit.** It is 0..5 in `types.ts:5`, 2 to 6 in `positions.ts:39-45` (with `{}` above 6 at `:50`), 2 to 10 in `hand.ts:64`, and 0..5 in the DB (`matches_hands.sql:19,33`).
4. **P2-01 status.** The architect calls the gate met (`six-max-arena.md:9`), but the ticket's acceptance (`tickets.md:1015-1018`) needs three crafted tests that do not exist, plus a run log in the SDE log.
5. **P2-03 lists `src/engine/redact.test.ts` for the new messages.** That file only tests `seatView`. Wire messages need `worker/test/frames.ts` entries and flow tests in `six.test.ts` and `leaks.test.ts`.
6. **P2-03's proposed "one `matches` row per table session" does not fit the schema or the table code.**
   - Primary key `(match_id, seat)` and unique `(match_id, user_id)` (`matches_hands.sql:16-26`).
   - Players inserted only on the first `record_match` (`rematch.sql:32-45`).
   - `record_hand` silently drops late joiners' net (`record_hand.sql:31-34`).
   - Timeouts and abandoned keyed by seat (`rematch.sql:60-66`).
   - `handsTotal` clamped to 1..100 (`table.ts:258-263`), with the controller returning null after it (`controller.ts:29`).
   - The 9998-hand outbox cap (`table.ts:189,1131`).
   - `hands_after_match.sql:15-19` hides every hand of a session that is still `playing`.
7. **P2-04 clock.** The ticket's "30 s bank per orbit" does not match `bankMs 60_000` (`table.ts:73`) or the hand-count refill (`protocol.ts:44-48`, `table.ts:743-745`). "Sit-out after 2" does not match `FORFEIT_TIMEOUTS=3` (`deadlines.ts:39`), which ends the match (`table.ts:693,712`).
8. **P2-04 "60 s reconnect keeps the seat".** It exists only for rated (`table.ts:508,522`), and when rated grace ends, turns are played instantly and still count as timeouts (`:669-675`). With six-max rules that means sitting out after 2 instant timeouts, so the interplay must be defined.
9. **R-20 (a joiner is dealt in without posting) against P2-02's "nobody skips the big blind".** Standing up and re-sitting dodges blinds; there is no missed-blind rule anywhere.
10. **P2-05 says to generalise `Table.tsx`, but that would spend the bundle budget.**
    - `Table.tsx` and `ActionBar.tsx` are in the entry chunk (`App.tsx:65-66`), with about 7.7 kB of headroom under the 150 kB limit (`check-bundle.mjs:6`).
    - The ADR says networked code lives only in `LiveApp` (`multiplayer-platform.md:169`).
    - `Table.tsx:3,7` import `lib/atlas` and `lib/scripted`, which `src/net` must not import (`imports.test.ts:9-22`, which checks direct files only).
    - "Atlas avatar for Atlas only" also rules out reusing the current plate.
11. **P2-05 "retire `toHeroGame`".** `stateToHeroGame` (`project.ts:90-104`) is used by server grading, so only the live path may drop it.
12. **Dependencies the shortest path ignores.**
    - P2-08 depends on P2-07 (`tickets.md:1112`), which is not in the architect's path or in this set. Quick-sit works without bots.
    - P2-11 depends on P2-09 (`tickets.md:1153`), which is not in the set.
    - P2-03 depends on P1-22 (`tickets.md:1042`), which needs the user's go-ahead (`tickets.md:993`).
13. **Grading.** R-23 says casual hands are not graded (`tickets.md:727`), and P2-09 grades 6-max decisions. The code already skips them: `gradeHand.ts:31` returns `[]` for more than 2 seats, and `rated` is set only for `hu-rated` (`table.ts:921`).
14. **Rebuy timing.** The PM says "at any time when below"; the ticket says only between hands. The ticket is narrower; follow the ticket.
15. **Blinds.** The PM says 1/2; the code uses 10/20 with 2,000 chips. R-10 says the code is the truth.
16. **The protocol report recommends bumping to `qp.v2`.** Additive fields (`hand_start.seats`, `MatchInfo.players[].status/stack`) avoid breaking old clients. Bump only when `stacks` is removed. This needs a decision in PR-03.
17. **Quick-sit needs a retryable "full" answer.** Today `join` returns a 403 JSON response (`table.ts:329-330`). Also, lobby-created tables escape the daily `creates` cap (`lobby.ts:383-406`), so a global cap is needed.

---

## (4) Security points

### The server owns cards and chips

- **Deck and secret stay server-side.** The deck comes from `shuffleWith(randomInt)` (`controller.ts:40`, `shuffle.ts:5-14`). The deck and secret live only in DO storage (`table.ts:763-766`) and the archive call (`:899-906`, into `hands_private`, which has no client policy). They never go into a frame. The commitment is sent before any card (`:773`).
- **Chips and seats come only from the server.** The rebuy amount is computed server-side (`rebuyTo`). Stacks are carried over by the controller and never accepted from a client. `sit {seat}` is the first client message that names a seat:
  - check that it is in `0..maxSeats-1` and free;
  - take identity only from the token (keep `seats.test.ts:69,94` passing);
  - parse it with `onlyKeys`;
  - add it to the `protocol.test.ts` accept, reject and fuzz lists.

### Seat reuse is the main new leak path. Three places key on the seat number instead of the user

| Where                                                                            | What could leak                                                                                                                                            |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Views are built from the socket's stored seat (`table.ts:152,355-358,1594,1644`) | If a new player takes seat k while the previous occupant is still in the hand, `seatView(hand,k)` would show the new player the old occupant's hole cards. |
| `sendEnded` sends `own[storedSeat]` (`:1616,1624`)                               | A new occupant who sends `resync` or reconnects after the hand would get the previous occupant's hole-card openings.                                       |
| `lastAck` and `illegalCount` are keyed by seat (`:203,213,417,684`)              | The new occupant inherits the old one's acks and illegal-move count. This is an integrity problem rather than a leak.                                      |

Fix:

- Look up the viewer's seat from `match.players` by userId at every send.
- Store the seat-to-user map for each hand in `Current`, and pass `null` as the viewer when the user was not dealt into the hand.
- Do not let anyone take a seat freed during a hand until that hand ends.
- Tests go in PR-11 and PR-12.

### Redaction tests for every new frame or field

New table frame fields and messages: `hand_start.seats`, `MatchInfo.players[].status/stack`, `welcome.seat:null`, `sit`, `stand`, `rebuy`, `sit_in`, and later the bot flag. Each needs:

1. a `FRAME_KEYS` entry or nested `keysOf` list (`worker/test/frames.ts:32-174`);
2. a `checkFrame` branch (`:214-234`);
3. a flow test that sends it, adds its type to the exact expected-type set, and runs `checkFrame`, the `analysisKeys` scan, and a check that no unshown hole-card value appears in the JSON.

On top of that:

- **Coverage test (PR-07):** the set of types seen must equal `Object.keys(FRAME_KEYS)`. The rating frame must go through `checkFrame`, which it does not today (`rating.test.ts:299-303`).
- **Lobby frames (PR-08, PR-24):** a `LOBBY_FRAME_KEYS` allowlist, with the 4 existing types backfilled and the new `tables` frame added. Registry entries carry counts and averages only; no userIds or usernames unless PR-03 decides otherwise.
- **Six-seat paths no worker test has run yet:**
  - folded with showdown: the folder's cards never appear in a view, `record.shown` or `reveal.slots`, and only the folder gets its `own` opening;
  - one all-in while two or more others keep betting;
  - seats with gaps (0, 2, 5);
  - the differential swap of every unseen seat's holes with undealt slots 17-51 (`leaks.test.ts:273-309`);
  - every view still shows the viewer's own cards.
- **Seatless sockets** get `view:null` and never a `SeatView`. No spectators in v1. If spectators come later, `seatView(state, null)` needs its own leak test.

### Archive and RLS

- **`hands_after_match`** (`20261010100000_hands_after_match.sql:15-19`) is security-positive for a session that stays `playing`. But PR-13's rotation makes earlier segments' hands public (decision times, shown hands) while the same opponents are still seated. That is the exposure #31 closed for rated play. PR-03 must accept it for casual or add a rule, for example readable only after the table closes or only by participants.
- **Late joiners and seat reuse in the archive:** `holesByUser` and `hand_holes_own` stay correct. `match_players` must be re-keyed by user (PR-09), or nets are silently dropped, which hides wrong payouts.
- **`deck:<n>` keys** (deck plus secret) pile up in a long-lived DO. Delete each one once its archive call has flushed (PR-13). Logs, incidents and close reasons stay card-free; extend the `log.ts` sink test to the new incidents.

### Account and abuse controls

- **One table per account.** The lobby claims on sit and releases on stand (today release happens only at `table.ts:1161-1174`). `liveActive` drops `open` tables (`lobby.ts:452-462`), so a one-player six table would not hold the account. Add a per-user "is seated" check.
- **Limits:**
  - `sit` and `stand` spend from the per-account frame budget (20 per 5 s, `limits.ts:16-17`);
  - add a global cap on lobby-created tables;
  - the illegal-move limit is counted per user;
  - a cool-down on standing up and re-sitting at the same table stops blind dodging and resetting the timeout count (PR-03 / PR-05).
- **Rated code must never see `six-casual`.** `apply_rating` already requires `hu-rated` (`ratings.sql:147-148`). Keep the verify message's `rated` flag tied to `kind==='hu-rated'` (`table.ts:921`), and add a test in PR-09.
- **Protocol version.** Any breaking frame-shape change must bump `PROTOCOL` (`protocol.ts:15`) so old clients get a 426 (`index.ts:196`) instead of misreading the frames. Misreading would mislabel seats rather than leak cards.
