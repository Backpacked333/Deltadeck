// The account pages, #signup and #signin, and the page a sign-in provider
// (Google, Apple) comes back to with ?code=…. Once the player is signed in,
// a new account goes on to choose its name (#welcome/onboard); anyone else
// goes back to where they were heading, or to the practice table.
import { useEffect, useRef, useState } from 'react'
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
import { activeSync, clearLocalPractice, clearPrivateOutbox } from './sync'
import type { PracticeSync } from './sync'
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

/** Maximum wait per save attempt before offering recovery choices. */
export const SIGN_OUT_WAIT_MS = 3000

/** Forgets this browser's account and its practice data, then starts afresh. */
async function leave(online: Online | null, sync: PracticeSync | null) {
  sync?.stop()
  if (sync) await sync.clearDevice()
  else { await clearPrivateOutbox(); clearLocalPractice() }
  if (online)
    await Promise.race([
      signOutHere(online.client).catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, SIGN_OUT_WAIT_MS)),
    ])
  // auth's convenience helper intentionally swallows storage errors; privacy cannot.
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i)!
    if ((key.startsWith('sb-') && key.endsWith('-auth-token')) || key === 'qp.username') localStorage.removeItem(key)
  }
  sessionStorage.removeItem('qp.devToken')
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
  const sync = useRef(activeSync())
  const account = useRef<string | null | undefined>(sync.current?.scope.accountId)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(true)
  const [exported, setExported] = useState(false)
  const [discard, setDiscard] = useState(false)
  const resolveSync = async () => {
    if (!sync.current) {
      const session = online ? await online.client.auth.getSession() : null
      const accountId = session?.data.session?.user.id ?? null
      if (account.current === undefined) account.current = accountId
      const latest = activeSync()
      if (account.current !== accountId || (latest && latest.scope.accountId !== account.current)) {
        throw new Error('The account changed. Stay signed in and start sign-out again.')
      }
      if (accountId) sync.current = latest
    } else if (activeSync() && activeSync() !== sync.current) {
      throw new Error('The account changed. Stay signed in and start sign-out again.')
    }
    return sync.current
  }
  const complete = async () => {
    setBusy(true)
    try { await leave(online, await resolveSync()) }
    catch { setProblem('Privacy cleanup failed. Private data may remain on this browser. Retry cleanup or clear this site’s data before leaving a shared device.'); setBusy(false) }
  }
  const retry = async () => {
    setBusy(true); setProblem(null)
    try {
      const current = await resolveSync()
      const result = await current?.flush(SIGN_OUT_WAIT_MS)
      if (result?.status !== 'saved') {
        setProblem(`Account save is ${result?.status ?? 'unverified'}. ${result?.reasons.join(' ') ?? 'Account reconciliation has not completed.'}`)
        setBusy(false)
      } else await complete()
    } catch (e) { setProblem(e instanceof Error ? e.message : 'Unable to verify account save.'); setBusy(false) }
  }
  const exportWork = async () => {
    setBusy(true)
    try {
      const current = await resolveSync()
      if (!current) throw new Error('Wait for the account to initialize before exporting.')
      const blob = await current.exportAccount()
      const url = URL.createObjectURL(blob), a = document.createElement('a')
      a.href = url; a.download = `deltadeck-recovery-${Date.now()}.json`
      a.click(); setTimeout(() => URL.revokeObjectURL(url), 60_000)
      setExported(true)
    } catch (e) { setProblem(e instanceof Error ? e.message : 'Export failed. Your work has not been removed.') }
    finally { setBusy(false) }
  }
  useEffect(() => {
    if (started.current) return
    started.current = true
    void retry()
    // This route captures one sign-out attempt; buttons explicitly retry it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online])
  if (!busy)
    return (
      <div className="empty live-empty" role="alert">
        <h3>Your account save is not verified</h3>
        <p>
          Your latest hands, lessons or conflicting versions may only be in this browser.
          Stay signed in and retry, save a recovery export, or explicitly discard unsaved work.
        </p>
        <p>{problem}</p>
        <div className="live-actions">
          <button
            className="btn btn-primary"
            onClick={() => replaceRoute(HOME_ROUTE)}
          >
            Stay signed in
          </button>
          <button
            className="btn btn-outline"
            onClick={() => void retry()}
          >
            Wait and retry save
          </button>
          <button className="btn btn-outline" onClick={() => void exportWork()}>Export and sign out</button>
          {exported && <div>
            <p>The recovery file contains private learning data. Verify the download and keep it secure before continuing.</p>
            <button className="btn btn-outline" onClick={() => void complete()}>I saved the export — sign out</button>
          </div>}
          <button className="btn btn-outline" onClick={() => setDiscard(true)}>Discard unsaved work and sign out</button>
          {discard && <div>
            <p>This permanently removes this browser’s unsaved work and recovery copies. It does not delete data already saved to your account.</p>
            <button className="btn btn-outline" onClick={() => void complete()}>Confirm permanent discard and sign out</button>
          </div>}
        </div>
      </div>
    )
  return (
    <p className="live-status" role="status">
      Signing you out…
    </p>
  )
}
