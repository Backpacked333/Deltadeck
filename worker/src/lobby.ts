// The one lobby: who is waiting for a heads-up match, which table each
// account is at, how often two accounts were paired today, and the list of
// six tables. Everything is in storage, so hibernation or eviction never
// loses a waiting player.
//
//   queue:<userId>          { userId, username, since, kind, rating? }  (connected + asked)
//   active:<userId>         matchId                      (one table each)
//   pairs:<day>:<a>:<b>     times paired that UTC day    (limit 2)
//   creates:<day>:<userId>  tables made that day: invites and quick-sit's
//                           openings                     (limit 30)
//   table:<tableId>         { seated, maxSeats, avgPot, playersPerHour, updatedAt }
//                           (six tables; counts only, never an account)
//   created:<tableId>       { at, by, ready }  a six table quick-sit opened,
//                           counted against the cap for CREATED_MS (never
//                           sent to a client)
//   quicksit:<day>:<userId> { tokens, at }  the account's quick-sit budget
//                           (the day before's carries over; older go)
//
// Open games (ADR amendment 2026-10-12, "Live games"): every invite table
// the Worker makes has a code, and may be listed. The lobby keeps only what
// finds it, and never sends any of these whole:
//
//   open:<matchId>          { gameId, code, hostId, hostName, listed,
//                           openedAt, updatedAt }  (never sent: the list's
//                           rows are built by name, gameRow)
//   code:<CODE>             matchId  (never sent; deleted with open:)
//   gameid:<gameId>         matchId  (never sent; deleted with open:)
//   joinreq:<userId>        { matchId, gameId, at }  the account's one
//                           pending join request (never sent; ignored and
//                           dropped once REQUEST_TTL_MS old)
//   codefail:<day>:<userId> bucket: failed code lookups, per account
//   codefail:global         bucket: failed code lookups, all accounts
//   joinask:<day>:<userId>  bucket: join requests, per account
//   gameslist:<day>:<userId> bucket: reads of the list, per account
//                           (the buckets are stored, like quick-sit's, and
//                           the day before's carries over; older go)
import { DurableObject } from 'cloudflare:workers'
import {
  CLOSE_ABUSE,
  CLOSE_RATE_LIMITED,
  MAX_FRAME,
  parseClientMsg,
  PROTOCOL,
  QUICK_SIT_TABLES,
} from '../../src/shared/protocol'
import type { ErrorCode, LobbyMsg, MatchKind } from '../../src/shared/protocol'
import type { RatedEligibility } from './auth'
import { now } from './clock'
import type { WorkerEnv } from './env'
import { GAME_CODE_RE, GAME_ID_RE } from '../../src/shared/gameCode'
import { newGameCode, newGameId } from './gamecode'
import {
  byWaiting,
  countOffered,
  hostOffered,
  gameRow,
  GAMES_CACHE_MS,
  GAMES_MAX,
  GAMES_RETURNED,
  HOST_LISTED_MAX,
  INIT_GRACE_MS,
  isFresh,
  isOffered,
  isPrunable,
  OPEN_ROWS_READ,
  REQUEST_TTL_MS,
} from './games'
import type { OpenGame, OpenReport } from './games'
import {
  CODE_FAIL_WINDOW_GLOBAL_MS,
  CODE_FAIL_WINDOW_MS,
  CODE_FAILS,
  CODE_FAILS_GLOBAL,
  FrameBudget,
  GAME_LIST_WINDOW_MS,
  GAME_LISTS,
  JOIN_REQUEST_WINDOW_MS,
  JOIN_REQUESTS,
  MATCH_CREATES_PER_DAY,
  QUICK_SIT_WINDOW_MS,
  QUICK_SITS,
  spendToken,
} from './limits'
import type { Bucket } from './limits'
import { describeError, logEvent } from './log'
import { ratingWindow, REPAIR_MS } from './pairing'
import { DEFAULT_REGION } from './region'
import type { Region } from './region'
import { isStale, listTables, REGISTRY_STALE_MS, tableRow } from './registry'
import type { ListedTable, TableEntry, TableReport } from './registry'
import type { InitBody, Liveness } from './table'

/** A whole number of seats, chips or accounts: what a table reports. */
const isCount = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0

/** The same two accounts meet at most this often per UTC day. */
export const PAIRS_PER_DAY = 2
/** Both players must open a paired table within this time. */
export const START_WITHIN_MS = 30_000
export { RATING_WINDOW, ratingWindow, REPAIR_MS } from './pairing'
export {
  DECLINED_MAX,
  GAME_PRUNE_MS,
  GAME_STALE_MS,
  GAMES_CACHE_MS,
  GAMES_MAX,
  GAMES_RETURNED,
  OPEN_HEARTBEAT_MS,
  REQUEST_TTL_MS,
  REQUESTS_PER_GAME,
  RESERVE_MS,
} from './games'

/** A player with no rated match yet queues at the default rating. */
const UNRATED = 1500

/**
 * Six tables open at once, at most (ADR, "One table per account"): the
 * listed ones, and those quick-sit opened that nobody has sat at yet.
 */
export const SIX_TABLES_MAX = 50
/**
 * A table quick-sit opened counts through its `created:` record for this
 * long, and after that only through its own entry in the list. A table
 * nobody sits at deletes itself IDLE_MS after it opens; one missed idle
 * check is slack, as for the list (REGISTRY_STALE_MS), so a lost removal
 * holds a place for at most this long.
 */
export const CREATED_MS = REGISTRY_STALE_MS

/** The queue and pairing are heads-up only: a six table is sat at. */
type HeadsUpKind = Exclude<MatchKind, 'six-casual'>

/** `kind` is absent on rows queued before rated play existed: casual. */
type Waiting = {
  userId: string
  username: string
  since: number
  kind?: HeadsUpKind
  /** Rated: the player's rating when they queued. */
  rating?: number
}

type Attachment = {
  userId: string
  username: string
  /** Checked by the Worker at connect (ratedEligibility). */
  rated?: RatedEligibility
}
const kindOf = (w: Waiting): HeadsUpKind => w.kind ?? 'hu-casual'
type Who = { userId: string; username: string }
/**
 * A six table quick-sit opened: when, for which account (never sent to a
 * client), and whether its /init has answered (only then is it offered).
 */
type Created = { at: number; by: string; ready: boolean }
/** What the lobby sends: a frame without its sequence number. */
type Answer = DistributiveOmit<LobbyMsg, 'seq'>
/** The lobby's answer to a rematch: the new table, or why not. */
export type RematchAnswer = { matchId: string } | { refused: 'limit' | 'busy' }
/**
 * The lobby's answer to `POST /api/matches`: the table it holds for the
 * caller, why not, or (with open-game options) the code and the list handle
 * it gave the new game. The handle never goes back to the client.
 */
export type CreateAnswer = {
  active?: string
  retryAfter?: number
  refused?: 'busy'
  code?: string
  gameId?: string
  /** Whether the game is listed: what was asked, unless the list is full. */
  listed?: boolean
}
/** What a join request is, until the host answers: which game, and when. */
type JoinRequest = { matchId: string; gameId: string; at: number }
/** How a table tells the lobby the host answered a join request. */
export type RequestAnswer = 'accepted' | 'declined' | 'taken'
/**
 * The list as it was last read: the few fields a row is built from, with the
 * host's account to leave the asker's own game out. Never the code.
 */
type GamesSnapshot = {
  at: number
  games: Pick<OpenGame, 'gameId' | 'hostId' | 'hostName' | 'openedAt'>[]
}

const OPEN = 1
const json = (body: unknown, status = 200) => Response.json(body, { status })
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const DAY_MS = 86_400_000
const pairKey = (d: string, a: string, b: string) =>
  `pairs:${d}:${[a, b].sort().join(':')}`

/**
 * The hint only matters when the object is created, which is the first call
 * to it: an invite table gets its host's region there (regionHint, passed on
 * the creating /init only); every other table, and every later call, uses the
 * default.
 */
export function tableStub(
  env: WorkerEnv,
  matchId: string,
  hint: Region = DEFAULT_REGION,
) {
  return env.TABLE.get(env.TABLE.idFromName(matchId), { locationHint: hint })
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
  /** A player's current rating, null when unreadable; tests replace it. */
  ratingOf: (userId: string) => Promise<number | null> = (userId) =>
    currentRating(this.env, userId)
  /**
   * Every player shares this object: each account gets a frame budget. And
   * a budget for quick-sits, which cost more than a frame, kept in storage
   * (spendQuickSit).
   */
  private budget = new FrameBudget(() => this.clock())
  /**
   * Each player's latest queue request. A request awaits lookups (the
   * table's liveness, the rating) before it writes its row, and other
   * frames run meanwhile: cancelling, leaving or asking again replaces or
   * drops the entry, so an older request that wakes up writes nothing.
   */
  private requests = new Map<string, number>()
  private lastRequest = 0
  /**
   * Each account's claims run one at a time (forUsers). A claim asks the
   * recorded table about the account before it writes, and the lobby takes
   * other calls during that await: two claims for one account at once
   * would both find it free, and both seat it.
   */
  private userLocks = new Map<string, Promise<unknown>>()
  /**
   * Quick-sit's opens still waiting on their table's /init, by table id.
   * Each settles once its `created:` record says how it went (ready, or
   * gone). An open is offered only once ready, and /init lets other events
   * in: a quick-sit arriving meanwhile with nothing else to offer waits for
   * it here, rather than open a second table beside it.
   */
  private opening = new Map<string, Promise<void>>()
  /**
   * The open games as the last read found them, for GAMES_CACHE_MS: every
   * `games` frame inside the window is answered from it, and one read in
   * flight serves every frame that arrives meanwhile, so the cost of the
   * list is the window's, not the number of players polling. Dropped when a
   * game closes (a filled game is gone from the next list at once), and a
   * read that started before that drops its own result (`generation`).
   */
  private snapshot: GamesSnapshot | null = null
  private loading: Promise<GamesSnapshot> | null = null
  private generation = 0
  /** The scan breaker's trip is logged (resolveCode); a calm miss clears it. */
  private scanLogged = false
  /** Draws a code for a new game; tests replace it to force a collision. */
  newCode: () => string = () => newGameCode()

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
    if (msg?.t === 'quick_sit') return this.quickSit(ws, msg.tried ?? [])
    // The list goes to the socket that asks, never to everyone: the lobby
    // is one object for every player (ADR, clarifications from PR-24).
    if (msg?.t === 'tables')
      return this.send(ws, {
        t: 'tables',
        tables: (await this.tables()).map(tableRow),
      })
    // Open games (ADR amendment 2026-10-12, "Live games"): each answers the
    // socket that asks and no other, and spends its frame like any message.
    if (msg?.t === 'games') return this.sendGames(ws)
    if (msg?.t === 'join_code') return this.joinCode(ws, msg.code)
    if (msg?.t === 'join_request') return this.joinRequest(ws, msg.gameId)
    if (msg?.t === 'cancel_request') return this.cancelRequest(ws)
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
      // A request nobody is left to see the answer to is withdrawn, so the
      // host's prompt does not offer a seat to an account that has gone.
      await this.dropRequest(userId)
    }
    await this.presence(ws)
  }

  // ---- Queue -------------------------------------------------------------------

  private async enqueue(ws: WebSocket, kind: HeadsUpKind) {
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
      if (kind === 'hu-rated' && rating === null)
        return this.reject(
          ws,
          'unverified',
          'Could not check your rating just now. Try again in a moment.',
        )
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
        (await this.startPaired(a, best.b, best.key, best.count, kind))
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

  /**
   * A paired table for two queued players, unless either is at a table by
   * now: they queued free, but a claim (a six table, an invite) may have
   * seated them since, or another pairing may have paired them meanwhile.
   * Nor unless both still wait as this pass read them. In line with both
   * accounts' claims, so none lands in between.
   */
  private startPaired(
    a: Waiting,
    b: Waiting,
    pairs: string,
    count: number,
    kind: HeadsUpKind,
  ) {
    return this.forUsers([a.userId, b.userId], async () => {
      for (const { userId } of [a, b]) {
        const active = await this.liveActive(userId)
        if (!active) continue
        // Still queued: sent back to that table, as a queue request would be.
        if (await this.ctx.storage.get(`queue:${userId}`)) {
          this.requests.delete(userId)
          await this.ctx.storage.delete(`queue:${userId}`)
          for (const ws of this.ctx.getWebSockets(userId))
            this.send(ws, { t: 'matched', matchId: active, resumed: true })
        }
        return null
      }
      // A quick-sit or a cancel deletes the account's row without waiting
      // for its claims, so a pass that read the queue before (and waited
      // here) would pair an account that no longer asks for heads-up. Only
      // the rows this pass read, unchanged, are paired.
      const keys = [a, b].map((w) => `queue:${w.userId}`)
      const rows = await this.ctx.storage.get<Waiting>(keys)
      const still = (w: Waiting) => {
        const row = rows.get(`queue:${w.userId}`)
        return row?.since === w.since && kindOf(row) === kindOf(w)
      }
      if (!still(a) || !still(b)) return null
      return this.startMatch(a, b, pairs, count, kind)
    })
  }

  /**
   * A paired table with `a` in seat 0; its id, or null if not made. Callers
   * hold both accounts (forUsers).
   */
  private async startMatch(
    a: Who,
    b: Who,
    pairs: string,
    count: number,
    kind: HeadsUpKind,
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
  claim(userId: string, matchId: string): Promise<string | null> {
    return this.forUsers([userId], async () => {
      const active = await this.liveActive(userId, matchId)
      if (active && active !== matchId) return active
      await this.ctx.storage.put(`active:${userId}`, matchId)
      return null
    })
  }

  /**
   * An invite's guest and its host, together (audit F06): both are recorded
   * at `matchId`, or neither is. Null when both were free; otherwise the
   * first account playing at another table, and that table. The host's
   * open invite holds nobody (liveness 'open'), so without this a host
   * could start two invites, or one invite while playing elsewhere.
   */
  claimBoth(
    userIds: string[],
    matchId: string,
  ): Promise<{ userId: string; matchId: string } | null> {
    return this.forUsers(userIds, async () => {
      for (const userId of userIds) {
        const active = await this.liveActive(userId, matchId)
        if (active && active !== matchId) return { userId, matchId: active }
      }
      await this.ctx.storage.put(
        Object.fromEntries(
          userIds.map((userId) => [`active:${userId}`, matchId]),
        ),
      )
      return null
    })
  }

  /**
   * For `POST /api/matches`: records that `userId` is at the new invite
   * table `matchId`, unless they are playing elsewhere (that table's id
   * comes back) or have made MATCH_CREATES_PER_DAY tables today (seconds
   * until the next UTC day come back). Only a table that is made counts.
   *
   * With `opts` (ADR amendment 2026-10-12, "Live games") the game also gets a
   * code and a list handle, and a row that finds it by either. They are drawn
   * and written here, before the table exists, and in the same write as the
   * rest: from the first read of `code:` to the put only storage is awaited,
   * so the input gate holds, and no other create can draw the same code in
   * between (the lobby is one object). Past GAMES_MAX rows the game is
   * unlisted, never refused, and so is a second listed game of one host
   * (HOST_LISTED_MAX); five codes in a row taken is `busy`. A host's new
   * table closes their earlier waiting ones: an invite table does not hold
   * its host (liveness 'open'), so without this one account would keep up to
   * MATCH_CREATES_PER_DAY rows, and the store is what the list is read from.
   */
  createMatch(
    userId: string,
    matchId: string,
    opts?: { listed: boolean; hostName: string },
  ): Promise<CreateAnswer> {
    return this.forUsers([userId], async () => {
      const active = await this.liveActive(userId)
      if (active) return { active }
      const creates = await this.createsToday(userId)
      if (creates.made >= MATCH_CREATES_PER_DAY)
        return { retryAfter: creates.retryAfter }
      const writes: Record<string, unknown> = {
        [creates.key]: creates.made + 1,
        [`active:${userId}`]: matchId,
      }
      let game: { code: string; gameId: string; listed: boolean } | undefined
      if (opts) {
        const code = await this.freeCode()
        if (!code) return { refused: 'busy' }
        const gameId = newGameId()
        const t = this.clock()
        const rows = await this.openRows()
        // Their own earlier games, closed in the same turn as the new one is
        // written (only storage is awaited, so nobody sees both).
        for (const [key, g] of rows)
          if (g.hostId === userId)
            await this.closeGame(key.slice('open:'.length))
        const others = rows.map(([, g]) => g).filter((g) => g.hostId !== userId)
        const listed =
          opts.listed &&
          countOffered(others, t) < GAMES_MAX &&
          hostOffered(others, userId, t) < HOST_LISTED_MAX
        writes[`open:${matchId}`] = {
          gameId,
          code,
          hostId: userId,
          hostName: opts.hostName,
          listed,
          openedAt: t,
          updatedAt: t,
          awaitingInit: true,
        } satisfies OpenGame
        writes[`code:${code}`] = matchId
        writes[`gameid:${gameId}`] = matchId
        game = { code, gameId, listed }
      }
      await this.ctx.storage.put(writes)
      await this.forgetOldCreates(creates.today)
      return game ?? {}
    })
  }

  /**
   * The table's /init refused, so the game was never made: its rows go and
   * the day's create is given back, as `open()` does for a six table. A
   * call that threw may have made it, so the rows stay and, with no
   * heartbeat, go stale (GAME_STALE_MS).
   */
  createFailed(userId: string, matchId: string): Promise<void> {
    return this.forUsers([userId], async () => {
      await this.closeGame(matchId)
      const creates = await this.createsToday(userId)
      if (creates.made > 0)
        await this.ctx.storage.put(creates.key, creates.made - 1)
      if ((await this.ctx.storage.get(`active:${userId}`)) === matchId)
        await this.ctx.storage.delete(`active:${userId}`)
    })
  }

  /** How many tables `userId` has made today, under which key. */
  private async createsToday(userId: string) {
    const t = this.clock()
    const today = day(t)
    const key = `creates:${today}:${userId}`
    const made = ((await this.ctx.storage.get(key)) as number) ?? 0
    return {
      key,
      made,
      today,
      retryAfter: Math.ceil((DAY_MS - (t % DAY_MS)) / 1000),
    }
  }

  /** Earlier days' counts are no longer needed. */
  private async forgetOldCreates(today: string) {
    const old = await this.ctx.storage.list({
      prefix: 'creates:',
      end: `creates:${today}`,
    })
    if (old.size) await this.ctx.storage.delete([...old.keys()])
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
  rematch(players: Who[], from: string): Promise<RematchAnswer> {
    const [a, b] = players
    return this.forUsers([a.userId, b.userId], async () => {
      for (const p of players)
        if (await this.liveActive(p.userId)) return { refused: 'busy' }
      const key = pairKey(day(this.clock()), a.userId, b.userId)
      const count = ((await this.ctx.storage.get(key)) as number) ?? 0
      if (count >= PAIRS_PER_DAY) return { refused: 'limit' }
      const matchId = await this.startMatch(a, b, key, count, 'hu-rated', from)
      if (!matchId) return { refused: 'busy' }
      await this.presence()
      return { matchId }
    })
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

  // ---- Open games (ADR amendment 2026-10-12, "Live games") --------------------
  //
  // A game here is an invite table that waits for its friend. Three ids, none
  // derived from another: the table's id and the code each seat their holder
  // directly (the table's join() still decides), and the gameId, which the
  // list shows, only lets its holder ASK the host. So no row of the list
  // names anything that seats, and approval cannot be bypassed through it.

  /**
   * Draws a code nobody holds: up to five tries, then null (the Worker
   * answers 503). Only storage is awaited between the read of `code:<c>` and
   * the caller's put, so the lobby, one object, cannot hand the same code to
   * two creates; a code of a stale row is held until the row is pruned.
   */
  private async freeCode() {
    for (let tries = 0; tries < 5; tries++) {
      const code = this.newCode()
      if ((await this.ctx.storage.get(`code:${code}`)) === undefined)
        return code
    }
    return null
  }

  /**
   * The stored `open:` rows, at most OPEN_ROWS_READ, those older than
   * GAME_PRUNE_MS deleted (with their `code:` and `gameid:` keys) as they are
   * read: pruning is lazy, so the constructor has no work and a quiet lobby
   * pays nothing.
   */
  private async openRows() {
    const t = this.clock()
    const rows = [
      ...(
        await this.ctx.storage.list<OpenGame>({
          prefix: 'open:',
          limit: OPEN_ROWS_READ,
        })
      ).entries(),
    ]
    const old = rows.filter(([, game]) => isPrunable(game, t))
    if (old.length)
      await this.ctx.storage.delete(
        old.flatMap(([key, game]) => [
          key,
          `code:${game.code}`,
          `gameid:${game.gameId}`,
        ]),
      )
    return rows.filter(([, game]) => !isPrunable(game, t))
  }

  /**
   * The table says it is open, with its host, its code and whether it is
   * listed (RPC from the table, through its ordered `listingCalls`, every
   * OPEN_HEARTBEAT_MS while the host is connected). An upsert, and the table
   * is the authority: a row that is there is refreshed; one that was pruned
   * while the host was away is made again, with its code if that is free or
   * already this game's. A code another game took meanwhile is replaced by a
   * fresh one, which comes back for the table to adopt. Because the table
   * only reports while it waits with one player, and its calls reach here in
   * order, a heartbeat cannot bring back a game that closeGame removed.
   */
  async reportOpen(
    matchId: string,
    report: OpenReport,
  ): Promise<{ code?: string }> {
    const { gameId, code, hostId, hostName, listed } = report
    // By value, as for a table's counts: a malformed report is refused whole
    // (the table logs it, lobby_open), and a row it never replaces goes stale.
    if (
      !GAME_CODE_RE.test(code) ||
      !GAME_ID_RE.test(gameId) ||
      typeof hostId !== 'string' ||
      typeof hostName !== 'string' ||
      typeof listed !== 'boolean'
    )
      throw new TypeError('An open report is a code, a handle and a host')
    const t = this.clock()
    const key = `open:${matchId}`
    const row = await this.ctx.storage.get<OpenGame>(key)
    if (row) {
      // The table has spoken, so its /init happened: no grace from here on.
      const kept: OpenGame = { ...row }
      delete kept.awaitingInit
      await this.ctx.storage.put(key, {
        ...kept,
        hostName,
        listed,
        updatedAt: t,
      } satisfies OpenGame)
      // A code the table does not know (an earlier answer was lost): its.
      return row.code === code ? {} : { code: row.code }
    }
    const holder = await this.ctx.storage.get<string>(`code:${code}`)
    const free = holder === undefined || holder === matchId
    const own = free ? code : await this.freeCode()
    if (!own) throw new Error('No free code')
    const taken = await this.ctx.storage.get(`gameid:${gameId}`)
    const handle =
      taken === undefined || taken === matchId ? gameId : newGameId()
    const rows = (await this.openRows()).map(([, g]) => g)
    await this.ctx.storage.put({
      [key]: {
        gameId: handle,
        code: own,
        hostId,
        hostName,
        listed:
          listed &&
          countOffered(rows, t) < GAMES_MAX &&
          hostOffered(rows, hostId, t) < HOST_LISTED_MAX,
        openedAt: t,
        updatedAt: t,
      } satisfies OpenGame,
      [`code:${own}`]: matchId,
      [`gameid:${handle}`]: matchId,
    })
    return own === code ? {} : { code: own }
  }

  /**
   * The game leaves the lobby: its table filled, finished or deleted itself
   * (RPC from the table, ordered after every report it sent). Idempotent,
   * and a key goes only if it still points at this game.
   */
  async closeGame(matchId: string) {
    const key = `open:${matchId}`
    const game = await this.ctx.storage.get<OpenGame>(key)
    if (!game) return
    const keys = [`code:${game.code}`, `gameid:${game.gameId}`]
    const held = await this.ctx.storage.get<string>(keys)
    await this.ctx.storage.delete([
      key,
      ...keys.filter((k) => held.get(k) === matchId),
    ])
    // A filled game is gone from the next list at once, not in 2 s.
    this.generation++
    this.snapshot = null
  }

  /**
   * The host answered a join request (RPC from the table). Only a request
   * this account still has for this game counts, so a late or repeated
   * answer does nothing. A decline, or a seat given to someone else, is
   * sent to the requester; an accept sends them `matched`, as a pairing
   * does, and says whether any lobby socket of theirs got it (the table
   * gives the seat back at once if not, rather than hold it for RESERVE_MS).
   * Not under forUsers: the table awaits this, and the requester's own
   * request holds that lock while it awaits the table.
   */
  async answerRequest(
    requesterId: string,
    matchId: string,
    state: RequestAnswer,
  ): Promise<boolean> {
    const key = `joinreq:${requesterId}`
    const req = await this.ctx.storage.get<JoinRequest>(key)
    if (
      !req ||
      req.matchId !== matchId ||
      this.clock() - req.at >= REQUEST_TTL_MS
    )
      return false
    await this.ctx.storage.delete(key)
    if (state !== 'accepted')
      return this.tell(requesterId, {
        t: 'join_status',
        state: state === 'declined' ? 'declined' : 'unavailable',
      })
    // Seated elsewhere since they asked: not here as well. The table's claim
    // at connect would refuse them anyway (4409); this spares the host a
    // minute's wait.
    if (await this.liveActive(requesterId)) {
      this.tell(requesterId, { t: 'join_status', state: 'unavailable' })
      return false
    }
    return this.tell(requesterId, { t: 'matched', matchId, resumed: false })
  }

  /** Sends `msg` to each lobby socket of `userId`; true if any got it. */
  private tell(userId: string, msg: Answer) {
    const sockets = this.ctx
      .getWebSockets(userId)
      .filter((ws) => ws.readyState === OPEN)
    for (const ws of sockets) this.send(ws, msg)
    return sockets.length > 0
  }

  // ---- Open games: the list and requests (frames) -------------------------------

  /** The reply to every lookup that finds no game: one frame, whatever the cause. */
  private unavailable(ws: WebSocket) {
    this.send(ws, { t: 'join_status', state: 'unavailable' })
  }

  /**
   * One of the account's stored buckets: `burst` tokens refilled at that
   * many per `windowMs`. Like quick-sit's they are in storage (a quiet
   * lobby hibernates within seconds, and a bucket in memory came back
   * full), keyed by day so old ones can be pruned, and the day before's
   * carries over so midnight refills nothing. `userId` null is the one
   * bucket for every account. The bucket after the spend, or null when dry;
   * `spend: false` only looks.
   */
  private async takeToken(
    prefix: string,
    userId: string | null,
    burst: number,
    windowMs: number,
    spend = true,
  ) {
    const t = this.clock()
    const yesterday = day(t - DAY_MS)
    const keys =
      userId === null
        ? [prefix]
        : [`${prefix}:${day(t)}:${userId}`, `${prefix}:${yesterday}:${userId}`]
    const stored = await this.ctx.storage.get<Bucket>(keys)
    const bucket = spendToken(
      stored.get(keys[0]) ?? stored.get(keys[1]),
      t,
      burst,
      windowMs,
    )
    if (!bucket || !spend) return bucket
    await this.ctx.storage.put(keys[0], bucket)
    // An account's first spend of the day prunes days before yesterday, at
    // most one storage delete's worth at a time.
    if (userId !== null && !stored.has(keys[0])) {
      const old = await this.ctx.storage.list({
        prefix: `${prefix}:`,
        end: `${prefix}:${yesterday}`,
        limit: 128,
      })
      if (old.size) await this.ctx.storage.delete([...old.keys()])
    }
    return bucket
  }

  /**
   * The open games, to the socket that asks (a `games` frame). The account's
   * reads are limited (GAME_LISTS); the rows come from `gamesNow`. The
   * asker's own game is left out here, after the cache, so one list serves
   * everyone. Nothing is pushed to anyone, and `presence()` is untouched:
   * the lobby is one object for every player.
   */
  private async sendGames(ws: WebSocket) {
    const { userId } = this.who(ws)
    if (
      !(await this.takeToken(
        'gameslist',
        userId,
        GAME_LISTS,
        GAME_LIST_WINDOW_MS,
      ))
    )
      return this.reject(
        ws,
        'rate_limited',
        'Too many refreshes. Try again in a moment.',
      )
    const t = this.clock()
    let snapshot: GamesSnapshot
    try {
      snapshot = await this.gamesNow(t)
    } catch (error) {
      logEvent('error', {
        userId,
        reason: 'games',
        detail: describeError(error),
      })
      return
    }
    this.send(ws, {
      t: 'games',
      games: snapshot.games
        .filter((game) => game.hostId !== userId)
        .map((game) => gameRow(game, t)),
    })
  }

  /**
   * The listed, fresh games, the longest waiting first, cut to
   * GAMES_RETURNED: one `storage.list` per GAMES_CACHE_MS however many ask,
   * and a read in flight is shared by the frames that come meanwhile.
   */
  private gamesNow(t: number): Promise<GamesSnapshot> {
    const cached = this.snapshot
    if (cached && t >= cached.at && t - cached.at < GAMES_CACHE_MS)
      return Promise.resolve(cached)
    if (this.loading) return this.loading
    const generation = this.generation
    const load = (async () => {
      const games = (await this.openRows())
        .map(([, game]) => game)
        .filter((game) => isOffered(game, t))
        .sort(byWaiting)
        .slice(0, GAMES_RETURNED)
        // By name: the code never enters the snapshot.
        .map(({ gameId, hostId, hostName, openedAt }) => ({
          gameId,
          hostId,
          hostName,
          openedAt,
        }))
      const read = { at: t, games }
      if (generation === this.generation) this.snapshot = read
      return read
    })()
    this.loading = load
    const done = () => {
      if (this.loading === load) this.loading = null
    }
    load.then(done, done)
    return load
  }

  /**
   * `join_code`: the game with this code, if it is open. A code seats its
   * holder like the table's link does (the table's join() decides), so
   * guesses are what is limited: an account's failed lookups, and all
   * accounts' together (CODE_FAILS, CODE_FAILS_GLOBAL). Every miss (unknown,
   * stale, full, closed, the asker's own) is the same frame, so a code
   * cannot be probed for why it failed.
   */
  private async joinCode(ws: WebSocket, code: string) {
    const { userId } = this.who(ws)
    try {
      await this.forUsers([userId], () => this.resolveCode(ws, userId, code))
    } catch (error) {
      // Never the code: ids and the error's name only.
      logEvent('error', {
        userId,
        reason: 'join_code',
        detail: describeError(error),
      })
      this.unavailable(ws)
    }
  }

  private async resolveCode(ws: WebSocket, userId: string, code: string) {
    // At a table already: back to it, as a queue request would be, and a
    // lookup that costs nothing.
    const active = await this.liveActive(userId)
    if (active)
      return this.send(ws, { t: 'matched', matchId: active, resumed: true })
    const mine = await this.takeToken(
      'codefail',
      userId,
      CODE_FAILS,
      CODE_FAIL_WINDOW_MS,
      false,
    )
    if (!mine) return this.tooManyCodes(ws)
    const matchId = await this.openByCode(code, userId)
    if (!matchId) {
      // A miss spends from both buckets. With the lobby's dry the miss is
      // refused rather than answered, but a hit is still served: a stranger's
      // scan must not lock an honest friend out of a code they were given.
      await this.takeToken('codefail', userId, CODE_FAILS, CODE_FAIL_WINDOW_MS)
      const all = await this.takeToken(
        'codefail',
        null,
        CODE_FAILS_GLOBAL,
        CODE_FAIL_WINDOW_GLOBAL_MS,
      )
      // The last failure the lobby tolerates this minute: one line, no code.
      // Once per trip: while a scan keeps spending each refilled token the
      // bucket stays under 1, and a line per miss would flood the log the
      // operator reads the attack in. A miss that leaves a whole token ends
      // the trip. In memory, so a lobby that woke may say it once more.
      if (all && all.tokens < 1) {
        if (!this.scanLogged)
          logEvent('limit_hit', { code: 429, reason: 'code_scan' })
        this.scanLogged = true
      } else if (all) this.scanLogged = false
      return all ? this.unavailable(ws) : this.tooManyCodes(ws)
    }
    // A hit costs nothing. The account stops looking for a heads-up opponent
    // (as quick-sit does), and the seat is not taken here: the client opens
    // the table, and its join() decides.
    this.requests.delete(userId)
    if (await this.ctx.storage.get(`queue:${userId}`)) {
      await this.ctx.storage.delete(`queue:${userId}`)
      await this.presence()
    }
    await this.dropRequest(userId)
    this.send(ws, { t: 'matched', matchId, resumed: false })
  }

  private tooManyCodes(ws: WebSocket) {
    this.reject(ws, 'rate_limited', 'Too many tries. Wait a few minutes.')
  }

  /**
   * The table with this code that still waits for a guest, or null. The row
   * must be fresh (the host's heartbeat), not the asker's own, and the table
   * must say it is open: a game whose table filled or died, with the close
   * lost on its way, is no hit; a dead one is deleted here, as `tables()`
   * drops its stale entries.
   */
  private async openByCode(code: string, userId: string) {
    const matchId = await this.ctx.storage.get<string>(`code:${code}`)
    if (!matchId) return null
    const game = await this.ctx.storage.get<OpenGame>(`open:${matchId}`)
    if (
      !game ||
      game.code !== code ||
      game.hostId === userId ||
      !isFresh(game, this.clock())
    )
      return null
    let state: Liveness
    try {
      state = await tableStub(this.env, matchId).liveness()
    } catch (error) {
      logEvent('error', {
        matchId,
        reason: 'join_code_liveness',
        detail: describeError(error),
      })
      return null
    }
    if (state === 'over') await this.closeIfOld(matchId)
    return state === 'open' ? matchId : null
  }

  /**
   * `join_request`: ask the host of a listed game for the other seat. The
   * handle can only ask: the host answers, and an accept sends the requester
   * `matched`. At most one request is pending per account, and a host's
   * decline sticks at the table. Under forUsers, like a claim, and so it
   * must not itself wait on forUsers for the same account (the table's
   * answerRequest, which it awaits, does not).
   */
  private async joinRequest(ws: WebSocket, gameId: string) {
    const { userId, username } = this.who(ws)
    try {
      await this.forUsers([userId], () =>
        this.requestSeat(ws, userId, username, gameId),
      )
    } catch (error) {
      logEvent('error', {
        userId,
        reason: 'join_request',
        detail: describeError(error),
      })
      this.unavailable(ws)
    }
  }

  private async requestSeat(
    ws: WebSocket,
    userId: string,
    username: string,
    gameId: string,
  ) {
    if (
      !(await this.takeToken(
        'joinask',
        userId,
        JOIN_REQUESTS,
        JOIN_REQUEST_WINDOW_MS,
      ))
    )
      return this.reject(
        ws,
        'rate_limited',
        'Too many requests. Wait a few minutes.',
      )
    const matchId = await this.ctx.storage.get<string>(`gameid:${gameId}`)
    const game = matchId
      ? await this.ctx.storage.get<OpenGame>(`open:${matchId}`)
      : undefined
    if (
      !matchId ||
      game?.gameId !== gameId ||
      !isOffered(game, this.clock()) ||
      game.hostId === userId
    )
      return this.unavailable(ws)
    // A host with a game of their own open is not looking for one to join.
    const t = this.clock()
    if (
      (await this.openRows()).some(
        ([, g]) => g.hostId === userId && isFresh(g, t),
      )
    )
      return this.unavailable(ws)
    const active = await this.liveActive(userId)
    if (active)
      return this.send(ws, { t: 'matched', matchId: active, resumed: true })
    // One pending request each: asking another game withdraws the first.
    const key = `joinreq:${userId}`
    const before = await this.ctx.storage.get<JoinRequest>(key)
    if (before && before.matchId !== matchId)
      this.cancelAt(before.matchId, userId)
    // Written before the table is asked, so a host who answers at once finds
    // the request; the table's answer can reach answerRequest before this
    // call returns.
    const at = this.clock()
    await this.ctx.storage.put(key, {
      matchId,
      gameId,
      at,
    } satisfies JoinRequest)
    let answer: 'ok' | 'declined' | 'no'
    try {
      answer = await tableStub(this.env, matchId).requestJoin(userId, username)
    } catch (error) {
      logEvent('error', {
        matchId,
        userId,
        reason: 'request_join',
        detail: describeError(error),
      })
      answer = 'no'
    }
    const kept = await this.ctx.storage.get<JoinRequest>(key)
    if (answer !== 'ok') {
      // Only the request just made: a newer one would have replaced it.
      if (kept?.at === at) await this.ctx.storage.delete(key)
      if (answer === 'no') await this.forgetIfOver(matchId)
      return answer === 'declined'
        ? this.send(ws, { t: 'join_status', state: 'declined' })
        : this.unavailable(ws)
    }
    // The host answered while this waited, and the requester has the answer:
    // `pending` after it would undo it.
    if (!kept || kept.at !== at) return
    this.send(ws, {
      t: 'join_status',
      state: 'pending',
      expiresInMs: REQUEST_TTL_MS,
    })
  }

  /** A game whose table is gone leaves the lobby, as `tables()` drops a stale entry. */
  private async forgetIfOver(matchId: string) {
    try {
      if ((await tableStub(this.env, matchId).liveness()) === 'over')
        await this.closeIfOld(matchId)
    } catch {
      // Left for GAME_STALE_MS.
    }
  }

  /**
   * closeGame for a table found 'over', unless its row is younger than
   * INIT_GRACE_MS: createMatch writes the row before the table's /init, and a
   * table with no match answers 'over', so a lookup in that gap would delete
   * the game being made (and the creator's code with it). A table that is
   * really gone is found again once the row is older, or goes stale.
   */
  private async closeIfOld(matchId: string) {
    const game = await this.ctx.storage.get<OpenGame>(`open:${matchId}`)
    if (game?.awaitingInit && this.clock() - game.openedAt < INIT_GRACE_MS)
      return
    await this.closeGame(matchId)
  }

  /** `cancel_request`: withdraw the pending request, in line with asking it. */
  private async cancelRequest(ws: WebSocket) {
    const { userId } = this.who(ws)
    await this.forUsers([userId], () => this.dropRequest(userId))
  }

  /**
   * Withdraws `userId`'s pending join request, if any, and tells its table,
   * best effort and not awaited: a lost cancel lapses at the table in
   * REQUEST_TTL_MS.
   */
  private async dropRequest(userId: string) {
    const key = `joinreq:${userId}`
    const req = await this.ctx.storage.get<JoinRequest>(key)
    if (!req) return
    await this.ctx.storage.delete(key)
    this.cancelAt(req.matchId, userId)
  }

  private cancelAt(matchId: string, userId: string) {
    tableStub(this.env, matchId)
      .cancelRequest(userId)
      .catch((error) =>
        logEvent('error', {
          matchId,
          reason: 'cancel_request',
          detail: describeError(error),
        }),
      )
  }

  // ---- The six-table registry (RPC from tables; P2-08) -----------------------

  /**
   * A six table's entry in the list, counts only (ADR, clarifications from
   * PR-23). The fields are copied by name, so a report that carried an
   * account would still be stored without it. One write and no read: every
   * report wakes this object, which every player shares.
   */
  async reportTable(tableId: string, report: TableReport) {
    const { seated, maxSeats, avgPot, playersPerHour } = report
    // By value too: a name where a count goes would be stored, and NaN
    // would sort anywhere in quick-sit's order. A report that is not four
    // counts is refused whole; the table logs it (lobby_report), and an
    // entry it never replaces expires.
    if (
      ![seated, maxSeats, playersPerHour].every(isCount) ||
      !(avgPot === null || isCount(avgPot))
    )
      throw new TypeError('A table report is four counts')
    await this.ctx.storage.put(`table:${tableId}`, {
      seated,
      maxSeats,
      avgPot,
      playersPerHour,
      updatedAt: this.clock(),
    } satisfies TableEntry)
  }

  /**
   * A six table that deleted itself or halted leaves the list, and no
   * longer counts against the cap if quick-sit opened it.
   */
  async removeTable(tableId: string) {
    await this.ctx.storage.delete([`table:${tableId}`, `created:${tableId}`])
  }

  /**
   * The listed six tables in quick-sit's order (listTables). Clients see
   * them through the `tables` frame (tableRow) and quick-sit, both of
   * which read here. Entries too old to trust are dropped here, on the
   * read, so a report stays a single write.
   */
  async tables(): Promise<ListedTable[]> {
    const t = this.clock()
    const rows = await this.ctx.storage.list<TableEntry>({ prefix: 'table:' })
    const stale = [...rows].filter(([, entry]) => isStale(entry, t))
    if (stale.length) await this.ctx.storage.delete(stale.map(([key]) => key))
    return listTables(
      [...rows].map(([key, entry]) => [key.slice('table:'.length), entry]),
      t,
    )
  }

  // ---- Quick-sit (P2-08b) -------------------------------------------------------

  /**
   * A six table for this account (ADR, clarifications from PR-24): the
   * table it is at, if any; else the fullest listed table with a free seat
   * this quick-sit has not `tried`; else one the lobby opened that nobody
   * has sat at yet; else a new one, under the cap. With three tried, a new
   * one first, and one of the others only if none opens. The client sits
   * there, and asks again naming the tables that refused it.
   */
  private async quickSit(ws: WebSocket, tried: string[]) {
    const { userId, username } = this.who(ws)
    // One search at a time: a heads-up search left running could pair the
    // account while it sits down at a six table. It ends even when the
    // budget refuses the quick-sit, as the client has stopped looking.
    this.requests.delete(userId)
    if (await this.ctx.storage.get(`queue:${userId}`)) {
      await this.ctx.storage.delete(`queue:${userId}`)
      await this.presence()
    }
    if (!(await this.spendQuickSit(userId))) {
      logEvent('limit_hit', { userId, code: 429, reason: 'quick_sit' })
      return this.reject(
        ws,
        'rate_limited',
        'Too many quick sits. Try again in a moment.',
      )
    }
    let answer: Answer
    try {
      answer = await this.forUsers([userId], async (): Promise<Answer> => {
        // At a table already (six or heads-up): back to it, as a queue
        // request would be. So an account at a table never opens one.
        const active = await this.liveActive(userId)
        if (active) return { t: 'matched', matchId: active, resumed: true }
        await this.forgetClosed(tried)
        await this.settleOrphans()
        return this.pickTable({ userId, username }, tried)
      })
    } catch (error) {
      // The claim is checked with its table, a call that can throw. The
      // client waits for an answer to end its seating, so it gets one.
      logEvent('error', {
        userId,
        reason: 'quick_sit',
        detail: describeError(error),
      })
      answer = {
        t: 'error',
        code: 'tables_full',
        message: 'Could not check your table just now. Try again in a moment.',
      }
    }
    this.send(ws, answer)
  }

  /**
   * Spends one of the account's quick-sits (QUICK_SITS per
   * QUICK_SIT_WINDOW_MS); false when none is left. The bucket is stored: a
   * quiet lobby hibernates within seconds, and a bucket kept in memory came
   * back full. It is keyed by day so that old ones can be pruned, and the
   * day before's carries over, so midnight refills nothing.
   */
  private async spendQuickSit(userId: string) {
    const t = this.clock()
    const yesterday = day(t - DAY_MS)
    const keys = [
      `quicksit:${day(t)}:${userId}`,
      `quicksit:${yesterday}:${userId}`,
    ]
    const stored = await this.ctx.storage.get<Bucket>(keys)
    const bucket = spendToken(
      stored.get(keys[0]) ?? stored.get(keys[1]),
      t,
      QUICK_SITS,
      QUICK_SIT_WINDOW_MS,
    )
    if (!bucket) return false
    await this.ctx.storage.put(keys[0], bucket)
    // An account's first quick-sit of the day prunes days before yesterday,
    // at most one storage delete's worth at a time.
    if (!stored.has(keys[0])) {
      const old = await this.ctx.storage.list({
        prefix: 'quicksit:',
        end: `quicksit:${yesterday}`,
        limit: 128,
      })
      if (old.size) await this.ctx.storage.delete([...old.keys()])
    }
    return true
  }

  /**
   * The tables this quick-sit tried that the lobby knows (listed, or
   * opened by it and answered), each asked whether it still exists. One
   * that is gone (deleted, its removal lost) or halted leaves the list and
   * the count. Only the table's own answer drops it: a client naming live
   * tables cannot hide them from anyone, and cannot make the lobby wake an
   * object it does not know.
   */
  private async forgetClosed(tried: string[]) {
    for (const tableId of tried) {
      const keys = [`table:${tableId}`, `created:${tableId}`]
      const known = await this.ctx.storage.get<TableEntry | Created>(keys)
      const created = known.get(keys[1]) as Created | undefined
      if (!known.has(keys[0]) && !created?.ready) continue
      let state: Liveness
      try {
        state = await tableStub(this.env, tableId).liveness()
      } catch (error) {
        logEvent('error', {
          matchId: tableId,
          reason: 'quick_sit_liveness',
          detail: describeError(error),
        })
        continue
      }
      if (state === 'over') await this.ctx.storage.delete(keys)
    }
  }

  /**
   * Opens whose /init never answered here: a record not ready and not in
   * flight was left by an earlier instance of the lobby (reset during the
   * call), or by an /init call that threw. Such a record held its account
   * to one unseated table and counted against the cap until it expired.
   * Its table says what it is: there ('open'), so the record is made ready
   * and offered; or not ('over': never made, or gone), so the record goes,
   * and nothing else is given back (the day's opening was spent). A table
   * that cannot be asked keeps its record, for removeTable or the expiry.
   */
  private async settleOrphans() {
    for (const [tableId, c] of await this.openedTables(this.clock())) {
      if (c.ready || this.opening.has(tableId)) continue
      let state: Liveness
      try {
        state = await tableStub(this.env, tableId).liveness()
      } catch (error) {
        logEvent('error', {
          matchId: tableId,
          reason: 'quick_sit_liveness',
          detail: describeError(error),
        })
        continue
      }
      // The call let other events in: only the record just asked about.
      const key = `created:${tableId}`
      const now = await this.ctx.storage.get<Created>(key)
      if (!now || now.ready || now.at !== c.at) continue
      if (state === 'over') await this.ctx.storage.delete(key)
      else await this.ctx.storage.put(key, { ...now, ready: true })
    }
  }

  /**
   * Picks or opens the table. Each pass reads afresh, and from its first
   * read to the writes that take a place under the cap only storage is
   * awaited, so the input gate holds and no other quick-sit counts in
   * between: two cannot both open the 50th. A call that lets other events
   * in (the table's /init) ends a pass.
   */
  private async pickTable(who: Who, tried: string[]): Promise<Answer> {
    const untried = (tableId: string) => !tried.includes(tableId)
    // Opens this quick-sit has waited for: each at most once.
    const waited = new Set<string>()
    let failed = false
    for (;;) {
      const t = this.clock()
      const listed = await this.tables()
      const opened = await this.openedTables(t)
      const listedIds = new Set(listed.map((row) => row.tableId))
      // Opened and nobody has sat there yet: not listed.
      const unseated = opened.filter(([tableId]) => !listedIds.has(tableId))
      // A seat: the fullest listed table with one, else a table opened that
      // nobody has sat at yet, so two players arriving together at an
      // empty lobby share one table.
      const seat =
        listed.find((row) => row.seated < row.maxSeats && untried(row.tableId))
          ?.tableId ??
        unseated.find(([tableId, c]) => c.ready && untried(tableId))?.[0]
      // An open still waiting on its /init will be such a table: one this
      // quick-sit has not tried, nor waited for already.
      const pending = unseated.find(
        ([tableId]) =>
          this.opening.has(tableId) && untried(tableId) && !waited.has(tableId),
      )?.[0]
      const wait = async (tableId: string) => {
        waited.add(tableId)
        await this.opening.get(tableId)
      }
      // Fewer than three tried: a seat comes first, then the open coming.
      // Three are leave to open a table, never a ban on a seat (below).
      if (tried.length < QUICK_SIT_TABLES) {
        if (seat) return { t: 'sit_at', tableId: seat }
        if (pending) {
          // Leaves the storage-only section: read again once it settles.
          await wait(pending)
          continue
        }
      }
      const refusal = failed
        ? 'Could not open a table just now. Try again in a moment.'
        : await this.refusal(who, listedIds, opened, unseated)
      if (!refusal) {
        const tableId = await this.open(who, t)
        if (tableId) return { t: 'sit_at', tableId }
        // The open let other events in: read again before answering.
        failed = true
        continue
      }
      // No table opens for this account: a seat it has not tried, if any,
      // or one about to be.
      if (seat) return { t: 'sit_at', tableId: seat }
      if (pending) {
        await wait(pending)
        continue
      }
      return { t: 'error', code: 'tables_full', message: refusal }
    }
  }

  /**
   * Why `who` may not open a table now, or null if it may: the cap, its own
   * table nobody has sat at yet (offered to it and everyone until someone
   * sits there), or its openings today. Storage reads only.
   */
  private async refusal(
    who: Who,
    listedIds: Set<string>,
    opened: (readonly [string, Created])[],
    unseated: (readonly [string, Created])[],
  ) {
    const counted = new Set([...listedIds, ...opened.map(([id]) => id)])
    if (counted.size >= SIX_TABLES_MAX)
      return 'Every table is full. Try again in a minute.'
    if (unseated.some(([, c]) => c.by === who.userId))
      return 'Your table is still empty. Try again in a minute.'
    const creates = await this.createsToday(who.userId)
    if (creates.made >= MATCH_CREATES_PER_DAY)
      return 'You have opened enough tables today. Try again tomorrow.'
    return null
  }

  /**
   * Opens a table for `who` at `t`: its `created:` record and the day's
   * count first (the caller has awaited only storage since its reads), and
   * only then the table's /init, which lets other events in. Its id, or
   * null if the table did not open. A table that refused its /init was not
   * made: the record goes and the day's count is given back. A call that
   * threw may have made it: both stay, for settleOrphans, removeTable or
   * the expiry to settle.
   */
  private async open(who: Who, t: number) {
    const creates = await this.createsToday(who.userId)
    const tableId = crypto.randomUUID()
    const record: Created = { at: t, by: who.userId, ready: false }
    // In flight from before its record is written: no quick-sit can see
    // the record and not the open.
    let settle = () => {}
    this.opening.set(tableId, new Promise<void>((done) => (settle = done)))
    try {
      await this.ctx.storage.put({
        [`created:${tableId}`]: record,
        [creates.key]: creates.made + 1,
      })
      await this.forgetOldCreates(creates.today)
      // The place is taken; only now a call that lets other events in.
      const init = await this.openTable(tableId, who)
      if (init === 'refused') {
        await this.ctx.storage.delete(`created:${tableId}`)
        await this.ctx.storage.put(creates.key, creates.made)
      }
      if (init !== 'made') return null
      await this.ctx.storage.put(`created:${tableId}`, {
        ...record,
        ready: true,
      })
      return tableId
    } finally {
      // Settled once the record says how it went, so whoever waited reads
      // it afresh.
      this.opening.delete(tableId)
      settle()
    }
  }

  /**
   * The tables quick-sit opened that still count (CREATED_MS), by id. Older
   * records are dropped: such a table counts through its entry, if listed.
   */
  private async openedTables(t: number) {
    const rows = await this.ctx.storage.list<Created>({ prefix: 'created:' })
    const expired = [...rows]
      .filter(([, c]) => t - c.at > CREATED_MS)
      .map(([key]) => key)
    if (expired.length) await this.ctx.storage.delete(expired)
    return [...rows]
      .filter(([, c]) => t - c.at <= CREATED_MS)
      .map(([key, c]) => [key.slice('created:'.length), c] as const)
  }

  /**
   * A new, empty six table: the internal /init pairing uses, with no
   * opponent and no start deadline. Nobody sits, and it deletes itself
   * after IDLE_MS, removing itself from the count (removeTable). 'made',
   * 'refused' (the table answered, not 2xx), or 'unknown' (the call threw).
   */
  private async openTable(
    tableId: string,
    creator: Who,
  ): Promise<'made' | 'refused' | 'unknown'> {
    const body: InitBody = { matchId: tableId, creator, kind: 'six-casual' }
    try {
      const created = await tableStub(this.env, tableId).fetch(
        'https://table/init',
        { method: 'POST', body: JSON.stringify(body) },
      )
      if (created.ok) return 'made'
      logEvent('error', {
        matchId: tableId,
        reason: 'table_init',
        code: created.status,
      })
      return 'refused'
    } catch (error) {
      logEvent('error', {
        matchId: tableId,
        reason: 'table_init',
        detail: describeError(error),
      })
      return 'unknown'
    }
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
    // Only the entry just checked: a claim may have written a newer one
    // during the await.
    const key = `active:${userId}`
    if ((await this.ctx.storage.get(key)) === matchId)
      await this.ctx.storage.delete(key)
    return null
  }

  /**
   * Runs `fn` once every earlier call for any of `userIds` has settled, and
   * holds those accounts until it settles. Each call waits only on calls
   * made before it, so two accounts taken together never deadlock; `fn`
   * must not itself wait on forUsers for the same accounts.
   */
  private forUsers<T>(userIds: string[], fn: () => Promise<T>): Promise<T> {
    const before = userIds.map((userId) => this.userLocks.get(userId))
    const run = Promise.all(before).then(fn)
    const done = run.catch(() => undefined)
    for (const userId of userIds) this.userLocks.set(userId, done)
    void done.then(() => {
      for (const userId of userIds)
        if (this.userLocks.get(userId) === done) this.userLocks.delete(userId)
    })
    return run
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

  private send(ws: WebSocket, msg: Answer) {
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
 * with none yet or a dev account. Null when the read fails: a rating that
 * could not be read is unknown, not 1500 (audit F14), so a rated search is
 * refused for a moment rather than paired as someone it may not be.
 */
async function currentRating(
  env: WorkerEnv,
  userId: string,
): Promise<number | null> {
  if (!UUID.test(userId) || !env.SUPABASE_URL) return UNRATED
  try {
    const response = await fetch(
      `${env.SUPABASE_URL}/rest/v1/ratings?select=rating&format=eq.hu-duplicate&user_id=eq.${userId}`,
      { headers: { apikey: env.SUPABASE_SECRET_KEY ?? '' } },
    )
    if (!response.ok) {
      logEvent('error', {
        userId,
        reason: 'rating_read',
        code: response.status,
      })
      return null
    }
    const rows = (await response.json()) as { rating: number }[]
    return typeof rows[0]?.rating === 'number' ? rows[0].rating : UNRATED
  } catch (error) {
    logEvent('error', {
      userId,
      reason: 'rating_read',
      detail: describeError(error),
    })
    return null
  }
}
