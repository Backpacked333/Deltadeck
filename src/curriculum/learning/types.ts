import type { AttemptSnapshot } from '../core/types'

export const POLICY = 'targeted-practice.v1'
export const PROJECTOR = 'learning-projection.v1'
export const MAPPING = 'three-skills.v1'
export const DELAY_MS = 7 * 86400000
export const skillIds = ['incremental', 'conditioning', 'thresholds'] as const
export type SkillId = (typeof skillIds)[number]
export type Stage =
  | 'unknown'
  | 'observed'
  | 'practiced'
  | 'independent'
  | 'transferred'
  | 'retained'
export type Trust = 'client-reported'
export interface Base {
  schema: 1
  id: string
  accountId: string
  observedAt: string
  trust: Trust
}
export interface Submission extends Base {
  kind: 'submission'
  source: 'curriculum' | 'practice'
  sourceId: string
  sourceRevision: string
  family: string | null
  context: string
  skills: SkillId[]
  mapping: typeof MAPPING
  clock: 'device-uncertain'
  assistance: 'assisted' | 'reported-unaided' | 'unknown'
  mode: 'practice' | 'diagnostic' | 'independent' | 'transfer' | 'delayed'
  attempt: AttemptSnapshot | null
  practice: {
    graded: boolean
    decisions: number
    modeled: number
    practiceGeneration: number
  } | null
}
export interface Evaluation extends Base {
  kind: 'evaluation'
  submissionId: string
  evaluator: string
  supersedes: string | null
  passed: boolean | null
  errors: string[]
  eligible: boolean
  reasons: string[]
}
export interface Exposure extends Base {
  kind: 'exposure'
  family: string
  sourceId: string
  reason: 'preview' | 'hint' | 'solution' | 'submitted'
}
export interface Invalidation extends Base {
  kind: 'invalidation'
  targetId: string
  reason: string
}
export interface Recommendation extends Base {
  practiceGeneration: number
  kind: 'recommendation'
  policy: typeof POLICY
  projector: typeof PROJECTOR
  cutoff: string[]
  skill: SkillId
  candidates: string[]
  exclusions: { id: string; reason: string }[]
  selected: string | null
  state: 'ready' | 'content-limited' | 'waiting-for-delay'
  evidence: string[]
  hypothesis: string
  mechanism: string
  followup: string
  effortMinutes: number
  assistance: string
  exposure: 'shadow' | 'limited-pilot'
}
export interface Feedback extends Base {
  kind: 'feedback'
  recommendationId: string
  response: 'does-not-fit' | 'other-focus' | 'started'
}
export type LearningEvent =
  | Submission
  | Evaluation
  | Exposure
  | Invalidation
  | Recommendation
  | Feedback
export interface StoredEvent {
  event: LearningEvent
  digest: string
  receivedAt: string | null
}
export interface SkillProjection {
  skill: SkillId
  stage: Stage
  eligible: string[]
  excluded: { id: string; reasons: string[] }[]
  families: string[]
  contexts: string[]
  successes: string[]
  errors: string[]
  hypothesis: 'uncertain' | 'supported' | 'contested'
  counterevidence: string[]
  retention: 'unknown' | 'due' | 'device-clock-only'
  dueAt: string | null
}
export interface Projection {
  version: typeof PROJECTOR
  mapping: typeof MAPPING
  cutoff: string[]
  conflicts: string[]
  skills: SkillProjection[]
}
