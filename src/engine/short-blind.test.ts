// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { lcg } from '../lib/sim'
import { act, assertInvariants, isOver, legalActions, startHand } from './hand'
import { referencePots } from './pots'
import {
  config,
  deckWith,
  randomAction,
  seededDeck,
  withExplicitBlinds,
} from './testing'
import type { HandState, PlayerAction } from './types'

function step(state: HandState, action: PlayerAction) {
  const next = act(state, state.toAct!, action)
  assertInvariants(
    next,
    state.config.seats.reduce((sum, p) => sum + p.stack, 0),
  )
  return next
}

function finish(state: HandState) {
  while (!isOver(state))
    state = step(state, {
      type: legalActions(state).canCheck ? 'check' : 'call',
    })
  expect(state.pots).toEqual(referencePots(state.players))
  return state
}

describe('F01 nominal short-blind bring-in', () => {
  it('F01_nominal_bb_1000_1000_15', () => {
    const cfg = config([1000, 1000, 15], 0)
    let state = startHand(cfg, deckWith(cfg, {}, ''))
    expect(state.players.map((p) => p.bet)).toEqual([0, 10, 15])
    expect(legalActions(state)).toMatchObject({
      toCall: 20,
      minRaiseTo: 40,
      canRaise: true,
    })
    expect(() => step(state, { type: 'raise', to: 35 })).toThrow(
      'Illegal raise size',
    )
    state = step(state, { type: 'call' })
    expect(legalActions(state)).toMatchObject({ toCall: 10, minRaiseTo: 40 })
    state = step(state, { type: 'call' })
    expect(state.street).toBe('flop')
    expect(state.players.map((p) => p.invested)).toEqual([20, 20, 15])
    expect(state.pots).toEqual([
      { amount: 45, eligible: [0, 1, 2] },
      { amount: 10, eligible: [0, 1] },
    ])
    finish(state)
  })

  it.each([3, 4, 5, 6])(
    'F01 keeps the nominal bring-in with %i players and BB below SB',
    (n) => {
      const cfg = config(
        Array.from({ length: n }, (_, seat) => (seat === 2 ? 5 : 1000)),
        0,
      )
      let state = startHand(cfg, deckWith(cfg, {}, ''))
      expect(legalActions(state)).toMatchObject({ toCall: 20, minRaiseTo: 40 })
      while (state.street === 'preflop') state = step(state, { type: 'call' })
      expect(state.players.map((p) => p.invested)).toEqual(
        cfg.seats.map((p) => (p.seat === 2 ? 5 : 20)),
      )
      expect(state.pots).toEqual([
        { amount: n * 5, eligible: cfg.seats.map((p) => p.seat) },
        {
          amount: (n - 1) * 15,
          eligible: cfg.seats.filter((p) => p.seat !== 2).map((p) => p.seat),
        },
      ])
      finish(state)
    },
  )

  it('F01 both blinds short still leave a full bring-in for two deep players', () => {
    const cfg = config([1000, 8, 15, 1000], 0)
    let state = startHand(cfg, deckWith(cfg, {}, ''))
    expect(legalActions(state)).toMatchObject({ toCall: 20, minRaiseTo: 40 })
    state = step(state, { type: 'call' })
    state = step(state, { type: 'call' })
    expect(state.pots).toEqual([
      { amount: 32, eligible: [0, 1, 2, 3] },
      { amount: 21, eligible: [0, 2, 3] },
      { amount: 10, eligible: [0, 3] },
    ])
    finish(state)
  })

  it('F01 refunds nominal excess when the other deep player folds', () => {
    const cfg = config([1000, 1000, 15], 0)
    let state = startHand(cfg, deckWith(cfg, {}, ''))
    state = step(state, { type: 'call' })
    state = step(state, { type: 'fold' })
    expect(isOver(state)).toBe(true)
    expect(state.players.map((p) => p.invested)).toEqual([15, 10, 15])
    expect(state.pots).toEqual([{ amount: 40, eligible: [0, 2] }])
  })

  it('F01 does not demand a nominal blind from the only player still able to bet', () => {
    const cfg = config([1000, 8, 15], 0)
    let state = startHand(cfg, deckWith(cfg, {}, ''))
    expect(legalActions(state)).toMatchObject({ toCall: 15, canRaise: false })
    state = step(state, { type: 'call' })
    expect(isOver(state)).toBe(true)
    expect(state.players.map((p) => p.invested)).toEqual([15, 8, 15])
  })

  it.each([
    [1000, 15],
    [1000, 5],
    [5, 1000],
    [8, 15],
    [15, 8],
  ])(
    'F01 short HU blinds preserve real capped contributions (%i/%i)',
    (sb, bb) => {
      const cfg = config([sb, bb], 0)
      let state = startHand(cfg, deckWith(cfg, {}, ''))
      if (!isOver(state)) {
        expect(legalActions(state)).toMatchObject({
          toCall: 5,
          canRaise: false,
        })
        state = step(state, { type: 'call' })
      }
      assertInvariants(state, sb + bb)
      expect(state.players.map((p) => p.invested)).toEqual([
        Math.min(sb, bb),
        Math.min(sb, bb),
      ])
    },
  )

  it('F01 short all-in after a nominal call does not reopen, but a full raise does', () => {
    const cfg = config([30, 1000, 15, 1000], 0)
    let state = startHand(cfg, deckWith(cfg, {}, ''))
    state = step(state, { type: 'call' }) // seat 3: 20
    expect(legalActions(state)).toMatchObject({
      minRaiseTo: 30,
      maxRaiseTo: 30,
    })
    state = step(state, { type: 'raise', to: 30 }) // short increment 10
    expect(state.lastRaise).toBe(20)
    expect(state.raiseSeq).toBe(0)
    const called = step(state, { type: 'call' })
    expect(legalActions(called)).toMatchObject({ toCall: 10, canRaise: false })
    finish(called)
    const raised = step(state, { type: 'raise', to: 50 })
    expect(legalActions(raised)).toMatchObject({
      toCall: 30,
      canRaise: true,
      minRaiseTo: 70,
    })
    finish(raised)
  })

  it('F01 handles a dead small blind and empty button without manufacturing chips', () => {
    const cfg = {
      ...config([1000, 1000, 5], 0),
      seats: [
        { seat: 0, stack: 1000 },
        { seat: 3, stack: 5 },
        { seat: 5, stack: 1000 },
      ],
      button: 1,
      sb: null,
      bb: 3,
    }
    let state = startHand(cfg, deckWith(cfg, {}, ''))
    expect(state.toAct).toBe(5)
    expect(legalActions(state)).toMatchObject({ toCall: 20, minRaiseTo: 40 })
    state = step(state, { type: 'call' })
    state = step(state, { type: 'call' })
    expect(state.pots).toEqual([
      { amount: 15, eligible: [0, 3, 5] },
      { amount: 30, eligible: [0, 5] },
    ])
    finish(state)
  })

  it('F01 side-pot ties give the odd main-pot chip clockwise from the button', () => {
    const cfg = config([1000, 1000, 5], 0)
    const state = finish(
      startHand(
        cfg,
        deckWith(cfg, { 0: 'As Kh', 1: 'Ah Ks', 2: '2c 3c' }, 'Qd Jd Tc 7s 8s'),
      ),
    )
    expect(
      state.result!.awards.map(({ pot, seat, amount }) => ({
        pot,
        seat,
        amount,
      })),
    ).toEqual([
      { pot: 1, seat: 1, amount: 15 },
      { pot: 1, seat: 0, amount: 15 },
      { pot: 0, seat: 1, amount: 8 },
      { pot: 0, seat: 0, amount: 7 },
    ])
  })

  it('F01 seeded short-stack walks conserve chips after every action across 2–6 players', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const random = lcg(seed)
      const n = 2 + (seed % 5)
      const cfg = withExplicitBlinds(
        config(
          Array.from({ length: n }, () => 1 + Math.floor(random() * 60)),
          0,
        ),
        random,
      )
      let state = startHand(cfg, seededDeck(seed))
      assertInvariants(
        state,
        cfg.seats.reduce((sum, p) => sum + p.stack, 0),
      )
      let actions = 0
      while (!isOver(state)) {
        expect(++actions, `seed ${seed}`).toBeLessThan(100)
        state = step(state, randomAction(state, random))
      }
      expect(state.pots, `seed ${seed}`).toEqual(referencePots(state.players))
    }
  })
})
