import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { LearningSession } from '../core/session'
import { MemoryStorage, fixedClock } from '../core/__fixtures__/testing'
import { seal } from './evidence'
import { attempt, OWNER, records } from './__fixtures__'
import { tasks } from './content'
import type { EvidenceRuntime } from './runtime'
import type { LearningEvent } from './types'
const state = vi.hoisted(() => ({ runtime: null as unknown }))
vi.mock('./runtime', () => ({
  CHANGED: 'qp-learning-evidence',
  evidenceRuntime: () => state.runtime,
}))
import LearningWorkspace from './LearningWorkspace'
let emitted: LearningEvent[]
let runtime: EvidenceRuntime
beforeEach(() => {
  emitted = []
  runtime = {
    rows: [],
    sync: { scope: { accountId: OWNER, epoch: 1 } },
    practiceGeneration: 0,
    learningGeneration: 0,
    serverNow: null,
    assignment: null,
    error: null,
    status: () => 'saved_to_account',
    emit: vi.fn(async (e: LearningEvent) => {
      emitted.push(e)
    }),
    retry: vi.fn(async () => {}),
    consent: vi.fn(async () => {}),
  } as unknown as EvidenceRuntime
  state.runtime = runtime
})
function renderWorkspace() {
  return render(
    <LearningWorkspace
      session={new LearningSession(new MemoryStorage(), fixedClock)}
    />,
  )
}
it('F15 cold start is a fixed manual sequence; shadow selection is logged but not marketed', async () => {
  renderWorkspace()
  expect(screen.getByText(/Targeted selection runs in shadow/)).toBeVisible()
  expect(
    screen.queryByRole('region', { name: 'Why this practice' }),
  ).not.toBeInTheDocument()
  await waitFor(() =>
    expect(
      emitted.some(
        (e) => e.kind === 'recommendation' && e.exposure === 'shadow',
      ),
    ).toBe(true),
  )
  const user = userEvent.setup()
  await user.click(
    screen.getByRole('button', { name: 'Payments are not receipts' }),
  )
  expect(
    screen.getByRole('heading', { name: 'Payments are not receipts' }),
  ).toBeVisible()
  expect(screen.getAllByText(/Prose is not graded/)[0]).toBeVisible()
})

it('switching task remounts its attempt and clearing the learning generation hides the old selection', async () => {
  const session = new LearningSession(new MemoryStorage(), fixedClock)
  render(<LearningWorkspace session={session} />)
  const user = userEvent.setup()
  const cases = tasks
    .filter((t) => t.skill === 'incremental' && !t.holdout)
    .slice(0, 2)
  for (const t of cases) {
    await user.click(screen.getByRole('button', { name: t.case.title }))
    const rationale = screen.getByRole('textbox', {
      name: /Prediction rationale/,
    })
    expect(rationale).toHaveValue('')
    await user.type(rationale, `For ${t.case.id}`)
    await user.click(screen.getByRole('button', { name: 'Commit prediction' }))
    expect(session.store.attempts.at(-1)?.caseId).toBe(t.case.id)
  }
  state.runtime = { ...runtime, learningGeneration: 1 }
  act(() => window.dispatchEvent(new Event('qp-learning-evidence')))
  expect(
    screen.queryByRole('heading', { name: cases[1].case.title }),
  ).not.toBeInTheDocument()
})
it('pilot can be exposed only for enabled, consenting targeted assignments and has usable mismatch/focus controls', async () => {
  runtime.assignment = {
    protocol: 'test',
    arm: 'targeted',
    enabled: true,
    consented: true,
    withdrawn: false,
    endpoint: 'new-family delayed',
    baseline: 'curriculum order',
  }
  renderWorkspace()
  const user = userEvent.setup()
  await waitFor(() =>
    expect(
      screen.getByRole('region', { name: 'Why this practice' }),
    ).toBeVisible(),
  )
  await user.click(screen.getByRole('button', { name: 'This does not fit' }))
  await user.click(screen.getByRole('button', { name: 'Choose another focus' }))
  expect(
    emitted.filter((e) => e.kind === 'feedback').map((e) => e.response),
  ).toEqual(['does-not-fit', 'other-focus'])
  expect(
    screen.getByRole('combobox', { name: 'Choose your focus' }),
  ).toHaveValue('conditioning')
  await user.click(
    screen.getByRole('button', { name: 'Withdraw pilot consent' }),
  )
  expect(runtime.consent).toHaveBeenCalledWith(false)
})
it('F15 exhausted family bank explains limitation instead of pretending changed numbers are fresh', async () => {
  runtime.assignment = {
    protocol: 'test',
    arm: 'targeted',
    enabled: true,
    consented: true,
    withdrawn: false,
    endpoint: 'delayed',
    baseline: 'curriculum',
  }
  runtime.rows = (
    await Promise.all(
      tasks
        .filter((t) => t.skill === 'incremental')
        .map((t) => records(t.case.id.replace('targeted-', ''))),
    )
  ).flat()
  renderWorkspace()
  expect(
    await screen.findByText(/Content limited: no fresh family remains/),
  ).toBeVisible()
  expect(screen.queryByRole('button', { name: /Try / })).not.toBeInTheDocument()
})
it('F10 account loss removes private projection rows and chosen tasks from rendering', async () => {
  runtime.rows = await records('incremental-poker-call', {
    id: 'private-account-a',
  })
  renderWorkspace()
  expect(
    screen.getByText(/submission: attempt:private-account-a/),
  ).toBeInTheDocument()
  state.runtime = null
  await act(async () => {
    window.dispatchEvent(new Event('qp-learning-evidence'))
  })
  expect(
    screen.queryByText(/submission: attempt:private-account-a/),
  ).not.toBeInTheDocument()
})

it('delayed journey obtains a server issue before revealing the reserved case, and reports refusal honestly', async () => {
  runtime.rows = [
    ...(await records('incremental-poker-call')),
    ...(await records('incremental-business-inventory')),
  ].map((r) => ({ ...r, receivedAt: '2026-01-01T00:00:00.000Z' }))
  runtime.serverNow = Date.parse('2026-01-10T00:00:00Z')
  runtime.issueAssessment = vi
    .fn()
    .mockRejectedValueOnce(new Error('Not due; server clock decides'))
    .mockResolvedValueOnce({
      issueId: 'test-issue',
      caseId: 'targeted-incremental-delayed-warranty',
    })
  renderWorkspace()
  const user = userEvent.setup()
  const begin = screen.getByRole('button', {
    name: /Delayed new-family check:/,
  })
  await user.click(begin)
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'server clock decides',
  )
  expect(
    screen.queryByText(/Reserved assessment. Opening/),
  ).not.toBeInTheDocument()
  await user.click(begin)
  expect(await screen.findByText(/Reserved assessment. Opening/)).toBeVisible()
  expect(runtime.issueAssessment).toHaveBeenCalledWith('incremental')
  expect(screen.getByText(/excluding hidden time/)).toBeVisible()
})
it('invalidated latest evaluation no longer presents success despite the cached receipt', async () => {
  const rows = await records()
  runtime.rows = [
    ...rows,
    await seal({
      schema: 1,
      accountId: OWNER,
      observedAt: fixedClock().toISOString(),
      trust: 'client-reported',
      id: 'i',
      kind: 'invalidation',
      targetId: rows[1].event.id,
      reason: 'withdraw',
    }),
  ]
  renderWorkspace()
  expect(screen.getAllByText(/0 eligible successful families/)).toHaveLength(3)
  expect(attempt()).toHaveProperty('submittedAt')
})
