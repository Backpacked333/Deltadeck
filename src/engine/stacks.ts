// Buy-in and rebuy for casual 6-max (ADR amendment 2026-10-10, Phase 2,
// "Stacks and rebuy"). Stacks carry over between hands, and a player may top
// up to exactly 100 bb whenever they are not in the hand being played and
// their stack is below 100 bb. Every amount here is derived from the stack
// and the big blind: no function takes a chip count, so a client's `rebuy`
// can neither choose its size nor push a stack past the buy-in.
import { EngineError } from './types'

/** Buy-in and rebuy target in big blinds: 2,000 chips at 10/20 (R-10). */
export const BUY_IN_BB = 100

/** Why a rebuy is refused; `in_hand` is also the wire error code. */
export type RebuyRefusal = 'in_hand' | 'not_below'

/** Chips to add before the next hand; `amount` is 0 when refused. */
export type Rebuy =
  | { amount: number; refused: null }
  | { amount: 0; refused: RebuyRefusal }

/** The buy-in in chips at big blind `bb`. */
export function buyIn(bb: number) {
  if (!Number.isInteger(bb) || bb <= 0)
    throw new EngineError('The big blind must be a positive integer')
  return BUY_IN_BB * bb
}

/**
 * The top-up that brings `stack` to exactly 100 bb. `inHand` is true while
 * the player is dealt into the hand being played; a seated player sitting it
 * out may rebuy, and the chips play from the next hand. `stack` must already
 * include any top-up granted for the next hand, or a second rebuy in the
 * same hand would top up again past 100 bb.
 */
export function rebuyTo(stack: number, bb: number, inHand: boolean): Rebuy {
  const target = buyIn(bb)
  // A NaN stack would read as 'not_below' and a fraction would break chip
  // conservation, so corrupt server state fails loudly instead.
  if (!Number.isInteger(stack) || stack < 0)
    throw new EngineError('A stack must be a non-negative integer')
  // Checked first: mid-hand the stack leaves out the chips in the pot, so
  // whether it is below 100 bb is not known until the hand ends.
  if (inHand) return { amount: 0, refused: 'in_hand' }
  if (stack >= target) return { amount: 0, refused: 'not_below' }
  return { amount: target - stack, refused: null }
}
