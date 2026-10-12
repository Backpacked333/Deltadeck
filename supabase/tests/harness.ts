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
