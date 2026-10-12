import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act as engineAct } from '../engine/hand'
import { CLOSE_ABUSE, CLOSE_GONE, CLOSE_RATE_LIMITED } from '../shared/protocol'
import type { HandRecordV1, ServerMsg } from '../shared/protocol'
import { ANSWER_WAIT_MS, readRequests, TableConnection } from './client'
import { PING_EVERY_MS, PROBE_MS } from './heartbeat'
import {
  FakeSocket,
  firstHand,
  frame,
  inviteFrame,
  MATCH,
  sixFrame,
} from './testing'
import { PENDING_WATCHDOG_MS, RESYNC_WAIT_MS } from './client'

const flush = () => new Promise((r) => setTimeout(r, 0))

/**
 * Every connection a test starts, stopped after it: a started connection
 * listens to the window (online, offline, visibility), and one left running
 * would answer the next test's events.
 */
const started: TableConnection[] = []

function connect(token: string | null = 'jwt', maxAttempts = 8) {
  const getToken = vi.fn(async () => token)
  let n = 0
  const connection = new TableConnection(MATCH, getToken, {
    origin: 'wss://qp.test',
    WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    maxAttempts,
    newRequestId: () => `req${++n}`,
  })
  connection.start()
  started.push(connection)
  return { connection, getToken }
}

beforeEach(() => {
  FakeSocket.all = []
})
afterEach(() => {
  for (const connection of started.splice(0)) connection.stop()
  vi.useRealTimers()
})

describe('TableConnection', () => {
  it('opens the table socket with the protocol and token as subprotocols', async () => {
    const { connection } = connect()
    await flush()
    const socket = FakeSocket.last()
    expect(socket.url).toBe(`wss://qp.test/ws/table/${MATCH}`)
    expect(socket.protocols).toEqual(['qp.v1', 'bearer.jwt'])
    expect(connection.getState().status).toBe('connecting')
    socket.open()
    expect(connection.getState().status).toBe('open')
  })

  it('fails without a token instead of connecting', async () => {
    const { connection } = connect(null)
    await flush()
    expect(FakeSocket.all).toHaveLength(0)
    expect(connection.getState()).toMatchObject({
      status: 'failed',
      error: { code: 'unauthorized' },
    })
  })

  it('keeps the newest snapshot and ignores older ones', async () => {
    const { connection } = connect()
    await flush()
    const socket = FakeSocket.last()
    socket.open()
    const hand = firstHand()
    socket.emit(frame('welcome', 5, 0, hand))
    expect(connection.getState()).toMatchObject({
      seat: 0,
      view: { handNo: 1 },
    })
    const later = engineAct(hand, 0, { type: 'call' })
    socket.emit(frame('state', 6, 0, later))
    socket.emit(frame('state', 5, 0, hand)) // late duplicate: dropped
    expect(connection.getState().view?.actions).toHaveLength(1)
    socket.emit(frame('state', 6, 0, later)) // same seq (presence): kept
    expect(connection.getState().view?.actions).toHaveLength(1)
  })

  it('sends a move for the current decision and clears it on the ack', async () => {
    const { connection } = connect()
    await flush()
    const socket = FakeSocket.last()
    socket.open()
    const hand = firstHand()
    socket.emit(frame('welcome', 1, 0, hand))
    expect(connection.act({ type: 'call' })).toBe(true)
    expect(JSON.parse(socket.sent[0])).toEqual({
      t: 'act',
      reqId: 'req1',
      handNo: 1,
      actionIndex: 0,
      action: { type: 'call' },
    })
    // One move at a time until the server answers.
    expect(connection.act({ type: 'fold' })).toBe(false)
    expect(connection.getState().pending).toBe('req1')
    socket.emit(
      frame('state', 2, 0, engineAct(hand, 0, { type: 'call' }), 'req1'),
    )
    expect(connection.getState().pending).toBeNull()
    // Now it is the other seat's turn.
    expect(connection.act({ type: 'check' })).toBe(false)
  })

  it('surfaces a rejected move and lets the player try again', async () => {
    const { connection } = connect()
    await flush()
    const socket = FakeSocket.last()
    socket.open()
    socket.emit(frame('welcome', 1, 0, firstHand()))
    connection.act({ type: 'raise', to: 21 })
    socket.emit({
      t: 'error',
      seq: 1,
      matchId: MATCH,
      code: 'illegal',
      reqId: 'req1',
      message: 'Illegal raise size',
    })
    expect(connection.getState()).toMatchObject({
      pending: null,
      error: { code: 'illegal', message: 'Illegal raise size' },
    })
    expect(connection.act({ type: 'call' })).toBe(true)
  })

  it('does not act for the other seat or after the hand', async () => {
    const { connection } = connect()
    await flush()
    const socket = FakeSocket.last()
    socket.open()
    socket.emit(frame('welcome', 1, 1, firstHand()))
    expect(connection.act({ type: 'call' })).toBe(false)
    expect(socket.sent).toHaveLength(0)
  })

  it('sends a bare rebuy and stand from a seat at a six table only', async () => {
    const { connection } = connect()
    await flush()
    const socket = FakeSocket.last()
    // Not open yet, then open without a seat: nothing to send.
    expect(connection.rebuy()).toBe(false)
    expect(connection.stand()).toBe(false)
    socket.open()
    socket.emit(sixFrame('welcome', 1, null, null, null))
    expect(connection.rebuy()).toBe(false)
    expect(connection.stand()).toBe(false)
    expect(socket.sent).toEqual([])
    // Seated: each frame is the type alone. The server finds the seat
    // from the account and computes the top-up.
    socket.emit(sixFrame('welcome', 2, 2, null, null))
    expect(connection.rebuy()).toBe(true)
    expect(connection.stand()).toBe(true)
    expect(socket.sent.map((m) => JSON.parse(m))).toEqual([
      { t: 'rebuy' },
      { t: 'stand' },
    ])
  })

  it('sit without a seat sends a bare sit; with one, names it', async () => {
    // Quick-sit (PR-25): the server picks the lowest free seat.
    const bare = connect().connection
    await flush()
    const socket = FakeSocket.last()
    expect(bare.sit()).toBe(false)
    socket.open()
    socket.emit(sixFrame('welcome', 1, null, null, null))
    expect(bare.sit()).toBe(true)
    expect(socket.sent).toEqual(['{"t":"sit"}'])
    socket.emit(sixFrame('welcome', 2, 1, null, null))
    expect(bare.sit()).toBe(false)

    const named = connect().connection
    await flush()
    const other = FakeSocket.last()
    other.open()
    other.emit(sixFrame('welcome', 1, null, null, null))
    expect(named.sit(4)).toBe(true)
    expect(other.sent.map((m) => JSON.parse(m))).toEqual([
      { t: 'sit', seat: 4 },
    ])
  })

  it('resync() asks for a fresh welcome only on an open socket', async () => {
    const { connection } = connect()
    await flush()
    const socket = FakeSocket.last()
    expect(connection.resync()).toBe(false)
    expect(socket.sent).toEqual([])
    socket.open()
    expect(connection.resync()).toBe(true)
    expect(socket.sent.map((m) => JSON.parse(m))).toEqual([{ t: 'resync' }])
  })

  it('sends a bare sit_out and sit_in from a seat at a six table only', async () => {
    const { connection } = connect()
    await flush()
    const socket = FakeSocket.last()
    expect(connection.sitOut()).toBe(false)
    expect(connection.sitIn()).toBe(false)
    socket.open()
    socket.emit(sixFrame('welcome', 1, null, null, null))
    expect(connection.sitOut()).toBe(false)
    expect(connection.sitIn()).toBe(false)
    expect(socket.sent).toEqual([])
    // Seated: the type alone, for the socket account's own seat.
    socket.emit(sixFrame('welcome', 2, 2, null, null))
    expect(connection.sitOut()).toBe(true)
    expect(connection.sitIn()).toBe(true)
    expect(socket.sent.map((m) => JSON.parse(m))).toEqual([
      { t: 'sit_out' },
      { t: 'sit_in' },
    ])
  })

  it('reconnects with backoff and a fresh token, then gives up', async () => {
    vi.useFakeTimers()
    const { connection, getToken } = connect('jwt', 2)
    await vi.advanceTimersByTimeAsync(0)
    FakeSocket.last().open()
    FakeSocket.last().drop()
    expect(connection.getState().status).toBe('reconnecting')
    await vi.advanceTimersByTimeAsync(499)
    expect(FakeSocket.all).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(FakeSocket.all).toHaveLength(2)
    expect(getToken).toHaveBeenCalledTimes(2)
    FakeSocket.last().drop()
    await vi.advanceTimersByTimeAsync(1000)
    expect(FakeSocket.all).toHaveLength(3)
    FakeSocket.last().drop()
    expect(connection.getState().status).toBe('failed')
  })

  it('gives up quickly on a table that never accepted the socket', async () => {
    vi.useFakeTimers()
    const { connection } = connect('jwt', 8)
    await vi.advanceTimersByTimeAsync(0)
    for (const wait of [500, 1000, 2000]) {
      FakeSocket.last().drop()
      await vi.advanceTimersByTimeAsync(wait)
    }
    expect(FakeSocket.all).toHaveLength(4)
    FakeSocket.last().drop()
    expect(connection.getState().status).toBe('failed')
  })

  it('resets the backoff once a connection opens', async () => {
    vi.useFakeTimers()
    connect('jwt', 1)
    await vi.advanceTimersByTimeAsync(0)
    FakeSocket.last().drop()
    await vi.advanceTimersByTimeAsync(500)
    FakeSocket.last().open()
    FakeSocket.last().drop()
    await vi.advanceTimersByTimeAsync(500)
    expect(FakeSocket.all).toHaveLength(3)
  })

  it('stops when another tab takes the seat, or when the page leaves', async () => {
    vi.useFakeTimers()
    const first = connect()
    await vi.advanceTimersByTimeAsync(0)
    FakeSocket.last().drop(4001)
    expect(first.connection.getState().status).toBe('replaced')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(FakeSocket.all).toHaveLength(1)

    const second = connect()
    await vi.advanceTimersByTimeAsync(0)
    const socket = FakeSocket.last()
    second.connection.stop()
    expect(socket.closedWith).toBe(1000)
    socket.drop(1000)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(FakeSocket.all).toHaveLength(2)
  })

  it('backs off at least a second after a limit close, says why, and keeps trying', async () => {
    vi.useFakeTimers()
    for (const code of [CLOSE_RATE_LIMITED, CLOSE_ABUSE]) {
      FakeSocket.all = []
      const { connection } = connect()
      await vi.advanceTimersByTimeAsync(0)
      FakeSocket.last().open()
      FakeSocket.last().drop(code, 'Too many messages')
      expect(connection.getState()).toMatchObject({
        status: 'reconnecting',
        error: {
          code: 'rate_limited',
          message: 'Too many messages, reconnecting…',
        },
      })
      await vi.advanceTimersByTimeAsync(999)
      expect(FakeSocket.all).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(FakeSocket.all).toHaveLength(2)
      FakeSocket.last().open()
      expect(connection.getState()).toMatchObject({
        status: 'open',
        error: null,
      })
      connection.stop()
    }
  })

  it('stops for good when the table has closed', async () => {
    vi.useFakeTimers()
    const { connection } = connect()
    await vi.advanceTimersByTimeAsync(0)
    FakeSocket.last().drop(CLOSE_GONE, 'closed')
    expect(connection.getState().status).toBe('closed')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(FakeSocket.all).toHaveLength(1)
  })

  it("starts a new session's hands afresh, though its hand numbers restart", async () => {
    // A six table's sessions each number their hands from 1, under a new
    // matchId. The last session's hand 1 must not lend its record (names,
    // deck check) to the new hand 1, nor crowd it out of the kept hands.
    const { connection } = connect()
    await flush()
    const socket = FakeSocket.last()
    const start = (matchId: string, handNo: number, seq: number) =>
      ({
        t: 'hand_start',
        seq,
        matchId,
        handNo,
        commitment: `${matchId}-${handNo}`,
        button: 0,
        blinds: { sb: 10, bb: 20 },
        stacks: [2000, 2000],
      }) satisfies ServerMsg
    for (let n = 1; n <= 100; n++) {
      socket.emit(start(MATCH, n, 2 * n))
      socket.emit({
        t: 'hand_end',
        seq: 2 * n + 1,
        matchId: MATCH,
        handNo: n,
        record: { handNo: n } as unknown as HandRecordV1,
      })
    }
    socket.emit(start('next-session', 1, 300))
    expect(connection.getState().hands).toEqual({
      1: { commitment: 'next-session-1' },
    })
  })

  it('records the match result', async () => {
    const { connection } = connect()
    await flush()
    FakeSocket.last().emit({
      t: 'match_end',
      seq: 9,
      matchId: MATCH,
      result: { netBySeat: { 0: 120, 1: -120 }, reason: 'complete' },
    })
    expect(connection.getState().ended).toEqual({
      netBySeat: { 0: 120, 1: -120 },
      reason: 'complete',
    })
  })
})

// ---- The link: heartbeat, round trips, and a move that gets no answer -------

/** A welcome stamped with the server's `serverNow`. */
const welcomeAt = (serverNow: number) =>
  ({
    ...frame('welcome', 1, 0, firstHand()),
    serverNow,
  }) as Extract<ServerMsg, { t: 'welcome' }>

describe('TableConnection: the link', () => {
  let clock = 0
  function link(heartbeatMs = PING_EVERY_MS) {
    const connection = new TableConnection(MATCH, async () => 'jwt', {
      origin: 'wss://qp.test',
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      newRequestId: () => 'req1',
      heartbeatMs,
      now: () => clock,
      random: () => 0.5,
    })
    connection.start()
    started.push(connection)
    return connection
  }
  /** Opens the first socket of a fresh connection, with fake timers on. */
  async function opened(heartbeatMs = PING_EVERY_MS) {
    vi.useFakeTimers()
    clock = 0
    const connection = link(heartbeatMs)
    await vi.advanceTimersByTimeAsync(0)
    const socket = FakeSocket.last()
    socket.open()
    return { connection, socket }
  }
  const settle = () => vi.advanceTimersByTimeAsync(0)
  const emitHidden = (visibilityState: 'visible' | 'hidden') => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibilityState,
    })
    document.dispatchEvent(new Event('visibilitychange'))
  }
  afterEach(() => {
    Reflect.deleteProperty(document, 'visibilityState')
  })

  it('sends the literal text ping every interval while open, and not before', async () => {
    vi.useFakeTimers()
    const connection = link()
    await settle()
    const socket = FakeSocket.last()
    await vi.advanceTimersByTimeAsync(PING_EVERY_MS * 3)
    expect(socket.pings).toEqual([]) // connecting: nothing to ping yet
    socket.open()
    await vi.advanceTimersByTimeAsync(PING_EVERY_MS - 1)
    expect(socket.pings).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(socket.pings).toEqual(['ping'])
    await vi.advanceTimersByTimeAsync(PING_EVERY_MS)
    expect(socket.pings).toHaveLength(2)
    // Pings are not frames of the protocol: nothing JSON went out.
    expect(socket.sent).toEqual([])
    connection.stop()
  })

  it('does not ping at all by default', async () => {
    const { connection, socket } = await opened(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(socket.pings).toEqual([])
    expect(connection.getState().status).toBe('open')
  })

  it('takes the pong before parsing it, and it changes nothing', async () => {
    const { connection, socket } = await opened()
    const before = connection.getState()
    const parse = vi.spyOn(JSON, 'parse')
    socket.emitRaw('pong')
    expect(parse).not.toHaveBeenCalled()
    parse.mockRestore()
    expect(connection.getState()).toBe(before)
  })

  it('measures the round trip of each ping, as the median of the last five', async () => {
    const { connection, socket } = await opened()
    socket.answerPings = false
    const roundTrip = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(PING_EVERY_MS)
      clock += ms
      socket.pong()
    }
    expect(connection.rtt.getSnapshot()).toBeNull()
    for (const ms of [300, 20, 40, 60, 80]) await roundTrip(ms)
    expect(connection.rtt.median()).toBe(60)
    expect(connection.rtt.getSnapshot()).toBe(60)
    await roundTrip(100) // 300 falls out: 20 40 60 80 100
    expect(connection.rtt.median()).toBe(60)
  })

  it("does not tell the table's subscribers about a ping or its reply", async () => {
    const { connection, socket } = await opened()
    const listener = vi.fn()
    connection.subscribe(listener)
    await vi.advanceTimersByTimeAsync(PING_EVERY_MS * 4)
    expect(socket.pings.length).toBeGreaterThanOrEqual(3)
    // The round trips went to their own store; the table's state is quiet.
    expect(connection.rtt.getSnapshot()).not.toBeNull()
    expect(listener).not.toHaveBeenCalled()
  })

  it('closes a socket that misses two pongs and reconnects as for any drop', async () => {
    const { connection, socket } = await opened()
    socket.answerPings = false
    await vi.advanceTimersByTimeAsync(PING_EVERY_MS * 2)
    expect(socket.closedWith).toBeNull()
    await vi.advanceTimersByTimeAsync(PING_EVERY_MS)
    expect(socket.closedWith).toBe(1000)
    // At once, without waiting for a close that may never be reported.
    expect(connection.getState().status).toBe('reconnecting')
    await vi.advanceTimersByTimeAsync(499)
    expect(FakeSocket.all).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(FakeSocket.all).toHaveLength(2)
    const again = FakeSocket.last()
    again.open()
    expect(connection.getState().status).toBe('open')
    await vi.advanceTimersByTimeAsync(PING_EVERY_MS)
    expect(again.pings).toEqual(['ping'])
    // The first socket's late close report is not a second drop.
    socket.drop(1006)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(FakeSocket.all).toHaveLength(2)
    connection.stop()
  })

  it('says it is reconnecting the moment the browser goes offline, and acts on nothing meanwhile', async () => {
    const { connection, socket } = await opened(0)
    socket.emit(frame('welcome', 1, 0, firstHand()))
    window.dispatchEvent(new Event('offline'))
    expect(connection.getState().status).toBe('reconnecting')
    expect(connection.act({ type: 'call' })).toBe(false)
    expect(socket.sent).toEqual([])
    connection.stop()
  })

  it('an offline blip that the socket survived is open again at its next frame', async () => {
    const { connection, socket } = await opened(0)
    socket.emit(frame('welcome', 1, 0, firstHand()))
    window.dispatchEvent(new Event('offline'))
    socket.emit(frame('state', 2, 0, firstHand()))
    expect(connection.getState().status).toBe('open')
    connection.stop()
  })

  it('reconnects at once when the network comes back, with the patience renewed', async () => {
    const { connection } = await opened(0)
    FakeSocket.last().drop()
    expect(connection.getState().status).toBe('reconnecting')
    window.dispatchEvent(new Event('online'))
    await settle()
    expect(FakeSocket.all).toHaveLength(2) // before the 500 ms backoff
    FakeSocket.last().open()
    expect(connection.getState().status).toBe('open')
    // The first socket's backoff timer is gone: no third socket.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(FakeSocket.all).toHaveLength(2)
    connection.stop()
  })

  it('offline then online: a new socket, and the old one is closed', async () => {
    const { connection, socket } = await opened(0)
    window.dispatchEvent(new Event('offline'))
    window.dispatchEvent(new Event('online'))
    await settle()
    expect(socket.closedWith).toBe(1000)
    expect(FakeSocket.all).toHaveLength(2)
    connection.stop()
  })

  it('probes a visible tab at once and reconnects if nothing is heard in time', async () => {
    const { connection, socket } = await opened()
    socket.answerPings = false
    emitHidden('hidden')
    expect(socket.pings).toEqual([])
    emitHidden('visible')
    expect(socket.pings).toEqual(['ping'])
    await vi.advanceTimersByTimeAsync(PROBE_MS - 1)
    expect(socket.closedWith).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(socket.closedWith).toBe(1000)
    expect(connection.getState().status).toBe('reconnecting')
    connection.stop()
  })

  it('keeps a visible tab whose socket answers the probe', async () => {
    const { connection, socket } = await opened() // answers pings
    emitHidden('visible')
    await vi.advanceTimersByTimeAsync(PROBE_MS + 1)
    expect(socket.closedWith).toBeNull()
    expect(connection.getState().status).toBe('open')
    connection.stop()
  })

  it('stops listening to the window and clears every timer on stop', async () => {
    const { connection, socket } = await opened()
    socket.answerPings = false
    connection.act({ type: 'call' }) // no hand: nothing sent, nothing pending
    socket.emit(frame('welcome', 1, 0, firstHand()))
    expect(connection.act({ type: 'call' })).toBe(true) // watchdog armed
    emitHidden('visible') // a probe armed
    expect(vi.getTimerCount()).toBeGreaterThan(1)
    connection.stop()
    expect(vi.getTimerCount()).toBe(0)
    window.dispatchEvent(new Event('online'))
    window.dispatchEvent(new Event('offline'))
    emitHidden('visible')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(FakeSocket.all).toHaveLength(1)
    expect(connection.getState().status).toBe('open')
  })

  describe('a move that gets no answer', () => {
    it('asks for the truth after 3 s, then closes a socket that says nothing more', async () => {
      const { connection, socket } = await opened(0)
      socket.emit(frame('welcome', 1, 0, firstHand()))
      expect(connection.act({ type: 'call' })).toBe(true)
      await vi.advanceTimersByTimeAsync(PENDING_WATCHDOG_MS - 1)
      expect(socket.sent).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(socket.sent.map((m) => JSON.parse(m).t)).toEqual(['act', 'resync'])
      expect(socket.closedWith).toBeNull()
      await vi.advanceTimersByTimeAsync(RESYNC_WAIT_MS)
      expect(socket.closedWith).toBe(1000)
      expect(connection.getState()).toMatchObject({
        status: 'reconnecting',
        pending: null,
      })
      // The move is never sent again, by the watchdog or the reconnect.
      await vi.advanceTimersByTimeAsync(500)
      FakeSocket.last().open()
      expect(
        FakeSocket.all.flatMap((s) => s.sent).filter((m) => /"act"/.test(m)),
      ).toHaveLength(1)
      connection.stop()
    })

    it('does not close a socket whose welcome answered the resync', async () => {
      const { connection, socket } = await opened(0)
      socket.emit(frame('welcome', 1, 0, firstHand()))
      connection.act({ type: 'call' })
      await vi.advanceTimersByTimeAsync(PENDING_WATCHDOG_MS)
      socket.emit(frame('welcome', 2, 0, firstHand()))
      expect(connection.getState().pending).toBeNull()
      await vi.advanceTimersByTimeAsync(RESYNC_WAIT_MS * 2)
      expect(socket.closedWith).toBeNull()
      expect(vi.getTimerCount()).toBe(0)
      connection.stop()
    })

    it('says nothing when the move is acknowledged in time', async () => {
      const { connection, socket } = await opened(0)
      const hand = firstHand()
      socket.emit(frame('welcome', 1, 0, hand))
      connection.act({ type: 'call' })
      await vi.advanceTimersByTimeAsync(PENDING_WATCHDOG_MS - 1)
      socket.emit(
        frame('state', 2, 0, engineAct(hand, 0, { type: 'call' }), 'req1'),
      )
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(PENDING_WATCHDOG_MS * 3)
      expect(socket.sent).toHaveLength(1)
      expect(socket.closedWith).toBeNull()
      connection.stop()
    })

    it('counts the heartbeat as the link, not as the table answering', async () => {
      const { connection, socket } = await opened() // pongs arrive
      socket.emit(frame('welcome', 1, 0, firstHand()))
      connection.act({ type: 'call' })
      await vi.advanceTimersByTimeAsync(PENDING_WATCHDOG_MS + RESYNC_WAIT_MS)
      // Pongs came back, yet the table said nothing to the resync.
      expect(socket.closedWith).toBe(1000)
      connection.stop()
    })
  })

  describe('the clock', () => {
    it('is the raw difference before a ping has measured the link', async () => {
      const { connection, socket } = await opened(0)
      vi.setSystemTime(1_000)
      socket.emit(welcomeAt(5_000))
      expect(connection.getState().clockOffset).toBe(4_000)
      connection.stop()
    })

    it('adds half the median round trip once there is one', async () => {
      const { connection, socket } = await opened()
      socket.answerPings = false
      await vi.advanceTimersByTimeAsync(PING_EVERY_MS)
      clock += 40
      socket.pong()
      vi.setSystemTime(1_000_000)
      socket.emit(welcomeAt(5_000))
      expect(connection.getState().clockOffset).toBe(5_000 + 20 - 1_000_000)
      connection.stop()
    })
  })
})

// ---- The host's invite frame -------------------------------------------------

describe('TableConnection: the host of an invite table', () => {
  const REQ = '0123456789abcdef'
  const asks = [
    { id: REQ, username: 'bob', ageMs: 1500 },
    { id: 'fedcba9876543210', username: 'carol', ageMs: 200 },
  ]
  async function host() {
    const { connection } = connect()
    await flush()
    const socket = FakeSocket.last()
    socket.open()
    socket.emit(frame('welcome', 1, 0, null))
    return { connection, socket }
  }
  afterEach(() => vi.useRealTimers())

  it('keeps the invite apart from the table: a frame never replaces view or table', async () => {
    const { connection, socket } = await host()
    const before = connection.getState()
    socket.emit(inviteFrame(2, { code: 'ABC234', requests: asks }))
    const state = connection.getState()
    expect(state.invite).toMatchObject({
      code: 'ABC234',
      listed: false,
      requests: asks,
      reservedFor: null,
      answering: null,
    })
    expect(state.table).toBe(before.table)
    expect(state.view).toBe(before.view)
    expect(state.seat).toBe(0)
    // The invite is a snapshot: a later one replaces it whole.
    socket.emit(
      inviteFrame(3, { code: null, listed: true, reservedFor: 'bob' }),
    )
    expect(connection.getState().invite).toMatchObject({
      code: null,
      listed: true,
      requests: [],
      reservedFor: 'bob',
    })
  })

  it('dates a reservation from the first frame that names the account', async () => {
    const { connection, socket } = await host()
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    socket.emit(inviteFrame(2, { reservedFor: 'bob' }))
    expect(connection.getState().invite?.reservedAt).toBe(10_000)
    vi.setSystemTime(20_000)
    socket.emit(inviteFrame(3, { reservedFor: 'bob' }))
    expect(connection.getState().invite?.reservedAt).toBe(10_000)
    socket.emit(inviteFrame(4, { reservedFor: 'carol' }))
    expect(connection.getState().invite?.reservedAt).toBe(20_000)
    socket.emit(inviteFrame(5))
    expect(connection.getState().invite?.reservedAt).toBeNull()
  })

  it('rebuilds what it keeps by name and drops what is malformed', () => {
    expect(
      readRequests([
        { id: REQ, username: 'bob', ageMs: 5, userId: 'u-1', matchId: 'm' },
        { id: 'r1', username: 'bad id', ageMs: 5 },
        { id: REQ, username: 7, ageMs: 5 },
        { id: REQ, username: 'x'.repeat(100), ageMs: 5 },
        { id: REQ, username: 'neg', ageMs: -1 },
        null,
        'bob',
      ]),
    ).toEqual([
      { id: REQ, username: 'bob', ageMs: 5 },
      { id: REQ, username: 'x'.repeat(40), ageMs: 5 },
    ])
    expect(readRequests('nope')).toEqual([])
  })

  it('sends an answer naming only the request, and waits for the next frame', async () => {
    const { connection, socket } = await host()
    socket.emit(inviteFrame(2, { requests: asks }))
    expect(connection.answer(REQ, true)).toBe(true)
    expect(socket.sent.map((m) => JSON.parse(m))).toEqual([
      { t: 'join_answer', requestId: REQ, accept: true },
    ])
    expect(connection.getState().invite?.answering).toBe(REQ)
    // One at a time, until the table's frame comes.
    expect(connection.answer('fedcba9876543210', false)).toBe(false)
    socket.emit(inviteFrame(3, { reservedFor: 'bob' }))
    expect(connection.getState().invite?.answering).toBeNull()
  })

  it('answers only a request it was told of, on an open socket', async () => {
    const { connection, socket } = await host()
    expect(connection.answer(REQ, true)).toBe(false) // no invite yet
    socket.emit(inviteFrame(2, { requests: asks }))
    expect(connection.answer('0000000000000000', true)).toBe(false)
    expect(socket.sent).toEqual([])
  })

  it('gives the buttons back if the frame that should confirm never comes', async () => {
    const { connection, socket } = await host()
    vi.useFakeTimers()
    socket.emit(inviteFrame(2, { requests: asks }))
    connection.answer(REQ, false)
    await vi.advanceTimersByTimeAsync(ANSWER_WAIT_MS - 1)
    expect(connection.getState().invite?.answering).toBe(REQ)
    await vi.advanceTimersByTimeAsync(1)
    expect(connection.getState().invite?.answering).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('forgets the invite when the socket goes: the next welcome brings a fresh one', async () => {
    const { connection, socket } = await host()
    socket.emit(inviteFrame(2, { requests: asks }))
    socket.drop(1006)
    expect(connection.getState().invite).toBeNull()
  })

  it('tolerates an invite with a wrong shape', async () => {
    const { connection, socket } = await host()
    socket.emit({
      ...inviteFrame(2),
      code: 'abc',
      requests: 'x',
      reservedFor: 5,
    } as never)
    expect(connection.getState().invite).toMatchObject({
      code: null,
      requests: [],
      reservedFor: null,
    })
  })
})
