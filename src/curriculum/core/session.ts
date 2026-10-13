import { useRef, useSyncExternalStore, type RefObject } from 'react'
import { backwardClock, deviceClock, recordEvidence } from './assessment'
import {
  compactStore,
  decodeAttempt,
  decodeStore,
  emptyStore,
  exportLearning,
  LEARNING_KEY,
  LEARNING_RESET_KEY,
  LEARNING_V1_KEY,
  LIMITS,
  loadLearning,
  serializedBytes,
  type StoragePort,
} from './persistence'
import type {
  AttemptSnapshot,
  Clock,
  EvidenceCallbacks,
  JsonObject,
  LearningStoreV2,
} from './types'
import { safeClone } from './validation'
import { LEARNING_SAVED_EVENT } from '../../lib/storage'

/** Tells the account's sync that the saved progress changed. */
function savedEvent() {
  if (typeof window !== 'undefined')
    window.dispatchEvent(new Event(LEARNING_SAVED_EVENT))
}

export class LearningSession implements EvidenceCallbacks {
  store: LearningStoreV2
  available: boolean
  recovery: boolean
  notice: string
  raw: string | null
  conflict = false
  private savedRaw: string | null
  private revision = 0
  private listeners = new Set<() => void>()
  readonly runtimes = new Map<string, { cancel(): void }>()
  constructor(
    readonly storage: StoragePort | null,
    readonly clock: Clock = deviceClock,
  ) {
    const loaded = loadLearning(storage, clock)
    this.store = loaded.store
    this.available = loaded.available
    this.recovery = loaded.recovery
    this.notice = loaded.notice
    this.raw = loaded.raw
    this.savedRaw = loaded.savedRaw
    if (backwardClock(this.store, clock))
      this.notice =
        'Device clock moved backward. Reminders use device time; early practice will not count as delayed review.'
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  getRevision = () => this.revision
  private notify() {
    this.revision++
    this.listeners.forEach((l) => l())
  }
  update(transform: (store: LearningStoreV2) => LearningStoreV2) {
    const next = compactStore({
      ...transform(safeClone(this.store)),
      revision: this.store.revision + 1,
      updatedAt: this.clock().toISOString(),
    })
    const validated = decodeStore(next)
    if (!validated.ok)
      throw new RangeError(validated.errors.map((e) => e.message).join(' '))
    this.store = next
    if (
      Object.keys(next.drafts).length > LIMITS.drafts ||
      next.attempts.length > LIMITS.attempts ||
      serializedBytes(next) > LIMITS.bytes
    ) {
      this.available = false
      this.notice =
        'Saved-data limit reached. New work remains in this tab; export before closing. Archive completed runs to compact details.'
    } else if (!this.recovery && !this.conflict && this.storage) {
      try {
        const current = this.storage.getItem(LEARNING_KEY)
        if (current !== this.savedRaw) {
          this.conflict = true
          this.available = false
          this.notice =
            'Another tab changed saved progress. This tab’s work is retained. Export it or reload saved progress; no automatic overwrite.'
        } else {
          const raw = JSON.stringify(next)
          this.storage.setItem(LEARNING_KEY, raw)
          this.savedRaw = raw
          this.available = true
          savedEvent()
          if (!backwardClock(next, this.clock)) this.notice = ''
        }
      } catch {
        this.available = false
        this.notice =
          'Browser storage is unavailable. This session only—export before closing.'
      }
    }
    this.notify()
  }
  recordAttempt = (
    attempt: AttemptSnapshot,
    draft?: { key: string; protocol: JsonObject },
  ) => {
    const decoded = decodeAttempt(attempt)
    if (!decoded.ok) throw new RangeError(decoded.errors[0].message)
    this.update((store) => {
      const existing = store.attempts.find((a) => a.id === attempt.id)
      if (
        existing?.submittedAt &&
        JSON.stringify(existing) !== JSON.stringify(attempt)
      )
        throw new RangeError(
          'Submitted evidence is immutable; create a linked attempt.',
        )
      if (existing?.committedAt) {
        const snapshot = (a: AttemptSnapshot) =>
          JSON.stringify([
            a.inputs,
            a.prediction,
            a.createdAt,
            a.committedAt,
            a.seed,
            a.generatorVersion,
            a.modelVersion,
            a.inputVersion,
            a.caseId,
            a.unitId,
            a.experienceId,
            a.mode,
            a.contentVersion,
            a.rubricVersion,
          ])
        if (snapshot(existing) !== snapshot(attempt))
          throw new RangeError(
            'Committed inputs/prediction are immutable; create a linked attempt.',
          )
        if (
          (existing.assistance.solutionViewed &&
            !attempt.assistance.solutionViewed) ||
          existing.assistance.hintIds.some(
            (id) => !attempt.assistance.hintIds.includes(id),
          )
        )
          throw new RangeError('Assistance cannot be erased.')
      }
      const exposure = `${attempt.caseId}@${attempt.contentVersion}`
      const exposed =
        !!attempt.submittedAt ||
        attempt.assistance.solutionViewed ||
        attempt.assistance.hintIds.length > 0
      let next = {
        ...store,
        ...(draft
          ? {
              drafts: {
                ...store.drafts,
                [draft.key]: {
                  attempt: safeClone(attempt),
                  protocol: safeClone(draft.protocol),
                },
              },
            }
          : {}),
        attempts: [
          ...store.attempts.filter((a) => a.id !== attempt.id),
          safeClone(attempt),
        ],
        exposedVariants:
          exposed && !store.exposedVariants.includes(exposure)
            ? [...store.exposedVariants, exposure]
            : store.exposedVariants,
      }
      next = recordEvidence(next, attempt, this.clock)
      return next
    })
  }
  exposeHint = (id: string, hintId: string) => {
    const a = this.store.attempts.find((a) => a.id === id)
    if (a && !a.submittedAt && !a.assistance.hintIds.includes(hintId))
      this.recordAttempt({
        ...a,
        assistance: {
          ...a.assistance,
          hintIds: [...a.assistance.hintIds, hintId],
        },
      })
  }
  exposeSolution = (id: string) => {
    const a = this.store.attempts.find((a) => a.id === id)
    if (a && !a.submittedAt)
      this.recordAttempt({
        ...a,
        assistance: { ...a.assistance, solutionViewed: true },
      })
  }
  observeStorage(key: string | null, newValue: string | null) {
    if ((key !== LEARNING_KEY && key !== null) || newValue === this.savedRaw)
      return
    this.conflict = true
    this.available = false
    this.notice =
      'Another tab changed saved progress. This tab’s work is retained. Export it or reload saved progress; no automatic overwrite.'
    this.notify()
  }
  reset() {
    this.cancelRuns()
    this.runtimes.clear()
    const next = emptyStore(this.clock)
    next.revision = this.store.revision + 1
    let durable = false
    try {
      if (this.storage) {
        const raw = JSON.stringify(next)
        // Before the document: a sync that sends the reset store sends the
        // reset with it, so the account drops older work everywhere.
        this.storage.setItem(LEARNING_RESET_KEY, next.updatedAt)
        this.storage.setItem(LEARNING_KEY, raw)
        this.savedRaw = raw
        durable = true
        savedEvent()
        this.storage.removeItem(LEARNING_V1_KEY)
      }
    } catch {
      /* The valid v2 remains authoritative if only v1 removal failed. */
    }
    this.store = next
    this.available = durable
    this.recovery = !durable
    this.conflict = false
    this.raw = null
    this.notice = durable
      ? ''
      : 'Session-only reset. Saved learning data may reappear after reload; durable deletion failed.'
    this.notify()
    return durable
  }
  reloadSaved() {
    this.cancelRuns()
    this.runtimes.clear()
    const loaded = loadLearning(this.storage, this.clock)
    this.store = loaded.store
    this.available = loaded.available
    this.recovery = loaded.recovery
    this.notice = loaded.notice
    this.raw = loaded.raw
    this.savedRaw = loaded.savedRaw
    this.conflict = false
    this.notify()
  }
  cancelRuns() {
    this.runtimes.forEach((r) => r.cancel())
  }
  export(format: 'json' | 'markdown') {
    return exportLearning(this.store, format)
  }
}
export function browserStorage(): StoragePort | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}
export function useLearningSession(
  root?: RefObject<LearningSession | null>,
): LearningSession {
  const local = useRef<LearningSession | null>(null)
  const ref = root ?? local
  if (!ref.current) ref.current = new LearningSession(browserStorage())
  useSyncExternalStore(ref.current.subscribe, ref.current.getRevision)
  return ref.current
}
