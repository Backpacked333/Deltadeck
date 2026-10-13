// Keeps the account honest while a stored session exists: the account
// client starts (refreshing the session if it can), the player's name is
// loaded into the header's cache, a session the service no longer honours
// is forgotten (so the header offers Sign in again), and the player's
// practice history is merged with the account's and kept in sync with it
// (src/net/sync.ts). Mounted lazily by App only while signed in; it never
// navigates.
import { useEffect, useRef, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import {
  devToken,
  forgetAccount,
  rememberHadAccount,
  rememberUsername,
} from '../lib/account'
import type { Progress } from '../lib/storage'
import { loadPlayer } from './players'
import { storageKeyFor } from './sessionKey'
import { loadOnline } from './supabase'
import { activeSync, PracticeSync, SYNC_CHANGED } from './sync'
import { startEvidenceBootstrap } from './evidenceBootstrap'

function stored(key: string) {
  try {
    return localStorage.getItem(key) !== null
  } catch {
    return false
  }
}

export type SessionKeeperProps = {
  /** The app's practice progress, as it stands. */
  progress: Progress
  /** Applies a change to it (React's state updater). */
  onMerge: (update: (current: Progress) => Progress) => void
  /** Reloads the curriculum after its stored copy was replaced. */
  onLearningReplaced: () => void
  /** The account's history has been reconciled. Failure is not readiness. */
  onReady: () => void
}

export default function SessionKeeper({
  progress,
  onMerge,
  onLearningReplaced,
  onReady,
}: SessionKeeperProps) {
  const sync = useRef<PracticeSync | null>(null)
  const latest = useRef(progress)
  latest.current = progress
  const [, refresh] = useState(0)
  // The latest callbacks, so the session effect runs once.
  const hooks = useRef({ onMerge, onLearningReplaced, onReady })
  hooks.current = { onMerge, onLearningReplaced, onReady }

  useEffect(() => {
    // A development identity has no session to check; neither has a build
    // without an account service (preview, unit tests).
    if (devToken()) {
      hooks.current.onReady()
      return
    }
    let live = true
    let stop = () => {}
    let user: string | null = null
    let generation = 0
    const changed = () => {
      refresh((n) => n + 1)
      if (sync.current?.isReconciled()) hooks.current.onReady()
    }
    window.addEventListener(SYNC_CHANGED, changed)

    const apply = async (session: Session | null, key: string) => {
      if (!session) {
        // Offline, supabase-js has no session to give but keeps the stored
        // one for later: only a missing key means signed out.
        if (!stored(key)) {
          generation++
          user = null
          sync.current?.stop()
          sync.current = null
          forgetAccount()
        }
        return
      }
      const userId = session.user.id
      if (user === userId) return
      user = userId
      const mine = ++generation
      const online = await loadOnline()
      if (!online || !live || generation !== mine) return
      sync.current?.stop()
      const next = new PracticeSync(online.client, userId, {
        merge: (update) => hooks.current.onMerge(update),
        reloadLearning: () => hooks.current.onLearningReplaced(),
      })
      sync.current = next
      next.note(latest.current)
      void startEvidenceBootstrap(next)
      void next.start()
      try {
        const player = await loadPlayer(online.client, userId)
        if (!live || generation !== mine) return
        rememberHadAccount()
        if (player) rememberUsername(player.username)
      } catch {
        // The header keeps its cached name; the next session event retries.
      }
    }

    void loadOnline().then((online) => {
      if (!live) return
      if (!online) {
        hooks.current.onReady()
        return
      }
      const key = storageKeyFor(online.url)
      const { data } = online.client.auth.onAuthStateChange((_, session) => {
        // Deferred: supabase-js holds a lock while it notifies listeners.
        setTimeout(() => live && void apply(session, key), 0)
      })
      stop = () => data.subscription.unsubscribe()
    })
    return () => {
      live = false
      window.removeEventListener(SYNC_CHANGED, changed)
      stop()
      sync.current?.stop()
      sync.current = null
    }
  }, [])

  useEffect(() => {
    sync.current?.note(progress)
  }, [progress])

  const current = activeSync()
  if (!current) return null
  const status = current.status()
  const labels = {
    checking_account: 'Checking your account — not yet verified as saved',
    saved_on_device: 'Saved on this device',
    saving: 'Saving to your account…',
    saved_to_account: 'Saved to your account',
    offline_local_changes: 'Offline — account save pending',
    conflict:
      'Both versions preserved — choose how to resolve learning changes',
    blocked: 'Account save blocked — export your work before leaving',
    unable_to_verify:
      'Unable to verify account history — new work is retained on this device',
  }
  return (
    <aside aria-label="Learning save status" className="live-status">
      <p role="status">{labels[status]}</p>
      {['unable_to_verify', 'offline_local_changes', 'blocked'].includes(
        status,
      ) && (
        <button
          className="btn btn-outline"
          onClick={() => void current.flush(3000)}
        >
          Retry account save
        </button>
      )}
      {current.hasUnclaimed() && (
        <div>
          <p>
            Guest work is unclaimed. Import it into account {current.userId}{' '}
            only if it is yours.
          </p>
          <button
            className="btn btn-outline"
            disabled={
              status === 'checking_account' || status === 'unable_to_verify'
            }
            onClick={() => current.claimGuest(current.userId)}
          >
            Import my guest work into this account
          </button>
        </div>
      )}
      {current.conflicts().map((conflict) => (
        <details key={conflict.key}>
          <summary>Learning conflict: {conflict.key}</summary>
          <p>
            Neither version was silently overwritten. Export before choosing if
            you need to keep both.
          </p>
          <pre>
            {JSON.stringify(
              { local: conflict.local, account: conflict.remote },
              null,
              2,
            )}
          </pre>
          {conflict.reason !== 'deleted_on_account' && (
            <button
              className="btn btn-outline"
              onClick={() => current.resolveConflict(conflict.key, 'local')}
            >
              Use this device version
            </button>
          )}
          <button
            className="btn btn-outline"
            onClick={() => current.resolveConflict(conflict.key, 'remote')}
          >
            Use account version
          </button>
        </details>
      ))}
    </aside>
  )
}
