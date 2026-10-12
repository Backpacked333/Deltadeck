import { useMemo } from 'react'
import { MessageSquareQuote, Sparkles } from 'lucide-react'
import type { DecisionGrade } from '../../lib/grading'
import type { Game } from '../../lib/poker'
import { streetEquities } from '../../lib/showdown'
import type { HeroDecision } from '../../state/trainer'
import { signed } from '../format'
import { MiniCard } from '../PlayingCard'

const pct = (v: number) => `${Math.round(v * 100)}%`
const streetLabel = (s: string) =>
  s === 'preflop' ? 'Pre-flop' : s[0].toUpperCase() + s.slice(1)
const actionText = (decision: HeroDecision) => {
  const a = decision.action
  const toCall = Math.max(...decision.snapshot.bets) - decision.snapshot.bets[0]
  if (a.type === 'fold') return 'Fold'
  if (a.type === 'check') return 'Check'
  if (a.type === 'call')
    return `Call ${Math.min(toCall, decision.snapshot.stacks[0])}`
  return `${Math.max(...decision.snapshot.bets) ? 'Raise to' : 'Bet'} ${a.to}`
}

export function GradeChip({ grade }: { grade: string }) {
  return <span className={`grade grade-${grade.toLowerCase()}`}>{grade}</span>
}

function EquityGraph({ game }: { game: Game }) {
  const points = useMemo(
    () => streetEquities(game.cards[0], game.cards[1], game.board),
    [game],
  )
  if (points.length < 2) return null
  const w = 520,
    h = 170,
    pad = { l: 38, r: 16, t: 12, b: 26 }
  const x = (i: number) =>
    pad.l + (i / (points.length - 1)) * (w - pad.l - pad.r)
  const y = (v: number) => pad.t + (1 - v) * (h - pad.t - pad.b)
  const line = (key: 'hero' | 'atlas') =>
    points.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p[key])}`).join(' ')
  return (
    <figure className="equity-graph">
      <figcaption>
        <span className="label">Equity by street, both hands face up</span>
        <small>Information you did not have while playing.</small>
      </figcaption>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        role="img"
        aria-label={points
          .map((p) => `${p.street}: you ${pct(p.hero)}, Atlas ${pct(p.atlas)}`)
          .join('; ')}
      >
        {[0, 0.5, 1].map((v) => (
          <g key={v}>
            <line
              className="grid-line"
              x1={pad.l}
              x2={w - pad.r}
              y1={y(v)}
              y2={y(v)}
            />
            <text
              className="axis-text"
              x={pad.l - 6}
              y={y(v) + 3}
              textAnchor="end"
            >
              {pct(v)}
            </text>
          </g>
        ))}
        <path className="eq-line atlas" d={line('atlas')} />
        <path className="eq-line hero" d={line('hero')} />
        {points.map((p, i) => (
          <g key={p.street}>
            <circle className="eq-dot atlas" cx={x(i)} cy={y(p.atlas)} r="3" />
            <circle className="eq-dot hero" cx={x(i)} cy={y(p.hero)} r="3.5" />
            <text className="axis-text" x={x(i)} y={h - 6} textAnchor="middle">
              {p.street}
            </text>
          </g>
        ))}
      </svg>
      <div className="outcome-keys">
        <span>
          <i className="hero-key" /> You
        </span>
        <span>
          <i className="atlas-key" /> Atlas{' '}
          {game.cards[1].map((c) => (
            <MiniCard key={`${c.rank}${c.suit}`} card={c} />
          ))}
        </span>
      </div>
    </figure>
  )
}

export function HandReview({
  game,
  decisions,
  grades,
  selected,
  onSelect,
}: {
  game: Game
  decisions: HeroDecision[]
  grades: (DecisionGrade | null)[]
  selected: number
  onSelect: (index: number) => void
}) {
  const result = game.result!
  const ready = grades.every(Boolean) && grades.length > 0
  const accuracy = ready
    ? grades.reduce((s, g) => s + g!.accuracy, 0) / grades.length
    : null
  const last = decisions.length - 1
  const expectedNet =
    ready && last >= 0
      ? grades[last]!.chosen.ev - decisions[last].snapshot.invested[0]
      : null
  const modelGap = expectedNet === null ? null : result.net - expectedNet
  const notes = game.history.filter((h) => h.player === 1 && h.note)
  const grade = grades[selected]
  const decision = decisions[selected]
  return (
    <section className="review" aria-label="Hand review">
      <div className="review-head">
        <div>
          <span className="label">Hand #{game.id} review</span>
          <h3>Judge the choice, not the outcome.</h3>
        </div>
        {accuracy !== null && (
          <div
            className="accuracy-badge"
            role="img"
            aria-label={`Modeled accuracy ${Math.round(accuracy)}`}
          >
            <strong>{Math.round(accuracy)}</strong>
            <span>modeled accuracy</span>
          </div>
        )}
      </div>
      {decisions.length === 0 ? (
        <p className="lab-copy">
          This hand ended before you made a decision, so there is nothing to
          grade. Atlas&apos;s reasoning is below.
        </p>
      ) : (
        <>
          <div className="luck-line">
            <div>
              <span className="label">Result</span>
              <strong className={result.net >= 0 ? 'positive' : 'negative'}>
                {signed(result.net)}
              </strong>
            </div>
            <div>
              <span className="label">Model expected</span>
              <strong>
                {expectedNet === null ? '…' : signed(expectedNet)}
              </strong>
            </div>
            <div>
              <span className="label">Actual − modeled</span>
              <strong>{modelGap === null ? '…' : signed(modelGap)}</strong>
            </div>
          </div>
          <p className="muted">
            This gap includes outcome variation and model limitations, not just
            luck. Model grades are not an unaided learning assessment.
          </p>
          <ol className="timeline">
            {decisions.map((d, i) => (
              <li key={i}>
                <button
                  className={`timeline-item ${i === selected ? 'on' : ''}`}
                  onClick={() => onSelect(i)}
                  aria-current={i === selected}
                >
                  <span className="timeline-street">
                    {streetLabel(d.snapshot.street)}
                  </span>
                  <span className="timeline-board">
                    {d.snapshot.board.length ? (
                      d.snapshot.board.map((c) => (
                        <MiniCard key={`${c.rank}${c.suit}`} card={c} />
                      ))
                    ) : (
                      <em>no board</em>
                    )}
                  </span>
                  <span className="timeline-action">{actionText(d)}</span>
                  {grades[i] ? (
                    <GradeChip grade={grades[i]!.grade} />
                  ) : (
                    <span className="grade">…</span>
                  )}
                </button>
              </li>
            ))}
          </ol>
          {grade && decision && (
            <div className="review-detail">
              <p>
                You chose <b>{grade.chosen.label}</b> ({signed(grade.chosen.ev)}
                ).{' '}
                {grade.evLost < 0.5 ? (
                  <>That matches the model&apos;s best option.</>
                ) : (
                  <>
                    The model preferred <b>{grade.best.label}</b> (
                    {signed(grade.best.ev)}), so this gave up{' '}
                    <b>{grade.evLost.toFixed(1)} chips</b> of expected value.
                  </>
                )}
              </p>
              {decision.guess !== undefined && (
                <p className="review-guess">
                  <Sparkles size={13} /> Your read was {pct(decision.guess)};
                  the model said {pct(grade.equity)}.
                </p>
              )}
              {grade.options.some((o) => !o.graded) && (
                <p className="review-guess">
                  Dashed options are overbets beyond 1.5× pot. They are priced
                  for reference but not used as the grading bar, because the
                  model ignores the later betting a call would allow.
                </p>
              )}
              <div className="option-list">
                {grade.options.map((o) => (
                  <span
                    key={o.label}
                    className={`${o === grade.best ? 'best' : ''} ${o === grade.chosen ? 'chosen' : ''} ${o.graded ? '' : 'ungraded'}`}
                    title={
                      o.graded
                        ? undefined
                        : 'Shown for reference, not used for grading'
                    }
                  >
                    {o.label}
                    <em className={o.ev >= 0 ? 'positive' : 'negative'}>
                      {signed(o.ev)}
                    </em>
                  </span>
                ))}
              </div>
            </div>
          )}
        </>
      )}
      {result.showdown && <EquityGraph game={game} />}
      {notes.length > 0 && (
        <div className="atlas-notes">
          <span className="label">
            <MessageSquareQuote size={13} /> Atlas&apos;s notes, revealed after
            the hand
          </span>
          {notes.map((note, i) => (
            <p key={i}>
              <b>{streetLabel(note.street)}</b> {note.note}
            </p>
          ))}
        </div>
      )}
    </section>
  )
}
