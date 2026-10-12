import { canonical } from '../../net/syncRevision'
import { evaluateSubmission, EVALUATOR } from './evidence'
import { taskById } from './content'
import { submission } from './evidence'
import { validEvent } from './validate'
import {
  DELAY_MS,
  MAPPING,
  PROJECTOR,
  skillIds,
  type Evaluation,
  type LearningEvent,
  type Projection,
  type StoredEvent,
  type Submission,
} from './types'

export function project(
  rows: readonly StoredEvent[],
  accountId: string,
  serverNow: number | null = null,
): Projection {
  const byId = new Map<string, StoredEvent>(),
    conflicts = new Set<string>()
  for (const row of rows.filter((r) => r.event.accountId === accountId)) {
    const eventId = row.event.id
    if (!validEvent(row.event)) {
      conflicts.add(eventId)
      continue
    }
    const old = byId.get(row.event.id)
    if (
      old &&
      (old.digest !== row.digest ||
        canonical(old.event) !== canonical(row.event))
    )
      conflicts.add(row.event.id)
    else if (
      !old ||
      (row.receivedAt && (!old.receivedAt || row.receivedAt < old.receivedAt))
    )
      byId.set(row.event.id, row)
  }
  const ordered = [...byId.values()].sort((a, b) =>
    a.event.id.localeCompare(b.event.id),
  )
  const invalid = new Set(
    ordered.flatMap(({ event: e }) =>
      e.kind === 'invalidation' ? [e.targetId] : [],
    ),
  )
  const events = ordered
    .map((r) => r.event)
    .filter((e) => !invalid.has(e.id) && !conflicts.has(e.id))
  const submissions = events
    .filter((e): e is Submission => e.kind === 'submission')
    .sort(
      (a, b) =>
        a.observedAt.localeCompare(b.observedAt) || a.id.localeCompare(b.id),
    )
  const evaluations = events.filter(
    (e): e is Evaluation => e.kind === 'evaluation',
  )
  const superseded = new Set(
    ordered.flatMap(({ event: e }) =>
      e.kind === 'evaluation' && e.supersedes ? [e.supersedes] : [],
    ),
  )
  const exposures = events.filter((e) => e.kind === 'exposure')
  const evaluated = submissions.map((s) => {
    const reasons: string[] = []
    const candidates = evaluations.filter((e) => e.submissionId === s.id)
    const heads = candidates.filter((e) => !superseded.has(e.id))
    let evaluation = heads.length === 1 ? heads[0] : null
    if (!evaluation)
      reasons.push(
        heads.length ? 'conflicting-evaluations' : 'missing-evaluation',
      )
    const visited = new Set<string>()
    for (
      let e = evaluation;
      e;
      e = e.supersedes
        ? (candidates.find((c) => c.id === e!.supersedes) ?? null)
        : null
    ) {
      if (
        visited.has(e.id) ||
        (e.supersedes && !candidates.some((c) => c.id === e!.supersedes))
      ) {
        reasons.push('invalid-evaluation-chain')
        break
      }
      visited.add(e.id)
    }
    if (evaluation) {
      const recomputed = evaluateSubmission(s)
      if (
        evaluation.evaluator !== EVALUATOR ||
        canonical([
          evaluation.passed,
          evaluation.errors,
          evaluation.eligible,
          evaluation.reasons,
        ]) !==
          canonical([
            recomputed.passed,
            recomputed.errors,
            recomputed.eligible,
            recomputed.reasons,
          ])
      ) {
        reasons.push('evaluation-does-not-match-versioned-rubric')
        evaluation = null
      } else reasons.push(...evaluation.reasons)
    }
    const task = s.attempt && taskById.get(s.attempt.caseId)
    if (
      s.attempt &&
      canonical(submission(accountId, s.attempt)) !== canonical(s)
    )
      reasons.push('source-metadata-mismatch')
    if (
      !task ||
      s.trust !== 'client-reported' ||
      s.clock !== 'device-uncertain' ||
      s.family !== task.family ||
      canonical(s.skills) !== canonical([task.skill]) ||
      s.mapping !== MAPPING
    )
      reasons.push('invalid-provenance')
    if (
      task &&
      s.attempt &&
      s.assistance !==
        (s.attempt.assistance.solutionViewed ||
        s.attempt.assistance.hintIds.length
          ? 'assisted'
          : 'reported-unaided')
    )
      reasons.push('assistance-mismatch')
    if (
      s.family &&
      submissions.some(
        (prior) =>
          prior !== s &&
          prior.family === s.family &&
          (prior.observedAt < s.observedAt ||
            (prior.observedAt === s.observedAt && prior.id < s.id)),
      )
    )
      reasons.push('repeated-family')
    if (
      exposures.some(
        (e) =>
          e.family === s.family &&
          e.sourceId !== s.sourceId &&
          e.observedAt <= s.observedAt,
      )
    )
      reasons.push('exposed-family')
    return { s, evaluation, reasons: [...new Set(reasons)] }
  })
  return {
    version: PROJECTOR,
    mapping: MAPPING,
    cutoff: ordered
      .filter(
        ({ event: e }) => e.kind !== 'recommendation' && e.kind !== 'feedback',
      )
      .map((r) => `${r.event.id}@${r.digest}`),
    conflicts: [...conflicts].sort(),
    skills: skillIds.map((skill) => {
      const all = evaluated.filter(({ s }) => s.skills.includes(skill))
      const eligible = all.filter((e) => !e.reasons.length)
      const passes = eligible.filter((e) => e.evaluation?.passed)
      const failures = eligible.filter((e) => e.evaluation?.passed === false)
      const contexts = [...new Set(eligible.map((e) => e.s.context))].sort()
      const independent = passes.filter((e) =>
        ['independent', 'diagnostic'].includes(e.s.mode),
      )
      const transfer = passes.filter(
        (e) => e.s.mode === 'transfer' && e.s.context === 'business',
      )
      const transferred =
        independent.length > 0 &&
        transfer.length > 0 &&
        new Set(passes.map((e) => e.s.context)).size > 1
      const anchors = transfer
        .map((e) => byId.get(e.s.id)?.receivedAt)
        .filter((x): x is string => !!x)
        .sort()
      const dueAt =
        transferred && anchors[0]
          ? new Date(Date.parse(anchors[0]) + DELAY_MS).toISOString()
          : null
      const latestFailure = eligible.at(-1)?.evaluation?.passed === false
      return {
        skill,
        stage:
          transferred && !latestFailure
            ? 'transferred'
            : passes.length >= 2 && contexts.length >= 2 && !latestFailure
              ? 'independent'
              : passes.length || all.some((e) => e.s.mode === 'practice')
                ? 'practiced'
                : all.length
                  ? 'observed'
                  : 'unknown',
        eligible: eligible.map((e) => e.s.id),
        excluded: all
          .filter((e) => e.reasons.length)
          .map((e) => ({ id: e.s.id, reasons: e.reasons })),
        families: [...new Set(eligible.map((e) => e.s.family!))].sort(),
        contexts,
        successes: passes.map((e) => e.s.id),
        errors: failures.map((e) => e.s.id),
        hypothesis:
          failures.filter((e) => e.evaluation?.errors.length).length >= 2 &&
          new Set(
            failures
              .filter((e) => e.evaluation?.errors.length)
              .map((e) => e.s.context),
          ).size >= 2
            ? passes.length
              ? 'contested'
              : 'supported'
            : 'uncertain',
        counterevidence: passes.map((e) => e.s.id),
        retention: all.some((e) => e.s.mode === 'delayed')
          ? 'device-clock-only'
          : dueAt && serverNow !== null && serverNow >= Date.parse(dueAt)
            ? 'due'
            : 'unknown',
        dueAt,
      }
    }),
  }
}
export function activeEvents(rows: readonly StoredEvent[]): LearningEvent[] {
  const invalid = new Set(
    rows.flatMap(({ event: e }) =>
      e.kind === 'invalidation' ? [e.targetId] : [],
    ),
  )
  return rows.map((r) => r.event).filter((e) => !invalid.has(e.id))
}
