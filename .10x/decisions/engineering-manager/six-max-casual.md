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
  - PR-12: lobby claims, so one account cannot sit at two tables (Devin's security finding);
  - PR-16: busted or sitting-out players are stood up after 3 orbits or 5 minutes without a dealt hand, so busted occupants cannot fill a table for good;
  - PR-14 rebuy, or its ADR cut line (automatic top-up).

  Until then six tables exist only through the table's own `/init`, which no route calls.

**PR-14 · P2-03f rebuy (cut line)**

- **Files:** `protocol.ts` (`rebuy`), `table.ts`; uses `rebuyTo` from PR-06.
- **Tests (red):**
  - `rebuy refused during a hand and above 100 bb`
  - `rebuy frames carry only allowed keys`
  - chip conservation counts rebuys.
- **Risk:** an amount sent by the client must be ignored.

**PR-15 · P2-04a orbit bank**

- **Files:** `deadlines.ts` gets `orbitDone(...)`; `MatchConfig` gets `bankRefill:'orbit'`, while rated keeps `bankRefillEvery`; `table.ts:743-745`; new `worker/test/six-clock.test.ts`.
- **Tests (red):** first the orbit-definition test, then `the bank refills each orbit` (30 s bank, 20 s decision).
- **Risk:** the dead button or joiners could stretch an orbit.

**PR-16 · P2-04b sit-out and removal**

- **Files:**
  - `table.ts:693,712`: for `six-casual`, 2 timeouts in a row means sitting out. Heads-up keeps `FORFEIT_TIMEOUTS=3`.
  - The controller skips sitting-out seats.
  - A seat is removed after 3 orbits sitting out.
  - New `sit_in` client message.
  - `MatchInfo.players` gains `status` (`protocol.ts:98-103`, `frames.ts`).
- **Tests (red):**
  - `two timeouts sit a player out and three orbits out remove them`
  - frame allowlist for the new message and status field.
- **Risk:** a sitting-out seat must still be released from the lobby when it is removed.

**PR-17 · P2-04c 60 s reconnect for six-casual**

- **Files:** `table.ts`: apply the grace and away handling (`:505-575`) to `six-casual`. When grace runs out the seat sits out, never ends the table. The "every player away" rule becomes "fewer than 2 active, then pause". `GRACE_MS` is at `rated.ts:25`.
- **Tests (red):** `a reconnect within 60 s keeps the seat and cards`; the reconnect `welcome` has only that user's cards for the current hand.
- **Risk:** away turns still count as timeouts, so they interact with the 2-timeout sit-out.

### Phase C: UI (spike first; PR-18 can start after PR-09; PR-19 needs PR-11)

**Spike (half a day, not merged).** Six plates at 320 px. Recommendation: build a new ring in the online chunk instead of generalising `Table.tsx`.

- `Table.tsx` and `ActionBar.tsx` are in the entry chunk (`App.tsx:65-66`).
- The entry chunk has about 7.7 kB of gzip headroom left under the 150 kB limit in `scripts/check-bundle.mjs:6`.
- The decision goes into the ticket or ADR.

**PR-18 · P2-05a ring layout and `SeatPlate`**

- **Files:** new `src/components/table/SeatPlate.tsx` and a ring component (imported only from the `LiveApp` path); slot = `(seat−you+6)%6`; CSS in `src/net/live.css`. No `lib/atlas` or `lib/scripted` imports (`src/net/imports.test.ts:9-22`).
- **Tests (red):** `Table.test.tsx › six seats render names, stacks, bets and the active timer`; `role=group` and `aria-label` per seat.
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

**PR-20 · P2-05c (optional) move the heads-up live table onto the ring and take `toHeroGame` out of the live path**

- **Files:** `LiveTable.tsx`. Keep `project.ts:90-104` for grading.
- **Tests:** the existing `live.spec` heads-up flow stays green.
- **Risk:** this is a heads-up visual regression for little gain. It can wait.

**PR-21 · P2-06a side-pot stacks without animation (cut line)**

- **Files:** the ring and pot rendering, from `view.pot.layers` and `result.awards`.
- **Tests (red):** `Table.test › side pots render separately and pay out in award order` (last side pot first, `types.ts:175-176`).

**PR-22 · P2-06b per-seat chip motion and the frame gate**

- **Files:** per-seat `--fx/--fy/--tx/--ty` flights; drop `backdrop-filter` at ≤680 px; `e2e/motion.spec.ts`.
- **Tests (red):** `a 3-way all-in runout with two side pots has no long frames` (median ≤ 34 ms, at most 3 frames over 150 ms).
- **Risk:** CI hardware. Run the existing frame test at 6 seats first.

### Phase D: lobby (P2-08, decoupled from P2-07; needs PR-11)

**PR-23 · P2-08a table registry**

- **Files:** `lobby.ts` stores `table:<id>` → `{seated, maxSeats, avgPot, playersPerHour, updatedAt}`, with a `reportTable` RPC. TableDO reports from the hand-over branch (`table.ts:691-704`), at most once per 30 s, and removes the entry on idle (`:1066-1090`).
- **Tests (red):** `lobby.test › the table list shows seats, average pot and players/hour`.
- **Risk:** lobby wake-ups. This is a single global DO (`lobby.ts:68-72`).

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
