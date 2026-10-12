// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { lcg } from '../lib/sim'
import { MAX_FRAME, parseClientMsg, QUICK_SIT_TABLES } from './protocol'
import type { MatchKind } from './protocol'

const frame = (v: unknown) => JSON.stringify(v)
// Table ids are the lobby's crypto.randomUUID().
const T1 = '0b7c4a52-6f0e-4d7b-9b55-3c1f2a9e8d01'
const T2 = '1c8d5b63-7a1f-4e8c-8c66-4d2a3b0f9e12'
const T3 = '2d9e6c74-8b2a-4f9d-9d77-5e3b4c1a0f23'
const T4 = '3e0f7d85-9c3b-4a0e-ae88-6f4c5d2b1a34'
const act = {
  t: 'act',
  reqId: 'r-1_a',
  handNo: 3,
  actionIndex: 0,
  action: { type: 'raise', to: 60 },
}

describe('parseClientMsg', () => {
  it('accepts every well-formed message', () => {
    expect(parseClientMsg(frame(act))).toEqual(act)
    for (const type of ['fold', 'check', 'call'])
      expect(parseClientMsg(frame({ ...act, action: { type } }))).toEqual({
        ...act,
        action: { type },
      })
    expect(parseClientMsg(frame({ t: 'resync' }))).toEqual({ t: 'resync' })
    expect(parseClientMsg(frame({ t: 'dequeue' }))).toEqual({ t: 'dequeue' })
    expect(parseClientMsg(frame({ t: 'rematch' }))).toEqual({ t: 'rematch' })
    expect(parseClientMsg(frame({ t: 'queue', kind: 'hu-casual' }))).toEqual({
      t: 'queue',
      kind: 'hu-casual',
    })
    expect(parseClientMsg(frame({ t: 'queue', kind: 'hu-rated' }))).toEqual({
      t: 'queue',
      kind: 'hu-rated',
    })
    // Sit anywhere free, or in a named seat 0..5.
    expect(parseClientMsg(frame({ t: 'sit' }))).toEqual({ t: 'sit' })
    for (const seat of [0, 3, 5])
      expect(parseClientMsg(frame({ t: 'sit', seat }))).toEqual({
        t: 'sit',
        seat,
      })
    expect(parseClientMsg(frame({ t: 'stand' }))).toEqual({ t: 'stand' })
    // A rebuy names nothing: the server computes the amount from the stack.
    expect(parseClientMsg(frame({ t: 'rebuy' }))).toEqual({ t: 'rebuy' })
    // Sitting out and back in name nothing either: the seat is the
    // socket account's own (ADR amendment 2026-10-10, "Sitting out").
    expect(parseClientMsg(frame({ t: 'sit_out' }))).toEqual({ t: 'sit_out' })
    expect(parseClientMsg(frame({ t: 'sit_in' }))).toEqual({ t: 'sit_in' })
    // In the lobby: quick-sit, bare or with the tables it tried, and the
    // list of six tables (P2-08).
    expect(parseClientMsg(frame({ t: 'quick_sit' }))).toEqual({
      t: 'quick_sit',
    })
    expect(parseClientMsg(frame({ t: 'quick_sit', tried: [T1] }))).toEqual({
      t: 'quick_sit',
      tried: [T1],
    })
    expect(parseClientMsg(frame({ t: 'tables' }))).toEqual({ t: 'tables' })
  })

  it('rejects malformed messages', () => {
    for (const bad of [
      'not json',
      frame(null),
      frame([act]),
      frame({ ...act, extra: 1 }),
      frame({ ...act, handNo: 0 }),
      frame({ ...act, handNo: 1.5 }),
      frame({ ...act, actionIndex: -1 }),
      frame({ ...act, reqId: '' }),
      frame({ ...act, reqId: 'x'.repeat(65) }),
      frame({ ...act, reqId: 'has space' }),
      frame({ ...act, action: { type: 'raise' } }),
      frame({ ...act, action: { type: 'raise', to: 10.5 } }),
      frame({ ...act, action: { type: 'raise', to: '60' } }),
      frame({ ...act, action: { type: 'call', to: 60 } }),
      frame({ ...act, action: { type: 'shove' } }),
      frame({ t: 'resync', x: 1 }),
      frame({ t: 'rematch', matchId: 'x' }),
      frame({ t: 'queue', kind: 'six-max' }),
      // A seat is an integer 0..5, and who sits comes only from the token:
      // no account, name or stack in the frame.
      frame({ t: 'sit', seat: 6 }),
      frame({ t: 'sit', seat: -1 }),
      frame({ t: 'sit', seat: 1.5 }),
      frame({ t: 'sit', seat: '1' }),
      frame({ t: 'sit', seat: null }),
      frame({ t: 'sit', seat: 2, x: 1 }),
      frame({ t: 'sit', userId: 'u1' }),
      frame({ t: 'sit', seat: 2, username: 'u1' }),
      frame({ t: 'sit', seat: 2, stack: 4000 }),
      // A stand names nothing: the seat is the socket account's own.
      frame({ t: 'stand', seat: 2 }),
      frame({ t: 'stand', userId: 'u1' }),
      frame({ t: 'stand', x: 1 }),
      frame({ t: 'stand', stack: 0 }),
      // A rebuy carries no amount, stack, seat or account: the top-up is
      // always to 100 bb, for the socket's own seat.
      frame({ t: 'rebuy', amount: 500 }),
      frame({ t: 'rebuy', amount: 0 }),
      frame({ t: 'rebuy', to: 2000 }),
      frame({ t: 'rebuy', stack: 4000 }),
      frame({ t: 'rebuy', seat: 2 }),
      frame({ t: 'rebuy', userId: 'u1' }),
      frame({ t: 'rebuy', x: 1 }),
      frame({ t: 'rebuy', amount: null }),
      // Sit out and sit in name no seat, account, stack or time: they are
      // the socket account's own, from the next hand.
      frame({ t: 'sit_out', seat: 2 }),
      frame({ t: 'sit_out', userId: 'u1' }),
      frame({ t: 'sit_out', hands: 3 }),
      frame({ t: 'sit_out', x: 1 }),
      frame({ t: 'sit_in', seat: 2 }),
      frame({ t: 'sit_in', userId: 'u1' }),
      frame({ t: 'sit_in', stack: 2000 }),
      frame({ t: 'sit_in', timeouts: 0 }),
      frame({ t: 'sit_in', x: 1 }),
      frame({ t: 'sitout' }),
      frame({ t: 'sit-in' }),
      frame({ t: 'hello' }),
      frame({ ...act, reqId: 'a'.repeat(MAX_FRAME) }),
    ])
      expect(parseClientMsg(bad), bad.slice(0, 60)).toBeNull()
    expect(parseClientMsg(42)).toBeNull()
    expect(parseClientMsg(' '.repeat(MAX_FRAME + 1))).toBeNull()
  })

  it('refuses to queue for six-casual: a six table is joined by sitting down', () => {
    const kind: MatchKind = 'six-casual'
    expect(parseClientMsg(frame({ t: 'queue', kind }))).toBeNull()
  })

  it('never throws on random input and only returns valid shapes', () => {
    const random = lcg(8)
    const pick = <T>(xs: T[]) => xs[Math.floor(random() * xs.length)]
    const value = (depth: number): unknown => {
      const roll = random()
      if (depth > 3 || roll < 0.3)
        return pick([
          0,
          1,
          -1,
          2.5,
          1e21,
          NaN,
          '',
          'act',
          'raise',
          'hu-casual',
          'sit',
          'stand',
          'rebuy',
          'sit_in',
          'sit_out',
          'quick_sit',
          'tables',
          'join_answer',
          'games',
          'join_code',
          'ABC234',
          T1,
          'r1',
          5,
          6,
          true,
          null,
        ])
      if (roll < 0.5) return Array.from({ length: 3 }, () => value(depth + 1))
      const keys = [
        't',
        'reqId',
        'handNo',
        'actionIndex',
        'action',
        'type',
        'to',
        'kind',
        'seat',
        'amount',
        'tried',
        'requestId',
        'accept',
        'gameId',
        'code',
        'x',
      ]
      return Object.fromEntries(
        keys.filter(() => random() < 0.5).map((k) => [k, value(depth + 1)]),
      )
    }
    for (let i = 0; i < 20_000; i++) {
      const raw =
        random() < 0.1
          ? 'x' + JSON.stringify(value(0))
          : JSON.stringify(value(0))
      const msg = parseClientMsg(raw ?? 'undefined')
      if (msg)
        expect([
          'act',
          'resync',
          'queue',
          'dequeue',
          'rematch',
          'sit',
          'stand',
          'rebuy',
          'sit_in',
          'sit_out',
          'quick_sit',
          'tables',
          'join_answer',
          'games',
          'join_request',
          'cancel_request',
          'join_code',
        ]).toContain(msg.t)
    }
  }, 30_000)

  it('accepts a sit only as a seat 0..5 or none, whatever else it carries', () => {
    const random = lcg(9)
    const pick = <T>(xs: T[]) => xs[Math.floor(random() * xs.length)]
    const values = [0, 1, 5, 6, -1, 2.5, 1e21, NaN, '', '3', null, true, [], {}]
    const accepted = { seat: 0, none: 0 }
    for (let i = 0; i < 5000; i++) {
      const extra = ['seat', 'userId', 'username', 'stack', 'x'].filter(
        () => random() < 0.4,
      )
      const sent = {
        t: 'sit',
        ...Object.fromEntries(extra.map((k) => [k, pick(values)])),
      }
      const msg = parseClientMsg(frame(sent))
      if (!msg) continue
      expect(msg.t).toBe('sit')
      // Nothing but the seat survives, and only as a seat number.
      expect(Object.keys(msg).filter((k) => k !== 't' && k !== 'seat')).toEqual(
        [],
      )
      if (msg.t !== 'sit') continue
      if (msg.seat === undefined) accepted.none++
      else {
        accepted.seat++
        expect([0, 1, 2, 3, 4, 5]).toContain(msg.seat)
      }
    }
    // Both shapes come through: no seat, and a seat 0..5.
    expect(accepted.none).toBeGreaterThan(100)
    expect(accepted.seat).toBeGreaterThan(20)
  })

  it('accepts a stand only bare, whatever else it carries', () => {
    const random = lcg(10)
    const pick = <T>(xs: T[]) => xs[Math.floor(random() * xs.length)]
    const values = [0, 1, 5, -1, '', 'k0', null, true, [], {}]
    let bare = 0
    for (let i = 0; i < 5000; i++) {
      const extra = ['seat', 'userId', 'username', 'stack', 'x'].filter(
        () => random() < 0.3,
      )
      const sent = {
        t: 'stand',
        ...Object.fromEntries(extra.map((k) => [k, pick(values)])),
      }
      const msg = parseClientMsg(frame(sent))
      // Anything beyond the type is refused, never ignored.
      expect(msg, JSON.stringify(sent)).toEqual(
        extra.length ? null : { t: 'stand' },
      )
      if (msg) bare++
    }
    expect(bare).toBeGreaterThan(500)
  })

  it('accepts a rebuy only bare, so no amount ever reaches the server', () => {
    const random = lcg(11)
    const pick = <T>(xs: T[]) => xs[Math.floor(random() * xs.length)]
    const values = [0, 1, 500, 2000, -1, 1e21, '', '2000', null, true, [], {}]
    let bare = 0
    for (let i = 0; i < 5000; i++) {
      const extra = [
        'amount',
        'to',
        'stack',
        'chips',
        'seat',
        'userId',
        'x',
      ].filter(() => random() < 0.25)
      const sent = {
        t: 'rebuy',
        ...Object.fromEntries(extra.map((k) => [k, pick(values)])),
      }
      const msg = parseClientMsg(frame(sent))
      // Anything beyond the type is refused, never ignored.
      expect(msg, JSON.stringify(sent)).toEqual(
        extra.length ? null : { t: 'rebuy' },
      )
      if (msg) bare++
    }
    expect(bare).toBeGreaterThan(500)
  })

  it('accepts a sit_in or sit_out only bare, whatever else it carries', () => {
    const random = lcg(12)
    const pick = <T>(xs: T[]) => xs[Math.floor(random() * xs.length)]
    const values = [0, 1, 2, 5, -1, '', 'k0', null, true, [], {}]
    const bare = { sit_in: 0, sit_out: 0 }
    for (let i = 0; i < 5000; i++) {
      const t = pick(['sit_in', 'sit_out'] as const)
      const extra = [
        'seat',
        'userId',
        'username',
        'stack',
        'timeouts',
        'status',
        'x',
      ].filter(() => random() < 0.25)
      const sent = {
        t,
        ...Object.fromEntries(extra.map((k) => [k, pick(values)])),
      }
      const msg = parseClientMsg(frame(sent))
      // Anything beyond the type is refused, never ignored: no frame
      // chooses whose seat, or what status, or how many timeouts.
      expect(msg, JSON.stringify(sent)).toEqual(extra.length ? null : { t })
      if (msg) bare[t]++
    }
    expect(bare.sit_in).toBeGreaterThan(300)
    expect(bare.sit_out).toBeGreaterThan(300)
  })

  it('accepts a quick_sit only bare or with up to three distinct table ids it tried', () => {
    expect(QUICK_SIT_TABLES).toBe(3)
    expect(
      parseClientMsg(frame({ t: 'quick_sit', tried: [T1, T2, T3] })),
    ).toEqual({ t: 'quick_sit', tried: [T1, T2, T3] })
    for (const bad of [
      // Nothing names a player, a seat or a table to take: the lobby picks.
      { t: 'quick_sit', userId: 'eve' },
      { t: 'quick_sit', seat: 2 },
      { t: 'quick_sit', tableId: T1 },
      // `tried` is one to three distinct table ids, or absent.
      { t: 'quick_sit', tried: [] },
      { t: 'quick_sit', tried: [T1, T2, T3, T4] },
      { t: 'quick_sit', tried: [T1, T1] },
      { t: 'quick_sit', tried: T1 },
      { t: 'quick_sit', tried: [T1.toUpperCase()] },
      { t: 'quick_sit', tried: ['host'] },
      { t: 'quick_sit', tried: [`${T1}x`] },
      { t: 'quick_sit', tried: [1] },
      { t: 'quick_sit', tried: [null] },
      { t: 'quick_sit', tried: null },
      { t: 'quick_sit', tried: { 0: T1 } },
      // The list request is bare.
      { t: 'tables', kind: 'six-casual' },
      { t: 'tables', tableId: T1 },
    ])
      expect(parseClientMsg(frame(bad)), JSON.stringify(bad)).toBeNull()
  })
})

describe('live game frames', () => {
  const GAME = 'a'.repeat(32)
  const REQ = '0123456789abcdef'

  it('parses the lobby and host frames, and nothing extra', () => {
    expect(parseClientMsg(frame({ t: 'games' }))).toEqual({ t: 'games' })
    expect(parseClientMsg(frame({ t: 'cancel_request' }))).toEqual({
      t: 'cancel_request',
    })
    expect(parseClientMsg(frame({ t: 'join_request', gameId: GAME }))).toEqual({
      t: 'join_request',
      gameId: GAME,
    })
    expect(
      parseClientMsg(
        frame({ t: 'join_answer', requestId: REQ, accept: false }),
      ),
    ).toEqual({ t: 'join_answer', requestId: REQ, accept: false })
  })

  it('refuses a malformed handle, request id or answer', () => {
    for (const bad of [
      { t: 'join_request', gameId: GAME.toUpperCase() },
      { t: 'join_request', gameId: GAME.slice(1) },
      { t: 'join_request', gameId: GAME, x: 1 },
      { t: 'join_request' },
      { t: 'games', x: 1 },
      { t: 'cancel_request', gameId: GAME },
      { t: 'join_answer', requestId: REQ, accept: 'yes' },
      { t: 'join_answer', requestId: REQ },
      { t: 'join_answer', requestId: 'r1', accept: true },
      { t: 'join_answer', requestId: REQ, accept: true, userId: 'u' },
    ])
      expect(parseClientMsg(frame(bad))).toBeNull()
  })

  it('takes a code only as the cleaned one', () => {
    expect(parseClientMsg(frame({ t: 'join_code', code: 'abc-234' }))).toEqual({
      t: 'join_code',
      code: 'ABC234',
    })
    for (const bad of [
      'ABC23',
      'ABC2345',
      'ABC230',
      'ABCIL2',
      '',
      'x'.repeat(17),
    ])
      expect(parseClientMsg(frame({ t: 'join_code', code: bad }))).toBeNull()
    expect(parseClientMsg(frame({ t: 'join_code', code: 234567 }))).toBeNull()
    expect(
      parseClientMsg(frame({ t: 'join_code', code: 'ABC234', x: 1 })),
    ).toBeNull()
  })
})
