// What the next hand is. The table runs hands; a controller decides decks,
// buttons and stacks. Phase 1's duplicate matches replace this one (same
// decks, seats swapped) without touching the table or the protocol.
import { shuffleWith } from '../../src/engine/deck'
import { nextBlinds } from '../../src/engine/positions'
import type { Blinds } from '../../src/engine/positions'
import type { HandConfig, SeatId } from '../../src/engine/types'
import type { MatchConfig, SeatStatus } from '../../src/shared/protocol'
import { randomBytes, randomInt } from './shuffle'

export type HandPlan = {
  config: HandConfig
  deck: number[]
  /** Per-hand secret for the deck commitment (used from Step 5). */
  secret: Uint8Array
  /**
   * Six-casual: where the blinds sat, whole. The table stores it for the
   * next hand, since the button follows the small blind's seat even when
   * that blind was dead (positions.ts Blinds).
   */
  blinds?: Blinds
  /**
   * Six-casual: who holds each seat dealt in, fixed at the deal. Every frame
   * and archive call about this hand reads it, never the live seating, so a
   * seat's next occupant gets nothing of this hand.
   */
  users?: { seat: SeatId; userId: string }[]
}

/** One occupied seat at a six-casual table, as the table holds it. */
export type RosterSeat = {
  seat: SeatId
  userId: string
  /** The chips carried from the last hand: stacks are never reset. */
  stack: number
  status: SeatStatus
  /**
   * Sat down since the last hand: dealt in without posting, so a small
   * blind that falls on this seat is dead (R-20).
   */
  justSat: boolean
}

/** What a six-casual table knows when it deals the next hand. */
export type Roster = {
  seats: RosterSeat[]
  /** The last hand's blinds, or null before the table's first hand. */
  blinds: Blinds | null
}

export interface TableController {
  /**
   * The plan for hand `handNo` (1-based), or null when there is no hand to
   * deal: the match is over (heads-up), or fewer than two players can be
   * dealt in (six-casual, which passes its `roster`).
   */
  nextHandPlan(
    handNo: number,
    config: MatchConfig,
    roster?: Roster,
  ): HandPlan | null
}

/** Casual heads-up: fresh shuffle, alternating button, stacks reset. */
export class LocalController implements TableController {
  constructor(
    private readonly random: (n: number) => number = randomInt,
    private readonly bytes: (n: number) => Uint8Array = randomBytes,
  ) {}

  nextHandPlan(handNo: number, config: MatchConfig): HandPlan | null {
    // Heads-up configs always have a length; only six tables leave it out.
    if (handNo > config.handsTotal!) return null
    return {
      config: {
        handNo,
        seats: [
          { seat: 0, stack: config.startingStack },
          { seat: 1, stack: config.startingStack },
        ],
        button: (handNo - 1) % 2,
        blinds: config.blinds,
      },
      deck: shuffleWith(this.random),
      secret: this.bytes(32),
    }
  }
}

/** A six-casual plan always says where the blinds sat and who was dealt in. */
export type CashPlan = HandPlan & Required<Pick<HandPlan, 'blinds' | 'users'>>

/**
 * Casual 6-max (ADR amendment 2026-10-10, Phase 2): the table's own stacks,
 * the standard dead button, and only the players who can be dealt in. The
 * deck and secret are drawn exactly as LocalController draws them.
 */
export class CashController implements TableController {
  constructor(
    private readonly random: (n: number) => number = randomInt,
    private readonly bytes: (n: number) => Uint8Array = randomBytes,
  ) {}

  nextHandPlan(
    handNo: number,
    config: MatchConfig,
    roster?: Roster,
  ): CashPlan | null {
    // A six table always passes its roster. Without one there is nobody to
    // deal to, and null would read as "wait for players": refuse loudly.
    if (!roster) throw new Error('A six-casual hand needs the roster')
    // Sitting out is not dealt in, and the engine refuses a player with no
    // chips (a busted player sits out until they rebuy).
    const dealt = roster.seats
      .filter((p) => p.status === 'playing' && p.stack > 0)
      .sort((a, b) => a.seat - b.seat)
    if (dealt.length < 2) return null
    const blinds = nextBlinds(
      roster.blinds,
      dealt.map((p) => p.seat),
      dealt.filter((p) => p.justSat).map((p) => p.seat),
    )
    return {
      config: {
        handNo,
        seats: dealt.map(({ seat, stack }) => ({ seat, stack })),
        button: blinds.button,
        blinds: config.blinds,
        sb: blinds.sb,
        bb: blinds.bb,
      },
      deck: shuffleWith(this.random),
      secret: this.bytes(32),
      blinds,
      users: dealt.map(({ seat, userId }) => ({ seat, userId })),
    }
  }
}
