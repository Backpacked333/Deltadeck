// Keeps the header's idea of the account honest while a stored session
// exists: the account client starts (refreshing the session if it can),
// the player's name is loaded into the header's cache, and a session the
// service no longer honours is forgotten, so the header offers Sign in
// again. Mounted lazily by App only while signed in; it never navigates.
import { useEffect } from 'react'
import type { Session } from '@supabase/supabase-js'
import {
  devToken,
  forgetAccount,
  rememberHadAccount,
  rememberUsername,
} from '../lib/account'
import { loadPlayer } from './players'
import { storageKeyFor } from './sessionKey'
import { loadOnline } from './supabase'

function stored(key: string) {
  try {
    return localStorage.getItem(key) !== null
  } catch {
    return false
  }
}

export default function SessionKeeper() {
  useEffect(() => {
    // A development identity has no session to check; neither has a build
    // without an account service (preview, unit tests).
    if (devToken()) return
    let live = true
    let stop = () => {}
    let named: string | null = null

    const apply = async (session: Session | null, key: string) => {
      if (!session) {
        // Offline, supabase-js has no session to give but keeps the stored
        // one for later: only a missing key means signed out.
        if (!stored(key)) forgetAccount()
        return
      }
      const userId = session.user.id
      if (named === userId) return
      named = userId
      const online = await loadOnline()
      if (!online || !live) return
      try {
        const player = await loadPlayer(online.client, userId)
        if (!live) return
        rememberHadAccount()
        if (player) rememberUsername(player.username)
      } catch {
        named = null // try again on the next session event
      }
    }

    void loadOnline().then((online) => {
      if (!online || !live) return
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
    }
  }, [])
  return null
}
