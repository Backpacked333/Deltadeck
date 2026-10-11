// The practice numbers shown on Progress and on Your profile, from the
// hands this player has recorded against Atlas.
import { calibrationSummary, GRADES } from './grading'
import type { HandRecord } from './storage'

/** The mean accuracy of a hand's graded decisions, or null if none. */
export function handAccuracy(hand: HandRecord): number | null {
  const decisions = hand.decisions ?? []
  return decisions.length
    ? decisions.reduce((s, d) => s + d.accuracy, 0) / decisions.length
    : null
}

export function practiceStats(hands: HandRecord[], sessionId = '') {
  const decisions = hands.flatMap((h) => h.decisions ?? [])
  const perHand = hands.map(handAccuracy).filter((a): a is number => a !== null)
  let net = 0,
    expected = 0
  const netLine: number[] = [0],
    expectedLine: number[] = [0]
  hands.forEach((h) => {
    net += h.net
    expected += h.expectedNet ?? h.net
    netLine.push(net)
    expectedLine.push(expected)
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
    expectedLine,
    net,
    expected,
    grades,
    reads,
    calibration: calibrationSummary(reads),
    session: hands.filter((h) => h.id.startsWith(sessionId)).length,
    evLost: decisions.reduce((s, d) => s + d.evLost, 0),
  }
}

export type PracticeStats = ReturnType<typeof practiceStats>
