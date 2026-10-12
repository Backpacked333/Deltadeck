// The practice numbers shown on Progress and on Your profile, from the
// hands this player has recorded against Atlas.
import { calibrationSummary, GRADES } from './grading'
import type { HandRecord } from './storage'

const gradedDecisions = (hand: HandRecord) =>
  hand.guided || hand.graded === false ? [] : (hand.decisions ?? [])

/** Nonguided, completed model grades, not a claim of unaided learning. */
export function handAccuracy(hand: HandRecord): number | null {
  const decisions = gradedDecisions(hand)
  return decisions.length
    ? decisions.reduce((s, d) => s + d.accuracy, 0) / decisions.length
    : null
}

export function practiceStats(hands: HandRecord[], sessionId = '') {
  const decisions = hands.flatMap(gradedDecisions)
  const perHand = hands.map(handAccuracy).filter((a): a is number => a !== null)
  let net = 0,
    expected = 0,
    coveredNet = 0
  const netLine: number[] = [0],
    expectedLine: number[] = [0],
    coveredNetLine: number[] = [0]
  const modeledHandIds: string[] = []
  const coverage = {
    total: hands.length,
    eligible: 0,
    evaluated: 0,
    guided: 0,
    pending: 0,
    ungraded: 0,
    missingModel: 0,
  }
  hands.forEach((h) => {
    net += h.net
    netLine.push(net)
    if (h.guided) {
      coverage.guided++
      return
    }
    if (h.graded === false) {
      coverage.pending++
      return
    }
    if (!h.decisions?.length) {
      coverage.ungraded++
      return
    }
    coverage.eligible++
    if (h.expectedNet === undefined || !Number.isFinite(h.expectedNet)) {
      coverage.missingModel++
      return
    }
    coverage.evaluated++
    modeledHandIds.push(h.id)
    expected += h.expectedNet
    coveredNet += h.net
    expectedLine.push(expected)
    coveredNetLine.push(coveredNet)
  })
  const grades = GRADES.map((g) => ({
    grade: g,
    count: decisions.filter((d) => d.grade === g).length,
  }))
  const reads = decisions
    .filter((d) => d.guess !== undefined)
    .map((d) => ({
      guess: d.guess!,
      actual: d.equity,
      label: d.handClass || 'Other',
    }))
  return {
    hands,
    decisions,
    accuracy: decisions.length
      ? decisions.reduce((s, d) => s + d.accuracy, 0) / decisions.length
      : null,
    handAccuracy: perHand,
    netLine,
    expectedLine: coverage.evaluated ? expectedLine : [],
    coveredNetLine: coverage.evaluated ? coveredNetLine : [],
    modeledHandIds,
    coverage,
    actualAll: net,
    modeledCovered: coverage.evaluated ? expected : null,
    actualCovered: coverage.evaluated ? coveredNet : null,
    coveredCount: coverage.evaluated,
    totalCount: coverage.total,
    modelGap: coverage.evaluated ? coveredNet - expected : null,
    grades,
    reads,
    calibration: calibrationSummary(reads),
    session: hands.filter((h) => h.id.startsWith(sessionId)).length,
    evLost: decisions.reduce((s, d) => s + d.evLost, 0),
  }
}

export type PracticeStats = ReturnType<typeof practiceStats>
