// @vitest-environment node
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrationFiles, MIGRATIONS_DIR, SUPABASE_STUB } from './harness'
import { attempt } from '../../src/curriculum/learning/__fixtures__'
import {
  base,
  evaluateSubmission,
  submission,
} from '../../src/curriculum/learning/evidence'
import { recommend } from '../../src/curriculum/learning/recommend'
import { project } from '../../src/curriculum/learning/projector'
let db: PGlite
beforeAll(async () => {
  db = new PGlite()
  await db.exec(SUPABASE_STUB)
  for (const f of migrationFiles())
    await db.exec(readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'))
}, 60000)
afterAll(() => db?.close())
async function player() {
  const id = crypto.randomUUID()
  await db.query('insert into auth.users(id) values($1)', [id])
  return id
}
async function as<T>(id: string, fn: () => Promise<T>) {
  await db.exec('set role authenticated')
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id])
  try {
    return await fn()
  } finally {
    await db.exec('reset role')
  }
}
async function rpc(name: string, p: object) {
  return (
    await db.query<{ r: Record<string, unknown> }>(
      `select public.${name}($1::jsonb) r`,
      [JSON.stringify(p)],
    )
  ).rows[0]!.r
}
function wire(accountId: string, payload: object, generation = 0) {
  const serialized = JSON.stringify(payload)
  return {
    protocol: 1,
    accountId,
    id: (payload as { id: string }).id,
    deletionGeneration: generation,
    serialized,
    digest: createHash('sha256').update(serialized).digest('hex'),
  }
}
const send = (u: string, p: object, g = 0) =>
  rpc('ingest_learning_evidence_v1', wire(u, p, g))
const read = () => rpc('read_learning_evidence_v1', {})
const clear = (u: string, scope = 'learning') =>
  rpc('clear_learning_scope_v1', {
    protocol: 1,
    accountId: u,
    scope,
    mutationId: crypto.randomUUID(),
    expectedGeneration: 0,
  })
describe('F08/F09/F10 private append-only source truth', () => {
  it('F08 exact digest ACK and duplicate delivery; no in-place answer mutation', async () => {
    const u = await player(),
      s = submission(u, attempt()),
      e = evaluateSubmission(s)
    await as(u, async () => {
      const ack = await send(u, s)
      expect(ack).toMatchObject({
        status: 'accepted',
        id: s.id,
        deletionGeneration: 0,
        digest: wire(u, s).digest,
      })
      expect(await send(u, s)).toEqual(ack)
      expect(await send(u, { ...s, context: 'different' })).toMatchObject({
        status: 'conflict',
      })
      expect(await send(u, e)).toMatchObject({ status: 'accepted' })
      expect((await read()).rows).toHaveLength(2)
      expect(
        await rpc('ingest_learning_evidence_v1', {
          ...wire(u, s),
          digest: 'a'.repeat(64),
        }),
      ).toMatchObject({ status: 'blocked' })
      await expect(
        db.query("update public.learning_evidence_events set digest='x'"),
      ).rejects.toThrow(/permission denied/)
    })
  })
  it('F10 owner isolation, anonymous denial and exact account binding', async () => {
    const a = await player(),
      b = await player(),
      s = submission(a, attempt())
    await as(a, () => send(a, s))
    await as(b, async () => {
      expect((await read()).rows).toEqual([])
      expect(
        (await db.query('select * from public.learning_evidence_events')).rows,
      ).toEqual([])
      await expect(send(a, s)).rejects.toThrow('account mismatch')
      await expect(
        db.query('delete from public.learning_evidence_events'),
      ).rejects.toThrow(/permission denied/)
    })
    await db.exec('set role anon')
    try {
      await expect(read()).rejects.toThrow(/permission denied/)
    } finally {
      await db.exec('reset role')
    }
  })
  it('client certification is rejected and unreceived source references retry, never disappear', async () => {
    const u = await player(),
      s = submission(u, attempt()),
      e = evaluateSubmission(s)
    await as(u, async () => {
      expect(await send(u, { ...s, trust: 'server-certified' })).toMatchObject({
        status: 'blocked',
        reason: 'invalid_envelope',
      })
      await expect(send(u, e)).rejects.toThrow('source_not_received')
      expect(await send(u, s)).toMatchObject({ status: 'accepted' })
      expect(await send(u, e)).toMatchObject({ status: 'accepted' })
      expect(await send(u, { ...e, id: 'e2' })).toMatchObject({
        status: 'conflict',
        reason: 'evaluation_requires_supersedes',
      })
      expect(await send(u, { ...e, id: 'e2', supersedes: e.id })).toMatchObject(
        { status: 'accepted' },
      )
      expect(
        await send(u, { ...e, id: 'fork', supersedes: e.id }),
      ).toMatchObject({ status: 'conflict' })
      expect(
        await send(u, {
          ...base(u, 'invalidate', s.observedAt),
          kind: 'invalidation',
          targetId: s.id,
          reason: 'source withdrawn',
        }),
      ).toMatchObject({ status: 'accepted' })
    })
  })
  it('F09 learning deletion erases raw, grades, pilot and fences old and brand-new stale IDs', async () => {
    const u = await player(),
      s = submission(u, attempt()),
      e = evaluateSubmission(s)
    await as(u, async () => {
      await send(u, s)
      await send(u, e)
      await send(u, { ...e, id: 'e2', supersedes: e.id })
      expect(await clear(u)).toMatchObject({
        status: 'accepted',
        deletionGeneration: 1,
      })
      expect((await read()).rows).toEqual([])
      expect(await send(u, s)).toMatchObject({
        status: 'blocked',
        reason: 'deleted_generation',
      })
      expect(await send(u, { ...s, id: 'new-offline' })).toMatchObject({
        status: 'blocked',
        reason: 'deleted_generation',
      })
      expect(await send(u, s, 1)).toMatchObject({ status: 'accepted' })
    })
  })
  it('F09 practice deletion cannot be reintroduced through the learning generation', async () => {
    const u = await player(),
      s = {
        ...submission(u, attempt()),
        id: 'practice1',
        source: 'practice',
        sourceId: 'h',
        sourceRevision: '1',
        family: null,
        skills: [],
        attempt: null,
        practice: {
          graded: true,
          decisions: 2,
          modeled: 2,
          practiceGeneration: 0,
        },
      }
    await as(u, async () => {
      expect(await send(u, s)).toMatchObject({ status: 'accepted' })
      await clear(u, 'practice')
      expect((await read()).rows).toEqual([])
      expect(await send(u, { ...s, id: 'stale-practice' })).toMatchObject({
        status: 'blocked',
        reason: 'invalid_practice_provenance',
      })
    })
  })
  it('F09 submitted times do not become trusted receipt times', async () => {
    const u = await player(),
      s = submission(
        u,
        attempt('incremental-delayed-warranty', {
          submittedAt: '2099-01-01T00:00:00.000Z',
        }),
      )
    await as(u, async () => {
      await send(u, s)
      const page = await read()
      const row = (
        page.rows as { event: { clock: string }; receivedAt: string }[]
      )[0]
      expect(row.event.clock).toBe('device-uncertain')
      expect(Date.parse(row.receivedAt)).toBeLessThan(Date.parse('2099-01-01'))
    })
  })
  it('pilot defaults shadow; user cannot self-assign, exposure requires enabled protocol and consent; attrition is exported', async () => {
    const u = await player(),
      absent = await player()
    const rec = {
      ...recommend(project([], u), [], u, new Date().toISOString()),
      id: 'recommendation',
      exposure: 'limited-pilot',
    }
    await as(u, async () => {
      expect(await send(u, rec)).toMatchObject({
        status: 'blocked',
        reason: 'pilot_not_authorized',
      })
      await expect(
        db.query(
          "insert into public.learning_pilot_assignments(user_id,protocol_id,arm,stratum) values($1,'test','targeted','cold')",
          [u],
        ),
      ).rejects.toThrow(/permission denied/)
      await expect(
        db.query("select public.export_learning_pilot_v1('test')"),
      ).rejects.toThrow(/permission denied/)
    })
    await db.query(
      "insert into public.learning_pilot_protocols(id,enabled,policy,endpoint,baseline,heldout_families,preregistration) values('test',true,'targeted-practice.v1','delayed new-family','curriculum-order-review-date',array['targeted-incremental-delayed-warranty'],'{\"analysis\":\"predeclared outside implementation\"}')",
    )
    await db.query(
      "insert into public.learning_pilot_assignments(user_id,protocol_id,arm,stratum) values($1,'test','targeted','cold'),($2,'test','baseline','cold')",
      [u, absent],
    )
    await as(u, async () => {
      expect(await send(u, rec)).toMatchObject({ status: 'blocked' })
      await rpc('learning_pilot_consent_v1', { consent: true })
      expect(await send(u, rec)).toMatchObject({ status: 'accepted' })
      const source = submission(u, attempt()),
        grade = evaluateSubmission(source)
      await send(u, source)
      await send(u, grade)
      await send(u, {
        ...base(u, 'withdraw-grade', source.observedAt),
        kind: 'invalidation',
        targetId: grade.id,
        reason: 'rubric challenged',
      })
      await rpc('learning_pilot_consent_v1', { consent: false })
      expect(await send(u, { ...rec, id: 'r2' })).toMatchObject({
        status: 'blocked',
      })
    })
    await db.exec('set role service_role')
    try {
      const exported = (
        await db.query<{
          r: {
            learner: string
            outcomes: unknown[]
            consentAt: string | null
          }[]
        }>("select public.export_learning_pilot_v1('test') r")
      ).rows[0]!.r
      expect(exported).toHaveLength(2)
      expect(exported.find((r) => r.learner === u)).toMatchObject({
        decisions: [{ payload: { exposure: 'limited-pilot' } }],
        invalidations: [{ targetId: expect.stringContaining(':eval:v1') }],
      })
      expect(exported.find((r) => r.learner === absent)).toMatchObject({
        outcomes: [],
        consentAt: null,
      })
    } finally {
      await db.exec('reset role')
    }
    await as(u, () => clear(u))
    expect(
      (
        await db.query(
          'select * from public.learning_pilot_assignments where user_id=$1',
          [u],
        )
      ).rows,
    ).toEqual([])
  })
})
