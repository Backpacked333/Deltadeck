import { decodeAttempt } from '../core/persistence'
import {
  MAPPING,
  POLICY,
  PROJECTOR,
  skillIds,
  type LearningEvent,
} from './types'

const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 2000
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(str)
export function validEvent(v: unknown): v is LearningEvent {
  if (
    !object(v) ||
    v.schema !== 1 ||
    !str(v.id) ||
    v.id.length > 120 ||
    !str(v.accountId) ||
    v.trust !== 'client-reported' ||
    !str(v.observedAt) ||
    !Number.isFinite(Date.parse(v.observedAt))
  )
    return false
  switch (v.kind) {
    case 'submission':
      return (
        ['curriculum', 'practice'].includes(String(v.source)) &&
        str(v.sourceId) &&
        str(v.sourceRevision) &&
        (v.family === null || str(v.family)) &&
        str(v.context) &&
        Array.isArray(v.skills) &&
        v.skills.every((s) => skillIds.includes(s)) &&
        v.mapping === MAPPING &&
        v.clock === 'device-uncertain' &&
        ['assisted', 'reported-unaided', 'unknown'].includes(
          String(v.assistance),
        ) &&
        [
          'practice',
          'diagnostic',
          'independent',
          'transfer',
          'delayed',
        ].includes(String(v.mode)) &&
        (v.source === 'curriculum'
          ? decodeAttempt(v.attempt).ok && v.practice === null
          : v.attempt === null &&
            object(v.practice) &&
            typeof v.practice.graded === 'boolean' &&
            ['decisions', 'modeled', 'practiceGeneration'].every(
              (key) =>
                Number.isSafeInteger(
                  v.practice && (v.practice as Record<string, unknown>)[key],
                ) && Number((v.practice as Record<string, unknown>)[key]) >= 0,
            ))
      )
    case 'evaluation':
      return (
        str(v.submissionId) &&
        str(v.evaluator) &&
        (v.supersedes === null || str(v.supersedes)) &&
        (v.passed === null || typeof v.passed === 'boolean') &&
        typeof v.eligible === 'boolean' &&
        strings(v.errors) &&
        strings(v.reasons)
      )
    case 'invalidation':
      return str(v.targetId) && str(v.reason)
    case 'exposure':
      return (
        str(v.family) &&
        str(v.sourceId) &&
        ['preview', 'hint', 'solution', 'submitted'].includes(String(v.reason))
      )
    case 'feedback':
      return (
        str(v.recommendationId) &&
        ['does-not-fit', 'other-focus', 'started'].includes(String(v.response))
      )
    case 'recommendation':
      return (
        v.policy === POLICY &&
        v.projector === PROJECTOR &&
        skillIds.includes(v.skill as never) &&
        strings(v.cutoff) &&
        strings(v.candidates) &&
        Array.isArray(v.exclusions) &&
        v.exclusions.every((e) => object(e) && str(e.id) && str(e.reason)) &&
        (v.selected === null || str(v.selected)) &&
        ['ready', 'content-limited', 'waiting-for-delay'].includes(
          String(v.state),
        ) &&
        strings(v.evidence) &&
        str(v.hypothesis) &&
        str(v.mechanism) &&
        str(v.followup) &&
        str(v.assistance) &&
        Number.isFinite(v.effortMinutes) &&
        ['shadow', 'limited-pilot'].includes(String(v.exposure))
      )
    default:
      return false
  }
}
