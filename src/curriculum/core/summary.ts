// A short account of a player's lessons for Your profile, read from the
// saved record alone so the profile does not load the curriculum content.
import type { AttemptSnapshot, LearningStoreV2, UnitId } from './types'
import { unitIds } from './types'

export type LessonSummary = {
  /** Foundation units passed with an unaided transfer case. */
  unitsDone: number
  unitsTotal: number
  /** Units with any attempt, draft or receipt, passed or not. */
  unitsStarted: number
  /** Core modules completed. */
  modulesDone: number
  /** The unit worked on most recently, with when. */
  last: { unitId: UnitId; at: string } | null
}

export function lessonSummary(store: LearningStoreV2): LessonSummary {
  const done = new Set<UnitId>()
  const started = new Set<UnitId>()
  let last: LessonSummary['last'] = null
  const seen = (unitId: UnitId, at: string) => {
    started.add(unitId)
    if (!last || Date.parse(at) > Date.parse(last.at)) last = { unitId, at }
  }
  for (const r of store.receipts) {
    seen(r.unitId, r.submittedAt)
    if (r.eligible && r.passed && r.mode === 'transfer') done.add(r.unitId)
  }
  const attempt = (a: AttemptSnapshot) => {
    if (a.unitId) seen(a.unitId, a.submittedAt ?? a.committedAt ?? a.createdAt)
  }
  store.attempts.forEach(attempt)
  Object.values(store.drafts).forEach((d) => attempt(d.attempt))
  return {
    unitsDone: done.size,
    unitsTotal: unitIds.length,
    unitsStarted: started.size,
    modulesDone: store.legacy.completed.length,
    last,
  }
}
