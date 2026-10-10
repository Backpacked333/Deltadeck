// The only serializer of table state for a client. Every frame a seat receives
// is built here, so card privacy is one function with one test suite.
import type { SeatedView, SeatView } from '../shared/protocol'
import { legalActions, potTotal } from './hand'
import type { HandState, SeatId } from './types'

export type ViewExtras = Pick<
  SeatView,
  'matchId' | 'match' | 'clock' | 'lastReqId' | 'commitment'
>

/**
 * What `viewer` may see: their own cards, cards shown at showdown, and public
 * betting. Other hole cards, the deck and the engine's bookkeeping
 * (raiseSeq, actedSeq, actedBet) never appear. A null viewer was not dealt
 * into the hand: it sees what every seat sees of the others, and no moves.
 */
export function seatView(
  state: HandState,
  viewer: SeatId,
  extras: ViewExtras,
): SeatedView
export function seatView(
  state: HandState,
  viewer: SeatId | null,
  extras: ViewExtras,
): SeatView
export function seatView(
  state: HandState,
  viewer: SeatId | null,
  extras: ViewExtras,
): SeatView {
  const { sb, bb } = state.config
  const view: SeatView = {
    matchId: extras.matchId,
    handNo: state.config.handNo,
    you: viewer,
    button: state.config.button,
    // Six-casual hands name their blind seats; heads-up views keep their
    // exact keys and bytes without them.
    ...(bb !== undefined ? { sb: sb ?? null, bb } : {}),
    street: state.street,
    board: [...state.board],
    commitment: extras.commitment,
    match: structuredClone(extras.match),
    pot: {
      total: potTotal(state),
      layers: state.pots.map((p) => ({
        amount: p.amount,
        eligible: [...p.eligible],
      })),
    },
    toAct: state.toAct,
    legal:
      viewer !== null && state.toAct === viewer ? legalActions(state) : null,
    lastRaise: state.lastRaise,
    actions: state.actions.map((a) => ({
      seat: a.seat,
      action: { ...a.action },
      street: a.street,
      boardCount: a.boardCount,
      amount: a.amount,
      toCall: a.toCall,
      pot: a.pot,
      canRaise: a.canRaise,
    })),
    clock: extras.clock ? { ...extras.clock } : null,
    players: state.players.map((p) => ({
      seat: p.seat,
      stack: p.stack,
      bet: p.bet,
      invested: p.invested,
      folded: p.folded,
      allIn: p.allIn,
      cards:
        (p.seat === viewer || p.shown) && p.cards
          ? [p.cards[0], p.cards[1]]
          : null,
      shown: p.shown,
    })),
    lastReqId: extras.lastReqId,
  }
  if (state.result)
    view.result = {
      awards: state.result.awards.map((a) => ({ ...a })),
      netBySeat: { ...state.result.netBySeat },
      showdown: state.result.showdown,
    }
  return view
}
