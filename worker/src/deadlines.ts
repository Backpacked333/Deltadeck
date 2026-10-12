// Everything the table waits for, as data: one list, one alarm at its
// earliest entry. Each entry says exactly which decision or hand it belongs
// to, so a late, early or repeated alarm can never act on the wrong one.
import { legalActions } from '../../src/engine/hand'
import { orbitTravel } from '../../src/engine/positions'
import type { Blinds } from '../../src/engine/positions'
import { EngineError } from '../../src/engine/types'
import type { HandState, PlayerAction, SeatId } from '../../src/engine/types'

export type Deadline =
  | {
      kind: 'turn'
      at: number
      handNo: number
      actionIndex: number
      seat: SeatId
    }
  | { kind: 'nextHand'; at: number; handNo: number }
  | { kind: 'outbox'; at: number }
  /** A paired table both players must open by `at`, or it is a no-show. */
  | { kind: 'start'; at: number }
  /**
   * A table with no more play: an invite nobody joined, or a finished
   * match. At `at` it deletes itself once its archive calls are done.
   */
  | { kind: 'idle'; at: number }
  /**
   * Rated: a seat whose socket closed. If it is not back by `at`, its turns
   * are played for it at once (GRACE_MS in rated.ts). Six-casual: a player
   * who is playing and has no socket open; not back by `at`, they sit out.
   * There the grace belongs to the account (`userId`), since seats change
   * hands; `seat` is only where they sat when it began. Heads-up graces
   * carry no `userId`, so they are stored as they always were.
   */
  | { kind: 'grace'; at: number; seat: SeatId; userId?: string }
  /** Rated, finished: a lone Rematch press expires at `at` (REMATCH_MS). */
  | { kind: 'rematch'; at: number }
  /**
   * Six-casual: the first player sitting out whose time runs out at `at`
   * (SIT_OUT_MS in table.ts) is stood up then. One entry, for the earliest.
   */
  | { kind: 'sitout'; at: number }
  /**
   * Six-casual, waiting: a change to the table's entry in the lobby's list
   * that the throttle held goes out at `at`, when its window has passed
   * (REPORT_MS after the last report). It does nothing itself: every alarm
   * ends by sending a held report that is due (ADR, clarifications from
   * PR-24, decision 6).
   *
   * An invite table waiting for its guest, with its host connected: `at` is
   * the next heartbeat to the lobby (OPEN_HEARTBEAT_MS after the last), or
   * sooner when a join request or a reservation lapses, so the host's
   * prompt follows. Again it does nothing itself: every alarm ends with the
   * invite's tick (ADR amendment 2026-10-12, "Live games").
   */
  | { kind: 'report'; at: number }

/** A finished table keeps its storage this long for late arrivals. */
export const IDLE_MS = 600_000
/** An invite table nobody joined closes after this long. */
export const INVITE_TTL_MS = 24 * 3600_000

/** Consecutive missed decisions that end the match as a forfeit. */
export const FORFEIT_TIMEOUTS = 3
/**
 * Six-casual: consecutive missed decisions that sit a player out from the
 * next hand (ADR amendment 2026-10-10, "Sitting out"). A six table never
 * ends for one player's timeouts; heads-up keeps FORFEIT_TIMEOUTS.
 */
export const SIT_OUT_TIMEOUTS = 2

/** When the player to act runs out: their decision time, then their bank. */
export function turnDeadline(
  hand: HandState,
  startedAt: number,
  decisionMs: number,
  bankMs: number,
): Deadline | null {
  if (hand.toAct === null || hand.street === 'showdown') return null
  return {
    kind: 'turn',
    at: startedAt + decisionMs + bankMs,
    handNo: hand.config.handNo,
    actionIndex: hand.actions.length,
    seat: hand.toAct,
  }
}

/** True while `d` still refers to the decision `hand` is waiting on. */
export const isCurrentTurn = (d: Deadline, hand: HandState | null) =>
  d.kind === 'turn' &&
  !!hand &&
  hand.street !== 'showdown' &&
  hand.config.handNo === d.handNo &&
  hand.actions.length === d.actionIndex &&
  hand.toAct === d.seat

/**
 * Six-casual (ADR amendment 2026-10-10, "Orbit and clock"): the table's
 * orbit count once it deals a hand with blinds `next`, its last deal having
 * had `prev` (null before its first hand). `travel` is the count stored with
 * the match. Only the big blind's seat moves it (orbitTravel: the seats it
 * moved clockwise, empty ones included), so a dead button or small blind,
 * a player sitting down and one leaving change nothing but where the big
 * blind goes next. `refill`: this hand starts a new orbit, and every seated
 * player's bank is full again before its first decision.
 */
export function orbitDone(travel: number, prev: Blinds | null, next: Blinds) {
  // A corrupt count would refill every hand, or never again.
  if (!Number.isInteger(travel) || travel < 0 || travel > 5)
    throw new EngineError(`An orbit count of ${travel}`)
  const orbit = orbitTravel(travel, prev?.bb ?? null, next.bb)
  return { travel: orbit.travel, refill: orbit.newOrbit }
}

/** The bank left after a decision that took `tookMs`. */
export const bankAfter = (bankMs: number, tookMs: number, decisionMs: number) =>
  Math.max(0, bankMs - Math.max(0, tookMs - decisionMs))

/** What the table does for a player whose time ran out. */
export const timeoutAction = (hand: HandState): PlayerAction =>
  legalActions(hand).canCheck ? { type: 'check' } : { type: 'fold' }

/** Retry delay for the n-th failed archive write: 2 s doubling to 5 min. */
export const outboxBackoff = (attempts: number) =>
  Math.min(300_000, 2000 * 2 ** Math.max(0, attempts - 1))

export const earliest = (deadlines: Deadline[]) =>
  deadlines.length ? Math.min(...deadlines.map((d) => d.at)) : null
