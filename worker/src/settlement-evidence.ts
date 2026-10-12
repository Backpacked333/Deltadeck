import { commitDeck, fromBase64 } from '../../src/engine/deck'
import { isOver, replayHand } from '../../src/engine/hand'
import type { HandState } from '../../src/engine/types'
import type {
  MatchConfig,
  Outcome,
  TerminalProofV1,
} from '../../src/shared/protocol'
import { canonicalJSON, evidenceDigest } from './live-evidence'
import { GRACE_MS, outcomes, RATED_CONFIG } from './rated'
import type { AuditedHand } from './verify'

export const SETTLEMENT_VERSION = 'settlement.v1'
export type SettlementSource = {
  matchId: string
  kind: string
  status: string
  config: MatchConfig
  result: {
    reason: string
    adjustedBySeat?: Record<number, number>
    netBySeat?: Record<number, number>
    outcomeBySeat?: Record<number, Outcome>
    forfeit?: number
  }
  players: { seat: number; userId: string; outcome: Outcome | null }[]
  terminal: { proof: TerminalProofV1; interruptedArchive: unknown } | null
  hands: AuditedHand[]
  sourceToken: string
}
export type SettlementCertificate = {
  version: typeof SETTLEMENT_VERSION
  matchId: string
  sourceToken: string
  evidenceDigest: string
  rulesVersion: 'hu-rated.v1'
  verifierVersion: 'hand.v2'
  drawBandVersion: 'draw-band.v1'
  reason: string
  finishedAt: number
  disposition: 'rated' | 'void'
  players: { seat: number; userId: string; outcome: Outcome | null }[]
  adjustedBySeat: Record<number, number>
  manifest: TerminalProofV1['completedHands']
}
export type SettlementVerdict =
  | {
      state: 'waiting-for-evidence' | 'legacy-insufficient' | 'quarantined'
      reasons: string[]
    }
  | { state: 'verified'; certificate: SettlementCertificate }

const equal = (a: unknown, b: unknown) => canonicalJSON(a) === canonicalJSON(b)
const time = (n: unknown): n is number =>
  Number.isSafeInteger(n) && (n as number) >= 0
const quarantine = (...reasons: string[]): SettlementVerdict => ({
  state: 'quarantined',
  reasons,
})
const waiting = (...reasons: string[]): SettlementVerdict => ({
  state: 'waiting-for-evidence',
  reasons,
})

/** Pure, read-only classification. A digest binds evidence, not its correctness. */
export async function inspectSettlement(
  source: SettlementSource,
): Promise<SettlementVerdict> {
  try {
    return await inspect(source)
  } catch {
    return quarantine('malformed_evidence')
  }
}

async function inspect(s: SettlementSource): Promise<SettlementVerdict> {
  canonicalJSON(s)
  if (s.kind !== 'hu-rated') return quarantine('unsupported_format')
  if (s.status === 'playing') return waiting('match_not_ended')
  if (!s.terminal)
    return { state: 'legacy-insufficient', reasons: ['terminal_proof_missing'] }
  const p = s.terminal.proof
  if (
    p.v !== 1 ||
    p.policyVersion !== 'terminal.v1' ||
    p.rulesVersion !== 'hu-rated.v1' ||
    p.matchId !== s.matchId ||
    !p.id ||
    !p.activationId ||
    !p.tableId ||
    !time(p.finishedAt) ||
    !time(p.terminalStateVersion) ||
    p.reason !== s.result.reason ||
    !equal(s.config, RATED_CONFIG) ||
    p.configDigest !== (await evidenceDigest(s.config))
  )
    return quarantine('terminal_identity_or_config')
  const players = [...s.players].sort((a, b) => a.seat - b.seat)
  if (
    players.length !== 2 ||
    players[0].seat !== 0 ||
    players[1].seat !== 1 ||
    players[0].userId === players[1].userId ||
    p.participants.length !== 2 ||
    !players.every(
      (a) =>
        p.participants.filter(
          (b) =>
            b.seat === a.seat &&
            b.userId === a.userId &&
            b.tableId === p.tableId &&
            Number.isSafeInteger(b.generation) &&
            b.generation > 0 &&
            Number.isSafeInteger(b.seatGeneration) &&
            b.seatGeneration > 0,
        ).length === 1,
    )
  )
    return quarantine('participants')
  if (p.completedHands.length > RATED_CONFIG.handsTotal)
    return quarantine('manifest_length')
  if (new Set(s.hands.map((h) => h.id)).size !== s.hands.length)
    return quarantine('duplicate_hand')
  if (s.hands.length > p.completedHands.length)
    return quarantine('foreign_hand')
  const adjusted: Record<number, number> = { 0: 0, 1: 0 }
  const net: Record<number, number> = { 0: 0, 1: 0 }
  const actions: {
    handNo: number
    actions: { seat: number; action: { type: string }; source: string }[]
  }[] = []
  let previousTime = p.startedAt ?? 0
  let previousVersion = -1
  for (let i = 0; i < p.completedHands.length; i++) {
    const entry = p.completedHands[i]
    if (
      entry.id !== `${s.matchId}:${i + 1}` ||
      entry.handNo !== i + 1 ||
      entry.requiredVerifier !== 'hand.v2' ||
      !time(entry.completedAt) ||
      entry.completedAt < previousTime ||
      entry.completedAt > p.finishedAt ||
      !time(entry.terminalStateVersion) ||
      entry.terminalStateVersion <= previousVersion ||
      entry.terminalStateVersion >= p.terminalStateVersion
    )
      return quarantine('manifest_order')
    previousTime = entry.completedAt
    previousVersion = entry.terminalStateVersion
    const h = s.hands.find((h) => h.id === entry.id)
    if (!h) return waiting('missing_hand')
    if (!h.verification || h.verification.version !== 'hand.v2')
      return waiting('hand_v2_required')
    const expectedConfig = {
      handNo: i + 1,
      seats: [
        { seat: 0, stack: s.config.startingStack },
        { seat: 1, stack: s.config.startingStack },
      ],
      button: i % 2,
      blinds: s.config.blinds,
    }
    if (
      !equal(h.record.config, expectedConfig) ||
      h.matchId !== s.matchId ||
      h.handNo !== i + 1 ||
      !equal(
        h.record.seats.map(({ seat, userId }) => ({ seat, userId })),
        players.map(({ seat, userId }) => ({ seat, userId })),
      )
    )
      return quarantine('hand_participants_or_config')
    if (
      !h.archive ||
      entry.recordDigest !== h.verification.recordDigest ||
      entry.archiveDigest !== h.verification.archiveDigest ||
      entry.recordDigest !== (await evidenceDigest(h.record)) ||
      entry.archiveDigest !== (await evidenceDigest(h.archive))
    )
      return quarantine('manifest_digest')
    for (const seat of [0, 1]) {
      const value = h.record.luck?.adjustedBySeat[seat]
      if (!Number.isFinite(value) || !Number.isFinite(h.record.netBySeat[seat]))
        return quarantine('adjustment_missing')
      adjusted[seat] += value!
      net[seat] += h.record.netBySeat[seat]
    }
    actions.push({ handNo: h.handNo, actions: h.record.actions })
  }
  if (
    p.completedHands.length &&
    (!time(p.startedAt) || p.startedAt > p.finishedAt)
  )
    return quarantine('start_time')
  if (p.interruptedHand) {
    const ref = p.interruptedHand
    const raw = s.terminal.interruptedArchive as {
      hand: HandState
      current: { commitment: string; timing: { source: string }[] }
      deck: { deck: number[]; secret: string }
    } | null
    if (
      !raw ||
      ref.disposition !== 'excluded_incomplete' ||
      ref.hand.matchId !== s.matchId ||
      ref.hand.tableId !== p.tableId ||
      ref.hand.handNo !== p.completedHands.length + 1 ||
      ref.archiveDigest !== (await evidenceDigest(raw))
    )
      return quarantine('interrupted_digest')
    const states = replayHand(
      raw.hand.config,
      raw.deck.deck,
      raw.hand.actions.map(({ seat, action }) => ({ seat, action })),
    )
    const final = states.at(-1)!
    if (
      isOver(final) ||
      !equal(final, raw.hand) ||
      ref.actionIndex !== final.actions.length ||
      raw.current.timing.length !== final.actions.length ||
      (await commitDeck(raw.deck.deck, fromBase64(raw.deck.secret)))
        .commitment !== raw.current.commitment ||
      !equal(raw.hand.config, {
        handNo: ref.hand.handNo,
        seats: [
          { seat: 0, stack: s.config.startingStack },
          { seat: 1, stack: s.config.startingStack },
        ],
        button: (ref.hand.handNo - 1) % 2,
        blinds: s.config.blinds,
      })
    )
      return quarantine('interrupted_replay')
    actions.push({
      handNo: ref.hand.handNo,
      actions: final.actions.map((a, i) => ({
        ...a,
        source: raw.current.timing[i].source,
      })),
    })
  } else if (s.terminal.interruptedArchive !== null)
    return quarantine('unbound_interruption')

  // Bind every recorded timeout to the replayed action, and recompute streaks
  // across hand boundaries (a client action, not a new hand, resets a streak).
  const streak: Record<number, number> = { 0: 0, 1: 0 }
  const seen = new Set<string>()
  for (const h of actions)
    for (const [index, a] of h.actions.entries()) {
      if (a.source === 'client') {
        streak[a.seat] = 0
        continue
      }
      if (a.source !== 'timeout') return quarantine('action_source')
      const id = `${s.matchId}:${h.handNo}:${index}`
      const e = p.timeoutEvidence.find((e) => e.id === id)
      streak[a.seat]++
      if (
        streak[a.seat] >= 3 &&
        (p.reason !== 'forfeit' ||
          p.forfeitingSeat !== a.seat ||
          h !== actions.at(-1) ||
          index !== h.actions.length - 1)
      )
        return quarantine('play_after_forfeit')
      if (
        !e ||
        !equal(e.decision, {
          tableId: p.tableId,
          matchId: s.matchId,
          handNo: h.handNo,
          actionIndex: index,
          seat: a.seat,
        }) ||
        e.action !== a.action.type ||
        !time(e.deadlineAt) ||
        !time(e.processedAt) ||
        e.processedAt < e.deadlineAt ||
        e.processedAt > p.finishedAt ||
        e.consecutiveTimeouts !== streak[a.seat]
      )
        return quarantine('timeout_evidence')
      seen.add(id)
    }
  if (p.timeoutEvidence.length !== seen.size)
    return quarantine('unbound_timeout')
  let disposition: 'rated' | 'void' = 'void'
  let result: Record<number, Outcome> | null = null
  switch (p.reason) {
    case 'complete':
      if (
        p.cause !== 'hand_limit' ||
        p.completedHands.length !== RATED_CONFIG.handsTotal ||
        p.interruptedHand ||
        p.forfeitingSeat !== null ||
        p.voluntaryCommandId !== null
      )
        return quarantine('normal_requires_40')
      disposition = 'rated'
      result = outcomes(adjusted, s.config.blinds.bb)
      break
    case 'forfeit': {
      const seat = p.forfeitingSeat
      if (
        p.cause !== 'timeout_streak' ||
        (seat !== 0 && seat !== 1) ||
        streak[seat] < 3 ||
        !time(p.startedAt) ||
        p.voluntaryCommandId !== null ||
        p.timeoutEvidence.at(-1)?.decision.seat !== seat ||
        p.timeoutEvidence.at(-1)?.consecutiveTimeouts !== 3
      )
        return quarantine('forfeit_policy')
      disposition = 'rated'
      result = seat === 0 ? { 0: 'loss', 1: 'win' } : { 0: 'win', 1: 'loss' }
      break
    }
    case 'no_show':
      if (
        p.startedAt !== null ||
        p.completedHands.length ||
        p.interruptedHand ||
        p.forfeitingSeat !== null
      )
        return quarantine('no_show_after_play')
      if (p.cause === 'cancelled_before_deal') {
        if (!p.voluntaryCommandId) return quarantine('cancel_identity')
      } else if (
        p.cause !== 'start_deadline' ||
        !time(p.startDeadlineAt) ||
        p.finishedAt < p.startDeadlineAt ||
        players.every(
          (a) =>
            time(p.firstPresenceAt[a.userId]) &&
            p.firstPresenceAt[a.userId] <= p.startDeadlineAt!,
        )
      )
        return quarantine('no_show_deadline')
      break
    case 'abandoned':
      if (
        p.cause !== 'mutual_absence' ||
        !players.every((a) =>
          p.absences.some(
            (e) =>
              e.userId === a.userId &&
              e.seat === a.seat &&
              e.seatGeneration ===
                p.participants.find((x) => x.userId === a.userId)!
                  .seatGeneration &&
              time(e.observedAt) &&
              e.deadlineAt === e.observedAt + GRACE_MS &&
              p.finishedAt >= e.deadlineAt &&
              ['socket_close', 'recovery'].includes(e.source),
          ),
        )
      )
        return quarantine('mutual_absence_policy')
      break
    case 'engine_fault':
      if (p.cause !== 'engine_fault') return quarantine('engine_fault_policy')
      break
    default:
      return quarantine('terminal_reason')
  }
  if (disposition === 'rated') {
    if (
      s.status !== 'finished' ||
      !equal(s.result.adjustedBySeat, adjusted) ||
      !equal(s.result.netBySeat, net) ||
      !equal(s.result.outcomeBySeat, result) ||
      !players.every((a) => a.outcome === result![a.seat])
    )
      return quarantine('aggregate_or_outcome')
  } else if (
    s.status !== 'void' ||
    players.some((a) => a.outcome !== null) ||
    s.result.outcomeBySeat != null
  )
    return quarantine('void_has_winner')
  return {
    state: 'verified',
    certificate: {
      version: SETTLEMENT_VERSION,
      matchId: s.matchId,
      sourceToken: s.sourceToken,
      evidenceDigest: await evidenceDigest({
        terminal: s.terminal,
        hands: s.hands.map((h) => h.verification),
        result: s.result,
        players,
      }),
      rulesVersion: 'hu-rated.v1',
      verifierVersion: 'hand.v2',
      drawBandVersion: 'draw-band.v1',
      reason: p.reason,
      finishedAt: p.finishedAt,
      disposition,
      players,
      adjustedBySeat: adjusted,
      manifest: p.completedHands,
    },
  }
}
