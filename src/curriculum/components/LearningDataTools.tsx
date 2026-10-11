import { useState } from 'react'
import type { LearningSession } from '../core/session'
import { registry } from '../core/registry'
import { evidenceState } from '../core/assessment'
import { routes } from '../core/routes'
function downloadText(content: string, name: string, mime: string) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  try {
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}
export function LearningDataTools({ session }: { session: LearningSession }) {
  const [error, setError] = useState('')
  const [confirm, setConfirm] = useState(false)
  function exportData(format: 'json' | 'markdown') {
    try {
      downloadText(
        session.export(format),
        `deltadeck-learning.${format === 'json' ? 'json' : 'md'}`,
        format === 'json' ? 'application/json' : 'text/markdown',
      )
      setError('')
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'Export unavailable. Your records remain in this tab.',
      )
    }
  }
  return (
    <section className="qp-data-tools">
      <h2>Learning data and recovery</h2>
      <p>
        Only your learning records are exported: no table history, private cards
        or future deck. JSON import is not part of R1.
      </p>
      <button className="button secondary" onClick={() => exportData('json')}>
        Export learning JSON
      </button>
      <button
        className="button secondary"
        onClick={() => exportData('markdown')}
      >
        Export learning Markdown
      </button>
      {session.raw !== null ? (
        <button
          className="button secondary"
          onClick={() => {
            try {
              downloadText(
                session.raw!,
                'deltadeck-learning-raw.txt',
                'text/plain',
              )
            } catch {
              setError(
                'Raw download unavailable; original browser data was not overwritten.',
              )
            }
          }}
        >
          Export original raw learning data
        </button>
      ) : null}
      {session.conflict ? (
        <>
          <p>
            Reloading saved progress discards only this tab’s unsaved work.
            Export first.
          </p>
          <button className="button secondary" onClick={() => setConfirm(true)}>
            Review reload saved progress
          </button>
          {confirm ? (
            <div role="alert">
              <p>
                Discard this tab’s unsaved work and reload the other tab’s saved
                progress?
              </p>
              <button
                className="button danger"
                onClick={() => {
                  session.reloadSaved()
                  setConfirm(false)
                }}
              >
                Reload saved progress and discard this tab
              </button>
              <button
                className="button secondary"
                onClick={() => setConfirm(false)}
              >
                Keep this tab
              </button>
            </div>
          ) : null}
        </>
      ) : null}
      {session.recovery ? (
        <p>
          Normal autosave is disabled to protect the original data. Continue
          temporarily and export; explicit reset is available in My notebook.
        </p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      <h2>Foundation notebook and evidence</h2>
      <p>
        Prior/core completion is separate. Predictions and reflection are
        ungraded; assisted or exposed variants do not establish fresh
        demonstration. Historical success remains visible after content changes.
      </p>
      {[...registry.units.values()].map((u) => (
        <details key={u.id}>
          <summary>
            {u.id.toUpperCase()} {u.title} —{' '}
            {evidenceState(
              session.store,
              u.id,
              u.contentVersion,
              u.rubricVersion,
              session.clock,
            )}
          </summary>
          <label>
            {u.id.toUpperCase()} notes and changed beliefs (ungraded; 2,000
            characters)
            <textarea
              maxLength={2000}
              value={session.store.unitNotes[u.id] ?? ''}
              onChange={(e) =>
                session.update((s) => ({
                  ...s,
                  unitNotes: { ...s.unitNotes, [u.id]: e.target.value },
                }))
              }
            />
          </label>
          <p>
            Device-clock review due:{' '}
            {session.store.reviewSchedule[u.id]?.dueAt ??
              'after fresh demonstration'}
            . <a href={routes.unit(u.id, 'review')}>Open review bank</a>
          </p>
          <ul>
            {session.store.receipts
              .filter((r) => r.unitId === u.id)
              .map((r) => (
                <li key={r.id}>
                  {r.caseId}: {r.earned}/{r.max},{' '}
                  {r.eligible ? 'eligible' : 'practice only'},{' '}
                  {r.unaided ? 'unaided' : 'assisted/repeated'}; content
                  {r.contentVersion}/rubric{r.rubricVersion}; {r.submittedAt}
                </li>
              ))}
          </ul>
          <h3>Recent prediction and reflection snapshots</h3>
          {session.store.attempts
            .filter((a) => a.unitId === u.id)
            .slice(-10)
            .reverse()
            .map((a) => (
              <article key={a.id}>
                <h4>{a.caseId}</h4>
                <p>
                  {a.phase}; {a.mode}; model {a.modelVersion}; {a.createdAt}
                </p>
                <p>
                  Prediction: {a.prediction?.actionId ?? 'none'};{' '}
                  {a.prediction?.direction ?? 'not supplied'}; estimate{' '}
                  {a.prediction?.numericEstimate ?? 'not supplied'}; confidence{' '}
                  {a.prediction?.confidencePercent ?? 'not sure'}.{' '}
                  {a.prediction?.rationale}
                </p>
                <p>Reflection (ungraded): {a.reflection ?? 'not supplied'}</p>
                <p>
                  {a.assistance.hintIds.length} hints; solution{' '}
                  {a.assistance.solutionViewed ? 'exposed' : 'not exposed'}.
                  Retained summaries are in JSON/Markdown exports.
                </p>
              </article>
            ))}
        </details>
      ))}
    </section>
  )
}
