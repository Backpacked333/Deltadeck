import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { emptyProgress } from '../../lib/storage'
import type { DecisionRecord, HandRecord } from '../../lib/storage'
import { ProgressView } from './ProgressView'

const hand = (id: string, net: number, expectedNet?: number): HandRecord => ({
  id,
  net,
  expectedNet,
  hand: 1,
  result: 'Hand finished',
  guided: false,
  decisions: [{ accuracy: 80, grade: 'Good', evLost: 2 } as DecisionRecord],
})

function show(hands: HandRecord[]) {
  render(
    <ProgressView
      progress={{ ...emptyProgress(), hands }}
      sessionId="session"
      onReplace={vi.fn()}
      onClear={vi.fn()}
      onPlay={vi.fn()}
    />,
  )
}

describe('F16 practice metric presentation', () => {
  it('F16 displays unknown rather than an invented expectation or zero gap', () => {
    show([hand('unknown', 100)])
    expect(
      screen.getByText(
        'Modeled result unknown. Actual results remain available above.',
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/Modeled result available for 0 of 1 hands/),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('img', { name: /Cumulative chips/ }),
    ).not.toBeInTheDocument()
    expect(screen.queryByText('Variance so far')).not.toBeInTheDocument()
    expect(
      screen.getByText('Actual − modeled · covered hands').parentElement,
    ).toHaveTextContent('—')
  })

  it('F16 labels equal-subset comparisons and keeps the actual total separate', () => {
    show([
      hand('covered', 30, 10),
      hand('unknown', 1000),
      { ...hand('guided', 500, 400), guided: true },
    ])
    expect(
      screen.getByText(/Modeled result available for 1 of 3 hands/),
    ).toBeInTheDocument()
    expect(
      screen.getByText('Actual result · all hands').parentElement,
    ).toHaveTextContent('+1,530')
    expect(
      screen.getByText('Actual − modeled · covered hands').parentElement,
    ).toHaveTextContent('+20')
    expect(
      screen.getByText(/Actual on covered hands: \+30 · Modeled: \+10/),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('img', {
        name: /Cumulative chips on covered hands: actual versus modeled/,
      }),
    ).toHaveAccessibleName(/Modeled ends at 10; Actual ends at 30/)
    expect(
      screen.getByText(/1 guided, 0 pending, 0 without grades/),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/Nonguided does not establish absence of hints/),
    ).toBeInTheDocument()
  })
})
