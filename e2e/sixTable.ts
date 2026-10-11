import type { Page } from '@playwright/test'
import { act, isOver, legalActions, startHand } from '../src/engine/hand'
import { nextBlinds } from '../src/engine/positions'
import { seatView } from '../src/engine/redact'
import { deckWith, seededDeck } from '../src/engine/testing'
import type {
  HandConfig,
  HandState,
  PlayerAction,
  Street,
} from '../src/engine/types'
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

const CALL = { type: 'call' } as const
const CHECK = { type: 'check' } as const
/**
 * The hand up to the river with two side pots, every seat's move scripted,
 * the viewer's included: evangeline_marten is all in for 940 pre-flop and
 * bartholomew_99 for 1,500 on the flop, and the turn is bet and called.
 * The main pot is 5,640 between all six, side pot 1 2,800 between five
 * and side pot 2 800 between four, and the viewer is to act.
 */
const SIDE_POTS: [number, PlayerAction][] = [
  [2, CALL],
  [3, CALL],
  [4, { type: 'raise', to: 940 }],
  [5, CALL],
  [0, CALL],
  [1, CALL],
  [2, CALL],
  [3, CALL],
  [0, CHECK],
  [1, CHECK],
  [2, CHECK],
  [3, { type: 'raise', to: 560 }],
  [5, CALL],
  [0, CALL],
  [1, CALL],
  [2, CALL],
  [0, CHECK],
  [1, { type: 'raise', to: 200 }],
  [2, CALL],
  [5, CALL],
  [0, CALL],
]

/**
 * A 3-way all-in with two side pots, for the frame test (P2-06b). The
 * button is bartholomew_99's, so the viewer acts first and folds, and so
 * do the others not in it; ozymandias_kings brings 2,600 here, not 23,020.
 * evangeline_marten is all in for 940 pre-flop, bartholomew_99 for 1,500
 * on the flop and ozymandias_kings for 2,600 on the turn, each called by
 * maximilian_okafor, who covers them all; the river runs out. Each street
 * closes with three or four bets to gather, and the result pays three
 * pots to three seats: side pot 2 (2,200) to maximilian_okafor's queens,
 * side pot 1 (1,680) to bartholomew_99's kings and the main pot (3,760)
 * to evangeline_marten's aces, the order the chips go out in. The engine
 * runs a board out in the act that closes the betting, as a real table
 * does, so every frame here is one a real table could send: the street
 * by street pace comes from the all-ins landing on successive streets.
 * `RUNOUT_DEALT`: played before the page connects, bartholomew_99 to act.
 */
const RUNOUT_STACKS: Record<number, number> = { 5: 2600 }
const RUNOUT_HOLES = {
  0: 'Td 6s',
  1: 'Qs Qh',
  2: '5d 5s',
  3: 'Ks Kh',
  4: 'As Ah',
  5: '7c 2d',
}
const RUNOUT_BOARD = '3c 8d 9s 4h Jc'
const FOLD = { type: 'fold' } as const
const RUNOUT_DEALT: [number, PlayerAction][] = [
  [0, FOLD],
  [1, CALL],
  [2, FOLD],
]
const RUNOUT: [number, PlayerAction][] = [
  [3, CALL],
  [4, { type: 'raise', to: 940 }],
  [5, CALL],
  [1, CALL],
  [3, CALL],
  [5, CHECK],
  [1, CHECK],
  [3, { type: 'raise', to: 560 }],
  [5, CALL],
  [1, CALL],
  [5, { type: 'raise', to: 1100 }],
  [1, CALL],
]
/**
 * Between the runout's moves: quick players, so the test stays short, but
 * slow enough that each street's chips land before the next street's fly.
 */
const RUNOUT_STEP_MS = 600
/**
 * The hand after RUNOUT, which `nextHand()` deals NEXT_HAND_MS after its
 * result. ozymandias_kings has no chips left and sits out, so the standard
 * dead button (nextBlinds) puts the big blind on the viewer, leaves the
 * small blind dead and the button on evangeline_marten's seat.
 * maximilian_okafor raises to 60 and the others fold to the viewer, whose
 * move it is; when she folds, the blinds go in and the pot goes to him.
 */
const NEXT_HAND: [number, PlayerAction][] = [
  [1, { type: 'raise', to: 60 }],
  [2, FOLD],
  [3, FOLD],
  [4, FOLD],
]
/** The table's pause after a result (NEXT_HAND_MS, worker/src/table.ts). */
const NEXT_HAND_MS = 3000

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
 * `sidePots`: play SIDE_POTS instead of `street`, to the river with a main
 * pot and two side pots (P2-06a). `split`: deal a royal flush on the board,
 * which plays for everyone, so every pot is split between all who can win
 * it and the result names each of them with their share. `runout`: deal
 * RUNOUT instead, played up to bartholomew_99's first move; `runout()` then
 * plays the rest, one move every RUNOUT_STEP_MS, and resolves once the
 * result is sent; a player it leaves with no chips sits out, as at the
 * table. `nextHand()` then deals NEXT_HAND and plays it, at the same pace,
 * up to the viewer's move.
 */
export async function fakeSixTable(
  page: Page,
  {
    street = 'preflop',
    hold = false,
    away = [],
    sidePots = false,
    split = false,
    runout = false,
  }: {
    street?: Street
    hold?: boolean
    away?: number[]
    sidePots?: boolean
    split?: boolean
    runout?: boolean
  } = {},
) {
  const config: HandConfig = runout
    ? {
        handNo: 1,
        seats: SEATS.map(({ stack }, seat) => ({
          seat,
          stack: RUNOUT_STACKS[seat] ?? stack,
        })),
        button: 3,
        blinds: { sb: 10, bb: 20 },
        sb: 4,
        bb: 5,
      }
    : {
        handNo: 1,
        seats: SEATS.map(({ stack }, seat) => ({ seat, stack })),
        button: 5,
        blinds: { sb: 10, bb: 20 },
        sb: 0,
        bb: 1,
      }
  /** The roster's stacks: as of the deal, then as the hand left them. */
  const stacks = config.seats.map(({ stack }) => stack)
  let settled = false
  /** Others the runout left with no chips, sitting out until a rebuy. */
  const busted = new Set<number>()
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
              status:
                seat === 0
                  ? status
                  : busted.has(seat)
                    ? ('sitting_out' as const)
                    : ('playing' as const),
            },
          ],
    ),
  })
  let hand: HandState = startHand(
    config,
    runout
      ? deckWith(config, RUNOUT_HOLES, RUNOUT_BOARD)
      : split
        ? deckWith(config, {}, 'As Ks Qs Js Ts')
        : seededDeck(2026),
  )
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
  if (runout)
    for (const [seat, action] of RUNOUT_DEALT) hand = act(hand, seat, action)
  else if (sidePots)
    for (const [seat, action] of SIDE_POTS) hand = act(hand, seat, action)
  else {
    others()
    while (hand.street !== street) {
      hand = passive(hand)
      others()
    }
  }

  const frame = (t: 'welcome' | 'state'): ServerMsg => {
    if (isOver(hand) && !settled) {
      for (const p of hand.players) {
        stacks[p.seat] = p.stack
        if (runout && p.seat !== 0 && !p.stack) busted.add(p.seat)
      }
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
  let socketSend: ((msg: ServerMsg) => void) | null = null
  await page.routeWebSocket(/\/ws\/table\//, (ws) => {
    const send = (msg: ServerMsg) => ws.send(JSON.stringify(msg))
    socketSend = send
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
  /** The rest of RUNOUT, a frame per move, as the table would send them. */
  const playRunout = async () => {
    const send = socketSend
    if (!runout || !send) throw new Error('No runout table is connected')
    for (const [seat, action] of RUNOUT) {
      await new Promise((done) => setTimeout(done, RUNOUT_STEP_MS))
      hand = act(hand, seat, action)
      send(frame('state'))
    }
    if (!isOver(hand)) throw new Error('The runout script left the hand open')
  }
  /** NEXT_HAND, dealt as the table deals it, up to the viewer's move. */
  const playNextHand = async () => {
    const send = socketSend
    if (!runout || !send || !isOver(hand) || config.sb == null)
      throw new Error('No runout has ended')
    await new Promise((done) => setTimeout(done, NEXT_HAND_MS))
    const dealt = config.seats
      .map(({ seat }) => seat)
      .filter((seat) => !busted.has(seat) && stacks[seat] > 0)
    const blinds = nextBlinds(
      {
        button: config.button,
        sb: config.sb,
        bb: config.bb!,
        sbSeat: config.sb,
      },
      dealt,
    )
    hand = startHand(
      {
        handNo: 2,
        seats: dealt.map((seat) => ({ seat, stack: stacks[seat] })),
        button: blinds.button,
        blinds: config.blinds,
        sb: blinds.sb,
        bb: blinds.bb,
      },
      seededDeck(2027),
    )
    settled = false
    send(frame('state'))
    for (const [seat, action] of NEXT_HAND) {
      await new Promise((done) => setTimeout(done, RUNOUT_STEP_MS))
      hand = act(hand, seat, action)
      send(frame('state'))
    }
    if (hand.toAct !== 0) throw new Error('The next hand skipped the viewer')
  }
  return {
    received,
    release,
    runout: playRunout,
    nextHand: playNextHand,
  }
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
