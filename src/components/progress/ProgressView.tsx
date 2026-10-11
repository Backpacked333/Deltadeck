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
import { calibrationSummary, GRADES } from '../../lib/grading'
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
  const stats = useMemo(() => {
    const hands = progress.hands
    const decisions = hands.flatMap((h) => h.decisions ?? [])
    const graded = hands.filter((h) => h.decisions?.length)
    const handAccuracy = graded.map(
      (h) =>
        h.decisions!.reduce((s, d) => s + d.accuracy, 0) / h.decisions!.length,
    )
    let net = 0,
      expected = 0
    const netLine: number[] = [0],
      expectedLine: number[] = [0]
    hands.forEach((h) => {
      net += h.net
      expected += h.expectedNet ?? h.net
      netLine.push(net)
      expectedLine.push(expected)
    })
    const grades = GRADES.map((g) => ({
      grade: g,
      count: decisions.filter((d) => d.grade === g).length,
    }))
    const reads = decisions
      .filter((d) => d.guess !== undefined)
      .map((d) => ({
        guess: d.guess!,
        actual: d.equity,
        label: d.handClass || 'Other',
      }))
    return {
      hands,
      decisions,
      accuracy: decisions.length
        ? decisions.reduce((s, d) => s + d.accuracy, 0) / decisions.length
        : null,
      handAccuracy,
      netLine,
      expectedLine,
      net,
      expected,
      grades,
      reads,
      calibration: calibrationSummary(reads),
      session: hands.filter((h) => h.id.startsWith(sessionId)).length,
      evLost: decisions.reduce((s, d) => s + d.evLost, 0),
    }
  }, [progress.hands, sessionId])

  if (!stats.hands.length)
    return (
      <div className="page progress-page">
        <header className="page-head">
          <h1>Small decisions. Lasting intuition.</h1>
          <p>Your progress lives on this device only.</p>
        </header>
        <div className="empty">
          <Sparkles size={26} />
          <h3>Your first insight is one hand away.</h3>
          <p>
            Play a few hands and this page will separate skill from luck: how
            accurate your decisions are, how well calibrated your reads are, and
            how much of your result was variance.
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
          {stats.hands.length} hands recorded on this device · {stats.session}{' '}
          this session
        </p>
      </header>
      <div className="tiles">
        <div className="tile">
          <Gauge size={18} />
          <span className="label">Decision accuracy</span>
          <strong>
            {stats.accuracy === null ? '—' : Math.round(stats.accuracy)}
          </strong>
          <small>
            {stats.decisions.length} graded decisions ·{' '}
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
          {stats.net >= 0 ? (
            <ArrowUpRight size={18} />
          ) : (
            <ArrowDownRight size={18} />
          )}
          <span className="label">Chips won</span>
          <strong className={stats.net >= 0 ? 'positive' : 'negative'}>
            {signed(stats.net)}
          </strong>
          <small>model expected {signed(stats.expected)}</small>
        </div>
        <div className="tile">
          <Waves size={18} />
          <span className="label">Variance so far</span>
          <strong>{signed(stats.net - stats.expected)}</strong>
          <small>result minus expectation: luck, not skill</small>
        </div>
      </div>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Luck versus skill</h2>
            <p>
              Your real chip result against what the model expected from your
              decisions. The gap between the lines is variance; it shrinks
              relative to the total as you play more hands.
            </p>
          </div>
          <div className="legend">
            <span>
              <i className="series-key actual" /> Result
            </span>
            <span>
              <i className="series-key expected" /> Expected from decisions
            </span>
          </div>
        </div>
        <LineChart
          width={980}
          height={260}
          label="Cumulative chips: result versus expected"
          series={[
            {
              label: 'Expected',
              className: 'expected',
              values: stats.expectedLine,
            },
            { label: 'Result', className: 'actual', values: stats.netLine },
          ]}
        />
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
              const accuracy = hand.decisions?.length
                ? hand.decisions.reduce((s, d) => s + d.accuracy, 0) /
                  hand.decisions.length
                : null
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
        Stored on this device only. Export a backup or move it to another
        browser.
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
              `Replace this device's progress with ${imported.hands.length} imported hands?`,
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
                'Clear saved hands and lessons on this device? Settings are kept.',
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
