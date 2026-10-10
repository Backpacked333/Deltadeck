// Casual 6-max tables (ADR amendment 2026-10-10, Phase 2): sitting down,
// playing and standing up, with stacks carried from hand to hand. The
// server owns the cards, so every check here is made on the bytes clients
// receive: no seat sees another's hole cards before that hand's showdown, a
// folded hand never shows, a socket without a seat hears nothing about
// hands, what a seat receives does not change with what any other seat
// holds, and a seat's next occupant gets nothing of the last one. Each
// hand's frames are built for the seat its user was dealt into, read from
// that hand's own seat-to-user map.
import {
  abortAllDurableObjects,
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dealSlots } from '../../src/engine/deck'
import { legalActions } from '../../src/engine/hand'
import { nextBlinds } from '../../src/engine/positions'
import type { Blinds } from '../../src/engine/positions'
import { seededDeck } from '../../src/engine/testing'
import type { HandState, PlayerAction, SeatId } from '../../src/engine/types'
import { CLOSE_GONE } from '../../src/shared/protocol'
import type { HandRecordV1, ServerMsg } from '../../src/shared/protocol'
import { forgetUsernames } from '../src/auth'
import { CashController } from '../src/controller'
import type { TableController } from '../src/controller'
import { IDLE_MS } from '../src/deadlines'
import { lobbyStub } from '../src/lobby'
import type { LobbyDO } from '../src/lobby'
import { NEXT_HAND_MS, SIT_COOLDOWN_MS } from '../src/table'
import type { InitBody, TableDO } from '../src/table'
import { analysisKeys, checkFrames, FLOW_TYPES } from './frames'
import {
  bySeat,
  connect,
  createMatch,
  createTable,
  elapse,
  freezeClock,
  isState,
  lobby,
  move,
  peek,
  seatPairs,
  setClock,
  storageOf,
  stub,
  tryConnect,
} from './helpers'
import type { Client } from './helpers'

/** A six-casual table, made through the table's own /init like any table. */
async function sixTable(controller?: TableController) {
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
  if (controller)
    await runInDurableObject(stub(matchId), (instance: TableDO) => {
      instance.sixController = controller
    })
  return matchId
}

/** `user` connects and sits (in `seat`, or wherever the table puts them). */
async function sitDown(matchId: string, user: string, seat?: SeatId) {
  const client = await connect(matchId, user)
  await client.next((f) => f.t === 'welcome')
  const from = client.frames.length
  client.send(seat === undefined ? { t: 'sit' } : { t: 'sit', seat })
  await client.next((f) => f.t === 'welcome' && f.seat !== null, from)
  return client
}

/** Seats every user in its seat; the first two start hand 1 between them. */
async function seatAll(matchId: string, seats: SeatId[], prefix: string) {
  const clients: Record<SeatId, Client> = {}
  for (const seat of seats)
    clients[seat] = await sitDown(matchId, `${prefix}-${seat}`, seat)
  return clients
}

/**
 * `client` stands up; resolves with the welcome that answers it (seat null
 * once the seat is free, or still its seat until the hand it was dealt into
 * ends) or with the error.
 */
async function standUp(client: Client) {
  const from = client.frames.length
  client.send({ t: 'stand' })
  return client.next((f) => f.t === 'welcome' || f.t === 'error', from)
}

/**
 * The welcome that tells `client` it has no seat any more, from frame
 * `from` on (its first welcome, before it sat, says the same).
 */
const unseated = (client: Client, from: number) =>
  client.next((f) => f.t === 'welcome' && f.seat === null, from)

/** `client` asks for a seat; resolves with its seated welcome or the error. */
async function trySit(client: Client, seat?: SeatId) {
  const from = client.frames.length
  client.send(seat === undefined ? { t: 'sit' } : { t: 'sit', seat })
  return client.next(
    (f) => f.t === 'error' || (f.t === 'welcome' && f.seat !== null),
    from,
  )
}

/** Who sits where at the table now, as it stores them. */
async function seated(matchId: string) {
  const { match } = await peek(matchId)
  return (
    match as unknown as {
      players: { seat: SeatId; userId: string; stack: number }[]
    }
  ).players
}

/** The lobby's one-table claims, account to table. */
const claims = () =>
  runInDurableObject(lobbyStub(env), async (_: LobbyDO, state) => {
    const rows = await state.storage.list<string>({ prefix: 'active:' })
    return Object.fromEntries(
      [...rows].map(([key, matchId]) => [key.slice('active:'.length), matchId]),
    )
  })

/** Waits for `test`; the lobby is told of a stand after its frames go out. */
async function eventually(test: () => Promise<boolean>) {
  for (let i = 0; i < 400; i++) {
    if (await test()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('never happened')
}

/** Waits for the server to close `client`'s socket, and says how. */
async function closedWith(client: Client) {
  await eventually(async () => client.closed !== null)
  return client.closed
}

const passive = (hand: HandState): PlayerAction =>
  legalActions(hand).canCheck ? { type: 'check' } : { type: 'call' }

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
  return ended
}

/** The table's real hand: who was dealt in, their hole slots and cards. */
function holesOf(hand: HandState) {
  const { holes } = dealSlots(hand.config)
  const seats = hand.config.seats.map((s) => s.seat)
  const cards: Record<SeatId, number[]> = {}
  for (const seat of seats)
    cards[seat] = holes[seat].map((slot) => hand.deck[slot])
  return { seats, slots: holes as Record<SeatId, number[]>, cards }
}

/** The last frame of type `t` a client received. */
function last<T extends ServerMsg['t']>(frames: ServerMsg[], t: T) {
  const found = frames.filter((f) => f.t === t).at(-1)
  if (!found) throw new Error(`no ${t} frame`)
  return found as Extract<ServerMsg, { t: T }>
}

/** The views of hand `handNo` a client received. */
const viewsOf = (frames: ServerMsg[], handNo: number) =>
  frames.flatMap((f) =>
    (f.t === 'state' || f.t === 'welcome') && f.view?.handNo === handNo
      ? [f.view]
      : [],
  )

/**
 * Checks hand `handNo` as every seat received it, for every (viewer, other)
 * pair dealt into it: `other`'s cards only once shown at the showdown, never
 * in the record or reveal unless shown, and each seat's own opening only to
 * that seat. Returns the shown seats.
 */
function expectPrivate(
  clients: Record<SeatId, Client>,
  hand: HandState,
): SeatId[] {
  const { seats, slots, cards } = holesOf(hand)
  const handNo = hand.config.handNo
  const shown = hand.players.filter((p) => p.shown).map((p) => p.seat)
  for (const [viewer, other] of seatPairs(seats)) {
    const frames = clients[viewer].frames
    const views = viewsOf(frames, handNo)
    expect(views.length, `seat ${viewer} saw hand ${handNo}`).toBeGreaterThan(0)
    for (const view of views) {
      expect(view.you).toBe(viewer)
      expect(bySeat(view.players, viewer).cards).toEqual(cards[viewer])
      const theirs = bySeat(view.players, other).cards
      if (!view.result || !shown.includes(other))
        expect(theirs, `seat ${viewer} saw seat ${other}`).toBeNull()
      else expect(theirs).toEqual(cards[other])
    }
    const end = frames.find(
      (f): f is Extract<ServerMsg, { t: 'hand_end' }> =>
        f.t === 'hand_end' && f.handNo === handNo,
    )!
    expect(end.record.shown.map((s) => s.seat).sort()).toEqual(
      [...shown].sort(),
    )
    const reveal = frames.find(
      (f): f is Extract<ServerMsg, { t: 'reveal' }> =>
        f.t === 'reveal' && f.handNo === handNo,
    )!
    const opened = reveal.slots.map((s) => s.slot)
    for (const slot of slots[other])
      expect(opened.includes(slot)).toBe(shown.includes(other))
    expect(reveal.own?.map((s) => [s.slot, s.card])).toEqual(
      slots[viewer].map((slot) => [slot, hand.deck[slot]]),
    )
  }
  return shown
}

describe('sitting down at a six table', () => {
  it('a sit during a hand is dealt in the next hand', async () => {
    const matchId = await sixTable()
    const a = await sitDown(matchId, 'late-a', 0)
    const b = await sitDown(matchId, 'late-b', 2)
    await a.next(isState(1))
    const one = (await peek(matchId)).hand!
    expect(one.config.seats.map((s) => s.seat)).toEqual([0, 2])

    // Seat 5 sits while hand 1 is played: seated, but not in hand 1.
    const c = await sitDown(matchId, 'late-c', 5)
    expect(last(c.frames, 'welcome').seat).toBe(5)
    const seen = viewsOf(c.frames, 1)
    expect(seen.length).toBeGreaterThan(0)
    for (const view of seen) {
      expect(view.you).toBeNull()
      expect(view.legal).toBeNull()
      expect(view.players.map((p) => p.cards)).toEqual([null, null])
    }
    // The others see seat 5 at the table, not in the hand.
    const after = last(a.frames, 'state')
    expect(after.table.players.map((p) => p.seat)).toEqual([0, 2, 5])
    expect(after.view?.players.map((p) => p.seat)).toEqual([0, 2])

    // Hand 1 ends: seat 5 gets its record, but no opening of its own.
    await move(matchId, { 0: a, 2: b }, () => ({ type: 'fold' }))
    const reveal = await c.next((f) => f.t === 'reveal' && f.handNo === 1)
    expect(reveal.t === 'reveal' && reveal.own).toBeUndefined()

    await elapse(matchId, NEXT_HAND_MS)
    await c.next(isState(2))
    const two = (await peek(matchId)).hand!
    // Dealt in at 100 bb, with the others' stacks carried from hand 1.
    expect(two.config.seats).toEqual([
      { seat: 0, stack: 1990 },
      { seat: 2, stack: 2010 },
      { seat: 5, stack: 2000 },
    ])
    expect(two.config).toMatchObject({ button: 0, sb: 2, bb: 5 })
    const start = c.frames.find((f) => f.t === 'hand_start')!
    expect(start).toMatchObject({
      handNo: 2,
      button: 0,
      sb: 2,
      bb: 5,
      // After the blinds, as `stacks`: seat 2 posted 10, seat 5 posted 20.
      seats: [
        { seat: 0, stack: 1990 },
        { seat: 2, stack: 2000 },
        { seat: 5, stack: 1980 },
      ],
    })
    const mine = viewsOf(c.frames, 2).at(-1)!
    expect(mine.you).toBe(5)
    expect(bySeat(mine.players, 5).cards).toEqual(holesOf(two).cards[5])
    checkFrames([...a.frames, ...b.frames, ...c.frames], 'six-casual')
  })

  it('sit frames carry only allowed keys', async () => {
    const matchId = await sixTable()
    const users = ['k0', 'k1', 'k2', 'k3', 'k4', 'k5', 'k6']
    const clients: Client[] = []
    for (const user of users) {
      const client = await connect(matchId, user)
      await client.next((f) => f.t === 'welcome')
      clients.push(client)
    }
    for (const client of clients) {
      const welcome = client.frames[0]
      expect(welcome).toMatchObject({ t: 'welcome', seat: null, view: null })
    }
    const sit = async (i: number, seat?: SeatId) => {
      const from = clients[i].frames.length
      clients[i].send(seat === undefined ? { t: 'sit' } : { t: 'sit', seat })
      return clients[i].next(
        (f) => f.t === 'error' || (f.t === 'welcome' && f.seat !== null),
        from,
      )
    }
    // No seat named: the lowest free seat.
    expect(await sit(0)).toMatchObject({ t: 'welcome', seat: 0 })
    expect(await sit(1, 3)).toMatchObject({ t: 'welcome', seat: 3 })
    expect(await sit(2, 3)).toMatchObject({ t: 'error', code: 'seat_taken' })
    for (const [i, seat] of [
      [2, 1],
      [3, 2],
      [4, 4],
      [5, 5],
    ])
      expect(await sit(i)).toMatchObject({ t: 'welcome', seat })
    expect(await sit(6)).toMatchObject({ t: 'error', code: 'table_full' })
    expect(await sit(6, 2)).toMatchObject({ t: 'error', code: 'table_full' })
    // Sitting again changes nothing: the same seat comes back.
    expect(await sit(0, 4)).toMatchObject({ t: 'welcome', seat: 0 })
    // Identity comes only from the token, and a seat is 0 to 5.
    for (const junk of [
      { t: 'sit', seat: 6 },
      { t: 'sit', seat: -1 },
      { t: 'sit', seat: '1' },
      { t: 'sit', userId: 'k0' },
      { t: 'sit', seat: 1, username: 'k0' },
    ]) {
      const from = clients[6].frames.length
      clients[6].ws.send(JSON.stringify(junk))
      expect(await clients[6].next((f) => f.t === 'error', from)).toMatchObject(
        { code: 'illegal' },
      )
    }
    const { match } = await peek(matchId)
    const seated = (
      match as unknown as {
        players: { seat: SeatId; userId: string; stack: number }[]
      }
    ).players
    expect(seated.map((p) => [p.seat, p.userId, p.stack])).toEqual([
      [0, 'k0', 2000],
      [1, 'k2', 2000],
      [2, 'k3', 2000],
      [3, 'k1', 2000],
      [4, 'k4', 2000],
      [5, 'k5', 2000],
    ])

    const all = clients.flatMap((c) => c.frames)
    expect(checkFrames(all, 'six-casual')).toEqual(new Set(FLOW_TYPES.sit))
    // The seventh account never sat: it heard about sits, never the hand.
    expect(new Set(clients[6].frames.map((f) => f.t))).toEqual(
      new Set(['welcome', 'state', 'error']),
    )
    for (const f of clients[6].frames)
      if (f.t === 'welcome' || f.t === 'state') expect(f.view).toBeNull()
    for (const f of all)
      if (f.t === 'state' || f.t === 'welcome')
        for (const p of f.table.players)
          expect(p).toMatchObject({ stack: 2000, status: 'playing' })
  })
})

describe('six seats before showdown', () => {
  it("no seat ever sees another's hole cards before showdown at N=6", async () => {
    for (const seats of [
      [0, 1, 2, 3, 4, 5],
      [0, 2, 5],
    ]) {
      const matchId = await sixTable()
      const clients = await seatAll(matchId, seats, `n${seats.length}`)
      await clients[seats[0]].next(isState(1))
      // Hand 1 is heads-up (the others sat during it); then every seat.
      await nextHand(matchId, clients, () => ({ type: 'fold' }))
      const hands: HandState[] = []
      // Checked down; one fold then checked down; raised and folded to.
      const plans: ((hand: HandState) => PlayerAction)[] = [
        passive,
        (hand) =>
          hand.actions.length === 0 ? { type: 'fold' } : passive(hand),
        (hand) =>
          hand.actions.length === 0
            ? { type: 'raise', to: legalActions(hand).minRaiseTo }
            : { type: 'fold' },
      ]
      for (const choose of plans) {
        const dealt = (await peek(matchId)).hand!
        expect(dealt.config.seats.map((s) => s.seat)).toEqual(seats)
        hands.push(await nextHand(matchId, clients, choose))
      }
      const shown = hands.map((hand) => expectPrivate(clients, hand))
      expect(shown[0]).toEqual(seats)
      expect(shown[1]).toHaveLength(seats.length - 1)
      expect(shown[2]).toEqual([])

      const all = Object.values(clients).flatMap((c) => c.frames)
      expect(checkFrames(all, 'six-casual')).toEqual(new Set(FLOW_TYPES.six))
      expect(analysisKeys(all)).toEqual([])
      // Nothing secret anywhere on the wire.
      const wire = all.map((f) => JSON.stringify(f)).join('\n')
      for (const hand of hands)
        expect(wire).not.toContain(JSON.stringify(hand.deck))
    }
  }, 120_000)

  it("a folded seat's cards never appear in views, record.shown or reveal.slots when the others reach showdown", async () => {
    const matchId = await sixTable()
    const clients = await seatAll(matchId, [0, 2, 5], 'fold')
    await clients[0].next(isState(1))
    await nextHand(matchId, clients, () => ({ type: 'fold' }))
    // Hand 2: the first to act folds; the other two check it down.
    const dealt = (await peek(matchId)).hand!
    const folder = dealt.toAct!
    const hand = await nextHand(matchId, clients, (h) =>
      h.toAct === folder && h.actions.length === 0
        ? { type: 'fold' }
        : passive(h),
    )
    expect(hand.result!.showdown).toBe(true)
    const shown = expectPrivate(clients, hand)
    expect(shown).not.toContain(folder)
    expect(shown).toHaveLength(2)
    // Nor in the views after the showdown, nor anywhere in the record.
    const { slots, cards } = holesOf(hand)
    for (const seat of shown) {
      for (const view of viewsOf(clients[seat].frames, 2))
        expect(bySeat(view.players, folder).cards).toBeNull()
      const end = clients[seat].frames.find(
        (f) => f.t === 'hand_end' && f.handNo === 2,
      )!
      expect(end.t === 'hand_end' && end.record.shown).toEqual(
        shown.map((s) => ({ seat: s, cards: cards[s] })),
      )
      const reveal = clients[seat].frames.find(
        (f) => f.t === 'reveal' && f.handNo === 2,
      )!
      if (reveal.t !== 'reveal') throw new Error('no reveal')
      expect(
        reveal.slots.filter((s) => slots[folder].includes(s.slot)),
      ).toEqual([])
      expect(reveal.own?.some((s) => slots[folder].includes(s.slot))).toBe(
        false,
      )
    }
    // The folder alone can check its own folded cards.
    const mine = clients[folder].frames.find(
      (f) => f.t === 'reveal' && f.handNo === 2,
    )!
    expect(mine.t === 'reveal' && mine.own?.map((s) => s.card)).toEqual(
      cards[folder],
    )
  })

  it("an all-in seat's cards stay hidden while two others keep betting", async () => {
    const matchId = await sixTable()
    const clients = await seatAll(matchId, [0, 2, 5], 'allin')
    await clients[0].next(isState(1))
    // Seat 5 sat during hand 1; it starts hand 2 short, at 15 bb.
    await runInDurableObject(stub(matchId), (instance: TableDO) => {
      const match = (
        instance as unknown as {
          match: { players: { seat: SeatId; stack: number }[] }
        }
      ).match
      match.players.find((p) => p.seat === 5)!.stack = 300
    })
    await nextHand(matchId, clients, () => ({ type: 'fold' }))
    const dealt = (await peek(matchId)).hand!
    expect(dealt.config.seats).toContainEqual({ seat: 5, stack: 300 })
    // Seat 5 moves all in before the flop and both others call; then they
    // bet and call on the flop and turn, and check the river.
    const hand = await nextHand(matchId, clients, (h) => {
      const legal = legalActions(h)
      if (h.street === 'preflop')
        return h.toAct === 5
          ? { type: 'raise', to: legal.maxRaiseTo }
          : legal.canCheck
            ? { type: 'check' }
            : { type: 'call' }
      if (h.street === 'river') return passive(h)
      return legal.toCall === 0
        ? { type: 'raise', to: legal.minRaiseTo }
        : { type: 'call' }
    })
    expect(hand.players.find((p) => p.seat === 5)!.allIn).toBe(true)
    let hidden = 0
    for (const viewer of [0, 2])
      for (const view of viewsOf(clients[viewer].frames, 2)) {
        const short = bySeat(view.players, 5)
        if (view.result) continue
        expect(short.cards, `seat ${viewer} on the ${view.street}`).toBeNull()
        if (short.allIn && view.street !== 'preflop') hidden++
      }
    // The bets on the flop and turn were each seen by both others.
    expect(hidden).toBeGreaterThanOrEqual(8)
    expectPrivate(clients, hand)
  })

  it('a seatless socket gets no hand frames', async () => {
    const matchId = await sixTable()
    const a = await sitDown(matchId, 'nos-a', 1)
    const watcher = await connect(matchId, 'nos-w')
    const welcome = await watcher.next((f) => f.t === 'welcome')
    expect(welcome).toMatchObject({ seat: null, view: null })
    const b = await sitDown(matchId, 'nos-b', 4)
    const clients = { 1: a, 4: b }
    await a.next(isState(1))
    await nextHand(matchId, clients, () => ({ type: 'fold' }))
    await move(matchId, clients, passive)
    // Asking again, or trying to act, still shows no hand.
    watcher.send({ t: 'resync' })
    const again = await watcher.next((f) => f.t === 'welcome', 1)
    expect(again).toMatchObject({ seat: null, view: null })
    const { hand } = await peek(matchId)
    watcher.send({
      t: 'act',
      reqId: 'w1',
      handNo: 2,
      actionIndex: hand!.actions.length,
      action: { type: 'fold' },
    })
    expect(await watcher.next((f) => f.t === 'error')).toMatchObject({
      code: 'not_your_turn',
    })
    const c = await sitDown(matchId, 'nos-c', 3)
    await watcher.next(
      (f) =>
        f.t === 'state' && f.table.players.some((p) => p.username === 'nos-c'),
    )
    // Two sits after it connected, so exactly two states, both without a
    // view; never a deal, a hand's end, a reveal or a move.
    const types = watcher.frames.map((f) => f.t)
    expect(types.filter((t) => t === 'state')).toHaveLength(2)
    expect(new Set(types)).toEqual(new Set(['welcome', 'state', 'error']))
    for (const f of watcher.frames)
      if (f.t === 'welcome' || f.t === 'state') expect(f.view).toBeNull()
    const commitments = [a, b, c].flatMap((x) =>
      x.frames.flatMap((f) => (f.t === 'hand_start' ? [f.commitment] : [])),
    )
    expect(commitments.length).toBeGreaterThan(0)
    const wire = JSON.stringify(watcher.frames)
    for (const commitment of commitments) expect(wire).not.toContain(commitment)
    checkFrames(watcher.frames, 'six-casual')
  })

  it('a seat receives the same bytes whatever every unseen seat holds', async () => {
    const seats = [0, 1, 2, 3, 4, 5]
    // Seat 0 folded its small blind to seat 1 in hand 1.
    const handTwo = {
      handNo: 2,
      seats: seats.map((seat) => ({
        seat,
        stack: [1990, 2010, 2000, 2000, 2000, 2000][seat],
      })),
      button: 0,
      sb: 1,
      bb: 2,
      blinds: { sb: 10, bb: 20 },
    }
    const { holes } = dealSlots(handTwo)
    const base = seededDeck(61)
    /** Hand 1 always deals `seededDeck(60)`; hand 2 deals `deck`. */
    const fixed = (deck: number[]): TableController => {
      const cash = new CashController()
      return {
        nextHandPlan: (handNo, config, roster) => {
          const plan = cash.nextHandPlan(handNo, config, roster)
          return plan && { ...plan, deck: handNo === 2 ? deck : seededDeck(60) }
        },
      }
    }
    /** Every frame `viewer` got about hand 2 before it was settled. */
    const before = (frames: ServerMsg[]) => {
      const out: string[] = []
      let on = false
      for (const f of frames) {
        if (f.t === 'hand_start') on = f.handNo === 2
        if (!on) continue
        if (f.t === 'hand_end' || f.t === 'reveal') break
        if ((f.t === 'state' || f.t === 'welcome') && f.view?.result) break
        // The match id and the commitment differ by construction.
        out.push(
          JSON.stringify(f)
            .replaceAll(f.matchId, '<match>')
            .replace(/[0-9a-f]{64}/g, '<commitment>'),
        )
      }
      return out
    }
    const run = async (deck: number[], tag: string) => {
      const matchId = await sixTable(fixed(deck))
      const clients = await seatAll(matchId, seats, tag)
      await clients[0].next(isState(1))
      await nextHand(matchId, clients, () => ({ type: 'fold' }))
      expect((await peek(matchId)).hand!.config).toMatchObject(handTwo)
      await playOut(matchId, clients)
      // The same accounts sit at the next run's table: one table each, so
      // they leave this one first.
      for (const seat of seats)
        expect(await standUp(clients[seat])).toMatchObject({ seat: null })
      return clients
    }
    const original = await run(base, 'same')
    for (const viewer of seats) {
      // Every seat but the viewer's swaps both hole cards with slots nobody
      // is dealt (17 to 51 at six seats), so no unseen card stays put.
      const swapped = [...base]
      let spare = 17 + viewer * 4
      for (const other of seats.filter((s) => s !== viewer))
        for (const slot of holes[other]) {
          ;[swapped[slot], swapped[spare]] = [base[spare], base[slot]]
          spare++
        }
      const other = await run(swapped, 'same')
      const seenA = before(original[viewer].frames)
      const seenB = before(other[viewer].frames)
      expect(seenA.length).toBeGreaterThan(5)
      expect(seenB, `seat ${viewer}`).toEqual(seenA)
    }
  }, 120_000)
})

describe('a six table between players', () => {
  it('starts empty: an opponent or a start deadline is refused', async () => {
    for (const extra of [
      { opponent: { userId: 'guest', username: 'guest' } },
      { startWithinMs: 60_000 },
    ]) {
      const matchId = crypto.randomUUID()
      const response = await stub(matchId).fetch('https://table/init', {
        method: 'POST',
        body: JSON.stringify({
          matchId,
          creator: { userId: 'host', username: 'host' },
          kind: 'six-casual',
          ...extra,
        }),
      })
      expect(response.status, JSON.stringify(extra)).toBe(400)
    }
  })

  it('deals no hand to a table nobody is at, and deals again when two are back', async () => {
    const matchId = await sixTable()
    const a = await sitDown(matchId, 'away-a', 0)
    const b = await sitDown(matchId, 'away-b', 2)
    await a.next(isState(1))
    await move(matchId, { 0: a, 2: b }, () => ({ type: 'fold' }))
    await a.next((f) => f.t === 'reveal' && f.handNo === 1)
    a.ws.close(1000)
    b.ws.close(1000)
    for (let i = 0; i < 200; i++) {
      const open = await runInDurableObject(
        stub(matchId),
        (_i: TableDO, state) => state.getWebSockets().length,
      )
      if (open === 0) break
      await new Promise((r) => setTimeout(r, 5))
    }
    // Both gone: the next deal waits instead of playing hands by timeout.
    await elapse(matchId, NEXT_HAND_MS)
    let { match } = await peek(matchId)
    expect(match.status).toBe('waiting')
    expect(match.handNo).toBe(1)
    // One back is not enough; the second deals hand 2.
    const a2 = await connect(matchId, 'away-a')
    await a2.next((f) => f.t === 'welcome')
    ;({ match } = await peek(matchId))
    expect(match.status).toBe('waiting')
    const b2 = await connect(matchId, 'away-b')
    await b2.next(isState(2))
    ;({ match } = await peek(matchId))
    expect(match.handNo).toBe(2)
    checkFrames([...a2.frames, ...b2.frames], 'six-casual')
  })

  it('a busted player is dealt no more cards; the table waits, then deals again when someone sits', async () => {
    const matchId = await sixTable()
    const a = await sitDown(matchId, 'bust-a', 0)
    const b = await sitDown(matchId, 'bust-b', 2)
    await a.next(isState(1))
    await move(matchId, { 0: a, 2: b }, () => ({ type: 'fold' }))
    await a.next((f) => f.t === 'reveal' && f.handNo === 1)
    // b loses every chip to a in hand 1: settled into the table's stacks
    // at the next deal, as a real all-in would be (no rebuy until PR-14).
    await runInDurableObject(stub(matchId), (instance: TableDO) => {
      const { hand } = instance as unknown as { hand: HandState }
      const winner = hand.players.find((p) => p.seat === 0)!
      const loser = hand.players.find((p) => p.seat === 2)!
      winner.stack += loser.stack
      loser.stack = 0
    })
    await elapse(matchId, NEXT_HAND_MS)
    const { match } = await peek(matchId)
    expect(match.status).toBe('waiting')
    const stacks = () =>
      (match as unknown as { players: { seat: SeatId; stack: number }[] })
        .players
    expect(stacks().map((p) => [p.seat, p.stack])).toEqual([
      [0, 4000],
      [2, 0],
    ])
    // c sits: dealing resumes between a and c only.
    const c = await sitDown(matchId, 'bust-c', 4)
    await c.next(isState(2))
    const two = (await peek(matchId)).hand!
    expect(two.config.seats.map((s) => s.seat)).toEqual([0, 4])
    const { cards } = holesOf(two)
    await b.next(isState(2))
    for (const view of viewsOf(b.frames, 2)) {
      expect(view.you).toBeNull()
      for (const p of view.players) expect(p.cards).toBeNull()
    }
    const ended = await playOut(matchId, { 0: a, 4: c }, () => ({
      type: 'fold',
    }))
    await b.next((f) => f.t === 'reveal' && f.handNo === 2)
    for (const f of b.frames)
      if (f.t === 'reveal' && f.handNo === 2) expect(f.own).toBeUndefined()
    const seen = JSON.stringify(b.frames)
    for (const seat of [0, 4] as SeatId[])
      expect(seen).not.toContain(JSON.stringify(cards[seat]))
    // Chips are conserved across the pause: 6,000 at the table.
    expect(ended.players.reduce((sum, p) => sum + p.stack, 0) + 0).toBe(
      4000 + 2000,
    )
    checkFrames([...a.frames, ...b.frames, ...c.frames], 'six-casual')
  })
})

describe('standing up at a six table', () => {
  it("a stand mid-hand folds at the player's turn and frees the seat after the hand", async () => {
    const matchId = await sixTable()
    const clients = await seatAll(matchId, [0, 2, 4], 'up')
    await clients[0].next(isState(1))
    await nextHand(matchId, clients, () => ({ type: 'fold' }))
    // Hand 2: button 0, small blind 2, big blind 4; seat 0 acts first.
    const two = (await peek(matchId)).hand!
    expect(two.config).toMatchObject({ button: 0, sb: 2, bb: 4 })
    expect(two.toAct).toBe(0)

    // Seat 2 stands before its turn: still seated, nothing folded yet.
    const stoodAt = clients[2].frames.length
    expect(await standUp(clients[2])).toMatchObject({ t: 'welcome', seat: 2 })
    expect((await peek(matchId)).hand!.actions).toEqual([])
    expect((await seated(matchId)).map((p) => p.seat)).toEqual([0, 2, 4])
    // Nobody takes the seat while the hand it was dealt into is played.
    const next = await connect(matchId, 'up-next')
    await next.next((f) => f.t === 'welcome')
    expect(await trySit(next, 2)).toMatchObject({ code: 'seat_taken' })

    // Seat 0 calls: the action reaches seat 2, which folds at once.
    await move(matchId, clients, () => ({ type: 'call' }))
    const folded = (await peek(matchId)).hand!
    expect(folded.actions.map((a) => [a.seat, a.action.type])).toEqual([
      [0, 'call'],
      [2, 'fold'],
    ])
    expect(folded.toAct).toBe(4)
    expect((await seated(matchId)).map((p) => p.seat)).toEqual([0, 2, 4])
    expect(await trySit(next, 2)).toMatchObject({ code: 'seat_taken' })

    // The other two check it down; the seat frees as the hand ends.
    const ended = await playOut(matchId, { 0: clients[0], 4: clients[4] })
    expect((await seated(matchId)).map((p) => p.seat)).toEqual([0, 4])
    expect(await unseated(clients[2], stoodAt)).toMatchObject({ view: null })
    // The fold was the player's own move, and their own opening is theirs.
    const record = last(clients[2].frames, 'hand_end').record
    expect(record.actions.find((a) => a.seat === 2)).toMatchObject({
      action: { type: 'fold' },
      source: 'client',
    })
    expect(last(clients[2].frames, 'reveal').own?.map((s) => s.slot)).toEqual(
      holesOf(ended).slots[2],
    )
    // Everyone sees the seat empty, and the lobby lets the account go.
    for (const client of [clients[0], next])
      await client.next(
        (f) =>
          f.t === 'state' &&
          f.table.players.map((p) => p.seat).join() === '0,4',
      )
    await eventually(async () => !('up-2' in (await claims())))
    expect(await claims()).toMatchObject({ 'up-0': matchId, 'up-4': matchId })

    // Free now: a new player takes it and is dealt in at hand 3.
    expect(await trySit(next, 2)).toMatchObject({ t: 'welcome', seat: 2 })
    await elapse(matchId, NEXT_HAND_MS)
    const three = (await peek(matchId)).hand!
    expect(three.config.seats.map((s) => s.seat)).toEqual([0, 2, 4])
    expect(clients[2].frames.some((f) => f.t === 'hand_start')).toBe(true)
    expect(
      clients[2].frames.some((f) => f.t === 'hand_start' && f.handNo === 3),
    ).toBe(false)

    // A stand on your turn folds at once.
    const actor = three.toAct!
    const players: Record<SeatId, Client> = { ...clients, 2: next }
    const from = players[actor].frames.length
    expect(await standUp(players[actor])).toMatchObject({ seat: actor })
    await players[actor].next(isState(3, 1), from)
    expect((await peek(matchId)).hand!.actions[0]).toMatchObject({
      seat: actor,
      action: { type: 'fold' },
    })

    // A player who sat during the hand was not dealt in: the seat frees now.
    const late = await sitDown(matchId, 'up-late', 5)
    expect(await standUp(late)).toMatchObject({ seat: null, view: null })
    expect((await seated(matchId)).map((p) => p.seat)).not.toContain(5)
    expect((await peek(matchId)).hand!.street).not.toBe('showdown')
    checkFrames(
      [...Object.values(clients), next, late].flatMap((c) => c.frames),
      'six-casual',
    )

    // A stand stored on the player's turn whose fold never ran (the object
    // evicted between the two) still folds once the table is back: the
    // turn was made due at once, and the alarm folds it.
    const third = (await peek(matchId)).hand!
    const stander = third.toAct!
    await runInDurableObject(stub(matchId), (instance: TableDO) => {
      const inside = instance as unknown as { applyAction: () => unknown }
      inside.applyAction = () => Promise.resolve()
    })
    expect(await standUp(players[stander])).toMatchObject({ seat: stander })
    expect((await peek(matchId)).hand!.actions).toHaveLength(
      third.actions.length,
    )
    await abortAllDurableObjects()
    await freezeClock(matchId, 1_800_000_000_000 + 3 * NEXT_HAND_MS)
    await runDurableObjectAlarm(stub(matchId))
    expect((await peek(matchId)).hand!.actions.at(-1)).toMatchObject({
      seat: stander,
      action: { type: 'fold' },
    })
  })

  it("a new occupant of seat k never receives the previous occupant's cards, own openings or acks", async () => {
    const matchId = await sixTable()
    const a = await sitDown(matchId, 'old-k', 1)
    const b = await sitDown(matchId, 'old-b', 3)
    await a.next(isState(1))
    const c = await sitDown(matchId, 'old-c', 5)
    await nextHand(matchId, { 1: a, 3: b, 5: c }, () => ({ type: 'fold' }))
    // Hand 2: button 1, small blind 3, big blind 5; seat 1 opens.
    expect((await peek(matchId)).hand!.config).toMatchObject({
      button: 1,
      sb: 3,
      bb: 5,
    })
    // Seat 1 calls (acknowledged as m2-0), sends five frames the table
    // refuses (the most one hand allows), then stands.
    await move(matchId, { 1: a, 3: b, 5: c }, () => ({ type: 'call' }))
    expect(last(a.frames, 'state').view?.lastReqId).toBe('m2-0')
    for (let i = 0; i < 5; i++) {
      const from = a.frames.length
      a.ws.send('junk')
      await a.next((f) => f.t === 'error', from)
    }
    const stoodAt = a.frames.length
    expect(await standUp(a)).toMatchObject({ t: 'welcome', seat: 1 })
    // The other two check it down; seat 1 folds when the action reaches it.
    const hand = await playOut(matchId, { 3: b, 5: c }, passive)
    const { slots, cards } = holesOf(hand)
    const shown = hand.players.filter((p) => p.shown).map((p) => p.seat)
    expect(shown).toEqual([3, 5])
    await unseated(a, stoodAt)
    // Seat 1's own opening went to the account dealt into it.
    expect(last(a.frames, 'reveal').own?.map((s) => s.card)).toEqual(cards[1])

    // Hand 2 is still on the table (hand 3 is not dealt): a new account
    // takes seat 1.
    const d = await sitDown(matchId, 'new-k', 1)
    expect(last(d.frames, 'welcome')).toMatchObject({ seat: 1 })
    /** What `frames` say about hand 2: nothing of seat 1's old player. */
    const nothingOfOld = (frames: ServerMsg[], ended: boolean) => {
      const views = viewsOf(frames, 2)
      expect(views.length).toBeGreaterThan(0)
      for (const view of views) {
        expect(view).toMatchObject({ you: null, legal: null, lastReqId: null })
        expect(bySeat(view.players, 1).cards).toBeNull()
        for (const seat of shown)
          expect(bySeat(view.players, seat).cards).toEqual(cards[seat])
      }
      const ends = frames.filter((f) => f.t === 'hand_end' && f.handNo === 2)
      const reveals = frames.flatMap((f) =>
        f.t === 'reveal' && f.handNo === 2 ? [f] : [],
      )
      expect(ends.length > 0 && reveals.length > 0).toBe(ended)
      for (const reveal of reveals) {
        expect(reveal.own).toBeUndefined()
        const opened = reveal.slots.map((s) => s.slot)
        for (const slot of slots[1]) expect(opened).not.toContain(slot)
      }
      const wire = JSON.stringify(frames)
      expect(wire).not.toContain('"m2-0"')
      expect(wire).not.toContain(JSON.stringify(cards[1]))
    }
    nothingOfOld(d.frames, false)
    // Asking again: the same.
    let from = d.frames.length
    d.send({ t: 'resync' })
    await d.next((f) => f.t === 'reveal', from)
    nothingOfOld(d.frames.slice(from), true)
    // Reconnecting: the same.
    const again = await connect(matchId, 'new-k')
    await again.next((f) => f.t === 'reveal')
    expect(again.frames[0]).toMatchObject({ t: 'welcome', seat: 1 })
    nothingOfOld(again.frames, true)
    // Nor the old player's illegal-move count: one refused frame of its own
    // in the same hand does not close the new player's socket.
    from = again.frames.length
    again.ws.send('junk')
    expect(await again.next((f) => f.t === 'error', from)).toMatchObject({
      code: 'illegal',
    })
    again.send({ t: 'resync' })
    await again.next((f) => f.t === 'welcome', from)
    expect(again.closed).toBeNull()

    // Hand 3 deals the new player its own cards in seat 1.
    await elapse(matchId, NEXT_HAND_MS)
    const three = (await peek(matchId)).hand!
    await again.next(isState(3))
    const mine = viewsOf(again.frames, 3).at(-1)!
    expect(mine.you).toBe(1)
    expect(bySeat(mine.players, 1).cards).toEqual(holesOf(three).cards[1])
    expect(a.frames.some((f) => f.t === 'hand_start' && f.handNo === 3)).toBe(
      false,
    )
    checkFrames(
      [a, b, c, d, again].flatMap((x) => x.frames),
      'six-casual',
    )
  })

  it('sit_cooldown refuses a re-sit for 6 hands or 2 minutes', async () => {
    // Counted in hands: three play, one stands.
    const matchId = await sixTable()
    const clients = await seatAll(matchId, [0, 2, 4], 'cool')
    await clients[0].next(isState(1))
    await nextHand(matchId, clients, () => ({ type: 'fold' }))
    // Hand 2 (two dealt so far): the big blind stands; the others fold to it.
    const stoodAt = clients[4].frames.length
    expect(await standUp(clients[4])).toMatchObject({ seat: 4 })
    const rest = { 0: clients[0], 2: clients[2] }
    await playOut(matchId, rest, () => ({ type: 'fold' }))
    const freed = await unseated(clients[4], stoodAt)
    const until = (freed as { serverNow: number }).serverNow + 120_000
    for (let dealt = 0; dealt < 6; dealt++) {
      expect(await trySit(clients[4], 4), `${dealt} dealt since`).toEqual({
        t: 'error',
        seq: expect.any(Number),
        matchId,
        code: 'sit_cooldown',
        message: expect.any(String),
        handsLeft: 6 - dealt,
        until,
      })
      await nextHand(matchId, rest, () => ({ type: 'fold' }))
    }
    // The sixth hand since is dealt: the seat is theirs again.
    expect((await peek(matchId)).hand!.config.handNo).toBe(8)
    expect(await trySit(clients[4], 4)).toMatchObject({
      t: 'welcome',
      seat: 4,
    })

    // Counted in time, at a table of two, where no hand can be dealt
    // without them: a cooldown in hands alone would never end.
    const other = await sixTable()
    const a = await sitDown(other, 'cool-a', 1)
    const b = await sitDown(other, 'cool-b', 3)
    await a.next(isState(1))
    // Seat 1 is the button and acts first: its stand folds at once.
    expect((await peek(other)).hand!.toAct).toBe(1)
    const leftAt = a.frames.length
    expect(await standUp(a)).toMatchObject({ seat: 1 })
    const gone = await unseated(a, leftAt)
    const later = (gone as { serverNow: number }).serverNow + 120_000
    await b.next((f) => f.t === 'reveal' && f.handNo === 1)
    await elapse(other, NEXT_HAND_MS)
    expect((await peek(other)).match.status).toBe('waiting')
    for (const at of [later - 120_000 + NEXT_HAND_MS, later - 1]) {
      await setClock(other, at)
      expect(await trySit(a)).toMatchObject({
        code: 'sit_cooldown',
        handsLeft: 6,
        until: later,
      })
    }
    await setClock(other, later)
    expect(await trySit(a, 1)).toMatchObject({ t: 'welcome', seat: 1 })
    await a.next(isState(2))
    checkFrames(
      [...Object.values(clients), a, b].flatMap((c) => c.frames),
      'six-casual',
    )
  }, 60_000)

  it('one table per account across six tables', async () => {
    const tables: string[] = []
    for (let i = 0; i < 6; i++) tables.push(await sixTable())
    /** `user` opens `matchId` and asks for a seat; the server closes it. */
    const refusedAt = async (matchId: string, user: string) => {
      const client = await connect(matchId, user)
      await client.next((f) => f.t === 'welcome')
      client.send({ t: 'sit' })
      return closedWith(client)
    }
    // Seated alone at the first table, which deals nothing: the lobby still
    // holds the account there.
    const roam = await sitDown(tables[0], 'roam', 2)
    expect((await peek(tables[0])).match.status).toBe('waiting')
    expect(await claims()).toEqual({ roam: tables[0] })
    for (const id of tables.slice(1)) {
      expect(await refusedAt(id, 'roam')).toEqual({
        code: 4409,
        reason: tables[0],
      })
      expect(await seated(id)).toEqual([])
    }
    // Queueing sends them back there; no invite table opens; no heads-up
    // seat either.
    const lobbySocket = await lobby('roam')
    lobbySocket.send({ t: 'queue', kind: 'hu-casual' })
    expect(await lobbySocket.next((f) => f.t === 'matched')).toMatchObject({
      matchId: tables[0],
      resumed: true,
    })
    const busy = await createMatch('roam')
    expect(busy.status).toBe(409)
    expect(await busy.json()).toEqual({ error: 'active', matchId: tables[0] })
    const invite = await createTable('roam-host')
    expect(await (await tryConnect(invite, 'roam')).closed).toEqual({
      code: 4409,
      reason: tables[0],
    })

    // Standing up lets the account go: the second table seats them, and
    // now every other table refuses them for that one (the first for its
    // cooldown as well).
    expect(await standUp(roam)).toMatchObject({ seat: null })
    await eventually(async () => !('roam' in (await claims())))
    await sitDown(tables[1], 'roam')
    expect(await claims()).toEqual({ roam: tables[1] })
    expect(await trySit(roam)).toMatchObject({ code: 'sit_cooldown' })
    for (const id of tables.slice(2))
      expect(await refusedAt(id, 'roam')).toEqual({
        code: 4409,
        reason: tables[1],
      })

    // A release the lobby never got locks nobody in: it asks the table,
    // which no longer seats them.
    const drift = await sitDown(tables[2], 'drift')
    expect(await standUp(drift)).toMatchObject({ seat: null })
    await eventually(async () => !('drift' in (await claims())))
    await runInDurableObject(lobbyStub(env), (_: LobbyDO, state) =>
      state.storage.put('active:drift', tables[2]),
    )
    await sitDown(tables[3], 'drift')
    expect(await claims()).toMatchObject({ drift: tables[3] })

    // A player at a heads-up table cannot sit at a six table either.
    const guest = await connect(invite, 'roam-guest')
    await guest.next((f) => f.t === 'welcome')
    expect(await refusedAt(tables[4], 'roam-guest')).toEqual({
      code: 4409,
      reason: invite,
    })

    // Across the six tables, every account holds one seat at most.
    const all = (await Promise.all(tables.map((id) => seated(id)))).flatMap(
      (players) => players.map((p) => p.userId),
    )
    expect(all.sort()).toEqual(['drift', 'roam'])
  })

  it('two sits sent at once to two six tables seat the account at one', async () => {
    // A stale claim: an invite the account made and nobody joined. Each
    // sit's claim asks that invite (it holds nobody) before writing its
    // own, so two claims at once both find the account free unless the
    // lobby takes them one at a time.
    expect((await createMatch('racer')).status).toBe(201)
    const tables = [await sixTable(), await sixTable()]
    const sockets = await Promise.all(tables.map((id) => connect(id, 'racer')))
    for (const client of sockets) await client.next((f) => f.t === 'welcome')
    const from = sockets.map((client) => client.frames.length)
    for (const client of sockets) client.send({ t: 'sit' })
    // Each sit ends seated, or closed with the table that seated them.
    const settled = (i: number) =>
      sockets[i].closed !== null ||
      sockets[i].frames
        .slice(from[i])
        .some((f) => f.t === 'welcome' && f.seat !== null)
    await eventually(async () => settled(0) && settled(1))
    const holding: string[] = []
    for (const id of tables)
      if ((await seated(id)).some((p) => p.userId === 'racer')) holding.push(id)
    expect(holding).toHaveLength(1)
    const held = tables.indexOf(holding[0])
    expect(sockets[held].closed).toBeNull()
    expect(sockets[1 - held].closed).toEqual({
      code: 4409,
      reason: tables[held],
    })
    expect(await claims()).toEqual({ racer: tables[held] })
  })

  it('a six table holds the account while the lobby grants its sit', async () => {
    // The lobby can grant a sit's claim and weigh another table's claim for
    // the same account before the grant gets back to this table: asked in
    // that gap, the table must say it holds the account.
    const matchId = await sixTable()
    const asked: string[] = []
    await runInDurableObject(stub(matchId), (instance: TableDO) => {
      const real = env.LOBBY
      const lobbyOf = (id: DurableObjectId) => {
        const lobby = real.get(id, { locationHint: 'enam' })
        return {
          claim: async (userId: string, table: string) => {
            const granted = await lobby.claim(userId, table)
            asked.push(await instance.liveness(userId))
            return granted
          },
          release: (userIds: string[], table: string) =>
            lobby.release(userIds, table),
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
    const before = await stub(matchId).liveness('gap')
    await sitDown(matchId, 'gap')
    expect({
      before,
      asked,
      after: await stub(matchId).liveness('gap'),
    }).toEqual({ before: 'open', asked: ['playing'], after: 'playing' })
  })

  it('a player queued for heads-up who sits at a six table is not paired as well', async () => {
    const matchId = await sixTable()
    const queued = await lobby('qs')
    queued.send({ t: 'queue', kind: 'hu-casual' })
    await queued.next((f) => f.t === 'queued')
    await sitDown(matchId, 'qs')
    expect(await claims()).toEqual({ qs: matchId })
    // The next player to queue would be paired with qs, who is seated here
    // now: qs is sent back to this table, and the other keeps waiting.
    const other = await lobby('qs-other')
    other.send({ t: 'queue', kind: 'hu-casual' })
    expect(await queued.next((f) => f.t === 'matched')).toMatchObject({
      matchId,
      resumed: true,
    })
    expect(await other.next((f) => f.t === 'queued')).toMatchObject({
      position: 1,
    })
    expect(other.frames.map((f) => f.t)).not.toContain('matched')
    expect(await claims()).toEqual({ qs: matchId })
  })

  it("a sit waits for the account's release from this table to reach the lobby", async () => {
    // Two calls from one table to the lobby are not ordered on the way. A
    // release that landed after the same account's next claim from here
    // would delete that claim, and another table could then seat them too.
    const matchId = await sixTable()
    let held: Promise<void> = Promise.resolve()
    let letGo = () => {}
    const calls: string[] = []
    await runInDurableObject(stub(matchId), (instance: TableDO) => {
      const real = env.LOBBY
      const lobbyOf = (id: DurableObjectId) => {
        const lobby = real.get(id, { locationHint: 'enam' })
        return {
          claim: (userId: string, table: string) => {
            calls.push('claim')
            return lobby.claim(userId, table)
          },
          release: async (userIds: string[], table: string) => {
            calls.push('release')
            await held
            await lobby.release(userIds, table)
            calls.push('released')
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
    const client = await sitDown(matchId, 'late')
    expect(await claims()).toEqual({ late: matchId })
    held = new Promise((resolve) => (letGo = resolve))
    expect(await standUp(client)).toMatchObject({ seat: null })
    // Past the cooldown, as for a sit refused after its claim (no cooldown).
    await runInDurableObject(stub(matchId), (instance: TableDO) => {
      const base = instance.clock
      instance.clock = () => base() + SIT_COOLDOWN_MS
    })
    const from = client.frames.length
    client.send({ t: 'sit' })
    // Every chance for the sit's claim to overtake the held release.
    for (let i = 0; i < 40 && calls.at(-1) !== 'claim'; i++)
      await new Promise((r) => setTimeout(r, 5))
    letGo()
    await client.next((f) => f.t === 'welcome' && f.seat !== null, from)
    await eventually(async () => calls.includes('released'))
    expect(calls).toEqual(['claim', 'release', 'released', 'claim'])
    expect(await claims()).toEqual({ late: matchId })
  })

  it('a player who stood makes no more decisions in the hand', async () => {
    const matchId = await sixTable()
    const clients = await seatAll(matchId, [0, 2, 4], 'sg')
    await clients[0].next(isState(1))
    const { hand } = await peek(matchId)
    const seat = hand!.toAct! as SeatId
    // A stand on their turn folds them in the same handler, and the turn
    // reaching a player who stood folds them in the same write: nothing
    // can come between. Mark them standing without that fold, as a decision
    // racing it would find them, and send the decision anyway.
    await runInDurableObject(stub(matchId), (instance: TableDO) => {
      const { match } = instance as unknown as {
        match: { players: { userId: string; standing?: boolean }[] }
      }
      match.players.find((p) => p.userId === `sg-${seat}`)!.standing = true
    })
    const from = clients[seat].frames.length
    clients[seat].send({
      t: 'act',
      reqId: 'sg-1',
      handNo: 1,
      actionIndex: hand!.actions.length,
      action: { type: 'call' },
    })
    expect(
      await clients[seat].next((f) => f.t === 'error', from),
    ).toMatchObject({ code: 'not_your_turn', reqId: 'sg-1' })
    expect((await peek(matchId)).hand!.actions).toHaveLength(
      hand!.actions.length,
    )
  })

  it('stand frames carry only allowed keys', async () => {
    const matchId = await sixTable()
    const watcher = await connect(matchId, 'sf-w')
    await watcher.next((f) => f.t === 'welcome')
    const clients = await seatAll(matchId, [0, 2], 'sf')
    await clients[0].next(isState(1))
    // A stand from a socket without a seat is refused, typed.
    const from = watcher.frames.length
    watcher.send({ t: 'stand' })
    expect(await watcher.next((f) => f.t === 'error', from)).toMatchObject({
      code: 'not_seated',
    })
    // Seat 4 sits during hand 1, so is not dealt in: its stand frees the
    // seat at once, and its re-sit is refused for the cooldown.
    const late = await sitDown(matchId, 'sf-4', 4)
    expect(await standUp(late)).toMatchObject({ seat: null, view: null })
    expect(await trySit(late, 4)).toMatchObject({
      code: 'sit_cooldown',
      handsLeft: 6,
    })
    // Hand 2 is heads-up with seat 2 on the button, first to act: its stand
    // folds it at once and frees the seat as the hand ends.
    await nextHand(matchId, clients, () => ({ type: 'fold' }))
    expect((await peek(matchId)).hand!.toAct).toBe(2)
    const seen = watcher.frames.length
    const stoodAt = clients[2].frames.length
    expect(await standUp(clients[2])).toMatchObject({ seat: 2 })
    await unseated(clients[2], stoodAt)
    await watcher.next(
      (f) => f.t === 'state' && f.table.players.length === 1,
      seen,
    )

    const all = [watcher, late, ...Object.values(clients)].flatMap(
      (c) => c.frames,
    )
    expect(checkFrames(all, 'six-casual')).toEqual(new Set(FLOW_TYPES.stand))
    expect(analysisKeys(all)).toEqual([])
    // Sockets without a seat heard of every sit and stand, never of a hand.
    for (const f of watcher.frames) {
      expect(['welcome', 'state', 'error']).toContain(f.t)
      if (f.t === 'welcome' || f.t === 'state') expect(f.view).toBeNull()
    }
    const roster = watcher.frames.flatMap((f) =>
      f.t === 'state' ? [f.table.players.map((p) => p.seat).join()] : [],
    )
    expect(roster).toEqual(['0', '0,2', '0,2,4', '0,2', '0'])
  })
})

describe('six clients over many hands', () => {
  it('six clients sit and play, chips conserved across 200 hands', async () => {
    const matchId = await sixTable()
    const seats = [0, 1, 2, 3, 4, 5]
    const clients = await seatAll(matchId, seats, 'soak')
    await clients[0].next(isState(1))
    const total = seats.length * 2000
    // A six-way pot checked down every fifth hand; otherwise the first to
    // act raises to 3 bb and the others fold, the big blind calling every
    // third hand and checking it down. Nobody busts, so all 200 hands are
    // six-handed (all-ins and side pots are the next tests' and the engine
    // soak's; there is no rebuy until PR-14).
    const choose = (hand: HandState): PlayerAction => {
      const legal = legalActions(hand)
      const n = hand.config.handNo
      if (n % 5 === 0) return passive(hand)
      if (hand.street === 'preflop' && hand.actions.length === 0)
        return legal.canRaise
          ? { type: 'raise', to: Math.min(60, legal.maxRaiseTo) }
          : passive(hand)
      if (legal.toCall === 0) return { type: 'check' }
      return legal.toCall <= 40 && n % 3 === 0
        ? { type: 'call' }
        : { type: 'fold' }
    }
    let played = 0
    for (let n = 1; n <= 200; n++) {
      const ended = await playOut(matchId, clients, choose)
      played++
      const { match } = await peek(matchId)
      const players = (
        match as unknown as {
          players: { seat: SeatId; userId: string; stack: number }[]
          netByUser: Record<string, number>
        }
      ).players
      const net = (match as unknown as { netByUser: Record<string, number> })
        .netByUser
      // Chips at the table: the dealt seats' stacks after the hand, and
      // the stacks of anyone not dealt in.
      const dealt = new Set(ended.players.map((p) => p.seat))
      const chips =
        ended.players.reduce((sum, p) => sum + p.stack, 0) +
        players
          .filter((p) => !dealt.has(p.seat))
          .reduce((sum, p) => sum + p.stack, 0)
      expect(chips, `hand ${n}`).toBe(total)
      expect(
        Object.values(ended.result!.netBySeat).reduce((a, b) => a + b, 0),
      ).toBe(0)
      // Each account's net is its stack against the buy-in.
      for (const p of players) {
        const stack = ended.players.find((q) => q.seat === p.seat)?.stack
        expect(net[p.userId] ?? 0, `${p.userId} after hand ${n}`).toBe(
          (stack ?? p.stack) - 2000,
        )
      }
      if (ended.players.filter((p) => p.stack > 0).length < 2) break
      await clients[seats[0]].next(
        (f) => f.t === 'reveal' && f.handNo === ended.config.handNo,
      )
      await elapse(matchId, NEXT_HAND_MS)
      if (n < 200) await clients[0].next(isState(n + 1))
    }
    expect(played).toBe(200)
  }, 300_000)

  it('six clients sit, play and stand with chips conserved across 200 hands', async () => {
    const matchId = await sixTable()
    const BUY_IN = 2000
    const clients = await seatAll(matchId, [0, 1, 2, 3, 4, 5], 'churn')
    await clients[0].next(isState(1))
    /** Every account that sat, by name, and its socket. */
    const users = new Map<string, Client>(
      Object.entries(clients).map(([seat, c]) => [`churn-${seat}`, c]),
    )
    // Chips brought to the table (a buy-in per sit) and taken away (each
    // stander's stack as its seat frees), and each account's result over
    // the seats it gave up.
    let bought = 6 * BUY_IN
    let left = 0
    const banked: Record<string, number> = {}
    /** A stander who left their seat empty, to sit again once allowed. */
    let away: { user: string; freedAt: number } | null = null
    const counts = { stands: 0, newcomers: 0, refused: 0, back: 0 }
    // The soak's betting: nobody busts, so every hand deals all seated.
    const choose = (hand: HandState): PlayerAction => {
      const legal = legalActions(hand)
      const n = hand.config.handNo
      if (n % 5 === 0) return passive(hand)
      if (hand.street === 'preflop' && hand.actions.length === 0)
        return legal.canRaise
          ? { type: 'raise', to: Math.min(60, legal.maxRaiseTo) }
          : passive(hand)
      if (legal.toCall === 0) return { type: 'check' }
      return legal.toCall <= 40 && n % 3 === 0
        ? { type: 'call' }
        : { type: 'fold' }
    }
    for (let n = 1; n <= 200; n++) {
      const dealt = (await peek(matchId)).hand!
      expect(dealt.config.handNo).toBe(n)
      const userIn = (seat: SeatId) =>
        [...users].find(([, c]) => c === clients[seat])![0]
      // Every ninth hand a dealt player stands before anyone moves: they
      // fold when the action reaches them (at once on their turn).
      let stander: { seat: SeatId; user: string } | null = null
      if (n % 9 === 4) {
        const seats = dealt.config.seats.map((s) => s.seat)
        const seat = seats.includes(n % 6) ? n % 6 : seats[0]
        stander = { seat, user: userIn(seat) }
        expect(await standUp(clients[seat])).toMatchObject({ seat })
        // Seated until the hand ends; the others play on around them.
        expect((await seated(matchId)).map((p) => p.userId)).toContain(
          stander.user,
        )
        counts.stands++
      }
      const ended = await playOut(matchId, clients, choose)
      const { match } = await peek(matchId)
      const { players, netByUser: net } = match as unknown as {
        players: { seat: SeatId; userId: string; stack: number }[]
        netByUser: Record<string, number>
      }
      if (stander) {
        // The seat freed as the hand ended, and its chips left with it.
        expect(players.map((p) => p.userId)).not.toContain(stander.user)
        const final = bySeat(ended.players, stander.seat).stack
        left += final
        banked[stander.user] = (banked[stander.user] ?? 0) + final - BUY_IN
        delete clients[stander.seat]
      }
      // Chips at the table: a dealt seat's stack after the hand, anyone
      // else's as the table holds it; with what left, all that was bought.
      const after = new Map(ended.players.map((p) => [p.seat, p.stack]))
      const stackOf = (p: { seat: SeatId; stack: number }) =>
        after.get(p.seat) ?? p.stack
      const chips = players.reduce((sum, p) => sum + stackOf(p), 0)
      expect(chips + left, `hand ${n}`).toBe(bought)
      expect(
        Object.values(ended.result!.netBySeat).reduce((x, y) => x + y, 0),
      ).toBe(0)
      // Each account's net: what it banked, plus its seat now.
      for (const user of users.keys()) {
        const p = players.find((q) => q.userId === user)
        const now = p ? stackOf(p) - BUY_IN : 0
        expect(net[user] ?? 0, `${user} after hand ${n}`).toBe(
          (banked[user] ?? 0) + now,
        )
      }
      if (n === 200) break
      await Object.values(clients)[0].next(
        (f) => f.t === 'reveal' && f.handNo === n,
      )
      // Between hands: every other stander's seat goes to a newcomer at
      // once; the rest leave it empty, are refused the next hand, and sit
      // again once 6 hands have been dealt since.
      if (stander && n % 18 === 4) {
        const user = `churn-new${n}`
        const newcomer = await sitDown(matchId, user, stander.seat)
        clients[stander.seat] = newcomer
        users.set(user, newcomer)
        bought += BUY_IN
        counts.newcomers++
      } else if (stander) away = { user: stander.user, freedAt: n }
      if (away && n - away.freedAt === 1) {
        expect(await trySit(users.get(away.user)!)).toMatchObject({
          code: 'sit_cooldown',
          handsLeft: 5,
        })
        counts.refused++
      }
      if (away && n - away.freedAt === 6) {
        const back = users.get(away.user)!
        const welcome = await trySit(back)
        expect(welcome).toMatchObject({ t: 'welcome' })
        clients[(welcome as { seat: SeatId }).seat] = back
        bought += BUY_IN
        away = null
        counts.back++
      }
      await elapse(matchId, NEXT_HAND_MS)
    }
    expect(counts).toEqual({ stands: 22, newcomers: 11, refused: 11, back: 11 })
    expect((await seated(matchId)).length).toBe(6)
  }, 300_000)
})

describe('the archive of a six table', () => {
  const USERS = [
    'a0000000-0000-4000-8000-00000000000a',
    'b0000000-0000-4000-8000-00000000000b',
    'c0000000-0000-4000-8000-00000000000c',
  ]
  afterEach(() => vi.unstubAllGlobals())

  it("archives each hand's seats and nets by the accounts dealt into it", async () => {
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
    const matchId = await sixTable()
    const a = await sitDown(matchId, USERS[0], 1)
    const b = await sitDown(matchId, USERS[1], 3)
    await a.next(isState(1))
    const c = await sitDown(matchId, USERS[2], 4)
    const clients = { 1: a, 3: b, 4: c }
    await nextHand(matchId, clients, () => ({ type: 'fold' }))
    await playOut(matchId, clients, () => ({ type: 'fold' }))
    await c.next((f) => f.t === 'reveal' && f.handNo === 2)
    const archived = () => calls.filter((c) => c.rpc.startsWith('record_'))
    for (let i = 0; i < 400 && archived().length < 3; i++)
      await new Promise((r) => setTimeout(r, 5))

    const [first, ...hands] = archived()
    expect(first.rpc).toBe('record_match')
    expect(first.p).toMatchObject({
      id: matchId,
      kind: 'six-casual',
      players: [
        { seat: 1, userId: USERS[0] },
        { seat: 3, userId: USERS[1] },
      ],
    })
    expect((first.p.config as Record<string, unknown>).maxSeats).toBe(6)
    expect(first.p.config).not.toHaveProperty('handsTotal')
    expect(hands.map((h) => h.rpc)).toEqual(['record_hand', 'record_hand'])
    const [one, two] = hands.map((h) => h.p.record as HandRecordV1)
    // Hand 1 dealt two accounts; hand 2 all three, the late one included.
    expect(one.seats).toEqual([
      { seat: 1, userId: USERS[0], username: 'p0' },
      { seat: 3, userId: USERS[1], username: 'p1' },
    ])
    expect(two.seats).toEqual([
      { seat: 1, userId: USERS[0], username: 'p0' },
      { seat: 3, userId: USERS[1], username: 'p1' },
      { seat: 4, userId: USERS[2], username: 'p2' },
    ])
    expect(two.config).toMatchObject({ button: 1, sb: 3, bb: 4 })
    for (const [h, record] of [
      [hands[0], one],
      [hands[1], two],
    ] as const) {
      const byUser = Object.fromEntries(
        record.seats.map((s) => [s.userId, record.netBySeat[s.seat]]),
      )
      expect(h.p.netByUser).toEqual(byUser)
      expect(
        (h.p.holesByUser as { userId: string }[]).map((x) => x.userId),
      ).toEqual(record.seats.map((s) => s.userId))
    }
  })
})

describe('six sessions', () => {
  const ACCOUNTS = [
    'a1000000-0000-4000-8000-00000000000a',
    'b1000000-0000-4000-8000-00000000000b',
    'c1000000-0000-4000-8000-00000000000c',
    'd1000000-0000-4000-8000-00000000000d',
  ]
  const [A, B, C, D] = ACCOUNTS
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
  afterEach(() => vi.unstubAllGlobals())

  /**
   * Supabase, stubbed: every archive call is recorded, and while `down` is
   * set every one fails as an outage (usernames still resolve).
   */
  function stubArchive() {
    const calls: { rpc: string; p: Record<string, unknown> }[] = []
    const state = { down: false }
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
          return Response.json([{ username: `p${ACCOUNTS.indexOf(id)}` }])
        }
        if (url.pathname.endsWith('/audit_hand'))
          return Response.json({ verified: true })
        if (state.down) return new Response(null, { status: 503 })
        if (url.pathname.startsWith('/rest/v1/rpc/'))
          calls.push({
            rpc: url.pathname.slice('/rest/v1/rpc/'.length),
            p: JSON.parse(String(init!.body)).p,
          })
        return new Response(null, { status: 204 })
      },
    )
    forgetUsernames()
    return { calls, state }
  }
  type Call = ReturnType<typeof stubArchive>['calls'][number]
  /** record_match calls that close a session (they carry its result). */
  const ends = (calls: Call[]) =>
    calls.filter((c) => c.rpc === 'record_match' && c.p.result)
  /** The table's queued archive calls. */
  const outbox = async (matchId: string) =>
    (await storageOf(matchId)).keys.filter((k) => k.startsWith('outbox:'))
  const decks = async (matchId: string) =>
    (await storageOf(matchId)).keys.filter((k) => k.startsWith('deck:'))
  /** Waits for every queued call to be sent. */
  const drained = (matchId: string) =>
    eventually(async () => (await outbox(matchId)).length === 0)

  /**
   * Between hands: the session's count jumps to `handNo`, as if that many
   * hands had been dealt (the table's own count of hands is untouched).
   */
  const jumpTo = (matchId: string, handNo: number) =>
    runInDurableObject(stub(matchId), async (instance: TableDO, state) => {
      const { match } = instance as unknown as { match: { handNo: number } }
      match.handNo = handNo
      await state.storage.put('match', match)
    })

  /** The player to act runs out of time: the clock goes to their deadline. */
  async function timeOut(matchId: string) {
    const at = await runInDurableObject(stub(matchId), (instance: TableDO) => {
      const { deadlines } = instance as unknown as {
        deadlines: { kind: string; at: number }[]
      }
      return deadlines.find((d) => d.kind === 'turn')!.at
    })
    await setClock(matchId, at)
    await runDurableObjectAlarm(stub(matchId))
  }

  it('idle table closes its session and archives the result', async () => {
    const { calls } = stubArchive()
    const matchId = await sixTable()
    const a = await sitDown(matchId, A, 0)
    const b = await sitDown(matchId, B, 2)
    await a.next(isState(1))
    const c = await sitDown(matchId, C, 4)
    const clients = { 0: a, 2: b, 4: c }
    await nextHand(matchId, clients, () => ({ type: 'fold' }))
    await playOut(matchId, clients, () => ({ type: 'fold' }))
    // Two stand: the one left cannot be dealt a hand, and the table waits.
    await standUp(b)
    await standUp(c)
    await drained(matchId)
    await elapse(matchId, NEXT_HAND_MS)
    expect((await peek(matchId)).match.status).toBe('waiting')
    // No hand has started for just under IDLE_MS: the session is open.
    await elapse(matchId, IDLE_MS - NEXT_HAND_MS - 1)
    expect(ends(calls)).toEqual([])
    await elapse(matchId, 1)
    await eventually(async () => ends(calls).length === 1)
    expect(ends(calls)[0].p).toEqual({
      id: matchId,
      kind: 'six-casual',
      config: expect.objectContaining({ kind: 'six-casual', maxSeats: 6 }),
      players: [{ seat: 0, userId: A }],
      handNo: 2,
      timeouts: { [A]: 0 },
      result: { netBySeat: {}, reason: 'complete' },
    })
    // Only the archive: nobody hears of it, the seated account is still
    // held, and the table stays.
    for (const client of [a, b, c])
      expect(client.frames.some((f) => f.t === 'match_end')).toBe(false)
    expect(await claims()).toEqual({ [A]: matchId })
    expect((await peek(matchId)).match.status).toBe('waiting')
    await drained(matchId)

    // A second player sits: the next session starts with its own matches
    // row, at hand 1, and its matchId on every frame from its hand_start.
    const from = a.frames.length
    expect(await trySit(b, 2)).toMatchObject({ seat: 2 })
    const start = (await a.next((f) => f.t === 'hand_start', from)) as Extract<
      ServerMsg,
      { t: 'hand_start' }
    >
    const next = start.matchId
    expect(next).toMatch(UUID)
    expect(next).not.toBe(matchId)
    expect(start.handNo).toBe(1)
    expect(
      a.frames.slice(a.frames.indexOf(start)).every((f) => f.matchId === next),
    ).toBe(true)
    expect(
      a.frames.slice(from, a.frames.indexOf(start)).map((f) => f.matchId),
    ).not.toContain(next)
    const hand = await playOut(matchId, { 0: a, 2: b }, () => ({
      type: 'fold',
    }))
    expect(hand.config.handNo).toBe(1)
    await drained(matchId)
    const opened = calls.filter(
      (c) => c.rpc === 'record_match' && c.p.id === next,
    )
    expect(opened).toEqual([
      {
        rpc: 'record_match',
        p: expect.objectContaining({
          id: next,
          players: [
            { seat: 0, userId: A },
            { seat: 2, userId: B },
          ],
        }),
      },
    ])
    expect(opened[0].p).not.toHaveProperty('result')
    const archived = calls.filter((c) => c.rpc === 'record_hand').at(-1)!.p
    expect(archived).toMatchObject({ id: `${next}:1`, matchId: next })
    expect((archived.record as HandRecordV1).matchId).toBe(next)
    checkFrames(
      [a, b, c].flatMap((x) => x.frames),
      'six-casual',
    )
  })

  it('rotation keeps seats, stacks and blinds and starts a new matches row', async () => {
    const { calls } = stubArchive()
    const matchId = await sixTable()
    const a = await sitDown(matchId, A, 1)
    const b = await sitDown(matchId, B, 3)
    await a.next(isState(1))
    const c = await sitDown(matchId, C, 5)
    const clients: Record<SeatId, Client> = { 1: a, 3: b, 5: c }
    await nextHand(matchId, clients, () => ({ type: 'fold' }))
    await playOut(matchId, clients, () => ({ type: 'fold' }))
    await drained(matchId)
    // The session jumps to its last hands; D sits for hand 999 and stands
    // after it, so its cooldown spans the rotation.
    await jumpTo(matchId, 998)
    const d = await sitDown(matchId, D, 0)
    await elapse(matchId, NEXT_HAND_MS)
    expect((await peek(matchId)).hand!.config.handNo).toBe(999)
    await playOut(matchId, { ...clients, 0: d }, () => ({ type: 'fold' }))
    expect(await standUp(d)).toMatchObject({ seat: null })
    await drained(matchId)
    await elapse(matchId, NEXT_HAND_MS)
    // Hand 1000, the last of the session: the first to act spends 25 s, so
    // 5 s of their bank, then everyone checks or calls it down.
    const last1000 = (await peek(matchId)).hand!
    expect(last1000.config.handNo).toBe(1000)
    // The whole blinds value, the dead small blind's seat included.
    const { blinds: kept } = (await peek(matchId)).match as unknown as {
      blinds: Blinds
    }
    const spender = last1000.toAct!
    await elapse(matchId, 25_000)
    const ended = await playOut(matchId, clients, passive)
    const banks = async () =>
      (
        (await peek(matchId)).match as unknown as {
          players: { seat: SeatId; bankMs: number }[]
        }
      ).players.map((p) => [p.seat, p.bankMs])
    const before = await banks()
    expect(before).toContainEqual([spender, 25_000])
    await drained(matchId)
    const from = a.frames.length
    await elapse(matchId, NEXT_HAND_MS)

    // Hand 1000 dealt and archived: the session ended, and the next deal is
    // hand 1 of a new one, under a new matchId.
    await eventually(async () => ends(calls).length === 1)
    expect(ends(calls)[0].p).toMatchObject({
      id: matchId,
      handNo: 1000,
      result: { reason: 'complete' },
    })
    const first = (await peek(matchId)).hand!
    expect(first.config.handNo).toBe(1)
    const start = (await a.next((f) => f.t === 'hand_start', from)) as Extract<
      ServerMsg,
      { t: 'hand_start' }
    >
    expect(start).toMatchObject({ handNo: 1 })
    expect(start.matchId).toMatch(UUID)
    expect(start.matchId).not.toBe(matchId)
    // Same seats, stacks carried from hand 1000, blinds moved on from it
    // (not a first hand's), banks as they were.
    expect(first.config.seats).toEqual(
      ended.players.map((p) => ({ seat: p.seat, stack: p.stack })),
    )
    const blinds = nextBlinds(kept, [1, 3, 5])
    expect(first.config).toMatchObject({
      button: blinds.button,
      sb: blinds.sb,
      bb: blinds.bb,
    })
    expect(await banks()).toEqual(before)
    // D stood after hand 999 (3 hands dealt at the table): 1000 and the new
    // hand 1 since, so 4 to go.
    expect(await trySit(d)).toMatchObject({
      code: 'sit_cooldown',
      handsLeft: 4,
    })
    // A new matches row with the same players; its hands under its id.
    await playOut(matchId, clients, () => ({ type: 'fold' }))
    await drained(matchId)
    expect(
      calls.find((c) => c.rpc === 'record_match' && c.p.id === start.matchId)
        ?.p,
    ).toMatchObject({
      players: [
        { seat: 1, userId: A },
        { seat: 3, userId: B },
        { seat: 5, userId: C },
      ],
    })
    expect(
      calls.filter((c) => c.rpc === 'record_hand').at(-1)!.p,
    ).toMatchObject({
      id: `${start.matchId}:1`,
      matchId: start.matchId,
      handNo: 1,
    })
    checkFrames(
      [a, b, c, d].flatMap((x) => x.frames),
      'six-casual',
    )
  }, 60_000)

  it('deck keys do not accumulate', async () => {
    // Archived: a hand's deck goes once its record_hand is stored.
    stubArchive()
    const matchId = await sixTable()
    const clients = {
      0: await sitDown(matchId, A, 0),
      2: await sitDown(matchId, B, 2),
      4: await sitDown(matchId, C, 4),
    }
    await clients[0].next(isState(1))
    for (let n = 1; n <= 8; n++) {
      expect(await decks(matchId), `hand ${n} dealt`).toHaveLength(1)
      await playOut(matchId, clients, passive)
      await drained(matchId)
      expect(await decks(matchId), `hand ${n} archived`).toEqual([])
      await elapse(matchId, NEXT_HAND_MS)
    }
    // Not archived (dev accounts): a hand's deck goes as the hand ends.
    const dev = await sixTable()
    const devs = await seatAll(dev, [1, 3], 'decks')
    await devs[1].next(isState(1))
    for (let n = 1; n <= 8; n++) {
      expect(await decks(dev), `dev hand ${n} dealt`).toHaveLength(1)
      await playOut(dev, devs, passive)
      expect(await decks(dev), `dev hand ${n} over`).toEqual([])
      expect(await outbox(dev)).toEqual([])
      await elapse(dev, NEXT_HAND_MS)
    }
  }, 60_000)

  it('a session ends only when its outbox is empty', async () => {
    const { calls, state } = stubArchive()
    const matchId = await sixTable()
    const a = await sitDown(matchId, A, 0)
    const b = await sitDown(matchId, B, 2)
    await a.next(isState(1))
    await drained(matchId)
    // Supabase goes down: hand 1's calls stay queued.
    state.down = true
    await playOut(matchId, { 0: a, 2: b }, () => ({ type: 'fold' }))
    await standUp(b)
    await elapse(matchId, NEXT_HAND_MS)
    expect((await peek(matchId)).match.status).toBe('waiting')
    // Idle past IDLE_MS, but its calls are still queued: it stays open.
    await elapse(matchId, IDLE_MS)
    expect(ends(calls)).toEqual([])
    expect(await outbox(matchId)).toContain('outbox:0001.0001:hand')
    // Back up: the retry sends hand 1, and then the session ends.
    state.down = false
    await elapse(matchId, 300_000)
    await eventually(async () => ends(calls).length === 1)
    expect(calls.map((c) => [c.rpc, c.p.handNo ?? null])).toEqual([
      ['record_match', null],
      ['record_hand', 1],
      ['record_match', 1],
    ])
    await drained(matchId)

    // Past the cap of 1,000 hands with calls queued, play goes on in the
    // same session; at 9,000 no hand is dealt until they drain.
    const seen = a.frames.length
    const c = await sitDown(matchId, C, 4)
    await a.next((f) => f.t === 'hand_start', seen)
    expect((await peek(matchId)).hand!.config.handNo).toBe(1)
    const id = () =>
      a.frames.filter((f) => f.t === 'hand_start').at(-1)!.matchId
    const second = id()
    expect(second).not.toBe(matchId)
    // Its start is archived; then Supabase goes down for good.
    await drained(matchId)
    state.down = true
    const players = { 0: a, 4: c }
    await playOut(matchId, players, () => ({ type: 'fold' }))
    await jumpTo(matchId, 1500)
    await elapse(matchId, NEXT_HAND_MS)
    expect((await peek(matchId)).hand!.config.handNo).toBe(1501)
    await playOut(matchId, players, () => ({ type: 'fold' }))
    await elapse(matchId, NEXT_HAND_MS)
    expect((await peek(matchId)).hand!.config.handNo).toBe(1502)
    expect(id()).toBe(second)
    await playOut(matchId, players, () => ({ type: 'fold' }))
    await jumpTo(matchId, 9000)
    await elapse(matchId, NEXT_HAND_MS)
    // Hand "9000" is over and nothing more is dealt while calls wait.
    expect((await peek(matchId)).hand!.config.handNo).toBe(1502)
    // The waiting calls are the second session's, keyed by its number, so
    // they can never collide with another session's.
    const waiting = await outbox(matchId)
    expect(waiting).toContain('outbox:0002.1502:hand')
    expect(waiting.every((k) => k.startsWith('outbox:0002.'))).toBe(true)
    await elapse(matchId, NEXT_HAND_MS)
    expect((await peek(matchId)).hand!.config.handNo).toBe(1502)
    expect(ends(calls)).toHaveLength(1)
    // They drain: the session ends, and a new one deals its hand 1.
    state.down = false
    const from = a.frames.length
    await elapse(matchId, 300_000)
    await a.next((f) => f.t === 'hand_start', from)
    await eventually(async () => ends(calls).length === 2)
    expect(ends(calls).map((e) => [e.p.id, e.p.handNo])).toEqual([
      [matchId, 1],
      [second, 9000],
    ])
    expect((await peek(matchId)).hand!.config.handNo).toBe(1)
    expect(id()).not.toBe(second)
  }, 60_000)

  it('six-casual timeouts are archived by account', async () => {
    const { calls } = stubArchive()
    const matchId = await sixTable()
    const a = await sitDown(matchId, A, 0)
    const b = await sitDown(matchId, B, 2)
    await a.next(isState(1))
    const c = await sitDown(matchId, C, 4)
    const clients = { 0: a, 2: b, 4: c }
    await nextHand(matchId, clients, () => ({ type: 'fold' }))
    // Hand 2 (button 0, small blind 2, big blind 4): A times out, then B,
    // then C plays and A's next turn runs out too. A's misses are not in a
    // row (A acts in hand 3 between), but both count for the session.
    let hand = (await peek(matchId)).hand!
    expect(hand.toAct).toBe(0)
    await timeOut(matchId)
    expect((await peek(matchId)).hand!.toAct).toBe(2)
    await timeOut(matchId)
    await playOut(matchId, clients, () => ({ type: 'fold' }))
    await elapse(matchId, NEXT_HAND_MS)
    hand = (await peek(matchId)).hand!
    expect(hand.config.handNo).toBe(3)
    // Hand 3: A acts (its run of misses resets), and later times out.
    await nextHand(matchId, clients, passive)
    while ((await peek(matchId)).hand!.toAct !== 0)
      await move(matchId, clients, passive)
    await timeOut(matchId)
    await playOut(matchId, clients, () => ({ type: 'fold' }))
    // B leaves before the session ends; C too, so the table waits.
    await standUp(b)
    await standUp(c)
    await drained(matchId)
    await elapse(matchId, NEXT_HAND_MS)
    await elapse(matchId, IDLE_MS)
    await eventually(async () => ends(calls).length === 1)
    // Session totals by account (record_match v6 reads them by user id),
    // B's too although it left; nothing by seat.
    expect(ends(calls)[0].p.timeouts).toEqual({ [A]: 2, [B]: 1 })
  }, 60_000)

  it('nobody seated and nothing queued: the table deletes itself', async () => {
    const { calls, state } = stubArchive()
    const matchId = await sixTable()
    const a = await sitDown(matchId, A, 1)
    const b = await sitDown(matchId, B, 4)
    await a.next(isState(1))
    await playOut(matchId, { 1: a, 4: b }, () => ({ type: 'fold' }))
    await drained(matchId)
    // Supabase goes down; both stand; the table waits with nobody seated.
    state.down = true
    await standUp(a)
    await standUp(b)
    await elapse(matchId, NEXT_HAND_MS)
    expect((await peek(matchId)).match.status).toBe('waiting')
    // IDLE_MS on: the session is closed, but its end is still queued, so
    // the table stays.
    await elapse(matchId, IDLE_MS)
    expect(await outbox(matchId)).toEqual(['outbox:0001.9999:end'])
    expect((await storageOf(matchId)).keys).toContain('match')
    await elapse(matchId, IDLE_MS)
    expect((await storageOf(matchId)).keys).toContain('match')
    // Back up: the end is archived, and the next idle check deletes all.
    state.down = false
    await elapse(matchId, 300_000)
    await eventually(async () => ends(calls).length === 1)
    await drained(matchId)
    await elapse(matchId, IDLE_MS)
    expect(await storageOf(matchId)).toEqual({ keys: [], alarm: null })
    await eventually(async () => a.closed !== null && b.closed !== null)
    expect([a.closed?.code, b.closed?.code]).toEqual([CLOSE_GONE, CLOSE_GONE])
  }, 60_000)
})

describe('a six table that halts', () => {
  it('sends match_end to its seats only', async () => {
    // Hand 2's plan names no players: the table halts as an engine fault.
    const cash = new CashController()
    const matchId = await sixTable({
      nextHandPlan: (handNo, config, roster) => {
        const plan = cash.nextHandPlan(handNo, config, roster)
        return plan && handNo === 2 ? { ...plan, users: undefined } : plan
      },
    })
    const watcher = await connect(matchId, 'halt-w')
    await watcher.next((f) => f.t === 'welcome')
    const clients = await seatAll(matchId, [0, 3], 'halt')
    await clients[0].next(isState(1))
    await playOut(matchId, clients, () => ({ type: 'fold' }))
    await elapse(matchId, NEXT_HAND_MS)
    for (const seat of [0, 3])
      expect(
        await clients[seat].next((f) => f.t === 'match_end'),
      ).toMatchObject({ result: { reason: 'engine_fault' } })
    // Nor when the watcher asks again, or another seatless socket opens.
    watcher.send({ t: 'resync' })
    await watcher.next((f) => f.t === 'welcome', 1)
    const late = await connect(matchId, 'halt-late')
    await late.next((f) => f.t === 'welcome')
    late.send({ t: 'resync' })
    await late.next((f) => f.t === 'welcome', 1)
    for (const client of [watcher, late])
      expect(client.frames.map((f) => f.t)).not.toContain('match_end')
    // A seat that reconnects still gets the result.
    const back = await connect(matchId, 'halt-0')
    await back.next((f) => f.t === 'match_end')
  })
})
