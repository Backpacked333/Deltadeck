import { act, startHand } from '../../src/engine/hand'
import {
  commitDeck,
  dealSlots,
  publicSlots,
  revealSlots,
  toBase64,
} from '../../src/engine/deck'
import { luckAdjusted } from '../../src/engine/luck'
import { deckWith } from '../../src/engine/testing'
import type { HandRecordV1, TerminalProofV1 } from '../../src/shared/protocol'
import { evidenceDigest } from '../src/live-evidence'
import { outcomes, RATED_CONFIG } from '../src/rated'
import type { AuditedHand } from '../src/verify'
import type { SettlementSource } from '../src/settlement-evidence'

export const USERS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
]
export const MATCH = '51000000-0000-4000-8000-000000000001'
export const T0 = 1_800_000_000_000

export async function handFixture(
  matchId = MATCH,
  handNo = 1,
  mode: 'fold' | 'timeout' | 'preflop' | 'flop' = 'fold',
): Promise<AuditedHand> {
  const config = {
    handNo,
    seats: [
      { seat: 0, stack: 2000 },
      { seat: 1, stack: 2000 },
    ],
    button: (handNo - 1) % 2,
    blinds: { sb: 10, bb: 20 },
  }
  const deck = deckWith(config, { 0: 'Ah Ad', 1: 'Ks Kc' }, 'Kd 7c 2h 9s 4d')
  let state = startHand(config, deck)
  if (mode === 'preflop') {
    state = act(state, state.toAct!, { type: 'raise', to: 2000 })
    state = act(state, state.toAct!, { type: 'call' })
  } else if (mode === 'flop') {
    state = act(state, state.toAct!, { type: 'call' })
    state = act(state, state.toAct!, { type: 'check' })
    state = act(state, state.toAct!, { type: 'raise', to: 1980 })
    state = act(state, state.toAct!, { type: 'call' })
  } else {
    if (mode === 'timeout' && state.toAct === 1)
      state = act(state, 1, { type: 'raise', to: 40 })
    state = act(state, state.toAct!, { type: 'fold' })
  }
  const secret = new Uint8Array(32).fill(handNo)
  const { commitment, leaves } = await commitDeck(deck, secret)
  const shown = state.players
    .filter((p) => p.shown && p.cards)
    .map((p) => ({ seat: p.seat, cards: p.cards! }))
  const luck = luckAdjusted(state)
  const record: HandRecordV1 = {
    v: 1,
    matchId,
    handNo,
    segment: 1,
    config,
    seats: USERS.map((userId, seat) => ({
      seat,
      userId,
      username: `player${seat}`,
    })),
    commitment,
    actions: state.actions.map((a) => ({
      ...a,
      source: mode === 'timeout' && a.seat === 0 ? 'timeout' : 'client',
      atMs: 20_000,
      decisionMs: 20_000,
    })),
    board: state.board,
    shown,
    awards: state.result!.awards,
    netBySeat: state.result!.netBySeat,
    showdown: state.result!.showdown,
    luck: {
      allInAt: luck.allInAt,
      equity: luck.equity,
      adjustedBySeat: luck.netBySeat,
    },
  }
  const reveal = await revealSlots(deck, secret, publicSlots(record))
  const holes = Object.fromEntries(
    Object.entries(dealSlots(config).holes).map(([seat, slots]) => [
      seat,
      slots.map((i) => deck[i]),
    ]),
  )
  const hand: AuditedHand = {
    id: `${matchId}:${handNo}`,
    matchId,
    handNo,
    kind: 'hu-rated',
    commitment,
    leaves: toBase64(leaves),
    reveal,
    record,
    deck,
    secret: toBase64(secret),
    holes,
    verified: true,
    sourceToken: 'fixture-source',
  }
  hand.archive = {
    id: hand.id,
    matchId,
    handNo,
    segment: 1,
    button: config.button,
    commitment,
    leaves: hand.leaves,
    reveal,
    record,
    deck,
    secret: hand.secret,
    holes,
    holesByUser: USERS.map((userId, seat) => ({ userId, cards: holes[seat] })),
    netByUser: Object.fromEntries(
      USERS.map((u, s) => [u, record.netBySeat[s]]),
    ),
  }
  hand.verification = {
    version: 'hand.v2',
    recordDigest: await evidenceDigest(record),
    archiveDigest: await evidenceDigest(hand.archive),
  }
  return hand
}

export async function settlementFixture(
  matchId = MATCH,
  reason: 'complete' | 'forfeit' | 'no_show' | 'abandoned' = 'complete',
): Promise<SettlementSource> {
  const count = reason === 'complete' ? 40 : reason === 'forfeit' ? 3 : 0
  const hands: AuditedHand[] = []
  for (let i = 1; i <= count; i++)
    hands.push(
      await handFixture(matchId, i, reason === 'forfeit' ? 'timeout' : 'fold'),
    )
  const adjustedBySeat = { 0: 0, 1: 0 }
  const netBySeat = { 0: 0, 1: 0 }
  for (const h of hands)
    for (const seat of [0, 1] as const) {
      adjustedBySeat[seat] += h.record.luck!.adjustedBySeat[seat]
      netBySeat[seat] += h.record.netBySeat[seat]
    }
  const result =
    reason === 'complete'
      ? outcomes(adjustedBySeat, 20)
      : reason === 'forfeit'
        ? { 0: 'loss' as const, 1: 'win' as const }
        : null
  const proof: TerminalProofV1 = {
    v: 1,
    id: `terminal:${matchId}`,
    matchId,
    tableId: matchId,
    activationId: 'activation-1',
    policyVersion: 'terminal.v1',
    rulesVersion: 'hu-rated.v1',
    configDigest: await evidenceDigest(RATED_CONFIG),
    participants: USERS.map((userId, seat) => ({
      userId,
      seat,
      tableId: matchId,
      generation: 1,
      seatGeneration: 1,
    })),
    reason,
    cause:
      reason === 'complete'
        ? 'hand_limit'
        : reason === 'forfeit'
          ? 'timeout_streak'
          : reason === 'no_show'
            ? 'start_deadline'
            : 'mutual_absence',
    terminalStateVersion: 1000,
    finishedAt: T0 + 1_000_000,
    startedAt: count ? T0 : null,
    startDeadlineAt: T0 + 30_000,
    firstPresenceAt: { [USERS[0]]: T0 },
    absences:
      reason === 'abandoned'
        ? USERS.map((userId, seat) => ({
            userId,
            seat,
            seatGeneration: 1,
            observedAt: T0 + 40_000,
            deadlineAt: T0 + 100_000,
            source: 'recovery',
          }))
        : [],
    timeoutEvidence:
      reason === 'forfeit'
        ? hands.map((h) => ({
            id: `${matchId}:${h.handNo}:${h.record.actions.length - 1}`,
            decision: {
              tableId: matchId,
              matchId,
              handNo: h.handNo,
              actionIndex: h.record.actions.length - 1,
              seat: 0,
            },
            deadlineAt: T0 + h.handNo * 20_000,
            processedAt: T0 + h.handNo * 20_000,
            consecutiveTimeouts: h.handNo,
            action: 'fold',
          }))
        : [],
    voluntaryCommandId: null,
    forfeitingSeat: reason === 'forfeit' ? 0 : null,
    completedHands: hands.map((h) => ({
      id: h.id,
      handNo: h.handNo,
      completedAt: T0 + h.handNo * 20_000,
      terminalStateVersion: h.handNo * 10,
      recordDigest: h.verification!.recordDigest,
      archiveDigest: h.verification!.archiveDigest,
      requiredVerifier: 'hand.v2',
    })),
    interruptedHand: null,
  }
  return {
    matchId,
    kind: 'hu-rated',
    status: result ? 'finished' : 'void',
    config: structuredClone(RATED_CONFIG),
    result: {
      reason,
      adjustedBySeat,
      netBySeat,
      ...(result ? { outcomeBySeat: result } : {}),
    },
    players: USERS.map((userId, seat) => ({
      seat,
      userId,
      outcome: result?.[seat as 0 | 1] ?? null,
    })),
    terminal: { proof, interruptedArchive: null },
    hands,
    sourceToken: 'fixture-source',
  }
}
