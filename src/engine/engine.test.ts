// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { fromId, lcg } from '../lib/sim'
import { reference } from '../test/reference'
import {
  act,
  assertInvariants,
  isOver,
  legalActions,
  potTotal,
  replayHand,
  startHand,
} from './hand'
import { blindSeats, positionNames, seatAfter } from './positions'
import { buildPots, referencePots } from './pots'
import {
  config,
  deckWith,
  randomAction,
  randomTable,
  ringDistance,
  withExplicitBlinds,
} from './testing'
import { EngineError } from './types'
import type { HandConfig, HandState, PlayerAction, SeatId } from './types'

const SOAK = !!process.env.ENGINE_SOAK
const HANDS_PER_N = SOAK ? 100_000 : 10_000
const WALK_TIMEOUT = SOAK ? 3_600_000 : 180_000
/**
 * Seeds the random hands. The scheduled soak passes a fresh one each night
 * (.github/workflows/engine-soak.yml); a failure names it so it can be
 * replayed exactly.
 */
const SEED = Number(process.env.ENGINE_SEED ?? 1000)
if (SOAK)
  console.log(
    `engine soak: seed ${SEED}, ${HANDS_PER_N.toLocaleString()} hands per table size`,
  )

/** Names the seed and hand, so any failure can be replayed exactly. */
function atHand(error: unknown, n: number, h: number) {
  const where = `seed ${SEED}, ${n} players, hand ${h + 1} (replay: ENGINE_SEED=${SEED} npm run engine:soak)`
  if (error instanceof Error) error.message = `${where}: ${error.message}`
  return error
}

const seatOf = (state: HandState, seat: SeatId) =>
  state.players.find((p) => p.seat === seat)!
const stacks = (state: HandState) => state.players.map((p) => p.stack)
/** Clockwise order from the seat after the button, which may be empty. */
const fromButton = (state: HandState, seat: SeatId) =>
  ringDistance(state.config.button, seat) || 6

/**
 * What a hand with explicit blind seats must look like before anyone acts,
 * worked out from the config alone: only the named blinds post, and when
 * nobody is all in the first player clockwise after the big blind opens.
 * A hand that ran out at once (blinds all in) has already returned chips.
 */
function checkExplicitStart(cfg: HandConfig, state: HandState) {
  if (state.street !== 'preflop') return
  const posted = Object.fromEntries(
    cfg.seats.map(({ seat, stack }) => [
      seat,
      seat === cfg.bb
        ? Math.min(cfg.blinds.bb, stack)
        : seat === cfg.sb
          ? Math.min(cfg.blinds.sb, stack)
          : 0,
    ]),
  )
  expect(
    Object.fromEntries(state.players.map((p) => [p.seat, p.invested])),
  ).toEqual(posted)
  if (state.players.every((p) => p.stack > 0)) {
    const after = (s: SeatId) => ringDistance(cfg.bb!, s) || 6
    const first = cfg.seats
      .map((s) => s.seat)
      .reduce((a, b) => (after(b) < after(a) ? b : a))
    expect(state.toAct).toBe(first)
  }
}

/** An action that must be rejected in this state, or null if none applies. */
function illegalAction(
  state: HandState,
  random: () => number,
): { seat: SeatId; action: PlayerAction } | null {
  const legal = legalActions(state)
  const seat = state.toAct!
  const others = state.players.filter((p) => p.seat !== seat)
  const candidates: { seat: SeatId; action: PlayerAction }[] = [
    { seat: others[0].seat, action: { type: 'check' } },
    { seat, action: { type: 'raise', to: legal.maxRaiseTo + 1 } },
    { seat, action: { type: 'raise', to: legal.minRaiseTo + 0.5 } },
  ]
  if (!legal.canCheck) candidates.push({ seat, action: { type: 'check' } })
  if (legal.canCheck) candidates.push({ seat, action: { type: 'call' } })
  if (
    legal.canRaise &&
    legal.minRaiseTo - 1 > Math.max(...state.players.map((p) => p.bet))
  )
    candidates.push({
      seat,
      action: { type: 'raise', to: legal.minRaiseTo - 1 },
    })
  if (!legal.canRaise)
    candidates.push({ seat, action: { type: 'raise', to: legal.minRaiseTo } })
  return candidates[Math.floor(random() * candidates.length)] ?? null
}

function checkShowdown(state: HandState) {
  const result = state.result!
  const live = state.players.filter((p) => !p.folded)
  state.pots.forEach((pot, i) => {
    const winners = result.awards.filter((a) => a.pot === i)
    expect(winners.reduce((s, a) => s + a.amount, 0)).toBe(pot.amount)
    for (const a of winners) expect(pot.eligible).toContain(a.seat)
    if (!result.showdown) return
    const scored = pot.eligible.map((seat) => ({
      seat,
      score: reference(
        [...seatOf(state, seat).cards!, ...state.board].map(fromId),
      ),
    }))
    const best = Math.max(...scored.map((s) => s.score))
    expect(winners.map((a) => a.seat).sort()).toEqual(
      scored
        .filter((s) => s.score === best)
        .map((s) => s.seat)
        .sort(),
    )
    // Odd chips: fewer than the winners, on the earliest winners clockwise
    // from the first seat after the button (the award order).
    const amounts = winners.map((a) => a.amount)
    expect(Math.max(...amounts) - Math.min(...amounts)).toBeLessThanOrEqual(1)
    expect([...amounts].sort((a, b) => b - a)).toEqual(amounts)
    const order = winners.map((a) => fromButton(state, a.seat))
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })
  expect(live.length).toBeGreaterThan(0)
}

describe('engine invariants over random hands', () => {
  for (const n of [2, 3, 4, 5, 6])
    it(
      `holds for ${HANDS_PER_N.toLocaleString()} hands at ${n} players`,
      () => {
        const random = lcg(SEED + n)
        let showdowns = 0
        let sidePots = 0
        let deadButtons = 0
        let deadSmallBlinds = 0
        for (let h = 0; h < HANDS_PER_N; h++)
          try {
            const table = randomTable(n, random, h + 1)
            const { deck } = table
            // One hand in ten is a six-casual hand: explicit blind seats,
            // often a dead button or a dead small blind.
            const explicit = h % 10 === 5
            const cfg = explicit
              ? withExplicitBlinds(table.config, random)
              : table.config
            if (!cfg.seats.some((s) => s.seat === cfg.button)) deadButtons++
            if (cfg.sb === null) deadSmallBlinds++
            const chips = cfg.seats.reduce((s, p) => s + p.stack, 0)
            let state = startHand(cfg, deck)
            assertInvariants(state, chips)
            if (explicit) checkExplicitStart(cfg, state)
            const taken: { seat: SeatId; action: PlayerAction }[] = []
            while (!isOver(state)) {
              if (random() < 0.1) {
                const bad = illegalAction(state, random)
                if (bad) {
                  const before = JSON.stringify(state)
                  expect(() => act(state, bad.seat, bad.action)).toThrow(
                    EngineError,
                  )
                  expect(JSON.stringify(state)).toBe(before)
                }
              }
              const seat = state.toAct!
              const action = randomAction(state, random)
              const street = state.street
              state = act(state, seat, action)
              taken.push({ seat, action })
              assertInvariants(state, chips)
              // A new street opens with the first player clockwise from the
              // button seat (even an empty one) who can still bet.
              if (state.street !== street && state.toAct !== null) {
                const open = state.players.filter((p) => !p.folded && !p.allIn)
                const first = open.reduce((a, b) =>
                  fromButton(state, b.seat) < fromButton(state, a.seat) ? b : a,
                )
                expect(state.toAct).toBe(first.seat)
              }
              // The chip-by-chip oracle is slow; sample it.
              if (h % 10 === 0 && state.players.every((p) => p.bet === 0))
                expect(state.pots).toEqual(referencePots(state.players))
              if (taken.length >= 200) throw new Error('Hand did not terminate')
            }
            checkShowdown(state)
            if (state.result!.showdown) showdowns++
            if (state.pots.length > 1) sidePots++
            const replayed = replayHand(cfg, deck, taken)
            expect(JSON.stringify(replayed[replayed.length - 1])).toBe(
              JSON.stringify(state),
            )
          } catch (error) {
            throw atHand(error, n, h)
          }
        // The walk must actually exercise showdowns and side pots.
        expect(showdowns).toBeGreaterThan(HANDS_PER_N / 20)
        if (n > 2) expect(sidePots).toBeGreaterThan(HANDS_PER_N / 100)
        // ...and dead blinds wherever the table can have them: a dead small
        // blind from three players up, a dead button while a seat is empty.
        if (n > 2) expect(deadSmallBlinds).toBeGreaterThan(HANDS_PER_N / 100)
        if (n > 2 && n < 6)
          expect(deadButtons).toBeGreaterThan(HANDS_PER_N / 100)
        // Printed only once every hand and both coverage checks have passed,
        // so the line is the soak's record of the P2-01 gate.
        if (SOAK)
          console.log(
            `${n} players: ${HANDS_PER_N.toLocaleString()} hands passed, ` +
              `showdown ${((100 * showdowns) / HANDS_PER_N).toFixed(1)}%, ` +
              `side pot ${((100 * sidePots) / HANDS_PER_N).toFixed(1)}%`,
          )
      },
      WALK_TIMEOUT,
    )
})

describe('positions', () => {
  it('heads-up: the button posts the small blind and opens pre-flop', () => {
    const state = startHand(
      config([2000, 2000], 1),
      deckWith(config([2000, 2000], 1), {}, ''),
    )
    expect(blindSeats([0, 1], 1)).toEqual({ sb: 1, bb: 0 })
    expect(state.toAct).toBe(1)
    let next = act(state, 1, { type: 'call' })
    expect(next.toAct).toBe(0)
    next = act(next, 0, { type: 'check' })
    expect(next.street).toBe('flop')
    expect(next.toAct).toBe(0)
  })
  it('three or more: blinds follow the button and UTG opens', () => {
    const cfg = {
      ...config([2000, 2000, 2000, 2000]),
      seats: [1, 2, 4, 5].map((seat) => ({ seat, stack: 2000 })),
      button: 5,
    }
    const state = startHand(cfg, deckWith(cfg, {}, ''))
    expect(blindSeats([1, 2, 4, 5], 5)).toEqual({ sb: 1, bb: 2 })
    expect(seatOf(state, 1).bet).toBe(10)
    expect(seatOf(state, 2).bet).toBe(20)
    expect(state.toAct).toBe(4)
    expect(positionNames([1, 2, 4, 5], 5)).toEqual({
      5: 'BTN',
      1: 'SB',
      2: 'BB',
      4: 'UTG',
    })
    expect(seatAfter([1, 2, 4, 5], 5)).toBe(1)
  })
  it('after the flop the first live seat clockwise from the button acts', () => {
    const cfg = config([2000, 2000, 2000], 0)
    let state = startHand(cfg, deckWith(cfg, {}, ''))
    state = act(state, 0, { type: 'call' })
    state = act(state, 1, { type: 'fold' })
    state = act(state, 2, { type: 'check' })
    expect(state.street).toBe('flop')
    expect(state.toAct).toBe(2)
  })
})

describe('crafted cases', () => {
  it('splits a three-way all-in into a main pot and a side pot', () => {
    const cfg = config([100, 300, 1000], 0)
    const deck = deckWith(
      cfg,
      { 0: 'As Ah', 1: 'Ks Kh', 2: 'Qs Qh' },
      '2c 7d 9h Tc 3s',
    )
    let state = startHand(cfg, deck)
    state = act(state, 0, { type: 'raise', to: 100 })
    state = act(state, 1, { type: 'raise', to: 300 })
    state = act(state, 2, { type: 'call' })
    expect(isOver(state)).toBe(true)
    expect(state.pots).toEqual([
      { amount: 300, eligible: [0, 1, 2] },
      { amount: 400, eligible: [1, 2] },
    ])
    expect(state.result!.awards.map((a) => [a.pot, a.seat, a.amount])).toEqual([
      [1, 1, 400],
      [0, 0, 300],
    ])
    expect(stacks(state)).toEqual([300, 400, 700])
    expect(state.result!.netBySeat).toEqual({ 0: 200, 1: 100, 2: -300 })
  })
  it('a short all-in does not reopen the betting for those who acted', () => {
    const cfg = config([2000, 70, 2000], 0)
    let state = startHand(cfg, deckWith(cfg, {}, ''))
    state = act(state, 0, { type: 'raise', to: 60 })
    state = act(state, 1, { type: 'raise', to: 70 })
    expect(legalActions(state).canRaise).toBe(true) // the big blind has not acted
    state = act(state, 2, { type: 'call' })
    const legal = legalActions(state)
    expect(state.toAct).toBe(0)
    expect(legal.toCall).toBe(10)
    expect(legal.canRaise).toBe(false)
    expect(() => act(state, 0, { type: 'raise', to: 200 })).toThrow(EngineError)
  })
  it('a full raise after a short all-in reopens the betting', () => {
    const cfg = config([2000, 70, 2000], 0)
    let state = startHand(cfg, deckWith(cfg, {}, ''))
    state = act(state, 0, { type: 'raise', to: 60 })
    state = act(state, 1, { type: 'raise', to: 70 })
    state = act(state, 2, { type: 'raise', to: 200 })
    expect(state.toAct).toBe(0)
    expect(legalActions(state).canRaise).toBe(true)
    expect(legalActions(state).minRaiseTo).toBe(330)
  })
  it('refunds the uncalled part of a bet when the only caller is short', () => {
    const cfg = config([2000, 300, 2000], 0)
    const deck = deckWith(
      cfg,
      { 0: 'As Ah', 1: 'Ks Kh', 2: '7c 2d' },
      '2c 7d 9h Tc 3s',
    )
    let state = startHand(cfg, deck)
    state = act(state, 0, { type: 'raise', to: 2000 })
    state = act(state, 1, { type: 'call' })
    state = act(state, 2, { type: 'fold' })
    expect(seatOf(state, 0).invested).toBe(300)
    expect(state.pots).toEqual([{ amount: 620, eligible: [0, 1] }])
    expect(stacks(state)).toEqual([2320, 0, 1980])
  })
  it('gives odd chips to the first tied winner clockwise from the button', () => {
    const cfg = config([2000, 2000, 2000], 0, { sb: 5, bb: 10 })
    const deck = deckWith(
      cfg,
      { 0: '2h 3h', 1: '6c 7c', 2: '4d 5d' },
      'As Ks Qs Js Ts',
    )
    let state = startHand(cfg, deck)
    state = act(state, 0, { type: 'call' })
    state = act(state, 1, { type: 'fold' })
    state = act(state, 2, { type: 'check' })
    while (!isOver(state)) state = act(state, state.toAct!, { type: 'check' })
    expect(state.result!.awards.map((a) => [a.seat, a.amount])).toEqual([
      [2, 13],
      [0, 12],
    ])
    expect(stacks(state)).toEqual([2002, 1995, 2003])
  })
  it('posts a blind larger than the stack as an all-in', () => {
    const cfg = config([2000, 15], 0)
    let state = startHand(cfg, deckWith(cfg, {}, ''))
    expect(seatOf(state, 1).allIn).toBe(true)
    const legal = legalActions(state)
    expect(legal.toCall).toBe(5)
    expect(legal.canRaise).toBe(false)
    state = act(state, 0, { type: 'call' })
    expect(isOver(state)).toBe(true)
    expect(state.board).toHaveLength(5)
    expect(stacks(state).reduce((a, b) => a + b)).toBe(2015)
  })
  it('runs out at once when the small blind cannot cover', () => {
    const cfg = config([5, 2000], 0)
    const state = startHand(cfg, deckWith(cfg, {}, ''))
    expect(isOver(state)).toBe(true)
    expect(state.players.map((p) => p.invested)).toEqual([5, 5])
    expect(stacks(state).reduce((a, b) => a + b)).toBe(2005)
  })
  it('splits a six-way pot evenly when everyone plays the board', () => {
    const cfg = config([2000, 2000, 2000, 2000, 2000, 2000], 3)
    const holes = {
      0: '2h 3h',
      1: '2d 3d',
      2: '2c 3c',
      3: '4h 5h',
      4: '4d 5d',
      5: '4c 5c',
    }
    let state = startHand(cfg, deckWith(cfg, holes, 'As Ks Qs Js Ts'))
    while (!isOver(state)) {
      const legal = legalActions(state)
      state = act(
        state,
        state.toAct!,
        legal.canCheck ? { type: 'check' } : { type: 'call' },
      )
    }
    expect(state.result!.showdown).toBe(true)
    expect(Object.values(state.result!.netBySeat)).toEqual([0, 0, 0, 0, 0, 0])
  })
  it('short all-ins that add up to a full raise reopen the betting', () => {
    // Button 0, blinds 1 and 2, UTG 3. Seat 3 raises to 100 (a raise of
    // 80), seat 0 calls, then both blinds go all in short: 140, then 180.
    const reopen = (bbStack: number) => {
      const cfg = config([2000, 140, bbStack, 2000], 0)
      let state = startHand(cfg, deckWith(cfg, {}, ''))
      state = act(state, 3, { type: 'raise', to: 100 })
      state = act(state, 0, { type: 'call' })
      state = act(state, 1, { type: 'raise', to: 140 })
      state = act(state, 2, { type: 'raise', to: bbStack })
      expect(state.toAct).toBe(3)
      return legalActions(state)
    }
    // 180 - 100 = 80: together a full raise, so seat 3 may raise again.
    expect(reopen(180)).toMatchObject({ canRaise: true, minRaiseTo: 260 })
    // 170 - 100 = 70: short of one, so only call or fold.
    expect(reopen(170)).toMatchObject({ canRaise: false, toCall: 70 })
  })
  it('a seat that called the short all-ins is reopened the same way', () => {
    const cfg = config([2000, 140, 180, 2000], 0)
    let state = startHand(cfg, deckWith(cfg, {}, ''))
    state = act(state, 3, { type: 'raise', to: 100 })
    state = act(state, 0, { type: 'call' })
    state = act(state, 1, { type: 'raise', to: 140 })
    state = act(state, 2, { type: 'raise', to: 180 })
    state = act(state, 3, { type: 'call' })
    expect(state.toAct).toBe(0)
    expect(legalActions(state).canRaise).toBe(true)
    // A full raise by seat 0 then reopens seat 3 as usual.
    state = act(state, 0, { type: 'raise', to: 260 })
    expect(state.toAct).toBe(3)
    expect(legalActions(state).canRaise).toBe(true)
  })
  it('builds three pots from all-ins on a later street', () => {
    // Button 0, blinds 1 and 2, UTG 3. Everyone limps, then the flop gets
    // two all-ins of different sizes, a call, and a fold.
    const cfg = config([1000, 200, 500, 1000], 0)
    const deck = deckWith(
      cfg,
      { 0: 'Js Jh', 1: 'As Ah', 2: 'Ks Kh', 3: '7c 2d' },
      '2c 8d 9h 4c 3s',
    )
    let state = startHand(cfg, deck)
    state = act(state, 3, { type: 'call' })
    state = act(state, 0, { type: 'call' })
    state = act(state, 1, { type: 'call' })
    state = act(state, 2, { type: 'check' })
    expect(state.street).toBe('flop')
    expect(state.toAct).toBe(1)
    state = act(state, 1, { type: 'raise', to: 180 })
    expect(seatOf(state, 1).allIn).toBe(true)
    state = act(state, 2, { type: 'raise', to: 480 })
    state = act(state, 3, { type: 'call' })
    state = act(state, 0, { type: 'fold' })
    // Only seat 3 has chips behind: the board runs out with no more action.
    expect(isOver(state)).toBe(true)
    expect(state.board).toHaveLength(5)
    expect(state.pots).toEqual([
      { amount: 620, eligible: [1, 2, 3] },
      { amount: 600, eligible: [2, 3] },
    ])
    expect(stacks(state)).toEqual([980, 620, 600, 500])
    expect(state.result!.netBySeat).toEqual({ 0: -20, 1: 420, 2: 100, 3: -500 })
    assertInvariants(state, 2700)
  })
  it('three-handed: the button folds first and the blinds play on', () => {
    const cfg = config([2000, 2000, 2000], 0)
    let state = startHand(cfg, deckWith(cfg, {}, ''))
    expect(state.toAct).toBe(0) // the button is first to act three-handed
    state = act(state, 0, { type: 'fold' })
    expect(state.toAct).toBe(1)
    state = act(state, 1, { type: 'call' })
    state = act(state, 2, { type: 'check' })
    expect(state.street).toBe('flop')
    // After the flop the small blind leads; the folded button is skipped.
    expect(state.toAct).toBe(1)
    state = act(state, 1, { type: 'check' })
    expect(state.toAct).toBe(2)
  })
  it('three-handed: the big blind wins the blinds when both others fold', () => {
    const cfg = config([2000, 2000, 2000], 0)
    let state = startHand(cfg, deckWith(cfg, {}, ''))
    state = act(state, 0, { type: 'fold' })
    state = act(state, 1, { type: 'fold' })
    expect(isOver(state)).toBe(true)
    expect(state.result!.showdown).toBe(false)
    expect(state.board).toEqual([])
    expect(state.result!.netBySeat).toEqual({ 0: 0, 1: -10, 2: 10 })
  })
  it('three short stacks all in from the blinds', () => {
    // Both blinds are all in posting; the button can only call or fold.
    const cfg = config([5, 8, 15], 0)
    const deck = deckWith(
      cfg,
      { 0: 'As Ah', 1: 'Ks Kh', 2: 'Qs Qh' },
      '2c 7d 9h Tc 3s',
    )
    let state = startHand(cfg, deck)
    expect(seatOf(state, 1).allIn && seatOf(state, 2).allIn).toBe(true)
    expect(state.toAct).toBe(0)
    expect(legalActions(state).canRaise).toBe(false)
    state = act(state, 0, { type: 'call' })
    expect(isOver(state)).toBe(true)
    // The big blind's 7 nobody could match comes back.
    expect(state.players.map((p) => p.invested)).toEqual([5, 8, 8])
    expect(state.pots).toEqual([
      { amount: 15, eligible: [0, 1, 2] },
      { amount: 6, eligible: [1, 2] },
    ])
    expect(stacks(state)).toEqual([15, 6, 7])
    expect(state.result!.netBySeat).toEqual({ 0: 10, 1: -2, 2: -8 })
  })
  it('gives the big blind the option after limps', () => {
    const cfg = config([2000, 2000, 2000], 0)
    let state = startHand(cfg, deckWith(cfg, {}, ''))
    state = act(state, 0, { type: 'call' })
    state = act(state, 1, { type: 'call' })
    expect(state.toAct).toBe(2)
    expect(legalActions(state)).toMatchObject({
      canCheck: true,
      canRaise: true,
      minRaiseTo: 40,
    })
    state = act(state, 2, { type: 'raise', to: 80 })
    expect(state.toAct).toBe(0)
    expect(legalActions(state).canRaise).toBe(true)
  })
  it('rejects bad configs, decks and out-of-turn actions without mutating', () => {
    expect(() =>
      startHand(config([2000]), deckWith(config([2000, 2000]), {}, '')),
    ).toThrow(EngineError)
    expect(() =>
      startHand(config([0, 2000]), deckWith(config([2000, 2000]), {}, '')),
    ).toThrow(EngineError)
    expect(() =>
      startHand(
        config([2000, 2000], 4),
        deckWith(config([2000, 2000]), {}, ''),
      ),
    ).toThrow(EngineError)
    expect(() => startHand(config([2000, 2000]), [1, 2, 3])).toThrow(
      EngineError,
    )
    const cfg = config([2000, 2000])
    const state = startHand(cfg, deckWith(cfg, {}, ''))
    const before = JSON.stringify(state)
    expect(() => act(state, 1, { type: 'check' })).toThrow(EngineError)
    expect(() => act(state, 0, { type: 'raise', to: 39 })).toThrow(EngineError)
    expect(JSON.stringify(state)).toBe(before)
  })
  it('builds pots that match the chip-by-chip reference', () => {
    const players = [
      { invested: 50, folded: false },
      { invested: 200, folded: true },
      { invested: 300, folded: false },
      { invested: 300, folded: false },
      { invested: 120, folded: false },
    ].map((p, seat) => ({
      ...p,
      seat,
      stack: 0,
      bet: 0,
      allIn: false,
      actedSeq: -1,
      actedBet: 0,
      cards: null,
      shown: false,
    }))
    expect(buildPots(players)).toEqual(referencePots(players))
    expect(buildPots(players).map((p) => p.amount)).toEqual([250, 280, 440])
    expect(potTotal({ players } as unknown as HandState)).toBe(970)
  })
  it('6-max: all-ins on three streets with odd-chip splits award in order', () => {
    // Button 3, blinds 4 and 5, UTG 0. Seat 0 is all in pre-flop, seat 3 on
    // the flop and seat 5 on the turn; seats 1 and 4 check the river. The
    // four jacks all make the same Broadway straight and seat 5's nines lose,
    // so every pot splits among the jacks eligible for it. The button sits
    // mid-table so that clockwise order differs from seat order.
    const cfg = config([103, 2000, 2000, 303, 2000, 704], 3)
    const deck = deckWith(
      cfg,
      {
        0: 'Js 2c',
        1: 'Jh 3c',
        2: '7s 8s',
        3: 'Jd 5c',
        4: 'Jc 6d',
        5: '9d 9h',
      },
      'As Kd Qh Tc 4s',
    )
    let state = startHand(cfg, deck)
    state = act(state, 0, { type: 'raise', to: 103 })
    expect(seatOf(state, 0).allIn).toBe(true)
    state = act(state, 1, { type: 'call' })
    state = act(state, 2, { type: 'fold' })
    state = act(state, 3, { type: 'call' })
    state = act(state, 4, { type: 'call' })
    state = act(state, 5, { type: 'call' })
    expect(state.street).toBe('flop')
    state = act(state, 4, { type: 'check' })
    state = act(state, 5, { type: 'check' })
    state = act(state, 1, { type: 'check' })
    state = act(state, 3, { type: 'raise', to: 200 })
    expect(seatOf(state, 3).allIn).toBe(true)
    state = act(state, 4, { type: 'call' })
    state = act(state, 5, { type: 'call' })
    state = act(state, 1, { type: 'call' })
    expect(state.street).toBe('turn')
    state = act(state, 4, { type: 'check' })
    state = act(state, 5, { type: 'raise', to: 401 })
    expect(seatOf(state, 5).allIn).toBe(true)
    state = act(state, 1, { type: 'call' })
    state = act(state, 4, { type: 'call' })
    expect(state.street).toBe('river')
    state = act(state, 4, { type: 'check' })
    state = act(state, 1, { type: 'check' })
    expect(isOver(state)).toBe(true)
    expect(state.result!.showdown).toBe(true)
    // 103 from five seats; 200 more from four; 401 more from three.
    expect(state.pots).toEqual([
      { amount: 515, eligible: [0, 1, 3, 4, 5] },
      { amount: 800, eligible: [1, 3, 4, 5] },
      { amount: 1203, eligible: [1, 4, 5] },
    ])
    expect(state.pots).toEqual(referencePots(state.players))
    // Last side pot first. Within a pot the winners are paid clockwise from
    // the seat after the button (4, 5, 0, 1, 2, 3), and the odd chips go to
    // the earliest: 1203 = 2 × 601 + 1, 800 = 3 × 266 + 2, 515 = 4 × 128 + 3.
    expect(state.result!.awards.map((a) => [a.pot, a.seat, a.amount])).toEqual([
      [2, 4, 602],
      [2, 1, 601],
      [1, 4, 267],
      [1, 1, 267],
      [1, 3, 266],
      [0, 4, 129],
      [0, 0, 129],
      [0, 1, 129],
      [0, 3, 128],
    ])
    expect(stacks(state)).toEqual([129, 2293, 2000, 394, 2294, 0])
    expect(state.result!.netBySeat).toEqual({
      0: 26,
      1: 293,
      2: 0,
      3: 91,
      4: 294,
      5: -704,
    })
    assertInvariants(state, 7110)
  })
  it('folded dead money stays in the pot it entered', () => {
    // Button 5, blinds 0 and 1, UTG 2 all in for 75. Three seats fold after
    // putting chips in: the small blind pre-flop (10), the big blind on the
    // flop (250) and the button on the river (700). Folded chips fill each
    // pot up to the folder's own investment, so the short stack wins 75
    // from every seat that paid that much, folders included.
    const cfg = config([2000, 2000, 75, 2000, 400, 2000], 5)
    const deck = deckWith(
      cfg,
      { 2: 'As Ah', 3: 'Qs Qh', 4: 'Ks Kh' },
      '2c 7d 9h Tc 3s',
    )
    let state = startHand(cfg, deck)
    state = act(state, 2, { type: 'raise', to: 75 })
    state = act(state, 3, { type: 'call' })
    state = act(state, 4, { type: 'call' })
    state = act(state, 5, { type: 'raise', to: 250 })
    state = act(state, 0, { type: 'fold' })
    state = act(state, 1, { type: 'call' })
    state = act(state, 3, { type: 'call' })
    state = act(state, 4, { type: 'call' })
    // 75 from five seats plus the folded small blind's 10; 175 from four.
    expect(state.pots).toEqual([
      { amount: 385, eligible: [1, 2, 3, 4, 5] },
      { amount: 700, eligible: [1, 3, 4, 5] },
    ])
    state = act(state, 1, { type: 'check' })
    state = act(state, 3, { type: 'check' })
    state = act(state, 4, { type: 'raise', to: 150 })
    state = act(state, 5, { type: 'call' })
    state = act(state, 1, { type: 'fold' })
    // A fold mid-street loses eligibility, never chips.
    expect(state.pots).toEqual([
      { amount: 385, eligible: [2, 3, 4, 5] },
      { amount: 700, eligible: [3, 4, 5] },
    ])
    state = act(state, 3, { type: 'call' })
    // The big blind's 175 above the main pot stays in the next one: the
    // 250 level is gone, so that pot now runs up to seat 4's 400.
    expect(state.pots).toEqual([
      { amount: 385, eligible: [2, 3, 4, 5] },
      { amount: 1150, eligible: [3, 4, 5] },
    ])
    state = act(state, 3, { type: 'raise', to: 300 })
    state = act(state, 5, { type: 'call' })
    state = act(state, 3, { type: 'raise', to: 500 })
    state = act(state, 5, { type: 'fold' })
    expect(isOver(state)).toBe(true)
    expect(state.result!.showdown).toBe(true)
    // The button's 700 is split 75 / 325 / 300 across the three pots.
    expect(state.pots).toEqual([
      { amount: 385, eligible: [2, 3, 4] },
      { amount: 1150, eligible: [3, 4] },
      { amount: 600, eligible: [3] },
    ])
    expect(state.pots).toEqual(referencePots(state.players))
    expect(state.result!.awards.map((a) => [a.pot, a.seat, a.amount])).toEqual([
      [2, 3, 600],
      [1, 4, 1150],
      [0, 2, 385],
    ])
    expect(stacks(state)).toEqual([1990, 1750, 385, 1900, 1150, 1300])
    expect(state.result!.netBySeat).toEqual({
      0: -10,
      1: -250,
      2: 310,
      3: -100,
      4: 750,
      5: -700,
    })
    assertInvariants(state, 8475)
  })
  it('a short stack all-in below the big blind', () => {
    // Button 0, blinds 1 and 2, UTG 3 with 13 chips. Calling all in for less
    // than the big blind is not a raise: the bet to match stays 20, the
    // minimum raise stays 40 and the big blind keeps its option.
    const cfg = config([2000, 2000, 2000, 13, 2000, 2000], 0)
    const deck = deckWith(
      cfg,
      { 0: 'Ks Kh', 2: 'Jd 4c', 3: 'As Ah', 4: 'Qs Qh' },
      '2c 7d 9h Tc 3s',
    )
    let state = startHand(cfg, deck)
    expect(legalActions(state)).toMatchObject({
      seat: 3,
      toCall: 13,
      canRaise: false,
    })
    state = act(state, 3, { type: 'call' })
    expect(seatOf(state, 3).allIn).toBe(true)
    expect(legalActions(state)).toMatchObject({
      seat: 4,
      toCall: 20,
      minRaiseTo: 40,
    })
    state = act(state, 4, { type: 'call' })
    state = act(state, 5, { type: 'fold' })
    state = act(state, 0, { type: 'call' })
    state = act(state, 1, { type: 'fold' })
    expect(legalActions(state)).toMatchObject({
      seat: 2,
      canCheck: true,
      canRaise: true,
      minRaiseTo: 40,
    })
    state = act(state, 2, { type: 'check' })
    // 13 from four seats plus the folded small blind's 10; 7 from three.
    expect(state.pots).toEqual([
      { amount: 62, eligible: [0, 2, 3, 4] },
      { amount: 21, eligible: [0, 2, 4] },
    ])
    state = act(state, 2, { type: 'check' })
    state = act(state, 4, { type: 'raise', to: 40 })
    state = act(state, 0, { type: 'call' })
    state = act(state, 2, { type: 'fold' })
    while (!isOver(state)) state = act(state, state.toAct!, { type: 'check' })
    // The big blind's fold leaves its 13 in the main pot and 7 in the side.
    expect(state.pots).toEqual([
      { amount: 62, eligible: [0, 3, 4] },
      { amount: 101, eligible: [0, 4] },
    ])
    expect(state.pots).toEqual(referencePots(state.players))
    // The aces win only the main pot; the kings take the side pot.
    expect(state.result!.awards.map((a) => [a.pot, a.seat, a.amount])).toEqual([
      [1, 0, 101],
      [0, 3, 62],
    ])
    expect(stacks(state)).toEqual([2041, 1990, 1980, 62, 1940, 2000])
    expect(state.result!.netBySeat).toEqual({
      0: 41,
      1: -10,
      2: -20,
      3: 49,
      4: -60,
      5: 0,
    })
    assertInvariants(state, 10013)
    // Folded round to the big blind: facing only a short all-in it has
    // nothing to decide (a raise could never be called), so the board runs
    // out at once and its 7 above the short stack comes back.
    let alone = startHand(cfg, deck)
    alone = act(alone, 3, { type: 'call' })
    for (const seat of [4, 5, 0, 1]) alone = act(alone, seat, { type: 'fold' })
    expect(isOver(alone)).toBe(true)
    expect(alone.board).toHaveLength(5)
    expect(alone.players.map((p) => p.invested)).toEqual([0, 10, 13, 13, 0, 0])
    expect(alone.pots).toEqual([{ amount: 36, eligible: [2, 3] }])
    expect(alone.pots).toEqual(referencePots(alone.players))
    expect(alone.result!.netBySeat).toEqual({
      0: 0,
      1: -10,
      2: -13,
      3: 23,
      4: 0,
      5: 0,
    })
    assertInvariants(alone, 10013)
  })
  it('calling all in for less than the bet does not reopen the betting', () => {
    // Button 0 with 35 chips, blinds in seats 1 and 2. UTG 3 calls 20, seat 4 calls
    // all in for 13 and the button raises all in to 35: 15 more, short of a
    // full raise. Neither all-in reopens the betting, so UTG, who has acted,
    // may only call or fold; the big blind has not acted yet and may raise.
    const cfg = config([35, 2000, 2000, 2000, 13, 2000], 0)
    const deck = deckWith(
      cfg,
      { 0: 'Ks Kh', 2: 'Jd 4c', 3: '8c 5d', 4: 'As Ah' },
      '2c 7d 9h Tc 3s',
    )
    let state = startHand(cfg, deck)
    state = act(state, 3, { type: 'call' })
    state = act(state, 4, { type: 'call' })
    expect(seatOf(state, 4).allIn).toBe(true)
    state = act(state, 5, { type: 'fold' })
    expect(legalActions(state)).toMatchObject({
      seat: 0,
      toCall: 20,
      canRaise: true,
      minRaiseTo: 35,
      maxRaiseTo: 35,
    })
    state = act(state, 0, { type: 'raise', to: 35 })
    expect(seatOf(state, 0).allIn).toBe(true)
    state = act(state, 1, { type: 'fold' })
    expect(legalActions(state)).toMatchObject({
      seat: 2,
      toCall: 15,
      canRaise: true,
      minRaiseTo: 55,
    })
    state = act(state, 2, { type: 'call' })
    expect(legalActions(state)).toMatchObject({
      seat: 3,
      toCall: 15,
      canRaise: false,
    })
    expect(() => act(state, 3, { type: 'raise', to: 55 })).toThrow(EngineError)
    state = act(state, 3, { type: 'call' })
    expect(state.street).toBe('flop')
    // 13 from four seats plus the folded small blind's 10; 22 from three.
    expect(state.pots).toEqual([
      { amount: 62, eligible: [0, 2, 3, 4] },
      { amount: 66, eligible: [0, 2, 3] },
    ])
    while (!isOver(state)) state = act(state, state.toAct!, { type: 'check' })
    expect(state.pots).toEqual(referencePots(state.players))
    // The aces win the main pot; the kings take the side pot.
    expect(state.result!.awards.map((a) => [a.pot, a.seat, a.amount])).toEqual([
      [1, 0, 66],
      [0, 4, 62],
    ])
    expect(stacks(state)).toEqual([66, 1990, 1965, 1965, 62, 2000])
    expect(state.result!.netBySeat).toEqual({
      0: 31,
      1: -10,
      2: -35,
      3: -35,
      4: 49,
      5: 0,
    })
    assertInvariants(state, 8048)
  })
})

describe('a short big blind is still the bring-in (audit F01)', () => {
  /** Chips on the table: stacks, plus what is in the middle until it is won. */
  const total = (state: HandState) =>
    state.players.reduce(
      (sum, p) => sum + p.stack + (isOver(state) ? 0 : p.invested),
      0,
    )

  it('the next player calls the full big blind and raises from it', () => {
    // 10/20; button and small blind deep, the big blind posts 15 all in.
    const cfg = config([1000, 1000, 15], 0)
    let state = startHand(cfg, deckWith(cfg, {}, ''))
    expect(state.players.map((p) => p.bet)).toEqual([0, 10, 15])
    expect(state.toAct).toBe(0)
    expect(legalActions(state)).toMatchObject({
      toCall: 20,
      canRaise: true,
      minRaiseTo: 40,
      maxRaiseTo: 1000,
    })
    expect(() => act(state, 0, { type: 'raise', to: 35 })).toThrow(EngineError)
    state = act(state, 0, { type: 'call' })
    expect(legalActions(state)).toMatchObject({ toCall: 10, minRaiseTo: 40 })
    state = act(state, 1, { type: 'call' })
    // The round closed: the short blind's 15 is matched three ways, the
    // rest is a side pot it cannot win. No chip appears from nowhere.
    expect(state.street).toBe('flop')
    expect(state.players.map((p) => p.invested)).toEqual([20, 20, 15])
    expect(state.pots).toEqual([
      { amount: 45, eligible: [0, 1, 2] },
      { amount: 10, eligible: [0, 1] },
    ])
    expect(total(state)).toBe(2015)
  })

  it('with only the short big blind left to face, it is called for what it posted', () => {
    const cfg = config([1000, 1000, 15], 0)
    let state = startHand(cfg, deckWith(cfg, {}, ''))
    state = act(state, 0, { type: 'fold' })
    expect(legalActions(state)).toMatchObject({ toCall: 5, canRaise: false })
    state = act(state, 1, { type: 'call' })
    expect(isOver(state)).toBe(true)
    expect(state.players.map((p) => p.invested)).toEqual([0, 15, 15])
  })

  it('an uncalled excess over the short big blind comes back', () => {
    const cfg = config([1000, 1000, 15], 0)
    let state = startHand(cfg, deckWith(cfg, {}, ''))
    state = act(state, 0, { type: 'call' })
    state = act(state, 1, { type: 'fold' })
    expect(isOver(state)).toBe(true)
    // The button's 20 against the blind's 15: 5 come back.
    expect(state.players.map((p) => p.invested)).toEqual([15, 10, 15])
    expect(total(state)).toBe(2015)
  })

  it('a big blind shorter than the small blind still brings it in at 20', () => {
    const cfg = config([1000, 1000, 8], 0)
    let state = startHand(cfg, deckWith(cfg, {}, ''))
    expect(state.players.map((p) => p.bet)).toEqual([0, 10, 8])
    expect(legalActions(state)).toMatchObject({ toCall: 20, minRaiseTo: 40 })
    state = act(state, 0, { type: 'call' })
    expect(legalActions(state)).toMatchObject({ toCall: 10 })
  })

  it('a short all-in above the short blind is not a full raise', () => {
    // Button 0, blinds 1 and 2 (the big blind 15 all in), then 3 and 4.
    const cfg = config([1000, 1000, 15, 1000, 35], 0)
    let state = startHand(cfg, deckWith(cfg, {}, ''))
    expect(state.toAct).toBe(3)
    state = act(state, 3, { type: 'call' })
    expect(state.players[3].invested).toBe(20)
    // All in to 35 is 15 more than the 20 bring-in: short of a full raise.
    expect(legalActions(state)).toMatchObject({
      minRaiseTo: 35,
      maxRaiseTo: 35,
    })
    state = act(state, 4, { type: 'raise', to: 35 })
    state = act(state, 0, { type: 'call' })
    state = act(state, 1, { type: 'call' })
    // The limper may call the 15 more but not raise: nothing reopened.
    expect(state.toAct).toBe(3)
    expect(legalActions(state)).toMatchObject({ toCall: 15, canRaise: false })
    expect(total(state)).toBe(3050)
  })

  it('heads-up keeps calling a short big blind for what it posted', () => {
    const cfg = config([2000, 15], 0)
    const state = startHand(cfg, deckWith(cfg, {}, ''))
    expect(legalActions(state)).toMatchObject({ toCall: 5, canRaise: false })
  })

  it('every random hand with short stacks keeps its chips', () => {
    const random = lcg(SEED + 17)
    for (let n = 0; n < 2000; n++) {
      const seats = 3 + Math.floor(random() * 4)
      const stacks = Array.from({ length: seats }, () =>
        random() < 0.4 ? 1 + Math.floor(random() * 40) : 1000,
      )
      const cfg = config(stacks, Math.floor(random() * seats))
      const chips = stacks.reduce((a, b) => a + b, 0)
      let state = startHand(cfg, deckWith(cfg, {}, ''))
      assertInvariants(state, chips)
      while (!isOver(state)) {
        state = act(state, state.toAct!, randomAction(state, random))
        assertInvariants(state, chips)
      }
    }
  })
})
