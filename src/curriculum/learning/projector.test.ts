import { describe, expect, it } from 'vitest'
import { canonical } from '../../net/syncRevision'
import { emptyStore } from '../core/persistence'
import { freshFamilyCase } from '../core/freshness'
import { validateCase } from '../core/assessment'
import { tasks, taskById } from './content'
import { attempt, OWNER, records } from './__fixtures__'
import {
  base,
  evaluateSubmission,
  practiceEvidence,
  seal,
  submission,
} from './evidence'
import { project } from './projector'
import { recommend } from './recommend'
import { DELAY_MS, type Evaluation, type StoredEvent } from './types'
import { validEvent } from './validate'

describe('F08/F09/F15 rebuildable private learning', () => {
  it('authored content is valid, distinguishable and golden answers grade correctly', () => {
    expect(tasks).toHaveLength(16)
    expect(new Set(tasks.map((t) => t.family)).size).toBe(16)
    for (const t of tasks) {
      expect(validateCase(t.case)).toEqual([])
      expect(
        evaluateSubmission(
          submission(OWNER, attempt(t.case.id.replace('targeted-', ''))),
        ).passed,
      ).toBe(true)
    }
    expect(tasks.filter((t) => t.holdout).map((t) => t.purpose)).toEqual([
      'delayed',
      'delayed',
      'delayed',
    ])
  })
  it('F08 duplicates and delivery permutations replay identically', async () => {
    const rows = [
      ...(await records()),
      ...(await records('incremental-business-inventory')),
    ]
    const expected = project(rows, OWNER)
    expect(expected.skills[0].stage).toBe('transferred')
    expect(project([...rows].reverse(), OWNER)).toEqual(expected)
    expect(project([...rows, ...rows], OWNER)).toEqual(expected)
    expect(project(JSON.parse(JSON.stringify(rows)), OWNER)).toEqual(expected)
    expect(
      project(rows, 'other').skills.every((s) => s.stage === 'unknown'),
    ).toBe(true)
  })
  it('F08 same immutable ID with differing answers is a conflict, not best score', async () => {
    const rows = await records()
    const changed = structuredClone(rows[0])
    changed.digest = 'different'
    const p = project([...rows, changed], OWNER)
    expect(p.conflicts).toEqual([rows[0].event.id])
    expect(p.skills[0].successes).toEqual([])
  })
  it('F08 raw answer and grade stay separate; reflection does not mutate submission', () => {
    const a = attempt()
    const s = submission(OWNER, a)
    expect(
      submission(OWNER, {
        ...a,
        phase: 'reflected',
        reflection: 'Changed assumption',
      }),
    ).toEqual(s)
    expect(s.attempt).not.toHaveProperty('evaluation')
    expect(evaluateSubmission(s).submissionId).toBe(s.id)
    expect(validEvent(s)).toBe(true)
    expect(validEvent({ ...s, trust: 'server-certified' })).toBe(false)
  })
  it('F09 assisted or exposed success never becomes independent; repeated family is not new', async () => {
    const first = await records()
    const repeated = await records('incremental-poker-call', {
      submittedAt: '2026-10-08T12:00:00.000Z',
    })
    const assisted = await records('incremental-business-inventory', {
      assistance: { hintIds: ['net:0'], solutionViewed: false },
    })
    const p = project([...first, ...repeated, ...assisted], OWNER)
    expect(p.skills[0].successes).toHaveLength(1)
    expect(p.skills[0].excluded.flatMap((e) => e.reasons)).toContain(
      'repeated-family',
    )
    expect(p.skills[0].excluded.flatMap((e) => e.reasons)).toContain(
      'assisted-or-unknown',
    )
    const exposure = await seal({
      ...base(OWNER, 'expose', '2026-01-01T00:00:00Z'),
      kind: 'exposure',
      family: 'targeted-incremental-poker-call',
      sourceId: 'prior',
      reason: 'preview',
    })
    expect(
      project([...first, exposure], OWNER).skills[0].successes,
    ).toHaveLength(0)
  })
  it('F08 superseding evaluations and invalidation cannot resurrect an old grade', async () => {
    const rows = await records()
    const old = rows[1].event as Evaluation
    const revised = await seal({ ...old, id: 'regrade', supersedes: old.id })
    expect(project([...rows, revised], OWNER).skills[0].successes).toHaveLength(
      1,
    )
    const invalidation = await seal({
      ...base(OWNER, 'invalidate', old.observedAt),
      kind: 'invalidation',
      targetId: 'regrade',
      reason: 'Rubric under review',
    })
    expect(
      project([...rows, revised, invalidation], OWNER).skills[0].successes,
    ).toHaveLength(0)
    const forged = await seal({ ...old, id: 'forged', passed: false })
    expect(project([...rows, forged], OWNER).skills[0].successes).toHaveLength(
      0,
    )
    const invalidSource = await seal({
      ...base(OWNER, 'invalidate-source', old.observedAt),
      kind: 'invalidation',
      targetId: rows[0].event.id,
      reason: 'Bad source',
    })
    expect(
      project([...rows, invalidSource], OWNER).skills[0].successes,
    ).toHaveLength(0)
  })
  it('F09 new errors downgrade current stage and keep successful counterevidence', async () => {
    const rows = [
      ...(await records()),
      ...(await records('incremental-business-inventory')),
      ...(await records('incremental-cash-diagnostic', {
        submittedAt: '2026-10-08T00:00:00Z',
        answers: { net: 35, loss: 25 },
      })),
    ]
    const p = project(rows, OWNER).skills[0]
    expect(p.stage).toBe('practiced')
    expect(p.counterevidence).toHaveLength(2)
    expect(p.hypothesis).toBe('uncertain')
  })
  it('misconception requires recurring independent cross-context errors and remains contested by success', async () => {
    const rows = [
      ...(await records('incremental-poker-call', {
        answers: { net: 120, loss: -30 },
      })),
      ...(await records('incremental-business-inventory', {
        answers: { net: 150, loss: -35 },
      })),
    ]
    expect(project(rows, OWNER).skills[0].hypothesis).toBe('supported')
    expect(
      project(
        [...rows, ...(await records('incremental-cash-diagnostic'))],
        OWNER,
      ).skills[0].hypothesis,
    ).toBe('contested')
  })
  it('F09 future device time cannot open holdout or certify retention; receipt only anchors scheduling', async () => {
    let rows: StoredEvent[] = [
      ...(await records()),
      ...(await records('incremental-business-inventory')),
    ]
    expect(project(rows, OWNER, 9e12).skills[0].dueAt).toBeNull()
    rows = rows.map((r) => ({ ...r, receivedAt: '2026-10-07T12:00:00.000Z' }))
    const due = Date.parse('2026-10-07T12:00:00.000Z') + DELAY_MS
    const early = project(rows, OWNER, due - 1)
    expect(early.skills[0].retention).toBe('unknown')
    expect(
      recommend(early, rows, OWNER, '', {
        goal: 'incremental',
        serverNow: due - 1,
      }).exclusions,
    ).toContainEqual({
      id: 'targeted-incremental-delayed-warranty',
      reason: 'reserved-until-server-receipt-delay',
    })
    expect(project(rows, OWNER, due).skills[0].retention).toBe('due')
    const late = [
      ...rows,
      ...(await records('incremental-delayed-warranty', {
        submittedAt: '2099-01-01T00:00:00Z',
      })),
    ]
    expect(project(late, OWNER, due).skills[0]).toMatchObject({
      stage: 'transferred',
      retention: 'device-clock-only',
    })
    expect(
      project(late, OWNER, due).skills[0].excluded.flatMap((e) => e.reasons),
    ).toContain('device-clock-cannot-prove-delay')
  })
  it('F15 family exhaustion fails honestly, deterministic selection logs exclusions and alternatives', async () => {
    const rows = (
      await Promise.all(
        tasks
          .filter((t) => t.skill === 'incremental')
          .map((t) => records(t.case.id.replace('targeted-', ''))),
      )
    ).flat()
    const r = recommend(project(rows, OWNER), rows, OWNER, '2026-10-07', {
      goal: 'incremental',
    })
    expect(r).toMatchObject({
      state: 'content-limited',
      selected: null,
      exposure: 'shadow',
      candidates: [],
    })
    expect(r.exclusions).toHaveLength(6)
    expect(
      recommend(
        project([...rows].reverse(), OWNER),
        [...rows].reverse(),
        OWNER,
        '2026-10-07',
        { goal: 'incremental' },
      ),
    ).toEqual(r)
    expect(
      recommend(project([], OWNER), [], OWNER, '2026-10-07', {
        goal: 'conditioning',
      }).selected,
    ).toBe('targeted-conditioning-sample-space')
  })
  it('F15 changed numbers in a named family do not make existing curriculum fresh', () => {
    const c = taskById.get('targeted-incremental-poker-call')!.case
    const variant = { ...c, id: 'perturbed', familyId: c.familyId }
    const store = emptyStore()
    store.attempts = [attempt()]
    expect(
      freshFamilyCase(
        ['perturbed'],
        new Map([
          [c.id, c],
          ['perturbed', variant],
        ]),
        store,
      ),
    ).toBeUndefined()
  })
  it('practice outcomes, modeled EV, rating and live private cards are not demonstrated learning', async () => {
    const s = await practiceEvidence(
      OWNER,
      {
        id: 'h',
        hand: 1,
        net: 1000000,
        result: 'won',
        guided: false,
        graded: true,
        at: 100,
      },
      0,
    )
    expect(s.skills).toEqual([])
    expect(s.assistance).toBe('unknown')
    expect(canonical(s)).not.toContain('1000000')
    expect(canonical(s)).not.toContain('won')
    expect(evaluateSubmission(s)).toMatchObject({
      passed: null,
      eligible: false,
    })
    expect(
      project([await seal(s)], OWNER).skills.every(
        (p) => p.stage === 'unknown',
      ),
    ).toBe(true)
  })
})
