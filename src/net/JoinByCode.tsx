// `#join/CODE`: the link that seats whoever opens it with the game's code
// (ADR amendment 2026-10-12, "Live games"). After sign-in this opens the
// lobby socket, sends the code, and goes to the table the lobby names. The
// code is taken out of the address bar once the lobby has answered, whether
// it matched or not, so a screenshot of the page or a reload does not keep
// trying it. One answer for every miss: the page cannot say why.
import { useEffect, useState } from 'react'
import { replaceRoute } from '../lib/authReturn'
import { normaliseCode } from '../shared/gameCode'
import type { Identity } from './api'
import { CODE_FAILED, TOO_MANY } from './GameList'
import { useLobby } from './useLobby'

/** The address a spent code leaves behind: it names nothing. */
const SPENT = '#join'

function spend() {
  // No hashchange: the page showing the answer stays. Provider parameters
  // from a sign-in's return are not kept either.
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${window.location.search}${SPENT}`,
  )
}

/**
 * The answer when there is nothing to try: a spent link, or a bad code (one
 * that cannot be a code is told no differently from one that matched
 * nothing). A link still carrying its code is spent here too.
 */
export function JoinFailed({ message = CODE_FAILED }: { message?: string }) {
  useEffect(() => {
    if (window.location.hash !== SPENT) spend()
  }, [])
  return (
    <div className="empty live-empty" role="alert">
      <h3>{message}</h3>
      <a className="btn btn-primary" href="#lobby">
        Back to lobby
      </a>
    </div>
  )
}

export function JoinByCode({
  code,
  identity,
}: {
  code: string
  identity: Identity
}) {
  // LiveApp passes a code that is one; a socket is not opened for a guess
  // that cannot match.
  const wanted = normaliseCode(code)
  const { state, connection } = useLobby(identity.getToken)
  const [ended, setEnded] = useState<string | null>(null)

  // Sent as the socket opens, and again after a reconnect if no answer came
  // (an ask is not lost to a drop; a miss is an answer and ends it).
  const answered = ended !== null || state.matched !== null
  useEffect(() => {
    if (wanted && !answered && state.status === 'open')
      connection?.joinByCode(wanted)
  }, [wanted, answered, state.status, connection])

  useEffect(() => {
    if (state.matched) replaceRoute(`#play/${state.matched.matchId}`)
  }, [state.matched])

  const miss = !wanted || state.codeFailed
  const limited = state.joinLimited === 'code'
  useEffect(() => {
    if (miss || limited) {
      spend()
      setEnded(limited ? TOO_MANY : CODE_FAILED)
    }
  }, [miss, limited])

  if (ended) return <JoinFailed message={ended} />
  if (state.status === 'failed' || state.status === 'replaced')
    return (
      <JoinFailed
        message={
          state.status === 'replaced'
            ? 'The lobby is open in another tab. Close it and reload this page.'
            : (state.error ?? 'The lobby is unavailable. Reload to try again.')
        }
      />
    )
  return (
    <p className="live-status" role="status">
      Joining the game…
    </p>
  )
}
