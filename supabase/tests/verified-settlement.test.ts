// @vitest-environment node
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import { migrationFiles, MIGRATIONS_DIR, SUPABASE_STUB } from './harness'
import {
  handFixture,
  settlementFixture,
  MATCH,
  USERS,
  T0,
} from '../../worker/test/settlement-fixtures'
import { inspectSettlement } from '../../worker/src/settlement-evidence'
import type {
  SettlementSource,
  SettlementCertificate,
} from '../../worker/src/settlement-evidence'
import { problemsWith } from '../../worker/src/verify'
import type { AuditedHand } from '../../worker/src/verify'
import { evidenceDigest } from '../../worker/src/live-evidence'

let db: PGlite
const rpc = async <T = unknown>(fn: string, p: unknown): Promise<T> => {
  await db.exec('set role service_role')
  try {
    return (
      await db.query<{ v: T }>(`select public.${fn}($1::jsonb) v`, [
        JSON.stringify(p),
      ])
    ).rows[0].v
  } finally {
    await db.exec('reset role')
  }
}
beforeAll(async () => {
  db = new PGlite()
  await db.exec(SUPABASE_STUB)
  for (const f of migrationFiles())
    await db.exec(readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'))
  await db.exec(
    `insert into auth.users(id) values('${USERS[0]}'),('${USERS[1]}')`,
  )
}, 60_000)
afterAll(() => db?.close())
let seq = 1
const matchId = () =>
  `51000000-0000-4000-8000-${String(seq++).padStart(12, '0')}`
beforeEach(() => {
  seq += 100
})

async function seed(
  reason: 'complete' | 'forfeit' | 'no_show' | 'abandoned' = 'forfeit',
  alter?: (source: SettlementSource) => void,
) {
  const s = await settlementFixture(matchId(), reason)
  alter?.(s)
  const start = {
    id: s.matchId,
    kind: s.kind,
    config: s.config,
    players: s.players,
  }
  await rpc('record_match', start)
  for (const h of s.hands) await rpc('record_hand', h.archive)
  await rpc('record_match', {
    ...start,
    handNo: s.hands.length,
    result: s.result,
  })
  await rpc('record_terminal', s.terminal)
  return s
}
async function verify(s: SettlementSource) {
  for (const h of s.hands) {
    const audited = await rpc<AuditedHand>('audit_hand', { id: h.id })
    expect(await problemsWith(audited)).toEqual([])
    await rpc('verify_hand_v2', {
      id: h.id,
      sourceToken: audited.sourceToken,
      version: 'hand.v2',
      recordDigest: await evidenceDigest(audited.record),
      archiveDigest: await evidenceDigest(audited.archive),
    })
  }
}
async function certify(s: SettlementSource): Promise<SettlementCertificate> {
  const audited = await rpc<SettlementSource>('audit_settlement', {
    matchId: s.matchId,
  })
  const v = await inspectSettlement(audited)
  expect(v).toMatchObject({ state: 'verified' })
  if (v.state !== 'verified') throw Error(JSON.stringify(v))
  await rpc('record_settlement_verdict', {
    matchId: s.matchId,
    sourceToken: audited.sourceToken,
    ...v,
  })
  return v.certificate
}
async function rating(
  c: SettlementCertificate,
  overrides: Record<string, unknown> = {},
) {
  const ratings = (
    await db.query<{ user_id: string; version: number }>(
      'select user_id,version from public.ratings',
    )
  ).rows
  return rpc('apply_rating', {
    matchId: c.matchId,
    sourceToken: c.sourceToken,
    certificateDigest: c.evidenceDigest,
    format: 'hu-duplicate',
    modelVersion: 'glicko2.v1',
    finishedAt: new Date(c.finishedAt).toISOString(),
    players: c.players.map((p) => ({
      ...p,
      version: ratings.find((r) => r.user_id === p.userId)?.version ?? 0,
      rating: 1500,
      rd: 300,
      sigma: 0.06,
    })),
    ...overrides,
  })
}

describe('F07 rating base-table write fence', () => {
  const roles = ['anon', 'authenticated', 'service_role'] as const
  const tables = ['public.ratings', 'public.rating_history'] as const
  beforeEach(() => db.exec('begin'))
  afterEach(() => db.exec('rollback'))

  async function deniesWrite(
    role: string,
    sql: string,
    params: unknown[] = [],
    code = '42501',
  ) {
    await db.exec(`savepoint denied_write; set local role ${role}`)
    try {
      await expect(db.query(sql, params)).rejects.toMatchObject({ code })
    } finally {
      await db.exec(
        'rollback to savepoint denied_write; release savepoint denied_write',
      )
    }
  }

  it('F07 final catalog allows reads but no table or column write privileges, including BYPASSRLS service_role', async () => {
    expect(
      (
        await db.query<{ rolbypassrls: boolean }>(
          "select rolbypassrls from pg_roles where rolname='service_role'",
        )
      ).rows[0].rolbypassrls,
    ).toBe(true)
    for (const role of roles) {
      for (const table of tables) {
        for (const permission of [
          'SELECT',
          'INSERT',
          'UPDATE',
          'DELETE',
          'TRUNCATE',
          'REFERENCES',
          'TRIGGER',
        ]) {
          const { rows } = await db.query<{ allowed: boolean }>(
            'select has_table_privilege($1,$2,$3) allowed',
            [role, table, permission],
          )
          expect(rows[0].allowed, `${role} ${table} ${permission}`).toBe(
            permission === 'SELECT',
          )
        }
        for (const permission of ['INSERT', 'UPDATE', 'REFERENCES']) {
          const { rows } = await db.query<{ allowed: boolean }>(
            'select has_any_column_privilege($1,$2,$3) allowed',
            [role, table, permission],
          )
          expect(rows[0].allowed, `${role} ${table} column ${permission}`).toBe(
            false,
          )
        }
      }
    }
  })

  it('F07 reapplication also removes independent column grants, including PUBLIC', async () => {
    await db.exec(`
      grant insert(user_id), update(rating), references(user_id) on public.ratings
        to public, anon, authenticated, service_role;
      grant insert(user_id), update(after_rating), references(user_id) on public.rating_history
        to public, anon, authenticated, service_role;
    `)
    const migration = readFileSync(
      new URL('20261012050000_rating_write_privileges.sql', MIGRATIONS_DIR),
      'utf8',
    )
    for (let attempt = 0; attempt < 2; attempt++) {
      await db.exec(migration)
      for (const role of roles)
        for (const table of tables)
          for (const permission of ['INSERT', 'UPDATE', 'REFERENCES']) {
            const { rows } = await db.query<{ allowed: boolean }>(
              'select has_any_column_privilege($1,$2,$3) allowed',
              [role, table, permission],
            )
            expect(
              rows[0].allowed,
              `${role} ${table} column ${permission}`,
            ).toBe(false)
          }
    }
  })

  it.each(roles)(
    'F07 %s can read both tables but direct DML is permission-denied',
    async (role) => {
      await db.query(
        "insert into public.ratings(user_id,format) values($1,'6max') on conflict do nothing",
        [USERS[0]],
      )
      await db.query(
        "insert into public.rating_history(user_id,format,kind,before_rating,before_rd,before_sigma,after_rating,after_rd,after_sigma,model_version) values($1,'6max','reset',1500,350,.06,1500,350,.06,'test')",
        [USERS[0]],
      )
      await db.exec(`set role ${role}`)
      try {
        for (const table of tables) {
          const { rows } = await db.query(
            `select * from ${table} where user_id=$1`,
            [USERS[0]],
          )
          expect(rows.length).toBeGreaterThan(0)
        }
      } finally {
        await db.exec('reset role')
      }

      await deniesWrite(
        role,
        "insert into public.ratings(user_id,format,rating) values($1,'6max',9999) on conflict(user_id,format) do update set rating=excluded.rating",
        [USERS[0]],
      )
      await deniesWrite(
        role,
        "insert into public.rating_history(user_id,format,kind,before_rating,before_rd,before_sigma,after_rating,after_rd,after_sigma,model_version) values($1,'6max','reset',1500,350,.06,9999,350,.06,'forged')",
        [USERS[0]],
      )
      await deniesWrite(
        role,
        'update public.ratings set rating=9999 where user_id=$1',
        [USERS[0]],
      )
      await deniesWrite(role, 'delete from public.ratings where user_id=$1', [
        USERS[0],
      ])
      // Empty predicates bypass row triggers, so these prove privileges, not the append-only guard.
      await deniesWrite(
        role,
        'update public.rating_history set after_rating=9999 where false',
      )
      await deniesWrite(role, 'delete from public.rating_history where false')
      for (const table of tables) await deniesWrite(role, `truncate ${table}`)
    },
  )

  it('F07 service_role cannot fabricate a zero-evidence history and enter the duplicate-result path', async () => {
    const id = matchId()
    await rpc('record_match', {
      id,
      kind: 'hu-rated',
      config: {},
      players: USERS.map((userId, seat) => ({ userId, seat })),
      result: {
        reason: 'complete',
        outcomeBySeat: { 0: 'draw', 1: 'draw' },
        adjustedBySeat: { 0: 0, 1: 0 },
      },
    })
    const payload = {
      matchId: id,
      format: 'hu-duplicate',
      modelVersion: 'glicko2.v1',
      players: USERS.map((userId, seat) => ({
        userId,
        seat,
        outcome: 'draw',
        version: 0,
        rating: 9999,
        rd: 300,
        sigma: 0.06,
      })),
    }
    await deniesWrite(
      'service_role',
      'select public.apply_rating($1::jsonb)',
      [JSON.stringify(payload)],
      'P0002',
    )
    await deniesWrite(
      'service_role',
      "insert into public.rating_history(user_id,format,kind,match_id,outcome,before_rating,before_rd,before_sigma,after_rating,after_rd,after_sigma,model_version) select user_id,'hu-duplicate','match',match_id,'draw',1500,350,.06,9999,300,.06,'glicko2.v1' from public.match_players where match_id=$1",
      [id],
    )
    const { rows } = await db.query<{
      hands: number
      proofs: number
      certificates: number
      history: number
    }>(
      `select
        (select count(*)::int from public.hands where match_id=$1) hands,
        (select count(*)::int from private.terminal_proofs where match_id=$1) proofs,
        (select count(*)::int from private.settlement_certificates where match_id=$1) certificates,
        (select count(*)::int from public.rating_history where match_id=$1) history`,
      [id],
    )
    expect(rows[0]).toEqual({
      hands: 0,
      proofs: 0,
      certificates: 0,
      history: 0,
    })
    await deniesWrite(
      'service_role',
      'select public.apply_rating($1::jsonb)',
      [JSON.stringify(payload)],
      'P0002',
    )
  })
})

describe('F07 SQL certificate fence', () => {
  it.each(['cancelled_before_deal', 'engine_fault'] as const)(
    'preserves %s as a void, never a winner',
    async (cause) => {
      const s = await seed('no_show', (source) => {
        const p = source.terminal!.proof
        p.cause = cause
        if (cause === 'cancelled_before_deal') {
          p.voluntaryCommandId = 'cancel-command'
          p.finishedAt = p.startDeadlineAt! - 1
        } else {
          p.reason = 'engine_fault'
          source.result.reason = 'engine_fault'
        }
      })
      const c = await certify(s)
      expect(c.disposition).toBe('void')
      await expect(rating(c)).rejects.toMatchObject({ code: 'P0002' })
    },
  )
  it.each([
    'manifest_duplicate',
    'manifest_missing',
    'participant',
    'terminal_reason',
    'private_cards',
  ] as const)(
    'invalidates the current certificate on %s source corruption',
    async (corruption) => {
      const s = await seed()
      await verify(s)
      const c = await certify(s)
      if (corruption === 'participant')
        await db.query(
          'update public.match_players set seat=4 where match_id=$1 and seat=1',
          [s.matchId],
        )
      else if (corruption === 'private_cards')
        await db.query(
          "update public.hands_private set holes=jsonb_set(holes,'{0}','[1,2]') where hand_id=$1",
          [s.hands[0].id],
        )
      else {
        const body = structuredClone(s.terminal)!
        if (corruption === 'manifest_duplicate')
          body.proof.completedHands[1] = body.proof.completedHands[0]
        if (corruption === 'manifest_missing') body.proof.completedHands.pop()
        if (corruption === 'terminal_reason') body.proof.reason = 'complete'
        await db.query(
          'update private.terminal_proofs set body=$2::jsonb where match_id=$1',
          [s.matchId, JSON.stringify(body)],
        )
      }
      await expect(rating(c)).rejects.toMatchObject({ code: 'P0002' })
      const audit = await rpc<SettlementSource>('audit_settlement', {
        matchId: s.matchId,
      })
      await expect(
        rpc('record_settlement_verdict', {
          matchId: s.matchId,
          sourceToken: audit.sourceToken,
          state: 'verified',
          certificate: c,
        }),
      ).rejects.toMatchObject({ code: '23514' })
    },
  )
  it('requires current hand.v2 evidence; rates exactly once, with returned historical result', async () => {
    const s = await seed()
    await expect(
      rpc('apply_rating', { matchId: s.matchId }),
    ).rejects.toMatchObject({ code: 'P0002' })
    await verify(s)
    const c = await certify(s)
    const tampered = structuredClone(c)
    tampered.adjustedBySeat[0] += 500
    await expect(
      rpc('record_settlement_verdict', {
        matchId: s.matchId,
        sourceToken: c.sourceToken,
        state: 'verified',
        certificate: tampered,
      }),
    ).rejects.toMatchObject({ code: '23514' })
    const first = await rating(c)
    expect(await rating(c)).toEqual(first)
    const count = await db.query<{ n: number }>(
      'select count(*)::int n from public.rating_history where match_id=$1',
      [s.matchId],
    )
    expect(count.rows[0].n).toBe(2)
    await expect(
      rating(c, {
        players: [
          { userId: USERS[0], outcome: 'win' },
          { userId: USERS[0], outcome: 'win' },
        ],
      }),
    ).rejects.toMatchObject({ code: '23514' })
  })
  it('supports the full normal 40-hand ordered manifest and rejects a gapped proof', async () => {
    const s = await seed('complete')
    await verify(s)
    const c = await certify(s)
    expect(c.disposition).toBe('rated')
    const broken = structuredClone(c)
    broken.manifest[0].handNo = 2
    await expect(
      rpc('record_settlement_verdict', {
        matchId: s.matchId,
        sourceToken: c.sourceToken,
        state: 'verified',
        certificate: broken,
      }),
    ).rejects.toMatchObject({ code: '23514' })
  }, 30_000)
  it('binds source tokens and invalidates certificates on edited luck or private evidence', async () => {
    const s = await seed()
    await verify(s)
    const c = await certify(s)
    const hand = await rpc<AuditedHand>('audit_hand', { id: s.hands[0].id })
    await db.query(
      "update public.hands set record=jsonb_set(record,'{luck,adjustedBySeat,0}','999') where id=$1",
      [hand.id],
    )
    expect(
      (await rpc<AuditedHand>('audit_hand', { id: hand.id })).verification,
    ).toBeNull()
    await expect(
      rpc('verify_hand_v2', {
        id: hand.id,
        sourceToken: hand.sourceToken,
        version: 'hand.v2',
        recordDigest: c.manifest[0].recordDigest,
        archiveDigest: c.manifest[0].archiveDigest,
      }),
    ).rejects.toMatchObject({ code: '40001' })
    await expect(rating(c)).rejects.toMatchObject({ code: 'P0002' })
    expect(
      await problemsWith(await rpc<AuditedHand>('audit_hand', { id: hand.id })),
    ).toContain('archive_source')
  })
  it('rejects stale source/certificate, wrong outcome, duplicate participants and optimistic versions atomically', async () => {
    const s = await seed()
    await verify(s)
    const c = await certify(s)
    await expect(rating(c, { sourceToken: 'old' })).rejects.toMatchObject({
      code: '40001',
    })
    await expect(
      rating(c, {
        players: c.players.map((p) => ({
          ...p,
          outcome: 'win',
          version: 0,
          rating: 1500,
          rd: 300,
          sigma: 0.06,
        })),
      }),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      rating(c, {
        players: c.players.map((p) => ({
          ...p,
          version: -1,
          rating: 1500,
          rd: 300,
          sigma: 0.06,
        })),
      }),
    ).rejects.toMatchObject({ code: '40001' })
    expect(
      (
        await db.query<{ n: number }>(
          'select count(*)::int n from public.rating_history where match_id=$1',
          [s.matchId],
        )
      ).rows[0].n,
    ).toBe(0)
    await rating(c)
  })
  it.each(['no_show', 'abandoned'] as const)(
    '%s has a valid void certificate, never a rating winner',
    async (reason) => {
      const s = await seed(reason)
      const c = await certify(s)
      expect(c.disposition).toBe('void')
      await expect(rating(c)).rejects.toMatchObject({ code: 'P0002' })
    },
  )
  it('out-of-order/missing hands wait; durable claims are bounded and retry after lease expiry', async () => {
    const s = await seed()
    let audit = await rpc<SettlementSource>('audit_settlement', {
      matchId: s.matchId,
    })
    expect((await inspectSettlement(audit)).state).toBe('waiting-for-evidence')
    const candidates = await rpc<{ matchId: string; hands: number[] }[]>(
      'settlement_candidates',
      { limit: 999 },
    )
    expect(candidates.length).toBeLessThanOrEqual(4)
    expect(candidates.every((c) => c.hands.length <= 2)).toBe(true)
    expect(
      await rpc('settlement_candidates', { limit: 999 }),
    ).not.toContainEqual(candidates[0])
    await verify(s)
    audit = await rpc('audit_settlement', { matchId: s.matchId })
    expect((await inspectSettlement(audit)).state).toBe('verified')
    await certify(s)
  })
  it('legacy remains unproven and anonymous/authenticated cannot write or see private certificates', async () => {
    await rpc('record_match', {
      id: MATCH,
      kind: 'hu-rated',
      config: {},
      players: USERS.map((userId, seat) => ({ userId, seat })),
      result: {
        reason: 'complete',
        adjustedBySeat: { 0: 0, 1: 0 },
        outcomeBySeat: { 0: 'draw', 1: 'draw' },
      },
    })
    const s = await rpc<SettlementSource>('audit_settlement', {
      matchId: MATCH,
    })
    expect((await inspectSettlement(s)).state).toBe('legacy-insufficient')
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`)
      try {
        await expect(
          db.query('select public.apply_rating($1::jsonb)', ['{}']),
        ).rejects.toMatchObject({ code: '42501' })
        await expect(
          db.query('select * from private.settlement_certificates'),
        ).rejects.toMatchObject({ code: '42501' })
        await expect(
          db.query('select public.record_settlement_verdict($1::jsonb)', [
            '{}',
          ]),
        ).rejects.toMatchObject({ code: '42501' })
      } finally {
        await db.exec('reset role')
      }
    }
  })
})

describe('F12/F13 played-time metrics', () => {
  it('F12 sums actual deltas despite delayed application and resets', async () => {
    const m1 = matchId(),
      m2 = matchId(),
      old = matchId()
    for (const id of [m1, m2, old])
      await rpc('record_match', {
        id,
        kind: 'hu-rated',
        config: {},
        players: [],
      })
    await db.query(
      "insert into public.ratings(user_id,format,rating,rd,matches,last_match_at) values($1,'6max',1600,50,30,now())",
      [USERS[0]],
    )
    for (const [id, before, after, days] of [
      [m1, 1500, 1510, 2],
      [m2, 1520, 1540, 1],
      [old, 1510, 1520, 40],
    ] as const)
      await db.query(
        "insert into public.rating_history(user_id,format,kind,match_id,outcome,before_rating,before_rd,before_sigma,after_rating,after_rd,after_sigma,model_version,played_at) values($1,'6max','match',$2,'win',$3,50,.06,$4,50,.06,'glicko2.v1',now()-($5||' days')::interval)",
        [USERS[0], id, before, after, days],
      )
    await db.query(
      "insert into public.rating_history(user_id,format,kind,before_rating,before_rd,before_sigma,after_rating,after_rd,after_sigma,model_version) values($1,'6max','reset',1540,50,.06,1600,50,.06,'reset')",
      [USERS[0]],
    )
    expect(
      (
        await db.query<{ trend: number }>(
          "select trend from public.ladder('6max')",
        )
      ).rows[0].trend,
    ).toBe(30)
    expect(
      (
        await db.query<{ trend: number }>(
          "select trend from public.ladder_month('6max')",
        )
      ).rows[0].trend,
    ).toBe(30)
  })
  it('F13 latest-500 ignores later archive/grade arrival for older play and orders decision indices', async () => {
    const newer = matchId(),
      older = matchId()
    for (const [id, at] of [
      [newer, T0],
      [older, T0 - 86_400_000],
    ] as const) {
      await rpc('record_match', {
        id,
        kind: 'hu-rated',
        config: {},
        players: USERS.map((userId, seat) => ({ userId, seat })),
      })
      const h = await handFixture(id)
      await rpc('record_hand', h.archive)
      await db.query(
        "update public.matches set status='finished',played_at=to_timestamp($2/1000.0),finished_at=now() where id=$1",
        [id, at],
      )
      await db.query('update public.hands set verified=true where id=$1', [
        h.id,
      ])
    }
    const grades = Array.from({ length: 501 }, (_, idx) => ({
      seat: 0,
      idx,
      grade: idx === 0 ? 'blunder' : 'best',
      accuracy: idx === 0 ? 0 : 100,
      evLost: 0,
      pot: 40,
    }))
    await rpc('record_grades', {
      handId: `${newer}:1`,
      format: 'hu-duplicate',
      modelVersion: 'test',
      grades,
    })
    await rpc('record_grades', {
      handId: `${older}:1`,
      format: 'hu-duplicate',
      modelVersion: 'test',
      grades: grades.map((g) => ({ ...g, grade: 'blunder', accuracy: 0 })),
    })
    const row = (
      await db.query<{ accuracy: number; graded: number; best: number }>(
        "select * from public.accuracy where user_id=$1 and format='hu-duplicate'",
        [USERS[0]],
      )
    ).rows[0]
    expect(row).toMatchObject({ accuracy: 100, graded: 500, best: 500 })
  })
})
