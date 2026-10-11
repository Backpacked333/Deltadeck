// The Worker in front of everything. Static files come from ./dist without
// reaching this code; only the page itself (/), /api/*, /ws/*, /u/* and /c/*
// do (see wrangler.jsonc).
import { PROTOCOL } from '../../src/shared/protocol'
import {
  bearerToken,
  identify,
  ratedEligibility,
  readSubprotocols,
} from './auth'
import { canonicalRedirect } from './canonical'
import type { WorkerEnv } from './env'
import { lobbyStub, tableStub } from './lobby'
import { describeError, logEvent } from './log'
import { profilePage } from './profile'
import { sharePage } from './share'
import { challengeRoute } from './challenge'
import { originAllowed } from './origin'
import type { InitBody } from './table'
import { HANDS_DLQ } from './queues'
import { handsPerDay } from './stats'
import { consumeDeadLetters, consumeHands } from './verify'

export { LobbyDO } from './lobby'
export { ScoreDO } from './scores'
export { TableDO } from './table'

const json = (body: unknown, status = 200, headers?: HeadersInit) =>
  Response.json(body, { status, headers })
const MATCH_PATH = /^\/ws\/table\/([0-9a-f-]{36})$/
/** Paths that verify a token or may wake a Durable Object. */
const LIMITED =
  /^\/(ws\/|c\/|api\/(matches|me|events|challenge\/(score|claim|shared\/[0-9a-f]{32})|school\/(start|confirm))$)/

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const { pathname } = new URL(request.url)

    const moved = canonicalRedirect(request, env.CANONICAL_ORIGIN)
    if (moved) return moved

    if (pathname === '/api/health')
      return json({ ok: true, protocol: PROTOCOL })

    // Browser-safe settings for the online area, so the static build needs
    // no environment variables.
    if (pathname === '/api/config')
      return json({
        supabaseUrl: env.SUPABASE_URL,
        supabaseKey: env.SUPABASE_PUBLISHABLE_KEY,
      })

    // Hands per day from the archive, for the operator (README §Operations).
    if (pathname === '/api/stats') return handsPerDay(env)

    // One address cannot make the server verify tokens and wake objects
    // without bound. Checked before any token work.
    if (LIMITED.test(pathname) && (await overAddressLimit(request, env))) {
      // The address itself is never logged.
      logEvent('limit_hit', { code: 429, reason: 'address' })
      return json({ error: 'rate_limited' }, 429, { 'Retry-After': '60' })
    }

    // Create a heads-up table and a link to share. The creator takes seat 0.
    if (pathname === '/api/matches' && request.method === 'POST') {
      const who = await identify(bearerToken(request), env)
      if (!who) return json({ error: 'unauthorized' }, 401)
      const matchId = crypto.randomUUID()
      // One table per account: finish the one you are playing first. And a
      // daily cap, so one account cannot create tables without end.
      const verdict = await lobbyStub(env).createMatch(who.userId, matchId)
      if (verdict.active)
        return json({ error: 'active', matchId: verdict.active }, 409)
      if (verdict.retryAfter) {
        logEvent('limit_hit', {
          userId: who.userId,
          code: 429,
          reason: 'creates',
        })
        return json(
          { error: 'too_many_tables', retryAfter: verdict.retryAfter },
          429,
          { 'Retry-After': String(verdict.retryAfter) },
        )
      }
      const body: InitBody = { matchId, creator: who }
      const created = await tableStub(env, matchId).fetch(
        'https://table/init',
        {
          method: 'POST',
          body: JSON.stringify(body),
        },
      )
      return created.ok
        ? json({ matchId }, 201)
        : json({ error: 'failed' }, 500)
    }

    // The table this account should be at, so a lobby page can offer it.
    if (pathname === '/api/me') {
      const who = await identify(bearerToken(request), env)
      if (!who) return json({ error: 'unauthorized' }, 401)
      return json({
        activeMatch: await lobbyStub(env).activeFor(who.userId),
      })
    }

    if (pathname === '/ws/lobby') {
      const refused = upgradeRefusal(request)
      if (refused) return refused
      const offered = readSubprotocols(
        request.headers.get('Sec-WebSocket-Protocol'),
      )
      const who = await identify(offered.token, env)
      if (!who) return json({ error: 'unauthorized' }, 401)
      // Checked once per lobby socket: the rated queue is refused without it.
      const rated = await ratedEligibility(offered.token!, who.userId, env)
      return lobbyStub(env).fetch('https://lobby/connect', {
        headers: {
          Upgrade: 'websocket',
          'x-user-id': who.userId,
          'x-username': who.username,
          'x-rated': rated,
        },
      })
    }

    const match = pathname.match(MATCH_PATH)
    if (match) {
      const refused = upgradeRefusal(request)
      if (refused) return refused
      const offered = readSubprotocols(
        request.headers.get('Sec-WebSocket-Protocol'),
      )
      const who = await identify(offered.token, env)
      if (!who) return json({ error: 'unauthorized' }, 401)
      return tableStub(env, match[1]).fetch('https://table/connect', {
        headers: {
          Upgrade: 'websocket',
          'x-user-id': who.userId,
          'x-username': who.username,
        },
      })
    }

    // The landing page: challenge scores, funnel events, score claims.
    const landing = await challengeRoute(request, env, pathname)
    if (landing) return landing

    // A shared challenge score: the app, with the score to beat in its preview.
    if (pathname.startsWith('/c/')) return sharePage(request, env)

    // A shared profile: the app, with that player's link preview.
    if (pathname.startsWith('/u/')) return profilePage(request, env)

    if (pathname.startsWith('/api/') || pathname.startsWith('/ws/'))
      return json({ error: 'not found' }, 404)
    return env.ASSETS.fetch(request)
  },

  // Archived hands to re-verify, and those that could not be.
  async queue(batch: MessageBatch, env: WorkerEnv) {
    if (batch.queue === HANDS_DLQ) await consumeDeadLetters(batch, env)
    else await consumeHands(batch, env)
  },
} satisfies ExportedHandler<WorkerEnv>

/**
 * True when this client address is over its per-minute allowance. Cloudflare
 * sets CF-Connecting-IP on every request it serves; a request without it is
 * local (tests, `wrangler dev` tools) and is not counted.
 */
export async function overAddressLimit(request: Request, env: WorkerEnv) {
  const ip = request.headers.get('CF-Connecting-IP')
  if (!ip) return false
  try {
    const { success } = await env.IP_LIMITER.limit({ key: ip })
    return !success
  } catch (error) {
    // A backstop that fails must not lock everyone out: let it through.
    logEvent('error', { reason: 'ip_limiter', detail: describeError(error) })
    return false
  }
}

/** Why a socket request cannot be upgraded, or null when it can. */
function upgradeRefusal(request: Request) {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
    return json({ error: 'expected a WebSocket upgrade' }, 426)
  if (!originAllowed(request)) return json({ error: 'origin' }, 403)
  const offered = readSubprotocols(
    request.headers.get('Sec-WebSocket-Protocol'),
  )
  // An old client after a deploy: it should reload, not misread frames.
  if (!offered.supported)
    return json({ error: 'unsupported protocol', protocol: PROTOCOL }, 426)
  return null
}
