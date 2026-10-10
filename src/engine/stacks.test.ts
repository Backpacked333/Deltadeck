// @vitest-environment node
// Buy-in and rebuy for casual 6-max (ADR amendment 2026-10-10, Phase 2,
// "Stacks and rebuy"). Expected chip counts are worked out by hand: 100 bb at
// a 20-chip big blind is 100 × 20 = 2,000 chips (R-10), and a top-up is
// 2,000 minus the stack.
import { describe, expect, it } from 'vitest'
import { BUY_IN_BB, buyIn, rebuyTo } from './stacks'
import { EngineError } from './types'

describe('buyIn', () => {
  it('bb 20 => 2000: the buy-in is 100 big blinds', () => {
    expect(BUY_IN_BB).toBe(100)
    expect(buyIn(20)).toBe(2000)
    expect(buyIn(50)).toBe(5000)
  })
})

describe('rebuyTo', () => {
  it('rebuy only below 100 bb and only between hands', () => {
    // Refused in the hand being played, whatever the stack: mid-hand it
    // leaves out the chips in the pot, and an all-in seat at 0 chips is
    // still in the hand.
    for (const stack of [0, 1, 1999, 2000, 2500])
      expect(rebuyTo(stack, 20, true)).toEqual({
        amount: 0,
        refused: 'in_hand',
      })
    // Out of the hand at exactly 100 bb or above: nothing to top up.
    for (const stack of [2000, 2001, 4000])
      expect(rebuyTo(stack, 20, false)).toEqual({
        amount: 0,
        refused: 'not_below',
      })
    // Below 100 bb: tops up to exactly 2,000.
    expect(rebuyTo(1, 20, false)).toEqual({ amount: 1999, refused: null })
    expect(rebuyTo(0, 20, false)).toEqual({ amount: 2000, refused: null })
    // 99 bb + 19 chips = 1,980 + 19 = 1,999: one chip short.
    expect(rebuyTo(99 * 20 + 19, 20, false)).toEqual({
      amount: 1,
      refused: null,
    })
    for (let stack = 0; stack < 2000; stack++)
      expect(stack + rebuyTo(stack, 20, false).amount).toBe(2000)
  })
  it('measures 100 bb at the table big blind', () => {
    // 100 × 50 = 5,000, so 2,000 chips is below 100 bb at 25/50.
    expect(rebuyTo(2000, 50, false)).toEqual({ amount: 3000, refused: null })
    expect(rebuyTo(1234, 50, false)).toEqual({ amount: 3766, refused: null })
    expect(rebuyTo(5000, 50, false)).toEqual({
      amount: 0,
      refused: 'not_below',
    })
  })
  it('never takes an amount from the client', () => {
    // The server derives the top-up from the stack; a requested size has no
    // parameter to arrive through, and an extra argument changes nothing.
    // @ts-expect-error: rebuyTo has no amount parameter
    expect(rebuyTo(1, 20, false, 50_000)).toEqual({
      amount: 1999,
      refused: null,
    })
  })
  it('refuses a stack or big blind that is not a chip count', () => {
    // NaN would read as 'not_below' and a fraction would break chip
    // conservation, so corrupt server state fails loudly instead.
    for (const stack of [-1, 1.5, NaN])
      expect(() => rebuyTo(stack, 20, false)).toThrow(
        new EngineError('A stack must be a non-negative integer'),
      )
    for (const bb of [0, -20, 2.5, NaN]) {
      expect(() => rebuyTo(0, bb, false)).toThrow(
        new EngineError('The big blind must be a positive integer'),
      )
      expect(() => buyIn(bb)).toThrow(
        new EngineError('The big blind must be a positive integer'),
      )
    }
  })
})
