// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { lcg } from '../lib/sim'
import { MAX_FRAME, parseClientMsg } from './protocol'
import type { MatchKind } from './protocol'

const frame = (v: unknown) => JSON.stringify(v)
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
        ]).toContain(msg.t)
    }
  })

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
})
