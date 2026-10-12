import { useMemo, useRef } from 'react'
import {
  ArrowDownRight,
  ArrowUpRight,
  Download,
  Gauge,
  RotateCcw,
  Sparkles,
  Target,
  Upload,
  Waves,
} from 'lucide-react'
import { handAccuracy, practiceStats } from '../../lib/practiceStats'
import type { Progress } from '../../lib/storage'
import { exportProgress, importProgress } from '../../lib/storage'
import { GradeChip } from '../review/HandReview'
import { LineChart, Scatter } from './Charts'

const signed = (v: number) =>
  `${v < 0 ? '−' : '+'}${Math.abs(Math.round(v)).toLocaleString('en-US')}`

export function ProgressView({
  progress,
  sessionId,
  onReplace,
  onClear,
  onPlay,
}: {
  progress: Progress
  sessionId: string
  onReplace: (progress: Progress) => void
  onClear: () => void
  onPlay: () => void
}) {
  const stats = useMemo(
    () => practiceStats(progress.hands, sessionId),
    [progress.hands, sessionId],
  )

  if (!stats.hands.length)
    return (
      <div className="page progress-page">
        <header className="page-head">
          <h1>Small decisions. Lasting intuition.</h1>
          <p>Your progress is saved to your account.</p>
        </header>
        <div className="empty">
          <Sparkles size={26} />
          <h3>Your first insight is one hand away.</h3>
          <p>
            Play a few hands to compare your decisions and reads with the
            practice model. Results and modeled expectations are shown
            separately, with their coverage and limits.
          </p>
          <button className="btn btn-primary" onClick={onPlay}>
            Go to the table
          </button>
        </div>
        <DataActions progress={progress} onReplace={onReplace} />
      </div>
    )

  const maxGrade = Math.max(1, ...stats.grades.map((g) => g.count))
  const cal = stats.calibration
  return (
    <div className="page progress-page">
      <header className="page-head">
        <h1>Small decisions. Lasting intuition.</h1>
        <p>
          {stats.hands.length} hands recorded · {stats.session} this session
        </p>
      </header>
      <div className="tiles">
        <div className="tile">
          <Gauge size={18} />
          <span className="label">Modeled decision accuracy</span>
          <strong>
            {stats.accuracy === null ? '—' : Math.round(stats.accuracy)}
          </strong>
          <small>
            {stats.decisions.length} nonguided graded decisions ·{' '}
            {stats.evLost.toFixed(0)} chips of EV given up
          </small>
        </div>
        <div className="tile">
          <Target size={18} />
          <span className="label">Read error</span>
          <strong>
            {cal ? `±${Math.round(cal.meanAbsError * 100)}` : '—'}
            {cal && <em> pts</em>}
          </strong>
          <small>
            {cal
              ? Math.abs(cal.bias) < 0.02
                ? `No consistent bias across ${cal.count} reads`
                : `You ${cal.bias > 0 ? 'overestimate' : 'underestimate'} by ${Math.round(Math.abs(cal.bias) * 100)} pts on average`
              : 'Lock in reads at the table to measure this'}
          </small>
        </div>
        <div className="tile">
          {stats.actualAll >= 0 ? (
            <ArrowUpRight size={18} />
          ) : (
            <ArrowDownRight size={18} />
          )}
          <span className="label">Actual result · all hands</span>
          <strong className={stats.actualAll >= 0 ? 'positive' : 'negative'}>
            {signed(stats.actualAll)}
          </strong>
          <small>{stats.hands.length} hands, including unmodeled results</small>
        </div>
        <div className="tile">
          <Waves size={18} />
          <span className="label">Actual − modeled · covered hands</span>
          <strong>
            {stats.modelGap === null ? '—' : signed(stats.modelGap)}
          </strong>
          <small>
            {stats.coverage.evaluated} matched hands · not a pure luck measure
          </small>
        </div>
      </div>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Results and model coverage</h2>
            <p>
              Modeled result available for {stats.coverage.evaluated} of{' '}
              {stats.coverage.total} hands. Both lines use only those same
              hands, in played order. The gap includes outcome variation and
              model limitations; it does not measure skill or prove learning.
            </p>
          </div>
          <div className="legend">
            <span>
              <i className="series-key actual" /> Actual · covered hands
            </span>
            <span>
              <i className="series-key expected" /> Modeled · covered hands
            </span>
          </div>
        </div>
        <p className="muted">
          {stats.coverage.eligible} nonguided graded hands eligible ·{' '}
          {stats.coverage.evaluated} with a modeled result. Excluded:{' '}
          {stats.coverage.guided} guided, {stats.coverage.pending} pending,{' '}
          {stats.coverage.ungraded} without grades. Missing modeled result:{' '}
          {stats.coverage.missingModel}. Nonguided does not establish absence of
          hints; these are practice-model metrics, not unaided assessments.
        </p>
        {stats.modeledCovered === null || stats.actualCovered === null ? (
          <p>Modeled result unknown. Actual results remain available above.</p>
        ) : (
          <>
            <p>
              Actual on covered hands: {signed(stats.actualCovered)} · Modeled:{' '}
              {signed(stats.modeledCovered)}
            </p>
            <LineChart
              width={980}
              height={260}
              label="Cumulative chips on covered hands: actual versus modeled"
              series={[
                {
                  label: 'Modeled',
                  className: 'expected',
                  values: stats.expectedLine,
                },
                {
                  label: 'Actual',
                  className: 'actual',
                  values: stats.coveredNetLine,
                },
              ]}
            />
          </>
        )}
      </section>

      <div className="panel-row">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Decision quality</h2>
              <p>
                Grades compare each choice with the best modeled option at that
                moment.
              </p>
            </div>
          </div>
          <div className="grade-bars">
            {stats.grades.map((g) => (
              <div key={g.grade}>
                <GradeChip grade={g.grade} />
                <span className="grade-track">
                  <i
                    className={`grade-fill grade-${g.grade.toLowerCase()}`}
                    style={{ width: `${(g.count / maxGrade) * 100}%` }}
                  />
                </span>
                <b>{g.count}</b>
              </div>
            ))}
          </div>
          {stats.handAccuracy.length > 1 && (
            <>
              <span className="label chart-label">Accuracy per hand</span>
              <LineChart
                width={460}
                height={130}
                label="Accuracy per graded hand"
                format={(v) => `${Math.round(v)}`}
                series={[
                  {
                    label: 'Accuracy',
                    className: 'accuracy',
                    values: stats.handAccuracy,
                  },
                ]}
              />
            </>
          )}
        </section>
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Calibration</h2>
              <p>
                Your locked-in reads against the model. Perfect reads sit on the
                diagonal.
              </p>
            </div>
          </div>
          {stats.reads.length ? (
            <div className="calibration">
              <Scatter
                points={stats.reads.map((r) => ({ x: r.actual, y: r.guess }))}
              />
              <div className="blind-spots">
                <span className="label">Where your reads drift</span>
                {cal!.groups.slice(0, 5).map((g) => (
                  <div key={g.label}>
                    <span>{g.label}</span>
                    <b className={Math.abs(g.bias) > 0.08 ? 'negative' : ''}>
                      {g.bias >= 0 ? '+' : '−'}
                      {Math.round(Math.abs(g.bias) * 100)} pts
                    </b>
                    <small>
                      {g.count} read{g.count === 1 ? '' : 's'}
                    </small>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="muted">
              Turn on “Guess before the lab opens” in settings and lock in a few
              reads to see your calibration.
            </p>
          )}
        </section>
      </div>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Recent hands</h2>
          </div>
        </div>
        <div className="hand-list">
          {stats.hands
            .slice(-12)
            .reverse()
            .map((hand) => {
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
                      Hand #{hand.hand} · {hand.guided ? 'Guided' : 'Shuffled'}
                      {hand.hero ? ` · ${hand.hero.join(' ')}` : ''}
                      {hand.board?.length ? ` on ${hand.board.join(' ')}` : ''}
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
      </section>

      <DataActions
        progress={progress}
        onReplace={onReplace}
        onClear={onClear}
      />
    </div>
  )
}

/** Export, import and clear; shown even with no hands so a backup can be restored. */
function DataActions({
  progress,
  onReplace,
  onClear,
}: {
  progress: Progress
  onReplace: (progress: Progress) => void
  onClear?: () => void
}) {
  const file = useRef<HTMLInputElement>(null)
  return (
    <div className="data-actions">
      <span>
        Saved to your account, so it follows you to any device. Export a backup
        at any time.
      </span>
      {progress.hands.length > 0 && (
        <button
          className="btn btn-quiet"
          onClick={() => {
            const blob = new Blob([exportProgress(progress)], {
              type: 'application/json',
            })
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = 'deltadeck-progress.json'
            a.click()
            URL.revokeObjectURL(url)
          }}
        >
          <Download size={14} /> Export
        </button>
      )}
      <button className="btn btn-quiet" onClick={() => file.current?.click()}>
        <Upload size={14} /> Import
      </button>
      <input
        ref={file}
        type="file"
        accept="application/json"
        hidden
        aria-label="Progress file to import"
        onChange={async (e) => {
          const chosen = e.target.files?.[0]
          e.target.value = ''
          if (!chosen) return
          const imported = importProgress(await chosen.text())
          if (!imported)
            window.alert('That file is not a DeltaDeck progress export.')
          else if (
            window.confirm(
              `Replace your progress with ${imported.hands.length} imported hands?`,
            )
          )
            onReplace(imported)
        }}
      />
      {onClear && (
        <button
          className="btn btn-quiet danger"
          onClick={() => {
            if (
              window.confirm(
                'Clear your saved hands and lessons, here and on your account? Settings are kept.',
              )
            )
              onClear()
          }}
        >
          <RotateCcw size={14} /> Clear
        </button>
      )}
    </div>
  )
}
