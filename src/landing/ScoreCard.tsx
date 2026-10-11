// The end of the challenge (L-5, L-6): accuracy, an honest percentile (the
// server re-scores the line; "model players" until a hand has enough real
// scores), the cards' luck shown apart from the decisions, every decision
// with its grade and what the best play was, and Atlas's reasoning, now that
// the hand is over.
import { useEffect, useState } from 'react'
import { ArrowRight, RotateCcw, Share2, ShieldCheck } from 'lucide-react'
import { scorePath } from '../challenge/score'
import { cardLabel } from '../lib/poker'
import { savePendingClaim } from '../lib/landing'
import { track } from '../lib/track'
import type { FinishedChallenge } from './ChallengeHand'
import { useCountUp } from './motion'
import type { Rival } from './Landing'
import { ordinal, why } from './why'

type Server =
  | { status: 'loading' }
  | { status: 'failed' }
  | {
      status: 'ok'
      percentile: number
      basis: 'players' | 'model'
      crowd: (number | null)[]
      receipt: string
    }

const chips = (x: number) =>
  `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(Math.round(x)).toLocaleString('en-US')}`

/** Shares a link to this score: the system sheet, else the clipboard. */
async function shareLink(url: string, accuracy: number, title: string) {
  const text = `I scored ${accuracy}/100 on “${title}”. Beat me.`
  try {
    if (navigator.share) {
      await navigator.share({ title: 'DeltaDeck challenge', text, url })
      return 'shared'
    }
    await navigator.clipboard.writeText(`${text} ${url}`)
    return 'copied'
  } catch {
    return 'failed'
  }
}

export function ScoreCard({
  finished,
  rival = null,
  signedIn = false,
  onSave,
  onAgain,
  againLabel = 'Play another hand',
}: {
  finished: FinishedChallenge
  /** The friend whose link this hand came from (L-13). */
  rival?: Rival | null
  /** Saving goes to the visitor's account rather than a new one. */
  signedIn?: boolean
  onSave: () => void
  onAgain: () => void
  /** Signed out, the next hand is an account away. */
  againLabel?: string
}) {
  const { spec, tree, game, path, decisions } = finished
  const accuracy = scorePath(tree, path)?.accuracy ?? 0
  const [server, setServer] = useState<Server>({ status: 'loading' })
  const [shared, setShared] = useState<'shared' | 'copied' | 'failed' | null>(
    null,
  )

  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/challenge/score', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hand: spec.id, ver: spec.ver, path }),
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status))
        const result = (await response.json()) as {
          accuracy: number
          percentile: number
          basis: 'players' | 'model'
          crowd: (number | null)[]
          receipt: string
        }
        savePendingClaim({
          receipt: result.receipt,
          hand: spec.id,
          ver: spec.ver,
          accuracy: result.accuracy,
          percentile: result.percentile,
          at: Date.now(),
        })
        setServer({ status: 'ok', ...result })
      })
      .catch(() => {
        if (!controller.signal.aborted) setServer({ status: 'failed' })
      })
    return () => controller.abort()
  }, [spec, path])

  const shownAccuracy = useCountUp(accuracy, 1200, 250)
  const shownPercentile = useCountUp(
    server.status === 'ok' ? server.percentile : 0,
    900,
  )
  const net = game.result?.net ?? 0
  const best = decisions.filter((d) => d.chosen.grade === 'Best').length
  const costly = decisions.reduce<(typeof decisions)[number] | null>(
    (worst, d) =>
      !worst || d.chosen.accuracy < worst.chosen.accuracy ? d : worst,
    null,
  )
  const notes = decisions.flatMap((d) => d.atlas.map((a) => a.note))

  return (
    <section
      className="scorecard"
      aria-labelledby="scorecard-label scorecard-title"
    >
      <div className="scorecard-head">
        <div className="scorecard-score">
          <span className="scorecard-label" id="scorecard-label">
            Accuracy
          </span>
          <span className="scorecard-number" id="scorecard-title">
            <span aria-hidden>{shownAccuracy}</span>
            <span className="sr-only">{accuracy}</span>
            <small>/100</small>
          </span>
          <span className="scorecard-meter" aria-hidden>
            <i style={{ width: `${shownAccuracy}%` }} />
          </span>
        </div>
        <div className="scorecard-rank" aria-live="polite">
          {server.status === 'ok' ? (
            <>
              <span className="scorecard-label">Percentile</span>
              <span className="scorecard-number">
                <span aria-hidden>{shownPercentile}</span>
                <span className="sr-only">{server.percentile}</span>
                <small>{ordinal(server.percentile)}</small>
              </span>
              <span className="scorecard-meter is-rank" aria-hidden>
                <i style={{ width: `${shownPercentile}%` }} />
              </span>
              <span className="scorecard-basis">
                {server.basis === 'players'
                  ? `Better than ${server.percentile}% of players on this hand`
                  : `Against model players, until 200 people have played this hand`}
              </span>
            </>
          ) : server.status === 'failed' ? (
            <span className="scorecard-basis">
              Percentile unavailable right now. Your grades below are exact.
            </span>
          ) : (
            <span className="scorecard-basis">Ranking your line…</span>
          )}
        </div>
        <dl className="scorecard-split">
          <div>
            <dt>Your decisions</dt>
            <dd>
              {best} of {decisions.length} graded Best
            </dd>
          </div>
          <div>
            <dt>The cards</dt>
            <dd className={net >= 0 ? 'is-up' : 'is-down'}>
              {chips(net)} chips
            </dd>
          </div>
        </dl>
        {rival && (
          <p className="scorecard-versus" role="status">
            {accuracy > rival.accuracy
              ? `You beat your friend: ${accuracy} to ${rival.accuracy}.`
              : accuracy === rival.accuracy
                ? `A tie with your friend at ${accuracy}.`
                : `Your friend wins this one: ${rival.accuracy} to ${accuracy}.`}
          </p>
        )}
        <p className="scorecard-note">
          Your score ignores how the cards fell. Winning a pot with a bad call
          still costs you; losing one with the right call does not.
        </p>
      </div>

      <ol className="scorecard-decisions">
        {decisions.map((d, i) => {
          const crowd = server.status === 'ok' ? server.crowd[i] : null
          return (
            <li
              key={i}
              style={{ '--i': i } as React.CSSProperties}
              className={
                d === costly && d.chosen.grade !== 'Best' ? 'is-costly' : ''
              }
            >
              <span className="scorecard-street">{d.node.street}</span>
              <span className="scorecard-move">
                <strong>{d.chosen.label}</strong>{' '}
                <span className={`grade grade-${d.chosen.grade.toLowerCase()}`}>
                  {d.chosen.grade}
                </span>
              </span>
              <span className="scorecard-why">
                {why(d.node, d.chosen)}
                {crowd !== null && (
                  <em>
                    {' '}
                    {Math.round(crowd * 100)}% of players chose this too.
                  </em>
                )}
              </span>
            </li>
          )
        })}
      </ol>

      <details className="scorecard-atlas">
        <summary>
          Atlas held {game.cards[1].map(cardLabel).join(' ')}. Read its
          reasoning
        </summary>
        <ul>
          {notes.length ? (
            notes.map((n, i) => <li key={i}>{n}</li>)
          ) : (
            <li>Atlas had nothing left to decide.</li>
          )}
        </ul>
      </details>

      <div className="scorecard-save">
        <div>
          <strong>
            {signedIn
              ? 'Save this score to your account'
              : 'Save this score to a free account'}
          </strong>
          <span>
            {signedIn
              ? 'Your best score on each hand is kept with your account.'
              : 'Your score, a rating once you play people, a public profile and a school badge. Free, in under a minute.'}
          </span>
        </div>
        <button className="btn btn-accent btn-lg" onClick={onSave}>
          {signedIn
            ? 'Save your score'
            : 'Save your score and create an account'}{' '}
          <ArrowRight size={16} />
        </button>
      </div>
      <div className="scorecard-cta">
        {server.status === 'ok' && (
          <button
            className="btn btn-ghost-desk"
            onClick={async () => {
              track('share_click')
              setShared(
                await shareLink(
                  `${window.location.origin}/c/${server.receipt}`,
                  accuracy,
                  spec.title,
                ),
              )
            }}
          >
            <Share2 size={15} />
            {shared === 'copied' ? 'Link copied' : 'Challenge a friend'}
          </button>
        )}
        <button className="btn btn-ghost-desk" onClick={onAgain}>
          <RotateCcw size={15} /> {againLabel}
        </button>
      </div>
      {shared === 'failed' && (
        <p className="scorecard-basis" role="alert">
          Could not share from this browser. Copy this link instead:{' '}
          {server.status === 'ok' &&
            `${window.location.origin}/c/${server.receipt}`}
        </p>
      )}
      <p className="scorecard-fine">
        <ShieldCheck size={14} /> Play money only. Your score is checked on our
        server against the same model, so nobody can post one they did not earn.
      </p>
    </section>
  )
}
