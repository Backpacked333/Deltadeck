// Sign-in providers redirect back to the bare origin with ?code=…, which knows
// nothing about hash routes. Before leaving, the online chunk records where
// to come back to; on return this restores that route so the online chunk
// loads and finishes the sign-in. It lives in the entry chunk, so it must stay
// tiny and import nothing from src/net.
const KEY = 'qp.afterAuth'
const SAFE = /^#[\w/-]+$/

/** The account pages: never a place to come back to after signing in. */
export const ACCOUNT_ROUTES = ['#signup', '#signin', '#signout']
export const isAccountRoute = (hash: string) => ACCOUNT_ROUTES.includes(hash)

export function rememberAuthReturn(hash: string) {
  try {
    sessionStorage.setItem(KEY, hash)
  } catch {
    // Storage blocked: the user lands on the table and can reopen the lobby.
  }
}

export function restoreAuthReturn(location: Location = window.location) {
  const params = new URLSearchParams(location.search)
  if (!params.has('code') && !params.has('error_description')) return
  let target: string | null = null
  try {
    target = sessionStorage.getItem(KEY)
    sessionStorage.removeItem(KEY)
  } catch {
    return
  }
  if (!target || !SAFE.test(target) || location.hash === target) return
  window.history.replaceState(
    null,
    '',
    `${location.pathname}${location.search}${target}`,
  )
}

/**
 * Where a player who has just signed in was going, once: the route the gate
 * or "Save your score" remembered. Null when there is none, or when it is
 * an account page itself.
 */
export function takeAuthReturn(): string | null {
  let target: string | null = null
  try {
    target = sessionStorage.getItem(KEY)
    sessionStorage.removeItem(KEY)
  } catch {
    return null
  }
  return target && SAFE.test(target) && !isAccountRoute(target) ? target : null
}

/** What a sign-in provider adds to the address on its way back. */
const PROVIDER_PARAMS = [
  'code',
  'state',
  'error',
  'error_code',
  'error_description',
]

/**
 * Moves to a route in place of the current one, dropping any sign-in query
 * (?code=…) but keeping the page's own options (?seed, ?motion), and tells
 * the app: replaceState fires no hashchange, and the route may be the one
 * already in the address bar.
 */
export function replaceRoute(hash: string) {
  const query = new URLSearchParams(window.location.search)
  for (const name of PROVIDER_PARAMS) query.delete(name)
  const search = query.size ? `?${query}` : ''
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${search}${hash}`,
  )
  window.dispatchEvent(new HashChangeEvent('hashchange'))
}
