// @vitest-environment node
// Practice history on the account (20261011100000_practice_history.sql):
// each player reads and writes only their own practice hands and learning
// state; a graded hand is never replaced by its provisional copy; at most
// 1,000 new hands a day; an older device never overwrites newer state; and
// deleting the account deletes all of it.
import { createHash } from 'node:crypto'
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

/** Revision-aware browser writer; direct table writers stay denied. */
async function revision(
  user: string,
  kind: string,
  id: string,
  payload: unknown,
  baseRevision = 0,
  lifecycle = 'final',
) {
  const serialized = JSON.stringify(payload)
  return (
    await db.query<{ r: { status: string; reason?: string } }>(
      'select public.write_learning_revision_v1($1::jsonb) r',
      [
        JSON.stringify({
          protocol: 1,
          accountId: user,
          mutationId: uid(),
          kind,
          id,
          payload,
          serialized,
          digest: createHash('sha256').update(serialized).digest('hex'),
          baseRevision,
          deletionGeneration: 0,
          lifecycle,
          supersedesRevision: lifecycle === 'corrected' ? baseRevision : null,
        }),
      ],
    )
  ).rows[0].r
}
async function upsert(user: string, id: string, record: string, at = 'now()') {
  const payload = JSON.parse(record)
  if (payload && !Array.isArray(payload))
    payload.at = (
      await db.query<{ at: number }>(
        `select extract(epoch from (${at}))*1000 as at`,
      )
    ).rows[0].at
  const previous = (
    await db.query<{ revision: number; lifecycle: string }>(
      "select revision,lifecycle from public.learning_revisions where user_id=$1 and kind='practice_hand' and id=$2",
      [user, id],
    )
  ).rows[0]
  const lifecycle =
    payload?.graded === false
      ? 'provisional'
      : previous?.lifecycle === 'final'
        ? 'corrected'
        : 'final'
  return revision(
    user,
    'practice_hand',
    id,
    payload,
    previous?.revision ?? 0,
    lifecycle,
  )
}

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
    ).rejects.toThrow(/account mismatch/)
    await expect(
      as(alice, () =>
        db.query('delete from public.practice_hands where user_id=$1', [bob]),
      ),
    ).rejects.toThrow(/permission denied/)
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
      expect(await upsert(alice, 'a:1', '[]')).toMatchObject({
        status: 'blocked',
      })
      expect(await upsert(alice, 'a:1', hand('a:2'))).toMatchObject({
        status: 'blocked',
      })
      expect(
        await upsert(alice, 'a:1', hand('a:1', { pad: 'x'.repeat(9000) })),
      ).toMatchObject({ status: 'blocked' })
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
    await db.query(
      `insert into public.learning_revisions(user_id,kind,id,revision,generation,serialized,digest,lifecycle) values($1,'practice_hand','h:7',1,0,'{"id":"h:7"}',encode(sha256(convert_to('{"id":"h:7"}','UTF8')),'hex'),'final')`,
      [alice],
    )
    await as(alice, async () => {
      expect(await upsert(alice, 'h:new', hand('h:new'))).toMatchObject({
        status: 'blocked',
        reason: 'daily_cap',
      })
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
  const save = (user: string, fields: Record<string, string | null>) =>
    revision(user, 'trainer', 'trainer', JSON.parse(fields.trainer ?? '{}'))
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

  it('F09 stale base revision cannot overwrite newer trainer or curriculum, regardless of clocks', async () => {
    const alice = await player()
    await as(alice, async () => {
      expect(
        await revision(alice, 'trainer', 'trainer', { lessons: ['equity'] }),
      ).toMatchObject({ status: 'accepted' })
      expect(
        await revision(alice, 'trainer', 'trainer', {
          lessons: [],
          updatedAt: 9e12,
        }),
      ).toMatchObject({ status: 'conflict' })
      expect(
        await revision(alice, 'curriculum', 'curriculum', '{"v":2,"a":1}'),
      ).toMatchObject({ status: 'accepted' })
      expect(
        await revision(alice, 'curriculum', 'curriculum', '{"v":2,"b":1}'),
      ).toMatchObject({ status: 'conflict' })
    })
    expect(await row(alice)).toMatchObject({
      trainer: { lessons: ['equity'] },
      curriculum: '{"v":2,"a":1}',
    })
  })

  it('F09 clear generations advance server-side and legacy clear timestamps cannot write', async () => {
    const alice = await player()
    await as(alice, async () => {
      await save(alice, { trainer: '{}' })
      await expect(
        db.query(
          "update public.learning_state set hands_cleared_at='2999-01-01'",
        ),
      ).rejects.toThrow(/permission denied/)
      const clear = (expectedGeneration: number) =>
        db.query<{ r: { status: string; deletionGeneration: number } }>(
          'select public.clear_learning_scope_v1($1::jsonb) r',
          [
            JSON.stringify({
              protocol: 1,
              accountId: alice,
              mutationId: uid(),
              scope: 'practice',
              expectedGeneration,
            }),
          ],
        )
      expect((await clear(0)).rows[0].r).toMatchObject({
        status: 'accepted',
        deletionGeneration: 1,
      })
      expect((await clear(0)).rows[0].r).toMatchObject({ status: 'conflict' })
      expect((await clear(1)).rows[0].r).toMatchObject({
        status: 'accepted',
        deletionGeneration: 2,
      })
    })
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
      expect(await revision(alice, 'trainer', 'trainer', {})).toMatchObject({
        status: 'accepted',
      })
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
