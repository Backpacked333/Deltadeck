// Pure N-player no-limit hold'em. Every transition clones its input like
// src/lib/poker.ts does, so callers can keep earlier states as snapshots. The
// engine has no randomness and no clock: the deck is an input.
import { score } from '../lib/sim'
import { dealSlots, isValidDeck } from './deck'
import { blindSeats, clockwiseFrom, ringDistance, seatAfter } from './positions'
import { buildPots, returnUncalled } from './pots'
import { EngineError } from './types'
import type {
  Award,
  BettingStreet,
  HandConfig,
  HandState,
  LegalActions,
  PlayerAction,
  SeatId,
  SeatState,
} from './types'

const seatIds = (state: HandState) => state.config.seats.map((s) => s.seat)
const player = (state: HandState, seat: SeatId) => {
  const found = state.players.find((p) => p.seat === seat)
  if (!found) throw new EngineError(`No player in seat ${seat}`)
  return found
}
const currentBet = (state: HandState) => {
  // A short blind changes its contribution, not the multiway bring-in.
  // With only one player able to bet, match actual chips instead (also HU).
  const bringIn =
    state.street === 'preflop' &&
    state.players.filter((p) => !p.folded && !p.allIn).length > 1
      ? state.config.blinds.bb
      : 0
  return Math.max(bringIn, ...state.players.map((p) => p.bet))
}

/** Total chips in the middle, current street bets included. */
export const potTotal = (state: HandState) =>
  state.players.reduce((sum, p) => sum + p.invested, 0)

export const isOver = (state: HandState) => state.street === 'showdown'

/**
 * Copies what a transition mutates. Config, deck, recorded actions and hole
 * cards are never mutated after creation, so they are shared: states are
 * values, and this is several times faster than structuredClone.
 */
function cloneState(state: HandState): HandState {
  return {
    ...state,
    board: [...state.board],
    players: state.players.map((p) => ({ ...p })),
    actions: [...state.actions],
    pots: state.pots.map((p) => ({
      amount: p.amount,
      eligible: [...p.eligible],
    })),
  }
}

function contribute(p: SeatState, amount: number) {
  p.stack -= amount
  p.bet += amount
  p.invested += amount
  if (p.stack === 0) p.allIn = true
}

function validateConfig(config: HandConfig) {
  const { seats, button, blinds, handNo } = config
  if (!Number.isInteger(handNo) || handNo < 1)
    throw new EngineError('Hand number must be a positive integer')
  // A table has six seats (SeatId 0..5); positionNames labels at most six.
  if (seats.length < 2 || seats.length > 6)
    throw new EngineError('A hand needs 2 to 6 players')
  seats.forEach((s, i) => {
    if (!Number.isInteger(s.seat) || s.seat < 0 || s.seat > 5)
      throw new EngineError('Seats must be integers from 0 to 5')
    if (i > 0 && s.seat <= seats[i - 1].seat)
      throw new EngineError('Seats must be ascending and distinct')
    if (!Number.isInteger(s.stack) || s.stack <= 0)
      throw new EngineError('Every player needs chips to start')
  })
  if (config.sb === undefined && config.bb === undefined) {
    if (!seats.some((s) => s.seat === button))
      throw new EngineError('The button must be a seated player')
  } else validateBlindSeats(config)
  if (
    !Number.isInteger(blinds.sb) ||
    !Number.isInteger(blinds.bb) ||
    blinds.sb <= 0 ||
    blinds.bb < blinds.sb
  )
    throw new EngineError('Blinds must be positive integers with sb ≤ bb')
}

/**
 * Explicit blind seats may put the button on an empty seat and leave the
 * small blind dead (null), so they get their own checks: every placement the
 * ADR amendment 2026-10-10 (Phase 2, "Blinds and button") lists as illegal.
 */
function validateBlindSeats({ seats, button, sb, bb }: HandConfig) {
  const dealt = seats.map((s) => s.seat)
  if (!Number.isInteger(button) || button < 0 || button > 5)
    throw new EngineError('The button must be a seat from 0 to 5')
  if (sb === undefined || bb === undefined)
    throw new EngineError('Explicit blinds need both sb and bb')
  if (!dealt.includes(bb))
    throw new EngineError('The big blind must be dealt in')
  if (sb !== null && !dealt.includes(sb))
    throw new EngineError('A live small blind must be dealt in')
  if (sb === bb)
    throw new EngineError(
      'The small blind and the big blind must be different seats',
    )
  if (dealt.length === 2) {
    if (sb === null || button !== sb)
      throw new EngineError('Heads-up the button posts the small blind')
  } else if (button === sb || button === bb)
    throw new EngineError(
      'With three or more players the button posts no blind',
    )
  // The button comes before the small blind's seat, which comes before the
  // big blind: never between a live small blind and the big blind, and with
  // a dead small blind at least one seat (that blind's) before the big blind.
  if (
    dealt.length > 2 &&
    (sb !== null
      ? ringDistance(sb, button) < ringDistance(sb, bb)
      : ringDistance(button, bb) < 2)
  )
    throw new EngineError('The button must come before the small blind')
  // A player dealt in between a live small blind and the big blind is one
  // the big blind skipped on its way round.
  if (sb !== null && seatAfter(dealt, sb) !== bb)
    throw new EngineError(
      'The big blind must be the next player after the small blind',
    )
}

/** Deals a hand from `deck` (52 slots; see dealSlots) and posts the blinds. */
export function startHand(config: HandConfig, deck: number[]): HandState {
  validateConfig(config)
  if (!isValidDeck(deck, true)) throw new EngineError('Invalid deck')
  const slots = dealSlots(config)
  const state: HandState = {
    config: structuredClone(config),
    street: 'preflop',
    board: [],
    deck: [...deck],
    players: config.seats.map(({ seat, stack }) => ({
      seat,
      stack,
      bet: 0,
      invested: 0,
      folded: false,
      allIn: false,
      actedSeq: -1,
      actedBet: 0,
      cards: [deck[slots.holes[seat][0]], deck[slots.holes[seat][1]]],
      shown: false,
    })),
    toAct: null,
    lastRaise: config.blinds.bb,
    raiseSeq: 0,
    actions: [],
    pots: [],
  }
  // A dead small blind (null) posts nothing; the big blind always posts.
  const { sb, bb } =
    config.bb === undefined
      ? blindSeats(seatIds(state), config.button)
      : { sb: config.sb ?? null, bb: config.bb }
  if (sb !== null) {
    const small = player(state, sb)
    contribute(small, Math.min(config.blinds.sb, small.stack))
  }
  const big = player(state, bb)
  contribute(big, Math.min(config.blinds.bb, big.stack))
  return advance(state, bb)
}

function mustAct(p: SeatState, bet: number) {
  return !p.folded && !p.allIn && (p.bet < bet || p.actedSeq < 0)
}

function roundClosed(state: HandState) {
  const live = state.players.filter((p) => !p.folded)
  if (live.length <= 1) return true
  const active = live.filter((p) => !p.allIn)
  if (active.length === 0) return true
  const bet = currentBet(state)
  if (active.length === 1) {
    // One player left with chips behind: nothing to decide unless they still
    // owe chips to an all-in bet.
    const [only] = active
    const others = Math.max(
      0,
      ...live.filter((p) => p !== only).map((p) => p.bet),
    )
    if (only.bet >= others) return true
  }
  return !live.some((p) => mustAct(p, bet))
}

/** Moves to the next seat that must act after `from`, or closes the round. */
function advance(state: HandState, from: SeatId): HandState {
  if (!roundClosed(state)) {
    const bet = currentBet(state)
    const next = clockwiseFrom(seatIds(state), from).find((seat) =>
      mustAct(player(state, seat), bet),
    )
    if (next === undefined) throw new EngineError('No seat can act')
    state.toAct = next
    return state
  }
  return closeRound(state)
}

function dealBoard(state: HandState, count: number) {
  const slots = dealSlots(state.config).board
  for (let i = 0; i < count; i++) {
    const card = state.deck[slots[state.board.length]]
    if (card === undefined || card < 0)
      throw new EngineError('Board card unknown in this deck')
    state.board.push(card)
  }
}

function closeRound(state: HandState): HandState {
  returnUncalled(state.players)
  state.pots = buildPots(state.players)
  for (const p of state.players) {
    p.bet = 0
    p.actedSeq = -1
    p.actedBet = 0
  }
  state.toAct = null
  const live = state.players.filter((p) => !p.folded)
  if (live.length === 1) return settle(state, false)
  const active = live.filter((p) => !p.allIn)
  if (active.length <= 1 || state.street === 'river') {
    for (const p of live) p.shown = true
    dealBoard(state, 5 - state.board.length)
    return settle(state, true)
  }
  dealBoard(state, state.street === 'preflop' ? 3 : 1)
  state.street =
    state.street === 'preflop'
      ? 'flop'
      : state.street === 'flop'
        ? 'turn'
        : 'river'
  state.lastRaise = state.config.blinds.bb
  state.raiseSeq = 0
  return advance(state, state.config.button)
}

function settle(state: HandState, showdown: boolean): HandState {
  const seats = seatIds(state)
  // Distance clockwise from the first seat after the button: odd chips go to
  // tied winners in this order (heads-up that is the big blind first).
  const order = clockwiseFrom(seats, state.config.button)
  const rank = (seat: SeatId) => order.indexOf(seat)
  const scores = new Map<SeatId, number>()
  if (showdown)
    for (const p of state.players) {
      if (p.folded) continue
      const cards = [...p.cards!, ...state.board]
      if (cards.some((c) => c < 0))
        throw new EngineError(`Seat ${p.seat} reached showdown unknown`)
      scores.set(p.seat, score(cards, 7))
    }
  const awards: Award[] = []
  for (let i = state.pots.length - 1; i >= 0; i--) {
    const pot = state.pots[i]
    let winners = pot.eligible
    if (showdown) {
      const best = Math.max(...winners.map((s) => scores.get(s)!))
      winners = winners.filter((s) => scores.get(s) === best)
    }
    winners = [...winners].sort((a, b) => rank(a) - rank(b))
    const share = Math.floor(pot.amount / winners.length)
    const odd = pot.amount - share * winners.length
    winners.forEach((seat, w) =>
      awards.push({
        pot: i,
        seat,
        amount: share + (w < odd ? 1 : 0),
        score: scores.get(seat) ?? 0,
      }),
    )
  }
  const netBySeat: Record<SeatId, number> = {}
  for (const p of state.players) {
    const won = awards
      .filter((a) => a.seat === p.seat)
      .reduce((sum, a) => sum + a.amount, 0)
    p.stack += won
    netBySeat[p.seat] = won - p.invested
  }
  state.street = 'showdown'
  state.toAct = null
  state.result = { awards, netBySeat, showdown }
  return state
}

export function legalActions(state: HandState): LegalActions {
  if (state.toAct === null) throw new EngineError('Nobody is to act')
  const me = player(state, state.toAct)
  const bet = currentBet(state)
  const toCall = Math.min(bet - me.bet, me.stack)
  const opponents = state.players.filter((p) => p !== me && !p.folded)
  // No raise above what the deepest opponent can match; heads-up this is
  // exactly poker.ts's effective-stack cap.
  const maxRaiseTo = Math.min(
    me.bet + me.stack,
    Math.max(0, ...opponents.map((p) => p.bet + p.stack)),
  )
  return {
    seat: me.seat,
    toCall,
    canCheck: toCall === 0,
    // A seat that has acted may raise again only after a full raise, or
    // after short all-ins that together come to one (bet - actedBet).
    canRaise:
      maxRaiseTo > bet &&
      (me.actedSeq < state.raiseSeq || bet - me.actedBet >= state.lastRaise),
    minRaiseTo: Math.min(maxRaiseTo, bet + state.lastRaise),
    maxRaiseTo,
  }
}

/**
 * Applies `action` for `seat`. Throws EngineError, leaving `previous`
 * untouched, for a wrong seat or anything outside legalActions. Folding is
 * always allowed, as in poker.ts.
 */
export function act(
  previous: HandState,
  seat: SeatId,
  action: PlayerAction,
): HandState {
  if (isOver(previous)) throw new EngineError('This hand has ended')
  if (previous.toAct !== seat) throw new EngineError('Not your turn')
  const legal = legalActions(previous)
  const bet = currentBet(previous)
  if (action.type === 'check' && !legal.canCheck)
    throw new EngineError('Cannot check facing a bet')
  if (action.type === 'call' && legal.canCheck)
    throw new EngineError('No bet to call')
  if (
    action.type === 'raise' &&
    (!legal.canRaise ||
      !Number.isInteger(action.to) ||
      action.to < legal.minRaiseTo ||
      action.to > legal.maxRaiseTo)
  )
    throw new EngineError('Illegal raise size')
  if (!['fold', 'check', 'call', 'raise'].includes(action.type))
    throw new EngineError('Unknown action')

  const state = cloneState(previous)
  const me = player(state, seat)
  state.actions.push({
    seat,
    action:
      action.type === 'raise'
        ? { type: 'raise', to: action.to }
        : { type: action.type },
    street: state.street as BettingStreet,
    boardCount: state.board.length,
    amount:
      action.type === 'raise'
        ? action.to
        : action.type === 'call'
          ? legal.toCall
          : 0,
    toCall: legal.toCall,
    pot: potTotal(state),
    canRaise: legal.canRaise,
  })
  if (action.type === 'fold') {
    me.folded = true
    // Earlier streets' pots stay accurate mid-street: a folder can win none.
    for (const pot of state.pots)
      pot.eligible = pot.eligible.filter((s) => s !== seat)
  } else if (action.type === 'call') contribute(me, legal.toCall)
  else if (action.type === 'raise') {
    const increment = action.to - bet
    contribute(me, action.to - me.bet)
    // A full raise reopens the betting; a short all-in only has to be called.
    if (increment >= state.lastRaise) {
      state.lastRaise = increment
      state.raiseSeq++
    }
  }
  me.actedSeq = state.raiseSeq
  me.actedBet = currentBet(state)
  return advance(state, seat)
}

/** Every intermediate state: before each action, then the final state. */
export function replayHand(
  config: HandConfig,
  deck: number[],
  actions: { seat: SeatId; action: PlayerAction }[],
): HandState[] {
  const states = [startHand(config, deck)]
  for (const { seat, action } of actions)
    states.push(act(states[states.length - 1], seat, action))
  return states
}

/** Throws when the state breaks a rule no transition may break. */
export function assertInvariants(state: HandState, chipsInPlay: number) {
  const fail = (why: string) => {
    throw new EngineError(`Invariant: ${why}`)
  }
  const stacks = state.players.reduce((s, p) => s + p.stack, 0)
  const bets = state.players.reduce((s, p) => s + p.bet, 0)
  const pots = state.pots.reduce((s, p) => s + p.amount, 0)
  if (state.result) {
    if (stacks !== chipsInPlay) fail('chips not conserved at settlement')
    const awarded = state.result.awards.reduce((s, a) => s + a.amount, 0)
    if (awarded !== pots) fail('awards do not add up to the pots')
    const net = Object.values(state.result.netBySeat).reduce((s, n) => s + n, 0)
    if (net !== 0) fail('net results do not sum to zero')
  } else {
    if (stacks + bets + pots !== chipsInPlay) fail('chips not conserved')
    if (pots + bets !== potTotal(state)) fail('pots do not match investments')
  }
  for (const p of state.players) {
    if (!Number.isInteger(p.stack) || p.stack < 0) fail('bad stack')
    if (!state.result && !p.folded && p.allIn !== (p.stack === 0))
      fail('all-in flag disagrees with the stack')
  }
  for (const pot of state.pots)
    for (const seat of pot.eligible)
      if (player(state, seat).folded) fail('folded seat is eligible')
  const seen = new Set<number>()
  for (const card of [
    ...state.players.flatMap((p) => p.cards ?? []),
    ...state.board,
  ]) {
    if (card < 0) continue
    if (seen.has(card)) fail('duplicate card')
    seen.add(card)
  }
  if (!state.result && state.toAct === null)
    fail('live hand with nobody to act')
}
