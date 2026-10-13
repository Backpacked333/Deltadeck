import type {
  Answer,
  AttemptSnapshot,
  CaseRecord,
  Clock,
  EvidenceReceipt,
  LearningStoreV2,
  ReviewSchedule,
  StructuredEvaluation,
  UnitId,
} from './types'
import { numberIn } from './validation'

const day = 86400000
export const deviceClock: Clock = () => new Date()
export function evaluateCase(
  caseRecord: CaseRecord,
  attempt: AttemptSnapshot,
  history: readonly AttemptSnapshot[] = [],
  receipts: readonly EvidenceReceipt[] = [],
  schedule?: ReviewSchedule,
  clock: Clock = deviceClock,
  exposedVariants: readonly string[] = [],
): StructuredEvaluation {
  const components = caseRecord.questions.map((question) => {
    const answer: Answer | undefined = attempt.answers[question.id]
    let correct = false
    if (question.kind === 'numeric')
      correct =
        typeof answer === 'number' &&
        Number.isFinite(answer) &&
        Math.abs(answer - question.expected) <=
          question.tolerance +
            Number.EPSILON * Math.max(1, Math.abs(question.expected))
    else if (Array.isArray(question.expected))
      correct =
        Array.isArray(answer) &&
        answer.length === question.expected.length &&
        (question.kind === 'classification' ||
          new Set(answer).size === answer.length) &&
        answer.every((a, i) =>
          question.kind === 'choice'
            ? question.expected.includes(a)
            : a === question.expected[i],
        )
    else correct = answer === question.expected
    return {
      questionId: question.id,
      component: question.component,
      correct,
      earned: correct ? question.points : 0,
      max: question.points,
    }
  })
  const earned = components.reduce((sum, q) => sum + q.earned, 0)
  const max = components.reduce((sum, q) => sum + q.max, 0)
  const criticalFailures = caseRecord.questions
    .filter((q, i) => q.critical && !components[i].correct)
    .map((q) => q.id)
  const exposed =
    exposedVariants.includes(`${attempt.caseId}@${attempt.contentVersion}`) ||
    attempt.assistance.solutionViewed ||
    attempt.assistance.hintIds.length > 0 ||
    history.some(
      (a) =>
        a.id !== attempt.id &&
        a.caseId === attempt.caseId &&
        a.contentVersion === attempt.contentVersion &&
        (!!a.submittedAt ||
          a.assistance.solutionViewed ||
          a.assistance.hintIds.length > 0),
    ) ||
    receipts.some(
      (r) =>
        r.attemptId !== attempt.id &&
        r.caseId === attempt.caseId &&
        r.contentVersion === attempt.contentVersion,
    )
  const reasons: string[] = []
  if (exposed)
    reasons.push(
      'Assisted or previously revealed variant; choose a fresh variant for unaided evidence.',
    )
  if (!attempt.committedAt || !attempt.prediction?.rationale.trim())
    reasons.push(
      'Record a pre-outcome prediction and rationale first; prose is not scored.',
    )
  if (
    attempt.caseId !== caseRecord.id ||
    attempt.unitId !== caseRecord.unitId ||
    !Number.isFinite(Date.parse(attempt.createdAt)) ||
    !Number.isFinite(Date.parse(attempt.committedAt ?? '')) ||
    Date.parse(attempt.committedAt ?? '') < Date.parse(attempt.createdAt) ||
    Date.parse(attempt.committedAt ?? '') > clock().getTime()
  )
    reasons.push('Case identity or prediction timing is invalid.')
  if (
    attempt.contentVersion !== caseRecord.contentVersion ||
    attempt.rubricVersion !== caseRecord.rubricVersion
  )
    reasons.push('Content or rubric version changed.')
  if (!['transfer', 'review'].includes(attempt.mode))
    reasons.push('Practice/exploration does not establish demonstration.')
  if (
    attempt.mode === 'review' &&
    (!schedule || clock().getTime() < Date.parse(schedule.dueAt))
  )
    reasons.push('Early practice is not delayed review evidence.')
  const passed = max > 0 && earned / max >= 0.8 && criticalFailures.length === 0
  return {
    rubricVersion: caseRecord.rubricVersion,
    earned,
    max,
    criticalFailures,
    components,
    unaided: !exposed,
    passed,
    eligible: reasons.length === 0 && passed,
    reasons,
  }
}

export function recordEvidence(
  store: LearningStoreV2,
  attempt: AttemptSnapshot,
  clock: Clock = deviceClock,
): LearningStoreV2 {
  if (!attempt.unitId || !attempt.evaluation || !attempt.submittedAt)
    return store
  if (store.receipts.some((r) => r.attemptId === attempt.id)) return store
  const unitId = attempt.unitId
  const evaluation = attempt.evaluation
  const previous = store.reviewSchedule[unitId]
  const firstDemonstration =
    attempt.mode === 'transfer' &&
    evaluation.eligible &&
    !store.receipts.some((r) => r.unitId === unitId && r.firstDemonstration)
  const delayed =
    attempt.mode === 'review' &&
    !!previous &&
    clock().getTime() >= Date.parse(previous.dueAt)
  const receipt: EvidenceReceipt = {
    id: `receipt:${attempt.id}`,
    attemptId: attempt.id,
    unitId,
    caseId: attempt.caseId,
    contentVersion: attempt.contentVersion,
    rubricVersion: evaluation.rubricVersion,
    mode: attempt.mode,
    earned: evaluation.earned,
    max: evaluation.max,
    criticalPassed: !evaluation.criticalFailures.length,
    unaided: evaluation.unaided,
    eligible: evaluation.eligible,
    passed: evaluation.passed,
    createdAt: attempt.createdAt,
    submittedAt: attempt.submittedAt,
    firstDemonstration,
    delayed,
  }
  const now = clock().getTime()
  let schedule = previous
  if (attempt.mode === 'transfer' && evaluation.eligible && !previous)
    schedule = {
      dueAt: new Date(now + 3 * day).toISOString(),
      lastPassAt: attempt.submittedAt,
      streak: 0,
      passedVariants: [],
      firstDemonstrationAt: attempt.submittedAt,
    }
  // Only an unaided review is evidence about retention (audit F15). A
  // variant seen before, a hint or the solution makes it practice: it keeps
  // its receipt but moves no schedule, so a bank with no fresh variant left
  // cannot keep sending a learner back to a review that can only "fail".
  if (
    previous &&
    attempt.mode === 'review' &&
    evaluation.unaided &&
    (delayed || !evaluation.passed)
  ) {
    const newVariant = !previous.passedVariants.includes(attempt.caseId)
    const passes = delayed && evaluation.eligible && newVariant
    const streak = passes ? previous.streak + 1 : 0
    schedule = {
      ...previous,
      dueAt: new Date(
        now + (passes ? (streak === 1 ? 10 : 30) : 1) * day,
      ).toISOString(),
      streak,
      lastPassAt: passes ? attempt.submittedAt : previous.lastPassAt,
      passedVariants: passes
        ? [...previous.passedVariants, attempt.caseId]
        : [],
    }
  }
  return {
    ...store,
    receipts: [...store.receipts, receipt],
    reviewSchedule: {
      ...store.reviewSchedule,
      ...(schedule ? { [unitId]: schedule } : {}),
    },
  }
}
/**
 * The first case of `ids` this learner has never seen: no exposure, no
 * receipt, no submitted or assisted attempt. Undefined once the bank is
 * used up (audit F15): a review then has no fresh evidence to offer, which
 * is a shortage of content, not a failure of the learner.
 */
export function freshCase(
  store: LearningStoreV2,
  ids: readonly string[],
  contentVersionOf: (caseId: string) => number | undefined,
): string | undefined {
  return ids.find(
    (id) =>
      !store.exposedVariants.includes(`${id}@${contentVersionOf(id)}`) &&
      !store.receipts.some((r) => r.caseId === id) &&
      !store.attempts.some(
        (a) =>
          a.caseId === id &&
          (a.submittedAt ||
            a.assistance.solutionViewed ||
            a.assistance.hintIds.length),
      ),
  )
}
export type EvidenceState =
  | 'not-started'
  | 'practicing'
  | 'demonstrated'
  | 'review-due'
  | 'retained'
  | 'refresh-suggested'
export function evidenceState(
  store: LearningStoreV2,
  unitId: UnitId,
  contentVersion: number,
  rubricVersion: number,
  clock: Clock = deviceClock,
): EvidenceState {
  const receipts = store.receipts.filter((r) => r.unitId === unitId)
  const passes = receipts.filter(
    (r) => r.eligible && r.passed && r.mode === 'transfer',
  )
  const current = passes.some(
    (r) =>
      r.contentVersion === contentVersion && r.rubricVersion === rubricVersion,
  )
  if (!current && passes.length) return 'refresh-suggested'
  if (!current)
    return receipts.length ||
      store.attempts.some((a) => a.unitId === unitId) ||
      Object.values(store.drafts).some((d) => d.attempt.unitId === unitId)
      ? 'practicing'
      : 'not-started'
  const schedule = store.reviewSchedule[unitId]
  if (schedule && clock().getTime() >= Date.parse(schedule.dueAt))
    return 'review-due'
  const retainedVariants = new Set(
    receipts
      .filter(
        (r) =>
          r.mode === 'review' &&
          r.eligible &&
          r.delayed &&
          r.contentVersion === contentVersion &&
          r.rubricVersion === rubricVersion,
      )
      .map((r) => r.caseId),
  )
  return retainedVariants.size >= 2 && (schedule?.streak ?? 0) >= 2
    ? 'retained'
    : 'demonstrated'
}
export function backwardClock(store: LearningStoreV2, clock: Clock): boolean {
  return clock().getTime() < Date.parse(store.updatedAt) - 5 * 60000
}
export function validateCase(caseRecord: CaseRecord): string[] {
  const errors: string[] = []
  if (!caseRecord.questions.length)
    errors.push(`${caseRecord.id}: empty rubric`)
  if (
    new Set(caseRecord.questions.map((q) => q.id)).size !==
    caseRecord.questions.length
  )
    errors.push(`${caseRecord.id}: duplicate question IDs`)
  for (const q of caseRecord.questions) {
    if (
      !numberIn(q.points, 1, 100) ||
      !q.rationale ||
      q.hints.length !== 4 ||
      q.hints.some((h) => !h)
    )
      errors.push(`${caseRecord.id}/${q.id}: incomplete rubric/hints`)
    if (
      q.kind === 'numeric' &&
      (!Number.isFinite(q.expected) || !numberIn(q.tolerance, 0, 100))
    )
      errors.push(`${q.id}: invalid numeric answer`)
    if (q.kind === 'choice') {
      const allowed = q.options.map((o) => o.id)
      const expected =
        typeof q.expected === 'string' ? [q.expected] : q.expected
      if (
        expected.some((e) => !allowed.includes(e)) ||
        new Set(allowed).size !== allowed.length ||
        q.options.some((o) => !o.rationale)
      )
        errors.push(`${q.id}: invalid choices`)
    }
    if (
      q.kind === 'classification' &&
      (q.expected.length !== q.entries.length ||
        q.expected.some((e) => !q.categories.some((c) => c.id === e)))
    )
      errors.push(`${q.id}: invalid classifications`)
    if (
      q.kind === 'ordering' &&
      (q.expected.length !== q.options.length ||
        new Set(q.expected).size !== q.options.length ||
        q.expected.some((e) => !q.options.some((o) => o.id === e)))
    )
      errors.push(`${q.id}: invalid ordering`)
  }
  if (['transfer', 'review'].includes(caseRecord.mode)) {
    if (
      caseRecord.unitId === 'f10' &&
      (caseRecord.questions.length < 6 ||
        caseRecord.questions.filter((q) => q.critical).length < 2)
    )
      errors.push(
        `${caseRecord.id}: F10 requires at least six structured items and two critical items`,
      )
    if (
      new Set(caseRecord.questions.map((q) => q.component)).size !== 4 ||
      !caseRecord.questions.some((q) => q.critical)
    )
      errors.push(
        `${caseRecord.id}: transfer must cover all four rubric components and critical items`,
      )
  }
  return errors
}
