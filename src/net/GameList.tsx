// The open games on the lobby page (ADR amendment 2026-10-12, "Live games"):
// the heads-up games their hosts chose to list, each with a "Request to
// join" that asks the host (who may say no), and a field for a game code,
// which seats the player at once. The list is asked for, never pushed: on
// arrival, every GAMES_EVERY_MS while the tab is seen, and as it comes back
// into view. A row is a name and an age; the table's id and its code are
// never in a list, so nothing here can seat anyone but the host's answer.
import { useEffect, useRef, useState } from 'react'
import type { ClipboardEvent, FormEvent } from 'react'
import type { GameRow } from '../shared/protocol'
import { codeFieldText, openFor, readLink } from './gameText'
import type { LobbyConnection, LobbyState } from './lobbyClient'
import { useNow } from './useNow'

/** How often the list is asked for while it is shown. */
export const GAMES_EVERY_MS = 5000
/**
 * A list that has not been refreshed in this many asks is not shown: its
 * rows may be games that filled or closed (the lobby drops them within
 * 90 s, but a socket that stopped answering says nothing).
 */
const STALE_AFTER_ASKS = 2
/**
 * How long a request waits for the host: the server's REQUEST_TTL_MS
 * (worker/src/lobby.ts), counted down here from the moment the lobby
 * confirms it, and from the click until then.
 */
export const REQUEST_WAIT_MS = 60_000

export const CODE_FAILED =
  "That code doesn't match an open game. Check it and try again."
export const TOO_MANY = 'Too many tries. Wait a few minutes.'

export function GameList({
  state,
  connection,
}: {
  state: LobbyState
  connection: LobbyConnection | null
}) {
  const open = state.status === 'open'

  // Asked as the socket opens (again after a reconnect), every 5 s while the
  // tab is seen, and as it comes back into view. Never pushed.
  useEffect(() => {
    if (!open || !connection) return
    const ask = () => {
      if (document.visibilityState === 'visible') connection.listGames()
    }
    ask()
    const timer = window.setInterval(ask, GAMES_EVERY_MS)
    document.addEventListener('visibilitychange', ask)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', ask)
    }
  }, [open, connection])

  // Two asks without an answer: the rows are dropped (a tab that is hidden
  // asks nothing, and so does not age its list).
  const [staleAt, setStaleAt] = useState<number | null>(null)
  useEffect(() => {
    const at = state.gamesAt
    if (at === null) return
    const timer = window.setTimeout(() => {
      if (document.visibilityState === 'visible') setStaleAt(at)
    }, GAMES_EVERY_MS * STALE_AFTER_ASKS)
    return () => window.clearTimeout(timer)
  }, [state.gamesAt])
  const rows =
    state.gamesAt !== null && state.gamesAt === staleAt ? null : state.games

  // The request waits REQUEST_WAIT_MS; a lapsed one frees the other rows.
  const request = state.joinRequest
  const [lapsed, setLapsed] = useState<LobbyState['joinRequest']>(null)
  const waiting = request?.state === 'pending' && lapsed !== request
  const said = (r: NonNullable<LobbyState['joinRequest']>) =>
    r.state === 'pending'
      ? lapsed === r
        ? 'No answer, try another game'
        : null
      : r.state === 'declined'
        ? 'Not this time'
        : 'That game is no longer available'

  const shown = rows?.some((g) => g.gameId === request?.gameId)
  return (
    <>
      {rows === null ? (
        <p className="live-muted">
          {open ? 'Looking for open games…' : 'Open games appear here.'}
        </p>
      ) : rows.length === 0 ? (
        <p className="live-muted">
          No open games right now. Create one with Play a friend.
        </p>
      ) : (
        <table className="live-tables live-games">
          <caption className="sr-only">Open games</caption>
          <thead>
            <tr>
              <th scope="col">Host</th>
              <th scope="col">Waiting</th>
              <th scope="col">
                <span className="sr-only">Request</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((game) => (
              <GameRowView
                key={game.gameId}
                game={game}
                request={request?.gameId === game.gameId ? request : null}
                said={request?.gameId === game.gameId ? said(request) : null}
                blocked={!open || waiting}
                onRequest={() => connection?.requestJoin(game.gameId)}
                onCancel={() => connection?.cancelRequest()}
                onLapse={setLapsed}
              />
            ))}
          </tbody>
        </table>
      )}
      {request && !shown && said(request) && (
        <p className="live-muted" role="status">
          {said(request)}
        </p>
      )}
      {state.joinLimited === 'request' && (
        <p className="live-error" role="alert">
          {TOO_MANY}
        </p>
      )}
      <CodeForm state={state} connection={connection} />
    </>
  )
}

function GameRowView({
  game,
  request,
  said,
  blocked,
  onRequest,
  onCancel,
  onLapse,
}: {
  game: GameRow
  request: LobbyState['joinRequest']
  /** The outcome of this row's request, when it has one. */
  said: string | null
  /** Another request is waiting, or the lobby is out of reach. */
  blocked: boolean
  onRequest: () => void
  onCancel: () => void
  onLapse: (request: LobbyState['joinRequest']) => void
}) {
  const waiting = request?.state === 'pending' && said === null
  const cell = useRef<HTMLTableCellElement>(null)
  const ask = useRef<HTMLButtonElement>(null)
  // The button that was pressed goes with the state it began: when the wait
  // ends, focus is taken back to this row (the Request button, or the cell
  // when the row says why there is none), unless the person has moved on.
  const was = useRef(waiting)
  useEffect(() => {
    if (was.current && !waiting && lost(cell.current))
      (ask.current ?? cell.current)?.focus()
    was.current = waiting
  }, [waiting])
  return (
    <tr>
      <td className="live-host" title={game.host}>
        {game.host}
      </td>
      <td>{openFor(game.openForMs)}</td>
      <td className="live-answer" ref={cell} tabIndex={-1}>
        {/* Always here, so that what it comes to say is announced. */}
        <span role="status" className={waiting || said ? undefined : 'sr-only'}>
          {waiting ? 'Waiting for host…' : (said ?? '')}
        </span>
        {waiting ? (
          <Waiting request={request} onCancel={onCancel} onLapse={onLapse} />
        ) : said ? null : (
          <button
            ref={ask}
            className="btn btn-outline"
            aria-label={`Request to join ${game.host}`}
            disabled={blocked}
            onClick={onRequest}
          >
            Request to join
          </button>
        )}
      </td>
    </tr>
  )
}

/**
 * Focus has been lost to the page (its button went away) or is still inside
 * `cell`: safe to move. Anywhere else it is the person's choice, and stays.
 */
function lost(cell: HTMLElement | null) {
  const at = document.activeElement
  return !at || at === document.body || !!cell?.contains(at)
}

function Waiting({
  request,
  onCancel,
  onLapse,
}: {
  request: NonNullable<LobbyState['joinRequest']>
  onCancel: () => void
  onLapse: (request: LobbyState['joinRequest']) => void
}) {
  const now = useNow(1000)
  // Until the lobby confirms the request, its time counts from this click.
  const [fallback] = useState(() => Date.now() + REQUEST_WAIT_MS)
  const left = Math.max(0, (request.expiresAt ?? fallback) - now)
  const lapsed = left === 0
  const seconds = Math.ceil(left / 1000)
  useEffect(() => {
    if (lapsed) onLapse(request)
  }, [lapsed, request, onLapse])
  // The pressed button is gone: Cancel is where the person's focus goes.
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (lost(cancel.current?.closest('td') ?? null)) cancel.current?.focus()
  }, [])
  return (
    <span className="live-waiting">
      <span className="live-clock" aria-hidden>
        {`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`}
      </span>
      <button className="btn btn-quiet" ref={cancel} onClick={onCancel}>
        Cancel
      </button>
    </span>
  )
}

function CodeForm({
  state,
  connection,
}: {
  state: LobbyState
  connection: LobbyConnection | null
}) {
  const [typed, setTyped] = useState('')
  const open = state.status === 'open'

  // A link in place of a code goes where it points: a table's own link to
  // that table, a code's to the same join as typing the code.
  const route = (text: string) => {
    const link = readLink(text)
    if (!link) return false
    if ('play' in link) window.location.hash = `#play/${link.play}`
    else connection?.joinByCode(link.code)
    return true
  }
  const paste = (e: ClipboardEvent<HTMLInputElement>) => {
    if (route(e.clipboardData.getData('text'))) e.preventDefault()
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (route(typed) || !typed) return
    connection?.joinByCode(typed)
  }
  return (
    <form className="live-codeform" onSubmit={submit}>
      <h3>Join with a code</h3>
      <div className="live-row live-row-tight">
        <input
          className="live-code-input"
          aria-label="Game code"
          aria-describedby="code-help"
          placeholder="ABC-234"
          value={typed}
          maxLength={8}
          inputMode="text"
          autoCapitalize="characters"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onPaste={paste}
          onChange={(e) => setTyped(codeFieldText(e.target.value))}
        />
        <button
          className="btn btn-outline"
          type="submit"
          disabled={!open || !typed}
        >
          Join game
        </button>
      </div>
      <p id="code-help" className="live-muted">
        The six characters your friend sees, or their link.
      </p>
      {(state.codeFailed || state.joinLimited === 'code') && (
        <p className="live-error" role="alert">
          {state.joinLimited === 'code' ? TOO_MANY : CODE_FAILED}
        </p>
      )}
    </form>
  )
}
