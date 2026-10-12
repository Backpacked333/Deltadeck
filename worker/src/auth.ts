// Who is calling. Supabase access tokens are ES256 JWTs checked against the
// project's published keys; nothing is trusted from the request body.
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { PROTOCOL } from '../../src/shared/protocol'
import { now } from './clock'
import type { WorkerEnv } from './env'

export type Identity = {
  userId: string
  username: string
  /** players.avatar_version: the picture to show, or null for none. */
  avatar: number | null
  /** The school domain of a verified school email, or null. */
  school: string | null
}

/** What a table shows of a player, besides their account id. */
export type PublicProfile = Omit<Identity, 'userId'>

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
 * Profiles already looked up in this isolate. Every socket upgrade needs
 * one, so without this a reconnecting client is a Supabase request each time,
 * and a Supabase outage would stop players who are already known.
 */
const names = new Map<string, { profile: PublicProfile; at: number }>()
/** A rename, or a new picture, shows at new tables within this time. */
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
  return (await profileFor(userId, env))?.username ?? null
}

type PlayerRow = {
  username: string
  avatar_version?: unknown
  school_domain?: unknown
  school_verified_at?: unknown
}

/**
 * The public username, picture version and verified school, in one request
 * to public.players (readable with the anon key). Dev accounts have no row,
 * so no picture or school either.
 */
export async function profileFor(
  userId: string,
  env: WorkerEnv,
): Promise<PublicProfile | null> {
  if (devTokensOn(env) && !/^[0-9a-f-]{36}$/.test(userId))
    return { username: userId, avatar: null, school: null }
  const cached = names.get(userId)
  if (cached && now() - cached.at < NAME_TTL_MS) return cached.profile
  let profile: PublicProfile | null = null
  try {
    const response = await fetch(
      `${env.SUPABASE_URL}/rest/v1/players?select=username,avatar_version,school_domain,school_verified_at&user_id=eq.${userId}`,
      { headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY } },
    )
    // Supabase down: a player we know keeps their stale profile.
    if (!response.ok) return cached?.profile ?? null
    const row = ((await response.json()) as PlayerRow[])[0]
    if (row?.username)
      profile = {
        username: row.username,
        avatar: avatarVersion(row.avatar_version),
        // The badge is a verified school's only.
        school:
          row.school_verified_at != null
            ? schoolDomain(row.school_domain)
            : null,
      }
  } catch {
    return cached?.profile ?? null
  }
  if (profile) {
    names.delete(userId)
    if (names.size >= MAX_NAMES) names.delete(names.keys().next().value!)
    names.set(userId, { profile, at: now() })
  }
  return profile
}

/** A picture version as players.avatar_version allows it, else null. */
export function avatarVersion(value: unknown): number | null {
  const n =
    typeof value === 'string' && /^\d{1,10}$/.test(value) ? +value : value
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 1e9
    ? n
    : null
}

/** A school domain as school_domains spells one, else null. */
export function schoolDomain(value: unknown): string | null {
  return typeof value === 'string' && /^[a-z0-9.-]{3,190}$/.test(value)
    ? value
    : null
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
  const profile = await profileFor(userId, env)
  return profile ? { userId, ...profile } : null
}

/**
 * The picture version and school for a table, as headers beside x-username.
 * Left out when there is none; the table checks both again (avatarVersion,
 * schoolDomain), so a header it cannot read shows nothing.
 */
export function identityHeaders(who: Identity): Record<string, string> {
  return {
    ...(who.avatar !== null ? { 'x-avatar': String(who.avatar) } : {}),
    ...(who.school !== null ? { 'x-school': who.school } : {}),
  }
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
