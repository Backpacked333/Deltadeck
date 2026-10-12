// How much one account may ask of a Durable Object. Every frame or connect an
// object handles is work on a single thread shared by everyone in it (the
// whole lobby, or both seats of a table), so each account gets a token
// bucket there: a burst of FRAMES_PER_WINDOW, refilled at that many per
// WINDOW_MS. Frames and new sockets both spend from it, so reconnecting does
// not buy a fresh budget. A socket that runs dry is closed with
// CLOSE_RATE_LIMITED; honest clients reconnect after a backoff and keep their
// seat.
//
// Buckets live in memory, keyed by account. Hibernation drops them, which is
// harmless: an object only hibernates after it has been quiet, and a quiet
// bucket is full again within WINDOW_MS. The lobby's quick-sit buckets are
// the exception: their window is a minute, longer than the lobby stays
// awake when quiet, so the lobby keeps those in storage (spendToken). So are
// the buckets of live games (code tries, join requests, list reads): codes
// are guessed over minutes.

import { QUICK_SIT_TABLES } from '../../src/shared/protocol'

export { CLOSE_RATE_LIMITED } from '../../src/shared/protocol'

export const FRAMES_PER_WINDOW = 20
export const WINDOW_MS = 5000
/** Illegal frames one seat may send in one hand before it is closed. */
export const ILLEGAL_PER_HAND = 5
/**
 * Tables one account may create per UTC day: invite tables and the six
 * tables its quick-sits open, together.
 */
export const MATCH_CREATES_PER_DAY = 30
/**
 * Quick-sits one account may ask of the lobby: a burst of QUICK_SITS,
 * refilled at that many per QUICK_SIT_WINDOW_MS. A whole quick-sit is up to
 * QUICK_SIT_TABLES + 1 requests (a bare one, then one per table tried), so
 * the burst is two whole quick-sits. A quick-sit reads the list, may ask
 * tables whether they still exist and may open one, so it costs more than
 * a frame. The lobby stores each account's bucket: one kept in memory came
 * back full whenever the quiet lobby hibernated, within seconds.
 */
export const QUICK_SITS = 2 * (QUICK_SIT_TABLES + 1)
export const QUICK_SIT_WINDOW_MS = 60_000
/**
 * Failed code lookups one account may make (ADR amendment 2026-10-12, "Live
 * games"): a burst of CODE_FAILS, refilled at that many per
 * CODE_FAIL_WINDOW_MS. Only a code that opens no game spends from it, and a
 * hit costs nothing. A code is a seat capability of about 30 bits, so the
 * allowance is what a guesser may try: five misses, then one more every two
 * minutes, per account.
 */
export const CODE_FAILS = 5
export const CODE_FAIL_WINDOW_MS = 600_000
/**
 * Failed code lookups the whole lobby tolerates: CODE_FAILS_GLOBAL per
 * CODE_FAIL_WINDOW_GLOBAL_MS. Accounts are cheap, so the per-account bucket
 * alone does not stop a scan from many; this one trips on the scan's volume,
 * not its sources. Past it a miss is answered as rate limited, and a hit is
 * still served, so an honest friend is not locked out by a stranger's scan.
 */
export const CODE_FAILS_GLOBAL = 60
export const CODE_FAIL_WINDOW_GLOBAL_MS = 60_000
/**
 * Join requests one account may send: a burst of JOIN_REQUESTS, refilled at
 * that many per JOIN_REQUEST_WINDOW_MS. A request wakes a host and a table,
 * and a host who declined does not hear again, so six in five minutes is
 * generous for anyone looking for a game.
 */
export const JOIN_REQUESTS = 6
export const JOIN_REQUEST_WINDOW_MS = 300_000
/**
 * Reads of the open games one account may ask for: a burst of GAME_LISTS,
 * refilled at that many per GAME_LIST_WINDOW_MS (so 20 a minute). A client
 * polls every 5 s (12 a minute); the burst lets a page open and refresh
 * without being cut off. The frame budget alone allows 240 a minute.
 */
export const GAME_LISTS = 10
export const GAME_LIST_WINDOW_MS = 30_000
/**
 * Signed-in requests (socket upgrades, /api/matches, /api/me) per client
 * address per minute. Must equal `ratelimits[IP_LIMITER].simple.limit` in
 * wrangler.jsonc (checked by scripts/wrangler-config.test.ts).
 */
export const UPGRADES_PER_IP_PER_MINUTE = 300

/** Tokens left in an account's bucket, as of `at`. */
export type Bucket = { tokens: number; at: number }

/** Buckets kept before full (idle) ones are dropped. */
const MAX_BUCKETS = 1000

/**
 * `bucket` (full when there is none) refilled up to `t`: it holds `burst`
 * at most and earns that many per `windowMs`.
 */
function refilled(
  bucket: Bucket | undefined,
  t: number,
  burst: number,
  windowMs: number,
): Bucket {
  const from = bucket ?? { tokens: burst, at: t }
  const earned = (Math.max(0, t - from.at) * burst) / windowMs
  return { tokens: Math.min(burst, from.tokens + earned), at: t }
}

/**
 * Spends one token from `bucket` at `t`: the bucket to keep, or null when
 * it has none left (keep the old one). Pure, for a bucket the caller
 * stores itself.
 */
export function spendToken(
  bucket: Bucket | undefined,
  t: number,
  burst: number,
  windowMs: number,
): Bucket | null {
  const now = refilled(bucket, t, burst, windowMs)
  return now.tokens < 1 ? null : { tokens: now.tokens - 1, at: t }
}

export class FrameBudget {
  private buckets = new Map<string, Bucket>()

  /**
   * `clock` is read on every frame, so a test can move it. A bucket holds
   * `burst` and refills that many per `windowMs`: frames by default.
   */
  constructor(
    private readonly clock: () => number,
    private readonly burst = FRAMES_PER_WINDOW,
    private readonly windowMs = WINDOW_MS,
  ) {}

  /** Spends one frame or connect; false when the account has none left. */
  spend(userId: string): boolean {
    const bucket = this.refill(userId)
    if (bucket.tokens < 1) return false
    bucket.tokens -= 1
    if (this.buckets.size > MAX_BUCKETS) this.prune()
    return true
  }

  /** Gives a frame back, for one that did useful work (an applied move). */
  refund(userId: string) {
    const bucket = this.refill(userId)
    bucket.tokens = Math.min(this.burst, bucket.tokens + 1)
  }

  /** Forgets every account (tests start each case with full budgets). */
  clear() {
    this.buckets.clear()
  }

  private refill(userId: string) {
    const bucket = refilled(
      this.buckets.get(userId),
      this.clock(),
      this.burst,
      this.windowMs,
    )
    this.buckets.set(userId, bucket)
    return bucket
  }

  /** A full bucket is the same as no bucket: drop those. */
  private prune() {
    for (const userId of [...this.buckets.keys()])
      if (this.refill(userId).tokens >= this.burst) this.buckets.delete(userId)
  }
}
