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

  it('F16_unknown_ev_same_covered_subset', () => {
    const covered = Array.from({ length: 12 }, (_, i) => ({
      ...hand(`covered-${i}`, 20, [decision(80, 'Good')]),
      expectedNet: 10,
      graded: true,
    }))
    const missing = Array.from({ length: 8 }, (_, i) =>
      hand(`missing-${i}`, 1000, [decision(80, 'Good')]),
    )
    const stats = practiceStats([...covered, ...missing])
    expect(stats.actualAll).toBe(8240)
    expect(stats.modeledCovered).toBe(120)
    expect(stats.actualCovered).toBe(240)
    expect(stats.coveredCount).toBe(12)
    expect(stats.totalCount).toBe(20)
    expect(stats.modelGap).toBe(120)
    expect(stats.expectedLine).toHaveLength(13)
    expect(stats.coveredNetLine).toHaveLength(13)
    expect(stats.coverage).toMatchObject({
      total: 20,
      eligible: 20,
      evaluated: 12,
      missingModel: 8,
    })
  })

  it('F16 all missing stays unknown, including non-finite modeled values', () => {
    const stats = practiceStats([
      hand('legacy', 100),
      ...[undefined, NaN, Infinity, -Infinity].map((expectedNet, i) => ({
        ...hand(`invalid-${i}`, 20, [decision(90, 'Best')]),
        expectedNet,
      })),
    ])
    expect(stats.modeledCovered).toBeNull()
    expect(stats.actualCovered).toBeNull()
    expect(stats.modelGap).toBeNull()
    expect(stats.expectedLine).toEqual([])
    expect(stats.coveredNetLine).toEqual([])
    expect(stats.coverage).toMatchObject({
      total: 5,
      eligible: 4,
      evaluated: 0,
      missingModel: 4,
    })
  })

  it('F16 guided, pending and ungraded records cannot inflate accuracy or model coverage', () => {
    const valid = {
      ...hand('valid', 10, [decision(60, 'Mistake')]),
      expectedNet: 0,
    }
    const guided = {
      ...valid,
      id: 'guided',
      guided: true,
      decisions: [decision(100, 'Best')],
    }
    const pending = {
      ...valid,
      id: 'pending',
      graded: false,
      decisions: [decision(100, 'Best')],
    }
    const ungraded = { ...valid, id: 'ungraded', decisions: [] }
    const stats = practiceStats([valid, guided, pending, ungraded])
    expect(stats.accuracy).toBe(60)
    expect(stats.decisions).toHaveLength(1)
    expect(stats.modeledCovered).toBe(0)
    expect(stats.actualCovered).toBe(10)
    expect(stats.coverage).toMatchObject({
      total: 4,
      eligible: 1,
      evaluated: 1,
      guided: 1,
      pending: 1,
      ungraded: 1,
    })
    expect(handAccuracy(guided)).toBeNull()
    expect(handAccuracy(pending)).toBeNull()
    expect(handAccuracy(ungraded)).toBeNull()
  })

  it('F16 zero and negative model values remain covered in the same interleaved played order', () => {
    const graded = [decision(80, 'Good')]
    const stats = practiceStats([
      { ...hand('first', 10, graded), expectedNet: 0 },
      hand('missing', 900, graded),
      { ...hand('third', -20, graded), expectedNet: -10 },
      { ...hand('guided', 500, graded), guided: true, expectedNet: 400 },
      { ...hand('fifth', 30, graded), expectedNet: 20 },
    ])
    expect(stats.modeledHandIds).toEqual(['first', 'third', 'fifth'])
    expect(stats.expectedLine).toEqual([0, 0, -10, 10])
    expect(stats.coveredNetLine).toEqual([0, 10, -10, 20])
    expect(stats).toMatchObject({
      actualAll: 1420,
      actualCovered: 20,
      modeledCovered: 10,
      modelGap: 10,
      coveredCount: 3,
      totalCount: 5,
    })
  })
})
