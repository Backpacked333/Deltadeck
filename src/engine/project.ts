// Heads-up bridge from the N-player engine to the trainer's Game shape, so the
// existing Table, ActionBar, hand review and grading code can run on a live
// table without changes. The viewer is always player 0 and the opponent
// player 1, as the trainer has "you" and "Atlas".
import { categories } from '../lib/poker'
import type { Card, Game, HistoryEntry, Player } from '../lib/poker'
import { categoryOf, fromId } from '../lib/sim'
import type { SeatedView } from '../shared/protocol'
import { seatView } from './redact'
import type { HandState, SeatId } from './types'

/** Stand-ins for cards the viewer cannot see; Table renders them face down. */
export const FACE_DOWN: [Card, Card] = [
  { rank: 0, suit: 's' },
  { rank: 0, suit: 'h' },
]

const cardsOf = (ids: [number, number] | null): [Card, Card] =>
  ids ? [fromId(ids[0]), fromId(ids[1])] : [...FACE_DOWN]

export function toHeroGame(view: SeatedView, opponentName = 'Opponent'): Game {
  if (view.players.length !== 2) throw new Error('toHeroGame is heads-up only')
  const me = view.players.find((p) => p.seat === view.you)!
  const them = view.players.find((p) => p.seat !== view.you)!
  const index = (seat: SeatId): Player => (seat === view.you ? 0 : 1)
  const pair = <T>(pick: (p: typeof me) => T): [T, T] => [pick(me), pick(them)]

  // poker.ts semantics: acting marks you as having acted; a raise clears the
  // opponent's flag; a new street clears both.
  const acted: [boolean, boolean] = [false, false]
  if (view.street !== 'showdown')
    for (const a of view.actions)
      if (a.street === view.street) {
        acted[index(a.seat)] = true
        if (a.action.type === 'raise')
          acted[index(a.seat) === 0 ? 1 : 0] = false
      }

  const history: HistoryEntry[] = view.actions.map((a) => ({
    player: index(a.seat),
    street: a.street,
    boardCount: a.boardCount,
    action: a.action.type,
    amount: a.amount,
    toCall: a.toCall,
    pot: a.pot,
    canRaise: a.canRaise,
  }))

  const game: Game = {
    id: view.handNo,
    guided: false,
    dealer: index(view.button),
    street: view.street,
    turn: view.toAct === null ? 0 : index(view.toAct),
    cards: [cardsOf(me.cards), cardsOf(them.cards)],
    board: view.board.map(fromId),
    deck: [],
    stacks: pair((p) => p.stack),
    bets: pair((p) => p.bet),
    invested: pair((p) => p.invested),
    acted,
    pot: view.result ? 0 : view.pot.total,
    lastRaise: view.lastRaise,
    log: [],
    history,
  }
  if (view.result) {
    const net = view.result.netBySeat[view.you] ?? 0
    const winner: Player | 'tie' = net > 0 ? 0 : net < 0 ? 1 : 'tie'
    const best = Math.max(0, ...view.result.awards.map((a) => a.score))
    const hand = categories[categoryOf(best)]
    const folder = them.folded ? 1 : me.folded ? 0 : null
    const text = !view.result.showdown
      ? folder === 0
        ? `You fold · ${opponentName} wins`
        : `${opponentName} folds · you win`
      : winner === 'tie'
        ? `Split pot · ${hand}`
        : `${winner === 0 ? 'You win' : `${opponentName} wins`} · ${hand}`
    game.result = { winner, text, net, showdown: view.result.showdown }
  }
  return game
}

/**
 * Server-side projection of a full engine state for one seat, opponent cards
 * included (for grading after the hand; never sent to a client).
 */
export function stateToHeroGame(state: HandState, hero: SeatId): Game {
  const view = seatView(state, hero, {
    matchId: '',
    match: { kind: 'hu-casual', status: 'playing', handsTotal: 0, players: [] },
    clock: null,
    lastReqId: null,
    commitment: null,
  })
  const game = toHeroGame(view)
  const them = state.players.find((p) => p.seat !== hero)!
  if (them.cards && them.cards.every((c) => c >= 0))
    game.cards[1] = cardsOf(them.cards)
  return game
}
