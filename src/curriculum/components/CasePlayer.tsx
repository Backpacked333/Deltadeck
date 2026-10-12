import { useEffect, useId, useRef, useState } from 'react'
import { evaluateCase } from '../core/assessment'
import { hashText } from '../core/seededRandom'
import type { LearningSession } from '../core/session'
import type {
  Answer,
  AttemptSnapshot,
  CaseRecord,
  Question,
} from '../core/types'
import { safeClone } from '../core/validation'
import { PredictionForm } from './PredictionForm'
import { connectionLabels } from '../content/foundations'
import { EffortClock } from '../core/effort'

function QuestionInput({
  question,
  answer,
  onAnswer,
  disabled,
  caseId,
}: {
  question: Question
  answer: Answer | undefined
  onAnswer: (value: Answer | undefined) => void
  disabled: boolean
  caseId: string
}) {
  const id = useId()
  if (question.kind === 'numeric')
    return (
      <div className="qp-question">
        <label htmlFor={id}>
          {question.prompt} ({question.units}; tolerance ±{question.tolerance})
        </label>
        <input
          id={id}
          type="number"
          step="any"
          disabled={disabled}
          value={answer ?? ''}
          onChange={(e) =>
            onAnswer(
              e.target.value.trim() && Number.isFinite(Number(e.target.value))
                ? Number(e.target.value)
                : undefined,
            )
          }
        />
      </div>
    )
  if (question.kind === 'choice') {
    const options =
      hashText(`${caseId}:${question.id}`) % 2
        ? [...question.options].reverse()
        : question.options
    return (
      <fieldset disabled={disabled}>
        <legend>{question.prompt}</legend>
        {options.map((o) => (
          <label key={o.id}>
            <input
              type={Array.isArray(question.expected) ? 'checkbox' : 'radio'}
              name={id}
              value={o.id}
              checked={
                Array.isArray(answer) ? answer.includes(o.id) : answer === o.id
              }
              onChange={(e) =>
                onAnswer(
                  Array.isArray(question.expected)
                    ? question.options
                        .filter((option) =>
                          option.id === o.id
                            ? e.target.checked
                            : Array.isArray(answer) &&
                              answer.includes(option.id),
                        )
                        .map((o) => o.id)
                    : o.id,
                )
              }
            />
            {o.label}
          </label>
        ))}
      </fieldset>
    )
  }
  const entries =
    question.kind === 'ordering'
      ? question.options.map((_, i) => ({
          id: String(i),
          label: `Position ${i + 1}`,
        }))
      : question.entries
  const options =
    question.kind === 'ordering' ? question.options : question.categories
  return (
    <fieldset disabled={disabled}>
      <legend>{question.prompt}</legend>
      {entries.map((entry, i) => (
        <label key={entry.id} htmlFor={`${id}-${i}`}>
          {entry.label}
          <select
            id={`${id}-${i}`}
            value={Array.isArray(answer) ? (answer[i] ?? '') : ''}
            onChange={(e) => {
              const next = Array.isArray(answer)
                ? [...answer]
                : entries.map(() => '')
              next[i] = e.target.value
              onAnswer(next)
            }}
          >
            <option value="">Choose</option>
            {options.map((o) => (
              <option value={o.id} key={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      ))}
    </fieldset>
  )
}
export function CasePlayer({
  caseRecord: c,
  session,
  assessmentIssueId,
}: {
  caseRecord: CaseRecord
  session: LearningSession
  assessmentIssueId?: string
}) {
  const feedbackRef = useRef<HTMLHeadingElement>(null)
  const focusFeedback = useRef(false)
  const [attempt, setAttempt] = useState<AttemptSnapshot>(() => {
    const prior = [...session.store.attempts]
      .reverse()
      .find(
        (a) =>
          a.caseId === c.id &&
          a.contentVersion === c.contentVersion &&
          a.rubricVersion === c.rubricVersion,
      )
    return prior
      ? safeClone(prior)
      : {
          id: crypto.randomUUID(),
          ...(assessmentIssueId ? { assessmentIssueId } : {}),
          unitId: c.unitId,
          caseId: c.id,
          contentVersion: c.contentVersion,
          rubricVersion: c.rubricVersion,
          modelVersion: 'foundation-cases-v1',
          mode:
            c.mode === 'transfer' || c.mode === 'review' ? c.mode : 'practice',
          createdAt: session.clock().toISOString(),
          inputs: { caseId: c.id },
          answers: {},
          assistance: { hintIds: [], solutionViewed: false },
          phase: 'draft',
        }
  })
  const [effort] = useState(
    () => new EffortClock(attempt.effort, undefined, !document.hidden),
  )
  const latest = useRef(attempt)
  useEffect(() => {
    latest.current = attempt
  }, [attempt])
  useEffect(() => {
    const visibility = () => {
      effort.visibility(!document.hidden)
      if (!latest.current.submittedAt) {
        const next = { ...latest.current, effort: effort.snapshot() }
        latest.current = next
        session.recordAttempt(next)
        setAttempt(next)
      }
    }
    document.addEventListener('visibilitychange', visibility)
    return () => document.removeEventListener('visibilitychange', visibility)
  }, [effort, session])
  useEffect(() => {
    if (attempt.submittedAt && focusFeedback.current) {
      focusFeedback.current = false
      feedbackRef.current?.focus()
    }
  }, [attempt.submittedAt])
  function save(next: AttemptSnapshot) {
    if (!attempt.submittedAt) next = { ...next, effort: effort.snapshot() }
    latest.current = next
    session.recordAttempt(next)
    setAttempt(next)
  }
  function answer(id: string, value: Answer | undefined) {
    const answers = { ...attempt.answers }
    if (value === undefined) delete answers[id]
    else answers[id] = value
    save({ ...attempt, answers })
  }
  return (
    <article
      className="qp-case"
      onPointerDownCapture={() => effort.interact()}
      onKeyDownCapture={() => effort.interact()}
    >
      <h3>{c.title}</h3>
      <p className="outline-badge">{connectionLabels[c.connection]}</p>
      <p>
        <strong>Role:</strong> {c.role}. <strong>Objective:</strong>{' '}
        {c.objective}
      </p>
      <ul>
        {c.information.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
      <p>
        <strong>Settlement:</strong> {c.cashFlows}
      </p>
      <p>
        <strong>Assumptions:</strong> {c.assumptions.join(' ')}
      </p>
      {c.mode === 'partial' ? (
        <section>
          <h4>Partial scaffold</h4>
          {attempt.assistance.hintIds.includes('scaffold:open') ? (
            <ul>
              {c.scaffold?.map((row) => (
                <li key={row}>{row}</li>
              ))}
            </ul>
          ) : null}
          {!attempt.submittedAt ? (
            <button
              type="button"
              className="button secondary"
              disabled={attempt.assistance.hintIds.includes('scaffold:open')}
              onClick={() =>
                save({
                  ...attempt,
                  assistance: {
                    ...attempt.assistance,
                    hintIds: [
                      ...new Set([
                        ...attempt.assistance.hintIds,
                        ...(c.scaffold
                          ? ['scaffold:open']
                          : c.questions.flatMap((q) => [
                              `${q.id}:0`,
                              `${q.id}:1`,
                            ])),
                      ]),
                    ],
                  },
                })
              }
            >
              Open the partial scaffold (marks assisted)
            </button>
          ) : null}
          <p>
            Finish the still-uncomputed quantities below; use a fresh transfer
            for unaided evidence.
          </p>
        </section>
      ) : null}
      {!attempt.committedAt ? (
        <PredictionForm
          initial={attempt.prediction}
          actions={c.actions}
          question="Predict the requested numeric quantity and action before answering. Name a decision-changing assumption."
          onDraft={(prediction) => save({ ...attempt, prediction })}
          onCommit={(prediction) =>
            save({
              ...attempt,
              prediction,
              committedAt: session.clock().toISOString(),
              phase: 'prediction_committed',
            })
          }
        />
      ) : (
        <>
          <p>
            Committed prediction: {attempt.prediction?.actionId};{' '}
            {attempt.prediction?.direction}; estimate{' '}
            {attempt.prediction?.numericEstimate ?? 'not supplied'}; confidence{' '}
            {attempt.prediction?.confidencePercent ?? 'not sure'}.{' '}
            {attempt.prediction?.rationale}
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (attempt.submittedAt) return
              const evaluation = evaluateCase(
                c,
                attempt,
                session.store.attempts,
                session.store.receipts,
                session.store.reviewSchedule[c.unitId],
                session.clock,
                session.store.exposedVariants,
              )
              focusFeedback.current = true
              save({
                ...attempt,
                evaluation,
                submittedAt: session.clock().toISOString(),
                phase: 'archived',
              })
            }}
          >
            {c.questions.map((q) => {
              const exposed = q.hints.filter((_, i) =>
                attempt.assistance.hintIds.includes(`${q.id}:${i}`),
              )
              return (
                <section key={q.id}>
                  <QuestionInput
                    question={q}
                    caseId={c.id}
                    answer={attempt.answers[q.id]}
                    disabled={!!attempt.submittedAt}
                    onAnswer={(value) => answer(q.id, value)}
                  />
                  {!attempt.submittedAt ? (
                    <>
                      <button
                        type="button"
                        className="text-button"
                        disabled={exposed.length === 4}
                        onClick={() =>
                          save({
                            ...attempt,
                            assistance: {
                              hintIds: [
                                ...attempt.assistance.hintIds,
                                `${q.id}:${exposed.length}`,
                              ],
                              solutionViewed:
                                attempt.assistance.solutionViewed ||
                                exposed.length === 3,
                            },
                          })
                        }
                      >
                        Show next hint for {q.id} ({exposed.length}/4; marks
                        assisted)
                      </button>
                      {exposed.map((hint, i) => (
                        <p key={i}>{hint}</p>
                      ))}
                    </>
                  ) : (
                    <p>{q.rationale}</p>
                  )}
                </section>
              )
            })}
            <label>
              Written defense (ungraded, up to2,000 characters)
              <span>{c.reflectionPrompt}</span>
              <textarea
                maxLength={2000}
                disabled={!!attempt.submittedAt}
                value={attempt.reflection ?? ''}
                onChange={(e) =>
                  save({ ...attempt, reflection: e.target.value })
                }
              />
            </label>
            {!attempt.submittedAt ? (
              <button className="button" type="submit">
                Submit structured answers
              </button>
            ) : null}
          </form>
        </>
      )}
      {attempt.evaluation ? (
        <section role="status">
          <h4 ref={feedbackRef} tabIndex={-1}>
            Structured feedback
          </h4>
          <p>
            {attempt.evaluation.earned}/{attempt.evaluation.max};{' '}
            {attempt.evaluation.eligible
              ? 'eligible unaided evidence'
              : 'practice only'}
            ; {attempt.evaluation.unaided ? 'unaided' : 'assisted/repeated'}.
          </p>
          <p>{attempt.evaluation.reasons.join(' ')}</p>
          <p>
            Critical misses:{' '}
            {attempt.evaluation.criticalFailures.join(', ') || 'none'}. Realized
            outcomes, confidence and prose were not scored.
          </p>
          <ol>
            {c.workedSolution.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          <button
            type="button"
            className="button secondary"
            onClick={() =>
              save({
                id: crypto.randomUUID(),
                parentAttemptId: attempt.id,
                unitId: c.unitId,
                caseId: c.id,
                contentVersion: c.contentVersion,
                rubricVersion: c.rubricVersion,
                modelVersion: 'foundation-cases-v1',
                mode:
                  c.mode === 'review'
                    ? 'review'
                    : c.mode === 'transfer'
                      ? 'transfer'
                      : 'practice',
                createdAt: session.clock().toISOString(),
                inputs: { caseId: c.id },
                answers: {},
                assistance: { hintIds: [], solutionViewed: false },
                phase: 'draft',
              })
            }
          >
            Practice this variant again (no fresh unaided credit)
          </button>
        </section>
      ) : null}
      <p>{c.constraints}</p>
      <p>Decision reversal: {c.decisionReversal}</p>
    </article>
  )
}
