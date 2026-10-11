// Sitting out at a casual 6-max table (ADR amendment 2026-10-10, "Sitting
// out" and "Stacks and rebuy"). Two missed decisions in a row, a voluntary
// sit_out or an empty stack sit a player out from the next hand: the hand
// in play finishes on the normal clock, and a player sitting out is not
// dealt in. sit_in (or, at 0 chips, a rebuy) deals them in again from the
// next hand. Heads-up is untouched: its third missed decision forfeits.
import { env, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { legalActions } from '../../src/engine/hand'
import { deckWith } from '../../src/engine/testing'
import type { HandState, PlayerAction, SeatId } from '../../src/engine/types'
import type {
  ClientMsg,
  MatchConfig,
  ServerMsg,
} from '../../src/shared/protocol'
import { CashController } from '../src/controller'
import type { Roster, TableController } from '../src/controller'
import { lobbyStub } from '../src/lobby'
import type { LobbyDO } from '../src/lobby'
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

/**
 * The table's own controller, except that while `holes` is set each seat
 * dealt in that it names gets those hole cards, over `board`: a test can
 * decide who wins a showdown, and so who loses their last chip.
 */
class Rigged implements TableController {
  private readonly inner = new CashController()
  holes: Record<number, string> | null = null
  board = 'Kc Qd 9h 4s 3s'
  nextHandPlan(handNo: number, config: MatchConfig, roster?: Roster) {
    const plan = this.inner.nextHandPlan(handNo, config, roster)
    if (plan && this.holes) {
      const dealt = plan.config.seats.map((s) => s.seat)
      const holes = Object.fromEntries(
        Object.entries(this.holes).filter(([s]) => dealt.includes(Number(s))),
      )
      plan.deck = deckWith(plan.config, holes, this.board)
    }
    return plan
  }
}

/** Gives the table `controller` to deal from (until a restart). */
const rig = (matchId: string, controller: TableController) =>
  runInDurableObject(stub(matchId), (instance: TableDO) => {
    instance.sixController = controller
  })

/** Sets `seat`'s stored stack, for a player not dealt into the last hand. */
const setStack = (matchId: string, seat: SeatId, stack: number) =>
  runInDurableObject(stub(matchId), (instance: TableDO) => {
    const { match } = instance as unknown as {
      match: { players: { seat: SeatId; stack: number }[] }
    }
    match.players.find((p) => p.seat === seat)!.stack = stack
  })

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

/** The last frame a client received. */
const last = (frames: ServerMsg[]) => frames.at(-1)!

/** The views of hand `handNo` a client received. */
const viewsOf = (frames: ServerMsg[], handNo: number) =>
  frames.flatMap((f) =>
    (f.t === 'state' || f.t === 'welcome') && f.view?.handNo === handNo
      ? [f.view]
      : [],
  )

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

/** The lobby's one-table claims, account to table. */
const claims = () =>
  runInDurableObject(lobbyStub(env), async (_: LobbyDO, state) => {
    const rows = await state.storage.list<string>({ prefix: 'active:' })
    return Object.fromEntries(
      [...rows].map(([key, matchId]) => [key.slice('active:'.length), matchId]),
    )
  })

/** Waits for `test`; the lobby is told of a removal after its frames go out. */
async function eventually(test: () => Promise<boolean>) {
  for (let i = 0; i < 400; i++) {
    if (await test()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('never happened')
}

/** `client` asks for `seat`; resolves with its seated welcome or the error. */
async function trySit(client: Client, seat: SeatId) {
  const from = client.frames.length
  client.send({ t: 'sit', seat })
  return client.next(
    (f) => f.t === 'error' || (f.t === 'welcome' && f.seat !== null),
    from,
  )
}

/** Seats as `client` saw them last. */
const seatsIn = (f: ServerMsg) =>
  f.t === 'welcome' || f.t === 'state' ? f.table.players.map((p) => p.seat) : []

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

describe('standing up a player who sits out', () => {
  it('two timeouts sit a player out and three orbits out remove them', async () => {
    const matchId = await sixTable()
    const watcher = await connect(matchId, 'tr-w')
    await watcher.next((f) => f.t === 'welcome')
    const clients: Record<SeatId, Client> = {
      0: await sitDown(matchId, 'tr-0', 0),
      2: await sitDown(matchId, 'tr-2', 2),
    }
    await clients[0].next(isState(1))
    clients[4] = await sitDown(matchId, 'tr-4', 4)
    // Hand 2: button 0, small blind 2, big blind 4. The others call and
    // seat 4 runs out of time twice: it checks its big blind, then the
    // flop. Two in a row: it sits out from hand 3, and even a socket
    // without a seat hears it at once.
    let hand = await nextHand(matchId, clients, fold)
    expect(hand.config).toMatchObject({ button: 0, sb: 2, bb: 4 })
    await move(matchId, clients, passive)
    await move(matchId, clients, passive)
    await timeOut(matchId)
    await move(matchId, clients, passive)
    const seen = watcher.frames.length
    await timeOut(matchId)
    hand = (await peek(matchId)).hand!
    expect(hand.actions.slice(-2)).toMatchObject([
      { seat: 2, action: { type: 'check' } },
      { seat: 4, action: { type: 'check' } },
    ])
    expect(hand.street).toBe('flop')
    const told = await watcher.next(
      (f) => f.t === 'state' && statusOf(f, 4) === 'sitting_out',
      seen,
    )
    expect(told).toMatchObject({ view: null })
    // The hand finishes on the normal clock: seat 4's next turn has its
    // 20 s (its bank went on the first timeout), not an instant fold.
    await move(matchId, clients, passive)
    await move(matchId, clients, passive)
    const t = await clockOf(matchId)
    expect(clockAt(clients[0], 2, hand.actions.length + 2)).toEqual({
      toAct: 4,
      deadline: t + 20_000,
      bankMs: 0,
    })
    await elapse(matchId, 20_000 - 1)
    expect((await peek(matchId)).hand!.toAct).toBe(4)
    await elapse(matchId, 1)
    // A third in a row: a six table never forfeits anyone.
    expect((await peek(matchId)).match.status).toBe('playing')
    const players = { 0: clients[0], 2: clients[2] }
    await playOut(matchId, { ...players, 4: clients[4] }, fold)
    await clients[0].next((f) => f.t === 'reveal' && f.handNo === 2)
    await elapse(matchId, NEXT_HAND_MS)
    await clients[0].next(isState(3))

    // From hand 3 the big blind goes round seats 0 and 2 alone: hands 4,
    // 6 and 8 start orbits (PR-15's orbitDone), the third of them the
    // third orbit start since seat 4 sat out.
    for (let n = 3; n < 8; n++) {
      hand = (await peek(matchId)).hand!
      expect(hand.config.handNo).toBe(n)
      expect(hand.config.seats.map((s) => s.seat)).toEqual([0, 2])
      expect(seatsIn(last(watcher.frames))).toEqual([0, 2, 4])
      await nextHand(matchId, players, fold)
    }
    // Hand 8 is dealt without it, and its seat frees as it is dealt: it
    // has no seat, everyone sees the seat empty, and the lobby lets the
    // account go.
    hand = (await peek(matchId)).hand!
    expect(hand.config).toMatchObject({ handNo: 8, bb: 2 })
    expect((await seated(matchId)).map((p) => p.seat)).toEqual([0, 2])
    expect(last(clients[4].frames)).toMatchObject({
      t: 'welcome',
      seat: null,
      view: null,
    })
    expect(
      clients[4].frames.some((f) => f.t === 'hand_start' && f.handNo === 8),
    ).toBe(false)
    expect(seatsIn(last(watcher.frames))).toEqual([0, 2])
    await eventually(async () => !('tr-4' in (await claims())))
    expect(await claims()).toEqual({ 'tr-0': matchId, 'tr-2': matchId })
    // Stood up, not standing: no cooldown, so it may sit again at once,
    // and is dealt in from hand 9 like any newcomer.
    expect(await trySit(clients[4], 4)).toMatchObject({
      t: 'welcome',
      seat: 4,
    })
    hand = await nextHand(matchId, players, fold)
    expect(hand.config.seats.map((s) => s.seat)).toEqual([0, 2, 4])
    checkFrames(
      [watcher, ...Object.values(clients)].flatMap((c) => c.frames),
      'six-casual',
    )
  }, 60_000)

  it("a removed player's lobby claim is released", async () => {
    const matchId = await sixTable()
    const clients: Record<SeatId, Client> = {
      0: await sitDown(matchId, 'rc-0', 0),
      2: await sitDown(matchId, 'rc-2', 2),
    }
    await clients[0].next(isState(1))
    // Seat 4 sits down during hand 1 and sits out before it is dealt any.
    const out = await sitDown(matchId, 'rc-4', 4)
    await sitOut(out)
    expect(await claims()).toMatchObject({ 'rc-4': matchId })
    // Big blinds 2, 0, 2, 0, 2, 0, 2: hands 3, 5 and 7 start orbits.
    for (let n = 1; n < 7; n++) {
      expect((await seated(matchId)).map((p) => p.seat)).toEqual([0, 2, 4])
      await nextHand(matchId, clients, fold)
    }
    expect((await peek(matchId)).hand!.config.handNo).toBe(7)
    expect((await seated(matchId)).map((p) => p.seat)).toEqual([0, 2])
    await eventually(async () => !('rc-4' in (await claims())))
    // Free for another table: it sits at one, and the lobby holds it there.
    const other = await sixTable()
    const there = await sitDown(other, 'rc-4', 3)
    expect(last(there.frames)).toMatchObject({ t: 'welcome', seat: 3 })
    expect(await claims()).toMatchObject({ 'rc-4': other })
  }, 30_000)
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

describe('a busted player at a six table', () => {
  it('a busted player sits out until a rebuy deals them in, without sit_in', async () => {
    const matchId = await sixTable()
    const rigged = new Rigged()
    await rig(matchId, rigged)
    const watcher = await connect(matchId, 'bo-w')
    await watcher.next((f) => f.t === 'welcome')
    const clients: Record<SeatId, Client> = {
      0: await sitDown(matchId, 'bo-0', 0),
      2: await sitDown(matchId, 'bo-2', 2),
    }
    await clients[0].next(isState(1))
    // Seat 4 sits during hand 1 and starts hand 2 on 100 chips, in the big
    // blind, with seven high against seat 0's aces.
    clients[4] = await sitDown(matchId, 'bo-4', 4)
    await setStack(matchId, 4, 100)
    rigged.holes = { 0: 'As Ad', 4: '7c 2h' }
    const two = await nextHand(matchId, clients, fold)
    rigged.holes = null
    expect(two.config).toMatchObject({ button: 0, sb: 2, bb: 4 })
    expect(two.config.seats).toContainEqual({ seat: 4, stack: 100 })
    await move(matchId, clients, () => ({ type: 'raise', to: 200 }))
    await move(matchId, clients, fold)
    // Seat 4 calls its last 80 chips and loses them at the showdown: no
    // chips, so it sits out, and every socket hears it as the hand ends.
    const seen = watcher.frames.length
    await move(matchId, clients, () => ({ type: 'call' }))
    const ended = (await peek(matchId)).hand!
    expect(ended.street).toBe('showdown')
    expect(bySeat(ended.players, 4).stack).toBe(0)
    const told = await watcher.next(
      (f) => f.t === 'state' && statusOf(f, 4) === 'sitting_out',
      seen,
    )
    expect(rosterOf(told, 4)).toMatchObject({ stack: 0 })
    // It cannot sit in with nothing to play: it must rebuy.
    expect(await sitIn(clients[4])).toMatchObject({
      t: 'error',
      code: 'no_chips',
    })

    // Hand 3 deals seats 0 and 2 only.
    await clients[0].next((f) => f.t === 'reveal' && f.handNo === 2)
    await elapse(matchId, NEXT_HAND_MS)
    await clients[0].next(isState(3))
    expect((await peek(matchId)).hand!.config.seats.map((s) => s.seat)).toEqual(
      [0, 2],
    )
    // A rebuy at 0 chips while hand 3 is played: 100 bb, and playing.
    const topped = await answer(clients[4], { t: 'rebuy' })
    expect(rosterOf(topped, 4)).toMatchObject({
      stack: 2000,
      status: 'playing',
    })
    // Hand 4 deals it in, with no sit_in sent.
    const four = await nextHand(matchId, { 0: clients[0], 2: clients[2] })
    expect(four.config.seats.map((s) => s.seat)).toEqual([0, 2, 4])
    expect(four.config.seats).toContainEqual({ seat: 4, stack: 2000 })
    checkFrames(
      [watcher, ...Object.values(clients)].flatMap((c) => c.frames),
      'six-casual',
    )
  }, 30_000)

  it('a player who loses their last chips in a hand over at the deal sits out', async () => {
    const matchId = await sixTable()
    const rigged = new Rigged()
    await rig(matchId, rigged)
    const watcher = await connect(matchId, 'bd-w')
    await watcher.next((f) => f.t === 'welcome')
    const clients: Record<SeatId, Client> = {
      0: await sitDown(matchId, 'bd-0', 0),
      2: await sitDown(matchId, 'bd-2', 2),
    }
    await clients[0].next(isState(1))
    // Hand 1: seat 0 folds its small blind. Then seat 2 is left with 10
    // chips (as a lost all-in would), and hand 2 makes it the button and
    // small blind: its 10 chips are all in at the deal, against seat 0's
    // big blind and aces, and the hand is over before anyone acts.
    await move(matchId, clients, fold)
    await clients[0].next((f) => f.t === 'reveal' && f.handNo === 1)
    await runInDurableObject(stub(matchId), (instance: TableDO) => {
      const { hand } = instance as unknown as { hand: HandState }
      bySeat(hand.players, 0).stack += bySeat(hand.players, 2).stack - 10
      bySeat(hand.players, 2).stack = 10
    })
    rigged.holes = { 0: 'As Ad', 2: '7c 2h' }
    const seen = watcher.frames.length
    await elapse(matchId, NEXT_HAND_MS)
    const two = (await peek(matchId)).hand!
    expect(two.config).toMatchObject({ handNo: 2, button: 2, sb: 2, bb: 0 })
    expect(two.actions).toEqual([])
    expect(two.street).toBe('showdown')
    expect(bySeat(two.players, 2).stack).toBe(0)
    const told = await watcher.next(
      (f) => f.t === 'state' && statusOf(f, 2) === 'sitting_out',
      seen,
    )
    expect(rosterOf(told, 2)).toMatchObject({ stack: 0 })
    expect((await seated(matchId)).map((p) => [p.seat, p.status])).toEqual([
      [0, 'playing'],
      [2, 'sitting_out'],
    ])
    checkFrames(
      [watcher, ...Object.values(clients)].flatMap((c) => c.frames),
      'six-casual',
    )
  })
})
