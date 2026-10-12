import { useEffect, useState, useSyncExternalStore } from 'react'
import { PING_EVERY_MS } from './heartbeat'
import { INITIAL_LOBBY, LobbyConnection } from './lobbyClient'

const noSubscription = () => () => {}

/** The lobby connection for as long as the lobby page is open. */
export function useLobby(getToken: () => Promise<string | null>) {
  const [connection, setConnection] = useState<LobbyConnection | null>(null)
  useEffect(() => {
    const next = new LobbyConnection(getToken, { heartbeatMs: PING_EVERY_MS })
    setConnection(next)
    next.start()
    return () => next.stop()
  }, [getToken])
  const state = useSyncExternalStore(
    connection?.subscribe ?? noSubscription,
    () => connection?.getState() ?? INITIAL_LOBBY,
  )
  return { state, connection }
}
