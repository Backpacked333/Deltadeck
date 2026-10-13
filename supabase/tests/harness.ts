// Shared by the SQL suites: a stub of what Supabase provides before any
// project migration runs, so revokes, grants and RLS are exercised on real
// Postgres (PGlite) against Supabase's permissive defaults.
import { readdirSync } from 'node:fs'

export const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url)

/** Every migration file, in the order Supabase applies them. */
export const migrationFiles = () =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()

export const SUPABASE_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (
    id uuid primary key,
    email text,
    email_confirmed_at timestamptz,
    is_anonymous boolean not null default false
  );
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated, service_role;
  -- Supabase Storage's two tables, as far as the policies need them.
  create schema storage;
  create table storage.buckets (
    id text primary key,
    name text not null,
    public boolean not null default false,
    file_size_limit bigint,
    allowed_mime_types text[]
  );
  create table storage.objects (
    id uuid primary key default gen_random_uuid(),
    bucket_id text references storage.buckets (id),
    name text,
    owner uuid
  );
  alter table storage.objects enable row level security;
  grant usage on schema storage to anon, authenticated, service_role;
  grant all on storage.objects to anon, authenticated, service_role;
  grant usage on schema public to anon, authenticated, service_role;
  -- Supabase's permissive defaults, which the migrations must narrow.
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`

/** What a rated match's config gives the evidence checks (worker/src/rated.ts). */
export const RATED_TEST_CONFIG = { handsTotal: 40, blinds: { sb: 10, bb: 20 } }

/** `total` over `n` hands in equal shares: each hand's net for seat 0. */
export const shares = (total: number, n = RATED_TEST_CONFIG.handsTotal) =>
  Array.from({ length: n }, () => total / n)

type Querier = {
  query: (sql: string, params?: unknown[]) => Promise<unknown>
}

/**
 * What a rated result rests on since audit F07: the match's hands 1..n,
 * archived and verified, each naming its two players in their seats and
 * carrying its luck-adjusted net (`seat0[i]` for seat 0, the opposite for
 * seat 1). Inserted directly, as record_hand and verify_hand leave them;
 * apply_rating checks them.
 */
export async function seedRatedEvidence(
  db: Querier,
  matchId: string,
  players: { seat: number; userId: string }[],
  seat0: number[],
  verified = true,
) {
  for (const [i, net] of seat0.entries())
    await db.query(
      `insert into public.hands (id, match_id, hand_no, button, commitment, leaves, reveal, record, verified)
       values ($1, $2, $3, 0, repeat('a', 64), decode(repeat('00', 1664), 'hex'), '[]', $4::jsonb, $5)
       on conflict (id) do nothing`,
      [
        `${matchId}:${i + 1}`,
        matchId,
        i + 1,
        JSON.stringify({
          seats: players.map((p) => ({ ...p, username: `p${p.seat}` })),
          netBySeat: { 0: net, 1: -net },
          luck: { adjustedBySeat: { 0: net, 1: -net } },
        }),
        verified,
      ],
    )
}
