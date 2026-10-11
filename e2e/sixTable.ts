import type { Page } from '@playwright/test'
import { act, isOver, legalActions, startHand } from '../src/engine/hand'
import { seatView } from '../src/engine/redact'
import { seededDeck } from '../src/engine/testing'
import type { HandConfig, HandState, Street } from '../src/engine/types'
import type {
  ClientMsg,
  ErrorCode,
  MatchInfo,
  ServerMsg,
} from '../src/shared/protocol'

export const SIX_TABLE = '66666666-6666-4666-8666-666666666666'

/**
 * Long names and wide stacks, so the plates are as wide as they get
 * (usernames are at most 20 characters). The viewer is seat 0.
 */
const SEATS = [
  { username: 'you_at_the_bottom', stack: 2000 },
  { username: 'maximilian_okafor', stack: 12400 },
  { username: 'seraphina_lindqvist', stack: 99850 },
  { username: 'bartholomew_99', stack: 1500 },
  { username: 'evangeline_marten', stack: 940 },
  { username: 'ozymandias_kings', stack: 23020 },
]

/**
 * A full six-seat table answered in the browser, with no table server.
 * Six tables cannot be opened over HTTP yet (quick-sit is P2-08), so the
 * page's socket is routed here, and each frame is the redacted view a real
 * table sends, built by the real engine. The viewer sits at seat 0 and
 * posts the small blind; the five others check or call at once. `street`:
 * play check-and-call up to the viewer's first move on that street before
 * the page connects. `received` collects every frame the page sends.
 * `hold`: after each of the viewer's moves (a stand that folds included)
 * the others wait for `release()`, so the page shows someone else to act.
 * Rebuy and stand are answered as the table does (PR-14): a rebuy out of
 * the hand below 100 bb tops up to 2,000; a stand frees the seat at once
 * between hands, or folds the viewer and frees it as the hand ends. Once
 * the hand is over the roster carries the stacks it left. Sit out and sit
 * in are answered as the table does (PR-16): the viewer's roster status
 * changes, and a sit_in with no chips is refused. `away`: seats whose
 * players have dropped (PR-17), so their plates say Disconnected.
 */
export async function fakeSixTable(
  page: Page,
  {
    street = 'preflop',
    hold = false,
    away = [],
  }: { street?: Street; hold?: boolean; away?: number[] } = {},
) {
  const config: HandConfig = {
    handNo: 1,
    seats: SEATS.map(({ stack }, seat) => ({ seat, stack })),
    button: 5,
    blinds: { sb: 10, bb: 20 },
    sb: 0,
    bb: 1,
  }
  /** The roster's stacks: as of the deal, then as the hand left them. */
  const stacks = SEATS.map(({ stack }) => stack)
  let settled = false
  /** The viewer has a seat; they stood during the hand; they sit out. */
  let seated = true
  let standing = false
  let status: 'playing' | 'sitting_out' = 'playing'
  const table = (): MatchInfo => ({
    kind: 'six-casual',
    status: 'playing',
    players: SEATS.flatMap(({ username }, seat) =>
      seat === 0 && !seated
        ? []
        : [
            {
              seat,
              username,
              connected: !away.includes(seat),
              consecutiveTimeouts: 0,
              stack: stacks[seat],
              status: seat === 0 ? status : ('playing' as const),
            },
          ],
    ),
  })
  let hand: HandState = startHand(config, seededDeck(2026))
  let seq = 0
  let lastReqId: string | null = null
  const passive = (state: HandState) =>
    act(state, state.toAct!, {
      type: legalActions(state).canCheck ? 'check' : 'call',
    })
  /**
   * The others' moves, up to the viewer's turn or the end of the hand; a
   * viewer who stood folds when the action reaches them.
   */
  const others = () => {
    while (!isOver(hand) && (hand.toAct !== 0 || standing))
      hand = hand.toAct === 0 ? act(hand, 0, { type: 'fold' }) : passive(hand)
  }
  others()
  while (hand.street !== street) {
    hand = passive(hand)
    others()
  }

  const frame = (t: 'welcome' | 'state'): ServerMsg => {
    if (isOver(hand) && !settled) {
      for (const p of hand.players) stacks[p.seat] = p.stack
      settled = true
    }
    const view = seated
      ? seatView(hand, 0, {
          matchId: SIX_TABLE,
          match: table(),
          // 20 s to decide, then the 30 s bank.
          clock: isOver(hand)
            ? null
            : { deadline: Date.now() + 50_000, bankMs: 30_000 },
          lastReqId,
          commitment: null,
        })
      : null
    const base = { seq: ++seq, matchId: SIX_TABLE, serverNow: Date.now() }
    return t === 'welcome'
      ? { ...base, t, seat: seated ? 0 : null, table: table(), view }
      : { ...base, t, table: table(), view }
  }

  const received: ClientMsg[] = []
  let held: (() => void) | null = null
  await page.routeWebSocket(/\/ws\/table\//, (ws) => {
    const send = (msg: ServerMsg) => ws.send(JSON.stringify(msg))
    const error = (code: ErrorCode, message: string, reqId?: string) =>
      send({
        t: 'error',
        seq,
        matchId: SIX_TABLE,
        code,
        message,
        ...(reqId ? { reqId } : {}),
      })
    /** The others play on; a viewer who stood leaves as the hand ends. */
    const rest = () => {
      others()
      send(frame('state'))
      if (standing && isOver(hand)) {
        standing = false
        seated = false
        send(frame('welcome'))
      }
    }
    send(frame('welcome'))
    ws.onMessage((data) => {
      const msg = JSON.parse(String(data)) as ClientMsg
      received.push(msg)
      if (msg.t === 'rebuy') {
        if (!seated) return error('not_seated', 'You have no seat here')
        if (!isOver(hand))
          return error('in_hand', 'You can rebuy once this hand is over')
        if (stacks[0] >= 2000)
          return error('not_below', 'You already have 100 big blinds')
        stacks[0] = 2000
        return send(frame('welcome'))
      }
      if (msg.t === 'sit_out' || msg.t === 'sit_in') {
        if (!seated) return error('not_seated', 'You have no seat here')
        if (msg.t === 'sit_in' && status === 'sitting_out' && !stacks[0])
          return error('no_chips', 'Rebuy to be dealt in')
        status = msg.t === 'sit_out' ? 'sitting_out' : 'playing'
        return send(frame('welcome'))
      }
      if (msg.t === 'stand') {
        if (!seated) return error('not_seated', 'You have no seat here')
        if (isOver(hand)) {
          seated = false
          return send(frame('welcome'))
        }
        standing = true
        if (hand.toAct === 0) hand = act(hand, 0, { type: 'fold' })
        send(frame('welcome'))
        if (hold) held = rest
        else rest()
        return
      }
      if (msg.t !== 'act') return
      const refuse = (code: 'stale' | 'illegal', message: string) => {
        error(code, message, msg.reqId)
        send(frame('state'))
      }
      if (
        hand.toAct !== 0 ||
        msg.actionIndex !== hand.actions.length ||
        msg.handNo !== hand.config.handNo
      )
        return refuse('stale', 'That decision has passed')
      try {
        hand = act(hand, 0, msg.action)
      } catch (error) {
        return refuse('illegal', String(error))
      }
      lastReqId = msg.reqId
      send(frame('state'))
      if (hold) held = rest
      else rest()
    })
  })
  const release = () => {
    held?.()
    held = null
  }
  return { received, release }
}

/** Signed in with a development token, past the trainer's first visit. */
export async function devSignIn(page: Page, name: string) {
  await page.addInitScript((token) => {
    localStorage.setItem(
      'quantpoker.progress.v2',
      JSON.stringify({ onboarded: true }),
    )
    sessionStorage.setItem('qp.devToken', token)
  }, `dev.${name}.e2e-local-secret-0001`)
}
