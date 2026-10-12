// HTTP calls to the table server (same origin as the page in production).
import { GAME_CODE_RE } from '../shared/gameCode'

const apiOrigin = () =>
  (import.meta.env.VITE_API_ORIGIN as string | undefined) ?? ''

export type Identity = {
  player: { userId: string; username: string }
  /** A fresh access token for each request or socket. */
  getToken: () => Promise<string | null>
  signOut: () => void
}

/** Opens a heads-up table; the caller takes seat 0 and shares the link. */
export async function createMatch(
  getToken: Identity['getToken'],
  fetcher: typeof fetch = fetch,
): Promise<
  | { ok: true; matchId: string }
  | { ok: false; reason: string; activeMatch?: string }
> {
  const token = await getToken()
  if (!token) return { ok: false, reason: 'Sign in again to create a table.' }
  try {
    const response = await fetcher(`${apiOrigin()}/api/matches`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
    if (response.status === 201) {
      const { matchId } = (await response.json()) as { matchId: string }
      return { ok: true, matchId }
    }
    if (response.status === 409) {
      const { matchId } = (await response.json()) as { matchId: string }
      return {
        ok: false,
        reason: 'You are already playing at another table.',
        activeMatch: matchId,
      }
    }
    return {
      ok: false,
      reason:
        response.status === 401
          ? 'Your session expired. Sign in again.'
          : 'Could not create a table. Try again in a moment.',
    }
  } catch {
    return { ok: false, reason: 'No connection to the table server.' }
  }
}

/**
 * Opens a heads-up table the way "Play a friend" does and says whether it is
 * to be listed among the open games (ADR amendment 2026-10-12, "Live games").
 * The server lists it only for an account with a confirmed email: `listed` in
 * the answer is what it did, not what was asked. `code` is the table's game
 * code (null if the server sent none). The list's handle is never returned:
 * the host has the link and the code, and that is all anyone is given.
 */
export async function createGame(
  getToken: Identity['getToken'],
  { listed }: { listed: boolean },
  fetcher: typeof fetch = fetch,
): Promise<
  | { ok: true; matchId: string; code: string | null; listed: boolean }
  | { ok: false; reason: string; activeMatch?: string }
> {
  const token = await getToken()
  if (!token) return { ok: false, reason: 'Sign in again to create a table.' }
  try {
    const response = await fetcher(`${apiOrigin()}/api/matches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ listed }),
    })
    if (response.status === 201) {
      const made = (await response.json()) as {
        matchId: string
        code?: unknown
        listed?: unknown
      }
      return {
        ok: true,
        matchId: made.matchId,
        code:
          typeof made.code === 'string' && GAME_CODE_RE.test(made.code)
            ? made.code
            : null,
        listed: made.listed === true,
      }
    }
    if (response.status === 409) {
      const { matchId } = (await response.json()) as { matchId: string }
      return {
        ok: false,
        reason: 'You are already playing at another table.',
        activeMatch: matchId,
      }
    }
    return {
      ok: false,
      reason:
        response.status === 401
          ? 'Your session expired. Sign in again.'
          : 'Could not create a table. Try again in a moment.',
    }
  } catch {
    return { ok: false, reason: 'No connection to the table server.' }
  }
}

/** The table this account is playing at, if any. */
export async function fetchActiveMatch(
  getToken: Identity['getToken'],
  fetcher: typeof fetch = fetch,
): Promise<string | null> {
  const token = await getToken()
  if (!token) return null
  try {
    const response = await fetcher(`${apiOrigin()}/api/me`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!response.ok) return null
    return ((await response.json()) as { activeMatch: string | null })
      .activeMatch
  } catch {
    return null
  }
}

export const inviteLink = (
  matchId: string,
  location: Location = window.location,
) => `${location.origin}${location.pathname}#play/${matchId}`

/**
 * The link that seats whoever opens it with the game's code: `#join/CODE`,
 * no hyphen (the code is typed or said as XXX-XXX, linked as XXXXXX).
 */
export const joinCodeLink = (
  code: string,
  location: Location = window.location,
) => `${location.origin}${location.pathname}#join/${code}`

/**
 * Development and end-to-end tests only: `sessionStorage['qp.devToken'] =
 * 'dev.<user>.<secret>'` plays as <user> without an account. The server
 * accepts these only when it was started with DEV_AUTH_SECRET, which
 * production never has.
 */
export function devIdentity(
  storage: Storage = sessionStorage,
): Identity | null {
  let token: string | null = null
  try {
    token = storage.getItem('qp.devToken')
  } catch {
    return null
  }
  const match = token?.match(/^dev\.([\w-]{1,64})\.[\w-]+$/)
  if (!token || !match) return null
  return {
    player: { userId: match[1], username: match[1] },
    getToken: async () => token,
    signOut: () => {
      storage.removeItem('qp.devToken')
      window.location.reload()
    },
  }
}
