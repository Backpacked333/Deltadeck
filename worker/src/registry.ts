// The lobby's list of six tables (P2-08; ADR amendment 2026-10-10, "Table
// list and quick-sit", and its clarifications from PR-23): what a table
// keeps to describe itself, the counts it reports, and the order the lobby
// lists them in. Pure, so the table and the lobby share one definition.
import type { HandState } from '../../src/engine/types'
import { IDLE_MS } from './deadlines'

/**
 * A table reports at most this often, by its own clock: the lobby is one
 * object for every table, and each report wakes it.
 */
export const REPORT_MS = 30_000
/** avgPot and playersPerHour describe the hour before a report. */
export const REGISTRY_WINDOW_MS = 3_600_000
/**
 * avgPot averages at most this many of the latest hands, which also bounds
 * what the table writes with every hand end.
 */
export const REGISTRY_HANDS = 20
/** playersPerHour counts at most this many accounts, for the same reason. */
export const REGISTRY_ACCOUNTS = 100
/**
 * An entry the lobby has not heard of for longer than this is treated as
 * gone (its table died without removing itself). A waiting table refreshes
 * at every idle check, IDLE_MS apart: one missed check is slack.
 */
export const REGISTRY_STALE_MS = 2 * IDLE_MS

/** What a six table tells the lobby: counts only, never an account. */
export type TableReport = {
  /** Accounts holding a seat now, playing or sitting out. */
  seated: number
  maxSeats: number
  /** Mean final pot in chips of the hands in the window; null if none. */
  avgPot: number | null
  /** Distinct accounts dealt into a hand that ended in the window. */
  playersPerHour: number
}
/** The lobby's `table:<tableId>` entry: a report, and when it landed. */
export type TableEntry = TableReport & { updatedAt: number }
/** An entry as the lobby lists it. */
export type ListedTable = { tableId: string } & TableEntry

/**
 * What a six table keeps for its entry, stored as `listing` with the change
 * it describes, so a restart keeps both the hour and the throttle.
 */
export type Listing = {
  /** The latest REGISTRY_HANDS hands to end: when (table clock), final pot. */
  hands: { at: number; pot: number }[]
  /**
   * Each account dealt into a hand that ended within the window, with when
   * the latest one ended. The table's own storage: the lobby gets a count.
   */
  seen: Record<string, number>
  /** When the table last sent a report (its clock); 0 before the first. */
  reportedAt: number
  /** A change the throttle held back, for the first alarm or change after. */
  pending: boolean
}

export const newListing = (): Listing => ({
  hands: [],
  seen: {},
  reportedAt: 0,
  pending: false,
})

/**
 * A finished hand's final pot: what its winners were awarded. An uncalled
 * bet went back to its owner before the award, so it is not part of it.
 */
export const finalPot = (hand: HandState) =>
  hand.result!.awards.reduce((sum, a) => sum + a.amount, 0)

/**
 * Adds a hand that ended at `at` with final pot `pot`, dealt to `userIds`.
 * Older hands past REGISTRY_HANDS and accounts outside the window go, and
 * past REGISTRY_ACCOUNTS the accounts seen longest ago go first.
 */
export function noteHand(
  listing: Listing,
  at: number,
  pot: number,
  userIds: string[],
) {
  listing.hands = [...listing.hands, { at, pot }].slice(-REGISTRY_HANDS)
  const since = at - REGISTRY_WINDOW_MS
  const seen = Object.entries(listing.seen).filter(
    ([userId, t]) => t >= since && !userIds.includes(userId),
  )
  for (const userId of userIds) seen.push([userId, at])
  // Stable: among accounts seen at the same moment, the earlier listed go.
  seen.sort((a, b) => a[1] - b[1])
  listing.seen = Object.fromEntries(seen.slice(-REGISTRY_ACCOUNTS))
}

/** The table's report at `now`: the window is the hour up to it. */
export function reportOf(
  listing: Listing,
  now: number,
  seated: number,
  maxSeats: number,
): TableReport {
  const since = now - REGISTRY_WINDOW_MS
  const pots = listing.hands.filter((h) => h.at >= since).map((h) => h.pot)
  return {
    seated,
    maxSeats,
    avgPot: pots.length
      ? Math.round(pots.reduce((sum, p) => sum + p, 0) / pots.length)
      : null,
    playersPerHour: Object.values(listing.seen).filter((t) => t >= since)
      .length,
  }
}

/** Whether the lobby treats `entry` as gone at `now` (REGISTRY_STALE_MS). */
export const isStale = (entry: TableEntry, now: number) =>
  now - entry.updatedAt > REGISTRY_STALE_MS

/**
 * The fresh entries in quick-sit's order: tables with a free seat first,
 * the fullest first, then full tables; ties by table id, so the order is
 * the same on every read.
 */
export function listTables(
  rows: Iterable<[string, TableEntry]>,
  now: number,
): ListedTable[] {
  const free = (t: TableEntry) => (t.seated < t.maxSeats ? 1 : 0)
  return [...rows]
    .filter(([, entry]) => !isStale(entry, now))
    .map(([tableId, entry]) => ({ tableId, ...entry }))
    .sort(
      (a, b) =>
        free(b) - free(a) ||
        b.seated - a.seated ||
        (a.tableId < b.tableId ? -1 : a.tableId > b.tableId ? 1 : 0),
    )
}
