import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MotionConfig } from 'motion/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act as engineAct } from '../engine/hand'
import { seedRandom } from '../lib/random'
import type { Identity } from './api'
import { Lobby } from './Lobby'
import { LiveTable } from './LiveTable'
import {
  FakeSocket,
  finishedHand,
  firstHand,
  frame,
  MATCH,
  SIX_ROSTER,
  sixFrame,
  sixHand,
  sixInfo,
  tableInfo,
} from './testing'

const identity = (username: string): Identity => ({
  player: { userId: username, username },
  getToken: async () => `dev.${username}.t`,
  signOut: vi.fn(),
})
const alice = identity('alice')

beforeEach(() => {
  FakeSocket.all = []
  vi.stubGlobal('WebSocket', FakeSocket)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function opened() {
  await act(async () => {})
  const socket = FakeSocket.last()
  act(() => socket.open())
  return socket
}

/** The welcome to hand 1 at a rated table, as the server sends it. */
function ratedWelcome() {
  const f = frame('welcome', 1, 0, firstHand())
  if (f.t !== 'welcome' || !f.view) throw new Error('fixture')
  const rated = { ...f.table, kind: 'hu-rated' as const, handsTotal: 40 }
  return { ...f, table: rated, view: { ...f.view, match: rated } }
}

describe('LiveTable', () => {
  it('waits with a copyable invite link until the opponent arrives', async () => {
    render(<LiveTable matchId={MATCH} identity={alice} />)
    expect(screen.getByRole('status')).toHaveTextContent('Joining')
    const socket = await opened()
    act(() =>
      socket.emit({
        t: 'welcome',
        seq: 0,
        matchId: MATCH,
        seat: 0,
        serverNow: 0,
        table: tableInfo(1, 'waiting'),
        view: null,
      }),
    )
    expect(screen.getByText('Waiting for your opponent')).toBeInTheDocument()
    expect(screen.getByLabelText('Invite link')).toHaveValue(
      `${window.location.origin}/#play/${MATCH}`,
    )
  })

  it('renders the live hand from the server and sends moves', async () => {
    render(<LiveTable matchId={MATCH} identity={alice} />)
    const socket = await opened()
    const hand = firstHand()
    act(() => socket.emit(frame('welcome', 1, 0, hand)))

    const table = screen.getByRole('region', { name: 'Poker table' })
    expect(table).toHaveTextContent('Live table')
    expect(table).toHaveTextContent('vs bob')
    expect(table).not.toHaveTextContent('Atlas')
    expect(screen.getByText('Hand 1 of 20')).toBeInTheDocument()
    expect(screen.getByText('Your move')).toBeInTheDocument()
    // No lab, no read prompt, no EV, and no practice controls.
    expect(screen.queryByText(/EV/)).toBeNull()
    for (const name of [/Pause table/, 'Hand history', 'Table settings'])
      expect(screen.queryByRole('button', { name })).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: /Call 10/ }))
    expect(JSON.parse(socket.sent[0])).toMatchObject({
      t: 'act',
      handNo: 1,
      actionIndex: 0,
      action: { type: 'call' },
    })
    const reqId = JSON.parse(socket.sent[0]).reqId as string
    act(() =>
      socket.emit(
        frame('state', 2, 0, engineAct(hand, 0, { type: 'call' }), reqId),
      ),
    )
    expect(screen.getByText('bob to act')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Check/ })).toBeDisabled()
  })

  it('shows the hand result without deal buttons', async () => {
    render(<LiveTable matchId={MATCH} identity={alice} />)
    const socket = await opened()
    const folded = engineAct(firstHand(), 0, { type: 'fold' })
    act(() => socket.emit(frame('welcome', 3, 0, folded)))
    expect(screen.getByText('You fold · bob wins')).toBeInTheDocument()
    expect(screen.getByText('Next hand in a few seconds.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Deal next hand/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Review hand' })).toBeNull()
  })

  it('ends a rated match by its outcome: a forfeit while ahead reads as a loss', async () => {
    render(<LiveTable matchId={MATCH} identity={alice} />)
    const socket = await opened()
    const folded = engineAct(firstHand(), 0, { type: 'fold' })
    act(() => socket.emit(frame('welcome', 3, 0, folded)))
    act(() =>
      socket.emit({
        t: 'match_end',
        seq: 4,
        matchId: MATCH,
        result: {
          netBySeat: { 0: 560, 1: -560 },
          reason: 'forfeit',
          forfeit: 0,
          adjustedBySeat: { 0: 560, 1: -560 },
          outcomeBySeat: { 0: 'loss', 1: 'win' },
        },
      }),
    )
    expect(
      screen.getByText('Match over: you lost by forfeit.'),
    ).toBeInTheDocument()
    expect(screen.queryByText(/you won/)).toBeNull()
  })

  it('a finished rated match shows the end panel, and Rematch is sent to the table', async () => {
    render(<LiveTable matchId={MATCH} identity={alice} />)
    const socket = await opened()
    const { hand, record } = await finishedHand({ fold: true })
    const welcome = ratedWelcome()
    const folded = frame('welcome', 3, 0, hand)
    if (folded.t !== 'welcome' || !folded.view) throw new Error('fixture')
    const view = { ...folded.view, match: welcome.table }
    act(() => socket.emit({ ...folded, table: welcome.table, view }))
    act(() =>
      socket.emit({ t: 'hand_end', seq: 3, matchId: MATCH, handNo: 1, record }),
    )
    act(() =>
      socket.emit({
        t: 'match_end',
        seq: 4,
        matchId: MATCH,
        result: {
          netBySeat: { 0: 220, 1: -220 },
          reason: 'complete',
          adjustedBySeat: { 0: 250, 1: -250 },
          outcomeBySeat: { 0: 'win', 1: 'loss' },
        },
      }),
    )
    act(() =>
      socket.emit({
        t: 'rematch_state',
        seq: 5,
        matchId: MATCH,
        state: 'open',
        pressed: [],
      }),
    )
    expect(
      screen.getByRole('heading', { name: '+12.5 bb · Win' }),
    ).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Rematch' }))
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({ t: 'rematch' })
  })

  it('names a rated match in the match bar', async () => {
    render(<LiveTable matchId={MATCH} identity={alice} />)
    const socket = await opened()
    const welcome = frame('welcome', 1, 0, firstHand())
    if (welcome.t !== 'welcome' || !welcome.view) throw new Error('fixture')
    const rated = {
      ...welcome.table,
      kind: 'hu-rated' as const,
      handsTotal: 40,
    }
    const view = { ...welcome.view, match: rated }
    act(() => socket.emit({ ...welcome, table: rated, view }))
    expect(screen.getByText('Rated · Hand 1 of 40')).toBeInTheDocument()
  })

  it('a rated table renders no equity value, EV label, lab button or guess bar', async () => {
    // The same decision at a casual table shows the pot-odds ring and the
    // break-even figure, so the checks below are not vacuous.
    const casual = render(<LiveTable matchId={MATCH} identity={alice} />)
    let socket = await opened()
    act(() => socket.emit(frame('welcome', 1, 0, firstHand())))
    expect(casual.container.querySelector('.ring')).not.toBeNull()
    expect(screen.getByText(/break-even \d+%/)).toBeInTheDocument()
    casual.unmount()

    const { container } = render(<LiveTable matchId={MATCH} identity={alice} />)
    socket = await opened()
    act(() => socket.emit(ratedWelcome()))
    expect(screen.getByText('Rated · Hand 1 of 40')).toBeInTheDocument()
    expect(screen.getByText('Your move')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Call 10/ })).toBeEnabled()
    expect(container.querySelector('.ring')).toBeNull()
    expect(container.textContent).not.toMatch(/%|break-even|equity|\bEV\b/i)
    expect(screen.queryByRole('slider', { name: /equity/i })).toBeNull()
    for (const name of [
      /lab/i,
      /lock in/i,
      /skip/i,
      /Pause table/,
      'Hand history',
      'Table settings',
    ])
      expect(screen.queryByRole('button', { name })).toBeNull()
  })

  it('?seed=3&motion=off does not change a rated table', async () => {
    // What the two switches do at boot (src/env.ts, src/main.tsx): seed the
    // trainer's random source, and freeze every animation.
    const seen = async (switches: boolean) => {
      if (switches) {
        seedRandom(3)
        document.documentElement.classList.add('no-motion')
      }
      const table = <LiveTable matchId={MATCH} identity={alice} />
      const { container, unmount } = render(
        switches ? (
          <MotionConfig reducedMotion="always">{table}</MotionConfig>
        ) : (
          table
        ),
      )
      try {
        const socket = await opened()
        act(() => socket.emit(ratedWelcome()))
        return {
          text: container.textContent,
          buttons: screen
            .getAllByRole('button')
            .map(
              (b) => `${b.textContent}|${(b as HTMLButtonElement).disabled}`,
            ),
          sliders: screen
            .queryAllByRole('slider')
            .map((i) => i.getAttribute('aria-label') ?? i.id),
        }
      } finally {
        unmount()
        seedRandom(null)
        document.documentElement.classList.remove('no-motion')
      }
    }
    const plain = await seen(false)
    expect(plain.text).toContain('Rated · Hand 1 of 40')
    expect(await seen(true)).toEqual(plain)
  })

  it('flags a dropped opponent and its own reconnects, and disables moves', async () => {
    render(<LiveTable matchId={MATCH} identity={alice} />)
    const socket = await opened()
    const hand = firstHand()
    act(() => socket.emit(frame('welcome', 1, 0, hand)))
    const bar = () => screen.getAllByRole('status')[0]
    expect(bar()).not.toHaveTextContent('disconnected')

    const away = frame('state', 2, 0, hand)
    if (away.t !== 'state') throw new Error('expected state')
    away.table.players[1].connected = false
    act(() => socket.emit(away))
    expect(bar()).toHaveTextContent('vs bob · disconnected')

    vi.useFakeTimers()
    act(() => socket.drop(1006))
    expect(bar()).toHaveTextContent('Reconnecting…')
    // A move made now would go nowhere, so none can be made.
    expect(screen.getByRole('button', { name: /Call 10/ })).toBeDisabled()

    await act(async () => vi.advanceTimersByTime(10_000))
    vi.useRealTimers()
    await act(async () => {})
    const again = FakeSocket.last()
    expect(again).not.toBe(socket)
    act(() => again.open())
    act(() => again.emit(frame('welcome', 3, 0, hand)))
    expect(bar()).not.toHaveTextContent(/Reconnecting|disconnected/)
    expect(screen.getByRole('button', { name: /Call 10/ })).toBeEnabled()
  })

  it('explains when another tab took the seat', async () => {
    render(<LiveTable matchId={MATCH} identity={alice} />)
    const socket = await opened()
    act(() => socket.drop(4001))
    expect(screen.getByRole('alert')).toHaveTextContent('open in another tab')
  })
})

/** A seat of the six-seat ring, by the number people see (seat id + 1). */
const seat = (id: number) =>
  screen.getByRole('group', { name: new RegExp(`^Seat ${id + 1}:`) })
/** The action bar's moves; present only while the viewer may act. */
const moves = () =>
  screen.queryAllByRole('button', { name: /^(Fold|Check|Call|Bet|Raise)/ })
/** Any face-up or face-down card image other than an empty board slot. */
const holeCards = () =>
  screen.queryAllByRole('img', {
    name: /of (spades|hearts|diamonds|clubs)|Face-down/,
  })

describe('LiveTable at a six-casual table', () => {
  it('a six-casual table renders the ring from frames', async () => {
    render(<LiveTable matchId={MATCH} identity={alice} />)
    const socket = await opened()
    act(() => socket.emit(sixFrame('welcome', 1, 2, 2, sixHand())))

    // The six-seat ring, not the heads-up table through toHeroGame.
    const table = screen.getByRole('region', { name: 'Poker table' })
    expect(table).not.toHaveTextContent('Live table')
    expect(
      within(table).getAllByRole('group', { name: /^Seat \d:/ }),
    ).toHaveLength(6)
    expect(screen.getByText('6-max · Hand 1')).toBeInTheDocument()
    expect(screen.queryByText(/Hand \d+ of/)).toBeNull()

    // alice at the bottom, and clockwise from her.
    expect(seat(2)).toHaveAccessibleName('Seat 3: alice (you)')
    expect(seat(2)).toHaveAttribute('data-slot', '0')
    expect(seat(3)).toHaveAttribute('data-slot', '1')
    // Stacks and bets from the hand: the blinds are in.
    expect(seat(2)).toHaveTextContent('1,990 chips')
    expect(seat(2)).toHaveTextContent('Bet 10')
    expect(seat(3)).toHaveTextContent('1,480 chips')
    expect(seat(3)).toHaveTextContent('Bet 20')
    expect(seat(5)).toHaveTextContent('3,000 chips')
    expect(within(seat(0)).getByText('Dealer button')).toBeInTheDocument()
    expect(within(seat(2)).getByText('Small blind')).toBeInTheDocument()
    expect(within(seat(3)).getByText('Big blind')).toBeInTheDocument()
    // Seated, so no other seat is offered.
    expect(seat(1)).toHaveAccessibleName('Seat 2: empty')
    expect(screen.queryByRole('button', { name: /^Sit here/ })).toBeNull()
    // dave is first to act.
    expect(seat(5)).toHaveAttribute('data-active')
    expect(screen.getByText('dave to act')).toBeInTheDocument()

    // Her own cards, the pot and an empty board, and nobody else's cards.
    const mine = screen.getByRole('group', { name: 'Your cards' })
    expect(
      within(mine)
        .getAllByRole('img')
        .map((c) => c.getAttribute('aria-label')),
    ).toEqual(['A of spades', 'K of diamonds'])
    expect(holeCards()).toHaveLength(2)
    expect(within(table).getByText(/^Pot/)).toHaveTextContent('Pot 30')
    const board = screen.getByRole('group', { name: 'Community cards' })
    expect(
      within(board).getAllByRole('img', { name: 'Card not dealt yet' }),
    ).toHaveLength(5)
  })

  it('Sit here sends sit with that seat', async () => {
    render(<LiveTable matchId={MATCH} identity={identity('erin')} />)
    const socket = await opened()
    // No seat: the table summary only, never a view of the hand.
    act(() => socket.emit(sixFrame('welcome', 1, null, null, sixHand())))

    expect(screen.getAllByRole('group', { name: /^Seat \d:/ })).toHaveLength(6)
    expect(screen.getByText('6-max')).toBeInTheDocument()
    expect(screen.getByText('4 of 6 seats taken')).toBeInTheDocument()
    expect(seat(0)).toHaveAccessibleName('Seat 1: bob')
    expect(seat(0)).toHaveAttribute('data-slot', '0')
    expect(seat(3)).toHaveTextContent('1,500 chips')
    expect(screen.queryByText(/\(you\)/)).toBeNull()
    expect(screen.queryByText('Dealer button')).toBeNull()
    expect(holeCards()).toEqual([])
    expect(moves()).toEqual([])

    const offered = screen.getAllByRole('button', { name: /^Sit here/ })
    expect(
      offered.map((b) => b.closest('[role=group]')!.getAttribute('aria-label')),
    ).toEqual(['Seat 2: empty', 'Seat 5: empty'])
    await userEvent.click(
      within(seat(4)).getByRole('button', { name: /^Sit here/ }),
    )
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({ t: 'sit', seat: 4 })

    // Someone else was quicker: the table says why.
    act(() =>
      socket.emit({
        t: 'error',
        seq: 1,
        matchId: MATCH,
        code: 'seat_taken',
        message: 'That seat is taken',
      }),
    )
    expect(screen.getByRole('alert')).toHaveTextContent('That seat is taken')

    // Seated: the welcome says where, and no seat is offered any more.
    const roster = [...SIX_ROSTER, { seat: 4, username: 'erin', stack: 2000 }]
    act(() =>
      socket.emit(
        sixFrame('welcome', 2, 4, null, null, { table: sixInfo(roster) }),
      ),
    )
    expect(seat(4)).toHaveAccessibleName('Seat 5: erin (you)')
    expect(seat(4)).toHaveAttribute('data-slot', '0')
    expect(screen.queryByRole('button', { name: /^Sit here/ })).toBeNull()
  })

  it('a player seated after the deal watches the hand without cards or moves', async () => {
    render(<LiveTable matchId={MATCH} identity={identity('erin')} />)
    const socket = await opened()
    const roster = [...SIX_ROSTER, { seat: 4, username: 'erin', stack: 2000 }]
    let hand = sixHand()
    hand = engineAct(hand, 5, { type: 'call' })
    hand = engineAct(hand, 0, { type: 'call' })
    // alice is to act; erin sat down after the deal (dealt: null).
    act(() =>
      socket.emit(
        sixFrame('welcome', 1, 4, null, hand, { table: sixInfo(roster) }),
      ),
    )

    expect(screen.getByText('6-max · Hand 1')).toBeInTheDocument()
    expect(seat(4)).toHaveAccessibleName('Seat 5: erin (you)')
    expect(seat(4)).toHaveAttribute('data-slot', '0')
    expect(seat(4)).toHaveTextContent('2,000 chips')
    expect(seat(4)).not.toHaveTextContent('Bet')
    expect(within(seat(0)).getByText('Dealer button')).toBeInTheDocument()
    expect(seat(0)).toHaveTextContent('Bet 20')
    expect(seat(2)).toHaveAttribute('data-active')
    expect(screen.getByText('alice to act')).toBeInTheDocument()
    expect(screen.getByText(/dealt in from the next hand/)).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Your cards' })).toBeNull()
    expect(holeCards()).toEqual([])
    expect(moves()).toEqual([])
  })

  it("the action bar appears only on the viewer's turn", async () => {
    render(<LiveTable matchId={MATCH} identity={alice} />)
    const socket = await opened()
    // The bar's own status is mounted with it, already holding "Your move",
    // which screen readers do not reliably announce; the match bar stays
    // on the page, so it is the one that says so.
    const matchBar = () =>
      screen.getByText(/^6-max · Hand/).closest('[role=status]')!
    let hand = sixHand()
    act(() => socket.emit(sixFrame('welcome', 1, 2, 2, hand)))
    expect(screen.getByText('dave to act')).toBeInTheDocument()
    expect(moves()).toEqual([])
    expect(matchBar()).not.toHaveTextContent('Your move')

    hand = engineAct(hand, 5, { type: 'call' })
    act(() => socket.emit(sixFrame('state', 2, 2, 2, hand)))
    expect(screen.getByText('bob to act')).toBeInTheDocument()
    expect(moves()).toEqual([])
    expect(matchBar()).not.toHaveTextContent('Your move')

    // Her turn: the bar, from the server's legal moves.
    hand = engineAct(hand, 0, { type: 'call' })
    act(() => socket.emit(sixFrame('state', 3, 2, 2, hand)))
    expect(
      within(document.querySelector<HTMLElement>('.action-bar')!).getByText(
        'Your move',
      ),
    ).toBeInTheDocument()
    expect(matchBar()).toHaveTextContent('Your move')
    expect(screen.getByRole('button', { name: /^Fold/ })).toBeEnabled()
    // Half the pot after calling by default: 20 + (70 + 10) / 2.
    expect(screen.getByRole('button', { name: /^Raise to 60/ })).toBeEnabled()
    await userEvent.click(screen.getByRole('button', { name: /^Call 10/ }))
    const sent = JSON.parse(socket.sent.at(-1)!)
    expect(sent).toMatchObject({
      t: 'act',
      handNo: 1,
      actionIndex: 2,
      action: { type: 'call' },
    })
    // Sent: the bar waits for the table's answer instead of a second move.
    expect(moves()).toEqual([])
    expect(matchBar()).not.toHaveTextContent('Your move')

    hand = engineAct(hand, 2, { type: 'call' })
    act(() =>
      socket.emit(sixFrame('state', 4, 2, 2, hand, { lastReqId: sent.reqId })),
    )
    expect(screen.getByText('carol to act')).toBeInTheDocument()
    expect(moves()).toEqual([])
    expect(matchBar()).not.toHaveTextContent('Your move')
  })

  it("keys size and make the move at a six-seat table, only on the viewer's turn", async () => {
    render(<LiveTable matchId={MATCH} identity={alice} />)
    const socket = await opened()
    let hand = sixHand()
    act(() => socket.emit(sixFrame('welcome', 1, 2, 2, hand)))
    await userEvent.keyboard('cfr')
    expect(socket.sent).toEqual([])
    // The connection refuses a move out of turn anyway, so the check above
    // holds even with the keys bound. This one does not: off her turn there
    // is no listener, so no key is taken from the page.
    expect(keysTaken()).toEqual([])

    hand = engineAct(hand, 5, { type: 'call' })
    hand = engineAct(hand, 0, { type: 'call' })
    act(() => socket.emit(sixFrame('state', 2, 2, 2, hand)))
    // 3 is the pot-sized preset: 20 to match plus a pot of 70 + 10 to call.
    await userEvent.keyboard('3')
    expect(
      screen.getByRole('button', { name: /^Raise to 100/ }),
    ).toBeInTheDocument()
    await userEvent.keyboard('r')
    expect(socket.sent.map((m) => JSON.parse(m))).toMatchObject([
      { t: 'act', actionIndex: 2, action: { type: 'raise', to: 100 } },
    ])
    // Sent: the keys are let go until her next decision.
    expect(keysTaken()).toEqual([])
  })

  it('a held key or a key that composes text makes no move', async () => {
    render(<LiveTable matchId={MATCH} identity={alice} />)
    const socket = await opened()
    let hand = sixHand()
    hand = engineAct(hand, 5, { type: 'call' })
    hand = engineAct(hand, 0, { type: 'call' })
    act(() => socket.emit(sixFrame('welcome', 1, 2, 2, hand)))
    expect(moves()).not.toEqual([])

    // Auto-repeat from a key held down, and keys an input method is
    // composing into text, are not moves.
    for (const init of [{ repeat: true }, { isComposing: true }])
      for (const key of ['c', 'f', 'r', '3'])
        expect(fireEvent.keyDown(window, { key, ...init })).toBe(true)
    expect(socket.sent).toEqual([])
    expect(
      screen.getByRole('button', { name: /^Raise to 60/ }),
    ).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'c' })
    expect(socket.sent.map((m) => JSON.parse(m))).toMatchObject([
      { t: 'act', action: { type: 'call' } },
    ])
  })

  it('a viewer without a seat is asked to take one, unless every seat is taken', async () => {
    render(<LiveTable matchId={MATCH} identity={identity('erin')} />)
    const socket = await opened()
    act(() => socket.emit(sixFrame('welcome', 1, null, null, sixHand())))
    expect(screen.getByText('Pick an empty seat to play.')).toBeInTheDocument()
    expect(
      screen.getByText('Take a seat to be dealt in from the next hand.'),
    ).toBeInTheDocument()
    // Only someone already seated is dealt in from the next hand.
    expect(screen.queryByText(/You are dealt in/)).toBeNull()

    const full = [
      ...SIX_ROSTER,
      { seat: 1, username: 'frank', stack: 2000 },
      { seat: 4, username: 'gina', stack: 2000 },
    ]
    act(() =>
      socket.emit(
        sixFrame('state', 2, null, null, sixHand(), { table: sixInfo(full) }),
      ),
    )
    expect(screen.getByText('Every seat is taken.')).toBeInTheDocument()
    expect(screen.queryByText(/dealt in/)).toBeNull()
    expect(screen.queryByRole('button', { name: /^Sit here/ })).toBeNull()
  })

  it('focus lands on her own seat when Sit here goes away', async () => {
    render(<LiveTable matchId={MATCH} identity={identity('erin')} />)
    const socket = await opened()
    act(() => socket.emit(sixFrame('welcome', 1, null, null, null)))
    const sitHere = within(seat(4)).getByRole('button', { name: /^Sit here/ })
    sitHere.focus()
    await userEvent.keyboard('{Enter}')
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({ t: 'sit', seat: 4 })

    // The welcome takes every Sit here away, the focused one included.
    const roster = [...SIX_ROSTER, { seat: 4, username: 'erin', stack: 2000 }]
    act(() =>
      socket.emit(
        sixFrame('welcome', 2, 4, null, null, { table: sixInfo(roster) }),
      ),
    )
    expect(sitHere).not.toBeInTheDocument()
    expect(seat(4)).toHaveFocus()
  })

  it('focus lands on her own seat when the action bar goes away', async () => {
    render(<LiveTable matchId={MATCH} identity={alice} />)
    const socket = await opened()
    let hand = engineAct(sixHand(), 5, { type: 'call' })
    hand = engineAct(hand, 0, { type: 'call' })
    act(() => socket.emit(sixFrame('welcome', 1, 2, 2, hand)))

    // She moves from the bar by keyboard; the bar goes while it is in flight.
    screen.getByRole('button', { name: /^Call 10/ }).focus()
    await userEvent.keyboard('{Enter}')
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      t: 'act',
      action: { type: 'call' },
    })
    expect(moves()).toEqual([])
    expect(seat(2)).toHaveFocus()

    // Her plate stays, so focus stays with it as the hand goes on.
    hand = engineAct(hand, 2, { type: 'call' })
    act(() => socket.emit(sixFrame('state', 2, 2, 2, hand)))
    expect(screen.getByText('carol to act')).toBeInTheDocument()
    expect(seat(2)).toHaveFocus()
  })

  it('a seat taken from under a focused Sit here leaves focus on the table status', async () => {
    render(<LiveTable matchId={MATCH} identity={identity('erin')} />)
    const socket = await opened()
    act(() => socket.emit(sixFrame('welcome', 1, null, null, null)))
    within(seat(4))
      .getByRole('button', { name: /^Sit here/ })
      .focus()

    // frank sits there first: no seat of her own to land on.
    const roster = [...SIX_ROSTER, { seat: 4, username: 'frank', stack: 2000 }]
    act(() =>
      socket.emit(
        sixFrame('state', 2, null, null, null, { table: sixInfo(roster) }),
      ),
    )
    expect(seat(4)).toHaveAccessibleName('Seat 5: frank')
    expect(
      screen.getByText('Pick an empty seat to play.').closest('.six-wait'),
    ).toHaveFocus()
  })

  it('each winner is named with their own hand when a side pot splits the chips', async () => {
    render(<LiveTable matchId={MATCH} identity={alice} />)
    const socket = await opened()
    // carol is all in for 100 with a flush and takes the main pot; alice's
    // two pair beats dave's eights for the side pot.
    let hand = sixHand({
      stacks: { 3: 100 },
      holes: { 0: '7d 2h', 2: 'As 9d', 3: 'Kc 2c', 5: '8d 8s' },
      board: 'Ac 7c 9h Tc 3s',
    })
    hand = engineAct(hand, 5, { type: 'call' })
    hand = engineAct(hand, 0, { type: 'fold' })
    hand = engineAct(hand, 2, { type: 'raise', to: 2000 })
    hand = engineAct(hand, 3, { type: 'call' })
    hand = engineAct(hand, 5, { type: 'call' })
    act(() => socket.emit(sixFrame('welcome', 1, 2, 2, hand)))

    expect(
      screen.getByText('You win · Two pair; carol wins · Flush'),
    ).toBeInTheDocument()
  })
})

/**
 * The move keys the page takes: a key is taken when a listener calls
 * preventDefault on it, which the six-seat table's does only while bound.
 */
const keysTaken = () =>
  ['c', 'f', 'r', 'b', '1', '2', '3', '4'].filter(
    (key) => !fireEvent.keyDown(window, { key }),
  )

describe('Lobby', () => {
  it('opens a table by link and goes to it', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ matchId: MATCH }, { status: 201 }),
    )
    render(<Lobby identity={alice} fetcher={fetcher} />)
    await userEvent.click(
      screen.getByRole('button', { name: 'Play a friend by link' }),
    )
    expect(window.location.hash).toBe(`#play/${MATCH}`)
    expect(fetcher).toHaveBeenCalledWith('/api/matches', {
      method: 'POST',
      headers: { Authorization: 'Bearer dev.alice.t' },
    })
  })

  it('shows why a table could not be opened', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 500 }))
    render(<Lobby identity={alice} fetcher={fetcher} />)
    await userEvent.click(
      screen.getByRole('button', { name: 'Play a friend by link' }),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not create a table',
    )
  })
})
