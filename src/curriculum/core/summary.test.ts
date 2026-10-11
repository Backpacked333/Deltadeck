import { describe, expect, it } from 'vitest'
import { emptyStore } from './persistence'
import { lessonSummary } from './summary'
import type { EvidenceReceipt, LearningStoreV2 } from './types'

const receipt = (over: Partial<EvidenceReceipt>) =>
  ({
    unitId: 'f01',
    mode: 'transfer',
    eligible: true,
    passed: true,
    submittedAt: '2026-10-01T00:00:00Z',
    ...over,
  }) as EvidenceReceipt

describe('lessonSummary', () => {
  it('counts units passed and started, and the latest one worked on', () => {
    const store: LearningStoreV2 = {
      ...emptyStore(),
      receipts: [
        receipt({ unitId: 'f01' }),
        receipt({
          unitId: 'f02',
          passed: false,
          submittedAt: '2026-10-05T00:00:00Z',
        }),
        receipt({ unitId: 'f03', mode: 'review' }),
      ],
      legacy: { completed: ['equity' as never], notes: {} },
    }
    const summary = lessonSummary(store)
    expect(summary.unitsDone).toBe(1)
    expect(summary.unitsStarted).toBe(3)
    expect(summary.unitsTotal).toBe(10)
    expect(summary.modulesDone).toBe(1)
    expect(summary.last?.unitId).toBe('f02')
  })

  it('is empty for a new learner', () => {
    expect(lessonSummary(emptyStore())).toMatchObject({
      unitsDone: 0,
      unitsStarted: 0,
      last: null,
    })
  })
})
