// GET /u/<username>: the app's page with a link preview for that player
// (P1-15/16), so a shared profile shows the player and their rating on
// LinkedIn or in a chat. Profiles are public: the name and rating ± RD are
// read with the publishable key and written into index.html's preview tags
// with HTMLRewriter's setAttribute, which escapes every value. The app then
// routes the path to #u/<username> (src/lib/profilePath.ts).
import { isProvisional } from '../../src/rating/rules'
import type { WorkerEnv } from './env'
import { describeError, logEvent } from './log'
import { previewPage } from './preview'
import type { PreviewOptions } from './preview'
export { OG_IMAGE, PREVIEW_TTL_S } from './preview'

const PROFILE_PATH = /^\/u\/([a-z0-9_]{3,20})\/?$/

type Found = {
  username: string
  ratings: { rating: number; rd: number; matches: number }[]
}

const GENERIC = {
  title: 'DeltaDeck',
  description:
    'Rated heads-up poker with the luck taken out: ratings shown with their uncertainty, accuracy, and every hand reviewable.',
}

async function lookUp(env: WorkerEnv, name: string): Promise<Found | null> {
  const url = new URL('/rest/v1/players', env.SUPABASE_URL)
  url.searchParams.set('select', 'username,ratings(rating,rd,matches)')
  url.searchParams.set('username', `eq.${name}`)
  url.searchParams.set('ratings.format', 'eq.hu-duplicate')
  const response = await fetch(url, {
    headers: {
      apikey: env.SUPABASE_PUBLISHABLE_KEY,
      Accept: 'application/json',
    },
  })
  if (!response.ok) throw new Error(`players: ${response.status}`)
  const rows = (await response.json()) as Found[]
  return rows[0] ?? null
}

/**
 * What the preview says about a player: their name as validated from the
 * path ([a-z0-9_] only, so it can hold no markup) and public numbers.
 */
export function describePlayer(name: string, found: Found): string {
  const r = found.ratings[0]
  if (!r || r.matches === 0)
    return `${name} plays rated heads-up poker on DeltaDeck.`
  const rating = `${Math.round(r.rating)} ± ${Math.round(r.rd)}`
  const played = `${r.matches} rated heads-up ${r.matches === 1 ? 'match' : 'matches'}`
  return isProvisional(r)
    ? `Provisional rating ${rating} after ${played} on DeltaDeck.`
    : `Rating ${rating} over ${played} on DeltaDeck.`
}

async function preview(env: WorkerEnv, name: string | undefined) {
  if (!name) return { status: 404, ...GENERIC }
  try {
    const found = await lookUp(env, name)
    if (!found) return { status: 404, ...GENERIC }
    return {
      status: 200,
      title: `${name} · DeltaDeck`,
      description: describePlayer(name, found),
    }
  } catch (error) {
    // The page still loads; only its preview is generic.
    logEvent('error', { reason: 'profile', detail: describeError(error) })
    return { status: 200, ...GENERIC }
  }
}

export async function profilePage(
  request: Request,
  env: WorkerEnv,
  options: PreviewOptions = {},
): Promise<Response> {
  const url = new URL(request.url)
  const name = url.pathname.match(PROFILE_PATH)?.[1]
  return previewPage(request, env, options, async () => ({
    ...(await preview(env, name)),
    type: name ? 'profile' : 'website',
  }))
}
