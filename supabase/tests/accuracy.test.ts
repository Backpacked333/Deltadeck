// @vitest-environment node
// Accuracy on the profile (P1-10): the plain mean of a player's latest 500
// graded decisions from matches that are over, with the grade distribution
// over the same decisions, kept in public.accuracy. Everyone reads the
// aggregate (it is the second number on every profile); nobody but the
// server writes it, and the raw grades stay readable by the match's two
// players only. A match in play never moves the number, so it cannot leak a
// live grade. The luck series for the chart reads public hands.
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrationFiles, MIGRATIONS_DIR, SUPABASE_STUB } from './harness'

const ALICE = '11111111-1111-4111-8111-111111111111'
const BOB = '22222222-2222-4222-8222-222222222222'
const CAROL = '44444444-4444-4444-8444-444444444444'
const OLD = '55555555-5555-4555-8555-555555555555'
const LIVE = '66666666-6666-4666-8666-666666666666'
const LATE = '77777777-7777-4777-8777-777777777777'

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

type Row = {
  accuracy: number | null
  graded: number
  best: number
  good: number
  inaccuracy: number
  mistake: number
  blunder: number
}
const aggregate = (role = 'service_role', sub = '', user = ALICE) =>
  as(
    role,
    sub,
    async () =>
      (
        await db.query<Row>(
          `select accuracy, graded, best, good, inaccuracy, mistake, blunder
           from public.accuracy where user_id = $1 and format = 'hu-duplicate'`,
          [user],
        )
      ).rows[0] ?? null,
  )

/** A rated match between Alice (seat 0) and Bob, with `hands` verified hands. */
async function match(id: string, status: string, hands: number) {
  await db.query(
    `insert into public.matches (id, kind, status, config) values ($1, 'hu-rated', 'playing', '{}')`,
    [id],
  )
  await db.query(
    `insert into public.match_players (match_id, user_id, seat) values ($1, $2, 0), ($1, $3, 1)`,
    [id, ALICE, BOB],
  )
  for (let n = 1; n <= hands; n++)
    await db.query(
      `insert into public.hands (id, match_id, hand_no, button, commitment, leaves, reveal, record, verified)
       values ($1::text || ':' || $2::int, $1::uuid, $2::int, 0, repeat('a', 64), decode(repeat('00', 1664), 'hex'), '[]',
               jsonb_build_object('netBySeat', jsonb_build_object('0', $2::int * 10, '1', -$2::int * 10),
                                  'luck', jsonb_build_object('adjustedBySeat', jsonb_build_object('0', $2::int * 5, '1', -$2::int * 5))),
               true)`,
      [id, n],
    )
  if (status !== 'playing')
    await db.query(`update public.matches set status = $2 where id = $1`, [
      id,
      status,
    ])
}

/** Alice's grades, written the way the consumer writes them. */
const grade = (
  handId: string,
  grades: { idx: number; grade: string; accuracy: number }[],
) =>
  as('service_role', '', () =>
    db.query('select public.record_grades($1::jsonb)', [
      JSON.stringify({
        handId,
        format: 'hu-duplicate',
        modelVersion: 'grade.v1+population.v1',
        grades: grades.map((g) => ({
          seat: 0,
          evLost: (100 - g.accuracy) / 10,
          pot: 20,
          ...g,
        })),
      }),
    ]),
  )

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

describe('accuracy', () => {
  it('is not graded yet for a player with no graded decision', async () => {
    expect(await aggregate()).toBeNull()
  })

  it('counts a match only once it is over, refreshed when it finishes', async () => {
    await match(LIVE, 'playing', 1)
    await grade(`${LIVE}:1`, [
      { idx: 0, grade: 'best', accuracy: 100 },
      { idx: 2, grade: 'blunder', accuracy: 0 },
    ])
    // Grades of a match in play move nothing (they would leak a live grade).
    expect(await aggregate()).toBeNull()
    await db.query(
      `update public.matches set status = 'finished' where id = '${LIVE}'`,
    )
    expect(await aggregate()).toEqual({
      accuracy: 50,
      graded: 2,
      best: 1,
      good: 0,
      inaccuracy: 0,
      mistake: 0,
      blunder: 1,
    })
  })

  it('takes in grades that land after the match is over', async () => {
    await match(LATE, 'finished', 1)
    await grade(`${LATE}:1`, [{ idx: 0, grade: 'good', accuracy: 80 }])
    expect(await aggregate()).toMatchObject({
      accuracy: (100 + 0 + 80) / 3,
      graded: 3,
      good: 1,
    })
  })

  it('averages exactly the latest 500 graded decisions', async () => {
    // 510 decisions at 0 from a hand played a day earlier; the three above
    // stay the newest.
    await match(OLD, 'finished', 1)
    await db.exec(
      `update public.matches set played_at = now() - interval '1 day' where id = '${OLD}'`,
    )
    await db.exec(`
      insert into public.hand_grades (hand_id, seat, idx, user_id, format, grade, ev_lost, accuracy, pot, model_version, created_at)
      select '${OLD}:1', 0, i, '${ALICE}', 'hu-duplicate', 'blunder', 10, 0, 20, 'x', now() - interval '1 day' - i * interval '1 second'
      from generate_series(0, 509) i;
    `)
    // (Inserted directly, so refreshed directly; the consumer's path is above.)
    await db.query(`select private.refresh_accuracy($1, 'hu-duplicate')`, [
      ALICE,
    ])
    const row = (await aggregate())!
    expect(row.graded).toBe(500)
    // The three newest (100, 0, 80) and 497 of the 510 at 0.
    expect(row.accuracy).toBeCloseTo(180 / 500, 5)
    expect(row.blunder).toBe(498)
  })

  it('keeps the window in the order the hands were played: an old hand graded late displaces nothing', async () => {
    const before = await aggregate()
    // A hand from two days ago, graded only now (a retry), all Best.
    const STALE = '99999999-9999-4999-8999-999999999999'
    await match(STALE, 'finished', 1)
    await db.exec(
      `update public.matches set played_at = now() - interval '2 days' where id = '${STALE}'`,
    )
    await grade(`${STALE}:1`, [
      { idx: 0, grade: 'best', accuracy: 100 },
      { idx: 2, grade: 'best', accuracy: 100 },
    ])
    // Still the three newest and 497 of yesterday's: the old hand is outside.
    expect(await aggregate()).toEqual(before)
  })

  it('is public: anon and any player read the same aggregate, while the raw grades stay hidden from them', async () => {
    const stored = await aggregate()
    expect(await aggregate('anon', '')).toEqual(stored)
    expect(await aggregate('authenticated', CAROL)).toEqual(stored)
    const raw = (role: string, sub: string) =>
      as(
        role,
        sub,
        async () =>
          (
            await db.query(
              `select 1 from public.hand_grades where user_id = $1`,
              [ALICE],
            )
          ).rows.length,
      )
    expect(await raw('authenticated', CAROL)).toBe(0)
    await expect(raw('anon', '')).rejects.toThrow(/permission denied/)
  })

  it('only the server writes it, and browsers cannot run the refresh', async () => {
    for (const [role, sub] of [
      ['anon', ''],
      ['authenticated', ALICE],
    ]) {
      await expect(
        as(role, sub, () =>
          db.query(
            `update public.accuracy set accuracy = 100 where user_id = $1`,
            [ALICE],
          ),
        ),
      ).rejects.toThrow(/permission denied/)
      await expect(
        as(role, sub, () =>
          db.query(`select private.refresh_accuracy($1, 'hu-duplicate')`, [
            ALICE,
          ]),
        ),
      ).rejects.toThrow(/permission denied/)
    }
  })
})

describe('the luck series', () => {
  it("gives each hand of the player's rated matches that are over: their net and the net with all-in luck taken out", async () => {
    const rows = await as(
      'anon',
      '',
      async () =>
        (
          await db.query<{
            match_id: string
            hand_no: number
            net: number
            adjusted: number
          }>(`select * from public.rated_luck($1)`, [BOB])
        ).rows,
    )
    // LIVE, LATE, OLD and STALE are over; each has hand 1 (net −10,
    // adjusted −5 for Bob in seat 1), oldest hand first.
    expect(rows).toHaveLength(4)
    for (const r of rows)
      expect([r.hand_no, r.net, r.adjusted]).toEqual([1, -10, -5])
    expect(
      (await db.query(`select * from public.rated_luck($1)`, [CAROL])).rows,
    ).toEqual([])
  })

  it('leaves out a match still in play', async () => {
    const PLAYING = '88888888-8888-4888-8888-888888888888'
    await match(PLAYING, 'playing', 2)
    const rows = (
      await db.query<{ match_id: string }>(
        `select match_id from public.rated_luck($1)`,
        [ALICE],
      )
    ).rows
    expect(rows.map((r) => r.match_id)).not.toContain(PLAYING)
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

  it('counts grades written before it, so nobody graded reads "Not graded yet"', async () => {
    const files = migrationFiles()
    const accuracy = files.findIndex((f) => f.endsWith('_accuracy.sql'))
    for (const f of files.slice(0, accuracy))
      await early.exec(readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'))
    const M = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    await early.exec(`
      insert into auth.users (id) values ('${ALICE}'), ('${BOB}');
      insert into public.matches (id, kind, status, config) values ('${M}', 'hu-rated', 'finished', '{}');
      insert into public.match_players (match_id, user_id, seat) values ('${M}', '${ALICE}', 0), ('${M}', '${BOB}', 1);
      insert into public.hands (id, match_id, hand_no, button, commitment, leaves, reveal, record, verified)
        values ('${M}:1', '${M}', 1, 0, repeat('a', 64), decode(repeat('00', 1664), 'hex'), '[]', '{}', true);
      insert into public.hand_grades (hand_id, seat, idx, user_id, format, grade, ev_lost, accuracy, pot, model_version)
        values ('${M}:1', 0, 0, '${ALICE}', 'hu-duplicate', 'good', 1, 90, 20, 'x');
    `)
    for (const f of files.slice(accuracy))
      await early.exec(readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'))
    const { rows } = await early.query(
      `select user_id, accuracy, graded, good from public.accuracy`,
    )
    expect(rows).toEqual([{ user_id: ALICE, accuracy: 90, graded: 1, good: 1 }])
  })
})
