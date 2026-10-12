// One live table connection. The server sends whole redacted snapshots, so
// the client keeps the newest one and never computes game state itself.
import type { PlayerAction, SeatId } from '../engine/types'
import { GAME_CODE_RE, REQUEST_ID_RE } from '../shared/gameCode'
import {
  CLOSE_ABUSE,
  CLOSE_ELSEWHERE,
  CLOSE_GONE,
  CLOSE_RATE_LIMITED,
  CLOSE_REPLACED,
  GAME_HOST_MAX,
  PROTOCOL,
} from '../shared/protocol'
import type {
  ErrorCode,
  HandRecordV1,
  InviteRequest,
  MatchInfo,
  Reveal,
  SeatView,
  ServerMsg,
  SeatCommandV1,
  CommandOutcomeV1,
  OwnControlV1,
  CancelStartV1,
  HandCompletionV1,
  PresentationStateV1,
} from '../shared/protocol'
import { Heartbeat, RttStore } from './heartbeat'
import { LiveTiming, renderIdentity } from './liveTiming'
import type { TimingSample } from './liveTiming'

export type SeatCommandState = {
  envelope: SeatCommandV1
  phase:
    | 'sending'
    | 'unknown'
    | 'accepted-pending-effect'
    | 'completed'
    | 'rejected'
    | 'stale'
  reason: CommandOutcomeV1['reason'] | null
  retryable: boolean
}
export type StartCancellation = {
  envelope: CancelStartV1
  phase: 'sending' | 'unknown' | 'cancelled' | 'game_started' | 'stale'
}

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

/**
 * What the host's `invite` frame last said (null before one, or at a table
 * that is not an invite table). Never part of `table` or `view`: a seat's
 * snapshot says nothing of codes or requests.
 */
export type InviteState = {
  /** Null once the code is gone: the link still works. */
  code: string | null
  listed: boolean
  requests: InviteRequest[]
  /** The username holding the other seat for a moment after Accept. */
  reservedFor: string | null
  /**
   * When this frame arrived (Date.now), and when `reservedFor` first showed:
   * requests carry their age, and a reservation carries none, and neither
   * lapse is announced by a frame (the table lapses them when next asked),
   * so the page counts them from these.
   */
  at: number
  reservedAt: number | null
  /**
   * The request this host just answered, until the table's next `invite`
   * frame confirms it (or ANSWER_WAIT_MS passes): its buttons wait.
   */
  answering: string | null
}

export type TableState = {
  ownControl: OwnControlV1 | null
  command: SeatCommandState | null
  cancellation: StartCancellation | null
  start: Extract<ServerMsg, { t: 'welcome' }>['start'] | null
  completion: HandCompletionV1 | null
  presentation: PresentationStateV1 | null
  frameTiming: TimingSample | null
  /** A fresh authoritative frame is required before any new command. */
  resyncing: boolean
  /** Changes on resync/wake so obsolete decorative work can be cancelled. */
  presentationEpoch: number
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
  /** Host only, while the invite table waits. */
  invite: InviteState | null
}

const LIMITED = {
  code: 'rate_limited',
  message: 'Too many messages, reconnecting…',
} as const

export const INITIAL_STATE: TableState = {
  ownControl: null,
  command: null,
  cancellation: null,
  start: null,
  completion: null,
  presentation: null,
  frameTiming: null,
  resyncing: true,
  presentationEpoch: 0,
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
  invite: null,
}

type Options = {
  /** ws(s):// origin of the table server; defaults to this page's origin. */
  origin?: string
  WebSocketImpl?: typeof WebSocket
  /** Give up after this many failed connection attempts in a row. */
  maxAttempts?: number
  newRequestId?: () => string
  /**
   * Ping every this many ms while open (0: never, which is what the tests
   * get; useTable passes PING_EVERY_MS).
   */
  heartbeatMs?: number
  /** A monotonic clock in ms, for round trips (performance.now). */
  now?: () => number
  /** 0..1, for the spread between pings (Math.random). */
  random?: () => number
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

/**
 * A move unacknowledged this long is asked about: a `resync` brings the
 * server's truth, which also names whether the move landed. The move is
 * never sent again, since it may have: the table's own duplicate check is
 * for a reconnect, not a guess.
 */
export const PENDING_WATCHDOG_MS = 3000
/**
 * After that resync: a socket that has said nothing at all in this long is
 * closed and reconnected, since a welcome would have come by now.
 */
export const RESYNC_WAIT_MS = 3000
/**
 * Buttons that answered a join request wait for the table's next `invite`
 * frame; if none comes (the frame was lost) they come back after this.
 */
export const ANSWER_WAIT_MS = 5000

/**
 * The requests of an `invite` frame, rebuilt by name: an id the host can
 * answer by, a name (cut short; it is another player's), and an age.
 * Anything else about a request is not kept.
 */
export function readRequests(raw: unknown): InviteRequest[] {
  if (!Array.isArray(raw)) return []
  const found: InviteRequest[] = []
  for (const r of raw) {
    if (typeof r !== 'object' || r === null) continue
    const { id, username, ageMs } = r as Record<string, unknown>
    if (
      typeof id === 'string' &&
      REQUEST_ID_RE.test(id) &&
      typeof username === 'string' &&
      typeof ageMs === 'number' &&
      Number.isFinite(ageMs) &&
      ageMs >= 0
    )
      found.push({ id, username: username.slice(0, GAME_HOST_MAX), ageMs })
  }
  return found
}

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
  private readonly heartbeat: Heartbeat
  /** The round trips; a store of its own so a ping re-renders no table. */
  readonly rtt = new RttStore()
  /** Table frames received: what the watchdog checks for silence. */
  private heard = 0
  /** The move the watchdog is timing, and its timers. */
  private watching: string | null = null
  private watchdog: ReturnType<typeof setTimeout> | null = null
  private answerTimer: ReturnType<typeof setTimeout> | null = null
  /** Bumped by every open() and every drop, so a stale open() gives up. */
  private generation = 0
  private listening = false
  private controlTimer: ReturnType<typeof setTimeout> | null = null
  private cancelTimer: ReturnType<typeof setTimeout> | null = null
  private resyncTimer: ReturnType<typeof setTimeout> | null = null
  private frameId = 0
  private renderedFrame = 0
  readonly timing: LiveTiming

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
      heartbeatMs: options.heartbeatMs ?? 0,
      now: options.now ?? (() => performance.now()),
      random: options.random ?? Math.random,
    }
    this.timing = new LiveTiming(this.options.now)
    this.heartbeat = new Heartbeat({
      intervalMs: this.options.heartbeatMs,
      now: this.options.now,
      random: this.options.random,
      send: () => this.socket?.send('ping'),
      dead: () => this.drop(),
      onRtt: (ms) => this.rtt.add(ms),
    })
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
    this.listen(true)
    void this.open()
  }

  stop() {
    this.stopped = true
    this.listen(false)
    this.generation++
    if (this.timer) clearTimeout(this.timer)
    if (this.watchdog) clearTimeout(this.watchdog)
    if (this.answerTimer) clearTimeout(this.answerTimer)
    if (this.controlTimer) clearTimeout(this.controlTimer)
    if (this.cancelTimer) clearTimeout(this.cancelTimer)
    if (this.resyncTimer) clearTimeout(this.resyncTimer)
    this.timer = this.watchdog = this.answerTimer = null
    this.heartbeat.stop()
    this.socket?.close(1000, 'leaving')
    this.socket = null
  }

  /** Sends a move for the current decision. False if it is not ours to make. */
  act(action: PlayerAction): boolean {
    const { view, seat, pending, status } = this.state
    if (
      status !== 'open' ||
      this.state.resyncing ||
      !view ||
      pending ||
      this.state.ownControl?.standing
    )
      return false
    if (view.toAct !== seat || view.street === 'showdown') return false
    const reqId = this.options.newRequestId()
    this.markIntent(reqId)
    this.socket!.send(
      JSON.stringify({
        t: 'act',
        reqId,
        handNo: view.handNo,
        actionIndex: view.actions.length,
        action,
      }),
    )
    this.markSent(reqId)
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
   * Takes `seat` at a six table, or without one the lowest free seat (a
   * quick-sit). The frame names only the seat: the server seats this
   * socket's account with its own buy-in, and its welcome says where we
   * sit (or an error says why not).
   */
  sit(seat?: SeatId): boolean {
    const { status, seat: current } = this.state
    if (status !== 'open' || current !== null) return false
    this.socket!.send(
      JSON.stringify(seat === undefined ? { t: 'sit' } : { t: 'sit', seat }),
    )
    return true
  }

  /**
   * As host of a waiting invite table: accept or decline one join request.
   * The frame names the request by the id the `invite` frame gave and
   * nothing else; the table decides whether it is still good. The buttons
   * wait for its next `invite` frame (the answer, or the current truth).
   */
  answer(requestId: string, accept: boolean): boolean {
    const { status, invite } = this.state
    if (status !== 'open' || !invite || invite.answering) return false
    if (!invite.requests.some((r) => r.id === requestId)) return false
    this.socket!.send(JSON.stringify({ t: 'join_answer', requestId, accept }))
    this.set({ invite: { ...invite, answering: requestId } })
    if (this.answerTimer) clearTimeout(this.answerTimer)
    this.answerTimer = setTimeout(() => {
      this.answerTimer = null
      const now = this.state.invite
      if (now?.answering === requestId)
        this.set({ invite: { ...now, answering: null } })
    }, ANSWER_WAIT_MS)
    return true
  }

  /** Asks the table for a fresh welcome, if this socket is open. */
  resync(): boolean {
    if (this.state.status !== 'open') return false
    this.set({
      resyncing: true,
      presentationEpoch: this.state.presentationEpoch + 1,
    })
    this.socket!.send(JSON.stringify({ t: 'resync' }))
    if (this.resyncTimer) clearTimeout(this.resyncTimer)
    const frameId = this.frameId
    this.resyncTimer = setTimeout(() => {
      if (this.state.resyncing && this.frameId === frameId) this.drop()
    }, RESYNC_WAIT_MS)
    return true
  }

  /**
   * At a six table: top up to 100 bb from the next hand. The frame is the
   * type alone: the server computes the amount, and its welcome carries
   * the new stack (or an error says why not).
   */
  rebuy(): boolean {
    return this.sendSeated('rebuy')
  }

  /**
   * At a six table: leave the seat, at once between hands, or when the
   * hand this player is dealt into ends. Acceptance and effect are separate.
   */
  stand(): boolean {
    return this.sendSeated('stand')
  }

  /**
   * At a six table: sit out from the next hand, keeping the seat.
   */
  sitOut(): boolean {
    return this.sendSeated('sit_out')
  }

  /** At a six table, sitting out: be dealt in again from the next hand. */
  sitIn(): boolean {
    return this.sendSeated('sit_in')
  }

  private sendSeated(kind: SeatCommandV1['kind']) {
    const { status, seat, ownControl, view, command, resyncing } = this.state
    const scope = ownControl?.scope
    if (
      status !== 'open' ||
      resyncing ||
      seat === null ||
      !scope ||
      this.state.table?.kind !== 'six-casual'
    )
      return false
    if (
      command &&
      ['sending', 'unknown', 'accepted-pending-effect'].includes(command.phase)
    )
      return false
    const envelope: SeatCommandV1 = {
      t: 'seat_command',
      v: 1,
      commandId: this.options.newRequestId(),
      kind,
      tableId: scope.tableId,
      membershipGeneration: scope.membershipGeneration,
      seatGeneration: scope.seatGeneration,
      expectedStateVersion: ownControl.stateVersion,
      hand: view
        ? { tableId: scope.tableId, matchId: view.matchId, handNo: view.handNo }
        : null,
    }
    this.markIntent(envelope.commandId)
    this.transmitCommand(envelope)
    return true
  }

  private transmitCommand(envelope: SeatCommandV1) {
    this.set({
      command: { envelope, phase: 'sending', reason: null, retryable: false },
    })
    this.socket!.send(JSON.stringify(envelope))
    this.markSent(envelope.commandId)
    if (this.controlTimer) clearTimeout(this.controlTimer)
    this.controlTimer = setTimeout(
      () => this.queryCommand(),
      PENDING_WATCHDOG_MS,
    )
  }

  private commandApplicable(envelope: SeatCommandV1) {
    const { ownControl, view } = this.state
    const scope = ownControl?.scope
    return (
      !!scope &&
      scope.tableId === envelope.tableId &&
      scope.membershipGeneration === envelope.membershipGeneration &&
      scope.seatGeneration === envelope.seatGeneration &&
      ownControl.stateVersion === envelope.expectedStateVersion &&
      (view
        ? envelope.hand?.matchId === view.matchId &&
          envelope.hand.handNo === view.handNo
        : envelope.hand === null)
    )
  }

  /** Never mint a new identity for an unknown effect. Resync/journal first. */
  retryCommand(): boolean {
    const command = this.state.command
    if (
      this.state.status !== 'open' ||
      this.state.resyncing ||
      !command?.retryable ||
      !this.commandApplicable(command.envelope)
    )
      return false
    this.transmitCommand(command.envelope)
    return true
  }

  checkCommand(): boolean {
    if (this.state.status !== 'open' || !this.state.command) return false
    this.queryCommand()
    return true
  }

  private queryCommand() {
    const command = this.state.command
    if (!command || !['sending', 'unknown'].includes(command.phase)) return
    this.set({ command: { ...command, phase: 'unknown', retryable: false } })
    if (this.state.status !== 'open') return
    this.resync()
    this.socket!.send(
      JSON.stringify({
        t: 'command_status',
        commandId: command.envelope.commandId,
      }),
    )
    const heard = this.heard
    if (this.controlTimer) clearTimeout(this.controlTimer)
    this.controlTimer = setTimeout(() => {
      if (this.heard === heard) this.drop()
    }, RESYNC_WAIT_MS)
  }

  private commandOutcome(outcome: CommandOutcomeV1) {
    const command = this.state.command
    if (!command || command.envelope.commandId !== outcome.commandId) return
    if (['completed', 'rejected'].includes(command.phase)) return
    if (
      command.phase === 'stale' &&
      (command.reason !== 'state_changed' || outcome.disposition === 'unknown')
    )
      return
    if (
      command.phase === 'accepted-pending-effect' &&
      outcome.disposition === 'unknown'
    )
      return
    if (this.controlTimer) clearTimeout(this.controlTimer)
    const phase =
      outcome.disposition === 'accepted'
        ? outcome.effect === 'pending'
          ? 'accepted-pending-effect'
          : 'completed'
        : outcome.disposition
    this.set({
      command: {
        ...command,
        phase,
        reason: outcome.reason,
        retryable:
          phase === 'unknown' &&
          outcome.reason === 'not_found' &&
          !this.state.resyncing &&
          this.commandApplicable(command.envelope),
      },
    })
    if (outcome.disposition === 'accepted')
      this.markAcknowledged(outcome.commandId)
  }

  cancelStart(): boolean {
    const { ownControl, start, status, cancellation, resyncing } = this.state
    const scope = ownControl?.scope
    if (
      status !== 'open' ||
      resyncing ||
      !scope ||
      !start ||
      this.state.view ||
      cancellation?.phase === 'sending'
    )
      return false
    const envelope: CancelStartV1 =
      cancellation?.phase === 'unknown'
        ? cancellation.envelope
        : {
            t: 'cancel_start',
            v: 1,
            commandId: this.options.newRequestId(),
            tableId: scope.tableId,
            activationId: start.activationId,
            membershipGeneration: scope.membershipGeneration,
          }
    if (
      envelope.activationId !== start.activationId ||
      envelope.membershipGeneration !== scope.membershipGeneration
    )
      return false
    this.markIntent(envelope.commandId)
    this.set({ cancellation: { envelope, phase: 'sending' } })
    this.socket!.send(JSON.stringify(envelope))
    this.markSent(envelope.commandId)
    if (this.cancelTimer) clearTimeout(this.cancelTimer)
    this.cancelTimer = setTimeout(() => {
      if (this.state.cancellation?.phase !== 'sending') return
      this.set({ cancellation: { envelope, phase: 'unknown' } })
      this.resync()
    }, PENDING_WATCHDOG_MS)
    return true
  }

  private timingIdentity() {
    return renderIdentity(
      this.matchId,
      this.state.view?.matchId ?? this.matchId,
      this.seq,
      this.state.view,
    )
  }
  private markIntent(requestId: string) {
    this.timing.mark({
      phase: 'intent',
      identity: this.timingIdentity(),
      requestId,
    })
  }
  private markSent(requestId: string) {
    this.timing.mark({
      phase: 'sent',
      identity: this.timingIdentity(),
      requestId,
    })
  }
  private markAcknowledged(requestId: string) {
    this.timing.mark({
      phase: 'acknowledgement',
      identity: this.timingIdentity(),
      requestId,
    })
  }
  markRendered(frame: TimingSample | null) {
    if (!frame?.frameId || frame.frameId <= this.renderedFrame) return
    this.renderedFrame = frame.frameId
    this.timing.mark({ ...frame, phase: 'render' })
  }

  private set(patch: Partial<TableState>) {
    this.state = { ...this.state, ...patch }
    if (this.state.pending !== this.watching) this.watch()
    for (const listener of this.listeners) listener()
  }

  /**
   * Times the move in flight (PENDING_WATCHDOG_MS). A move whose answer
   * never comes leaves every button disabled, so at the deadline the client
   * asks for the server's truth, and if the socket then says nothing at all
   * it is closed and reconnected (the welcome after it clears the move).
   * Whatever happens, the move is not sent again.
   */
  private watch() {
    if (this.watchdog) clearTimeout(this.watchdog)
    this.watchdog = null
    const { pending } = this.state
    this.watching = pending
    if (!pending) return
    this.watchdog = setTimeout(() => {
      this.watchdog = null
      if (this.state.pending !== pending) return
      this.resync()
      const heard = this.heard
      this.watchdog = setTimeout(() => {
        this.watchdog = null
        if (this.state.pending === pending && this.heard === heard) this.drop()
      }, RESYNC_WAIT_MS)
    }, PENDING_WATCHDOG_MS)
  }

  /**
   * Window events that say more than the socket does: the network went or
   * came back, or the tab woke (a sleeping laptop's socket is dead, but its
   * browser may not know yet).
   */
  private listen(on: boolean) {
    if (this.listening === on || typeof window === 'undefined') return
    this.listening = on
    const method = on ? 'addEventListener' : 'removeEventListener'
    window[method]('online', this.onOnline)
    window[method]('offline', this.onOffline)
    document[method]('visibilitychange', this.onVisible)
  }

  private onOffline = () => {
    this.interrupted()
    if (this.state.status === 'open')
      this.set({ status: 'reconnecting', pending: null })
  }

  private onOnline = () => {
    const { status } = this.state
    if (this.stopped) return
    if (status === 'open') return this.heartbeat.probe()
    if (status === 'reconnecting' || (status === 'failed' && this.everOpened))
      this.reconnectNow()
  }

  private onVisible = () => {
    if (this.stopped || document.visibilityState !== 'visible') return
    const { status } = this.state
    if (status === 'open') {
      this.heartbeat.probe()
      this.resync()
      this.queryCommand()
    } else if (status === 'reconnecting') this.reconnectNow()
  }

  /** A new socket now, with the patience renewed: the network is back. */
  private reconnectNow() {
    this.interrupted()
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const old = this.socket
    this.socket = null
    this.heartbeat.stop()
    // A new socket is a new path: its figure starts again, even when the
    // old socket never got to say it closed.
    this.rtt.reset()
    old?.close(1000, 'reconnecting')
    this.attempts = 0
    this.set({ status: 'reconnecting', pending: null })
    void this.open()
  }

  /** The heartbeat or the watchdog gave this socket up: close it, recover. */
  private drop() {
    const socket = this.socket
    if (!socket) return
    socket.close(1000, 'unresponsive')
    // A socket that does not answer may take minutes to report its close:
    // recover now, and the late close finds another socket and does nothing.
    this.closed(socket, 1006, 'unresponsive')
  }

  private async open() {
    const generation = ++this.generation
    const token = await this.getToken()
    if (this.stopped || generation !== this.generation) return
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
      this.heartbeat.start()
    }
    socket.onmessage = (event) => {
      if (this.socket !== socket || this.stopped) return
      this.heartbeat.heard()
      // The heartbeat's reply is not JSON: taken before the parse, so it
      // costs nothing and cannot be mistaken for a snapshot.
      if (event.data === 'pong') {
        this.heartbeat.pong()
        // A pong is proof of life too: an `offline` that no `online` ever
        // followed must not leave a socket that answers stuck disabled.
        // Only this socket's: a replaced one says nothing of the new path.
        if (this.socket === socket && this.state.status === 'reconnecting') {
          this.set({ status: 'open' })
          this.resync()
          this.queryCommand()
        }
        return
      }
      // Only the table's own frames count for the watchdog: a pong shows
      // the link is up, not that the table answered.
      this.heard++
      // The network was said to be gone (offline), yet this socket speaks:
      // it was a blip, and the socket is as open as ever.
      if (this.socket === socket && this.state.status === 'reconnecting')
        this.set({ status: 'open' })
      try {
        this.receive(JSON.parse(String(event.data)) as ServerMsg)
      } catch {
        // A frame we cannot read is ignored; the next snapshot replaces it.
      }
    }
    socket.onclose = (event) => this.closed(socket, event.code, event.reason)
  }

  /** `socket` closed (or was given up): settle the state and, if due, retry. */
  private closed(socket: WebSocket, code: number, reason: string) {
    if (this.socket !== socket || this.stopped) return
    this.interrupted()
    this.socket = null
    this.heartbeat.stop()
    this.rtt.reset()
    // The host's invite state belongs to the socket: the welcome after a
    // reconnect is followed by a fresh one.
    const gone = { invite: null }
    if (code === CLOSE_REPLACED)
      return this.set({ status: 'replaced', ...gone })
    if (code === CLOSE_ELSEWHERE)
      return this.set({ status: 'elsewhere', elsewhere: reason, ...gone })
    if (code === CLOSE_GONE) return this.set({ status: 'closed', ...gone })
    // Sent too much: the server wants a pause of at least a second.
    const limited = code === CLOSE_RATE_LIMITED || code === CLOSE_ABUSE
    this.attempts++
    const limit = this.everOpened
      ? this.options.maxAttempts
      : NEVER_OPENED_ATTEMPTS
    if (this.attempts > limit)
      return this.set({
        status: 'failed',
        ...gone,
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
      ...gone,
      ...(limited ? { error: LIMITED } : {}),
    })
    this.timer = setTimeout(() => void this.open(), delay)
  }

  private receive(msg: ServerMsg) {
    if (msg.t === 'command_outcome') {
      this.commandOutcome(msg)
      return
    }
    if (msg.t === 'cancel_start_result') {
      const cancellation = this.state.cancellation
      if (cancellation?.envelope.commandId !== msg.commandId) return
      if (this.cancelTimer) clearTimeout(this.cancelTimer)
      this.set({ cancellation: { ...cancellation, phase: msg.status } })
      this.resync()
      return
    }
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
    if (msg.t === 'invite') {
      // Replaces the last invite whole (a snapshot), which also ends the
      // wait of the answer that prompted it. Never touches view or table.
      this.set({
        invite: {
          code:
            typeof msg.code === 'string' && GAME_CODE_RE.test(msg.code)
              ? msg.code
              : null,
          listed: msg.listed === true,
          requests: readRequests(msg.requests),
          reservedFor:
            typeof msg.reservedFor === 'string'
              ? msg.reservedFor.slice(0, GAME_HOST_MAX)
              : null,
          at: Date.now(),
          // The same account still holding the seat keeps its first sighting.
          reservedAt:
            msg.reservedFor === null
              ? null
              : this.state.invite?.reservedFor === msg.reservedFor
                ? (this.state.invite.reservedAt ?? Date.now())
                : Date.now(),
          answering: null,
        },
      })
      return
    }
    if (msg.t === 'match_end') {
      this.set({
        ended: msg.result,
        presentationEpoch: this.state.presentationEpoch + 1,
      })
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
      if (msg.completion) this.keepCompletion(msg.completion)
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
    const before = this.state.ownControl?.scope
    const after = msg.ownControl?.scope
    const changedSeat =
      before?.membershipGeneration !== after?.membershipGeneration ||
      before?.seatGeneration !== after?.seatGeneration
    const completion = msg.presentation?.completion ?? msg.completion
    const frameTiming = this.timing.mark({
      phase: 'frame',
      frameId: ++this.frameId,
      identity: renderIdentity(this.matchId, msg.matchId, msg.seq, msg.view),
      ...(msg.view?.lastReqId ? { requestId: msg.view.lastReqId } : {}),
    })
    if (this.state.pending && msg.view?.lastReqId === this.state.pending)
      this.markAcknowledged(this.state.pending)
    const pending =
      this.state.pending && msg.view?.lastReqId === this.state.pending
        ? null
        : this.state.pending
    this.set({
      ownControl: msg.ownControl ?? null,
      start: msg.start ?? null,
      presentation: msg.presentation ?? null,
      frameTiming,
      resyncing: false,
      ...(changedSeat
        ? { presentationEpoch: this.state.presentationEpoch + 1 }
        : {}),
      ...(msg.t === 'welcome'
        ? { seat: msg.seat, pending: null }
        : { pending }),
      table: msg.table,
      view: msg.view,
      clockOffset: this.offsetOf(msg.serverNow),
      hands: msg.view ? this.withView(msg.matchId, msg.view) : this.state.hands,
    })
    if (completion) this.keepCompletion(completion)
    const command = this.state.command
    if (command) {
      const outcome = msg.ownControl?.commandOutcomes.find(
        (o) => o.commandId === command.envelope.commandId,
      )
      if (outcome) this.commandOutcome(outcome)
      else if (['sending', 'unknown'].includes(command.phase)) {
        // A snapshot cannot invent acceptance. Its scope can rule out replay.
        const applicable = this.commandApplicable(command.envelope)
        this.set({
          command: {
            ...command,
            phase: applicable ? command.phase : 'stale',
            reason: applicable ? command.reason : 'state_changed',
            retryable: applicable && command.reason === 'not_found',
          },
        })
        if (!applicable || msg.t === 'welcome')
          this.socket?.send(
            JSON.stringify({
              t: 'command_status',
              commandId: command.envelope.commandId,
            }),
          )
      }
    }
    if (
      msg.view &&
      this.state.cancellation &&
      ['sending', 'unknown'].includes(this.state.cancellation.phase)
    )
      this.set({
        cancellation: { ...this.state.cancellation, phase: 'game_started' },
      })
  }

  private interrupted() {
    const { command, cancellation } = this.state
    this.set({
      resyncing: true,
      presentationEpoch: this.state.presentationEpoch + 1,
      ...(command && ['sending', 'unknown'].includes(command.phase)
        ? { command: { ...command, phase: 'unknown', retryable: false } }
        : {}),
      ...(cancellation?.phase === 'sending'
        ? { cancellation: { ...cancellation, phase: 'unknown' } }
        : {}),
    })
  }

  private keepCompletion(completion: HandCompletionV1) {
    if (completion.hand.tableId !== this.matchId) return
    if (this.state.view && completion.hand.matchId !== this.state.view.matchId)
      return
    const old = this.state.completion
    if (
      old &&
      old.hand.matchId === completion.hand.matchId &&
      old.terminalStateVersion >= completion.terminalStateVersion
    )
      return
    this.set({ completion })
  }

  /**
   * Server time minus ours. The snapshot was stamped half a round trip ago,
   * so once a ping has measured one, that half is added; with none yet the
   * raw difference stands.
   */
  private offsetOf(serverNow: number) {
    const rtt = this.rtt.median()
    return serverNow + (rtt === null ? 0 : rtt / 2) - Date.now()
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
