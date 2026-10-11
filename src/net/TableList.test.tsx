// The six-table list and Quick sit on the lobby page, and the retry that
// follows the player from the lobby to a table and back (PR-25; ADR,
// clarifications from PR-25). The whole online area is rendered, so the
// navigation, the lobby socket's reopening and the table page's sit are
// the app's own.
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLOSE_ELSEWHERE, CLOSE_GONE, CLOSE_REPLACED } from '../shared/protocol'
import type {
  ErrorCode,
  MatchInfo,
  ServerMsg,
  TableRow,
} from '../shared/protocol'
import { SIT_ANSWER_MS } from './LiveTable'
import { TABLES_EVERY_MS } from './TableList'
import { FakeSocket, sixInfo } from './testing'

const T1 = '0b7c4a52-6f0e-4d7b-9b55-3c1f2a9e8d01'
const T2 = '1c8d5b63-7a1f-4e8c-8c66-4d2a3b0f9e12'
const T3 = '2d9e6c74-8b2a-4f9d-9d77-5e3b4c1a0f23'
const T4 = '3e0f7d85-9c3b-4a0e-8e88-6f4c5d2b1a34'
const M = '33333333-3333-4333-8333-333333333333'

const sent = (s: FakeSocket) => s.sent.map((m) => JSON.parse(m))
const lobbyFrame = (msg: object) => ({ seq: 1, ...msg }) as never
/**
 * Lets a navigation land: jsdom fires hashchange a task later, and runs a
 * history traversal (Back) several tasks deep.
 */
const settle = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0))
  })

/** Every role=alert put on the page from now on, the node or within it. */
function alertsAdded() {
  const added: string[] = []
  const observer = new MutationObserver((records) => {
    for (const r of records)
      for (const node of r.addedNodes)
        if (node instanceof HTMLElement)
          for (const el of [node, ...node.querySelectorAll('*')])
            if (el.getAttribute('role') === 'alert')
              added.push(el.textContent ?? '')
  })
  observer.observe(document.body, { childList: true, subtree: true })
  return { added, stop: () => observer.disconnect() }
}

const lobbies = () => FakeSocket.all.filter((s) => s.url.endsWith('/ws/lobby'))
const lobby = () => lobbies().at(-1)!
const tables = (id: string) =>
  FakeSocket.all.filter((s) => s.url.endsWith(`/ws/table/${id}`))
const tableAt = (id: string) => tables(id).at(-1)!

const row = (
  tableId: string,
  seated: number,
  avgPot: number | null = 40,
  playersPerHour = 3,
): TableRow => ({ tableId, seated, maxSeats: 6, avgPot, playersPerHour })

/** Two others at the table; alice at `seat`, if she has one. */
function six(
  id: string,
  seat: number | null,
  {
    seq = 1,
    status = 'playing',
  }: { seq?: number; status?: MatchInfo['status'] } = {},
): ServerMsg {
  const others = [
    { seat: 0, username: 'bob', stack: 2000 },
    { seat: 3, username: 'carol', stack: 1500 },
  ]
  const roster =
    seat === null
      ? others
      : [...others, { seat, username: 'alice', stack: 2000 }].sort(
          (a, b) => a.seat - b.seat,
        )
  return {
    t: 'welcome',
    seq,
    matchId: id,
    serverNow: 0,
    table: sixInfo(roster, status),
    view: null,
    seat,
  } as ServerMsg
}

const refusal = (id: string, code: ErrorCode, message: string) =>
  ({ t: 'error', seq: 1, matchId: id, code, message }) as ServerMsg

const card = () =>
  screen.getByRole('heading', { name: '6-max tables' }).closest('article')!
const quickSit = () => within(card()).getByRole('button', { name: 'Quick sit' })
const line = () => within(card()).getByRole('status')
const sitHere = () => screen.queryAllByRole('button', { name: /^Sit here/ })

async function app(hash = '#lobby') {
  const { default: LiveApp } = await import('./LiveApp')
  window.location.hash = hash
  render(<LiveApp />)
  await act(async () => {})
}

/** The lobby page, its socket open and asked for the list. */
async function inLobby() {
  await app()
  act(() => lobby().open())
}

/** Sent to `id` by the lobby: the page there, its socket open, seatless. */
async function sentTo(id: string) {
  act(() => lobby().emit(lobbyFrame({ t: 'sit_at', tableId: id })))
  await settle()
  expect(window.location.hash).toBe(`#play/${id}`)
  const socket = tableAt(id)
  act(() => socket.open())
  act(() => socket.emit(six(id, null)))
  expect(sent(socket)).toEqual([{ t: 'sit' }])
  return socket
}

/** Back on the lobby page after a refusal: its new socket open. */
async function bounced() {
  await settle()
  expect(window.location.hash).toBe('#lobby')
  act(() => lobby().open())
}

beforeEach(() => {
  FakeSocket.all = []
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ activeMatch: null })),
  )
  sessionStorage.setItem('qp.devToken', 'dev.alice.t')
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  sessionStorage.removeItem('qp.devToken')
  window.location.hash = ''
})

describe('the six-table list', () => {
  it('lists tables with seats taken of 6 and Quick sit navigates to the table the lobby chose', async () => {
    await inLobby()
    expect(sent(lobby())).toEqual([{ t: 'tables' }])
    act(() =>
      lobby().emit(
        lobbyFrame({
          t: 'tables',
          tables: [row(T1, 4, 130, 9), row(T2, 6, null, 100)],
        }),
      ),
    )
    const list = screen.getByRole('table', { name: 'Six-max tables' })
    expect(
      within(list)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Seats', 'Average pot', 'Players in the last hour'])
    expect(
      within(list)
        .getAllByRole('row')
        .slice(1)
        .map((r) =>
          within(r)
            .getAllByRole('cell')
            .map((c) => c.textContent),
        ),
    ).toEqual([
      ['4 of 6', '6.5 bb', '9'],
      ['6 of 6, full', '–', '100+'],
    ])

    await userEvent.click(quickSit())
    expect(sent(lobby()).at(-1)).toEqual({ t: 'quick_sit' })
    expect(line()).toHaveTextContent('Finding you a seat…')
    const before = window.history.length
    act(() => lobby().emit(lobbyFrame({ t: 'sit_at', tableId: T1 })))
    await settle()
    expect(window.location.hash).toBe(`#play/${T1}`)
    expect(window.history.length).toBe(before + 1)
    const socket = tableAt(T1)
    act(() => socket.open())
    act(() => socket.emit(six(T1, null)))
    // The bare sit is in flight: no Sit here to press beside it.
    expect(sitHere()).toEqual([])
    expect(screen.getByText('Taking a seat…')).toBeVisible()
    expect(sent(socket)).toEqual([{ t: 'sit' }])
    act(() => socket.emit(six(T1, 1, { seq: 2 })))
    expect(
      screen.getByRole('group', { name: 'Seat 2: alice (you)' }),
    ).toHaveFocus()
    expect(lobbies()).toHaveLength(1)
  })

  it('asks for the list as the lobby opens, every 15 s while the tab is visible, again after a reconnect, and never once the page has gone', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    await inLobby()
    const asks = () =>
      lobbies()
        .flatMap((s) => sent(s))
        .filter((m) => m.t === 'tables').length
    expect(asks()).toBe(1)
    act(() => vi.advanceTimersByTime(TABLES_EVERY_MS - 1))
    expect(asks()).toBe(1)
    act(() => vi.advanceTimersByTime(1))
    expect(asks()).toBe(2)
    // A tab in the background asks nothing, and asks once it is back.
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    act(() => vi.advanceTimersByTime(TABLES_EVERY_MS))
    expect(asks()).toBe(2)
    hidden.mockReturnValue(false)
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(asks()).toBe(3)
    hidden.mockRestore()
    // A reconnect asks again on open.
    act(() => lobby().drop(1006))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 600))
    })
    act(() => lobby().open())
    expect(sent(lobby())).toEqual([{ t: 'tables' }])
    // Gone to a table: no more asks.
    const total = asks()
    act(() => {
      window.location.hash = `#play/${T1}`
    })
    await settle()
    act(() => vi.advanceTimersByTime(2 * TABLES_EVERY_MS))
    expect(asks()).toBe(total)
  })

  it('says when no six table is running, and shows the first 10 tables with how many more', async () => {
    await inLobby()
    act(() => lobby().emit(lobbyFrame({ t: 'tables', tables: [] })))
    expect(
      within(card()).getByText(
        'No tables are running right now. Quick sit opens one.',
      ),
    ).toBeVisible()
    expect(screen.queryByRole('table')).toBeNull()
    const twelve = Array.from({ length: 12 }, (_, i) =>
      row(`${T1.slice(0, -2)}${String(i).padStart(2, '0')}`, 3),
    )
    act(() => lobby().emit(lobbyFrame({ t: 'tables', tables: twelve })))
    const list = screen.getByRole('table', { name: 'Six-max tables' })
    expect(within(list).getAllByRole('row')).toHaveLength(1 + 10)
    expect(within(card()).getByText('And 2 more.')).toBeVisible()
  })
})

describe('quick-sit across pages', () => {
  it('a table that filled up sends the quick-sit back to the lobby, which asks again naming it, and the next table seats us without a new history entry', async () => {
    await inLobby()
    await userEvent.click(quickSit())
    const length = window.history.length + 1
    const first = await sentTo(T1)
    act(() => first.emit(refusal(T1, 'table_full', 'Every seat is taken')))
    await bounced()
    expect(window.history.length).toBe(length)
    expect(first.closedWith).toBe(1000)
    expect(screen.getByRole('heading', { name: '6-max tables' })).toHaveFocus()
    expect(sent(lobby())).toEqual([
      { t: 'quick_sit', tried: [T1] },
      { t: 'tables' },
    ])
    expect(line()).toHaveTextContent(
      'That table filled up. Finding you another…',
    )
    const next = await sentTo(T2)
    expect(window.history.length).toBe(length)
    act(() => next.emit(six(T2, 4, { seq: 2 })))
    expect(
      screen.getByRole('group', { name: 'Seat 5: alice (you)' }),
    ).toBeVisible()
    expect(lobbies()).toHaveLength(2)
  })

  it.each([
    {
      case: 'sit_cooldown',
      refuse: (s: FakeSocket) =>
        s.emit(refusal(T1, 'sit_cooldown', 'You stood up here a moment ago')),
      says: 'You stood up at that table a moment ago. Finding you another…',
    },
    {
      case: 'illegal (a table halted since the list)',
      refuse: (s: FakeSocket) =>
        s.emit(refusal(T1, 'illegal', 'There is no seat to take here')),
      says: 'That table has closed. Finding you another…',
    },
    {
      case: '4404 after the sit',
      refuse: (s: FakeSocket) => s.drop(CLOSE_GONE, 'closed'),
      says: 'That table has closed. Finding you another…',
    },
  ])('moves on from a table that answers $case', async ({ refuse, says }) => {
    await inLobby()
    await userEvent.click(quickSit())
    const socket = await sentTo(T1)
    act(() => refuse(socket))
    await bounced()
    expect(sent(lobby())[0]).toEqual({ t: 'quick_sit', tried: [T1] })
    expect(line()).toHaveTextContent(says)
  })

  it.each([
    {
      case: 'a welcome saying it has finished',
      arrive: (s: FakeSocket) => {
        s.open()
        s.emit(six(T1, null, { status: 'finished' }))
      },
    },
    {
      case: 'a 4404 before any welcome',
      arrive: (s: FakeSocket) => s.drop(CLOSE_GONE, 'closed'),
    },
  ])(
    'moves on, sending nothing, from a table that is gone: $case',
    async ({ arrive }) => {
      await inLobby()
      await userEvent.click(quickSit())
      act(() => lobby().emit(lobbyFrame({ t: 'sit_at', tableId: T1 })))
      await settle()
      const socket = tableAt(T1)
      act(() => arrive(socket))
      expect(sent(socket)).toEqual([])
      await bounced()
      expect(sent(lobby())[0]).toEqual({ t: 'quick_sit', tried: [T1] })
      expect(line()).toHaveTextContent(
        'That table has closed. Finding you another…',
      )
    },
  )

  it('a whole quick-sit asks the lobby at most four times, then stays at the last table', async () => {
    await inLobby()
    await userEvent.click(quickSit())
    for (const id of [T1, T2, T3]) {
      const socket = await sentTo(id)
      act(() => socket.emit(refusal(id, 'table_full', 'Every seat is taken')))
      await bounced()
    }
    const last = await sentTo(T4)
    act(() => last.emit(refusal(T4, 'table_full', 'Every seat is taken')))
    await settle()
    expect(
      lobbies().map((s) => sent(s).filter((m) => m.t === 'quick_sit')),
    ).toEqual([
      [{ t: 'quick_sit' }],
      [{ t: 'quick_sit', tried: [T1] }],
      [{ t: 'quick_sit', tried: [T1, T2] }],
      [{ t: 'quick_sit', tried: [T1, T2, T3] }],
    ])
    expect(window.location.hash).toBe(`#play/${T4}`)
    expect(screen.getByRole('alert')).toHaveTextContent('Every seat is taken')
    expect(sitHere().length).toBeGreaterThan(0)
  })

  it.each([
    {
      code: 'tables_full',
      message: 'Could not check your table just now. Try again in a moment.',
    },
    {
      code: 'rate_limited',
      message: 'Too many quick sits. Try again in a moment.',
    },
  ])(
    'stops when the lobby says $code, says why, and gives focus back to Quick sit',
    async ({ code, message }) => {
      await inLobby()
      await userEvent.click(quickSit())
      const socket = await sentTo(T1)
      act(() => socket.emit(refusal(T1, 'table_full', 'Every seat is taken')))
      await bounced()
      act(() => lobby().emit(lobbyFrame({ t: 'error', code, message })))
      expect(within(card()).getByRole('alert')).toHaveTextContent(message)
      expect(quickSit()).toBeEnabled()
      expect(quickSit()).toHaveFocus()
      expect(line()).toHaveTextContent('')
      expect(window.location.hash).toBe('#lobby')
      expect(tables(T1)).toHaveLength(1)
    },
  )

  it('goes to the table a 4409 close names, replacing the history entry', async () => {
    await inLobby()
    await userEvent.click(quickSit())
    const socket = await sentTo(T1)
    const length = window.history.length
    act(() => socket.drop(CLOSE_ELSEWHERE, M))
    await settle()
    expect(window.location.hash).toBe(`#play/${M}`)
    expect(window.history.length).toBe(length)
    const mine = tableAt(M)
    act(() => mine.open())
    act(() => mine.emit(six(M, 1)))
    expect(sent(mine)).toEqual([])
  })

  it('the lobby sending us back to our table resumes it without sitting again', async () => {
    await inLobby()
    await userEvent.click(quickSit())
    act(() =>
      lobby().emit(lobbyFrame({ t: 'matched', matchId: M, resumed: true })),
    )
    await settle()
    expect(window.location.hash).toBe(`#play/${M}`)
    const mine = tableAt(M)
    act(() => mine.open())
    act(() => mine.emit(six(M, null)))
    act(() => mine.emit(six(M, 1, { seq: 2 })))
    expect(sent(mine)).toEqual([])
  })

  it('a quick-sit is taken on arrival, so a later visit or a reload asks and sits nothing', async () => {
    await inLobby()
    await userEvent.click(quickSit())
    const socket = await sentTo(T1)
    act(() => socket.emit(refusal(T1, 'table_full', 'Every seat is taken')))
    await bounced()
    act(() =>
      lobby().emit(
        lobbyFrame({
          t: 'error',
          code: 'tables_full',
          message: 'Every table is full.',
        }),
      ),
    )
    act(() => {
      window.location.hash = '#ladder'
    })
    await settle()
    act(() => {
      window.location.hash = '#lobby'
    })
    await settle()
    act(() => lobby().open())
    expect(sent(lobby())).toEqual([{ t: 'tables' }])
    // A link to (or a reload of) a table: a seat to pick, nothing sent.
    act(() => {
      window.location.hash = `#play/${T2}`
    })
    await settle()
    const table = tableAt(T2)
    act(() => table.open())
    act(() => table.emit(six(T2, null)))
    expect(sent(table)).toEqual([])
    expect(sitHere().length).toBeGreaterThan(0)
  })

  it('a sit the table never answers is given up after 10 s: one resync, no move, Sit here back', async () => {
    await inLobby()
    await userEvent.click(quickSit())
    act(() => lobby().emit(lobbyFrame({ t: 'sit_at', tableId: T1 })))
    await settle()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const socket = tableAt(T1)
    act(() => socket.open())
    act(() => socket.emit(six(T1, null)))
    expect(sent(socket)).toEqual([{ t: 'sit' }])
    act(() => vi.advanceTimersByTime(SIT_ANSWER_MS - 1))
    expect(sent(socket)).toEqual([{ t: 'sit' }])
    act(() => vi.advanceTimersByTime(1))
    expect(sent(socket)).toEqual([{ t: 'sit' }, { t: 'resync' }])
    act(() => socket.emit(six(T1, null, { seq: 2 })))
    expect(sitHere().length).toBeGreaterThan(0)
    vi.useRealTimers()
    // Done: a close much later sends nobody anywhere.
    act(() => socket.drop(CLOSE_GONE, 'closed'))
    await settle()
    expect(window.location.hash).toBe(`#play/${T1}`)
    expect(lobbies()).toHaveLength(1)
  })

  it('a sit lost to a dropped table socket is not sent again', async () => {
    await inLobby()
    await userEvent.click(quickSit())
    const socket = await sentTo(T1)
    act(() => socket.drop(1006))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 600))
    })
    const again = tableAt(T1)
    expect(again).not.toBe(socket)
    act(() => again.open())
    act(() => again.emit(six(T1, null)))
    expect(sent(again)).toEqual([])
    expect(sitHere().length).toBeGreaterThan(0)
    expect(window.location.hash).toBe(`#play/${T1}`)
  })

  it('once a quick-sit has ended, a refused Sit here at that table stays at the table', async () => {
    await inLobby()
    await userEvent.click(quickSit())
    const socket = await sentTo(T1)
    act(() => socket.emit(six(T1, 1, { seq: 2 })))
    // Stood up by the table: a seat to pick again.
    act(() => socket.emit(six(T1, null, { seq: 3 })))
    await userEvent.click(
      screen.getByRole('button', { name: 'Sit here (seat 2)' }),
    )
    expect(sent(socket).at(-1)).toEqual({ t: 'sit', seat: 1 })
    act(() => socket.emit(refusal(T1, 'table_full', 'Every seat is taken')))
    await settle()
    expect(window.location.hash).toBe(`#play/${T1}`)
    expect(screen.getByRole('alert')).toHaveTextContent('Every seat is taken')
    expect(lobbies()).toHaveLength(1)
  })
})

describe('quick-sit and the history (review)', () => {
  it('Back on the lobby page while it asks again leaves it, and ends the quick-sit', async () => {
    window.location.hash = '#ladder'
    await settle()
    await inLobby()
    await userEvent.click(quickSit())
    const first = await sentTo(T1)
    act(() => first.emit(refusal(T1, 'table_full', 'Every seat is taken')))
    await bounced()
    const asking = lobby()
    act(() => window.history.back())
    await settle()
    expect(window.location.hash).toBe('#ladder')
    expect(asking.closedWith).toBe(1000)
    act(() => asking.emit(lobbyFrame({ t: 'sit_at', tableId: T2 })))
    await settle()
    expect(window.location.hash).toBe('#ladder')
    expect(tables(T2)).toEqual([])
  })

  it('after a refusal and a retry the lobby refuses, one Back leaves the lobby page', async () => {
    window.location.hash = '#ladder'
    await settle()
    await inLobby()
    await userEvent.click(quickSit())
    const first = await sentTo(T1)
    act(() => first.emit(refusal(T1, 'table_full', 'Every seat is taken')))
    await bounced()
    act(() =>
      lobby().emit(
        lobbyFrame({ t: 'error', code: 'tables_full', message: 'Full.' }),
      ),
    )
    act(() => window.history.back())
    await settle()
    expect(window.location.hash).toBe('#ladder')
  })

  it('Back from the table a retry found returns to the lobby', async () => {
    window.location.hash = '#ladder'
    await settle()
    await inLobby()
    await userEvent.click(quickSit())
    const first = await sentTo(T1)
    act(() => first.emit(refusal(T1, 'table_full', 'Every seat is taken')))
    await bounced()
    const next = await sentTo(T2)
    act(() => next.emit(six(T2, 4, { seq: 2 })))
    act(() => window.history.back())
    await settle()
    expect(window.location.hash).toBe('#lobby')
    act(() => window.history.back())
    await settle()
    expect(window.location.hash).toBe('#ladder')
  })

  it('a quick-sit the player left in the same moment as a refusal is not taken by a later lobby visit', async () => {
    await inLobby()
    await userEvent.click(quickSit())
    const first = await sentTo(T1)
    act(() => {
      first.emit(refusal(T1, 'table_full', 'Every seat is taken'))
      window.location.hash = '#ladder'
    })
    await settle()
    expect(window.location.hash).toBe('#ladder')
    act(() => {
      window.location.hash = '#lobby'
    })
    await settle()
    act(() => lobby().open())
    expect(sent(lobby())).toEqual([{ t: 'tables' }])
  })
})

describe('a Back pressed as a table refuses (review)', () => {
  it('two Backs at once leave no quick-sit for a later lobby visit', async () => {
    // A browser that applies the player's Back and the refusal's together
    // lands two entries back, past the lobby page (jsdom lands both on
    // one entry, so the refusal's is made to go two). What the quick-sit
    // carried is dropped there.
    window.location.hash = '#ladder'
    await settle()
    await inLobby()
    await userEvent.click(quickSit())
    const first = await sentTo(T1)
    const back = vi
      .spyOn(window.history, 'back')
      .mockImplementation(() => window.history.go(-2))
    act(() => first.emit(refusal(T1, 'table_full', 'Every seat is taken')))
    await settle()
    back.mockRestore()
    expect(window.location.hash).toBe('#ladder')
    act(() => {
      window.location.hash = '#lobby'
    })
    await settle()
    act(() => lobby().open())
    expect(sent(lobby())).toEqual([{ t: 'tables' }])
  })
})

describe('the hand-off says one thing (review)', () => {
  it.each([
    {
      case: 'table_full',
      refuse: (s: FakeSocket) =>
        s.emit(refusal(T1, 'table_full', 'Every seat is taken')),
    },
    {
      case: 'a 4404',
      refuse: (s: FakeSocket) => s.drop(CLOSE_GONE, 'closed'),
    },
  ])(
    'a table refusing a quick-sit puts up no alert of its own on the way back: $case',
    async ({ refuse }) => {
      await inLobby()
      await userEvent.click(quickSit())
      const socket = await sentTo(T1)
      const alerts = alertsAdded()
      act(() => refuse(socket))
      await bounced()
      alerts.stop()
      expect(alerts.added).toEqual([])
    },
  )

  it('a refusal at the fourth table still says why, and a closed fourth table offers the lobby, not a heads-up search', async () => {
    await inLobby()
    await userEvent.click(quickSit())
    for (const id of [T1, T2, T3]) {
      const socket = await sentTo(id)
      act(() => socket.emit(refusal(id, 'table_full', 'Every seat is taken')))
      await bounced()
    }
    act(() => lobby().emit(lobbyFrame({ t: 'sit_at', tableId: T4 })))
    await settle()
    act(() => tableAt(T4).drop(CLOSE_GONE, 'closed'))
    await settle()
    expect(window.location.hash).toBe(`#play/${T4}`)
    expect(screen.queryByRole('link', { name: 'Find a match' })).toBeNull()
    expect(
      screen.getByRole('link', { name: 'Back to the lobby' }),
    ).toHaveAttribute('href', '#lobby')
  })
})

describe('the lobby away (review)', () => {
  it('a lobby that cannot be reached says so in the 6-max card', async () => {
    await inLobby()
    act(() => lobby().emit(lobbyFrame({ t: 'presence', online: 2, queued: 0 })))
    await userEvent.click(quickSit())
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    for (let i = 0; i < 9; i++) {
      act(() => lobby().drop(1006))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(9000)
      })
    }
    expect(line()).toHaveTextContent(
      'Could not reach the lobby. Reload to try again.',
    )
    expect(quickSit()).toBeDisabled()
  })

  it('a refusal stays put through a reconnect, not announced again', async () => {
    await inLobby()
    await userEvent.click(quickSit())
    act(() =>
      lobby().emit(
        lobbyFrame({ t: 'error', code: 'tables_full', message: 'Full.' }),
      ),
    )
    const said = within(card()).getByRole('alert')
    act(() => lobby().drop(1006))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 600))
    })
    act(() => lobby().open())
    expect(within(card()).getByRole('alert')).toBe(said)
  })

  it('the lobby closing a flood says nothing in the 6-max card', async () => {
    await inLobby()
    act(() => lobby().drop(4429, 'Too many messages'))
    expect(within(card()).queryByRole('alert')).toBeNull()
  })
})

describe('the 6-max card', () => {
  it('one search at a time: Quick sit and the Find buttons wait for each other', async () => {
    await inLobby()
    await userEvent.click(quickSit())
    expect(screen.getByRole('button', { name: 'Find a match' })).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Find a rated match' }),
    ).toBeDisabled()
    act(() =>
      lobby().emit(
        lobbyFrame({
          t: 'error',
          code: 'tables_full',
          message: 'Every table is full.',
        }),
      ),
    )
    await userEvent.click(screen.getByRole('button', { name: 'Find a match' }))
    expect(quickSit()).toBeDisabled()
    expect(sent(lobby()).filter((m) => m.t === 'quick_sit')).toHaveLength(1)
  })

  it('Quick sit is off when the lobby is open in another tab, and the card says so', async () => {
    await inLobby()
    expect(line()).toHaveTextContent('')
    await userEvent.click(quickSit())
    act(() => lobby().drop(CLOSE_REPLACED, 'replaced'))
    expect(line()).toHaveTextContent(
      'The lobby is open in another tab. Reload this page to sit from here.',
    )
    expect(quickSit()).toBeDisabled()
  })
})

// Each pins a behaviour the mutation review found no test for: the
// review's mutant is named in the test's comment.
describe('pinned by mutation (review)', () => {
  it('Quick sit waits for the lobby, while it asks and once it is away', async () => {
    // TL14, TL15.
    await app()
    expect(quickSit()).toBeDisabled()
    act(() => lobby().open())
    expect(quickSit()).toBeEnabled()
    await userEvent.click(quickSit())
    expect(quickSit()).toBeDisabled()
    act(() =>
      lobby().emit(
        lobbyFrame({ t: 'error', code: 'tables_full', message: 'Full.' }),
      ),
    )
    expect(quickSit()).toBeEnabled()
    act(() => lobby().drop(CLOSE_REPLACED, 'replaced'))
    expect(quickSit()).toBeDisabled()
  })

  it('the list is asked once per tick after a reconnect, not once per socket so far', async () => {
    // TL4, TL5: the interval and the visibility listener go with the socket.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    await inLobby()
    act(() => lobby().drop(1006))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 600))
    })
    act(() => lobby().open())
    const asks = () => sent(lobby()).filter((m) => m.t === 'tables').length
    expect(asks()).toBe(1)
    act(() => vi.advanceTimersByTime(TABLES_EVERY_MS))
    expect(asks()).toBe(2)
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(asks()).toBe(3)
  })

  it('a fresh Quick sit after a stopped retry starts over', async () => {
    // LO5: it names no table tried, and says so.
    await inLobby()
    await userEvent.click(quickSit())
    const first = await sentTo(T1)
    act(() => first.emit(refusal(T1, 'table_full', 'Every seat is taken')))
    await bounced()
    act(() =>
      lobby().emit(
        lobbyFrame({ t: 'error', code: 'tables_full', message: 'Full.' }),
      ),
    )
    await userEvent.click(quickSit())
    expect(sent(lobby()).at(-1)).toEqual({ t: 'quick_sit' })
    expect(line()).toHaveTextContent('Finding you a seat…')
    const next = await sentTo(T2)
    act(() => next.emit(refusal(T2, 'table_full', 'Every seat is taken')))
    await bounced()
    expect(sent(lobby())[0]).toEqual({ t: 'quick_sit', tried: [T2] })
  })

  it('arriving already seated sends nothing, then or later', async () => {
    // LT6.
    await inLobby()
    await userEvent.click(quickSit())
    act(() => lobby().emit(lobbyFrame({ t: 'sit_at', tableId: T1 })))
    await settle()
    const socket = tableAt(T1)
    act(() => socket.open())
    act(() => socket.emit(six(T1, 1)))
    act(() => socket.emit(six(T1, null, { seq: 2 })))
    expect(sent(socket)).toEqual([])
    expect(sitHere().length).toBeGreaterThan(0)
    expect(screen.queryByText('Taking a seat…')).toBeNull()
  })

  it('the table page takes the quick-sit, so coming back to it later sits nobody', async () => {
    // LT22.
    await inLobby()
    await userEvent.click(quickSit())
    const socket = await sentTo(T1)
    act(() => socket.emit(six(T1, 1, { seq: 2 })))
    act(() => {
      window.location.hash = '#ladder'
    })
    await settle()
    act(() => {
      window.location.hash = `#play/${T1}`
    })
    await settle()
    const again = tableAt(T1)
    expect(again).not.toBe(socket)
    act(() => again.open())
    act(() => again.emit(six(T1, null)))
    expect(sent(again)).toEqual([])
    expect(sitHere().length).toBeGreaterThan(0)
  })

  it('a lobby refusal brings focus back to Quick sit from nowhere, not from elsewhere', async () => {
    // TL21, TL22.
    await inLobby()
    await userEvent.click(quickSit())
    const temporary = document.createElement('button')
    document.body.append(temporary)
    temporary.focus()
    temporary.remove()
    expect(document.activeElement).toBe(document.body)
    act(() =>
      lobby().emit(
        lobbyFrame({ t: 'error', code: 'tables_full', message: 'Full.' }),
      ),
    )
    expect(quickSit()).toHaveFocus()

    await userEvent.click(quickSit())
    const signOut = screen.getByRole('button', { name: 'Sign out' })
    signOut.focus()
    act(() =>
      lobby().emit(
        lobbyFrame({ t: 'error', code: 'tables_full', message: 'Full.' }),
      ),
    )
    expect(signOut).toHaveFocus()
  })

  it('a sit that ends leaves focus where the player put it', async () => {
    // ST4.
    await inLobby()
    await userEvent.click(quickSit())
    const socket = await sentTo(T1)
    const outside = document.createElement('button')
    document.body.append(outside)
    outside.focus()
    act(() => socket.emit(six(T1, 1, { seq: 2 })))
    expect(outside).toHaveFocus()
    outside.remove()
  })

  it('a sit that ends with focus nowhere and no seat puts it on the table status', async () => {
    // ST5.
    await inLobby()
    await userEvent.click(quickSit())
    const lost = await sentTo(T1)
    ;(document.activeElement as HTMLElement | null)?.blur()
    act(() => lost.drop(1006))
    expect(document.querySelector('.six-wait')).toHaveFocus()
  })

  it('the table moves focus only when a quick-sit ends, not on a welcome or a seat change', async () => {
    // ST6, ST7.
    await app(`#play/${T2}`)
    act(() => tableAt(T2).open())
    act(() => tableAt(T2).emit(six(T2, null)))
    expect(document.activeElement).toBe(document.body)
    act(() => tableAt(T2).emit(six(T2, 1, { seq: 2 })))
    expect(document.activeElement).toBe(document.body)
    act(() => tableAt(T2).emit(six(T2, null, { seq: 3 })))
    expect(document.activeElement).toBe(document.body)
  })

  it('while the sit is on its way the table says only that', async () => {
    // ST3.
    await inLobby()
    await userEvent.click(quickSit())
    await sentTo(T1)
    expect(screen.getByText('Taking a seat…')).toBeVisible()
    expect(
      screen.queryByText('Take a seat to be dealt in from the next hand.'),
    ).toBeNull()
  })

  it('ten tables are all shown, with no count of more', async () => {
    // TL8.
    await inLobby()
    const ten = Array.from({ length: 10 }, (_, i) =>
      row(`${T1.slice(0, -2)}${String(i).padStart(2, '0')}`, 3),
    )
    act(() => lobby().emit(lobbyFrame({ t: 'tables', tables: ten })))
    expect(
      within(
        screen.getByRole('table', { name: 'Six-max tables' }),
      ).getAllByRole('row'),
    ).toHaveLength(1 + 10)
    expect(within(card()).queryByText(/more\.$/)).toBeNull()
  })

  it('leaving the table page with the sit unanswered leaves no timer behind', async () => {
    // LT25.
    await inLobby()
    await userEvent.click(quickSit())
    act(() => lobby().emit(lobbyFrame({ t: 'sit_at', tableId: T1 })))
    await settle()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const socket = tableAt(T1)
    act(() => socket.open())
    act(() => socket.emit(six(T1, null)))
    act(() => {
      window.location.hash = '#ladder'
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    expect(() => act(() => vi.advanceTimersByTime(SIT_ANSWER_MS))).not.toThrow()
    expect(sent(socket)).toEqual([{ t: 'sit' }])
  })
})
