import { describe, expect, it } from 'vitest'
import { handAccuracy, practiceStats } from './practiceStats'
import type { DecisionRecord, HandRecord } from './storage'

const decision = (accuracy: number, grade: DecisionRecord['grade']) =>
  ({ accuracy, grade, evLost: 100 - accuracy, equity: 0.5 }) as DecisionRecord
const hand = (id: string, net: number, decisions?: DecisionRecord[]) =>
  ({ id, hand: 1, net, result: 'won', guided: false, decisions }) as HandRecord

describe('practiceStats', () => {
  it('averages accuracy over decisions and follows the running result', () => {
    const hands = [
      hand('s1-a', 50, [decision(100, 'Best'), decision(80, 'Good')]),
      hand('s1-b', -20),
      hand('s2-c', 30, [decision(60, 'Mistake')]),
    ]
    const stats = practiceStats(hands, 's1')
    expect(stats.accuracy).toBe(80)
    expect(stats.handAccuracy).toEqual([90, 60])
    expect(stats.netLine).toEqual([0, 50, 30, 60])
    expect(stats.session).toBe(2)
    expect(stats.grades.find((g) => g.grade === 'Best')?.count).toBe(1)
  })

  it('has no accuracy without graded decisions', () => {
    expect(practiceStats([hand('a', 0)]).accuracy).toBeNull()
    expect(handAccuracy(hand('a', 0))).toBeNull()
  })
})
