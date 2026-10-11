// The account pages, #signup and #signin, and the page a sign-in provider
// (Google, Apple) comes back to with ?code=…. Once the player is signed in,
// a new account goes on to choose its name (#welcome/onboard); anyone else
// goes back to where they were heading, or to the practice table.
import { useEffect, useRef, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  rememberAuthReturn,
  replaceRoute,
  takeAuthReturn,
} from '../lib/authReturn'
import { readPendingClaim } from '../lib/landing'
import { useAuth } from './auth'
import { NotConfigured } from './AuthGate'
import { loadPlayer, PLACEHOLDER } from './players'
import { SignIn } from './SignIn'
import type { SignInMode } from './SignIn'
import type { Online } from './supabase'

const ONBOARD = '#welcome/onboard'
/** Where a signed-in player goes when nothing else was remembered. */
export const HOME_ROUTE = '#table'

/**
 * Sends a player who has just signed in on: a new account to choose its
 * name first, keeping `destination` for after; anyone else to `destination`.
 */
async function onward(
  client: SupabaseClient,
  userId: string,
  destination: string,
) {
  let named = true
  try {
    const player = await loadPlayer(client, userId)
    named = !!player && !PLACEHOLDER.test(player.username)
  } catch {
    // Unreadable now: onboarding checks again and asks for a name if needed.
    named = false
  }
  if (named) replaceRoute(destination)
  else {
    if (destination !== ONBOARD) rememberAuthReturn(destination)
    replaceRoute(ONBOARD)
  }
}

export function AccountPage({
  online,
  mode,
}: {
  online: Online | null
  mode: SignInMode
}) {
  if (!online) return <NotConfigured />
  return <Account online={online} mode={mode} />
}

function Account({ online, mode }: { online: Online; mode: SignInMode }) {
  const auth = useAuth(online.client)
  const [pending] = useState(readPendingClaim)
  const userId = auth.status === 'signed-in' ? auth.session.user.id : null
  const sent = useRef(false)

  // The remembered route is taken only now: a provider sign-in started here
  // leaves the page and must still find it when it comes back.
  useEffect(() => {
    if (!userId || sent.current) return
    sent.current = true
    void onward(online.client, userId, takeAuthReturn() ?? HOME_ROUTE)
  }, [online.client, userId])

  if (auth.status === 'signed-out')
    return (
      <SignIn
        key={mode}
        client={online.client}
        url={online.url}
        apiKey={online.key}
        mode={mode}
        titles={
          pending
            ? { signup: `Save your score of ${pending.accuracy} and get rated` }
            : {}
        }
      />
    )
  return (
    <p className="live-status" role="status">
      {auth.status === 'loading' ? 'Checking your account…' : 'Signing you in…'}
    </p>
  )
}

/**
 * Back from Google or Apple. supabase-js swaps the ?code for a session as
 * the client starts; this waits for it, then moves on. `route` is the page
 * the player was on when they left (restored by authReturn), if any.
 */
export function AuthCallback({
  online,
  route,
}: {
  online: Online | null
  route: string
}) {
  const [problem] = useState(
    () =>
      new URLSearchParams(window.location.search).get('error_description') ??
      null,
  )
  if (problem) return <CallbackFailed message={problem} route={route} />
  if (!online) return <NotConfigured />
  return <Callback client={online.client} route={route} />
}

function Callback({
  client,
  route,
}: {
  client: SupabaseClient
  route: string
}) {
  const auth = useAuth(client)
  const userId = auth.status === 'signed-in' ? auth.session.user.id : null
  const sent = useRef(false)
  useEffect(() => {
    if (!userId || sent.current) return
    sent.current = true
    void onward(client, userId, route || HOME_ROUTE)
  }, [client, userId, route])

  if (auth.status === 'signed-out')
    return (
      <CallbackFailed
        message="This sign-in has expired, or was opened in a different browser."
        route={route}
      />
    )
  return (
    <p className="live-status" role="status">
      Signing you in…
    </p>
  )
}

function CallbackFailed({
  message,
  route,
}: {
  message: string
  route: string
}) {
  return (
    <div className="empty live-empty" role="alert">
      <h3>Sign-in did not finish</h3>
      <p>{message}</p>
      <button
        className="btn btn-primary"
        onClick={() => {
          if (route) rememberAuthReturn(route)
          replaceRoute('#signin')
        }}
      >
        Try again
      </button>
    </div>
  )
}
