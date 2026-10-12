import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { PlayerAction, SeatId } from '../engine/types'
import { INITIAL_STATE, TableConnection } from './client'
import { PING_EVERY_MS } from './heartbeat'
import type { RttStore } from './heartbeat'

const noSubscription = () => () => {}
const noRtt = () => null

/**
 * The round-trip time to the server in ms (to the nearest 5), or null before
 * a ping has come back. Read through a store of its own, so a ping every few
 * seconds re-renders only the component that shows it.
 */
export function useRtt(store: RttStore | null): number | null {
  return useSyncExternalStore(
    store?.subscribe ?? noSubscription,
    store?.getSnapshot ?? noRtt,
  )
}

/** Connects to a live table for as long as the component is mounted. */
export function useTable(
  matchId: string,
  getToken: () => Promise<string | null>,
) {
  const [connection, setConnection] = useState<TableConnection | null>(null)
  useEffect(() => {
    const next = new TableConnection(matchId, getToken, {
      heartbeatMs: PING_EVERY_MS,
    })
    setConnection(next)
    next.start()
    return () => next.stop()
  }, [matchId, getToken])
  const state = useSyncExternalStore(
    connection?.subscribe ?? noSubscription,
    () => connection?.getState() ?? INITIAL_STATE,
  )
  const act = useCallback(
    (action: PlayerAction) => connection?.act(action) ?? false,
    [connection],
  )
  const rematch = useCallback(
    () => connection?.rematch() ?? false,
    [connection],
  )
  const sit = useCallback(
    (seat?: SeatId) => connection?.sit(seat) ?? false,
    [connection],
  )
  const resync = useCallback(() => connection?.resync() ?? false, [connection])
  const rebuy = useCallback(() => connection?.rebuy() ?? false, [connection])
  const stand = useCallback(() => connection?.stand() ?? false, [connection])
  const sitOut = useCallback(() => connection?.sitOut() ?? false, [connection])
  const sitIn = useCallback(() => connection?.sitIn() ?? false, [connection])
  const answer = useCallback(
    (requestId: string, accept: boolean) =>
      connection?.answer(requestId, accept) ?? false,
    [connection],
  )
  return {
    state,
    act,
    rematch,
    sit,
    resync,
    rebuy,
    stand,
    sitOut,
    sitIn,
    answer,
    rtt: connection?.rtt ?? null,
  }
}
