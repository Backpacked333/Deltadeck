// Test-only: a WebSocket stand-in the tests drive by hand, and server frames
// built from real engine states.
import {
  commitDeck,
  dealSlots,
  publicSlots,
  revealSlots,
  toBase64,
} from '../engine/deck'
import { act, isOver, startHand } from '../engine/hand'
import { seatView } from '../engine/redact'
import { config, deckWith } from '../engine/testing'
import type { HandConfig, HandState, SeatId } from '../engine/types'
import type {
  GameRow,
  HandRecordV1,
  InviteRequest,
  JoinStatusState,
  LobbyMsg,
  MatchInfo,
  Reveal,
  ServerMsg,
} from '../shared/protocol'

/** A lobby frame without its `seq`, which only counts them. */
export type LobbyBody = LobbyMsg extends infer M
  ? M extends unknown
    ? Omit<M, 'seq'>
    : never
  : never

export class FakeSocket {
  static all: FakeSocket[] = []
  /** Frames sent, as the client wrote them. Heartbeat pings are not here. */
  sent: string[] = []
  /**
   * Heartbeat pings, apart from `sent`: a ping is not JSON, so every test
   * that parses what the client wrote would trip on one, and none of them is
   * about the heartbeat.
   */
  pings: string[] = []
  /** Answer each ping with a pong at once, as the Worker's auto-response does. */
  answerPings = true
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: ((e: { code: number; reason: string }) => void) | null = null
  closedWith: number | null = null
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    FakeSocket.all.push(this)
  }
  send(data: string) {
    if (data === 'ping') {
      this.pings.push(data)
      if (this.answerPings && this.readyState === 1) this.pong()
      return
    }
    this.sent.push(data)
  }
  close(code = 1000) {
    this.closedWith = code
  }
  // Driven by tests:
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  emit(msg: ServerMsg) {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }
  /** A frame as the lobby sends it (`seq` is the lobby's own count). */
  emitLobby(msg: LobbyBody) {
    this.onmessage?.({ data: JSON.stringify({ seq: 1, ...msg }) })
  }
  /** Text exactly as given: the heartbeat's reply is not JSON. */
  emitRaw(data: string) {
    this.onmessage?.({ data })
  }
  pong() {
    this.emitRaw('pong')
  }
  drop(code = 1006, reason = '') {
    this.readyState = 3
    this.onclose?.({ code, reason })
  }
  static last() {
    return FakeSocket.all[FakeSocket.all.length - 1]
  }
}

export const MATCH = '33333333-3333-4333-8333-333333333333'

export const tableInfo = (
  players = 2,
  status: MatchInfo['status'] = 'playing',
): MatchInfo => ({
  kind: 'hu-casual',
  status,
  handsTotal: 20,
  players: [
    { seat: 0, username: 'alice', connected: true, consecutiveTimeouts: 0 },
    { seat: 1, username: 'bob', connected: true, consecutiveTimeouts: 0 },
  ].slice(0, players),
})

/** Hand 1 with fixed cards: alice (seat 0) has the button and acts first. */
export function firstHand(): HandState {
  const cfg = config([2000, 2000], 0)
  return startHand(
    cfg,
    deckWith(cfg, { 0: 'As Kd', 1: '7c 2h' }, '2c 7d 9h Tc 3s'),
  )
}

export function frame(
  kind: 'welcome' | 'state',
  seq: number,
  seat: SeatId,
  hand: HandState | null,
  lastReqId: string | null = null,
): ServerMsg {
  const table = tableInfo()
  const view = hand
    ? seatView(hand, seat, {
        matchId: MATCH,
        match: table,
        clock: null,
        lastReqId,
        commitment: null,
      })
    : null
  const base = { seq, matchId: MATCH, serverNow: 0, table, view }
  return kind === 'welcome'
    ? { ...base, t: 'welcome', seat }
    : { ...base, t: 'state' }
}

/**
 * Hand 1 played to showdown with a real commitment and reveal, as the
 * server would send it: the frames for each seat and what a seat should see.
 */
export async function finishedHand({ fold = false } = {}) {
  const cfg = config([2000, 2000], 0)
  const deck = deckWith(cfg, { 0: 'As Kd', 1: '7c 2h' }, '2c 7d 9h Tc 3s')
  const secret = new Uint8Array(32).fill(5)
  let hand = startHand(cfg, deck)
  hand = act(hand, 0, fold ? { type: 'fold' } : { type: 'call' })
  while (!isOver(hand)) hand = act(hand, hand.toAct!, { type: 'check' })
  const { commitment, leaves } = await commitDeck(deck, secret)
  const shown = hand.players
    .filter((p) => p.shown)
    .map((p) => ({ seat: p.seat, cards: p.cards! }))
  const record: HandRecordV1 = {
    v: 1,
    matchId: MATCH,
    handNo: 1,
    segment: 1,
    config: cfg,
    seats: [
      { seat: 0, userId: 'alice', username: 'alice' },
      { seat: 1, userId: 'bob', username: 'bob' },
    ],
    commitment,
    actions: hand.actions.map((a) => ({
      ...a,
      atMs: 0,
      decisionMs: 1500,
      source: 'client' as const,
    })),
    board: hand.board,
    shown,
    awards: hand.result!.awards,
    netBySeat: hand.result!.netBySeat,
    showdown: hand.result!.showdown,
  }
  const reveal: Reveal = {
    handNo: 1,
    leaves: toBase64(leaves),
    slots: await revealSlots(
      deck,
      secret,
      publicSlots({ config: cfg, board: hand.board, shown }),
    ),
    // Seat 0's view: its own hole slots, opened for it alone.
    own: await revealSlots(deck, secret, dealSlots(cfg).holes[0]),
  }
  const base = { seq: 9, matchId: MATCH }
  const frames = {
    start: {
      ...base,
      seq: 1,
      t: 'hand_start',
      handNo: 1,
      commitment,
      button: 0,
      blinds: cfg.blinds,
      stacks: [1990, 1980],
    } as ServerMsg,
    end: { ...base, t: 'hand_end', handNo: 1, record } as ServerMsg,
    reveal: { ...base, t: 'reveal', ...reveal } as ServerMsg,
  }
  return { hand, record, reveal, commitment, frames }
}

// ---- Six-casual ---------------------------------------------------------------

/** Who sits where at the test six table: seats 1 and 4 are empty. */
export const SIX_ROSTER: { seat: SeatId; username: string; stack: number }[] = [
  { seat: 0, username: 'bob', stack: 2000 },
  { seat: 2, username: 'alice', stack: 2000 },
  { seat: 3, username: 'carol', stack: 1500 },
  { seat: 5, username: 'dave', stack: 3000 },
]

/**
 * A six-casual table summary. Stacks are outside the hand being played:
 * as of its deal for a player dealt in, else what the next hand deals.
 */
export const sixInfo = (
  roster = SIX_ROSTER,
  status: MatchInfo['status'] = 'playing',
): MatchInfo => ({
  kind: 'six-casual',
  status,
  players: roster.map(({ seat, username, stack }) => ({
    seat,
    username,
    connected: true,
    consecutiveTimeouts: 0,
    stack,
    status: 'playing' as const,
  })),
})

/**
 * Hand 1 at the six table: bob (seat 0) has the button, alice (seat 2)
 * posts the small blind and carol (seat 3) the big; dave (seat 5) is first
 * to act. alice holds As Kd; the others' cards must never reach her.
 * `stacks`, `holes` and `board` replace the roster's stacks and those cards.
 */
export function sixHand({
  stacks = {},
  holes = { 0: '7c 2h', 2: 'As Kd', 3: 'Qs Qh', 5: '9d 8d' },
  board = '2c 7d 9h Tc 3s',
}: {
  stacks?: Partial<Record<SeatId, number>>
  holes?: Record<number, string>
  board?: string
} = {}): HandState {
  const cfg: HandConfig = {
    handNo: 1,
    seats: SIX_ROSTER.map(({ seat, stack }) => ({
      seat,
      stack: stacks[seat] ?? stack,
    })),
    button: 0,
    blinds: { sb: 10, bb: 20 },
    sb: 2,
    bb: 3,
  }
  return startHand(cfg, deckWith(cfg, holes, board))
}

/**
 * A six-table frame as the server builds it: `seat` is where this account
 * sits now (null: no seat, so no view), `dealt` the seat it was dealt into
 * in `hand` (null: it sat down after the deal).
 */
export function sixFrame(
  kind: 'welcome' | 'state',
  seq: number,
  seat: SeatId | null,
  dealt: SeatId | null,
  hand: HandState | null,
  {
    table = sixInfo(),
    lastReqId = null,
    leaving = false,
  }: { table?: MatchInfo; lastReqId?: string | null; leaving?: boolean } = {},
): ServerMsg {
  const view =
    hand && seat !== null
      ? seatView(hand, dealt, {
          matchId: MATCH,
          match: table,
          clock: null,
          lastReqId,
          commitment: null,
        })
      : null
  const base = {
    seq,
    matchId: MATCH,
    serverNow: 0,
    table,
    view,
    ...(leaving ? { leaving: true as const } : {}),
  }
  return kind === 'welcome'
    ? { ...base, t: 'welcome', seat }
    : { ...base, t: 'state' }
}

// ---- Live games ---------------------------------------------------------------

/** A 32-hex list handle: `n` picks which. */
export const gameId = (n = 1) => n.toString(16).padStart(32, '0')

export const gameRow = (
  n = 1,
  host = 'carol',
  openForMs = 180_000,
): GameRow => ({ gameId: gameId(n), host, openForMs })

export const gamesFrame = (games: GameRow[]): LobbyBody => ({
  t: 'games',
  games,
})

export const joinStatusFrame = (
  state: JoinStatusState,
  expiresInMs?: number,
): LobbyBody => ({
  t: 'join_status',
  state,
  ...(expiresInMs === undefined ? {} : { expiresInMs }),
})

/** The host-only invite frame, as the table sends it while it waits. */
export const inviteFrame = (
  seq: number,
  {
    code = 'ABC234',
    listed = false,
    requests = [],
    reservedFor = null,
  }: {
    code?: string | null
    listed?: boolean
    requests?: InviteRequest[]
    reservedFor?: string | null
  } = {},
): ServerMsg => ({
  t: 'invite',
  seq,
  matchId: MATCH,
  code,
  listed,
  requests,
  reservedFor,
})
