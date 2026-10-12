// The lobby's open games (ADR amendment 2026-10-12, "Live games"): what the
// lobby keeps for an invite table that waits for its friend, how fresh that
// must be to be offered, and the one function that turns it into a row a
// client sees. Pure, so the table and the lobby share one definition (as
// registry.ts does for the six tables).
import { GAMES_RETURNED, GAME_HOST_MAX } from '../../src/shared/protocol'
import type { GameRow } from '../../src/shared/protocol'
import { REPORT_MS } from './registry'

export { GAMES_RETURNED }

/**
 * A game the lobby has not heard of for this long is not offered, and its
 * code stops working: three missed heartbeats (OPEN_HEARTBEAT_MS), so a late
 * alarm or one lost report is slack, and a host who closed the tab takes the
 * code with them within a minute and a half. The link keeps working (24 h).
 */
export const GAME_STALE_MS = 90_000
/**
 * An `open:` row older than this is deleted when the lobby next reads the
 * list (with its `code:` and `gameid:` keys): a stale row still holds its
 * code, so that code is not given out again for a while, and a longer hold
 * would only let rows of dead games pile up.
 */
export const GAME_PRUNE_MS = 600_000
/**
 * `open:` rows the lobby stores at most as a creation counts them. A game
 * made past it is unlisted (never refused), so the list and its reads stay
 * bounded however many accounts create tables.
 */
export const GAMES_MAX = 200
/**
 * One `storage.list` serves every `games` frame inside this window, so the
 * cost of the list is the cache window's, not the number of players polling.
 * A client polls every 5 s; 2 s keeps a row's age and its removal fresh
 * enough to click on.
 */
export const GAMES_CACHE_MS = 2_000
/**
 * A join request lives this long, at the table and in the lobby: long enough
 * for a host to notice and answer, short enough that a request nobody read
 * does not hold the requester's one pending slot.
 */
export const REQUEST_TTL_MS = 60_000
/**
 * After Accept the other seat is held for the accepted account this long
 * (they must open the table from the lobby's `matched` frame). A requester
 * who never arrives costs the host one minute, not the game.
 */
export const RESERVE_MS = 60_000
/** Requests a host's prompt holds at once: a longer list is noise. */
export const REQUESTS_PER_GAME = 5
/** Accounts a host declined, kept so a decline sticks; the oldest go first. */
export const DECLINED_MAX = 20
/**
 * A waiting invite table tells the lobby it is open this often, by its own
 * clock: the same cadence as a six table's report (REPORT_MS), and a third
 * of GAME_STALE_MS.
 */
export const OPEN_HEARTBEAT_MS = REPORT_MS

/**
 * The lobby's `open:<matchId>` row: never sent to a client whole. `code` and
 * `hostId` seat or name an account; only `gameRow` builds what is shown.
 */
export type OpenGame = {
  gameId: string
  code: string
  hostId: string
  hostName: string
  /** Offered in the list; an unlisted game is reachable by its code only. */
  listed: boolean
  openedAt: number
  /** The latest heartbeat (lobby clock). */
  updatedAt: number
}

/** What a table tells the lobby when it is open: the row without its times. */
export type OpenReport = Pick<
  OpenGame,
  'gameId' | 'code' | 'hostId' | 'hostName' | 'listed'
>

/** Whether the row's host has been heard from lately enough (GAME_STALE_MS). */
export const isFresh = (game: OpenGame, t: number) =>
  t - game.updatedAt < GAME_STALE_MS

/** A row the list may show: listed, and fresh. */
export const isOffered = (game: OpenGame, t: number) =>
  game.listed && isFresh(game, t)

/** Whether a row is old enough to be deleted on the next read. */
export const isPrunable = (game: OpenGame, t: number) =>
  t - game.updatedAt > GAME_PRUNE_MS

/**
 * An open game as a client sees it: the list's handle, the host's public
 * name and how long it has waited, copied by name so nothing else the lobby
 * keeps (the code, the table's id, the host's account) can reach a frame,
 * whatever is added to a row later. Never the table's id or code, which
 * would seat without asking.
 */
export const gameRow = (
  {
    gameId,
    hostName,
    openedAt,
  }: Pick<OpenGame, 'gameId' | 'hostName' | 'openedAt'>,
  t: number,
): GameRow => ({
  gameId,
  host: hostName.slice(0, GAME_HOST_MAX),
  openForMs: Math.max(0, t - openedAt),
})

/** Longest waiting first; the handle breaks a tie, so the order is stable. */
export const byWaiting = (
  a: Pick<OpenGame, 'openedAt' | 'gameId'>,
  b: Pick<OpenGame, 'openedAt' | 'gameId'>,
) =>
  a.openedAt - b.openedAt ||
  (a.gameId < b.gameId ? -1 : a.gameId > b.gameId ? 1 : 0)
