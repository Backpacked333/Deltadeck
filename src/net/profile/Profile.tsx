import { useEffect, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { LineChart } from '../../components/progress/Charts'
import { VERSION } from '../../rating/glicko2'
import { isProvisional, matchesToGo, PROVISIONAL_RD } from '../../rating/rules'
import { crestFor } from '../../lib/crests'
import { AccuracyPanel } from '../AccuracyPanel'
import { PlayerAvatar, SchoolCrest } from '../Avatar'
import { ratingText, winRate } from '../ladder'
import { loadProfile } from './profile'
import type { Profile as ProfileData, ProfileRating } from './profile'

type State =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'missing' }
  | { status: 'ready'; profile: ProfileData }

const date = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '±0')
const RESULT = { win: 'Won', draw: 'Drew', loss: 'Lost' } as const

/**
 * A player's public profile (P1-15): rating ± RD and its history, volume,
 * abandonment, accuracy, the last 20 rated matches with links to their
 * hands, and an empty sanctions field until moderation ships (P1-18).
 */
export function Profile({
  client,
  username,
}: {
  client: SupabaseClient
  username: string
}) {
  const [state, setState] = useState<State>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    setState({ status: 'loading' })
    loadProfile(client, username).then(
      (profile) =>
        live &&
        setState(
          profile ? { status: 'ready', profile } : { status: 'missing' },
        ),
      () => live && setState({ status: 'error' }),
    )
    return () => {
      live = false
    }
  }, [client, username, attempt])

  if (state.status === 'loading')
    return (
      <p className="live-status" role="status">
        Loading the profile…
      </p>
    )
  if (state.status === 'error')
    return (
      <div className="panel live-profile" role="alert">
        <p className="live-error">The profile could not be loaded.</p>
        <button
          className="btn btn-outline"
          onClick={() => setAttempt((n) => n + 1)}
        >
          Try again
        </button>
      </div>
    )
  if (state.status === 'missing')
    return (
      <div className="panel live-profile" role="status">
        <p>No player is called {username}.</p>
        <a href="#ladder">See the ladder</a>
      </div>
    )

  const { player, rating, history, recent } = state.profile
  return (
    <>
      {(player.avatar || crestFor(player.school)) && (
        <section className="panel live-profile live-profile-who">
          {player.avatar && (
            <PlayerAvatar
              username={player.username}
              avatar={player.avatar}
              size={64}
            />
          )}
          <SchoolCrest school={player.school} size={28} />
          {player.avatar && (
            <ReportPicture client={client} player={player.userId} />
          )}
        </section>
      )}
      <section className="panel live-profile" aria-labelledby="profile-rating">
        <h2 id="profile-rating">Heads-up rating</h2>
        {rating && rating.matches > 0 ? (
          <Rating rating={rating} />
        ) : (
          <p>Unrated: no rated matches yet.</p>
        )}
        <dl className="live-profile-stats">
          <div>
            <dt>Rated matches</dt>
            <dd>{rating?.matches ?? 0}</dd>
          </div>
          <div>
            <dt>Won · drawn · lost</dt>
            <dd>
              {rating
                ? `${rating.wins} · ${rating.draws} · ${rating.matches - rating.wins - rating.draws}`
                : '0 · 0 · 0'}
            </dd>
          </div>
          <div>
            <dt>Win rate</dt>
            <dd>{winRate(rating ?? { wins: 0, matches: 0 })}</dd>
          </div>
          <div>
            <dt>Abandoned</dt>
            <dd>
              {rating && rating.matches
                ? `${rating.abandoned} of ${rating.matches} (${Math.round((100 * rating.abandoned) / rating.matches)}%)`
                : `${rating?.abandoned ?? 0}`}
            </dd>
          </div>
          <div>
            <dt>Sanctions</dt>
            <dd>None</dd>
          </div>
        </dl>
        {history.length >= 2 && (
          <LineChart
            width={560}
            height={180}
            zero={false}
            label="Rating over time, with the band of one rating deviation either side"
            format={(v) => `${Math.round(v)}`}
            ends={[date(history[0].at), date(history[history.length - 1].at)]}
            series={[
              {
                label: 'Rating plus RD',
                className: 'band',
                values: history.map((h) => h.rating + h.rd),
              },
              {
                label: 'Rating minus RD',
                className: 'band',
                values: history.map((h) => h.rating - h.rd),
              },
              {
                label: 'Rating',
                className: 'actual',
                values: history.map((h) => h.rating),
              },
            ]}
          />
        )}
        <p className="live-muted">
          Glicko-2 (<code>{VERSION}</code>). The ± is the rating deviation: the
          fewer the matches, the wider it is. <a href="#method">Method</a>
        </p>
        <p className="live-muted">
          Playing since {date(player.createdAt)}
          {player.country ? ` · ${player.country}` : ''}
        </p>
        {player.bio && <p className="live-profile-bio">{player.bio}</p>}
      </section>
      <AccuracyPanel
        client={client}
        userId={player.userId}
        subject={player.username}
      />
      <section className="panel live-profile" aria-labelledby="profile-matches">
        <h2 id="profile-matches">
          {recent.length
            ? `Last ${recent.length} rated ${recent.length === 1 ? 'match' : 'matches'}`
            : 'Rated matches'}
        </h2>
        {recent.length === 0 ? (
          <p className="live-muted">No rated matches yet.</p>
        ) : (
          <ol className="live-profile-matches">
            {recent.map((m) => {
              const change = Math.round(m.after) - Math.round(m.before)
              return (
                <li key={m.matchId}>
                  <span className="live-muted">{date(m.finishedAt)}</span>
                  <span>
                    <b>{RESULT[m.outcome]}</b>
                    {m.opponent && (
                      <>
                        {' vs '}
                        <a href={`#u/${m.opponent}`}>{m.opponent}</a>
                      </>
                    )}
                  </span>
                  <span>
                    {Math.round(m.before)} → {Math.round(m.after)} (
                    {signed(change)})
                  </span>
                  <a href={`#match/${m.matchId}`}>
                    Review<span className="sr-only"> the match</span>
                  </a>
                </li>
              )
            })}
          </ol>
        )}
      </section>
      <Share username={player.username} />
    </>
  )
}

function Rating({ rating }: { rating: ProfileRating }) {
  const left = matchesToGo(rating)
  return (
    <p className="live-profile-rating">
      <strong>{ratingText(rating)}</strong>{' '}
      <span className="live-profile-badge">
        {!isProvisional(rating)
          ? 'Established'
          : left > 0
            ? `Provisional · ${left} rated ${left === 1 ? 'match' : 'matches'} to go`
            : `Provisional until the ± is under ${PROVISIONAL_RD}`}
      </span>
    </p>
  )
}

/** The share link is the server-rendered path, which carries the preview. */
function Share({ username }: { username: string }) {
  const url = `${window.location.origin}/u/${username}`
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }
  return (
    <section className="panel live-profile" aria-labelledby="profile-share">
      <h2 id="profile-share">Share</h2>
      <div className="live-row">
        <input
          aria-label="Profile link"
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
        />
        <button className="btn btn-outline" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy link'}
        </button>
      </div>
    </section>
  )
}

/**
 * "Report picture", for a signed-in viewer who is not the player. Pictures
 * go live without review; a report is one row an operator reads
 * (report_avatar, 20261012000000_avatars.sql), at most one a day each.
 */
function ReportPicture({
  client,
  player,
}: {
  client: SupabaseClient
  player: string
}) {
  const [viewer, setViewer] = useState<string | null>(null)
  const [sent, setSent] = useState<'idle' | 'sending' | 'sent' | 'failed'>(
    'idle',
  )
  useEffect(() => {
    let live = true
    client.auth.getSession().then(
      ({ data }) => live && setViewer(data.session?.user.id ?? null),
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [client])
  if (!viewer || viewer === player) return null
  if (sent === 'sent')
    return (
      <p className="live-muted" role="status">
        Thanks — a person will look at it.
      </p>
    )
  return (
    <>
      <button
        type="button"
        className="btn btn-outline"
        disabled={sent === 'sending'}
        onClick={async () => {
          setSent('sending')
          const { error } = await client.rpc('report_avatar', {
            p_player: player,
          })
          setSent(error ? 'failed' : 'sent')
        }}
      >
        Report picture
      </button>
      {sent === 'failed' && (
        <p className="live-error" role="alert">
          The report could not be sent. Try again.
        </p>
      )}
    </>
  )
}
