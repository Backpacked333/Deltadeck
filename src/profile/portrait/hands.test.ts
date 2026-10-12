import { describe, expect, it } from 'vitest'
import type { DecisionRecord, HandRecord } from '../../lib/storage'
import type { HandRecordV1 } from '../../shared/protocol'
import { fromOnline, fromPractice, holeClass, holeGroup } from './hands'

const d = (
  street: DecisionRecord['street'],
  action: DecisionRecord['action'],
  toCall: number,
  pot: number,
  extra: Partial<DecisionRecord> = {},
): DecisionRecord => ({
  street,
  action,
  amount: action === 'call' ? toCall : action === 'raise' ? 60 : 0,
  pot,
  toCall,
  grade: 'Best',
  evLost: 0,
  accuracy: 100,
  chosenEV: 0,
  bestEV: 0,
  bestLabel: '',
  equity: 0.5,
  handClass: 'Pair',
  ...extra,
})

const practice = (
  decisions: DecisionRecord[],
  extra: Partial<HandRecord> = {},
): HandRecord => ({
  id: 's:1',
  hand: 1,
  net: 40,
  result: 'You won',
  guided: false,
  at: 1000,
  hero: ['A♠', 'K♠'],
  board: ['2♣', '7♦', 'J♥'],
  decisions,
  ...extra,
})

describe('starting hands', () => {
  it('names a hand high card first, with suitedness', () => {
    expect(holeClass({ rank: 13, suit: 's' }, { rank: 14, suit: 's' })).toBe(
      'AKs',
    )
    expect(holeClass({ rank: 9, suit: 'h' }, { rank: 10, suit: 'c' })).toBe(
      'T9o',
    )
    expect(holeClass({ rank: 7, suit: 'h' }, { rank: 7, suit: 'c' })).toBe('77')
  })
  it('groups them', () => {
    expect(holeGroup('AA')).toBe('premium')
    expect(holeGroup('AKo')).toBe('premium')
    expect(holeGroup('AQo')).toBe('strong')
    expect(holeGroup('KQo')).toBe('strong')
    expect(holeGroup('55')).toBe('speculative')
    expect(holeGroup('87s')).toBe('speculative')
    expect(holeGroup('A4s')).toBe('speculative')
    expect(holeGroup('72o')).toBe('weak')
    expect(holeGroup('J4s')).toBe('weak')
  })
})

describe('practice hands', () => {
  it('skips guided hands', () => {
    expect(fromPractice(practice([], { guided: true }))).toBeNull()
  })

  it('reads the button raising, then continuation-betting', () => {
    const h = fromPractice(
      practice([d('preflop', 'raise', 10, 30), d('flop', 'raise', 0, 120)]),
    )!
    expect(h).toMatchObject({
      format: 'practice',
      position: 'BTN',
      hole: 'AKs',
      holeGroup: 'premium',
      vpip: true,
      pfr: true,
      threeBetChance: false,
      sawFlop: true,
      cbetChance: true,
      cbet: true,
      facedCbet: false,
      net: 2,
      opponents: ['Atlas (balanced)'],
    })
    expect(h.acts[0]).toMatchObject({ facing: 0.5, pot: 1.5, size: 3 })
  })

  it("reads the big blind 3-betting Atlas's raise, then folding to a 4-bet", () => {
    const h = fromPractice(
      practice(
        [d('preflop', 'raise', 40, 80), d('preflop', 'fold', 120, 300)],
        {
          net: -60,
        },
      ),
    )!
    expect(h).toMatchObject({
      position: 'BB',
      vpip: true,
      pfr: true,
      threeBetChance: true,
      threeBet: true,
      foldTo3betChance: true,
      foldTo3bet: true,
      sawFlop: false,
      net: -3,
    })
  })

  it("reads folding to Atlas's continuation bet", () => {
    const h = fromPractice(
      practice(
        [
          d('preflop', 'call', 40, 80),
          d('flop', 'check', 0, 120),
          d('flop', 'fold', 80, 200),
        ],
        { net: -60, showdown: false },
      ),
    )!
    expect(h).toMatchObject({
      vpip: true,
      pfr: false,
      threeBetChance: true,
      threeBet: false,
      cbetChance: false,
      facedCbet: true,
      foldedToCbet: true,
      showdown: false,
    })
  })

  it('counts a big blind check as not putting money in', () => {
    const h = fromPractice(
      practice([d('preflop', 'check', 0, 40)], { showdown: true, net: 20 }),
    )!
    expect(h).toMatchObject({
      position: 'BB',
      vpip: false,
      pfr: false,
      showdown: true,
      wonShowdown: true,
    })
  })
})

// A six-handed hand: seats 0–5, button 0, blinds 1 and 2, 10/20.
const six = (
  actions: [number, string, number, number, number?][],
  extra: Partial<HandRecordV1> = {},
): HandRecordV1 => ({
  v: 1,
  matchId: 'm1',
  handNo: 4,
  segment: 1,
  config: {
    handNo: 4,
    seats: [0, 1, 2, 3, 4, 5].map((seat) => ({ seat, stack: 2000 })),
    button: 0,
    blinds: { sb: 10, bb: 20 },
    sb: 1,
    bb: 2,
  },
  seats: [0, 1, 2, 3, 4, 5].map((seat) => ({
    seat,
    userId: `u${seat}`,
    username: `p${seat}`,
  })),
  commitment: '0'.repeat(64),
  actions: actions.map(([seat, type, toCall, pot, to]) => ({
    seat,
    action:
      type === 'raise'
        ? { type: 'raise', to: to ?? 60 }
        : ({ type } as { type: 'fold' }),
    street: 'preflop',
    boardCount: 0,
    amount: type === 'raise' ? (to ?? 60) : type === 'call' ? toCall : 0,
    toCall,
    pot,
    canRaise: true,
    atMs: 0,
    decisionMs: 2000,
    source: 'client',
  })),
  board: [],
  shown: [],
  awards: [],
  netBySeat: {},
  showdown: false,
  ...extra,
})
const streets = (
  r: HandRecordV1,
  s: ('preflop' | 'flop' | 'turn' | 'river')[],
) => {
  r.actions.forEach((a, i) => (a.street = s[i]))
  return r
}

describe('online hands', () => {
  it('reads a cutoff open, a 3-bet from the button, and the fold', () => {
    // UTG folds, HJ folds, CO (5) opens, BTN (0) 3-bets, blinds fold, CO folds.
    const r = streets(
      six(
        [
          [3, 'fold', 20, 30],
          [4, 'fold', 20, 30],
          [5, 'raise', 20, 30, 60],
          [0, 'raise', 60, 90, 180],
          [1, 'fold', 170, 270],
          [2, 'fold', 160, 270],
          [5, 'fold', 120, 270],
        ],
        { netBySeat: { 0: 90, 5: -60, 1: -10, 2: -20 } },
      ),
      Array(7).fill('preflop'),
    )
    const cutoff = fromOnline(r, 'u5', 'six-casual', { hole: [48, 44] })!
    expect(cutoff).toMatchObject({
      format: 'six-max',
      position: 'CO',
      players: 6,
      vpip: true,
      pfr: true,
      threeBetChance: false,
      foldTo3betChance: true,
      foldTo3bet: true,
      net: -3,
      hole: 'AKs',
    })
    const button = fromOnline(r, 'u0', 'six-casual')!
    expect(button).toMatchObject({
      position: 'BTN',
      threeBetChance: true,
      threeBet: true,
      net: 4.5,
    })
    expect(button.opponents).toHaveLength(5)
    expect(fromOnline(r, 'nobody', 'six-casual')).toBeNull()
  })

  it('reads continuation bets, showdowns, grades and time', () => {
    // Heads-up: button 0 raises, BB 1 calls; BB checks, button bets, BB calls.
    const r = streets(
      {
        ...six([
          [0, 'raise', 10, 30, 60],
          [1, 'call', 40, 80],
          [1, 'check', 0, 120],
          [0, 'raise', 0, 120, 80],
          [1, 'call', 80, 200],
        ]),
        config: {
          handNo: 1,
          seats: [
            { seat: 0, stack: 2000 },
            { seat: 1, stack: 2000 },
          ],
          button: 0,
          blinds: { sb: 10, bb: 20 },
        },
        seats: [
          { seat: 0, userId: 'a', username: 'ann' },
          { seat: 1, userId: 'b', username: 'bob' },
        ],
        board: [1, 2, 3, 4, 5],
        showdown: true,
        awards: [{ pot: 0, seat: 1, amount: 280, score: 1 }],
        netBySeat: { 0: -140, 1: 140 },
        luck: {
          allInAt: null,
          equity: null,
          adjustedBySeat: { 0: -100, 1: 100 },
        },
      },
      ['preflop', 'preflop', 'flop', 'flop', 'flop'],
    )
    const ann = fromOnline(r, 'a', 'hu-rated', {
      at: 5,
      grades: [{ idx: 3, grade: 'mistake', evLost: 40, accuracy: 55 }],
    })!
    expect(ann).toMatchObject({
      format: 'heads-up',
      position: 'BTN',
      cbetChance: true,
      cbet: true,
      showdown: true,
      wonShowdown: false,
      net: -7,
      expected: -5,
      at: 5,
    })
    expect(ann.acts[1]).toMatchObject({
      grade: 'Mistake',
      accuracy: 55,
      evLost: 2,
      ms: 2000,
    })
    const bob = fromOnline(r, 'b', 'hu-rated')!
    expect(bob).toMatchObject({
      position: 'BB',
      threeBetChance: true,
      threeBet: false,
      facedCbet: true,
      foldedToCbet: false,
      wonShowdown: true,
    })
  })
})
