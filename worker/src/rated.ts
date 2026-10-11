// The rated heads-up rules (ADR amendment 2026-10-10, P1-00). Fresh decks
// every hand as casual (Q1 = B); the result is the luck-adjusted total
// (src/engine/luck.ts) with a draw band.
import type { SeatId } from '../../src/engine/types'
import { DRAW_BAND_BB } from '../../src/rating/rules'
import type { MatchConfig, Outcome } from '../../src/shared/protocol'

export { DRAW_BAND_BB }

/** 40 hands at 100 bb; 20 s a decision and a 60 s bank for each half. */
export const RATED_CONFIG: MatchConfig & { handsTotal: number } = {
  kind: 'hu-rated',
  handsTotal: 40,
  startingStack: 2000,
  blinds: { sb: 10, bb: 20 },
  decisionMs: 20_000,
  bankMs: 60_000,
  bankRefillEvery: 20,
}

/**
 * How long a seat may be gone before its turns are played for it at once
 * (check if possible, else fold; each counts as a timeout). Six-casual
 * uses the same grace, after which the player sits out instead (ADR
 * amendment 2026-10-10, "Reconnect").
 */
export const GRACE_MS = 60_000

/** After a rated match, both players must press Rematch within this. */
export const REMATCH_MS = 60_000

/**
 * Each seat's result from the luck-adjusted totals. Decided once from the
 * lead (half the difference), so floating-point noise can never give both
 * players a win or a draw and a loss.
 */
export function outcomes(
  adjusted: Record<SeatId, number>,
  bb: number,
): Record<SeatId, Outcome> {
  const lead = (adjusted[0] - adjusted[1]) / 2
  if (Math.abs(lead) <= DRAW_BAND_BB * bb + 1e-9)
    return { 0: 'draw', 1: 'draw' }
  return lead > 0 ? { 0: 'win', 1: 'loss' } : { 0: 'loss', 1: 'win' }
}
