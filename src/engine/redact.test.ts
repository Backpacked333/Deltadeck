// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { lcg } from '../lib/sim'
import type { SeatView } from '../shared/protocol'
import { act, isOver, startHand } from './hand'
import { seatView } from './redact'
import type { ViewExtras } from './redact'
import {
  config,
  deckWith,
  randomAction,
  randomTable,
  withExplicitBlinds,
} from './testing'
import type { HandState } from './types'

const extras: ViewExtras = {
  matchId: 'm1',
  match: {
    kind: 'hu-casual',
    status: 'playing',
    handsTotal: 20,
    players: [],
  },
  clock: { deadline: 1000, bankMs: 60_000 },
  lastReqId: 'r1',
  commitment: 'ab'.repeat(32),
}

// Every key a client may ever receive. Adding a field to SeatView means
// adding it here, on purpose, with a reason it cannot leak a card.
const VIEW_KEYS = [
  'actions',
  'board',
  'button',
  'clock',
  'commitment',
  'handNo',
  'lastRaise',
  'lastReqId',
  'legal',
  'match',
  'matchId',
  'players',
  'pot',
  'street',
  'toAct',
  'you',
]
// Six-casual hands name their blind seats, which every player sees posted
// at the deal: they say where chips went, never what anyone holds.
const SIX_VIEW_KEYS = [...VIEW_KEYS, 'bb', 'sb'].sort()
const PLAYER_KEYS = [
  'allIn',
  'bet',
  'cards',
  'folded',
  'invested',
  'seat',
  'shown',
  'stack',
]

/** Random states across table sizes and streets, all players' cards set. */
function sampleStates(count: number, seed: number) {
  const random = lcg(seed)
  const states: HandState[] = []
  while (states.length < count) {
    const n = 2 + Math.floor(random() * 5)
    const { config: cfg, deck } = randomTable(n, random)
    let state = startHand(cfg, deck)
    states.push(state)
    while (!isOver(state) && states.length < count) {
      state = act(state, state.toAct!, randomAction(state, random))
      if (random() < 0.4) states.push(state)
    }
  }
  return states
}

describe('seatView redaction', () => {
  it('adds only the blind seats for a hand that names them', () => {
    const random = lcg(12)
    for (const state of sampleStates(300, 7)) {
      const named = withExplicitBlinds(state.config, random)
      const six: HandState = { ...state, config: named }
      const view = seatView(six, state.players[0].seat, extras)
      expect(Object.keys(view).sort()).toEqual(
        state.result ? [...SIX_VIEW_KEYS, 'result'].sort() : SIX_VIEW_KEYS,
      )
      expect([view.sb, view.bb]).toEqual([named.sb, named.bb])
      // A hand without them keeps exactly its old keys and bytes.
      expect(
        JSON.stringify(seatView(state, state.players[0].seat, extras)),
      ).not.toMatch(/"(sb|bb)":/)
    }
  })

  it('shows a seatless viewer no hole card but shown ones, and no moves', () => {
    for (const state of sampleStates(2000, 8)) {
      const view = seatView(state, null, extras)
      expect(view.you).toBeNull()
      expect(view.legal).toBeNull()
      for (const p of view.players) {
        const real = state.players.find((q) => q.seat === p.seat)!
        expect(p.cards).toEqual(real.shown ? real.cards : null)
      }
      // The same as any seated viewer sees of everyone else.
      const seated = seatView(state, state.players[0].seat, extras)
      expect(view.players.slice(1)).toEqual(seated.players.slice(1))
      // And unchanged when every unshown hand and the deck change.
      const swapped: HandState = {
        ...state,
        deck: state.deck.map(() => -1),
        players: state.players.map((p) =>
          p.shown ? p : { ...p, cards: [-1, -1] },
        ),
      }
      expect(JSON.stringify(seatView(swapped, null, extras))).toBe(
        JSON.stringify(view),
      )
    }
  })

  it('exposes only allowlisted keys', () => {
    for (const state of sampleStates(300, 5)) {
      const view = seatView(state, state.players[0].seat, extras)
      expect(Object.keys(view).sort()).toEqual(
        state.result ? [...VIEW_KEYS, 'result'].sort() : VIEW_KEYS,
      )
      for (const p of view.players)
        expect(Object.keys(p).sort()).toEqual(PLAYER_KEYS)
      const json = JSON.stringify(view)
      for (const secret of [
        'deck',
        'raiseSeq',
        'actedSeq',
        'actedBet',
        'secret',
        'config',
      ])
        expect(json).not.toContain(`"${secret}"`)
    }
  })

  it('shows your own cards and shown cards, never other hole cards', () => {
    const cfg = config([2000, 2000, 2000])
    let state = startHand(cfg, deckWith(cfg, {}, ''))
    const view = seatView(state, 1, extras)
    expect(view.players.map((p) => p.cards !== null)).toEqual([
      false,
      true,
      false,
    ])
    expect(view.legal).toBeNull()
    expect(seatView(state, 0, extras).legal).not.toBeNull()
    // Check it down: everyone still in is shown at showdown.
    state = act(state, 0, { type: 'call' })
    state = act(state, 1, { type: 'fold' })
    state = act(state, 2, { type: 'check' })
    while (!isOver(state)) state = act(state, state.toAct!, { type: 'check' })
    const end = seatView(state, 1, extras)
    expect(end.players.map((p) => p.cards !== null)).toEqual([true, true, true])
    expect(seatView(state, 0, extras).players[1].cards).toBeNull()
  })

  it('is unchanged when any unseen hole cards or the deck are swapped', () => {
    const random = lcg(99)
    const states = sampleStates(10_000, 6)
    for (const state of states) {
      const viewer =
        state.players[Math.floor(random() * state.players.length)].seat
      const before = JSON.stringify(seatView(state, viewer, extras))
      const visible = new Set([
        ...state.board,
        ...state.players
          .filter((p) => p.seat === viewer || p.shown)
          .flatMap((p) => p.cards!),
      ])
      const pool = Array.from({ length: 52 }, (_, i) => i).filter(
        (c) => !visible.has(c),
      )
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1))
        ;[pool[i], pool[j]] = [pool[j], pool[i]]
      }
      const swapped: HandState = {
        ...state,
        deck: state.deck.map(() => pool[0]),
        players: state.players.map((p) =>
          p.seat === viewer || p.shown
            ? p
            : { ...p, cards: [pool.pop()!, pool.pop()!] },
        ),
      }
      const after: SeatView = seatView(swapped, viewer, extras)
      expect(JSON.stringify(after)).toBe(before)
    }
  })
})
