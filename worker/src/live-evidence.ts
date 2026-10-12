import type { HandState } from '../../src/engine/types'
import type { HandCompletionV1, HandRecordV1 } from '../../src/shared/protocol'

/** JSON-only canonicalization; absent properties must be omitted by the caller. */
export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value))
    return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`
  if (
    typeof value === 'object' &&
    value &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    return `{${Object.keys(value)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonicalJSON((value as Record<string, unknown>)[k])}`,
      )
      .join(',')}}`
  throw new Error('Evidence must contain finite JSON values')
}

export async function evidenceDigest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJSON(value))
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('')
}

export const RESULT_HOLD_MS = 900
export const RUNOUT_BEAT_MS = 900

export function completeHand(
  hand: HandState,
  record: HandRecordV1,
  terminalStateVersion: number,
  completedAt: number,
  generations: Record<number, number>,
  tableId = record.matchId,
): HandCompletionV1 {
  const lastBoard = hand.actions.at(-1)?.boardCount ?? 0
  const showdown = !!hand.result?.showdown
  const missing = showdown
    ? ([3, 4, 5] as const).filter((n) => n > lastBoard)
    : []
  const shape = !showdown
    ? 'fold'
    : lastBoard === 0
      ? 'all_in_preflop'
      : lastBoard === 3
        ? 'all_in_flop'
        : lastBoard === 4
          ? 'all_in_turn'
          : 'river'
  const key = { tableId, matchId: record.matchId, handNo: record.handNo }
  let elapsed = 0
  const beats = missing.map((boardCount) => ({
    offsetMs: (elapsed += boardCount === 5 ? 1400 : RUNOUT_BEAT_MS),
    boardCount,
  }))
  return {
    v: 1,
    hand: key,
    terminalStateVersion,
    completedAt,
    resultAvailable: true,
    final: {
      hand: key,
      board: [...record.board],
      shown: record.shown.map((p) => ({ seat: p.seat, cards: [...p.cards] })),
      participants: record.seats.map((p) => ({
        seat: p.seat,
        username: p.username,
        seatGeneration: generations[p.seat] ?? 0,
      })),
      stacksBySeat: Object.fromEntries(
        hand.players.map((p) => [p.seat, p.stack]),
      ),
      pots: hand.pots.map((p) => ({
        amount: p.amount,
        eligible: [...p.eligible],
      })),
      awards: record.awards.map((p) => ({ seat: p.seat, amount: p.amount })),
      netBySeat: { ...record.netBySeat },
      showdown,
    },
    schedule: {
      version: 'completion.v1',
      shape,
      beats,
      resultHoldMs: RESULT_HOLD_MS,
      earliestNextDealAt:
        completedAt + Math.max(3000, elapsed + RESULT_HOLD_MS),
    },
  }
}
