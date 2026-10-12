// The lobby connection: presence counts, the quick-match queue, and the
// table the server pairs us at. A queue place is held only while the socket
// is open, so after a reconnect we ask again if we were still looking.
// Six tables: quick-sit (the lobby says which table to sit at) and the list
// of tables. Sitting there, and asking again with the tables tried when one
// refuses, is the table page's (PR-25).
// Open games (ADR amendment 2026-10-12, "Live games"): the list of listed
// heads-up games, a request to join one (the host answers), and a game code.
// All are asked for, never pushed: nothing is sent when the socket opens, so
// a page that does not show the list costs the lobby nothing.
import { GAME_ID_RE, normaliseCode } from '../shared/gameCode'
import {
  CLOSE_ABUSE,
  GAME_HOST_MAX,
  GAMES_RETURNED,
  CLOSE_RATE_LIMITED,
  CLOSE_REPLACED,
  PROTOCOL,
} from '../shared/protocol'
import type {
  GameRow,
  JoinStatusState,
  LobbyMsg,
  MatchKind,
  TableRow,
} from '../shared/protocol'
import { socketOrigin } from './client'
import { Heartbeat } from './heartbeat'

export type LobbyState = {
  status: 'connecting' | 'open' | 'reconnecting' | 'replaced' | 'failed'
  /** True from "Find a match" until matched or cancelled. */
  looking: boolean
  /** The queue asked for: casual, or rated. */
  kind: MatchKind
  /** Why the server refused the last rated queue (no confirmed email). */
  refused: string | null
  queued: { position: number; since: number } | null
  /** `rated`: of those queued, how many wait for rated. */
  presence: { online: number; queued: number; rated: number } | null
  matched: { matchId: string; resumed: boolean } | null
  error: string | null
  /** True from a quick-sit until the lobby answers it. */
  seating: boolean
  /** The six table quick-sit chose: open it and sit. */
  sitAt: string | null
  /** The six tables, as the lobby last listed them; null until asked. */
  tables: TableRow[] | null
  /**
   * The open games, as the lobby last listed them; null until asked, and
   * again after a drop (a list from before it says nothing of now).
   */
  games: GameRow[] | null
  /** When `games` arrived (Date.now): a list that stops coming goes stale. */
  gamesAt: number | null
  /**
   * The join request in flight or answered, for the game it asked about.
   * `expiresAt` is the host's deadline (Date.now); null until the lobby
   * says, since the request is shown the moment it is made.
   */
  joinRequest: {
    gameId: string
    state: JoinStatusState
    expiresAt: number | null
  } | null
  /** The last code tried was not an open game's (one answer for every why). */
  codeFailed: boolean
  /** A request or a code was refused for asking too often. */
  joinLimited: 'request' | 'code' | null
}

/**
 * The rows of a `games` frame the page will show, rebuilt by name. A row
 * with a key beyond the three, a handle that is not 32 hex characters, or a
 * figure that is not a time is dropped; a host name is cut to GAME_HOST_MAX;
 * at most GAMES_RETURNED rows are kept. The lobby sends exactly this, so
 * anything else is a bug or an attack, and it must not reach the page (a
 * stray `matchId` or `code` in a row would otherwise be one render from the
 * DOM).
 */
export function readGames(raw: unknown): GameRow[] {
  if (!Array.isArray(raw)) return []
  const rows: GameRow[] = []
  for (const row of raw) {
    if (rows.length >= GAMES_RETURNED) break
    if (typeof row !== 'object' || row === null) continue
    const keys = Object.keys(row)
    const { gameId, host, openForMs } = row as Record<string, unknown>
    if (
      keys.length !== 3 ||
      typeof gameId !== 'string' ||
      !GAME_ID_RE.test(gameId) ||
      typeof host !== 'string' ||
      typeof openForMs !== 'number' ||
      !Number.isFinite(openForMs) ||
      openForMs < 0
    )
      continue
    rows.push({ gameId, host: host.slice(0, GAME_HOST_MAX), openForMs })
  }
  return rows
}

/** What a drop, a reconnect and a match found leave of the games' state. */
const NO_GAMES = {
  games: null,
  gamesAt: null,
  joinRequest: null,
  codeFailed: false,
  joinLimited: null,
} as const

/** The error while reconnecting after the lobby closed a flood. */
export const LIMITED = 'Too many messages, reconnecting…'

export const INITIAL_LOBBY: LobbyState = {
  status: 'connecting',
  looking: false,
  kind: 'hu-casual',
  refused: null,
  queued: null,
  presence: null,
  matched: null,
  error: null,
  seating: false,
  sitAt: null,
  tables: null,
  ...NO_GAMES,
}

type Options = {
  origin?: string
  WebSocketImpl?: typeof WebSocket
  maxAttempts?: number
  /** Ping every this many ms while open (0: never; useLobby passes 5000). */
  heartbeatMs?: number
  now?: () => number
  random?: () => number
}

export class LobbyConnection {
  private state: LobbyState = INITIAL_LOBBY
  private listeners = new Set<() => void>()
  private socket: WebSocket | null = null
  private attempts = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  /**
   * This socket's rated answer was no. The Worker checks once per socket,
   * so a later rated search goes over a fresh one, whatever came between.
   */
  private unverified = false
  /** The tables the quick-sit being asked has tried (sent with it). */
  private tried: string[] = []
  /**
   * What the next `join_status` or rate-limit error answers: a request or a
   * code. The frames do not say, and one is asked at a time.
   */
  private awaiting: 'request' | 'code' | null = null
  private readonly options: Required<Options>
  private readonly heartbeat: Heartbeat

  constructor(
    private readonly getToken: () => Promise<string | null>,
    options: Options = {},
  ) {
    this.options = {
      origin: options.origin ?? socketOrigin(),
      WebSocketImpl: options.WebSocketImpl ?? WebSocket,
      maxAttempts: options.maxAttempts ?? 8,
      heartbeatMs: options.heartbeatMs ?? 0,
      now: options.now ?? (() => performance.now()),
      random: options.random ?? Math.random,
    }
    this.heartbeat = new Heartbeat({
      intervalMs: this.options.heartbeatMs,
      now: this.options.now,
      random: this.options.random,
      send: () => this.socket?.send('ping'),
      dead: () => this.drop(),
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
    void this.open()
  }

  stop() {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.heartbeat.stop()
    this.socket?.close(1000, 'leaving')
    this.socket = null
  }

  /**
   * Joins the queue (now, or as soon as the socket is open). It ends a
   * quick-sit, as the lobby does, so an answer to one that comes later is
   * not taken.
   */
  find(kind: MatchKind = 'hu-casual') {
    // The Worker checks rated eligibility once per socket, so a refused
    // player who retries (after confirming, or once Auth is back) needs a
    // fresh socket for a fresh answer.
    const recheck = kind === 'hu-rated' && this.unverified
    this.set({
      looking: true,
      kind,
      seating: false,
      matched: null,
      error: null,
      refused: null,
    })
    if (recheck) return this.reopen()
    if (this.state.status === 'open') this.sendQueue()
  }

  /** A new socket now; the old one's close is not a drop to recover from. */
  private reopen() {
    const old = this.socket
    this.socket = null
    if (this.timer) clearTimeout(this.timer)
    this.heartbeat.stop()
    old?.close(1000, 'recheck')
    this.set({ status: 'connecting' })
    void this.open()
  }

  cancel() {
    this.set({ looking: false, queued: null })
    if (this.state.status === 'open')
      this.socket?.send(JSON.stringify({ t: 'dequeue' }))
  }

  /**
   * Asks the lobby for a six table to sit at (now, or once the socket is
   * open), naming the tables this quick-sit has tried. It ends a heads-up
   * search, as the lobby does.
   */
  quickSit(tried: string[] = []) {
    this.tried = tried
    this.set({
      seating: true,
      sitAt: null,
      looking: false,
      queued: null,
      matched: null,
      error: null,
    })
    if (this.state.status === 'open') this.sendQuickSit()
  }

  /** Asks for the list of six tables, if the socket is open. */
  listTables() {
    if (this.state.status === 'open')
      this.socket?.send(JSON.stringify({ t: 'tables' }))
  }

  /** Asks for the open games, if the socket is open. */
  listGames() {
    if (this.state.status === 'open')
      this.socket?.send(JSON.stringify({ t: 'games' }))
  }

  /**
   * Asks the host of a listed game for the other seat. The handle is the
   * list's: it can only ask, never sit. Ends any search, as the lobby does.
   * False when the socket is not open.
   */
  requestJoin(gameId: string): boolean {
    if (this.state.status !== 'open') return false
    this.leaveSearch()
    this.awaiting = 'request'
    this.set({
      joinRequest: { gameId, state: 'pending', expiresAt: null },
      joinLimited: null,
      codeFailed: false,
    })
    this.socket?.send(JSON.stringify({ t: 'join_request', gameId }))
    return true
  }

  /** Withdraws the request, wherever it stands. */
  cancelRequest() {
    const pending = this.state.joinRequest?.state === 'pending'
    if (this.awaiting === 'request') this.awaiting = null
    this.set({ joinRequest: null, joinLimited: null })
    if (pending && this.state.status === 'open')
      this.socket?.send(JSON.stringify({ t: 'cancel_request' }))
  }

  /**
   * Joins the game with this code, as typed or pasted. A string that cannot
   * be a code fails here, the same way a wrong one fails at the lobby; the
   * answer is `matched`, or `codeFailed`. False when the socket is not open.
   */
  joinByCode(input: string): boolean {
    if (this.state.status !== 'open') return false
    const code = normaliseCode(input)
    if (code === null) {
      this.set({ codeFailed: true, joinLimited: null })
      return true
    }
    // One ask at a time: a request in flight is given up first.
    if (this.state.joinRequest?.state === 'pending') this.cancelRequest()
    this.leaveSearch()
    this.awaiting = 'code'
    this.set({ codeFailed: false, joinLimited: null, joinRequest: null })
    this.socket?.send(JSON.stringify({ t: 'join_code', code }))
    return true
  }

  /** Ends a heads-up search or a quick-sit: this is a different way in. */
  private leaveSearch() {
    if (this.state.looking && this.state.status === 'open')
      this.socket?.send(JSON.stringify({ t: 'dequeue' }))
    this.set({ looking: false, queued: null, seating: false, sitAt: null })
  }

  private sendQuickSit() {
    this.socket?.send(
      JSON.stringify(
        this.tried.length
          ? { t: 'quick_sit', tried: this.tried }
          : { t: 'quick_sit' },
      ),
    )
  }

  private sendQueue() {
    this.socket?.send(JSON.stringify({ t: 'queue', kind: this.state.kind }))
  }

  private set(patch: Partial<LobbyState>) {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }

  private async open() {
    const token = await this.getToken()
    if (this.stopped) return
    if (!token)
      return this.set({ status: 'failed', error: 'Sign in to find a match.' })
    const socket = new this.options.WebSocketImpl(
      `${this.options.origin}/ws/lobby`,
      [PROTOCOL, `bearer.${token}`],
    )
    this.socket = socket
    socket.onopen = () => {
      this.attempts = 0
      this.unverified = false
      this.set({
        status: 'open',
        ...(this.state.error === LIMITED ? { error: null } : {}),
      })
      this.heartbeat.start()
      if (this.state.looking) this.sendQueue()
      if (this.state.seating) this.sendQuickSit()
    }
    socket.onmessage = (event) => {
      this.heartbeat.heard()
      // The heartbeat's reply is not JSON; taken before the parse.
      if (event.data === 'pong') return this.heartbeat.pong()
      try {
        this.receive(JSON.parse(String(event.data)) as LobbyMsg)
      } catch {
        // Unreadable frame: ignored.
      }
    }
    socket.onclose = (event) => this.closed(socket, event.code)
  }

  /** The heartbeat gave this socket up: close it and recover at once. */
  private drop() {
    const socket = this.socket
    if (!socket) return
    socket.close(1000, 'unresponsive')
    // An unresponsive socket may take minutes to report its close.
    this.closed(socket, 1006)
  }

  private closed(socket: WebSocket, code: number) {
    if (this.socket !== socket || this.stopped) return
    this.socket = null
    this.heartbeat.stop()
    // Nothing asked over the old socket is answered on the next: the list
    // is from before, and a request or code in flight is lost with it.
    this.awaiting = null
    if (code === CLOSE_REPLACED)
      return this.set({ status: 'replaced', ...NO_GAMES })
    const limited = code === CLOSE_RATE_LIMITED || code === CLOSE_ABUSE
    this.attempts++
    if (this.attempts > this.options.maxAttempts)
      return this.set({
        status: 'failed',
        ...NO_GAMES,
        error: 'Could not reach the lobby. Reload to try again.',
      })
    const backoff = Math.min(8000, 500 * 2 ** (this.attempts - 1))
    // Sent too much: the server wants a pause of at least a second.
    const delay = limited ? Math.max(1000, backoff) : backoff
    this.set({
      status: 'reconnecting',
      queued: null,
      ...NO_GAMES,
      ...(limited ? { error: LIMITED } : {}),
    })
    this.timer = setTimeout(() => void this.open(), delay)
  }

  private receive(msg: LobbyMsg) {
    switch (msg.t) {
      case 'presence':
        return this.set({
          presence: {
            online: msg.online,
            queued: msg.queued,
            rated: msg.rated ?? 0,
          },
        })
      case 'queued':
        return this.state.looking
          ? this.set({ queued: { position: msg.position, since: msg.since } })
          : undefined
      case 'matched':
        // From any state: a pairing, a code, an accepted request, or a table
        // already in play. A request or code in flight is answered by it.
        this.awaiting = null
        return this.set({
          looking: false,
          queued: null,
          seating: false,
          joinRequest: null,
          codeFailed: false,
          joinLimited: null,
          matched: { matchId: msg.matchId, resumed: !!msg.resumed },
        })
      case 'sit_at':
        // Only a quick-sit still waiting takes it: a search since replaced it.
        return this.state.seating
          ? this.set({ seating: false, sitAt: msg.tableId })
          : undefined
      case 'tables':
        return this.set({ tables: msg.tables })
      case 'games':
        return this.set({ games: readGames(msg.games), gamesAt: Date.now() })
      case 'join_status': {
        const asked = this.awaiting
        if (asked === 'code') {
          this.awaiting = null
          // A code has no pending or declined: only "not an open game".
          return this.set({ codeFailed: true })
        }
        const { joinRequest } = this.state
        // No request of ours is waiting (cancelled, or a late frame).
        if (asked === null || !joinRequest) return
        if (msg.state !== 'pending') this.awaiting = null
        return this.set({
          joinRequest: {
            gameId: joinRequest.gameId,
            state: msg.state,
            expiresAt:
              msg.state === 'pending' && msg.expiresInMs !== undefined
                ? Date.now() + msg.expiresInMs
                : null,
          },
        })
      }
      case 'error':
        // A request or code refused for asking too often: the message is the
        // list's, not a banner for the whole lobby.
        if (msg.code === 'rate_limited' && this.awaiting) {
          const limited = this.awaiting
          this.awaiting = null
          return this.set({
            joinLimited: limited,
            ...(limited === 'request' ? { joinRequest: null } : {}),
          })
        }
        // A quick-sit's refusal, after a search replaced it, says nothing.
        if (msg.code === 'tables_full' && !this.state.seating) return
        // A rated queue refused: not looking any more, and the card says why.
        // Anything else also ends a quick-sit waiting for its answer.
        if (msg.code !== 'unverified')
          return this.set({ error: msg.message, seating: false })
        this.unverified = true
        return this.set({ looking: false, queued: null, refused: msg.message })
    }
  }
}
