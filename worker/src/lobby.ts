// The one lobby: who is waiting for a heads-up match, which table each
// account is at, and how often two accounts were paired today. Everything
// is in storage, so hibernation or eviction never loses a waiting player.
//
//   queue:<userId>          { userId, username, since, kind, rating? }  (connected + asked)
//   active:<userId>         matchId                      (one table each)
//   pairs:<day>:<a>:<b>     times paired that UTC day    (limit 2)
//   creates:<day>:<userId>  invite tables made that day  (limit 30)
import { DurableObject } from 'cloudflare:workers'
import {
  CLOSE_ABUSE,
  CLOSE_RATE_LIMITED,
  MAX_FRAME,
  parseClientMsg,
  PROTOCOL,
} from '../../src/shared/protocol'
import type { ErrorCode, LobbyMsg, MatchKind } from '../../src/shared/protocol'
import type { RatedEligibility } from './auth'
import { now } from './clock'
import type { WorkerEnv } from './env'
import { FrameBudget, MATCH_CREATES_PER_DAY } from './limits'
import { logEvent } from './log'
import { ratingWindow, REPAIR_MS } from './pairing'
import type { InitBody, Liveness } from './table'

/** The same two accounts meet at most this often per UTC day. */
export const PAIRS_PER_DAY = 2
/** Both players must open a paired table within this time. */
export const START_WITHIN_MS = 30_000
export { RATING_WINDOW, ratingWindow, REPAIR_MS } from './pairing'

/** A player with no rated match yet queues at the default rating. */
const UNRATED = 1500

/** `kind` is absent on rows queued before rated play existed: casual. */
type Waiting = {
  userId: string
  username: string
  since: number
  kind?: MatchKind
  /** Rated: the player's rating when they queued. */
  rating?: number
}

type Attachment = {
  userId: string
  username: string
  /** Checked by the Worker at connect (ratedEligibility). */
  rated?: RatedEligibility
}
const kindOf = (w: Waiting): MatchKind => w.kind ?? 'hu-casual'
type Who = { userId: string; username: string }
/** The lobby's answer to a rematch: the new table, or why not. */
export type RematchAnswer = { matchId: string } | { refused: 'limit' | 'busy' }

const OPEN = 1
const json = (body: unknown, status = 200) => Response.json(body, { status })
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const DAY_MS = 86_400_000
const pairKey = (d: string, a: string, b: string) =>
  `pairs:${d}:${[a, b].sort().join(':')}`

export function tableStub(env: WorkerEnv, matchId: string) {
  // One region at launch; the hint only matters when the object is created.
  return env.TABLE.get(env.TABLE.idFromName(matchId), { locationHint: 'enam' })
}

export function lobbyStub(env: WorkerEnv) {
  return env.LOBBY.get(env.LOBBY.idFromName('global'), {
    locationHint: 'enam',
  })
}

export class LobbyDO extends DurableObject<WorkerEnv> {
  private seq = 0
  /** The lobby's clock; tests move it. */
  clock: () => number = now
  /** A player's current rating; tests replace it. */
  ratingOf: (userId: string) => Promise<number> = (userId) =>
    currentRating(this.env, userId)
  /** Every player shares this object: each account gets a frame budget. */
  private budget = new FrameBudget(() => this.clock())
  /**
   * Each player's latest queue request. A request awaits lookups (the
   * table's liveness, the rating) before it writes its row, and other
   * frames run meanwhile: cancelling, leaving or asking again replaces or
   * drops the entry, so an older request that wakes up writes nothing.
   */
  private requests = new Map<string, number>()
  private lastRequest = 0

  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env)
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('ping', 'pong'),
    )
    void ctx.blockConcurrencyWhile(async () => {
      this.seq = ((await ctx.storage.get('seq')) as number | undefined) ?? 0
      // The queue is exactly "connected and asked to play": rows whose
      // socket did not survive a restart go.
      const connected = new Set(this.sockets().map((ws) => this.who(ws).userId))
      const queued = await ctx.storage.list<Waiting>({ prefix: 'queue:' })
      const gone = [...queued.values()]
        .filter((w) => !connected.has(w.userId))
        .map((w) => `queue:${w.userId}`)
      if (gone.length) await ctx.storage.delete(gone)
    })
  }

  // ---- Sockets ---------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    const userId = request.headers.get('x-user-id')
    const username = request.headers.get('x-username')
    const header = request.headers.get('x-rated')
    const rated: RatedEligibility =
      header === 'yes' || header === 'no' ? header : 'unknown'
    if (new URL(request.url).pathname !== '/connect')
      return json({ error: 'not found' }, 404)
    if (!userId || !username) return json({ error: 'unauthorized' }, 401)
    // A connect costs a frame: reconnecting in a loop is a flood too, and
    // a refused connect tells nobody anything.
    if (!this.budget.spend(userId)) {
      logEvent('limit_hit', {
        userId,
        code: CLOSE_RATE_LIMITED,
        reason: 'connects',
      })
      const pair = new WebSocketPair()
      pair[1].accept()
      pair[1].close(CLOSE_RATE_LIMITED, 'Too many connections')
      return new Response(null, {
        status: 101,
        webSocket: pair[0],
        headers: { 'Sec-WebSocket-Protocol': PROTOCOL },
      })
    }
    // One lobby socket per account: a second tab replaces the first.
    for (const old of this.ctx.getWebSockets(userId))
      old.close(4001, 'replaced')
    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    this.ctx.acceptWebSocket(server, [userId])
    server.serializeAttachment({
      userId,
      username,
      rated,
    } satisfies Attachment)
    await this.presence()
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { 'Sec-WebSocket-Protocol': PROTOCOL },
    })
  }

  /** Rated players still apart: widen their windows and try again. */
  async alarm() {
    await this.pairUp()
    await this.presence()
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    // Frames still in flight from a socket we already closed do nothing.
    if (ws.readyState !== OPEN) return
    if (!this.budget.spend(this.who(ws).userId))
      return this.cutOff(
        ws,
        CLOSE_RATE_LIMITED,
        'rate_limited',
        'Too many messages',
      )
    const size =
      typeof message === 'string' ? message.length : message.byteLength
    if (size > MAX_FRAME)
      return this.cutOff(ws, CLOSE_ABUSE, 'too_large', 'Message too large')
    const msg = typeof message === 'string' ? parseClientMsg(message) : null
    if (msg?.t === 'queue') return this.enqueue(ws, msg.kind)
    if (msg?.t === 'dequeue') {
      this.requests.delete(this.who(ws).userId)
      await this.ctx.storage.delete(`queue:${this.who(ws).userId}`)
      return this.presence()
    }
    this.reject(ws, 'illegal', 'Not a lobby message')
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    try {
      ws.close(code === 1005 ? 1000 : code, reason)
    } catch {
      // Already closed.
    }
    await this.leave(ws)
  }

  async webSocketError(ws: WebSocket) {
    await this.leave(ws)
  }

  /** Tells the socket why, closes it, and lets its queue place go. */
  private cutOff(
    ws: WebSocket,
    code: number,
    error: ErrorCode,
    message: string,
  ) {
    this.reject(ws, error, message)
    ws.close(code, message)
    logEvent('limit_hit', { userId: this.who(ws).userId, code, reason: error })
    return this.leave(ws)
  }

  /** A closed socket takes its queue row with it (unless a newer tab is open). */
  private async leave(ws: WebSocket) {
    const { userId } = this.who(ws)
    if (!this.sockets(ws).some((s) => this.who(s).userId === userId)) {
      this.requests.delete(userId)
      await this.ctx.storage.delete(`queue:${userId}`)
    }
    await this.presence(ws)
  }

  // ---- Queue -------------------------------------------------------------------

  private async enqueue(ws: WebSocket, kind: MatchKind) {
    const { userId, username, rated } = this.who(ws)
    const request = ++this.lastRequest
    this.requests.set(userId, request)
    const current = () =>
      this.requests.get(userId) === request && ws.readyState === OPEN
    // Already at a table: go back to it instead of starting another.
    const active = await this.liveActive(userId)
    if (!current()) return
    if (active) {
      await this.ctx.storage.delete(`queue:${userId}`)
      this.send(ws, { t: 'matched', matchId: active, resumed: true })
      return this.presence()
    }
    if (kind === 'hu-rated' && rated !== 'yes')
      return this.reject(
        ws,
        'unverified',
        rated === 'no'
          ? 'Rated matches need a confirmed email address.'
          : 'Could not check your account just now. Try again in a moment.',
      )
    const key = `queue:${userId}`
    const waiting = (await this.ctx.storage.get(key)) as Waiting | undefined
    // Asking again for the same kind keeps the place; another kind starts over.
    if (!waiting || kindOf(waiting) !== kind) {
      const rating = kind === 'hu-rated' ? await this.ratingOf(userId) : null
      // Cancelled, gone or superseded while the rating was read.
      if (!current()) return
      await this.ctx.storage.put(key, {
        userId,
        username,
        since: this.clock(),
        kind,
        ...(rating === null ? {} : { rating }),
      } satisfies Waiting)
    }
    await this.pairUp()
    await this.presence()
  }

  /**
   * Oldest first: each waiting player meets an opponent they still may.
   * Casual: the oldest one. Rated: the closest rating within the window
   * (the longer waiter's), the oldest on a tie.
   */
  private async pairUp() {
    const at = this.clock()
    const today = day(at)
    const waiting = [
      ...(await this.ctx.storage.list<Waiting>({ prefix: 'queue:' })).values(),
    ].sort((a, b) => a.since - b.since)
    const taken = new Set<string>()
    for (const [i, a] of waiting.entries()) {
      if (taken.has(a.userId)) continue
      const kind = kindOf(a)
      let best: { b: Waiting; key: string; count: number; gap: number } | null =
        null
      for (const b of waiting.slice(i + 1)) {
        if (taken.has(b.userId) || kindOf(b) !== kind) continue
        const key = pairKey(today, a.userId, b.userId)
        const count = ((await this.ctx.storage.get(key)) as number) ?? 0
        if (count >= PAIRS_PER_DAY) continue
        const gap =
          kind === 'hu-rated'
            ? Math.abs((a.rating ?? UNRATED) - (b.rating ?? UNRATED))
            : 0
        // `a` queued first, so it has waited longest.
        if (gap > ratingWindow(at - a.since)) continue
        if (!best || gap < best.gap) best = { b, key, count, gap }
        if (kind !== 'hu-rated' || gap === 0) break
      }
      if (
        best &&
        (await this.startMatch(a, best.b, best.key, best.count, kind))
      ) {
        taken.add(a.userId)
        taken.add(best.b.userId)
      }
    }
    // The rating windows widen as players wait: look again soon while two
    // rated players are still apart, and sleep otherwise.
    const rated = waiting.filter(
      (w) => kindOf(w) === 'hu-rated' && !taken.has(w.userId),
    ).length
    if (rated >= 2) await this.ctx.storage.setAlarm(at + REPAIR_MS)
    else await this.ctx.storage.deleteAlarm()
    // Yesterday's pair counts are no longer needed.
    const old = await this.ctx.storage.list({
      prefix: 'pairs:',
      end: `pairs:${today}`,
    })
    if (old.size) await this.ctx.storage.delete([...old.keys()])
  }

  /** A paired table with `a` in seat 0; its id, or null if not made. */
  private async startMatch(
    a: Who,
    b: Who,
    pairs: string,
    count: number,
    kind: MatchKind,
    rematchOf?: string,
  ) {
    const matchId = crypto.randomUUID()
    const body: InitBody = {
      matchId,
      creator: { userId: a.userId, username: a.username },
      opponent: { userId: b.userId, username: b.username },
      startWithinMs: START_WITHIN_MS,
      kind,
      ...(rematchOf ? { rematchOf } : {}),
    }
    const created = await tableStub(this.env, matchId).fetch(
      'https://table/init',
      { method: 'POST', body: JSON.stringify(body) },
    )
    if (!created.ok) {
      logEvent('error', {
        matchId,
        reason: 'table_init',
        code: created.status,
      })
      return null
    }
    await this.ctx.storage.put({
      [`active:${a.userId}`]: matchId,
      [`active:${b.userId}`]: matchId,
      [pairs]: count + 1,
    })
    await this.ctx.storage.delete([`queue:${a.userId}`, `queue:${b.userId}`])
    for (const ws of this.sockets()) {
      const { userId } = this.who(ws)
      if (userId === a.userId || userId === b.userId)
        this.send(ws, { t: 'matched', matchId })
    }
    return matchId
  }

  // ---- One active table per account (RPC from the Worker and tables) ---------

  /**
   * Records that `userId` is at `matchId`, unless they are playing at
   * another table: then that table's id comes back and nothing changes.
   */
  async claim(userId: string, matchId: string): Promise<string | null> {
    const active = await this.liveActive(userId, matchId)
    if (active && active !== matchId) return active
    await this.ctx.storage.put(`active:${userId}`, matchId)
    return null
  }

  /**
   * For `POST /api/matches`: records that `userId` is at the new invite
   * table `matchId`, unless they are playing elsewhere (that table's id
   * comes back) or have made MATCH_CREATES_PER_DAY tables today (seconds
   * until the next UTC day come back). Only a table that is made counts.
   */
  async createMatch(
    userId: string,
    matchId: string,
  ): Promise<{ active?: string; retryAfter?: number }> {
    const active = await this.liveActive(userId)
    if (active) return { active }
    const t = this.clock()
    const today = day(t)
    const key = `creates:${today}:${userId}`
    const made = ((await this.ctx.storage.get(key)) as number) ?? 0
    if (made >= MATCH_CREATES_PER_DAY)
      return { retryAfter: Math.ceil((DAY_MS - (t % DAY_MS)) / 1000) }
    await this.ctx.storage.put({
      [key]: made + 1,
      [`active:${userId}`]: matchId,
    })
    // Earlier days' counts are no longer needed.
    const old = await this.ctx.storage.list({
      prefix: 'creates:',
      end: `creates:${today}`,
    })
    if (old.size) await this.ctx.storage.delete([...old.keys()])
    return {}
  }

  /** For a finished rated table: how often this pair may still meet today. */
  async pairsLeft(userIds: string[]): Promise<number> {
    const [a, b] = userIds
    const key = pairKey(day(this.clock()), a, b)
    const count = ((await this.ctx.storage.get(key)) as number) ?? 0
    return Math.max(0, PAIRS_PER_DAY - count)
  }

  /**
   * Both players of the finished rated table `from` pressed Rematch: a new
   * rated table, `players[0]` in seat 0, counted as a pairing. Refused when
   * the pair met PAIRS_PER_DAY times today (R-9), or when either player is
   * at another table by now.
   */
  async rematch(players: Who[], from: string): Promise<RematchAnswer> {
    const [a, b] = players
    for (const p of players)
      if (await this.liveActive(p.userId)) return { refused: 'busy' }
    const key = pairKey(day(this.clock()), a.userId, b.userId)
    const count = ((await this.ctx.storage.get(key)) as number) ?? 0
    if (count >= PAIRS_PER_DAY) return { refused: 'limit' }
    const matchId = await this.startMatch(a, b, key, count, 'hu-rated', from)
    if (!matchId) return { refused: 'busy' }
    await this.presence()
    return { matchId }
  }

  /** Called by a table when its match ends. */
  async release(userIds: string[], matchId: string) {
    for (const userId of userIds)
      if ((await this.ctx.storage.get(`active:${userId}`)) === matchId)
        await this.ctx.storage.delete(`active:${userId}`)
  }

  /** The table this account should be at, if any. */
  async activeFor(userId: string) {
    return this.liveActive(userId)
  }

  /**
   * The recorded table, checked with the table itself: a finished table, or
   * an invite nobody has opened, does not hold anyone. A release that never
   * arrived therefore cannot lock an account out.
   */
  private async liveActive(userId: string, unless?: string) {
    const matchId = (await this.ctx.storage.get(`active:${userId}`)) as
      | string
      | undefined
    if (!matchId) return null
    if (matchId === unless) return matchId
    const state: Liveness = await tableStub(this.env, matchId).liveness(userId)
    if (state === 'playing' || state === 'starting') return matchId
    await this.ctx.storage.delete(`active:${userId}`)
    return null
  }

  // ---- Frames --------------------------------------------------------------------

  private async presence(gone?: WebSocket) {
    const sockets = this.sockets(gone)
    const queue = [
      ...(await this.ctx.storage.list<Waiting>({ prefix: 'queue:' })).values(),
    ].sort((a, b) => a.since - b.since)
    const online = new Set(sockets.map((ws) => this.who(ws).userId)).size
    const rated = queue.filter((w) => kindOf(w) === 'hu-rated').length
    this.seq++
    await this.ctx.storage.put('seq', this.seq)
    for (const ws of sockets) {
      const { userId } = this.who(ws)
      const mine = queue.find((w) => w.userId === userId)
      // A place in the line for the kind asked for.
      const line = mine ? queue.filter((w) => kindOf(w) === kindOf(mine)) : []
      const at = line.findIndex((w) => w.userId === userId)
      if (at >= 0)
        this.send(ws, { t: 'queued', position: at + 1, since: line[at].since })
      this.send(ws, { t: 'presence', online, queued: queue.length, rated })
    }
  }

  private sockets(exclude?: WebSocket) {
    return this.ctx
      .getWebSockets()
      .filter((ws) => ws !== exclude && ws.readyState === OPEN)
  }

  private who(ws: WebSocket) {
    return ws.deserializeAttachment() as Attachment
  }

  private send(ws: WebSocket, msg: DistributiveOmit<LobbyMsg, 'seq'>) {
    try {
      ws.send(JSON.stringify({ ...msg, seq: this.seq }))
    } catch {
      // Closed meanwhile; webSocketClose follows.
    }
  }

  private reject(ws: WebSocket, code: ErrorCode, message: string) {
    this.send(ws, { t: 'error', code, message })
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * A player's heads-up rating (public.ratings), or the default for a player
 * with none yet, a dev account, or a read that fails: queueing never waits
 * on a lookup that cannot succeed.
 */
async function currentRating(env: WorkerEnv, userId: string) {
  if (!UUID.test(userId) || !env.SUPABASE_URL) return UNRATED
  try {
    const response = await fetch(
      `${env.SUPABASE_URL}/rest/v1/ratings?select=rating&format=eq.hu-duplicate&user_id=eq.${userId}`,
      { headers: { apikey: env.SUPABASE_SECRET_KEY ?? '' } },
    )
    if (!response.ok) return UNRATED
    const rows = (await response.json()) as { rating: number }[]
    return typeof rows[0]?.rating === 'number' ? rows[0].rating : UNRATED
  } catch {
    return UNRATED
  }
}
