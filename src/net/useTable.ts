import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { PlayerAction, SeatId } from '../engine/types'
import { INITIAL_STATE, TableConnection } from './client'

const noSubscription = () => () => {}

/** Connects to a live table for as long as the component is mounted. */
export function useTable(
  matchId: string,
  getToken: () => Promise<string | null>,
) {
  const [connection, setConnection] = useState<TableConnection | null>(null)
  useEffect(() => {
    const next = new TableConnection(matchId, getToken)
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
    (seat: SeatId) => connection?.sit(seat) ?? false,
    [connection],
  )
  return { state, act, rematch, sit }
}
