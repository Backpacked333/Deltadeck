import { useEffect, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { SeatId } from '../engine/types'
import type { MatchEndReason } from '../shared/protocol'
import { loadPublicMatch } from './publicMatch'
import type { PublicHand, PublicMatch, PublicSeat } from './publicMatch'
import { Cards } from './ReviewLive'
import { describeAction, STREETS, streetName } from './reviewText'

type State =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'missing' }
  | { status: 'ready'; match: PublicMatch }

const RESULT = { win: 'won', draw: 'drew', loss: 'lost' } as const

/**
 * A finished match, hand by hand, for anyone (P1-15): the actions, the
 * board and only the cards shown at showdown, from the public archive. A
 * match in play is not shown. Decision times stay out (tickets.md Q5).
 */
export function MatchReview({
  client,
  matchId,
}: {
  client: SupabaseClient
  matchId: string
}) {
  const [state, setState] = useState<State>({ status: 'loading' })
  const [at, setAt] = useState(0)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    loadPublicMatch(client, matchId).then(
      (match) =>
        live &&
        setState(match ? { status: 'ready', match } : { status: 'missing' }),
      () => live && setState({ status: 'error' }),
    )
    return () => {
      live = false
    }
  }, [client, matchId, attempt])

  if (state.status === 'loading')
    return (
      <p className="live-status" role="status">
        Loading the match…
      </p>
    )
  if (state.status === 'error')
    return (
      <p className="live-error" role="alert">
        The match could not be loaded. Try again later.
      </p>
    )
  if (state.status === 'missing')
    return (
      <p className="live-muted" role="status">
        There is no such match.
      </p>
    )
  const match = state.match
  if (match.status === 'playing')
    return (
      <div className="panel live-profile" role="status">
        <p className="live-muted">
          This match is still being played. Its hands appear here once it ends.
        </p>
        <button
          className="btn btn-outline"
          onClick={() => setAttempt((n) => n + 1)}
        >
          Check again
        </button>
      </div>
    )

  const hand = match.hands[Math.min(at, match.hands.length - 1)]
  return (
    <>
      <section className="panel live-profile" aria-labelledby="match-title">
        <h2 id="match-title">
          {match.kind === 'hu-rated' ? 'Rated match' : 'Casual match'}
        </h2>
        <p>
          {/* One per account: at a six table two can share a last seat. */}
          {match.seats.map((s, i) => (
            <span key={s.userId}>
              {i > 0 && ' vs '}
              <a href={`#u/${s.username}`}>{s.username}</a>
            </span>
          ))}
        </p>
        <Summary
          seats={match.seats}
          status={match.status}
          reason={match.reason}
        />
      </section>
      {hand ? (
        <>
          <nav className="live-row live-review-nav" aria-label="Hands">
            <button
              className="btn btn-outline"
              disabled={at === 0}
              onClick={() => setAt((n) => n - 1)}
            >
              Previous hand
            </button>
            <span>
              Hand {hand.record.handNo} of {match.hands.length}
            </span>
            <button
              className="btn btn-outline"
              disabled={at >= match.hands.length - 1}
              onClick={() => setAt((n) => n + 1)}
            >
              Next hand
            </button>
          </nav>
          <Hand hand={hand} />
        </>
      ) : (
        <p className="live-muted">No hands were played.</p>
      )}
    </>
  )
}

/** Why a match was void, from its archived result; never a guess. */
const VOID_REASON: Partial<Record<MatchEndReason, string>> = {
  no_show: 'Void: a player did not arrive. Not rated.',
  abandoned: 'Void: both players left. Not rated.',
  engine_fault: 'Void: the server stopped the match. Not rated.',
}

function Summary({
  seats,
  status,
  reason,
}: {
  seats: PublicSeat[]
  status: 'finished' | 'void'
  reason: MatchEndReason | null
}) {
  if (status === 'void')
    return (
      <p className="live-muted">
        {(reason && VOID_REASON[reason]) ?? 'Void. Not rated.'}
      </p>
    )
  const rated = seats.filter((s) => s.outcome)
  if (!rated.length) return null
  return (
    <p>{rated.map((s) => `${s.username} ${RESULT[s.outcome!]}`).join(', ')}.</p>
  )
}

function Hand({ hand }: { hand: PublicHand }) {
  const { record } = hand
  // Who held a seat in this hand: seats are reused and players join between
  // hands, so the match's player list cannot say.
  const name = (seat: SeatId) =>
    hand.players.find((p) => p.seat === seat)?.username ?? 'A player'
  return (
    <section className="panel live-review" aria-label={`Hand ${record.handNo}`}>
      <header className="live-review-head">
        <h3>Hand {record.handNo}</h3>
        {hand.verified && (
          <span
            className="live-deck live-deck-ok"
            title="The server replayed this hand from its committed deck and checked every card and chip."
          >
            Verified
          </span>
        )}
      </header>
      <dl className="live-review-cards">
        {record.shown.map((s) => (
          <div key={s.seat}>
            <dt>{name(s.seat)} showed</dt>
            <dd>
              <Cards ids={s.cards} />
            </dd>
          </div>
        ))}
        {record.board.length > 0 && (
          <div>
            <dt>Board</dt>
            <dd>
              <Cards ids={record.board} />
            </dd>
          </div>
        )}
      </dl>
      <ol className="live-review-streets">
        {STREETS.map((street) => {
          const actions = record.actions.filter((a) => a.street === street)
          if (!actions.length) return null
          return (
            <li key={street}>
              <strong>{streetName(street)}</strong>
              <ul>
                {actions.map((a, i) => (
                  <li key={i}>
                    {name(a.seat)} {describeAction(a, false)}
                    {a.source === 'timeout' && (
                      <small> · ran out of time</small>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          )
        })}
      </ol>
      <p>
        {/* Every seat dealt in, in seat order (heads-up: 0 then 1). */}
        {(Object.keys(record.netBySeat).map(Number) as SeatId[])
          .sort((a, b) => a - b)
          .map((s) => {
            const net = record.netBySeat[s]
            return `${name(s)} ${net > 0 ? '+' : net < 0 ? '−' : '±'}${Math.abs(net)}`
          })
          .join(' · ')}{' '}
        chips
      </p>
    </section>
  )
}
