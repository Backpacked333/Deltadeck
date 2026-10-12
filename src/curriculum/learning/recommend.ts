import { base } from './evidence'
import { skills, tasks } from './content'
import {
  POLICY,
  PROJECTOR,
  skillIds,
  type Projection,
  type Recommendation,
  type SkillId,
  type StoredEvent,
} from './types'

export function recommend(
  projection: Projection,
  rows: readonly StoredEvent[],
  accountId: string,
  at: string,
  options: {
    goal?: SkillId
    pilot?: boolean
    serverNow?: number | null
    practiceGeneration?: number
  } = {},
): Recommendation {
  const feedback = rows
    .filter((r) => r.event.kind === 'feedback')
    .map((r) => r.event)
  const skipped = new Set(
    feedback.flatMap((e) =>
      e.kind === 'feedback' && e.response !== 'started'
        ? [e.recommendationId]
        : [],
    ),
  )
  const cooldown = new Set(
    rows.flatMap(({ event: e }) =>
      e.kind === 'recommendation' && skipped.has(e.id) && e.selected
        ? [e.selected]
        : [],
    ),
  )
  const skill =
    options.goal ??
    projection.skills.find((s) => s.retention === 'due')?.skill ??
    projection.skills.find((s) => s.hypothesis === 'supported')?.skill ??
    projection.skills.find((s) => s.stage === 'unknown')?.skill ??
    skillIds[0]
  const state = projection.skills.find((s) => s.skill === skill)!
  // Exposure survives grade invalidation: an invalid grade does not erase a viewed answer.
  const used = new Set(
    rows.flatMap(({ event: e }) =>
      e.kind === 'exposure'
        ? [e.family]
        : e.kind === 'submission' && e.family
          ? [e.family]
          : [],
    ),
  )
  const exclusions: Recommendation['exclusions'] = []
  const candidates = tasks
    .filter((t) => t.skill === skill)
    .filter((t) => {
      const reason = used.has(t.family)
        ? 'family-already-exposed'
        : cooldown.has(t.case.id)
          ? 'learner-declined'
          : t.holdout &&
              (!state.dueAt ||
                options.serverNow == null ||
                options.serverNow < Date.parse(state.dueAt))
            ? 'reserved-until-server-receipt-delay'
            : t.purpose === 'transfer' && !state.successes.length
              ? 'practice-prerequisite'
              : null
      if (reason) {
        exclusions.push({ id: t.case.id, reason })
        return false
      }
      return true
    })
  const completedIndependent = rows.some(
    ({ event: e }) =>
      e.kind === 'submission' &&
      e.mode === 'independent' &&
      state.successes.includes(e.id),
  )
  const completedWorked = tasks.some(
    (t) => t.skill === skill && t.purpose === 'worked' && used.has(t.family),
  )
  const completedFading = tasks.some(
    (t) => t.skill === skill && t.purpose === 'fading' && used.has(t.family),
  )
  const preferred =
    state.retention === 'due'
      ? 'delayed'
      : state.hypothesis === 'supported'
        ? 'worked'
        : state.errors.length && state.hypothesis === 'uncertain'
          ? 'diagnostic'
          : completedIndependent
            ? 'transfer'
            : !completedWorked
              ? 'worked'
              : !completedFading
                ? 'fading'
                : 'independent'
  const ranked = [...candidates].sort(
    (a, b) =>
      Number(b.purpose === preferred) - Number(a.purpose === preferred) ||
      tasks.indexOf(a) - tasks.indexOf(b),
  )
  const chosen = ranked[0]
  const waiting =
    !chosen &&
    exclusions.some((e) => e.reason === 'reserved-until-server-receipt-delay')
  return {
    ...base(accountId, '', at),
    kind: 'recommendation',
    practiceGeneration: options.practiceGeneration ?? 0,
    policy: POLICY,
    projector: PROJECTOR,
    cutoff: [
      ...projection.cutoff,
      ...rows
        .filter(
          ({ event: e }) =>
            e.kind === 'feedback' ||
            (e.kind === 'recommendation' && skipped.has(e.id)),
        )
        .map((r) => `${r.event.id}@${r.digest}`),
    ].sort(),
    skill,
    candidates: ranked.map((t) => t.case.id),
    exclusions,
    selected: chosen?.case.id ?? null,
    state: chosen ? 'ready' : waiting ? 'waiting-for-delay' : 'content-limited',
    evidence: [...state.errors, ...state.counterevidence].slice(0, 3),
    hypothesis: state.errors.length
      ? skills[skill].hypothesis
      : 'There is not enough independent evidence to diagnose a weakness. Start with a short optional exercise or keep the curriculum order.',
    mechanism:
      chosen?.purpose === 'worked'
        ? 'Separate the setup steps with a worked example, then remove the scaffolding.'
        : 'Commit a structured answer before seeing feedback; compare against the stated assumptions.',
    followup:
      'Use an unseen business family after practice, then a reserved new family at least seven days after account receipt. Device-clock completion remains qualified self-study, not verified retention.',
    effortMinutes: chosen?.minutes ?? 0,
    assistance:
      chosen && ['worked', 'fading'].includes(chosen.purpose)
        ? 'Assisted practice; no independent-learning claim'
        : 'Unaided self-report; hints exclude independent evidence',
    exposure: options.pilot ? 'limited-pilot' : 'shadow',
  }
}
