import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MotionConfig } from 'motion/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act as engineAct, legalActions } from '../engine/hand'
import type { HandState, SeatId } from '../engine/types'
import type { HandRecordV1, MatchInfo } from '../shared/protocol'
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
  // A six table remembers, per tab, the hand a player stood from.
  sessionStorage.clear()
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

  it('Rebuy appears to a seated player below 100 bb once out of the hand, and sends a bare rebuy', async () => {
    render(<LiveTable matchId={MATCH} identity={alice} />)
    const socket = await opened()
    // Dealt into the hand being played: no rebuy, short as she is.
    const short = withStack(SIX_ROSTER, 2, 1200)
    act(() =>
      socket.emit(
        sixFrame('welcome', 1, 2, 2, sixHand({ stacks: { 2: 1200 } }), {
          table: sixInfo(short),
        }),
      ),
    )
    expect(screen.getByText('dave to act')).toBeInTheDocument()
    expect(rebuyButton()).toBeNull()

    // The hand is over and the roster says what it left her: 1,990.
    const ended = foldedToCarol()
    act(() =>
      socket.emit(
        sixFrame('state', 2, 2, 2, ended, { table: sixInfo(AFTER_FOLDS) }),
      ),
    )
    const button = rebuyButton()!
    expect(button).toHaveAccessibleName('Rebuy to 2,000 chips')
    // By keyboard, as every control at the table.
    button.focus()
    await userEvent.keyboard('{Enter}')
    // The type alone: the server computes the amount.
    expect(socket.sent.map((m) => JSON.parse(m))).toEqual([{ t: 'rebuy' }])

    // Topped up: the table's answer takes the button away, her plate
    // shows the new stack, and focus stays at the table on her seat.
    const topped = withStack(AFTER_FOLDS, 2, 2000)
    act(() =>
      socket.emit(
        sixFrame('welcome', 3, 2, 2, ended, { table: sixInfo(topped) }),
      ),
    )
    expect(rebuyButton()).toBeNull()
    expect(seat(2)).toHaveTextContent('2,000 chips')
    expect(seat(2)).toHaveFocus()

    // At exactly 100 bb, or above it, there is nothing to top up.
    act(() =>
      socket.emit(
        sixFrame('state', 4, 2, 2, ended, {
          table: sixInfo(withStack(AFTER_FOLDS, 2, 2400)),
        }),
      ),
    )
    expect(rebuyButton()).toBeNull()
  })

  it('a player who busts hears that she must rebuy: the seat controls announce it', async () => {
    render(<LiveTable matchId={MATCH} identity={alice} />)
    const socket = await opened()
    // alice posts her last 10 chips as the small blind; dave and bob fold
    // and carol's queens take them at the showdown.
    let hand = sixHand({ stacks: { 2: 10 } })
    const short = withStack(SIX_ROSTER, 2, 10)
    act(() =>
      socket.emit(
        sixFrame('welcome', 1, 2, 2, hand, { table: sixInfo(short) }),
      ),
    )
    // The live region is in the page before the news, so it is announced.
    const status = seatStatus()
    expect(status).toHaveTextContent(/^$/)
    for (const s of [5, 0]) hand = engineAct(hand, s, { type: 'fold' })
    expect(hand.street).toBe('showdown')
    const busted = withStack(withStack(SIX_ROSTER, 2, 0), 3, 1510)
    act(() =>
      socket.emit(sixFrame('state', 2, 2, 2, hand, { table: sixInfo(busted) })),
    )
    expect(screen.getByText(/^carol wins/)).toBeInTheDocument()
    expect(status).toHaveTextContent('No chips left: rebuy to be dealt in.')
    // Said once, next to the Rebuy button it explains.
    expect(
      screen.getAllByText('No chips left: rebuy to be dealt in.'),
    ).toHaveLength(1)
    expect(rebuyButton()).toBeInTheDocument()

    // Topped up: the line empties, and she is dealt in from the next hand.
    act(() =>
      socket.emit(
        sixFrame('welcome', 3, 2, 2, hand, {
          table: sixInfo(withStack(busted, 2, 2000)),
        }),
      ),
    )
    expect(status).toHaveTextContent(/^$/)
  })

  it('a busted player watching a hand may rebuy; a viewer without a seat has no seat controls', async () => {
    render(<LiveTable matchId={MATCH} identity={identity('erin')} />)
    const socket = await opened()
    // erin is seated at seat 4 with no chips, so the hand was dealt
    // without her: she may rebuy while it is played.
    const busted = [...SIX_ROSTER, { seat: 4, username: 'erin', stack: 0 }]
    act(() =>
      socket.emit(
        sixFrame('welcome', 1, 4, null, sixHand(), { table: sixInfo(busted) }),
      ),
    )
    expect(rebuyButton()).toBeInTheDocument()
    expect(standButton()).toBeInTheDocument()
    // Without chips she is not dealt in from the next hand unless she does.
    expect(screen.queryByText(/dealt in from the next hand/)).toBeNull()
    expect(
      screen.getByText('No chips left: rebuy to be dealt in.'),
    ).toBeInTheDocument()
    await userEvent.click(rebuyButton()!)
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({ t: 'rebuy' })
    // Topped up, she is dealt in from the next hand like anyone seated.
    const topped = withStack(busted, 4, 2000)
    act(() =>
      socket.emit(
        sixFrame('welcome', 2, 4, null, sixHand(), { table: sixInfo(topped) }),
      ),
    )
    expect(rebuyButton()).toBeNull()
    expect(
      screen.getByText('You are dealt in from the next hand.'),
    ).toBeInTheDocument()

    // A viewer without a seat: neither control.
    act(() => socket.emit(sixFrame('welcome', 3, null, null, sixHand())))
    expect(screen.queryByRole('group', { name: 'Your seat' })).toBeNull()
    expect(rebuyButton()).toBeNull()
    expect(standButton()).toBeNull()
  })

  it('Stand up sends a bare stand; dealt into the hand, she reads Leaving after this hand', async () => {
    render(<LiveTable matchId={MATCH} identity={alice} />)
    const socket = await opened()
    const hand = sixHand()
    act(() => socket.emit(sixFrame('welcome', 1, 2, 2, hand)))
    const controls = screen.getByRole('group', { name: 'Your seat' })
    const status = within(controls).getByRole('status')
    expect(status).toHaveTextContent('')
    standButton()!.focus()
    await userEvent.keyboard('{Enter}')
    expect(socket.sent.map((m) => JSON.parse(m))).toEqual([{ t: 'stand' }])
    // The wire has no marker of a pending stand: she knows she sent one.
    // The live region was already there, so the change is announced.
    expect(status).toHaveTextContent('Leaving after this hand')
    expect(standButton()).toBeNull()
    expect(seat(2)).toHaveFocus()

    // The table answers that she keeps the seat until the hand ends.
    act(() => socket.emit(sixFrame('welcome', 2, 2, 2, hand)))
    expect(status).toHaveTextContent('Leaving after this hand')
    expect(standButton()).toBeNull()

    // The hand ends and the seat frees: a viewer without a seat again.
    const left = SIX_ROSTER.filter((p) => p.seat !== 2)
    act(() =>
      socket.emit(
        sixFrame('welcome', 3, null, null, null, { table: sixInfo(left) }),
      ),
    )
    expect(screen.queryByText('Leaving after this hand')).toBeNull()
    expect(screen.queryByRole('group', { name: 'Your seat' })).toBeNull()
    expect(
      within(seat(2)).getByRole('button', { name: /^Sit here/ }),
    ).toBeInTheDocument()

    // Back in the seat later and dealt into a new hand: she stays.
    const next = { ...sixHand(), config: { ...hand.config, handNo: 7 } }
    act(() => socket.emit(sixFrame('welcome', 4, 2, 2, next)))
    expect(screen.getByText('6-max · Hand 7')).toBeInTheDocument()
    expect(screen.queryByText('Leaving after this hand')).toBeNull()
    expect(standButton()).toBeInTheDocument()
  })

  it('Stand up on her own turn takes the moves and keys away at once', async () => {
    render(<LiveTable matchId={MATCH} identity={alice} />)
    const socket = await opened()
    // dave and bob call: the small blind, alice, is to act.
    let hand = sixHand()
    hand = engineAct(hand, 5, { type: 'call' })
    hand = engineAct(hand, 0, { type: 'call' })
    act(() => socket.emit(sixFrame('welcome', 1, 2, 2, hand)))
    expect(moves().length).toBeGreaterThan(0)
    standButton()!.focus()
    await userEvent.keyboard('{Enter}')
    // Before the table answers with her fold, nothing offers or takes a
    // move: the server refuses one from a player who stood.
    expect(moves()).toEqual([])
    expect(keysTaken()).toEqual([])
    expect(socket.sent.map((m) => JSON.parse(m))).toEqual([{ t: 'stand' }])
  })

  it('a reload during the hand she stood from still says Leaving after this hand', async () => {
    const first = render(<LiveTable matchId={MATCH} identity={alice} />)
    const socket = await opened()
    const hand = sixHand()
    act(() => socket.emit(sixFrame('welcome', 1, 2, 2, hand)))
    await userEvent.click(standButton()!)
    expect(seatStatus()).toHaveTextContent('Leaving after this hand')

    // The page reloads mid-hand. Nothing on the wire says she stood (ADR,
    // clarifications from PR-12); this tab remembers.
    first.unmount()
    const reloaded = render(<LiveTable matchId={MATCH} identity={alice} />)
    const fresh = await opened()
    act(() => fresh.emit(sixFrame('welcome', 1, 2, 2, hand)))
    expect(seatStatus()).toHaveTextContent('Leaving after this hand')
    expect(standButton()).toBeNull()

    // Not another account's: bob, dealt into the same hand in this tab.
    reloaded.unmount()
    render(<LiveTable matchId={MATCH} identity={identity('bob')} />)
    const bobs = await opened()
    act(() => bobs.emit(sixFrame('welcome', 1, 0, 0, hand)))
    expect(seatStatus()).toHaveTextContent(/^$/)
    expect(standButton()).toBeInTheDocument()

    // Nor a later hand's.
    const next = { ...hand, config: { ...hand.config, handNo: 2 } }
    act(() => bobs.emit(sixFrame('welcome', 2, 2, 2, next)))
    expect(seatStatus()).toHaveTextContent(/^$/)
    expect(standButton()).toBeInTheDocument()
  })

  it('Stand up between hands frees the seat at once, with no leaving caption', async () => {
    render(<LiveTable matchId={MATCH} identity={alice} />)
    const socket = await opened()
    act(() =>
      socket.emit(
        sixFrame('welcome', 1, 2, 2, foldedToCarol(), {
          table: sixInfo(AFTER_FOLDS),
        }),
      ),
    )
    await userEvent.click(standButton()!)
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({ t: 'stand' })
    expect(screen.queryByText('Leaving after this hand')).toBeNull()
  })

  it('a double press on Rebuy or Stand up sends one frame until the table answers', async () => {
    render(<LiveTable matchId={MATCH} identity={alice} />)
    const socket = await opened()
    const ended = foldedToCarol()
    act(() =>
      socket.emit(
        sixFrame('welcome', 1, 2, 2, ended, { table: sixInfo(AFTER_FOLDS) }),
      ),
    )
    const sent = () => socket.sent.map((m) => JSON.parse(m))
    // The second press of a double press would be refused (not_below) and
    // flash "You already have 100 big blinds" just after the top-up.
    const rebuy = rebuyButton()!
    fireEvent.click(rebuy)
    fireEvent.click(rebuy)
    expect(sent()).toEqual([{ t: 'rebuy' }])
    expect(rebuyButton()).toBeNull()

    // The socket drops before the answer, which may never have gone out:
    // back, with the roster still short, Rebuy is offered again.
    vi.useFakeTimers()
    act(() => socket.drop(1006))
    await act(async () => vi.advanceTimersByTime(10_000))
    vi.useRealTimers()
    await act(async () => {})
    const again = FakeSocket.last()
    act(() => again.open())
    act(() =>
      again.emit(
        sixFrame('welcome', 2, 2, 2, ended, { table: sixInfo(AFTER_FOLDS) }),
      ),
    )
    expect(rebuyButton()).toBeInTheDocument()
    const retry = rebuyButton()!
    fireEvent.click(retry)
    fireEvent.click(retry)
    expect(again.sent.map((m) => JSON.parse(m))).toEqual([{ t: 'rebuy' }])
    // Topped up: nothing more to rebuy.
    const topped = withStack(AFTER_FOLDS, 2, 2000)
    act(() =>
      again.emit(
        sixFrame('welcome', 3, 2, 2, ended, { table: sixInfo(topped) }),
      ),
    )
    expect(rebuyButton()).toBeNull()

    // Between hands a stand frees the seat at once: one frame, whose
    // welcome takes the seat away; a second would earn not_seated.
    const stand = standButton()!
    fireEvent.click(stand)
    fireEvent.click(stand)
    expect(again.sent.map((m) => JSON.parse(m))).toEqual([
      { t: 'rebuy' },
      { t: 'stand' },
    ])
    expect(standButton()).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()

    // Answered: no seat. A table that deals nothing keeps the finished
    // hand, so sitting down again in the same seat, with the same 2,000,
    // comes back to the same hand and stack: a new seat, offered Stand up.
    const gone = topped.filter((p) => p.seat !== 2)
    act(() =>
      again.emit(
        sixFrame('welcome', 4, null, null, null, { table: sixInfo(gone) }),
      ),
    )
    expect(screen.queryByRole('group', { name: 'Your seat' })).toBeNull()
    act(() =>
      again.emit(
        sixFrame('welcome', 5, 2, null, ended, { table: sixInfo(topped) }),
      ),
    )
    expect(standButton()).toBeInTheDocument()
  })

  it('no seat control shows while the socket reconnects or once the table has closed', async () => {
    render(<LiveTable matchId={MATCH} identity={alice} />)
    const socket = await opened()
    // Between hands, short of 100 bb: both controls, nothing to say.
    act(() =>
      socket.emit(
        sixFrame('welcome', 1, 2, 2, foldedToCarol(), {
          table: sixInfo(AFTER_FOLDS),
        }),
      ),
    )
    expect(rebuyButton()).toBeInTheDocument()
    expect(standButton()).toBeInTheDocument()

    // The socket drops: a press would send nothing, so neither shows.
    vi.useFakeTimers()
    act(() => socket.drop(1006))
    expect(screen.getByText('Reconnecting…')).toBeInTheDocument()
    expect(seatStatus()).toHaveTextContent(/^$/)
    expect(rebuyButton()).toBeNull()
    expect(standButton()).toBeNull()

    // Back, at a table that has closed meanwhile: still neither.
    await act(async () => vi.advanceTimersByTime(10_000))
    vi.useRealTimers()
    await act(async () => {})
    const again = FakeSocket.last()
    expect(again).not.toBe(socket)
    act(() => again.open())
    act(() =>
      again.emit(
        sixFrame('welcome', 2, 2, 2, foldedToCarol(), {
          table: sixInfo(AFTER_FOLDS, 'finished'),
        }),
      ),
    )
    expect(screen.getByText('This table has closed.')).toBeInTheDocument()
    expect(seatStatus()).toHaveTextContent(/^$/)
    expect(rebuyButton()).toBeNull()
    expect(standButton()).toBeNull()
  })

  it("the hand's end takes the seat controls from a player who stood, before the table frees her seat", async () => {
    render(<LiveTable matchId={MATCH} identity={alice} />)
    const socket = await opened()
    act(() => socket.emit(sixFrame('welcome', 1, 2, 2, sixHand())))
    await userEvent.click(standButton()!)
    expect(seatStatus()).toHaveTextContent('Leaving after this hand')

    // The hand ends. Its last state comes before the welcome that frees
    // her seat (she still sees the hand she was dealt into), and its
    // roster has already dropped her: there is nothing left to stand up
    // from or leave after, and no stack to top up.
    const left = AFTER_FOLDS.filter((p) => p.seat !== 2)
    act(() =>
      socket.emit(
        sixFrame('state', 2, 2, 2, foldedToCarol(), { table: sixInfo(left) }),
      ),
    )
    expect(screen.getByText('carol wins')).toBeInTheDocument()
    expect(seatStatus()).toHaveTextContent(/^$/)
    expect(standButton()).toBeNull()
    expect(rebuyButton()).toBeNull()
  })

  it('between hands the plates show the stacks the roster carries', async () => {
    render(<LiveTable matchId={MATCH} identity={alice} />)
    const socket = await opened()
    // Hand 1 is over; carol stood up as it ended and frank took seat 3.
    // The finished hand still says what seat 3 held (1,510): that was
    // carol's, and frank brings his own 2,000.
    const roster = AFTER_FOLDS.map((p) =>
      p.seat === 3 ? { seat: 3, username: 'frank', stack: 2000 } : p,
    )
    act(() =>
      socket.emit(
        sixFrame('welcome', 1, 2, 2, foldedToCarol(), {
          table: sixInfo(roster),
        }),
      ),
    )
    expect(seat(3)).toHaveAccessibleName('Seat 4: frank')
    expect(seat(3)).toHaveTextContent('2,000 chips')
    expect(seat(2)).toHaveTextContent('1,990 chips')
    expect(seat(5)).toHaveTextContent('3,000 chips')
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

  it('names a side-pot winner who lost chips on the hand', async () => {
    render(<LiveTable matchId={MATCH} identity={alice} />)
    const socket = await opened()
    // carol (1,500, all in) takes the 4,500 main pot with a flush. alice's
    // two pair beats dave's eights for the 200 side pot: she wins a pot yet
    // ends 1,400 down, and must still be named with her hand.
    let hand = sixHand({
      stacks: { 5: 1600 },
      holes: { 0: '7d 2h', 2: 'As 9d', 3: 'Kc 2c', 5: '8d 8s' },
      board: 'Ac 7c 9h Tc 3s',
    })
    hand = engineAct(hand, 5, { type: 'raise', to: 1600 })
    hand = engineAct(hand, 0, { type: 'fold' })
    hand = engineAct(hand, 2, { type: 'call' })
    hand = engineAct(hand, 3, { type: 'call' })
    expect(hand.result!.netBySeat[2]).toBe(-1400)
    act(() => socket.emit(sixFrame('welcome', 1, 2, 2, hand)))

    expect(
      screen.getByText('You win · Two pair; carol wins · Flush'),
    ).toBeInTheDocument()
  })

  it('a table waiting for players promises no next hand', async () => {
    render(<LiveTable matchId={MATCH} identity={alice} />)
    const socket = await opened()
    const done = playedOut(sixHand())
    act(() =>
      socket.emit(
        sixFrame('welcome', 1, 2, 2, done, {
          table: sixInfo(SIX_ROSTER, 'waiting'),
        }),
      ),
    )
    expect(screen.queryByText('Next hand in a few seconds.')).toBeNull()
    expect(
      screen.getByText('Waiting for players to deal the next hand.'),
    ).toBeInTheDocument()
  })

  it('Sit out shows to a seated player who is playing, during a hand too, and sends a bare sit_out', async () => {
    render(<LiveTable matchId={MATCH} identity={alice} />)
    const socket = await opened()
    // Dealt into the hand being played: she may sit out from the next one.
    const hand = sixHand()
    act(() => socket.emit(sixFrame('welcome', 1, 2, 2, hand)))
    const status = seatStatus()
    expect(status).toHaveTextContent(/^$/)
    expect(sitInButton()).toBeNull()
    sitOutButton()!.focus()
    await userEvent.keyboard('{Enter}')
    expect(socket.sent.map((m) => JSON.parse(m))).toEqual([{ t: 'sit_out' }])

    // The table's answer: sitting out, from the next hand. She still plays
    // this one, so her plate shows her in it, and the live line says when.
    const out = outIn(sixInfo(), [2])
    act(() => socket.emit(sixFrame('welcome', 2, 2, 2, hand, { table: out })))
    expect(status).toHaveTextContent('Sitting out from the next hand.')
    expect(sitOutButton()).toBeNull()
    expect(sitInButton()).toBeInTheDocument()
    expect(within(seat(2)).queryByText('Sitting out')).toBeNull()
    expect(seat(2)).toHaveFocus()

    // The hand is over: her plate says so, and the line says how back in.
    const ended = foldedToCarol()
    act(() =>
      socket.emit(
        sixFrame('state', 3, 2, 2, ended, {
          table: outIn(sixInfo(AFTER_FOLDS), [2]),
        }),
      ),
    )
    expect(within(seat(2)).getByText('Sitting out')).toBeInTheDocument()
    expect(status).toHaveTextContent('Sitting out: sit in to be dealt in.')
    expect(sitInButton()).toBeInTheDocument()
  })

  it('Sit in sends a bare sit_in, and the seat controls announce she is back from the next hand', async () => {
    render(<LiveTable matchId={MATCH} identity={identity('erin')} />)
    const socket = await opened()
    // erin sits out at seat 4 while a hand she is not in is played.
    const roster = [
      ...SIX_ROSTER,
      { seat: 4 as SeatId, username: 'erin', stack: 1500 },
    ]
    const out = outIn(sixInfo(roster), [4])
    act(() =>
      socket.emit(sixFrame('welcome', 1, 4, null, sixHand(), { table: out })),
    )
    const status = seatStatus()
    expect(status).toHaveTextContent('Sitting out: sit in to be dealt in.')
    expect(within(seat(4)).getByText('Sitting out')).toBeInTheDocument()
    expect(screen.queryByText(/dealt in from the next hand/)).toBeNull()
    expect(sitOutButton()).toBeNull()
    // Below 100 bb: she may top up as well, without sitting in.
    expect(rebuyButton()).toBeInTheDocument()
    sitInButton()!.focus()
    await userEvent.keyboard('{Enter}')
    expect(socket.sent.map((m) => JSON.parse(m))).toEqual([{ t: 'sit_in' }])

    // Back: the line says so until the next hand deals her in.
    act(() =>
      socket.emit(
        sixFrame('welcome', 2, 4, null, sixHand(), { table: sixInfo(roster) }),
      ),
    )
    expect(status).toHaveTextContent('Back in from the next hand.')
    expect(
      screen.getByText('You are dealt in from the next hand.'),
    ).toBeInTheDocument()
    expect(within(seat(4)).queryByText('Sitting out')).toBeNull()
    expect(sitInButton()).toBeNull()
    expect(sitOutButton()).toBeInTheDocument()
    expect(seat(4)).toHaveFocus()
    const next = { ...sixHand(), config: { ...sixHand().config, handNo: 2 } }
    act(() =>
      socket.emit(
        sixFrame('state', 3, 4, null, next, { table: sixInfo(roster) }),
      ),
    )
    expect(status).toHaveTextContent(/^$/)
  })

  it('a busted player sitting out is offered Rebuy, not Sit in', async () => {
    render(<LiveTable matchId={MATCH} identity={identity('erin')} />)
    const socket = await opened()
    const busted = [
      ...SIX_ROSTER,
      { seat: 4 as SeatId, username: 'erin', stack: 0 },
    ]
    act(() =>
      socket.emit(
        sixFrame('welcome', 1, 4, null, sixHand(), {
          table: outIn(sixInfo(busted), [4]),
        }),
      ),
    )
    expect(rebuyButton()).toBeInTheDocument()
    expect(sitInButton()).toBeNull()
    expect(sitOutButton()).toBeNull()
    expect(seatStatus()).toHaveTextContent(
      'No chips left: rebuy to be dealt in.',
    )
  })

  it('a double press on Sit out or Sit in sends one frame until the table answers', async () => {
    render(<LiveTable matchId={MATCH} identity={alice} />)
    const socket = await opened()
    const ended = foldedToCarol()
    const sent = () => socket.sent.map((m) => JSON.parse(m))
    act(() =>
      socket.emit(
        sixFrame('welcome', 1, 2, 2, ended, { table: sixInfo(AFTER_FOLDS) }),
      ),
    )
    const out = sitOutButton()!
    fireEvent.click(out)
    fireEvent.click(out)
    expect(sent()).toEqual([{ t: 'sit_out' }])
    expect(sitOutButton()).toBeNull()
    expect(sitInButton()).toBeNull()
    act(() =>
      socket.emit(
        sixFrame('welcome', 2, 2, 2, ended, {
          table: outIn(sixInfo(AFTER_FOLDS), [2]),
        }),
      ),
    )
    const back = sitInButton()!
    fireEvent.click(back)
    fireEvent.click(back)
    expect(sent()).toEqual([{ t: 'sit_out' }, { t: 'sit_in' }])
    expect(sitInButton()).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    // Neither shows while the socket is down: a press would send nothing.
    act(() => socket.drop(1006))
    expect(sitOutButton()).toBeNull()
    expect(sitInButton()).toBeNull()
  })

  it('a player stood up after sitting out is told why her seat is gone', async () => {
    render(<LiveTable matchId={MATCH} identity={alice} />)
    const socket = await opened()
    const ended = foldedToCarol()
    act(() =>
      socket.emit(
        sixFrame('welcome', 1, 2, 2, ended, {
          table: outIn(sixInfo(AFTER_FOLDS), [2]),
        }),
      ),
    )
    // The table stands her up: its roster drops her, then its welcome
    // says she has no seat.
    const left = sixInfo(AFTER_FOLDS.filter((p) => p.seat !== 2))
    act(() => {
      socket.emit(sixFrame('state', 2, 2, 2, ended, { table: left }))
      socket.emit(sixFrame('welcome', 3, null, null, null, { table: left }))
    })
    expect(
      screen.getByText('You were stood up after sitting out.'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Your seat' })).toBeNull()
    // Sitting down again ends it.
    act(() =>
      socket.emit(
        sixFrame('welcome', 4, 2, null, null, { table: sixInfo(AFTER_FOLDS) }),
      ),
    )
    expect(
      screen.queryByText('You were stood up after sitting out.'),
    ).toBeNull()

    // A player sitting out who stands up herself is not told so.
    act(() =>
      socket.emit(
        sixFrame('welcome', 5, 2, 2, ended, {
          table: outIn(sixInfo(AFTER_FOLDS), [2]),
        }),
      ),
    )
    await userEvent.click(standButton()!)
    act(() =>
      socket.emit(sixFrame('welcome', 6, null, null, null, { table: left })),
    )
    expect(
      screen.queryByText('You were stood up after sitting out.'),
    ).toBeNull()
    expect(screen.getByText('Pick an empty seat to play.')).toBeInTheDocument()
  })

  it('a player who stood keeps their seat on the ring while the hand result shows', async () => {
    render(<LiveTable matchId={MATCH} identity={alice} />)
    const socket = await opened()
    // carol stood during hand 1: the server unseats her as it ends, while
    // the finished hand stays on the table until the next deal.
    const done = playedOut(sixHand())
    const without = SIX_ROSTER.filter((p) => p.seat !== 3)
    act(() => {
      socket.emit({
        t: 'hand_end',
        seq: 1,
        matchId: MATCH,
        handNo: 1,
        record: {
          seats: SIX_ROSTER.map((p) => ({ ...p, userId: p.username })),
        } as unknown as HandRecordV1,
      })
      socket.emit(
        sixFrame('welcome', 2, 2, 2, done, { table: sixInfo(without) }),
      )
    })
    expect(seat(3)).toHaveAccessibleName('Seat 4: carol')
    expect(within(seat(3)).getByText('Left the table')).toBeInTheDocument()

    // Someone sat in her seat: the ring shows them, not her.
    const erin = [
      ...without,
      { seat: 3 as const, username: 'erin', stack: 2000 },
    ]
    act(() =>
      socket.emit(sixFrame('state', 3, 2, 2, done, { table: sixInfo(erin) })),
    )
    expect(seat(3)).toHaveAccessibleName('Seat 4: erin')
    expect(within(seat(3)).queryByText('Left the table')).toBeNull()

    // The table waits for players: no hand is coming, so the seat is free.
    act(() =>
      socket.emit(
        sixFrame('state', 4, 2, 2, done, {
          table: sixInfo(without, 'waiting'),
        }),
      ),
    )
    expect(seat(3)).toHaveAccessibleName('Seat 4: empty')
  })
})

/** Every remaining player checks or calls the hand down to showdown. */
function playedOut(start: HandState) {
  let hand = start
  while (hand.toAct !== null) {
    const legal = legalActions(hand)
    hand = engineAct(
      hand,
      hand.toAct,
      legal.canCheck ? { type: 'check' } : { type: 'call' },
    )
  }
  return hand
}

/** The Rebuy and Stand up controls, when the table offers them. */
const rebuyButton = () => screen.queryByRole('button', { name: /^Rebuy/ })
const standButton = () => screen.queryByRole('button', { name: 'Stand up' })
/** The Sit out and Sit in controls (PR-16), when the table offers them. */
const sitOutButton = () => screen.queryByRole('button', { name: 'Sit out' })
const sitInButton = () => screen.queryByRole('button', { name: 'Sit in' })
/** `table` with the players in `seats` sitting out. */
const outIn = (table: MatchInfo, seats: SeatId[]): MatchInfo => ({
  ...table,
  players: table.players.map((p) =>
    seats.includes(p.seat) ? { ...p, status: 'sitting_out' as const } : p,
  ),
})
/** The live line under the viewer's own seat controls. */
const seatStatus = () =>
  within(screen.getByRole('group', { name: 'Your seat' })).getByRole('status')

/** `roster` with `seat`'s stack replaced. */
const withStack = (roster: typeof SIX_ROSTER, at: number, stack: number) =>
  roster.map((p) => (p.seat === at ? { ...p, stack } : p))

/** Hand 1 over: dave, bob and alice fold to carol's big blind. */
function foldedToCarol() {
  let hand = sixHand()
  for (const s of [5, 0, 2]) hand = engineAct(hand, s, { type: 'fold' })
  return hand
}
/** The roster after foldedToCarol: alice lost her small blind to carol. */
const AFTER_FOLDS = withStack(withStack(SIX_ROSTER, 2, 1990), 3, 1510)

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
