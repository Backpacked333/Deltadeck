import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act as engineAct } from '../engine/hand'
import { CLOSE_ABUSE, CLOSE_GONE, CLOSE_RATE_LIMITED } from '../shared/protocol'
import type { HandRecordV1, ServerMsg } from '../shared/protocol'
import { TableConnection } from './client'
import { FakeSocket, firstHand, frame, MATCH, sixFrame } from './testing'

const flush = () => new Promise((r) => setTimeout(r, 0))

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
  return { connection, getToken }
}

beforeEach(() => {
  FakeSocket.all = []
})
afterEach(() => vi.useRealTimers())

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
    expect(other.sent.map((m) => JSON.parse(m))).toEqual([{ t: 'sit', seat: 4 }])
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
