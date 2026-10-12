// @vitest-environment node
// Profile pictures (20261012000000_avatars.sql): a player writes only their
// own <user id>.webp in the avatars bucket, sets only their own
// avatar_version (set_avatar and remove_avatar, or directly), and may
// report another player's picture once a day; nobody reads the reports
// through the API.
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

const version = async (id: string) =>
  (
    await db.query<{ v: number | null }>(
      `select avatar_version v from public.players where user_id = $1`,
      [id],
    )
  ).rows[0].v

describe('the avatars bucket', () => {
  it('is public, WebP only and capped at 1 MB', async () => {
    const { rows } = await db.query<{
      public: boolean
      file_size_limit: number
      allowed_mime_types: string[]
    }>(`select * from storage.buckets where id = 'avatars'`)
    expect(rows[0]).toMatchObject({
      public: true,
      file_size_limit: 1048576,
      allowed_mime_types: ['image/webp'],
    })
  })

  it('lets a player write only their own picture', async () => {
    const me = await player()
    const other = await player()
    const put = (name: string) =>
      db.query(
        `insert into storage.objects (bucket_id, name) values ('avatars', $1)`,
        [name],
      )
    await as(me, () => put(`${me}.webp`))
    await expect(as(me, () => put(`${other}.webp`))).rejects.toThrow(
      /row-level security/,
    )
    await expect(as(me, () => put(`${me}.png`))).rejects.toThrow(
      /row-level security/,
    )
    await expect(as(null, () => put(`${me}.webp`))).rejects.toThrow(
      /row-level security/,
    )
    // Another player can neither replace nor delete it; anyone can see it.
    const replaced = await as(other, () =>
      db.query(
        `update storage.objects set owner = $1 where name = $2 returning id`,
        [other, `${me}.webp`],
      ),
    )
    expect(replaced.rows).toHaveLength(0)
    const deleted = await as(other, () =>
      db.query(`delete from storage.objects where name = $1 returning id`, [
        `${me}.webp`,
      ]),
    )
    expect(deleted.rows).toHaveLength(0)
    const seen = await as(null, () =>
      db.query(`select name from storage.objects where name = $1`, [
        `${me}.webp`,
      ]),
    )
    expect(seen.rows).toHaveLength(1)
    const mine = await as(me, () =>
      db.query(`delete from storage.objects where name = $1 returning id`, [
        `${me}.webp`,
      ]),
    )
    expect(mine.rows).toHaveLength(1)
  })
})

describe('avatar_version', () => {
  it('starts empty, and set_avatar and remove_avatar change only your own', async () => {
    const me = await player()
    const other = await player()
    expect(await version(me)).toBeNull()
    await as(me, () => db.query(`select public.set_avatar(42)`))
    expect(await version(me)).toBe(42)
    expect(await version(other)).toBeNull()
    await as(me, () => db.query(`select public.remove_avatar()`))
    expect(await version(me)).toBeNull()
  })

  it('refuses bad versions and anon callers, and checks direct writes', async () => {
    const me = await player()
    for (const v of [0, -1, 1_000_000_001])
      await expect(
        as(me, () => db.query(`select public.set_avatar($1)`, [v])),
      ).rejects.toThrow(/bad avatar version/)
    await expect(
      as(null, () => db.query(`select public.set_avatar(1)`)),
    ).rejects.toThrow(/permission denied/)
    // A direct write is the same as set_avatar: own row, valid values only.
    const direct = (v: number, who = me) =>
      as(me, () =>
        db.query(
          `update public.players set avatar_version = $1 where user_id = $2`,
          [v, who],
        ),
      )
    await direct(7)
    expect(await version(me)).toBe(7)
    await expect(direct(0)).rejects.toThrow(/check constraint/)
    const other = await player()
    expect((await direct(9, other)).affectedRows).toBe(0)
  })
})

describe('report_avatar', () => {
  it('keeps one report per reporter, player and day, and shows them to nobody', async () => {
    const me = await player()
    const them = await player()
    await as(them, () => db.query(`select public.set_avatar(3)`))
    await as(me, () => db.query(`select public.report_avatar($1)`, [them]))
    await as(me, () => db.query(`select public.report_avatar($1)`, [them]))
    const { rows } = await db.query(
      `select * from public.avatar_reports where player = $1`,
      [them],
    )
    expect(rows).toHaveLength(1)
    await expect(
      as(me, () => db.query(`select * from public.avatar_reports`)),
    ).rejects.toThrow(/permission denied/)
    // Only in your own name.
    await expect(
      as(me, () =>
        db.query(
          `insert into public.avatar_reports (reporter, player) values ($1, $2)`,
          [them, me],
        ),
      ),
    ).rejects.toThrow(/row-level security/)
  })

  it('refuses reporting yourself or while signed out, and ignores no picture', async () => {
    const me = await player()
    const bare = await player()
    await expect(
      as(me, () => db.query(`select public.report_avatar($1)`, [me])),
    ).rejects.toThrow(/cannot report/)
    await expect(
      as(null, () => db.query(`select public.report_avatar($1)`, [bare])),
    ).rejects.toThrow(/permission denied/)
    await as(me, () => db.query(`select public.report_avatar($1)`, [bare]))
    const { rows } = await db.query(
      `select * from public.avatar_reports where player = $1`,
      [bare],
    )
    expect(rows).toHaveLength(0)
  })
})
