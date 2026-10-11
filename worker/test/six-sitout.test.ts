// Sitting out at a casual 6-max table (ADR amendment 2026-10-10, "Sitting
// out" and "Stacks and rebuy"). Two missed decisions in a row, a voluntary
// sit_out or an empty stack sit a player out from the next hand: the hand
// in play finishes on the normal clock, and a player sitting out is not
// dealt in. sit_in (or, at 0 chips, a rebuy) deals them in again from the
// next hand. Heads-up is untouched: its third missed decision forfeits.
import { runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { legalActions } from '../../src/engine/hand'
import type { HandState, PlayerAction, SeatId } from '../../src/engine/types'
import type { ClientMsg, ServerMsg } from '../../src/shared/protocol'
import { NEXT_HAND_MS } from '../src/table'
import type { InitBody, TableDO } from '../src/table'
import { checkFrames } from './frames'
import {
  bySeat,
  connect,
  createTable,
  elapse,
  freezeClock,
  isState,
  move,
  peek,
  stub,
} from './helpers'
import type { Client } from './helpers'

/** A six-casual table, made through the table's own /init like any table. */
async function sixTable() {
  const matchId = crypto.randomUUID()
  const body: InitBody = {
    matchId,
    creator: { userId: 'host', username: 'host' },
    kind: 'six-casual',
  }
  const response = await stub(matchId).fetch('https://table/init', {
    method: 'POST',
    body: JSON.stringify(body),
  })
  if (response.status !== 201) throw new Error(`init ${response.status}`)
  await freezeClock(matchId)
  return matchId
}

/** `user` connects and sits in `seat`. */
async function sitDown(matchId: string, user: string, seat: SeatId) {
  const client = await connect(matchId, user)
  await client.next((f) => f.t === 'welcome')
  const from = client.frames.length
  client.send({ t: 'sit', seat })
  await client.next((f) => f.t === 'welcome' && f.seat !== null, from)
  return client
}

/**
 * Seats 0, 2 and 4 as `${prefix}-0`, `-2` and `-4`. The first two start
 * hand 1 heads-up (seat 0 is button and small blind, and acts first); seat
 * 4 sits during it and is dealt in from hand 2.
 */
async function threeSeats(prefix: string) {
  const matchId = await sixTable()
  const clients: Record<SeatId, Client> = {
    0: await sitDown(matchId, `${prefix}-0`, 0),
    2: await sitDown(matchId, `${prefix}-2`, 2),
  }
  await clients[0].next(isState(1))
  clients[4] = await sitDown(matchId, `${prefix}-4`, 4)
  return { matchId, clients }
}

const passive = (hand: HandState): PlayerAction =>
  legalActions(hand).canCheck ? { type: 'check' } : { type: 'call' }
const fold = (): PlayerAction => ({ type: 'fold' })

/** Plays the hand on the table to its end, each move chosen by `choose`. */
async function playOut(
  matchId: string,
  clients: Record<SeatId, Client>,
  choose: (hand: HandState) => PlayerAction = passive,
) {
  for (let guard = 0; guard < 200; guard++) {
    const { hand } = await peek(matchId)
    if (!hand || hand.street === 'showdown') return hand!
    await move(matchId, clients, choose)
  }
  throw new Error('the hand did not end')
}

/** Ends the hand on the table, then deals the next one. */
async function nextHand(
  matchId: string,
  clients: Record<SeatId, Client>,
  choose?: (hand: HandState) => PlayerAction,
) {
  const ended = await playOut(matchId, clients, choose)
  const handNo = ended.config.handNo
  const first = Object.values(clients)[0]
  await first.next((f) => f.t === 'reveal' && f.handNo === handNo)
  await elapse(matchId, NEXT_HAND_MS)
  await first.next(isState(handNo + 1))
  return (await peek(matchId)).hand!
}

/** The player to act runs out of time: the clock goes to their deadline. */
async function timeOut(matchId: string) {
  const at = await runInDurableObject(stub(matchId), (instance: TableDO) => {
    const { deadlines } = instance as unknown as {
      deadlines: { kind: string; at: number }[]
    }
    return deadlines.find((d) => d.kind === 'turn')!.at
  })
  await elapse(matchId, at - (await clockOf(matchId)))
}

/** The table's clock now. */
const clockOf = (matchId: string) =>
  runInDurableObject(stub(matchId), (instance: TableDO) => instance.clock())

/** `client` sends `msg`; resolves with the welcome or error that answers it. */
async function answer(client: Client, msg: ClientMsg) {
  const from = client.frames.length
  client.send(msg)
  return client.next((f) => f.t === 'welcome' || f.t === 'error', from)
}
const sitOut = (client: Client) => answer(client, { t: 'sit_out' })
const sitIn = (client: Client) => answer(client, { t: 'sit_in' })

/** Seat `seat` as the roster a frame carries describes it. */
function rosterOf(f: ServerMsg, seat: SeatId) {
  if (f.t !== 'welcome' && f.t !== 'state') throw new Error(`no roster: ${f.t}`)
  return bySeat(f.table.players, seat)
}
const statusOf = (f: ServerMsg, seat: SeatId) => rosterOf(f, seat).status

/** The views of hand `handNo` a client received. */
const viewsOf = (frames: ServerMsg[], handNo: number) =>
  frames.flatMap((f) =>
    (f.t === 'state' || f.t === 'welcome') && f.view?.handNo === handNo
      ? [f.view]
      : [],
  )

type Stored = {
  seat: SeatId
  userId: string
  status?: string
  timeouts: number
  stack?: number
}
/** Who sits where at the table now, as it stores them. */
async function seated(matchId: string) {
  const { match } = await peek(matchId)
  return (match as unknown as { players: Stored[] }).players
}

describe('sitting out at a six table', () => {
  it('a voluntary sit_out takes effect from the next hand', async () => {
    const matchId = await sixTable()
    const watcher = await connect(matchId, 'vo-w')
    await watcher.next((f) => f.t === 'welcome')
    const clients: Record<SeatId, Client> = {
      0: await sitDown(matchId, 'vo-0', 0),
      2: await sitDown(matchId, 'vo-2', 2),
    }
    await clients[0].next(isState(1))
    clients[4] = await sitDown(matchId, 'vo-4', 4)

    // Hand 1 is heads-up and seat 0, its button, is to act. It sits out:
    // the roster says so at once, to a socket without a seat too, and the
    // seat stays its own in hand 1, its move to make on the normal clock.
    const seen = watcher.frames.length
    const out = await sitOut(clients[0])
    expect(out).toMatchObject({ t: 'welcome', seat: 0 })
    expect(statusOf(out, 0)).toBe('sitting_out')
    expect(out.t === 'welcome' && out.view).toMatchObject({ you: 0, toAct: 0 })
    const told = await watcher.next(
      (f) => f.t === 'state' && statusOf(f, 0) === 'sitting_out',
      seen,
    )
    expect(told).toMatchObject({ view: null })
    // 20 s to decide and the whole 30 s bank, as before it sat out.
    const t = await clockOf(matchId)
    expect(out.t === 'welcome' && out.view?.clock).toEqual({
      deadline: t + 50_000,
      bankMs: 30_000,
    })
    await move(matchId, clients, () => ({ type: 'call' }))
    expect((await peek(matchId)).hand!.actions[0]).toMatchObject({
      seat: 0,
      action: { type: 'call' },
    })

    // Hand 2 deals seats 2 and 4 only; seat 0 sees it as nobody's seat.
    const two = await nextHand(matchId, clients)
    expect(two.config.seats.map((s) => s.seat)).toEqual([2, 4])
    const mine = viewsOf(clients[0].frames, 2)
    expect(mine.length).toBeGreaterThan(0)
    for (const view of mine) {
      expect(view.you).toBeNull()
      for (const p of view.players) expect(p.cards).toBeNull()
    }

    // Between hands, seat 4 sits out too: the next deal finds one player
    // to deal in, and the table waits.
    await playOut(matchId, { 2: clients[2], 4: clients[4] }, fold)
    await clients[2].next((f) => f.t === 'reveal' && f.handNo === 2)
    expect(statusOf(await sitOut(clients[4]), 4)).toBe('sitting_out')
    // Sitting out again changes nothing.
    expect(statusOf(await sitOut(clients[4]), 4)).toBe('sitting_out')
    await elapse(matchId, NEXT_HAND_MS)
    const { match, hand } = await peek(matchId)
    expect(match.status).toBe('waiting')
    expect(hand!.config.handNo).toBe(2)
    expect((await seated(matchId)).map((p) => [p.seat, p.status])).toEqual([
      [0, 'sitting_out'],
      [2, 'playing'],
      [4, 'sitting_out'],
    ])
    checkFrames(
      [watcher, ...Object.values(clients)].flatMap((c) => c.frames),
      'six-casual',
    )
  })

  it('sit_in deals a player in at the next hand and resets their timeouts', async () => {
    const { matchId, clients } = await threeSeats('si')
    // Hand 2: button 0, small blind 2, big blind 4. Seat 0 raises, seat 2
    // folds, and seat 4 runs out of time facing the raise: it folds.
    let hand = await nextHand(matchId, clients, fold)
    expect(hand.config).toMatchObject({ button: 0, sb: 2, bb: 4 })
    await move(matchId, clients, () => ({ type: 'raise', to: 60 }))
    await move(matchId, clients, fold)
    await timeOut(matchId)
    expect((await peek(matchId)).hand!.actions.at(-1)).toMatchObject({
      seat: 4,
      action: { type: 'fold' },
    })
    let roster = (await seated(matchId)).find((p) => p.seat === 4)!
    expect(roster).toMatchObject({ status: 'playing', timeouts: 1 })
    await clients[0].next((f) => f.t === 'reveal' && f.handNo === 2)
    await elapse(matchId, NEXT_HAND_MS)
    await clients[0].next(isState(3))

    // Hand 3: button 2, small blind 4, big blind 0. Seat 2 calls and seat
    // 4 runs out of time again: two in a row, so it sits out from hand 4,
    // and everyone hears it.
    hand = (await peek(matchId)).hand!
    expect(hand.config).toMatchObject({ button: 2, sb: 4, bb: 0 })
    await move(matchId, clients, () => ({ type: 'call' }))
    const from = clients[2].frames.length
    await timeOut(matchId)
    const told = await clients[2].next(
      (f) => f.t === 'state' && statusOf(f, 4) === 'sitting_out',
      from,
    )
    expect(rosterOf(told, 4)).toMatchObject({ consecutiveTimeouts: 2 })
    hand = await nextHand(matchId, { 0: clients[0], 2: clients[2] })
    expect(hand.config.handNo).toBe(4)
    expect(hand.config.seats.map((s) => s.seat)).toEqual([0, 2])

    // Seat 4 sits in while hand 4 is played: playing again, its count
    // back at 0, but not in hand 4.
    const back = await sitIn(clients[4])
    expect(back).toMatchObject({ t: 'welcome', seat: 4 })
    expect(rosterOf(back, 4)).toMatchObject({
      status: 'playing',
      consecutiveTimeouts: 0,
    })
    expect(back.t === 'welcome' && back.view).toMatchObject({
      handNo: 4,
      you: null,
    })
    roster = (await seated(matchId)).find((p) => p.seat === 4)!
    expect(roster).toMatchObject({ status: 'playing', timeouts: 0 })
    // A sit_in from a player who is playing changes nothing.
    const already = await sitIn(clients[0])
    expect(rosterOf(already, 0)).toMatchObject({ status: 'playing' })

    // Hand 5 deals it in.
    hand = await nextHand(matchId, { 0: clients[0], 2: clients[2] })
    expect(hand.config.handNo).toBe(5)
    expect(hand.config.seats.map((s) => s.seat)).toEqual([0, 2, 4])
    await clients[4].next(isState(5))
    expect(viewsOf(clients[4].frames, 5).at(-1)!.you).toBe(4)
    checkFrames(
      Object.values(clients).flatMap((c) => c.frames),
      'six-casual',
    )
  }, 30_000)

  it('a sit_in at a waiting table that makes two players to deal in deals at once', async () => {
    const matchId = await sixTable()
    const clients: Record<SeatId, Client> = {
      0: await sitDown(matchId, 'sw-0', 0),
      2: await sitDown(matchId, 'sw-2', 2),
    }
    await clients[0].next(isState(1))
    await playOut(matchId, clients, fold)
    await clients[0].next((f) => f.t === 'reveal' && f.handNo === 1)
    await sitOut(clients[2])
    await elapse(matchId, NEXT_HAND_MS)
    expect((await peek(matchId)).match.status).toBe('waiting')
    await sitIn(clients[2])
    await clients[2].next(isState(2))
    const { match, hand } = await peek(matchId)
    expect(match.status).toBe('playing')
    expect(hand!.config.seats.map((s) => s.seat)).toEqual([0, 2])
  })
})

describe('heads-up timeouts', () => {
  it('a heads-up table sits nobody out, refuses sit_in and sit_out, and still forfeits on the third timeout', async () => {
    const matchId = await createTable('hg-a')
    await freezeClock(matchId)
    const seats: Record<SeatId, Client> = {
      0: await connect(matchId, 'hg-a'),
      1: await connect(matchId, 'hg-b'),
    }
    await seats[0].next(isState(1))
    // A six-table message is not a heads-up one.
    for (const msg of [{ t: 'sit_out' }, { t: 'sit_in' }] as ClientMsg[])
      expect(await answer(seats[0], msg)).toMatchObject({
        t: 'error',
        code: 'illegal',
      })
    // Hand 1: seat 0, the button, runs out of time facing the big blind.
    await timeOut(matchId)
    await seats[0].next((f) => f.t === 'reveal' && f.handNo === 1)
    await elapse(matchId, NEXT_HAND_MS)
    await seats[0].next(isState(2))
    // Hand 2: seat 1 calls, and seat 0 runs out of time again: two in a
    // row. Heads-up nobody sits out; seat 0 is still dealt in.
    await move(matchId, seats, () => ({ type: 'call' }))
    await timeOut(matchId)
    const { match, hand } = await peek(matchId)
    expect(match.status).toBe('playing')
    expect(hand!.street).toBe('flop')
    const players = (await seated(matchId)).map((p) => ({ ...p }))
    expect(players.map((p) => p.timeouts)).toEqual([2, 0])
    for (const p of players) expect(p).not.toHaveProperty('status')
    // The third, on the flop, forfeits the match.
    await timeOut(matchId)
    expect(await seats[1].next((f) => f.t === 'match_end')).toMatchObject({
      result: { reason: 'forfeit', forfeit: 0 },
    })
    checkFrames([...seats[0].frames, ...seats[1].frames])
  })
})
