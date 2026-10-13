// @vitest-environment node
// Ratings (P1-12): each finished rated match changes both players' Glicko-2
// ratings exactly once, in one transaction, with an append-only history.
// The Worker computes the new values (src/rating/glicko2.ts) and names the
// version it read; apply_rating checks it (compare-and-set), refuses a
// stale one, and answers a repeat with the change it already made.
// Abandonments of rated matches (forfeit, no-show, both gone) are counted
// once, for the ladder's < 10% rule.
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  migrationFiles,
  MIGRATIONS_DIR,
  RATED_TEST_CONFIG,
  seedRatedEvidence,
  shares,
  SUPABASE_STUB,
} from './harness'

const ALICE = '11111111-1111-4111-8111-111111111111'
const BOB = '22222222-2222-4222-8222-222222222222'
const CAROL = '44444444-4444-4444-8444-444444444444'

let db: PGlite

async function as<T>(role: string, sub: string, run: () => Promise<T>) {
  await db.exec(`set role ${role}`)
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [sub])
  try {
    return await run()
  } finally {
    await db.exec('reset role')
    await db.query(`select set_config('request.jwt.claim.sub', '', false)`)
  }
}

const service = <T>(run: () => Promise<T>) => as('service_role', '', run)

const recordMatch = (p: object) =>
  service(() =>
    db.query('select public.record_match($1::jsonb)', [JSON.stringify(p)]),
  )

const players = [
  { seat: 0, userId: ALICE },
  { seat: 1, userId: BOB },
]

/**
 * A rated match between Alice (seat 0) and Bob, finished with `result`. A
 * complete one gets the verified hands its adjusted totals rest on (audit
 * F07; supabase/tests/rating-evidence.test.ts tests the gate itself).
 */
async function rated(
  id: string,
  result: { reason?: string; adjustedBySeat?: Record<number, number> } | null,
  pair = players,
) {
  const start = {
    id,
    kind: 'hu-rated',
    config: RATED_TEST_CONFIG,
    players: pair,
  }
  await recordMatch(start)
  if (!result) return
  await recordMatch({ ...start, handNo: 40, timeouts: {}, result })
  if (result.reason === 'complete' && result.adjustedBySeat)
    await seedRatedEvidence(db, id, pair, shares(result.adjustedBySeat[0]))
}

const win = (seat: 0 | 1) => ({
  netBySeat: { 0: seat === 0 ? 400 : -400, 1: seat === 0 ? -400 : 400 },
  reason: 'complete',
  adjustedBySeat: { 0: seat === 0 ? 300 : -300, 1: seat === 0 ? -300 : 300 },
  outcomeBySeat: seat === 0 ? { 0: 'win', 1: 'loss' } : { 0: 'loss', 1: 'win' },
})

type Row = {
  user_id: string
  rating: number
  rd: number
  matches: number
  wins: number
  draws: number
  abandoned: number
  version: number
}
const ratings = () =>
  service(
    async () =>
      (
        await db.query<Row>(
          `select user_id, rating, rd, matches, wins, draws, abandoned, version
           from public.ratings where format = 'hu-duplicate' order by user_id`,
        )
      ).rows,
  )
const history = (match: string) =>
  service(
    async () =>
      (
        await db.query<{ user_id: string; outcome: string }>(
          `select user_id, outcome from public.rating_history
           where match_id = $1 order by user_id`,
          [match],
        )
      ).rows,
  )

/** What the Worker sends: new values, computed from the version it read. */
const apply = (
  matchId: string,
  rows: { userId: string; outcome: string; version: number; rating: number }[],
  role = 'service_role',
) =>
  as(role, '', async () => {
    const { rows: out } = await db.query<{ apply_rating: unknown }>(
      'select public.apply_rating($1::jsonb)',
      [
        JSON.stringify({
          matchId,
          format: 'hu-duplicate',
          modelVersion: 'glicko2.v1',
          players: rows.map((r) => ({ rd: 300, sigma: 0.06, ...r })),
        }),
      ],
    )
    return out[0].apply_rating as {
      userId: string
      outcome: string
      before: { rating: number; rd: number }
      after: { rating: number; rd: number }
      matches: number
    }[]
  })

const M1 = '51000000-0000-4000-8000-000000000001'
const M2 = '51000000-0000-4000-8000-000000000002'

beforeAll(async () => {
  db = new PGlite()
  await db.exec(SUPABASE_STUB)
  for (const f of migrationFiles())
    await db.exec(readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'))
  await db.exec(
    `insert into auth.users (id) values ('${ALICE}'), ('${BOB}'), ('${CAROL}')`,
  )
}, 60_000)

afterAll(() => db?.close())

describe('apply_rating', () => {
  it('rates a finished match once, and answers a repeat with the same change', async () => {
    await rated(M1, win(0))
    const first = await apply(M1, [
      { userId: ALICE, outcome: 'win', version: 0, rating: 1662.3 },
      { userId: BOB, outcome: 'loss', version: 0, rating: 1337.7 },
    ])
    expect(first).toEqual([
      {
        userId: ALICE,
        outcome: 'win',
        before: { rating: 1500, rd: 350 },
        after: { rating: 1662.3, rd: 300 },
        matches: 1,
      },
      {
        userId: BOB,
        outcome: 'loss',
        before: { rating: 1500, rd: 350 },
        after: { rating: 1337.7, rd: 300 },
        matches: 1,
      },
    ])
    // An outbox retry after the first call had already committed: computed
    // from the new rows (version 1), it changes nothing and reports the same.
    const again = await apply(M1, [
      { userId: ALICE, outcome: 'win', version: 1, rating: 1700 },
      { userId: BOB, outcome: 'loss', version: 1, rating: 1300 },
    ])
    expect(again).toEqual(first)
    expect(await ratings()).toMatchObject([
      { user_id: ALICE, rating: 1662.3, matches: 1, wins: 1, version: 1 },
      { user_id: BOB, rating: 1337.7, matches: 1, wins: 0, version: 1 },
    ])
    expect(await history(M1)).toEqual([
      { user_id: ALICE, outcome: 'win' },
      { user_id: BOB, outcome: 'loss' },
    ])
  })

  it('refuses a stale version (40001) and writes nothing', async () => {
    await rated(M2, win(1))
    const before = await ratings()
    await expect(
      apply(M2, [
        { userId: ALICE, outcome: 'loss', version: 1, rating: 1600 },
        { userId: BOB, outcome: 'win', version: 0, rating: 1400 },
      ]),
    ).rejects.toMatchObject({ code: '40001' })
    expect(await ratings()).toEqual(before)
    expect(await history(M2)).toEqual([])
    // Recomputed from the current versions, it applies.
    await apply(M2, [
      { userId: ALICE, outcome: 'loss', version: 1, rating: 1600 },
      { userId: BOB, outcome: 'win', version: 1, rating: 1400 },
    ])
    expect(await ratings()).toMatchObject([
      { user_id: ALICE, matches: 2, wins: 1, version: 2 },
      { user_id: BOB, matches: 2, wins: 1, version: 2 },
    ])
  })

  it('refuses a match that is not finished yet (retry), and one that is not rated or names the wrong players or outcomes', async () => {
    const playing = '51000000-0000-4000-8000-000000000003'
    await rated(playing, null)
    await expect(
      apply(playing, [
        { userId: ALICE, outcome: 'win', version: 2, rating: 1 },
        { userId: BOB, outcome: 'loss', version: 2, rating: 1 },
      ]),
    ).rejects.toMatchObject({ code: 'P0002' })
    const casual = '51000000-0000-4000-8000-000000000004'
    await recordMatch({ id: casual, kind: 'hu-casual', config: {}, players })
    await recordMatch({
      id: casual,
      kind: 'hu-casual',
      config: {},
      players,
      handNo: 20,
      timeouts: {},
      result: { netBySeat: { 0: 10, 1: -10 }, reason: 'complete' },
    })
    await expect(
      apply(casual, [
        { userId: ALICE, outcome: 'win', version: 2, rating: 1 },
        { userId: BOB, outcome: 'loss', version: 2, rating: 1 },
      ]),
    ).rejects.toMatchObject({ code: '23514' })
    const m = '51000000-0000-4000-8000-000000000005'
    await rated(m, win(0))
    for (const wrong of [
      [
        { userId: ALICE, outcome: 'loss', version: 2, rating: 1 },
        { userId: BOB, outcome: 'win', version: 2, rating: 1 },
      ],
      [
        { userId: ALICE, outcome: 'win', version: 2, rating: 1 },
        { userId: CAROL, outcome: 'loss', version: 0, rating: 1 },
      ],
      [{ userId: ALICE, outcome: 'win', version: 2, rating: 1 }],
    ])
      await expect(apply(m, wrong)).rejects.toMatchObject({ code: '23514' })
    expect(await history(m)).toEqual([])
  })

  it('only the server applies a rating', async () => {
    const m = '51000000-0000-4000-8000-000000000006'
    await rated(m, win(0))
    for (const role of ['anon', 'authenticated'])
      await expect(
        apply(
          m,
          [
            { userId: ALICE, outcome: 'win', version: 2, rating: 1 },
            { userId: BOB, outcome: 'loss', version: 2, rating: 1 },
          ],
          role,
        ),
      ).rejects.toThrow(/permission denied/)
  })
})

describe('the last match', () => {
  it('is when the match was played, not when its rating applied, and never moves backwards', async () => {
    const DAN = '71111111-1111-4111-8111-111111111111'
    const EVE = '72222222-2222-4222-8222-222222222222'
    await db.exec(`insert into auth.users (id) values ('${DAN}'), ('${EVE}')`)
    const pair = [
      { seat: 0, userId: DAN },
      { seat: 1, userId: EVE },
    ]
    const finish = (id: string) => rated(id, win(0), pair)
    const applyAt = (id: string, version: number, finishedAt: string) =>
      service(() =>
        db.query('select public.apply_rating($1::jsonb)', [
          JSON.stringify({
            matchId: id,
            format: 'hu-duplicate',
            modelVersion: 'glicko2.v1',
            finishedAt,
            players: [
              {
                userId: DAN,
                outcome: 'win',
                version,
                rating: 1600,
                rd: 300,
                sigma: 0.06,
              },
              {
                userId: EVE,
                outcome: 'loss',
                version,
                rating: 1400,
                rd: 300,
                sigma: 0.06,
              },
            ],
          }),
        ]),
      )
    const last = async () =>
      (
        await db.query<{ at: string }>(
          `select to_char(last_match_at at time zone 'utc', 'YYYY-MM-DD') at
           from public.ratings where user_id = $1`,
          [DAN],
        )
      ).rows[0].at
    const jan = '53000000-0000-4000-8000-000000000001'
    const dec = '53000000-0000-4000-8000-000000000002'
    await finish(jan)
    await finish(dec)
    await applyAt(jan, 0, '2026-01-01T12:00:00Z')
    expect(await last()).toBe('2026-01-01')
    // Played earlier, rated later: the last match stays January's.
    await applyAt(dec, 1, '2025-12-01T12:00:00Z')
    expect(await last()).toBe('2026-01-01')
    // Each history row keeps when its match was played, for the month ladder.
    const played = await db.query<{ match_id: string; at: string }>(
      `select match_id, to_char(played_at at time zone 'utc', 'YYYY-MM-DD HH24:MI') at
       from public.rating_history where user_id = $1 order by id`,
      [DAN],
    )
    expect(played.rows).toEqual([
      { match_id: jan, at: '2026-01-01 12:00' },
      { match_id: dec, at: '2025-12-01 12:00' },
    ])
  })
})

describe('rating history', () => {
  it('refuses update, delete and truncate for every role, the server included', async () => {
    for (const role of ['service_role', 'authenticated', 'anon'])
      for (const statement of [
        `update public.rating_history set after_rating = 9999`,
        `delete from public.rating_history`,
        `truncate public.rating_history`,
      ])
        await expect(
          as(role, ALICE, () => db.query(statement)),
        ).rejects.toThrow(/append-only|permission denied/)
    // Not even the table owner.
    await expect(db.query(`delete from public.rating_history`)).rejects.toThrow(
      /append-only/,
    )
    expect(await history(M1)).toHaveLength(2)
  })

  it('and ratings are public reads: anyone sees both, nobody but the server writes', async () => {
    for (const [role, sub] of [
      ['anon', ''],
      ['authenticated', CAROL],
    ]) {
      const seen = await as(role, sub, async () => ({
        ratings: (await db.query('select 1 from public.ratings')).rows.length,
        history: (await db.query('select 1 from public.rating_history')).rows
          .length,
      }))
      expect(seen.ratings).toBeGreaterThanOrEqual(2)
      expect(seen.history).toBeGreaterThanOrEqual(4)
      await expect(
        as(role, sub, () =>
          db.query(`update public.ratings set rating = 3000`),
        ),
      ).rejects.toThrow(/permission denied/)
    }
  })
})

describe('abandonment', () => {
  it('counts a forfeit, a no-show and leaving a void match once each, and a retry never twice', async () => {
    const before = Object.fromEntries(
      (await ratings()).map((r) => [r.user_id, r.abandoned]),
    )
    const forfeit = '52000000-0000-4000-8000-000000000001'
    const forfeitResult = {
      netBySeat: { 0: -560, 1: 560 },
      reason: 'forfeit',
      forfeit: 1,
      adjustedBySeat: { 0: -560, 1: 560 },
      outcomeBySeat: { 0: 'win', 1: 'loss' },
    }
    await rated(forfeit, forfeitResult)
    await rated(forfeit, forfeitResult) // the outbox retries the finish
    const noShow = '52000000-0000-4000-8000-000000000002'
    await rated(noShow, {
      netBySeat: { 0: 0, 1: 0 },
      reason: 'no_show',
      noShow: [0],
      adjustedBySeat: { 0: 0, 1: 0 },
    })
    const bothGone = '52000000-0000-4000-8000-000000000003'
    await rated(bothGone, {
      netBySeat: { 0: 0, 1: 0 },
      reason: 'abandoned',
      abandoned: [0, 1],
      adjustedBySeat: { 0: 0, 1: 0 },
    })
    const after = Object.fromEntries(
      (await ratings()).map((r) => [r.user_id, r.abandoned]),
    )
    expect(after[ALICE] - before[ALICE]).toBe(2) // no-show, both gone
    expect(after[BOB] - before[BOB]).toBe(2) // forfeit, both gone
  })

  it('does not count a casual match', async () => {
    const before = await ratings()
    const casual = '52000000-0000-4000-8000-000000000004'
    const start = { id: casual, kind: 'hu-casual', config: {}, players }
    await recordMatch(start)
    await recordMatch({
      ...start,
      handNo: 3,
      timeouts: { 1: 3 },
      result: { netBySeat: { 0: 30, 1: -30 }, reason: 'forfeit', forfeit: 1 },
    })
    expect(await ratings()).toEqual(before)
  })
})
