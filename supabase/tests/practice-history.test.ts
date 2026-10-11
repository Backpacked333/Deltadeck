// @vitest-environment node
// Practice history on the account (20261011100000_practice_history.sql):
// each player reads and writes only their own practice hands and learning
// state; a graded hand is never replaced by its provisional copy; at most
// 1,000 new hands a day; an older device never overwrites newer state; and
// deleting the account deletes all of it.
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrationFiles, MIGRATIONS_DIR, SUPABASE_STUB } from './harness'

let db: PGlite
const uid = () => crypto.randomUUID()

beforeAll(async () => {
  db = new PGlite()
  await db.exec(SUPABASE_STUB)
  for (const file of migrationFiles())
    await db.exec(readFileSync(new URL(file, MIGRATIONS_DIR), 'utf8'))
}, 60_000)
afterAll(() => db?.close())

async function player() {
  const id = uid()
  await db.query(
    `insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())`,
    [id, `${id}@example.com`],
  )
  return id
}

/** Runs as a signed-in player (or anon when `sub` is null). */
async function as<T>(sub: string | null, run: () => Promise<T>) {
  await db.exec(`set role ${sub ? 'authenticated' : 'anon'}`)
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [
    sub ?? '',
  ])
  try {
    return await run()
  } finally {
    await db.exec('reset role')
    await db.query(`select set_config('request.jwt.claim.sub', '', false)`)
  }
}

const hand = (id: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    id,
    hand: 1,
    net: 10,
    result: 'won',
    guided: false,
    ...extra,
  })

/** The browser's upsert: insert, or replace the record with the same id. */
const upsert = (user: string, id: string, record: string, at = 'now()') =>
  db.query(
    `insert into public.practice_hands (user_id, id, played_at, record)
     values ($1, $2, ${at}, $3::jsonb)
     on conflict (user_id, id) do update
       set record = excluded.record, played_at = excluded.played_at`,
    [user, id, record],
  )

const stored = async (user: string, id: string) =>
  (
    await db.query<{ record: Record<string, unknown> }>(
      `select record from public.practice_hands where user_id = $1 and id = $2`,
      [user, id],
    )
  ).rows[0]?.record

describe('practice hands', () => {
  it('a player reads and writes only their own; anon nothing', async () => {
    const alice = await player()
    const bob = await player()
    await as(alice, () => upsert(alice, 'a:1', hand('a:1')))
    await as(bob, () => upsert(bob, 'b:1', hand('b:1')))
    const seen = await as(alice, () =>
      db.query<{ id: string }>(`select id from public.practice_hands`),
    )
    expect(seen.rows.map((r) => r.id)).toEqual(['a:1'])
    await expect(
      as(alice, () => upsert(bob, 'a:2', hand('a:2'))),
    ).rejects.toThrow(/row-level security/)
    const removed = await as(alice, () =>
      db.query(`delete from public.practice_hands where user_id = $1`, [bob]),
    )
    expect(removed.affectedRows).toBe(0)
    await expect(
      as(null, () => db.query(`select * from public.practice_hands`)),
    ).rejects.toThrow(/permission denied/)
  })

  it('never replaces a graded hand with its provisional record', async () => {
    const alice = await player()
    await as(alice, async () => {
      await upsert(alice, 'a:1', hand('a:1', { graded: false }))
      await upsert(
        alice,
        'a:1',
        hand('a:1', { decisions: [{ grade: 'best' }] }),
      )
      // An older device still holding the copy saved before grading.
      await upsert(alice, 'a:1', hand('a:1', { graded: false }))
    })
    expect(await stored(alice, 'a:1')).toMatchObject({
      decisions: [{ grade: 'best' }],
    })
    expect((await stored(alice, 'a:1'))?.graded).toBeUndefined()
  })

  it('takes only an object matching its id, at most 8 KB, never dated ahead', async () => {
    const alice = await player()
    await as(alice, async () => {
      await expect(upsert(alice, 'a:1', '[]')).rejects.toThrow(/check/)
      await expect(upsert(alice, 'a:1', hand('a:2'))).rejects.toThrow(/check/)
      await expect(
        upsert(alice, 'a:1', hand('a:1', { pad: 'x'.repeat(9000) })),
      ).rejects.toThrow(/check/)
      await upsert(alice, 'a:1', hand('a:1'), `now() + interval '3 days'`)
    })
    const { rows } = await db.query<{ ahead: boolean }>(
      `select played_at > now() as ahead from public.practice_hands where user_id = $1`,
      [alice],
    )
    expect(rows).toEqual([{ ahead: false }])
  })

  it('stops new hands after 1,000 in a day, but still updates stored ones', async () => {
    const alice = await player()
    await db.query(
      `insert into public.practice_hands (user_id, id, played_at, record)
       select $1, 'h:' || n, now(), jsonb_build_object('id', 'h:' || n)
       from generate_series(1, 1000) n`,
      [alice],
    )
    await as(alice, async () => {
      await expect(upsert(alice, 'h:new', hand('h:new'))).rejects.toThrow(
        /limit reached/,
      )
      await upsert(alice, 'h:7', hand('h:7', { net: 99 }))
    })
    expect(await stored(alice, 'h:7')).toMatchObject({ net: 99 })
    // A day later the same player can save new hands again. (created_at
    // never changes through the guard, so the clock moves with it paused.)
    await db.exec(`set session_replication_role = replica`)
    await db.query(
      `update public.practice_hands set created_at = now() - interval '25 hours'
       where user_id = $1`,
      [alice],
    )
    await db.exec(`set session_replication_role = origin`)
    await as(alice, () => upsert(alice, 'h:new', hand('h:new')))
    expect(await stored(alice, 'h:new')).toMatchObject({ id: 'h:new' })
  })
})

describe('learning state', () => {
  const save = (user: string, fields: Record<string, string | null>) => {
    const columns = Object.keys(fields)
    return db.query(
      `insert into public.learning_state (user_id, ${columns.join(', ')})
       values ($1, ${columns.map((_, i) => `$${i + 2}`).join(', ')})
       on conflict (user_id) do update set ${columns
         .map((c) => `${c} = excluded.${c}`)
         .join(', ')}`,
      [user, ...Object.values(fields)],
    )
  }
  const row = async (user: string) =>
    (
      await db.query<{
        trainer: unknown
        curriculum: string | null
        hands_cleared_at: Date | null
      }>(
        `select trainer, curriculum, hands_cleared_at from public.learning_state where user_id = $1`,
        [user],
      )
    ).rows[0]

  it('an older device never overwrites newer trainer or curriculum state', async () => {
    const alice = await player()
    await as(alice, async () => {
      await save(alice, {
        trainer: '{"lessons": ["equity", "variance"]}',
        trainer_updated_at: '2026-10-11T12:00:00Z',
        curriculum: '{"v":2,"b":1}',
        curriculum_updated_at: '2026-10-11T12:00:00Z',
      })
      await save(alice, {
        trainer: '{"lessons": []}',
        trainer_updated_at: '2026-10-11T11:00:00Z',
        curriculum: '{"v":2,"a":1}',
        curriculum_updated_at: '2026-10-11T13:00:00Z',
      })
    })
    const state = await row(alice)
    expect(state.trainer).toEqual({ lessons: ['equity', 'variance'] })
    // Stored byte for byte: the newer curriculum, keys in its own order.
    expect(state.curriculum).toBe('{"v":2,"a":1}')
  })

  it('moves the history clear time only forward', async () => {
    const alice = await player()
    await as(alice, async () => {
      await save(alice, { hands_cleared_at: '2026-10-11T12:00:00Z' })
      await save(alice, { hands_cleared_at: '2026-10-01T00:00:00Z' })
    })
    expect((await row(alice)).hands_cleared_at?.toISOString()).toBe(
      '2026-10-11T12:00:00.000Z',
    )
  })

  it('is never read or deleted by another player', async () => {
    const alice = await player()
    const bob = await player()
    await as(alice, () => save(alice, { trainer: '{}' }))
    const seen = await as(bob, () =>
      db.query(`select * from public.learning_state where user_id = $1`, [
        alice,
      ]),
    )
    expect(seen.rows).toEqual([])
    await expect(
      as(alice, () =>
        db.query(`delete from public.learning_state where user_id = $1`, [
          alice,
        ]),
      ),
    ).rejects.toThrow(/permission denied/)
  })
})

describe('the account', () => {
  it('takes its practice data with it when it is deleted', async () => {
    const alice = await player()
    await as(alice, async () => {
      await upsert(alice, 'a:1', hand('a:1'))
      await db.query(
        `insert into public.learning_state (user_id, trainer) values ($1, '{}')`,
        [alice],
      )
    })
    await db.query(`delete from public.players where user_id = $1`, [alice])
    await db.query(`delete from auth.users where id = $1`, [alice])
    const left = await db.query<{ n: number }>(
      `select (select count(*) from public.practice_hands where user_id = $1)
            + (select count(*) from public.learning_state where user_id = $1) n`,
      [alice],
    )
    expect(Number(left.rows[0].n)).toBe(0)
  })
})
