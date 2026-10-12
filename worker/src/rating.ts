// The rating update of a finished rated match (P1-12), run from the table's
// outbox after the match is archived: read both players' current ratings,
// widen each RD for the 30-day periods they sat out, rate the match with
// Glicko-2 (src/rating/glicko2.ts, one match = one period) and apply it with
// the versions read. Postgres refuses a stale version (40001): another match
// of one of the players was rated in between, so this re-reads and
// recomputes against the then-current rating. A repeat after a success
// changes nothing and reports the change already made.
import {
  DEFAULT,
  idle,
  idlePeriods,
  rateMatch,
  SCORE,
  VERSION,
} from '../../src/rating/glicko2'
import type { Rating } from '../../src/rating/glicko2'
import type { SeatId } from '../../src/engine/types'
import type { Outcome, RatingChange } from '../../src/shared/protocol'
import type { WorkerEnv } from './env'
import type { ArchiveOutcome } from './supabase'
import { describeError, logEvent } from './log'
import { classifySettlement } from './settlement'

/** What the table queues when a rated match finishes with a result. */
export type RateCall = {
  matchId: string
  players: { seat: SeatId; userId: string; outcome: Outcome }[]
  /**
   * When the match finished (the table's clock). Inactivity is counted up to
   * here, and stored as the players' last match, however late the rating
   * applies. Absent on calls queued before it existed: the time of rating.
   */
  finishedAt?: number
}

export type RateOutcome = ArchiveOutcome & {
  change?: Record<SeatId, RatingChange>
}

/** Stale-version retries within one attempt before the outbox backs off. */
const STALE_TRIES = 5
const FORMAT = 'hu-duplicate'

type Row = Rating & {
  user_id: string
  version: number
  last_match_at: string | null
}

const headers = (env: WorkerEnv) => ({
  apikey: env.SUPABASE_SECRET_KEY ?? '',
  'Content-Type': 'application/json',
})

/** PostgREST's error code (e.g. 40001), never its message. */
async function codeOf(response: Response) {
  try {
    const body = (await response.json()) as { code?: unknown }
    return typeof body.code === 'string' ? body.code.slice(0, 16) : undefined
  } catch {
    return undefined
  }
}

/** Rates and applies one finished rated match. Never throws. */
export async function applyRating(
  env: WorkerEnv,
  call: RateCall,
  now: number,
): Promise<RateOutcome> {
  try {
    const verdict = await classifySettlement(env, call.matchId, { write: true })
    if (
      verdict.state !== 'verified' ||
      verdict.certificate.disposition !== 'rated'
    )
      return { ok: false, code: 'P0002' }
    const certificate = verdict.certificate
    const playedAt = certificate.finishedAt
    if (
      certificate.finishedAt > now ||
      call.players.length !== 2 ||
      !certificate.players.every((p) =>
        call.players.some(
          (c) =>
            c.seat === p.seat &&
            c.userId === p.userId &&
            c.outcome === p.outcome,
        ),
      )
    )
      return { ok: false, code: '23514' }
    for (let tries = 0; tries < STALE_TRIES; tries++) {
      const ids = call.players.map((p) => p.userId)
      const read = await fetch(
        `${env.SUPABASE_URL}/rest/v1/ratings?select=user_id,rating,rd,sigma,version,last_match_at&format=eq.${FORMAT}&user_id=in.(${ids.join(',')})`,
        { headers: headers(env) },
      )
      if (!read.ok) return { ok: false, status: read.status }
      const rows = (await read.json()) as Row[]
      // A player's rating as of now: RD widens for each idle 30-day period.
      const current = (userId: string) => {
        const row = rows.find((r) => r.user_id === userId)
        if (!row) return { rating: DEFAULT, version: 0 }
        const last = row.last_match_at ? Date.parse(row.last_match_at) : null
        return {
          rating: idle(
            { rating: row.rating, rd: row.rd, sigma: row.sigma },
            idlePeriods(last, playedAt),
          ),
          version: row.version,
        }
      }
      const [a, b] = [...call.players].sort((x, y) => x.seat - y.seat)
      const [ca, cb] = [current(a.userId), current(b.userId)]
      const [na, nb] = rateMatch(ca.rating, cb.rating, SCORE[a.outcome])
      const response = await fetch(
        `${env.SUPABASE_URL}/rest/v1/rpc/apply_rating`,
        {
          method: 'POST',
          headers: headers(env),
          body: JSON.stringify({
            p: {
              matchId: call.matchId,
              certificateDigest: certificate.evidenceDigest,
              sourceToken: certificate.sourceToken,
              format: FORMAT,
              modelVersion: VERSION,
              finishedAt: new Date(playedAt).toISOString(),
              players: [
                {
                  userId: a.userId,
                  outcome: a.outcome,
                  version: ca.version,
                  ...na,
                },
                {
                  userId: b.userId,
                  outcome: b.outcome,
                  version: cb.version,
                  ...nb,
                },
              ],
            },
          }),
        },
      )
      if (response.ok) {
        const applied = (await response.json()) as (RatingChange & {
          userId: string
        })[]
        const change = {} as Record<SeatId, RatingChange>
        for (const { seat, userId } of call.players) {
          const row = applied.find((r) => r.userId === userId)
          if (!row) return { ok: false, status: response.status }
          change[seat] = {
            before: row.before,
            after: row.after,
            matches: row.matches,
          }
        }
        logEvent('rated', { matchId: call.matchId })
        return { ok: true, change }
      }
      const code = await codeOf(response)
      if (code !== '40001') {
        logEvent('error', {
          reason: 'archive',
          rpc: 'apply_rating',
          code: response.status,
          detail: code,
        })
        return { ok: false, status: response.status, code }
      }
      // Stale: another match of one of these players was rated meanwhile.
    }
    return { ok: false, code: '40001' }
  } catch (error) {
    logEvent('error', {
      reason: 'archive',
      rpc: 'apply_rating',
      detail: describeError(error),
    })
    return { ok: false }
  }
}
