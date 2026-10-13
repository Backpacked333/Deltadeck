// Two devices' curriculum stores as one (audit F09). Each device saved the
// whole document, and the account kept whichever arrived last, so work done
// on one device and not yet seen by the other was lost without a word. Here
// they merge by what each part means:
//
// - submitted evidence (attempts, receipts) is a union by id: nothing one
//   device recorded is dropped, and an attempt keeps its furthest stage;
// - assistance (hints, a viewed solution) is never forgotten: it is what
//   makes an attempt practice rather than unaided evidence;
// - exposure only grows: a variant seen on either device is not fresh;
// - a note edited on both devices keeps both texts, marked;
// - drafts keep the newer copy, and go once their attempt is submitted;
// - each unit's review schedule comes from the device with that unit's
//   latest evidence;
// - a reset (resetAt) drops everything older than it, so a device that
//   missed the reset cannot bring the old work back.
//
// Pure and deterministic; the caller validates and compacts the result.
import { compactStore, decodeStore, LIMITS } from './persistence'
import type {
  AttemptSnapshot,
  DraftSnapshot,
  EvidenceReceipt,
  LearningStoreV2,
  UnitId,
} from './types'

/** Marks the other device's text in a note both devices changed. */
export const OTHER_DEVICE = '\n\n— From another device —\n'

const ms = (iso: string | undefined) => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? t : 0
}

/** How far an attempt got: submitted, committed, or still a draft. */
const stage = (a: AttemptSnapshot) =>
  a.submittedAt ? 2 : a.committedAt ? 1 : 0
const lastTouched = (a: AttemptSnapshot) =>
  Math.max(ms(a.submittedAt), ms(a.committedAt), ms(a.createdAt))

function mergeAttempt(
  ours: AttemptSnapshot,
  theirs: AttemptSnapshot,
): AttemptSnapshot {
  const base =
    stage(theirs) > stage(ours) ||
    (stage(theirs) === stage(ours) && lastTouched(theirs) > lastTouched(ours))
      ? theirs
      : ours
  const hintIds = [
    ...new Set([...ours.assistance.hintIds, ...theirs.assistance.hintIds]),
  ]
  const solutionViewed =
    ours.assistance.solutionViewed || theirs.assistance.solutionViewed
  if (
    hintIds.length === base.assistance.hintIds.length &&
    solutionViewed === base.assistance.solutionViewed
  )
    return base
  return { ...base, assistance: { hintIds, solutionViewed } }
}

function mergeNote(ours: string | undefined, theirs: string | undefined) {
  if (!theirs || ours === theirs) return ours
  if (!ours) return theirs
  // One already holds the other (an earlier merge, or one side only added
  // text): the longer one is both.
  if (ours.includes(theirs)) return ours
  if (theirs.includes(ours)) return theirs
  return `${ours}${OTHER_DEVICE}${theirs}`.slice(0, LIMITS.note)
}

/** `record` with its keys in order: the same content, the same text. */
function sortedKeys<V>(record: Record<string, V>): Record<string, V> {
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, record[key]]),
  )
}

function mergeNotes<K extends string>(
  ours: Partial<Record<K, string>>,
  theirs: Partial<Record<K, string>>,
) {
  const out: Partial<Record<K, string>> = { ...ours }
  for (const key of Object.keys(theirs) as K[]) {
    const merged = mergeNote(ours[key], theirs[key])
    if (merged !== undefined) out[key] = merged
  }
  return sortedKeys(out as Record<string, string>) as Partial<Record<K, string>>
}

/** The latest evidence time per unit in `receipts`. */
function latestByUnit(receipts: EvidenceReceipt[]) {
  const latest = new Map<UnitId, number>()
  for (const r of receipts)
    latest.set(r.unitId, Math.max(latest.get(r.unitId) ?? 0, ms(r.submittedAt)))
  return latest
}

/**
 * `local` and `remote` merged, as `local`'s device should hold it. Parts
 * that cannot be dated (notes, settings) come from a side only if that
 * side changed after the reset; settings are this device's.
 */
export function mergeLearningStores(
  local: LearningStoreV2,
  remote: LearningStoreV2,
  resetAt: number | null = null,
): LearningStoreV2 {
  // Work made before the reset is gone; a document last saved before it
  // (a device that missed the reset) contributes nothing but the variants
  // it saw, since exposure only grows. The reset document itself is saved
  // at the reset, so it counts.
  const after = (iso: string | undefined) =>
    resetAt === null || ms(iso) > resetAt
  const live = (s: LearningStoreV2) =>
    resetAt === null || ms(s.updatedAt) >= resetAt
  const sides = [local, remote].filter(live)
  const [first, second] = sides

  const attempts = new Map<string, AttemptSnapshot>()
  for (const side of sides)
    for (const a of side.attempts) {
      if (!after(a.createdAt)) continue
      const seen = attempts.get(a.id)
      attempts.set(a.id, seen ? mergeAttempt(seen, a) : a)
    }

  const receipts = new Map<string, EvidenceReceipt>()
  for (const side of sides)
    for (const r of side.receipts)
      if (after(r.submittedAt) && !receipts.has(r.attemptId))
        receipts.set(r.attemptId, r)

  const submitted = new Set(
    [...attempts.values()].filter((a) => a.submittedAt).map((a) => a.id),
  )
  const drafts: Record<string, DraftSnapshot> = {}
  for (const side of sides)
    for (const [key, draft] of Object.entries(side.drafts)) {
      if (!after(draft.attempt.createdAt) || submitted.has(draft.attempt.id))
        continue
      const seen = drafts[key]
      if (!seen || lastTouched(draft.attempt) > lastTouched(seen.attempt))
        drafts[key] = draft
    }
  // At most LIMITS.drafts, newest first kept.
  const keptDrafts = sortedKeys(
    Object.fromEntries(
      Object.entries(drafts)
        .sort(([, a], [, b]) => lastTouched(b.attempt) - lastTouched(a.attempt))
        .slice(0, LIMITS.drafts),
    ),
  )

  // Each unit's schedule from the side whose evidence for it is newest
  // (this device's on a tie).
  const reviewSchedule: LearningStoreV2['reviewSchedule'] = {}
  const latest = sides.map((side) => latestByUnit(side.receipts))
  const units = new Set(
    sides.flatMap((side) => Object.keys(side.reviewSchedule)),
  ) as Set<UnitId>
  for (const unit of units) {
    const [ours, theirs] = sides.map((side) => side.reviewSchedule[unit])
    const pick =
      theirs &&
      (!ours || (latest[1]?.get(unit) ?? 0) > (latest[0].get(unit) ?? 0))
        ? theirs
        : ours
    if (pick) reviewSchedule[unit] = pick
  }

  const byTime =
    <T>(time: (x: T) => number, id: (x: T) => string) =>
    (a: T, b: T) =>
      time(a) - time(b) || (id(a) < id(b) ? -1 : 1)
  const notes = <K extends string>(
    pick: (side: LearningStoreV2) => Partial<Record<K, string>>,
  ): Partial<Record<K, string>> =>
    !first ? {} : mergeNotes(pick(first), second ? pick(second) : {})
  return compactStore({
    ...local,
    revision: Math.max(local.revision, remote.revision),
    updatedAt: new Date(
      Math.max(ms(local.updatedAt), ms(remote.updatedAt)),
    ).toISOString(),
    migration: {
      ...local.migration,
      fromV1: local.migration.fromV1 || remote.migration.fromV1,
    },
    legacy: {
      completed: [
        ...new Set(sides.flatMap((side) => side.legacy.completed)),
      ].sort(),
      notes: notes((side) => side.legacy.notes),
    },
    unitNotes: notes((side) => side.unitNotes),
    attempts: [...attempts.values()].sort(
      byTime(
        (a) => ms(a.createdAt),
        (a) => a.id,
      ),
    ),
    receipts: [...receipts.values()].sort(
      byTime(
        (r) => ms(r.submittedAt),
        (r) => r.id,
      ),
    ),
    reviewSchedule: sortedKeys(
      reviewSchedule as Record<
        string,
        NonNullable<(typeof reviewSchedule)[UnitId]>
      >,
    ),
    drafts: keptDrafts,
    exposedVariants: [
      ...new Set([...local.exposedVariants, ...remote.exposedVariants]),
    ].sort(),
  })
}

/** A store's content, without the bookkeeping a merge always changes. */
export const contentOf = (store: LearningStoreV2) =>
  JSON.stringify({ ...store, revision: 0, updatedAt: '' })

/** What a merge of two saved documents comes to. */
export type RawMerge =
  /** This device's document already holds everything. */
  | { kind: 'ours' }
  /** The other's already holds everything: take it as it is. */
  | { kind: 'theirs' }
  /** Neither does: both must take this. */
  | { kind: 'merged'; raw: string }

const parse = (raw: string) => {
  try {
    const decoded = decodeStore(JSON.parse(raw))
    return decoded.ok ? decoded.value : null
  } catch {
    return null
  }
}

/**
 * Two saved documents (the exact text each device stored) merged; null
 * when either is not a valid store, so the caller can fall back to keeping
 * both copies apart. "ours" and "theirs" compare content after the merge's
 * own ordering, so two copies that differ only in order or bookkeeping
 * never rewrite each other.
 */
export function mergeLearningRaw(
  localRaw: string,
  remoteRaw: string,
  resetAt: number | null,
  now: () => Date = () => new Date(),
): RawMerge | null {
  const local = parse(localRaw)
  const remote = parse(remoteRaw)
  if (!local || !remote) return null
  const merged = mergeLearningStores(local, remote, resetAt)
  if (!decodeStore(merged).ok) return null
  const same = (store: LearningStoreV2) =>
    contentOf(mergeLearningStores(store, store, resetAt)) === contentOf(merged)
  if (same(local)) return { kind: 'ours' }
  if (same(remote)) return { kind: 'theirs' }
  return {
    kind: 'merged',
    raw: JSON.stringify({
      ...merged,
      revision: merged.revision + 1,
      updatedAt: new Date(
        Math.max(now().getTime(), Date.parse(merged.updatedAt)),
      ).toISOString(),
    }),
  }
}
