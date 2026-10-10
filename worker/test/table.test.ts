import {
  abortAllDurableObjects,
  env,
  runInDurableObject,
  SELF,
} from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { legalActions } from '../../src/engine/hand'
import type { HandState } from '../../src/engine/types'
import type { ServerMsg } from '../../src/shared/protocol'
import {
  connect,
  createTable,
  elapse,
  isState,
  ORIGIN,
  peek,
  stub,
  token,
} from './helpers'
import type { Client } from './helpers'
import { NEXT_HAND_MS } from '../src/table'

const views = (frames: ServerMsg[]) =>
  frames.flatMap((f) =>
    (f.t === 'state' || f.t === 'welcome') && f.view ? [f.view] : [],
  )

/** Plays checks and calls from the server's real state until the hand ends. */
async function playOut(matchId: string, clients: Record<number, Client>) {
  for (let guard = 0; guard < 20; guard++) {
    const { hand } = await peek(matchId)
    if (!hand || hand.street === 'showdown') return hand
    const seat = hand.toAct!
    const legal = legalActions(hand)
    const from = clients[seat].frames.length
    clients[seat].send({
      t: 'act',
      reqId: `r${hand.config.handNo}-${hand.actions.length}`,
      handNo: hand.config.handNo,
      actionIndex: hand.actions.length,
      action: legal.canCheck ? { type: 'check' } : { type: 'call' },
    })
    await clients[seat].next(
      isState(hand.config.handNo, hand.actions.length + 1),
      from,
    )
  }
  throw new Error('hand did not finish')
}

async function seatBoth(handsTotal?: number) {
  const matchId = await createTable('alice', handsTotal)
  const alice = await connect(matchId, 'alice')
  const bob = await connect(matchId, 'bob')
  await alice.next(isState(1))
  await bob.next(isState(1))
  return {
    matchId,
    alice,
    bob,
    clients: { 0: alice, 1: bob } as Record<number, Client>,
  }
}

describe('worker routes', () => {
  it('serves health and browser-safe config', async () => {
    const health = await SELF.fetch(`${ORIGIN}/api/health`)
    expect(await health.json()).toEqual({ ok: true, protocol: 'qp.v1' })
    const config = (await (
      await SELF.fetch(`${ORIGIN}/api/config`)
    ).json()) as Record<string, string>
    expect(config.supabaseUrl).toBe(env.SUPABASE_URL)
    expect(config.supabaseKey).toMatch(/^sb_publishable_/)
    expect(JSON.stringify(config)).not.toMatch(/service_role|secret/i)
    expect((await SELF.fetch(`${ORIGIN}/api/nope`)).status).toBe(404)
  })

  it('creates a match only for a signed-in caller', async () => {
    const anonymous = await SELF.fetch(`${ORIGIN}/api/matches`, {
      method: 'POST',
    })
    expect(anonymous.status).toBe(401)
    const forged = await SELF.fetch(`${ORIGIN}/api/matches`, {
      method: 'POST',
      headers: { Authorization: 'Bearer dev.alice.wrong' },
    })
    expect(forged.status).toBe(401)
    const created = await SELF.fetch(`${ORIGIN}/api/matches`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token('alice')}` },
    })
    expect(created.status).toBe(201)
    const { matchId } = (await created.json()) as { matchId: string }
    expect(matchId).toMatch(/^[0-9a-f-]{36}$/)
    const alice = await connect(matchId, 'alice')
    const welcome = await alice.next((f) => f.t === 'welcome')
    expect(welcome).toMatchObject({ t: 'welcome', seat: 0, view: null })
  })

  it('refuses sockets without the protocol, a token, or an upgrade', async () => {
    const matchId = await createTable('alice')
    const url = `${ORIGIN}/ws/table/${matchId}`
    expect((await SELF.fetch(url)).status).toBe(426)
    const old = await SELF.fetch(url, {
      headers: {
        Upgrade: 'websocket',
        Origin: ORIGIN,
        'Sec-WebSocket-Protocol': `qp.v0, bearer.${token('a')}`,
      },
    })
    expect(old.status).toBe(426)
    const unsigned = await SELF.fetch(url, {
      headers: {
        Upgrade: 'websocket',
        Origin: ORIGIN,
        'Sec-WebSocket-Protocol': 'qp.v1',
      },
    })
    expect(unsigned.status).toBe(401)
    const forged = await SELF.fetch(url, {
      headers: {
        Upgrade: 'websocket',
        Origin: ORIGIN,
        'Sec-WebSocket-Protocol': 'qp.v1, bearer.dev.bob.nope',
      },
    })
    expect(forged.status).toBe(401)
  })
})

describe('a heads-up table', () => {
  it('waits for both players, then deals hand 1', async () => {
    const matchId = await createTable('alice')
    const alice = await connect(matchId, 'alice')
    const waiting = await alice.next((f) => f.t === 'welcome')
    expect(waiting).toMatchObject({ view: null, table: { status: 'waiting' } })
    const bob = await connect(matchId, 'bob')
    const dealt = await bob.next(isState(1))
    expect(dealt.t === 'welcome' || dealt.t === 'state').toBe(true)
    if (dealt.t !== 'state' && dealt.t !== 'welcome') return
    expect(dealt.table.status).toBe('playing')
    expect(dealt.table.players.map((p) => [p.username, p.connected])).toEqual([
      ['alice', true],
      ['bob', true],
    ])
    expect(dealt.view!.you).toBe(1)
  })

  it('never tells a seat the other seat’s cards before showdown', async () => {
    const { matchId, alice, bob, clients } = await seatBoth()
    const hand = (await peek(matchId)).hand as HandState
    const [mine, theirs] = [hand.players[0].cards!, hand.players[1].cards!]
    await playOut(matchId, clients)
    for (const [client, own, other] of [
      [alice, mine, theirs],
      [bob, theirs, mine],
    ] as const) {
      const seen = views(client.frames).filter((v) => v.handNo === 1)
      for (const view of seen) {
        expect(view.players[view.you!].cards).toEqual(own)
        const opponent = view.players[1 - view.you!]
        expect(opponent.cards).toEqual(opponent.shown ? other : null)
        expect(JSON.stringify(view)).not.toContain('"deck"')
      }
      expect(seen.at(-1)!.players[1 - seen.at(-1)!.you!].shown).toBe(true)
    }
  })

  it('rejects out-of-turn, stale, and illegal moves, and re-acks a retry', async () => {
    const { matchId, clients } = await seatBoth()
    const { hand } = await peek(matchId)
    const actor = hand!.toAct!
    const idle = 1 - actor
    const base = { t: 'act' as const, handNo: 1, actionIndex: 0 }

    const idleFrom = clients[idle].frames.length
    clients[idle].send({ ...base, reqId: 'x1', action: { type: 'call' } })
    expect(
      await clients[idle].next((f) => f.t === 'error', idleFrom),
    ).toMatchObject({
      code: 'not_your_turn',
      reqId: 'x1',
    })

    let from = clients[actor].frames.length
    clients[actor].send({
      ...base,
      reqId: 'x2',
      action: { type: 'raise', to: 21 },
    })
    expect(
      await clients[actor].next((f) => f.t === 'error', from),
    ).toMatchObject({
      code: 'illegal',
    })

    from = clients[actor].frames.length
    clients[actor].send({
      ...base,
      actionIndex: 3,
      reqId: 'x3',
      action: { type: 'call' },
    })
    expect(
      await clients[actor].next((f) => f.t === 'error', from),
    ).toMatchObject({
      code: 'stale',
    })

    from = clients[actor].frames.length
    clients[actor].send({ ...base, reqId: 'ok1', action: { type: 'call' } })
    const acked = await clients[actor].next(isState(1, 1), from)
    expect(acked.t === 'state' && acked.view?.lastReqId).toBe('ok1')

    // The same request again (a retry after a flaky network) changes nothing.
    from = clients[actor].frames.length
    clients[actor].send({ ...base, reqId: 'ok1', action: { type: 'call' } })
    await clients[actor].next(isState(1, 1), from)
    expect((await peek(matchId)).hand!.actions).toHaveLength(1)

    from = clients[actor].frames.length
    clients[actor].ws.send('{"t":"act","nope":1}')
    expect(
      await clients[actor].next((f) => f.t === 'error', from),
    ).toMatchObject({
      code: 'illegal',
    })
  })

  it('re-acks a retry whose ack was stored by seat before acks were keyed by account', async () => {
    const { matchId, clients } = await seatBoth()
    const { hand, match } = await peek(matchId)
    const actor = hand!.toAct!
    const base = { t: 'act' as const, handNo: 1, actionIndex: 0 }
    let from = clients[actor].frames.length
    clients[actor].send({ ...base, reqId: 'old1', action: { type: 'call' } })
    await clients[actor].next(isState(1, 1), from)
    // The object as an earlier deploy left it: the ack under the seat.
    const userId = match.players.find((p) => p.seat === actor)!.userId
    await runInDurableObject(stub(matchId), (instance) => {
      const t = instance as unknown as {
        lastAck: Record<string, { reqId: string; seq: number }>
      }
      t.lastAck[String(actor)] = t.lastAck[userId]
      delete t.lastAck[userId]
    })
    from = clients[actor].frames.length
    clients[actor].send({ ...base, reqId: 'old1', action: { type: 'call' } })
    const again = await clients[actor].next(
      (f) => f.t === 'state' || f.t === 'error',
      from,
    )
    expect(again.t).toBe('state')
    expect(again.t === 'state' && again.view?.lastReqId).toBe('old1')
    expect((await peek(matchId)).hand!.actions).toHaveLength(1)
  })

  it('deals the next hand with the button moved, and ends the match', async () => {
    const { matchId, alice, clients } = await seatBoth(2)
    await playOut(matchId, clients)
    const first = await peek(matchId)
    expect(first.hand!.config.button).toBe(0)
    expect(await elapse(matchId, NEXT_HAND_MS)).toBe(true)
    await alice.next(isState(2))
    const second = await peek(matchId)
    expect(second.hand!.config.button).toBe(1)
    // Hand 2: seat 1 has the button and posts the small blind.
    expect(second.hand!.players.map((p) => p.stack)).toEqual([1980, 1990])

    const net = first.hand!.result!.netBySeat
    await playOut(matchId, clients)
    const total = {
      0: net[0] + (await peek(matchId)).hand!.result!.netBySeat[0],
    }
    expect(await elapse(matchId, NEXT_HAND_MS)).toBe(true)
    const end = await alice.next((f) => f.t === 'match_end')
    expect(end).toMatchObject({ result: { reason: 'complete' } })
    if (end.t === 'match_end') expect(end.result.netBySeat[0]).toBe(total[0])
    expect((await peek(matchId)).match.status).toBe('finished')
  })

  it('keeps a full table full and replaces a second tab', async () => {
    const { matchId, alice } = await seatBoth()
    await expect(connect(matchId, 'carol')).rejects.toThrow(/403/)
    const again = await connect(matchId, 'alice')
    await again.next((f) => f.t === 'welcome')
    for (let i = 0; i < 100 && !alice.closed; i++)
      await new Promise((r) => setTimeout(r, 5))
    expect(alice.closed?.code).toBe(4001)
  })

  it('shows an opponent dropping and returning, and gives the seat back intact', async () => {
    const { matchId, alice, bob } = await seatBoth()
    const before = (await peek(matchId)).hand!
    const connected = (f: ServerMsg, seat: number) =>
      (f.t === 'state' || f.t === 'welcome') && f.table.players[seat].connected

    let from = alice.frames.length
    bob.ws.close(1000)
    await alice.next((f) => f.t === 'state' && !connected(f, 1), from)

    from = alice.frames.length
    const back = await connect(matchId, 'bob')
    await alice.next((f) => f.t === 'state' && connected(f, 1), from)
    const welcome = await back.next((f) => f.t === 'welcome')
    if (welcome.t !== 'welcome') throw new Error('expected welcome')
    expect(welcome.view!.you).toBe(1)
    expect(welcome.view!.players[1].cards).toEqual(before.players[1].cards)
    expect(welcome.view!.players[0].cards).toBeNull()
    expect(welcome.view!.actions).toEqual(before.actions)
    expect(welcome.table.players.every((p) => p.connected)).toBe(true)

    // Frames to one socket only ever move forward.
    const seqs = alice.frames.map((f) => f.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))

    // The returning player can still play the hand.
    const clients = { 0: alice, 1: back } as Record<number, Client>
    const hand = await playOut(matchId, clients)
    expect(hand!.street).toBe('showdown')
  })

  it('restarts mid-hand from storage, and play continues', async () => {
    const { matchId, clients } = await seatBoth()
    const { hand } = await peek(matchId)
    const actor = hand!.toAct!
    let from = clients[actor].frames.length
    clients[actor].send({
      t: 'act',
      reqId: 'before',
      handNo: 1,
      actionIndex: 0,
      action: { type: 'call' },
    })
    await clients[actor].next(isState(1, 1), from)
    const saved = JSON.stringify((await peek(matchId)).hand)

    // A deploy or crash: every live object is dropped, storage survives.
    // (evictDurableObject never settles in this local runtime, so the test
    // uses the reset that keeps persisted data.)
    const mark = (i: object) =>
      ((i as { boot?: number }).boot ??= Math.random())
    const before = await runInDurableObject(stub(matchId), mark)
    await abortAllDurableObjects()
    const after = await runInDurableObject(stub(matchId), mark)
    expect(after).not.toBe(before) // really a fresh instance

    const restored = await peek(matchId)
    expect(JSON.stringify(restored.hand)).toBe(saved)

    // The player to act reconnects, gets the same hand, and play continues.
    const next = restored.hand!.toAct!
    const client = await connect(matchId, next === 0 ? 'alice' : 'bob')
    const welcome = await client.next((f) => f.t === 'welcome')
    expect(welcome.t === 'welcome' && welcome.view?.actions).toHaveLength(1)
    from = client.frames.length
    client.send({
      t: 'act',
      reqId: 'after',
      handNo: 1,
      actionIndex: 1,
      action: { type: 'check' },
    })
    await client.next(isState(1, 2), from)
    expect((await peek(matchId)).hand!.actions).toHaveLength(2)
  })
})
