// Test-only helpers for the engine suites: seeded decks, readable cards and
// a random legal-action walk shared by the invariant, redaction and
// differential tests. Not imported by application code.
import type { Suit } from '../lib/poker'
import { lcg, toId } from '../lib/sim'
import { dealSlots, orderedDeck, shuffleWith } from './deck'
import { legalActions } from './hand'
import type { HandConfig, HandState, PlayerAction, SeatId } from './types'

export const randomIntFrom = (random: () => number) => (n: number) =>
  Math.floor(random() * n)

/** A deterministic source of numbers in [0, 1) for seeded test walks. */
export const seededRandom = (seed: number) => lcg(seed)

export const seededDeck = (seed: number) =>
  shuffleWith(randomIntFrom(lcg(seed)))

/** 'As Kd' → card ids. */
export const ids = (text: string) =>
  text
    .split(' ')
    .filter(Boolean)
    .map((v) =>
      toId({ rank: '23456789TJQKA'.indexOf(v[0]) + 2, suit: v[1] as Suit }),
    )

/** A deck that deals the given hole cards and board; the rest in order. */
export function deckWith(
  config: HandConfig,
  holes: Record<SeatId, string>,
  board: string,
) {
  const slots = dealSlots(config)
  const deck = Array<number>(52).fill(-1)
  for (const [seat, text] of Object.entries(holes)) {
    const [a, b] = ids(text)
    deck[slots.holes[Number(seat)][0]] = a
    deck[slots.holes[Number(seat)][1]] = b
  }
  ids(board).forEach((card, i) => (deck[slots.board[i]] = card))
  const used = new Set(deck)
  const rest = orderedDeck().filter((c) => !used.has(c))
  return deck.map((c) => (c === -1 ? rest.shift()! : c))
}

export const config = (
  stacks: number[],
  button = 0,
  blinds = { sb: 10, bb: 20 },
  handNo = 1,
): HandConfig => ({
  handNo,
  seats: stacks.map((stack, seat) => ({ seat, stack })),
  button,
  blinds,
})

/** The walk from poker.test.ts: 12% fold, 38% random raise, else check/call. */
export function randomAction(
  state: HandState,
  random: () => number,
): PlayerAction {
  const legal = legalActions(state)
  const roll = random()
  if (roll < 0.12) return { type: 'fold' }
  if (roll < 0.5 && legal.canRaise)
    return {
      type: 'raise',
      to:
        legal.minRaiseTo +
        Math.floor(random() * (legal.maxRaiseTo - legal.minRaiseTo + 1)),
    }
  return legal.canCheck ? { type: 'check' } : { type: 'call' }
}

/** A random table of `n` players: seats, stacks 1..4000, button, deck. */
export function randomTable(n: number, random: () => number, handNo = 1) {
  const seats = orderedDeck()
    .slice(0, 6)
    .sort(() => random() - 0.5)
    .slice(0, n)
    .sort((a, b) => a - b)
  const cfg: HandConfig = {
    handNo,
    seats: seats.map((seat) => ({
      seat,
      stack: 1 + Math.floor(random() * 4000),
    })),
    button: seats[Math.floor(random() * n)],
    blinds: { sb: 10, bb: 20 },
  }
  return { config: cfg, deck: shuffleWith(randomIntFrom(random)) }
}

/** Clockwise seat distance on the six-seat ring, 0..5. */
export const ringDistance = (from: SeatId, to: SeatId) => (to - from + 6) % 6

/**
 * `cfg` with six-casual blind seats placed at random wherever the standard
 * dead button can put them (ADR amendment 2026-10-10, "Blinds and button"),
 * worked out from that geometry rather than from the engine: the big blind on
 * a player; the small blind's seat on the nearest player before it or on an
 * empty seat in between, dead when empty and, half the time, when its player
 * has just sat down; the button on any seat strictly between the big blind
 * and the small blind's seat, empty or not. Heads-up the other player is the
 * button and posts the small blind.
 */
export function withExplicitBlinds(
  cfg: HandConfig,
  random: () => number,
): HandConfig {
  const seats = cfg.seats.map((s) => s.seat)
  const pick = <T>(list: T[]) => list[Math.floor(random() * list.length)]
  const bb = pick(seats)
  if (seats.length === 2) {
    const other = seats.find((s) => s !== bb)!
    return { ...cfg, button: other, sb: other, bb }
  }
  const before = seats
    .filter((s) => s !== bb)
    .reduce((a, b) => (ringDistance(b, bb) < ringDistance(a, bb) ? b : a))
  const ring = (from: SeatId, count: number) =>
    Array.from({ length: count }, (_, i) => (from + i) % 6)
  const sbSeat = pick(ring(before, ringDistance(before, bb)))
  const live = sbSeat === before && random() < 0.5
  const button = pick(ring(bb + 1, ringDistance(bb, sbSeat) - 1))
  return { ...cfg, button, sb: live ? sbSeat : null, bb }
}
