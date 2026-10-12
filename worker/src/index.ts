// The Worker in front of everything. Static files come from ./dist without
// reaching this code; only the page itself (/), /api/*, /ws/*, /u/* and /c/*
// do (see wrangler.jsonc).
import { PROTOCOL } from '../../src/shared/protocol'
import {
  bearerToken,
  identify,
  identityHeaders,
  primeKeys,
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
import { regionHint } from './region'
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

/** The largest `POST /api/matches` body read: `{"listed":true}` is 15 bytes. */
const MATCH_BODY_MAX = 256

/**
 * The options of `POST /api/matches`: an absent or empty body is the plain
 * invite the client has always asked for (unlisted); otherwise a JSON object
 * with `listed` and nothing else. Null for anything else, which is a 400:
 * the body is never logged, and `kind` is not read from it (nor from
 * anywhere in the request), so a client cannot ask for another sort of table.
 */
async function readMatchOptions(
  request: Request,
): Promise<{ listed: boolean } | null> {
  let text = ''
  if (request.body) {
    // Read at most MATCH_BODY_MAX bytes: a larger body is refused unread.
    const reader = request.body.getReader()
    const decoder = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
      if (text.length > MATCH_BODY_MAX) {
        await reader.cancel()
        return null
      }
    }
  }
  if (!text.trim()) return { listed: false }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return null
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const keys = Object.keys(body)
  if (keys.some((key) => key !== 'listed')) return null
  const { listed } = body as { listed?: unknown }
  if (listed !== undefined && typeof listed !== 'boolean') return null
  return { listed: listed === true }
}

export default {
  async fetch(
    request: Request,
    env: WorkerEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const { pathname } = new URL(request.url)

    const moved = canonicalRedirect(request, env.CANONICAL_ORIGIN)
    if (moved) return moved

    if (pathname === '/api/health')
      return json({ ok: true, protocol: PROTOCOL })

    // Browser-safe settings for the online area, so the static build needs
    // no environment variables.
    if (pathname === '/api/config') {
      // The page asks this as it loads, before any sign-in: the signing keys
      // are fetched now, off this response, so the first connect of a fresh
      // isolate does not wait on them.
      ctx.waitUntil(primeKeys(env))
      return json({
        supabaseUrl: env.SUPABASE_URL,
        supabaseKey: env.SUPABASE_PUBLISHABLE_KEY,
      })
    }

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
    // The table also gets a code, and is listed if the caller asks and may
    // (ADR amendment 2026-10-12, "Live games").
    if (pathname === '/api/matches' && request.method === 'POST') {
      const token = bearerToken(request)
      const who = await identify(token, env)
      if (!who) return json({ error: 'unauthorized' }, 401)
      const options = await readMatchOptions(request)
      if (!options) return json({ error: 'bad request' }, 400)
      // Where the host is: the table is made near them, since every move of
      // the game goes to it. Only the creating /init uses the hint.
      // (request.cf is typed for outgoing requests too; an incoming one
      // carries the caller's location, and none at all in local tests.)
      const hint = regionHint(
        request.cf as IncomingRequestCfProperties | undefined,
      )
      // Listing needs what rated play needs, a confirmed email: a free
      // anonymous account could otherwise fill the list. Without it the game
      // is made, unlisted, and the answer says so.
      const mayList =
        options.listed &&
        (await ratedEligibility(token!, who.userId, env)) === 'yes'
      const matchId = crypto.randomUUID()
      // One table per account: finish the one you are playing first. And a
      // daily cap, so one account cannot create tables without end.
      const lobby = lobbyStub(env)
      const verdict = await lobby.createMatch(who.userId, matchId, {
        listed: mayList,
        hostName: who.username,
      })
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
      // Five codes in a row were taken: a moment later there will be a free one.
      if (
        verdict.refused ||
        !verdict.code ||
        !verdict.gameId ||
        verdict.listed === undefined
      )
        return json({ error: 'busy' }, 503, { 'Retry-After': '2' })
      // The code, handle and listing are the Worker's: nothing here comes
      // from the request but what it asked for, and the lobby (a full list
      // makes a game unlisted) decides whether it is listed.
      const { code, listed } = verdict
      // The picture and badge come with the creator's socket, as for anyone.
      const body: InitBody = {
        matchId,
        creator: { userId: who.userId, username: who.username },
        code,
        gameId: verdict.gameId,
        listed,
      }
      let created: Response | null = null
      try {
        created = await tableStub(env, matchId, hint).fetch(
          'https://table/init',
          { method: 'POST', body: JSON.stringify(body) },
        )
      } catch (error) {
        // It may have been made: the rows stay, and with no heartbeat go
        // stale (GAME_STALE_MS).
        logEvent('error', {
          matchId,
          reason: 'table_init',
          detail: describeError(error),
        })
      }
      // Refused: no table, so no game. The rows go and the day's create is
      // given back.
      if (created && !created.ok) await lobby.createFailed(who.userId, matchId)
      return created?.ok
        ? json({ matchId, code, listed }, 201)
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
          // The picture and badge a table shows beside the name.
          ...identityHeaders(who),
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
