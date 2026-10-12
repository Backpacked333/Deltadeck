import type { ComponentType } from 'react'
import type { LearningSession } from './session'

export const legacyIds = [
  'odds',
  'outs',
  'equity',
  'pricing',
  'fold',
  'variance',
  'replication',
  'risk',
] as const
export const unitIds = [
  'f01',
  'f02',
  'f03',
  'f04',
  'f05',
  'f06',
  'f07',
  'f08',
  'f09',
  'f10',
] as const
export const experienceIds = [
  'calibration',
  'selection',
  'information',
  'contracts',
  'solvency',
  'backtest',
] as const
export const pathwayIds = [
  'inference-strategy',
  'risk-insurance-credit',
  'derivatives-hedging',
  'markets-research',
] as const
export const unitSteps = [
  'brief',
  'predict',
  'worked',
  'practice',
  'experiment',
  'transfer',
  'review',
] as const
export type LegacyModuleId = (typeof legacyIds)[number]
export type UnitId = (typeof unitIds)[number]
export type ExperienceId = (typeof experienceIds)[number]
export type PathwayId = (typeof pathwayIds)[number]
export type UnitStep = (typeof unitSteps)[number]
export type ConnectionKind = 'direct' | 'added-contract' | 'separate-finance'
export type Availability = 'available' | 'partial' | 'planned'
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }
export interface FieldError {
  field: string
  code: string
  message: string
}
export interface ModelWarning {
  code: string
  message: string
}
export type ModelResult<T> =
  | { ok: true; value: T; warnings: readonly ModelWarning[] }
  | { ok: false; errors: readonly FieldError[] }
export type Decoder<T> = (value: unknown) => ModelResult<T>
export interface EvidenceReference {
  sourceId: string
  claim: string
  locator?: string
  verification: 'pending' | 'checked' | 'unavailable'
  checkedAt?: string
}
export interface SourceRecord {
  id: string
  title: string
  url: string
  references: readonly EvidenceReference[]
  originalExamples: string
}
export interface Prediction {
  actionId?: string
  numericEstimate?: number
  direction?: 'increase' | 'decrease' | 'unchanged' | 'not-sure'
  confidencePercent: number | null
  rationale: string
}
export type Answer = string | number | string[]
export type RubricComponent =
  | 'setup'
  | 'calculation'
  | 'interpretation'
  | 'limitation'
export interface QuestionBase {
  id: string
  prompt: string
  component: RubricComponent
  points: number
  critical: boolean
  rationale: string
  hints: readonly [string, string, string, string]
}
export type Question = QuestionBase &
  (
    | { kind: 'numeric'; expected: number; tolerance: number; units: string }
    | {
        kind: 'choice'
        options: readonly { id: string; label: string; rationale: string }[]
        expected: string | readonly string[]
      }
    | {
        kind: 'ordering'
        options: readonly { id: string; label: string }[]
        expected: readonly string[]
      }
    | {
        kind: 'classification'
        entries: readonly { id: string; label: string }[]
        categories: readonly { id: string; label: string }[]
        expected: readonly string[]
      }
  )
export interface CaseRecord {
  id: string
  familyId?: string
  unitId: UnitId
  contentVersion: number
  rubricVersion: number
  title: string
  role: string
  objective: string
  information: readonly string[]
  states: readonly string[]
  actions: readonly string[]
  responses: string
  cashFlows: string
  constraints: string
  assumptions: readonly string[]
  connection: ConnectionKind
  mode: 'worked' | 'partial' | 'practice' | 'transfer' | 'review'
  questions: readonly Question[]
  scaffold?: readonly string[]
  workedSolution: readonly string[]
  reflectionPrompt: string
  decisionReversal: string
  sources: readonly EvidenceReference[]
}
export interface ComponentScore {
  questionId: string
  component: RubricComponent
  earned: number
  max: number
  correct: boolean
}
export interface StructuredEvaluation {
  rubricVersion: number
  earned: number
  max: number
  criticalFailures: string[]
  components: ComponentScore[]
  unaided: boolean
  passed: boolean
  eligible: boolean
  reasons: string[]
}
export type ExperimentPhase =
  | 'draft'
  | 'prediction_committed'
  | 'running'
  | 'results_ready'
  | 'reflected'
  | 'archived'
export interface AttemptSnapshot {
  id: string
  unitId?: UnitId
  experienceId?: ExperienceId
  caseId: string
  contentVersion: number
  rubricVersion: number
  modelVersion: string
  inputVersion?: number
  generatorVersion?: string
  seed?: number
  mode: 'explore' | 'practice' | 'transfer' | 'review'
  createdAt: string
  committedAt?: string
  submittedAt?: string
  inputs: JsonValue
  prediction?: Prediction
  answers: Record<string, Answer>
  assistance: { hintIds: string[]; solutionViewed: boolean }
  resultSummary?: JsonValue
  evaluation?: StructuredEvaluation
  reflection?: string
  parentAttemptId?: string
  phase: ExperimentPhase
  parameterHash?: string
  searchSummary?: JsonObject
}
export interface EvidenceReceipt {
  id: string
  attemptId: string
  unitId: UnitId
  caseId: string
  contentVersion: number
  rubricVersion: number
  mode: AttemptSnapshot['mode']
  earned: number
  max: number
  criticalPassed: boolean
  unaided: boolean
  eligible: boolean
  passed: boolean
  createdAt: string
  submittedAt: string
  firstDemonstration: boolean
  delayed: boolean
}
export interface ReviewSchedule {
  dueAt: string
  lastPassAt: string
  streak: number
  passedVariants: string[]
  firstDemonstrationAt: string
}
export interface DraftSnapshot {
  attempt: AttemptSnapshot
  protocol: JsonObject
}
export interface LearningStoreV2 {
  version: 2
  revision: number
  updatedAt: string
  migration: { fromV1: boolean; migratedAt?: string }
  legacy: {
    completed: LegacyModuleId[]
    notes: Partial<Record<LegacyModuleId, string>>
  }
  unitNotes: Partial<Record<UnitId, string>>
  attempts: AttemptSnapshot[]
  receipts: EvidenceReceipt[]
  reviewSchedule: Partial<Record<UnitId, ReviewSchedule>>
  drafts: Record<string, DraftSnapshot>
  exposedVariants: string[]
  settings: {
    preferredDepth: 'intuition' | 'quantitative'
    reduceAnimation: boolean
  }
}
export interface LessonCopy {
  brief: readonly string[]
  retrieval: Question
  predictionQuestion: string
  worked: readonly string[]
  practice: readonly string[]
  experiment: {
    question: string
    instructions: readonly string[]
    legacyId?: LegacyModuleId
    experienceId?: ExperienceId
  }
  transfer: readonly string[]
  review: readonly string[]
  limitation: string
  decisionReversal: string
}
export interface FoundationUnit {
  id: UnitId
  contentVersion: number
  rubricVersion: number
  title: string
  question: string
  objectives: readonly string[]
  prerequisites: readonly UnitId[]
  conceptIds: readonly string[]
  steps: readonly UnitStep[]
  legacyResources: readonly LegacyModuleId[]
  experiences: readonly ExperienceId[]
  workedCaseIds: readonly string[]
  practiceCaseIds: readonly string[]
  transferCaseIds: readonly string[]
  reviewCaseIds: readonly string[]
  sources: readonly EvidenceReference[]
  availability: Availability
  lesson: LessonCopy | null
  fragmentSlots: readonly FragmentSlot[]
}
export interface FragmentSlot {
  id: string
  unitId: UnitId
  owner: 'A01' | 'A02' | 'A03' | 'A04' | 'A05' | 'A06' | 'A07'
  purpose: string
  minTransfer: number
  minReview: number
  requiredTopics: readonly string[]
}
export interface CaseFragment {
  slotId: string
  unitId: UnitId
  cases: readonly CaseRecord[]
  lesson?: LessonCopy
  sources: readonly EvidenceReference[]
}
export interface RunIdentity {
  runId: string
  parameterHash: string
  generatorVersion: string
}
export interface RunContext extends RunIdentity {
  signal: AbortSignal
  seed: number
  onProgress: (completed: number, total: number) => void
}
export type RunExecutor<I, O> = (
  inputs: Readonly<I>,
  context: RunContext,
) => ModelResult<O> | Promise<ModelResult<O>>
export interface ExperimentController<I, O> {
  readonly mode: 'explore' | 'assess'
  readonly phase: ExperimentPhase
  readonly inputs: Readonly<I>
  readonly result: ModelResult<O> | null
  readonly attempt: Readonly<AttemptSnapshot>
  readonly protocolState: Readonly<JsonObject>
  readonly status: string
  readonly progress: number | null
  requestInputChange(next: I): void
  commitPrediction(prediction: Prediction): void
  run(): Promise<void>
  runWith(executor: RunExecutor<I, O>): Promise<void>
  cancel(): void
  reflect(text: string): void
  archive(): void
  resetControls(): void
  saveProtocolState(next: JsonObject, searchSummary?: JsonObject): void
  recordSearchSummary(summary: JsonObject): void
  subscribe(listener: () => void): () => void
  getRevision(): number
  submitAssessment(
    caseRecord: CaseRecord,
    answers: Record<string, Answer>,
  ): StructuredEvaluation
}
export interface EvidenceCallbacks {
  recordAttempt(attempt: AttemptSnapshot): void
  exposeHint(attemptId: string, hintId: string): void
  exposeSolution(attemptId: string): void
}
export interface ExperienceViewProps<I, O> {
  controller: ExperimentController<I, O>
  evidence: EvidenceCallbacks
}
export interface ExperienceManifest<I, O> {
  id: ExperienceId
  title: string
  version: string
  inputVersion: number
  conceptIds: readonly string[]
  unitIds: readonly UnitId[]
  defaultInputs: Readonly<I>
  decodeInputs: Decoder<I>
  model: (inputs: Readonly<I>) => ModelResult<O>
  encodeInputs: (inputs: Readonly<I>) => JsonValue
  encodeResult: (output: O) => JsonValue
  decodeResult: Decoder<O>
  loadView: () => Promise<{ default: ComponentType<ExperienceViewProps<I, O>> }>
  cases: readonly CaseFragment[]
  sources: readonly SourceRecord[]
  assumptions: readonly string[]
  limitations: readonly string[]
  controls: string
  probabilityInterpretation: string
}
export interface ExperienceEntryProps {
  session: LearningSession
}
export interface ExperienceRegistration {
  id: ExperienceId
  title: string
  version: string
  passedGate: boolean
  load: () => Promise<{ default: ComponentType<ExperienceEntryProps> }>
}
export type Clock = () => Date
