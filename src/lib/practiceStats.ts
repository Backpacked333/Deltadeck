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

/**
 * Whether the model priced this hand: graded, with an expected result. A
 * hand still being graded, or one recorded before expectations were kept,
 * has no expectation; its result is not one (audit F16).
 */
export const isModeled = (hand: HandRecord) =>
  hand.graded !== false && hand.expectedNet !== undefined

export function practiceStats(hands: HandRecord[], sessionId = '') {
  const decisions = hands.flatMap((h) => h.decisions ?? [])
  const perHand = hands.map(handAccuracy).filter((a): a is number => a !== null)
  // The result counts every hand. Result and expectation are compared over
  // the same hands: the modeled ones.
  let net = 0,
    modeledNet = 0,
    expected = 0,
    modeled = 0
  const netLine: number[] = [0],
    modeledNetLine: number[] = [0],
    expectedLine: number[] = [0]
  hands.forEach((h) => {
    net += h.net
    netLine.push(net)
    if (!isModeled(h)) return
    modeled++
    modeledNet += h.net
    expected += h.expectedNet!
    modeledNetLine.push(modeledNet)
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
    net,
    /** Result and expectation over the modeled hands only. */
    modeledNetLine,
    expectedLine,
    modeledNet,
    expected,
    coverage: { modeled, total: hands.length },
    grades,
    reads,
    calibration: calibrationSummary(reads),
    session: hands.filter((h) => h.id.startsWith(sessionId)).length,
    evLost: decisions.reduce((s, d) => s + d.evLost, 0),
  }
}

export type PracticeStats = ReturnType<typeof practiceStats>
