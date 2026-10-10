// @vitest-environment node
// Casual 6-max sessions in the archive (P2-03; ADR amendment 2026-10-10,
// "Players in the archive"). A six table's session is one matches row whose
// players change while it plays: people sit down after hand 1, stand up, sit
// again in another seat, and a freed seat goes to someone else. So
// match_players is keyed by account, not seat: record_hand gives every
// account dealt into a hand its row, at the seat it held in that hand,
// before adding the net, and record_match does the same on every call.
// Nothing here is rated, and a session in play stays hidden from clients.
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrationFiles, MIGRATIONS_DIR, SUPABASE_STUB } from './harness'

const ALICE = '11111111-1111-4111-8111-111111111111'
const BOB = '22222222-2222-4222-8222-222222222222'
const CAROL = '33333333-3333-4333-8333-333333333333'
const DAVE = '44444444-4444-4444-8444-444444444444'
const NAMES: Record<string, string> = {
  [ALICE]: 'alice',
  [BOB]: 'bob',
  [CAROL]: 'carol',
  [DAVE]: 'dave',
}

let db: PGlite

/** One archive call the way PostgREST sends it: one statement, service role. */
async function call(
  fn: 'record_match' | 'record_hand' | 'apply_rating',
  p: object,
) {
  await db.exec('set role service_role')
  try {
    await db.query(`select public.${fn}($1::jsonb)`, [JSON.stringify(p)])
  } finally {
    await db.exec('reset role')
  }
}

/** Rows `sql` returns to a client role (`sub` signed in, or anon). */
async function seen(role: 'anon' | 'authenticated', sub: string, sql: string) {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
      sub,
    ])
    await tx.exec(`set local role ${role}`)
    return (await tx.query<Record<string, unknown>>(sql)).rows
  })
}

/** Who sits where (seat → account), at a record_match call or in a hand. */
type Seats = Record<number, string>
const entries = (seats: Seats) =>
  Object.entries(seats).map(([seat, userId]) => ({ seat: +seat, userId }))

const session = (id: string, seats: Seats) => ({
  id,
  kind: 'six-casual',
  config: {
    kind: 'six-casual',
    maxSeats: 6,
    startingStack: 2000,
    blinds: { sb: 10, bb: 20 },
  },
  players: entries(seats),
})

/** Hand `handNo` of a session: who was dealt in at which seat, and their nets. */
function hand(
  matchId: string,
  handNo: number,
  seats: Seats,
  netByUser: Record<string, number>,
) {
  const dealt = entries(seats)
  const cards = (i: number) => [2 * i, 2 * i + 1]
  return {
    id: `${matchId}:${handNo}`,
    matchId,
    handNo,
    segment: 1,
    button: dealt[0].seat,
    commitment: 'a'.repeat(64),
    leaves: Buffer.alloc(52 * 32, 7).toString('base64'),
    reveal: [],
    record: {
      v: 1,
      matchId,
      handNo,
      seats: dealt.map((s) => ({ ...s, username: NAMES[s.userId] })),
    },
    deck: Array.from({ length: 52 }, (_, i) => i),
    secret: Buffer.alloc(32, 1).toString('base64'),
    holes: Object.fromEntries(dealt.map((s, i) => [s.seat, cards(i)])),
    holesByUser: dealt.map((s, i) => ({ userId: s.userId, cards: cards(i) })),
    netByUser,
  }
}

/** The session's players, one row per account. */
const players = async (matchId: string) =>
  (
    await db.query<{ user_id: string; seat: number; net_chips: number }>(
      `select user_id, seat, net_chips from public.match_players
       where match_id = $1 order by user_id`,
      [matchId],
    )
  ).rows

const handsOf = (m: string) =>
  `select id from public.hands where match_id = '${m}' order by hand_no`

beforeAll(async () => {
  db = new PGlite()
  await db.exec(SUPABASE_STUB)
  for (const f of migrationFiles())
    await db.exec(readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'))
  await db.exec(
    `insert into auth.users (id) values ('${ALICE}'), ('${BOB}'), ('${CAROL}'), ('${DAVE}')`,
  )
}, 60_000)

afterAll(() => db?.close())

describe('a six-casual session', () => {
  it('record_match adds a player who joins after hand 1', async () => {
    const S = 'cccccccc-0000-4000-8000-000000000001'
    await call('record_match', session(S, { 0: ALICE, 1: BOB }))
    await call(
      'record_hand',
      hand(S, 1, { 0: ALICE, 1: BOB }, { [ALICE]: 20, [BOB]: -20 }),
    )
    // Carol sat down in seat 3 after hand 1 and Bob moved to seat 4; the
    // next call names everyone where they sit now.
    await call('record_match', session(S, { 0: ALICE, 3: CAROL, 4: BOB }))
    expect(await players(S)).toEqual([
      { user_id: ALICE, seat: 0, net_chips: 20 },
      { user_id: BOB, seat: 4, net_chips: -20 },
      { user_id: CAROL, seat: 3, net_chips: 0 },
    ])
  })

  it('record_hand credits net to a late joiner', async () => {
    const S = 'cccccccc-0000-4000-8000-000000000002'
    await call('record_match', session(S, { 0: ALICE, 1: BOB }))
    await call(
      'record_hand',
      hand(S, 1, { 0: ALICE, 1: BOB }, { [ALICE]: 30, [BOB]: -30 }),
    )
    // Carol sat down in seat 2 after hand 1. No record_match names her: her
    // first archive call is the hand she was dealt into.
    const second = hand(
      S,
      2,
      { 0: ALICE, 1: BOB, 2: CAROL },
      { [ALICE]: -20, [BOB]: -20, [CAROL]: 40 },
    )
    await call('record_hand', second)
    await call('record_hand', second) // an outbox retry adds nothing
    expect(await players(S)).toEqual([
      { user_id: ALICE, seat: 0, net_chips: 10 }, // 30 - 20
      { user_id: BOB, seat: 1, net_chips: -50 }, // -30 - 20
      { user_id: CAROL, seat: 2, net_chips: 40 },
    ])
  })

  it('one session archives two accounts that used the same seat', async () => {
    const S = 'cccccccc-0000-4000-8000-000000000003'
    await call('record_match', session(S, { 0: ALICE, 1: BOB }))
    await call(
      'record_hand',
      hand(S, 1, { 0: ALICE, 1: BOB }, { [ALICE]: 50, [BOB]: -50 }),
    )
    // Bob stood up after hand 1 and Dave took seat 1.
    await call(
      'record_hand',
      hand(S, 2, { 0: ALICE, 1: DAVE }, { [ALICE]: -25, [DAVE]: 25 }),
    )
    expect(await players(S)).toEqual([
      { user_id: ALICE, seat: 0, net_chips: 25 }, // 50 - 25
      { user_id: BOB, seat: 1, net_chips: -50 },
      { user_id: DAVE, seat: 1, net_chips: 25 },
    ])
    // Who held seat 1 in a hand is read from that hand, never from
    // match_players.seat: Bob in hand 1, Dave in hand 2, each with his own
    // hole cards.
    const { rows } = await db.query<{ hand_no: number; user_id: string }>(
      `select h.hand_no, s ->> 'userId' as user_id
       from public.hands h, jsonb_array_elements(h.record -> 'seats') s
       where h.match_id = $1 and (s ->> 'seat')::int = 1 order by h.hand_no`,
      [S],
    )
    expect(rows).toEqual([
      { hand_no: 1, user_id: BOB },
      { hand_no: 2, user_id: DAVE },
    ])
    for (const [user, id] of [
      [BOB, `${S}:1`],
      [DAVE, `${S}:2`],
    ])
      expect(
        await seen(
          'authenticated',
          user,
          `select hand_id from public.hand_holes where hand_id like '${S}:%'`,
        ),
      ).toEqual([{ hand_id: id }])
  })

  it('a player who stands and sits again keeps one row and their net adds up', async () => {
    const S = 'cccccccc-0000-4000-8000-000000000004'
    await call('record_match', session(S, { 0: ALICE, 1: BOB, 2: CAROL }))
    await call(
      'record_hand',
      hand(
        S,
        1,
        { 0: ALICE, 1: BOB, 2: CAROL },
        { [ALICE]: 60, [BOB]: -30, [CAROL]: -30 },
      ),
    )
    // Carol stood up after hand 1 ...
    await call(
      'record_hand',
      hand(S, 2, { 0: ALICE, 1: BOB }, { [ALICE]: -40, [BOB]: 40 }),
    )
    // ... and sat again, in seat 4.
    await call(
      'record_hand',
      hand(
        S,
        3,
        { 0: ALICE, 1: BOB, 4: CAROL },
        { [ALICE]: 10, [BOB]: -60, [CAROL]: 50 },
      ),
    )
    expect(await players(S)).toEqual([
      { user_id: ALICE, seat: 0, net_chips: 30 }, // 60 - 40 + 10
      { user_id: BOB, seat: 1, net_chips: -50 }, // -30 + 40 - 60
      { user_id: CAROL, seat: 4, net_chips: 20 }, // -30 + 50, last seat held
    ])
  })

  it('a finished session keeps each player’s session timeouts and writes no abandonment', async () => {
    const S = 'cccccccc-0000-4000-8000-000000000005'
    await call('record_match', session(S, { 0: ALICE, 1: BOB }))
    await call(
      'record_hand',
      hand(
        S,
        1,
        { 0: ALICE, 1: BOB, 2: CAROL },
        { [ALICE]: 20, [BOB]: -10, [CAROL]: -10 },
      ),
    )
    // Carol stood up before the session ended, so the finish does not
    // name her seat; her timeouts are still counted.
    const end = {
      ...session(S, { 0: ALICE, 1: BOB }),
      handNo: 1,
      // Session totals by account: one seat may have had several players.
      timeouts: { [BOB]: 3, [CAROL]: 1 },
      // What a heads-up finish turns into abandonments, by seat. A six
      // table forfeits nobody (ADR "Sitting out"), so these mean nothing.
      result: { reason: 'complete', forfeit: 1, noShow: [0], abandoned: [1] },
    }
    await call('record_match', end)
    await call('record_match', end) // an outbox retry
    const { rows: match } = await db.query<{ status: string }>(
      'select status from public.matches where id = $1',
      [S],
    )
    expect(match).toEqual([{ status: 'finished' }])
    const { rows } = await db.query<{
      user_id: string
      timeouts: number
      abandoned: boolean
      finished: boolean
    }>(
      `select user_id, timeouts, abandoned, finished_at is not null as finished
       from public.match_players where match_id = $1 order by user_id`,
      [S],
    )
    expect(rows).toEqual([
      { user_id: ALICE, timeouts: 0, abandoned: false, finished: true },
      { user_id: BOB, timeouts: 3, abandoned: false, finished: true },
      { user_id: CAROL, timeouts: 1, abandoned: false, finished: true },
    ])
    const { rows: left } = await db.query(
      'select user_id from public.abandonments where match_id = $1',
      [S],
    )
    expect(left).toEqual([])
  })

  it('a call after the session ended adds nobody', async () => {
    const S = 'cccccccc-0000-4000-8000-000000000016'
    await call('record_match', session(S, { 0: ALICE, 1: BOB }))
    const end = {
      ...session(S, { 0: ALICE, 1: BOB }),
      handNo: 0,
      timeouts: {},
      result: { reason: 'complete' },
    }
    await call('record_match', end)
    // A late retry that names a new account changes nothing.
    await call('record_match', {
      ...end,
      players: entries({ 0: ALICE, 2: DAVE }),
    })
    expect((await players(S)).map((r) => r.user_id)).toEqual([ALICE, BOB])
  })

  it('a hand replayed after the session ended moves no seat and gives a new row its finish time and timeouts', async () => {
    const S = 'cccccccc-0000-4000-8000-000000000017'
    await call('record_match', session(S, { 0: ALICE, 1: BOB }))
    // Alice moved to seat 4 before the session ended; Carol played hand 2
    // only, and its call was parked until after the finish.
    await call('record_match', {
      ...session(S, { 4: ALICE, 1: BOB }),
      handNo: 3,
      timeouts: { [CAROL]: 1 },
      result: { reason: 'complete' },
    })
    await call(
      'record_hand',
      hand(
        S,
        2,
        { 0: ALICE, 1: BOB, 3: CAROL },
        { [ALICE]: 20, [BOB]: -10, [CAROL]: -10 },
      ),
    )
    const { rows } = await db.query<{
      user_id: string
      seat: number
      timeouts: number
      same: boolean
    }>(
      `select mp.user_id, mp.seat, mp.timeouts,
              mp.finished_at = m.finished_at as same
       from public.match_players mp join public.matches m on m.id = mp.match_id
       where mp.match_id = $1 order by mp.user_id`,
      [S],
    )
    expect(rows).toEqual([
      { user_id: ALICE, seat: 4, timeouts: 0, same: true },
      { user_id: BOB, seat: 1, timeouts: 0, same: true },
      { user_id: CAROL, seat: 3, timeouts: 1, same: true },
    ])
  })

  it('one account twice in a call is refused as data (23505)', async () => {
    const S = 'cccccccc-0000-4000-8000-000000000018'
    const refused = async (fn: 'record_match' | 'record_hand', p: object) => {
      const error = await call(fn, p).then(
        () => null,
        (e: { code?: string }) => e,
      )
      expect(error?.code, fn).toBe('23505')
    }
    await refused('record_match', {
      ...session(S, {}),
      players: [
        { seat: 0, userId: ALICE },
        { seat: 1, userId: ALICE },
      ],
    })
    await call('record_match', session(S, { 0: ALICE, 1: BOB }))
    const twice = hand(S, 1, { 0: ALICE, 1: BOB }, { [ALICE]: 0, [BOB]: 0 })
    twice.record.seats[1].userId = ALICE
    await refused('record_hand', twice)
    const { rows } = await db.query(
      'select id from public.hands where match_id = $1',
      [S],
    )
    expect(rows).toEqual([])
  })

  it('apply_rating still refuses six-casual', async () => {
    const S = 'cccccccc-0000-4000-8000-000000000006'
    await call('record_match', session(S, { 0: ALICE, 1: BOB }))
    await call(
      'record_hand',
      hand(S, 1, { 0: ALICE, 1: BOB }, { [ALICE]: 40, [BOB]: -40 }),
    )
    await call('record_match', {
      ...session(S, { 0: ALICE, 1: BOB }),
      handNo: 1,
      timeouts: {},
      result: { reason: 'complete' },
    })
    const ratings = async () =>
      (
        await db.query(
          'select user_id, matches, version from public.ratings order by user_id',
        )
      ).rows
    const before = await ratings()
    // Finished, the archived players and no outcome on either side: only
    // the kind is left to refuse it.
    await expect(
      call('apply_rating', {
        matchId: S,
        format: 'hu-duplicate',
        modelVersion: 'glicko2.v1',
        players: [ALICE, BOB].map((userId) => ({
          userId,
          version: 0,
          rating: 1600,
          rd: 300,
          sigma: 0.06,
        })),
      }),
    ).rejects.toMatchObject({ code: '23514' })
    const { rows } = await db.query(
      'select id from public.rating_history where match_id = $1',
      [S],
    )
    expect(rows).toEqual([])
    expect(await ratings()).toEqual(before)
  })

  it('hands_after_match still hides a playing six-casual session’s hands from clients', async () => {
    const S = 'cccccccc-0000-4000-8000-000000000007'
    await call('record_match', session(S, { 0: ALICE, 1: BOB }))
    await call(
      'record_hand',
      hand(S, 1, { 0: ALICE, 1: BOB }, { [ALICE]: 20, [BOB]: -20 }),
    )
    await call(
      'record_hand',
      hand(
        S,
        2,
        { 0: ALICE, 1: BOB, 2: CAROL },
        { [ALICE]: -10, [BOB]: -10, [CAROL]: 20 },
      ),
    )
    // A visitor, a player at the table, a late joiner, a stranger.
    for (const [role, sub] of [
      ['anon', ''],
      ['authenticated', ALICE],
      ['authenticated', CAROL],
      ['authenticated', DAVE],
    ] as const)
      expect(await seen(role, sub, handsOf(S))).toEqual([])
    expect((await db.query(handsOf(S))).rows).toHaveLength(2)
    // The late joiner still reads her own cards of the hand she played.
    expect(
      await seen(
        'authenticated',
        CAROL,
        `select hand_id from public.hand_holes where hand_id like '${S}:%'`,
      ),
    ).toEqual([{ hand_id: `${S}:2` }])
    await call('record_match', {
      ...session(S, { 0: ALICE, 1: BOB, 2: CAROL }),
      handNo: 2,
      timeouts: {},
      result: { reason: 'complete' },
    })
    expect(await seen('anon', '', handsOf(S))).toHaveLength(2)
  })

  it('RLS: match_players stays readable by anyone and writable by no browser', async () => {
    const S = 'cccccccc-0000-4000-8000-000000000008'
    await call('record_match', session(S, { 0: ALICE, 1: BOB }))
    await call(
      'record_hand',
      hand(
        S,
        1,
        { 0: ALICE, 1: BOB, 2: CAROL },
        { [ALICE]: 20, [BOB]: -10, [CAROL]: -10 },
      ),
    )
    const ofSession = `select user_id from public.match_players where match_id = '${S}' order by user_id`
    for (const [role, sub] of [
      ['anon', ''],
      ['authenticated', ALICE],
      ['authenticated', DAVE],
    ] as const)
      expect(await seen(role, sub, ofSession)).toEqual([
        { user_id: ALICE },
        { user_id: BOB },
        { user_id: CAROL },
      ])
    for (const write of [
      `insert into public.match_players (match_id, user_id, seat) values ('${S}', '${DAVE}', 5)`,
      `update public.match_players set net_chips = 0 where match_id = '${S}'`,
      `delete from public.match_players where match_id = '${S}'`,
    ])
      await expect(seen('authenticated', ALICE, write)).rejects.toThrow(
        /permission denied/,
      )
    // The policy itself is untouched by the change of key.
    const { rows } = await db.query(
      `select policyname, permissive, roles::text[] as roles, cmd, qual
       from pg_policies where schemaname = 'public' and tablename = 'match_players'`,
    )
    expect(rows).toEqual([
      {
        policyname: 'public_read',
        permissive: 'PERMISSIVE',
        roles: ['anon', 'authenticated'],
        cmd: 'SELECT',
        qual: 'true',
      },
    ])
  })
})

describe('match_players', () => {
  it('is keyed by account, and keeps the indexes other reads use', async () => {
    const { rows: keys } = await db.query<{ def: string }>(
      `select pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'public.match_players'::regclass and contype in ('p', 'u')`,
    )
    expect(keys).toEqual([{ def: 'PRIMARY KEY (match_id, user_id)' }])
    // match_players_user: the profile joins and the pairing audit (Q3);
    // match_players_history: a player's matches newest first (DB-5).
    const { rows: indexes } = await db.query<{ indexname: string }>(
      `select indexname from pg_indexes
       where schemaname = 'public' and tablename = 'match_players' order by 1`,
    )
    expect(indexes.map((i) => i.indexname)).toEqual([
      'match_players_history',
      'match_players_pkey',
      'match_players_user',
    ])
  })

  it('a rated heads-up match archived with full hand records still has two rows and rates', async () => {
    const M = 'cccccccc-0000-4000-8000-000000000009'
    const seats = { 0: ALICE, 1: BOB }
    const start = { ...session(M, seats), kind: 'hu-rated', config: {} }
    await call('record_match', start)
    // Real hand records name both seats; they change no heads-up row.
    for (const n of [1, 2])
      await call('record_hand', hand(M, n, seats, { [ALICE]: 30, [BOB]: -30 }))
    await call('record_match', {
      ...start,
      handNo: 2,
      timeouts: { 1: 1 },
      result: {
        netBySeat: { 0: 60, 1: -60 },
        reason: 'complete',
        adjustedBySeat: { 0: 60, 1: -60 },
        outcomeBySeat: { 0: 'win', 1: 'loss' },
      },
    })
    const { rows } = await db.query(
      `select user_id, seat, net_chips, timeouts, outcome from public.match_players
       where match_id = $1 order by seat`,
      [M],
    )
    expect(rows).toEqual([
      { user_id: ALICE, seat: 0, net_chips: 60, timeouts: 0, outcome: 'win' },
      { user_id: BOB, seat: 1, net_chips: -60, timeouts: 1, outcome: 'loss' },
    ])
    await call('apply_rating', {
      matchId: M,
      format: 'hu-duplicate',
      modelVersion: 'glicko2.v1',
      players: [
        { userId: ALICE, outcome: 'win', version: 0, rating: 1600 },
        { userId: BOB, outcome: 'loss', version: 0, rating: 1400 },
      ].map((r) => ({ ...r, rd: 300, sigma: 0.06 })),
    })
    const { rows: history } = await db.query(
      'select user_id, outcome from public.rating_history where match_id = $1 order by user_id',
      [M],
    )
    expect(history).toEqual([
      { user_id: ALICE, outcome: 'win' },
      { user_id: BOB, outcome: 'loss' },
    ])
  })
})
