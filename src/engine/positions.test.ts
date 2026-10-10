// @vitest-environment node
// Seat order, blinds and labels for casual 6-max, pinned before the dead
// button lands (P2-02a) so that change shows exactly which baseline it moves.
// Expected values are worked out by hand from the rules in positions.ts:
// seats ascend clockwise and wrap from the highest seat to the lowest.
import { describe, expect, it } from 'vitest'
import { dealSlots, orderedDeck } from './deck'
import { act, isOver, startHand } from './hand'
import {
  blindSeats,
  nextBlinds,
  nextButton,
  orbitTravel,
  positionNames,
} from './positions'
import type { Blinds } from './positions'
import { config, deckWith, ringDistance, seededRandom } from './testing'
import { EngineError } from './types'
import type { HandConfig, HandState, SeatId } from './types'

/** A six-casual config: 2000 chips in each of `seats`, explicit blinds. */
const explicit = (
  seats: SeatId[],
  button: SeatId,
  sb: SeatId | null,
  bb: SeatId,
  blinds = { sb: 10, bb: 20 },
): HandConfig => ({
  handNo: 1,
  seats: seats.map((seat) => ({ seat, stack: 2000 })),
  button,
  blinds,
  sb,
  bb,
})
const invested = (state: HandState) =>
  Object.fromEntries(state.players.map((p) => [p.seat, p.invested]))

describe('table size', () => {
  it('validateConfig rejects 7 seats', () => {
    // SeatId is 0..5 and positionNames has labels for at most six.
    const seven = config([2000, 2000, 2000, 2000, 2000, 2000, 2000])
    expect(() => startHand(seven, deckWith(seven, {}, ''))).toThrow(
      new EngineError('A hand needs 2 to 6 players'),
    )
    const six = config([2000, 2000, 2000, 2000, 2000, 2000])
    expect(startHand(six, deckWith(six, {}, '')).players).toHaveLength(6)
  })
  it('refuses a seat id above 5', () => {
    const base = config([2000, 2000])
    const wide = {
      ...base,
      seats: [base.seats[0], { ...base.seats[1], seat: 8 }],
    }
    expect(() => startHand(wide, deckWith(base, {}, ''))).toThrow(
      new EngineError('Seats must be integers from 0 to 5'),
    )
  })
})

describe('positionNames', () => {
  it('heads-up: the button and the big blind', () => {
    // The button posts the small blind heads-up but is still labelled BTN.
    expect(positionNames([1, 4], 4)).toEqual({ 4: 'BTN', 1: 'BB' })
  })
  it('3 seats: wraps past the highest seat to the big blind', () => {
    expect(positionNames([0, 3, 5], 3)).toEqual({
      3: 'BTN',
      5: 'SB',
      0: 'BB',
    })
  })
  it('5 seats: the empty seat 3 is skipped', () => {
    expect(positionNames([0, 1, 2, 4, 5], 2)).toEqual({
      2: 'BTN',
      4: 'SB',
      5: 'BB',
      0: 'UTG',
      1: 'CO',
    })
  })
  it('6 seats: every label once, starting from the button', () => {
    expect(positionNames([0, 1, 2, 3, 4, 5], 4)).toEqual({
      4: 'BTN',
      5: 'SB',
      0: 'BB',
      1: 'UTG',
      2: 'HJ',
      3: 'CO',
    })
  })
})

describe('blindSeats', () => {
  it('heads-up: the button posts the small blind', () => {
    expect(blindSeats([0, 1], 0)).toEqual({ sb: 0, bb: 1 })
    expect(blindSeats([2, 5], 5)).toEqual({ sb: 5, bb: 2 })
  })
  it('3 or more: the two seats after the button, wrapping and skipping gaps', () => {
    expect(blindSeats([0, 1, 2], 0)).toEqual({ sb: 1, bb: 2 })
    expect(blindSeats([0, 1, 2], 2)).toEqual({ sb: 0, bb: 1 })
    expect(blindSeats([0, 2, 5], 2)).toEqual({ sb: 5, bb: 0 })
    expect(blindSeats([0, 1, 2, 3, 4, 5], 5)).toEqual({ sb: 0, bb: 1 })
  })
})

describe('nextButton', () => {
  it('wraps around a gap (seats 0, 2, 5)', () => {
    const seats = [0, 2, 5]
    expect(nextButton(seats, 0)).toBe(2)
    expect(nextButton(seats, 2)).toBe(5)
    expect(nextButton(seats, 5)).toBe(0)
  })
  it('moves on from a button seat that has emptied', () => {
    // The P2-02 dead-button rule is the change most likely to move this.
    expect(nextButton([0, 2, 5], 3)).toBe(5)
    expect(nextButton([0, 2, 5], 4)).toBe(5)
    expect(nextButton([0, 2], 5)).toBe(0)
  })
})

// Six-casual hands name their blind seats (ADR amendment 2026-10-10, Phase 2,
// "Blinds and button"). Each config below is one the standard dead button
// produces; the comment says which departure led to it.
describe('explicit blind seats', () => {
  it('dead button: empty button seat, no small blind, bb posts, first seat after bb opens', () => {
    // Last hand: button 0, small blind 1, big blind 2. Seats 1 and 2 left, so
    // the big blind moves on to 3, the small blind (seat 2) is dead and the
    // button stays on seat 1, which is empty.
    const cfg = explicit([0, 3, 4, 5], 1, null, 3)
    let state = startHand(cfg, deckWith(cfg, {}, ''))
    expect(invested(state)).toEqual({ 0: 0, 3: 20, 4: 0, 5: 0 })
    // The deal starts at the first player clockwise after the empty button.
    expect(dealSlots(cfg).holes).toEqual({
      3: [0, 4],
      4: [1, 5],
      5: [2, 6],
      0: [3, 7],
    })
    expect(state.toAct).toBe(4)
    state = act(state, 4, { type: 'call' })
    expect(state.toAct).toBe(5)
    state = act(state, 5, { type: 'call' })
    expect(state.toAct).toBe(0)
    state = act(state, 0, { type: 'call' })
    expect(state.toAct).toBe(3) // the big blind's option
    state = act(state, 3, { type: 'check' })
    expect(state.street).toBe('flop')
    expect(state.pots).toEqual([{ amount: 80, eligible: [0, 3, 4, 5] }])
    // After the flop the first player clockwise from seat 1 leads.
    expect(state.toAct).toBe(3)
    expect(positionNames([0, 3, 4, 5], 1, { sb: null, bb: 3 })).toEqual({
      3: 'BB',
      4: 'UTG',
      5: 'HJ',
      0: 'CO',
    })
  })

  it('dead small blind', () => {
    // Last hand: button 0, small blind 1, big blind 2. Seat 2 left: the big
    // blind moves on to 3, and the small blind falls on the empty seat 2.
    // Seat 1 keeps the button and posts nothing.
    const cfg = explicit([0, 1, 3, 4], 1, null, 3)
    let state = startHand(cfg, deckWith(cfg, {}, ''))
    expect(invested(state)).toEqual({ 0: 0, 1: 0, 3: 20, 4: 0 })
    expect(state.toAct).toBe(4)
    state = act(state, 4, { type: 'call' })
    state = act(state, 0, { type: 'call' })
    expect(state.toAct).toBe(1)
    state = act(state, 1, { type: 'call' })
    state = act(state, 3, { type: 'check' })
    expect(state.street).toBe('flop')
    expect(state.toAct).toBe(3)
    expect(positionNames([0, 1, 3, 4], 1, { sb: null, bb: 3 })).toEqual({
      1: 'BTN',
      3: 'BB',
      4: 'UTG',
      0: 'CO',
    })
  })

  it('dead small blind: a player who just sat in its seat is dealt in and posts nothing', () => {
    // As above, but someone sat in seat 2 between the hands (R-20).
    const cfg = explicit([0, 1, 2, 3, 4], 1, null, 3)
    let state = startHand(cfg, deckWith(cfg, {}, ''))
    expect(invested(state)).toEqual({ 0: 0, 1: 0, 2: 0, 3: 20, 4: 0 })
    const order: SeatId[] = []
    while (state.street === 'preflop') {
      order.push(state.toAct!)
      state = act(state, state.toAct!, {
        type: state.toAct === 3 ? 'check' : 'call',
      })
    }
    expect(order).toEqual([4, 0, 1, 2, 3])
    expect(state.toAct).toBe(2) // first clockwise from the button after the flop
    // Seat 2 holds no position: it sits between the button and the big
    // blind and posts nothing.
    expect(positionNames([0, 1, 2, 3, 4], 1, { sb: null, bb: 3 })).toEqual({
      1: 'BTN',
      3: 'BB',
      4: 'UTG',
      0: 'CO',
    })
  })

  it('dead button with a live small blind', () => {
    // Last hand: button 0, small blind 1, big blind 2. Seat 1 left.
    const cfg = explicit([0, 2, 3, 4], 1, 2, 3)
    const state = startHand(cfg, deckWith(cfg, {}, ''))
    expect(invested(state)).toEqual({ 0: 0, 2: 10, 3: 20, 4: 0 })
    expect(state.toAct).toBe(4)
    expect(positionNames([0, 2, 3, 4], 1, { sb: 2, bb: 3 })).toEqual({
      2: 'SB',
      3: 'BB',
      4: 'UTG',
      0: 'CO',
    })
  })

  it('odd chip from the seat after an empty button', () => {
    // Button on the empty seat 1, blinds 2 and 4 at 5/10. Seats 0 and 2 tie
    // on a royal-flush board for a 95-chip pot. Odd chips go clockwise from
    // the seat after the button: 2, 4, 0. So seat 2 gets 48 and seat 0 gets
    // 47. Counting from the small blind or the big blind would pay seat 0.
    const cfg = explicit([0, 2, 4], 1, 2, 4, { sb: 5, bb: 10 })
    const deck = deckWith(
      cfg,
      { 0: '2h 3h', 2: '2d 3d', 4: '4c 5c' },
      'As Ks Qs Js Ts',
    )
    let state = startHand(cfg, deck)
    expect(state.toAct).toBe(0)
    state = act(state, 0, { type: 'call' })
    state = act(state, 2, { type: 'call' })
    state = act(state, 4, { type: 'check' })
    expect(state.toAct).toBe(2) // flop: 30 in the pot
    state = act(state, 2, { type: 'check' })
    state = act(state, 4, { type: 'raise', to: 15 })
    state = act(state, 0, { type: 'call' })
    state = act(state, 2, { type: 'call' })
    expect(state.toAct).toBe(2) // turn: 75
    state = act(state, 2, { type: 'raise', to: 10 })
    state = act(state, 4, { type: 'fold' })
    state = act(state, 0, { type: 'call' })
    state = act(state, 2, { type: 'check' }) // river: 95
    state = act(state, 0, { type: 'check' })
    expect(isOver(state)).toBe(true)
    expect(state.result!.awards.map((a) => [a.pot, a.seat, a.amount])).toEqual([
      [0, 2, 48],
      [0, 0, 47],
    ])
    expect(state.players.map((p) => p.stack)).toEqual([2012, 2013, 1975])
    expect(state.result!.netBySeat).toEqual({ 0: 12, 2: 13, 4: -25 })
  })

  it('two-handed: the button posts the small blind, as heads-up', () => {
    const cfg = explicit([1, 4], 4, 4, 1)
    const state = startHand(cfg, deckWith(cfg, {}, ''))
    expect(invested(state)).toEqual({ 1: 20, 4: 10 })
    expect(state.toAct).toBe(4)
    expect(positionNames([1, 4], 4, { sb: 4, bb: 1 })).toEqual({
      4: 'BTN',
      1: 'BB',
    })
  })

  it('refuses every illegal explicit blind placement', () => {
    const refuses = (cfg: HandConfig, message: string) =>
      expect(() => startHand(cfg, deckWith(cfg, {}, ''))).toThrow(
        new EngineError(message),
      )
    // Players in seats 0, 2, 3 and 5; one legal placement is button 1 (empty),
    // small blind 2, big blind 3.
    const seats = [0, 2, 3, 5]
    const legal = explicit(seats, 1, 2, 3)
    expect(startHand(legal, deckWith(legal, {}, '')).toAct).toBe(5)
    // The big blind must be a player dealt in.
    refuses(explicit(seats, 1, null, 4), 'The big blind must be dealt in')
    refuses(explicit(seats, 2, null, 1), 'The big blind must be dealt in')
    // A live small blind must be a player dealt in, on another seat.
    refuses(explicit(seats, 0, 1, 2), 'A live small blind must be dealt in')
    refuses(
      explicit(seats, 1, 3, 3),
      'The small blind and the big blind must be different seats',
    )
    // Two players: the button posts the small blind, which is never dead.
    refuses(
      explicit([0, 3], 0, null, 3),
      'Heads-up the button posts the small blind',
    )
    refuses(
      explicit([0, 3], 1, 0, 3),
      'Heads-up the button posts the small blind',
    )
    refuses(
      explicit([0, 3], 3, 0, 3),
      'Heads-up the button posts the small blind',
    )
    // Three or more: the button is on neither blind.
    const noBlind = 'With three or more players the button posts no blind'
    refuses(explicit(seats, 2, 2, 3), noBlind)
    refuses(explicit(seats, 3, 2, 3), noBlind)
    refuses(explicit(seats, 3, null, 3), noBlind)
    // A live small blind's next player is the big blind.
    const next = 'The big blind must be the next player after the small blind'
    refuses(explicit(seats, 1, 2, 5), next)
    refuses(explicit(seats, 3, 5, 2), next)
    refuses(explicit([0, 2, 4], 1, 2, 0), next)
    // The button comes before the small blind's seat: never between a live
    // small blind and the big blind, never just before the big blind when
    // the small blind is dead (that blind's seat lies between them).
    const before = 'The button must come before the small blind'
    refuses(explicit([0, 2, 4], 3, 2, 4), before)
    refuses(explicit([0, 1, 2, 3, 4], 5, 4, 0), before)
    refuses(explicit([0, 1, 2, 3, 4], 5, null, 0), before)
    refuses(explicit(seats, 2, null, 3), before)
    // Seats and the button are 0..5.
    const button = 'The button must be a seat from 0 to 5'
    refuses(explicit(seats, 6, 2, 3), button)
    refuses(explicit(seats, -1, 2, 3), button)
    refuses(explicit(seats, 1.5, 2, 3), button)
    refuses(
      explicit([0, 2, 3, 6], 1, 2, 3),
      'Seats must be integers from 0 to 5',
    )
    // Both blind seats or neither.
    const noSb = { ...legal }
    const noBb = { ...legal }
    delete noSb.sb
    delete noBb.bb
    refuses(noSb, 'Explicit blinds need both sb and bb')
    refuses(noBb, 'Explicit blinds need both sb and bb')
    // Without them the button must still be a seated player, as before.
    refuses(
      { ...config([2000, 2000]), button: 3 },
      'The button must be a seated player',
    )
  })
})

describe('positionNames with explicit blinds', () => {
  it('matches the implicit labels whenever the blinds are where blindSeats puts them', () => {
    // Every seating of 2 to 6 players at six seats, every seated button.
    for (let mask = 0; mask < 64; mask++) {
      const seats = [0, 1, 2, 3, 4, 5].filter((s) => mask & (1 << s))
      if (seats.length < 2) continue
      for (const button of seats)
        expect(positionNames(seats, button, blindSeats(seats, button))).toEqual(
          positionNames(seats, button),
        )
    }
  })
  it('labels without throwing even for a placement the engine refuses', () => {
    // Four players between the big blind and the button have no names to
    // take; the engine refuses that button, and positionNames must not crash.
    expect(() =>
      positionNames([0, 1, 2, 3, 4], 5, { sb: 4, bb: 0 }),
    ).not.toThrow()
    expect(positionNames([0, 1, 2, 3, 4], 5, { sb: 4, bb: 0 })).toMatchObject({
      0: 'BB',
      4: 'SB',
    })
  })
  it('names nobody BTN on an empty seat and nobody SB when it is dead', () => {
    // Button on empty seat 4, live small blind 5, big blind 0, then 1, 2, 3.
    expect(positionNames([0, 1, 2, 3, 5], 4, { sb: 5, bb: 0 })).toEqual({
      5: 'SB',
      0: 'BB',
      1: 'UTG',
      2: 'HJ',
      3: 'CO',
    })
    // A six-handed table where seat 2 just sat in the small blind's seat.
    expect(positionNames([0, 1, 2, 3, 4, 5], 1, { sb: null, bb: 3 })).toEqual({
      1: 'BTN',
      3: 'BB',
      4: 'UTG',
      5: 'HJ',
      0: 'CO',
    })
  })
})

// ---- Blind rotation between hands (P2-02b) -----------------------------------
//
// The ADR amendment's rule, step by step: (1) the big blind moves to the next
// seat clockwise with a player dealt in; (2) the small blind goes to the seat
// that had the big blind, dead when nobody there is dealt in or its player
// sat down since the last hand; (3) the button goes to the seat that had the
// small blind if that seat lies clockwise after the new big blind and before
// the new small blind, else to the seat just before the new small blind.
// Exactly two dealt in: the other player is button and small blind.

/** The engine config for a hand dealt with blinds `b`. */
const dealt = (seats: SeatId[], b: Blinds): HandConfig =>
  explicit(seats, b.button, b.sb, b.bb)
/** Starts the hand, so the engine's validateConfig judges the placement. */
const deal = (seats: SeatId[], b: Blinds) => {
  const cfg = dealt(seats, b)
  return startHand(cfg, deckWith(cfg, {}, ''))
}
/** Any full deck: the random walk only needs the engine to accept a deal. */
const DECK = orderedDeck()
/** Button, small blind seat, big blind: in that order clockwise. */
const inOrder = (b: Blinds) =>
  ringDistance(b.button, b.sbSeat) > 0 &&
  ringDistance(b.button, b.sbSeat) < ringDistance(b.button, b.bb)

describe('nextBlinds', () => {
  it('the first hand at a table: blindSeats with the button on the lowest seat dealt in', () => {
    expect(nextBlinds(null, [4, 1])).toEqual({
      button: 1,
      sb: 1,
      bb: 4,
      sbSeat: 1,
    })
    expect(nextBlinds(null, [5, 0, 2])).toEqual({
      button: 0,
      sb: 2,
      bb: 5,
      sbSeat: 2,
    })
    // Everyone has just sat down, so someone has to post: the small blind is
    // live at the first hand.
    expect(nextBlinds(null, [1, 3, 5], [1, 3, 5])).toEqual({
      button: 1,
      sb: 3,
      bb: 5,
      sbSeat: 3,
    })
    // One player is no hand.
    expect(() => nextBlinds(null, [3])).toThrow(
      new EngineError('Blinds need two players'),
    )
  })

  it('when the next big blind leaves, the big blind still advances one seat and the button may be dead', () => {
    // As amended: the big blind advances to the next seat with a player
    // dealt in, and the button may end up on an empty seat.
    const h1 = nextBlinds(null, [0, 1, 2, 3, 4])
    expect(h1).toEqual({ button: 0, sb: 1, bb: 2, sbSeat: 1 })
    // Seat 3, due to post the next big blind, leaves. Seat 4 posts it; seat
    // 2 moves to the small blind and seat 1 to the button.
    const h2 = nextBlinds(h1, [0, 1, 2, 4])
    expect(h2).toEqual({ button: 1, sb: 2, bb: 4, sbSeat: 2 })
    // Seat 2, who just posted the small blind, leaves too. The big blind
    // goes round to seat 0, seat 4 posts the small blind, and the button
    // goes to seat 2 (the seat that had the small blind, which lies after
    // the new big blind and before the new small blind): a dead button.
    const h3 = nextBlinds(h2, [0, 1, 4])
    expect(h3).toEqual({ button: 2, sb: 4, bb: 0, sbSeat: 4 })
    const state = deal([0, 1, 4], h3)
    expect(state.toAct).toBe(1)
    // The hand after, the button is back on a player: seat 4.
    expect(nextBlinds(h3, [0, 1, 4])).toEqual({
      button: 4,
      sb: 0,
      bb: 1,
      sbSeat: 0,
    })
  })

  it('the big blind leaves: a dead small blind, then a dead button', () => {
    const h1 = nextBlinds(null, [0, 1, 2, 3, 4])
    // Seat 2 (the big blind) leaves: seat 3 posts the big blind, nobody the
    // small blind (its seat is empty), and the button goes to seat 1.
    const h2 = nextBlinds(h1, [0, 1, 3, 4])
    expect(h2).toEqual({ button: 1, sb: null, bb: 3, sbSeat: 2 })
    expect(deal([0, 1, 3, 4], h2).toAct).toBe(4)
    // Next: the button goes to the empty seat 2, which had the small blind.
    const h3 = nextBlinds(h2, [0, 1, 3, 4])
    expect(h3).toEqual({ button: 2, sb: 3, bb: 4, sbSeat: 3 })
    expect(deal([0, 1, 3, 4], h3).toAct).toBe(0)
  })

  it('refuses dealt-in seats that repeat or leave the table', () => {
    const err = new EngineError(
      'Dealt-in seats must be distinct seats from 0 to 5',
    )
    const prev = { button: 0, sb: 1, bb: 2, sbSeat: 1 }
    expect(() => nextBlinds(prev, [1, 1, 3])).toThrow(err)
    expect(() => nextBlinds(prev, [1, 3, 6])).toThrow(err)
    expect(() => nextBlinds(null, [-1, 3])).toThrow(err)
  })
  it('3→2 players: no big blind repeats', () => {
    const h1 = nextBlinds(null, [0, 2, 4])
    expect(h1).toEqual({ button: 0, sb: 2, bb: 4, sbSeat: 2 })
    // Whoever leaves, the big blind moves on from seat 4, and the other
    // player is button and small blind.
    expect(nextBlinds(h1, [2, 4])).toEqual({
      button: 4,
      sb: 4,
      bb: 2,
      sbSeat: 4,
    })
    expect(nextBlinds(h1, [0, 4])).toEqual({
      button: 4,
      sb: 4,
      bb: 0,
      sbSeat: 4,
    })
    expect(nextBlinds(h1, [0, 2])).toEqual({
      button: 2,
      sb: 2,
      bb: 0,
      sbSeat: 2,
    })
    // Heads-up from then on, the big blind alternates.
    let h = nextBlinds(h1, [2, 4])
    const bigBlinds = [h.bb]
    for (let i = 0; i < 4; i++) bigBlinds.push((h = nextBlinds(h, [2, 4])).bb)
    expect(bigBlinds).toEqual([2, 4, 2, 4, 2])
  })

  it('a joiner is dealt in next hand without posting', () => {
    const h1 = nextBlinds(null, [0, 1, 2, 4])
    expect(h1).toEqual({ button: 0, sb: 1, bb: 2, sbSeat: 1 })
    // Someone sits at seat 5, between seat 4 and the button.
    const h2 = nextBlinds(h1, [0, 1, 2, 4, 5], [5])
    expect(h2).toEqual({ button: 1, sb: 2, bb: 4, sbSeat: 2 })
    expect(deal([0, 1, 2, 4, 5], h2).players.map((p) => p.invested)).toEqual([
      0, 0, 10, 20, 0,
    ])
    // Seat 2 (the big blind) leaves and someone sits there: the small blind
    // lands on the newcomer, so it is dead.
    const h2b = nextBlinds(h1, [0, 1, 2, 4], [2])
    expect(h2b).toEqual({ button: 1, sb: null, bb: 4, sbSeat: 2 })
    expect(deal([0, 1, 2, 4], h2b).players.map((p) => p.invested)).toEqual([
      0, 0, 0, 20,
    ])
  })

  it('a joiner posts the big blind when it lands on their seat, as anyone would', () => {
    // R-20 as amended: the big blind is never skipped for a newcomer.
    const h1 = nextBlinds(null, [0, 1, 2, 4])
    expect(nextBlinds(h1, [0, 1, 2, 3, 4], [3])).toEqual({
      button: 1,
      sb: 2,
      bb: 3,
      sbSeat: 2,
    })
  })

  it('two dealt in never leave the small blind dead, even for a joiner', () => {
    // Heads-up: seat 0 is button and small blind, seat 3 the big blind.
    const hu = nextBlinds(null, [0, 3])
    expect(hu).toEqual({ button: 0, sb: 0, bb: 3, sbSeat: 0 })
    // Seat 3 leaves and someone sits at 2: the big blind goes round to seat
    // 0, and the newcomer is button and posts the small blind.
    const next = nextBlinds(hu, [0, 2], [2])
    expect(next).toEqual({ button: 2, sb: 2, bb: 0, sbSeat: 2 })
    expect(deal([0, 2], next).players.map((p) => p.invested)).toEqual([20, 10])
  })

  it('traces from the ADR review: the button never lands on a blind or out of order', () => {
    // Each case put the button on the big blind, or after the small blind,
    // under "button to the seat that had the small blind" without step (3).
    const cases: [string, Blinds, SeatId[], SeatId[], Blinds][] = [
      [
        '2→3: heads-up 0 (button, small blind) and 3, someone sits at 1',
        { button: 0, sb: 0, bb: 3, sbSeat: 0 },
        [0, 1, 3],
        [1],
        { button: 2, sb: 3, bb: 0, sbSeat: 3 },
      ],
      [
        '3→3: button 0, blinds 2 and 4; seat 0 stands, someone sits at 3',
        { button: 0, sb: 2, bb: 4, sbSeat: 2 },
        [2, 3, 4],
        [3],
        { button: 3, sb: 4, bb: 2, sbSeat: 4 },
      ],
      [
        'order inverted: heads-up 4 (button, small blind) and 3; seat 4 stands, 0 and 1 sit',
        { button: 4, sb: 4, bb: 3, sbSeat: 4 },
        [0, 1, 3],
        [0, 1],
        { button: 2, sb: 3, bb: 0, sbSeat: 3 },
      ],
      [
        'heads-up 2 (button, small blind) and 1; someone sits at 5',
        { button: 2, sb: 2, bb: 1, sbSeat: 2 },
        [1, 2, 5],
        [5],
        { button: 0, sb: 1, bb: 2, sbSeat: 1 },
      ],
    ]
    for (const [name, prev, seats, sat, expected] of cases) {
      const next = nextBlinds(prev, seats, sat)
      expect(next, name).toEqual(expected)
      expect(inOrder(next), name).toBe(true)
      expect(() => deal(seats, next), name).not.toThrow()
    }
  })

  it('no one posts the big blind twice in a row or skips it after departures', () => {
    // 10,000 tables, each a random run of joins, departures and sit-outs.
    // Every placement is checked against the rule walked one seat at a time
    // (referenceBlinds below) and against the properties the ADR promises.
    const random = seededRandom(20261010)
    const counts = {
      hands: 0,
      headsUp: 0,
      deadButton: 0,
      deadEmptySb: 0,
      deadJoinerSb: 0,
      threeToTwo: 0,
    }
    for (let table = 0; table < 10_000; table++) {
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
      let prev: {
        blinds: Blinds
        occupant: (number | null)[]
        dealt: boolean[]
      } | null = null
      for (let step = 0; step < 24; step++) {
        const isDealt = occupant.map((o, s) => o !== null && !out[s])
        const seats = [0, 1, 2, 3, 4, 5].filter((s) => isDealt[s])
        if (seats.length >= 2) {
          const justSat = seats.filter((s) => sat[s])
          const b = nextBlinds(prev?.blinds ?? null, seats, justSat)
          // Plain checks: an expect per hand would dominate the run time.
          const check = (ok: boolean, why: string) => {
            if (!ok)
              expect.fail(
                `${why}, table ${table}, step ${step}: ` +
                  JSON.stringify({ prev: prev?.blinds, seats, justSat, b }),
              )
          }
          const ref = referenceBlinds(prev?.blinds ?? null, isDealt, sat)
          check(
            b.button === ref.button &&
              b.sb === ref.sb &&
              b.bb === ref.bb &&
              b.sbSeat === ref.sbSeat,
            `the rule gives ${JSON.stringify(ref)}`,
          )
          check(isDealt[b.bb], 'big blind not dealt in')
          check(
            b.sb === null || (isDealt[b.sb] && b.sb !== b.bb),
            'small blind not dealt in, or on the big blind',
          )
          if (seats.length === 2) {
            check(b.sb !== null && b.button === b.sb, 'heads-up button')
            counts.headsUp++
            if (prev && prev.dealt.filter(Boolean).length === 3)
              counts.threeToTwo++
          } else {
            check(b.button !== b.sb && b.button !== b.bb, 'button on a blind')
            check(inOrder(b), 'button, small blind, big blind out of order')
            // After the first hand a newcomer never posts the small blind.
            check(!prev || b.sb === null || !sat[b.sb], 'newcomer posts sb')
            if (!isDealt[b.button]) counts.deadButton++
            if (b.sb === null)
              counts[isDealt[b.sbSeat] ? 'deadJoinerSb' : 'deadEmptySb']++
          }
          // Throws, failing the test, if the engine refuses the placement.
          startHand(dealt(seats, b), DECK)
          if (prev) {
            check(
              occupant[b.bb] !== prev.occupant[prev.blinds.bb],
              'same player posts the big blind twice in a row',
            )
            // Nobody dealt into both hands is passed over.
            for (const s of seats)
              if (prev.dealt[s] && occupant[s] === prev.occupant[s]) {
                const d = ringDistance(prev.blinds.bb, s)
                check(
                  !(d > 0 && d < ringDistance(prev.blinds.bb, b.bb)),
                  `seat ${s} skipped`,
                )
              }
          }
          prev = { blinds: b, occupant: [...occupant], dealt: isDealt }
          sat.fill(false)
          counts.hands++
        }
        // Between hands each seat may change once.
        for (let s = 0; s < 6; s++) {
          const r = random()
          if (occupant[s] !== null && r < 0.08) {
            occupant[s] = null
            out[s] = false
          } else if (occupant[s] !== null && r < 0.13) out[s] = !out[s]
          else if (occupant[s] === null && r < 0.12) {
            occupant[s] = nextId++
            sat[s] = true
          }
        }
      }
    }
    // The walk reached every case the rule distinguishes. The rarest is a
    // newcomer in the seat the big blind just left (a dead small blind).
    const { deadJoinerSb, ...common } = counts
    for (const [key, n] of Object.entries(common))
      expect(n, key).toBeGreaterThan(1_000)
    expect(deadJoinerSb).toBeGreaterThan(200)
  }, 60_000) // about 3 s alone, slower beside the other suites
})

/**
 * The ADR's rule walked one seat at a time, independent of positions.ts:
 * `dealt[s]` and `sat[s]` say whether seat s is dealt in and whether its
 * player sat down since the last hand.
 */
function referenceBlinds(
  prev: Blinds | null,
  dealt: boolean[],
  sat: boolean[],
): Blinds {
  const step = (s: SeatId) => (s + 1) % 6
  const nextDealt = (s: SeatId) => {
    do s = step(s)
    while (!dealt[s])
    return s
  }
  const players = dealt.filter(Boolean).length
  if (!prev) {
    const button = dealt.indexOf(true)
    const sb = players === 2 ? button : nextDealt(button)
    return { button, sb, bb: nextDealt(sb), sbSeat: sb }
  }
  const bb = nextDealt(prev.bb)
  if (players === 2) {
    const other = nextDealt(bb)
    return { button: other, sb: other, bb, sbSeat: other }
  }
  const sbSeat = prev.bb
  const sb = dealt[sbSeat] && !sat[sbSeat] ? sbSeat : null
  // Walk from the new big blind towards the new small blind; meeting the
  // old small blind's seat on the way puts the button there.
  let button = (sbSeat + 5) % 6
  for (let s = step(bb); s !== sbSeat; s = step(s))
    if (s === prev.sbSeat) button = s
  return { button, sb, bb, sbSeat }
}

describe('orbitTravel', () => {
  it('the first hand at a table starts no orbit', () => {
    expect(orbitTravel(0, null, 3)).toEqual({ travel: 0, newOrbit: false })
  })
  it('a full table: the big blind back on its first seat starts a new orbit', () => {
    // Big blinds 0, 1, 2, 3, 4, 5, then 0 again after every seat posted.
    let travel = orbitTravel(0, null, 0).travel
    const starts: boolean[] = []
    for (const [from, to] of [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
      [5, 0],
    ]) {
      const next = orbitTravel(travel, from, to)
      travel = next.travel
      starts.push(next.newOrbit)
    }
    expect(starts).toEqual([false, false, false, false, false, true])
    expect(travel).toBe(0)
  })
  it('gaps count as seats: three players at 0, 2 and 4, and heads-up at 1 and 4', () => {
    expect(orbitTravel(0, 0, 2)).toEqual({ travel: 2, newOrbit: false })
    expect(orbitTravel(2, 2, 4)).toEqual({ travel: 4, newOrbit: false })
    expect(orbitTravel(4, 4, 0)).toEqual({ travel: 0, newOrbit: true })
    expect(orbitTravel(0, 1, 4)).toEqual({ travel: 3, newOrbit: false })
    expect(orbitTravel(3, 4, 1)).toEqual({ travel: 0, newOrbit: true })
  })
  it('passing six goes back to 0, not to the remainder', () => {
    // Travel 5, then the big blind jumps from seat 5 over empty seats to 2.
    expect(orbitTravel(5, 5, 2)).toEqual({ travel: 0, newOrbit: true })
  })
  it('departures shorten the orbit', () => {
    // Four players at 0..3; seat 2 leaves after the big blind reached 1.
    const bbs = [0, 1, 3, 0]
    let travel = 0
    const starts = bbs.slice(1).map((bb, i) => {
      const next = orbitTravel(travel, bbs[i], bb)
      travel = next.travel
      return next.newOrbit
    })
    expect(starts).toEqual([false, false, true])
  })
})
