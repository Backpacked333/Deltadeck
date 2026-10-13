// @vitest-environment node
// The rating gate (audit F07): apply_rating moves a rating only on a result
// its own verified hands support. Evidence still on its way is 55000 (the
// table's outbox retries); evidence that cannot arrive or contradicts the
// result is 23514 (the call is parked with an incident, never rated). The
// verifier's side, recomputing each rated hand's luck, is in
// worker/test/verify.test.ts.
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DRAW_BAND_BB } from '../../src/rating/rules'
import { outcomes } from '../../worker/src/rated'
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
const players = [
  { seat: 0, userId: ALICE },
  { seat: 1, userId: BOB },
]

let db: PGlite
let next = 0
const newMatch = () =>
  `5e000000-0000-4000-8000-${String(++next).padStart(12, '0')}`

async function service<T>(run: () => Promise<T>) {
  await db.exec('set role service_role')
  try {
    return await run()
  } finally {
    await db.exec('reset role')
  }
}
const call = (fn: string, p: object) =>
  service(() => db.query(`select public.${fn}($1::jsonb)`, [JSON.stringify(p)]))

type Result = {
  reason: 'complete' | 'forfeit'
  adjusted: number
  outcome0: 'win' | 'loss' | 'draw'
  forfeit?: 0 | 1
  handNo?: number
}
/** A rated match finished through record_match, as the table archives it. */
async function finished(id: string, r: Result, total = 40) {
  const start = {
    id,
    kind: 'hu-rated',
    config: { ...RATED_TEST_CONFIG, handsTotal: total },
    players,
  }
  await call('record_match', start)
  const other = { win: 'loss', loss: 'win', draw: 'draw' }[r.outcome0]
  await call('record_match', {
    ...start,
    handNo: r.handNo ?? total,
    timeouts: r.forfeit === undefined ? {} : { [r.forfeit]: 3 },
    result: {
      netBySeat: { 0: r.adjusted, 1: -r.adjusted },
      reason: r.reason,
      ...(r.forfeit === undefined ? {} : { forfeit: r.forfeit }),
      adjustedBySeat: { 0: r.adjusted, 1: -r.adjusted },
      outcomeBySeat: { 0: r.outcome0, 1: other },
    },
  })
}

const rate = (id: string, outcome0: string) =>
  call('apply_rating', {
    matchId: id,
    format: 'hu-duplicate',
    modelVersion: 'glicko2.v1',
    players: [
      { userId: ALICE, outcome: outcome0 },
      {
        userId: BOB,
        outcome: { win: 'loss', loss: 'win', draw: 'draw' }[outcome0],
      },
    ].map((p) => ({ ...p, version: 0, rating: 1500, rd: 300, sigma: 0.06 })),
  })

const rated = async (id: string) =>
  (
    await db.query('select 1 from public.rating_history where match_id = $1', [
      id,
    ])
  ).rows.length > 0

const incident = (id: string, kind: string, handNo: number | null) =>
  call('record_incident', { matchId: id, handNo, kind, detail: {} })

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

// Every probe below rates nobody, so each starts from version 0.
describe('a rating rests on verified evidence (audit F07)', () => {
  it('a complete match with its 40 verified hands is rated, once', async () => {
    const m = newMatch()
    await finished(m, { reason: 'complete', adjusted: 300, outcome0: 'win' })
    await seedRatedEvidence(db, m, players, shares(300))
    await rate(m, 'win')
    expect(await rated(m)).toBe(true)
    // A duplicate finalization returns the change it made and applies nothing.
    await expect(rate(m, 'win')).resolves.toBeDefined()
    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from public.rating_history where match_id = $1`,
      [m],
    )
    expect(rows[0].n).toBe(2)
    // Back to version 0 for the probes below.
    await db.exec(`
      alter table public.rating_history disable trigger rating_history_append_only;
      delete from public.rating_history;
      alter table public.rating_history enable trigger rating_history_append_only;
      update public.ratings set version = 0, matches = 0, wins = 0, draws = 0;
    `)
  })

  it('with no archived hand it waits (55000) and rates nothing', async () => {
    const m = newMatch()
    await finished(m, { reason: 'complete', adjusted: 300, outcome0: 'win' })
    await expect(rate(m, 'win')).rejects.toMatchObject({ code: '55000' })
    expect(await rated(m)).toBe(false)
  })

  it('waits while a hand is missing or unverified, and rates once it is in', async () => {
    const m = newMatch()
    await finished(m, { reason: 'complete', adjusted: 300, outcome0: 'win' })
    const each = shares(300)
    await seedRatedEvidence(db, m, players, each.slice(0, 39))
    await expect(rate(m, 'win')).rejects.toMatchObject({ code: '55000' })
    await seedRatedEvidence(
      db,
      m,
      players,
      each, // hands 1..39 exist already; hand 40 arrives unverified
      false,
    )
    await db.query(`update public.hands set verified = false where id = $1`, [
      `${m}:40`,
    ])
    await expect(rate(m, 'win')).rejects.toMatchObject({ code: '55000' })
    await db.query(`update public.hands set verified = true where id = $1`, [
      `${m}:40`,
    ])
    await rate(m, 'win')
    expect(await rated(m)).toBe(true)
    await db.exec(`
      alter table public.rating_history disable trigger rating_history_append_only;
      delete from public.rating_history;
      alter table public.rating_history enable trigger rating_history_append_only;
      update public.ratings set version = 0, matches = 0, wins = 0, draws = 0;
    `)
  })

  it.each([
    ['a hand that failed verification', 'verify_failed', 7],
    ['a hand parked by the table', 'archive_parked:hand', 7],
    ['a hand dead-lettered before it was verified', 'dlq', 7],
  ])('quarantines a match with %s (23514)', async (_, kind, handNo) => {
    const m = newMatch()
    await finished(m, { reason: 'complete', adjusted: 300, outcome0: 'win' })
    await seedRatedEvidence(db, m, players, shares(300))
    await db.query(`update public.hands set verified = false where id = $1`, [
      `${m}:${handNo}`,
    ])
    await incident(m, kind, handNo)
    await expect(rate(m, 'win')).rejects.toMatchObject({ code: '23514' })
    expect(await rated(m)).toBe(false)
  })

  it('a hand dead-lettered after it was verified (its grading failed) does not block', async () => {
    const m = newMatch()
    await finished(m, { reason: 'complete', adjusted: 300, outcome0: 'win' })
    await seedRatedEvidence(db, m, players, shares(300))
    await incident(m, 'dlq', 3)
    await rate(m, 'win')
    expect(await rated(m)).toBe(true)
    await db.exec(`
      alter table public.rating_history disable trigger rating_history_append_only;
      delete from public.rating_history;
      alter table public.rating_history enable trigger rating_history_append_only;
      update public.ratings set version = 0, matches = 0, wins = 0, draws = 0;
    `)
  })

  it.each([
    [
      'an altered luck adjustment',
      (m: string) =>
        db.query(
          `update public.hands set record = jsonb_set(record, '{luck,adjustedBySeat,0}', '200')
           where id = $1`,
          [`${m}:5`],
        ),
    ],
    [
      'a hand without its luck',
      (m: string) =>
        db.query(
          `update public.hands set record = record - 'luck' where id = $1`,
          [`${m}:5`],
        ),
    ],
    [
      'a hand naming another player',
      (m: string) =>
        db.query(
          `update public.hands set record = jsonb_set(record, '{seats,1,userId}', to_jsonb($2::text))
           where id = $1`,
          [`${m}:5`, CAROL],
        ),
    ],
    [
      'a hand beyond the match’s length',
      (m: string) => seedRatedEvidence(db, m, players, [...shares(300), 0]),
    ],
  ])('refuses %s (23514)', async (_, corrupt) => {
    const m = newMatch()
    await finished(m, { reason: 'complete', adjusted: 300, outcome0: 'win' })
    await seedRatedEvidence(db, m, players, shares(300))
    await corrupt(m)
    await expect(rate(m, 'win')).rejects.toMatchObject({ code: '23514' })
    expect(await rated(m)).toBe(false)
  })

  it('holds the outcome to the draw band, as the table decides it', async () => {
    const bb = RATED_TEST_CONFIG.blinds.bb
    expect(DRAW_BAND_BB).toBe(2)
    // A lead of exactly 2 bb is a draw; the table agrees (outcomes()).
    const edge = DRAW_BAND_BB * bb
    expect(outcomes({ 0: edge, 1: -edge }, bb)[0]).toBe('draw')
    expect(outcomes({ 0: edge + 1, 1: -edge - 1 }, bb)[0]).toBe('win')
    const draw = newMatch()
    await finished(draw, {
      reason: 'complete',
      adjusted: edge,
      outcome0: 'win',
    })
    await seedRatedEvidence(db, draw, players, shares(edge))
    await expect(rate(draw, 'win')).rejects.toMatchObject({ code: '23514' })
    const won = newMatch()
    await finished(won, {
      reason: 'complete',
      adjusted: edge + 1,
      outcome0: 'win',
    })
    await seedRatedEvidence(db, won, players, shares(edge + 1))
    await rate(won, 'win')
    expect(await rated(won)).toBe(true)
    await db.exec(`
      alter table public.rating_history disable trigger rating_history_append_only;
      delete from public.rating_history;
      alter table public.rating_history enable trigger rating_history_append_only;
      update public.ratings set version = 0, matches = 0, wins = 0, draws = 0;
    `)
  })

  it('a forfeit rests on the hands up to it, and the forfeiter loses', async () => {
    // Bob's third timeout came in hand 12 and did not end it: 11 hands.
    const m = newMatch()
    await finished(m, {
      reason: 'forfeit',
      adjusted: 110,
      outcome0: 'win',
      forfeit: 1,
      handNo: 12,
    })
    await seedRatedEvidence(db, m, players, shares(110, 10))
    await expect(rate(m, 'win')).rejects.toMatchObject({ code: '55000' })
    await seedRatedEvidence(db, m, players, [...shares(110, 10), 11])
    // Eleven hands now, but they add up to more than the result.
    await expect(rate(m, 'win')).rejects.toMatchObject({ code: '23514' })
    await db.query(`delete from public.hands where match_id = $1`, [m])
    await seedRatedEvidence(db, m, players, shares(110, 11))
    await rate(m, 'win')
    expect(await rated(m)).toBe(true)
  })
})
