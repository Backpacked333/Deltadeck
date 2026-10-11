// DBA review bench: query plans and timings for the queries the app runs now
// and the ones Phase 1 will run, over generated data, plus bytes per hand
// from real archive payloads and self-checks of the proposed Phase 1 rules.
//
//   node supabase/bench/plans.ts            # 10k, 100k, 1M
//   node supabase/bench/plans.ts 10000      # one scale
//
// PGlite is Postgres 17 compiled to WASM with one connection and a small
// memory budget: plans (which index, which join) carry over to the hosted
// database; absolute times do not (hosted is usually faster). Nothing here
// touches a real database. Scale N = matches; match_players 2N; players N/20
// (skewed, so a few play a lot); abandonments ~3% of finished seats; ratings
// one per player; rating_history two per rated match; hands, hand_holes and
// hand_grades N (hands of the first N/20 matches; realistic sizes up to
// 100k, then slim leaves so 1M fits in memory).
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import {
  migrationFiles,
  MIGRATIONS_DIR,
  SUPABASE_STUB,
} from '../tests/harness.ts'

type Row = Record<string, unknown>
const scales = process.argv.slice(2).map(Number)
if (!scales.length) scales.push(10_000, 100_000, 1_000_000)

const PROPOSED = new URL('../proposed/phase1.sql', import.meta.url)
const PAYLOADS = JSON.parse(
  readFileSync(new URL('./payloads.json', import.meta.url), 'utf8'),
) as { record_match: Row[]; record_hand: Row[] }

async function fresh() {
  const db = new PGlite()
  await db.exec(SUPABASE_STUB)
  for (const f of migrationFiles())
    await db.exec(readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'))
  await db.exec(readFileSync(PROPOSED, 'utf8'))
  return db
}

const t = () => performance.now()

async function generate(db: PGlite, n: number) {
  const players = Math.max(200, Math.floor(n / 20))
  const handsN = n
  const slim = handsN > 100_000
  const sql = `
    select setseed(0.42);
    insert into auth.users (id) select gen_random_uuid() from generate_series(1, ${players});
    create temp table u as
      select (row_number() over (order by user_id) - 1)::int as i, user_id from public.players;
    create unique index on u (i);

    create temp table pairs as
      select gen_random_uuid() as id,
             case when random() < 0.7 then 'hu-rated' else 'hu-casual' end as kind,
             x, now() - random() * interval '365 days' as at,
             floor(${players} * random() ^ 2)::int as a,
             floor(random() * (${players} - 1))::int as d,
             random() as r
      from (select random() x from generate_series(1, ${n})) g;
    alter table pairs add column b int;
    update pairs set b = (a + 1 + d) % ${players};

    insert into public.matches (id, kind, status, config, result, created_at, finished_at)
    select id, kind,
           case when x < 0.95 then 'finished' when x < 0.98 then 'void' else 'playing' end,
           '{"kind":"hu-casual","handsTotal":20,"startingStack":2000,"blinds":{"sb":10,"bb":20},"decisionMs":20000,"bankMs":60000}',
           case when x < 0.98 then '{"netBySeat":{"0":120,"1":-120},"reason":"complete"}'::jsonb end,
           at, case when x < 0.98 then at + interval '15 minutes' end
    from pairs;

    insert into public.match_players (match_id, user_id, seat, net_chips, abandoned, finished_at, outcome)
    select p.id, u.user_id, 0, case when r < 0.5 then 120 else -120 end,
           x < 0.95 and r > 0.97, case when x < 0.98 then at + interval '15 minutes' end,
           case when kind = 'hu-rated' and x < 0.95 then case when r < 0.45 then 'win' when r < 0.55 then 'draw' else 'loss' end end
    from pairs p join u on u.i = p.a;
    insert into public.match_players (match_id, user_id, seat, net_chips, abandoned, finished_at, outcome)
    select p.id, u.user_id, 1, case when r < 0.5 then -120 else 120 end,
           x < 0.95 and r < 0.03, case when x < 0.98 then at + interval '15 minutes' end,
           case when kind = 'hu-rated' and x < 0.95 then case when r < 0.45 then 'loss' when r < 0.55 then 'draw' else 'win' end end
    from pairs p join u on u.i = p.b;

    insert into public.abandonments (user_id, match_id, hand_no, kind, at)
    select mp.user_id, mp.match_id, 7, 'timeout_x3', p.at + interval '10 minutes'
    from public.match_players mp join pairs p on p.id = mp.match_id
    where mp.abandoned;

    insert into public.ratings (user_id, format, rating, rd, sigma, matches, wins, draws,
      abandoned, last_match_at, version)
    select user_id, 'hu-duplicate', 1200 + random() * 600, 40 + random() * 310, 0.06,
           m, floor(m * 0.45)::int, floor(m * 0.1)::int,
           floor(m * random() ^ 2 * 0.25)::int,
           now() - random() * interval '60 days', 1
    from (select user_id, floor(random() * 200)::int as m from u) s;

    insert into public.accuracy (user_id, format, accuracy, graded)
    select user_id, 'hu-duplicate', 60 + random() * 40, 500 from u;

    insert into public.rating_history (user_id, format, kind, match_id, outcome,
      before_rating, before_rd, before_sigma, after_rating, after_rd, after_sigma,
      model_version, created_at, played_at)
    select mp.user_id, 'hu-duplicate', 'match', mp.match_id, mp.outcome,
           1500, 120, 0.06, 1500 + (random() - 0.5) * 30, 118, 0.06, 'glicko2.v1', p.at, p.at
    from public.match_players mp join pairs p on p.id = mp.match_id
    where mp.outcome is not null;

    create temp table hand_matches as
      select id, at, row_number() over (order by at) as k from pairs where x < 0.95
      order by at limit ${Math.ceil(handsN / 20)};
  `
  const t0 = t()
  await db.exec(sql)
  // Leaves are incompressible in real life (SHA-256 output); 1M realistic
  // rows (~4 GB) does not fit in PGlite's memory, so the 1M run stores one
  // byte and drops the length check, which only changes row width.
  if (slim)
    await db.exec('alter table public.hands drop constraint hands_leaves_check')
  const leaves = slim
    ? `'\\x00'::bytea`
    : `(select decode(string_agg(md5(hm.k::text || ':' || s::text), ''), 'hex') from generate_series(1, 104) s)`
  await db.exec(`
    insert into public.hands (id, match_id, hand_no, segment, button, commitment, leaves, reveal, record, verified, created_at)
    select hm.id || ':' || h, hm.id, h, 1, h % 2, md5(hm.id::text || h) || md5(h || hm.id::text),
           ${leaves},
           '[]'::jsonb, $$${JSON.stringify(PAYLOADS.record_hand[0].record)}$$::jsonb,
           random() < 0.99, hm.at + h * interval '40 seconds'
    from hand_matches hm, generate_series(1, 20) h;
    insert into public.hands_private (hand_id, deck, secret, holes)
    select id, array(select generate_series(0, 51))::smallint[], decode(md5(id) || md5(id || 'x'), 'hex'), '{"0":[1,2],"1":[3,4]}'
    from public.hands;
    insert into public.hand_holes (hand_id, user_id, cards)
    select h.id, mp.user_id, '{1,2}' from public.hands h join public.match_players mp on mp.match_id = h.match_id;
    insert into public.hand_grades (hand_id, seat, idx, user_id, format, grade, ev_lost, accuracy, model_version, created_at)
    select h.id, mp.seat, 0, mp.user_id, 'hu-duplicate', 'good', random() * 5, 60 + random() * 40, 'grade.v1', h.created_at
    from public.hands h join public.match_players mp on mp.match_id = h.match_id and mp.seat = (h.hand_no % 2);
    analyze;
  `)
  const counts = (
    await db.query<Row>(`select
      (select count(*) from public.players)::int players,
      (select count(*) from public.matches)::int matches,
      (select count(*) from public.match_players)::int match_players,
      (select count(*) from public.abandonments)::int abandonments,
      (select count(*) from public.ratings)::int ratings,
      (select count(*) from public.rating_history)::int rating_history,
      (select count(*) from public.hands)::int hands,
      (select count(*) from public.hand_grades)::int hand_grades`)
  ).rows[0]
  return { counts, seconds: (t() - t0) / 1000, slim }
}

/** Median execution time of EXPLAIN ANALYZE, and the plan's node lines. */
async function plan(
  db: PGlite,
  sql: string,
  params: unknown[] = [],
  role?: string,
) {
  const times: number[] = []
  let lines: string[] = []
  for (let i = 0; i < 3; i++) {
    // A client role plans with its RLS policies, as PostgREST runs it.
    if (role) await db.exec(`set role ${role}`)
    const rows = (
      await db
        .query<{
          'QUERY PLAN': string
        }>(
          `explain (analyze, costs off, timing off, summary on) ${sql}`,
          params,
        )
        .finally(() => role && db.exec('reset role'))
    ).rows.map((r) => r['QUERY PLAN'])
    const exec = rows.find((l) => l.startsWith('Execution Time'))
    times.push(Number(exec?.match(/([\d.]+) ms/)?.[1]))
    lines = rows.filter(
      (l) => !/^(Planning|Execution) Time|^\s*(Rows Removed|Buffers)/.test(l),
    )
  }
  times.sort((a, b) => a - b)
  return { ms: times[1], lines }
}

/** The plan in one line: its scans and joins, with the indexes they use. */
const shape = (lines: string[]) =>
  lines
    .map((l) => l.replace(/^[\s->]+/, '').replace(/\s*\(actual.*$/, ''))
    .filter((l) =>
      /Scan|Join|Nested Loop|Sort|Limit|Aggregate|Hash|Function Scan/.test(l),
    )
    .slice(0, 6)
    .join(' → ')

async function queries(db: PGlite) {
  const pick = async (sql: string) =>
    Object.values((await db.query<Row>(sql)).rows[0])[0]
  const heavy = await pick(
    `select user_id from public.match_players group by user_id order by count(*) desc limit 1`,
  )
  const typical = await pick(
    `select user_id from u where i = (select count(*) / 2 from u)`,
  )
  const pairA = await pick(
    `select user_id from public.match_players mp join public.matches m on m.id = mp.match_id order by m.created_at desc limit 1`,
  )
  const pairB = await pick(
    `select mp.user_id from public.match_players mp join public.matches m on m.id = mp.match_id where mp.user_id <> '${pairA}' and mp.match_id = (select mp2.match_id from public.match_players mp2 join public.matches m2 on m2.id = mp2.match_id where mp2.user_id = '${pairA}' order by m2.created_at desc limit 1)`,
  )
  const someMatch = await pick(`select match_id from public.hands limit 1`)
  const someHand = await pick(`select id from public.hands limit 1`)
  const handUser = await pick(
    `select user_id from public.hand_holes where hand_id = '${someHand}' limit 1`,
  )
  const graded = await pick(
    `select user_id from public.hand_grades group by user_id order by count(*) desc limit 1`,
  )
  const page1 = (
    await db.query<{ rating: number; user_id: string }>(
      `select rating, user_id from public.ladder('hu-duplicate') offset 49 limit 1`,
    )
  ).rows[0]

  const profile = `
    select m.id, m.kind, m.status, m.finished_at, mp.net_chips, mp.outcome, op.username
    from public.match_players mp
    join public.matches m on m.id = mp.match_id
    join public.match_players o on o.match_id = mp.match_id and o.user_id <> mp.user_id
    join public.players op on op.user_id = o.user_id
    where mp.user_id = $1 and m.status <> 'playing'
    order by m.finished_at desc nulls last limit 20`
  // The same page from match_players.finished_at (proposed): the index hands
  // over the newest 20 seats and only those are joined.
  const profileDirect = `
    select m.id, m.kind, m.status, mp.finished_at, mp.net_chips, mp.outcome, op.username
    from (select match_id, user_id, finished_at, net_chips, outcome
          from public.match_players
          where user_id = $1 and finished_at is not null
          order by finished_at desc limit 20) mp
    join public.matches m on m.id = mp.match_id
    join public.match_players o on o.match_id = mp.match_id and o.user_id <> mp.user_id
    join public.players op on op.user_id = o.user_id
    order by mp.finished_at desc`
  const list: [string, string, string, unknown[], string?][] = [
    [
      'Q1',
      'Profile: last 20 matches, join on matches (heaviest player)',
      profile,
      [heavy],
    ],
    [
      'Q1b',
      'Profile: last 20 matches, join on matches (typical player)',
      profile,
      [typical],
    ],
    [
      'Q1c',
      'Profile: last 20 matches from match_players.finished_at (heaviest)',
      profileDirect,
      [heavy],
    ],
    [
      'Q2',
      'Match history, next page (keyset on finished_at)',
      `select m.id, m.finished_at, mp.net_chips, mp.outcome
       from public.match_players mp join public.matches m on m.id = mp.match_id
       where mp.user_id = $1 and m.status <> 'playing'
         and m.finished_at < now() - interval '90 days'
       order by m.finished_at desc limit 20`,
      [heavy],
    ],
    [
      'Q2b',
      'Match history, next page from match_players.finished_at (heaviest)',
      `select mp.match_id, mp.finished_at, mp.net_chips, mp.outcome
       from public.match_players mp
       where mp.user_id = $1 and mp.finished_at is not null
         and mp.finished_at < now() - interval '90 days'
       order by mp.finished_at desc limit 20`,
      [heavy],
    ],
    [
      'Q3',
      'Same pair, rated pairings today (≤ 2/day rule)',
      `select count(*) from public.match_players a
       join public.match_players b on b.match_id = a.match_id and b.user_id = $2
       join public.matches m on m.id = a.match_id
       where a.user_id = $1 and m.kind = 'hu-rated'
         and m.created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'`,
      [pairA, pairB],
    ],
    [
      'Q4',
      'Ladder page 1 (eligibility filters)',
      `select * from public.ladder('hu-duplicate')`,
      [],
    ],
    [
      'Q4b',
      'Ladder page 2 (keyset)',
      `select * from public.ladder('hu-duplicate', $1, $2)`,
      [page1?.rating ?? 0, page1?.user_id ?? null],
    ],
    [
      'Q4c',
      'Ladder page 1 inlined (the plan inside ladder())',
      `select r.user_id, p.username, r.rating, r.rd, r.matches
       from public.ratings r join public.players p on p.user_id = r.user_id
       where r.format = 'hu-duplicate' and r.rd < 100 and r.matches >= 20
         and r.last_match_at >= now() - interval '30 days'
         and not exists (select 1 from public.sanctions s where s.user_id = r.user_id and s.kind = 'ladder_removal' and s.lifted_at is null)
         and 10 * r.abandoned < r.matches
       order by r.rating desc, r.user_id limit 50`,
      [],
    ],
    [
      'Q4e',
      'Ladder page 1 inlined as shipped (P1-14, before P1-18 adds sanctions)',
      `select r.user_id, p.username, r.rating, r.rd, r.matches
       from public.ratings r join public.players p on p.user_id = r.user_id
       where r.format = 'hu-duplicate' and r.rd < 100 and r.matches >= 20
         and r.last_match_at >= now() - interval '30 days'
         and 10 * r.abandoned < r.matches
       order by r.rating desc, r.user_id limit 50`,
      [],
    ],
    [
      'Q4f',
      'Ladder this month inlined (the plan inside ladder_month())',
      `with month as (
         select h.user_id, count(*)::int as matches
         from public.rating_history h
         where h.format = 'hu-duplicate' and h.kind = 'match'
           and h.played_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc'
         group by h.user_id)
       select r.user_id, r.rating, mo.matches
       from month mo join public.ratings r on r.user_id = mo.user_id and r.format = 'hu-duplicate'
       where r.rd < 100 and r.matches >= 20
         and r.last_match_at >= now() - interval '30 days'
         and 10 * r.abandoned < r.matches
       order by r.rating desc, r.user_id limit 50`,
      [],
    ],
    [
      'Q5',
      'Hands of a match, in order',
      `select id, hand_no, record from public.hands where match_id = $1 order by hand_no`,
      [someMatch],
    ],
    [
      'Q6',
      'Abandonment rate, lifetime, from the counters (heaviest player)',
      `select public.abandonment_rate($1)`,
      [heavy],
    ],
    [
      'Q6b',
      'Abandonment rate over 30 days, the shape Prompt 4 lists (heaviest player)',
      `select coalesce(avg(mp.abandoned::int), 0)::real
       from public.match_players mp join public.matches m on m.id = mp.match_id
       where mp.user_id = $1 and mp.finished_at >= now() - interval '30 days'
         and m.kind = 'hu-rated'`,
      [heavy],
    ],
    [
      'Q4d',
      'Ladder this month, page 1 (R-16)',
      `select * from public.ladder_month('hu-duplicate')`,
      [],
    ],
    [
      'Q7',
      'Idempotency: record_hand retry lookup',
      `insert into public.hands (id, match_id, hand_no, segment, button, commitment, leaves, reveal, record)
       select id, match_id, hand_no, segment, button, commitment, leaves, reveal, record from public.hands where id = $1
       on conflict (id) do nothing`,
      [someHand],
    ],
    [
      'Q7b',
      'Idempotency: record_match lock',
      `select status from public.matches where id = $1 for update`,
      [someMatch],
    ],
    [
      'Q8',
      '/api/stats: hands archived one UTC day',
      `select count(*) from public.hands where created_at >= now() - interval '200 days' and created_at < now() - interval '199 days'`,
      [],
    ],
    [
      'Q8b',
      '/api/stats: verified hands one UTC day',
      `select count(*) from public.hands where created_at >= now() - interval '200 days' and created_at < now() - interval '199 days' and verified is true`,
      [],
    ],
    [
      'Q8c',
      '/api/stats as anon (hands_after_match), worst case: every hand on one day, one matches_pkey probe each',
      `select count(*) from public.hands`,
      [],
      'anon',
    ],
    [
      'Q9',
      'Accuracy recompute: latest 500 graded decisions (at match end, not per view)',
      `select * from private.player_accuracy($1)`,
      [graded],
    ],
    [
      'Q9b',
      'Accuracy inlined (the plan inside private.player_accuracy())',
      `select avg(accuracy)::real from (
         select g.accuracy from public.hand_grades g
         join public.hands h on h.id = g.hand_id
         join public.matches m on m.id = h.match_id
         where g.user_id = $1 and g.format = 'hu-duplicate' and m.status <> 'playing'
         order by g.created_at desc limit 500) latest`,
      [graded],
    ],
    [
      'Q10',
      'Rating graph: a player history',
      `select created_at, after_rating, after_rd from public.rating_history where user_id = $1 and format = 'hu-duplicate' order by created_at desc limit 200`,
      [heavy],
    ],
    [
      'Q11',
      'Own hole cards for a hand',
      `select cards from public.hand_holes where hand_id = $1 and user_id = $2`,
      [someHand, handUser],
    ],
    [
      'Q12',
      'audit_hand (verify consumer)',
      `select public.audit_hand(jsonb_build_object('id', $1::text))`,
      [someHand],
    ],
  ]
  const out = []
  for (const [id, what, sql, params, role] of list) {
    const { ms, lines } = await plan(db, sql, params, role)
    out.push({ id, what, ms, shape: shape(lines), lines })
  }
  return out
}

/** Bytes per hand and per match from real payloads, replicated to 10k hands. */
async function sizes() {
  const db = await fresh()
  const users = new Set<string>()
  for (const m of PAYLOADS.record_match)
    for (const p of m.players as { userId: string }[]) users.add(p.userId)
  for (const id of users)
    await db.query(
      'insert into auth.users (id) values ($1) on conflict do nothing',
      [id],
    )
  const starts = PAYLOADS.record_match.filter((m) => !m.result)
  const copies = Math.ceil(10_000 / PAYLOADS.record_hand.length)
  for (let c = 0; c < copies; c++) {
    const ids = new Map<string, string>()
    for (const m of starts) {
      const id = crypto.randomUUID()
      ids.set(m.id as string, id)
      await db.query('select public.record_match($1::jsonb)', [{ ...m, id }])
    }
    for (const h of PAYLOADS.record_hand) {
      const matchId = ids.get(h.matchId as string)
      if (!matchId) continue
      await db.query('select public.record_hand($1::jsonb)', [
        { ...h, matchId, id: `${matchId}:${h.handNo}` },
      ])
    }
  }
  // Phase 1 grades one row per decision: one per recorded action here.
  await db.exec(`
    insert into public.hand_grades (hand_id, seat, idx, user_id, format, grade, ev_lost, accuracy, model_version)
    select h.id, (a.value ->> 'seat')::smallint, (a.ordinality - 1)::smallint, mp.user_id,
           'hu-duplicate', 'good', 0.4, 87.5, 'grade.v1'
    from public.hands h
    cross join lateral jsonb_array_elements(h.record -> 'actions') with ordinality a
    join public.match_players mp
      on mp.match_id = h.match_id and mp.seat = (a.value ->> 'seat')::smallint`)
  await db.exec('vacuum analyze')
  const rows = (
    await db.query<Row>(`
      select relname as table, n_live_tup::int as rows,
             pg_total_relation_size(relid)::bigint as bytes
      from pg_stat_user_tables
      where relname in ('hands','hands_private','hand_holes','matches','match_players','hand_grades')
      order by relname`)
  ).rows
  const cols = (
    await db.query<Row>(`select
      avg(pg_column_size(record))::int record, avg(pg_column_size(leaves))::int leaves,
      avg(pg_column_size(reveal))::int reveal, avg(pg_column_size(h.*))::int hand_row
      from public.hands h`)
  ).rows[0]
  await db.close()
  return { rows, cols }
}

/** The proposed Phase 1 rules, exercised once on the generated data. */
async function selfChecks(db: PGlite) {
  const results: [string, boolean, string][] = []
  const check = async (name: string, run: () => Promise<string | true>) => {
    try {
      const r = await run()
      results.push([name, r === true, r === true ? '' : r])
    } catch (error) {
      results.push([name, false, String(error)])
    }
  }
  // Runs one statement as a client role, like PostgREST does.
  const as = async (role: string, sql: string, user = '') => {
    await db.exec(
      `select set_config('request.jwt.claim.sub', '${user}', false); set role ${role}`,
    )
    try {
      return (await db.query<Row>(sql)).rows
    } finally {
      await db.exec('reset role')
    }
  }
  const refused = async (role: string, sql: string, user = '') => {
    try {
      await as(role, sql, user)
      return false
    } catch {
      return true
    }
  }
  const one = async <T>(sql: string, params: unknown[] = []) =>
    (await db.query<T>(sql, params)).rows[0]
  const [a, b, c] = (
    await db.query<{ user_id: string }>(
      'select user_id from u order by i limit 3',
    )
  ).rows.map((r) => r.user_id)
  /** A rated match between a and b with one hand, in the given status. */
  const newMatch = async (status: string) => {
    const { id } = await one<{ id: string }>(
      `insert into public.matches (id, kind, status, config) values (gen_random_uuid(), 'hu-rated', $1, '{}') returning id`,
      [status],
    )
    // A finished rated match carries each seat's outcome (record_match v4),
    // which apply_rating checks the payload against.
    const done = status === 'finished'
    await db.query(
      `insert into public.match_players (match_id, user_id, seat, outcome) values ($1, $2, 0, $4), ($1, $3, 1, $5)`,
      [id, a, b, done ? 'win' : null, done ? 'loss' : null],
    )
    await db.query(
      `insert into public.hands (id, match_id, hand_no, segment, button, commitment, leaves, reveal, record, verified)
       values ($1::text || ':1', $1::uuid, 1, 1, 0, repeat('a', 64), decode(repeat('00', 1664), 'hex'), '[]', '{}', true)`,
      [id],
    )
    return id
  }
  const match = await newMatch('finished')
  const version = async (u: string) =>
    (
      await one<{ version: number }>(
        `select version from public.ratings where user_id = $1 and format = 'hu-duplicate'`,
        [u],
      )
    ).version
  const payload = async (matchId = match) => ({
    matchId,
    format: 'hu-duplicate',
    modelVersion: 'glicko2.v1',
    players: [
      {
        userId: a,
        outcome: 'win',
        version: await version(a),
        rating: 1520,
        rd: 90,
        sigma: 0.06,
      },
      {
        userId: b,
        outcome: 'loss',
        version: await version(b),
        rating: 1480,
        rd: 90,
        sigma: 0.06,
      },
    ],
  })
  const counters = (u: string) =>
    one<{ matches: number; wins: number; abandoned: number; version: number }>(
      `select matches, wins, abandoned, version from public.ratings where user_id = $1 and format = 'hu-duplicate'`,
      [u],
    )

  await check(
    'apply_rating twice rates the match once, counting the win once (abandonment is counted by record_match, not here)',
    async () => {
      const [a0, b0] = [await counters(a), await counters(b)]
      const p = await payload()
      await db.query('select public.apply_rating($1::jsonb)', [p])
      await db.query('select public.apply_rating($1::jsonb)', [p])
      const { n } = await one<{ n: number }>(
        `select count(*)::int n from public.rating_history where match_id = $1`,
        [match],
      )
      const [a1, b1] = [await counters(a), await counters(b)]
      return (
        (n === 2 &&
          a1.matches === a0.matches + 1 &&
          a1.wins === a0.wins + 1 &&
          b1.abandoned === b0.abandoned &&
          b1.wins === b0.wins) ||
        `history ${n}; a ${JSON.stringify(a0)} → ${JSON.stringify(a1)}; b ${JSON.stringify(b0)} → ${JSON.stringify(b1)}`
      )
    },
  )
  await check(
    'a stale version is refused (40001) and nothing is written',
    async () => {
      const other = await newMatch('finished')
      const p = await payload(other)
      p.players[0].version -= 1
      try {
        await db.query('select public.apply_rating($1::jsonb)', [p])
        return 'accepted a stale version'
      } catch (error) {
        const { n } = await one<{ n: number }>(
          `select count(*)::int n from public.rating_history where match_id = $1`,
          [other],
        )
        return (
          (String(error).includes('stale') && n === 0) || `${error}; rows ${n}`
        )
      }
    },
  )
  await check(
    'rating_history refuses update, delete and truncate',
    async () => {
      for (const sql of [
        'update public.rating_history set after_rating = 0',
        'delete from public.rating_history',
        'truncate public.rating_history',
      ])
        try {
          await db.exec(sql)
          return `${sql} succeeded`
        } catch {
          // refused, as intended
        }
      return true
    },
  )
  await check(
    'exactly 10% abandonment excludes from the ladder; just under includes',
    async () => {
      const top = async (abandoned: number) => {
        await db.query(
          `update public.ratings set rating = 9999, rd = 50, matches = 20, wins = 10, draws = 0,
                abandoned = $2, last_match_at = now() where user_id = $1 and format = 'hu-duplicate'`,
          [a, abandoned],
        )
        return (
          await db.query<{ user_id: string }>(
            `select user_id from public.ladder('hu-duplicate') limit 1`,
          )
        ).rows[0]?.user_id
      }
      const at10 = await top(2)
      const under = await top(1)
      return (
        (at10 !== a && under === a) ||
        `2/20 listed: ${at10 === a}; 1/20 listed: ${under === a}`
      )
    },
  )
  await check(
    'apply_sanction: a reset restores the provisional default with a reset row; a removal hides from both ladders',
    async () => {
      const before = await counters(a)
      await db.query(`select public.apply_sanction($1::jsonb)`, [
        {
          userId: a,
          kind: 'rating_reset',
          reason: 'test',
          decidedBy: 'dba',
          format: 'hu-duplicate',
        },
      ])
      const r = await one<{ rating: number; rd: number; version: number }>(
        `select rating, rd, version from public.ratings where user_id = $1 and format = 'hu-duplicate'`,
        [a],
      )
      const { n } = await one<{ n: number }>(
        `select count(*)::int n from public.rating_history where user_id = $1 and kind = 'reset'`,
        [a],
      )
      await db.query(
        `update public.ratings set rating = 9999, rd = 50 where user_id = $1`,
        [a],
      )
      const listed = async (fn: string) =>
        (
          await db.query<{ user_id: string }>(
            `select user_id from public.${fn}('hu-duplicate') limit 1`,
          )
        ).rows[0]?.user_id === a
      const [beforeAll, beforeMonth] = [
        await listed('ladder'),
        await listed('ladder_month'),
      ]
      await db.query(`select public.apply_sanction($1::jsonb)`, [
        { userId: a, kind: 'ladder_removal', reason: 'test', decidedBy: 'dba' },
      ])
      const [afterAll, afterMonth] = [
        await listed('ladder'),
        await listed('ladder_month'),
      ]
      return (
        (r.rating === 1500 &&
          r.rd === 350 &&
          r.version === before.version + 1 &&
          n === 1 &&
          beforeAll &&
          beforeMonth &&
          !afterAll &&
          !afterMonth) ||
        `reset ${JSON.stringify(r)} rows ${n}; listed ${beforeAll}/${beforeMonth} → ${afterAll}/${afterMonth}`
      )
    },
  )
  await check(
    'sanctions: public kind and date, private reason; one appeal, own sanction only',
    async () => {
      const { id } = await one<{ id: number }>(
        `select id from public.sanctions where user_id = $1 and kind = 'ladder_removal'`,
        [a],
      )
      const kind = (
        await as('anon', `select kind from public.sanctions where id = ${id}`)
      ).length
      const reason = await refused(
        'anon',
        `select reason from public.sanctions where id = ${id}`,
      )
      const notMine = await refused(
        'authenticated',
        `select public.appeal_sanction(${id}, 'mine?')`,
        b,
      )
      await as(
        'authenticated',
        `select public.appeal_sanction(${id}, 'please')`,
        a,
      )
      const twice = await refused(
        'authenticated',
        `select public.appeal_sanction(${id}, 'again')`,
        a,
      )
      const apply = await refused(
        'authenticated',
        `select public.apply_sanction('{}'::jsonb)`,
        a,
      )
      return (
        (kind === 1 && reason && notMine && twice && apply) ||
        `kind ${kind}, reason hidden ${reason}, other refused ${notMine}, second refused ${twice}, apply refused ${apply}`
      )
    },
  )
  await check(
    'reports: a participant of a finished rated match reports once; abuse is refused',
    async () => {
      const file = (by: string, m: string, about: string) =>
        as(
          'authenticated',
          `insert into public.reports (match_id, reported_id, reason) values ('${m}', '${about}', 'other')`,
          by,
        )
      await file(a, match, b)
      const again = await refused(
        'authenticated',
        `insert into public.reports (match_id, reported_id, reason) values ('${match}', '${b}', 'other')`,
        a,
      )
      const live = await newMatch('playing')
      const unfinished = await refused(
        'authenticated',
        `insert into public.reports (match_id, reported_id, reason) values ('${live}', '${b}', 'other')`,
        a,
      )
      const outsider = await refused(
        'authenticated',
        `insert into public.reports (match_id, reported_id, reason) values ('${match}', '${a}', 'other')`,
        c,
      )
      const self = await refused(
        'authenticated',
        `insert into public.reports (match_id, reported_id, reason) values ('${match}', '${a}', 'other')`,
        a,
      )
      const spoof = await refused(
        'authenticated',
        `insert into public.reports (match_id, reporter_id, reported_id, reason) values ('${match}', '${c}', '${b}', 'other')`,
        a,
      )
      const anon = await refused(
        'anon',
        `insert into public.reports (match_id, reported_id, reason) values ('${match}', '${b}', 'other')`,
      )
      const mine = (
        await as('authenticated', 'select id from public.reports', a)
      ).length
      const aboutMe = (
        await as('authenticated', 'select id from public.reports', b)
      ).length
      return (
        (again &&
          unfinished &&
          outsider &&
          self &&
          spoof &&
          anon &&
          mine === 1 &&
          aboutMe === 0) ||
        `again ${again}, unfinished ${unfinished}, outsider ${outsider}, self ${self}, spoof ${spoof}, anon ${anon}, mine ${mine}, aboutMe ${aboutMe}`
      )
    },
  )
  await check('reports: the 11th in 24 hours is refused', async () => {
    for (let i = 0; i < 9; i++) await file11(await newMatch('finished'))
    const eleventh = await refused(
      'authenticated',
      `insert into public.reports (match_id, reported_id, reason) values ('${await newMatch('finished')}', '${b}', 'other')`,
      a,
    )
    const { n } = await one<{ n: number }>(
      `select count(*)::int n from public.reports where reporter_id = $1`,
      [a],
    )
    return (eleventh && n === 10) || `11th refused ${eleventh}, rows ${n}`
  })
  async function file11(m: string) {
    await as(
      'authenticated',
      `insert into public.reports (match_id, reported_id, reason) values ('${m}', '${b}', 'other')`,
      a,
    )
  }
  await check(
    'clients read ratings, history and the ladders, and write nothing else',
    async () => {
      const reads = [
        `select * from public.ladder('hu-duplicate')`,
        `select * from public.ladder_month('hu-duplicate')`,
        'select 1 from public.ratings limit 1',
        'select 1 from public.rating_history limit 1',
      ]
      for (const sql of reads)
        if (!(await as('anon', sql)).length) return `anon read nothing: ${sql}`
      const writes = [
        `update public.ratings set rating = 3000`,
        `insert into public.rating_history (user_id, format, kind, before_rating, before_rd, before_sigma, after_rating, after_rd, after_sigma, model_version) values ('${a}', 'hu-duplicate', 'reset', 1, 1, 0.1, 1, 1, 0.1, 'x')`,
        `insert into public.hand_grades (hand_id, seat, idx, user_id, format, grade, ev_lost, accuracy, model_version) values ('${match}:1', 0, 9, '${a}', 'hu-duplicate', 'best', 0, 100, 'x')`,
        `insert into public.sanctions (user_id, kind, reason, decided_by) values ('${a}', 'flag', 'x', 'x')`,
        `update public.sanctions set appeal_at = now() - interval '1 year'`,
        `update public.sanctions set kind = 'flag'`,
        `update public.reports set outcome = 'no_action'`,
        `delete from public.reports`,
        `select public.apply_rating('{}'::jsonb)`,
        `select public.record_grades('{}'::jsonb)`,
        `select * from public.profile_views`,
      ]
      for (const sql of writes)
        for (const role of ['anon', 'authenticated'])
          if (!(await refused(role, sql, a))) {
            // An UPDATE or DELETE that RLS filters to zero rows is not an error;
            // count what actually changed.
            const { n } = await one<{ n: number }>(
              `select count(*)::int n from public.reports where outcome is not null`,
            )
            if (sql.startsWith('update public.reports') && n === 0) continue
            const left = await one<{ n: number }>(
              `select count(*)::int n from public.reports`,
            )
            if (sql.startsWith('delete from public.reports') && left.n > 0)
              continue
            return `${role} may: ${sql.slice(0, 70)}`
          }
      return true
    },
  )
  await check(
    'grades: nobody reads them while the match is playing; after it its two players do, anon never (Q6); accuracy counts finished matches',
    async () => {
      const live = await newMatch('playing')
      await db.query(`select public.record_grades($1::jsonb)`, [
        {
          handId: `${live}:1`,
          format: 'hu-duplicate',
          modelVersion: 'grade.v1',
          grades: [
            {
              seat: 0,
              idx: 0,
              userId: a,
              grade: 'blunder',
              evLost: 9,
              accuracy: 0,
            },
          ],
        },
      ])
      const sql = `select grade from public.hand_grades where hand_id = '${live}:1'`
      const during = [
        await refused('anon', sql),
        (await as('authenticated', sql, a)).length,
        (await as('authenticated', sql, b)).length,
      ]
      const accDuring = (
        await one<{ accuracy: number }>(
          `select accuracy from private.player_accuracy($1)`,
          [a],
        )
      ).accuracy
      await db.query(
        `update public.matches set status = 'finished' where id = $1`,
        [live],
      )
      // The finish trigger (P1-10) has refreshed both players; again is harmless:
      await db.query(`select private.refresh_accuracy($1, 'hu-duplicate')`, [a])
      const after = [
        await refused('anon', sql),
        (await as('authenticated', sql, a)).length,
        (await as('authenticated', sql, b)).length,
      ]
      const stored = (
        await one<{ accuracy: number }>(
          `select accuracy from public.accuracy where user_id = $1 and format = 'hu-duplicate'`,
          [a],
        )
      ).accuracy
      const accAfter = (
        await one<{ accuracy: number }>(
          `select accuracy from private.player_accuracy($1)`,
          [a],
        )
      ).accuracy
      // A redelivery writes nothing new.
      await db.query(`select public.record_grades($1::jsonb)`, [
        {
          handId: `${live}:1`,
          format: 'hu-duplicate',
          modelVersion: 'grade.v1',
          grades: [
            {
              seat: 0,
              idx: 0,
              userId: a,
              grade: 'best',
              evLost: 0,
              accuracy: 100,
            },
          ],
        },
      ])
      const { grade } = await one<{ grade: string }>(
        `select grade from public.hand_grades where hand_id = $1`,
        [`${live}:1`],
      )
      return (
        (during.join() === 'true,0,0' &&
          after.join() === 'true,1,1' &&
          accDuring !== accAfter &&
          Math.abs(stored - accAfter) < 1e-3 &&
          grade === 'blunder') ||
        `during ${during}, after ${after}, accuracy ${accDuring} → ${accAfter}, stored ${stored}, grade ${grade}`
      )
    },
  )
  await check(
    'every function pins search_path and no security definer is callable by browsers (rls-matrix.test.ts rule)',
    async () => {
      const bad = (
        await db.query<{ name: string }>(`
        select n.nspname || '.' || p.proname as name
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'private')
          and (not coalesce('search_path=""' = any (p.proconfig), false)
               or (p.prosecdef and (has_function_privilege('anon', p.oid, 'execute')
                                    or has_function_privilege('authenticated', p.oid, 'execute'))))`)
      ).rows.map((r) => r.name)
      return bad.length === 0 || bad.join(', ')
    },
  )
  await check('the ladder pages without gaps or repeats', async () => {
    const seen = new Set<string>()
    let after: { rating: number; user_id: string } | null = null
    for (let page = 0; page < 1000; page++) {
      const rows = (
        await db.query<{ rating: number; user_id: string }>(
          `select rating, user_id from public.ladder('hu-duplicate', $1, $2)`,
          [after?.rating ?? null, after?.user_id ?? null],
        )
      ).rows
      if (!rows.length) break
      for (const r of rows) {
        if (seen.has(r.user_id)) return `repeat ${r.user_id}`
        seen.add(r.user_id)
      }
      after = rows[rows.length - 1]
    }
    const { n } = await one<{ n: number }>(`
      select count(*)::int n from public.ratings r
      where r.format = 'hu-duplicate' and r.rd < 100 and r.matches >= 20
        and r.last_match_at >= now() - interval '30 days'
        and 10 * r.abandoned < r.matches
        and not exists (select 1 from public.sanctions s where s.user_id = r.user_id
                        and s.kind = 'ladder_removal' and s.lifted_at is null)`)
    return seen.size === n || `paged ${seen.size} of ${n}`
  })
  return results
}

const ms = (x: number) => (x < 10 ? x.toFixed(2) : x.toFixed(0))

console.log('# DBA bench (PGlite, Postgres 17 in WASM)\n')
const size = await sizes()
console.log(
  '## Bytes per hand (real payloads, 10k hands; hand_grades: Phase 1, one row per decision)\n',
)
console.table(size.rows)
console.log('average column sizes:', size.cols, '\n')

for (const n of scales) {
  const db = await fresh()
  const gen = await generate(db, n)
  console.log(
    `## Scale ${n.toLocaleString()} (generated in ${gen.seconds.toFixed(0)} s${gen.slim ? ', slim leaves' : ''})\n`,
  )
  console.log(JSON.stringify(gen.counts))
  console.log('\n| Query | ms | Plan |\n| --- | --- | --- |')
  for (const q of await queries(db))
    console.log(`| ${q.id} ${q.what} | ${ms(q.ms)} | ${q.shape} |`)
  if (n === scales[0]) {
    console.log('\nSelf-checks of the proposed Phase 1 rules:')
    for (const [name, ok, why] of await selfChecks(db))
      console.log(`- ${ok ? 'PASS' : 'FAIL'} ${name}${why ? ` (${why})` : ''}`)
  }
  console.log('')
  await db.close()
}
