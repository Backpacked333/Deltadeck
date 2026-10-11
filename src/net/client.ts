// One live table connection. The server sends whole redacted snapshots, so
// the client keeps the newest one and never computes game state itself.
import type { PlayerAction, SeatId } from '../engine/types'
import {
  CLOSE_ABUSE,
  CLOSE_ELSEWHERE,
  CLOSE_GONE,
  CLOSE_RATE_LIMITED,
  CLOSE_REPLACED,
  PROTOCOL,
} from '../shared/protocol'
import type {
  ClientMsg,
  ErrorCode,
  HandRecordV1,
  MatchInfo,
  Reveal,
  SeatView,
  ServerMsg,
} from '../shared/protocol'

export type ConnectionStatus =
  | 'connecting'
  | 'open'
  | 'reconnecting'
  /** Another tab took this seat; reconnecting would fight it. */
  | 'replaced'
  /** This account is playing at another table (`elsewhere`). */
  | 'elsewhere'
  /** The table finished long ago or the invite expired; it is gone. */
  | 'closed'
  /** Gave up: no token, or the server kept refusing. */
  | 'failed'

/** What this client saw of one hand, for the review and the deck check. */
export type HandSeen = {
  /** The commitment as first received: before any card of the hand. */
  commitment?: string
  /** True when the commitment arrived after this hand's cards (late join). */
  late?: boolean
  mine?: [number, number]
  record?: HandRecordV1
  reveal?: Reveal
}

/** A finished rated match's rematch offer, as the server last sent it. */
export type RematchView = Omit<
  Extract<ServerMsg, { t: 'rematch_state' }>,
  't' | 'seq' | 'matchId'
>

export type TableState = {
  status: ConnectionStatus
  seat: SeatId | null
  table: MatchInfo | null
  view: SeatView | null
  /** The move sent and not yet acknowledged. */
  pending: string | null
  error: { code: ErrorCode; message: string } | null
  ended: Extract<ServerMsg, { t: 'match_end' }>['result'] | null
  rematch: RematchView | null
  /** Rated, once applied: each seat's rating change. */
  rating: Extract<ServerMsg, { t: 'rating' }>['change'] | null
  /** The table this account is already playing at, when refused here. */
  elsewhere: string | null
  /** Server time minus this device's time, from the latest snapshot. */
  clockOffset: number
  hands: Record<number, HandSeen>
}

const LIMITED = {
  code: 'rate_limited',
  message: 'Too many messages, reconnecting…',
} as const

export const INITIAL_STATE: TableState = {
  status: 'connecting',
  seat: null,
  table: null,
  view: null,
  pending: null,
  error: null,
  ended: null,
  rematch: null,
  rating: null,
  elsewhere: null,
  clockOffset: 0,
  hands: {},
}

type Options = {
  /** ws(s):// origin of the table server; defaults to this page's origin. */
  origin?: string
  WebSocketImpl?: typeof WebSocket
  /** Give up after this many failed connection attempts in a row. */
  maxAttempts?: number
  newRequestId?: () => string
}

export function socketOrigin(location: Location = window.location) {
  const api = import.meta.env.VITE_API_ORIGIN as string | undefined
  const base = api || `${location.protocol}//${location.host}`
  return base.replace(/^http/, 'ws')
}

/**
 * Browsers hide why an upgrade was refused (full table, bad link), so a
 * table that never opened gets a few quick retries, not the full patience.
 */
const NEVER_OPENED_ATTEMPTS = 3

export class TableConnection {
  private state: TableState = INITIAL_STATE
  private listeners = new Set<() => void>()
  private socket: WebSocket | null = null
  private seq = -1
  /**
   * The session `hands` belongs to. A six table's next session numbers its
   * hands from 1 again, under a new matchId; its hands start afresh.
   */
  private handsOf: string | null = null
  private attempts = 0
  /** A table that never accepted us is a bad link or a full table. */
  private everOpened = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private readonly options: Required<Options>

  constructor(
    private readonly matchId: string,
    private readonly getToken: () => Promise<string | null>,
    options: Options = {},
  ) {
    this.options = {
      origin: options.origin ?? socketOrigin(),
      WebSocketImpl: options.WebSocketImpl ?? WebSocket,
      maxAttempts: options.maxAttempts ?? 8,
      newRequestId:
        options.newRequestId ?? (() => crypto.randomUUID().replace(/-/g, '')),
    }
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getState = () => this.state

  start() {
    this.stopped = false
    void this.open()
  }

  stop() {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.socket?.close(1000, 'leaving')
    this.socket = null
  }

  /** Sends a move for the current decision. False if it is not ours to make. */
  act(action: PlayerAction): boolean {
    const { view, seat, pending, status } = this.state
    if (status !== 'open' || !view || pending) return false
    if (view.toAct !== seat || view.street === 'showdown') return false
    const reqId = this.options.newRequestId()
    this.socket!.send(
      JSON.stringify({
        t: 'act',
        reqId,
        handNo: view.handNo,
        actionIndex: view.actions.length,
        action,
      }),
    )
    this.set({ pending: reqId, error: null })
    return true
  }

  /** Asks for a rematch at a finished rated table. */
  rematch(): boolean {
    if (this.state.status !== 'open' || !this.state.rematch) return false
    this.socket!.send(JSON.stringify({ t: 'rematch' }))
    return true
  }

  /**
   * Takes `seat` at a six table. The frame names only the seat: the server
   * seats this socket's account with its own buy-in, and its welcome says
   * where we sit (or an error says why not).
   */
  sit(seat: SeatId): boolean {
    const { status, seat: current } = this.state
    if (status !== 'open' || current !== null) return false
    this.socket!.send(JSON.stringify({ t: 'sit', seat }))
    return true
  }

  /**
   * At a six table: top up to 100 bb from the next hand. The frame is the
   * type alone: the server computes the amount, and its welcome carries
   * the new stack (or an error says why not).
   */
  rebuy(): boolean {
    return this.sendSeated({ t: 'rebuy' })
  }

  /**
   * At a six table: leave the seat, at once between hands, or when the
   * hand this player is dealt into ends (folding when the action reaches
   * them). The wire has no marker of a pending stand; the caller knows.
   */
  stand(): boolean {
    return this.sendSeated({ t: 'stand' })
  }

  /**
   * At a six table: sit out from the next hand, keeping the seat. The
   * frame is the type alone; the welcome carries the new status.
   */
  sitOut(): boolean {
    return this.sendSeated({ t: 'sit_out' })
  }

  /** At a six table, sitting out: be dealt in again from the next hand. */
  sitIn(): boolean {
    return this.sendSeated({ t: 'sit_in' })
  }

  /** Sends a seat-only frame, if this socket is open and has a seat. */
  private sendSeated(
    msg: Extract<ClientMsg, { t: 'rebuy' | 'stand' | 'sit_out' | 'sit_in' }>,
  ) {
    const { status, seat } = this.state
    if (status !== 'open' || seat === null) return false
    this.socket!.send(JSON.stringify(msg))
    return true
  }

  private set(patch: Partial<TableState>) {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }

  private async open() {
    const token = await this.getToken()
    if (this.stopped) return
    if (!token)
      return this.set({
        status: 'failed',
        error: { code: 'unauthorized', message: 'Sign in to play.' },
      })
    const { WebSocketImpl, origin } = this.options
    const socket = new WebSocketImpl(`${origin}/ws/table/${this.matchId}`, [
      PROTOCOL,
      `bearer.${token}`,
    ])
    this.socket = socket
    socket.onopen = () => {
      this.attempts = 0
      this.everOpened = true
      this.set({
        status: 'open',
        ...(this.state.error?.code === 'rate_limited' ? { error: null } : {}),
      })
    }
    socket.onmessage = (event) => {
      try {
        this.receive(JSON.parse(String(event.data)) as ServerMsg)
      } catch {
        // A frame we cannot read is ignored; the next snapshot replaces it.
      }
    }
    socket.onclose = (event) => {
      if (this.socket !== socket || this.stopped) return
      this.socket = null
      if (event.code === CLOSE_REPLACED) return this.set({ status: 'replaced' })
      if (event.code === CLOSE_ELSEWHERE)
        return this.set({ status: 'elsewhere', elsewhere: event.reason })
      if (event.code === CLOSE_GONE) return this.set({ status: 'closed' })
      // Sent too much: the server wants a pause of at least a second.
      const limited =
        event.code === CLOSE_RATE_LIMITED || event.code === CLOSE_ABUSE
      this.attempts++
      const limit = this.everOpened
        ? this.options.maxAttempts
        : NEVER_OPENED_ATTEMPTS
      if (this.attempts > limit)
        return this.set({
          status: 'failed',
          error: {
            code: 'unauthorized',
            message: 'Could not reach the table. Check the link and try again.',
          },
        })
      // 0.5 s, 1 s, 2 s … capped at 8 s; a fresh token each time.
      const backoff = Math.min(8000, 500 * 2 ** (this.attempts - 1))
      const delay = limited ? Math.max(1000, backoff) : backoff
      this.set({
        status: 'reconnecting',
        pending: null,
        ...(limited ? { error: LIMITED } : {}),
      })
      this.timer = setTimeout(() => void this.open(), delay)
    }
  }

  private receive(msg: ServerMsg) {
    if (msg.t === 'error') {
      this.set({
        error: { code: msg.code, message: msg.message },
        pending:
          msg.reqId && msg.reqId === this.state.pending
            ? null
            : this.state.pending,
      })
      return
    }
    if (msg.t === 'match_end') {
      this.set({ ended: msg.result })
      return
    }
    if (msg.t === 'rating') {
      this.set({ rating: msg.change })
      return
    }
    if (msg.t === 'rematch_state') {
      const { state, pressed, until, next } = msg
      this.set({
        rematch: {
          state,
          pressed,
          ...(until !== undefined ? { until } : {}),
          ...(next ? { next } : {}),
        },
      })
      return
    }
    if (msg.t === 'hand_start') {
      this.seen(msg.matchId, msg.handNo, (h) =>
        h.commitment ? h : { ...h, commitment: msg.commitment },
      )
      return
    }
    if (msg.t === 'hand_end') {
      this.seen(msg.matchId, msg.handNo, (h) => ({ ...h, record: msg.record }))
      return
    }
    if (msg.t === 'reveal') {
      const { handNo, leaves, slots, own } = msg
      this.seen(msg.matchId, handNo, (h) => ({
        ...h,
        reveal: { handNo, leaves, slots, ...(own ? { own } : {}) },
      }))
      return
    }
    if (msg.t !== 'welcome' && msg.t !== 'state') return
    // Snapshots can repeat a seq (presence changes) but never go back,
    // except a welcome, which is always the server's current truth.
    if (msg.t === 'state' && msg.seq < this.seq) return
    this.seq = msg.seq
    const pending =
      this.state.pending && msg.view?.lastReqId === this.state.pending
        ? null
        : this.state.pending
    this.set({
      ...(msg.t === 'welcome'
        ? { seat: msg.seat, pending: null }
        : { pending }),
      table: msg.table,
      view: msg.view,
      clockOffset: msg.serverNow - Date.now(),
      hands: msg.view ? this.withView(msg.matchId, msg.view) : this.state.hands,
    })
  }

  /** Keeps our own cards, and a commitment we missed the start frame for. */
  private withView(matchId: string, view: SeatView) {
    const hands = this.handsFor(matchId)
    const h = hands[view.handNo] ?? {}
    const mine = view.players.find((p) => p.seat === view.you)?.cards
    const next: HandSeen = {
      ...h,
      ...(mine && !h.mine ? { mine } : {}),
      ...(!h.commitment && view.commitment
        ? { commitment: view.commitment, late: true }
        : {}),
    }
    return next === h ? hands : { ...hands, [view.handNo]: next }
  }

  /** The hands kept so far, or none when `matchId` starts a new session. */
  private handsFor(matchId: string) {
    if (matchId === this.handsOf) return this.state.hands
    this.handsOf = matchId
    return {}
  }

  private seen(
    matchId: string,
    handNo: number,
    update: (h: HandSeen) => HandSeen,
  ) {
    const before = this.handsFor(matchId)
    const hands = { ...before, [handNo]: update(before[handNo] ?? {}) }
    // A match is at most 100 hands; keep the latest 100 regardless.
    const keys = Object.keys(hands)
      .map(Number)
      .sort((a, b) => a - b)
    for (const old of keys.slice(0, -100)) delete hands[old]
    this.set({ hands })
  }
}
