import type { CaseRecord, LearningStoreV2 } from './types'

export function freshFamilyCase(
  ids: readonly string[],
  cases: ReadonlyMap<string, CaseRecord>,
  store: LearningStoreV2,
) {
  const family = (id: string) => cases.get(id)?.familyId ?? id
  const used = new Set([
    ...store.receipts.map((r) => family(r.caseId)),
    ...store.exposedVariants.map((id) => family(id.split('@')[0])),
    ...store.attempts
      .filter(
        (a) =>
          a.submittedAt ||
          a.assistance.solutionViewed ||
          a.assistance.hintIds.length,
      )
      .map((a) => family(a.caseId)),
  ])
  return ids.find((id) => cases.has(id) && !used.has(family(id)))
}
