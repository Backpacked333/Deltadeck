// @vitest-environment node
// Applies supabase/migrations to an in-process Postgres (PGlite) with a stub of
// Supabase's auth schema and API roles, then checks the access rules as the
// browser (anon / authenticated) and the table server (service_role) see them.
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrationFiles, MIGRATIONS_DIR, SUPABASE_STUB } from './harness'

const dir = MIGRATIONS_DIR
// The learning_cloud migration (an earlier app version's tables, kept in the
// repo so it matches the live migration history) is applied and checked in
// rls-matrix.test.ts; this suite is about the multiplayer migrations.
const MIGRATIONS = migrationFiles().filter(
  (f) => !f.startsWith('20261007192620_learning_cloud'),
)

const ALICE = '11111111-1111-4111-8111-111111111111'
const BOB = '22222222-2222-4222-8222-222222222222'
const EARLY = '00000000-0000-4000-8000-000000000000'
const MATCH = '33333333-3333-4333-8333-333333333333'

let db: PGlite

async function as<T = Record<string, unknown>>(
  role: 'anon' | 'authenticated' | 'service_role',
  sql: string,
  user?: string,
) {
  await db.exec(
    `reset role; select set_config('request.jwt.claim.sub', '${user ?? ''}', false);`,
  )
  await db.exec(`set role ${role}`)
  try {
    return (await db.query<T>(sql)).rows
  } finally {
    await db.exec('reset role')
  }
}

const denied = (p: Promise<unknown>) =>
  expect(p).rejects.toThrow(/permission denied|row-level security/)

function handPayload(id = `${MATCH}:1`) {
  return {
    id,
    matchId: MATCH,
    handNo: 1,
    segment: 1,
    button: 0,
    commitment: 'a'.repeat(64),
    leaves: Buffer.alloc(52 * 32, 7).toString('base64'),
    reveal: [{ slot: 4, card: 12, salt: '00'.repeat(16) }],
    record: { v: 1 },
    deck: Array.from({ length: 52 }, (_, i) => i),
    secret: Buffer.alloc(32, 1).toString('base64'),
    holes: { 0: [0, 1], 1: [2, 3] },
    holesByUser: [
      { userId: ALICE, cards: [0, 1] },
      { userId: BOB, cards: [2, 3] },
    ],
    netByUser: { [ALICE]: 40, [BOB]: -40 },
  }
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(SUPABASE_STUB)
  // An account created before the migrations: the backfill must cover it.
  await db.query('insert into auth.users (id) values ($1)', [EARLY])
  for (const file of MIGRATIONS)
    await db.exec(readFileSync(new URL(file, dir), 'utf8'))
  await db.query('insert into auth.users (id) values ($1), ($2)', [ALICE, BOB])
  await db.query(
    `insert into public.matches (id, config) values ($1, '{}');
     `,
    [MATCH],
  )
  await db.query(
    'insert into public.match_players (match_id, user_id, seat) values ($1, $2, 0), ($1, $3, 1)',
    [MATCH, ALICE, BOB],
  )
}, 60_000)

afterAll(() => db?.close())

describe('migrations', () => {
  it('apply in order', () => {
    expect(MIGRATIONS).toEqual([
      '20261008133809_players.sql',
      '20261008134201_matches_hands.sql',
      '20261008134322_record_hand.sql',
      '20261008134345_abandonments_match_index.sql',
      '20261008173914_record_match.sql',
      '20261008181317_record_match_no_show.sql',
      '20261009213919_verify_hand.sql',
      '20261009213923_hands_created_index.sql',
      '20261010010000_rated_matches.sql',
      '20261010043000_rematch.sql',
      '20261010053000_hand_grades.sql',
      '20261010060000_hand_grades_pot.sql',
      '20261010070000_accuracy.sql',
      '20261010080000_ratings.sql',
      '20261010090000_ladder.sql',
      '20261010100000_hands_after_match.sql',
      '20261010110000_landing.sql',
      '20261010120000_school_email.sql',
      '20261010130000_six_casual.sql',
    ])
  })
})

describe('players', () => {
  it('get a placeholder name on sign-up, and existing accounts are backfilled', async () => {
    const rows = await as<{ user_id: string; username: string }>(
      'anon',
      'select user_id, username from public.players order by user_id',
    )
    expect(rows.map((r) => r.user_id)).toEqual([EARLY, ALICE, BOB])
    expect(rows[1].username).toBe('player_111111111111')
  })

  it('are public to read but not writable by anon', async () => {
    await denied(as('anon', `update public.players set bio = 'x'`))
    await denied(
      as(
        'anon',
        `insert into public.players (user_id, username) values ('${ALICE}', 'zed')`,
      ),
    )
  })

  it('can rename themselves, and nobody else', async () => {
    await as(
      'authenticated',
      `update public.players set username = 'alice' where user_id = '${ALICE}'`,
      ALICE,
    )
    // RLS hides other rows from the update, so this changes nothing.
    await as(
      'authenticated',
      `update public.players set username = 'mallory' where user_id = '${BOB}'`,
      ALICE,
    )
    const names = await as<{ username: string }>(
      'anon',
      'select username from public.players order by user_id',
    )
    expect(names.map((r) => r.username)).toEqual([
      'player_000000000000',
      'alice',
      'player_222222222222',
    ])
  })

  it('cannot change identity columns or delete rows', async () => {
    await denied(
      as(
        'authenticated',
        `update public.players set user_id = '${BOB}'`,
        ALICE,
      ),
    )
    await denied(
      as(
        'authenticated',
        `update public.players set created_at = now()`,
        ALICE,
      ),
    )
    await denied(as('authenticated', `delete from public.players`, ALICE))
  })

  it('rejects bad, reserved and duplicate usernames', async () => {
    for (const name of [
      'Al',
      'has space',
      'UPPER',
      'x'.repeat(21),
      'atlas',
      'admin',
    ])
      await expect(
        as(
          'authenticated',
          `update public.players set username = '${name}' where user_id = '${ALICE}'`,
          ALICE,
        ),
      ).rejects.toThrow(/check constraint/)
    await as(
      'authenticated',
      `update public.players set username = 'bob' where user_id = '${BOB}'`,
      BOB,
    )
    await expect(
      as(
        'authenticated',
        `update public.players set username = 'bob' where user_id = '${ALICE}'`,
        ALICE,
      ),
    ).rejects.toThrow(/unique/)
  })
})

describe('hand records', () => {
  it('can only be written through record_hand by the service role', async () => {
    const payload = JSON.stringify(handPayload()).replace(/'/g, "''")
    await denied(
      as(
        'authenticated',
        `select public.record_hand('${payload}'::jsonb)`,
        ALICE,
      ),
    )
    await denied(as('anon', `select public.record_hand('${payload}'::jsonb)`))
    await denied(
      as(
        'authenticated',
        `insert into public.hands (id, match_id, hand_no, button, commitment, leaves, reveal, record)
        values ('${MATCH}:9', '${MATCH}', 9, 0, '${'a'.repeat(64)}', '\\x00', '[]', '{}')`,
        ALICE,
      ),
    )
    await as('service_role', `select public.record_hand('${payload}'::jsonb)`)
    // Idempotent: an outbox retry changes nothing.
    await as('service_role', `select public.record_hand('${payload}'::jsonb)`)
    // Archived once, and not public while its match is still in play
    // (hands-live.test.ts); readable by anyone once the match is over.
    expect((await db.query('select id from public.hands')).rows).toEqual([
      { id: `${MATCH}:1` },
    ])
    expect(await as('anon', 'select id from public.hands')).toEqual([])
    const status = (
      await db.query<{ status: string }>(
        `select status from public.matches where id = '${MATCH}'`,
      )
    ).rows[0].status
    await db.exec(
      `update public.matches set status = 'finished' where id = '${MATCH}'`,
    )
    const hands = await as<{ id: string }>(
      'anon',
      'select id from public.hands',
    )
    expect(hands).toEqual([{ id: `${MATCH}:1` }])
    await db.query(`update public.matches set status = $1 where id = $2`, [
      status,
      MATCH,
    ])
    const nets = await as<{ net_chips: number }>(
      'anon',
      'select net_chips from public.match_players order by seat',
    )
    expect(nets.map((r) => r.net_chips)).toEqual([40, -40])
  })

  it('keep the deck and every hole card private', async () => {
    await denied(as('anon', 'select * from public.hands_private'))
    await denied(
      as('authenticated', 'select * from public.hands_private', ALICE),
    )
    await denied(as('authenticated', 'select * from public.incidents', ALICE))
    const own = await as<{ cards: number[] }>(
      'authenticated',
      'select cards from public.hand_holes',
      ALICE,
    )
    expect(own).toEqual([{ cards: [0, 1] }])
    await denied(as('anon', 'select * from public.hand_holes'))
    const audit = await as<{ n: number }>(
      'service_role',
      'select count(*)::int as n from public.hands_private',
    )
    expect(audit).toEqual([{ n: 1 }])
  })

  it('are counted per UTC day from an index, not by reading every hand', async () => {
    // The query /api/stats sends through PostgREST (worker/src/stats.ts),
    // as the anon role it uses. Seq scans are priced out so the plan shows
    // whether an index can answer it; on a few rows the planner would scan.
    await db.exec('set enable_seqscan = off')
    try {
      for (const verified of ['', 'and verified is true']) {
        const plan = await as<{ 'QUERY PLAN': string }>(
          'anon',
          `explain (costs off) select count(*) from public.hands
           where created_at >= '2026-10-09T00:00:00Z'
             and created_at < '2026-10-10T00:00:00Z' ${verified}`,
        )
        // Index-only or bitmap depends on the visibility map (vacuum), not
        // on the schema; either reads one day's index entries.
        const text = plan.map((r) => r['QUERY PLAN']).join('\n')
        expect(text).toMatch(/Index (Only )?Scan (using|on) hands_created/)
        expect(text).not.toMatch(/Seq Scan/)
      }
    } finally {
      await db.exec('reset enable_seqscan')
    }
  })

  it('reject malformed records', async () => {
    const bad = { ...handPayload(`${MATCH}:2`), commitment: 'nothex' }
    await expect(
      as(
        'service_role',
        `select public.record_hand('${JSON.stringify(bad)}'::jsonb)`,
      ),
    ).rejects.toThrow(/check constraint/)
  })
})

describe('match records', () => {
  const GAME = '44444444-4444-4444-8444-444444444444'
  const start = {
    id: GAME,
    kind: 'hu-casual',
    config: { handsTotal: 20 },
    players: [
      { seat: 0, userId: ALICE },
      { seat: 1, userId: BOB },
    ],
  }
  const end = {
    ...start,
    handNo: 7,
    timeouts: { 1: 3 },
    result: { netBySeat: { 0: 120, 1: -120 }, reason: 'forfeit', forfeit: 1 },
  }
  const call = (p: object) =>
    `select public.record_match('${JSON.stringify(p)}'::jsonb)`

  it('are written only by the service role', async () => {
    await denied(as('authenticated', call(start), ALICE))
    await denied(as('anon', call(start)))
  })

  it('create the match and seats once, then finish it once', async () => {
    await as('service_role', call(start))
    await as('service_role', call(start))
    const seats = await as<{ user_id: string }>(
      'anon',
      `select user_id from public.match_players where match_id = '${GAME}' order by seat`,
    )
    expect(seats.map((r) => r.user_id)).toEqual([ALICE, BOB])
    // A hand can now be recorded against it.
    await as(
      'service_role',
      `select public.record_hand('${JSON.stringify({ ...handPayload(`${GAME}:1`), matchId: GAME })}'::jsonb)`,
    )

    await as('service_role', call(end))
    await as('service_role', call(end)) // an outbox retry
    const [match] = await as<{ status: string; result: { reason: string } }>(
      'anon',
      `select status, result from public.matches where id = '${GAME}'`,
    )
    expect(match.status).toBe('finished')
    expect(match.result.reason).toBe('forfeit')
    const players = await as<{ timeouts: number; abandoned: boolean }>(
      'anon',
      `select timeouts, abandoned from public.match_players where match_id = '${GAME}' order by seat`,
    )
    expect(players).toEqual([
      { timeouts: 0, abandoned: false },
      { timeouts: 3, abandoned: true },
    ])
    const left = await as<{ user_id: string; kind: string; hand_no: number }>(
      'anon',
      `select user_id, kind, hand_no from public.abandonments where match_id = '${GAME}'`,
    )
    expect(left).toEqual([{ user_id: BOB, kind: 'timeout_x3', hand_no: 7 }])
  })

  it('can be finished by a call that also creates it', async () => {
    const other = '55555555-5555-4555-8555-555555555555'
    await as(
      'service_role',
      call({
        ...end,
        id: other,
        result: { netBySeat: {}, reason: 'complete' },
      }),
    )
    const [row] = await as<{ status: string }>(
      'anon',
      `select status from public.matches where id = '${other}'`,
    )
    expect(row.status).toBe('finished')
  })
})

describe('no-shows', () => {
  it('void the match and record each absent seat once', async () => {
    const id = '66666666-6666-4666-8666-666666666666'
    const p = {
      id,
      kind: 'hu-casual',
      config: {},
      players: [
        { seat: 0, userId: ALICE },
        { seat: 1, userId: BOB },
      ],
      handNo: 0,
      timeouts: { 0: 0, 1: 0 },
      result: { netBySeat: { 0: 0, 1: 0 }, reason: 'no_show', noShow: [1] },
    }
    const call = `select public.record_match('${JSON.stringify(p)}'::jsonb)`
    await as('service_role', call)
    await as('service_role', call)
    const [match] = await as<{ status: string }>(
      'anon',
      `select status from public.matches where id = '${id}'`,
    )
    expect(match.status).toBe('void')
    const seats = await as<{ abandoned: boolean }>(
      'anon',
      `select abandoned from public.match_players where match_id = '${id}' order by seat`,
    )
    expect(seats.map((s) => s.abandoned)).toEqual([false, true])
    const left = await as<{ user_id: string; kind: string }>(
      'anon',
      `select user_id, kind from public.abandonments where match_id = '${id}'`,
    )
    expect(left).toEqual([{ user_id: BOB, kind: 'no_show' }])
  })
})
