// @vitest-environment node
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrationFiles, MIGRATIONS_DIR, SUPABASE_STUB } from './harness'

let db: PGlite
const legacyOwner = crypto.randomUUID()
const legacyCurriculum = JSON.stringify({ notes: 'legacy Unicode ☀ and a quotation "', updatedAt: 9e12 })
beforeAll(async () => {
  db = new PGlite()
  await db.exec(SUPABASE_STUB)
  for (const f of migrationFiles()) {
    if (f === '20261012010000_learning_revisions.sql') {
      await db.query('insert into auth.users(id) values($1)', [legacyOwner])
      await db.query('insert into public.practice_hands(user_id,id,played_at,record) values($1,$2,now(),$3::jsonb)', [legacyOwner, 'legacy', JSON.stringify({ id: 'legacy', graded: true })])
      await db.query("insert into public.learning_state(user_id,trainer,curriculum,trainer_updated_at,curriculum_updated_at) values($1,'{}'::jsonb,$2,'2999-01-01','2999-01-01')", [legacyOwner, legacyCurriculum])
    }
    await db.exec(readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'))
  }
}, 60_000)
afterAll(() => db?.close())
async function player() {
  const id = crypto.randomUUID()
  await db.query('insert into auth.users(id) values($1)', [id])
  return id
}
async function as<T>(id: string, fn: () => Promise<T>) {
  await db.exec('set role authenticated')
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id])
  try { return await fn() } finally { await db.exec('reset role') }
}
type Result = { status: string; revision: number; current: unknown; deletionGeneration: number; reason?: string }
async function rpc(name: string, p: object) {
  return (await db.query<{ r: Result }>(`select public.${name}($1::jsonb) r`, [JSON.stringify(p)])).rows[0]!.r
}
function write(accountId: string, payload: unknown, over: object = {}) {
  const serialized = JSON.stringify(payload)
  return { protocol: 1, accountId, mutationId: crypto.randomUUID(), kind: 'curriculum', id: 'curriculum',
    baseRevision: 0, deletionGeneration: 0, lifecycle: 'final', supersedesRevision: null,
    serialized, payload, digest: createHash('sha256').update(serialized).digest('hex'), ...over }
}
const send = (p: object) => rpc('write_learning_revision_v1', p)
const clear = (accountId: string, scope = 'practice') => ({ protocol: 1, accountId,
  mutationId: crypto.randomUUID(), scope, expectedGeneration: 0 })

describe('F08–F10 protected learning writes', () => {
  it('F09 legacy backfill is exact but not new evidence; future clocks cannot defeat CAS projections', async () => {
    await as(legacyOwner, async () => {
      type Row = { revision: number; digest: string; serialized: string; payload: unknown }
      const read = (await db.query<{ r: { trainer: Row; curriculum: Row; hands: Row[] } }>("select public.read_learning_sync_v1('{\"protocol\":1}') r")).rows[0]!.r
      for (const row of [read.trainer, read.curriculum, ...read.hands]) {
        expect(row.revision).toBe(1)
        expect(createHash('sha256').update(row.serialized).digest('hex')).toBe(row.digest)
        expect(JSON.parse(row.serialized)).toEqual(row.payload)
      }
      expect(read.curriculum.payload).toBe(legacyCurriculum)
      expect(await send(write(legacyOwner, 'new account notes', { baseRevision: 1 }))).toMatchObject({ status: 'accepted', revision: 2 })
      expect((await db.query<{ curriculum: string }>('select curriculum from public.learning_state')).rows[0]!.curriculum).toBe('new account notes')
    })
    await db.query('delete from auth.users where id=$1', [legacyOwner])
  })
  it.each([false, true])('F09 both arrival orders preserve the losing document in a conflict (%s)', async (reverse) => {
    const u = await player()
    const docs = ['{"notes":"device-a","updatedAt":"2099"}', '{"notes":"device-b","updatedAt":"1900"}']
    if (reverse) docs.reverse()
    await as(u, async () => {
      expect(await send(write(u, docs[0]))).toMatchObject({ status: 'accepted', revision: 1 })
      expect(await send(write(u, docs[1]))).toMatchObject({ status: 'conflict', revision: 1, current: docs[0] })
    })
  })
  it('F08 requires current base, refuses provisional regression, accepts explicit correction and dedupes', async () => {
    const u = await player()
    const h = { id: 'h', hand: 1, net: 10, result: 'won', guided: false }
    const provisional = write(u, { ...h, graded: false }, { kind: 'practice_hand', id: 'h', lifecycle: 'provisional' })
    await as(u, async () => {
      expect(await send(provisional)).toMatchObject({ status: 'accepted', revision: 1 })
      expect(await send(provisional)).toMatchObject({ status: 'accepted', revision: 1 })
      expect(await send(write(u, h, { kind: 'practice_hand', id: 'h', baseRevision: 1 }))).toMatchObject({ status: 'accepted', revision: 2 })
      expect(await send({ ...provisional, mutationId: crypto.randomUUID() })).toMatchObject({ status: 'conflict' })
      expect(await send({ ...provisional, mutationId: crypto.randomUUID(), baseRevision: 2 })).toMatchObject({ status: 'blocked' })
      expect(await send(write(u, { ...h, net: 11 }, { kind: 'practice_hand', id: 'h', baseRevision: 2,
        lifecycle: 'corrected', supersedesRevision: 2 }))).toMatchObject({ status: 'accepted', revision: 3 })
      expect(await send({ ...provisional, digest: '0'.repeat(64) })).toMatchObject({ status: 'blocked' })
    })
  })
  it('F09 delete generation fences stale receipts, future timestamps and brand new offline IDs', async () => {
    const u = await player()
    const h = write(u, { id: 'h', graded: false, at: 4e12 }, { kind: 'practice_hand', id: 'h', lifecycle: 'provisional' })
    await as(u, async () => {
      await send(h)
      const deletion = clear(u)
      expect(await rpc('clear_learning_scope_v1', deletion)).toMatchObject({ status: 'accepted', deletionGeneration: 1 })
      expect(await rpc('clear_learning_scope_v1', deletion)).toMatchObject({ status: 'accepted', deletionGeneration: 1 })
      expect(await send(h)).toMatchObject({ status: 'deleted' })
      expect(await send(write(u, { id: 'new', graded: false }, { kind: 'practice_hand', id: 'new', lifecycle: 'provisional' }))).toMatchObject({ status: 'deleted' })
      expect((await db.query('select * from public.practice_hands')).rows).toHaveLength(0)
      expect(await rpc('clear_learning_scope_v1', { ...clear(u), expectedGeneration: 1 })).toMatchObject({ status: 'accepted', deletionGeneration: 2 })
      expect(await rpc('clear_learning_scope_v1', deletion)).toMatchObject({ status: 'conflict' })
    })
  })
  it('F10 owner-only RPCs and direct legacy/new writes cannot bypass the gate', async () => {
    const u = await player(), other = await player()
    await as(u, async () => {
      await expect(send(write(other, '{}'))).rejects.toThrow(/account mismatch/)
      for (const table of ['practice_hands', 'learning_state', 'learning_revisions', 'learning_sync_scopes', 'learning_mutations']) {
        await expect(db.query(`delete from public.${table}`)).rejects.toThrow(/permission denied/)
      }
      await expect(db.query('insert into public.learning_state(user_id,curriculum) values($1,$2)', [u, '{}'])).rejects.toThrow(/permission denied/)
      await send(write(u, '{}'))
    })
    await as(other, async () => expect((await db.query('select * from public.learning_revisions')).rows).toHaveLength(0))
    await db.exec('set role anon')
    try { await expect(rpc('read_learning_sync_v1', { protocol: 1 })).rejects.toThrow(/permission denied/) }
    finally { await db.exec('reset role') }
  })
  it('F08 size and payload/lifecycle mismatch fail explicitly rather than acknowledging', async () => {
    const u = await player()
    await as(u, async () => {
      expect(await send(write(u, 'x'.repeat(1_200_001)))).toMatchObject({ status: 'blocked', reason: 'size_limit' })
      const inflated = Object.fromEntries(Array.from({ length: 900 }, (_, i) => [`k${i}`, 0]))
      expect(JSON.stringify(inflated).length).toBeLessThan(8192)
      expect(await send(write(u, inflated, { kind: 'trainer', id: 'trainer' }))).toMatchObject({ status: 'blocked', reason: 'size_limit' })
      expect(await send(write(u, { id: 'h', graded: false }, { kind: 'practice_hand', id: 'h' }))).toMatchObject({ status: 'blocked', reason: 'invalid_lifecycle' })
      expect(await send({ ...write(u, '{}'), payload: '{"altered":true}' })).toMatchObject({ status: 'blocked', reason: 'invalid_payload' })
      expect(await send(write(u, '{}', { protocol: 0 }))).toMatchObject({ status: 'upgrade_required' })
    })
  })
  it('F09 all-scope clear compares both generations and removes protected source data', async () => {
    const u = await player()
    await as(u, async () => {
      await send(write(u, 'private notes'))
      const p = { ...clear(u, 'all'), expectedGenerations: { practice: 0, learning: 1 } }
      expect(await rpc('clear_learning_scope_v1', p)).toMatchObject({ status: 'conflict' })
      expect(await rpc('clear_learning_scope_v1', { ...p, expectedGenerations: { practice: 0, learning: 0 } })).toMatchObject({ status: 'accepted' })
      expect((await db.query('select * from public.learning_revisions')).rows).toHaveLength(0)
      expect((await db.query('select * from public.learning_state')).rows).toHaveLength(0)
    })
  })
})
