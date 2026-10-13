import type { SaveParticipant } from './sync'
import { canonical, digest } from './syncRevision'
import type { FlushResult, SaveBarrier, SyncScope, SyncStatus } from './syncRevision'

export const OUTBOX_DB = 'deltadeck.learning.outbox'
export type DurableEvent = { schema: 1; accountId: string; id: string; deletionGeneration: number; serialized: string; digest: string; localRevision: number }
type Job = { accountId: string; id: string; schema: 1; attempts: number; due: number; state: 'pending' | 'leased' | 'acked' | 'blocked' | 'conflict'; lease?: string; epoch?: number; leaseUntil?: number; reason?: string }
type Meta = { accountId: string; epoch: number; watermark: number; deletionGeneration: number }
export type EventAck = { status: 'accepted'; id: string; digest: string; deletionGeneration: number } | { status: 'blocked' | 'conflict'; reason: string }
export type EventWriter = (event: DurableEvent, scope: SyncScope) => Promise<EventAck>
const request = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed')) })
const completed = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
  tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
})
const matches = (a: SyncScope, b: SyncScope) => a.accountId === b.accountId && a.epoch === b.epoch

/** No drop/recreate fallback: unknown schemas and blocked upgrades are export/recovery states. */
export function openOutbox(factory: IDBFactory = indexedDB): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = factory.open(OUTBOX_DB, 1)
    let blocked = false
    r.onupgradeneeded = () => {
      for (const name of ['events', 'jobs']) if (!r.result.objectStoreNames.contains(name))
        r.result.createObjectStore(name, { keyPath: ['accountId', 'id'] })
      if (!r.result.objectStoreNames.contains('scopes')) r.result.createObjectStore('scopes', { keyPath: 'accountId' })
    }
    r.onerror = () => reject(r.error ?? new Error('Durable storage unavailable'))
    r.onblocked = () => { blocked = true; reject(new Error('Storage upgrade blocked by another tab; close it and retry. Existing data was not removed.')) }
    r.onsuccess = () => {
      if (blocked) { r.result.close(); return }
      if (!['events', 'jobs', 'scopes'].every((s) => r.result.objectStoreNames.contains(s))) {
        r.result.close(); reject(new Error('Unsupported outbox schema; export site data before recovery')); return
      }
      r.result.onversionchange = () => r.result.close()
      resolve(r.result)
    }
  })
}

/** Sign-out is the one explicit privacy purge, including unregistered/older-version producers. */
export async function clearOutboxDevice(factory: IDBFactory = indexedDB): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const r = factory.deleteDatabase(OUTBOX_DB)
    const timer = setTimeout(() => reject(new Error('Private outbox cleanup timed out; close other tabs and retry')), 3000)
    r.onsuccess = () => { clearTimeout(timer); resolve() }
    r.onerror = () => { clearTimeout(timer); reject(r.error ?? new Error('Private outbox cleanup failed')) }
    r.onblocked = () => { clearTimeout(timer); reject(new Error('Private outbox cleanup blocked by another tab; close it and retry')) }
  })
}

/** Read-only export also works when a future database version blocks the old writer. */
export async function exportStoredAccount(accountId: string, factory: IDBFactory = indexedDB): Promise<unknown> {
  const db = await new Promise<IDBDatabase | null>((resolve, reject) => {
    const r = factory.open(OUTBOX_DB)
    let missing = false, blocked = false
    r.onupgradeneeded = () => { missing = true; r.transaction!.abort() }
    r.onerror = () => missing ? resolve(null) : reject(r.error ?? new Error('Recovery export unavailable'))
    r.onblocked = () => { blocked = true; reject(new Error('Recovery export blocked by another tab; close it and retry')) }
    r.onsuccess = () => { if (blocked) r.result.close(); else resolve(r.result) }
  })
  // Export must not create an empty v1 database that the v1 writer cannot initialize.
  if (!db) return { databaseVersion: null, stores: {} }
  try {
    const names = [...db.objectStoreNames]
    if (!names.length) return { databaseVersion: db.version, stores: {} }
    const tx = db.transaction(names), done = completed(tx)
    const stores = await Promise.all(names.map(async (name) => [name, (await request(tx.objectStore(name).getAll()) as { accountId?: string }[]).filter((row) => row?.accountId === accountId)]))
    await done
    return { databaseVersion: db.version, stores: Object.fromEntries(stores) }
  } finally { db.close() }
}

/** Stable-ID events and their jobs are committed atomically, before the producer reports a save. */
export class DurableOutbox implements SaveParticipant {
  private db: Promise<IDBDatabase>
  private active = true
  private initialized: Promise<void>
  private problem: string | null = null
  private pumping: Promise<void> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private view: SyncStatus = 'checking_account'
  private enqueues = new Set<Promise<DurableEvent>>()
  private failedEnqueues = new Map<string, { id: string; payload: unknown; reason: string }>()

  constructor(readonly scope: SyncScope, readonly deletionGeneration: number, private writer: EventWriter,
    private factory: IDBFactory = indexedDB, private now = () => Date.now()) {
    this.db = openOutbox(factory)
    this.initialized = this.activate().then(() => this.schedule(0)).catch((e) => { this.problem = String(e); this.publish('blocked') })
  }
  status() { return this.problem || this.failedEnqueues.size ? 'blocked' : this.enqueues.size ? 'saving' : this.view }
  private publish(status: SyncStatus) {
    this.view = this.problem || this.failedEnqueues.size ? 'blocked' : status
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('qp-sync-changed'))
  }
  private async refreshStatus() {
    if (!this.active) return
    if (this.problem) { this.publish('blocked'); return }
    try {
      const jobs = await this.transaction(['jobs', 'scopes'], 'readonly', async (tx) => {
        await this.check(tx)
        return (await request(tx.objectStore('jobs').getAll()) as Job[]).filter((j) => j.accountId === this.scope.accountId)
      })
      this.publish(jobs.some((j) => j.state === 'conflict') ? 'conflict' : jobs.some((j) => j.state === 'blocked') ? 'blocked'
        : jobs.some((j) => j.state !== 'acked') ? 'offline_local_changes' : 'saved_to_account')
    } catch (e) { this.problem = String(e); this.publish('blocked') }
  }
  private async transaction<T>(stores: string[], mode: IDBTransactionMode, work: (tx: IDBTransaction) => Promise<T>): Promise<T> {
    const tx = (await this.db).transaction(stores, mode), done = completed(tx)
    try { const value = await work(tx); await done; return value }
    catch (e) { try { tx.abort() } catch { /* Already aborted. */ } await done.catch(() => {}); throw e }
  }
  private async activate() {
    await this.transaction(['scopes'], 'readwrite', async (tx) => {
      if (!this.active) throw new Error('Account changed')
      const store = tx.objectStore('scopes'), meta = await request(store.get(this.scope.accountId)) as Meta | undefined
      if (meta && meta.epoch > this.scope.epoch) throw new Error('Stale account epoch')
      store.put({ accountId: this.scope.accountId, epoch: this.scope.epoch, watermark: meta?.watermark ?? 0, deletionGeneration: this.deletionGeneration } satisfies Meta)
    })
  }
  private async check(tx: IDBTransaction) {
    const meta = await request(tx.objectStore('scopes').get(this.scope.accountId)) as Meta | undefined
    if (!this.active || !meta || meta.epoch !== this.scope.epoch) throw new Error('Account changed')
    return meta
  }
  private fail(e: unknown): never { this.problem = String(e); this.publish('blocked'); throw e }
  enqueue(id: string, payload: unknown): Promise<DurableEvent> {
    const pending = this.store(id, payload).then((event) => {
      this.failedEnqueues.delete(id); return event
    }).catch((e) => {
      if (this.active) this.failedEnqueues.set(id, { id, payload, reason: String(e) })
      return this.fail(e)
    })
    this.enqueues.add(pending); this.publish('saving')
    void pending.finally(() => this.enqueues.delete(pending)).catch(() => {})
    return pending
  }
  private async store(id: string, payload: unknown): Promise<DurableEvent> {
    await this.initialized
    if (this.problem) throw new Error(this.problem)
    if (!id || id.length > 120) throw new Error('A stable event ID is required')
    const serialized = canonical(payload), hash = await digest(serialized)
    try {
      const event = await this.transaction(['events', 'jobs', 'scopes'], 'readwrite', async (tx) => {
        const meta = await this.check(tx), events = tx.objectStore('events'), jobs = tx.objectStore('jobs')
        const prior = await request(events.get([this.scope.accountId, id])) as DurableEvent | undefined
        if (prior) {
          if (prior.digest !== hash || prior.deletionGeneration !== this.deletionGeneration) throw new Error('Immutable event ID reused with different content or generation')
          return prior
        }
        const event: DurableEvent = { schema: 1, accountId: this.scope.accountId, id, deletionGeneration: this.deletionGeneration, serialized, digest: hash, localRevision: ++meta.watermark }
        events.add(event)
        jobs.add({ accountId: this.scope.accountId, id, schema: 1, attempts: 0, due: this.now(), state: 'pending' } satisfies Job)
        tx.objectStore('scopes').put(meta)
        return event
      })
      this.publish('saved_on_device'); this.schedule(0)
      return event
    } catch (e) { return this.fail(e) }
  }
  /** Retry operational failures without discarding events or resetting their schema. */
  async retry() {
    this.problem = null
    await this.initialized
    try { await this.pump() } catch (e) { this.fail(e) }
  }
  private schedule(delay: number) {
    if (!this.active || this.retryTimer) return
    this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.pump().catch((e) => { this.problem = String(e) }) }, delay)
  }
  private pump() {
    this.pumping ??= this.drain().finally(async () => { this.pumping = null; await this.refreshStatus() })
    return this.pumping
  }
  private async drain() {
    await this.initialized
    if (!this.active || this.problem) return
    this.publish('saving')
    for (;;) {
      const claimed = await this.transaction(['events', 'jobs', 'scopes'], 'readwrite', async (tx) => {
        const meta = await this.check(tx), jobs = tx.objectStore('jobs')
        const all = (await request(jobs.getAll()) as Job[]).filter((j) => j.accountId === this.scope.accountId)
        const candidates = all.filter((j) => j.state === 'pending' || (j.state === 'leased' && (j.epoch !== this.scope.epoch || (j.leaseUntil ?? 0) <= this.now())))
        const job = candidates.find((j) => j.due <= this.now())
        if (!job) {
          const due = all.filter((j) => j.state === 'pending' || j.state === 'leased').map((j) => j.state === 'leased' ? j.leaseUntil ?? this.now() : j.due)
          if (due.length) this.schedule(Math.max(1, Math.min(...due) - this.now()))
          return null
        }
        const event = await request(tx.objectStore('events').get([job.accountId, job.id])) as DurableEvent | undefined
        if (!event || event.schema !== 1 || job.schema !== 1 || event.deletionGeneration !== meta.deletionGeneration) {
          job.state = 'blocked'; job.reason = 'Unsupported schema, missing event or deleted generation; retained for export'; jobs.put(job)
          return { invalid: true } as const
        }
        job.state = 'leased'; job.epoch = this.scope.epoch; job.lease = crypto.randomUUID(); job.leaseUntil = this.now() + 30_000
        jobs.put(job)
        return { event, job }
      })
      if (!claimed) return
      if ('invalid' in claimed) continue
      let ack: EventAck | null = null, network: unknown
      try { ack = await this.writer(claimed.event, this.scope) } catch (e) { network = e }
      if (!this.active) return
      await this.transaction(['jobs', 'scopes'], 'readwrite', async (tx) => {
        await this.check(tx)
        const jobs = tx.objectStore('jobs'), job = await request(jobs.get([this.scope.accountId, claimed.event.id])) as Job | undefined
        if (!job || job.lease !== claimed.job.lease || job.epoch !== this.scope.epoch) return
        if (ack?.status === 'accepted' && ack.id === claimed.event.id && ack.digest === claimed.event.digest && ack.deletionGeneration === claimed.event.deletionGeneration) {
          job.state = 'acked'; delete job.reason
        } else if (ack?.status === 'blocked' || ack?.status === 'conflict') { job.state = ack.status; job.reason = ack.reason }
        else {
          job.state = 'pending'; job.attempts++; job.due = this.now() + Math.min(300_000, 1000 * 2 ** Math.min(job.attempts, 9))
          job.reason = network ? 'Upload unavailable' : 'Unverifiable ACK'
        }
        delete job.lease; delete job.leaseUntil
        jobs.put(job)
      })
    }
  }
  async barrier(scope: SyncScope): Promise<SaveBarrier> {
    if (!matches(scope, this.scope)) throw new Error('Account changed')
    await this.initialized
    await Promise.all([...this.enqueues])
    if (this.problem) throw new Error(this.problem)
    if (this.failedEnqueues.size) throw new Error('Some events are only in memory; retry enqueue or export before leaving')
    return this.transaction(['events', 'scopes'], 'readonly', async (tx) => {
      const meta = await this.check(tx)
      const events = (await request(tx.objectStore('events').getAll()) as DurableEvent[]).filter((e) => e.accountId === scope.accountId)
      return { scope, watermark: meta.watermark, targets: events.map((e) => ({ kind: 'evidence' as const, id: e.id, localRevision: e.localRevision, digest: e.digest })) }
    })
  }
  async flush(barrier: SaveBarrier, timeoutMs: number): Promise<FlushResult> {
    const result = (status: FlushResult['status'], reasons: string[] = []): FlushResult => ({ barrier, status, pending: barrier.targets, reasons })
    if (!this.active || !matches(barrier.scope, this.scope)) return result('account_changed')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([this.pump(), new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs) })])
      if (!this.active) return result('account_changed')
      if (this.problem || this.failedEnqueues.size) return result('blocked', [this.problem ?? 'Some events are only in memory'])
      return await this.transaction(['jobs', 'events', 'scopes'], 'readonly', async (tx) => {
        await this.check(tx)
        const jobs = await request(tx.objectStore('jobs').getAll()) as Job[], events = await request(tx.objectStore('events').getAll()) as DurableEvent[]
        const pending = barrier.targets.filter((t) => !jobs.some((j) => j.accountId === this.scope.accountId && j.id === t.id && j.state === 'acked') ||
          !events.some((e) => e.accountId === this.scope.accountId && e.id === t.id && e.digest === t.digest))
        const blocked = jobs.filter((j) => j.accountId === this.scope.accountId && (j.state === 'blocked' || j.state === 'conflict'))
        const active = this.enqueues.size || jobs.some((j) => j.accountId === this.scope.accountId && j.state !== 'acked')
        return { barrier, status: blocked.some((j) => j.state === 'conflict') ? 'conflict' : blocked.length ? 'blocked' : pending.length || active ? 'timeout' : 'saved',
          pending, reasons: blocked.map((j) => j.reason ?? 'Outbox blocked') }
      })
    } catch (e) { return result('blocked', [String(e)]) }
    finally { if (timer) clearTimeout(timer) }
  }
  async exportAccount(scope: SyncScope): Promise<Blob> {
    if (!matches(scope, this.scope)) throw new Error('Account changed')
    await Promise.allSettled([...this.enqueues])
    try { return await this.transaction(['events', 'jobs'], 'readonly', async (tx) => {
      const events = (await request(tx.objectStore('events').getAll()) as DurableEvent[]).filter((e) => e.accountId === scope.accountId)
      const jobs = (await request(tx.objectStore('jobs').getAll()) as Job[]).filter((e) => e.accountId === scope.accountId)
      return new Blob([JSON.stringify({ schema: 1, accountId: scope.accountId, events, jobs, failedEnqueues: [...this.failedEnqueues.values()], problem: this.problem })], { type: 'application/json' })
    }) } catch {
      return new Blob([JSON.stringify({ schema: 'outbox.recovery', accountId: scope.accountId, recovery: await exportStoredAccount(scope.accountId, this.factory), failedEnqueues: [...this.failedEnqueues.values()], problem: this.problem })], { type: 'application/json' })
    }
  }
  stop(scope: SyncScope) {
    if (!matches(scope, this.scope)) return
    this.active = false
    if (this.retryTimer) clearTimeout(this.retryTimer)
  }
  async clearAccount(scope: SyncScope): Promise<void> {
    if (!matches(scope, this.scope)) throw new Error('Account changed')
    this.stop(scope)
    await this.initialized
    await this.transaction(['events', 'jobs', 'scopes'], 'readwrite', async (tx) => {
      const meta = await request(tx.objectStore('scopes').get(scope.accountId)) as Meta | undefined
      if (meta && meta.epoch !== scope.epoch) throw new Error('Cannot clear a newer account epoch')
      for (const name of ['events', 'jobs']) {
        const store = tx.objectStore(name), keys = await request(store.getAllKeys())
        for (const key of keys) if (Array.isArray(key) && key[0] === scope.accountId) store.delete(key)
      }
      tx.objectStore('scopes').delete(scope.accountId)
    })
    ;(await this.db).close()
    this.failedEnqueues.clear()
  }
}
