// Sitting out at a casual 6-max table (ADR amendment 2026-10-10, "Sitting
// out" and "Stacks and rebuy"). Two missed decisions in a row, a voluntary
// sit_out or an empty stack sit a player out from the next hand: the hand
// in play finishes on the normal clock, and a player sitting out is not
// dealt in. sit_in (or, at 0 chips, a rebuy) deals them in again from the
// next hand. Heads-up is untouched: its third missed decision forfeits.
import {
  abortAllDurableObjects,
  env,
  runInDurableObject,
} from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { legalActions } from '../../src/engine/hand'
import { deckWith } from '../../src/engine/testing'
import type { HandState, PlayerAction, SeatId } from '../../src/engine/types'
import type {
  ClientMsg,
  MatchConfig,
  ServerMsg,
} from '../../src/shared/protocol'
import { forgetUsernames } from '../src/auth'
import { CashController } from '../src/controller'
import type { Roster, TableController } from '../src/controller'
import { lobbyStub } from '../src/lobby'
import type { LobbyDO } from '../src/lobby'
import { NEXT_HAND_MS } from '../src/table'
import type { InitBody, TableDO } from '../src/table'
import { dealSlots } from '../../src/engine/deck'
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

/** How long a player sits out before they are stood up (ADR "Sitting out"). */
const FIVE_MINUTES = 5 * 60_000

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

/** The table's stored deadlines, as a restarted object reads them. */
const storedDeadlines = (matchId: string) =>
  runInDurableObject(stub(matchId), (_: TableDO, state) =>
    state.storage.get<{ kind: string; at: number }[]>('deadlines'),
  )

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
  outOrbits?: number
  outSince?: number
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
    // A sit_in from a player who is playing changes nothing, not even
    // their missed decisions: the player to act in hand 4 runs out of
    // time (and folds), then sends one.
    const actor = (await peek(matchId)).hand!.toAct as SeatId
    await timeOut(matchId)
    const already = await sitIn(clients[actor])
    expect(rosterOf(already, actor)).toMatchObject({
      status: 'playing',
      consecutiveTimeouts: 1,
    })
    roster = (await seated(matchId)).find((p) => p.seat === actor)!
    expect(roster).toMatchObject({ status: 'playing', timeouts: 1 })

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

  it('a player sitting out is stood up after 5 minutes without a dealt hand', async () => {
    const matchId = await sixTable()
    const watcher = await connect(matchId, 'fm-w')
    await watcher.next((f) => f.t === 'welcome')
    const clients: Record<SeatId, Client> = {
      0: await sitDown(matchId, 'fm-0', 0),
      2: await sitDown(matchId, 'fm-2', 2),
    }
    await clients[0].next(isState(1))
    await playOut(matchId, clients, fold)
    await clients[0].next((f) => f.t === 'reveal' && f.handNo === 1)
    // Between hands seat 2 sits out: the next deal has one player to deal
    // in, so the table waits, and no orbit can pass to stand it up.
    const t = await clockOf(matchId)
    await sitOut(clients[2])
    // The sit_out arms its own alarm, for five minutes from now.
    expect(await storedDeadlines(matchId)).toContainEqual({
      kind: 'sitout',
      at: t + FIVE_MINUTES,
    })
    await elapse(matchId, NEXT_HAND_MS)
    expect((await peek(matchId)).match.status).toBe('waiting')
    await elapse(matchId, FIVE_MINUTES - NEXT_HAND_MS - 1)
    expect((await seated(matchId)).map((p) => p.seat)).toEqual([0, 2])
    // Five minutes after it sat out, it is stood up.
    const seen = watcher.frames.length
    await elapse(matchId, 1)
    expect(await clockOf(matchId)).toBe(t + FIVE_MINUTES)
    expect((await seated(matchId)).map((p) => p.seat)).toEqual([0])
    expect(last(clients[2].frames)).toMatchObject({
      t: 'welcome',
      seat: null,
      view: null,
    })
    await watcher.next(
      (f) => f.t === 'state' && seatsIn(f).join() === '0',
      seen,
    )
    await eventually(async () => !('fm-2' in (await claims())))
    expect(await claims()).toEqual({ 'fm-0': matchId })
    // Stood up by the alarm, not standing: no cooldown, so it may sit
    // again at once.
    expect(await trySit(clients[2], 2)).toMatchObject({
      t: 'welcome',
      seat: 2,
    })
    checkFrames(
      [watcher, ...Object.values(clients)].flatMap((c) => c.frames),
      'six-casual',
    )
  })

  it('a player who sits out during a hand they are dealt into keeps the seat until it ends', async () => {
    const { matchId, clients } = await threeSeats('mh')
    let hand = await nextHand(matchId, clients, fold)
    expect(hand.config).toMatchObject({ button: 0, sb: 2, bb: 4 })
    // Seat 4, the big blind, sits out as hand 2 begins. Five minutes pass
    // with the hand still on (seat 0's turn runs out and it folds): seat 4
    // keeps its seat and its cards, and its moves are its own.
    await sitOut(clients[4])
    await elapse(matchId, FIVE_MINUTES)
    hand = (await peek(matchId)).hand!
    expect(hand.config.handNo).toBe(2)
    expect(hand.actions).toMatchObject([{ seat: 0, action: { type: 'fold' } }])
    expect((await seated(matchId)).map((p) => p.seat)).toEqual([0, 2, 4])
    await move(matchId, clients, () => ({ type: 'call' }))
    await move(matchId, clients, () => ({ type: 'check' }))
    await playOut(matchId, clients, fold)
    await clients[2].next((f) => f.t === 'reveal' && f.handNo === 2)
    expect((await seated(matchId)).map((p) => p.seat)).toEqual([0, 2, 4])
    // The hand is over and its five minutes long past: the alarm its end
    // armed stands seat 4 up before the next deal.
    await elapse(matchId, 0)
    expect((await seated(matchId)).map((p) => p.seat)).toEqual([0, 2])
    expect(last(clients[4].frames)).toMatchObject({ t: 'welcome', seat: null })
    checkFrames(
      Object.values(clients).flatMap((c) => c.frames),
      'six-casual',
    )
  })

  it('a sit_in and sit_out with no dealt hand between keeps the five-minute clock', async () => {
    const matchId = await sixTable()
    const clients: Record<SeatId, Client> = {
      0: await sitDown(matchId, 'tg-0', 0),
      2: await sitDown(matchId, 'tg-2', 2),
    }
    await clients[0].next(isState(1))
    await playOut(matchId, clients, fold)
    await clients[0].next((f) => f.t === 'reveal' && f.handNo === 1)
    // Seat 2 sits out between hands and the table waits; a minute later
    // seat 0 sits out too.
    const t = await clockOf(matchId)
    await sitOut(clients[2])
    await elapse(matchId, NEXT_HAND_MS)
    expect((await peek(matchId)).match.status).toBe('waiting')
    await elapse(matchId, 60_000 - NEXT_HAND_MS)
    await sitOut(clients[0])
    // Seat 0 sits in and straight out again, twice, the second time after
    // seat 2 has been stood up. No sit_in deals a hand (there is never a
    // second player to deal in), so none restarts its five minutes: they
    // run from its first sit_out, and the alarm stays there.
    for (const at of [3 * 60_000, 5.5 * 60_000]) {
      await elapse(matchId, t + at - (await clockOf(matchId)))
      expect(statusOf(await sitIn(clients[0]), 0)).toBe('playing')
      expect(statusOf(await sitOut(clients[0]), 0)).toBe('sitting_out')
    }
    expect((await seated(matchId)).map((p) => p.seat)).toEqual([0])
    expect(await storedDeadlines(matchId)).toContainEqual({
      kind: 'sitout',
      at: t + 60_000 + FIVE_MINUTES,
    })
    await elapse(
      matchId,
      t + 60_000 + FIVE_MINUTES - 1 - (await clockOf(matchId)),
    )
    expect((await seated(matchId)).map((p) => p.seat)).toEqual([0])
    await elapse(matchId, 1)
    expect((await seated(matchId)).map((p) => p.seat)).toEqual([])
    expect(last(clients[0].frames)).toMatchObject({ t: 'welcome', seat: null })
    expect((await peek(matchId)).hand!.config.handNo).toBe(1)
    checkFrames(
      Object.values(clients).flatMap((c) => c.frames),
      'six-casual',
    )
  })

  it('a sit_in and sit_out with no dealt hand between keeps the orbit count', async () => {
    const matchId = await sixTable()
    const clients: Record<SeatId, Client> = {
      0: await sitDown(matchId, 'tt-0', 0),
      2: await sitDown(matchId, 'tt-2', 2),
    }
    await clients[0].next(isState(1))
    // Seat 4 sits down during hand 1 and sits out before it is dealt any.
    // Before every deal it sits in and straight out again, so it is never
    // dealt in; once, with its chips gone, a rebuy is its way back in.
    // Neither restarts its count: big blinds 2, 0, 2, 0, 2, 0, 2 between
    // seats 0 and 2, so hands 3, 5 and 7 are its three orbit starts.
    const toggler = await sitDown(matchId, 'tt-4', 4)
    await sitOut(toggler)
    let from = 0
    for (let n = 1; n < 7; n++) {
      expect((await seated(matchId)).map((p) => p.seat)).toEqual([0, 2, 4])
      await playOut(matchId, clients, fold)
      await clients[0].next((f) => f.t === 'reveal' && f.handNo === n)
      if (n === 3) {
        await setStack(matchId, 4, 0)
        const topped = await answer(toggler, { t: 'rebuy' })
        expect(rosterOf(topped, 4)).toMatchObject({ status: 'playing' })
      } else expect(statusOf(await sitIn(toggler), 4)).toBe('playing')
      expect(statusOf(await sitOut(toggler), 4)).toBe('sitting_out')
      from = toggler.frames.length
      await elapse(matchId, NEXT_HAND_MS)
      await clients[0].next(isState(n + 1))
      const { hand } = await peek(matchId)
      expect(hand!.config.seats.map((s) => s.seat)).toEqual([0, 2])
    }
    expect((await peek(matchId)).hand!.config.handNo).toBe(7)
    expect((await seated(matchId)).map((p) => p.seat)).toEqual([0, 2])
    await toggler.next((f) => f.t === 'welcome' && f.seat === null, from)
    await eventually(async () => !('tt-4' in (await claims())))
    checkFrames(
      [toggler, ...Object.values(clients)].flatMap((c) => c.frames),
      'six-casual',
    )
  }, 30_000)

  it('a dealt hand spends the removal clocks, so the next sit_out starts them again', async () => {
    const matchId = await sixTable()
    const clients: Record<SeatId, Client> = {
      0: await sitDown(matchId, 'dc-0', 0),
      2: await sitDown(matchId, 'dc-2', 2),
    }
    await clients[0].next(isState(1))
    // Seat 4 sits out during hand 1, before it is dealt any. Hand 3 is
    // its first orbit start since (big blinds 2, 0, 2).
    clients[4] = await sitDown(matchId, 'dc-4', 4)
    const since = await clockOf(matchId)
    await sitOut(clients[4])
    const players = { 0: clients[0], 2: clients[2] }
    await nextHand(matchId, players, fold)
    await nextHand(matchId, players, fold)
    const four = () =>
      seated(matchId).then((all) => all.find((p) => p.seat === 4)!)
    expect(await four()).toMatchObject({ outOrbits: 1, outSince: since })
    // It sits in during hand 3: playing, its clocks kept until a deal.
    await sitIn(clients[4])
    expect(await four()).toMatchObject({
      status: 'playing',
      outOrbits: 1,
      outSince: since,
    })
    // Hand 4 deals it in: they are spent. Sitting out during hand 4, it
    // starts both again, from 0 orbit starts and from now.
    const hand = await nextHand(matchId, players, fold)
    expect(hand.config.seats.map((s) => s.seat)).toEqual([0, 2, 4])
    const dealt = await four()
    expect(dealt).not.toHaveProperty('outOrbits')
    expect(dealt).not.toHaveProperty('outSince')
    const again = await clockOf(matchId)
    expect(again).toBeGreaterThan(since)
    await sitOut(clients[4])
    expect(await four()).toMatchObject({
      status: 'sitting_out',
      outOrbits: 0,
      outSince: again,
    })
    checkFrames(
      Object.values(clients).flatMap((c) => c.frames),
      'six-casual',
    )
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
    // A rebuy at 0 chips while hand 3 is played: 100 bb, and playing
    // with no missed decisions, whatever it had missed before.
    await runInDurableObject(stub(matchId), (instance: TableDO) => {
      const { match } = instance as unknown as { match: { players: Stored[] } }
      match.players.find((p) => p.seat === 4)!.timeouts = 1
    })
    const topped = await answer(clients[4], { t: 'rebuy' })
    expect(rosterOf(topped, 4)).toMatchObject({
      stack: 2000,
      status: 'playing',
      consecutiveTimeouts: 0,
    })
    expect((await seated(matchId)).find((p) => p.seat === 4)).toMatchObject({
      status: 'playing',
      timeouts: 0,
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

  it('a busted player who never rebuys is stood up after 3 orbits or 5 minutes', async () => {
    // At a table that deals on without it: the third orbit start.
    const matchId = await sixTable()
    const rigged = new Rigged()
    await rig(matchId, rigged)
    const clients: Record<SeatId, Client> = {
      0: await sitDown(matchId, 'bn-0', 0),
      2: await sitDown(matchId, 'bn-2', 2),
    }
    await clients[0].next(isState(1))
    clients[4] = await sitDown(matchId, 'bn-4', 4)
    await setStack(matchId, 4, 100)
    rigged.holes = { 0: 'As Ad', 4: '7c 2h' }
    await nextHand(matchId, clients, fold)
    rigged.holes = null
    await move(matchId, clients, () => ({ type: 'raise', to: 200 }))
    await move(matchId, clients, fold)
    await move(matchId, clients, () => ({ type: 'call' }))
    expect(bySeat((await peek(matchId)).hand!.players, 4).stack).toBe(0)
    await clients[0].next((f) => f.t === 'reveal' && f.handNo === 2)
    await elapse(matchId, NEXT_HAND_MS)
    await clients[0].next(isState(3))
    // Big blinds 0, 2, 0, 2, 0, 2 from hand 3: hands 4, 6 and 8 start
    // orbits. It is seated, with nothing, until hand 8 is dealt.
    const players = { 0: clients[0], 2: clients[2] }
    for (let n = 3; n < 8; n++) {
      expect((await seated(matchId)).map((p) => p.seat)).toEqual([0, 2, 4])
      await nextHand(matchId, players, fold)
    }
    expect((await peek(matchId)).hand!.config.handNo).toBe(8)
    expect((await seated(matchId)).map((p) => p.seat)).toEqual([0, 2])
    expect(last(clients[4].frames)).toMatchObject({ t: 'welcome', seat: null })
    await eventually(async () => !('bn-4' in (await claims())))

    // At a table of two, which deals nothing without it: five minutes.
    const other = await sixTable()
    const pair = new Rigged()
    await rig(other, pair)
    pair.holes = { 0: 'As Ad', 2: '7c 2h' }
    const two: Record<SeatId, Client> = {
      0: await sitDown(other, 'bt-0', 0),
      2: await sitDown(other, 'bt-2', 2),
    }
    await two[0].next(isState(1))
    await move(other, two, () => ({ type: 'raise', to: 2000 }))
    await move(other, two, () => ({ type: 'call' }))
    expect(bySeat((await peek(other)).hand!.players, 2).stack).toBe(0)
    await two[0].next((f) => f.t === 'reveal' && f.handNo === 1)
    await elapse(other, NEXT_HAND_MS)
    expect((await peek(other)).match.status).toBe('waiting')
    await elapse(other, FIVE_MINUTES - NEXT_HAND_MS - 1)
    expect((await seated(other)).map((p) => p.seat)).toEqual([0, 2])
    await elapse(other, 1)
    expect((await seated(other)).map((p) => p.seat)).toEqual([0])
    expect(last(two[2].frames)).toMatchObject({ t: 'welcome', seat: null })
    await eventually(async () => !('bt-2' in (await claims())))
    checkFrames(
      [...Object.values(clients), ...Object.values(two)].flatMap(
        (c) => c.frames,
      ),
      'six-casual',
    )
  }, 60_000)
})

describe('sitting out across a restart', () => {
  it('statuses, orbit counts and the five-minute timer survive a Durable Object restart', async () => {
    // Orbits: seat 4 sits out during hand 1; hand 3 is the first orbit
    // start since (big blinds 2, 0, 2 between seats 0 and 2).
    const matchId = await sixTable()
    let clients: Record<SeatId, Client> = {
      0: await sitDown(matchId, 'rs-0', 0),
      2: await sitDown(matchId, 'rs-2', 2),
    }
    await clients[0].next(isState(1))
    clients[4] = await sitDown(matchId, 'rs-4', 4)
    const since = await clockOf(matchId)
    await sitOut(clients[4])
    const players = { 0: clients[0], 2: clients[2] }
    await nextHand(matchId, players, fold)
    await nextHand(matchId, players, fold)
    const t = await clockOf(matchId)
    const before = (await seated(matchId)).find((p) => p.seat === 4)
    expect(before).toMatchObject({
      status: 'sitting_out',
      outOrbits: 1,
      outSince: since,
    })

    await abortAllDurableObjects()
    await freezeClock(matchId, t)
    expect((await seated(matchId)).find((p) => p.seat === 4)).toEqual(before)
    expect(await storedDeadlines(matchId)).toContainEqual({
      kind: 'sitout',
      at: since + FIVE_MINUTES,
    })
    clients = {}
    for (const seat of [0, 2, 4] as SeatId[]) {
      clients[seat] = await connect(matchId, `rs-${seat}`)
      const welcome = await clients[seat].next((f) => f.t === 'welcome')
      expect(statusOf(welcome, 4)).toBe('sitting_out')
    }
    // The count goes on from 1: hands 5 and 7 are the second and third
    // orbit starts, and hand 7 is dealt without seat 4.
    const back = { 0: clients[0], 2: clients[2] }
    for (let n = 3; n < 7; n++) {
      expect((await seated(matchId)).map((p) => p.seat)).toEqual([0, 2, 4])
      await nextHand(matchId, back, fold)
    }
    expect((await peek(matchId)).hand!.config.handNo).toBe(7)
    expect((await seated(matchId)).map((p) => p.seat)).toEqual([0, 2])

    // The timer: seat 2 sits out between hands at a table of two, and the
    // object restarts before anything else is written. The next deal
    // finds one player to deal in and waits, and five minutes after the
    // sit_out seat 2 is stood up.
    const other = await sixTable()
    const two: Record<SeatId, Client> = {
      0: await sitDown(other, 'rt-0', 0),
      2: await sitDown(other, 'rt-2', 2),
    }
    await two[0].next(isState(1))
    await playOut(other, two, fold)
    await two[0].next((f) => f.t === 'reveal' && f.handNo === 1)
    const out = await clockOf(other)
    await sitOut(two[2])
    await abortAllDurableObjects()
    await freezeClock(other, out)
    expect(
      (await seated(other)).map((p) => [p.seat, p.status, p.outSince]),
    ).toEqual([
      [0, 'playing', undefined],
      [2, 'sitting_out', out],
    ])
    for (const seat of [0, 2] as SeatId[]) {
      const again = await connect(other, `rt-${seat}`)
      await again.next((f) => f.t === 'welcome')
    }
    await elapse(other, NEXT_HAND_MS)
    expect((await peek(other)).match.status).toBe('waiting')
    expect((await peek(other)).hand!.config.handNo).toBe(1)
    await elapse(other, FIVE_MINUTES - NEXT_HAND_MS - 1)
    expect((await seated(other)).map((p) => p.seat)).toEqual([0, 2])
    await elapse(other, 1)
    expect((await seated(other)).map((p) => p.seat)).toEqual([0])
    checkFrames(
      Object.values(clients).flatMap((c) => c.frames),
      'six-casual',
    )
  }, 60_000)
})

describe('a bad stored sit-out count', () => {
  const USERS = [
    'a3000000-0000-4000-8000-00000000000a',
    'b3000000-0000-4000-8000-00000000000b',
    'c3000000-0000-4000-8000-00000000000c',
  ]
  afterEach(() => vi.unstubAllGlobals())

  /**
   * Supabase, stubbed: every archive call is recorded. Real accounts, so
   * the table archives, and its incidents reach record_incident.
   */
  function stubArchive() {
    const calls: { rpc: string; p: Record<string, unknown> }[] = []
    const realFetch = globalThis.fetch
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        )
        if (url.origin !== new URL(env.SUPABASE_URL).origin)
          return realFetch(input, init)
        if (url.pathname === '/rest/v1/players') {
          const id = url.searchParams.get('user_id')!.slice(3)
          return Response.json([{ username: `p${USERS.indexOf(id)}` }])
        }
        if (url.pathname.endsWith('/audit_hand'))
          return Response.json({ verified: true })
        if (url.pathname.startsWith('/rest/v1/rpc/'))
          calls.push({
            rpc: url.pathname.slice('/rest/v1/rpc/'.length),
            p: JSON.parse(String(init!.body)).p,
          })
        return new Response(null, { status: 204 })
      },
    )
    forgetUsernames()
    return calls
  }

  /** Sets a stored field of the player in `seat`, in memory and storage. */
  const corrupt = (matchId: string, seat: SeatId, patch: object) =>
    runInDurableObject(stub(matchId), async (instance: TableDO, state) => {
      const { match } = instance as unknown as {
        match: { players: { seat: SeatId }[] }
      }
      Object.assign(match.players.find((p) => p.seat === seat)!, patch)
      await state.storage.put('match', match)
    })

  /** Waits until record_incident has been called `n` times. */
  async function incidents(calls: ReturnType<typeof stubArchive>, n: number) {
    await eventually(
      async () => calls.filter((c) => c.rpc === 'record_incident').length >= n,
    )
    return calls.filter((c) => c.rpc === 'record_incident').map((c) => c.p)
  }

  it('a bad orbit count is reset to 0 and recorded, and the table plays on', async () => {
    const calls = stubArchive()
    const matchId = await sixTable()
    const clients: Record<SeatId, Client> = {
      0: await sitDown(matchId, USERS[0], 0),
      2: await sitDown(matchId, USERS[1], 2),
    }
    await clients[0].next(isState(1))
    // Seat 4 sits out before it is dealt a hand. Hand 3 is the first
    // orbit start since (big blinds 2, 0, 2).
    clients[4] = await sitDown(matchId, USERS[2], 4)
    await sitOut(clients[4])
    const players = { 0: clients[0], 2: clients[2] }
    await nextHand(matchId, players, fold)
    await nextHand(matchId, players, fold)
    expect((await seated(matchId)).find((p) => p.seat === 4)!.outOrbits).toBe(1)
    // Its stored count goes bad. The next deal finds it, sets it to 0
    // (the next orbit start is then its first again) and records an
    // incident with what was stored; nothing halts.
    await corrupt(matchId, 4, { outOrbits: 7 })
    const four = await nextHand(matchId, players, fold)
    expect(four.config.handNo).toBe(4)
    expect((await seated(matchId)).find((p) => p.seat === 4)!.outOrbits).toBe(0)
    const [incident] = await incidents(calls, 1)
    expect(incident).toEqual({
      matchId,
      handNo: 4,
      kind: `sitout_count:${USERS[2]}`,
      detail: {
        userId: USERS[2],
        outOrbits: 7,
        outSince: expect.any(Number),
      },
    })
    // Hands 5, 7 and 9 are its three orbit starts from there.
    for (let n = 4; n < 9; n++) {
      expect((await peek(matchId)).match.status).toBe('playing')
      expect((await seated(matchId)).map((p) => p.seat)).toEqual([0, 2, 4])
      await nextHand(matchId, players, fold)
    }
    expect((await peek(matchId)).hand!.config.handNo).toBe(9)
    expect((await seated(matchId)).map((p) => p.seat)).toEqual([0, 2])
    expect(await incidents(calls, 1)).toHaveLength(1)
  }, 60_000)

  it('a bad sit-out time is reset to now and recorded, and the alarm keeps running', async () => {
    const calls = stubArchive()
    const matchId = await sixTable()
    const clients: Record<SeatId, Client> = {
      0: await sitDown(matchId, USERS[0], 0),
      2: await sitDown(matchId, USERS[1], 2),
    }
    await clients[0].next(isState(1))
    await playOut(matchId, clients, fold)
    await clients[0].next((f) => f.t === 'reveal' && f.handNo === 1)
    await sitOut(clients[2])
    await elapse(matchId, NEXT_HAND_MS)
    expect((await peek(matchId)).match.status).toBe('waiting')
    // Its stored time goes bad: not a number, so no deadline can be read
    // from it. The table looks at once, sets it to now and records it.
    await corrupt(matchId, 2, { outSince: 'soon' })
    await elapse(matchId, 0)
    await elapse(matchId, 0)
    const t = await clockOf(matchId)
    expect((await seated(matchId)).find((p) => p.seat === 2)).toMatchObject({
      status: 'sitting_out',
      outSince: t,
    })
    const [incident] = await incidents(calls, 1)
    expect(incident).toEqual({
      matchId,
      handNo: 1,
      kind: `sitout_count:${USERS[1]}`,
      detail: { userId: USERS[1], outOrbits: 0, outSince: 'soon' },
    })
    // Five minutes from then, it is stood up as anyone would be.
    await elapse(matchId, FIVE_MINUTES - 1)
    expect((await seated(matchId)).map((p) => p.seat)).toEqual([0, 2])
    await elapse(matchId, 1)
    expect((await seated(matchId)).map((p) => p.seat)).toEqual([0])

    // A number can still not be a time this table's clock gave. Later
    // than now, read as it is, it would put the removal off until then,
    // at a table that deals nothing: never. Before 1970 (past the range
    // of a date), the alarm could not be set at all. Seat 0 sits out, and
    // seat 4 sits down and sits out too (nobody to deal in with): one
    // stored time goes a day ahead, the other far back. Both are repaired
    // the same way.
    await sitOut(clients[0])
    clients[4] = await sitDown(matchId, USERS[2], 4)
    await sitOut(clients[4])
    expect((await peek(matchId)).hand!.config.handNo).toBe(1)
    const now = await clockOf(matchId)
    const later = now + 24 * 60 * 60_000
    await corrupt(matchId, 0, { outSince: later })
    await corrupt(matchId, 4, { outSince: -1e300 })
    await elapse(matchId, 0)
    await elapse(matchId, 0)
    expect(
      (await seated(matchId)).map((p) => [p.seat, p.status, p.outSince]),
    ).toEqual([
      [0, 'sitting_out', now],
      [4, 'sitting_out', now],
    ])
    const recorded = (await incidents(calls, 3)).slice(1)
    expect(recorded).toHaveLength(2)
    expect(recorded).toEqual(
      expect.arrayContaining([
        {
          matchId,
          handNo: 1,
          kind: `sitout_count:${USERS[0]}`,
          detail: { userId: USERS[0], outOrbits: 0, outSince: later },
        },
        {
          matchId,
          handNo: 1,
          kind: `sitout_count:${USERS[2]}`,
          detail: { userId: USERS[2], outOrbits: 0, outSince: -1e300 },
        },
      ]),
    )
    await elapse(matchId, FIVE_MINUTES - 1)
    expect((await seated(matchId)).map((p) => p.seat)).toEqual([0, 4])
    await elapse(matchId, 1)
    expect((await seated(matchId)).map((p) => p.seat)).toEqual([])
  })
})

describe('sit-out frames', () => {
  /** Every dealt seat's hole cards in `hand`, as the table holds them. */
  const holes = (hand: HandState) =>
    hand.config.seats.map(({ seat }) =>
      dealSlots(hand.config).holes[seat].map((slot) => hand.deck[slot]),
    )

  it('sit_in and sit_out frames carry only allowed keys', async () => {
    const matchId = await sixTable()
    const rigged = new Rigged()
    await rig(matchId, rigged)
    const watcher = await connect(matchId, 'sf-w')
    await watcher.next((f) => f.t === 'welcome')
    const clients: Record<SeatId, Client> = {
      0: await sitDown(matchId, 'sf-0', 0),
      2: await sitDown(matchId, 'sf-2', 2),
    }
    await clients[0].next(isState(1))
    const one = (await peek(matchId)).hand!
    // Refused, typed: a socket without a seat has nothing to sit out of.
    expect(await sitOut(watcher)).toMatchObject({ code: 'not_seated' })
    expect(await sitIn(watcher)).toMatchObject({ code: 'not_seated' })
    // Seat 4 sits during hand 1 and starts hand 2 on 100 chips.
    clients[4] = await sitDown(matchId, 'sf-4', 4)
    await setStack(matchId, 4, 100)
    rigged.holes = { 0: 'As Ad', 4: '7c 2h' }
    const two = await nextHand(matchId, clients, fold)
    rigged.holes = null
    // Hand 2: seat 2 sits out but plays it (folding to the raise), and
    // seat 4 loses its last chips: both sit out from hand 3, and a sit_in
    // with no chips is refused.
    expect(statusOf(await sitOut(clients[2]), 2)).toBe('sitting_out')
    await move(matchId, clients, () => ({ type: 'raise', to: 200 }))
    await move(matchId, clients, fold)
    await move(matchId, clients, () => ({ type: 'call' }))
    expect(await sitIn(clients[4])).toMatchObject({ code: 'no_chips' })
    await clients[0].next((f) => f.t === 'reveal' && f.handNo === 2)
    await elapse(matchId, NEXT_HAND_MS)
    expect((await peek(matchId)).match.status).toBe('waiting')
    // Seat 2 sits in: two to deal in, so hand 3 deals at once.
    expect(statusOf(await sitIn(clients[2]), 2)).toBe('playing')
    await clients[2].next(isState(3))
    const three = await playOut(matchId, { 0: clients[0], 2: clients[2] })
    await clients[0].next((f) => f.t === 'reveal' && f.handNo === 3)

    const all = [watcher, ...Object.values(clients)].flatMap((c) => c.frames)
    expect(checkFrames(all, 'six-casual')).toEqual(new Set(FLOW_TYPES.sitOut))
    expect(analysisKeys(all)).toEqual([])
    // The socket without a seat heard every status change, never a hand.
    for (const f of watcher.frames) {
      expect(['welcome', 'state', 'error']).toContain(f.t)
      if (f.t === 'welcome' || f.t === 'state') expect(f.view).toBeNull()
    }
    const statuses = watcher.frames.flatMap((f) =>
      f.t === 'state'
        ? [f.table.players.map((p) => `${p.seat}:${p.status}`).join()]
        : [],
    )
    expect(statuses).toContain('0:playing,2:sitting_out,4:playing')
    expect(statuses).toContain('0:playing,2:sitting_out,4:sitting_out')
    expect(statuses.at(-1)).toBe('0:playing,2:playing,4:sitting_out')
    const heard = JSON.stringify(watcher.frames)
    for (const hand of [one, two, three])
      for (const cards of holes(hand))
        expect(heard).not.toContain(JSON.stringify(cards))
  }, 30_000)
})
