// Keeps the account honest while a stored session exists: the account
// client starts (refreshing the session if it can), the player's name is
// loaded into the header's cache, a session the service no longer honours
// is forgotten (so the header offers Sign in again), and the player's
// practice history is merged with the account's and kept in sync with it
// (src/net/sync.ts). Mounted lazily by App only while signed in; it never
// navigates.
import { useEffect, useRef } from 'react'
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
import { PracticeSync } from './sync'

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
  /** The account's history has been merged in, or could not be read. */
  onReady: () => void
}

export default function SessionKeeper({
  progress,
  onMerge,
  onLearningReplaced,
  onReady,
}: SessionKeeperProps) {
  const sync = useRef<PracticeSync | null>(null)
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

    const apply = async (session: Session | null, key: string) => {
      if (!session) {
        // Offline, supabase-js has no session to give but keeps the stored
        // one for later: only a missing key means signed out.
        if (!stored(key)) forgetAccount()
        hooks.current.onReady()
        return
      }
      const userId = session.user.id
      if (user === userId) return
      user = userId
      const online = await loadOnline()
      if (!online || !live) return
      sync.current?.stop()
      const next = new PracticeSync(online.client, userId, {
        merge: (update) => hooks.current.onMerge(update),
        reloadLearning: () => hooks.current.onLearningReplaced(),
      })
      sync.current = next
      void next
        .start()
        .catch(() => {})
        .finally(() => live && hooks.current.onReady())
      try {
        const player = await loadPlayer(online.client, userId)
        if (!live) return
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
      stop()
      sync.current?.stop()
      sync.current = null
    }
  }, [])

  useEffect(() => {
    sync.current?.note(progress)
  }, [progress])

  return null
}
