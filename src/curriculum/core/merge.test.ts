// Two devices' curriculum stores merge instead of the last save winning
// (audit F09).
import { describe, expect, it } from 'vitest'
import { baseCases } from '../content/foundationCases/baseBanks'
import { evaluateCase, recordEvidence } from './assessment'
import {
  contentOf,
  mergeLearningRaw,
  mergeLearningStores,
  OTHER_DEVICE,
} from './merge'
import { decodeStore, emptyStore } from './persistence'
import { attemptFor, fixedClock } from './__fixtures__/testing'
import type { AttemptSnapshot, LearningStoreV2 } from './types'

const at = (day: number) => () =>
  new Date(fixedClock().getTime() + day * 86_400_000)
const transfer = baseCases.find((c) => c.id === 'f03-transfer-1')!
const otherTransfer = baseCases.find(
  (c) => c.mode === 'transfer' && c.unitId !== 'f03',
)!

/** `store` with `c` submitted on `day`, as the session records it. */
function submit(
  store: LearningStoreV2,
  c: typeof transfer,
  day: number,
  changes: Partial<AttemptSnapshot> = {},
) {
  const clock = at(day)
  const a = attemptFor(c, {
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
  const next = recordEvidence(
    { ...store, attempts: [...store.attempts, a] },
    a,
    clock,
  )
  return {
    ...next,
    updatedAt: clock().toISOString(),
    exposedVariants: [
      ...new Set([...next.exposedVariants, `${c.id}@${c.contentVersion}`]),
    ],
  }
}

const empty = () => emptyStore(fixedClock)
const valid = (store: LearningStoreV2) => {
  const decoded = decodeStore(store)
  expect(decoded.ok, JSON.stringify(!decoded.ok && decoded.errors)).toBe(true)
  return store
}

describe('mergeLearningStores', () => {
  it('keeps disjoint work from both devices, in either order', () => {
    const phone = submit(empty(), transfer, 1)
    const laptop = submit(empty(), otherTransfer, 2)
    const one = valid(mergeLearningStores(phone, laptop))
    const two = valid(mergeLearningStores(laptop, phone))
    for (const merged of [one, two]) {
      expect(merged.attempts.map((a) => a.caseId).sort()).toEqual(
        [transfer.id, otherTransfer.id].sort(),
      )
      expect(merged.receipts).toHaveLength(2)
      expect(Object.keys(merged.reviewSchedule).sort()).toEqual(
        [transfer.unitId, otherTransfer.unitId].sort(),
      )
      expect(merged.exposedVariants).toHaveLength(2)
    }
    // Settings aside (each device keeps its own), both see the same work.
    expect(contentOf({ ...one, settings: two.settings })).toBe(contentOf(two))
  })

  it('is idempotent: merging again changes nothing', () => {
    const phone = submit(empty(), transfer, 1)
    const laptop = submit(empty(), otherTransfer, 2)
    const merged = mergeLearningStores(phone, laptop)
    expect(contentOf(mergeLearningStores(merged, laptop))).toBe(
      contentOf(merged),
    )
    expect(contentOf(mergeLearningStores(merged, merged))).toBe(
      contentOf(merged),
    )
  })

  it('keeps an attempt at its furthest stage, and never forgets its assistance', () => {
    const draft = attemptFor(transfer, { id: 'shared', phase: 'draft' })
    delete draft.committedAt
    const submitted: AttemptSnapshot = {
      ...attemptFor(transfer, { id: 'shared' }),
      submittedAt: at(1)().toISOString(),
      phase: 'archived',
    }
    const hinted: AttemptSnapshot = {
      ...draft,
      assistance: { hintIds: ['setup:0'], solutionViewed: false },
    }
    const merged = mergeLearningStores(
      { ...empty(), attempts: [hinted] },
      { ...empty(), attempts: [submitted] },
    )
    expect(merged.attempts).toHaveLength(1)
    expect(merged.attempts[0].submittedAt).toBe(submitted.submittedAt)
    expect(merged.attempts[0].assistance.hintIds).toEqual(['setup:0'])
  })

  it('keeps both texts of a note changed on both devices, once', () => {
    const phone = { ...empty(), unitNotes: { f03: 'Count only the call.' } }
    const laptop = { ...empty(), unitNotes: { f03: 'Sunk costs are sunk.' } }
    const merged = mergeLearningStores(phone, laptop)
    expect(merged.unitNotes.f03).toBe(
      `Count only the call.${OTHER_DEVICE}Sunk costs are sunk.`,
    )
    // Merged again with either side, the note does not grow.
    expect(mergeLearningStores(merged, laptop).unitNotes.f03).toBe(
      merged.unitNotes.f03,
    )
    expect(mergeLearningStores(laptop, merged).unitNotes.f03).toBe(
      merged.unitNotes.f03,
    )
    // One side only added to the other's text: the longer is both.
    const longer = {
      ...empty(),
      unitNotes: { f03: 'Count only the call. And the pot.' },
    }
    expect(mergeLearningStores(phone, longer).unitNotes.f03).toBe(
      'Count only the call. And the pot.',
    )
  })

  it('drops a draft whose attempt was submitted on the other device', () => {
    const draft = attemptFor(transfer, { id: 'drafted', phase: 'draft' })
    const submitted: AttemptSnapshot = {
      ...draft,
      submittedAt: at(1)().toISOString(),
      phase: 'archived',
    }
    const merged = mergeLearningStores(
      { ...empty(), drafts: { k: { attempt: draft, protocol: {} } } },
      { ...empty(), attempts: [submitted] },
    )
    expect(merged.drafts).toEqual({})
  })

  it('takes each unit’s review schedule from the device with its latest evidence', () => {
    const first = submit(empty(), transfer, 1)
    const later = submit(empty(), transfer, 5)
    const merged = mergeLearningStores(first, later)
    expect(merged.reviewSchedule.f03).toEqual(later.reviewSchedule.f03)
    expect(mergeLearningStores(later, first).reviewSchedule.f03).toEqual(
      later.reviewSchedule.f03,
    )
  })

  it('a reset is not undone by a device that missed it', () => {
    // The laptop did work on day 1, then went quiet; the phone reset on day
    // 3 and did new work on day 4.
    const laptop = {
      ...submit(empty(), transfer, 1),
      unitNotes: { f03: 'old note' },
    }
    const resetAt = at(3)().getTime()
    const reset = { ...empty(), updatedAt: at(3)().toISOString() }
    const phone = submit(reset, otherTransfer, 4)
    for (const merged of [
      mergeLearningStores(phone, laptop, resetAt),
      mergeLearningStores(laptop, phone, resetAt),
    ]) {
      valid(merged)
      expect(merged.attempts.map((a) => a.caseId)).toEqual([otherTransfer.id])
      expect(merged.receipts).toHaveLength(1)
      expect(merged.unitNotes).toEqual({})
      expect(merged.reviewSchedule.f03).toBeUndefined()
      // What was seen stays seen: no reset makes a variant fresh again.
      expect(merged.exposedVariants).toContain(
        `${transfer.id}@${transfer.contentVersion}`,
      )
    }
  })
})

describe('mergeLearningRaw', () => {
  const raw = (s: LearningStoreV2) => JSON.stringify(s)
  it('says when one side already holds everything, and merges otherwise', () => {
    const phone = submit(empty(), transfer, 1)
    const both = mergeLearningStores(phone, submit(empty(), otherTransfer, 2))
    expect(mergeLearningRaw(raw(phone), raw(phone), null)).toEqual({
      kind: 'ours',
    })
    expect(mergeLearningRaw(raw(both), raw(phone), null)).toEqual({
      kind: 'ours',
    })
    expect(mergeLearningRaw(raw(phone), raw(both), null)).toEqual({
      kind: 'theirs',
    })
    const merged = mergeLearningRaw(
      raw(phone),
      raw(submit(empty(), otherTransfer, 2)),
      null,
      at(10),
    )
    expect(merged?.kind).toBe('merged')
    const stored = JSON.parse((merged as { raw: string }).raw)
    valid(stored)
    expect(stored.attempts).toHaveLength(2)
    expect(stored.updatedAt).toBe(at(10)().toISOString())
  })

  it('gives up on a document that is not a valid store', () => {
    expect(mergeLearningRaw('{"updatedAt":"x"}', raw(empty()), null)).toBeNull()
    expect(mergeLearningRaw(raw(empty()), 'not json', null)).toBeNull()
  })
})
