// Who is signed in, as far as the entry chunk can tell without the account
// client: a stored session that has the shape supabase-js writes, or a
// development token. The online chunk confirms it with the server and keeps
// the cached username here so the header can name the player at once.
// Entry-safe: plain storage reads, nothing from src/net.
import { useSyncExternalStore } from 'react'

const USERNAME_KEY = 'qp.username'
const HAD_ACCOUNT_KEY = 'qp.hadAccount'
const DEV_TOKEN_KEY = 'qp.devToken'
/** Fired on this window when the stored account changes. */
export const ACCOUNT_EVENT = 'qp-account'

const isSessionKey = (key: string) =>
  key.startsWith('sb-') && key.endsWith('-auth-token')

/** A stored session with both tokens, an expiry and a user. */
function looksLikeSession(raw: string | null) {
  try {
    const value = raw ? (JSON.parse(raw) as Record<string, unknown>) : null
    const user = value?.user as Record<string, unknown> | undefined
    return (
      typeof value?.access_token === 'string' &&
      typeof value.refresh_token === 'string' &&
      typeof value.expires_at === 'number' &&
      typeof user?.id === 'string'
    )
  } catch {
    return false
  }
}

/** True when this browser holds a usable-looking session (any project). */
export function hasStoredSession() {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i) ?? ''
      if (isSessionKey(key) && looksLikeSession(localStorage.getItem(key)))
        return true
    }
  } catch {
    // Storage blocked: treat as signed out.
  }
  return false
}

/** A development identity (`dev.<user>.<secret>`), for local and e2e play. */
export function devToken() {
  try {
    const token = sessionStorage.getItem(DEV_TOKEN_KEY)
    return token && /^dev\.[\w-]{1,64}\.[\w-]+$/.test(token) ? token : null
  } catch {
    return null
  }
}

export function signedIn() {
  return hasStoredSession() || devToken() !== null
}

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/** The signed-in player's username, as last loaded from the server. */
export function cachedUsername() {
  const name = read(USERNAME_KEY)
  return name && /^[a-z0-9_]{3,20}$/.test(name) ? name : null
}

/** Tells the header (this window) that the stored account changed. */
export function notifyAccount() {
  window.dispatchEvent(new Event(ACCOUNT_EVENT))
}

export function rememberUsername(name: string | null) {
  try {
    if (name) localStorage.setItem(USERNAME_KEY, name)
    else localStorage.removeItem(USERNAME_KEY)
  } catch {
    // The header falls back to "Account".
  }
  notifyAccount()
}

/**
 * Forgets this browser's account: the stored sessions (in case the account
 * service could not be told), the cached name and a development identity.
 */
export function forgetAccount() {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i) ?? ''
      if (isSessionKey(key)) localStorage.removeItem(key)
    }
    localStorage.removeItem(USERNAME_KEY)
    sessionStorage.removeItem(DEV_TOKEN_KEY)
  } catch {
    // Storage blocked: nothing was stored either.
  }
  notifyAccount()
}

/** Whether this browser has signed in before: the gate offers sign-in. */
export function hadAccount() {
  return read(HAD_ACCOUNT_KEY) === '1'
}

export function rememberHadAccount() {
  try {
    localStorage.setItem(HAD_ACCOUNT_KEY, '1')
  } catch {
    // The gate offers sign-up instead, with a link to sign in.
  }
}

const subscribe = (listener: () => void) => {
  window.addEventListener('hashchange', listener)
  window.addEventListener('storage', listener)
  window.addEventListener(ACCOUNT_EVENT, listener)
  return () => {
    window.removeEventListener('hashchange', listener)
    window.removeEventListener('storage', listener)
    window.removeEventListener(ACCOUNT_EVENT, listener)
  }
}

// One string per state, so React compares snapshots by value.
const snapshot = () => (signedIn() ? `in:${cachedUsername() ?? ''}` : 'out')

export type Account = { signedIn: boolean; username: string | null }

/** The account as the header shows it, updated when it changes. */
export function useAccount(): Account {
  const state = useSyncExternalStore(subscribe, snapshot)
  return state === 'out'
    ? { signedIn: false, username: null }
    : { signedIn: true, username: state.slice(3) || null }
}
