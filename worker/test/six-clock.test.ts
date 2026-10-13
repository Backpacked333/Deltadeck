// The six-casual clock (ADR amendment 2026-10-10, "Orbit and clock"): 20 s
// a decision and a 30 s bank, set back to 30 s for every seated player when
// a hand starts a new orbit. The orbit is measured on the ring, not in hands:
// each deal adds how many seats, empty ones included, the big blind moved
// clockwise, and the hand that brings that to 6 starts the next orbit. A
// dead button, a dead small blind, players sitting down and players leaving
// must neither stretch an orbit (someone posts the big blind twice in it)
// nor shorten it (someone dealt in throughout never posts it).
import {
  abortAllDurableObjects,
  env,
  runInDurableObject,
} from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { legalActions } from '../../src/engine/hand'
import { nextBlinds } from '../../src/engine/positions'
import type { Blinds } from '../../src/engine/positions'
import { seededRandom } from '../../src/engine/testing'
import { EngineError } from '../../src/engine/types'
import type { HandState, PlayerAction, SeatId } from '../../src/engine/types'
import type { ServerMsg } from '../../src/shared/protocol'
import { forgetUsernames } from '../src/auth'
import { orbitDone } from '../src/deadlines'
import { NEXT_HAND_MS } from '../src/table'
import type { InitBody, TableDO } from '../src/table'
import { checkFrames, FLOW_TYPES } from './frames'
import {
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

/** The seats clockwise from `from` (excluded) to `to` (included). */
function passed(from: SeatId, to: SeatId) {
  const seats: SeatId[] = []
  let s = from
  do {
    s = (s + 1) % 6
    seats.push(s)
  } while (s !== to)
  return seats
}

describe('the orbit (orbitDone)', () => {
  it('an orbit ends when the big blind has passed every seat, with a dead button, joiners and departures', () => {
    // Worked by hand from the ADR's rules: nextBlinds places the blinds,
    // and the orbit is the big blind's travel round the ring. Counted in
    // hands instead, these orbits would be 5, 3 and 3 hands long.
    const steps: {
      why: string
      dealt: SeatId[]
      justSat?: SeatId[]
      button: SeatId
      sb: SeatId | null
      bb: SeatId
      travel: number
      refill: boolean
    }[] = [
      // Orbit 1 starts at the table's first hand: big blind 3.
      {
        why: 'first hand',
        dealt: [0, 2, 3, 4],
        button: 0,
        sb: 2,
        bb: 3,
        travel: 0,
        refill: false,
      },
      {
        why: 'one seat on',
        dealt: [0, 2, 3, 4],
        button: 2,
        sb: 3,
        bb: 4,
        travel: 1,
        refill: false,
      },
      // Seat 3 leaves: the button lands on its empty seat.
      {
        why: 'dead button',
        dealt: [0, 2, 4],
        button: 3,
        sb: 4,
        bb: 0,
        travel: 3,
        refill: false,
      },
      // A joiner ahead of the big blind posts it within this orbit.
      {
        why: 'joiner on the big blind',
        dealt: [0, 1, 2, 4],
        justSat: [1],
        button: 4,
        sb: 0,
        bb: 1,
        travel: 4,
        refill: false,
      },
      // A joiner on the orbit's first seat, which the big blind has left.
      {
        why: 'joiner on seat 3',
        dealt: [0, 1, 2, 3, 4],
        justSat: [3],
        button: 0,
        sb: 1,
        bb: 2,
        travel: 5,
        refill: false,
      },
      // The big blind is back on seat 3: every seat passed. Orbit 2.
      {
        why: 'orbit 2 starts',
        dealt: [0, 1, 2, 3, 4],
        button: 1,
        sb: 2,
        bb: 3,
        travel: 0,
        refill: true,
      },
      // Seat 4 leaves: the big blind passes its empty seat and seat 5.
      {
        why: 'departure',
        dealt: [0, 1, 2, 3],
        button: 2,
        sb: 3,
        bb: 0,
        travel: 3,
        refill: false,
      },
      // Seat 1 leaves; a joiner takes seat 5, which the big blind passed.
      {
        why: 'joiner behind the big blind',
        dealt: [0, 2, 3, 5],
        justSat: [5],
        button: 3,
        sb: 0,
        bb: 2,
        travel: 5,
        refill: false,
      },
      // Back on seat 3: the joiner did not stretch orbit 2. Orbit 3.
      {
        why: 'orbit 3 starts',
        dealt: [0, 2, 3, 5],
        button: 0,
        sb: 2,
        bb: 3,
        travel: 0,
        refill: true,
      },
      // The joiner's first big blind is in orbit 3. Seat 0 leaves.
      {
        why: 'joiner posts',
        dealt: [2, 3, 5],
        button: 2,
        sb: 3,
        bb: 5,
        travel: 2,
        refill: false,
      },
      // Seat 5 leaves: heads-up, the other player is button and small blind.
      {
        why: 'heads-up',
        dealt: [2, 3],
        button: 3,
        sb: 3,
        bb: 2,
        travel: 5,
        refill: false,
      },
      {
        why: 'orbit 4 starts',
        dealt: [2, 3],
        button: 2,
        sb: 2,
        bb: 3,
        travel: 0,
        refill: true,
      },
    ]
    let prev: Blinds | null = null
    let travel = 0
    for (const step of steps) {
      const blinds = nextBlinds(prev, step.dealt, step.justSat)
      const orbit = orbitDone(travel, prev, blinds)
      expect(
        { button: blinds.button, sb: blinds.sb, bb: blinds.bb, ...orbit },
        step.why,
      ).toEqual({
        button: step.button,
        sb: step.sb,
        bb: step.bb,
        travel: step.travel,
        refill: step.refill,
      })
      prev = blinds
      travel = orbit.travel
    }
  })

  it('a player dealt in through an orbit posts its big blind exactly once, over 5,000 tables with players joining and leaving', () => {
    // An orbit runs from the hand that starts it up to the hand that starts
    // the next. Someone dealt into every hand from the one to the other
    // posts the big blind exactly once in it: twice would mean a stretched
    // orbit, never a shortened one. The walk also checks the definition
    // itself, independently of the arithmetic: a new orbit starts exactly
    // when the big blind has passed every seat of the ring.
    const random = seededRandom(20261011)
    const counts = {
      orbits: 0,
      checked: 0,
      deadButton: 0,
      joined: 0,
      left: 0,
      headsUp: 0,
    }
    const fail = (why: string, where: object) =>
      expect.fail(`${why}: ${JSON.stringify(where)}`)
    for (let table = 0; table < 5_000; table++) {
      // occupant[s]: who sits at seat s (a fresh id per sit-down), or null.
      const occupant: (number | null)[] = Array(6).fill(null)
      const out = Array<boolean>(6).fill(false)
      const sat = Array<boolean>(6).fill(false)
      let nextId = 1
      for (let s = 0; s < 6; s++)
        if (random() < 0.6) {
          occupant[s] = nextId++
          sat[s] = true
        }
      let prev: Blinds | null = null
      let travel = 0
      /** Seats the big blind has passed since the orbit started. */
      let covered = new Set<SeatId>()
      /** The orbit so far: big blinds posted per player, who was always in. */
      let posts = new Map<number, number>()
      let always: Set<number> | null = null
      let hands = 0
      let churn = { dead: false, joined: false, left: false }
      for (let step = 0; step < 30; step++) {
        const seats = [0, 1, 2, 3, 4, 5].filter(
          (s) => occupant[s] !== null && !out[s],
        )
        if (seats.length >= 2) {
          const ids = seats.map((s) => occupant[s]!)
          const blinds = nextBlinds(
            prev,
            seats,
            seats.filter((s) => sat[s]),
          )
          const orbit = orbitDone(travel, prev, blinds)
          const where = { table, step, prev, blinds, travel, orbit }
          if (prev) for (const s of passed(prev.bb, blinds.bb)) covered.add(s)
          const starts = covered.size === 6
          if (orbit.refill !== starts)
            fail(`a new orbit should ${starts ? '' : 'not '}start`, where)
          if (!starts && orbit.travel !== covered.size)
            fail(`travel should be ${covered.size}`, where)
          if (orbit.refill) {
            if (orbit.travel !== 0) fail('a new orbit starts from 0', where)
            if (hands < 2 || hands > 6)
              fail(`an orbit of ${hands} hands`, where)
            for (const id of always!)
              if (ids.includes(id)) {
                counts.checked++
                if (posts.get(id) !== 1)
                  fail(`player ${id} posted ${posts.get(id) ?? 0} times`, where)
              }
            counts.orbits++
            if (churn.dead) counts.deadButton++
            if (churn.joined) counts.joined++
            if (churn.left) counts.left++
          }
          if (!prev || orbit.refill) {
            covered = new Set()
            posts = new Map()
            always = new Set(ids)
            hands = 0
            churn = { dead: false, joined: false, left: false }
          }
          hands++
          for (const id of always!) if (!ids.includes(id)) always!.delete(id)
          const bbId = occupant[blinds.bb]!
          posts.set(bbId, (posts.get(bbId) ?? 0) + 1)
          if (seats.length === 2) counts.headsUp++
          else if (!seats.includes(blinds.button)) churn.dead = true
          if (seats.some((s) => sat[s])) churn.joined = true
          prev = blinds
          travel = orbit.travel
          sat.fill(false)
        }
        // Between hands each seat may change once.
        for (let s = 0; s < 6; s++) {
          const r = random()
          if (occupant[s] !== null && r < 0.08) {
            occupant[s] = null
            out[s] = false
            churn.left = true
          } else if (occupant[s] !== null && r < 0.13) out[s] = !out[s]
          else if (occupant[s] === null && r < 0.12) {
            occupant[s] = nextId++
            sat[s] = true
          }
        }
      }
    }
    // The walk reached the cases the orbit has to survive.
    expect(counts.orbits).toBeGreaterThan(10_000)
    expect(counts.checked).toBeGreaterThan(20_000)
    for (const key of ['deadButton', 'joined', 'left'] as const)
      expect(counts[key], key).toBeGreaterThan(1_000)
    expect(counts.headsUp).toBeGreaterThan(1_000)
  }, 60_000)

  it("only the big blind's seat moves the orbit: the button and small blind, dead or live, change nothing", () => {
    const random = seededRandom(1011)
    const seat = () => Math.floor(random() * 6) as SeatId
    const blinds = (bb: SeatId): Blinds => {
      const sbSeat = seat()
      return {
        button: seat(),
        sb: random() < 0.3 ? null : sbSeat,
        bb,
        sbSeat,
      }
    }
    for (let i = 0; i < 2_000; i++) {
      const from = seat()
      const to = ((from + 1 + Math.floor(random() * 5)) % 6) as SeatId
      const travel = Math.floor(random() * 6)
      const once = orbitDone(travel, blinds(from), blinds(to))
      expect(orbitDone(travel, blinds(from), blinds(to))).toEqual(once)
    }
    // The table's first hand has no big blind to travel from.
    expect(orbitDone(0, null, blinds(4))).toEqual({ travel: 0, refill: false })
  })

  it('refuses a stored travel that is not 0 to 5', () => {
    // A corrupt count would refill every hand, or never again: the table
    // halts on it as on any engine fault rather than run a wrong clock.
    const prev: Blinds = { button: 0, sb: 1, bb: 2, sbSeat: 1 }
    const next: Blinds = { button: 1, sb: 2, bb: 3, sbSeat: 2 }
    for (const travel of [
      -1,
      6,
      2.5,
      Number.NaN,
      undefined as unknown as number,
    ])
      expect(() => orbitDone(travel, prev, next), String(travel)).toThrow(
        EngineError,
      )
    expect(orbitDone(5, prev, next)).toEqual({ travel: 0, refill: true })
  })
})

// ---- Over the wire, with a frozen clock that only `elapse` moves ----------

const DECISION = 20_000
const BANK = 30_000

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
 * Three players at seats 0, 2 and 4, as `${prefix}-a`, `-b` and `-c`. The
 * first two start hand 1 heads-up (seat 0 button and small blind, seat 2
 * big blind: the first orbit starts there); seat 4 sits during it and is
 * dealt in from hand 2. Hands 2, 3 and 4 then have their big blind on 4, 0
 * and 2: the big blind has travelled 2 + 2 + 2 seats, so hand 4 starts the
 * next orbit, and so does every third hand after it.
 */
async function threeSeats(prefix: string) {
  const matchId = await sixTable()
  const clients: Record<SeatId, Client> = {
    0: await sitDown(matchId, `${prefix}-a`, 0),
    2: await sitDown(matchId, `${prefix}-b`, 2),
  }
  await clients[0].next(isState(1))
  clients[4] = await sitDown(matchId, `${prefix}-c`, 4)
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

/** The player to act thinks `ms`, then makes their move. */
async function think(
  matchId: string,
  clients: Record<SeatId, Client>,
  ms: number,
  choose: (hand: HandState) => PlayerAction = passive,
) {
  await elapse(matchId, ms)
  await move(matchId, clients, choose)
}

/** The table's clock now. */
const clockOf = (matchId: string) =>
  runInDurableObject(stub(matchId), (instance: TableDO) => instance.clock())

/** Each seated account's bank, as the table stores it. */
async function banks(matchId: string) {
  const { match } = await peek(matchId)
  const { players } = match as unknown as {
    players: { userId: string; bankMs: number }[]
  }
  return Object.fromEntries(players.map((p) => [p.userId, p.bankMs]))
}

/** The table's stored orbit count. */
async function travelOf(matchId: string) {
  const { match } = await peek(matchId)
  return (match as unknown as { orbitTravel?: number }).orbitTravel
}

/**
 * The turn clock `client` was shown once hand `handNo` had `actions`
 * moves: the deadline of the player to act and what is left of their bank.
 */
function clockAt(client: Client, handNo: number, actions: number) {
  const f = client.frames.filter(isState(handNo, actions)).at(-1) as
    | Extract<ServerMsg, { t: 'state' | 'welcome' }>
    | undefined
  if (!f?.view) throw new Error(`no view of hand ${handNo} at ${actions}`)
  return { toAct: f.view.toAct, ...f.view.clock }
}

describe('the bank at a six table', () => {
  it('the bank refills each orbit (30 s bank, 20 s decision)', async () => {
    const { matchId, clients } = await threeSeats('refill')
    const [a, b, c] = ['refill-a', 'refill-b', 'refill-c']
    // Hand 1: seat 0 acts first, with 20 s to decide and the whole bank.
    let t = await clockOf(matchId)
    expect(clockAt(clients[0], 1, 0)).toEqual({
      toAct: 0,
      deadline: t + DECISION + BANK,
      bankMs: BANK,
    })
    await think(matchId, clients, 32_000, fold)
    expect(await banks(matchId)).toEqual({ [a]: 18_000, [b]: BANK, [c]: BANK })
    // Hand 2 (big blind 4) and hand 3 (big blind 0): the same orbit.
    let hand = await nextHand(matchId, clients)
    expect(hand.config).toMatchObject({ button: 0, sb: 2, bb: 4 })
    expect(await travelOf(matchId)).toBe(2)
    hand = await nextHand(matchId, clients, fold)
    expect(hand.config).toMatchObject({ button: 2, sb: 4, bb: 0 })
    expect(await travelOf(matchId)).toBe(4)
    // Seat 4 spends 8 s of bank in hand 3.
    await move(matchId, clients, passive)
    await think(matchId, clients, 28_000, passive)
    expect(await banks(matchId)).toEqual({
      [a]: 18_000,
      [b]: BANK,
      [c]: 22_000,
    })

    // Hand 4: the big blind is back on seat 2, round all six seats. Every
    // bank is full before the first decision, and seat 4's clock says so.
    hand = await nextHand(matchId, clients, fold)
    expect(hand.config).toMatchObject({ button: 4, sb: 0, bb: 2 })
    expect(await travelOf(matchId)).toBe(0)
    expect(await banks(matchId)).toEqual({ [a]: BANK, [b]: BANK, [c]: BANK })
    t = await clockOf(matchId)
    expect(clockAt(clients[0], 4, 0)).toEqual({
      toAct: 4,
      deadline: t + DECISION + BANK,
      bankMs: BANK,
    })
    // The table acts at that deadline, not a moment before.
    await elapse(matchId, DECISION + BANK - 1)
    expect((await peek(matchId)).hand!.actions).toHaveLength(0)
    await elapse(matchId, 1)
    expect((await peek(matchId)).hand!.actions[0]).toMatchObject({
      seat: 4,
      action: { type: 'fold' },
    })
    expect(await banks(matchId)).toEqual({ [a]: BANK, [b]: BANK, [c]: 0 })
    // Seat 0 spent 12 s in the last orbit; it has the whole bank again.
    t = await clockOf(matchId)
    expect(clockAt(clients[0], 4, 1)).toEqual({
      toAct: 0,
      deadline: t + DECISION + BANK,
      bankMs: BANK,
    })

    // Hands 5 and 6 are the second orbit: seat 4 decides on 20 s alone.
    hand = await nextHand(matchId, clients, fold)
    expect(hand.config).toMatchObject({ bb: 4 })
    await move(matchId, clients, passive)
    await move(matchId, clients, passive)
    t = await clockOf(matchId)
    expect(clockAt(clients[0], 5, 2)).toEqual({
      toAct: 4,
      deadline: t + DECISION,
      bankMs: 0,
    })
    hand = await nextHand(matchId, clients, passive)
    expect(hand.config).toMatchObject({ bb: 0 })
    expect(await banks(matchId)).toEqual({ [a]: BANK, [b]: BANK, [c]: 0 })
    // Hand 7 starts the third orbit: seat 4's bank is back.
    hand = await nextHand(matchId, clients, fold)
    expect(hand.config).toMatchObject({ button: 4, bb: 2 })
    expect(await banks(matchId)).toEqual({ [a]: BANK, [b]: BANK, [c]: BANK })
    t = await clockOf(matchId)
    expect(clockAt(clients[0], 7, 0)).toEqual({
      toAct: 4,
      deadline: t + DECISION + BANK,
      bankMs: BANK,
    })
    const frames = Object.values(clients).flatMap((x) => x.frames)
    expect(checkFrames(frames, 'six-casual')).toEqual(new Set(FLOW_TYPES.six))
  }, 30_000)

  it('a bank spent in one orbit stays spent until the next orbit starts', async () => {
    const { matchId, clients } = await threeSeats('spent')
    const [a, b, c] = ['spent-a', 'spent-b', 'spent-c']
    // Seat 0 spends 12 s of bank in hand 1 and 8 s more in hand 2.
    await think(matchId, clients, 32_000, fold)
    await nextHand(matchId, clients)
    let t = await clockOf(matchId)
    expect(clockAt(clients[0], 2, 0)).toEqual({
      toAct: 0,
      deadline: t + DECISION + 18_000,
      bankMs: 18_000,
    })
    await think(matchId, clients, 28_000, passive)
    expect(await banks(matchId)).toEqual({ [a]: 10_000, [b]: BANK, [c]: BANK })
    // Hand 3, the same orbit: dealing gives nothing back.
    const hand = await nextHand(matchId, clients)
    expect(hand.config).toMatchObject({ button: 2, sb: 4, bb: 0 })
    expect(await banks(matchId)).toEqual({ [a]: 10_000, [b]: BANK, [c]: BANK })
    await move(matchId, clients, passive)
    await move(matchId, clients, passive)
    // Seat 0, the big blind, has 20 s and its last 10 s, and runs out.
    t = await clockOf(matchId)
    expect(clockAt(clients[0], 3, 2)).toEqual({
      toAct: 0,
      deadline: t + DECISION + 10_000,
      bankMs: 10_000,
    })
    await elapse(matchId, DECISION + 10_000 - 1)
    expect((await peek(matchId)).hand!.actions).toHaveLength(2)
    await elapse(matchId, 1)
    expect((await peek(matchId)).hand!.actions[2]).toMatchObject({
      seat: 0,
      action: { type: 'check' },
    })
    expect(await banks(matchId)).toEqual({ [a]: 0, [b]: BANK, [c]: BANK })
    // On the flop seat 0 has the 20 s decision time alone.
    await move(matchId, clients, passive)
    t = await clockOf(matchId)
    expect(clockAt(clients[0], 3, 4)).toEqual({
      toAct: 0,
      deadline: t + DECISION,
      bankMs: 0,
    })
    // Hand 4 starts the next orbit: the bank is whole again.
    await nextHand(matchId, clients)
    expect(await banks(matchId)).toEqual({ [a]: BANK, [b]: BANK, [c]: BANK })
  }, 30_000)

  it('a player who sits mid-orbit starts with a full 30 s, and moves the orbit by no hand', async () => {
    const { matchId, clients } = await threeSeats('join')
    const [a, b, c, d] = ['join-a', 'join-b', 'join-c', 'join-d']
    await think(matchId, clients, 32_000, fold)
    await nextHand(matchId, clients)
    // Hand 2, big blind on seat 4: it has passed seat 3, where d sits now.
    clients[3] = await sitDown(matchId, d, 3)
    expect(await banks(matchId)).toEqual({
      [a]: 18_000,
      [b]: BANK,
      [d]: BANK,
      [c]: BANK,
    })
    // Hand 3: d is dealt in without posting; seat 0 has the big blind.
    let hand = await nextHand(matchId, clients, fold)
    expect(hand.config).toMatchObject({ button: 2, sb: 4, bb: 0 })
    expect(hand.config.seats.map((s) => s.seat)).toEqual([0, 2, 3, 4])
    expect(await travelOf(matchId)).toBe(4)
    await move(matchId, clients, passive)
    // d's first decision has the whole bank; seat 0's stays spent.
    let t = await clockOf(matchId)
    expect(clockAt(clients[3], 3, 1)).toEqual({
      toAct: 3,
      deadline: t + DECISION + BANK,
      bankMs: BANK,
    })
    await think(matchId, clients, 26_000, passive)
    expect(await banks(matchId)).toEqual({
      [a]: 18_000,
      [b]: BANK,
      [d]: 24_000,
      [c]: BANK,
    })
    // Hand 4 still starts the next orbit (big blind back on seat 2): the
    // joiner neither stretched the orbit nor ended it early, and was never
    // its big blind.
    hand = await nextHand(matchId, clients, fold)
    expect(hand.config).toMatchObject({ button: 4, sb: 0, bb: 2 })
    expect(await travelOf(matchId)).toBe(0)
    expect(await banks(matchId)).toEqual({
      [a]: BANK,
      [b]: BANK,
      [d]: BANK,
      [c]: BANK,
    })
    t = await clockOf(matchId)
    expect(clockAt(clients[3], 4, 0)).toEqual({
      toAct: 3,
      deadline: t + DECISION + BANK,
      bankMs: BANK,
    })
    checkFrames(
      Object.values(clients).flatMap((x) => x.frames),
      'six-casual',
    )
  }, 30_000)

  it("banks are keyed by account: a seat's next player starts with 30 s, not what the last one left", async () => {
    const { matchId, clients } = await threeSeats('owner')
    const [a, b, c, e] = ['owner-a', 'owner-b', 'owner-c', 'owner-e']
    await think(matchId, clients, 32_000, fold)
    await nextHand(matchId, clients)
    // Hand 2: seat 0 calls, then seat 2 spends 5 s of bank and folds.
    await move(matchId, clients, passive)
    await think(matchId, clients, 25_000, fold)
    expect(await banks(matchId)).toEqual({
      [a]: 18_000,
      [b]: 25_000,
      [c]: BANK,
    })
    await playOut(matchId, clients, passive)
    await clients[0].next((f) => f.t === 'reveal' && f.handNo === 2)
    // Between hands seat 2's player stands, and e takes the seat.
    const from = clients[2].frames.length
    clients[2].send({ t: 'stand' })
    await clients[2].next((f) => f.t === 'welcome' && f.seat === null, from)
    const owner = clients[2]
    clients[2] = await sitDown(matchId, e, 2)
    expect(await banks(matchId)).toEqual({ [a]: 18_000, [e]: BANK, [c]: BANK })
    await elapse(matchId, NEXT_HAND_MS)
    await clients[0].next(isState(3))
    // Hand 3, the same orbit: e acts first on the button with all of it.
    expect((await peek(matchId)).hand!.config).toMatchObject({
      button: 2,
      bb: 0,
    })
    const t = await clockOf(matchId)
    expect(clockAt(clients[2], 3, 0)).toEqual({
      toAct: 2,
      deadline: t + DECISION + BANK,
      bankMs: BANK,
    })
    expect(await banks(matchId)).toEqual({ [a]: 18_000, [e]: BANK, [c]: BANK })
    checkFrames(
      [...Object.values(clients), owner].flatMap((x) => x.frames),
      'six-casual',
    )
  }, 30_000)

  it('every seated player has the whole bank at an orbit start, one not dealt in too', async () => {
    const { matchId, clients } = await threeSeats('bust')
    const [a, b, c] = ['bust-a', 'bust-b', 'bust-c']
    await think(matchId, clients, 32_000, fold)
    await nextHand(matchId, clients)
    // Hand 2: seat 4, the big blind, spends 8 s of bank.
    await move(matchId, clients, passive)
    await move(matchId, clients, passive)
    await think(matchId, clients, 28_000, passive)
    await nextHand(matchId, clients, fold)
    await playOut(matchId, clients, passive)
    await clients[0].next((f) => f.t === 'reveal' && f.handNo === 3)
    // Seat 4 loses every chip to seat 0 in hand 3 (as an all-in would; no
    // rebuy yet): seated, but not dealt into hand 4.
    await runInDurableObject(stub(matchId), (instance: TableDO) => {
      const { hand } = instance as unknown as { hand: HandState }
      const winner = hand.players.find((p) => p.seat === 0)!
      const loser = hand.players.find((p) => p.seat === 4)!
      winner.stack += loser.stack
      loser.stack = 0
    })
    expect(await banks(matchId)).toEqual({
      [a]: 18_000,
      [b]: BANK,
      [c]: 22_000,
    })
    await elapse(matchId, NEXT_HAND_MS)
    await clients[0].next(isState(4))
    // Hand 4, heads-up between seats 0 and 2, starts the next orbit (big
    // blind 0 to 2): every seated player's bank is whole, seat 4's too.
    const hand = (await peek(matchId)).hand!
    expect(hand.config.seats.map((s) => s.seat)).toEqual([0, 2])
    expect(hand.config).toMatchObject({ bb: 2 })
    expect(await travelOf(matchId)).toBe(0)
    expect(await banks(matchId)).toEqual({ [a]: BANK, [b]: BANK, [c]: BANK })
  }, 30_000)

  it('orbitTravel and banks survive a Durable Object restart', async () => {
    const { matchId, clients } = await threeSeats('restart')
    const [a, b, c] = ['restart-a', 'restart-b', 'restart-c']
    await think(matchId, clients, 32_000, fold)
    await nextHand(matchId, clients)
    await move(matchId, clients, passive)
    await think(matchId, clients, 25_000, passive)
    await nextHand(matchId, clients, fold)
    // Hand 3, the orbit's third: seat 2 (the button) to act first.
    const t = await clockOf(matchId)
    const before = { [a]: 18_000, [b]: 25_000, [c]: BANK }
    expect(await travelOf(matchId)).toBe(4)
    expect(await banks(matchId)).toEqual(before)

    await abortAllDurableObjects()
    await freezeClock(matchId, t)
    expect(await travelOf(matchId)).toBe(4)
    expect(await banks(matchId)).toEqual(before)
    // Everyone reconnects; the clock is the one the turn had.
    const back: Record<SeatId, Client> = {}
    for (const [seat, user] of [
      [0, a],
      [2, b],
      [4, c],
    ] as const) {
      back[seat] = await connect(matchId, user)
      await back[seat].next(isState(3, 0))
    }
    expect(clockAt(back[2], 3, 0)).toEqual({
      toAct: 2,
      deadline: t + DECISION + 25_000,
      bankMs: 25_000,
    })
    // The orbit goes on from where it was: hand 4 starts the next one.
    const hand = await nextHand(matchId, back, fold)
    expect(hand.config).toMatchObject({ bb: 2 })
    expect(await travelOf(matchId)).toBe(0)
    expect(await banks(matchId)).toEqual({ [a]: BANK, [b]: BANK, [c]: BANK })
    checkFrames(
      Object.values(back).flatMap((x) => x.frames),
      'six-casual',
    )
  }, 30_000)

  it('a session rotation mid-orbit keeps the orbit and the banks', async () => {
    const { matchId, clients } = await threeSeats('rotate')
    const [a, b, c] = ['rotate-a', 'rotate-b', 'rotate-c']
    await think(matchId, clients, 32_000, fold)
    await nextHand(matchId, clients)
    await move(matchId, clients, passive)
    await think(matchId, clients, 25_000, passive)
    await playOut(matchId, clients, fold)
    await clients[0].next((f) => f.t === 'reveal' && f.handNo === 2)
    // The session reaches its last hand: the next deal starts a new one.
    // (Nothing here is archived: these accounts are not real users.)
    await runInDurableObject(
      stub(matchId),
      async (instance: TableDO, state) => {
        const { match } = instance as unknown as { match: { handNo: number } }
        match.handNo = 1000
        await state.storage.put('match', match)
      },
    )
    const from = clients[0].frames.length
    await elapse(matchId, NEXT_HAND_MS)
    const start = (await clients[0].next(
      (f) => f.t === 'hand_start',
      from,
    )) as Extract<ServerMsg, { t: 'hand_start' }>
    expect(start.handNo).toBe(1)
    expect(start.matchId).not.toBe(matchId)
    // Hand 1 of the new session is the orbit's third hand: nothing refills.
    expect(start).toMatchObject({ button: 2, sb: 4, bb: 0 })
    expect(await travelOf(matchId)).toBe(4)
    expect(await banks(matchId)).toEqual({
      [a]: 18_000,
      [b]: 25_000,
      [c]: BANK,
    })
    // Its hand 2 has the big blind back on seat 2: the next orbit.
    const hand = await nextHand(matchId, clients, fold)
    expect(hand.config).toMatchObject({ handNo: 2, bb: 2 })
    expect(await banks(matchId)).toEqual({ [a]: BANK, [b]: BANK, [c]: BANK })
  }, 30_000)

  it('a corrupt stored orbit count halts the table as an engine fault, before any hand is dealt on it', async () => {
    const { matchId, clients } = await threeSeats('corrupt')
    await move(matchId, clients, fold)
    await clients[0].next((f) => f.t === 'reveal' && f.handNo === 1)
    await runInDurableObject(
      stub(matchId),
      async (instance: TableDO, state) => {
        const { match } = instance as unknown as {
          match: { orbitTravel: number }
        }
        match.orbitTravel = 7
        await state.storage.put('match', match)
      },
    )
    await elapse(matchId, NEXT_HAND_MS)
    for (const client of Object.values(clients))
      expect(await client.next((f) => f.t === 'match_end')).toMatchObject({
        result: { reason: 'engine_fault' },
      })
    const { match, hand } = await peek(matchId)
    expect(match.status).toBe('finished')
    expect(hand!.config.handNo).toBe(1)
    expect(Object.values(clients).flatMap((x) => x.frames)).not.toContainEqual(
      expect.objectContaining({ t: 'hand_start', handNo: 2 }),
    )
  })

  it('a six table stored without bankRefill counts its orbits but keeps one bank', async () => {
    // A table created before the orbit bank has no `bankRefill` in its
    // stored config. The switch, not the orbit, refills: such a table goes
    // on counting orbits (so the count is right if it ever gains the
    // switch) and keeps the one bank it was created with.
    const { matchId, clients } = await threeSeats('legacy')
    const [a, b, c] = ['legacy-a', 'legacy-b', 'legacy-c']
    await runInDurableObject(
      stub(matchId),
      async (instance: TableDO, state) => {
        const { match } = instance as unknown as {
          match: { config: { bankRefill?: string } }
        }
        delete match.config.bankRefill
        await state.storage.put('match', match)
      },
    )
    await think(matchId, clients, 32_000, fold)
    expect(await banks(matchId)).toEqual({ [a]: 18_000, [b]: BANK, [c]: BANK })
    await nextHand(matchId, clients)
    expect(await travelOf(matchId)).toBe(2)
    await nextHand(matchId, clients, fold)
    expect(await travelOf(matchId)).toBe(4)
    // Hand 4: the big blind is back on seat 2, so an orbit starts, but
    // nothing refills, and seat 0's clock still shows what it had left.
    const hand = await nextHand(matchId, clients, fold)
    expect(hand.config).toMatchObject({ button: 4, sb: 0, bb: 2 })
    expect(await travelOf(matchId)).toBe(0)
    expect(await banks(matchId)).toEqual({ [a]: 18_000, [b]: BANK, [c]: BANK })
    await move(matchId, clients, passive)
    const t = await clockOf(matchId)
    expect(clockAt(clients[0], 4, 1)).toEqual({
      toAct: 0,
      deadline: t + DECISION + 18_000,
      bankMs: 18_000,
    })
    const { match } = await peek(matchId)
    expect((match as unknown as { config: object }).config).not.toHaveProperty(
      'bankRefill',
    )
  }, 30_000)
})

describe('the incident for a corrupt orbit count', () => {
  const USERS = [
    'a2000000-0000-4000-8000-00000000000a',
    'b2000000-0000-4000-8000-00000000000b',
    'c2000000-0000-4000-8000-00000000000c',
  ]
  afterEach(() => vi.unstubAllGlobals())

  it('records the stored count and the blinds it was counted from, beside the plan', async () => {
    // Supabase, stubbed: every archive call is recorded. Real accounts, so
    // the table is archived and its engine fault becomes an incident.
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
    const clients: Record<SeatId, Client> = {
      0: await sitDown(matchId, USERS[0], 0),
      2: await sitDown(matchId, USERS[1], 2),
    }
    await clients[0].next(isState(1))
    clients[4] = await sitDown(matchId, USERS[2], 4)
    await move(matchId, clients, fold)
    await clients[0].next((f) => f.t === 'reveal' && f.handNo === 1)
    // The count is corrupted between hands; the blinds it counts from stay.
    const blinds = await runInDurableObject(
      stub(matchId),
      async (instance: TableDO, state) => {
        const { match } = instance as unknown as {
          match: { orbitTravel: number; blinds: Blinds }
        }
        match.orbitTravel = 7
        await state.storage.put('match', match)
        return structuredClone(match.blinds)
      },
    )
    expect(blinds).toMatchObject({ button: 0, bb: 2 })
    await elapse(matchId, NEXT_HAND_MS)
    await clients[0].next((f) => f.t === 'match_end')
    for (
      let i = 0;
      i < 400 && !calls.some((c) => c.rpc === 'record_incident');
      i++
    )
      await new Promise((r) => setTimeout(r, 5))
    const incidents = calls.filter((c) => c.rpc === 'record_incident')
    expect(incidents).toHaveLength(1)
    const { p } = incidents[0]
    expect(p).toMatchObject({
      matchId,
      handNo: 2,
      kind: 'engine_fault',
      detail: { error: 'An orbit count of 7' },
    })
    // What diagnoses it: the corrupt count and the last deal's blinds, and
    // the plan it refused (only the service role reads an incident).
    const { evidence } = p.detail as { evidence: Record<string, unknown> }
    expect(evidence).toMatchObject({ orbitTravel: 7, blinds })
    expect(Object.keys(evidence).sort()).toEqual(
      ['blinds', 'config', 'deck', 'orbitTravel', 'secret'].sort(),
    )
  }, 30_000)
})

describe('heads-up banks', () => {
  it('a heads-up table stores no orbit: its match keeps the keys it had', async () => {
    const matchId = await createTable('hu-a', 3)
    await freezeClock(matchId)
    const seats: Record<SeatId, Client> = {
      0: await connect(matchId, 'hu-a'),
      1: await connect(matchId, 'hu-b'),
    }
    await seats[0].next(isState(1))
    await nextHand(matchId, seats, fold)
    const { match } = await peek(matchId)
    expect(Object.keys(match).sort()).toEqual(
      [
        'activation',
        'config',
        'firstPresenceAt',
        'handNo',
        'id',
        'memberships',
        'net',
        'players',
        'seatEpochs',
        'startDeadlineAt',
        'startedAt',
        'status',
        'v',
      ].sort(),
    )
    const { config, players } = match as unknown as {
      config: object
      players: object[]
    }
    expect(config).not.toHaveProperty('bankRefill')
    for (const p of players)
      expect(Object.keys(p).sort()).toEqual(
        ['bankMs', 'seat', 'timeouts', 'userId', 'username'].sort(),
      )
  })
})
