// @vitest-environment node
// The whole access matrix: every table the migrations create, as each kind
// of caller, for each kind of statement. Every write runs in a transaction
// that is rolled back, so each cell starts from the same rows.
//
//   anon     the browser before sign-in (publishable key)
//   self     a signed-in player, touching their own rows (alice -> alice)
//   other    a signed-in player, touching someone else's (alice -> bob)
//   service  the table server's secret key
//
// A cell is a row count (select: rows visible; update/delete: rows changed),
// 'ok' (an insert went through), 'denied' (a grant or RLS refused it) or
// 'allowed' (no access rule refused it; a constraint stopped it).
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrationFiles, MIGRATIONS_DIR, SUPABASE_STUB } from './harness'

const ALICE = '11111111-1111-4111-8111-111111111111'
const BOB = '22222222-2222-4222-8222-222222222222'
const M = '33333333-3333-4333-8333-333333333333'
const H = `${M}:1`

type Cell = number | 'ok' | 'denied' | 'allowed'
type Who = 'anon' | 'self' | 'other' | 'service'
const WHO: Who[] = ['anon', 'self', 'other', 'service']

let db: PGlite

class Rollback {
  constructor(readonly cell: Cell) {}
}

/** Runs one statement as `who` and rolls it back. */
async function cell(who: Who, sql: string): Promise<Cell> {
  const role =
    who === 'anon'
      ? 'anon'
      : who === 'service'
        ? 'service_role'
        : 'authenticated'
  const sub = who === 'self' || who === 'other' ? ALICE : ''
  try {
    await db.transaction(async (tx) => {
      await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
        sub,
      ])
      await tx.exec(`set local role ${role}`)
      const result = await tx.query<{ n: number }>(sql)
      throw new Rollback(
        /^\s*select/i.test(sql)
          ? Number(result.rows[0].n)
          : /^\s*insert/i.test(sql)
            ? 'ok'
            : (result.affectedRows ?? 0),
      )
    })
  } catch (error) {
    if (error instanceof Rollback) return error.cell
    if (/permission denied|row-level security/.test(String(error)))
      return 'denied'
    return 'allowed'
  }
  throw new Error('unreachable')
}

/** Statements for one table; `u` is the account whose rows are targeted. */
type Spec = {
  select: (u: string) => string
  insert: (u: string) => string
  update: (u: string) => string
  remove: (u: string) => string
}
const owned = (
  table: string,
  set: string,
  insert: (u: string) => string,
): Spec => ({
  select: (u) => `select count(*) n from ${table} where user_id = '${u}'`,
  insert,
  update: (u) => `update ${table} set ${set} where user_id = '${u}'`,
  remove: (u) => `delete from ${table} where user_id = '${u}'`,
})
const shared = (table: string, set: string, insert: string): Spec => ({
  select: () => `select count(*) n from ${table}`,
  insert: () => insert,
  update: () => `update ${table} set ${set}`,
  remove: () => `delete from ${table}`,
})

const TABLES: Record<string, Spec> = {
  'public.players': owned(
    'public.players',
    'bio = bio',
    (u) =>
      `insert into public.players (user_id, username) values ('${u}', 'newname') on conflict do nothing`,
  ),
  'public.matches': shared(
    'public.matches',
    'config = config',
    `insert into public.matches (id, config) values (gen_random_uuid(), '{}')`,
  ),
  'public.match_players': owned(
    'public.match_players',
    'timeouts = timeouts',
    (u) =>
      `insert into public.match_players (match_id, user_id, seat) values ('${M}', '${u}', 5) on conflict do nothing`,
  ),
  'public.hands': shared(
    'public.hands',
    'verified = verified',
    `insert into public.hands (id, match_id, hand_no, button, commitment, leaves, reveal, record)
     values ('${M}:9', '${M}', 9, 0, repeat('a', 64), decode(repeat('00', 1664), 'hex'), '[]', '{}')`,
  ),
  'public.hands_private': shared(
    'public.hands_private',
    'holes = holes',
    `insert into public.hands_private (hand_id, deck, secret, holes)
     values ('${H}', array(select generate_series(0, 51))::smallint[], decode(repeat('00', 32), 'hex'), '{}')
     on conflict do nothing`,
  ),
  'public.hand_holes': owned(
    'public.hand_holes',
    'cards = cards',
    (u) =>
      `insert into public.hand_holes (hand_id, user_id, cards) values ('${H}', '${u}', '{1,2}') on conflict do nothing`,
  ),
  'public.hand_grades': owned(
    'public.hand_grades',
    'accuracy = accuracy',
    (u) =>
      `insert into public.hand_grades (hand_id, seat, idx, user_id, format, grade, ev_lost, accuracy, model_version)
       values ('${H}', 0, 7, '${u}', 'hu-duplicate', 'best', 0, 100, 'x') on conflict do nothing`,
  ),
  'public.ratings': owned(
    'public.ratings',
    'rating = rating',
    (u) =>
      `insert into public.ratings (user_id, format) values ('${u}', '6max') on conflict do nothing`,
  ),
  'public.rating_history': owned(
    'public.rating_history',
    'after_rating = after_rating',
    (u) =>
      `insert into public.rating_history (user_id, format, kind, before_rating, before_rd, before_sigma, after_rating, after_rd, after_sigma, model_version)
       values ('${u}', 'hu-duplicate', 'reset', 1500, 350, 0.06, 1500, 350, 0.06, 'x')`,
  ),
  'public.accuracy': owned(
    'public.accuracy',
    'accuracy = accuracy',
    (u) =>
      `insert into public.accuracy (user_id, format) values ('${u}', '6max') on conflict do nothing`,
  ),
  'public.abandonments': owned(
    'public.abandonments',
    'kind = kind',
    (u) =>
      `insert into public.abandonments (user_id, kind) values ('${u}', 'no_show')`,
  ),
  'public.incidents': shared(
    'public.incidents',
    'kind = kind',
    `insert into public.incidents (kind, detail) values ('x', '{}')`,
  ),
  'public.profiles': owned(
    'public.profiles',
    'display_name = display_name',
    (u) =>
      `insert into public.profiles (user_id) values ('${u}') on conflict do nothing`,
  ),
  'public.hand_results': owned(
    'public.hand_results',
    'net = net',
    (u) =>
      `insert into public.hand_results (user_id, id, hand_number, net, result, guided)
       values ('${u}', 's:99', 1, 0, 'x', false) on conflict do nothing`,
  ),
  'public.lesson_progress': owned(
    'public.lesson_progress',
    'completed_at = completed_at',
    (u) =>
      `insert into public.lesson_progress (user_id, lens) values ('${u}', 'options') on conflict do nothing`,
  ),
  'public.practice_attempts': owned(
    'public.practice_attempts',
    'correct = correct',
    (u) =>
      `insert into public.practice_attempts (user_id, id, lens, stage, answer_id, correct, context)
       values ('${u}', gen_random_uuid(), 'equity', 'prediction', 'a', true, '{}')`,
  ),
  'public.coach_messages': owned(
    'public.coach_messages',
    'label = label',
    (u) =>
      `insert into public.coach_messages (user_id, id, role, text, snapshot_id, label)
       values ('${u}', gen_random_uuid(), 'user', 'hi', 's', 'l')`,
  ),
  'public.school_domains': {
    select: () =>
      `select count(*) n from public.school_domains where domain = 'mit.edu'`,
    insert: () =>
      `insert into public.school_domains (domain, school, country) values ('evil.edu', 'Evil', 'US')`,
    update: () =>
      `update public.school_domains set school = 'MIT' where domain = 'mit.edu'`,
    remove: () => `delete from public.school_domains where domain = 'mit.edu'`,
  },
  'public.challenge_scores': owned(
    'public.challenge_scores',
    'accuracy = accuracy',
    (u) =>
      `insert into public.challenge_scores (user_id, hand, ver, accuracy, receipt, played_at)
       values ('${u}', 'nut-draw', 1, 50, repeat('e', 32), now()) on conflict do nothing`,
  ),
  'public.practice_hands': owned(
    'public.practice_hands',
    'record = record',
    (u) =>
      `insert into public.practice_hands (user_id, id, played_at, record)
       values ('${u}', 'h:new', now(), '{"id": "h:new"}') on conflict do nothing`,
  ),
  'public.learning_state': owned(
    'public.learning_state',
    'trainer = trainer',
    (u) =>
      `insert into public.learning_state (user_id) values ('${u}') on conflict do nothing`,
  ),
  'public.avatar_reports': {
    select: (u) =>
      `select count(*) n from public.avatar_reports where reporter = '${u}'`,
    insert: (u) =>
      `insert into public.avatar_reports (reporter, player)
       values ('${u}', '${u === ALICE ? BOB : ALICE}') on conflict do nothing`,
    update: (u) =>
      `update public.avatar_reports set day = day where reporter = '${u}'`,
    remove: (u) => `delete from public.avatar_reports where reporter = '${u}'`,
  },
  'private.coach_usage': shared(
    'private.coach_usage',
    'used = used',
    `insert into private.coach_usage (scope, window_start) values ('x', now())`,
  ),
}

// Protected RPC-backed tables: no synthetic direct-write fixtures.
// Owner filtering and RPC behavior are exercised in the dedicated SQL suites.
const PROTECTED: Record<
  string,
  { authenticated?: string[]; service_role?: string[] }
> = {
  'public.learning_sync_scopes': { authenticated: ['SELECT'] },
  'public.learning_revisions': { authenticated: ['SELECT'] },
  'public.learning_mutations': {},
  'public.learning_evidence_events': { authenticated: ['SELECT'] },
  'public.learning_evidence_evaluations': { authenticated: ['SELECT'] },
  'public.learning_assessment_issues': { authenticated: ['SELECT'] },
  'public.learning_pilot_protocols': {
    service_role: ['SELECT', 'INSERT', 'UPDATE'],
  },
  'public.learning_pilot_assignments': {
    authenticated: ['SELECT'],
    service_role: ['SELECT', 'INSERT', 'UPDATE'],
  },
  'private.hand_archive_sources': {},
  'private.hand_verifications': {},
  'private.terminal_proofs': {},
  'private.settlement_certificates': {},
  'private.settlement_jobs': {},
}
const D = 'denied' as const
const PUBLIC_READ = {
  anon: [1, D, D, D],
  self: [1, D, D, D],
  other: [1, D, D, D],
}
const PRIVATE = { anon: [D, D, D, D], self: [D, D, D, D], other: [D, D, D, D] }
const OWN_ONLY = {
  anon: [D, D, D, D],
  self: [1, 'ok', 1, 1],
  other: [0, D, 0, 0],
}
const SERVICE = { service: [1, 'ok', 1, 1] }

/** Expected [select, insert, update, delete] per caller. */
const EXPECTED: Record<string, Record<Who, Cell[]>> = {
  // Public profiles: anyone reads; a player edits only their own name, country
  // and bio; nobody but the server creates or deletes one (a player row is
  // referenced by history, so even the server's delete stops at a key).
  'public.players': {
    anon: [1, D, D, D],
    self: [1, D, 1, D],
    other: [1, D, 0, D],
    service: [1, 'ok', 1, 'allowed'],
  },
  'public.matches': { ...PUBLIC_READ, ...SERVICE },
  'public.match_players': { ...PUBLIC_READ, ...SERVICE },
  // Public once the match is over; the fixture's match is still in play, so
  // no client reads its hand (hands-live.test.ts covers both states).
  'public.hands': {
    anon: [0, D, D, D],
    self: [0, D, D, D],
    other: [0, D, D, D],
    ...SERVICE,
  },
  'public.abandonments': { ...PUBLIC_READ, ...SERVICE },
  // The deck, the hand secret and every hole card: the server only.
  'public.hands_private': { ...PRIVATE, ...SERVICE },
  'public.incidents': { ...PRIVATE, ...SERVICE },
  // Each player reads their own hole cards and nobody else's; nobody writes.
  'public.hand_holes': {
    anon: [D, D, D, D],
    self: [1, D, D, D],
    other: [0, D, D, D],
    ...SERVICE,
  },
  // Grades are analysis: while the match plays (as it does here) nobody but
  // the server reads one, not even its own player; after it, the match's
  // two players read both seats (supabase/tests/grades.test.ts).
  'public.hand_grades': {
    anon: [D, D, D, D],
    self: [0, D, D, D],
    other: [0, D, D, D],
    ...SERVICE,
  },
  // The accuracy on every profile: anyone reads it, only the server's
  // refresh writes it (supabase/tests/accuracy.test.ts).
  'public.accuracy': { ...PUBLIC_READ, ...SERVICE },
  // F07: public reads; service writes must use the definer-owned rating gate
  // or abandonment accounting, never direct DML (verified-settlement.test.ts).
  'public.ratings': { ...PUBLIC_READ, service: [1, D, D, D] },
  // F07: deny before append-only triggers, including forged history inserts.
  'public.rating_history': {
    ...PUBLIC_READ,
    service: [1, D, D, D],
  },
  // The earlier app's learning tables: strictly per owner.
  'public.profiles': { ...OWN_ONLY, ...SERVICE },
  'public.hand_results': { ...OWN_ONLY, ...SERVICE },
  'public.lesson_progress': { ...OWN_ONLY, ...SERVICE },
  'public.practice_attempts': { ...OWN_ONLY, ...SERVICE },
  'public.coach_messages': { ...OWN_ONLY, ...SERVICE },
  // The school list: anyone reads it (onboarding shows the name), only
  // migrations write it.
  'public.school_domains': { ...PUBLIC_READ, ...SERVICE },
  // A player reads their own challenge scores; only the server's
  // record_challenge_claim writes them (supabase/tests/landing.test.ts).
  'public.challenge_scores': {
    anon: [D, D, D, D],
    self: [1, D, D, D],
    other: [0, D, D, D],
    ...SERVICE,
  },
  // Practice history on the account: strictly per owner. The learning state
  // is replaced, never deleted (practice-history.test.ts covers the guards).
  'public.practice_hands': {
    anon: [D, D, D, D],
    self: [1, D, D, D],
    other: [0, D, D, D],
    service: [1, D, D, D],
  },
  'public.learning_state': {
    anon: [D, D, D, D],
    self: [1, D, D, D],
    other: [0, D, D, D],
    service: [1, D, D, D],
  },
  // Picture reports: a player adds them in their own name only, and nobody
  // but the server reads, changes or deletes one (avatars.test.ts).
  'public.avatar_reports': {
    anon: [D, D, D, D],
    self: [D, 'ok', D, D],
    other: [D, D, D, D],
    ...SERVICE,
  },
  // Only reachable through reserve_coach_request (security definer). In this
  // stub service_role has no usage on schema private either; on Supabase the
  // grants may differ, which does not change what browsers can do.
  'private.coach_usage': { ...PRIVATE, service: [D, D, D, D] },
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(SUPABASE_STUB)
  for (const file of migrationFiles())
    await db.exec(readFileSync(new URL(file, MIGRATIONS_DIR), 'utf8'))
  await db.exec(`
    insert into auth.users (id, email_confirmed_at) values ('${ALICE}', now()), ('${BOB}', now());
    insert into public.matches (id, config) values ('${M}', '{}');
    insert into public.match_players (match_id, user_id, seat) values ('${M}', '${ALICE}', 0), ('${M}', '${BOB}', 1);
    insert into public.hands (id, match_id, hand_no, button, commitment, leaves, reveal, record)
      values ('${H}', '${M}', 1, 0, repeat('b', 64), decode(repeat('00', 1664), 'hex'), '[]', '{}');
    insert into public.hands_private (hand_id, deck, secret, holes)
      values ('${H}', array(select generate_series(0, 51))::smallint[], decode(repeat('01', 32), 'hex'), '{}');
    insert into public.hand_holes (hand_id, user_id, cards) values ('${H}', '${ALICE}', '{0,1}'), ('${H}', '${BOB}', '{2,3}');
    insert into public.hand_grades (hand_id, seat, idx, user_id, format, grade, ev_lost, accuracy, model_version)
      values ('${H}', 0, 0, '${ALICE}', 'hu-duplicate', 'best', 0, 100, 'x'),
             ('${H}', 1, 1, '${BOB}', 'hu-duplicate', 'good', 1, 90, 'x');
    insert into public.ratings (user_id, format) values ('${ALICE}', 'hu-duplicate'), ('${BOB}', 'hu-duplicate');
    insert into public.rating_history (user_id, format, kind, before_rating, before_rd, before_sigma, after_rating, after_rd, after_sigma, model_version)
      values ('${ALICE}', 'hu-duplicate', 'reset', 1500, 350, 0.06, 1500, 350, 0.06, 'x'),
             ('${BOB}', 'hu-duplicate', 'reset', 1500, 350, 0.06, 1500, 350, 0.06, 'x');
    insert into public.accuracy (user_id, format, accuracy, graded, best) values ('${ALICE}', 'hu-duplicate', 100, 1, 1), ('${BOB}', 'hu-duplicate', 90, 1, 0);
    insert into public.abandonments (user_id, match_id, kind) values ('${ALICE}', '${M}', 'no_show'), ('${BOB}', '${M}', 'no_show');
    insert into public.incidents (kind, detail) values ('seed', '{}');
    insert into public.profiles (user_id) values ('${ALICE}'), ('${BOB}');
    insert into public.hand_results (user_id, id, hand_number, net, result, guided)
      values ('${ALICE}', 's:1', 1, 0, 'x', false), ('${BOB}', 's:1', 1, 0, 'x', false);
    insert into public.lesson_progress (user_id, lens) values ('${ALICE}', 'equity'), ('${BOB}', 'equity');
    insert into public.practice_attempts (user_id, id, lens, stage, answer_id, correct, context)
      values ('${ALICE}', gen_random_uuid(), 'equity', 'prediction', 'a', true, '{}'),
             ('${BOB}', gen_random_uuid(), 'equity', 'prediction', 'a', true, '{}');
    insert into public.coach_messages (user_id, id, role, text, snapshot_id, label)
      values ('${ALICE}', gen_random_uuid(), 'user', 'hi', 's', 'l'),
             ('${BOB}', gen_random_uuid(), 'user', 'hi', 's', 'l');
    insert into private.coach_usage (scope, window_start) values ('seed', now());
    insert into public.practice_hands (user_id, id, played_at, record)
      values ('${ALICE}', 'h:1', now(), '{"id": "h:1"}'),
             ('${BOB}', 'h:1', now(), '{"id": "h:1"}');
    insert into public.learning_state (user_id) values ('${ALICE}'), ('${BOB}');
    insert into public.avatar_reports (reporter, player) values ('${ALICE}', '${BOB}'), ('${BOB}', '${ALICE}');
    insert into public.challenge_scores (user_id, hand, ver, accuracy, receipt, played_at)
      values ('${ALICE}', 'overpair', 1, 80, repeat('a', 32), now()),
             ('${BOB}', 'overpair', 1, 70, repeat('b', 32), now());
  `)
}, 60_000)

afterAll(() => db?.close())

describe('the access matrix', () => {
  it('covers every table the migrations create', async () => {
    const { rows } = await db.query<{ t: string }>(
      `select schemaname || '.' || tablename t from pg_tables
       where schemaname in ('public', 'private') order by 1`,
    )
    expect(rows.map((r) => r.t)).toEqual(
      [...Object.keys(TABLES), ...Object.keys(PROTECTED)].sort(),
    )
    expect(Object.keys(EXPECTED).sort()).toEqual(Object.keys(TABLES).sort())
  })

  it('F07–F10 protected source and certificate tables have exactly the allowed grants', async () => {
    for (const [table, roles] of Object.entries(PROTECTED))
      for (const role of ['anon', 'authenticated', 'service_role'] as const)
        for (const permission of [
          'SELECT',
          'INSERT',
          'UPDATE',
          'DELETE',
          'TRUNCATE',
        ]) {
          const { rows } = await db.query<{ allowed: boolean }>(
            'select has_table_privilege($1,$2,$3) allowed',
            [role, table, permission],
          )
          expect(rows[0].allowed, `${table} ${role} ${permission}`).toBe(
            role !== 'anon' && !!roles[role]?.includes(permission),
          )
        }
  })

  it('has RLS on every table a browser role could reach', async () => {
    const { rows } = await db.query<{ t: string }>(
      `select n.nspname || '.' || c.relname t from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where c.relkind = 'r' and n.nspname in ('public', 'private')
         and not c.relrowsecurity`,
    )
    expect(rows).toEqual([])
  })

  for (const [table, spec] of Object.entries(TABLES))
    it(`holds for ${table}`, async () => {
      const seen: Record<string, Cell[]> = {}
      for (const who of WHO) {
        const u = who === 'other' ? BOB : ALICE
        seen[who] = [
          await cell(who, spec.select(u)),
          await cell(who, spec.insert(u)),
          await cell(who, spec.update(u)),
          await cell(who, spec.remove(u)),
        ]
      }
      expect(seen).toEqual(EXPECTED[table])
    })
})

describe('functions', () => {
  type Fn = {
    name: string
    definer: boolean
    config: string[] | null
    anon: boolean
    authenticated: boolean
  }
  const fns = async () =>
    (
      await db.query<Fn>(
        `select n.nspname || '.' || p.proname name, p.prosecdef definer,
                p.proconfig config,
                has_function_privilege('anon', p.oid, 'execute') anon,
                has_function_privilege('authenticated', p.oid, 'execute') authenticated
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname in ('public', 'private') order by 1`,
      )
    ).rows

  it('pin search_path and allow only the named account-scoped security definers to browsers', async () => {
    const all = await fns()
    expect(all.map((f) => f.name)).toEqual(
      [
        'private.apply_rating_pre_certificate',
        'private.check_assessment_issue',
        'private.check_certificate',
        'private.export_learning_pilot_pre_measurement',
        'private.hand_source',
        'private.invalidate_settlement',
        'private.record_hand_pre_certificate',
        'private.settlement_source',
        'private.source_token',
        'private.count_abandonment',
        'private.learning_state_newer',
        'private.player_accuracy',
        'private.practice_hands_guard',
        'private.rating_change',
        'private.refresh_accuracy',
        'private.refresh_finished_match',
        'private.refuse_change',
        'private.school_for',
        'private.set_player_school',
        'public.abandonment_rate',
        'public.apply_rating',
        'public.audit_settlement',
        'public.clear_learning_scope_v1',
        'public.export_learning_pilot_v1',
        'public.ingest_learning_evidence_v1',
        'public.issue_learning_assessment_v1',
        'public.learning_pilot_consent_v1',
        'public.purge_learning_evidence_generation_v1',
        'public.read_learning_evidence_v1',
        'public.read_learning_sync_v1',
        'public.record_settlement_verdict',
        'public.record_terminal',
        'public.settlement_candidates',
        'public.verify_hand_v2',
        'public.write_learning_revision_v1',
        'public.audit_hand',
        'public.clear_learning_progress',
        'public.handle_new_player',
        'public.ladder',
        'public.ladder_month',
        'public.rated_luck',
        'public.record_challenge_claim',
        'public.record_grades',
        'public.record_hand',
        'public.record_incident',
        'public.record_match',
        'public.remove_avatar',
        'public.report_avatar',
        'public.reserve_coach_request',
        'public.set_avatar',
        'public.set_player_school',
        'public.verify_hand',
      ].sort(),
    )
    for (const f of all) {
      expect(f.config, f.name).toContain('search_path=""')
      if (f.definer) {
        expect(f.anon, `${f.name} anon`).toBe(false)
        expect(f.authenticated, `${f.name} authenticated`).toBe(
          [
            'public.clear_learning_scope_v1',
            'public.read_learning_sync_v1',
            'public.write_learning_revision_v1',
            'public.ingest_learning_evidence_v1',
            'public.read_learning_evidence_v1',
            'public.learning_pilot_consent_v1',
            'public.issue_learning_assessment_v1',
          ].includes(f.name),
        )
      }
    }
  })

  it('let a signed-in player clear only their own learning progress', async () => {
    const cleared = await cell(
      'self',
      `select count(*) n from (select public.clear_learning_progress()) x`,
    )
    expect(cleared).toBe(1)
    expect(
      await cell(
        'anon',
        `select count(*) n from (select public.clear_learning_progress()) x`,
      ),
    ).toBe('denied')
  })
})
