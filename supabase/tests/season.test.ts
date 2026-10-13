// @vitest-environment node
// A simulated season in a scratch database (P1-14, mission DONE WHEN): 200
// players with a hidden true skill play 5,000 rated matches over 60 days.
// Opponents are paired near rating, outcomes follow the true skill gap
// (with draws), and every match is rated the production way: Glicko-2 in
// src/rating/glicko2.ts, applied by apply_rating with the versions read.
// The ladder must rank players by true skill, show only eligible players,
// and the metrics file (supabase/metrics/rating-metrics.sql) must run on it,
// saying "insufficient data" on the empty database first.
// Nothing here touches production: PGlite only.
import { readFileSync, writeFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  DEFAULT,
  idle,
  idlePeriods,
  rateMatch,
  SCORE,
  VERSION,
} from '../../src/rating/glicko2'
import type { Rating } from '../../src/rating/glicko2'
import {
  migrationFiles,
  MIGRATIONS_DIR,
  seedRatedEvidence,
  SUPABASE_STUB,
} from './harness'

const PLAYERS = 200
const MATCHES = 5000
const DAY = 86_400_000
const SEASON_DAYS = 60
const METRICS = readFileSync(
  new URL('../metrics/rating-metrics.sql', import.meta.url),
  'utf8',
)

let db: PGlite

/** A small seeded generator, so the season is the same every run. */
function seeded(seed: number) {
  let t = seed >>> 0
  return () => {
    t = (t + 0x6d2b79f5) >>> 0
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}
const random = seeded(2026)
const normal = () =>
  Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random())

const uid = (n: number) =>
  `90000000-0000-4000-8000-${String(n).padStart(12, '0')}`

/** Spearman's rho, with average ranks for ties. */
function spearman(xs: number[], ys: number[]) {
  const ranks = (v: number[]) => {
    const order = v.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0])
    const r = new Array<number>(v.length)
    for (let i = 0; i < order.length; ) {
      let j = i
      while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++
      for (let k = i; k <= j; k++) r[order[k][1]] = (i + j) / 2
      i = j + 1
    }
    return r
  }
  const [a, b] = [ranks(xs), ranks(ys)]
  const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length
  const [ma, mb] = [mean(a), mean(b)]
  let cov = 0
  let va = 0
  let vb = 0
  for (let i = 0; i < a.length; i++) {
    cov += (a[i] - ma) * (b[i] - mb)
    va += (a[i] - ma) ** 2
    vb += (b[i] - mb) ** 2
  }
  return cov / Math.sqrt(va * vb)
}

type Metric = {
  metric: string
  value: string | null
  sample: number
  verdict: string
}
const metrics = async () => (await db.query<Metric>(METRICS)).rows

type Ladder = {
  user_id: string
  rating: number
  rd: number
  matches: number
}
async function ladder(fn: 'ladder' | 'ladder_month' = 'ladder') {
  const rows: Ladder[] = []
  let after: Ladder | null = null
  for (;;) {
    const page: Ladder[] = (
      await db.query<Ladder>(
        `select * from public.${fn}('hu-duplicate', $1, $2, 100)`,
        [after?.rating ?? null, after?.user_id ?? null],
      )
    ).rows
    if (!page.length) return rows
    rows.push(...page)
    after = page[page.length - 1]
  }
}

const skill: number[] = []
/** Players who stop after day 20, and players who abandon too often. */
const quitters = new Set([3, 4, 5, 6, 7])
const leavers = new Set([10, 11, 12, 13, 14])

beforeAll(async () => {
  db = new PGlite()
  await db.exec(SUPABASE_STUB)
  for (const f of migrationFiles())
    await db.exec(readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'))
  for (let n = 0; n < PLAYERS; n++) {
    skill.push(1500 + 250 * normal())
    await db.query(`insert into auth.users (id) values ($1)`, [uid(n)])
    // The placeholder name comes from the id's first 12 digits, which these
    // ids share, so each gets its real name before the next one is made.
    await db.query(
      `update public.players set username = $2 where user_id = $1`,
      [uid(n), `pl${n}`],
    )
  }
}, 60_000)

afterAll(() => db?.close())

describe('a simulated season', () => {
  it('says "insufficient data" for every metric before any rated match', async () => {
    const rows = await metrics()
    expect(rows.map((r) => r.metric)).toEqual([
      'accuracy validity',
      'predictive validity',
      'rating stability',
    ])
    for (const r of rows) {
      expect(r.value).toBeNull()
      expect(r.verdict).toMatch(/^insufficient data/)
    }
  })

  it('200 players and 5,000 matches: the ladder ranks by true skill, shows only eligible players, and the metrics run', async () => {
    const { rows } = await db.query<{ now: string }>(`select now()::text now`)
    const end = Date.parse(rows[0].now)
    const start = end - SEASON_DAYS * DAY
    const state = Array.from({ length: PLAYERS }, () => ({
      rating: { ...DEFAULT } as Rating,
      version: 0,
      last: null as number | null,
    }))
    for (let k = 0; k < MATCHES; k++) {
      const at = start + Math.floor(((k + 1) * SEASON_DAYS * DAY) / MATCHES)
      const active = (n: number) => !quitters.has(n) || at < start + 20 * DAY
      let a = Math.floor(random() * PLAYERS)
      while (!active(a)) a = Math.floor(random() * PLAYERS)
      // Rated quick-match: the closest rating among a few players looking.
      let b = -1
      for (let tries = 0; tries < 8; tries++) {
        const c = Math.floor(random() * PLAYERS)
        if (c === a || !active(c)) continue
        if (
          b < 0 ||
          Math.abs(state[c].rating.rating - state[a].rating.rating) <
            Math.abs(state[b].rating.rating - state[a].rating.rating)
        )
          b = c
      }
      if (b < 0) continue
      const pa = 1 / (1 + 10 ** ((skill[b] - skill[a]) / 400))
      const outcome = random() < 0.08 ? 'draw' : random() < pa ? 'win' : 'loss'
      const other = { win: 'loss', loss: 'win', draw: 'draw' }[outcome]
      const id = crypto.randomUUID()
      const finished = new Date(at).toISOString()
      // One verified hand whose luck-adjusted net gives the outcome (audit
      // F07): past the draw band either way, or nothing for a draw.
      const adjusted = { win: 100, loss: -100, draw: 0 }[outcome]!
      await db.exec(`
        insert into public.matches (id, kind, status, config, result, finished_at)
          values ('${id}', 'hu-rated', 'finished',
                  '{"handsTotal": 1, "blinds": {"sb": 10, "bb": 20}}',
                  '{"reason": "complete"}', '${finished}');
        insert into public.match_players (match_id, user_id, seat, outcome, adjusted_chips, finished_at)
          values ('${id}', '${uid(a)}', 0, '${outcome}', ${adjusted}, '${finished}'),
                 ('${id}', '${uid(b)}', 1, '${other}', ${-adjusted}, '${finished}');
      `)
      await seedRatedEvidence(
        db,
        id,
        [
          { seat: 0, userId: uid(a) },
          { seat: 1, userId: uid(b) },
        ],
        [adjusted],
      )
      const now = (n: number) =>
        idle(state[n].rating, idlePeriods(state[n].last, at))
      const [na, nb] = rateMatch(
        now(a),
        now(b),
        SCORE[outcome as keyof typeof SCORE],
      )
      await db.query('select public.apply_rating($1::jsonb)', [
        JSON.stringify({
          matchId: id,
          format: 'hu-duplicate',
          modelVersion: VERSION,
          finishedAt: finished,
          players: [
            { userId: uid(a), outcome, version: state[a].version, ...na },
            {
              userId: uid(b),
              outcome: other,
              version: state[b].version,
              ...nb,
            },
          ],
        }),
      ])
      state[a] = { rating: na, version: state[a].version + 1, last: at }
      state[b] = { rating: nb, version: state[b].version + 1, last: at }
    }
    // Five players abandon 15% of their matches (counted by record_match in
    // production); each player's accuracy follows their skill, with noise.
    for (const n of leavers)
      await db.query(
        `update public.ratings set abandoned = ceil(matches * 0.15) where user_id = $1`,
        [uid(n)],
      )
    for (let n = 0; n < PLAYERS; n++)
      await db.query(
        `insert into public.accuracy (user_id, format, accuracy, graded) values ($1, 'hu-duplicate', $2, 500)`,
        [
          uid(n),
          Math.max(
            0,
            Math.min(100, 70 + (8 * (skill[n] - 1500)) / 250 + 4 * normal()),
          ),
        ],
      )

    // The database agrees with the season played.
    const stored = (
      await db.query<{ user_id: string; rating: number; version: number }>(
        `select user_id, rating, version from public.ratings order by user_id`,
      )
    ).rows
    expect(stored).toHaveLength(PLAYERS)
    for (const r of stored) {
      const n = Number(r.user_id.slice(-12))
      expect(r.version).toBe(state[n].version)
      expect(r.rating).toBeCloseTo(state[n].rating.rating, 6)
    }

    const listed = await ladder()
    const ids = listed.map((r) => Number(r.user_id.slice(-12)))
    // Only eligible players: nobody inactive or abandoning, nobody provisional.
    for (const r of listed) {
      expect(r.matches).toBeGreaterThanOrEqual(20)
      expect(r.rd).toBeLessThan(100)
    }
    for (const n of [...quitters, ...leavers]) expect(ids).not.toContain(n)
    expect(listed.length).toBeGreaterThan(150)
    // Ranked by true skill.
    const rho = spearman(
      ids.map((n) => skill[n]),
      listed.map((r) => r.rating),
    )
    expect(rho).toBeGreaterThan(0.8)
    // This month's ladder lists a subset with this month's matches.
    const month = await ladder('ladder_month')
    expect(month.length).toBeGreaterThan(0)
    expect(month.length).toBeLessThanOrEqual(listed.length)

    const result = await metrics()
    const by = Object.fromEntries(result.map((r) => [r.metric, r]))
    for (const r of result) {
      expect(r.value).not.toBeNull()
      expect(r.verdict).toMatch(/^(meets|misses) target$/)
    }
    expect(Number(by['accuracy validity'].value)).toBeGreaterThan(0.4)
    expect(Number(by['predictive validity'].value)).toBeGreaterThan(50)

    if (process.env.SEASON_OUT)
      writeFileSync(
        process.env.SEASON_OUT,
        JSON.stringify(
          { rho, listed: listed.length, month: month.length, metrics: result },
          null,
          2,
        ),
      )
  }, 600_000)
})
