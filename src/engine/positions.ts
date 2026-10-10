// Seat order, blinds and position names. Seats are ascending clockwise.
//
// Heads-up the button posts the small blind, acts first pre-flop and last
// after the flop (as in src/lib/poker.ts). With three or more players the
// small blind is the next seat after the button, the big blind the one after
// that, and the first seat after the big blind opens. After the flop the first
// active seat clockwise from the button acts first.
//
// That describes the first hand at a table. Later six-casual hands use the
// standard dead button (ADR amendment 2026-10-10, Phase 2; nextBlinds below):
// the big blind moves to the next seat with a player dealt in, the small
// blind to the seat that had the big blind (dead if no one there is dealt in,
// or if that player just sat down), and the button to the seat that had the
// small blind when it lies between the new big and small blinds, else just
// before the new small blind. Positions are seat numbers, so the button may
// have no player. Nobody posts the big blind twice in a row or skips it when
// others leave. Those hands name their blind seats in HandConfig (sb, bb),
// and the engine refuses the placements the ADR lists as illegal.
import { EngineError } from './types'
import type { SeatId } from './types'

/** The seat `steps` places clockwise from `from` among `seats` (ascending). */
export function seatAfter(seats: SeatId[], from: SeatId, steps = 1): SeatId {
  const start = seats.findIndex((s) => s > from)
  const base = start === -1 ? 0 : start
  return seats[(base + steps - 1) % seats.length]
}

/** `seats` reordered to start at the first seat clockwise after `from`. */
export function clockwiseFrom(seats: SeatId[], from: SeatId): SeatId[] {
  const first = seatAfter(seats, from)
  const i = seats.indexOf(first)
  return [...seats.slice(i), ...seats.slice(0, i)]
}

export function blindSeats(seats: SeatId[], button: SeatId) {
  const sb = seats.length === 2 ? button : seatAfter(seats, button)
  return { sb, bb: seatAfter(seats, sb) }
}

/**
 * Phase 0 button movement: the next seated seat. Six-casual tables use
 * nextBlinds instead.
 */
export const nextButton = (seats: SeatId[], previous: SeatId) =>
  seatAfter(seats, previous)

const NAMES: Record<number, string[]> = {
  2: ['BTN', 'BB'],
  3: ['BTN', 'SB', 'BB'],
  4: ['BTN', 'SB', 'BB', 'UTG'],
  5: ['BTN', 'SB', 'BB', 'UTG', 'CO'],
  6: ['BTN', 'SB', 'BB', 'UTG', 'HJ', 'CO'],
}

/** Clockwise distance on the six-seat ring, empty seats included. */
/** Seats clockwise from `from` to `to` around the six-seat ring. */
export const ringDistance = (from: SeatId, to: SeatId) => (to - from + 6) % 6

/**
 * Position labels keyed by seat, starting from the button. Six-casual hands
 * pass their explicit blinds, since the button and small blind can be dead:
 * BTN then goes only to a player on the button seat and SB only to a live
 * small blind. The players after the big blind and before the button seat
 * keep the names a full table gives them: UTG first, CO last, HJ between. A
 * player between the button and the big blind who posts nothing (one who
 * sat down in a dead small blind's seat, or behind the button) has no name.
 */
export function positionNames(
  seats: SeatId[],
  button: SeatId,
  blinds?: { sb: SeatId | null; bb: SeatId },
) {
  const names = NAMES[seats.length]
  if (!names) return {} as Record<SeatId, string>
  if (!blinds) {
    const order = [button, ...clockwiseFrom(seats, button).slice(0, -1)]
    return Object.fromEntries(order.map((s, i) => [s, names[i]])) as Record<
      SeatId,
      string
    >
  }
  const { sb, bb } = blinds
  const early = clockwiseFrom(seats, bb)
    .slice(0, -1)
    .filter((s) => ringDistance(bb, s) < ringDistance(bb, button))
  // The engine refuses a button that leaves four players before it, so
  // `tail` exists; the guard keeps a bad caller to missing labels.
  const tail = NAMES[early.length + 3]
  const labels: Record<SeatId, string> = tail
    ? Object.fromEntries(early.map((s, i) => [s, tail[i + 3]]))
    : {}
  labels[bb] = 'BB'
  if (sb !== null) labels[sb] = 'SB'
  // Heads-up the button posts the small blind and is labelled BTN.
  if (seats.includes(button)) labels[button] = 'BTN'
  return labels
}

/**
 * Where the blinds sit for one six-casual hand. `sb` and `bb` go into the
 * HandConfig as they are. `sbSeat` is the small blind's seat even when it is
 * dead: the next hand's button moves there (step 3), so a table keeps the
 * whole value between hands, across idle gaps and session rotations.
 */
export type Blinds = {
  button: SeatId
  /** The seat that posts the small blind, or null when it is dead. */
  sb: SeatId | null
  bb: SeatId
  sbSeat: SeatId
}

/**
 * The blinds for the next hand under the standard dead button (ADR amendment
 * 2026-10-10, Phase 2, "Blinds and button"). `dealtIn` are the seats with a
 * player who will be dealt in, at least two. `justSat` are those whose player
 * sat down since the last hand: a small blind falling on one of them is dead
 * (R-20), unless only two are dealt in. A player back from sitting out
 * (`sit_in`) has not just sat: the small blind only falls on last hand's
 * big-blind seat, so the only such returner there is that big blind, sitting
 * out for one hand to skip the small blind. `prev` is the last hand's value, or
 * null at the first hand at a table, which everyone has just joined: then
 * blindSeats places the blinds, all live, with the lowest seat as button.
 */
export function nextBlinds(
  prev: Blinds | null,
  dealtIn: SeatId[],
  justSat: SeatId[] = [],
): Blinds {
  const seats = [...dealtIn].sort((a, b) => a - b)
  if (seats.length < 2) throw new EngineError('Blinds need two players')
  if (
    seats.some(
      (s, i) => !Number.isInteger(s) || s < 0 || s > 5 || s === seats[i - 1],
    )
  )
    throw new EngineError('Dealt-in seats must be distinct seats from 0 to 5')
  if (!prev) {
    const { sb, bb } = blindSeats(seats, seats[0])
    return { button: seats[0], sb, bb, sbSeat: sb }
  }
  // (1) The big blind moves to the next seat with a player dealt in, so
  // nobody posts it twice in a row or is passed over when others leave.
  const bb = seatAfter(seats, prev.bb)
  // Heads-up the other player is button and small blind, a newcomer too:
  // two players cannot leave the small blind dead.
  if (seats.length === 2) {
    const other = seats.find((s) => s !== bb)!
    return { button: other, sb: other, bb, sbSeat: other }
  }
  // (2) The small blind goes to the seat that had the big blind. It is dead
  // when nobody there is dealt in, or its player has just sat down.
  const sbSeat = prev.bb
  const sb = seats.includes(sbSeat) && !justSat.includes(sbSeat) ? sbSeat : null
  // (3) The button follows to the seat that had the small blind if that
  // seat lies after the new big blind and before the new small blind; else
  // it sits just before the new small blind. Either way it is on neither
  // blind and the order stays button, small blind, big blind.
  const back = ringDistance(bb, prev.sbSeat)
  const button =
    back > 0 && back < ringDistance(bb, sbSeat) ? prev.sbSeat : (sbSeat + 5) % 6
  return { button, sb, bb, sbSeat }
}

/**
 * The orbit counter (ADR "Orbit and clock"). Each dealt hand adds the
 * clockwise distance, empty seats included, from the previous big blind to
 * the new one; the hand that brings it to 6 or more starts a new orbit (the
 * big blind has passed every seat) and the count goes back to 0. The first
 * hand at a table, with no previous big blind, adds nothing.
 */
export function orbitTravel(travel: number, prevBb: SeatId | null, bb: SeatId) {
  const total = travel + (prevBb === null ? 0 : ringDistance(prevBb, bb))
  return total >= 6
    ? { travel: 0, newOrbit: true }
    : { travel: total, newOrbit: false }
}
