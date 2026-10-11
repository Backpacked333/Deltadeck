// Your profile (#me): one private page with everything the account holds
// about this player — practice against Atlas, online rating and matches,
// lessons and challenge scores. A lazy chunk; the account parts load from
// the online service, the rest is already in this browser.
import { useEffect, useMemo, useState } from 'react'
import {
  ArrowDownRight,
  ArrowUpRight,
  BookOpen,
  Gauge,
  GraduationCap,
  Swords,
  Trophy,
} from 'lucide-react'
import { CHALLENGE_HANDS } from '../challenge/hands'
import { LineChart } from '../components/progress/Charts'
import { GradeChip } from '../components/review/HandReview'
import { loadLearning } from '../curriculum/core/persistence'
import { browserStorage } from '../curriculum/core/session'
import { lessonSummary } from '../curriculum/core/summary'
import { handAccuracy, practiceStats } from '../lib/practiceStats'
import type { Progress } from '../lib/storage'
import { loadOnline } from '../net/supabase'
import { loadAccountHistory } from './account'
import type { AccountHistory } from './account'

type Online =
  | { status: 'loading' }
  | { status: 'unavailable' }
  | { status: 'ready'; history: AccountHistory | null }

const date = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
const signed = (n: number) =>
  `${n < 0 ? '−' : '+'}${Math.abs(Math.round(n)).toLocaleString('en-US')}`
const RESULT = { win: 'Won', draw: 'Drew', loss: 'Lost' } as const
const handTitle = (id: string) =>
  CHALLENGE_HANDS.find((h) => h.id === id)?.title ?? id

export default function MyProfile({
  progress,
  username,
}: {
  progress: Progress
  username: string | null
}) {
  const practice = useMemo(
    () => practiceStats(progress.hands),
    [progress.hands],
  )
  const lessons = useMemo(
    () => lessonSummary(loadLearning(browserStorage()).store),
    [],
  )
  const [online, setOnline] = useState<Online>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!username) {
      setOnline({ status: 'unavailable' })
      return
    }
    let live = true
    setOnline({ status: 'loading' })
    loadOnline()
      .then((found) =>
        found ? loadAccountHistory(found.client, username) : undefined,
      )
      .then(
        (history) =>
          live &&
          setOnline(
            history === undefined
              ? { status: 'unavailable' }
              : { status: 'ready', history },
          ),
        () => live && setOnline({ status: 'unavailable' }),
      )
    return () => {
      live = false
    }
  }, [username, attempt])

  const account = online.status === 'ready' ? online.history : null
  const rating = account?.profile.rating
  const rated = rating && rating.matches > 0 ? rating : null
  const best = account?.challenges[0]
  const recentHands = practice.hands.slice(-10).reverse()

  return (
    <div className="page progress-page my-profile">
      <header className="page-head">
        <h1>{username ?? 'Your profile'}</h1>
        <p>
          {account
            ? `Playing since ${date(account.profile.player.createdAt)}`
            : 'Your history on DeltaDeck, in one place.'}
          {account?.school ? ` · ${account.school}` : ''}
        </p>
        {username && (
          <p className="my-profile-links">
            <a href={`#u/${username}`}>View your public profile</a>
          </p>
        )}
      </header>

      <div className="tiles" aria-label="At a glance">
        <div className="tile">
          <Gauge size={18} />
          <span className="label">Practice accuracy</span>
          <strong>
            {practice.accuracy === null ? '—' : Math.round(practice.accuracy)}
          </strong>
          <small>
            {practice.hands.length} hand
            {practice.hands.length === 1 ? '' : 's'} against Atlas
          </small>
        </div>
        <div className="tile">
          <Swords size={18} />
          <span className="label">Online rating</span>
          <strong>
            {rated ? `${Math.round(rated.rating)}` : '—'}
            {rated && <em> ±{Math.round(rated.rd)}</em>}
          </strong>
          <small>
            {online.status === 'loading'
              ? 'Loading…'
              : rated
                ? `${rated.matches} rated match${rated.matches === 1 ? '' : 'es'}`
                : 'No rated matches yet'}
          </small>
        </div>
        <div className="tile">
          <GraduationCap size={18} />
          <span className="label">Lessons</span>
          <strong>
            {lessons.unitsDone}
            <em> / {lessons.unitsTotal}</em>
          </strong>
          <small>
            foundation units passed
            {lessons.modulesDone
              ? ` · ${lessons.modulesDone} core modules`
              : ''}
          </small>
        </div>
        <div className="tile">
          <Trophy size={18} />
          <span className="label">Best challenge</span>
          <strong>{best ? best.accuracy : '—'}</strong>
          <small>
            {best ? handTitle(best.hand) : 'Play the hand on the home page'}
          </small>
        </div>
      </div>

      <section className="panel" aria-labelledby="me-practice">
        <div className="panel-head">
          <div>
            <h2 id="me-practice">Practice</h2>
            <p>Your hands against Atlas, graded decision by decision.</p>
          </div>
          <a className="text-button" href="#progress">
            All practice stats
          </a>
        </div>
        {practice.hands.length === 0 ? (
          <p className="muted">
            No hands yet. <a href="#table">Sit down at the table</a> to start.
          </p>
        ) : (
          <>
            {practice.handAccuracy.length > 1 && (
              <LineChart
                width={980}
                height={160}
                label="Accuracy per graded hand"
                format={(v) => `${Math.round(v)}`}
                series={[
                  {
                    label: 'Accuracy',
                    className: 'accuracy',
                    values: practice.handAccuracy,
                  },
                ]}
              />
            )}
            <div className="hand-list">
              {recentHands.map((hand) => {
                const accuracy = handAccuracy(hand)
                return (
                  <div key={hand.id} className="hand-row">
                    <span
                      className={`result-icon ${hand.net >= 0 ? 'up' : 'down'}`}
                    >
                      {hand.net >= 0 ? (
                        <ArrowUpRight size={16} />
                      ) : (
                        <ArrowDownRight size={16} />
                      )}
                    </span>
                    <span className="hand-main">
                      <strong>{hand.result}</strong>
                      <small>
                        Hand #{hand.hand}
                        {hand.hero ? ` · ${hand.hero.join(' ')}` : ''}
                        {hand.board?.length
                          ? ` on ${hand.board.join(' ')}`
                          : ''}
                      </small>
                    </span>
                    <span className="hand-grades">
                      {hand.decisions?.map((d, i) => (
                        <GradeChip key={i} grade={d.grade} />
                      ))}
                    </span>
                    <span className="hand-acc">
                      {accuracy === null ? '' : Math.round(accuracy)}
                    </span>
                    <b className={hand.net >= 0 ? 'positive' : 'negative'}>
                      {signed(hand.net)}
                    </b>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </section>

      <section className="panel" aria-labelledby="me-online">
        <div className="panel-head">
          <div>
            <h2 id="me-online">Online</h2>
            <p>Your rated heads-up matches and how your rating moved.</p>
          </div>
          <a className="text-button" href="#lobby">
            Play online
          </a>
        </div>
        {online.status === 'loading' ? (
          <p className="muted" role="status">
            Loading your matches…
          </p>
        ) : online.status === 'unavailable' ? (
          <p className="muted" role="alert">
            Your online history could not be loaded.{' '}
            <button
              className="text-button"
              onClick={() => setAttempt((n) => n + 1)}
            >
              Try again
            </button>
          </p>
        ) : !account || account.profile.recent.length === 0 ? (
          <p className="muted">
            No rated matches yet. <a href="#lobby">Find a match</a> to get your
            first rating.
          </p>
        ) : (
          <>
            {account.profile.history.length >= 2 && (
              <LineChart
                width={980}
                height={180}
                zero={false}
                label="Your rating over time"
                format={(v) => `${Math.round(v)}`}
                series={[
                  {
                    label: 'Rating',
                    className: 'actual',
                    values: account.profile.history.map((h) => h.rating),
                  },
                ]}
              />
            )}
            <ol className="live-profile-matches">
              {account.profile.recent.map((m) => (
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
                    {signed(Math.round(m.after) - Math.round(m.before))})
                  </span>
                  <a href={`#match/${m.matchId}`}>
                    Review<span className="sr-only"> the match</span>
                  </a>
                </li>
              ))}
            </ol>
          </>
        )}
      </section>

      <div className="panel-row">
        <section className="panel" aria-labelledby="me-lessons">
          <div className="panel-head">
            <div>
              <h2 id="me-lessons">Lessons</h2>
            </div>
            <a className="text-button" href="#learn/foundations">
              {lessons.unitsStarted ? 'Continue' : 'Start learning'}
            </a>
          </div>
          <p>
            <BookOpen size={14} /> {lessons.unitsDone} of {lessons.unitsTotal}{' '}
            foundation units passed, {lessons.unitsStarted} started.
          </p>
          {lessons.last && (
            <p className="muted">
              Last worked on {lessons.last.unitId.toUpperCase()},{' '}
              {date(lessons.last.at)}.
            </p>
          )}
        </section>
        <section className="panel" aria-labelledby="me-challenge">
          <div className="panel-head">
            <div>
              <h2 id="me-challenge">Challenge scores</h2>
            </div>
          </div>
          {account?.challenges.length ? (
            <ol className="live-profile-matches">
              {account.challenges.map((c) => (
                <li key={`${c.hand}-${c.playedAt}`}>
                  <span className="live-muted">{date(c.playedAt)}</span>
                  <span>{handTitle(c.hand)}</span>
                  <b>{c.accuracy}/100</b>
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted">
              No saved scores yet. <a href="#start">Play the challenge hand</a>{' '}
              and save your score.
            </p>
          )}
        </section>
      </div>
    </div>
  )
}
