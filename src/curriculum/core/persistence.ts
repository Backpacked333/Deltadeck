import { parseProgress, STORAGE_KEY as LEGACY_KEY } from '../lib/progress'
import {
  decodePrediction,
  failure,
  isRecord,
  isSafeJson,
  numberIn,
  safeClone,
  success,
} from './validation'
import {
  experienceIds,
  legacyIds,
  unitIds,
  type AttemptSnapshot,
  type Clock,
  type EvidenceReceipt,
  type LearningStoreV2,
  type ModelResult,
} from './types'
import { deviceClock } from './assessment'

export const LEARNING_KEY = 'quantpoker.learning.v2'
/**
 * When this browser last reset its curriculum (ISO). The account keeps the
 * latest reset of any device, and a merge drops work from before it, so a
 * device that missed the reset cannot bring the old work back (audit F09).
 */
export const LEARNING_RESET_KEY = 'quantpoker.learning.v2.resetAt'
export const LEARNING_V1_KEY = LEGACY_KEY
export const LIMITS = {
  note: 10000,
  reflection: 2000,
  attempts: 200,
  drafts: 20,
  bytes: 1048576,
  receiptsPerUnit: 12,
} as const
export interface StoragePort {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}
export function emptyStore(clock: Clock = deviceClock): LearningStoreV2 {
  return {
    version: 2,
    revision: 0,
    updatedAt: clock().toISOString(),
    migration: { fromV1: false },
    legacy: { completed: [], notes: {} },
    unitNotes: {},
    attempts: [],
    receipts: [],
    reviewSchedule: {},
    drafts: {},
    exposedVariants: [],
    settings: { preferredDepth: 'intuition', reduceAnimation: false },
  }
}
const iso = (v: unknown): v is string =>
  typeof v === 'string' &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v
const short = (v: unknown, max = 2000): v is string =>
  typeof v === 'string' && v.length <= max
const list = (v: unknown, ids: readonly string[]): v is string[] =>
  Array.isArray(v) &&
  new Set(v).size === v.length &&
  v.every((x) => typeof x === 'string' && ids.includes(x))
function keys(v: Record<string, unknown>, allowed: readonly string[]) {
  return Object.keys(v).every((k) => allowed.includes(k))
}
function notes(v: unknown, ids: readonly string[]) {
  return (
    isRecord(v) &&
    Object.entries(v).every(
      ([k, n]) => ids.includes(k) && short(n, LIMITS.note),
    )
  )
}
function validEvaluation(v: unknown): boolean {
  if (
    !isRecord(v) ||
    !keys(v, [
      'rubricVersion',
      'earned',
      'max',
      'criticalFailures',
      'components',
      'unaided',
      'passed',
      'eligible',
      'reasons',
    ])
  )
    return false
  if (
    !numberIn(v.rubricVersion, 1, 100000, true) ||
    !numberIn(v.max, 1, 10000) ||
    !numberIn(v.earned, 0, v.max) ||
    !Array.isArray(v.criticalFailures) ||
    !v.criticalFailures.every((x) => short(x, 100)) ||
    !Array.isArray(v.reasons) ||
    !v.reasons.every((x) => short(x))
  )
    return false
  if (
    !['unaided', 'passed', 'eligible'].every(
      (k) => typeof v[k] === 'boolean',
    ) ||
    !Array.isArray(v.components)
  )
    return false
  return v.components.every(
    (c) =>
      isRecord(c) &&
      keys(c, ['questionId', 'component', 'earned', 'max', 'correct']) &&
      short(c.questionId, 100) &&
      ['setup', 'calculation', 'interpretation', 'limitation'].includes(
        String(c.component),
      ) &&
      numberIn(c.max, 1, 100) &&
      numberIn(c.earned, 0, c.max) &&
      typeof c.correct === 'boolean',
  )
}
export function decodeAttempt(value: unknown): ModelResult<AttemptSnapshot> {
  if (
    !isRecord(value) ||
    !isSafeJson(value) ||
    !keys(value, [
      'id',
      'unitId',
      'experienceId',
      'caseId',
      'contentVersion',
      'rubricVersion',
      'modelVersion',
      'inputVersion',
      'generatorVersion',
      'seed',
      'mode',
      'createdAt',
      'committedAt',
      'submittedAt',
      'inputs',
      'prediction',
      'answers',
      'assistance',
      'resultSummary',
      'evaluation',
      'reflection',
      'parentAttemptId',
      'phase',
      'parameterHash',
      'searchSummary',
    ])
  )
    return failure('attempt', 'Invalid attempt schema.')
  const v = value
  if (
    !short(v.id, 100) ||
    !short(v.caseId, 100) ||
    !short(v.modelVersion, 100) ||
    !numberIn(v.contentVersion, 1, 100000, true) ||
    !numberIn(v.rubricVersion, 1, 100000, true) ||
    (v.inputVersion !== undefined &&
      !numberIn(v.inputVersion, 1, 100000, true)) ||
    !iso(v.createdAt) ||
    !['explore', 'practice', 'transfer', 'review'].includes(String(v.mode)) ||
    ![
      'draft',
      'prediction_committed',
      'running',
      'results_ready',
      'reflected',
      'archived',
    ].includes(String(v.phase))
  )
    return failure('attempt', 'Invalid attempt identity/version/time.')
  if (
    (v.unitId !== undefined && !unitIds.includes(v.unitId as never)) ||
    (v.experienceId !== undefined &&
      !experienceIds.includes(v.experienceId as never)) ||
    (v.seed !== undefined && !numberIn(v.seed, 0, 0xffffffff, true)) ||
    (v.generatorVersion !== undefined && !short(v.generatorVersion, 100))
  )
    return failure('attempt', 'Unknown unit, experience, or seed.')
  if (
    ['committedAt', 'submittedAt'].some(
      (k) => v[k] !== undefined && !iso(v[k]),
    ) ||
    (v.reflection !== undefined && !short(v.reflection)) ||
    (v.parentAttemptId !== undefined && !short(v.parentAttemptId, 100)) ||
    (v.parameterHash !== undefined && !short(v.parameterHash, 100))
  )
    return failure('attempt', 'Invalid bounded text/time.')
  if (
    !isRecord(v.answers) ||
    Object.entries(v.answers).some(
      ([k, a]) =>
        !short(k, 100) ||
        !(
          short(a, 2000) ||
          (typeof a === 'number' && Number.isFinite(a)) ||
          (Array.isArray(a) && a.length <= 100 && a.every((x) => short(x, 100)))
        ),
    )
  )
    return failure('answers', 'Invalid structured answers.')
  if (
    !isRecord(v.assistance) ||
    !keys(v.assistance, ['hintIds', 'solutionViewed']) ||
    !Array.isArray(v.assistance.hintIds) ||
    v.assistance.hintIds.length > 100 ||
    !v.assistance.hintIds.every((x) => short(x, 100)) ||
    typeof v.assistance.solutionViewed !== 'boolean'
  )
    return failure('assistance', 'Invalid assistance record.')
  if (v.prediction !== undefined && !decodePrediction(v.prediction).ok)
    return failure('prediction', 'Invalid prediction.')
  if (v.evaluation !== undefined && !validEvaluation(v.evaluation))
    return failure('evaluation', 'Invalid evaluation.')
  if (
    v.inputs === undefined ||
    (v.searchSummary !== undefined && !isRecord(v.searchSummary))
  )
    return failure('inputs', 'Missing input or invalid search summary.')
  return success(safeClone(v) as unknown as AttemptSnapshot)
}
function validReceipt(r: unknown): r is EvidenceReceipt {
  return (
    isRecord(r) &&
    keys(r, [
      'id',
      'attemptId',
      'unitId',
      'caseId',
      'contentVersion',
      'rubricVersion',
      'mode',
      'earned',
      'max',
      'criticalPassed',
      'unaided',
      'eligible',
      'passed',
      'createdAt',
      'submittedAt',
      'firstDemonstration',
      'delayed',
    ]) &&
    ['id', 'attemptId', 'caseId'].every((k) => short(r[k], 100)) &&
    unitIds.includes(r.unitId as never) &&
    ['explore', 'practice', 'transfer', 'review'].includes(String(r.mode)) &&
    ['contentVersion', 'rubricVersion'].every((k) =>
      numberIn(r[k], 1, 100000, true),
    ) &&
    numberIn(r.max, 1, 10000) &&
    numberIn(r.earned, 0, r.max) &&
    [
      'criticalPassed',
      'unaided',
      'eligible',
      'passed',
      'firstDemonstration',
      'delayed',
    ].every((k) => typeof r[k] === 'boolean') &&
    iso(r.createdAt) &&
    iso(r.submittedAt)
  )
}
export function decodeStore(value: unknown): ModelResult<LearningStoreV2> {
  if (
    !isRecord(value) ||
    !isSafeJson(value) ||
    !keys(value, [
      'version',
      'revision',
      'updatedAt',
      'migration',
      'legacy',
      'unitNotes',
      'attempts',
      'receipts',
      'reviewSchedule',
      'drafts',
      'exposedVariants',
      'settings',
    ]) ||
    value.version !== 2 ||
    !numberIn(value.revision, 0, Number.MAX_SAFE_INTEGER, true) ||
    !iso(value.updatedAt)
  )
    return failure(
      'store',
      'Malformed or unsupported learning data. Original data has not been overwritten.',
    )
  const v = value
  if (
    !Array.isArray(v.exposedVariants) ||
    v.exposedVariants.length > 1000 ||
    new Set(v.exposedVariants).size !== v.exposedVariants.length ||
    !v.exposedVariants.every((x) => short(x, 220))
  )
    return failure('evidence', 'Invalid exposure receipts.')
  if (
    !isRecord(v.migration) ||
    !keys(v.migration, ['fromV1', 'migratedAt']) ||
    typeof v.migration.fromV1 !== 'boolean' ||
    (v.migration.migratedAt !== undefined && !iso(v.migration.migratedAt))
  )
    return failure('migration', 'Invalid migration metadata.')
  if (
    !isRecord(v.legacy) ||
    !keys(v.legacy, ['completed', 'notes']) ||
    !list(v.legacy.completed, legacyIds) ||
    !notes(v.legacy.notes, legacyIds) ||
    !notes(v.unitNotes, unitIds)
  )
    return failure('notes', 'Invalid notes/core IDs.')
  if (
    !Array.isArray(v.attempts) ||
    !v.attempts.every((a) => decodeAttempt(a).ok) ||
    new Set(v.attempts.map((a) => (isRecord(a) ? a.id : null))).size !==
      v.attempts.length ||
    !Array.isArray(v.receipts) ||
    !v.receipts.every(validReceipt) ||
    new Set(v.receipts.map((r) => (isRecord(r) ? r.id : null))).size !==
      v.receipts.length
  )
    return failure('evidence', 'Invalid attempts or receipts.')
  if (
    !isRecord(v.drafts) ||
    !Object.entries(v.drafts).every(
      ([id, d]) =>
        short(id, 100) &&
        isRecord(d) &&
        keys(d, ['attempt', 'protocol']) &&
        decodeAttempt(d.attempt).ok &&
        isRecord(d.protocol),
    )
  )
    return failure('drafts', 'Invalid draft/protocol data.')
  if (
    !isRecord(v.reviewSchedule) ||
    !Object.entries(v.reviewSchedule).every(
      ([id, s]) =>
        unitIds.includes(id as never) &&
        isRecord(s) &&
        keys(s, [
          'dueAt',
          'lastPassAt',
          'streak',
          'passedVariants',
          'firstDemonstrationAt',
        ]) &&
        iso(s.dueAt) &&
        iso(s.lastPassAt) &&
        iso(s.firstDemonstrationAt) &&
        numberIn(s.streak, 0, 100000, true) &&
        Array.isArray(s.passedVariants) &&
        s.passedVariants.length <= 100 &&
        s.passedVariants.every((x) => short(x, 100)),
    )
  )
    return failure('reviews', 'Invalid review schedule.')
  if (
    !isRecord(v.settings) ||
    !keys(v.settings, ['preferredDepth', 'reduceAnimation']) ||
    !['intuition', 'quantitative'].includes(
      String(v.settings.preferredDepth),
    ) ||
    typeof v.settings.reduceAnimation !== 'boolean'
  )
    return failure('settings', 'Invalid preferences.')
  return success(safeClone(v) as unknown as LearningStoreV2)
}
export function serializedBytes(store: LearningStoreV2) {
  return new TextEncoder().encode(JSON.stringify(store)).byteLength
}
export function compactStore(store: LearningStoreV2): LearningStoreV2 {
  const next = safeClone(store)
  next.receipts = unitIds.flatMap((id) => {
    const rows = next.receipts.filter((r) => r.unitId === id)
    const first = rows.find((r) => r.firstDemonstration)
    const retained = rows.slice(-LIMITS.receiptsPerUnit)
    return first && !retained.includes(first) ? [first, ...retained] : retained
  })
  while (
    next.attempts.length > LIMITS.attempts ||
    serializedBytes(next) > LIMITS.bytes
  ) {
    const index = next.attempts.findIndex(
      (a) =>
        a.phase === 'archived' &&
        !Object.values(next.drafts).some((d) => d.attempt.id === a.id) &&
        (!a.evaluation ||
          next.exposedVariants.includes(`${a.caseId}@${a.contentVersion}`)) &&
        (!a.searchSummary ||
          next.attempts.some(
            (other) =>
              other.id !== a.id &&
              other.phase === 'archived' &&
              other.experienceId === a.experienceId &&
              !!other.searchSummary,
          )),
    )
    if (index < 0) break
    const [old] = next.attempts.splice(index, 1)
    if (old.searchSummary) {
      // Keep research counts/protocol summaries even after removing detailed answers.
      const existing = next.attempts.find(
        (a) =>
          a.phase === 'archived' &&
          a.experienceId === old.experienceId &&
          a.searchSummary,
      )
      if (existing?.searchSummary)
        existing.searchSummary = {
          ...existing.searchSummary,
          compactedSearches:
            (Number(existing.searchSummary.compactedSearches) || 0) +
            (Number(old.searchSummary.totalSearchCount) || 0) +
            (Number(old.searchSummary.compactedSearches) || 0),
        }
      else {
        next.attempts.push({
          ...old,
          answers: {},
          inputs: null,
          resultSummary: null,
          reflection:
            'Detailed archived answers compacted; research summary retained.',
        })
        break
      }
    }
  }
  return next
}
export interface LoadedLearning {
  store: LearningStoreV2
  available: boolean
  recovery: boolean
  notice: string
  raw: string | null
  savedRaw: string | null
}
export function loadLearning(
  storage: StoragePort | null,
  clock: Clock = deviceClock,
): LoadedLearning {
  const temporary = (
    notice: string,
    raw: string | null = null,
  ): LoadedLearning => ({
    store: emptyStore(clock),
    available: false,
    recovery: raw !== null,
    notice,
    raw,
    savedRaw: null,
  })
  if (!storage)
    return temporary(
      'Browser storage is unavailable. This session only—export before closing.',
    )
  let raw: string | null
  try {
    raw = storage.getItem(LEARNING_KEY)
  } catch {
    return temporary(
      'Browser storage is unavailable. This session only—export before closing.',
    )
  }
  if (raw !== null) {
    try {
      const parsed = decodeStore(JSON.parse(raw))
      if (
        parsed.ok &&
        serializedBytes(parsed.value) <= LIMITS.bytes &&
        parsed.value.attempts.length <= LIMITS.attempts &&
        Object.keys(parsed.value.drafts).length <= LIMITS.drafts
      )
        return {
          store: parsed.value,
          available: true,
          recovery: false,
          notice: '',
          raw: null,
          savedRaw: raw,
        }
    } catch {
      /* Keep original for explicit recovery. */
    }
    return temporary(
      'Saved learning data is malformed or unsupported. Export raw data, use this temporary session, or explicitly reset.',
      raw,
    )
  }
  let v1: string | null
  try {
    v1 = storage.getItem(LEGACY_KEY)
  } catch {
    return temporary(
      'Browser storage is unavailable. This session only—export before closing.',
    )
  }
  const store = emptyStore(clock)
  const prior = parseProgress(v1)
  store.legacy = { completed: prior.completed, notes: prior.notes }
  store.migration =
    v1 === null
      ? { fromV1: false }
      : { fromV1: true, migratedAt: clock().toISOString() }
  let malformed = false
  if (v1 !== null) {
    try {
      const v: unknown = JSON.parse(v1)
      malformed =
        !isRecord(v) ||
        v.version !== 1 ||
        !list(v.completed, legacyIds) ||
        !notes(v.notes, legacyIds)
    } catch {
      malformed = true
    }
  }
  if (malformed)
    return {
      store,
      available: false,
      recovery: true,
      notice:
        'Legacy learning data was damaged. Valid known records were salvaged in this temporary session; export raw data before recovery or reset.',
      raw: v1,
      savedRaw: null,
    }
  const encoded = JSON.stringify(store)
  try {
    storage.setItem(LEARNING_KEY, encoded)
    return {
      store,
      available: true,
      recovery: false,
      notice: '',
      raw: null,
      savedRaw: encoded,
    }
  } catch {
    return {
      store,
      available: false,
      recovery: false,
      notice:
        'Browser storage is unavailable. This session only—export before closing.',
      raw: v1,
      savedRaw: null,
    }
  }
}
export function exportLearning(
  store: LearningStoreV2,
  format: 'json' | 'markdown',
): string {
  const decoded = decodeStore(store)
  if (!decoded.ok) throw new RangeError('Invalid export schema.')
  const data = compactStore(decoded.value)
  if (
    serializedBytes(data) > LIMITS.bytes ||
    data.attempts.length > LIMITS.attempts ||
    Object.keys(data.drafts).length > LIMITS.drafts
  ) {
    const parts = partitionExport(data)
    if (format === 'json')
      return JSON.stringify(
        {
          schema: 'quantpoker.learning.export.v1',
          reason:
            'Session exceeded durable bounds; every part is a bounded v2 snapshot.',
          parts,
        },
        null,
        2,
      )
    return parts
      .map(
        (part, i) =>
          `# Export part ${i + 1}/${parts.length}\n\n${exportLearning(part, 'markdown')}`,
      )
      .join('\n\n')
  }
  if (format === 'json') return JSON.stringify(data, null, 2)
  const escape = (s: string) =>
    s
      .replace(
        /[&<>]/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!,
      )
      .replace(/([\\`*_[\]#|])/g, '\\$1')
  return [
    '# DeltaDeck learning notebook',
    'Schema: quantpoker.learning.v2. Local, editable evidence—not secure certification.',
    `Updated: ${data.updatedAt}`,
    '## Prior core practice',
    ...data.legacy.completed.map((id) => `- ${id}`),
    ...Object.entries(data.legacy.notes).map(
      ([id, note]) => `### Core ${id}\n${escape(note!)}`,
    ),
    ...Object.entries(data.unitNotes).map(
      ([id, note]) => `### ${id}\n${escape(note!)}`,
    ),
    '## Evidence receipts',
    ...data.receipts.map(
      (r) =>
        `- ${r.unitId} ${r.caseId}: ${r.earned}/${r.max}; ${r.eligible ? 'eligible' : 'practice/assisted'}; content ${r.contentVersion}, rubric ${r.rubricVersion}; ${r.submittedAt}; attempt ${r.attemptId}`,
    ),
    '## Attempts and active drafts',
    ...data.attempts.map(
      (a) =>
        `### ${a.caseId} (${a.id})\nModel ${a.modelVersion}; content ${a.contentVersion}; rubric ${a.rubricVersion}; generator ${a.generatorVersion ?? 'none'}; seed ${a.seed ?? 'none'}\nPrediction: ${escape(JSON.stringify(a.prediction ?? null))}\nInputs: ${escape(JSON.stringify(a.inputs))}\nAnswers: ${escape(JSON.stringify(a.answers))}\nModel result (not a score): ${escape(JSON.stringify(a.resultSummary ?? null))}\nReflection (ungraded): ${escape(a.reflection ?? '')}\nSearch summary: ${escape(JSON.stringify(a.searchSummary ?? null))}`,
    ),
    ...Object.entries(data.drafts).map(
      ([id, d]) => `### Active draft ${id}\n${escape(JSON.stringify(d))}`,
    ),
    '## Review schedule',
    escape(JSON.stringify(data.reviewSchedule)),
  ].join('\n\n')
}
function partitionExport(data: LearningStoreV2): LearningStoreV2[] {
  const base = { ...data, attempts: [], drafts: {} } as LearningStoreV2
  const parts: LearningStoreV2[] = []
  let part = safeClone(base)
  const bounded = (s: LearningStoreV2) =>
    s.attempts.length <= LIMITS.attempts &&
    Object.keys(s.drafts).length <= LIMITS.drafts &&
    serializedBytes(s) <= LIMITS.bytes
  const add = (transform: (s: LearningStoreV2) => LearningStoreV2) => {
    let next = transform(part)
    if (!bounded(next)) {
      parts.push(part)
      part = safeClone(base)
      next = transform(part)
    }
    if (!bounded(next))
      throw new RangeError(
        'One record exceeds the export-part bound. Reduce its public summary; original work remains in this tab.',
      )
    part = next
  }
  data.attempts.forEach((a) =>
    add((s) => ({ ...s, attempts: [...s.attempts, a] })),
  )
  Object.entries(data.drafts).forEach(([key, draft]) =>
    add((s) => ({ ...s, drafts: { ...s.drafts, [key]: draft } })),
  )
  parts.push(part)
  return parts
}
