// The end of a rated match: the result as the rating will read it, and the
// rematch offer (P1-04). The offer's state comes from the server; this only
// shows it and sends the one press.
import { useEffect, useState } from 'react'
import type { SeatId } from '../engine/types'
import type { RematchView } from './client'
import type { RatingChange } from '../shared/protocol'
import { inBb, matchHeadline, ratingLine } from './matchResult'
import type { MatchResult } from './matchResult'

const mmss = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function MatchEnd({
  result,
  you,
  bb,
  opponent,
  rematch,
  rating = null,
  clockOffset,
  onRematch,
}: {
  result: MatchResult
  you: SeatId
  /** The big blind, for totals in bb. */
  bb?: number
  opponent: string
  rematch: RematchView | null
  /** Rated: each seat's rating change, once applied. */
  rating?: Partial<Record<SeatId, RatingChange>> | null
  /** Server time minus this device's time. */
  clockOffset: number
  onRematch: () => void
}) {
  const headline = matchHeadline(result, you, bb) ?? 'Match over'
  const net = result.netBySeat[you] ?? 0
  const chips = bb ? ` Chips won: ${inBb(net, bb)} bb.` : ''
  const detail =
    result.reason === 'forfeit'
      ? `${result.forfeit === you ? 'You' : opponent} ran out of time three times in a row.${chips}`
      : `Luck-adjusted: all-in pots are settled at equity${bb ? ', and within 2 bb is a draw' : ''}.${chips}`
  return (
    <section className="panel live-matchend" aria-labelledby="match-end-title">
      <h2 id="match-end-title">{headline}</h2>
      <p className="live-muted">{detail}</p>
      <RatingResult rating={rating} result={result} you={you} />
      <RematchOffer
        rematch={rematch}
        you={you}
        opponent={opponent}
        clockOffset={clockOffset}
        onRematch={onRematch}
      />
      <a className="btn btn-outline" href="#lobby">
        Back to the lobby
      </a>
    </section>
  )
}

/** The real rating change, or that it is on its way (rated results only). */
function RatingResult({
  rating,
  result,
  you,
}: {
  rating: Partial<Record<SeatId, RatingChange>> | null
  result: MatchResult
  you: SeatId
}) {
  const outcome = result.outcomeBySeat?.[you]
  if (!outcome) return null
  const shown = ratingLine(rating, you, outcome)
  if (!shown)
    return (
      <p className="live-rating" role="status">
        Rating pending — gameplay is complete; verified settlement has not arrived.
      </p>
    )
  return (
    <p className="live-rating" role="status">
      <b>{shown.line}</b> {shown.standing}{' '}
      <a href="#method">How ratings work</a>
    </p>
  )
}

function RematchOffer({
  rematch,
  you,
  opponent,
  clockOffset,
  onRematch,
}: {
  rematch: RematchView | null
  you: SeatId
  opponent: string
  clockOffset: number
  onRematch: () => void
}) {
  const [now, setNow] = useState(() => Date.now())
  const waiting = rematch?.state === 'waiting'
  useEffect(() => {
    if (!waiting) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [waiting])
  // Both pressed: go to the new table.
  const next = rematch?.state === 'starting' ? rematch.next : undefined
  useEffect(() => {
    if (next) window.location.hash = `#play/${next}`
  }, [next])

  if (!rematch) return null
  const left = mmss((rematch.until ?? 0) - (now + clockOffset))
  switch (rematch.state) {
    case 'open':
      return (
        <div className="live-rematch">
          <button className="btn btn-primary" onClick={onRematch}>
            Rematch
          </button>
          <p className="live-muted">Both players press within a minute.</p>
        </div>
      )
    case 'waiting':
      return rematch.pressed.includes(you) ? (
        <div className="live-rematch" role="status">
          <button className="btn btn-primary" disabled>
            Waiting for {opponent}…
          </button>
          <p className="live-muted">
            The offer stands for <span className="live-clock">{left}</span>.
          </p>
        </div>
      ) : (
        <div className="live-rematch" role="status">
          <p>
            <strong>{opponent} wants a rematch.</strong>
          </p>
          <button className="btn btn-primary" onClick={onRematch}>
            Rematch
          </button>
          <p className="live-muted">
            <span className="live-clock">{left}</span> left.
          </p>
        </div>
      )
    case 'starting':
      return (
        <p className="live-rematch" role="status">
          Starting the rematch…
        </p>
      )
    case 'declined':
      return <p className="live-muted live-rematch">No rematch this time.</p>
    case 'limit':
      return (
        <div className="live-rematch">
          <button className="btn btn-primary" disabled>
            Rematch limit reached (2 per day)
          </button>
        </div>
      )
  }
}
