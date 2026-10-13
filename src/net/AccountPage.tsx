// The account pages, #signup and #signin, and the page a sign-in provider
// (Google, Apple) comes back to with ?code=…. Once the player is signed in,
// a new account goes on to choose its name (#welcome/onboard); anyone else
// goes back to where they were heading, or to the practice table.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  forgetAccount,
  rememberHadAccount,
  rememberUsername,
} from '../lib/account'
import {
  rememberAuthReturn,
  replaceRoute,
  takeAuthReturn,
} from '../lib/authReturn'
import { readPendingClaim } from '../lib/landing'
import { signOutHere, useAuth } from './auth'
import { NotConfigured } from './AuthGate'
import { loadPlayer, PLACEHOLDER } from './players'
import { SignIn } from './SignIn'
import {
  activeSync,
  clearLocalPractice,
  exportLocalPractice,
  hasLocalWork,
} from './sync'
import type { SaveState } from './sync'
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
    rememberHadAccount()
    rememberUsername(player?.username ?? null)
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

/** Saves this browser's practice as a file the player keeps. */
function downloadPractice() {
  const blob = new Blob([exportLocalPractice()], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `deltadeck-practice-${new Date().toISOString().slice(0, 10)}.json`
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/** How long sign-out waits for the account service before going anyway. */
export const SIGN_OUT_WAIT_MS = 3000

/** Forgets this browser's account and its practice data, then starts afresh. */
async function leave(online: Online | null) {
  clearLocalPractice()
  if (online)
    await Promise.race([
      signOutHere(online.client).catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, SIGN_OUT_WAIT_MS)),
    ])
  forgetAccount()
  window.location.replace(window.location.pathname)
}

/**
 * #signout: the practice hands still on their way reach the account first
 * (3 s at most; the player decides if some cannot), then this browser
 * forgets the session (other devices stay signed in) and its practice data,
 * and reloads at the home page, so nothing of the account stays in memory.
 */
export function SignOut({ online }: { online: Online | null }) {
  const started = useRef(false)
  // Why sign-out waits for the player: anything but `saved` (audit F08,
  // F10). With no running sync there is nothing to ask, and nothing is
  // known to be on the account either: practice here is "unverified".
  const [unsaved, setUnsaved] = useState<Exclude<SaveState, 'saved'> | null>(
    null,
  )
  const [trying, setTrying] = useState(false)
  const attempt = useCallback(async () => {
    const sync = activeSync()
    const state: SaveState = sync
      ? await sync.flush(SIGN_OUT_WAIT_MS)
      : hasLocalWork()
        ? 'unverified'
        : 'saved'
    if (state === 'saved') await leave(online)
    else setUnsaved(state)
  }, [online])
  useEffect(() => {
    if (started.current) return
    started.current = true
    void attempt()
  }, [attempt])
  if (unsaved)
    return (
      <div className="empty live-empty" role="alert">
        <h3>
          {unsaved === 'unverified'
            ? 'We could not check what your account holds'
            : 'Some practice is not saved to your account yet'}
        </h3>
        <p>
          {unsaved === 'unverified'
            ? 'Your account could not be reached since this page opened, so the hands and lessons in this browser may not be on it.'
            : unsaved === 'blocked'
              ? 'Some of your practice is too large for your account, or over today’s limit, so it is only in this browser.'
              : 'We could not reach the server, so your latest hands or lessons are only in this browser.'}{' '}
          Signing out removes them from this browser. Download a copy to keep
          them.
        </p>
        <div className="live-actions">
          <button
            className="btn btn-primary"
            onClick={() => replaceRoute(HOME_ROUTE)}
          >
            Stay signed in
          </button>
          {unsaved !== 'blocked' && (
            <button
              className="btn btn-outline"
              disabled={trying}
              onClick={() => {
                setTrying(true)
                void attempt().finally(() => setTrying(false))
              }}
            >
              {trying ? 'Trying…' : 'Try again'}
            </button>
          )}
          <button className="btn btn-outline" onClick={downloadPractice}>
            Download a copy
          </button>
          <button
            className="btn btn-outline"
            onClick={() => void leave(online)}
          >
            Discard and sign out
          </button>
        </div>
      </div>
    )
  return (
    <p className="live-status" role="status">
      Signing you out…
    </p>
  )
}
