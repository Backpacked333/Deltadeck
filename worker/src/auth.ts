// Who is calling. Supabase access tokens are ES256 JWTs checked against the
// project's published keys; nothing is trusted from the request body.
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { PROTOCOL } from '../../src/shared/protocol'
import { now } from './clock'
import type { WorkerEnv } from './env'

export type Identity = { userId: string; username: string }

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null
let jwksUrl = ''

/**
 * Dev tokens name any account id, so a guessable secret is as bad as none:
 * shorter secrets leave dev tokens off (fail closed).
 */
export const MIN_DEV_SECRET = 16

const devTokensOn = (env: WorkerEnv) =>
  (env.DEV_AUTH_SECRET?.length ?? 0) >= MIN_DEV_SECRET

/** The key set for this project; made once per isolate (and per URL). */
function keySet(env: WorkerEnv) {
  const url = `${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`
  if (!jwks || jwksUrl !== url) {
    jwks = createRemoteJWKSet(new URL(url))
    jwksUrl = url
  }
  return jwks
}

/** A prime is tried at most this often per isolate, whatever fails. */
export const PRIME_MIN_MS = 30_000
let lastPrime = -Infinity

/**
 * Fetches the project's signing keys ahead of the first sign-in (ADR
 * amendment 2026-10-12, "Live games"). A fresh isolate has no keys, and the
 * first token it verifies waits on a round trip to Supabase before anything
 * else, on the path of a player's first connect. The page asks /api/config
 * as it loads, long before it connects, so that request primes them
 * (`ctx.waitUntil`). Verification is untouched: the same pinned algorithm,
 * issuer and audience. Never throws, and does nothing while the keys are
 * fresh or a fetch is under way, nor more than once per PRIME_MIN_MS: the
 * route is open to everyone, and a failing fetch must not become a fetch per
 * request.
 */
export async function primeKeys(env: WorkerEnv) {
  if (!env.SUPABASE_URL) return
  const keys = keySet(env)
  const t = now()
  if (keys.fresh || keys.reloading || t - lastPrime < PRIME_MIN_MS) return
  lastPrime = t
  try {
    await keys.reload()
  } catch {
    // The first real verification asks again.
  }
}

/** The account id for a token, or null when it does not verify. */
export async function verifyToken(
  token: string,
  env: WorkerEnv,
): Promise<string | null> {
  // Dots, not colons: a token travels as a WebSocket subprotocol, where
  // browsers reject separators like ':'. Real JWTs start with 'eyJ'.
  if (devTokensOn(env) && token.startsWith('dev.')) {
    const [, userId, secret] = token.split('.')
    return secret === env.DEV_AUTH_SECRET && /^[\w-]{1,64}$/.test(userId)
      ? userId
      : null
  }
  const keys = keySet(env)
  try {
    const { payload } = await jwtVerify(token, keys, {
      issuer: `${env.SUPABASE_URL}/auth/v1`,
      audience: 'authenticated',
      // Pinned: rejects alg confusion and the HS256 legacy API keys.
      algorithms: ['ES256'],
    })
    return typeof payload.sub === 'string' ? payload.sub : null
  } catch {
    return null
  }
}

/**
 * Usernames already looked up in this isolate. Every socket upgrade needs
 * one, so without this a reconnecting client is a Supabase request each time,
 * and a Supabase outage would stop players who are already known.
 */
const names = new Map<string, { username: string; at: number }>()
/** A rename shows at new tables within this time. */
export const NAME_TTL_MS = 300_000
const MAX_NAMES = 10_000

/** Empties the username cache (tests). */
export function forgetUsernames() {
  names.clear()
}

/** The public username, from public.players (readable with the anon key). */
export async function usernameFor(
  userId: string,
  env: WorkerEnv,
): Promise<string | null> {
  if (devTokensOn(env) && !/^[0-9a-f-]{36}$/.test(userId)) return userId
  const cached = names.get(userId)
  if (cached && now() - cached.at < NAME_TTL_MS) return cached.username
  let username: string | null = null
  try {
    const response = await fetch(
      `${env.SUPABASE_URL}/rest/v1/players?select=username&user_id=eq.${userId}`,
      { headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY } },
    )
    // Supabase down: a player we know keeps their stale name.
    if (!response.ok) return cached?.username ?? null
    const rows = (await response.json()) as { username: string }[]
    username = rows[0]?.username ?? null
  } catch {
    return cached?.username ?? null
  }
  if (username) {
    names.delete(userId)
    if (names.size >= MAX_NAMES) names.delete(names.keys().next().value!)
    names.set(userId, { username, at: now() })
  }
  return username
}

/**
 * Whether an account may play rated: a confirmed email on a permanent (not
 * anonymous) account. Asked of Supabase Auth itself with the player's own
 * token, because the access token carries no confirmation claim and
 * user_metadata is the user's to edit. `unknown` when Auth cannot be
 * reached: not a refusal, so the player is told to try again.
 */
export type RatedEligibility = 'yes' | 'no' | 'unknown'

/**
 * A yes is cached this long, then asked again, so a confirmation an
 * operator revokes lapses within minutes.
 */
export const ELIGIBLE_TTL_MS = 300_000
/** Accounts found eligible in this isolate, and when. */
const eligible = new Map<string, number>()

export async function ratedEligibility(
  token: string,
  userId: string,
  env: WorkerEnv,
): Promise<RatedEligibility> {
  if (devTokensOn(env) && token.startsWith('dev.')) return 'yes'
  const seen = eligible.get(userId)
  if (seen !== undefined && now() - seen < ELIGIBLE_TTL_MS) return 'yes'
  let user: {
    id?: unknown
    email_confirmed_at?: unknown
    is_anonymous?: unknown
  }
  try {
    const response = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: env.SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${token}`,
      },
    })
    if (response.status === 401 || response.status === 403) return 'no'
    if (!response.ok) return 'unknown'
    user = (await response.json()) as typeof user
  } catch {
    return 'unknown'
  }
  const ok =
    user.id === userId &&
    typeof user.email_confirmed_at === 'string' &&
    user.is_anonymous !== true
  eligible.delete(userId)
  if (!ok) return 'no'
  if (eligible.size >= MAX_NAMES) eligible.delete(eligible.keys().next().value!)
  eligible.set(userId, now())
  return 'yes'
}

export async function identify(
  token: string | null,
  env: WorkerEnv,
): Promise<Identity | null> {
  if (!token) return null
  const userId = await verifyToken(token, env)
  if (!userId) return null
  const username = await usernameFor(userId, env)
  return username ? { userId, username } : null
}

/**
 * Browsers cannot set headers on a WebSocket, so the client offers
 * `qp.v1, bearer.<jwt>` as subprotocols. The token never goes in a URL.
 */
export function readSubprotocols(header: string | null) {
  const offered = (header ?? '').split(',').map((s) => s.trim())
  const bearer = offered.find((s) => s.startsWith('bearer.'))
  return {
    supported: offered.includes(PROTOCOL),
    token: bearer ? bearer.slice('bearer.'.length) : null,
  }
}

export function bearerToken(request: Request) {
  const header = request.headers.get('Authorization') ?? ''
  return header.startsWith('Bearer ') ? header.slice(7) : null
}
