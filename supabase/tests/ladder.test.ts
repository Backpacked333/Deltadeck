// @vitest-environment node
// The ladder (P1-14): only eligible players, by rating, with keyset pages.
// Eligible: not provisional (RD < 100 and at least 20 rated matches), a
// rated match in the last 30 days, and abandonment under 10% of rated
// matches (exactly 10% is out). "This month" lists players with a rated
// match this UTC month, with that month's matches, wins and trend.
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrationFiles, MIGRATIONS_DIR, SUPABASE_STUB } from './harness'

let db: PGlite

/** A deterministic uuid for player n. */
import { certifiedRatingFixture } from './rating-fixture'

const uid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

type Seed = {
  rating: number
  rd?: number
  matches?: number
  abandoned?: number
  daysAgo?: number
}
/** Creates player n with a ratings row (and the account the row needs). */
async function player(n: number, s: Seed) {
  await db.query(`insert into auth.users (id) values ($1)`, [uid(n)])
  await db.query(`update public.players set username = $2 where user_id = $1`, [
    uid(n),
    `pl${n}`,
  ])
  await db.query(
    `insert into public.ratings (user_id, format, rating, rd, matches, wins, abandoned, last_match_at)
     values ($1, 'hu-duplicate', $2, $3, $4, $5, $6, now() - make_interval(days => $7))`,
    [
      uid(n),
      s.rating,
      s.rd ?? 60,
      s.matches ?? 30,
      Math.floor((s.matches ?? 30) / 2),
      s.abandoned ?? 0,
      s.daysAgo ?? 1,
    ],
  )
}

type LadderRow = {
  user_id: string
  username: string
  rating: number
  matches: number
  wins: number
  trend: number | null
}
const page = (
  fn: 'ladder' | 'ladder_month',
  after: { rating: number; user_id: string } | null,
  size = 50,
  role = 'anon',
) =>
  as(
    role,
    async () =>
      (
        await db.query<LadderRow>(
          `select * from public.${fn}('hu-duplicate', $1, $2, $3)`,
          [after?.rating ?? null, after?.user_id ?? null, size],
        )
      ).rows,
  )

async function as<T>(role: string, run: () => Promise<T>) {
  await db.exec(`set role ${role}`)
  try {
    return await run()
  } finally {
    await db.exec('reset role')
  }
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(SUPABASE_STUB)
  for (const f of migrationFiles())
    await db.exec(readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'))
}, 60_000)

afterAll(() => db?.close())

describe('the ladder', () => {
  it('shows only eligible players, by rating; exactly 10% abandonment is out', async () => {
    await player(1, { rating: 1800 })
    await player(2, { rating: 1900, rd: 120 }) // provisional: RD
    await player(3, { rating: 1950, matches: 19 }) // provisional: matches
    await player(4, { rating: 2000, daysAgo: 31 }) // inactive
    await player(5, { rating: 1700, matches: 30, abandoned: 3 }) // exactly 10%
    await player(6, { rating: 1650, matches: 31, abandoned: 3 }) // 9.7%
    await player(7, { rating: 1750, rd: 99.9, matches: 20, daysAgo: 29 })
    expect((await page('ladder', null)).map((r) => r.username)).toEqual([
      'pl1',
      'pl7',
      'pl6',
    ])
  })

  it('pages of 50 over 1,000 players have no gaps or repeats', async () => {
    // 1,000 players over 700 distinct ratings: the user id breaks ties.
    for (let n = 100; n < 1100; n++)
      await player(n, { rating: 1200 + ((n * 37) % 700) })
    const all = await page('ladder', null, 100_000)
    const seen: string[] = []
    let after: LadderRow | null = null
    for (;;) {
      const rows: LadderRow[] = await page('ladder', after)
      if (!rows.length) break
      expect(rows.length).toBeLessThanOrEqual(50)
      seen.push(...rows.map((r) => r.user_id))
      after = rows[rows.length - 1]
    }
    // The page size is capped at 100 even when asked for more.
    expect(all).toHaveLength(100)
    expect(seen).toHaveLength(1003) // 1,000 here plus pl1, pl7, pl6
    expect(new Set(seen).size).toBe(seen.length)
    const ordered = [...seen]
    const rating = new Map<string, number>()
    let cursor: LadderRow | null = null
    for (;;) {
      const rows: LadderRow[] = await page('ladder', cursor, 100)
      if (!rows.length) break
      for (const r of rows) rating.set(r.user_id, r.rating)
      cursor = rows[rows.length - 1]
    }
    ordered.sort((a, b) => rating.get(b)! - rating.get(a)! || (a < b ? -1 : 1))
    expect(seen).toEqual(ordered)
  }, 120_000)

  it('this month lists players with a rated match this UTC month: that month’s matches, wins and trend', async () => {
    const month = async (
      n: number,
      outcome: string,
      created: string,
      before: number,
      after: number,
    ) => {
      const id = crypto.randomUUID()
      await db.query(
        `insert into public.matches (id, kind, status, config) values ($1, 'hu-rated', 'finished', '{}')`,
        [id],
      )
      await db.query(
        `insert into public.rating_history (user_id, format, kind, match_id, outcome,
           before_rating, before_rd, before_sigma, after_rating, after_rd, after_sigma, model_version, played_at)
         values ($1, 'hu-duplicate', 'match', $2, $3, $4, 60, 0.06, $5, 60, 0.06, 'glicko2.v1', ${created})`,
        [uid(n), id, outcome, before, after],
      )
    }
    const thisMonth = `date_trunc('month', now()) + interval '1 hour'`
    const lastMonth = `date_trunc('month', now()) - interval '1 day'`
    // pl1: two this month (a win and a loss), one last month.
    await month(1, 'win', lastMonth, 1700, 1720)
    await month(1, 'win', thisMonth, 1760, 1790)
    await month(1, 'loss', `${thisMonth} + interval '1 hour'`, 1790, 1800)
    // pl6: only last month.
    await month(6, 'win', lastMonth, 1600, 1650)
    const rows = await page('ladder_month', null)
    expect(rows.map((r) => [r.username, r.matches, r.wins, r.trend])).toEqual([
      ['pl1', 2, 1, 40],
    ])
  })

  it('a match counts in the month it was played, even when its rating applied the next month', async () => {
    // pl1 beats pl7 at 23:59 UTC on the last day of last month; the rating
    // is applied now, this month (a retry after an outage).
    const id = crypto.randomUUID()
    const { rows } = await db.query<{ at: string; last: string }>(
      `select (date_trunc('month', now() at time zone 'utc') at time zone 'utc'
                 - interval '1 minute')::text as at,
              (date_trunc('month', now() at time zone 'utc') - interval '1 day')::date::text as last`,
    )
    const [{ at, last }] = rows
    const certificate = await certifiedRatingFixture(
      db,
      id,
      uid(7),
      uid(1),
      new Date(at).toISOString(),
    )
    await db.query('select public.apply_rating($1::jsonb)', [
      JSON.stringify({
        matchId: id,
        ...certificate,
        format: 'hu-duplicate',
        modelVersion: 'glicko2.v1',
        finishedAt: at,
        players: [
          {
            userId: uid(1),
            seat: 1,
            outcome: 'win',
            version: 0,
            rating: 1810,
            rd: 59,
            sigma: 0.06,
          },
          {
            userId: uid(7),
            seat: 0,
            outcome: 'loss',
            version: 0,
            rating: 1740,
            rd: 99,
            sigma: 0.06,
          },
        ],
      }),
    ])
    const counts = async (month: string | null) =>
      (
        await db.query<{ username: string; matches: number }>(
          `select username, matches from public.ladder_month('hu-duplicate', null, null, 50${month ? `, '${month}'::date` : ''})`,
        )
      ).rows.map((r) => [r.username, r.matches])
    // This month: pl1 still has only its two matches from this month.
    expect(await counts(null)).toEqual([['pl1', 2]])
    // Last month (any day of it names the month): the new match is there,
    // for both players.
    expect(await counts(last)).toEqual([
      ['pl1', 2],
      ['pl7', 1],
      ['pl6', 1],
    ])
  })

  it('is read with the caller’s rights, by anyone; abandonment rate is public too', async () => {
    expect((await page('ladder', null, 3, 'anon')).length).toBe(3)
    expect((await page('ladder', null, 3, 'authenticated')).length).toBe(3)
    const { rows } = await as('anon', () =>
      db.query<{ rate: number }>(`select public.abandonment_rate($1) as rate`, [
        uid(5),
      ]),
    )
    expect(rows[0].rate).toBeCloseTo(0.1, 6)
  })
})

describe('the migration', () => {
  // Booting PGlite (initdb in WebAssembly) costs about 2 s of CPU, and
  // more while other suites boot theirs: fixture work, so it runs in a hook
  // like every suite's boot, not inside the test's 5 s.
  let early: PGlite
  beforeAll(async () => {
    early = new PGlite()
    await early.exec(SUPABASE_STUB)
  })
  afterAll(() => early.close())

  it('backfills when each earlier rated match was played, and history stays append-only', async () => {
    const files = migrationFiles()
    const ladder = files.findIndex((f) => f.endsWith('_ladder.sql'))
    for (const f of files.slice(0, ladder))
      await early.exec(readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'))
    const M = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    await early.exec(`
      insert into auth.users (id) values ('${uid(1)}');
      insert into public.matches (id, kind, status, config, finished_at)
        values ('${M}', 'hu-rated', 'finished', '{}', '2026-09-30 23:59:00+00');
      insert into public.rating_history (user_id, format, kind, match_id, outcome,
          before_rating, before_rd, before_sigma, after_rating, after_rd, after_sigma, model_version, created_at)
        values ('${uid(1)}', 'hu-duplicate', 'match', '${M}', 'win', 1500, 350, 0.06, 1600, 300, 0.06, 'glicko2.v1', '2026-10-01 00:02:00+00'),
               ('${uid(1)}', 'hu-duplicate', 'reset', null, null, 1600, 300, 0.06, 1500, 350, 0.06, 'glicko2.v1', '2026-10-05 10:00:00+00');
    `)
    for (const f of files.slice(ladder))
      await early.exec(readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'))
    const { rows } = await early.query<{ kind: string; at: string }>(
      `select kind, to_char(played_at at time zone 'utc', 'YYYY-MM-DD HH24:MI') at
       from public.rating_history order by id`,
    )
    expect(rows).toEqual([
      { kind: 'match', at: '2026-09-30 23:59' },
      { kind: 'reset', at: '2026-10-05 10:00' },
    ])
    await expect(
      early.query(`update public.rating_history set played_at = now()`),
    ).rejects.toThrow(/append-only/)
  })
})
