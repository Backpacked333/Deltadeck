// @vitest-environment node
// The verify consumer's three functions (Step 7): read an archived hand for
// audit, mark it verified, record an incident. Service role only, and safe to
// call any number of times: queue messages can be redelivered or arrive out
// of order.
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrationFiles, MIGRATIONS_DIR, SUPABASE_STUB } from './harness'

const ALICE = '11111111-1111-4111-8111-111111111111'
const BOB = '22222222-2222-4222-8222-222222222222'
const MATCH = '33333333-3333-4333-8333-333333333333'
const HAND = `${MATCH}:1`

let db: PGlite

async function as<T = Record<string, unknown>>(
  role: 'anon' | 'authenticated' | 'service_role',
  sql: string,
  user = '',
) {
  await db.exec(
    `reset role; select set_config('request.jwt.claim.sub', '${user}', false);`,
  )
  await db.exec(`set role ${role}`)
  try {
    return (await db.query<T>(sql)).rows
  } finally {
    await db.exec('reset role')
  }
}

const call = (fn: string, p: object) =>
  `select public.${fn}('${JSON.stringify(p).replace(/'/g, "''")}'::jsonb) as r`

const LEAVES = Buffer.alloc(52 * 32, 7).toString('base64')
const SECRET = Buffer.alloc(32, 1).toString('base64')
const DECK = Array.from({ length: 52 }, (_, i) => 51 - i)
const payload = {
  id: HAND,
  matchId: MATCH,
  handNo: 1,
  segment: 1,
  button: 0,
  commitment: 'a'.repeat(64),
  leaves: LEAVES,
  reveal: [{ slot: 4, card: 12, salt: '00'.repeat(16) }],
  record: { v: 1, handNo: 1 },
  deck: DECK,
  secret: SECRET,
  holes: { 0: [51, 50], 1: [49, 48] },
  holesByUser: [
    { userId: ALICE, cards: [51, 50] },
    { userId: BOB, cards: [49, 48] },
  ],
  netByUser: { [ALICE]: 10, [BOB]: -10 },
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(SUPABASE_STUB)
  for (const file of migrationFiles())
    await db.exec(readFileSync(new URL(file, MIGRATIONS_DIR), 'utf8'))
  await db.query('insert into auth.users (id) values ($1), ($2)', [ALICE, BOB])
  await as(
    'service_role',
    call('record_match', {
      id: MATCH,
      kind: 'hu-casual',
      config: {},
      players: [
        { seat: 0, userId: ALICE },
        { seat: 1, userId: BOB },
      ],
    }),
  )
  await as('service_role', call('record_hand', payload))
}, 60_000)

afterAll(() => db?.close())

describe('the verify functions', () => {
  it.each(['audit_hand', 'verify_hand', 'record_incident'])(
    '%s is executable by the service role only',
    async (fn) => {
      const p = { id: HAND, matchId: MATCH, handNo: 1, kind: 'x', detail: {} }
      for (const [role, user] of [
        ['anon', ''],
        ['authenticated', ALICE],
      ] as const)
        await expect(as(role, call(fn, p), user)).rejects.toThrow(
          /permission denied/,
        )
    },
  )

  it('audit_hand returns the public and private halves, base64 like the archive payload, or null', async () => {
    const [{ r }] = await as<{ r: Record<string, unknown> }>(
      'service_role',
      call('audit_hand', { id: HAND }),
    )
    expect(r).toMatchObject({
      id: HAND,
      matchId: MATCH,
      handNo: 1,
      commitment: payload.commitment,
      leaves: LEAVES,
      reveal: payload.reveal,
      record: payload.record,
      verified: false,
      deck: DECK,
      secret: SECRET,
      holes: { 0: [51, 50], 1: [49, 48] },
    })
    const [missing] = await as<{ r: unknown }>(
      'service_role',
      call('audit_hand', { id: `${MATCH}:9` }),
    )
    expect(missing.r).toBeNull()
  })

  it('verify_hand marks the hand verified, and again changes nothing', async () => {
    await as('service_role', call('verify_hand', { id: HAND }))
    await as('service_role', call('verify_hand', { id: HAND }))
    // Read as the server: the hand's match is still in play, so clients see
    // it only once the match ends (hands-live.test.ts).
    const rows = await as<{ verified: boolean }>(
      'service_role',
      `select verified from public.hands where id = '${HAND}'`,
    )
    expect(rows).toEqual([{ verified: true }])
  })

  it('record_incident writes one row per hand and kind however often it is called, readable by no client', async () => {
    const incident = {
      matchId: MATCH,
      handNo: 1,
      kind: 'verify_failed',
      detail: { problems: ['stacks'] },
    }
    for (let i = 0; i < 3; i++)
      await as('service_role', call('record_incident', incident))
    await as(
      'service_role',
      call('record_incident', { ...incident, kind: 'dlq' }),
    )
    const rows = await as<{ kind: string; detail: unknown }>(
      'service_role',
      `select kind, detail from public.incidents where match_id = '${MATCH}' order by id`,
    )
    expect(rows).toEqual([
      { kind: 'verify_failed', detail: { problems: ['stacks'] } },
      { kind: 'dlq', detail: { problems: ['stacks'] } },
    ])
    await expect(as('anon', 'select * from public.incidents')).rejects.toThrow(
      /permission denied/,
    )
  })

  it('record_incident takes a match-level incident with no hand, once', async () => {
    const p = { matchId: MATCH, kind: 'engine_fault', detail: { at: 'deal' } }
    await as('service_role', call('record_incident', p))
    await as('service_role', call('record_incident', p))
    const rows = await as<{ n: number }>(
      'service_role',
      `select count(*)::int n from public.incidents where kind = 'engine_fault'`,
    )
    expect(rows).toEqual([{ n: 1 }])
  })
})
