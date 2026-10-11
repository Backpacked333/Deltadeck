// The six tables on the lobby page: Quick sit, and the list of tables as the
// lobby last gave it (P2-08; ADR, clarifications from PR-25). The list is
// read-only: Quick sit is the way to sit. Where it sends the player, and
// the retry when that table refuses, is LiveApp's, Lobby's and the table
// page's (useSitOnArrival).
import { useEffect, useLayoutEffect, useRef } from 'react'
import { SIX_BLINDS } from '../engine/stacks'
import { LIMITED } from './lobbyClient'
import type { LobbyConnection, LobbyState } from './lobbyClient'

/** How often the list is asked for while it is shown (ADR, PR-25). */
export const TABLES_EVERY_MS = 15_000
/** Rows shown; the rest are counted. */
export const TABLES_SHOWN = 10
/** The registry caps players per hour here (PR-23). */
const PLAYERS_CAP = 100

/** Why the last table did not seat us, on the way back to the lobby. */
export type Passed = 'table_full' | 'sit_cooldown' | 'closed'

/**
 * A quick-sit on its way between pages (LiveApp): to table `at`, or back
 * from table `from` to the lobby (`at` null) to ask again, naming every
 * table tried.
 */
export type QuickSit =
  | { tried: string[]; at: string }
  | { tried: string[]; at: null; passed: Passed; from: string }

const AGAIN: Record<Passed, string> = {
  table_full: 'That table filled up. Finding you another…',
  sit_cooldown: 'You stood up at that table a moment ago. Finding you another…',
  closed: 'That table has closed. Finding you another…',
}

const pot = (chips: number | null) =>
  chips === null
    ? '–'
    : `${(chips / SIX_BLINDS.bb).toLocaleString('en-US', { maximumFractionDigits: 1 })} bb`

export function TableList({
  state,
  connection,
  retry,
  onQuickSit,
}: {
  state: LobbyState
  connection: LobbyConnection | null
  /** Why the table before did not seat us, while the lobby asks again. */
  retry: Passed | null
  onQuickSit: () => void
}) {
  const open = state.status === 'open'
  const away = state.status === 'replaced' || state.status === 'failed'
  const seating = state.seating && !away

  // Asked as the socket opens (again after a reconnect), every 15 s while
  // the tab is seen, and as it comes back into view. Never pushed.
  useEffect(() => {
    if (!open || !connection) return
    const ask = () => {
      if (!document.hidden) connection.listTables()
    }
    ask()
    const timer = window.setInterval(ask, TABLES_EVERY_MS)
    document.addEventListener('visibilitychange', ask)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', ask)
    }
  }, [open, connection])

  // The lobby refused: Quick sit is back, and so is focus, if it was on
  // the button, in this card, or nowhere (a bounce focuses the heading).
  const button = useRef<HTMLButtonElement>(null)
  const wasSeating = useRef(false)
  useLayoutEffect(() => {
    const ended = wasSeating.current && !state.seating
    wasSeating.current = state.seating
    if (!ended || state.sitAt || state.matched) return
    const active = document.activeElement
    const card = button.current?.closest('article')
    if (!active || active === document.body || card?.contains(active))
      button.current?.focus()
  })

  // What the card says: the search, or why the lobby is out of reach. A
  // lobby away ends any search (no answer will come).
  const said = seating
    ? retry
      ? AGAIN[retry]
      : 'Finding you a seat…'
    : state.status === 'replaced'
      ? 'The lobby is open in another tab. Reload this page to sit from here.'
      : state.status === 'failed'
        ? (state.error ?? 'The lobby is unavailable. Reload to try again.')
        : ''
  // The lobby's refusal stays up through a reconnect, so it is not
  // announced again; the reconnect's own notice is the 1v1 card's.
  const refusal =
    !away && !state.seating && state.error !== LIMITED ? state.error : null
  const rows = state.tables
  const more = rows ? rows.length - TABLES_SHOWN : 0
  return (
    <>
      <button
        ref={button}
        className="btn btn-primary"
        onClick={onQuickSit}
        disabled={!open || state.seating || state.looking}
      >
        Quick sit
      </button>
      <p className="live-muted" role="status">
        {said}
      </p>
      {refusal && (
        <p className="live-error" role="alert">
          {refusal}
        </p>
      )}
      {rows &&
        (rows.length === 0 ? (
          <p className="live-muted">
            No tables are running right now. Quick sit opens one.
          </p>
        ) : (
          <>
            <table className="live-tables">
              <caption className="sr-only">Six-max tables</caption>
              <thead>
                <tr>
                  <th scope="col">Seats</th>
                  <th scope="col">Average pot</th>
                  <th scope="col">Players in the last hour</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, TABLES_SHOWN).map((t) => (
                  <tr key={t.tableId}>
                    <td>
                      {`${t.seated} of ${t.maxSeats}`}
                      {t.seated >= t.maxSeats ? ', full' : ''}
                    </td>
                    <td>{pot(t.avgPot)}</td>
                    <td>
                      {t.playersPerHour >= PLAYERS_CAP
                        ? `${PLAYERS_CAP}+`
                        : t.playersPerHour}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {more > 0 && <p className="live-muted">{`And ${more} more.`}</p>}
          </>
        ))}
    </>
  )
}
