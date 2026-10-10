import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PlateSeat } from './SeatPlate'
import { SixRing } from './SixRing'

const T0 = 1_000_000

const SIX: PlateSeat[] = [
  { seat: 0, username: 'alice', stack: 1980, bet: 20, status: 'playing' },
  { seat: 1, username: 'bob', stack: 2000, bet: 0, status: 'playing' },
  { seat: 2, username: 'carol', stack: 12400, bet: 60, status: 'playing' },
  { seat: 3, username: 'dmitri', stack: 1500, bet: 0, status: 'playing' },
  { seat: 4, username: 'eve', stack: 990, bet: 10, status: 'playing' },
  { seat: 5, username: 'frank', stack: 3020, bet: 0, status: 'playing' },
]

function ring(props: Partial<ComponentProps<typeof SixRing>> = {}) {
  const all: ComponentProps<typeof SixRing> = {
    players: SIX,
    you: 0,
    button: 3,
    sb: 4,
    bb: 5,
    toAct: null,
    clock: null,
    clockOffset: 0,
    ...props,
  }
  return { ...render(<SixRing {...all} />), all }
}

/** A seat's group, by the seat number people see (seat id + 1). */
const seat = (id: number) =>
  screen.getByRole('group', { name: new RegExp(`^Seat ${id + 1}:`) })

afterEach(() => {
  vi.useRealTimers()
})

describe('the six-seat ring', () => {
  it('six seats render names, stacks, bets and the active timer', () => {
    vi.useFakeTimers({ now: T0 })
    // carol to act with 15 s of decision time, then the 30 s bank.
    ring({ toAct: 2, clock: { deadline: T0 + 45_000, bankMs: 30_000 } })

    expect(screen.getAllByRole('group')).toHaveLength(6)
    expect(seat(0)).toHaveAccessibleName('Seat 1: alice (you)')
    expect(seat(1)).toHaveAccessibleName('Seat 2: bob')
    for (const p of SIX) {
      const plate = within(seat(p.seat))
      expect(plate.getByText(p.username)).toBeInTheDocument()
      expect(seat(p.seat)).toHaveTextContent(
        `${p.stack.toLocaleString('en-US')} chips`,
      )
      if (p.bet)
        expect(seat(p.seat)).toHaveTextContent(
          `Bet ${p.bet.toLocaleString('en-US')}`,
        )
      else expect(seat(p.seat)).not.toHaveTextContent('Bet')
    }
    expect(seat(2)).toHaveTextContent('12,400 chips')

    // One clock, on the seat to act, counting down into the bank.
    const timer = within(seat(2)).getByRole('timer')
    expect(screen.getAllByRole('timer')).toEqual([timer])
    expect(timer).toHaveTextContent('15s')
    expect(timer).toHaveAccessibleName('15 seconds left')
    act(() => vi.advanceTimersByTime(16_000))
    expect(timer).toHaveTextContent('bank 29s')
    expect(timer).toHaveAccessibleName('29 seconds of time bank left')
  })

  it('the viewer sits at the bottom', () => {
    const { rerender, all } = ring({ you: 3 })
    // Slot 0 is the bottom; slots go on clockwise, to the viewer's left.
    expect(seat(3)).toHaveAttribute('data-slot', '0')
    expect(seat(3)).toHaveAccessibleName('Seat 4: dmitri (you)')
    expect(seat(4)).toHaveAttribute('data-slot', '1')
    expect(seat(0)).toHaveAttribute('data-slot', '3')
    expect(seat(2)).toHaveAttribute('data-slot', '5')
    // Reading and tab order go clockwise from the viewer.
    expect(
      screen.getAllByRole('group').map((g) => g.getAttribute('data-slot')),
    ).toEqual(['0', '1', '2', '3', '4', '5'])

    // Without a seat, seat 1 (id 0) is at the bottom and nobody is "you".
    rerender(<SixRing {...all} you={null} />)
    expect(seat(0)).toHaveAttribute('data-slot', '0')
    expect(seat(0)).toHaveAccessibleName('Seat 1: alice')
    expect(seat(5)).toHaveAttribute('data-slot', '5')
  })

  it('an empty seat offers Sit here', async () => {
    const onSit = vi.fn()
    const players = SIX.filter((p) => p.seat !== 4)
    const { rerender, all } = ring({ players, you: null, onSit })

    expect(screen.getAllByRole('group')).toHaveLength(6)
    expect(seat(4)).toHaveAccessibleName('Seat 5: empty')
    const sit = within(seat(4)).getByRole('button', { name: /^Sit here/ })
    expect(screen.getAllByRole('button', { name: /^Sit here/ })).toEqual([sit])
    await userEvent.click(sit)
    expect(onSit).toHaveBeenCalledExactlyOnceWith(4)

    // A seated viewer is not offered a second seat.
    rerender(<SixRing {...all} you={0} />)
    expect(screen.queryByRole('button', { name: /^Sit here/ })).toBeNull()
    expect(seat(4)).toHaveTextContent('Empty')
  })

  it('a dead button is drawn on an empty seat and no SB when it is dead', () => {
    // Seat 4 (id 3) emptied: the button stays there and the small blind
    // is dead, so only the big blind posts.
    const players = SIX.filter((p) => p.seat !== 3)
    ring({ players, button: 3, sb: null, bb: 5 })

    expect(seat(3)).toHaveAccessibleName('Seat 4: empty')
    expect(within(seat(3)).getByText('Dealer button')).toBeInTheDocument()
    expect(screen.getAllByText('Dealer button')).toHaveLength(1)
    expect(within(seat(5)).getByText('Big blind')).toBeInTheDocument()
    expect(screen.queryByText('Small blind')).toBeNull()
    expect(screen.queryByText('SB')).toBeNull()
  })

  it('a seat sitting out says so', () => {
    const players = SIX.map((p) =>
      p.seat === 1 ? { ...p, status: 'sitting_out' as const } : p,
    )
    ring({ players })
    expect(seat(1)).toHaveTextContent('Sitting out')
    expect(seat(1)).toHaveAttribute('data-state', 'sitting-out')
    expect(screen.getAllByText('Sitting out')).toHaveLength(1)
  })
})
