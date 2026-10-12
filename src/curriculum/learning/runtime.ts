import type { SupabaseClient } from '@supabase/supabase-js'
import {
  activeSync,
  registerSaveParticipant,
  type PracticeSync,
  type SaveParticipant,
} from '../../net/sync'
import {
  DurableOutbox,
  type DurableEvent,
  type EventAck,
} from '../../net/syncOutbox'
import {
  canonical,
  digest,
  type SaveBarrier,
  type SyncScope,
} from '../../net/syncRevision'
import { loadOnline } from '../../net/supabase'
import { readProgress } from '../../lib/storage'
import { loadLearning } from '../core/persistence'
import type { LearningSession } from '../core/session'
import { registry } from '../core/registry'
import {
  attemptExposure,
  evaluateSubmission,
  practiceEvidence,
  submission,
} from './evidence'
import type { LearningEvent, StoredEvent } from './types'
import { validEvent } from './validate'
import { cleanupDeletedEvidence } from './cleanup'
import { startEvidenceBootstrap } from '../../net/evidenceBootstrap'

export interface Assignment {
  protocol: string
  arm: 'baseline' | 'targeted'
  enabled: boolean
  consented: boolean
  withdrawn: boolean
  endpoint: string
  baseline: string
}
export const CHANGED = 'qp-learning-evidence'
const changed = () => window.dispatchEvent(new Event(CHANGED))
const matches = (a: SyncScope, b: SyncScope) =>
  a.accountId === b.accountId && a.epoch === b.epoch
export class EvidenceRuntime implements SaveParticipant {
  readonly outbox: DurableOutbox
  rows: StoredEvent[] = []
  remoteRaw: unknown[] = []
  assignment: Assignment | null = null
  serverNow: number | null = null
  error: string | null = null
  private active = true
  private seen = new Map<string, string>()
  private capturePending: Promise<void> | null = null
  private captureAgain = false
  private captureSession: LearningSession | null = null
  private refreshing: Promise<void> | null = null
  private unregister: () => void = () => {}
  private lastInput = ''
  constructor(
    readonly sync: PracticeSync,
    private client: SupabaseClient,
    readonly learningGeneration: number,
    readonly practiceGeneration: number,
    factory?: IDBFactory,
  ) {
    this.outbox = new DurableOutbox(
      sync.scope,
      learningGeneration,
      this.write,
      factory,
    )
  }
  register() {
    this.unregister = registerSaveParticipant(this)
  }
  private live() {
    const generations = this.sync.deletionGenerations()
    return (
      this.active &&
      activeSync() === this.sync &&
      generations?.learning === this.learningGeneration &&
      generations.practice === this.practiceGeneration
    )
  }
  private write = async (
    event: DurableEvent,
    scope: SyncScope,
  ): Promise<EventAck> => {
    if (!this.live() || !matches(scope, this.sync.scope))
      return { status: 'blocked', reason: 'account_changed' }
    const { data, error } = await this.client.rpc(
      'ingest_learning_evidence_v1',
      { p: { protocol: 1, ...event } },
    )
    if (error) throw error
    if (!this.live()) return { status: 'blocked', reason: 'account_changed' }
    if (!data || !['accepted', 'blocked', 'conflict'].includes(data.status))
      throw new Error('Invalid evidence acknowledgement')
    return data as EventAck
  }
  async emit(event: LearningEvent) {
    if (!this.live() || event.accountId !== this.sync.scope.accountId)
      throw new Error('Account changed')
    const serialized = canonical(event)
    if (this.seen.get(event.id) === serialized) return
    const stored = await this.outbox.enqueue(event.id, event)
    if (!this.live()) return
    this.seen.set(event.id, serialized)
    if (
      !this.rows.some(
        (r) => r.event.id === event.id && r.digest === stored.digest,
      )
    )
      this.rows = [
        ...this.rows,
        { event, digest: stored.digest, receivedAt: null },
      ]
    changed()
  }
  capture(session?: LearningSession | null) {
    if (!this.live()) return Promise.resolve()
    this.captureAgain = true
    this.captureSession = session ?? attachedSession
    if (this.capturePending) return this.capturePending
    let failed = false
    this.capturePending = Promise.resolve()
      .then(async () => {
        while (this.captureAgain && this.live()) {
          this.captureAgain = false
          await this.captureSources(this.captureSession)
        }
      })
      .catch((e) => {
        failed = true
        this.error = String(e)
        if (this.live()) this.sync.reportSourceBlocked('evidence', this.error)
        changed()
      })
      .finally(() => {
        this.capturePending = null
        if (!failed && this.captureAgain && this.live())
          return this.capture(this.captureSession)
      })
    return this.capturePending
  }
  private async captureSources(session?: LearningSession | null) {
    const boundSession =
      session && attachedScope && matches(attachedScope, this.sync.scope)
        ? session
        : null
    const store = boundSession?.store ?? loadLearning(localStorage).store
    const progress = readProgress()
    const input = canonical([store.attempts, progress.hands])
    if (input === this.lastInput) return
    for (const a of store.attempts) {
      if (!this.live()) return
      if (a.submittedAt) {
        const s = submission(this.sync.scope.accountId, a)
        await this.emit(s)
        await this.emit(evaluateSubmission(s, (id) => registry.cases.get(id)))
      }
      const exposure = attemptExposure(this.sync.scope.accountId, a)
      if (exposure) await this.emit(exposure)
    }
    for (const h of progress.hands) {
      if (!this.live()) return
      const s = await practiceEvidence(
        this.sync.scope.accountId,
        h,
        this.practiceGeneration,
      )
      await this.emit(s)
      await this.emit(evaluateSubmission(s))
    }
    this.lastInput = input
  }
  async restore() {
    const exported = JSON.parse(
      await (await this.outbox.exportAccount(this.sync.scope)).text(),
    )
    const durable = exported.stores?.events ?? exported.events ?? []
    for (const row of durable as DurableEvent[]) {
      if (
        row.accountId !== this.sync.scope.accountId ||
        row.deletionGeneration !== this.learningGeneration
      )
        continue
      const event = JSON.parse(row.serialized) as LearningEvent
      if (
        !validEvent(event) ||
        event.accountId !== row.accountId ||
        (await digest(canonical(event))) !== row.digest
      )
        throw new Error(
          'Unsupported or corrupt local evidence; export before recovery',
        )
      if (!this.live()) return
      this.rows.push({ event, digest: row.digest, receivedAt: null })
      this.seen.set(event.id, canonical(event))
    }
    changed()
  }
  refresh() {
    if (this.refreshing) return this.refreshing
    this.refreshing = this.read()
      .catch((e) => {
        if (this.live()) {
          this.error = String(e)
          changed()
        }
      })
      .finally(() => {
        this.refreshing = null
      })
    return this.refreshing
  }
  private async read() {
    const remote: StoredEvent[] = []
    let cursor = 0
    do {
      const { data, error } = await this.client.rpc(
        'read_learning_evidence_v1',
        { p: { after: cursor } },
      )
      if (!this.live()) return
      if (error) throw error
      if (
        !data ||
        data.accountId !== this.sync.scope.accountId ||
        data.deletionGeneration !== this.learningGeneration ||
        !Array.isArray(data.rows)
      )
        throw new Error(
          'Evidence account or deletion generation changed; reconcile before retry',
        )
      this.remoteRaw.push(...data.rows)
      for (const row of data.rows as StoredEvent[]) {
        if (
          !validEvent(row.event) ||
          row.event.accountId !== data.accountId ||
          row.event.trust !== 'client-reported' ||
          (await digest(canonical(row.event))) !== row.digest
        )
          throw new Error('Unsupported remote evidence; export is available')
        remote.push(row)
      }
      if (!this.live()) return
      this.serverNow = Date.parse(data.serverNow)
      this.assignment = data.assignment
      if (data.rows.length < 300) break
      if (!Number.isSafeInteger(data.cursor) || data.cursor <= cursor)
        throw new Error('Invalid evidence pagination')
      cursor = data.cursor
    } while (this.live())
    this.rows = [
      ...remote,
      ...this.rows.filter(
        (r) =>
          !remote.some(
            (s) => s.event.id === r.event.id && s.digest === r.digest,
          ),
      ),
    ]
    this.remoteRaw = remote
    this.error = null
    changed()
  }
  async consent(consent: boolean) {
    if (!this.live()) throw new Error('Account changed')
    const { error } = await this.client.rpc('learning_pilot_consent_v1', {
      p: { consent },
    })
    if (error) throw error
    await this.refresh()
  }
  async issueAssessment(skill: string) {
    if (!this.live()) throw new Error('Account changed')
    const { data, error } = await this.client.rpc(
      'issue_learning_assessment_v1',
      {
        p: {
          protocol: 1,
          accountId: this.sync.scope.accountId,
          deletionGeneration: this.learningGeneration,
          skill,
        },
      },
    )
    if (!this.live()) throw new Error('Account changed')
    if (error) throw error
    if (
      data?.status !== 'issued' ||
      typeof data.issueId !== 'string' ||
      typeof data.caseId !== 'string'
    )
      throw new Error(
        data?.status === 'waiting'
          ? `Not due until ${data.dueAt}; the server clock decides.`
          : `Assessment unavailable: ${data?.reason ?? 'unknown response'}`,
      )
    return { issueId: data.issueId as string, caseId: data.caseId as string }
  }
  async retry() {
    this.error = null
    this.lastInput = ''
    await this.outbox.retry()
    await this.capture(attachedSession)
    if (!this.error) {
      this.sync.reportSourceBlocked('evidence', null)
      await this.refresh()
    }
  }
  status() {
    return this.error
      ? ('blocked' as const)
      : this.capturePending
        ? ('saving' as const)
        : this.outbox.status()
  }
  async barrier(scope: SyncScope) {
    if (this.error) await this.retry()
    else await this.capture(attachedSession)
    return this.outbox.barrier(scope)
  }
  async flush(barrier: SaveBarrier, timeoutMs: number) {
    const until = performance.now() + timeoutMs
    for (;;) {
      if (this.error)
        return { barrier, status: 'blocked' as const, pending: [], reasons: [this.error] }
      const result = await this.outbox.flush(barrier, Math.max(0, until - performance.now()))
      if (result.status !== 'saved') return result
      await this.capture(attachedSession)
      const latest = await this.outbox.barrier(barrier.scope)
      if (this.error) continue
      if (latest.watermark === barrier.watermark) return result
      barrier = latest
      if (performance.now() >= until)
        return { barrier, status: 'timeout' as const, pending: barrier.targets, reasons: ['Evidence changed during save'] }
    }
  }
  async exportAccount(scope: SyncScope) {
    await this.capturePending
    return new Blob(
      [
        JSON.stringify(
          {
            schema: 1,
            raw: JSON.parse(
              await (await this.outbox.exportAccount(scope)).text(),
            ),
            remote: this.remoteRaw,
            projectionInputs: this.rows,
          },
          null,
          2,
        ),
      ],
      { type: 'application/json' },
    )
  }
  async clearAccount(scope: SyncScope) {
    await this.outbox.clearAccount(scope)
    this.rows = []
    this.remoteRaw = []
    this.assignment = null
    this.seen.clear()
    changed()
  }
  stop(scope: SyncScope) {
    if (!matches(scope, this.sync.scope)) return
    this.active = false
    this.outbox.stop(scope)
    this.unregister()
    this.rows = []
    this.remoteRaw = []
    this.assignment = null
    this.seen.clear()
    changed()
  }
}
let current: EvidenceRuntime | null = null
let attachedSession: LearningSession | null = null
let attachedScope: SyncScope | null = null
let started = false
let restored = false
export const evidenceRuntime = () => current
export function attachLearningSession(session: LearningSession) {
  attachedSession = session
  attachedScope = activeSync()?.scope ?? null
  const unsub = session.subscribe(() => {
    void current?.capture(session)
  })
  void current?.capture(session)
  return () => {
    unsub()
    if (attachedSession === session) {
      attachedSession = null
      attachedScope = null
    }
  }
}
/** Lazy account producer, shared by account bootstrap and curriculum mount. */
export function startLearningEvidence() {
  const sync = activeSync()
  if (sync) void startEvidenceBootstrap(sync)
}

function listen() {
  if (started) return
  started = true
  window.addEventListener('qp-sync-changed', () => {
    const sync = activeSync(),
      generations = sync?.deletionGenerations()
    if (
      current &&
      (current.sync !== sync ||
        generations?.learning !== current.learningGeneration ||
        generations.practice !== current.practiceGeneration)
    ) {
      const old = current
      current = null
      restored = false
      old.stop(old.sync.scope)
    }
    if (sync?.isReconciled()) void startEvidenceBootstrap(sync)
    if (restored) void current?.capture(attachedSession)
    changed()
  })
  window.addEventListener('qp-learning-saved', () => {
    if (restored) void current?.capture(attachedSession)
  })
  window.addEventListener('online', () => {
    const sync = activeSync()
    if (sync) void startEvidenceBootstrap(sync, true)
    if (restored) void current?.retry()
  })
  window.addEventListener('storage', () => {
    if (restored) void current?.capture(attachedSession)
  })
}

/** Called only behind the synchronously registered bootstrap save participant. */
export async function initializeLearningEvidence(sync: PracticeSync) {
  listen()
  const generations = sync.deletionGenerations()
  if (!sync.isReconciled() || !generations) throw new Error('Account not reconciled')
  const stillCurrent = () => {
    const latest = sync.deletionGenerations()
    return activeSync() === sync && latest?.learning === generations.learning &&
      latest.practice === generations.practice
  }
  if (!stillCurrent()) throw new Error('Account changed')
  if (current && restored && current.sync === sync &&
    current.learningGeneration === generations.learning &&
    current.practiceGeneration === generations.practice) return
  const old = current
  current = null
  restored = false
  old?.stop(old.sync.scope)
  let runtime: EvidenceRuntime | null = null
  try {
    const online = await loadOnline()
    if (!online) throw new Error('Evidence account service unavailable')
    if (!stillCurrent()) throw new Error('Account changed')
    await cleanupDeletedEvidence(sync.scope, generations, stillCurrent)
    if (!stillCurrent()) throw new Error('Account changed')
    runtime = new EvidenceRuntime(sync, online.client, generations.learning, generations.practice)
    current = runtime
    runtime.register()
    await runtime.restore()
    if (!stillCurrent()) throw new Error('Account changed')
    await runtime.capture(attachedSession)
    if (runtime.error) throw new Error(runtime.error)
    await runtime.refresh()
    if (runtime.error) throw new Error(runtime.error)
    if (!stillCurrent()) throw new Error('Account changed')
    restored = true
    sync.reportSourceBlocked('evidence', null)
  } catch (e) {
    if (current === runtime) { current = null; restored = false }
    runtime?.stop(sync.scope)
    throw e
  } finally { changed() }
}
