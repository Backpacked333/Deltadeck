# Trust fixes: the October 2026 foundation audit (F01–F17)

Date: 2026-10-13 · Status: **Built**, on `claude/admiring-wright-wweve6`, not merged. The four migrations must reach Supabase before the Worker and client that use them.

## Why

A five-specialist audit of `9de1fd8` found ten high-priority defects (F01–F10) and seven smaller ones (F11–F17). A follow-up plan ("earn trust first, then earn the right to personalize") grouped them under four missing guarantees: ownership, completion, provenance, reconciliation. Before any fix, each finding was traced in the current code: all seventeen reproduce. The UI-only commit after the audit (`70f61e0`) touched none of them.

## What was decided

Keep the plan's diagnosis, its release contract (each finding has a regression test that fails on the old code), and its order: the game's promises before any claim about learning. Build less machinery than the plan proposed, where a smaller change gives the same guarantee:

| Plan proposed | Built instead | Why it is enough |
|---|---|---|
| Command envelope with ids for seat commands (F03) | The table's word: own-only `leaving` on `welcome`/`state`; the client waits for it, and the move watchdog asks with `resync` | Seat commands are idempotent (`stand` is guarded, `rebuy` tops up to 100 bb and refuses above), so the table's state is the acknowledgement |
| Reservation tokens and generations (F06) | `LobbyDO.claimBoth([guest, host])`, both or neither, held in the table's `liveness` while asked | Match ids are random UUIDs, and every release already compares the id: they are the generation. The hole was that the host was never claimed |
| Settlement certificate entity (F07) | `apply_rating` itself requires the evidence, in its own transaction; the verifier recomputes luck | Puts the gate "where rating writes happen" with no new table to keep in step |
| Revisions plus a merge framework (F09) | A semantic merge (`src/curriculum/core/merge.ts`) and a revision compare-and-set in the existing trigger | Unions for evidence, both texts for notes, a reset tombstone; old clients fail closed |
| Server-owned hand-completion envelope (F02) | Shared reveal timings (`src/shared/pacing.ts`); the table waits for the reveal plus 3 s | One source of the numbers; a late client already skips to the current hand, and "Review hand N" keeps the result |

## The contracts, in one line each

- **Short blind (F01):** preflop the bet to match is at least the big blind, capped at what the other live seats can put in.
- **Pacing (F02):** after a heads-up all-in, the next deal waits `runoutMs(board before) + 3 s`; six tables and fold-ended hands wait 3 s.
- **Stand (F03):** "leaving" is shown only from the table's `leaving`; a request with no answer is resynced, never resent.
- **Restart (F04):** the first join or alarm after a restart starts a rated seat's grace from then, once; both away is void.
- **Invite start (F05):** a guest seated while the host is away waits 30 s, then the table closes and frees both; a casual guest may stop waiting at once.
- **One active table (F06):** an invite claims host and guest together before it can start.
- **Rating (F07):** rated only on hands 1..n, all verified, naming its players, whose luck nets add up to the result the outcome follows from; arriving evidence `55000`, contradicting or lost evidence `23514`.
- **Saves (F08, F10):** "saved" means the account acknowledged the latest version; otherwise `pending`, `unverified` (never read the account) or `blocked` (too large, daily cap). Sign-out leaves only on "saved".
- **Curriculum (F09):** a write names its base revision plus one; a conflict merges and retries; a reset drops older work everywhere.
- **Smaller ones:** a move at its deadline is stale (F11); the ladder trend sums each match's own change (F12); "latest 500" orders by play time (F13); an unreadable rating refuses the rated search (F14); a used-up review bank is a content limit, not a lapse (F15); modeled EV is compared over the modeled hands only, with the coverage shown (F16); held or composing keys are not decisions (F17).

## What was left, and why

- **Gate B in full** (evidence layer, skill graph, learner projections, recommendation policy, interventions, the controlled pilot). It needs authored transfer content, real elapsed time for delayed checks and real learners; schema built now would be guesswork. Its preconditions are now true: saves are honest, curriculum work survives two devices, and review scheduling no longer punishes a content shortage.
- **Historical ratings.** The new gate applies from the deploy. Whether any past rating rests on bad evidence needs a read-only audit of production, which this work did not have access to.
- **Real-device measurement** (intent-to-render timings, Safari background tabs) and the plan's flags, dashboards and runbook drills.
- **Six-casual archived hands** dealt under the old short-blind rule and verified after the deploy can raise a `verify_failed` incident; six-casual is unrated, so nothing else follows.
- **Casual heads-up** keeps its rule that three timeouts forfeit, with no grace: unchanged by this work.
