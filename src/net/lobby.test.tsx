import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLOSE_GONE, CLOSE_RATE_LIMITED } from '../shared/protocol'
import type { Identity } from './api'
import { Lobby } from './Lobby'
import { LobbyConnection, readGames } from './lobbyClient'
import { LiveTable } from './LiveTable'
import {
  FakeSocket,
  gameId,
  gameRow,
  gamesFrame,
  joinStatusFrame,
  MATCH,
  tableInfo,
} from './testing'

const flush = () => new Promise((r) => setTimeout(r, 0))
// What the page sent, less the open games' poll (GameList asks on its own
// schedule, with its own tests in GameList.test.tsx): these tests are about
// the queue, the quick-sit and the six tables.
const sent = (s: FakeSocket) =>
  s.sent.map((m) => JSON.parse(m)).filter((m) => m.t !== 'games')
const lobbyFrame = (msg: object) => ({ seq: 1, ...msg }) as never

const alice: Identity = {
  player: { userId: 'alice', username: 'alice' },
  getToken: async () => 'dev.alice.t',
  signOut: vi.fn(),
}
const noActive = vi.fn(async () => Response.json({ activeMatch: null }))

beforeEach(() => {
  FakeSocket.all = []
  vi.stubGlobal('WebSocket', FakeSocket)
  window.location.hash = '#lobby'
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('LobbyConnection', () => {
  function connect() {
    const connection = new LobbyConnection(async () => 'jwt', {
      origin: 'wss://qp.test',
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    })
    connection.start()
    return connection
  }

  it('opens the lobby socket and queues once it is open', async () => {
    const connection = connect()
    connection.find() // before the socket opens
    await flush()
    const socket = FakeSocket.last()
    expect(socket.url).toBe('wss://qp.test/ws/lobby')
    expect(socket.protocols).toEqual(['qp.v1', 'bearer.jwt'])
    expect(socket.sent).toEqual([])
    socket.open()
    expect(sent(socket)).toEqual([{ t: 'queue', kind: 'hu-casual' }])
    socket.emit(lobbyFrame({ t: 'queued', position: 1, since: 5 }))
    socket.emit(lobbyFrame({ t: 'presence', online: 3, queued: 1 }))
    expect(connection.getState()).toMatchObject({
      looking: true,
      queued: { position: 1, since: 5 },
      presence: { online: 3, queued: 1 },
    })
  })

  it('asks again after a reconnect while still looking', async () => {
    vi.useFakeTimers()
    const connection = connect()
    await vi.advanceTimersByTimeAsync(0)
    FakeSocket.last().open()
    connection.find()
    FakeSocket.last().drop(1006)
    expect(connection.getState().status).toBe('reconnecting')
    await vi.advanceTimersByTimeAsync(600)
    const again = FakeSocket.last()
    again.open()
    expect(sent(again)).toEqual([{ t: 'queue', kind: 'hu-casual' }])
  })

  it('stops looking when cancelled or matched', async () => {
    const connection = connect()
    await flush()
    const socket = FakeSocket.last()
    socket.open()
    connection.find()
    connection.cancel()
    expect(sent(socket).at(-1)).toEqual({ t: 'dequeue' })
    expect(connection.getState().looking).toBe(false)
    // A late 'queued' after cancelling is ignored.
    socket.emit(lobbyFrame({ t: 'queued', position: 1, since: 5 }))
    expect(connection.getState().queued).toBeNull()

    connection.find()
    socket.emit(lobbyFrame({ t: 'matched', matchId: MATCH, resumed: true }))
    expect(connection.getState()).toMatchObject({
      looking: false,
      matched: { matchId: MATCH, resumed: true },
    })
  })

  it('backs off at least a second after a limit close, says why, and queues again', async () => {
    vi.useFakeTimers()
    const connection = connect()
    await vi.advanceTimersByTimeAsync(0)
    FakeSocket.last().open()
    connection.find()
    FakeSocket.last().drop(CLOSE_RATE_LIMITED, 'Too many messages')
    expect(connection.getState()).toMatchObject({
      status: 'reconnecting',
      error: 'Too many messages, reconnecting…',
    })
    await vi.advanceTimersByTimeAsync(999)
    expect(FakeSocket.all).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    const again = FakeSocket.last()
    again.open()
    expect(connection.getState().error).toBeNull()
    expect(sent(again)).toEqual([{ t: 'queue', kind: 'hu-casual' }])
  })

  it('stops for good when another tab opens the lobby', async () => {
    const connection = connect()
    await flush()
    FakeSocket.last().drop(4001)
    expect(connection.getState().status).toBe('replaced')
  })
})

describe('LobbyConnection: quick-sit and the table list', () => {
  const T1 = '0b7c4a52-6f0e-4d7b-9b55-3c1f2a9e8d01'
  const T2 = '1c8d5b63-7a1f-4e8c-8c66-4d2a3b0f9e12'
  function connect() {
    const connection = new LobbyConnection(async () => 'jwt', {
      origin: 'wss://qp.test',
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    })
    connection.start()
    return connection
  }

  it('asks bare, then with the tables tried, and keeps the table it is sent to', async () => {
    const connection = connect()
    await flush()
    const socket = FakeSocket.last()
    socket.open()
    connection.quickSit()
    expect(sent(socket)).toEqual([{ t: 'quick_sit' }])
    expect(connection.getState()).toMatchObject({ seating: true, sitAt: null })
    socket.emit(lobbyFrame({ t: 'sit_at', tableId: T1 }))
    expect(connection.getState()).toMatchObject({ seating: false, sitAt: T1 })
    // Refused there (PR-25 sits and retries): ask again, naming it.
    connection.quickSit([T1])
    expect(sent(socket).at(-1)).toEqual({ t: 'quick_sit', tried: [T1] })
    expect(connection.getState().sitAt).toBeNull()
    socket.emit(lobbyFrame({ t: 'sit_at', tableId: T2 }))
    expect(connection.getState().sitAt).toBe(T2)
  })

  it('sends a quick-sit asked before the socket opens, or across a reconnect, once open', async () => {
    vi.useFakeTimers()
    const connection = connect()
    connection.quickSit([T1])
    await vi.advanceTimersByTimeAsync(0)
    FakeSocket.last().open()
    expect(sent(FakeSocket.last())).toEqual([{ t: 'quick_sit', tried: [T1] }])
    FakeSocket.last().drop(1006)
    await vi.advanceTimersByTimeAsync(600)
    FakeSocket.last().open()
    expect(sent(FakeSocket.last())).toEqual([{ t: 'quick_sit', tried: [T1] }])
  })

  it('a quick-sit ends a heads-up search, and one resumed goes back to the table', async () => {
    const connection = connect()
    await flush()
    const socket = FakeSocket.last()
    socket.open()
    connection.find()
    connection.quickSit()
    expect(connection.getState()).toMatchObject({
      looking: false,
      seating: true,
    })
    socket.emit(lobbyFrame({ t: 'matched', matchId: MATCH, resumed: true }))
    expect(connection.getState()).toMatchObject({
      seating: false,
      matched: { matchId: MATCH, resumed: true },
    })
  })

  it('a heads-up search asked before the socket opens replaces a quick-sit asked before it', async () => {
    // Devin's review: both went out on open, and the older choice won.
    const connection = connect()
    connection.quickSit([T1])
    connection.find()
    expect(connection.getState()).toMatchObject({
      looking: true,
      seating: false,
    })
    await flush()
    FakeSocket.last().open()
    expect(sent(FakeSocket.last())).toEqual([{ t: 'queue', kind: 'hu-casual' }])
  })

  it('a quick-sit answer arriving after a heads-up search began does not override it', async () => {
    const connection = connect()
    await flush()
    const socket = FakeSocket.last()
    socket.open()
    connection.quickSit()
    connection.find()
    expect(sent(socket)).toEqual([
      { t: 'quick_sit' },
      { t: 'queue', kind: 'hu-casual' },
    ])
    socket.emit(lobbyFrame({ t: 'sit_at', tableId: T1 }))
    socket.emit(
      lobbyFrame({
        t: 'error',
        code: 'tables_full',
        message: 'Every table is full. Try again in a minute.',
      }),
    )
    expect(connection.getState()).toMatchObject({
      looking: true,
      seating: false,
      sitAt: null,
      error: null,
    })
  })

  it('stops a refused quick-sit and says why', async () => {
    const connection = connect()
    await flush()
    const socket = FakeSocket.last()
    socket.open()
    connection.quickSit()
    socket.emit(
      lobbyFrame({
        t: 'error',
        code: 'tables_full',
        message: 'Every table is full. Try again in a minute.',
      }),
    )
    expect(connection.getState()).toMatchObject({
      seating: false,
      sitAt: null,
      error: 'Every table is full. Try again in a minute.',
    })
  })

  it('asks for the list of six tables and keeps it', async () => {
    const connection = connect()
    await flush()
    const socket = FakeSocket.last()
    socket.open()
    connection.listTables()
    expect(sent(socket)).toEqual([{ t: 'tables' }])
    const tables = [
      { tableId: T1, seated: 5, maxSeats: 6, avgPot: 120, playersPerHour: 9 },
      { tableId: T2, seated: 0, maxSeats: 6, avgPot: null, playersPerHour: 0 },
    ]
    socket.emit(lobbyFrame({ t: 'tables', tables }))
    expect(connection.getState().tables).toEqual(tables)
  })
})

describe('LobbyConnection: rated', () => {
  function connect() {
    const connection = new LobbyConnection(async () => 'jwt', {
      origin: 'wss://qp.test',
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    })
    connection.start()
    return connection
  }

  it('queues for the kind asked, again after a reconnect', async () => {
    const connection = connect()
    await flush()
    const socket = FakeSocket.last()
    socket.open()
    connection.find('hu-rated')
    expect(sent(socket)).toEqual([{ t: 'queue', kind: 'hu-rated' }])
    expect(connection.getState()).toMatchObject({
      looking: true,
      kind: 'hu-rated',
    })
    vi.useFakeTimers()
    socket.drop(1006, '')
    await vi.advanceTimersByTimeAsync(1000)
    const again = FakeSocket.last()
    again.open()
    expect(sent(again)).toEqual([{ t: 'queue', kind: 'hu-rated' }])
  })

  it('stops looking when the server refuses a rated queue, and says why', async () => {
    const connection = connect()
    await flush()
    const socket = FakeSocket.last()
    socket.open()
    connection.find('hu-rated')
    socket.emit(
      lobbyFrame({
        t: 'error',
        code: 'unverified',
        message: 'Rated matches need a confirmed email address.',
      }),
    )
    expect(connection.getState()).toMatchObject({
      looking: false,
      refused: 'Rated matches need a confirmed email address.',
    })
    // Casual is still open to them, and clears the refusal.
    connection.find()
    expect(sent(socket).at(-1)).toEqual({ t: 'queue', kind: 'hu-casual' })
    expect(connection.getState().refused).toBeNull()
  })

  it('asks again over a fresh socket for rated after a refusal, even with a casual search between', async () => {
    const connection = connect()
    await flush()
    const socket = FakeSocket.last()
    socket.open()
    connection.find('hu-rated')
    socket.emit(
      lobbyFrame({
        t: 'error',
        code: 'unverified',
        message: 'Rated matches need a confirmed email address.',
      }),
    )
    connection.find() // a casual search clears the message, not the socket's answer
    connection.cancel()
    connection.find('hu-rated')
    await flush()
    const again = FakeSocket.last()
    expect(again).not.toBe(socket)
    again.open()
    expect(sent(again)).toEqual([{ t: 'queue', kind: 'hu-rated' }])
    // The fresh socket's answer is the one that counts from now on.
    connection.cancel()
    connection.find('hu-rated')
    expect(FakeSocket.last()).toBe(again)
  })

  it('asks again over a fresh socket when a refused player retries rated', async () => {
    const connection = connect()
    await flush()
    const socket = FakeSocket.last()
    socket.open()
    connection.find('hu-rated')
    socket.emit(
      lobbyFrame({
        t: 'error',
        code: 'unverified',
        message:
          'Could not check your account just now. Try again in a moment.',
      }),
    )
    // The Worker checks once per socket, so the retry needs a new one.
    connection.find('hu-rated')
    await flush()
    const again = FakeSocket.last()
    expect(again).not.toBe(socket)
    expect(socket.closedWith).toBe(1000)
    again.open()
    expect(sent(again)).toEqual([{ t: 'queue', kind: 'hu-rated' }])
    expect(connection.getState()).toMatchObject({
      status: 'open',
      looking: true,
      refused: null,
    })
  })
})

describe('Lobby: Play rated 1v1', () => {
  async function lobbyPage() {
    render(<Lobby identity={alice} fetcher={noActive} />)
    await act(async () => {})
    const socket = FakeSocket.last()
    act(() => socket.open())
    return socket
  }

  it('queues hu-rated from the Rated card, and holds the casual one meanwhile', async () => {
    const socket = await lobbyPage()
    expect(
      screen.getByRole('heading', { name: 'Play rated 1v1' }),
    ).toBeVisible()
    expect(screen.getByText(/40 hands/)).toBeVisible()
    await userEvent.click(
      screen.getByRole('button', { name: 'Find a rated match' }),
    )
    // The six-table list is asked for as the socket opens (PR-25).
    expect(sent(socket)).toEqual([
      { t: 'tables' },
      { t: 'queue', kind: 'hu-rated' },
    ])
    expect(screen.getAllByText('Looking for an opponent')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Find a match' })).toBeDisabled()
    act(() => socket.emit(lobbyFrame({ t: 'matched', matchId: MATCH })))
    expect(window.location.hash).toBe(`#play/${MATCH}`)
  })

  it('offers Atlas after a minute alone in the rated line, whoever waits for casual', async () => {
    const socket = await lobbyPage()
    vi.useFakeTimers({ shouldAdvanceTime: true })
    act(() =>
      screen.getByRole('button', { name: 'Find a rated match' }).click(),
    )
    // Two waiting, but one of them for casual: nobody to pair with.
    act(() =>
      socket.emit(
        lobbyFrame({ t: 'presence', online: 2, queued: 2, rated: 1 }),
      ),
    )
    await act(async () => vi.advanceTimersByTime(61_000))
    expect(screen.getByText(/Nobody else is looking right now/)).toBeVisible()
  })

  it('tells an account without a confirmed email why it cannot play rated', async () => {
    const socket = await lobbyPage()
    await userEvent.click(
      screen.getByRole('button', { name: 'Find a rated match' }),
    )
    act(() =>
      socket.emit(
        lobbyFrame({
          t: 'error',
          code: 'unverified',
          message: 'Rated matches need a confirmed email address.',
        }),
      ),
    )
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Rated matches need a confirmed email address.',
    )
    expect(
      screen.getByRole('button', { name: 'Find a rated match' }),
    ).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Find a match' })).toBeEnabled()
  })
})

describe('Lobby: Play 1v1', () => {
  async function lobbyPage(props: Partial<Parameters<typeof Lobby>[0]> = {}) {
    render(<Lobby identity={alice} fetcher={noActive} {...props} />)
    await act(async () => {})
    const socket = FakeSocket.last()
    act(() => socket.open())
    return socket
  }

  it('finds a match and goes to the table', async () => {
    const socket = await lobbyPage()
    act(() => socket.emit(lobbyFrame({ t: 'presence', online: 3, queued: 0 })))
    expect(screen.getByText('2 other players in the lobby.')).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Find a match' }))
    expect(sent(socket)).toEqual([
      { t: 'tables' },
      { t: 'queue', kind: 'hu-casual' },
    ])
    expect(screen.getByText('Looking for an opponent')).toBeVisible()
    act(() => socket.emit(lobbyFrame({ t: 'matched', matchId: MATCH })))
    expect(window.location.hash).toBe(`#play/${MATCH}`)
  })

  it('says nothing more when a listed game is listed, and notes it when it was not', async () => {
    for (const listed of [true, false]) {
      window.location.hash = '#lobby'
      window.sessionStorage.clear()
      const fetcher = vi.fn(async (url: string) =>
        url.endsWith('/api/matches')
          ? Response.json(
              { matchId: MATCH, code: 'ABC234', listed },
              { status: 201 },
            )
          : Response.json({ activeMatch: null }),
      ) as unknown as typeof fetch
      const view = render(<Lobby identity={alice} fetcher={fetcher} />)
      await act(async () => {})
      act(() => FakeSocket.last().open())
      await userEvent.click(screen.getByLabelText('Show in open games'))
      await userEvent.click(
        screen.getByRole('button', { name: 'Play a friend by link' }),
      )
      await vi.waitFor(() =>
        expect(window.location.hash).toBe(`#play/${MATCH}`),
      )
      expect(window.sessionStorage.getItem(`qp-unlisted-${MATCH}`)).toBe(
        listed ? null : '1',
      )
      view.unmount()
    }
  })

  it('does not note a game the host never asked to list', async () => {
    window.sessionStorage.clear()
    const fetcher = vi.fn(async (url: string) =>
      url.endsWith('/api/matches')
        ? Response.json(
            { matchId: MATCH, code: 'ABC234', listed: false },
            { status: 201 },
          )
        : Response.json({ activeMatch: null }),
    ) as unknown as typeof fetch
    await lobbyPage({ fetcher })
    await userEvent.click(
      screen.getByRole('button', { name: 'Play a friend by link' }),
    )
    await vi.waitFor(() => expect(window.location.hash).toBe(`#play/${MATCH}`))
    expect(window.sessionStorage.getItem(`qp-unlisted-${MATCH}`)).toBeNull()
  })

  it('words the help so that an unlisted game is expected', async () => {
    await lobbyPage()
    expect(screen.getByText(/or the game stays unlisted/)).toBeVisible()
  })

  it('cancels', async () => {
    const socket = await lobbyPage()
    await userEvent.click(screen.getByRole('button', { name: 'Find a match' }))
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(sent(socket).at(-1)).toEqual({ t: 'dequeue' })
    expect(screen.getByRole('button', { name: 'Find a match' })).toBeVisible()
  })

  it('offers Atlas after a minute alone in the queue', async () => {
    const socket = await lobbyPage()
    vi.useFakeTimers({ shouldAdvanceTime: true })
    act(() => screen.getByRole('button', { name: 'Find a match' }).click())
    act(() => socket.emit(lobbyFrame({ t: 'presence', online: 1, queued: 1 })))
    expect(screen.queryByText(/Nobody else is looking/)).toBeNull()
    await act(async () => vi.advanceTimersByTime(61_000))
    expect(screen.getByText(/Nobody else is looking right now/)).toBeVisible()
    expect(
      screen.getByRole('link', { name: 'Practice vs Atlas' }),
    ).toHaveAttribute('href', '#table')
    act(() => screen.getByRole('button', { name: 'Keep waiting' }).click())
    expect(screen.queryByText(/Nobody else is looking/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeVisible()
  })

  it('says the rated search is widening after a minute with others waiting', async () => {
    const socket = await lobbyPage()
    vi.useFakeTimers({ shouldAdvanceTime: true })
    act(() =>
      screen.getByRole('button', { name: 'Find a rated match' }).click(),
    )
    act(() =>
      socket.emit(
        lobbyFrame({ t: 'presence', online: 4, queued: 2, rated: 2 }),
      ),
    )
    expect(screen.queryByText(/Widening search/)).toBeNull()
    await act(async () => vi.advanceTimersByTime(61_000))
    expect(screen.getByText(/Widening search…/)).toBeVisible()
  })

  it('starts looking at once when sent back to find another match', async () => {
    const socket = await lobbyPage({ autoFind: true })
    expect(sent(socket)).toEqual([
      { t: 'queue', kind: 'hu-casual' },
      { t: 'tables' },
    ])
  })

  it('points to the table already in play', async () => {
    const fetcher = vi.fn(async (url: string) =>
      url.endsWith('/api/me')
        ? Response.json({ activeMatch: MATCH })
        : Response.json({ error: 'active', matchId: MATCH }, { status: 409 }),
    ) as unknown as typeof fetch
    await lobbyPage({ fetcher })
    expect(
      await screen.findByRole('link', { name: 'Return to your table' }),
    ).toHaveAttribute('href', `#play/${MATCH}`)
    await userEvent.click(
      screen.getByRole('button', { name: 'Play a friend by link' }),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'already playing at another table',
    )
  })
})

describe('LiveTable and the lobby', () => {
  async function table() {
    render(<LiveTable matchId={MATCH} identity={alice} />)
    await act(async () => {})
    const socket = FakeSocket.last()
    act(() => socket.open())
    return socket
  }
  const welcome = (info = tableInfo(2, 'waiting')) =>
    ({
      t: 'welcome',
      seq: 0,
      matchId: MATCH,
      seat: 0,
      serverNow: 0,
      table: info,
      view: null,
    }) as const

  it('waits for a paired opponent by name', async () => {
    const socket = await table()
    const info = tableInfo(2, 'waiting')
    info.players[1].connected = false
    act(() => socket.emit(welcome(info)))
    expect(screen.getByText('Waiting for bob')).toBeVisible()
    expect(screen.queryByLabelText('Invite link')).toBeNull()
  })

  it('lets a casual player stop waiting for an opponent who is away (audit F05)', async () => {
    const socket = await table()
    // Bob opened alice's invite; alice, the host, has gone.
    const info = tableInfo(2, 'waiting')
    info.players[0].connected = false
    act(() => socket.emit({ ...welcome(info), seat: 1 }))
    expect(screen.getByText('Waiting for alice')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Stop waiting' }))
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({ t: 'stand' })
    expect(screen.getByRole('button', { name: 'Leaving…' })).toBeDisabled()
    act(() =>
      socket.emit({
        t: 'match_end',
        seq: 1,
        matchId: MATCH,
        result: { netBySeat: { 0: 0, 1: 0 }, reason: 'no_show', noShow: [0] },
      }),
    )
    expect(screen.getByText('alice did not show up')).toBeVisible()
  })

  it('tells a player the table closed before they arrived, not that the other did not show', async () => {
    const socket = await table()
    act(() => socket.emit(welcome()))
    act(() =>
      socket.emit({
        t: 'match_end',
        seq: 1,
        matchId: MATCH,
        result: { netBySeat: { 0: 0, 1: 0 }, reason: 'no_show', noShow: [0] },
      }),
    )
    expect(
      screen.getByText('The table closed before you arrived'),
    ).toBeVisible()
  })

  it('explains a no-show and offers another match', async () => {
    const socket = await table()
    const info = tableInfo(2, 'waiting')
    info.players[1].connected = false
    act(() => socket.emit(welcome(info)))
    act(() =>
      socket.emit({
        t: 'match_end',
        seq: 1,
        matchId: MATCH,
        result: { netBySeat: { 0: 0, 1: 0 }, reason: 'no_show', noShow: [1] },
      }),
    )
    expect(screen.getByText('bob did not show up')).toBeVisible()
    expect(
      screen.getByRole('link', { name: 'Find another match' }),
    ).toHaveAttribute('href', '#lobby/find')
  })

  it('sends a player who is busy elsewhere to their table', async () => {
    const socket = await table()
    const other = '44444444-4444-4444-8444-444444444444'
    act(() => socket.drop(4409, other))
    expect(screen.getByRole('alert')).toHaveTextContent(
      'already playing at another table',
    )
    expect(
      screen.getByRole('link', { name: 'Go to your table' }),
    ).toHaveAttribute('href', `#play/${other}`)
  })

  it('says the table has closed when the server has cleaned it up', async () => {
    const socket = await table()
    act(() => socket.drop(CLOSE_GONE, 'closed'))
    expect(screen.getByRole('alert')).toHaveTextContent('This table has closed')
    expect(screen.getByRole('link', { name: 'Find a match' })).toHaveAttribute(
      'href',
      '#lobby/find',
    )
  })

  it('tells a flooding client why it is reconnecting', async () => {
    const socket = await table()
    act(() => socket.emit(welcome()))
    act(() => socket.drop(CLOSE_RATE_LIMITED, 'Too many messages'))
    expect(screen.getByText('Too many messages, reconnecting…')).toBeVisible()
  })
})

describe('LiveApp routes', () => {
  it('starts looking when a table sends you to find another match', async () => {
    const { default: LiveApp } = await import('./LiveApp')
    sessionStorage.setItem('qp.devToken', 'dev.alice.t')
    window.location.hash = `#play/${MATCH}`
    render(<LiveApp />)
    await act(async () => {})
    expect(FakeSocket.last().url).toContain('/ws/table/')
    // "Find another match" after a no-show: the same app, a new route.
    act(() => {
      window.location.hash = '#lobby/find'
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    await act(async () => {})
    const lobbySocket = FakeSocket.last()
    expect(lobbySocket.url).toContain('/ws/lobby')
    act(() => lobbySocket.open())
    expect(sent(lobbySocket)).toEqual([
      { t: 'queue', kind: 'hu-casual' },
      { t: 'tables' },
    ])
    expect(window.location.hash).toBe('#lobby')
    sessionStorage.removeItem('qp.devToken')
  })
})

describe('LobbyConnection: open games', () => {
  function connect(heartbeatMs = 0) {
    const connection = new LobbyConnection(async () => 'jwt', {
      origin: 'wss://qp.test',
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      heartbeatMs,
      random: () => 0.5,
    })
    connection.start()
    return connection
  }
  async function opened(heartbeatMs = 0) {
    const connection = connect(heartbeatMs)
    await flush()
    const socket = FakeSocket.last()
    socket.open()
    return { connection, socket }
  }
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends nothing as the socket opens: the list is asked for, never pushed', async () => {
    const { socket } = await opened()
    expect(socket.sent).toEqual([])
  })

  it('asks for the list only on an open socket, and keeps what comes back', async () => {
    const connection = connect()
    await flush()
    const socket = FakeSocket.last()
    connection.listGames()
    expect(socket.sent).toEqual([])
    socket.open()
    connection.listGames()
    expect(socket.sent).toEqual(['{"t":"games"}'])
    expect(connection.getState().games).toBeNull()
    socket.emitLobby(gamesFrame([gameRow(1), gameRow(2, 'dave', 61_000)]))
    expect(connection.getState().games).toEqual([
      { gameId: gameId(1), host: 'carol', openForMs: 180_000 },
      { gameId: gameId(2), host: 'dave', openForMs: 61_000 },
    ])
    expect(connection.getState().gamesAt).not.toBeNull()
  })

  it('keeps only the rows it can use, rebuilt by name', () => {
    const good = gameRow(1)
    expect(
      readGames([
        { ...good, matchId: MATCH },
        { ...good, code: 'ABC234' },
        { ...good, gameId: gameId(10).toUpperCase() },
        { ...good, gameId: 'short' },
        { ...good, openForMs: -1 },
        { ...good, openForMs: '5' },
        { gameId: good.gameId, host: good.host },
        { ...good, host: 'h'.repeat(100) },
        null,
        'row',
      ]),
    ).toEqual([{ ...good, host: 'h'.repeat(40) }])
    expect(readGames({ games: [] })).toEqual([])
    const many = Array.from({ length: 50 }, (_, n) => gameRow(n + 1))
    expect(readGames(many)).toHaveLength(30)
    expect(readGames(many)[29].gameId).toBe(gameId(30))
  })

  it('takes a matched frame from any state, including idle, and clears a request', async () => {
    const { connection, socket } = await opened()
    expect(connection.getState().looking).toBe(false)
    connection.requestJoin(gameId(1))
    socket.emitLobby({ t: 'matched', matchId: MATCH, resumed: false })
    expect(connection.getState()).toMatchObject({
      looking: false,
      matched: { matchId: MATCH, resumed: false },
      joinRequest: null,
    })
  })

  describe('a join request', () => {
    it('is sent at once, shows pending, and takes the host deadline from the lobby', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(1_000)
      const connection = connect()
      await vi.advanceTimersByTimeAsync(0)
      const socket = FakeSocket.last()
      expect(connection.requestJoin(gameId(1))).toBe(false) // not open yet
      socket.open()
      expect(connection.requestJoin(gameId(1))).toBe(true)
      expect(sent(socket)).toEqual([{ t: 'join_request', gameId: gameId(1) }])
      expect(connection.getState().joinRequest).toEqual({
        gameId: gameId(1),
        state: 'pending',
        expiresAt: null,
      })
      socket.emitLobby(joinStatusFrame('pending', 60_000))
      expect(connection.getState().joinRequest).toEqual({
        gameId: gameId(1),
        state: 'pending',
        expiresAt: 61_000,
      })
    })

    it('ends declined or unavailable, with nothing more expected', async () => {
      const { connection, socket } = await opened()
      connection.requestJoin(gameId(1))
      socket.emitLobby(joinStatusFrame('declined'))
      expect(connection.getState().joinRequest).toMatchObject({
        state: 'declined',
        expiresAt: null,
      })
      // A late frame with no request waiting changes nothing.
      connection.cancelRequest()
      socket.emitLobby(joinStatusFrame('unavailable'))
      expect(connection.getState().joinRequest).toBeNull()
      expect(connection.getState().codeFailed).toBe(false)
    })

    it('is withdrawn with a cancel, sent only while it is pending', async () => {
      const { connection, socket } = await opened()
      connection.requestJoin(gameId(1))
      connection.cancelRequest()
      expect(sent(socket).at(-1)).toEqual({ t: 'cancel_request' })
      expect(connection.getState().joinRequest).toBeNull()
      const before = socket.sent.length
      connection.requestJoin(gameId(2))
      socket.emitLobby(joinStatusFrame('declined'))
      connection.cancelRequest() // nothing pending at the lobby to cancel
      expect(socket.sent.length).toBe(before + 1)
    })

    it('ends a search, as the lobby does', async () => {
      const { connection, socket } = await opened()
      connection.find()
      connection.requestJoin(gameId(1))
      expect(sent(socket)).toEqual([
        { t: 'queue', kind: 'hu-casual' },
        { t: 'dequeue' },
        { t: 'join_request', gameId: gameId(1) },
      ])
      expect(connection.getState()).toMatchObject({
        looking: false,
        queued: null,
      })
      connection.quickSit()
      connection.requestJoin(gameId(1))
      expect(connection.getState().seating).toBe(false)
    })

    it('says it was refused for asking too often, in the list and not as a banner', async () => {
      const { connection, socket } = await opened()
      connection.requestJoin(gameId(1))
      socket.emitLobby({
        t: 'error',
        code: 'rate_limited',
        message: 'Slow down',
      } as never)
      expect(connection.getState()).toMatchObject({
        joinLimited: 'request',
        joinRequest: null,
        error: null,
      })
    })
  })

  describe('a game code', () => {
    it('is cleaned, then sent as the code alone', async () => {
      const { connection, socket } = await opened()
      expect(connection.joinByCode(' abc-234 ')).toBe(true)
      expect(sent(socket)).toEqual([{ t: 'join_code', code: 'ABC234' }])
    })

    it('fails on the spot for what can not be a code, as the lobby would for a miss', async () => {
      const { connection, socket } = await opened()
      for (const typed of ['', 'ABC', 'ABC0IL', 'a'.repeat(30)]) {
        connection.joinByCode(typed)
        expect(connection.getState().codeFailed).toBe(true)
      }
      expect(socket.sent).toEqual([])
    })

    it("fails on the lobby's unavailable, and tries again clean", async () => {
      const { connection, socket } = await opened()
      connection.joinByCode('ABC234')
      socket.emitLobby(joinStatusFrame('unavailable'))
      expect(connection.getState().codeFailed).toBe(true)
      connection.joinByCode('ABC235')
      expect(connection.getState().codeFailed).toBe(false)
    })

    it('goes to the table the lobby names', async () => {
      const { connection, socket } = await opened()
      connection.joinByCode('ABC234')
      socket.emitLobby({ t: 'matched', matchId: MATCH, resumed: false })
      expect(connection.getState().matched).toEqual({
        matchId: MATCH,
        resumed: false,
      })
      expect(connection.getState().codeFailed).toBe(false)
    })

    it('is refused for asking too often', async () => {
      const { connection, socket } = await opened()
      connection.joinByCode('ABC234')
      socket.emitLobby({
        t: 'error',
        code: 'rate_limited',
        message: 'Slow down',
      } as never)
      expect(connection.getState()).toMatchObject({
        joinLimited: 'code',
        error: null,
      })
    })

    it('gives up a request in flight first, and ends a search', async () => {
      const { connection, socket } = await opened()
      connection.requestJoin(gameId(1))
      connection.joinByCode('ABC234')
      expect(sent(socket).map((m) => m.t)).toEqual([
        'join_request',
        'cancel_request',
        'join_code',
      ])
      // The next join_status answers the code, not the request.
      socket.emitLobby(joinStatusFrame('unavailable'))
      expect(connection.getState()).toMatchObject({
        codeFailed: true,
        joinRequest: null,
      })
    })
  })

  it('forgets the list and any request when the socket drops, and asks nothing on reopening', async () => {
    vi.useFakeTimers()
    const connection = connect()
    await vi.advanceTimersByTimeAsync(0)
    const socket = FakeSocket.last()
    socket.open()
    socket.emitLobby(gamesFrame([gameRow(1)]))
    connection.requestJoin(gameId(1))
    connection.joinByCode('xxx')
    socket.drop(1006)
    expect(connection.getState()).toMatchObject({
      status: 'reconnecting',
      games: null,
      gamesAt: null,
      joinRequest: null,
      codeFailed: false,
    })
    await vi.advanceTimersByTimeAsync(500)
    FakeSocket.last().open()
    expect(FakeSocket.last().sent).toEqual([])
    expect(connection.getState().games).toBeNull()
  })

  describe('the heartbeat', () => {
    it('pings the lobby socket too, and a pong is not a frame to parse', async () => {
      vi.useFakeTimers()
      const connection = connect(5000)
      await vi.advanceTimersByTimeAsync(0)
      const socket = FakeSocket.last()
      socket.open()
      await vi.advanceTimersByTimeAsync(5000)
      expect(socket.pings).toEqual(['ping'])
      expect(socket.sent).toEqual([])
      expect(connection.getState().status).toBe('open')
      connection.stop()
      expect(vi.getTimerCount()).toBe(0)
    })

    it('closes a lobby socket that stops answering and reconnects', async () => {
      vi.useFakeTimers()
      const connection = connect(5000)
      await vi.advanceTimersByTimeAsync(0)
      const socket = FakeSocket.last()
      socket.open()
      socket.answerPings = false
      await vi.advanceTimersByTimeAsync(15_000)
      expect(socket.closedWith).toBe(1000)
      expect(connection.getState().status).toBe('reconnecting')
      await vi.advanceTimersByTimeAsync(500)
      expect(FakeSocket.all).toHaveLength(2)
      connection.stop()
    })
  })
})

describe('LiveApp: #join/CODE', () => {
  async function app(hash: string) {
    const { default: LiveApp } = await import('./LiveApp')
    sessionStorage.setItem('qp.devToken', 'dev.alice.t')
    window.location.hash = hash
    render(<LiveApp />)
    await act(async () => {})
  }
  afterEach(() => sessionStorage.removeItem('qp.devToken'))

  it('sends the cleaned code once the lobby is open, and goes to the table it names', async () => {
    await app('#join/abc-234')
    const socket = FakeSocket.last()
    expect(socket.url).toContain('/ws/lobby')
    expect(screen.getByText('Joining the game…')).toBeVisible()
    act(() => socket.open())
    expect(sent(socket)).toEqual([{ t: 'join_code', code: 'ABC234' }])
    act(() =>
      socket.emitLobby({ t: 'matched', matchId: MATCH, resumed: false }),
    )
    expect(window.location.hash).toBe(`#play/${MATCH}`)
    await act(async () => {})
    expect(FakeSocket.last().url).toContain('/ws/table/')
  })

  it('takes the code out of the address bar and gives one answer for a miss', async () => {
    await app('#join/ABC234')
    const socket = FakeSocket.last()
    act(() => socket.open())
    act(() => socket.emitLobby(joinStatusFrame('unavailable')))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "That code doesn't match an open game. Check it and try again.",
    )
    expect(screen.getByRole('link', { name: 'Back to lobby' })).toHaveAttribute(
      'href',
      '#lobby',
    )
    expect(window.location.hash).toBe('#join')
  })

  it('says to wait when the lobby has had too many tries', async () => {
    await app('#join/ABC234')
    const socket = FakeSocket.last()
    act(() => socket.open())
    act(() =>
      socket.emitLobby({
        t: 'error',
        code: 'rate_limited',
        message: 'Slow down',
      } as never),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many tries. Wait a few minutes.',
    )
    expect(window.location.hash).toBe('#join')
  })

  it('asks the lobby nothing for a code that cannot be one, and says the same', async () => {
    await app('#join/ABC0IL')
    expect(FakeSocket.all).toHaveLength(0)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "That code doesn't match an open game",
    )
    expect(window.location.hash).toBe('#join')
  })

  it('a spent link, reloaded, is the same answer and tries nothing', async () => {
    await app('#join')
    expect(FakeSocket.all).toHaveLength(0)
    expect(screen.getByRole('alert')).toHaveTextContent(
      "That code doesn't match an open game",
    )
  })

  it('tries again over a new socket if the first dropped before an answer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await app('#join/ABC234')
    const socket = FakeSocket.last()
    act(() => socket.open())
    act(() => socket.drop(1006))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    const again = FakeSocket.last()
    expect(again).not.toBe(socket)
    act(() => again.open())
    expect(sent(again)).toEqual([{ t: 'join_code', code: 'ABC234' }])
  })
})
