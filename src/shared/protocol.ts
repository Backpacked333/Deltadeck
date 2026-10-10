// The wire protocol between the browser and the table server. The protocol
// version is the WebSocket subprotocol name; an unknown version is refused at
// upgrade so old clients reload instead of misreading frames.
import type {
  Award,
  HandAction,
  HandConfig,
  LegalActions,
  PlayerAction,
  Pot,
  SeatId,
  Street,
} from '../engine/types'

export const PROTOCOL = 'qp.v1'
/** Largest client frame the server will parse. */
export const MAX_FRAME = 4096

// Close codes the server uses (the WebSocket private range 4000–4999). Each
// one tells the client what to do next.
/** Another socket for this account took over (a second tab). Stop. */
export const CLOSE_REPLACED = 4001
/**
 * An oversized frame, or too many illegal frames in one hand. The seat keeps
 * its reconnect rights; reconnect after a backoff.
 */
export const CLOSE_ABUSE = 4400
/** The table has closed (finished and cleaned up, or an expired invite). */
export const CLOSE_GONE = 4404
/** This account is playing at another table; the reason is its matchId. */
export const CLOSE_ELSEWHERE = 4409
/** Too many frames or connections. Reconnect after a backoff of ≥ 1 s. */
export const CLOSE_RATE_LIMITED = 4429

/**
 * `six-casual`: a casual table of 2 to 6 seats, one archived session at a
 * time (ADR amendment 2026-10-10, Phase 2). Never rated or graded.
 */
export type MatchKind = 'hu-casual' | 'hu-rated' | 'six-casual'
export type MatchConfig = {
  kind: MatchKind
  /** Six tables: how many seats the table has. Absent: heads-up. */
  maxSeats?: number
  /**
   * Heads-up: the match's length in hands. Absent at a six table, which
   * deals for as long as two players can be dealt in.
   */
  handsTotal?: number
  startingStack: number
  blinds: { sb: number; bb: number }
  /** Per-decision clock and time bank, in milliseconds. */
  decisionMs: number
  bankMs: number
  /**
   * The bank refills to `bankMs` every this many hands (rated: 20, so each
   * half of the match has its own). Absent: one bank for the whole match.
   */
  bankRefillEvery?: number
}

/** A rated player's result: from the luck-adjusted total and the draw band. */
export type Outcome = 'win' | 'draw' | 'loss'

export type ClientMsg =
  | {
      t: 'act'
      reqId: string
      handNo: number
      actionIndex: number
      action: PlayerAction
    }
  | { t: 'resync' }
  /** The heads-up queue: a six table is joined by sitting down, not queued. */
  | { t: 'queue'; kind: Exclude<MatchKind, 'six-casual'> }
  | { t: 'dequeue' }
  /** At a finished rated table: play the same opponent again. */
  | { t: 'rematch' }
  /**
   * At a six table: take `seat`, or the lowest free seat. Who sits is the
   * socket's account and the stack is the buy-in: the frame names neither.
   */
  | { t: 'sit'; seat?: SeatId }
  /**
   * At a six table: leave the seat. During a hand the player was dealt into,
   * they fold when the action next reaches them and the seat frees when the
   * hand ends; otherwise it frees at once.
   */
  | { t: 'stand' }

/** A seated six-casual player: dealt in, or sitting out (P2-04). */
export type SeatStatus = 'playing' | 'sitting_out'

export type ErrorCode =
  | 'not_your_turn'
  | 'illegal'
  | 'stale'
  | 'rate_limited'
  | 'too_large'
  | 'replaced'
  | 'halted'
  | 'unauthorized'
  /** Rated play needs a confirmed email on a permanent account. */
  | 'unverified'
  /** Six tables: the seat asked for has a player. */
  | 'seat_taken'
  /** Six tables: every seat has a player. */
  | 'table_full'
  /**
   * Six tables: this account stood up here too recently to sit again; the
   * error says how many more hands, or until when (whichever comes first).
   */
  | 'sit_cooldown'
  /** Six tables: a seat-only message from a socket without a seat. */
  | 'not_seated'

/**
 * Everything one seat may know about the table. There is deliberately no
 * field for the deck, other seats' unshown cards, the hand secret, or any
 * analysis (equity, EV, ranges, grades): the schema itself keeps them out.
 */
export type SeatView = {
  matchId: string
  handNo: number
  /**
   * The seat this viewer was dealt into in this hand, or null: a six-casual
   * player who sat down after the deal sees the hand as nobody's seat does.
   */
  you: SeatId | null
  button: SeatId
  /**
   * Six-casual hands: the seat that posted the small blind (null when it was
   * dead) and the big blind's seat. Heads-up views leave both out.
   */
  sb?: SeatId | null
  bb?: SeatId
  street: Street
  board: number[]
  /** This hand's deck commitment; null between hands. */
  commitment: string | null
  match: {
    kind: MatchKind
    status: 'waiting' | 'playing' | 'finished'
    /** Heads-up only, as in MatchConfig. */
    handsTotal?: number
    players: {
      seat: SeatId
      username: string
      connected: boolean
      consecutiveTimeouts: number
      /** Six tables: chips as of the last deal (or the buy-in, if since). */
      stack?: number
      /** Six tables. */
      status?: SeatStatus
    }[]
  }
  pot: { total: number; layers: Pot[] }
  toAct: SeatId | null
  /** Only when toAct === you. */
  legal: LegalActions | null
  /** Size of the last full raise this street (public, from the actions). */
  lastRaise: number
  actions: HandAction[]
  /** Server epoch milliseconds. */
  clock: { deadline: number; bankMs: number } | null
  players: {
    seat: SeatId
    stack: number
    bet: number
    invested: number
    folded: boolean
    allIn: boolean
    cards: [number, number] | null
    shown: boolean
  }[]
  lastReqId: string | null
  result?: {
    awards: Award[]
    netBySeat: Record<SeatId, number>
    showdown: boolean
  }
}

/** A view for a seat dealt into the hand: heads-up views are always one. */
export type SeatedView = SeatView & { you: SeatId }
export const isSeated = (view: SeatView): view is SeatedView =>
  view.you !== null

/** Who is at the table and how the match stands. */
export type MatchInfo = SeatView['match']

/** The permanent public record of a hand: no deck, no unshown cards. */
export type HandRecordV1 = {
  v: 1
  matchId: string
  handNo: number
  segment: number
  config: HandConfig
  seats: { seat: SeatId; userId: string; username: string }[]
  commitment: string
  actions: (HandAction & {
    atMs: number
    decisionMs: number
    source: 'client' | 'timeout'
  })[]
  board: number[]
  shown: { seat: SeatId; cards: [number, number] }[]
  awards: Award[]
  netBySeat: Record<SeatId, number>
  showdown: boolean
  /**
   * Rated hands only (luck.ts): the all-in pot settled at equity. Archived,
   * never in a frame; it is computed after the hand, from shown cards only.
   */
  luck?: {
    allInAt: number | null
    equity: Record<SeatId, number> | null
    adjustedBySeat: Record<SeatId, number>
  }
}

export type Reveal = {
  handNo: number
  /** Base64 of all 52 leaves (52 × 32 bytes). */
  leaves: string
  /** The board and shown hands: the same for every seat, and archived. */
  slots: { slot: number; card: number; salt: string }[]
  /**
   * This seat's own two hole slots, so a player can check the cards they
   * were dealt (folded or not). Sent to that seat only; never archived.
   */
  own?: { slot: number; card: number; salt: string }[]
}

/**
 * A finished rated match's rematch offer (P1-04). `open`: nobody has
 * pressed yet. `waiting`: one player has, until `until`. `starting`: both
 * did, and `next` is the new table. `declined`: the press expired, or a
 * player is already at another table. `limit`: the pair has met
 * PAIRS_PER_DAY times today.
 */
export type RematchState =
  | 'open'
  | 'waiting'
  | 'starting'
  | 'declined'
  | 'limit'

/** One player's rating change from a rated match (P1-12). Ratings are public. */
export type RatingChange = {
  before: { rating: number; rd: number }
  after: { rating: number; rd: number }
  /** Rated matches played, counting this one (for the provisional rule). */
  matches: number
}

/** `abandoned`: both players were gone past the grace (rated; void). */
export type MatchEndReason =
  | 'complete'
  | 'forfeit'
  | 'no_show'
  | 'engine_fault'
  | 'abandoned'

export type ServerMsg = { seq: number; matchId: string } & (
  | {
      t: 'welcome'
      /** null: this account has no seat at the (six) table. */
      seat: SeatId | null
      table: MatchInfo
      /** null until the first hand is dealt. */
      view: SeatView | null
      serverNow: number
    }
  | { t: 'state'; table: MatchInfo; view: SeatView | null; serverNow: number }
  | {
      t: 'hand_start'
      handNo: number
      commitment: string
      button: SeatId
      blinds: { sb: number; bb: number }
      stacks: number[]
      /**
       * Six-casual: each dealt seat with the stack in `stacks` (after the
       * blinds), and the blind seats as in SeatView.
       */
      seats?: { seat: SeatId; stack: number }[]
      sb?: SeatId | null
      bb?: SeatId
    }
  | { t: 'hand_end'; handNo: number; record: HandRecordV1 }
  | ({ t: 'reveal' } & Reveal)
  | {
      t: 'match_end'
      result: {
        netBySeat: Record<SeatId, number>
        reason: MatchEndReason
        forfeit?: SeatId
        /** Seats that never connected, for a no-show. */
        noShow?: SeatId[]
        /** Seats gone past the grace, for an abandoned match. */
        abandoned?: SeatId[]
        /** Rated: the luck-adjusted total per seat. */
        adjustedBySeat?: Record<SeatId, number>
        /** Rated and not void: each seat's win, draw or loss. */
        outcomeBySeat?: Record<SeatId, Outcome>
      }
    }
  | {
      t: 'error'
      code: ErrorCode
      reqId?: string
      message: string
      /**
       * sit_cooldown only: hands still to be dealt here before this account
       * may sit again, and the server epoch milliseconds when it may anyway.
       */
      handsLeft?: number
      until?: number
    }
  | {
      t: 'rating'
      /** Rated, after the match: each seat's change, once it is applied. */
      change: Record<SeatId, RatingChange>
    }
  | {
      t: 'rematch_state'
      state: RematchState
      /** Seats that pressed Rematch. */
      pressed: SeatId[]
      /** Server epoch milliseconds when an unanswered press expires. */
      until?: number
      /** The new table, once starting. */
      next?: string
    }
)

export type LobbyMsg = { seq: number } & (
  | { t: 'queued'; position: number; since: number }
  /** A table to go to: a new pairing, or (resumed) one already in play. */
  | { t: 'matched'; matchId: string; resumed?: boolean }
  /** `queued` counts every line; `rated`, those of them waiting for rated. */
  | { t: 'presence'; online: number; queued: number; rated?: number }
  | { t: 'error'; code: ErrorCode; message: string }
)

// ---- Validation ---------------------------------------------------------------

type Json = Record<string, unknown>
const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const onlyKeys = (v: Json, keys: string[]) =>
  Object.keys(v).every((k) => keys.includes(k))
const isCount = (v: unknown, min = 0) =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min
const REQ_ID = /^[A-Za-z0-9_-]{1,64}$/

function parseAction(v: unknown): PlayerAction | null {
  if (!isObject(v)) return null
  switch (v.type) {
    case 'fold':
    case 'check':
    case 'call':
      return onlyKeys(v, ['type']) ? { type: v.type } : null
    case 'raise':
      return onlyKeys(v, ['type', 'to']) && isCount(v.to, 1)
        ? { type: 'raise', to: v.to as number }
        : null
    default:
      return null
  }
}

/**
 * Parses one client frame, or returns null for anything malformed: oversize,
 * invalid JSON, an unknown type, a missing or extra key, or a non-integer
 * number. The server never acts on a frame this rejects.
 */
export function parseClientMsg(raw: unknown): ClientMsg | null {
  if (typeof raw !== 'string' || raw.length > MAX_FRAME) return null
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isObject(v)) return null
  switch (v.t) {
    case 'act': {
      if (!onlyKeys(v, ['t', 'reqId', 'handNo', 'actionIndex', 'action']))
        return null
      const action = parseAction(v.action)
      if (
        typeof v.reqId !== 'string' ||
        !REQ_ID.test(v.reqId) ||
        !isCount(v.handNo, 1) ||
        !isCount(v.actionIndex) ||
        !action
      )
        return null
      return {
        t: 'act',
        reqId: v.reqId,
        handNo: v.handNo as number,
        actionIndex: v.actionIndex as number,
        action,
      }
    }
    case 'resync':
    case 'dequeue':
    case 'rematch':
    case 'stand':
      return onlyKeys(v, ['t']) ? { t: v.t } : null
    case 'sit':
      if (!onlyKeys(v, ['t', 'seat'])) return null
      if (v.seat === undefined) return { t: 'sit' }
      // Seat ids are 0..5 everywhere (ADR amendment 2026-10-10, "Seats").
      return isCount(v.seat) && (v.seat as number) <= 5
        ? { t: 'sit', seat: v.seat as number }
        : null
    case 'queue':
      return onlyKeys(v, ['t', 'kind']) &&
        (v.kind === 'hu-casual' || v.kind === 'hu-rated')
        ? { t: 'queue', kind: v.kind }
        : null
    default:
      return null
  }
}
