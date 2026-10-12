import type { PGlite } from '@electric-sql/pglite'
import {
  settlementFixture,
  USERS,
  T0,
} from '../../worker/test/settlement-fixtures'
import { evidenceDigest } from '../../worker/src/live-evidence'
import {
  inspectSettlement,
  type SettlementSource,
} from '../../worker/src/settlement-evidence'
import { problemsWith, type AuditedHand } from '../../worker/src/verify'

/** Real timeout-forfeit evidence for downstream rating/CAS fixtures. */
export async function certifiedRatingFixture(
  db: PGlite,
  matchId: string,
  loser: string,
  winner: string,
  finishedAt = new Date().toISOString(),
) {
  const rpc = async <T>(fn: string, p: unknown) =>
    (
      await db.query<{ v: T }>(`select public.${fn}($1::jsonb) v`, [
        JSON.stringify(p),
      ])
    ).rows[0].v
  const original = await settlementFixture(matchId, 'forfeit')
  const delta = Date.parse(finishedAt) - (T0 + 1_000_000)
  const serialized = JSON.stringify(original, (_key, value: unknown) =>
    typeof value === 'number' && value >= T0 ? value + delta : value,
  ).replace(new RegExp(USERS.join('|'), 'g'), (id) =>
    id === USERS[0] ? loser : winner,
  )
  const s = JSON.parse(serialized) as SettlementSource
  for (const h of s.hands) {
    h.verification!.recordDigest = await evidenceDigest(h.record)
    h.verification!.archiveDigest = await evidenceDigest(h.archive)
    Object.assign(
      s.terminal!.proof.completedHands[h.handNo - 1],
      h.verification,
    )
  }
  const start = {
    id: matchId,
    kind: s.kind,
    config: s.config,
    players: s.players,
  }
  await rpc('record_match', start)
  for (const h of s.hands) await rpc('record_hand', h.archive)
  await rpc('record_match', {
    ...start,
    handNo: s.hands.length,
    result: s.result,
  })
  await rpc('record_terminal', s.terminal)
  for (const h of s.hands) {
    const audited = await rpc<AuditedHand>('audit_hand', { id: h.id })
    const problems = await problemsWith(audited)
    if (problems.length) throw Error(JSON.stringify(problems))
    await rpc('verify_hand_v2', {
      id: h.id,
      sourceToken: audited.sourceToken,
      ...h.verification,
    })
  }
  const audited = await rpc<SettlementSource>('audit_settlement', { matchId })
  const verdict = await inspectSettlement(audited)
  if (verdict.state !== 'verified') throw Error(JSON.stringify(verdict))
  await rpc('record_settlement_verdict', {
    matchId,
    sourceToken: audited.sourceToken,
    ...verdict,
  })
  return {
    sourceToken: verdict.certificate.sourceToken,
    certificateDigest: verdict.certificate.evidenceDigest,
    finishedAt,
    seats: { [loser]: 0, [winner]: 1 },
  }
}
