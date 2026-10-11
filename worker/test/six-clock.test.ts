// The six-casual clock (ADR amendment 2026-10-10, "Orbit and clock"): 20 s
// a decision and a 30 s bank, set back to 30 s for every seated player when
// a hand starts a new orbit. The orbit is measured on the ring, not in hands:
// each deal adds how many seats, empty ones included, the big blind moved
// clockwise, and the hand that brings that to 6 starts the next orbit. A
// dead button, a dead small blind, players sitting down and players leaving
// must neither stretch an orbit (someone posts the big blind twice in it)
// nor shorten it (someone dealt in throughout never posts it).
import { describe, expect, it } from 'vitest'
import { nextBlinds } from '../../src/engine/positions'
import type { Blinds } from '../../src/engine/positions'
import { seededRandom } from '../../src/engine/testing'
import { EngineError } from '../../src/engine/types'
import type { SeatId } from '../../src/engine/types'
import { orbitDone } from '../src/deadlines'

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
