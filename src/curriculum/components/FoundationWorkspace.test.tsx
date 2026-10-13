import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import Curriculum from '../Curriculum'
import { NumericControl } from './NumericControl'
import { DataTable } from './DataTable'
import { SeriesChart } from './SeriesChart'
import { CasePlayer } from './CasePlayer'
import { baseCases } from '../content/foundationCases/baseBanks'
import { LearningSession } from '../core/session'
import { useExperimentController } from '../core/experiments'
import {
  attemptFor,
  fixedClock,
  MemoryStorage,
} from '../core/__fixtures__/testing'
import { evaluateCase, recordEvidence } from '../core/assessment'
import {
  referenceCase,
  referenceManifest,
} from '../core/__fixtures__/reference'
import ReferenceView from '../core/__fixtures__/ReferenceView'
import { LEARNING_KEY } from '../core/persistence'
import { registry } from '../core/registry'

function navigate(hash: string) {
  act(() => {
    window.history.replaceState(null, '', hash)
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  })
}
function ReferenceHarness({ session }: { session: LearningSession }) {
  const c = useExperimentController({
    manifest: referenceManifest,
    session,
    mode: 'assess',
    assessmentMode: 'transfer',
    unitId: 'f03',
    caseId: 'reference-1',
    seed: 42,
  })
  return (
    <div className="curriculum-workspace">
      <ReferenceView controller={c} evidence={session} />
    </div>
  )
}
describe('accessible frozen primitives and reference fixture', () => {
  it('charts finite summaries with labeled axes, equivalent table and gaps for undefined branches', () => {
    const view = render(
      <SeriesChart
        title="Expected profit"
        summary="Not realized winnings."
        xLabel="Probability"
        xUnits="fraction"
        yLabel="EV"
        yUnits="currency"
        series={[
          {
            name: 'Call',
            points: [
              { x: 0, y: -25 },
              { x: 0.5, y: null },
              { x: 1, y: 100 },
            ],
          },
          {
            name: 'Decline',
            points: [
              { x: 0, y: 0 },
              { x: 1, y: 0 },
            ],
          },
        ]}
      />,
    )
    expect(screen.getByRole('img')).toHaveAccessibleDescription(
      /Undefined branches are gaps/,
    )
    expect(
      view.container.querySelector('path[stroke-dasharray="8 4"]'),
    ).not.toBeNull()
    expect(
      screen.getByRole('list', { name: 'Chart line key' }),
    ).toHaveTextContent('Decline — dash/gap pattern 8 4')
    expect(
      screen.getByRole('table', {
        name: 'Expected profit — equivalent values',
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('cell', { name: 'Unavailable' }),
    ).toBeInTheDocument()
    view.rerender(
      <SeriesChart
        title="Bad"
        summary="Never render NaN."
        xLabel="x"
        xUnits="units"
        yLabel="y"
        yUnits="units"
        series={[{ name: 'Bad', points: [{ x: NaN, y: 1 }] }]}
      />,
    )
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('invalid')
  })
  it('labels equivalent numeric and slider input with units/limits/errors and rejects invalid entry', () => {
    const onChange = vi.fn()
    render(
      <NumericControl
        name="price"
        label="Purchase price"
        units="currency units"
        min={0}
        max={100}
        step={1}
        value={25}
        onChange={onChange}
      />,
    )
    const numeric = screen.getByRole('spinbutton', {
      name: 'Purchase price (currency units)',
    })
    expect(numeric).toHaveAttribute('min', '0')
    expect(numeric).toHaveAttribute('max', '100')
    expect(numeric).toHaveAccessibleDescription(
      '0–100 currency units; increment 1',
    )
    const slider = screen.getByRole('slider', {
      name: 'Purchase price slider (currency units)',
    })
    fireEvent.change(numeric, { target: { value: '101' } })
    expect(onChange).not.toHaveBeenCalled()
    expect(numeric).toHaveAttribute('aria-invalid', 'true')
    expect(numeric).toHaveAccessibleDescription(/Use a value/)
    fireEvent.change(numeric, { target: { value: '' } })
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('finite number')
    fireEvent.change(numeric, { target: { value: '30' } })
    expect(onChange).toHaveBeenCalledWith(30)
    fireEvent.change(slider, { target: { value: '40' } })
    expect(onChange).toHaveBeenCalledWith(40)
  })
  it('provides caption, textual summary and null-unavailable equivalent table', () => {
    render(
      <DataTable
        caption="Finite states"
        summary="A missing branch is unavailable, not zero."
        columns={['State', 'Probability']}
        rows={[
          ['Unreachable', null],
          ['Reachable', 0.3],
        ]}
      />,
    )
    expect(
      screen.getByRole('table', { name: 'Finite states' }),
    ).toHaveAccessibleDescription('A missing branch is unavailable, not zero.')
    expect(
      screen.getByRole('rowheader', { name: 'Unreachable' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('cell', { name: 'Unavailable' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('region')).toHaveAttribute('tabindex', '0')
  })
  it('runs the real fixture View/model/controller with commitment before results', async () => {
    const user = userEvent.setup(),
      session = new LearningSession(new MemoryStorage(), fixedClock)
    render(<ReferenceHarness session={session} />)
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run reference' })).toBeDisabled()
    await user.type(
      screen.getByRole('textbox', { name: /Prediction rationale/ }),
      'The modeled expectation should be12.5.',
    )
    await user.click(screen.getByRole('button', { name: 'Commit prediction' }))
    await user.click(screen.getByRole('button', { name: 'Run reference' }))
    expect(
      await screen.findByRole('table', { name: 'Reference exact values' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: '12.5' })).toBeInTheDocument()
    expect(session.store.attempts[0].prediction?.rationale).toBe(
      'The modeled expectation should be12.5.',
    )
    expect(session.store.attempts[0].evaluation).toBeUndefined()
    await user.type(
      screen.getByRole('textbox', { name: 'Reference reflection (ungraded)' }),
      'My expected-profit prediction was not a realized outcome.',
    )
    for (const q of referenceCase.questions) {
      if (q.kind === 'numeric')
        fireEvent.change(
          screen.getByRole('spinbutton', {
            name: new RegExp(q.prompt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
          }),
          { target: { value: String(q.expected) } },
        )
      else if (q.kind === 'choice')
        await user.selectOptions(
          screen.getByRole('combobox', { name: q.prompt }),
          String(q.expected),
        )
    }
    await user.click(
      screen.getByRole('button', { name: 'Submit reference assessment' }),
    )
    expect(
      screen.getByText('Reference evidence: 100/100; eligible.'),
    ).toBeInTheDocument()
    expect(session.store.receipts[0].eligible).toBe(true)
    const lazyModule = await referenceManifest.loadView()
    expect(lazyModule.default).toBe(ReferenceView)
  })
})
describe('complete foundation bank interaction and honest availability', () => {
  it.each(['f02', 'f04'])(
    'labels %s worked poker quantities as direct connections',
    (unitId) => {
      navigate(`#learn/unit/${unitId}/worked`)
      render(<Curriculum />)
      expect(screen.getByText('Same decision mathematics')).toBeInTheDocument()
      const c = baseCases.find(
        (c) => c.unitId === unitId && c.mode === 'worked',
      )!
      expect(c.connection).toBe('direct')
    },
  )
  it.each([
    ['f01', 'calculate', -10, 'currency units'],
    ['f02', 'calculate', 46, 'unseen cards'],
    ['f03', 'calculate', 30, 'currency units'],
    ['f04', 'calculate', 400, 'currency units squared'],
    ['f06', 'calculate', 0.06, 'fraction of current wealth'],
    ['f09', 'calculate', 20, 'currency units'],
    ['f10', 'ev', 6, 'currency units'],
  ])(
    'authors %s partial rows with the quantity promised by the lesson',
    (unitId, questionId, expected, units) => {
      const c = [...registry.cases.values()].find(
        (c) => c.unitId === unitId && c.mode === 'partial',
      )!
      const q = c.questions.find((q) => q.id === questionId)!
      expect(q).toMatchObject({ kind: 'numeric', expected, units })
      expect(c.scaffold!.length).toBeGreaterThanOrEqual(3)
      expect(c.contentVersion).toBe(2)
      expect(c.rubricVersion).toBe(2)
    },
  )
  it.each([
    [-10, true],
    [35, false],
  ])(
    'shows the supplied purchase row and grades failure profit %s, not success profit',
    async (value, correct) => {
      const c = baseCases.find((c) => c.id === 'f01-partial-1')!,
        session = new LearningSession(new MemoryStorage(), fixedClock),
        user = userEvent.setup()
      const view = render(<CasePlayer caseRecord={c} session={session} />)
      expect(
        screen.queryByText(/Supplied purchase row:/),
      ).not.toBeInTheDocument()
      await user.click(
        screen.getByRole('button', { name: /Open the partial scaffold/ }),
      )
      expect(
        screen.getByText(/Supplied purchase row: pay 10/),
      ).toBeInTheDocument()
      expect(screen.getByText(/Missing failure row:/)).toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: /Open the partial scaffold/ }),
      ).toBeDisabled()
      expect(session.store.attempts[0].assistance.hintIds).toContain(
        'scaffold:open',
      )
      view.unmount()
      render(
        <CasePlayer
          caseRecord={c}
          session={new LearningSession(session.storage, fixedClock)}
        />,
      )
      expect(
        screen.getByText(/Supplied purchase row: pay 10/),
      ).toBeInTheDocument()
      await user.type(
        screen.getByRole('textbox', { name: /Prediction rationale/ }),
        'The purchase cost remains in the failure state.',
      )
      await user.click(
        screen.getByRole('button', { name: 'Commit prediction' }),
      )
      fireEvent.change(
        screen.getByRole('spinbutton', { name: /Complete the failure row/ }),
        { target: { value: String(value) } },
      )
      await user.click(
        screen.getByRole('button', { name: 'Submit structured answers' }),
      )
      const reloaded = new LearningSession(session.storage, fixedClock)
      expect(
        reloaded.store.attempts[0].evaluation?.components.find(
          (q) => q.questionId === 'calculate',
        )?.correct,
      ).toBe(correct)
      expect(reloaded.store.receipts[0].eligible).toBe(false)
      expect(reloaded.store.reviewSchedule.f01).toBeUndefined()
    },
  )
  it('searches specialist/core labs by question, role and concept with only real URLs', () => {
    navigate('#learn/lab')
    render(<Curriculum />)
    expect(
      screen.getByText('6 specialist and 8 core matches.'),
    ).toBeInTheDocument()
    fireEvent.change(screen.getByRole('searchbox', { name: /Search labs/ }), {
      target: { value: 'B05' },
    })
    expect(
      screen.getByRole('link', { name: 'The observations you never see' }),
    ).toHaveAttribute('href', '#learn/lab/selection')
    fireEvent.change(screen.getByRole('searchbox', { name: /Search labs/ }), {
      target: { value: 'irreversible' },
    })
    expect(
      screen.getByRole('link', { name: 'Price the next piece of information' }),
    ).toHaveAttribute('href', '#learn/lab/information')
    fireEvent.change(screen.getByRole('searchbox', { name: /Search labs/ }), {
      target: { value: 'Equipment' },
    })
    expect(
      screen.getByRole('link', {
        name: 'Freeze, test, and challenge a strategy',
      }),
    ).toBeInTheDocument()
  })
  it('does not recommend a review whose fresh cases are used up (audit F15)', () => {
    const at = (day: number) => () =>
      new Date(fixedClock().getTime() + day * 86_400_000)
    const submit = (
      store: LearningSession['store'],
      c: Parameters<typeof attemptFor>[0],
      day: number,
    ) => {
      const a = attemptFor(c, {
        createdAt: at(day)().toISOString(),
        committedAt: at(day)().toISOString(),
      })
      a.evaluation = evaluateCase(
        c,
        a,
        store.attempts,
        store.receipts,
        store.reviewSchedule[c.unitId],
        at(day),
        store.exposedVariants,
      )
      a.submittedAt = at(day)().toISOString()
      a.phase = 'archived'
      return recordEvidence(store, a, at(day))
    }
    // F03 demonstrated, then reviewed on every case its bank has, and due
    // again: there is nothing fresh left to review it with.
    const reviews = registry.units
      .get('f03')!
      .reviewCaseIds.map((id) => registry.cases.get(id)!)
    expect(reviews.length).toBeGreaterThan(0)
    const last = 3 + 40 * reviews.length
    const ref = { current: new LearningSession(null, at(last + 40)) }
    let store = submit(
      ref.current.store,
      registry.cases.get('f03-transfer-1')!,
      0,
    )
    for (const [i, c] of reviews.entries()) store = submit(store, c, 3 + 40 * i)
    ref.current.update(() => store)
    navigate('#learn/path')
    render(<Curriculum session={ref} />)
    expect(
      screen.queryByRole('link', { name: /^Review F03/ }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByText(/No fresh review case is left for F03/),
    ).toBeInTheDocument()
  })

  it('keeps foundation notes and prediction evidence accessible in the legacy-compatible notebook', () => {
    const ref = { current: new LearningSession(null, fixedClock) }
    navigate('#learn/notebook')
    render(<Curriculum session={ref} />)
    fireEvent.click(
      screen.getByText(/F10 Independent finance transfer — not-started/),
    )
    fireEvent.change(
      screen.getByRole('textbox', { name: /F10 notes and changed beliefs/ }),
      {
        target: {
          value:
            'My revised belief separates mean profit from an all-state cash floor.',
        },
      },
    )
    expect(ref.current.store.unitNotes.f10).toContain('all-state cash floor')
    expect(ref.current.export('markdown')).toContain('all-state cash floor')
    navigate('#learn/unit/f10/brief')
    navigate('#learn/notebook')
    fireEvent.click(
      screen.getByText(/F10 Independent finance transfer — not-started/),
    )
    expect(
      screen.getByRole('textbox', { name: /F10 notes and changed beliefs/ }),
    ).toHaveValue(
      'My revised belief separates mean profit from an all-state cash floor.',
    )
  })
  it('records retrieval skips and guided prediction drafts across route round trips without granting mastery', async () => {
    const ref = { current: new LearningSession(null, fixedClock) }
    navigate('#learn/unit/f10/brief')
    render(<Curriculum session={ref} />)
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Skip retrieval (recorded; not success)',
      }),
    )
    expect(ref.current.store.attempts[0].answers).toEqual({
      retrieval: 'skipped',
    })
    navigate('#learn/unit/f10/predict')
    fireEvent.change(
      screen.getByRole('textbox', { name: /Prediction rationale/ }),
      {
        target: {
          value: 'Funding and all-state floors change the admissible choice.',
        },
      },
    )
    fireEvent.change(
      screen.getByRole('spinbutton', { name: /Numeric estimate/ }),
      { target: { value: '30' } },
    )
    fireEvent.change(
      screen.getByRole('spinbutton', { name: /Numeric estimate/ }),
      { target: { value: '' } },
    )
    navigate('#learn/unit/f01/brief')
    navigate('#learn/unit/f10/predict')
    expect(
      screen.getByRole('textbox', { name: /Prediction rationale/ }),
    ).toHaveValue('Funding and all-state floors change the admissible choice.')
    expect(
      screen.getByRole('spinbutton', { name: /Numeric estimate/ }),
    ).toHaveValue(null)
    fireEvent.click(screen.getByRole('button', { name: 'Commit prediction' }))
    navigate('#learn/unit/f10/brief')
    expect(screen.getByRole('status')).toHaveTextContent('Retrieval skipped')
    expect(ref.current.store.receipts).toHaveLength(0)
  })
  it('loads all six production Entries, moves focus after lazy resolution and preserves root learning notes', async () => {
    const ref = { current: new LearningSession(null, fixedClock) }
    navigate('#learn/foundations')
    render(<Curriculum session={ref} />)
    for (const e of registry.experienceInventory) {
      navigate(`#learn/lab/${e.id}`)
      const heading = await screen.findByRole('heading', { level: 1 })
      expect(heading).toHaveFocus()
      expect(
        screen.queryByText('Laboratory pending integration'),
      ).not.toBeInTheDocument()
      expect(ref.current.store.receipts).toHaveLength(0)
    }
  })
  it('filters atlas by domain, pathway, level and honest availability and links real resources', () => {
    navigate('#learn/atlas')
    render(<Curriculum />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Domain' }), {
      target: { value: 'A' },
    })
    expect(
      screen.getByRole('heading', { name: /A01 Legal/ }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: /B01/ }),
    ).not.toBeInTheDocument()
    fireEvent.change(
      screen.getByRole('combobox', { name: 'Mathematical level' }),
      { target: { value: 'research' } },
    )
    fireEvent.change(screen.getByRole('combobox', { name: 'Availability' }), {
      target: { value: 'available' },
    })
    expect(
      screen.queryByRole('heading', { name: /A01 Legal/ }),
    ).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox', { name: 'Availability' }), {
      target: { value: 'planned' },
    })
    expect(
      screen.getByRole('heading', { name: /A01 Legal/ }),
    ).toBeInTheDocument()
  })
  it('has ten complete seven-step units, runnable labs and no playable future capstones', () => {
    navigate('#learn/foundations')
    render(<Curriculum />)
    expect(
      screen.getByRole('link', { name: /^F01 Information/ }),
    ).toHaveAttribute('href', '#learn/unit/f01/brief')
    expect(
      screen.queryByRole('link', { name: /F05 Updating/ }),
    ).toHaveAttribute('href', '#learn/unit/f05/brief')
    expect(
      screen.queryByRole('link', {
        name: 'Price the next piece of information',
      }),
    ).toHaveAttribute('href', '#learn/lab/information')
    navigate('#learn/unit/f01/brief')
    expect(
      screen.getByRole('navigation', { name: 'Seven lesson steps' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'Retrieve before studying' }),
    ).toBeInTheDocument()
    navigate('#learn/unit/f05/transfer')
    expect(
      screen.getByRole('combobox', { name: 'Case variant' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Submit structured answers' }),
    ).not.toBeInTheDocument()
    navigate('#learn/atlas')
    expect(
      screen.getByRole('heading', { name: '96-family concept atlas' }),
    ).toBeInTheDocument()
    navigate('#learn/pathways')
    expect(
      screen.getByRole('heading', { name: 'Four quantitative pathways' }),
    ).toBeInTheDocument()
    expect(
      screen.getAllByRole('heading', {
        name: 'Future capstone — planned, not playable',
      }),
    ).toHaveLength(4)
  })
  it('retains a committed case across navigation/reload and earns structured unaided evidence, not prose mastery', async () => {
    const c = baseCases.find((c) => c.id === 'f03-transfer-1')!,
      session = new LearningSession(new MemoryStorage(), fixedClock),
      user = userEvent.setup()
    const view = render(<CasePlayer caseRecord={c} session={session} />)
    await user.type(
      screen.getByRole('textbox', { name: /Prediction rationale/ }),
      'I expect positive profit from the supplied ledger.',
    )
    await user.click(screen.getByRole('button', { name: 'Commit prediction' }))
    view.unmount()
    render(<CasePlayer caseRecord={c} session={session} />)
    expect(
      screen.queryByRole('button', { name: 'Commit prediction' }),
    ).not.toBeInTheDocument()
    for (const q of c.questions) {
      if (q.kind === 'numeric')
        fireEvent.change(
          screen.getByRole('spinbutton', {
            name: new RegExp(q.prompt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
          }),
          { target: { value: String(q.expected) } },
        )
      else if (q.kind === 'choice') {
        const group = screen.getByRole('group', { name: q.prompt })
        const correct = q.options.find((o) => o.id === q.expected)!
        await user.click(
          within(group).getByRole('radio', { name: correct.label }),
        )
      }
    }
    await user.type(
      screen.getByRole('textbox', { name: /Written defense/ }),
      'This text is deliberately not keyword graded.',
    )
    await user.click(
      screen.getByRole('button', { name: 'Submit structured answers' }),
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      '100/100; eligible unaided evidence',
    )
    expect(
      screen.getByRole('heading', { name: 'Structured feedback' }),
    ).toHaveFocus()
    expect(session.store.receipts[0].firstDemonstration).toBe(true)
    expect(session.store.reviewSchedule.f03?.dueAt).toBe(
      '2026-10-10T12:00:00.000Z',
    )
    const reloaded = new LearningSession(session.storage, fixedClock)
    expect(reloaded.store.receipts).toEqual(session.store.receipts)
    expect(reloaded.store.attempts[0].reflection).toBe(
      'This text is deliberately not keyword graded.',
    )
  })
  it('marks hint-assisted correct answers practice-only before solution exposure', async () => {
    const c = baseCases.find((c) => c.id === 'f01-transfer-1')!,
      session = new LearningSession(new MemoryStorage(), fixedClock),
      user = userEvent.setup()
    render(<CasePlayer caseRecord={c} session={session} />)
    await user.type(
      screen.getByRole('textbox', { name: /Prediction rationale/ }),
      'I will examine the ledger.',
    )
    await user.click(screen.getByRole('button', { name: 'Commit prediction' }))
    await user.click(
      screen.getByRole('button', { name: /Show next hint for setup/ }),
    )
    for (const q of c.questions) {
      if (q.kind === 'numeric')
        fireEvent.change(screen.getByRole('spinbutton'), {
          target: { value: String(q.expected) },
        })
      else if (q.kind === 'choice')
        await user.click(
          within(screen.getByRole('group', { name: q.prompt })).getByRole(
            'radio',
            { name: q.options.find((o) => o.id === q.expected)!.label },
          ),
        )
    }
    await user.click(
      screen.getByRole('button', { name: 'Submit structured answers' }),
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      '100/100; practice only; assisted/repeated',
    )
    expect(session.store.reviewSchedule.f01).toBeUndefined()
  })
  it('roots storage-blocked work across workspace remounts and exposes conflict recovery', async () => {
    const port = new MemoryStorage()
    port.failRead = true
    port.failWrite = true
    const session = new LearningSession(port, fixedClock)
    function Harness() {
      const root = useRef<LearningSession | null>(session)
      return <Curriculum session={root} />
    }
    navigate('#learn/unit/f03/transfer')
    const view = render(<Harness />)
    fireEvent.change(
      screen.getByRole('textbox', { name: /Prediction rationale/ }),
      { target: { value: 'Work before leaving' } },
    )
    navigate('#learn/path')
    navigate('#learn/unit/f03/transfer')
    expect(
      screen.getByRole('textbox', { name: /Prediction rationale/ }),
    ).toHaveValue('Work before leaving')
    view.unmount()
    render(<Harness />)
    expect(
      screen.getByRole('textbox', { name: /Prediction rationale/ }),
    ).toHaveValue('Work before leaving')
    act(() => session.observeStorage(LEARNING_KEY, '{"other":"tab"}'))
    expect(
      screen.getByRole('button', { name: 'Review reload saved progress' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(/Another tab/)
  })
})
