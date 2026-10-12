import { evaluateCase } from '../core/assessment'
import { decodeAttempt } from '../core/persistence'
import type { AttemptSnapshot, CaseRecord } from '../core/types'
import type { HandRecord } from '../../lib/storage'
import { canonical, digest } from '../../net/syncRevision'
import { skills, taskById } from './content'
import {
  MAPPING,
  type Evaluation,
  type Exposure,
  type LearningEvent,
  type Submission,
} from './types'

export const EVALUATOR = 'structured-self-study.v1'
export const base = (accountId: string, id: string, observedAt: string) => ({
  schema: 1 as const,
  accountId,
  id,
  observedAt,
  trust: 'client-reported' as const,
})
export function submission(
  accountId: string,
  attempt: AttemptSnapshot,
): Submission {
  if (!decodeAttempt(attempt).ok || !attempt.submittedAt)
    throw new Error('A valid immutable submission is required')
  const task = taskById.get(attempt.caseId)
  // The evaluation is a separate immutable record, not part of the raw answer.
  const raw = { ...attempt }
  delete raw.evaluation
  delete raw.reflection
  raw.phase = 'results_ready'
  return {
    ...base(accountId, `attempt:${attempt.id}`, attempt.submittedAt),
    kind: 'submission',
    source: 'curriculum',
    sourceId: attempt.id,
    sourceRevision: `${attempt.contentVersion}:${attempt.rubricVersion}`,
    family: task?.family ?? null,
    context: task?.context ?? 'legacy-unknown',
    skills: task ? [task.skill] : [],
    mapping: MAPPING,
    clock: 'device-uncertain',
    assistance:
      attempt.assistance.solutionViewed || attempt.assistance.hintIds.length
        ? 'assisted'
        : 'reported-unaided',
    mode:
      task &&
      ['diagnostic', 'independent', 'transfer', 'delayed'].includes(
        task.purpose,
      )
        ? (task.purpose as Submission['mode'])
        : 'practice',
    attempt: raw,
    practice: null,
  }
}
export function evaluateSubmission(
  s: Submission,
  lookup?: (id: string) => CaseRecord | undefined,
): Evaluation {
  const task = s.attempt && taskById.get(s.attempt.caseId)
  const c = task
    ? task.case
    : s.attempt
      ? lookup?.(s.attempt.caseId)
      : undefined
  const reasons: string[] = []
  let passed: boolean | null = null
  let errors: string[] = []
  if (!s.attempt || !c || !decodeAttempt(s.attempt).ok)
    reasons.push('unsupported-source')
  else {
    const a = s.attempt
    const e = evaluateCase(
      c,
      a,
      [],
      [],
      undefined,
      () => new Date(a.submittedAt!),
    )
    passed = e.passed
    if (
      a.contentVersion !== c.contentVersion ||
      a.rubricVersion !== c.rubricVersion
    )
      reasons.push('unknown-content-or-rubric')
    if (!a.committedAt || !a.prediction?.rationale.trim())
      reasons.push('missing-commitment')
    if (
      !Number.isFinite(Date.parse(a.committedAt ?? '')) ||
      Date.parse(a.committedAt!) > Date.parse(a.submittedAt!) ||
      Date.parse(a.createdAt) > Date.parse(a.committedAt!)
    )
      reasons.push('invalid-timing')
    const signatures: Record<string, [string, number]> = {
      'targeted-incremental-poker-call': ['net', 120],
      'targeted-incremental-business-inventory': ['net', 150],
      'targeted-incremental-cash-diagnostic': ['net', 35],
      'targeted-conditioning-poker-event': ['conditional', 6 / 20],
      'targeted-conditioning-business-screen': ['probability', 60 / 200],
      'targeted-thresholds-poker-price': ['threshold', 20 / 80],
      'targeted-thresholds-business-contract': ['threshold', 60 / 140],
    }
    const signature = task && signatures[task.case.id]
    if (
      task &&
      !passed &&
      signature &&
      typeof a.answers[signature[0]] === 'number' &&
      Math.abs(Number(a.answers[signature[0]]) - signature[1]) < 1e-6
    )
      errors = [skills[task.skill].error]
  }
  if (!task) reasons.push('family-and-skill-provenance-unknown')
  if (s.assistance !== 'reported-unaided') reasons.push('assisted-or-unknown')
  if (s.mode === 'practice') reasons.push('assisted-practice-not-demonstration')
  if (s.mode === 'delayed') reasons.push('device-clock-cannot-prove-delay')
  return {
    ...base(s.accountId, `${s.id}:eval:v1`, s.observedAt),
    kind: 'evaluation',
    submissionId: s.id,
    evaluator: EVALUATOR,
    supersedes: null,
    passed,
    errors,
    eligible: reasons.length === 0,
    reasons,
  }
}
export function attemptExposure(
  accountId: string,
  a: AttemptSnapshot,
): Exposure | null {
  const task = taskById.get(a.caseId)
  if (
    !task ||
    (!a.submittedAt &&
      !a.assistance.solutionViewed &&
      !a.assistance.hintIds.length)
  )
    return null
  const reason = a.assistance.solutionViewed
    ? 'solution'
    : a.assistance.hintIds.length
      ? 'hint'
      : 'submitted'
  return {
    ...base(
      accountId,
      `exposure:${a.id}:${reason}`,
      a.committedAt ?? a.createdAt,
    ),
    kind: 'exposure',
    family: task.family,
    sourceId: a.id,
    reason,
  }
}
export async function practiceEvidence(
  accountId: string,
  hand: HandRecord,
  practiceGeneration: number,
): Promise<Submission> {
  // Never copy cards, realized winnings or an opponent's private information into learner evidence.
  const summary = {
    graded: hand.graded === true,
    decisions: hand.decisions?.length ?? 0,
    modeled:
      hand.decisions?.filter(
        (d) => Number.isFinite(d.chosenEV) && Number.isFinite(d.bestEV),
      ).length ?? 0,
    practiceGeneration,
  }
  const revision = await digest(canonical(summary))
  return {
    ...base(
      accountId,
      `practice:${await digest(hand.id)}:${revision.slice(0, 16)}`,
      new Date(hand.at ?? 0).toISOString(),
    ),
    kind: 'submission',
    source: 'practice',
    sourceId: hand.id,
    sourceRevision: revision,
    family: null,
    context: 'poker',
    skills: [],
    mapping: MAPPING,
    clock: 'device-uncertain',
    assistance: hand.guided ? 'assisted' : 'unknown',
    mode: 'practice',
    attempt: null,
    practice: summary,
  }
}
export async function seal(event: LearningEvent) {
  return { event, digest: await digest(canonical(event)), receivedAt: null }
}
