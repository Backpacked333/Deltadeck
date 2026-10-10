// What the next hand is, decided before any card exists. LocalController
// plays heads-up invite and rated tables and must keep its exact plans;
// CashController plays six-casual tables (ADR amendment 2026-10-10, Phase 2):
// stacks carried, blind seats from nextBlinds, only players who can be dealt
// in. The table trusts these plans, so every one is also dealt by the engine.
import { describe, expect, it } from 'vitest'
import { isValidDeck, shuffleWith } from '../../src/engine/deck'
import { act, isOver, startHand } from '../../src/engine/hand'
import type { Blinds } from '../../src/engine/positions'
import type { HandState } from '../../src/engine/types'
import type { MatchConfig } from '../../src/shared/protocol'
import { CashController, LocalController } from '../src/controller'
import type { CashPlan, HandPlan, RosterSeat } from '../src/controller'

/** A repeatable stream for shuffleWith, and the sizes it was asked for. */
function seeded(seed: number) {
  const asked: number[] = []
  const random = (n: number) => {
    asked.push(n)
    seed = (seed * 1103515245 + 12345) % 2 ** 31
    return seed % n
  }
  return { random, asked }
}

/** Distinct, recognisable secrets: the n-th call starts at n * 31. */
function counted() {
  const lengths: number[] = []
  const bytes = (n: number) => {
    lengths.push(n)
    return Uint8Array.from(
      { length: n },
      (_, i) => (lengths.length * 31 + i) % 256,
    )
  }
  return { bytes, lengths }
}

const HEADS_UP: MatchConfig = {
  kind: 'hu-casual',
  handsTotal: 3,
  startingStack: 2000,
  blinds: { sb: 10, bb: 20 },
  decisionMs: 20_000,
  bankMs: 60_000,
}

describe('LocalController', () => {
  // Pinned before CashController was added: heads-up hands, their records
  // and their replays must not change by a byte. Each line is one plan for
  // the hand number on its left, as JSON; hand 4 is past handsTotal and
  // draws nothing from the stream, so the second hand 2 gets the next deck.
  it('plans the same heads-up hands, byte for byte', () => {
    const { random } = seeded(20261010)
    const { bytes } = counted()
    const controller = new LocalController(random, bytes)
    const plans = [1, 2, 3, 4, 2].map((handNo) => {
      const plan = controller.nextHandPlan(handNo, HEADS_UP)
      return `${handNo} ${plan && JSON.stringify({ config: plan.config, deck: plan.deck, secret: [...plan.secret] })}`
    })
    expect(plans).toEqual([
      '1 {"config":{"handNo":1,"seats":[{"seat":0,"stack":2000},{"seat":1,"stack":2000}],"button":0,"blinds":{"sb":10,"bb":20}},"deck":[22,49,3,7,10,36,40,9,2,14,42,17,29,23,15,43,35,26,13,25,34,31,46,8,21,16,27,4,18,38,11,37,1,39,19,41,12,51,45,47,5,24,6,20,48,28,33,32,50,44,30,0],"secret":[31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62]}',
      '2 {"config":{"handNo":2,"seats":[{"seat":0,"stack":2000},{"seat":1,"stack":2000}],"button":1,"blinds":{"sb":10,"bb":20}},"deck":[46,5,3,41,38,13,44,15,4,28,7,17,18,2,12,30,14,34,43,27,29,10,6,47,25,8,45,20,23,31,19,35,11,22,39,37,36,0,1,42,21,26,51,32,33,40,9,49,48,50,16,24],"secret":[62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93]}',
      '3 {"config":{"handNo":3,"seats":[{"seat":0,"stack":2000},{"seat":1,"stack":2000}],"button":0,"blinds":{"sb":10,"bb":20}},"deck":[1,24,42,5,37,7,9,48,44,22,17,33,21,10,19,29,13,2,20,4,30,41,11,43,3,14,39,47,36,31,25,0,46,34,18,50,6,32,49,51,26,28,35,45,15,40,27,16,23,12,38,8],"secret":[93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124]}',
      '4 null',
      '2 {"config":{"handNo":2,"seats":[{"seat":0,"stack":2000},{"seat":1,"stack":2000}],"button":1,"blinds":{"sb":10,"bb":20}},"deck":[32,44,11,7,37,13,49,9,3,29,5,42,25,34,20,19,1,48,26,27,41,6,30,39,36,10,23,43,31,24,33,51,18,45,38,8,40,22,21,47,15,46,17,28,35,50,14,16,4,2,12,0],"secret":[124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155]}',
    ])
  })
})

const SIX: MatchConfig = { ...HEADS_UP, handsTotal: 1 }

/** A seated player who is playing and has been here since the last hand. */
const at = (seat: number, stack = 2000): RosterSeat => ({
  seat,
  userId: `u${seat}`,
  stack,
  status: 'playing',
  justSat: false,
})

/** Deals the plan; the engine refuses any placement the ADR forbids. */
function deal(plan: HandPlan | null) {
  expect(plan, 'a plan').not.toBeNull()
  return startHand(plan!.config, plan!.deck)
}

/** Everyone folds to the last player, who takes the blinds. */
function foldOut(hand: HandState) {
  while (!isOver(hand)) hand = act(hand, hand.toAct!, { type: 'fold' })
  return hand
}

describe('CashController', () => {
  it('carries stacks', () => {
    const controller = new CashController()
    const roster = [at(0, 1234), at(1, 2766), at(3, 50)]
    const first = controller.nextHandPlan(1, SIX, {
      seats: roster,
      blinds: null,
    })
    // The roster's chips, never the starting stack.
    expect(first?.config.seats).toEqual([
      { seat: 0, stack: 1234 },
      { seat: 1, stack: 2766 },
      { seat: 3, stack: 50 },
    ])
    const after = foldOut(deal(first))
    const carried = roster.map((p) => ({
      ...p,
      stack: after.players.find((q) => q.seat === p.seat)!.stack,
    }))
    // The big blind (seat 3) took the small blind's 10 from seat 1.
    expect(carried.map((p) => p.stack)).toEqual([1234, 2756, 60])
    const second = controller.nextHandPlan(2, SIX, {
      seats: carried,
      blinds: first!.blinds,
    })
    expect(second?.config.seats).toEqual([
      { seat: 0, stack: 1234 },
      { seat: 1, stack: 2756 },
      { seat: 3, stack: 60 },
    ])
    // A session has no hand count: handsTotal is a heads-up setting.
    expect(second?.config.handNo).toBe(2)
    deal(second)
  })

  it('skips empty seats with gaps 0,2,5', () => {
    const controller = new CashController()
    const seats = [at(5), at(0), at(2)]
    const plans: CashPlan[] = []
    let blinds: Blinds | null = null
    for (let handNo = 1; handNo <= 4; handNo++) {
      const plan: CashPlan = controller.nextHandPlan(handNo, SIX, {
        seats,
        blinds,
      })!
      deal(plan)
      plans.push(plan)
      blinds = plan.blinds
    }
    // Ascending seats, as the engine requires, and only the occupied ones.
    for (const plan of plans)
      expect(plan.config.seats.map((s) => s.seat)).toEqual([0, 2, 5])
    // The first hand puts the button on the lowest seat; then the big
    // blind walks 5 → 0 → 2 → 5, one occupied seat at a time.
    expect(
      plans.map(({ config: { button, sb, bb } }) => ({ button, sb, bb })),
    ).toEqual([
      { button: 0, sb: 2, bb: 5 },
      { button: 2, sb: 5, bb: 0 },
      { button: 5, sb: 0, bb: 2 },
      { button: 0, sb: 2, bb: 5 },
    ])
    // Who holds each dealt seat, fixed at the deal.
    expect(plans[0].users).toEqual([
      { seat: 0, userId: 'u0' },
      { seat: 2, userId: 'u2' },
      { seat: 5, userId: 'u5' },
    ])
  })

  it('skips sitting-out and busted seats, and a newcomer posts no small blind', () => {
    const controller = new CashController()
    const blinds = { button: 0, sb: 1, bb: 2, sbSeat: 1 }
    const plan = controller.nextHandPlan(7, SIX, {
      seats: [
        at(0),
        at(1),
        { ...at(2), justSat: true },
        { ...at(3), status: 'sitting_out' },
        at(4, 0),
        at(5),
      ],
      blinds,
    })!
    deal(plan)
    expect(plan.config.seats.map((s) => s.seat)).toEqual([0, 1, 2, 5])
    expect(plan.users.map((u) => u.userId)).toEqual(['u0', 'u1', 'u2', 'u5'])
    // The big blind skips the seats nobody is dealt into (3 and 4). The
    // small blind falls on seat 2, whose player has just sat: dead (R-20).
    expect(plan.blinds).toEqual({ button: 1, sb: null, bb: 5, sbSeat: 2 })
    expect(plan.config).toMatchObject({ button: 1, sb: null, bb: 5 })
  })

  it('dead button after the big blind leaves', () => {
    const controller = new CashController()
    const four = [at(0), at(1), at(2), at(3)]
    const first = controller.nextHandPlan(1, SIX, {
      seats: four,
      blinds: null,
    })!
    expect(first.blinds).toEqual({ button: 0, sb: 1, bb: 2, sbSeat: 1 })
    // The big blind (seat 2) stands up between hands.
    const three = four.filter((p) => p.seat !== 2)
    const second = controller.nextHandPlan(2, SIX, {
      seats: three,
      blinds: first.blinds,
    })!
    deal(second)
    // The big blind still moves one player on; the small blind's seat is
    // the one the big blind left, so nobody posts it.
    expect(second.blinds).toEqual({ button: 1, sb: null, bb: 3, sbSeat: 2 })
    const third = controller.nextHandPlan(3, SIX, {
      seats: three,
      blinds: second.blinds,
    })!
    deal(third)
    // The button follows the small blind's seat: empty, so dead.
    expect(third.blinds).toEqual({ button: 2, sb: 3, bb: 0, sbSeat: 3 })
    expect(third.config.seats.map((s) => s.seat)).not.toContain(2)
    expect(third.config).toMatchObject({ button: 2, sb: 3, bb: 0 })
  })

  it('null with one seated', () => {
    const controller = new CashController()
    const blinds = { button: 0, sb: 1, bb: 2, sbSeat: 1 }
    for (const seats of [
      [],
      [at(4)],
      [at(4), { ...at(1), status: 'sitting_out' as const }],
      [at(4), at(1, 0)],
    ]) {
      expect(
        controller.nextHandPlan(1, SIX, { seats, blinds: null }),
      ).toBeNull()
      expect(controller.nextHandPlan(9, SIX, { seats, blinds })).toBeNull()
    }
  })

  it('deck and secret fresh per hand', () => {
    const { random, asked } = seeded(7)
    const { bytes, lengths } = counted()
    const controller = new CashController(random, bytes)
    const seats = [at(0), at(3)]
    const first = controller.nextHandPlan(1, SIX, { seats, blinds: null })!
    // The deck is shuffleWith over the injected stream, nothing else.
    expect(first.deck).toEqual(shuffleWith(seeded(7).random))
    expect(asked).toEqual(Array.from({ length: 51 }, (_, i) => 52 - i))
    const second = controller.nextHandPlan(2, SIX, {
      seats,
      blinds: first.blinds,
    })!
    expect(asked).toHaveLength(102)
    expect(second.deck).not.toEqual(first.deck)
    // A fresh 32-byte secret for every hand.
    expect(lengths).toEqual([32, 32])
    const from = (n: number) => Array.from({ length: 32 }, (_, i) => n + i)
    expect([...first.secret]).toEqual(from(31))
    expect([...second.secret]).toEqual(from(62))
    // By default: the CSPRNG deck and bytes (randomInt, randomBytes).
    const real = new CashController()
    const a = real.nextHandPlan(1, SIX, { seats, blinds: null })!
    const b = real.nextHandPlan(1, SIX, { seats, blinds: null })!
    expect(isValidDeck(a.deck)).toBe(true)
    expect(a.secret).toBeInstanceOf(Uint8Array)
    expect(a.secret).toHaveLength(32)
    expect(b.deck).not.toEqual(a.deck)
    expect(b.secret).not.toEqual(a.secret)
  })
})
