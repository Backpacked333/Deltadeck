import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RematchView } from './client'
import { MatchEnd } from './MatchEnd'
import type { MatchResult } from './matchResult'

const WIN: MatchResult = {
  netBySeat: { 0: 220, 1: -220 },
  reason: 'complete',
  adjustedBySeat: { 0: 250, 1: -250 },
  outcomeBySeat: { 0: 'win', 1: 'loss' },
}

function end(rematch: RematchView | null, onRematch = vi.fn()) {
  const view = render(
    <MatchEnd
      result={WIN}
      you={0}
      bb={20}
      opponent="bob"
      rematch={rematch}
      clockOffset={0}
      onRematch={onRematch}
    />,
  )
  return { ...view, onRematch }
}

afterEach(() => {
  vi.useRealTimers()
  window.location.hash = ''
})

describe('the end of a rated match', () => {
  it('shows "+12.5 bb · Win", the rematch button, and the limit text at the cap', async () => {
    const { onRematch, rerender } = end({ state: 'open', pressed: [] })
    expect(
      screen.getByRole('heading', { name: '+12.5 bb · Win' }),
    ).toBeInTheDocument()
    expect(screen.getByText(/Chips won: \+11\.0 bb/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Rematch' }))
    expect(onRematch).toHaveBeenCalledOnce()

    rerender(
      <MatchEnd
        result={WIN}
        you={0}
        bb={20}
        opponent="bob"
        rematch={{ state: 'limit', pressed: [] }}
        clockOffset={0}
        onRematch={onRematch}
      />,
    )
    expect(
      screen.getByRole('button', { name: 'Rematch limit reached (2 per day)' }),
    ).toBeDisabled()
  })

  it('waits for the opponent after pressing, and counts down', () => {
    vi.useFakeTimers({ now: 1_000_000 })
    end({ state: 'waiting', pressed: [0], until: 1_045_000 })
    expect(
      screen.getByRole('button', { name: 'Waiting for bob…' }),
    ).toBeDisabled()
    expect(screen.getByText(/0:45/)).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(5000))
    expect(screen.getByText(/0:40/)).toBeInTheDocument()
  })

  it('says who asked for a rematch, with the button to accept', async () => {
    const { onRematch } = end({
      state: 'waiting',
      pressed: [1],
      until: Date.now() + 30_000,
    })
    expect(screen.getByText('bob wants a rematch.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Rematch' }))
    expect(onRematch).toHaveBeenCalledOnce()
  })

  it('opens the new table once the rematch starts', () => {
    const next = '44444444-4444-4444-8444-444444444444'
    end({ state: 'starting', pressed: [0, 1], next })
    expect(screen.getByText('Starting the rematch…')).toBeInTheDocument()
    expect(window.location.hash).toBe(`#play/${next}`)
  })

  it('says when there is no rematch', () => {
    end({ state: 'declined', pressed: [0] })
    expect(screen.getByText('No rematch this time.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Rematch/ })).toBeNull()
  })

  it('names who ran out of time after a forfeit', () => {
    render(
      <MatchEnd
        result={{ ...WIN, reason: 'forfeit', forfeit: 1 }}
        you={0}
        bb={20}
        opponent="bob"
        rematch={null}
        clockOffset={0}
        onRematch={vi.fn()}
      />,
    )
    expect(
      screen.getByRole('heading', { name: 'Win by forfeit' }),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'bob ran out of time three times in a row. Chips won: +11.0 bb.',
      ),
    ).toBeInTheDocument()
  })
})

describe('the rating change at the end', () => {
  it('says the rating is updating until the change arrives, then shows it and why', () => {
    const props = {
      result: WIN,
      you: 0 as const,
      bb: 20,
      opponent: 'bob',
      rematch: null,
      clockOffset: 0,
      onRematch: vi.fn(),
    }
    const { rerender } = render(<MatchEnd {...props} />)
    expect(
      screen.getByText('Updating your rating once every hand is verified…'),
    ).toBeInTheDocument()
    rerender(
      <MatchEnd
        {...props}
        rating={{
          0: {
            before: { rating: 1520, rd: 95 },
            after: { rating: 1534, rd: 92 },
            matches: 25,
          },
          1: {
            before: { rating: 1610, rd: 80 },
            after: { rating: 1597, rd: 79 },
            matches: 40,
          },
        }}
      />,
    )
    expect(
      screen.getByText(
        'Rating 1520 → 1534 (+14): beat a 1610 ± 80 player. Now 1534 ± 92.',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText(/Updating your rating/)).toBeNull()
  })

  it('shows no rating line for a void or casual result', () => {
    render(
      <MatchEnd
        result={{ netBySeat: { 0: 0, 1: 0 }, reason: 'no_show', noShow: [1] }}
        you={0}
        opponent="bob"
        rematch={null}
        clockOffset={0}
        onRematch={vi.fn()}
      />,
    )
    expect(screen.queryByText(/rating/i)).toBeNull()
  })
})
