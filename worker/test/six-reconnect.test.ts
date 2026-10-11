// Leaving and coming back at a casual 6-max table (ADR amendment
// 2026-10-10, "Reconnect"). A player whose socket closes keeps the seat for
// the rated 60 s grace (GRACE_MS): their turns run on the normal clock and
// their timeouts count, as anyone's. When the grace ends they sit out, and
// coming back does not deal them in again: that takes sit_in. Nobody is
// forfeited and no table ends because one player left; with fewer than two
// players to deal in the table waits, and deals again once two are back.
// Heads-up keeps its own rules: no grace for casual, and rated's grace,
// instant turns after it and void when both are gone.
import {
  abortAllDurableObjects,
  env,
  runInDurableObject,
} from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { dealSlots } from '../../src/engine/deck'
import { legalActions } from '../../src/engine/hand'
import type { HandState, PlayerAction, SeatId } from '../../src/engine/types'
import type { ClientMsg, ServerMsg } from '../../src/shared/protocol'
import { IDLE_MS } from '../src/deadlines'
import { lobbyStub } from '../src/lobby'
import type { LobbyDO } from '../src/lobby'
import { GRACE_MS } from '../src/rated'
import { NEXT_HAND_MS } from '../src/table'
import type { InitBody, TableDO } from '../src/table'
import { analysisKeys, checkFrames, FLOW_TYPES } from './frames'
import {
  bySeat,
  connect,
  createTable,
  elapse,
  freezeClock,
  isState,
  move,
  peek,
  setClock,
  storageOf,
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

const passive = (hand: HandState): PlayerAction =>
  legalActions(hand).canCheck ? { type: 'check' } : { type: 'call' }
const fold = (): PlayerAction => ({ type: 'fold' })
const call = (): PlayerAction => ({ type: 'call' })
const check = (): PlayerAction => ({ type: 'check' })
const bet = (hand: HandState): PlayerAction => ({
  type: 'raise',
  to: legalActions(hand).minRaiseTo,
})

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

/**
 * Seats 0, 2 and 4 as `${prefix}-0`, `-2` and `-4`. Seats 0 and 2 play
 * hand 1 heads-up (seat 0 folds it); seat 4 sits during it. Resolves once
 * hand 2 is dealt to all three, at the frozen clock plus NEXT_HAND_MS:
 * button 0, small blind 2, big blind 4, and seat 0 to act first.
 */
async function handTwo(prefix: string) {
  const matchId = await sixTable()
  const clients: Record<SeatId, Client> = {
    0: await sitDown(matchId, `${prefix}-0`, 0),
    2: await sitDown(matchId, `${prefix}-2`, 2),
  }
  await clients[0].next(isState(1))
  clients[4] = await sitDown(matchId, `${prefix}-4`, 4)
  await playOut(matchId, clients, fold)
  await clients[0].next((f) => f.t === 'reveal' && f.handNo === 1)
  await elapse(matchId, NEXT_HAND_MS)
  await clients[4].next(isState(2))
  const hand = (await peek(matchId)).hand!
  expect(hand.config).toMatchObject({ handNo: 2, button: 0, sb: 2, bb: 4 })
  return { matchId, clients, hand, dealtAt: await clockOf(matchId) }
}

/** The table's clock now. */
const clockOf = (matchId: string) =>
  runInDurableObject(stub(matchId), (instance: TableDO) => instance.clock())

/** Moves the table's clock to `t` and fires its alarm (what is due runs). */
async function at(matchId: string, t: number) {
  await elapse(matchId, t - (await clockOf(matchId)))
}

/** `client`'s socket closes; resolves once the table has seen it go. */
async function leave(matchId: string, client: Client, user: string) {
  client.ws.close(1000, 'gone')
  for (let i = 0; i < 400; i++) {
    const open = await runInDurableObject(
      stub(matchId),
      (_: TableDO, state) =>
        state.getWebSockets(user).filter((ws) => ws.readyState === 1).length,
    )
    if (open === 0) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`the table never saw ${user} go`)
}

type Deadline = { kind: string; at: number; seat?: SeatId; userId?: string }
/** The graces the table is running. */
const graces = (matchId: string) =>
  runInDurableObject(stub(matchId), (instance: TableDO) =>
    (instance as unknown as { deadlines: Deadline[] }).deadlines.filter(
      (d) => d.kind === 'grace',
    ),
  )
/** The table's stored deadlines, as a restarted object reads them. */
const storedDeadlines = (matchId: string) =>
  runInDurableObject(stub(matchId), (_: TableDO, state) =>
    state.storage.get<Deadline[]>('deadlines'),
  )

type Stored = {
  seat: SeatId
  userId: string
  status?: string
  timeouts: number
  awaySince?: number
  outOrbits?: number
  outSince?: number
}
/** Who sits where at the table now, as it stores them. */
async function seated(matchId: string) {
  const { match } = await peek(matchId)
  return (match as unknown as { players: Stored[] }).players
}
const storedSeat = async (matchId: string, seat: SeatId) =>
  bySeat(await seated(matchId), seat)

/** Seat `seat` as the roster a frame carries describes it. */
function rosterOf(f: ServerMsg, seat: SeatId) {
  if (f.t !== 'welcome' && f.t !== 'state') throw new Error(`no roster: ${f.t}`)
  return bySeat(f.table.players, seat)
}

/** `client` sends `msg`; resolves with the welcome or error that answers it. */
async function answer(client: Client, msg: ClientMsg) {
  const from = client.frames.length
  client.send(msg)
  return client.next((f) => f.t === 'welcome' || f.t === 'error', from)
}

/** `user` connects again; resolves with the client and its welcome. */
async function comeBack(matchId: string, user: string) {
  const client = await connect(matchId, user)
  const welcome = (await client.next((f) => f.t === 'welcome')) as Extract<
    ServerMsg,
    { t: 'welcome' }
  >
  return { client, welcome }
}

/** Every dealt seat's hole cards in `hand`, as the table holds them. */
function holesOf(hand: HandState) {
  const { holes } = dealSlots(hand.config)
  const cards: Record<SeatId, number[]> = {}
  for (const { seat } of hand.config.seats)
    cards[seat] = holes[seat].map((slot) => hand.deck[slot])
  return cards
}

/**
 * The turn clock `client` was shown once hand `handNo` had `actions`
 * moves: who was to act, their deadline and what was left of their bank.
 */
function clockAt(client: Client, handNo: number, actions: number) {
  const f = client.frames.filter(isState(handNo, actions)).at(-1) as
    | Extract<ServerMsg, { t: 'state' | 'welcome' }>
    | undefined
  if (!f?.view) throw new Error(`no view of hand ${handNo} at ${actions}`)
  return { toAct: f.view.toAct, ...f.view.clock }
}

/** Ends the hand on the table, then deals the next one; returns it. */
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

describe('coming back to a six table', () => {
  it('a reconnect within 60 s keeps the seat and cards', async () => {
    const { matchId, clients, hand, dealtAt } = await handTwo('rk')
    const cards = holesOf(hand)
    // Seat 4, the big blind, drops while seat 0 is to act: its grace runs
    // for 60 s from now, and everyone sees it gone.
    const from = clients[0].frames.length
    await leave(matchId, clients[4], 'rk-4')
    expect(await graces(matchId)).toEqual([
      { kind: 'grace', at: dealtAt + GRACE_MS, seat: 4, userId: 'rk-4' },
    ])
    const told = await clients[0].next(
      (f) => f.t === 'state' && !rosterOf(f, 4).connected,
      from,
    )
    expect(rosterOf(told, 4)).toMatchObject({ status: 'playing' })
    // Play goes on without it: seat 0 calls 40 s in.
    await setClock(matchId, dealtAt + 40_000)
    await move(matchId, clients, call)

    // A moment before the grace ends, seat 4 is back: the same seat, its
    // own cards for the hand, playing, and the grace over.
    await setClock(matchId, dealtAt + GRACE_MS - 1)
    const { client: back, welcome } = await comeBack(matchId, 'rk-4')
    expect(welcome).toMatchObject({
      seat: 4,
      view: { handNo: 2, you: 4, toAct: 2 },
    })
    expect(bySeat(welcome.view!.players, 4).cards).toEqual(cards[4])
    expect(rosterOf(welcome, 4)).toMatchObject({
      connected: true,
      status: 'playing',
      consecutiveTimeouts: 0,
    })
    expect(await graces(matchId)).toEqual([])
    await clients[0].next(
      (f) => f.t === 'state' && rosterOf(f, 4).connected,
      from,
    )

    // Past where the grace would have ended, nothing changes, and seat 4
    // makes its own move in the hand.
    await at(matchId, dealtAt + GRACE_MS + 1)
    expect(await storedSeat(matchId, 4)).toMatchObject({
      status: 'playing',
      timeouts: 0,
    })
    const seats = { 0: clients[0], 2: clients[2], 4: back }
    await move(matchId, seats, call)
    expect((await peek(matchId)).hand!.toAct).toBe(4)
    await move(matchId, seats, check)
    expect((await peek(matchId)).hand!.actions.at(-1)).toMatchObject({
      seat: 4,
      action: { type: 'check' },
    })
    // Hand 3 deals it in again.
    const three = await nextHand(matchId, seats)
    expect(three.config.seats.map((s) => s.seat)).toEqual([0, 2, 4])
    checkFrames(
      [...Object.values(clients), back].flatMap((c) => c.frames),
      'six-casual',
    )
  }, 30_000)

  it('a reconnect after the grace ran out, before its alarm ran, still sits the player out', async () => {
    const { matchId, clients, hand, dealtAt } = await handTwo('rl')
    const cards = holesOf(hand)
    // Seat 4, the big blind, drops as hand 2 is dealt; seat 0 calls 40 s
    // in. Its grace ends at 60 s, but the alarm is late (a deploy or a
    // restart), and seat 4 is back 5 s after the end, before it runs.
    await leave(matchId, clients[4], 'rl-4')
    await setClock(matchId, dealtAt + 40_000)
    await move(matchId, clients, call)
    const from = clients[0].frames.length
    await setClock(matchId, dealtAt + GRACE_MS + 5_000)
    const { client: back, welcome } = await comeBack(matchId, 'rl-4')
    // The grace ran out, so it sits out as the alarm would have sat it
    // out, its removal clock from now; being back does not deal it in.
    // It still has its seat and its cards in the hand it was dealt.
    expect(welcome).toMatchObject({ seat: 4, view: { handNo: 2, you: 4 } })
    expect(bySeat(welcome.view!.players, 4).cards).toEqual(cards[4])
    expect(rosterOf(welcome, 4)).toMatchObject({
      connected: true,
      status: 'sitting_out',
    })
    expect(await storedSeat(matchId, 4)).toMatchObject({
      status: 'sitting_out',
      outSince: dealtAt + GRACE_MS + 5_000,
      outOrbits: 0,
    })
    expect(await graces(matchId)).toEqual([])
    await clients[0].next(
      (f) => f.t === 'state' && rosterOf(f, 4).status === 'sitting_out',
      from,
    )
    // The late alarm finds nothing left to do.
    await at(matchId, dealtAt + GRACE_MS + 6_000)
    expect(await storedSeat(matchId, 4)).toMatchObject({
      status: 'sitting_out',
      outSince: dealtAt + GRACE_MS + 5_000,
    })
    // It plays out hand 2 (its option), and hand 3 deals seats 0 and 2.
    const seats = { 0: clients[0], 2: clients[2], 4: back }
    await move(matchId, seats, call)
    await move(matchId, seats, check)
    expect((await peek(matchId)).hand!.actions.at(-1)).toMatchObject({
      seat: 4,
      action: { type: 'check' },
    })
    const three = await nextHand(matchId, seats)
    expect(three.config.seats.map((s) => s.seat)).toEqual([0, 2])
    checkFrames(
      [...Object.values(clients), back].flatMap((c) => c.frames),
      'six-casual',
    )
  }, 30_000)

  it("the reconnect welcome has only that user's cards for the current hand", async () => {
    const { matchId, clients, hand, dealtAt } = await handTwo('rw')
    const cards = holesOf(hand)
    // A socket without a seat, and seat 5, which sits during hand 2 and is
    // not dealt into it.
    const seatless = await connect(matchId, 'rw-w')
    await seatless.next((f) => f.t === 'welcome')
    clients[5] = await sitDown(matchId, 'rw-5', 5)
    // Seats 4 and 5 and the seatless socket drop as hand 2 starts; seat
    // 0 calls 15 s in, so seat 2's turn runs past the end of the grace.
    for (const [c, user] of [
      [clients[4], 'rw-4'],
      [clients[5], 'rw-5'],
      [seatless, 'rw-w'],
    ] as const)
      await leave(matchId, c, user)
    await setClock(matchId, dealtAt + 15_000)
    await move(matchId, clients, call)
    // The grace ends with seat 4 still dealt into hand 2: it sits out
    // from the next hand, and plays this one out on the normal clock.
    await at(matchId, dealtAt + GRACE_MS)
    expect((await storedSeat(matchId, 4)).status).toBe('sitting_out')

    // Seat 4 comes back: its own cards for hand 2, nobody else's, on the
    // wire as well as in the view.
    const four = await comeBack(matchId, 'rw-4')
    expect(four.welcome).toMatchObject({
      seat: 4,
      view: { handNo: 2, you: 4, toAct: 2 },
    })
    const view = four.welcome.view!
    expect(bySeat(view.players, 4).cards).toEqual(cards[4])
    for (const p of view.players)
      if (p.seat !== 4) expect(p.cards, `seat ${p.seat}`).toBeNull()
    const wire = JSON.stringify(four.welcome)
    for (const seat of [0, 2] as SeatId[])
      expect(wire).not.toContain(JSON.stringify(cards[seat]))
    expect(rosterOf(four.welcome, 4)).toMatchObject({
      status: 'sitting_out',
      connected: true,
    })
    // A resync answers the same.
    const again = await answer(four.client, { t: 'resync' })
    expect(again).toEqual({ ...four.welcome, seq: again.seq })

    // Seat 5, seated but not dealt in, and the seatless socket come back:
    // no hole card of anyone's.
    const five = await comeBack(matchId, 'rw-5')
    expect(five.welcome).toMatchObject({ seat: 5, view: { you: null } })
    for (const p of five.welcome.view!.players) expect(p.cards).toBeNull()
    const none = await comeBack(matchId, 'rw-w')
    expect(none.welcome).toMatchObject({ seat: null, view: null })
    for (const f of [five.welcome, none.welcome])
      for (const seat of [0, 2, 4] as SeatId[])
        expect(JSON.stringify(f)).not.toContain(JSON.stringify(cards[seat]))

    // The hand goes on with seat 4 making its own moves, and ends; only
    // seat 4's own opening reaches seat 4, and none reaches seat 5.
    const seats = { 0: clients[0], 2: clients[2], 4: four.client }
    await playOut(matchId, seats, fold)
    await four.client.next((f) => f.t === 'reveal' && f.handNo === 2)
    await five.client.next((f) => f.t === 'reveal' && f.handNo === 2)
    const opened = (c: Client) =>
      c.frames.flatMap((f) => (f.t === 'reveal' && f.own ? f.own : []))
    expect(opened(four.client).map((s) => s.card)).toEqual(cards[4])
    expect(opened(five.client)).toEqual([])

    const all = [
      ...Object.values(clients),
      seatless,
      four.client,
      five.client,
      none.client,
    ].flatMap((c) => c.frames)
    expect(checkFrames(all, 'six-casual')).toEqual(
      new Set(FLOW_TYPES.reconnect),
    )
    expect(analysisKeys(all)).toEqual([])
  }, 30_000)

  it('a player gone past 60 s sits out and is not dealt in after reconnecting until sit_in', async () => {
    const { matchId, clients, dealtAt } = await handTwo('rp')
    const watcher = await connect(matchId, 'rp-w')
    await watcher.next((f) => f.t === 'welcome')
    // Seat 0 folds hand 2 and drops; seats 2 and 4 take their time.
    await move(matchId, clients, fold)
    await leave(matchId, clients[0], 'rp-0')
    await setClock(matchId, dealtAt + 40_000)
    await move(matchId, clients, call)
    // 60 s after it left, seat 0 sits out, and everyone hears it, the
    // socket without a seat too. Its removal clock starts now, not when
    // it left.
    const seen = watcher.frames.length
    await at(matchId, dealtAt + GRACE_MS)
    expect(await storedSeat(matchId, 0)).toMatchObject({
      status: 'sitting_out',
      outSince: dealtAt + GRACE_MS,
      outOrbits: 0,
    })
    const told = await watcher.next(
      (f) => f.t === 'state' && rosterOf(f, 0).status === 'sitting_out',
      seen,
    )
    expect(rosterOf(told, 0)).toMatchObject({ connected: false })
    expect(told).toMatchObject({ view: null })

    // Hand 3 deals seats 2 and 4 only.
    const three = await nextHand(matchId, { 2: clients[2], 4: clients[4] })
    expect(three.config.seats.map((s) => s.seat)).toEqual([2, 4])
    // Back during hand 3: still sitting out, watching it with no cards.
    const { client: back, welcome } = await comeBack(matchId, 'rp-0')
    expect(welcome).toMatchObject({ seat: 0, view: { handNo: 3, you: null } })
    expect(rosterOf(welcome, 0)).toMatchObject({
      status: 'sitting_out',
      connected: true,
    })
    // Being back does not deal it in: hand 4 goes ahead without it.
    const four = await nextHand(matchId, { 2: clients[2], 4: clients[4] })
    expect(four.config.seats.map((s) => s.seat)).toEqual([2, 4])
    expect((await storedSeat(matchId, 0)).status).toBe('sitting_out')
    // sit_in does, from the next hand.
    const sat = await answer(back, { t: 'sit_in' })
    expect(rosterOf(sat, 0)).toMatchObject({ status: 'playing' })
    const five = await nextHand(matchId, { 2: clients[2], 4: clients[4] })
    expect(five.config.seats.map((s) => s.seat)).toEqual([0, 2, 4])
    await back.next(isState(5))
    checkFrames(
      [watcher, back, ...Object.values(clients)].flatMap((c) => c.frames),
      'six-casual',
    )
  }, 30_000)

  it('away turns count as timeouts and two of them sit the player out', async () => {
    const { matchId, clients, dealtAt } = await handTwo('ra')
    // Seats 0 and 2 call; seat 4, the big blind, has the option. It is
    // thinking when, 30 s in, its socket closes: the grace runs to 90 s.
    await move(matchId, clients, call)
    await move(matchId, clients, call)
    await setClock(matchId, dealtAt + 30_000)
    await leave(matchId, clients[4], 'ra-4')
    expect(await graces(matchId)).toEqual([
      { kind: 'grace', at: dealtAt + 90_000, seat: 4, userId: 'ra-4' },
    ])
    // Its turn runs on the normal clock: 20 s and its whole 30 s bank,
    // then the table checks for it. One missed decision.
    await at(matchId, dealtAt + 50_000 - 1)
    expect((await peek(matchId)).hand!.actions).toHaveLength(2)
    await at(matchId, dealtAt + 50_000)
    expect((await peek(matchId)).hand!.actions.at(-1)).toMatchObject({
      seat: 4,
      action: { type: 'check' },
    })
    expect(await storedSeat(matchId, 4)).toMatchObject({
      status: 'playing',
      timeouts: 1,
    })
    // On the flop seat 2 checks and seat 4 has 20 s, its bank spent.
    await move(matchId, clients, check)
    expect(clockAt(clients[0], 2, 4)).toEqual({
      toAct: 4,
      deadline: dealtAt + 70_000,
      bankMs: 0,
    })
    const from = clients[0].frames.length
    await at(matchId, dealtAt + 70_000)
    // The second in a row: it sits out from the next hand, before its
    // grace ends, and everyone hears it.
    expect(await storedSeat(matchId, 4)).toMatchObject({
      status: 'sitting_out',
      timeouts: 2,
      outSince: dealtAt + 70_000,
    })
    await clients[0].next(
      (f) => f.t === 'state' && rosterOf(f, 4).status === 'sitting_out',
      from,
    )
    // The grace ending changes nothing more: same status, same removal
    // clock, no roster news.
    const quiet = clients[0].frames.length
    await at(matchId, dealtAt + 90_000)
    expect(await storedSeat(matchId, 4)).toMatchObject({
      status: 'sitting_out',
      timeouts: 2,
      outSince: dealtAt + 70_000,
    })
    expect(await graces(matchId)).toEqual([])
    expect(clients[0].frames.slice(quiet)).toEqual([])
    // It still plays this hand out on the normal clock: seat 0 checks, and
    // on the turn seat 2 checks and seat 4 gets 20 s, not an instant move.
    await move(matchId, clients, check)
    await move(matchId, clients, check)
    expect(clockAt(clients[0], 2, 7)).toEqual({
      toAct: 4,
      deadline: dealtAt + 110_000,
      bankMs: 0,
    })
    await at(matchId, dealtAt + 110_000 - 1)
    expect((await peek(matchId)).hand!.actions).toHaveLength(7)
    await at(matchId, dealtAt + 110_000)
    // Sitting out and still gone, it gets no new grace from the alarms
    // since: being back would change nothing for it until sit_in.
    expect(await graces(matchId)).toEqual([])
    // Seat 0 bets, seat 2 folds, and seat 4 times out facing it: a fold,
    // its fourth miss. A six table never forfeits anyone.
    await move(matchId, clients, bet)
    await move(matchId, clients, fold)
    await at(matchId, dealtAt + 130_000)
    const { match, hand } = await peek(matchId)
    expect(match.status).toBe('playing')
    expect(hand!.street).toBe('showdown')
    expect(await storedSeat(matchId, 4)).toMatchObject({ timeouts: 4 })
    // Hand 3 is dealt without it.
    await clients[0].next((f) => f.t === 'reveal' && f.handNo === 2)
    await elapse(matchId, NEXT_HAND_MS)
    await clients[0].next(isState(3))
    expect((await peek(matchId)).hand!.config.seats.map((s) => s.seat)).toEqual(
      [0, 2],
    )
    checkFrames(
      Object.values(clients).flatMap((c) => c.frames),
      'six-casual',
    )
  }, 30_000)

  it('a player in their grace is dealt in when the table deals', async () => {
    // The usual case at a table of three or more: seat 4 drops between
    // hands. Seats 0 and 2 are still there, so the table deals hand 3 on
    // time, and it deals seat 4 in (ADR clarification from PR-17: "a hand
    // the table deals still deals them in").
    const { matchId, clients } = await handTwo('rd')
    await playOut(matchId, clients, fold)
    await clients[0].next((f) => f.t === 'reveal' && f.handNo === 2)
    const left = await clockOf(matchId)
    await leave(matchId, clients[4], 'rd-4')
    await elapse(matchId, NEXT_HAND_MS)
    await clients[0].next(isState(3))
    const { match, hand } = await peek(matchId)
    expect(match.status).toBe('playing')
    expect(hand!.config.seats.map((s) => s.seat)).toEqual([0, 2, 4])
    expect(hand!.config).toMatchObject({ button: 2, sb: 4, bb: 0 })
    expect(await graces(matchId)).toEqual([
      { kind: 'grace', at: left + GRACE_MS, seat: 4, userId: 'rd-4' },
    ])
    // Seat 2 calls at once; seat 4, the small blind, gets the normal 20 s
    // and its whole 30 s bank, not an instant move.
    const dealt = left + NEXT_HAND_MS
    await move(matchId, clients, call)
    expect(clockAt(clients[0], 3, 1)).toEqual({
      toAct: 4,
      deadline: dealt + 50_000,
      bankMs: 30_000,
    })
    await at(matchId, dealt + 50_000 - 1)
    expect((await peek(matchId)).hand!.actions).toHaveLength(1)
    // It runs out within the grace: a fold, one missed decision, and seat
    // 4 still playing.
    await at(matchId, dealt + 50_000)
    expect((await peek(matchId)).hand!.actions.at(-1)).toMatchObject({
      seat: 4,
      action: { type: 'fold' },
    })
    expect(await storedSeat(matchId, 4)).toMatchObject({
      status: 'playing',
      timeouts: 1,
    })
    // When the grace ends seat 4 sits out, and the next deal leaves it out.
    await at(matchId, left + GRACE_MS)
    expect(await storedSeat(matchId, 4)).toMatchObject({
      status: 'sitting_out',
      timeouts: 1,
    })
    const four = await nextHand(matchId, { 0: clients[0], 2: clients[2] })
    expect(four.config.seats.map((s) => s.seat)).toEqual([0, 2])
    checkFrames(
      Object.values(clients).flatMap((c) => c.frames),
      'six-casual',
    )
  }, 30_000)

  it('reconnecting within the grace keeps the decisions missed during it', async () => {
    // Only the player's own move or sit_in resets missed decisions (ADR
    // clarification from PR-17); coming back does not.
    const { matchId, clients, dealtAt } = await handTwo('rm')
    // Seat 4, the big blind, drops as hand 2 starts; seats 0 and 2 call,
    // and its option runs out at 50 s: a check, one missed decision.
    await leave(matchId, clients[4], 'rm-4')
    await move(matchId, clients, call)
    await move(matchId, clients, call)
    await at(matchId, dealtAt + 50_000)
    expect(await storedSeat(matchId, 4)).toMatchObject({
      status: 'playing',
      timeouts: 1,
    })
    // Back at 55 s, within the grace: still one missed decision.
    await setClock(matchId, dealtAt + 55_000)
    const { client: back, welcome } = await comeBack(matchId, 'rm-4')
    expect(rosterOf(welcome, 4)).toMatchObject({
      connected: true,
      status: 'playing',
      consecutiveTimeouts: 1,
    })
    expect(await graces(matchId)).toEqual([])
    // On the flop seat 2 checks; seat 4, here but idle, misses again (20 s,
    // its bank spent), the second in a row: it sits out from the next hand.
    const seats = { 0: clients[0], 2: clients[2], 4: back }
    await move(matchId, seats, check)
    expect(clockAt(back, 2, 4)).toEqual({
      toAct: 4,
      deadline: dealtAt + 75_000,
      bankMs: 0,
    })
    await at(matchId, dealtAt + 75_000)
    expect(await storedSeat(matchId, 4)).toMatchObject({
      status: 'sitting_out',
      timeouts: 2,
    })
    checkFrames(
      [back, ...Object.values(clients)].flatMap((c) => c.frames),
      'six-casual',
    )
  }, 30_000)

  it('a grace begun at a waiting table arms the alarm for its end', async () => {
    // One player at a table that cannot deal: nothing else is due for
    // minutes, so the alarm must be set for the grace's end as it starts,
    // or the grace would run out at the idle check instead.
    const matchId = await sixTable()
    const client = await sitDown(matchId, 'rg-0', 0)
    expect((await peek(matchId)).match.status).toBe('waiting')
    // The idle check /init armed (on the real clock, before the test froze
    // it) runs, and keeps the table for its seated player until IDLE_MS
    // from now on the table's clock.
    await elapse(matchId, 0)
    const t = await clockOf(matchId)
    expect((await storageOf(matchId)).alarm).toBe(t + IDLE_MS)
    await leave(matchId, client, 'rg-0')
    expect(await graces(matchId)).toEqual([
      { kind: 'grace', at: t + GRACE_MS, seat: 0, userId: 'rg-0' },
    ])
    expect((await storageOf(matchId)).alarm).toBe(t + GRACE_MS)
    await at(matchId, t + GRACE_MS)
    expect((await storedSeat(matchId, 0)).status).toBe('sitting_out')
  })

  it('a table whose active players drop below two pauses and resumes', async () => {
    const { matchId, clients, dealtAt } = await handTwo('rz')
    // Seats 2 and 4 drop as hand 2 starts. Seat 0 raises; the hand goes on
    // on the normal clock, and seat 2 folds when its time is up.
    await leave(matchId, clients[2], 'rz-2')
    await leave(matchId, clients[4], 'rz-4')
    await move(matchId, clients, (h) => ({
      type: 'raise',
      to: legalActions(h).minRaiseTo,
    }))
    await at(matchId, dealtAt + 50_000)
    expect((await peek(matchId)).hand!.actions.at(-1)).toMatchObject({
      seat: 2,
      action: { type: 'fold' },
    })
    // Both graces end with seat 4 still to act: both sit out, and the hand
    // still goes on. Seat 4 folds when its own time is up.
    await at(matchId, dealtAt + GRACE_MS)
    expect((await seated(matchId)).map((p) => [p.seat, p.status])).toEqual([
      [0, 'playing'],
      [2, 'sitting_out'],
      [4, 'sitting_out'],
    ])
    expect((await peek(matchId)).hand!.toAct).toBe(4)
    await at(matchId, dealtAt + 100_000)
    expect((await peek(matchId)).hand!.street).toBe('showdown')
    // One player left to deal in: the table pauses instead of ending.
    const from = clients[0].frames.length
    await elapse(matchId, NEXT_HAND_MS)
    let { match } = await peek(matchId)
    expect(match).toMatchObject({ status: 'waiting', handNo: 2 })
    await clients[0].next(
      (f) => f.t === 'state' && f.table.status === 'waiting',
      from,
    )
    // Seat 2 comes back, sitting out: still paused.
    const two = await comeBack(matchId, 'rz-2')
    expect(rosterOf(two.welcome, 2).status).toBe('sitting_out')
    ;({ match } = await peek(matchId))
    expect(match).toMatchObject({ status: 'waiting', handNo: 2 })
    // Its sit_in makes two to deal in: hand 3 deals at once.
    await answer(two.client, { t: 'sit_in' })
    await two.client.next(isState(3))
    expect((await peek(matchId)).hand!.config.seats.map((s) => s.seat)).toEqual(
      [0, 2],
    )

    // Seat 2 drops as hand 3 ends: paused again, and back within the
    // grace it is still playing, so the table deals at once.
    const seats = { 0: clients[0], 2: two.client }
    await playOut(matchId, seats, fold)
    await clients[0].next((f) => f.t === 'reveal' && f.handNo === 3)
    await leave(matchId, two.client, 'rz-2')
    await elapse(matchId, NEXT_HAND_MS)
    ;({ match } = await peek(matchId))
    expect(match).toMatchObject({ status: 'waiting', handNo: 3 })
    await elapse(matchId, 10_000)
    const again = await comeBack(matchId, 'rz-2')
    expect(rosterOf(again.welcome, 2).status).toBe('playing')
    await again.client.next(isState(4))
    expect((await peek(matchId)).hand!.config.seats.map((s) => s.seat)).toEqual(
      [0, 2],
    )
    checkFrames(
      [two.client, again.client, ...Object.values(clients)].flatMap(
        (c) => c.frames,
      ),
      'six-casual',
    )
  }, 30_000)
})

describe('a restart while a player is away', () => {
  it('a grace that began before a Durable Object restart still ends with a sit-out', async () => {
    const { matchId, clients: before, dealtAt } = await handTwo('rr')
    // Seat 4 drops as hand 2 starts; the object restarts 20 s later.
    await leave(matchId, before[4], 'rr-4')
    await abortAllDurableObjects()
    await freezeClock(matchId, dealtAt + 20_000)
    expect(await storedDeadlines(matchId)).toContainEqual({
      kind: 'grace',
      at: dealtAt + GRACE_MS,
      seat: 4,
      userId: 'rr-4',
    })
    // Seats 0 and 2 come back and call; seat 4's option runs from now.
    const clients: Record<SeatId, Client> = {}
    for (const seat of [0, 2] as SeatId[])
      clients[seat] = (await comeBack(matchId, `rr-${seat}`)).client
    await move(matchId, clients, call)
    await move(matchId, clients, call)
    // At 60 s the grace ends: seat 4 sits out, still in hand 2, with its
    // turn on the normal clock (20 s and the 30 s bank from its start).
    await at(matchId, dealtAt + GRACE_MS)
    expect(await storedSeat(matchId, 4)).toMatchObject({
      status: 'sitting_out',
      outSince: dealtAt + GRACE_MS,
    })
    expect((await peek(matchId)).hand!.toAct).toBe(4)
    expect(clockAt(clients[0], 2, 2)).toEqual({
      toAct: 4,
      deadline: dealtAt + 20_000 + 50_000,
      bankMs: 30_000,
    })
    // Sitting out changes none of its turns in this hand: that one runs
    // out at 70 s (a check), and on the flop, after seat 2 checks, it has
    // 20 s again, its bank spent, not an instant move as a rated seat
    // away would.
    await at(matchId, dealtAt + 70_000 - 1)
    expect((await peek(matchId)).hand!.actions).toHaveLength(2)
    await at(matchId, dealtAt + 70_000)
    expect((await peek(matchId)).hand!.actions.at(-1)).toMatchObject({
      seat: 4,
      action: { type: 'check' },
    })
    await move(matchId, clients, check)
    expect(clockAt(clients[0], 2, 4)).toEqual({
      toAct: 4,
      deadline: dealtAt + 90_000,
      bankMs: 0,
    })

    // A player back within the grace after a restart keeps playing: seat
    // 2 drops between hands at a table of two, the object restarts, and
    // seat 2 is back 30 s after it left.
    const other = await sixTable()
    const two: Record<SeatId, Client> = {
      0: await sitDown(other, 'rb-0', 0),
      2: await sitDown(other, 'rb-2', 2),
    }
    await two[0].next(isState(1))
    await playOut(other, two, fold)
    await two[0].next((f) => f.t === 'reveal' && f.handNo === 1)
    const left = await clockOf(other)
    await leave(other, two[2], 'rb-2')
    await abortAllDurableObjects()
    await freezeClock(other, left + 30_000)
    const zero = await comeBack(other, 'rb-0')
    const back = await comeBack(other, 'rb-2')
    expect(rosterOf(back.welcome, 2).status).toBe('playing')
    expect(await graces(other)).toEqual([])
    // Hand 2 deals both, and past the grace seat 2 is still playing.
    await elapse(other, 0)
    await back.client.next(isState(2))
    await at(other, left + GRACE_MS + 1)
    expect((await storedSeat(other, 2)).status).toBe('playing')
    checkFrames(
      [...Object.values(clients), zero.client, back.client].flatMap(
        (c) => c.frames,
      ),
      'six-casual',
    )
  }, 30_000)

  it('a player whose socket a restart closed unseen gets the grace at the next alarm', async () => {
    // A restart drops every socket, and the restarted object hears no
    // close for them: nothing would ever time out a player who does not
    // come back to a table that cannot deal.
    const matchId = await sixTable()
    const clients: Record<SeatId, Client> = {
      0: await sitDown(matchId, 'ru-0', 0),
      2: await sitDown(matchId, 'ru-2', 2),
    }
    await clients[0].next(isState(1))
    const t0 = await clockOf(matchId)
    await abortAllDurableObjects()
    await freezeClock(matchId, t0 + 10_000)
    expect(await graces(matchId)).toEqual([])
    // Nobody is back when seat 0's turn runs out at 50 s (a fold, ending
    // hand 1): the alarm that plays it gives both seats their grace.
    await at(matchId, t0 + 50_000)
    expect((await peek(matchId)).hand!.street).toBe('showdown')
    const dueAt = t0 + 50_000 + GRACE_MS
    expect(await graces(matchId)).toEqual([
      { kind: 'grace', at: dueAt, seat: 0, userId: 'ru-0' },
      { kind: 'grace', at: dueAt, seat: 2, userId: 'ru-2' },
    ])
    // Seat 0 is back 5 s later, which ends its own grace; seat 2 never
    // is, and keeps the one the alarm gave it. The next deal finds one
    // player to deal in and waits, its alarm set for the grace's end
    // rather than the idle check ten minutes on.
    await setClock(matchId, t0 + 55_000)
    const zero = await comeBack(matchId, 'ru-0')
    expect(await graces(matchId)).toEqual([
      { kind: 'grace', at: dueAt, seat: 2, userId: 'ru-2' },
    ])
    await elapse(matchId, NEXT_HAND_MS)
    expect((await peek(matchId)).match.status).toBe('waiting')
    expect((await storageOf(matchId)).alarm).toBe(dueAt)
    await at(matchId, dueAt - 1)
    expect((await storedSeat(matchId, 2)).status).toBe('playing')
    await at(matchId, dueAt)
    expect((await storedSeat(matchId, 2)).status).toBe('sitting_out')
    // Five minutes later the seat frees (PR-16's removal).
    await at(matchId, dueAt + 5 * 60_000)
    expect((await seated(matchId)).map((p) => p.seat)).toEqual([0])
    checkFrames(zero.client.frames, 'six-casual')
  }, 30_000)

  it('the first player back after a restart starts the grace of everyone still away', async () => {
    // Without waiting for an alarm, which at a waiting table can be the
    // idle check ten minutes on: a join looks for absent players too.
    const matchId = await sixTable()
    const clients: Record<SeatId, Client> = {
      0: await sitDown(matchId, 'rj-0', 0),
      2: await sitDown(matchId, 'rj-2', 2),
    }
    await clients[0].next(isState(1))
    const t0 = await clockOf(matchId)
    await abortAllDurableObjects()
    await freezeClock(matchId, t0 + 10_000)
    // Seat 0 is back before any alarm; seat 2 never is. Its grace starts
    // with seat 0's join, and is stored at once.
    const zero = await comeBack(matchId, 'rj-0')
    const dueAt = t0 + 10_000 + GRACE_MS
    const grace = { kind: 'grace', at: dueAt, seat: 2, userId: 'rj-2' }
    expect(await graces(matchId)).toEqual([grace])
    expect(await storedDeadlines(matchId)).toContainEqual(grace)
    // Seat 0 folds hand 1; the next deal waits, with the alarm set for the
    // grace's end, and then seat 2 sits out.
    await move(matchId, { 0: zero.client }, fold)
    await zero.client.next((f) => f.t === 'reveal' && f.handNo === 1)
    await elapse(matchId, NEXT_HAND_MS)
    expect((await peek(matchId)).match.status).toBe('waiting')
    expect((await storageOf(matchId)).alarm).toBe(dueAt)
    await at(matchId, dueAt)
    expect((await storedSeat(matchId, 2)).status).toBe('sitting_out')
    checkFrames(zero.client.frames, 'six-casual')
  }, 30_000)
})

/**
 * Holds every lobby claim the table makes until the test lets it go
 * (`letGo(i)`, the i-th claim), and records the releases it sends.
 */
async function holdLobby(matchId: string) {
  // Made here, not in the table: a promise the table made could not be
  // resolved from the test (workerd's per-object I/O rule).
  const gates: (() => void)[] = []
  const holds = Array.from(
    { length: 4 },
    () => new Promise<void>((resolve) => gates.push(resolve)),
  )
  let claims = 0
  const released: string[][] = []
  await runInDurableObject(stub(matchId), (instance: TableDO) => {
    const real = env.LOBBY
    const lobbyOf = (id: DurableObjectId) => {
      const lobby = real.get(id, { locationHint: 'enam' })
      return {
        claim: async (userId: string, table: string) => {
          await holds[claims++]
          return lobby.claim(userId, table)
        },
        release: (userIds: string[], table: string) => {
          released.push(userIds)
          return lobby.release(userIds, table)
        },
      }
    }
    ;(instance as unknown as { env: typeof env }).env = {
      ...env,
      LOBBY: {
        idFromName: (name: string) => real.idFromName(name),
        get: lobbyOf,
      } as unknown as typeof env.LOBBY,
    }
  })
  const until = async (
    what: string,
    done: () => boolean | Promise<boolean>,
  ) => {
    for (let i = 0; i < 400 && !(await done()); i++)
      await new Promise((r) => setTimeout(r, 5))
    expect(await done(), what).toBe(true)
  }
  return {
    released,
    /** Resolves once `n` claims are waiting. */
    asked: (n: number) => until(`${n} claims asked`, () => claims >= n),
    letGo: (i: number) => gates[i](),
    until,
  }
}

/** The table the lobby holds `userId` at, if any. */
const lobbyHolds = (userId: string) =>
  runInDurableObject(lobbyStub(env), (_: LobbyDO, state) =>
    state.storage.get<string>(`active:${userId}`),
  )

describe('a socket that closes while its sit waits on the lobby', () => {
  it('is not seated, and its lobby claim is released', async () => {
    const matchId = await sixTable()
    const lobby = await holdLobby(matchId)
    const client = await connect(matchId, 'rc-0')
    await client.next((f) => f.t === 'welcome')
    client.send({ t: 'sit', seat: 0 })
    // The sit waits on the lobby; its socket closes meanwhile.
    await lobby.asked(1)
    await leave(matchId, client, 'rc-0')
    lobby.letGo(0)
    // Nobody is there to sit: no seat, no grace to run for one, and the
    // account is free for its next table at once rather than held for the
    // grace and the five minutes sitting out.
    await lobby.until('a release sent', () => lobby.released.length > 0)
    expect(lobby.released).toEqual([['rc-0']])
    expect(await seated(matchId)).toEqual([])
    expect(await graces(matchId)).toEqual([])
    expect(await lobbyHolds('rc-0')).toBeUndefined()
  })

  it('leaves the claim to a second tab whose sit is still waiting', async () => {
    // A tab sits, and a second tab of the same account replaces it while
    // that sit waits on the lobby, then sits too. The first sit finds its
    // socket closed and takes no seat, but must not release the claim the
    // second one is about to be seated under.
    const matchId = await sixTable()
    const lobby = await holdLobby(matchId)
    const first = await connect(matchId, 'rt-0')
    await first.next((f) => f.t === 'welcome')
    first.send({ t: 'sit', seat: 0 })
    await lobby.asked(1)
    const second = await connect(matchId, 'rt-0')
    await second.next((f) => f.t === 'welcome')
    const from = second.frames.length
    second.send({ t: 'sit', seat: 3 })
    await lobby.asked(2)
    // The first claim answers; its sit is done once only the second one
    // is still claiming.
    lobby.letGo(0)
    const claiming = () =>
      runInDurableObject(
        stub(matchId),
        (instance: TableDO) =>
          (instance as unknown as { claiming: Map<string, number> }).claiming,
      )
    await lobby.until(
      'the first sit done',
      async () => (await claiming()).get('rt-0') === 1,
    )
    expect(await seated(matchId)).toEqual([])
    lobby.letGo(1)
    await second.next((f) => f.t === 'welcome' && f.seat === 3, from)
    expect(await seated(matchId)).toMatchObject([
      { seat: 3, userId: 'rt-0', status: 'playing' },
    ])
    expect(lobby.released).toEqual([])
    expect(await lobbyHolds('rt-0')).toBe(matchId)
  })

  it('a sit whose seat went meanwhile leaves the claim to another sit still waiting', async () => {
    // One page asks for seat 0, then seat 3, before the table answers.
    // Someone else takes seat 0 meanwhile. The first sit takes no seat,
    // but must not release the claim the second is about to sit under.
    const matchId = await sixTable()
    const lobby = await holdLobby(matchId)
    const page = await connect(matchId, 'rw-0')
    await page.next((f) => f.t === 'welcome')
    const from = page.frames.length
    page.send({ t: 'sit', seat: 0 })
    await lobby.asked(1)
    page.send({ t: 'sit', seat: 3 })
    await lobby.asked(2)
    const other = await connect(matchId, 'rw-x')
    await other.next((f) => f.t === 'welcome')
    other.send({ t: 'sit', seat: 0 })
    await lobby.asked(3)
    lobby.letGo(2)
    await other.next((f) => f.t === 'welcome' && f.seat === 0)
    lobby.letGo(0)
    expect(
      await page.next((f) => f.t === 'error' && f.code === 'seat_taken', from),
    ).toBeTruthy()
    lobby.letGo(1)
    await page.next((f) => f.t === 'welcome' && f.seat === 3, from)
    expect(lobby.released).toEqual([])
    expect(await lobbyHolds('rw-0')).toBe(matchId)
  })
})

describe('a grace and the seat it was for', () => {
  it('a player stood up during their grace gets a whole grace when they sit again and drop', async () => {
    const { matchId, clients, dealtAt } = await handTwo('rs')
    // Seat 5 sits during hand 2, is not dealt in, and drops.
    clients[5] = await sitDown(matchId, 'rs-5', 5)
    await leave(matchId, clients[5], 'rs-5')
    expect(await graces(matchId)).toEqual([
      { kind: 'grace', at: dealtAt + GRACE_MS, seat: 5, userId: 'rs-5' },
    ])
    // Within the grace the table stands it up for sitting out too long,
    // as two quick timeouts and three quick orbit starts can: its stored
    // status and sit-out time say so here.
    await runInDurableObject(stub(matchId), (instance: TableDO) => {
      const { match } = instance as unknown as { match: { players: Stored[] } }
      Object.assign(bySeat(match.players, 5), {
        status: 'sitting_out',
        outOrbits: 0,
        outSince: dealtAt - 5 * 60_000,
      })
    })
    await elapse(matchId, 0) // arms the sit-out alarm, due now
    await elapse(matchId, 0) // which stands seat 5 up
    expect((await seated(matchId)).map((p) => p.seat)).toEqual([0, 2, 4])
    expect(await graces(matchId)).toEqual([])
    // Back at once (a removal has no cooldown), it sits in seat 5 again
    // and drops 30 s later: its grace is a whole new 60 s.
    const again = await comeBack(matchId, 'rs-5')
    expect(again.welcome.seat).toBeNull()
    const from = again.client.frames.length
    again.client.send({ t: 'sit', seat: 5 })
    await again.client.next((f) => f.t === 'welcome' && f.seat === 5, from)
    await setClock(matchId, dealtAt + 30_000)
    await leave(matchId, again.client, 'rs-5')
    expect(await graces(matchId)).toEqual([
      {
        kind: 'grace',
        at: dealtAt + 30_000 + GRACE_MS,
        seat: 5,
        userId: 'rs-5',
      },
    ])
    await at(matchId, dealtAt + GRACE_MS)
    expect((await storedSeat(matchId, 5)).status).toBe('playing')
    await at(matchId, dealtAt + 30_000 + GRACE_MS)
    expect((await storedSeat(matchId, 5)).status).toBe('sitting_out')
  }, 30_000)
})

describe('heads-up away rules', () => {
  it('heads-up casual has no grace, and rated keeps its grace, instant turns and void', async () => {
    // Casual heads-up: a seat that drops gets no grace and no status; its
    // turns run on the normal clock, and the third miss still forfeits.
    const casual = await createTable('hc-a')
    await freezeClock(casual)
    const seats: Record<SeatId, Client> = {
      0: await connect(casual, 'hc-a'),
      1: await connect(casual, 'hc-b'),
    }
    await seats[0].next(isState(1))
    await leave(casual, seats[0], 'hc-a')
    expect(await graces(casual)).toEqual([])
    // Past the grace a rated seat would have had, to the end of its own
    // turn: 20 s and its 60 s bank.
    await elapse(casual, GRACE_MS + 20_000)
    expect(await graces(casual)).toEqual([])
    const players = (await seated(casual)).map((p) => ({ ...p }))
    for (const p of players) {
      expect(p).not.toHaveProperty('status')
      expect(p).not.toHaveProperty('awaySince')
    }
    expect(players.map((p) => p.timeouts)).toEqual([1, 0])
    expect((await peek(casual)).match.status).toBe('playing')
    // Seat 1 plays its own decisions; seat 0, still gone, misses two more,
    // and the third in a row forfeits the match.
    for (
      let i = 0;
      i < 30 && (await peek(casual)).match.status === 'playing';
      i++
    ) {
      const { hand } = await peek(casual)
      if (!hand || hand.street === 'showdown')
        await elapse(casual, NEXT_HAND_MS)
      else if (hand.toAct === 1) await move(casual, seats, passive)
      else await elapse(casual, GRACE_MS + 20_000)
    }
    expect(await storedSeat(casual, 0)).toMatchObject({ timeouts: 3 })
    expect(await seats[1].next((f) => f.t === 'match_end')).toMatchObject({
      result: { reason: 'forfeit', forfeit: 0 },
    })

    // Rated: the grace is the seat's, stored as it always was; after it
    // the absent seat's turn is played at once, and both gone is void.
    const rated = crypto.randomUUID()
    const body: InitBody = {
      matchId: rated,
      creator: { userId: 'hr-a', username: 'hr-a' },
      opponent: { userId: 'hr-b', username: 'hr-b' },
      kind: 'hu-rated',
    }
    const made = await stub(rated).fetch('https://table/init', {
      method: 'POST',
      body: JSON.stringify(body),
    })
    expect(made.status).toBe(201)
    await freezeClock(rated)
    const t = await clockOf(rated)
    const r: Record<SeatId, Client> = {
      0: await connect(rated, 'hr-a'),
      1: await connect(rated, 'hr-b'),
    }
    await r[0].next(isState(1))
    await move(rated, r, passive) // seat 0 limps; seat 1 to act
    await leave(rated, r[1], 'hr-b')
    expect(await graces(rated)).toEqual([
      { kind: 'grace', at: t + GRACE_MS, seat: 1 },
    ])
    await elapse(rated, GRACE_MS)
    expect((await peek(rated)).hand!.actions).toHaveLength(2)
    expect(await storedSeat(rated, 1)).toMatchObject({
      awaySince: t + GRACE_MS,
      timeouts: 1,
    })
    expect(await storedSeat(rated, 1)).not.toHaveProperty('status')
    await leave(rated, r[0], 'hr-a')
    await elapse(rated, GRACE_MS)
    const { match } = await peek(rated)
    expect(match.status).toBe('finished')
    expect(
      match as unknown as { endReason: string; abandoned: SeatId[] },
    ).toMatchObject({ endReason: 'abandoned', abandoned: [0, 1] })
  }, 30_000)
})
