// The numbers scripts/smoke-ws.mjs reports, and its pass/fail rule.

/** Nearest-rank percentile (p in 0..100) of `samples`; NaN when empty. */
export function percentile(samples: number[], p: number) {
  if (!samples.length) return NaN
  const sorted = [...samples].sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]
}

/** Ack latency (send → acknowledging state) a run may not exceed at p95. */
export const ACK_P95_LIMIT_MS = 300
/** At six seats, the P2-11 target: p95 under 150 ms. */
export const SIX_ACK_P95_LIMIT_MS = 150

export type SmokeResult = {
  hands: number
  target: number
  acks: number[]
  /** Broken invariants (chips, sequence, missing frames, errors), as text. */
  failures: string[]
  /** Frames that showed a seat a card it must not see. */
  leaks: number
  /** Hands whose reveal verified against the commitment sent first. */
  commitments: number
}

/** Why the run failed; empty when it passed. */
export function verdict(r: SmokeResult, limitMs = ACK_P95_LIMIT_MS): string[] {
  const problems: string[] = []
  const p95 = percentile(r.acks, 95)
  if (!r.acks.length) problems.push('no acknowledged moves')
  else if (p95 > limitMs)
    problems.push(`ack p95 ${p95} ms is over ${limitMs} ms`)
  if (r.hands < r.target)
    problems.push(`only ${r.hands} of ${r.target} hands finished`)
  if (r.failures.length)
    problems.push(`${r.failures.length} invariant failures`)
  if (r.leaks) problems.push(`${r.leaks} leaked frames`)
  if (r.commitments !== r.hands)
    problems.push(`${r.commitments} of ${r.hands} commitments verified`)
  return problems
}
