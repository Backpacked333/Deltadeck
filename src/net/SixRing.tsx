// The six-seat table for casual 6-max (P2-05). The viewer sits at the
// bottom and the seats go on clockwise to their left, as at a real table;
// someone without a seat sees seat 1 at the bottom. Props only, no socket:
// the live table feeds it from the server's snapshot. It is a new component
// in the online chunk, not a generalised Table.tsx, so the entry bundle and
// the trainer's heads-up table stay as they are (ADR, "Table UI (P2-05)").
import type { ReactNode } from 'react'
import type { SeatId } from '../engine/types'
import { SeatPlate } from './SeatPlate'
import type { PlateSeat, SeatClock } from './SeatPlate'

const SEATS: SeatId[] = [0, 1, 2, 3, 4, 5]

/** 0 is the bottom of the ring, then clockwise: (seat − you + 6) % 6. */
const slotOf = (seat: SeatId, you: SeatId | null) =>
  (seat - (you ?? 0) + SEATS.length) % SEATS.length

export function SixRing({
  players,
  you,
  button,
  sb,
  bb,
  toAct,
  clock,
  clockOffset,
  onSit,
  children,
  overlay,
}: {
  /** Seated players, in any order; a seat missing here is empty. */
  players: PlateSeat[]
  /** The viewer's seat; null for someone without a seat. */
  you: SeatId | null
  /** null before the first hand. It may be an empty seat (dead button). */
  button: SeatId | null
  /** null when the small blind is dead. */
  sb: SeatId | null
  bb: SeatId | null
  toAct: SeatId | null
  clock: SeatClock | null
  /** Server time minus local time. */
  clockOffset: number
  /** Taking an empty seat; offered only while the viewer has no seat. */
  onSit?: (seat: SeatId) => void
  /** The middle of the table: board and pot. */
  children?: ReactNode
  /**
   * Drawn over the whole ring, outside its grid: the chip flights, which
   * go from the plates to the middle and back.
   */
  overlay?: ReactNode
}) {
  const bySeat = new Map(players.map((p) => [p.seat, p]))
  // DOM order is clockwise from the viewer, so reading and tab order go
  // around the table the way the action does.
  const seats = [...SEATS].sort((a, b) => slotOf(a, you) - slotOf(b, you))
  return (
    <section className="six-ring" aria-label="Poker table">
      {seats.map((seat) => (
        <SeatPlate
          key={seat}
          seat={seat}
          slot={slotOf(seat, you)}
          player={bySeat.get(seat) ?? null}
          you={seat === you}
          button={seat === button}
          sb={seat === sb}
          bb={seat === bb}
          active={seat === toAct}
          clock={seat === toAct ? clock : null}
          clockOffset={clockOffset}
          onSit={you === null ? onSit : undefined}
        />
      ))}
      <div className="six-mid">{children}</div>
      {overlay}
    </section>
  )
}
