// Bindings from wrangler.jsonc plus values that only exist in some places:
// DEV_AUTH_SECRET is set for local development and tests, never in
// production, and turns on `dev.<userId>.<secret>` tokens.
// SUPABASE_SECRET_KEY is a Worker secret (`wrangler secret put`); without it
// nothing is archived, which is how local development runs.
// RESEND_API_KEY (a secret) and SCHOOL_EMAIL_FROM (e.g. "DeltaDeck
// <verify@example.com>", a sender on a domain verified at Resend) turn on
// school codes by email (worker/src/school.ts); without them that route
// answers 503 and nothing else changes.
export type WorkerEnv = Env & {
  DEV_AUTH_SECRET?: string
  SUPABASE_SECRET_KEY?: string
  RESEND_API_KEY?: string
  SCHOOL_EMAIL_FROM?: string
}
