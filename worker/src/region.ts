// Where a new table lives (ADR amendment 2026-10-12, "Live games"). A Durable
// Object runs in one place, picked when it is first used, and every action in
// a heads-up game crosses to it. An invite table is made for the player who
// asks, so it is placed near that player: the host. The friend who joins pays
// one long leg if far away, which no placement can avoid.
//
// A hint only matters when the object is created, and it is a hint, not a
// promise. Pure, so it is tested without a runtime.

/** Cloudflare's location hints for Durable Objects. */
export type Region =
  | 'wnam'
  | 'enam'
  | 'sam'
  | 'weur'
  | 'eeur'
  | 'apac'
  | 'oc'
  | 'afr'
  | 'me'

/** The few request.cf fields used: all may be missing. */
export type CfLocation = {
  continent?: string | null
  country?: string | null
  longitude?: string | number | null
}

/** Where tables were placed before any hint: the lobby lives here too. */
export const DEFAULT_REGION: Region = 'enam'

/**
 * North America splits at 100 degrees west, near the edge of the Great
 * Plains: Vancouver, Denver and Honolulu are west of it, Chicago, Toronto
 * and Mexico City east.
 */
const WNAM_BELOW = -100
/** Europe splits near Warsaw and Athens: the Baltic and the Balkans are east. */
const EEUR_FROM = 20
/** Asian countries that sit nearer the Middle East's location than Asia's. */
const MIDDLE_EAST = new Set([
  'AE',
  'BH',
  'IL',
  'IQ',
  'IR',
  'JO',
  'KW',
  'LB',
  'OM',
  'PS',
  'QA',
  'SA',
  'SY',
  'TR',
  'YE',
])

/**
 * The hint for a request from `cf`: DEFAULT_REGION when the request carries
 * none (tests, local development) or names a continent that has no region.
 */
export function regionHint(cf?: CfLocation | null): Region {
  if (!cf) return DEFAULT_REGION
  const longitude = Number(cf.longitude)
  const known = cf.longitude != null && Number.isFinite(longitude)
  switch (cf.continent) {
    case 'NA':
      return known && longitude < WNAM_BELOW ? 'wnam' : 'enam'
    case 'SA':
      return 'sam'
    case 'EU':
      return known && longitude >= EEUR_FROM ? 'eeur' : 'weur'
    case 'AS':
      return cf.country && MIDDLE_EAST.has(cf.country) ? 'me' : 'apac'
    case 'OC':
      return 'oc'
    case 'AF':
      return 'afr'
    default:
      return DEFAULT_REGION
  }
}
