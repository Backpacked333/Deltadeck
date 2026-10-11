// The landing page's entry-side helpers: who is signed in, who is back from
// a sign-in redirect, and the score waiting to be saved. Entry-safe: plain
// storage reads, no imports from the landing or online chunks.
export const PENDING_CLAIM_KEY = 'qp.pendingClaim'

/** A score waiting to be attached to an account after sign-up (O-4). */
export type PendingClaim = {
  receipt: string
  hand: string
  ver: number
  accuracy: number
  percentile: number | null
  at: number
}

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/** True when this browser holds a Supabase session (any project). */
export function signedIn() {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i) ?? ''
      if (key.startsWith('sb-') && key.endsWith('-auth-token')) return true
    }
  } catch {
    // Storage blocked: treat as signed out.
  }
  return false
}

/**
 * Back from a sign-in provider with no route to restore (authReturn): the
 * bare URL then opens the app, which finishes the sign-in, not the landing.
 */
export function backFromSignIn(search = window.location.search) {
  const params = new URLSearchParams(search)
  return params.has('code') || params.has('error_description')
}

export function savePendingClaim(claim: PendingClaim) {
  try {
    localStorage.setItem(PENDING_CLAIM_KEY, JSON.stringify(claim))
  } catch {
    // Without storage the score stays on this page only.
  }
}

export function readPendingClaim(): PendingClaim | null {
  try {
    const raw = read(PENDING_CLAIM_KEY)
    const claim = raw ? (JSON.parse(raw) as PendingClaim) : null
    return claim && /^[0-9a-f]{32}$/.test(claim.receipt) ? claim : null
  } catch {
    return null
  }
}

export function clearPendingClaim() {
  try {
    localStorage.removeItem(PENDING_CLAIM_KEY)
  } catch {
    // Nothing to clear.
  }
}
