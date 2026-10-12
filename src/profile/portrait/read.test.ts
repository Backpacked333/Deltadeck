import { describe, expect, it } from 'vitest'
import type { Act, PlayedHand } from './hands'
import { ARCHETYPES, archetypeOf, confidenceOf, portraitOf } from './read'
import { afterLosses, breakdown, rate, statsOf } from './stats'

const act = (
  street: Act['street'],
  action: Act['action'],
  extra: Partial<Act> = {},
): Act => ({
  street,
  action,
  facing: 0,
  pot: 1.5,
  size: 0,
  ...extra,
})

let id = 0
const hand = (extra: Partial<PlayedHand> = {}): PlayedHand => ({
  id: `h${++id}`,
  at: id,
  format: 'six-max',
  kind: 'six-casual',
  players: 6,
  position: 'CO',
  acts: [act('preflop', 'fold', { facing: 1 })],
  opponents: ['bob'],
  vpip: false,
  pfr: false,
  threeBetChance: false,
  threeBet: false,
  foldTo3betChance: false,
  foldTo3bet: false,
  sawFlop: false,
  cbetChance: false,
  cbet: false,
  facedCbet: false,
  foldedToCbet: false,
  showdown: false,
  wonShowdown: false,
  net: 0,
  ...extra,
})

/** A raise pre-flop and a bet on the flop that takes the pot. */
const raiseAndBet = (extra: Partial<PlayedHand> = {}) =>
  hand({
    acts: [
      act('preflop', 'raise', { facing: 1, size: 3 }),
      act('flop', 'raise', { pot: 7, size: 4 }),
    ],
    vpip: true,
    pfr: true,
    sawFlop: true,
    cbetChance: true,
    cbet: true,
    net: 3,
    ...extra,
  })

describe('stats', () => {
  it('counts rates over their chances', () => {
    const s = statsOf([raiseAndBet(), hand(), hand(), hand()])
    expect(s.hands).toBe(4)
    expect(s.vpip).toEqual({ n: 1, of: 4 })
    expect(s.pfr).toEqual({ n: 1, of: 4 })
    expect(s.cbet).toEqual({ n: 1, of: 1 })
    expect(s.afq).toEqual({ n: 1, of: 1 })
    expect(s.bbPer100).toBe(75)
    expect(rate({ n: 0, of: 0 })).toBeNull()
  })

  it('folds to big bets, times decisions and grades', () => {
    const s = statsOf([
      hand({
        acts: [
          act('flop', 'fold', { facing: 8, pot: 18, ms: 9000 }),
          act('turn', 'call', {
            facing: 1,
            pot: 11,
            ms: 1000,
            accuracy: 80,
            evLost: 1,
            grade: 'Good',
          }),
          act('river', 'raise', {
            equity: 0.1,
            ms: 3000,
            accuracy: 40,
            evLost: 5,
            grade: 'Mistake',
          }),
        ],
      }),
    ])
    expect(s.foldToBig).toEqual({ n: 1, of: 1 })
    expect(s.facing).toEqual({ fold: 1, call: 1, raise: 0 })
    expect(s.riverBluffs).toEqual({ n: 1, of: 1 })
    expect(s.accuracy).toBe(60)
    expect(s.evLost).toBe(6)
    expect(s.grades.Mistake).toBe(1)
    expect(s.decisionMs).toBe(3000)
    expect(s.bigDecisionMs).toBe(6000)
  })

  it('finds the hands right after a big loss, format by format', () => {
    const hands = [
      hand({ net: -30 }),
      raiseAndBet(),
      raiseAndBet({ format: 'practice' }),
      ...Array.from({ length: 6 }, () => hand()),
    ]
    const t = afterLosses(hands)
    expect(t.losses).toBe(1)
    // The practice hand is not "after" a six-max loss.
    expect(t.after.hands).toBe(5)
    expect(t.after.vpip.n).toBe(1)
  })
})

describe('the read', () => {
  it('names a style from the two axes', () => {
    expect(archetypeOf(30, 70)).toBe(ARCHETYPES.tag)
    expect(archetypeOf(70, 70)).toBe(ARCHETYPES.lag)
    expect(archetypeOf(90, 90)).toBe(ARCHETYPES.maniac)
    expect(archetypeOf(70, 20)).toBe(ARCHETYPES.station)
    expect(archetypeOf(30, 30)).toBe(ARCHETYPES.rock)
    expect(archetypeOf(10, 30)).toBe(ARCHETYPES.nit)
    expect(archetypeOf(52, 47)).toBe(ARCHETYPES.balanced)
  })

  it('waits for enough hands', () => {
    expect(confidenceOf(29)).toBe('none')
    expect(confidenceOf(30)).toBe('early')
    expect(confidenceOf(500)).toBe('settling')
    expect(confidenceOf(5000)).toBe('solid')
    const p = portraitOf(breakdown([raiseAndBet()]))
    expect(p.archetype).toBeNull()
    expect(p.headline).toMatch(/Play 29 more/)
  })

  it('reads a six-max player who plays few hands and raises them', () => {
    // 20% VPIP, every one a raise and a flop bet: tight-aggressive.
    const hands = Array.from({ length: 100 }, (_, i) =>
      i % 5 === 0 ? raiseAndBet() : hand(),
    )
    const p = portraitOf(breakdown(hands))
    expect(p.archetype).toBe(ARCHETYPES.tag)
    expect(p.confidence).toBe('early')
    expect(p.summary[0]).toMatch(/100 hands at six-max tables/)
    expect(p.summary[1]).toMatch(/20% of hands at six-max tables/)
    expect(p.traits.map((t) => t.key)).toEqual(
      expect.arrayContaining(['loose', 'aggro']),
    )
    expect(p.dynamics.join(' ')).toMatch(/most-played opponent is bob/)
  })

  it('reads heads-up looseness in its own band', () => {
    // 60% VPIP is middle-of-the-road heads-up, and loose six-handed.
    const mk = (format: PlayedHand['format']) =>
      Array.from({ length: 100 }, (_, i) =>
        i % 5 < 3 ? raiseAndBet({ format }) : hand({ format }),
      )
    expect(portraitOf(breakdown(mk('heads-up'))).loose).toBeCloseTo(50)
    expect(portraitOf(breakdown(mk('six-max'))).loose).toBe(100)
  })

  it('names the costliest spots and the trend', () => {
    const leaky = (i: number) =>
      hand({
        at: i,
        acts: [
          act('river', 'call', {
            facing: 5,
            pot: 15,
            accuracy: i < 48 ? 40 : 80,
            evLost: 2,
          }),
        ],
        vpip: true,
      })
    const p = portraitOf(
      breakdown(Array.from({ length: 96 }, (_, i) => leaky(i))),
    )
    expect(p.leaks[0]).toMatch(/Calling on the river has cost you 192 bb/)
    expect(p.trajectory[0]).toMatch(/risen from 40 to 80/)
  })
})
