// One Durable Object per match. It is the only place a live hand exists:
// it holds the deck, applies every action through the engine, writes the new
// state durably, and only then tells each seat what that seat may see.
import { DurableObject } from 'cloudflare:workers'
import {
  commitDeck,
  dealSlots,
  fromBase64,
  publicSlots,
  revealSlots,
  toBase64,
} from '../../src/engine/deck'
import { act, assertInvariants, isOver, startHand } from '../../src/engine/hand'
import { luckAdjusted } from '../../src/engine/luck'
import type { Blinds } from '../../src/engine/positions'
import { seatView } from '../../src/engine/redact'
import { buyIn, rebuyTo, SIX_BLINDS } from '../../src/engine/stacks'
import type { RevealedSlot } from '../../src/engine/deck'
import { EngineError } from '../../src/engine/types'
import type { HandState, SeatId } from '../../src/engine/types'
import {
  CLOSE_ABUSE,
  CLOSE_ELSEWHERE,
  CLOSE_GONE,
  CLOSE_RATE_LIMITED,
  MAX_FRAME,
  parseClientMsg,
  PROTOCOL,
} from '../../src/shared/protocol'
import type {
  ErrorCode,
  HandRecordV1,
  MatchConfig,
  MatchEndReason,
  MatchInfo,
  MatchKind,
  Outcome,
  RatingChange,
  RematchState,
  Reveal,
  SeatStatus,
  ServerMsg,
} from '../../src/shared/protocol'
import { now } from './clock'
import { CashController, LocalController } from './controller'
import type { Roster, TableController } from './controller'
import {
  bankAfter,
  earliest,
  FORFEIT_TIMEOUTS,
  IDLE_MS,
  INVITE_TTL_MS,
  isCurrentTurn,
  orbitDone,
  outboxBackoff,
  SIT_OUT_TIMEOUTS,
  timeoutAction,
  turnDeadline,
} from './deadlines'
import type { Deadline } from './deadlines'
import type { WorkerEnv } from './env'
import { FrameBudget, ILLEGAL_PER_HAND } from './limits'
import { lobbyStub } from './lobby'
import type { RematchAnswer } from './lobby'
import { describeError, logEvent } from './log'
import { GRACE_MS, outcomes, RATED_CONFIG, REMATCH_MS } from './rated'
import { archive, refusedForData } from './supabase'
import type { ArchiveCall, ArchiveOutcome } from './supabase'
import { applyRating } from './rating'
import type { RateCall } from './rating'
import type { HandMessage } from './verify'

export const DEFAULT_CONFIG: MatchConfig & { handsTotal: number } = {
  kind: 'hu-casual',
  handsTotal: 20,
  startingStack: 2000,
  blinds: { sb: 10, bb: 20 },
  decisionMs: 20_000,
  bankMs: 60_000,
}
/**
 * Casual 6-max (ADR amendment 2026-10-10, Phase 2): six seats, a 100 bb
 * buy-in at 10/20, 20 s per decision and a 30 s bank, full again at every
 * orbit. No length: the table deals while two players can be dealt in.
 */
export const SIX_CONFIG: MatchConfig = {
  kind: 'six-casual',
  maxSeats: 6,
  startingStack: buyIn(SIX_BLINDS.bb),
  blinds: { ...SIX_BLINDS },
  decisionMs: 20_000,
  bankMs: 30_000,
  bankRefill: 'orbit',
}
/** Pause after a hand so both players see the result. */
export const NEXT_HAND_MS = 3000
/**
 * Six-casual: a player who stood may sit at the same table again once this
 * many hands have been dealt there, or SIT_COOLDOWN_MS has passed, whichever
 * comes first (ADR amendment 2026-10-10, "Standing up"). It keeps a player
 * from standing to dodge the blinds; the time limit keeps a table of two,
 * which deals nothing without them, from locking them out.
 */
export const SIT_COOLDOWN_HANDS = 6
export const SIT_COOLDOWN_MS = 120_000
/**
 * Six-casual sessions (ADR amendment 2026-10-10, "Sessions in the
 * archive"): a session ends after this many hands, once its outbox is
 * empty, and the next deal starts a new one.
 */
export const SESSION_HANDS = 1000
/**
 * A session whose calls are still queued deals no hand past this many, so
 * its hands and its end always fit under the outbox's 4-digit keys.
 */
export const SESSION_DEAL_LIMIT = 9000
/**
 * Refusals for bad data after which an archive call is set aside (about half
 * an hour of retries; S7-13). Outages and key errors never count.
 */
export const OUTBOX_MAX_REFUSALS = 12
/** Fallback retry for queued archive calls if the immediate send is lost. */
export const OUTBOX_SAFETY_MS = 30_000

type Player = {
  seat: SeatId
  userId: string
  username: string
  /**
   * Time bank left: for the match (casual heads-up), for its half (rated),
   * or until the next orbit starts (six-casual, where a player who sits
   * starts with the whole bank). It is this account's, read through the
   * hand's seat-to-account map, so a seat's next player never inherits it.
   */
  bankMs: number
  /** Missed decisions in a row; any move of their own resets it. */
  timeouts: number
  /**
   * Rated: gone past the grace since then; their turns are played at once,
   * and a turn that began while they were away costs no bank.
   */
  awaySince?: number
  /**
   * Six-casual: chips as of the last deal they were dealt into (or the
   * buy-in until then). The hand in play holds the live stack.
   */
  stack?: number
  status?: SeatStatus
  /** Six-casual: sat down since the last deal (dealt in without posting). */
  justSat?: boolean
  /**
   * Six-casual: stood up during a hand they were dealt into. They fold when
   * the action reaches them and keep the seat until the hand ends: the
   * hand's moves still read the seat's account from here.
   */
  standing?: boolean
}
/**
 * When an account that stood may sit at this table again: once the table's
 * hand count reaches `hands`, or at `until`, whichever comes first.
 */
type Cooldown = { hands: number; until: number }
/** One seat of a hand and the account dealt into it, fixed at the deal. */
type Dealt = { seat: SeatId; userId: string; username: string }
type Match = {
  v: 1
  id: string
  config: MatchConfig
  status: 'waiting' | 'playing' | 'finished'
  players: Player[]
  handNo: number
  /** Running result per seat over the match (heads-up). */
  net: Record<SeatId, number>
  /**
   * Six-casual: the session's running result per account, since seats
   * change hands. It starts over with each session, so it holds only the
   * accounts of one session, not every account that ever sat here.
   */
  netByUser?: Record<string, number>
  /**
   * Six-casual: the last deal's blinds, whole (the small blind's seat even
   * when it was dead), for the next deal; null before the first.
   */
  blinds?: Blinds | null
  /**
   * Six-casual: seats the big blind has travelled since the orbit started
   * (orbitDone), 0 to 5. Kept across idle gaps and sessions, as `blinds`.
   */
  orbitTravel?: number
  /**
   * Six-casual: who was dealt into hand `handNo`, fixed at its deal. Every
   * frame and archive call about that hand reads this, never `players`, so
   * whoever sits in a seat later gets nothing of the hand.
   */
  dealt?: Dealt[]
  /**
   * Six-casual: hands dealt at this table, across sessions. Cooldowns and
   * stack settling count in these, since a session's handNo restarts.
   */
  tableHands?: number
  /** Six-casual: the table hand (tableHands) whose final stacks are in `players`. */
  settled?: number
  /** Six-casual: accounts that stood here recently, by account. */
  cooldowns?: Record<string, Cooldown>
  /**
   * Six-casual, from the second session on: the session's own matchId and
   * its number (the first session is the table id, number 1). Frames and
   * the archive carry the session's id; the lobby knows the table's.
   */
  sessionId?: string
  session?: number
  /** Six-casual: the session has ended; the next deal starts another. */
  sessionOver?: boolean
  /** Six-casual: missed decisions this session, by account. */
  sessionTimeouts?: Record<string, number>
  /** Six-casual: the accounts dealt into the session's hands so far. */
  sessionUsers?: string[]
  /**
   * Six-casual: dealing waits for the outbox to drain (SESSION_DEAL_LIMIT).
   */
  dealsHeld?: boolean
  endReason?: MatchEndReason
  forfeit?: SeatId
  noShow?: SeatId[]
  /** Seats gone past the grace when the match was abandoned (void). */
  abandoned?: SeatId[]
  /**
   * Rated: the luck-adjusted total per seat, through hand
   * `adjustedThrough` (settled after each hand; see settleLuck).
   */
  adjusted?: Record<SeatId, number>
  adjustedThrough?: number
  /** Rated, once finished and not void. */
  outcome?: Record<SeatId, Outcome>
  /** Rated: the match this one is a rematch of. */
  rematchOf?: string
  /** Rated, finished with a result: the rematch offer (P1-04). */
  rematch?: Rematch
  /** Rated, once applied: each seat's rating change (P1-12). */
  rating?: Record<SeatId, RatingChange>
}
type Rematch = {
  state: RematchState
  pressed: SeatId[]
  until?: number
  next?: string
}
/** The hand in progress: its commitment and per-action timing. */
type Current = {
  handNo: number
  commitment: string
  startedAt: number
  turnStartedAt: number
  timing: { atMs: number; decisionMs: number; source: 'client' | 'timeout' }[]
}
/**
 * The last finished hand, re-sent to anyone who (re)joins before the next.
 * `own` holds the opening of each dealt account's own hole slots, keyed by
 * account; an account only ever receives its own.
 */
type Ended = {
  record: HandRecordV1
  reveal: Reveal
  own?: Record<string, RevealedSlot[]>
}
/**
 * A socket knows only its account. Its seat, in the hand on the table or at
 * the table, is looked up for every frame (Dealt, Match.players).
 */
type Attachment = { userId: string; username: string }
type Ack = { reqId: string; seq: number }
/**
 * A queued call: an archive function, or a hand for the verify queue. Hands
 * and the match must reach Postgres in order, so an archive failure stops the
 * flush; a verify send or an incident report never holds up what follows.
 */
export type Outbox = (ArchiveCall | { send: HandMessage }) & {
  attempts: number
  /** Of those attempts, how many Postgres refused for the call's data. */
  refused?: number
}
export type InitBody = {
  matchId: string
  creator: { userId: string; username: string }
  /** Set by the lobby: both seats are taken from the start. */
  opponent?: { userId: string; username: string }
  /** Set by the lobby: both must connect within this time. */
  startWithinMs?: number
  handsTotal?: number
  /** Set by the lobby: a rated match plays RATED_CONFIG (no handsTotal). */
  kind?: MatchKind
  /** Set by the lobby: the rated match this one is a rematch of. */
  rematchOf?: string
}
/**
 * For the lobby's one-table-per-account rule: `playing`, or `starting` (a
 * paired table waiting for its players) holds an account; an `open` invite
 * nobody has joined, or an `over` table, does not. A six table holds exactly
 * the accounts seated at it.
 */
export type Liveness = 'playing' | 'starting' | 'open' | 'over'

const OPEN = 1
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const json = (body: unknown, status = 200) => Response.json(body, { status })
const pad = (n: number) => String(n).padStart(4, '0')
/** A rated hand's calls wait here until its luck is settled (settleLuck). */
const heldKey = (n: number, what: string) => `held:${pad(n)}:${what}`
/** Void endings: nobody wins or loses a rated match that ends so. */
const VOID: MatchEndReason[] = ['no_show', 'engine_fault', 'abandoned']

export class TableDO extends DurableObject<WorkerEnv> {
  private match: Match | null = null
  private hand: HandState | null = null
  private current: Current | null = null
  private ended: Ended | null = null
  private deadlines: Deadline[] = []
  private seq = 0
  /** The last applied move per account. */
  private lastAck: Record<string, Ack> = {}
  private flushing = false
  /** A call was queued while a flush was under way: that flush goes again. */
  private flushAgain = false
  /**
   * A deal is under way. Work that is not an event (a flush finishing)
   * still runs during its awaits, and must not end its session meanwhile.
   */
  private dealing = false
  controller: TableController = new LocalController()
  /** Six-casual tables deal from their roster (tests replace it). */
  sixController: TableController = new CashController()
  /** The table's clock; tests move it instead of waiting. */
  clock: () => number = now
  /** Frames and connects that do not move the game, per account. */
  private budget = new FrameBudget(() => this.clock())
  /** Illegal frames per account in the current hand. */
  private illegalCount = new Map<string, { handNo: number; n: number }>()
  /**
   * Six-casual: accounts whose sit waits on the lobby's claim, with how
   * many sits. The lobby may grant the claim and weigh another table's
   * claim for the same account before the grant gets back here, so this
   * table holds them from the moment it asks (liveness).
   */
  private claiming = new Map<string, number>()
  /**
   * Six-casual: releases still on their way to the lobby, by account. Two
   * calls from here are not ordered on the way, so a release that landed
   * after a later sit's claim would delete that claim: the account would
   * be seated here with the lobby thinking it free. A sit waits for these.
   */
  private releasing = new Map<string, Promise<void>>()

  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env)
    // Keepalives are answered without waking the object.
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('ping', 'pong'),
    )
    void ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get([
        'match',
        'hand',
        'current',
        'ended',
        'deadlines',
        'seq',
        'lastAck',
      ])
      this.match = (stored.get('match') as Match | undefined) ?? null
      this.hand = (stored.get('hand') as HandState | undefined) ?? null
      this.current = (stored.get('current') as Current | undefined) ?? null
      this.ended = (stored.get('ended') as Ended | undefined) ?? null
      this.deadlines = (stored.get('deadlines') as Deadline[]) ?? []
      this.seq = (stored.get('seq') as number | undefined) ?? 0
      this.lastAck = (stored.get('lastAck') as Record<string, Ack>) ?? {}
    })
  }

  // ---- Requests from the Worker (never from the internet) ----------------

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url)
    if (pathname === '/init' && request.method === 'POST')
      return this.init((await request.json()) as InitBody)
    if (pathname === '/connect') {
      const userId = request.headers.get('x-user-id')
      const username = request.headers.get('x-username')
      if (!userId || !username) return json({ error: 'unauthorized' }, 401)
      return this.join(userId, username)
    }
    return json({ error: 'not found' }, 404)
  }

  private async init(body: InitBody) {
    if (this.match) return json({ error: 'exists' }, 409)
    // A six table starts empty and has no start deadline: a paired
    // opponent or one would make a Player without a stack or status.
    if (body.kind === 'six-casual' && (body.opponent || body.startWithinMs))
      return json({ error: 'six tables start empty' }, 400)
    const handsTotal =
      Number.isInteger(body.handsTotal) &&
      body.handsTotal! >= 1 &&
      body.handsTotal! <= 100
        ? body.handsTotal!
        : DEFAULT_CONFIG.handsTotal
    const rated = body.kind === 'hu-rated'
    const six = body.kind === 'six-casual'
    const config = rated
      ? { ...RATED_CONFIG }
      : six
        ? { ...SIX_CONFIG }
        : { ...DEFAULT_CONFIG, handsTotal }
    this.match = {
      v: 1,
      id: body.matchId,
      config,
      status: 'waiting',
      players: [],
      handNo: 0,
      net: six ? {} : { 0: 0, 1: 0 },
      ...(six
        ? {
            netByUser: {},
            blinds: null,
            orbitTravel: 0,
            tableHands: 0,
            sessionTimeouts: {},
          }
        : {}),
      ...(rated ? { adjusted: { 0: 0, 1: 0 }, adjustedThrough: 0 } : {}),
      ...(rated && body.rematchOf ? { rematchOf: body.rematchOf } : {}),
    }
    // A six table starts empty: everyone, its creator too, takes a seat
    // with `sit`.
    if (!six) this.match.players.push(this.newPlayer(0, body.creator))
    if (body.opponent) this.match.players.push(this.newPlayer(1, body.opponent))
    // A paired table must start soon; an invite waits for its friend, but
    // not forever; a six table nobody sits at closes like a finished one.
    this.deadlines = [
      body.startWithinMs
        ? { kind: 'start', at: this.clock() + body.startWithinMs }
        : { kind: 'idle', at: this.clock() + (six ? IDLE_MS : INVITE_TTL_MS) },
    ]
    await this.ctx.storage.put({
      match: this.match,
      seq: this.seq,
      deadlines: this.deadlines,
    })
    await this.armAlarm()
    return json({ matchId: body.matchId }, 201)
  }

  /** RPC from the lobby: whether this table holds `userId`. */
  async liveness(userId?: string): Promise<Liveness> {
    const match = this.match
    if (!match || match.status === 'finished') return 'over'
    // A six table holds whoever has a seat, dealt in or not, and nobody
    // else: a player alone at it is still at it, one who stood is not.
    if (match.config.kind === 'six-casual')
      return userId !== undefined &&
        (this.claiming.has(userId) || this.atTable(userId))
        ? 'playing'
        : 'open'
    if (match.status === 'playing') return 'playing'
    return match.players.length === 2 ? 'starting' : 'open'
  }

  private newPlayer(
    seat: SeatId,
    who: { userId: string; username: string },
  ): Player {
    return { seat, ...who, bankMs: this.match!.config.bankMs, timeouts: 0 }
  }

  private async join(userId: string, username: string) {
    const match = this.match
    // Cleaned up (or never existed): say so, and store nothing.
    if (!match) return this.refuse(CLOSE_GONE, 'closed')
    // A connect costs a frame, so reconnecting does not refill a budget.
    if (!this.budget.spend(userId)) {
      logEvent('limit_hit', {
        matchId: match.id,
        userId,
        code: CLOSE_RATE_LIMITED,
        reason: 'connects',
      })
      return this.refuse(CLOSE_RATE_LIMITED, 'Too many connections')
    }
    const six = match.config.kind === 'six-casual'
    let player = match.players.find((p) => p.userId === userId)
    // At a six table a socket starts without a seat, and sits with `sit`.
    if (!player && !six) {
      // Invite link: the first other account to open it takes the empty seat.
      if (match.status !== 'waiting' || match.players.length >= 2)
        return json({ error: 'table full' }, 403)
      // One table per account: someone playing elsewhere is sent back there.
      const elsewhere = await lobbyStub(this.env).claim(userId, match.id)
      if (elsewhere) return this.refuse(4409, elsewhere)
      // The claim awaited, so another join may have run meanwhile. If it
      // seated this same account (a second tab), join as that seat: releasing
      // here would free an account that is now playing at this table.
      player = match.players.find((p) => p.userId === userId)
      if (!player) {
        if (match.players.length >= 2) {
          await lobbyStub(this.env).release([userId], match.id)
          return json({ error: 'table full' }, 403)
        }
        player = this.newPlayer(1, { userId, username })
        match.players.push(player)
        await this.ctx.storage.put('match', match)
      }
    }
    if (player) await this.back(player)
    // One socket per account: a second tab replaces the first.
    for (const old of this.ctx.getWebSockets(userId))
      old.close(4001, 'replaced')
    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    this.ctx.acceptWebSocket(server, [userId])
    server.serializeAttachment({ userId, username } satisfies Attachment)
    this.send(server, this.frame('welcome', userId))
    this.sendEnded(server)
    this.sendMatchEnd(server)
    if (
      !six &&
      match.status === 'waiting' &&
      match.players.length === 2 &&
      match.players.every((p) => this.connected(p.userId))
    ) {
      match.status = 'playing'
      await this.startNextHand()
    } else if (
      six &&
      player &&
      match.status === 'waiting' &&
      match.players.length >= 2
    ) {
      // A seated player back at a waiting six table: deal if two are here.
      match.status = 'playing'
      await this.startNextHand()
    } else if (player) this.broadcast('state', { skip: server })
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { 'Sec-WebSocket-Protocol': PROTOCOL },
    })
  }

  /**
   * Browsers cannot read why an upgrade failed, so a refusal the player
   * should understand is an accepted socket closed with a code and reason.
   */
  private refuse(code: number, reason: string) {
    const pair = new WebSocketPair()
    pair[1].accept()
    pair[1].close(code, reason)
    return new Response(null, {
      status: 101,
      webSocket: pair[0],
      headers: { 'Sec-WebSocket-Protocol': PROTOCOL },
    })
  }

  // ---- Socket events (hibernation API) ------------------------------------

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    // Frames still in flight from a socket we already closed do nothing.
    if (ws.readyState !== OPEN || !this.match) return
    const { userId } = ws.deserializeAttachment() as Attachment
    if (!this.budget.spend(userId))
      return this.cutOff(
        ws,
        CLOSE_RATE_LIMITED,
        'rate_limited',
        'Too many messages',
      )
    const size =
      typeof message === 'string' ? message.length : message.byteLength
    // Refused unread: parsing is the cost an oversized frame imposes.
    if (size > MAX_FRAME)
      return this.cutOff(ws, CLOSE_ABUSE, 'too_large', 'Message too large')
    const msg = typeof message === 'string' ? parseClientMsg(message) : null
    if (!msg) return this.illegal(ws, userId, 'Malformed message')
    if (msg.t === 'resync') {
      this.send(ws, this.frame('welcome', userId))
      this.sendEnded(ws)
      return this.sendMatchEnd(ws)
    }
    if (msg.t === 'rematch') return this.pressRematch(ws, userId)
    if (msg.t === 'sit') return this.sit(ws, msg.seat)
    if (msg.t === 'stand') return this.stand(ws)
    if (msg.t === 'rebuy') return this.rebuy(ws)
    if (msg.t === 'sit_out') return this.sitOutMsg(ws)
    if (msg.t === 'sit_in') return this.sitInMsg(ws)
    if (msg.t !== 'act') return this.illegal(ws, userId, 'Not a table message')
    // Nobody without a seat acts, and the reply carries no hand.
    if (!this.atTable(userId))
      return this.reject(ws, 'not_your_turn', 'Take a seat to play', msg.reqId)

    // A retry of the action we already applied: acknowledge it again.
    if (this.ackOf(userId)?.reqId === msg.reqId)
      return this.send(ws, this.frame('state', userId))
    // A player who stood folds when the action reaches them; they make no
    // more decisions in this hand, whatever reaches the table first.
    if (this.match!.players.some((p) => p.userId === userId && p.standing))
      return this.reject(ws, 'not_your_turn', 'You have stood up', msg.reqId)
    const hand = this.hand
    if (
      !hand ||
      this.match?.status !== 'playing' ||
      isOver(hand) ||
      msg.handNo !== hand.config.handNo ||
      msg.actionIndex !== hand.actions.length
    ) {
      this.reject(ws, 'stale', 'That decision has passed', msg.reqId)
      return this.send(ws, this.frame('state', userId))
    }
    // The seat this account was dealt into in this hand, if any.
    const seat = this.handSeat(userId)
    if (seat === null || hand.toAct !== seat)
      return this.reject(ws, 'not_your_turn', 'Wait for your turn', msg.reqId)
    let next: HandState
    try {
      next = act(hand, seat, msg.action)
    } catch (error) {
      if (error instanceof EngineError)
        return this.illegal(ws, userId, error.message, msg.reqId)
      throw error
    }
    await this.applyAction(seat, next, 'client', msg.reqId)
    // A move the table applied is play, not noise: it costs nothing. Moves
    // are paced by the opponent, so they cannot flood.
    this.budget.refund(userId)
  }

  /**
   * A six-table socket takes `wanted`, or the lowest free seat, with a
   * buy-in of 100 bb. Who sits is the socket's account (from its token); a
   * seat taken during a hand is dealt in from the next one (R-20). With two
   * or more seated and no hand under way, the next hand deals now. The
   * lobby claims the account first: one table per account, so a player
   * seated elsewhere is closed with that table's id, as at an invite.
   */
  private async sit(ws: WebSocket, wanted?: SeatId) {
    const match = this.match!
    const { userId, username } = ws.deserializeAttachment() as Attachment
    if (!this.seatable())
      return this.illegal(ws, userId, 'There is no seat to take here')
    // Already seated: nothing changes, and the welcome says where.
    if (this.atTable(userId))
      return this.send(ws, this.frame('welcome', userId))
    const cooldown = this.cooldownOf(userId)
    if (cooldown)
      return this.send(ws, {
        t: 'error',
        seq: this.seq,
        matchId: this.matchId(),
        code: 'sit_cooldown',
        message: 'You stood up here a moment ago',
        ...cooldown,
      })
    if (this.seatFor(ws, userId, wanted) === null) return
    // A release of this account from here still on its way would land
    // after this claim and delete it.
    await this.releasing.get(userId)
    // Held from here until the account is seated below, or not (liveness).
    this.claiming.set(userId, (this.claiming.get(userId) ?? 0) + 1)
    let elsewhere: string | null
    try {
      elsewhere = await lobbyStub(this.env).claim(userId, match.id)
    } finally {
      const left = this.claiming.get(userId)! - 1
      if (left) this.claiming.set(userId, left)
      else this.claiming.delete(userId)
    }
    if (elsewhere) {
      ws.close(CLOSE_ELSEWHERE, elsewhere)
      return this.socketGone(ws)
    }
    // The claim awaited, so other frames may have run meanwhile: another
    // tab of this account may have sat (keep its claim), or the seat gone.
    if (this.match !== match || !this.seatable()) return
    if (this.atTable(userId))
      return this.send(ws, this.frame('welcome', userId))
    const seat = this.seatFor(ws, userId, wanted)
    if (seat === null) return this.releaseSeats([userId])
    const player: Player = {
      ...this.newPlayer(seat, { userId, username }),
      // The buy-in is the server's: the frame carries no amount.
      stack: match.config.startingStack,
      status: 'playing',
      justSat: true,
    }
    match.players = [...match.players, player].sort((a, b) => a.seat - b.seat)
    this.seq++
    await this.ctx.storage.put({ match, seq: this.seq })
    this.send(ws, this.frame('welcome', userId))
    this.broadcast('state', { skip: ws, roster: true })
    if (match.status === 'waiting' && match.players.length >= 2) {
      match.status = 'playing'
      await this.startNextHand()
    }
  }

  /** Whether this is a six table that still seats players. */
  private seatable() {
    const match = this.match
    return match?.config.kind === 'six-casual' && match.status !== 'finished'
  }

  /**
   * The seat `wanted`, or the lowest free one, if it can be taken now;
   * otherwise tells the socket why and returns null.
   */
  private seatFor(ws: WebSocket, userId: string, wanted?: SeatId) {
    const match = this.match!
    const seats = Array.from(
      { length: match.config.maxSeats ?? 6 },
      (_, i) => i,
    )
    const free = seats.filter((s) => !match.players.some((p) => p.seat === s))
    if (!free.length) {
      this.reject(ws, 'table_full', 'Every seat is taken')
      return null
    }
    if (wanted !== undefined && !seats.includes(wanted)) {
      this.illegal(ws, userId, 'There is no such seat')
      return null
    }
    if (wanted !== undefined && !free.includes(wanted)) {
      this.reject(ws, 'seat_taken', 'That seat is taken')
      return null
    }
    return wanted ?? free[0]
  }

  /** How long `userId`, who stood here, still waits to sit; null if not. */
  private cooldownOf(userId: string) {
    const match = this.match!
    const cooldown = match.cooldowns?.[userId]
    if (!cooldown) return null
    const handsLeft = cooldown.hands - (match.tableHands ?? 0)
    if (handsLeft <= 0 || this.clock() >= cooldown.until) return null
    return { handsLeft, until: cooldown.until }
  }

  /**
   * A six-table player leaves their seat. Dealt into the hand being played,
   * they keep the seat until it ends: their cards are that seat's until
   * then, and nobody else may take it. They fold when the action reaches
   * them, at once if it already has. Otherwise the seat frees now. Either
   * way the answer is a welcome saying where they sit.
   */
  private async stand(ws: WebSocket) {
    const match = this.match!
    const { userId } = ws.deserializeAttachment() as Attachment
    if (!this.seatable())
      return this.illegal(ws, userId, 'There is no seat to leave here')
    const player = match.players.find((p) => p.userId === userId)
    if (!player) return this.reject(ws, 'not_seated', 'You have no seat here')
    const seat = this.handSeat(userId)
    if (!this.hand || isOver(this.hand) || seat === null) {
      this.unseat([player])
      // The last player left a table that deals nothing. An open session
      // still ends IDLE_MS after its last hand started, as waitForPlayers
      // armed it (idle keeps the table IDLE_MS after that); with none open,
      // the table deletes itself IDLE_MS from now.
      if (!match.players.length && match.status === 'waiting')
        this.setGameDeadline(this.idleDeadline())
      this.seq++
      await this.ctx.storage.put({
        match,
        seq: this.seq,
        deadlines: this.deadlines,
      })
      await this.armAlarm()
      this.send(ws, this.frame('welcome', userId))
      this.broadcast('state', { skip: ws, roster: true })
      return this.releaseSeats([userId])
    }
    if (!player.standing) {
      player.standing = true
      // Their turn now: due at once, should the fold below be lost.
      if (this.hand.toAct === seat)
        this.setGameDeadline(
          this.turnFor(this.hand, this.current!.turnStartedAt),
        )
      this.seq++
      await this.ctx.storage.put({
        match,
        seq: this.seq,
        deadlines: this.deadlines,
      })
      await this.armAlarm()
    }
    this.send(ws, this.frame('welcome', userId))
    const hand = this.hand
    if (!isOver(hand) && hand.toAct === seat)
      await this.applyAction(seat, act(hand, seat, { type: 'fold' }), 'client')
  }

  /**
   * A six-table player tops up to 100 bb (ADR amendment 2026-10-10, "Stacks
   * and rebuy"). Allowed while the account is not dealt into the hand being
   * played (one who sat after the deal is not in it) and its stack is below
   * 100 bb; the chips play from the next hand. The amount is the server's,
   * from the stack: the frame carries none. Credited before any await, so a
   * second rebuy finds the stack at 100 bb. The answer is a welcome, and
   * everyone else sees the new stack.
   */
  private async rebuy(ws: WebSocket) {
    const match = this.match!
    const { userId } = ws.deserializeAttachment() as Attachment
    if (!this.seatable())
      return this.illegal(ws, userId, 'There is no stack to top up here')
    const player = match.players.find((p) => p.userId === userId)
    if (!player) return this.reject(ws, 'not_seated', 'You have no seat here')
    const hand = this.hand
    const inHand = !!hand && !isOver(hand) && this.handSeat(userId) !== null
    // Between hands, the stack the last hand left, not the one it began with.
    const stack = this.stackOf(player)
    const topUp = rebuyTo(stack, match.config.blinds.bb, inHand)
    if (topUp.refused)
      return this.reject(
        ws,
        topUp.refused,
        topUp.refused === 'in_hand'
          ? 'You can rebuy once this hand is over'
          : 'You already have 100 big blinds',
      )
    // The finished hand's stacks are settled now rather than at the next
    // deal, which would otherwise set this player's stack back to the
    // hand's final one; the deal finds them settled and leaves them.
    this.settleStacks()
    player.stack = stack + topUp.amount
    this.seq++
    await this.ctx.storage.put({ match, seq: this.seq })
    this.send(ws, this.frame('welcome', userId))
    this.broadcast('state', { skip: ws, roster: true })
    // A table waiting for funded players deals once two are here.
    if (match.status === 'waiting' && this.funded().length >= 2) {
      match.status = 'playing'
      await this.startNextHand()
    }
  }

  /**
   * A six-table player sits out from the next hand (ADR amendment
   * 2026-10-10, "Sitting out"), between hands or during one. Dealt into
   * the hand being played, they play it out as usual: only the next deal
   * leaves them out. The answer is a welcome, and everyone sees the status.
   * Sitting out again changes nothing.
   */
  private async sitOutMsg(ws: WebSocket) {
    const match = this.match!
    const { userId } = ws.deserializeAttachment() as Attachment
    if (!this.seatable())
      return this.illegal(ws, userId, 'There is no seat to sit out from here')
    const player = match.players.find((p) => p.userId === userId)
    if (!player) return this.reject(ws, 'not_seated', 'You have no seat here')
    if (!this.sitOut(player))
      return this.send(ws, this.frame('welcome', userId))
    this.seq++
    await this.ctx.storage.put({ match, seq: this.seq })
    this.send(ws, this.frame('welcome', userId))
    this.broadcast('state', { skip: ws, roster: true })
  }

  /**
   * A six-table player sitting out is dealt in again from the next hand,
   * their missed decisions back at 0 (ADR "Sitting out"). A player who is
   * playing already changes nothing. With two players to deal in at a
   * waiting table, the next hand deals now.
   */
  private async sitInMsg(ws: WebSocket) {
    const match = this.match!
    const { userId } = ws.deserializeAttachment() as Attachment
    if (!this.seatable())
      return this.illegal(ws, userId, 'There is no seat to sit in at here')
    const player = match.players.find((p) => p.userId === userId)
    if (!player) return this.reject(ws, 'not_seated', 'You have no seat here')
    if (player.status !== 'sitting_out')
      return this.send(ws, this.frame('welcome', userId))
    this.sitIn(player)
    this.seq++
    await this.ctx.storage.put({ match, seq: this.seq })
    this.send(ws, this.frame('welcome', userId))
    this.broadcast('state', { skip: ws, roster: true })
    if (match.status === 'waiting' && this.funded().length >= 2) {
      match.status = 'playing'
      await this.startNextHand()
    }
  }

  /**
   * Six-casual: `player` sits out from the next hand. False when they
   * already were.
   */
  private sitOut(player: Player) {
    if (player.status === 'sitting_out') return false
    player.status = 'sitting_out'
    return true
  }

  /** Six-casual: `player` is dealt in from the next hand, with no misses. */
  private sitIn(player: Player) {
    player.status = 'playing'
    player.timeouts = 0
  }

  /**
   * Takes `gone` off the table, each with a cooldown before they may sit
   * here again. It runs from now, when the seat frees, not from the stand:
   * a player who stood mid-hand held the seat until that hand ended.
   * Cooldowns already over are dropped, so the list stays short.
   */
  private unseat(gone: Player[]) {
    const match = this.match!
    match.players = match.players.filter((p) => !gone.includes(p))
    const cooldowns = Object.fromEntries(
      Object.entries(match.cooldowns ?? {}).filter(([userId]) =>
        this.cooldownOf(userId),
      ),
    )
    for (const p of gone)
      cooldowns[p.userId] = {
        hands: (match.tableHands ?? 0) + SIT_COOLDOWN_HANDS,
        until: this.clock() + SIT_COOLDOWN_MS,
      }
    match.cooldowns = cooldowns
  }

  /**
   * Frees the accounts that left for their next table. If this is lost, the
   * lobby finds them unseated the next time it asks (liveness). Until it
   * lands, a sit by one of them waits (releasing).
   */
  private releaseSeats(userIds: string[]) {
    const sent = this.sendRelease(userIds)
    for (const userId of userIds) this.releasing.set(userId, sent)
    void sent.then(() => {
      for (const userId of userIds)
        if (this.releasing.get(userId) === sent) this.releasing.delete(userId)
    })
    return sent
  }

  /** The lobby call itself; it never throws. */
  private async sendRelease(userIds: string[]) {
    try {
      await lobbyStub(this.env).release(userIds, this.match!.id)
    } catch (error) {
      logEvent('error', {
        matchId: this.match?.id,
        reason: 'lobby_release',
        detail: describeError(error),
      })
    }
  }

  /** Tells the socket why, then closes it; the seat may reconnect. */
  private cutOff(
    ws: WebSocket,
    code: number,
    error: ErrorCode,
    message: string,
  ) {
    this.reject(ws, error, message)
    ws.close(code, message)
    this.limitHit(ws, code, error)
    void this.socketGone(ws)
  }

  private limitHit(ws: WebSocket, code: number, reason: string) {
    const { userId } = ws.deserializeAttachment() as Attachment
    logEvent('limit_hit', { matchId: this.match?.id, userId, code, reason })
  }

  /**
   * A frame an honest client never sends: answered with `illegal`, and
   * counted. More than ILLEGAL_PER_HAND in one hand closes the socket.
   * Wrong-turn and stale moves are not counted: lag produces those.
   */
  private illegal(
    ws: WebSocket,
    userId: string,
    message: string,
    reqId?: string,
  ) {
    this.reject(ws, 'illegal', message, reqId)
    const handNo = this.hand?.config.handNo ?? 0
    // Per account: whoever sits in the seat next starts from nothing.
    const seen = this.illegalCount.get(userId)
    const n = seen?.handNo === handNo ? seen.n + 1 : 1
    this.illegalCount.set(userId, { handNo, n })
    if (n > ILLEGAL_PER_HAND) {
      ws.close(CLOSE_ABUSE, 'Too many illegal messages')
      this.limitHit(ws, CLOSE_ABUSE, 'illegal')
      void this.socketGone(ws)
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    // Finish the closing handshake so the runtime can release the socket.
    try {
      ws.close(code === 1005 ? 1000 : code, reason)
    } catch {
      // Already closed.
    }
    await this.socketGone(ws)
  }

  async webSocketError(ws: WebSocket) {
    await this.socketGone(ws)
  }

  /**
   * A socket is closing: the others see the seat offline, and a rated
   * seat with no other socket open starts its grace.
   */
  private async socketGone(ws: WebSocket) {
    this.broadcast('state', { gone: ws })
    const match = this.match
    if (!match?.adjusted || match.status !== 'playing') return
    const { userId } = ws.deserializeAttachment() as Attachment
    const player = match.players.find((p) => p.userId === userId)
    if (!player || player.awaySince !== undefined || this.connected(userId, ws))
      return
    const seat = player.seat
    if (this.deadlines.some((d) => d.kind === 'grace' && d.seat === seat))
      return
    this.deadlines.push({ kind: 'grace', at: this.clock() + GRACE_MS, seat })
    await this.armAlarm()
  }

  /** A rated seat that (re)connects ends its grace, or its time away. */
  private async back(player: Player) {
    const match = this.match!
    if (!match.adjusted) return
    const grace = (d: Deadline) => d.kind === 'grace' && d.seat === player.seat
    const away = player.awaySince !== undefined
    if (!this.deadlines.some(grace) && !away) return
    this.deadlines = this.deadlines.filter((d) => !grace(d))
    const hand = this.hand
    if (away) {
      delete player.awaySince
      // A turn of theirs still pending (its alarm not yet run) starts over
      // with the normal clock from now: they had no clock while away.
      const writes: Record<string, unknown> = { match }
      if (hand && !isOver(hand) && hand.toAct === player.seat) {
        const current = this.current!
        current.turnStartedAt = this.clock()
        this.setGameDeadline(this.turnFor(hand, current.turnStartedAt))
        writes.current = current
      }
      await this.ctx.storage.put(writes)
    }
    await this.armAlarm()
  }

  /**
   * Seats whose grace ran out are away: a turn of theirs is played at once.
   * Both away: the match is abandoned, void.
   */
  private async graceOver(seats: SeatId[]) {
    const match = this.match
    if (match?.status !== 'playing') return
    const leaving = match.players.filter(
      (p) =>
        seats.includes(p.seat) &&
        p.awaySince === undefined &&
        !this.connected(p.userId),
    )
    if (!leaving.length) return
    for (const p of leaving) p.awaySince = this.clock()
    if (match.players.every((p) => p.awaySince !== undefined))
      return this.finish(
        'abandoned',
        undefined,
        undefined,
        match.players.map((p) => p.seat),
      )
    await this.ctx.storage.put('match', match)
    const hand = this.hand
    const seat = hand?.toAct
    if (hand && !isOver(hand) && leaving.some((p) => p.seat === seat))
      await this.applyAction(
        seat!,
        act(hand, seat!, timeoutAction(hand)),
        'timeout',
      )
  }

  /**
   * Runs every deadline that is due. Each one is checked against the table
   * first, so a late or repeated alarm does nothing. Never throws: a throw
   * would spend the platform's retry budget on a bug.
   */
  async alarm() {
    try {
      const t = this.clock()
      const due = this.deadlines.filter((d) => d.at <= t)
      this.deadlines = this.deadlines.filter((d) => d.at > t)
      // All graces first, so two seats gone together void the match.
      const graces = due.flatMap((d) => (d.kind === 'grace' ? [d.seat] : []))
      if (graces.length) await this.graceOver(graces)
      for (const d of due) {
        if (d.kind === 'grace') continue
        if (d.kind === 'outbox') {
          void this.flushOutbox()
          continue
        }
        if (d.kind === 'start') {
          if (this.match?.status === 'waiting') await this.noShow()
          continue
        }
        if (d.kind === 'idle') {
          // Deleted: nothing is left to arm.
          if (await this.idle()) return
          continue
        }
        if (d.kind === 'rematch') {
          await this.rematchExpired()
          continue
        }
        if (this.match?.status !== 'playing') continue
        const hand = this.hand
        if (d.kind === 'turn' && isCurrentTurn(d, hand)) {
          // A player who stood folds (their fold was lost to a restart);
          // anyone else's time ran out.
          const stood = !!this.playerIn(d.seat)?.standing
          await this.applyAction(
            d.seat,
            act(hand!, d.seat, stood ? { type: 'fold' } : timeoutAction(hand!)),
            stood ? 'client' : 'timeout',
          )
        } else if (
          d.kind === 'nextHand' &&
          hand &&
          isOver(hand) &&
          hand.config.handNo === d.handNo
        )
          await this.startNextHand()
      }
      await this.armAlarm()
    } catch (error) {
      logEvent('error', {
        matchId: this.match?.id,
        reason: 'alarm',
        detail: describeError(error),
      })
    }
  }

  // ---- Hands ----------------------------------------------------------------

  /**
   * The single write path for a move, from a player or the clock: account
   * the time, persist everything in one write, then tell the seats.
   */
  private applyAction(
    seat: SeatId,
    next: HandState,
    source: 'client' | 'timeout',
    reqId?: string,
  ) {
    // The reveal's crypto awaits between the change and its write. Holding
    // other events until the write lands keeps any frame from showing a
    // state that is not yet durable.
    return this.ctx.blockConcurrencyWhile(() =>
      this.applyActionNow(seat, next, source, reqId),
    )
  }

  private async applyActionNow(
    seat: SeatId,
    next: HandState,
    source: 'client' | 'timeout',
    reqId?: string,
  ) {
    if (!this.invariantsHold(next)) return
    const match = this.match!
    const current = this.current!
    const t = this.clock()
    const took = t - current.turnStartedAt
    const player = this.playerIn(seat)!
    // A turn that began while the seat was away was due at once: however
    // late the alarm ran, it costs no bank.
    const awayTurn =
      source === 'timeout' &&
      player.awaySince !== undefined &&
      current.turnStartedAt >= player.awaySince
    if (!awayTurn)
      player.bankMs = bankAfter(player.bankMs, took, match.config.decisionMs)
    player.timeouts = source === 'timeout' ? player.timeouts + 1 : 0
    if (source === 'timeout' && match.sessionTimeouts)
      match.sessionTimeouts[player.userId] =
        (match.sessionTimeouts[player.userId] ?? 0) + 1
    current.timing.push({
      atMs: t - current.startedAt,
      decisionMs: took,
      source,
    })
    current.turnStartedAt = t
    this.hand = next
    this.seq++
    if (reqId) this.lastAck[player.userId] = { reqId, seq: this.seq }

    const writes: Record<string, unknown> = {
      match,
      hand: next,
      current,
      seq: this.seq,
      lastAck: this.lastAck,
    }
    const six = match.config.kind === 'six-casual'
    // A six table never ends for one player's timeouts: two in a row sit
    // them out from the next hand, and this one goes on on the normal clock.
    const forfeit = !six && player.timeouts >= FORFEIT_TIMEOUTS
    const satOut =
      six && player.timeouts >= SIT_OUT_TIMEOUTS && this.sitOut(player)
    // Six-casual: players who stood during this hand leave as it ends.
    const stood = isOver(next) ? match.players.filter((p) => p.standing) : []
    if (isOver(next)) {
      this.addNet(next)
      this.logHandEnd(next, t - current.startedAt)
      this.ended = await this.endOfHand(next, current, writes)
      writes.ended = this.ended
      if (stood.length) this.unseat(stood)
      this.setGameDeadline(
        forfeit
          ? null
          : { kind: 'nextHand', at: t + NEXT_HAND_MS, handNo: match.handNo },
      )
    } else this.setGameDeadline(this.turnFor(next, t))
    writes.deadlines = this.deadlines
    this.expectArchive(writes)
    await this.ctx.storage.put(writes)
    await this.armAlarm()
    if (isOver(next)) await this.dropDeckIfUnqueued(writes)
    // A seat that freed, or a status that changed, changes the table for
    // sockets without a seat too.
    this.broadcast('state', { roster: stood.length > 0 || satOut })
    if (isOver(next)) for (const ws of this.openSockets()) this.sendEnded(ws)
    for (const ws of this.openSockets()) {
      const userId = this.userOf(ws)
      if (stood.some((p) => p.userId === userId))
        this.send(ws, this.frame('welcome', userId))
    }
    if (forfeit) await this.finish('forfeit', seat)
    else if (isOver(next)) {
      void this.flushOutbox()
      if (stood.length) void this.releaseSeats(stood.map((p) => p.userId))
    } else {
      // A player who stood folds as soon as the action reaches them.
      const hand = this.hand!
      if (hand.toAct !== null && this.playerIn(hand.toAct)?.standing)
        await this.applyActionNow(
          hand.toAct,
          act(hand, hand.toAct, { type: 'fold' }),
          'client',
        )
    }
  }

  private startNextHand() {
    return this.ctx.blockConcurrencyWhile(async () => {
      this.dealing = true
      try {
        await this.startNextHandNow()
      } finally {
        this.dealing = false
      }
    })
  }

  private async startNextHandNow() {
    const match = this.match!
    const six = match.config.kind === 'six-casual'
    await this.settleLuck()
    if (six) {
      this.settleStacks()
      // At the hand cap the session ends at the first deal that finds its
      // outbox empty; until then play goes on, up to a limit.
      if (await this.sessionDue(true)) await this.endSession()
      else if (!match.sessionOver && match.handNo >= SESSION_DEAL_LIMIT)
        return this.holdDealing()
    }
    // A six table deals only to people who are there: with fewer than two
    // funded, connected players it waits, and a reconnect or a sit deals
    // again (the 60 s grace and sitting out come with PR-16/17).
    if (six && this.funded().length < 2) return this.waitForPlayers()
    const handNo = six && match.sessionOver ? 1 : match.handNo + 1
    const plan = six
      ? this.sixController.nextHandPlan(handNo, match.config, this.roster())
      : this.controller.nextHandPlan(handNo, match.config)
    if (!plan) return six ? this.waitForPlayers() : this.finish('complete')
    // A session starts at its first dealt hand.
    const fresh = six && !!match.sessionOver
    if (fresh) this.newSession()
    let hand: HandState
    let orbit: ReturnType<typeof orbitDone> | null = null
    try {
      // A six hand's frames and archive read who was dealt in from its
      // plan; a plan without them cannot be dealt safely.
      if (six && (!plan.blinds || !plan.users))
        throw new Error('A six-casual plan names its blinds and players')
      hand = startHand(plan.config, plan.deck)
      // Whether this deal starts an orbit, from the last deal's big blind
      // (a table stored before the count began has travelled nothing). A
      // corrupt count halts the table here, like a plan the engine refuses.
      if (six)
        orbit = orbitDone(
          match.orbitTravel ?? 0,
          match.blinds ?? null,
          plan.blinds!,
        )
    } catch (error) {
      // A plan the engine refuses (a bad stored deck, in Phase 1): halt the
      // match like any engine fault rather than break the object. A six
      // table's evidence adds the orbit count and the blinds it counts
      // from, so a corrupt count can be diagnosed from the incident.
      return this.engineFault(error, plan.config.handNo, {
        config: plan.config,
        deck: plan.deck,
        secret: toBase64(plan.secret),
        ...(six
          ? {
              orbitTravel: match.orbitTravel ?? null,
              blinds: match.blinds ?? null,
            }
          : {}),
      })
    }
    if (!this.invariantsHold(hand)) return
    const { commitment } = await commitDeck(plan.deck, plan.secret)
    const t = this.clock()
    match.handNo = plan.config.handNo
    if (six) {
      match.tableHands = (match.tableHands ?? 0) + 1
      match.blinds = plan.blinds!
      match.orbitTravel = orbit!.travel
      // A new orbit: every seated player, dealt in or not, has the whole
      // bank again before the hand's first decision (its turn deadline,
      // set below, reads it).
      if (orbit!.refill && match.config.bankRefill === 'orbit')
        for (const p of match.players) p.bankMs = match.config.bankMs
      match.dealt = plan.users!.map(({ seat, userId }) => ({
        seat,
        userId,
        username: match.players.find((p) => p.userId === userId)!.username,
      }))
      for (const p of match.players)
        if (match.dealt.some((d) => d.userId === p.userId)) p.justSat = false
      match.sessionUsers = [
        ...new Set([
          ...(match.sessionUsers ?? []),
          ...match.dealt.map((d) => d.userId),
        ]),
      ]
    }
    // Rated: each half of the match has its own bank; what is left of the
    // last one does not carry over.
    const every = match.config.bankRefillEvery
    if (every && match.handNo > 1 && (match.handNo - 1) % every === 0)
      for (const p of match.players) p.bankMs = match.config.bankMs
    this.hand = hand
    this.current = {
      handNo: match.handNo,
      commitment,
      startedAt: t,
      turnStartedAt: t,
      timing: [],
    }
    this.seq++
    this.setGameDeadline(this.turnFor(hand, t))
    const writes: Record<string, unknown> = {
      match,
      hand,
      current: this.current,
      deadlines: this.deadlines,
      seq: this.seq,
      ...(fresh ? { lastAck: this.lastAck } : {}),
      // Kept for the match: the reveal opens it, Phase 1 replays decks.
      [this.deckKey(match.handNo)]: {
        deck: plan.deck,
        secret: toBase64(plan.secret),
      },
    }
    if (match.handNo === 1 && this.recordable())
      writes[this.outboxKey(0, 'match')] = this.matchCall()
    this.expectArchive(writes)
    await this.ctx.storage.put(writes)
    await this.armAlarm()
    // The commitment goes out before any frame carries a card of this hand,
    // to everyone with a seat; a socket without one hears of no hand.
    for (const ws of this.openSockets())
      if (this.atTable(this.userOf(ws)))
        this.send(ws, {
          t: 'hand_start',
          seq: this.seq,
          matchId: this.matchId(),
          handNo: match.handNo,
          commitment,
          button: hand.config.button,
          blinds: hand.config.blinds,
          stacks: hand.players.map((p) => p.stack),
          ...(six
            ? {
                seats: hand.players.map((p) => ({
                  seat: p.seat,
                  stack: p.stack,
                })),
                sb: hand.config.sb ?? null,
                bb: hand.config.bb,
              }
            : {}),
        })
    this.broadcast('state')
    if (match.handNo === 1)
      logEvent('match_start', {
        matchId: this.matchId(),
        userIds: match.players.map((p) => p.userId),
      })
    // A hand that is over at the deal (blinds all in) still needs its end.
    if (isOver(hand)) await this.applyEndAtDeal(hand)
    else if (match.handNo === 1) void this.flushOutbox()
  }

  /** Settles a hand the blinds alone finished, through the normal end path. */
  private async applyEndAtDeal(hand: HandState) {
    const match = this.match!
    this.addNet(hand)
    this.logHandEnd(hand, 0)
    const writes: Record<string, unknown> = { match }
    this.ended = await this.endOfHand(hand, this.current!, writes)
    writes.ended = this.ended
    this.setGameDeadline({
      kind: 'nextHand',
      at: this.clock() + NEXT_HAND_MS,
      handNo: match.handNo,
    })
    writes.deadlines = this.deadlines
    this.expectArchive(writes)
    await this.ctx.storage.put(writes)
    await this.armAlarm()
    await this.dropDeckIfUnqueued(writes)
    for (const ws of this.openSockets()) this.sendEnded(ws)
    void this.flushOutbox()
  }

  private logHandEnd(hand: HandState, ms: number) {
    logEvent('hand_end', {
      matchId: this.matchId(),
      handNo: hand.config.handNo,
      reason: hand.result!.showdown ? 'showdown' : 'fold',
      ms,
    })
  }

  /** The public record and reveal of a finished hand; queues the archive. */
  private async endOfHand(
    hand: HandState,
    current: Current,
    writes: Record<string, unknown>,
  ): Promise<Ended> {
    const match = this.match!
    const stored = (await this.ctx.storage.get(this.deckKey(match.handNo))) as {
      deck: number[]
      secret: string
    }
    const secret = fromBase64(stored.secret)
    const shown = hand.players
      .filter((p) => p.shown && p.cards)
      .map((p) => ({ seat: p.seat, cards: p.cards! }))
    const record: HandRecordV1 = {
      v: 1,
      matchId: this.matchId(),
      handNo: match.handNo,
      segment: 1,
      config: hand.config,
      // The accounts dealt into this hand, by its own map.
      seats: this.dealtUsers().map(({ seat, userId, username }) => ({
        seat,
        userId,
        username,
      })),
      commitment: current.commitment,
      actions: hand.actions.map((a, i) => ({ ...a, ...current.timing[i] })),
      board: hand.board,
      shown,
      awards: hand.result!.awards,
      netBySeat: hand.result!.netBySeat,
      showdown: hand.result!.showdown,
    }
    const { leaves } = await commitDeck(stored.deck, secret)
    const slots = await revealSlots(
      stored.deck,
      secret,
      publicSlots({ config: hand.config, board: hand.board, shown }),
    )
    const reveal: Reveal = {
      handNo: match.handNo,
      leaves: toBase64(leaves),
      slots,
    }
    const holeSlots = dealSlots(hand.config).holes
    const userOf = (seat: SeatId) => this.userIn(seat)!
    const own: Record<string, RevealedSlot[]> = {}
    for (const p of hand.players)
      own[userOf(p.seat)] = await revealSlots(
        stored.deck,
        secret,
        holeSlots[p.seat],
      )
    if (this.recordable()) {
      // A rated hand's record waits for its luck (settleLuck).
      const key = match.adjusted
        ? heldKey
        : (n: number, what: string) => this.outboxKey(n, what)
      const holes = Object.fromEntries(
        hand.players.map((p) => [
          p.seat,
          holeSlots[p.seat].map((slot) => stored.deck[slot]),
        ]),
      )
      writes[key(match.handNo, 'hand')] = {
        rpc: 'record_hand',
        attempts: 0,
        body: {
          id: `${this.matchId()}:${match.handNo}`,
          matchId: this.matchId(),
          handNo: match.handNo,
          segment: 1,
          button: hand.config.button,
          commitment: current.commitment,
          leaves: reveal.leaves,
          reveal: slots,
          record,
          deck: stored.deck,
          secret: stored.secret,
          holes,
          holesByUser: hand.players.map((p) => ({
            userId: userOf(p.seat),
            cards: holes[p.seat],
          })),
          netByUser: Object.fromEntries(
            Object.entries(hand.result!.netBySeat).map(([s, n]) => [
              userOf(Number(s)),
              n,
            ]),
          ),
        },
      } satisfies Outbox
      // Sorts after this hand's archive call, so it is sent only once
      // Postgres has the hand: the consumer never races the archive.
      writes[key(match.handNo, 'verify')] = {
        send: {
          matchId: this.matchId(),
          handNo: match.handNo,
          ...(match.config.kind === 'hu-rated' ? { rated: true as const } : {}),
        },
        attempts: 0,
      } satisfies Outbox
    }
    return { record, reveal, own }
  }

  /**
   * Rated: adds the last finished hand's luck-adjusted net to the match
   * total and releases its held archive calls with the luck in the record.
   * Runs as the next hand starts and at the finish, never before a hand's
   * showdown frames: a preflop all-in costs ≈ 0.5 s of CPU. Idempotent, and
   * recomputed from the stored hand after a restart.
   */
  private async settleLuck() {
    const match = this.match!
    const hand = this.hand
    if (!match.adjusted || !hand?.result) return
    const handNo = hand.config.handNo
    if ((match.adjustedThrough ?? 0) >= handNo) return
    const luck = luckAdjusted(hand)
    for (const [s, net] of Object.entries(luck.netBySeat))
      match.adjusted[Number(s)] += net
    match.adjustedThrough = handNo
    const held = await this.ctx.storage.list<Outbox>({
      prefix: heldKey(handNo, ''),
    })
    const writes: Record<string, unknown> = { match }
    for (const [key, call] of held) {
      if (!('send' in call) && call.rpc === 'record_hand')
        (call.body as { record: HandRecordV1 }).record.luck = {
          allInAt: luck.allInAt,
          equity: luck.equity,
          adjustedBySeat: luck.netBySeat,
        }
      writes[`outbox:${key.slice('held:'.length)}`] = call
    }
    this.expectArchive(writes)
    // No await between the two: they commit together.
    const released = held.size
      ? this.ctx.storage.delete([...held.keys()])
      : null
    await this.ctx.storage.put(writes)
    await released
    if (held.size) void this.flushOutbox()
  }

  /**
   * The turn deadline: the decision clock and bank, or now for an away seat
   * or a player who stood (so a fold lost to a restart still happens).
   */
  private turnFor(hand: HandState, startedAt: number) {
    const match = this.match!
    const player = hand.toAct === null ? undefined : this.playerIn(hand.toAct)
    return player?.awaySince !== undefined || player?.standing
      ? turnDeadline(hand, startedAt, 0, 0)
      : turnDeadline(
          hand,
          startedAt,
          match.config.decisionMs,
          this.bankOf(hand),
        )
  }

  private bankOf(hand: HandState) {
    return hand.toAct === null ? 0 : (this.playerIn(hand.toAct)?.bankMs ?? 0)
  }

  // ---- Six-casual seats and stacks -------------------------------------------

  /** What the six-casual controller deals from: seats, stacks, blinds. */
  private roster(): Roster {
    const match = this.match!
    return {
      seats: match.players.map((p) => ({
        seat: p.seat,
        userId: p.userId,
        stack: p.stack!,
        status: p.status!,
        justSat: !!p.justSat,
      })),
      blinds: match.blinds ?? null,
    }
  }

  /**
   * Six-casual: the finished hand's final stacks go back to the accounts
   * dealt into it, as the next hand is dealt or a rebuy tops one up. Once
   * per hand: a stack is set, not added. An account that stood and sat
   * again since the deal (`justSat`, cleared only when dealt in) is a new
   * seat with its own buy-in: the hand's final stack left with the old one.
   */
  private settleStacks() {
    const match = this.match!
    const hand = this.hand
    // The hand on the table is always the table's latest (tableHands);
    // counted across sessions, since each session's handNo restarts.
    const latest = match.tableHands ?? 0
    if (!hand || !isOver(hand) || (match.settled ?? 0) >= latest) return
    for (const p of hand.players) {
      const player = this.playerIn(p.seat)
      if (player && !player.justSat) player.stack = p.stack
    }
    match.settled = latest
  }

  /**
   * Six-casual: the chips `player` has outside the hand being played.
   * Between hands, a player dealt into the hand just finished has its final
   * stack (the next deal settles it into `stack`); otherwise `stack` holds
   * it: as of the last deal, the buy-in, or after a rebuy. An account that
   * stood and sat again since the deal holds its new buy-in, as
   * settleStacks leaves it.
   */
  private stackOf(player: Player) {
    const match = this.match!
    const hand = this.hand
    if (
      hand &&
      isOver(hand) &&
      (match.settled ?? 0) < (match.tableHands ?? 0)
    ) {
      const seat = this.handSeat(player.userId)
      const final = hand.players.find((p) => p.seat === seat)
      if (seat !== null && final && !player.justSat) return final.stack
    }
    return player.stack!
  }

  /** Six-casual: the players a hand could deal in now. */
  private funded() {
    return this.match!.players.filter(
      (p) => p.stack! > 0 && p.status === 'playing' && this.connected(p.userId),
    )
  }

  /** A finished hand's net: per seat heads-up, per account at a six table. */
  private addNet(hand: HandState) {
    const match = this.match!
    for (const [s, net] of Object.entries(hand.result!.netBySeat)) {
      if (!match.netByUser) {
        match.net[Number(s)] += net
        continue
      }
      const userId = this.userIn(Number(s))!
      match.netByUser[userId] = (match.netByUser[userId] ?? 0) + net
    }
  }

  /**
   * Six-casual: fewer than two players can be dealt in. Play waits, the
   * stacks just settled are kept, and the next sit deals again.
   */
  private async waitForPlayers() {
    const match = this.match!
    match.status = 'waiting'
    // The idle check (PR-11 left none after the first deal): it ends the
    // session once no hand has started for IDLE_MS, and deletes a table
    // nobody sits at by then.
    this.setGameDeadline(this.idleDeadline())
    this.seq++
    await this.ctx.storage.put({
      match,
      seq: this.seq,
      deadlines: this.deadlines,
    })
    await this.armAlarm()
    this.broadcast('state', { roster: true })
  }

  /**
   * A waiting six table's next idle check: IDLE_MS after the open session's
   * last hand started, so the session ends on time; IDLE_MS from now when
   * no session is open.
   */
  private idleDeadline(): Deadline {
    const t = this.clock()
    const started = this.sessionOpen() ? this.current?.startedAt : undefined
    return {
      kind: 'idle',
      at: started === undefined ? t + IDLE_MS : Math.max(t, started + IDLE_MS),
    }
  }

  // ---- Six-casual sessions ---------------------------------------------------

  /** Whether a six table's session is open: it has dealt, and not ended. */
  private sessionOpen() {
    const match = this.match
    return (
      match?.config.kind === 'six-casual' &&
      match.status !== 'finished' &&
      match.handNo > 0 &&
      !match.sessionOver
    )
  }

  /**
   * Whether the open session ends now (ADR amendment 2026-10-10, "Sessions
   * in the archive"): between hands, once SESSION_HANDS have been dealt or
   * no hand has started for IDLE_MS, and only with its outbox empty. A deal
   * under way decides for itself (`fromDeal`).
   */
  private async sessionDue(fromDeal = false) {
    if (!this.sessionOpen() || (this.dealing && !fromDeal)) return false
    if (this.hand && !isOver(this.hand)) return false
    const idle = this.clock() - (this.current?.startedAt ?? 0) >= IDLE_MS
    if (this.match!.handNo < SESSION_HANDS && !idle) return false
    const queued = await this.ctx.storage.list({ prefix: 'outbox:', limit: 1 })
    return queued.size === 0
  }

  /**
   * Ends the session in the archive, and only there: no frame, no lobby
   * release, no rematch, no deletion. Seats, stacks, statuses, blinds,
   * banks and cooldowns stay as they are; the next deal starts a session.
   * Callers check sessionDue first, which awaits its outbox read, so two of
   * them (idle and a flush's afterDrain) can both find it due: marked
   * before any await, and the second ends nothing.
   */
  private async endSession() {
    const match = this.match!
    if (match.sessionOver) return
    match.sessionOver = true
    const writes: Record<string, unknown> = { match }
    if (this.recordable())
      writes[this.outboxKey(9999, 'end')] = this.matchCall('complete')
    logEvent('match_end', {
      matchId: this.matchId(),
      reason: 'complete',
      handNo: match.handNo,
    })
    this.expectArchive(writes)
    await this.ctx.storage.put(writes)
    await this.armAlarm()
    void this.flushOutbox()
  }

  /**
   * The next session: its own matchId, hands from 1, its own timeouts,
   * nets and dealt accounts. Acks start over with it: a request id is only
   * ever retried within a hand, and the last session's would match this
   * one's hand numbers.
   */
  private newSession() {
    const match = this.match!
    match.session = (match.session ?? 1) + 1
    match.sessionId = crypto.randomUUID()
    match.handNo = 0
    match.sessionTimeouts = {}
    match.sessionUsers = []
    match.netByUser = {}
    delete match.sessionOver
    this.lastAck = {}
  }

  /**
   * SESSION_DEAL_LIMIT hands with calls still queued: no hand until they
   * drain, so the session's end still fits under outbox:9999. The flush
   * that empties the outbox deals again (afterDrain).
   */
  private async holdDealing() {
    const match = this.match!
    match.dealsHeld = true
    this.setGameDeadline(null)
    await this.ctx.storage.put({ match, deadlines: this.deadlines })
    await this.armAlarm()
  }

  /**
   * Six-casual, once everything queued is archived: held dealing resumes
   * (the deal ends the session first), and a session idle past IDLE_MS
   * ends, since no hand will come to check it.
   */
  private async afterDrain() {
    const match = this.match
    if (match?.config.kind !== 'six-casual') return
    if (match.dealsHeld) {
      delete match.dealsHeld
      return this.startNextHand()
    }
    if (await this.sessionDue()) await this.endSession()
  }

  /**
   * Missed decisions this session by account, every player the call names
   * included (record_match v6 reads six-casual timeouts by user id). A
   * player who left keeps their count.
   */
  private sessionTimeouts() {
    const match = this.match!
    return {
      ...Object.fromEntries(this.namedPlayers().map((p) => [p.userId, 0])),
      ...match.sessionTimeouts,
    }
  }

  /**
   * The players a record_match call names: heads-up, both seats. At a six
   * table, the seated accounts dealt in during the session: record_match
   * gives each a match_players row, and one who sat after the session's
   * last hand never played it. Those who left have theirs from record_hand.
   */
  private namedPlayers() {
    const match = this.match!
    if (match.config.kind !== 'six-casual') return match.players
    const dealt = new Set(match.sessionUsers)
    return match.players.filter((p) => dealt.has(p.userId))
  }

  /**
   * Six-casual: a finished hand's deck is kept only until its record_hand
   * is stored (flushPass drops it then); a hand nothing archives drops it
   * now. Runs once the hand's end is written, which no longer needs it.
   */
  private async dropDeckIfUnqueued(writes: Record<string, unknown>) {
    const match = this.match!
    if (match.config.kind !== 'six-casual') return
    if (this.outboxKey(match.handNo, 'hand') in writes) return
    await this.ctx.storage.delete(this.deckKey(match.handNo))
  }

  /**
   * Called with every write that queues an archive call: if the object is
   * evicted before the immediate send, this deadline still delivers it.
   */
  private expectArchive(writes: Record<string, unknown>) {
    if (!Object.keys(writes).some((k) => k.startsWith('outbox:'))) return
    if (!this.deadlines.some((d) => d.kind === 'outbox'))
      this.deadlines.push({
        kind: 'outbox',
        at: this.clock() + OUTBOX_SAFETY_MS,
      })
    writes.deadlines = this.deadlines
  }

  /** Replaces the turn/next-hand deadline; archive retries and graces stay. */
  private setGameDeadline(deadline: Deadline | null) {
    this.deadlines = [
      ...this.deadlines.filter(
        (d) =>
          d.kind === 'outbox' || d.kind === 'grace' || d.kind === 'rematch',
      ),
      ...(deadline ? [deadline] : []),
    ]
  }

  private async armAlarm() {
    await this.ctx.storage.put('deadlines', this.deadlines)
    const at = earliest(this.deadlines)
    if (at === null) await this.ctx.storage.deleteAlarm()
    else await this.ctx.storage.setAlarm(at)
  }

  private invariantsHold(state: HandState) {
    try {
      assertInvariants(
        state,
        state.config.seats.reduce((sum, s) => sum + s.stack, 0),
      )
      return true
    } catch (error) {
      this.engineFault(error, state.config.handNo, state)
      return false
    }
  }

  /**
   * Loud and final rather than a wrong payout: the match ends as
   * `engine_fault`. Ids only in the log: `evidence` (the state or plan) holds
   * the deck and every hole card.
   */
  private engineFault(error: unknown, handNo: number, evidence: unknown) {
    const detail = error instanceof Error ? error.message : describeError(error)
    logEvent('error', {
      matchId: this.matchId(),
      handNo,
      reason: 'engine_fault',
      detail,
    })
    // The evidence goes where only the service role can read it. Written
    // before finish() so its flush sends it.
    if (this.recordable())
      void this.ctx.storage.put(this.outboxKey(handNo, 'incident'), {
        rpc: 'record_incident',
        attempts: 0,
        body: {
          matchId: this.matchId(),
          handNo,
          kind: 'engine_fault',
          detail: { error: detail, evidence },
        },
      } satisfies Outbox)
    void this.finish('engine_fault')
  }

  /**
   * An expired invite or a finished table deletes itself, closing any
   * socket still open, once nothing is left to archive; otherwise it checks
   * again later. True when the table is gone.
   */
  private async idle() {
    const match = this.match
    if (match?.config.kind === 'six-casual' && match.status !== 'finished') {
      // No hand for IDLE_MS: the session ends (once its outbox is empty).
      // The table stays at least IDLE_MS more: its end is still to be
      // archived, and whoever stood last may be back.
      const due = await this.sessionDue()
      if (due) await this.endSession()
      // It stays while anyone sits at it, or while its session is open: a
      // flush may have drained the outbox after sessionDue looked, and the
      // session must be archived as ended before the table goes.
      if (due || match.players.length || this.sessionOpen()) {
        this.deadlines.push({ kind: 'idle', at: this.clock() + IDLE_MS })
        return false
      }
    }
    if (this.match?.status === 'playing') return false
    const pending = await this.ctx.storage.list({ prefix: 'outbox:', limit: 1 })
    if (pending.size) {
      this.deadlines.push({ kind: 'idle', at: this.clock() + IDLE_MS })
      return false
    }
    for (const ws of this.ctx.getWebSockets())
      try {
        ws.close(CLOSE_GONE, 'closed')
      } catch {
        // Already closed.
      }
    await this.ctx.storage.deleteAlarm()
    await this.ctx.storage.deleteAll()
    this.match = null
    this.hand = null
    this.current = null
    this.ended = null
    this.deadlines = []
    this.seq = 0
    this.lastAck = {}
    return true
  }

  /** A paired table not everyone opened in time. */
  private noShow() {
    const absent = this.match!.players.filter(
      (p) => !this.connected(p.userId),
    ).map((p) => p.seat)
    return this.finish('no_show', undefined, absent)
  }

  private async finish(
    reason: MatchEndReason,
    forfeit?: SeatId,
    noShow?: SeatId[],
    abandoned?: SeatId[],
  ) {
    const match = this.match!
    const six = match.config.kind === 'six-casual'
    await this.settleLuck()
    match.status = 'finished'
    match.endReason = reason
    if (forfeit !== undefined) match.forfeit = forfeit
    if (noShow) match.noShow = noShow
    if (abandoned) match.abandoned = abandoned
    // Rated: a forfeit loses whatever the chips say; a void match has no
    // result; otherwise the luck-adjusted total and the draw band decide.
    if (match.adjusted && !VOID.includes(reason))
      match.outcome =
        forfeit !== undefined
          ? forfeit === 0
            ? { 0: 'loss', 1: 'win' }
            : { 0: 'win', 1: 'loss' }
          : outcomes(match.adjusted, match.config.blinds.bb)
    this.seq++
    this.logFinish(match, reason, forfeit, noShow)
    this.setGameDeadline({ kind: 'idle', at: this.clock() + IDLE_MS })
    this.deadlines = this.deadlines.filter((d) => d.kind !== 'grace')
    const writes: Record<string, unknown> = {
      match,
      seq: this.seq,
      deadlines: this.deadlines,
    }
    if (this.recordable()) {
      writes[this.outboxKey(9999, 'end')] = this.matchCall()
      // Rated with a result (not void): rated once the match is archived;
      // 'rate' sorts after 'end', and the flush stops at a failure.
      if (match.outcome)
        writes[this.outboxKey(9999, 'rate')] = {
          rpc: 'apply_rating',
          body: {
            matchId: match.id,
            players: match.players.map((p) => ({
              seat: p.seat,
              userId: p.userId,
              outcome: match.outcome![p.seat],
            })),
            finishedAt: this.clock(),
          } satisfies RateCall,
          attempts: 0,
        } satisfies Outbox
    }
    this.expectArchive(writes)
    await this.ctx.storage.put(writes)
    await this.armAlarm()
    this.broadcast('state')
    // A six table that ends (an engine fault) tells only its seats.
    for (const ws of this.openSockets())
      if (!six || this.atTable(this.userOf(ws)))
        this.send(ws, {
          t: 'match_end',
          seq: this.seq,
          matchId: this.matchId(),
          result: this.result(),
        })
    void this.flushOutbox()
    // Free both accounts for their next table. If this is lost, the lobby
    // finds the table over the next time it asks.
    try {
      await lobbyStub(this.env).release(
        match.players.map((p) => p.userId),
        match.id,
      )
    } catch (error) {
      logEvent('error', {
        matchId: match.id,
        reason: 'lobby_release',
        detail: describeError(error),
      })
    }
    await this.offerRematch()
  }

  // ---- Rematch (P1-04) -------------------------------------------------------

  /**
   * A rated match with a result may be played again by the same two players.
   * The lobby says whether they may still meet today (R-9). It is asked once
   * the result is stored and sent, so the result never waits on it.
   */
  private async offerRematch() {
    const match = this.match!
    if (!match.outcome || match.rematch) return
    let left = 1
    try {
      left = await lobbyStub(this.env).pairsLeft(
        match.players.map((p) => p.userId),
      )
    } catch (error) {
      // Asked again when both players press.
      logEvent('error', {
        matchId: match.id,
        reason: 'lobby_pairs',
        detail: describeError(error),
      })
    }
    // Made meanwhile by a join or a press, or the table closed.
    if (this.match !== match || match.rematch) return
    await this.setRematch({ state: left > 0 ? 'open' : 'limit', pressed: [] })
  }

  /** Both press within REMATCH_MS and the lobby starts a new rated table. */
  private async pressRematch(ws: WebSocket, userId: string) {
    const match = this.match!
    const seat = match.players.find((p) => p.userId === userId)?.seat
    // Finished with a result but no offer yet (on its way, or lost to a
    // restart after the result was stored): make it now.
    if (match.outcome && !match.rematch) await this.offerRematch()
    const offer = match.rematch
    if (!offer || seat === undefined)
      return this.illegal(ws, userId, 'There is no rematch at this table')
    // The minute is over, even if its alarm has not run yet.
    if (
      offer.state === 'waiting' &&
      offer.until !== undefined &&
      this.clock() >= offer.until
    )
      return this.rematchExpired()
    // Pressed already, or nothing left to press: how it stands.
    if (
      (offer.state !== 'open' && offer.state !== 'waiting') ||
      offer.pressed.includes(seat)
    )
      return this.send(ws, this.rematchFrame())
    const pressed = [...offer.pressed, seat].sort((a, b) => a - b)
    if (pressed.length < 2) {
      const until = this.clock() + REMATCH_MS
      // However late the press, the table stays for the whole minute, and
      // a while after it so both see how it ended.
      this.deadlines = this.deadlines.map((d) =>
        d.kind === 'idle'
          ? { ...d, at: Math.max(d.at, until + REMATCH_MS) }
          : d,
      )
      this.deadlines.push({ kind: 'rematch', at: until })
      return this.setRematch({ state: 'waiting', pressed, until })
    }
    // Both pressed. Marked first, so neither the expiry nor another press
    // changes the offer while the lobby answers.
    match.rematch = { state: 'starting', pressed }
    this.deadlines = this.deadlines.filter((d) => d.kind !== 'rematch')
    let answer: RematchAnswer
    try {
      // Seats swap, so the other player has the first hand's button.
      const players = [...match.players]
        .sort((a, b) => b.seat - a.seat)
        .map(({ userId, username }) => ({ userId, username }))
      answer = await lobbyStub(this.env).rematch(players, match.id)
    } catch (error) {
      logEvent('error', {
        matchId: match.id,
        reason: 'lobby_rematch',
        detail: describeError(error),
      })
      answer = { refused: 'busy' }
    }
    await this.setRematch(
      'matchId' in answer
        ? { state: 'starting', pressed, next: answer.matchId }
        : { state: answer.refused === 'limit' ? 'limit' : 'declined', pressed },
    )
  }

  private async rematchExpired() {
    const offer = this.match?.rematch
    if (offer?.state !== 'waiting') return
    this.deadlines = this.deadlines.filter((d) => d.kind !== 'rematch')
    await this.setRematch({ state: 'declined', pressed: offer.pressed })
  }

  /** Stores the offer, then tells both seats. */
  private async setRematch(offer: Rematch) {
    const match = this.match!
    match.rematch = offer
    this.seq++
    await this.ctx.storage.put({ match, seq: this.seq })
    await this.armAlarm()
    for (const ws of this.openSockets()) this.send(ws, this.rematchFrame())
  }

  private rematchFrame(): ServerMsg {
    const match = this.match!
    const { state, pressed, until, next } = match.rematch!
    return {
      t: 'rematch_state',
      seq: this.seq,
      matchId: match.id,
      state,
      pressed: [...pressed],
      ...(until !== undefined ? { until } : {}),
      ...(next ? { next } : {}),
    }
  }

  /** A finished match's result and offer, for a socket that (re)joins. */
  private sendMatchEnd(ws: WebSocket) {
    const match = this.match
    if (match?.status !== 'finished') return
    // Six tables: never to a socket without a seat (ADR "Sockets without a
    // seat").
    if (match.config.kind === 'six-casual' && !this.atTable(this.userOf(ws)))
      return
    this.send(ws, {
      t: 'match_end',
      seq: this.seq,
      matchId: this.matchId(),
      result: this.result(),
    })
    if (match.rating) this.send(ws, this.ratingFrame(match.rating))
    if (match.rematch) this.send(ws, this.rematchFrame())
    // A result whose offer was lost to a restart: made now, for both.
    else if (match.outcome) void this.offerRematch()
  }

  private ratingFrame(change: Record<SeatId, RatingChange>): ServerMsg {
    return { t: 'rating', seq: this.seq, matchId: this.match!.id, change }
  }

  /**
   * Applies a finished rated match's ratings (worker/src/rating.ts) and
   * shows both players the change. A failure is retried from the outbox
   * like any archive call; play and the result never wait on it.
   */
  private async rate(call: RateCall): Promise<ArchiveOutcome> {
    const outcome = await applyRating(this.env, call, this.clock())
    const match = this.match
    if (!outcome.ok || !outcome.change || match?.id !== call.matchId)
      return outcome
    match.rating = outcome.change
    this.seq++
    await this.ctx.storage.put({ match, seq: this.seq })
    for (const ws of this.openSockets())
      this.send(ws, this.ratingFrame(outcome.change))
    return outcome
  }

  private logFinish(
    match: Match,
    reason: MatchEndReason,
    forfeit?: SeatId,
    noShow?: SeatId[],
  ) {
    const userOf = (seat: SeatId) =>
      match.players.find((p) => p.seat === seat)?.userId
    if (forfeit !== undefined)
      logEvent('forfeit', {
        matchId: match.id,
        seat: forfeit,
        userId: userOf(forfeit),
      })
    for (const seat of noShow ?? [])
      logEvent('no_show', { matchId: match.id, seat, userId: userOf(seat) })
    logEvent('match_end', {
      matchId: this.matchId(),
      reason,
      handNo: match.handNo,
    })
  }

  // ---- Archive ---------------------------------------------------------------

  /** Real accounts and a configured key; local dev tables are not archived. */
  private recordable() {
    const match = this.match
    if (!this.env.SUPABASE_SECRET_KEY || !match) return false
    // A six table asks of the accounts its session dealt in, not of who
    // sits there now: nobody, when an idle session ends, and every() of
    // nobody would archive the end of a session never archived.
    const accounts =
      match.config.kind === 'six-casual'
        ? (match.sessionUsers ?? [])
        : match.players.map((p) => p.userId)
    return accounts.every((userId) => UUID.test(userId))
  }

  /**
   * The match's (or session's) record_match call: its start, or with its
   * result once it is over. `ended` closes a six-casual session whose
   * table plays on.
   */
  private matchCall(ended?: MatchEndReason): Outbox {
    const match = this.match!
    return {
      rpc: 'record_match',
      attempts: 0,
      body: {
        id: this.matchId(),
        kind: match.config.kind,
        config: match.config,
        players: this.namedPlayers().map(({ seat, userId }) => ({
          seat,
          userId,
        })),
        ...(match.rematchOf ? { rematchOf: match.rematchOf } : {}),
        ...(match.status === 'finished' || ended
          ? {
              handNo: match.handNo,
              // Six tables send session totals by account (record_match v6).
              timeouts:
                match.config.kind === 'six-casual'
                  ? this.sessionTimeouts()
                  : Object.fromEntries(
                      match.players.map((p) => [p.seat, p.timeouts]),
                    ),
              result: ended
                ? { netBySeat: { ...match.net }, reason: ended }
                : this.result(),
            }
          : {}),
      },
    }
  }

  /** A finished match's result, as the seats and the archive get it. */
  private result() {
    const match = this.match!
    return {
      netBySeat: { ...match.net },
      reason: match.endReason!,
      ...(match.forfeit !== undefined ? { forfeit: match.forfeit } : {}),
      ...(match.noShow ? { noShow: match.noShow } : {}),
      ...(match.abandoned ? { abandoned: match.abandoned } : {}),
      ...(match.adjusted ? { adjustedBySeat: { ...match.adjusted } } : {}),
      ...(match.outcome ? { outcomeBySeat: { ...match.outcome } } : {}),
    }
  }

  /**
   * Sends queued archive calls in key order and stops at the first failure,
   * so a hand never reaches Postgres before its match. A failure schedules
   * a retry with backoff; play never waits on the archive.
   */
  async flushOutbox() {
    if (this.flushing) {
      this.flushAgain = true
      return
    }
    this.flushing = true
    try {
      do {
        this.flushAgain = false
        // A failure has armed its own retry, which lists everything again.
        if (!(await this.flushPass())) return
      } while (this.flushAgain)
      // Nothing can be queued between the check above and this line, so no
      // call is left without a deadline; one queued later arms its own.
      if (this.deadlines.some((d) => d.kind === 'outbox')) {
        this.deadlines = this.deadlines.filter((d) => d.kind !== 'outbox')
        await this.armAlarm()
      }
    } finally {
      this.flushing = false
    }
    await this.afterDrain()
  }

  /** One pass over the outbox. False when a failure armed a retry. */
  private async flushPass() {
    const queued = await this.ctx.storage.list<Outbox>({ prefix: 'outbox:' })
    // The most attempts among calls that failed without stopping the flush.
    let behind = 0
    // A parked call queues an incident report that this pass did not list.
    let parked = false
    // Entries parked along with a call (a hand's verification).
    const dropped = new Set<string>()
    for (const [key, call] of queued) {
      if (dropped.has(key)) continue
      const outcome: ArchiveOutcome =
        'send' in call
          ? { ok: await this.enqueue(call.send) }
          : call.rpc === 'apply_rating'
            ? await this.rate(call.body as RateCall)
            : await archive(this.env, call)
      if (outcome.ok) {
        await this.ctx.storage.delete([key, ...this.deckOf(key, call)])
        continue
      }
      const attempts = call.attempts + 1
      const refused = (call.refused ?? 0) + (refusedForData(outcome) ? 1 : 0)
      // An incident report never holds up the flush, so it is never parked:
      // parking it would only lose its evidence at cleanup.
      if (
        !('send' in call) &&
        call.rpc !== 'record_incident' &&
        refused >= OUTBOX_MAX_REFUSALS
      ) {
        for (const k of await this.park(key, call, outcome)) dropped.add(k)
        parked = true
        continue
      }
      logEvent('outbox_retry', {
        matchId: this.match?.id,
        rpc: 'send' in call ? 'hand_queue' : call.rpc,
        attempt: attempts,
        depth: queued.size,
      })
      await this.ctx.storage.put(key, { ...call, attempts, refused })
      if ('send' in call || call.rpc === 'record_incident') {
        behind = Math.max(behind, attempts)
        continue
      }
      await this.retryOutbox(attempts)
      return false
    }
    if (behind || parked) {
      await this.retryOutbox(Math.max(behind, 1))
      return false
    }
    return true
  }

  /**
   * Sets aside a call Postgres keeps refusing for its data, so the calls
   * behind it can go through, and reports it once as an incident. The
   * incident carries the call itself (incidents are for the service role
   * only, like the deck), so it can be replayed once the cause is fixed.
   * A parked hand takes its verification with it: the verifier would find
   * no hand and report a false failure. Returns the keys parked with it.
   */
  private async park(
    key: string,
    call: ArchiveCall & { attempts: number },
    outcome: ArchiveOutcome,
  ) {
    const rest = key.slice('outbox:'.length)
    const [n, what] = rest.split(':')
    await this.ctx.storage.put(`parked:${rest}`, call)
    // The parked call carries the deck and secret itself.
    await this.ctx.storage.delete([key, ...this.deckOf(key, call)])
    const alongside: string[] = []
    if (call.rpc === 'record_hand') {
      const verify = `outbox:${n}:verify`
      const entry = await this.ctx.storage.get<Outbox>(verify)
      if (entry) {
        await this.ctx.storage.put(`parked:${n}:verify`, entry)
        await this.ctx.storage.delete(verify)
        alongside.push(verify)
      }
    }
    logEvent('outbox_parked', {
      matchId: this.match?.id,
      rpc: call.rpc,
      code: outcome.status,
      detail: outcome.code,
    })
    const handNo = (call.body as { handNo?: unknown }).handNo
    const body = call.body as { id?: unknown; matchId?: unknown }
    const callMatch = [body.matchId, body.id].find(
      (id): id is string => typeof id === 'string',
    )
    await this.ctx.storage.put(`${key}:parked`, {
      rpc: 'record_incident',
      attempts: 0,
      body: {
        // The parked call's own match: at a six table, maybe a session
        // that has ended since.
        matchId: callMatch ?? this.matchId(),
        handNo:
          call.rpc === 'record_hand' && typeof handNo === 'number'
            ? handNo
            : null,
        // One incident per parked call: the match's start and end both have
        // no hand number, so the call names the kind (incidents_once).
        kind: `archive_parked:${what}`,
        detail: {
          rpc: call.rpc,
          status: outcome.status,
          code: outcome.code,
          body: call.body,
        },
      },
    } satisfies Outbox)
    return alongside
  }

  private async retryOutbox(attempts: number) {
    this.deadlines = [
      ...this.deadlines.filter((d) => d.kind !== 'outbox'),
      { kind: 'outbox', at: this.clock() + outboxBackoff(attempts) },
    ]
    await this.armAlarm()
  }

  /** Hands a finished hand to the verify queue. Never throws. */
  private async enqueue(message: HandMessage) {
    try {
      await this.env.HAND_QUEUE.send(message)
      return true
    } catch {
      return false
    }
  }

  // ---- Frames ----------------------------------------------------------------

  private openSockets(exclude?: WebSocket) {
    return this.ctx
      .getWebSockets()
      .filter((ws) => ws !== exclude && ws.readyState === OPEN)
  }

  private userOf(ws: WebSocket) {
    return (ws.deserializeAttachment() as Attachment).userId
  }

  /**
   * The matchId frames and the archive carry: the session's at a six table
   * (the table id for its first session), the match's otherwise.
   */
  private matchId() {
    return this.match?.sessionId ?? this.match?.id ?? ''
  }

  /**
   * Hand `n`'s part of its storage keys. A six table's lead with the
   * session number, so two sessions' keys never collide and sort session by
   * session; heads-up keys are as they always were.
   */
  private handTag(n: number) {
    const match = this.match!
    return match.config.kind === 'six-casual'
      ? `${pad(match.session ?? 1)}.${pad(n)}`
      : pad(n)
  }

  /** Outbox keys sort in the order Postgres needs them: match, hands, end. */
  private outboxKey(n: number, what: string) {
    return `outbox:${this.handTag(n)}:${what}`
  }

  /** Where hand `n`'s deck and secret wait for the reveal and the archive. */
  private deckKey(n: number) {
    return this.match!.config.kind === 'six-casual'
      ? `deck:${this.handTag(n)}`
      : `deck:${n}`
  }

  /**
   * The deck key a six table's record_hand call at `key` makes redundant
   * once it is stored or parked (that call carries the deck itself), so
   * decks do not pile up; heads-up keeps every deck for its short match.
   */
  private deckOf(key: string, call: Outbox) {
    if (this.match?.config.kind !== 'six-casual') return []
    if ('send' in call || call.rpc !== 'record_hand') return []
    return [`deck:${key.slice('outbox:'.length, key.lastIndexOf(':'))}`]
  }

  /**
   * The last ack for `userId`. Heads-up objects stored before acks were
   * keyed by account kept them by seat; a retry across that deploy still
   * finds its ack (a six table never stored one by seat).
   */
  private ackOf(userId: string): Ack | undefined {
    return (
      this.lastAck[userId] ??
      (this.match?.config.kind === 'six-casual'
        ? undefined
        : this.lastAck[String(this.seatOfUser(userId))])
    )
  }

  private seatOfUser(userId: string) {
    return this.match?.players.find((p) => p.userId === userId)?.seat
  }

  /** Whether `userId` has a socket open (other than `exclude`). */
  private connected(userId: string, exclude?: WebSocket) {
    return this.openSockets(exclude).some((ws) => this.userOf(ws) === userId)
  }

  /** Whether `userId` has a seat at the table now (heads-up: a player). */
  private atTable(userId: string) {
    return this.match!.players.some((p) => p.userId === userId)
  }

  /**
   * Who was dealt into the hand on the table, seat by seat. Heads-up
   * players never change seats, so the players are that map.
   */
  private dealtUsers(): Dealt[] {
    const match = this.match!
    if (match.dealt) return match.dealt
    if (match.config.kind === 'six-casual') return []
    return match.players.map(({ seat, userId, username }) => ({
      seat,
      userId,
      username,
    }))
  }

  /** The account dealt into `seat` in the hand on the table. */
  private userIn(seat: SeatId) {
    return this.dealtUsers().find((d) => d.seat === seat)?.userId
  }

  /** The player dealt into `seat` in the hand on the table. */
  private playerIn(seat: SeatId) {
    const userId = this.userIn(seat)
    return this.match!.players.find((p) => p.userId === userId)
  }

  /** The seat `userId` was dealt into in the hand on the table, or null. */
  private handSeat(userId: string): SeatId | null {
    return this.dealtUsers().find((d) => d.userId === userId)?.seat ?? null
  }

  /**
   * The table as `userId` may see it. A socket without a seat gets the
   * summary only, never a view of the hand. A seated account gets the hand
   * as the seat it was dealt into in that hand, by the hand's own map, or
   * as nobody's seat when it was not dealt in: no hole card but shown ones,
   * no moves.
   */
  private frame(
    kind: 'welcome' | 'state',
    userId: string,
    exclude?: WebSocket,
  ): ServerMsg {
    const match = this.match!
    const six = match.config.kind === 'six-casual'
    const table: MatchInfo = {
      kind: match.config.kind,
      status: match.status,
      ...(match.config.handsTotal !== undefined
        ? { handsTotal: match.config.handsTotal }
        : {}),
      players: match.players.map((p) => ({
        seat: p.seat,
        username: p.username,
        connected: this.connected(p.userId, exclude),
        consecutiveTimeouts: p.timeouts,
        // Between hands, the stack the hand left: the one the next hand
        // deals, and whether the player may rebuy.
        ...(six ? { stack: this.stackOf(p), status: p.status! } : {}),
      })),
    }
    const turn = this.deadlines.find((d) => isCurrentTurn(d, this.hand))
    const seat = match.players.find((p) => p.userId === userId)?.seat ?? null
    const view =
      this.hand && seat !== null
        ? seatView(this.hand, this.handSeat(userId), {
            matchId: this.matchId(),
            match: table,
            clock:
              turn && match.status === 'playing'
                ? { deadline: turn.at, bankMs: this.bankOf(this.hand) }
                : null,
            lastReqId: this.ackOf(userId)?.reqId ?? null,
            commitment: this.current?.commitment ?? null,
          })
        : null
    const base = {
      seq: this.seq,
      matchId: this.matchId(),
      serverNow: this.clock(),
    }
    return kind === 'welcome'
      ? { ...base, t: 'welcome', seat, table, view }
      : { ...base, t: 'state', table, view }
  }

  /**
   * The finished hand's record and reveal, while it is still on the table,
   * for a seated account or one dealt into that hand (who may have stood
   * since); `own` only to an account dealt into it.
   */
  private sendEnded(ws: WebSocket) {
    const ended = this.ended
    // Only the end of the hand on the table, once it is over. A six table's
    // sessions repeat hand numbers, so the number alone would tie the last
    // session's end (and its openings) to a new session's hand under way.
    if (
      !ended ||
      !this.hand ||
      !isOver(this.hand) ||
      ended.record.handNo !== this.hand.config.handNo ||
      ended.record.matchId !== this.matchId()
    )
      return
    const userId = this.userOf(ws)
    const dealt = ended.record.seats.some((s) => s.userId === userId)
    if (!this.atTable(userId) && !dealt) return
    const base = { seq: this.seq, matchId: ended.record.matchId }
    this.send(ws, {
      ...base,
      t: 'hand_end',
      handNo: ended.record.handNo,
      record: ended.record,
    })
    const own =
      ended.own?.[userId] ??
      (this.match?.config.kind === 'six-casual'
        ? undefined
        : ended.own?.[String(this.seatOfUser(userId))])
    this.send(ws, {
      ...base,
      t: 'reveal',
      ...ended.reveal,
      ...(own ? { own } : {}),
    })
  }

  /**
   * `gone` is a socket that is closing: offline, and not sent to. `skip`
   * already has its frame (a fresh welcome) but still counts as connected.
   * Sockets without a seat get only `roster` changes (someone sat down),
   * and then without a view: never a hand's moves.
   */
  private broadcast(
    kind: 'state',
    {
      gone,
      skip,
      roster = false,
    }: { gone?: WebSocket; skip?: WebSocket; roster?: boolean } = {},
  ) {
    if (!this.match) return
    for (const ws of this.openSockets(gone)) {
      if (ws === skip) continue
      const userId = this.userOf(ws)
      if (!roster && !this.atTable(userId)) continue
      this.send(ws, this.frame(kind, userId, gone))
    }
  }

  private send(ws: WebSocket, msg: ServerMsg) {
    try {
      ws.send(JSON.stringify(msg))
    } catch {
      // The socket closed meanwhile; webSocketClose will follow.
    }
  }

  private reject(
    ws: WebSocket,
    code: ErrorCode,
    message: string,
    reqId?: string,
  ) {
    this.send(ws, {
      t: 'error',
      seq: this.seq,
      matchId: this.matchId(),
      code,
      message,
      ...(reqId ? { reqId } : {}),
    })
  }
}
