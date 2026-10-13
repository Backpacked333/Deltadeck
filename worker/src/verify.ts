// Every archived hand is re-verified off the game path (ADR §Post-hand
// grading placement). The table queues { matchId, handNo } once Postgres has
// the hand; this consumer reads it back with the service role, replays it
// from the full deck and checks it against its own commitment and record.
// A sound hand is marked `hands.verified`; anything else becomes one
// `incidents` row. Play never waits on any of this, and every step is safe
// to repeat: queue messages can be redelivered or arrive out of order.
import {
  commitDeck,
  dealSlots,
  fromBase64,
  toBase64,
  verifyDeal,
} from '../../src/engine/deck'
import type { RevealedSlot } from '../../src/engine/deck'
import { assertInvariants, isOver, replayHand } from '../../src/engine/hand'
import { luckAdjusted } from '../../src/engine/luck'
import type { HandState } from '../../src/engine/types'
import type { HandRecordV1 } from '../../src/shared/protocol'
import type { WorkerEnv } from './env'
import { gradeArchived } from './grade'
import { describeError, logEvent } from './log'
import { rpc } from './supabase'

export { HANDS_DLQ, HANDS_QUEUE } from './queues'

/**
 * What the table sends for each archived hand. `rated`: a rated match's
 * hand, which is graded once verified (P1-09); absent on casual hands and
 * on messages from before grading existed.
 */
export type HandMessage = { matchId: string; handNo: number; rated?: true }

/** A hand as `audit_hand` returns it: the public row plus the private one. */
export type AuditedHand = {
  id: string
  matchId: string
  handNo: number
  commitment: string
  /** Base64 of all 52 leaves. */
  leaves: string
  reveal: RevealedSlot[]
  record: HandRecordV1
  verified: boolean
  deck: number[]
  /** Base64 of the 32-byte hand secret. */
  secret: string
  holes: Record<string, number[]>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Why `hand` is not what the table said it was: fixed words, never cards.
 * Empty when it replays from its deck to exactly its record, and the deck
 * matches the commitment players saw before the deal. `rated`: the hand of a
 * rated match, whose luck adjustment is what the rating settles on, so it is
 * recomputed here rather than taken from the table (audit F07).
 */
export async function problemsWith(
  hand: AuditedHand,
  rated = false,
): Promise<string[]> {
  const problems = new Set<string>()
  const { record } = hand
  if (
    record.matchId !== hand.matchId ||
    record.handNo !== hand.handNo ||
    hand.id !== `${hand.matchId}:${hand.handNo}`
  )
    problems.add('ids')

  // The deck and secret open to the commitment the players were sent.
  try {
    const { commitment, leaves } = await commitDeck(
      hand.deck,
      fromBase64(hand.secret),
    )
    if (commitment !== hand.commitment || record.commitment !== hand.commitment)
      problems.add('commitment')
    if (toBase64(leaves) !== hand.leaves) problems.add('leaves')
  } catch {
    problems.add('commitment')
  }

  // The recorded actions, replayed from that deck, give the recorded hand.
  let states: HandState[] = []
  try {
    states = replayHand(
      record.config,
      hand.deck,
      record.actions.map(({ seat, action }) => ({ seat, action })),
    )
  } catch {
    problems.add('replay')
  }
  const final = states.at(-1)
  if (final) {
    const chips = record.config.seats.reduce((sum, s) => sum + s.stack, 0)
    try {
      for (const state of states) assertInvariants(state, chips)
    } catch {
      problems.add('chips')
    }
    if (!isOver(final) || !final.result) problems.add('unfinished')
    else if (
      !same(final.result.netBySeat, record.netBySeat) ||
      !same(final.result.awards, record.awards) ||
      final.result.showdown !== record.showdown
    )
      problems.add('result')
    if (!same(final.board, record.board)) problems.add('board')
    const shown = final.players
      .filter((p) => p.shown && p.cards)
      .map((p) => ({ seat: p.seat, cards: p.cards }))
    if (!same(shown, record.shown)) problems.add('shown')
  }

  // The luck adjustment, from the replayed hand: the same pure function the
  // table ran, on the hand as the deck and the moves make it, not on what
  // the table wrote down. Field by field: the archive's jsonb does not keep
  // the record's key order.
  if (rated || record.luck) {
    const luck = record.luck
    try {
      const expected = final?.result ? luckAdjusted(final) : null
      if (
        !luck ||
        !expected ||
        luck.allInAt !== expected.allInAt ||
        !same(luck.equity, expected.equity) ||
        !same(luck.adjustedBySeat, expected.netBySeat)
      )
        problems.add('luck')
    } catch {
      problems.add('luck')
    }
  }

  // The public reveal opens exactly the board and shown hands.
  try {
    if (
      !(await verifyDeal(
        hand.commitment,
        fromBase64(hand.leaves),
        hand.reveal,
        record,
      ))
    )
      problems.add('reveal')
  } catch {
    problems.add('reveal')
  }

  // The private copy of each seat's cards is what the deck dealt them.
  try {
    const slots = dealSlots(record.config).holes
    for (const { seat } of record.config.seats)
      if (
        !same(
          slots[seat].map((s) => hand.deck[s]),
          hand.holes[String(seat)],
        )
      )
        problems.add('holes')
  } catch {
    problems.add('holes')
  }
  return [...problems]
}

function parseMessage(body: unknown): HandMessage | null {
  if (typeof body !== 'object' || body === null) return null
  const { matchId, handNo, rated } = body as Record<string, unknown>
  return typeof matchId === 'string' &&
    UUID.test(matchId) &&
    Number.isSafeInteger(handNo) &&
    (handNo as number) >= 1
    ? {
        matchId,
        handNo: handNo as number,
        ...(rated === true ? { rated } : {}),
      }
    : null
}

/** Seconds before the n-th retry: 10 s doubling, at most 10 minutes. */
export const retryDelay = (attempts: number) =>
  Math.min(600, 10 * 2 ** Math.max(0, attempts - 1))

/** One hand: verified, failed (an incident), or not archived yet. */
async function verifyArchived(
  env: WorkerEnv,
  { matchId, handNo, rated }: HandMessage,
): Promise<
  { state: 'missing' | 'failed' } | { state: 'verified'; hand: AuditedHand }
> {
  const id = `${matchId}:${handNo}`
  const hand = await rpc<AuditedHand>(env, 'audit_hand', { id })
  if (!hand) return { state: 'missing' }
  // A redelivery after a success: nothing more to verify.
  if (hand.verified) return { state: 'verified', hand }
  const problems = await problemsWith(hand, rated === true)
  if (problems.length === 0) {
    await rpc(env, 'verify_hand', { id })
    logEvent('verified', { matchId, handNo })
    return { state: 'verified', hand }
  }
  await rpc(env, 'record_incident', {
    matchId,
    handNo,
    kind: 'verify_failed',
    detail: { problems },
  })
  logEvent('verify_failed', { matchId, handNo, detail: problems.join(',') })
  return { state: 'failed' }
}

/** The `quantpoker-hands` consumer (one message per batch in production). */
export async function consumeHands(batch: MessageBatch, env: WorkerEnv) {
  for (const message of batch.messages) {
    const body = parseMessage(message.body)
    if (!body) {
      // Retrying cannot fix it: say so once and drop it.
      logEvent('error', { reason: 'bad_hand_message' })
      message.ack()
      continue
    }
    try {
      const outcome = await verifyArchived(env, body)
      if (outcome.state === 'missing') {
        message.retry({ delaySeconds: retryDelay(message.attempts) })
        continue
      }
      // Graded only once verified; a grading failure throws, so the message
      // is retried (verification is not repeated) and, after the last try,
      // dead-lettered as an incident. Play never waits on it.
      if (outcome.state === 'verified' && body.rated)
        await gradeArchived(env, outcome.hand)
      message.ack()
    } catch (error) {
      logEvent('error', {
        ...body,
        reason: 'verify',
        attempt: message.attempts,
        detail: describeError(error),
      })
      message.retry({ delaySeconds: retryDelay(message.attempts) })
    }
  }
}

/** The DLQ consumer: a hand that could not be verified is an incident. */
export async function consumeDeadLetters(batch: MessageBatch, env: WorkerEnv) {
  for (const message of batch.messages) {
    const body = parseMessage(message.body)
    try {
      await rpc(env, 'record_incident', {
        matchId: body?.matchId ?? null,
        handNo: body?.handNo ?? null,
        kind: 'dlq',
        detail: { attempts: message.attempts },
      })
      logEvent('dlq', { ...body, attempt: message.attempts })
      message.ack()
    } catch (error) {
      logEvent('error', {
        ...body,
        reason: 'dlq',
        detail: describeError(error),
      })
      message.retry()
    }
  }
}
