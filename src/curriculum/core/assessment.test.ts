import { describe, expect, it } from 'vitest'
import {
  backwardClock,
  evaluateCase,
  evidenceState,
  freshCase,
  recordEvidence,
} from './assessment'
import { emptyStore, compactStore } from './persistence'
import { attemptFor, fixedClock } from './__fixtures__/testing'
import { baseCases } from '../content/foundationCases/baseBanks'
import type { AttemptSnapshot, CaseRecord, LearningStoreV2 } from './types'
const transfer = baseCases.find((c) => c.id === 'f03-transfer-1')!
it('grades repeated categories positionally rather than requiring unique category IDs', () => {
  const classified: CaseRecord = {
    ...transfer,
    questions: [
      {
        id: 'classify',
        component: 'setup' as const,
        points: 100,
        critical: true,
        prompt: 'Classify costs.',
        rationale: 'Two costs can share a category.',
        hints: ['a', 'b', 'c', 'd'],
        kind: 'classification' as const,
        entries: [
          { id: 'one', label: 'One' },
          { id: 'two', label: 'Two' },
        ],
        categories: [{ id: 'cost', label: 'Cost' }],
        expected: ['cost', 'cost'],
      },
    ],
  }
  const a = attemptFor(classified, { answers: { classify: ['cost', 'cost'] } })
  expect(
    evaluateCase(classified, a, [], [], undefined, fixedClock),
  ).toMatchObject({ earned: 100, passed: true, eligible: true })
})
const reviews = baseCases.filter(
  (c) => c.unitId === 'f03' && c.mode === 'review',
)
const clockAt = (day: number) => () =>
  new Date(fixedClock().getTime() + day * 86400000)
function submitted(
  c = transfer,
  changes: Partial<AttemptSnapshot> = {},
  day = 0,
  store = emptyStore(fixedClock),
) {
  const clock = clockAt(day),
    a = attemptFor(c, {
      createdAt: clock().toISOString(),
      committedAt: clock().toISOString(),
      ...changes,
    })
  a.evaluation = evaluateCase(
    c,
    a,
    store.attempts,
    store.receipts,
    store.reviewSchedule[c.unitId],
    clock,
    store.exposedVariants,
  )
  a.submittedAt = clock().toISOString()
  a.phase = 'archived'
  return a
}
describe('objective assessment eligibility', () => {
  it('requires80% and all critical items, while exact numeric tolerance uses full precision', () => {
    const all = submitted()
    expect(all.evaluation).toMatchObject({
      earned: 100,
      max: 100,
      eligible: true,
      unaided: true,
    })
    const numeric = transfer.questions.find((q) => q.kind === 'numeric')!
    const missesCalc = submitted(transfer, {
      answers: { ...all.answers, [numeric.id]: -999 },
    })
    expect(missesCalc.evaluation?.earned).toBe(80)
    expect(missesCalc.evaluation?.eligible).toBe(true)
    const critical = transfer.questions.find((q) => q.critical)!
    const missesCritical = submitted(transfer, {
      answers: { ...all.answers, [critical.id]: 'wrong' },
    })
    expect(missesCritical.evaluation?.earned).toBe(80)
    expect(missesCritical.evaluation?.eligible).toBe(false)
    if (numeric.kind !== 'numeric') throw Error('numeric')
    expect(
      submitted(transfer, {
        answers: {
          ...all.answers,
          [numeric.id]: numeric.expected + numeric.tolerance,
        },
      }).evaluation?.earned,
    ).toBe(100)
    expect(
      submitted(transfer, {
        answers: {
          ...all.answers,
          [numeric.id]: numeric.expected + numeric.tolerance * 1.01,
        },
      }).evaluation?.earned,
    ).toBe(80)
  })
  it('never keyword-grades prose or uses simulated winnings as score', () => {
    const a = submitted(transfer, {
      reflection: 'the word probability is absent',
      resultSummary: { realizedProfit: -1000 },
    })
    const b = submitted(transfer, {
      reflection: 'probability uncertainty assumption expected risk',
      resultSummary: { realizedProfit: 999999 },
    })
    expect(a.evaluation).toEqual(b.evaluation)
    const noPredict = submitted(transfer, {
      prediction: undefined,
      committedAt: undefined,
    })
    expect(noPredict.evaluation?.eligible).toBe(false)
    expect(submitted(transfer, { mode: 'explore' }).evaluation?.eligible).toBe(
      false,
    )
    expect(submitted(transfer, { mode: 'practice' }).evaluation?.eligible).toBe(
      false,
    )
  })
  it('treats hints, solutions, repeated exposed variants and compacted exposures as assisted', () => {
    for (const assistance of [
      { hintIds: ['setup:0'], solutionViewed: false },
      { hintIds: [], solutionViewed: true },
    ])
      expect(submitted(transfer, { assistance }).evaluation).toMatchObject({
        unaided: false,
        eligible: false,
      })
    const prior = submitted(),
      fresh = attemptFor(transfer)
    expect(
      evaluateCase(transfer, fresh, [prior], [], undefined, fixedClock)
        .eligible,
    ).toBe(false)
    const store = recordEvidence(emptyStore(fixedClock), prior, fixedClock)
    expect(
      evaluateCase(transfer, fresh, [], store.receipts, undefined, fixedClock)
        .eligible,
    ).toBe(false)
    expect(
      evaluateCase(transfer, fresh, [], [], undefined, fixedClock, [
        `${transfer.id}@1`,
      ]).eligible,
    ).toBe(false)
    expect(
      evaluateCase(
        { ...transfer, contentVersion: 2 },
        { ...fresh, contentVersion: 2 },
        [],
        [],
        undefined,
        fixedClock,
        [`${transfer.id}@1`],
      ).eligible,
    ).toBe(true)
  })
  it('marks stale versions and case identity mismatches practice-only', () => {
    expect(
      submitted(transfer, { rubricVersion: 99 }).evaluation?.eligible,
    ).toBe(false)
    expect(
      submitted(transfer, { contentVersion: 99 }).evaluation?.eligible,
    ).toBe(false)
    expect(submitted(transfer, { caseId: 'wrong' }).evaluation?.eligible).toBe(
      false,
    )
    expect(
      submitted(transfer, { committedAt: clockAt(1)().toISOString() })
        .evaluation?.eligible,
    ).toBe(false)
    const indifferent = baseCases.find((c) => c.id === 'f03-transfer-3')!
    expect(submitted(indifferent).evaluation?.eligible).toBe(true)
    expect(
      indifferent.questions.find((q) => q.id === 'interpret')?.rationale,
    ).toMatch(/zero/)
  })
})
describe('device-clock review schedule and evidence states', () => {
  it('uses3days then10days then30days and requires two fresh delayed review variants', () => {
    let s: LearningStoreV2 = emptyStore(fixedClock)
    expect(evidenceState(s, 'f03', 1, 1, fixedClock)).toBe('not-started')
    s.attempts = [attemptFor(transfer)]
    expect(evidenceState(s, 'f03', 1, 1, fixedClock)).toBe('practicing')
    s = recordEvidence(s, submitted(), fixedClock)
    expect(s.reviewSchedule.f03?.dueAt).toBe(clockAt(3)().toISOString())
    expect(evidenceState(s, 'f03', 1, 1, fixedClock)).toBe('demonstrated')
    const early = submitted(reviews[0], {}, 2, s)
    expect(early.evaluation?.eligible).toBe(false)
    const unchanged = recordEvidence(s, early, clockAt(2))
    expect(unchanged.reviewSchedule).toEqual(s.reviewSchedule)
    expect(evidenceState(s, 'f03', 1, 1, clockAt(3))).toBe('review-due')
    s = recordEvidence(s, submitted(reviews[0], {}, 3, s), clockAt(3))
    expect(s.reviewSchedule.f03?.dueAt).toBe(clockAt(13)().toISOString())
    s = recordEvidence(s, submitted(reviews[1], {}, 13, s), clockAt(13))
    expect(s.reviewSchedule.f03?.dueAt).toBe(clockAt(43)().toISOString())
    expect(evidenceState(s, 'f03', 1, 1, clockAt(13))).toBe('retained')
    expect(evidenceState(s, 'f03', 2, 1, clockAt(13))).toBe('refresh-suggested')
  })
  it('resets streak and retries after1day on a failed review; an assisted one is practice and moves nothing (audit F15)', () => {
    let s = recordEvidence(emptyStore(fixedClock), submitted(), fixedClock)
    s = recordEvidence(s, submitted(reviews[0], {}, 3, s), clockAt(3))
    const failed = submitted(reviews[1], { answers: {} }, 13, s)
    s = recordEvidence(s, failed, clockAt(13))
    expect(s.reviewSchedule.f03?.dueAt).toBe(clockAt(14)().toISOString())
    expect(s.reviewSchedule.f03?.streak).toBe(0)
    const hinted = submitted(
      reviews[2],
      { assistance: { hintIds: ['setup:0'], solutionViewed: false } },
      14,
      s,
    )
    const schedule = s.reviewSchedule
    s = recordEvidence(s, hinted, clockAt(14))
    expect(s.reviewSchedule).toEqual(schedule)
    // Its receipt is kept, and is not evidence.
    expect(s.receipts.at(-1)).toMatchObject({ unaided: false, eligible: false })
  })
  it('does not count the same review variant twice and is idempotent on re-record', () => {
    let s = recordEvidence(emptyStore(fixedClock), submitted(), fixedClock)
    const a = submitted(reviews[0], {}, 3, s)
    s = recordEvidence(s, a, clockAt(3))
    expect(recordEvidence(s, a, clockAt(3))).toEqual(s)
    const repeat = submitted(reviews[0], {}, 13, s)
    expect(repeat.evaluation?.eligible).toBe(false)
    s = recordEvidence(s, repeat, clockAt(13))
    // Not counted, and not a lapse either: the streak stands (audit F15).
    expect(s.reviewSchedule.f03?.streak).toBe(1)
    expect(s.reviewSchedule.f03?.dueAt).toBe(clockAt(13)().toISOString())
  })
  it('once the review bank is used up, reviewing again resets nothing (audit F15)', () => {
    let s = recordEvidence(emptyStore(fixedClock), submitted(), fixedClock)
    s = recordEvidence(s, submitted(reviews[0], {}, 3, s), clockAt(3))
    s = recordEvidence(s, submitted(reviews[1], {}, 13, s), clockAt(13))
    expect(evidenceState(s, 'f03', 1, 1, clockAt(13))).toBe('retained')
    const ids = reviews.map((c) => c.id)
    const version = () => 1
    for (const [i, c] of reviews.slice(2).entries())
      s = recordEvidence(s, submitted(c, {}, 43 + i, s), clockAt(43 + i))
    expect(freshCase(s, ids, version)).toBeUndefined()
    // Reviewing again can only repeat a seen case: practice, no reset.
    const again = submitted(reviews[0], {}, 80, s)
    expect(again.evaluation?.unaided).toBe(false)
    const before = s.reviewSchedule
    s = recordEvidence(s, again, clockAt(80))
    expect(s.reviewSchedule).toEqual(before)
  })
  it('does not turn a backward clock or detail compaction into false retention', () => {
    const s = recordEvidence(emptyStore(fixedClock), submitted(), fixedClock)
    expect(backwardClock(s, clockAt(-1))).toBe(true)
    expect(submitted(reviews[0], {}, -1, s).evaluation?.eligible).toBe(false)
    expect(evidenceState(compactStore(s), 'f03', 1, 1, clockAt(-1))).toBe(
      'demonstrated',
    )
  })
})
