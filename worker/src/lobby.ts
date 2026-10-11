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
import {
  FrameBudget,
  MATCH_CREATES_PER_DAY,
  QUICK_SIT_WINDOW_MS,
  QUICK_SITS,
} from './limits'
import { describeError, logEvent } from './log'
import { ratingWindow, REPAIR_MS } from './pairing'
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
  /** And a budget for quick-sits, which cost more than a frame. */
  private quickSits = new FrameBudget(
    () => this.clock(),
    QUICK_SITS,
    QUICK_SIT_WINDOW_MS,
  )
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
   * For `POST /api/matches`: records that `userId` is at the new invite
   * table `matchId`, unless they are playing elsewhere (that table's id
   * comes back) or have made MATCH_CREATES_PER_DAY tables today (seconds
   * until the next UTC day come back). Only a table that is made counts.
   */
  createMatch(
    userId: string,
    matchId: string,
  ): Promise<{ active?: string; retryAfter?: number }> {
    return this.forUsers([userId], async () => {
      const active = await this.liveActive(userId)
      if (active) return { active }
      const creates = await this.createsToday(userId)
      if (creates.made >= MATCH_CREATES_PER_DAY)
        return { retryAfter: creates.retryAfter }
      await this.ctx.storage.put({
        [creates.key]: creates.made + 1,
        [`active:${userId}`]: matchId,
      })
      await this.forgetOldCreates(creates.today)
      return {}
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
   * has sat at yet; else a new one, under the cap. The client sits there,
   * and asks again naming the tables that refused it.
   */
  private async quickSit(ws: WebSocket, tried: string[]) {
    const { userId, username } = this.who(ws)
    if (!this.quickSits.spend(userId)) {
      logEvent('limit_hit', { userId, code: 429, reason: 'quick_sit' })
      return this.reject(
        ws,
        'rate_limited',
        'Too many quick sits. Try again in a moment.',
      )
    }
    // One search at a time: a heads-up search left running could pair the
    // account while it sits down at a six table.
    this.requests.delete(userId)
    if (await this.ctx.storage.get(`queue:${userId}`)) {
      await this.ctx.storage.delete(`queue:${userId}`)
      await this.presence()
    }
    let answer: Answer
    try {
      answer = await this.forUsers([userId], async (): Promise<Answer> => {
        // At a table already (six or heads-up): back to it, as a queue
        // request would be. So an account at a table never opens one.
        const active = await this.liveActive(userId)
        if (active) return { t: 'matched', matchId: active, resumed: true }
        await this.forgetClosed(tried)
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
   * Picks or opens the table. From the first read to the writes that take
   * a place under the cap only storage is awaited, so the input gate holds
   * and no other quick-sit counts in between: two cannot both open the
   * 50th. The table's /init, which lets other events in, comes after.
   */
  private async pickTable(who: Who, tried: string[]): Promise<Answer> {
    const t = this.clock()
    const listed = await this.tables()
    const opened = await this.openedTables(t)
    const listedIds = new Set(listed.map((row) => row.tableId))
    // Opened and nobody has sat there yet: not listed.
    const unseated = opened.filter(([tableId]) => !listedIds.has(tableId))
    if (tried.length < QUICK_SIT_TABLES) {
      const free = listed.find(
        (row) => row.seated < row.maxSeats && !tried.includes(row.tableId),
      )
      if (free) return { t: 'sit_at', tableId: free.tableId }
      // Two players arriving together at an empty lobby share one table.
      const waiting = unseated.find(
        ([tableId, c]) => c.ready && !tried.includes(tableId),
      )
      if (waiting) return { t: 'sit_at', tableId: waiting[0] }
    }
    const full = (message: string): Answer => ({
      t: 'error',
      code: 'tables_full',
      message,
    })
    const counted = new Set([...listedIds, ...opened.map(([id]) => id)])
    if (counted.size >= SIX_TABLES_MAX)
      return full('Every table is full. Try again in a minute.')
    // One table nobody has sat at per account: it is offered to this
    // account (and everyone) until someone sits there.
    if (unseated.some(([, c]) => c.by === who.userId))
      return full('Your table is still empty. Try again in a minute.')
    const creates = await this.createsToday(who.userId)
    if (creates.made >= MATCH_CREATES_PER_DAY)
      return full('You have opened enough tables today. Try again tomorrow.')
    const tableId = crypto.randomUUID()
    const record: Created = { at: t, by: who.userId, ready: false }
    await this.ctx.storage.put({
      [`created:${tableId}`]: record,
      [creates.key]: creates.made + 1,
    })
    await this.forgetOldCreates(creates.today)
    // The place is taken; only now a call that lets other events in.
    if (!(await this.openTable(tableId, who))) {
      await this.ctx.storage.delete(`created:${tableId}`)
      await this.ctx.storage.put(creates.key, creates.made)
      return full('Could not open a table just now. Try again in a moment.')
    }
    await this.ctx.storage.put(`created:${tableId}`, { ...record, ready: true })
    return { t: 'sit_at', tableId }
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
   * after IDLE_MS, removing itself from the count (removeTable).
   */
  private async openTable(tableId: string, creator: Who) {
    const body: InitBody = { matchId: tableId, creator, kind: 'six-casual' }
    try {
      const created = await tableStub(this.env, tableId).fetch(
        'https://table/init',
        { method: 'POST', body: JSON.stringify(body) },
      )
      if (created.ok) return true
      logEvent('error', {
        matchId: tableId,
        reason: 'table_init',
        code: created.status,
      })
    } catch (error) {
      logEvent('error', {
        matchId: tableId,
        reason: 'table_init',
        detail: describeError(error),
      })
    }
    return false
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
