import type { WorkerEnv } from './env'
import { describeError, logEvent } from './log'
import { rpc } from './supabase'
import { inspectSettlement } from './settlement-evidence'
import type { SettlementSource, SettlementVerdict } from './settlement-evidence'
import { verifyArchived } from './verify'

/** Default is read-only: no receipts, certificates, status or rating writes. */
export async function classifySettlement(
  env: WorkerEnv,
  matchId: string,
  options: { write?: boolean } = {},
): Promise<SettlementVerdict> {
  const source = await rpc<SettlementSource>(env, 'audit_settlement', {
    matchId,
  })
  if (!source)
    return { state: 'waiting-for-evidence', reasons: ['match_missing'] }
  const verdict = await inspectSettlement(source)
  if (options.write) {
    await rpc(env, 'record_settlement_verdict', {
      matchId,
      sourceToken: source.sourceToken,
      ...verdict,
    })
  }
  return verdict
}

/** A bounded lease scan, independent of queue delivery and live table lifetime. */
export async function catchUpSettlements(
  env: WorkerEnv,
  now: number,
): Promise<void> {
  if (!env.SUPABASE_SECRET_KEY) return
  const candidates =
    (await rpc<{ matchId: string; hands: number[] }[]>(
      env,
      'settlement_candidates',
      { limit: 4 },
    )) ?? []
  for (const candidate of candidates) {
    try {
      // At most two exact-equity replays per match per invocation.
      let failed = false
      for (const handNo of candidate.hands.slice(0, 2)) {
        const result = await verifyArchived(env, {
          matchId: candidate.matchId,
          handNo,
          rated: true,
        })
        failed ||= result.state === 'failed'
      }
      if (failed) {
        const source = await rpc<SettlementSource>(env, 'audit_settlement', {
          matchId: candidate.matchId,
        })
        if (source)
          await rpc(env, 'record_settlement_verdict', {
            matchId: candidate.matchId,
            sourceToken: source.sourceToken,
            state: 'quarantined',
            reasons: ['hand_verification_failed'],
          })
        continue
      }
      const verdict = await classifySettlement(env, candidate.matchId, {
        write: true,
      })
      if (
        verdict.state === 'verified' &&
        verdict.certificate.disposition === 'rated'
      ) {
        const { applyRating } = await import('./rating')
        await applyRating(
          env,
          {
            matchId: candidate.matchId,
            players: verdict.certificate.players.map((p) => ({
              ...p,
              outcome: p.outcome!,
            })),
            finishedAt: verdict.certificate.finishedAt,
          },
          now,
        )
      }
    } catch (error) {
      logEvent('error', {
        reason: 'settlement_catchup',
        matchId: candidate.matchId,
        detail: describeError(error),
      })
    }
  }
}
