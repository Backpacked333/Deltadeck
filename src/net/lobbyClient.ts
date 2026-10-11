// The lobby connection: presence counts, the quick-match queue, and the
// table the server pairs us at. A queue place is held only while the socket
// is open, so after a reconnect we ask again if we were still looking.
// Six tables: quick-sit (the lobby says which table to sit at) and the list
// of tables. Sitting there, and asking again with the tables tried when one
// refuses, is the table page's (PR-25).
import {
  CLOSE_ABUSE,
  CLOSE_RATE_LIMITED,
  CLOSE_REPLACED,
  PROTOCOL,
} from '../shared/protocol'
import type { LobbyMsg, MatchKind, TableRow } from '../shared/protocol'
import { socketOrigin } from './client'

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
}

const LIMITED = 'Too many messages, reconnecting…'

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
}

type Options = {
  origin?: string
  WebSocketImpl?: typeof WebSocket
  maxAttempts?: number
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
  private readonly options: Required<Options>

  constructor(
    private readonly getToken: () => Promise<string | null>,
    options: Options = {},
  ) {
    this.options = {
      origin: options.origin ?? socketOrigin(),
      WebSocketImpl: options.WebSocketImpl ?? WebSocket,
      maxAttempts: options.maxAttempts ?? 8,
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
      if (this.state.looking) this.sendQueue()
      if (this.state.seating) this.sendQuickSit()
    }
    socket.onmessage = (event) => {
      try {
        this.receive(JSON.parse(String(event.data)) as LobbyMsg)
      } catch {
        // Unreadable frame: ignored.
      }
    }
    socket.onclose = (event) => {
      if (this.socket !== socket || this.stopped) return
      this.socket = null
      if (event.code === CLOSE_REPLACED) return this.set({ status: 'replaced' })
      const limited =
        event.code === CLOSE_RATE_LIMITED || event.code === CLOSE_ABUSE
      this.attempts++
      if (this.attempts > this.options.maxAttempts)
        return this.set({
          status: 'failed',
          error: 'Could not reach the lobby. Reload to try again.',
        })
      const backoff = Math.min(8000, 500 * 2 ** (this.attempts - 1))
      // Sent too much: the server wants a pause of at least a second.
      const delay = limited ? Math.max(1000, backoff) : backoff
      this.set({
        status: 'reconnecting',
        queued: null,
        ...(limited ? { error: LIMITED } : {}),
      })
      this.timer = setTimeout(() => void this.open(), delay)
    }
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
        return this.set({
          looking: false,
          queued: null,
          seating: false,
          matched: { matchId: msg.matchId, resumed: !!msg.resumed },
        })
      case 'sit_at':
        // Only a quick-sit still waiting takes it: a search since replaced it.
        return this.state.seating
          ? this.set({ seating: false, sitAt: msg.tableId })
          : undefined
      case 'tables':
        return this.set({ tables: msg.tables })
      case 'error':
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
