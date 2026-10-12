// Real Supabase-shaped tokens: ES256, signed by a key published through a
// stubbed JWKS endpoint. Everything else the Worker does with a token is
// covered by dev tokens in table.test.ts; this file is about who gets in.
import { env, SELF } from 'cloudflare:test'
import { exportJWK, exportSPKI, generateKeyPair, SignJWT } from 'jose'
import type { JWTPayload } from 'jose'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  ELIGIBLE_TTL_MS,
  identify,
  ratedEligibility,
  verifyToken,
} from '../src/auth'
import type { WorkerEnv } from '../src/env'
import { DEV_SECRET, ORIGIN } from './helpers'

const USER = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b'
const NO_PROFILE = '00000000-0000-4000-8000-000000000000'
// Accounts for the rated gate: what Supabase Auth says about each.
const UNCONFIRMED = '7a1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b'
const ANONYMOUS = '8b1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b'
const AUTH_DOWN = '9c1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b'
const NAMES: Record<string, string> = {
  [USER]: 'alice',
  [UNCONFIRMED]: 'una',
  [ANONYMOUS]: 'anon',
  [AUTH_DOWN]: 'dana',
}
/** The apikey each request to Supabase Auth's user endpoint carried. */
const authKeys: string[] = []
/** Whether Auth reports USER's email as confirmed (a test may revoke it). */
let userConfirmed = true
const ISSUER = `${env.SUPABASE_URL}/auth/v1`
const KID = 'qp-test-key'
// Production never sets DEV_AUTH_SECRET.
const prodEnv = { ...env, DEV_AUTH_SECRET: undefined } as WorkerEnv

let signingKey: CryptoKey
let strangerKey: CryptoKey
/** What Supabase publishes, as an attacker can fetch it. */
let publishedJwk = ''
let publishedPem = ''

beforeAll(async () => {
  const signing = await generateKeyPair('ES256', { extractable: true })
  signingKey = signing.privateKey
  strangerKey = (await generateKeyPair('ES256')).privateKey
  const jwk = {
    ...(await exportJWK(signing.publicKey)),
    kid: KID,
    alg: 'ES256',
    use: 'sig',
  }
  publishedJwk = JSON.stringify(jwk)
  publishedPem = await exportSPKI(signing.publicKey)
  const realFetch = globalThis.fetch
  // The test module and the Worker share an isolate, so this also stands in
  // for Supabase when requests go through SELF.
  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.origin !== new URL(env.SUPABASE_URL).origin)
        return realFetch(input, init)
      if (url.pathname === '/auth/v1/.well-known/jwks.json')
        return Response.json({ keys: [jwk] })
      if (url.pathname === '/rest/v1/players') {
        const name = NAMES[url.searchParams.get('user_id')!.slice(3)]
        return Response.json(name ? [{ username: name }] : [])
      }
      if (url.pathname === '/auth/v1/user') {
        const headers = new Headers(init?.headers)
        authKeys.push(headers.get('apikey') ?? '')
        const jwt = (headers.get('Authorization') ?? '').slice(7)
        const { sub } = JSON.parse(
          atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')),
        ) as { sub: string }
        if (sub === AUTH_DOWN) return new Response('down', { status: 503 })
        return Response.json({
          id: sub,
          email_confirmed_at:
            sub === USER && userConfirmed ? '2026-10-01T00:00:00Z' : null,
          is_anonymous: sub === ANONYMOUS,
          // Editable by the user, so never trusted.
          user_metadata: { email_verified: true },
        })
      }
      return new Response('not stubbed', { status: 599 })
    },
  )
})
afterAll(() => vi.unstubAllGlobals())

function sign(
  claims: JWTPayload = {},
  opts: { key?: CryptoKey; kid?: string; exp?: string | number } = {},
) {
  return new SignJWT({ role: 'authenticated', sub: USER, ...claims })
    .setProtectedHeader({ alg: 'ES256', kid: opts.kid ?? KID, typ: 'JWT' })
    .setIssuedAt()
    .setIssuer(typeof claims.iss === 'string' ? claims.iss : ISSUER)
    .setAudience((claims.aud as string) ?? 'authenticated')
    .setExpirationTime(opts.exp ?? '1h')
    .sign(opts.key ?? signingKey)
}

const b64url = (s: string) =>
  btoa(s).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')

/** A token whose HMAC key is public text, as in the classic confusion. */
const hs256With = (secret: string) =>
  new SignJWT({ role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256', kid: KID })
    .setSubject(USER)
    .setIssuer(ISSUER)
    .setAudience('authenticated')
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(secret))

const createMatch = (jwt: string) =>
  SELF.fetch(`${ORIGIN}/api/matches`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}` },
  })

describe('Supabase access tokens', () => {
  it('accepts a valid ES256 token and resolves the username', async () => {
    expect(await verifyToken(await sign(), prodEnv)).toBe(USER)
    expect(await identify(await sign(), prodEnv)).toEqual({
      userId: USER,
      username: 'alice',
    })
    expect((await createMatch(await sign())).status).toBe(201)
  })

  it.each<[string, () => Promise<string>]>([
    ['a wrong issuer', () => sign({ iss: 'https://evil.example/auth/v1' })],
    ['a wrong audience', () => sign({ aud: 'anon' })],
    [
      'an expired token',
      () => sign({}, { exp: Math.floor(Date.now() / 1000) - 60 }),
    ],
    ['a key Supabase did not publish', () => sign({}, { key: strangerKey })],
    ['an unknown key id', () => sign({}, { kid: 'rotated-away' })],
    ['no subject', () => sign({ sub: undefined })],
    [
      'a payload swapped under a valid signature',
      async () => {
        const [header, , signature] = (await sign()).split('.')
        const payload = b64url(
          JSON.stringify({
            sub: 'mallory',
            aud: 'authenticated',
            iss: ISSUER,
            exp: 9e9,
          }),
        )
        return `${header}.${payload}.${signature}`
      },
    ],
    [
      'alg none',
      async () =>
        `${b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${b64url(
          JSON.stringify({
            sub: USER,
            aud: 'authenticated',
            iss: ISSUER,
            exp: 9e9,
          }),
        )}.`,
    ],
    [
      'HS256 signed with the public publishable key',
      () =>
        new SignJWT({ role: 'authenticated' })
          .setProtectedHeader({ alg: 'HS256', kid: KID })
          .setSubject(USER)
          .setIssuer(ISSUER)
          .setAudience('authenticated')
          .setExpirationTime('1h')
          .sign(new TextEncoder().encode(env.SUPABASE_PUBLISHABLE_KEY)),
    ],
    [
      'a token that is not valid yet (nbf in an hour)',
      () => sign({ nbf: Math.floor(Date.now() / 1000) + 3600 }),
    ],
    [
      'HS256 keyed with the published EC key (JWK text): alg confusion',
      () => hs256With(publishedJwk),
    ],
    [
      'HS256 keyed with the published EC key (PEM): alg confusion',
      () => hs256With(publishedPem),
    ],
    [
      'RS256 under the published key id',
      async () => {
        const { privateKey } = await generateKeyPair('RS256')
        return new SignJWT({ role: 'authenticated', sub: USER })
          .setProtectedHeader({ alg: 'RS256', kid: KID })
          .setIssuer(ISSUER)
          .setAudience('authenticated')
          .setExpirationTime('1h')
          .sign(privateKey)
      },
    ],
    ['garbage', async () => 'eyJnot.a.jwt'],
  ])('rejects %s', async (_, make) => {
    const jwt = await make()
    expect(await verifyToken(jwt, prodEnv)).toBeNull()
    expect((await createMatch(jwt)).status).toBe(401)
  })

  it('refuses a valid token whose account has no username yet', async () => {
    const jwt = await sign({ sub: NO_PROFILE })
    expect(await verifyToken(jwt, prodEnv)).toBe(NO_PROFILE)
    expect(await identify(jwt, prodEnv)).toBeNull()
    expect((await createMatch(jwt)).status).toBe(401)
  })

  it('takes a real token on the WebSocket subprotocol', async () => {
    const created = await createMatch(await sign())
    const { matchId } = (await created.json()) as { matchId: string }
    const upgrade = async (jwt: string) =>
      SELF.fetch(`${ORIGIN}/ws/table/${matchId}`, {
        headers: {
          Upgrade: 'websocket',
          Origin: ORIGIN,
          'Sec-WebSocket-Protocol': `qp.v1, bearer.${jwt}`,
        },
      })
    const ok = await upgrade(await sign())
    expect(ok.status).toBe(101)
    ok.webSocket!.accept()
    ok.webSocket!.close(1000)
    expect((await upgrade(await sign({}, { key: strangerKey }))).status).toBe(
      401,
    )
  })
})

describe('the rated gate', () => {
  it('asks Supabase Auth itself: a confirmed, permanent account only', async () => {
    expect(await ratedEligibility(await sign(), USER, prodEnv)).toBe('yes')
    for (const sub of [UNCONFIRMED, ANONYMOUS])
      expect(await ratedEligibility(await sign({ sub }), sub, prodEnv)).toBe(
        'no',
      )
    // Auth unreachable: not a refusal, just unknown for now.
    expect(
      await ratedEligibility(
        await sign({ sub: AUTH_DOWN }),
        AUTH_DOWN,
        prodEnv,
      ),
    ).toBe('unknown')
    // The answer must be about the account the token verified as.
    expect(await ratedEligibility(await sign(), UNCONFIRMED, prodEnv)).toBe(
      'no',
    )
    // The browser-safe key, never the secret one.
    expect(new Set(authKeys)).toEqual(new Set([env.SUPABASE_PUBLISHABLE_KEY]))
  })

  it('asks again once a cached yes is older than its TTL, so a revoked confirmation lapses', async () => {
    const t0 = Date.now()
    expect(await ratedEligibility(await sign(), USER, prodEnv)).toBe('yes')
    userConfirmed = false
    try {
      // Within the TTL the cached answer stands.
      vi.spyOn(Date, 'now').mockReturnValue(t0 + ELIGIBLE_TTL_MS - 1000)
      expect(await ratedEligibility(await sign(), USER, prodEnv)).toBe('yes')
      vi.spyOn(Date, 'now').mockReturnValue(t0 + ELIGIBLE_TTL_MS + 1000)
      expect(await ratedEligibility(await sign(), USER, prodEnv)).toBe('no')
    } finally {
      userConfirmed = true
      vi.restoreAllMocks()
    }
  })

  it('refuses a rated queue to an unconfirmed account, which can still queue casual', async () => {
    const response = await SELF.fetch(`${ORIGIN}/ws/lobby`, {
      headers: {
        Upgrade: 'websocket',
        Origin: ORIGIN,
        'Sec-WebSocket-Protocol': `qp.v1, bearer.${await sign({ sub: UNCONFIRMED })}`,
      },
    })
    expect(response.status).toBe(101)
    const ws = response.webSocket!
    const frames: { t: string; code?: string; message?: string }[] = []
    ws.addEventListener('message', (e) =>
      frames.push(JSON.parse(e.data as string)),
    )
    ws.accept()
    const next = async (t: string) => {
      for (let i = 0; i < 400; i++) {
        const f = frames.find((x) => x.t === t)
        if (f) return f
        await new Promise((r) => setTimeout(r, 5))
      }
      throw new Error(`no ${t}`)
    }
    ws.send(JSON.stringify({ t: 'queue', kind: 'hu-rated' }))
    expect(await next('error')).toMatchObject({
      code: 'unverified',
      message: expect.stringMatching(/confirmed email/),
    })
    expect(frames.some((f) => f.t === 'queued')).toBe(false)
    ws.send(JSON.stringify({ t: 'queue', kind: 'hu-casual' }))
    expect(await next('queued')).toMatchObject({ position: 1 })
    ws.send(JSON.stringify({ t: 'dequeue' }))
    ws.close(1000)
  })
})

describe('dev tokens', () => {
  const devEnv = env as WorkerEnv

  it('work only where DEV_AUTH_SECRET is set', async () => {
    expect(await verifyToken(`dev.alice.${DEV_SECRET}`, devEnv)).toBe('alice')
    expect(await verifyToken('dev.alice.wrong', devEnv)).toBeNull()
    // In production the same string is just a malformed JWT.
    expect(await verifyToken(`dev.alice.${DEV_SECRET}`, prodEnv)).toBeNull()
    expect(
      await verifyToken('dev.alice.', {
        ...env,
        DEV_AUTH_SECRET: '',
      } as WorkerEnv),
    ).toBeNull()
    expect((await createMatch(`dev.alice.${DEV_SECRET}`)).status).toBe(201)
  })

  it('stay off when the configured secret is too short to resist guessing', async () => {
    // A short secret set by mistake on a deployed Worker would let anyone
    // guess it and play as any account id they name.
    for (const weak of ['x', 'e2e', 'fifteen-chars!!'])
      expect(
        await verifyToken(`dev.alice.${weak}`, {
          ...env,
          DEV_AUTH_SECRET: weak,
        } as WorkerEnv),
      ).toBeNull()
  })

  it('reject user ids that are not plain words', async () => {
    expect(await verifyToken(`dev.a b.${DEV_SECRET}`, devEnv)).toBeNull()
    expect(
      await verifyToken(`dev.${'x'.repeat(65)}.${DEV_SECRET}`, devEnv),
    ).toBeNull()
    // The lobby's keys join an account id to a day or a game with ':', so
    // an id that held one could name another account's key.
    expect(await verifyToken(`dev.a:b.${DEV_SECRET}`, devEnv)).toBeNull()
  })
})

describe('listing a game (ADR amendment 2026-10-12, "Live games")', () => {
  /** POST /api/matches asking for a listed game, as the account `sub`. */
  const askListed = async (sub: string) => {
    const made = await SELF.fetch(`${ORIGIN}/api/matches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await sign({ sub })}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ listed: true }),
    })
    expect(made.status).toBe(201)
    return ((await made.json()) as { listed: boolean }).listed
  }

  it('needs a confirmed email, as rated play does: any other account gets a game made unlisted, and is told so', async () => {
    userConfirmed = true
    expect(await askListed(USER)).toBe(true)
    expect(await askListed(UNCONFIRMED)).toBe(false)
    expect(await askListed(ANONYMOUS)).toBe(false)
    // Auth unreachable: not a refusal to make the game, only not listed.
    expect(await askListed(AUTH_DOWN)).toBe(false)
  })
})
