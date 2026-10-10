// Casual 6-max tables (ADR amendment 2026-10-10, Phase 2): sitting down and
// playing, with stacks carried from hand to hand. The server owns the
// cards, so every check here is made on the bytes clients receive: no seat
// sees another's hole cards before that hand's showdown, a folded hand
// never shows, a socket without a seat hears nothing about hands, and what
// a seat receives does not change with what any other seat holds. Each
// hand's frames are built for the seat its user was dealt into, read from
// that hand's own seat-to-user map.
import { env, runInDurableObject } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dealSlots } from '../../src/engine/deck'
import { legalActions } from '../../src/engine/hand'
import { seededDeck } from '../../src/engine/testing'
import type { HandState, PlayerAction, SeatId } from '../../src/engine/types'
import type { HandRecordV1, ServerMsg } from '../../src/shared/protocol'
import { forgetUsernames } from '../src/auth'
import { CashController } from '../src/controller'
import type { TableController } from '../src/controller'
import { NEXT_HAND_MS } from '../src/table'
import type { InitBody, TableDO } from '../src/table'
import { analysisKeys, checkFrames, FLOW_TYPES } from './frames'
import {
  bySeat,
  connect,
  elapse,
  freezeClock,
  isState,
  move,
  peek,
  seatPairs,
  stub,
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
