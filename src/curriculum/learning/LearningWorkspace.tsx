import { useEffect, useMemo, useState } from 'react'
import type { LearningSession } from '../core/session'
import { CasePlayer } from '../components/CasePlayer'
import { canonical, digest } from '../../net/syncRevision'
import { base } from './evidence'
import { skills, tasks, taskById } from './content'
import { project } from './projector'
import { recommend } from './recommend'
import { CHANGED, evidenceRuntime } from './runtime'
import { skillIds, type Recommendation, type SkillId } from './types'
import type { StoredEvent } from './types'
const EMPTY: StoredEvent[] = []

export default function LearningWorkspace({
  session,
}: {
  session: LearningSession
}) {
  const [, setRevision] = useState(0)
  const [goal, setGoal] = useState<SkillId>('incremental')
  const [selected, setSelected] = useState<{
    id: string
    accountId: string
    epoch: number
    learningGeneration: number
    assessmentIssueId?: string
  } | null>(null)
  const [logged, setLogged] = useState<Recommendation | null>(null)
  const [message, setMessage] = useState('')
  useEffect(() => {
    const update = () => setRevision((r) => r + 1)
    window.addEventListener(CHANGED, update)
    return () => window.removeEventListener(CHANGED, update)
  }, [])
  const runtime = evidenceRuntime()
  const rows = runtime?.rows ?? EMPTY
  const serverNow = runtime?.serverNow
  const projection = useMemo(
    () => project(rows, runtime?.sync.scope.accountId ?? '', serverNow),
    [rows, runtime, serverNow],
  )
  const assignment = runtime?.assignment
  const pilot = !!(
    assignment?.enabled &&
    assignment.consented &&
    !assignment.withdrawn &&
    assignment.arm === 'targeted'
  )
  const rec = useMemo(
    () =>
      recommend(projection, rows, runtime?.sync.scope.accountId ?? '', '', {
        goal,
        pilot,
        serverNow: runtime?.serverNow,
        practiceGeneration: runtime?.practiceGeneration,
      }),
    [projection, rows, runtime, goal, pilot],
  )
  useEffect(() => {
    let stopped = false
    if (!runtime) return
    const record = async () => {
      // Only source inputs determine a snapshot; recording it must not feed itself.
      const stable = rec
      const id = `recommendation:${await digest(canonical(stable))}`
      const event = { ...stable, id, observedAt: '1970-01-01T00:00:00.000Z' }
      if (stopped) return
      await runtime.emit(event)
      if (!stopped) setLogged(event)
    }
    void record().catch((e) => {
      if (!stopped) setMessage(String(e))
    })
    return () => {
      stopped = true
    }
  }, [rec, runtime])
  async function feedback(
    response: 'started' | 'does-not-fit' | 'other-focus',
  ) {
    if (
      !runtime ||
      !logged ||
      logged.accountId !== runtime.sync.scope.accountId
    )
      return
    await runtime.emit({
      ...base(
        runtime.sync.scope.accountId,
        `feedback:${crypto.randomUUID()}`,
        new Date().toISOString(),
      ),
      kind: 'feedback',
      recommendationId: logged.id,
      response,
    })
  }
  async function begin(id: string, recommended = false) {
    try {
      if (!runtime) return
      const task = taskById.get(id)
      const issue = task?.holdout
        ? await runtime.issueAssessment(task.skill)
        : null
      if (evidenceRuntime() !== runtime) return
      if (issue && issue.caseId !== id)
        throw new Error(
          'Assessment identity mismatch; refresh account evidence',
        )
      if (recommended) await feedback('started')
      if (evidenceRuntime() !== runtime) return
      setSelected({
        id,
        ...runtime.sync.scope,
        learningGeneration: runtime.learningGeneration,
        ...(issue ? { assessmentIssueId: issue.issueId } : {}),
      })
      setMessage('')
    } catch (e) {
      setMessage(String(e))
    }
  }
  async function exportData() {
    if (!runtime) return
    try {
      const blob = await runtime.exportAccount(runtime.sync.scope)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'deltadeck-learning-evidence.json'
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (e) {
      setMessage(String(e))
    }
  }
  const used = new Set(
    rows.flatMap(({ event: e }) =>
      e.kind === 'exposure'
        ? [e.family]
        : e.kind === 'submission' && e.family
          ? [e.family]
          : [],
    ),
  )
  const current =
    selected &&
    selected.accountId === runtime?.sync.scope.accountId &&
    selected.epoch === runtime.sync.scope.epoch &&
    selected.learningGeneration === runtime.learningGeneration
      ? taskById.get(selected.id)
      : null
  return (
    <section className="qp-foundation qp-targeted">
      <header className="page-heading">
        <div>
          <div className="eyebrow">QUALIFIED SELF-STUDY</div>
          <h1 tabIndex={-1}>Your evidence, not a score.</h1>
          <p>
            Three skills. Inspectable answers. Fresh contexts. No claim of
            proven personalization.
          </p>
        </div>
      </header>
      <p>
        <a href="#learn/foundations">Continue the curriculum in order</a> ·{' '}
        <a href="#learn/reviews">Existing review dates</a>
      </p>
      <p>
        Ratings measure competitive results. Trainer EV describes decisions
        under a model. This workspace records structured self-study; none
        substitutes for the others.
      </p>
      {!runtime ? (
        <p role="status">
          Sign in and finish account reconciliation to save an append-only
          evidence history. The ordinary curriculum remains available locally.
        </p>
      ) : (
        <p role="status">
          Evidence save: {runtime.status().replaceAll('_', ' ')}.{' '}
          {runtime.error}
        </p>
      )}
      {message ? <p role="alert">{message}</p> : null}
      {runtime ? (
        <div className="qp-targeted-actions">
          <button
            className="button secondary"
            onClick={() =>
              void runtime.retry().catch((e) => setMessage(String(e)))
            }
          >
            Retry and refresh account evidence
          </button>
          <button
            className="button secondary"
            onClick={() => void exportData()}
          >
            Export raw evidence and replay inputs
          </button>
        </div>
      ) : null}
      <div className="qp-targeted-skills">
        {projection.skills.map((s) => (
          <article key={s.skill}>
            <h2>{skills[s.skill].title}</h2>
            <p>
              Self-study stage: <strong>{s.stage}</strong>
            </p>
            <p>
              {s.successes.length} eligible successful families;{' '}
              {s.errors.length} contrary observations. Misconception hypothesis:{' '}
              {s.hypothesis}.
            </p>
            <p>
              Retention: {s.retention.replaceAll('-', ' ')}.{' '}
              {s.dueAt
                ? `Earliest new-family review: ${new Date(s.dueAt).toLocaleDateString()}.`
                : 'No account-received transfer anchor yet.'}
            </p>
            <p>
              Prose is not graded. Unaided status is self-reported; device
              clocks cannot prove delayed completion. A server-issued check
              proves only issuance/receipt timing, not unseen content or
              retained skill.
            </p>
          </article>
        ))}
      </div>
      {assignment ? (
        <section>
          <h2>Limited pilot invitation</h2>
          <p>
            Protocol {assignment.protocol}. Endpoint: {assignment.endpoint}.
            Baseline: ordinary curriculum order and review dates. Participation
            does not promise better learning.
          </p>
          <button
            className="button secondary"
            onClick={() =>
              void runtime
                ?.consent(!assignment.consented || assignment.withdrawn)
                .catch((e) => setMessage(String(e)))
            }
          >
            {assignment.consented && !assignment.withdrawn
              ? 'Withdraw pilot consent'
              : 'Opt into this limited pilot'}
          </button>
        </section>
      ) : null}
      <label>
        Choose your focus{' '}
        <select
          value={goal}
          onChange={(e) => {
            setGoal(e.target.value as SkillId)
            setSelected(null)
          }}
        >
          {skillIds.map((s) => (
            <option key={s} value={s}>
              {skills[s].title}
            </option>
          ))}
        </select>
      </label>
      {pilot &&
      logged &&
      logged.accountId === runtime?.sync.scope.accountId &&
      logged.skill === goal ? (
        <section aria-label="Why this practice">
          <h2>Why this practice?</h2>
          <p>{logged.hypothesis}</p>
          <p>{logged.mechanism}</p>
          <p>
            {logged.assistance} · about {logged.effortMinutes} minutes.
          </p>
          <p>{logged.followup}</p>
          <p>
            Evidence:{' '}
            {logged.evidence.length
              ? logged.evidence.map((id) => (
                  <a
                    href="#learn/targeted"
                    key={id}
                    onClick={(e) => {
                      e.preventDefault()
                      const item = document.getElementById(
                        `evidence-${encodeURIComponent(id)}`,
                      )
                      const details = item?.closest('details')
                      if (details) details.open = true
                      item?.scrollIntoView({ block: 'center' })
                    }}
                  >
                    {id}{' '}
                  </a>
                ))
              : 'Cold start; no diagnosis yet.'}
          </p>
          {logged.selected ? (
            <button
              className="button primary"
              onClick={() => void begin(logged.selected!, true)}
            >
              Try {taskById.get(logged.selected)?.case.title}
            </button>
          ) : (
            <p role="status">
              {logged.state === 'waiting-for-delay'
                ? 'Not due yet. Keep practicing, but early repeats are not retention.'
                : 'Content limited: no fresh family remains. Revisit for practice only or choose another focus.'}
            </p>
          )}
          <div className="qp-targeted-actions">
            <button
              className="button secondary"
              onClick={() =>
                void feedback('does-not-fit').catch((e) =>
                  setMessage(String(e)),
                )
              }
            >
              This does not fit
            </button>
            <button
              className="button secondary"
              onClick={() =>
                void feedback('other-focus')
                  .then(() =>
                    setGoal(skillIds[(skillIds.indexOf(goal) + 1) % 3]),
                  )
                  .catch((e) => setMessage(String(e)))
              }
            >
              Choose another focus
            </button>
          </div>
        </section>
      ) : (
        <p>
          Targeted selection runs in shadow. It does not reorder your work.
          Below is a fixed, learner-chosen sequence—not a personalized
          recommendation.
        </p>
      )}
      <ol>
        {tasks
          .filter((t) => t.skill === goal && !t.holdout)
          .map((t) => (
            <li key={t.case.id}>
              <button
                className="text-button"
                disabled={!runtime}
                onClick={() => void begin(t.case.id)}
              >
                {t.case.title}
              </button>{' '}
              · {t.purpose} ·{' '}
              {used.has(t.family)
                ? 'previously exposed; revisit only'
                : 'new family'}{' '}
              · {t.minutes} min
            </li>
          ))}
      </ol>
      {projection.skills.find((s) => s.skill === goal)?.retention === 'due'
        ? tasks
            .filter((t) => t.skill === goal && t.holdout && !used.has(t.family))
            .map((t) => (
              <button
                className="button secondary"
                key={t.case.id}
                onClick={() => void begin(t.case.id)}
              >
                Delayed new-family check: {t.case.title}
              </button>
            ))
        : null}
      {current ? (
        <section key={current.case.id}>
          <p>
            {current.holdout
              ? 'Reserved assessment. Opening hints or prior-family reuse excludes independent evidence.'
              : 'Practice and assessment use different evidence rules. A repeat never becomes fresh by changing numbers.'}
          </p>
          <p>
            Effort records visible, recently active browser time, excluding
            hidden time and idle periods over 60 seconds. It is client-reported,
            not proof of attention.
          </p>
          <CasePlayer
            key={`${selected?.accountId}:${selected?.epoch}:${selected?.learningGeneration}:${current.case.id}:${selected?.assessmentIssueId ?? 'practice'}`}
            caseRecord={current.case}
            session={session}
            assessmentIssueId={selected?.assessmentIssueId}
          />
        </section>
      ) : null}
      <details>
        <summary>
          Inspect raw attempts, evaluations and policy decisions separately
        </summary>
        <p>
          Projection {projection.version}; mapping {projection.mapping}.
          Rebuildable from {projection.cutoff.length} immutable input records.
          Shadow selections are research logs, not advice.
        </p>
        {rows
          .filter((r) => r.event.kind !== 'recommendation' || pilot)
          .map((r) => (
            <article
              key={`${r.event.id}:${r.digest}`}
              id={`evidence-${encodeURIComponent(r.event.id)}`}
            >
              <h3>
                {r.event.kind}: {r.event.id}
              </h3>
              <pre>{JSON.stringify(r, null, 2)}</pre>
            </article>
          ))}
      </details>
    </section>
  )
}
