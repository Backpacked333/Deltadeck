import type { SupabaseClient } from '@supabase/supabase-js'
import { emptyProgress, HAND_LIMIT, LEARNING_SAVED_EVENT, LEGACY_KEY, sanitizeProgress, STORAGE_KEY } from '../lib/storage'
import type { HandRecord, Progress } from '../lib/storage'
import { byteLength, canonical, digest } from './syncRevision'
import type { FlushResult, Lifecycle, RemoteRevision, RevisionKind, RevisionResult, RevisionWrite, SaveBarrier, SyncScope, SyncStatus } from './syncRevision'
export type { FlushResult, SaveBarrier, SyncScope, SyncStatus } from './syncRevision'

export const LEARNING_KEY = 'quantpoker.learning.v2'
export const LEARNING_V1_KEY = 'quantpoker.learning.v1'
export const LEARNING_BACKUP_KEY = 'quantpoker.learning.v2.backup'
const OWNER_KEY = 'qp.learningOwner'
const PREFIX = 'qp.sync.v1.'
const GUEST_KEY = `${PREFIX}unclaimed`
export const RECORD_MAX_BYTES = 8192
export const CURRICULUM_MAX_BYTES = 1_200_000
export const SYNC_CHANGED = 'qp-sync-changed'
export type TrainerDoc = Pick<Progress, 'settings' | 'lessons' | 'onboarded' | 'guidedComplete'>
export const trainerDoc = ({ settings, lessons, onboarded, guidedComplete }: Progress): TrainerDoc => ({ settings, lessons, onboarded, guidedComplete })
type Conflict = { base: unknown; local: unknown; remote: unknown; serialized?: string | null; revision: number; lifecycle: Lifecycle; reason: string }
type Entry = {
  kind: RevisionKind; id: string; local: string; localRevision: number;
  base: string | null; serverRevision: number; lifecycle: Lifecycle;
  generation: number; mutation?: RevisionWrite; conflict?: Conflict
}
type Journal = { version: 1; generations: { practice: number; learning: number } | null; entries: Entry[]; clearedAt: number; clear?: { at: number; cutoff: number; request: object } }
type AccountRead = { protocol: 1; accountId: string; deletionGenerations: { practice: number; learning: number };
  trainer: RemoteRevision | null; curriculum: RemoteRevision | null;
  hands: (RemoteRevision & { id: string })[]; cursor: string | null }
type Hooks = { merge: (update: (current: Progress) => Progress) => void; reloadLearning: () => void }
let epoch = Date.now() * 1000 + Math.floor(Math.random() * 1000)
let running: PracticeSync | null = null
export const activeSync = () => running
const setRunning = (sync: PracticeSync | null) => { running = sync }
const keyOf = (kind: RevisionKind, id: string) => `${kind}:${id}`
const errorText = (e: unknown) => e instanceof Error ? e.message : 'Account service unavailable'
const storageKeys = () => Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!).filter(Boolean)

/** Safe union only for disjoint IDs; divergent same-ID data needs revision reconciliation. */
export function mergeHands(local: HandRecord[], remote: HandRecord[]): HandRecord[] {
  const hands = new Map(remote.map((h) => [h.id, h]))
  for (const h of local) if (!hands.has(h.id)) hands.set(h.id, h)
  return [...hands.values()].sort((a, b) => (a.at ?? 0) - (b.at ?? 0)).slice(-HAND_LIMIT)
}

export class PracticeSync {
  readonly scope: SyncScope
  private readonly key: string
  private entries = new Map<string, Entry>()
  private generations: Journal['generations'] = null
  private clearedAt = 0
  private clearing: Journal['clear']
  private latest: Progress | null = null
  private ready = false
  private stopped = false
  private initialized = false
  private starting: Promise<void> | null = null
  private sending: Promise<void> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private wait = 5000
  private watermark = 0
  private problems = new Map<string, string>()
  private networkError = false
  private guest: { progress: Progress | null; curriculum: string | null } | null = null
  private participants = new Set<SaveParticipant>()

  constructor(private client: SupabaseClient, readonly userId: string, private hooks: Hooks) {
    running?.stop()
    this.scope = { accountId: userId, epoch: ++epoch }
    let tab = 'unavailable'
    try {
      tab = sessionStorage.getItem(`${PREFIX}tab`) ?? crypto.randomUUID()
      sessionStorage.setItem(`${PREFIX}tab`, tab)
    } catch { this.problems.set('session-storage', 'Browser session storage is unavailable') }
    this.key = `${PREFIX}${userId}.${tab}`
    try {
      const raw = localStorage.getItem(this.key)
      if (raw) {
        const journal = JSON.parse(raw) as Journal
        if (journal.version !== 1 || !Array.isArray(journal.entries)) throw new Error('Unsupported sync journal; export before recovery')
        this.entries = new Map(journal.entries.map((e) => [keyOf(e.kind, e.id), e]))
        this.generations = journal.generations
        this.clearedAt = journal.clearedAt
        this.clearing = journal.clear
        this.watermark = Math.max(0, ...journal.entries.map((e) => e.localRevision))
      }
      const guest = localStorage.getItem(GUEST_KEY)
      if (guest) this.guest = JSON.parse(guest)
      // A tab ID can disappear on browser restart. Recovery never depends on that ID surviving.
      for (const key of storageKeys().filter((k) => k.startsWith(`${PREFIX}${userId}.`) && k !== this.key)) {
        const recovered = JSON.parse(localStorage.getItem(key)!) as Journal
        if (recovered.version !== 1) { this.problems.set('other-journal', 'Unsupported recovery journal retained for export'); continue }
        for (const e of recovered.entries.filter((e) => e.local !== e.base || e.mutation || e.conflict)) {
          const k = keyOf(e.kind, e.id), current = this.entries.get(k)
          if (!current) this.entries.set(k, e)
          else if (current.local !== e.local) current.conflict = { base: current.base && JSON.parse(current.base), local: JSON.parse(current.local),
            remote: JSON.parse(e.local), revision: current.serverRevision, lifecycle: current.lifecycle, reason: 'other_tab_recovery' }
          this.watermark = Math.max(this.watermark, e.localRevision)
        }
      }
    } catch (e) { this.problems.set('journal', errorText(e)) }
    setRunning(this)
    window.addEventListener('online', this.retry)
    window.addEventListener(LEARNING_SAVED_EVENT, this.learningSaved)
    window.addEventListener('storage', this.storageChanged)
  }
  private live = () => !this.stopped && running === this
  private emit() { if (this.live()) window.dispatchEvent(new Event(SYNC_CHANGED)) }
  stop() {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    window.removeEventListener('online', this.retry)
    window.removeEventListener(LEARNING_SAVED_EVENT, this.learningSaved)
    window.removeEventListener('storage', this.storageChanged)
    for (const p of this.participants) p.stop(this.scope)
    if (running === this) setRunning(null)
  }

  /** Register before the first read, including edits during a failed initial pull. */
  note(progress: Progress) {
    if (!this.live()) return
    if (!this.initialized) {
      this.initialized = true
      if (!this.entries.size && !this.clearing) this.clearedAt = progress.historyClearedAt ?? 0
      try {
        const learning = localStorage.getItem(LEARNING_KEY)
        const owner = localStorage.getItem(OWNER_KEY)
        if (!progress.owner && (progress.hands.length || progress.lessons.length || learning)) {
          this.guest = { progress, curriculum: !owner ? learning : null }
          localStorage.setItem(GUEST_KEY, JSON.stringify(this.guest))
        }
        if (owner !== this.userId && !(owner === null && progress.owner === this.userId)) {
          localStorage.removeItem(LEARNING_KEY)
          localStorage.removeItem(LEARNING_V1_KEY)
          localStorage.removeItem(LEARNING_BACKUP_KEY)
          localStorage.setItem(OWNER_KEY, this.userId)
          this.hooks.reloadLearning()
        }
        localStorage.setItem(OWNER_KEY, this.userId)
      } catch (e) { this.problems.set('source-storage', errorText(e)) }
      if (progress.owner !== this.userId) {
        progress = { ...emptyProgress(), owner: this.userId }
        const initial = progress
        this.hooks.merge((current) => this.live() ? initial : current)
      }
    }
    if (progress.owner !== this.userId) return
    this.latest = progress
    if (this.clearChanged() && !this.clearing) this.prepareClear()
    this.capture('trainer', 'trainer', trainerDoc(progress))
    for (const hand of progress.hands) this.capture('practice_hand', hand.id, hand)
    this.learningSaved()
    this.persist()
    if (this.ready && this.pending()) this.schedule(0)
  }
  private capture(kind: RevisionKind, id: string, payload: unknown) {
    const local = canonical(payload), key = keyOf(kind, id), old = this.entries.get(key)
    if (old && canonical(JSON.parse(old.local)) === local) return
    const next: Entry = old ? { ...old, local, localRevision: ++this.watermark } : {
      kind, id, local, localRevision: ++this.watermark, base: null, serverRevision: 0,
      generation: this.generations?.[kind === 'practice_hand' ? 'practice' : 'learning'] ?? 0, lifecycle: 'provisional',
    }
    if (next.conflict) next.conflict = { ...next.conflict, local: payload }
    this.entries.set(key, next)
    this.problems.delete(key)
  }
  private persist() {
    if (!this.live() || this.problems.has('journal')) return
    try {
      localStorage.setItem(this.key, JSON.stringify({ version: 1, generations: this.generations,
        entries: [...this.entries.values()], clearedAt: this.clearedAt, clear: this.clearing } satisfies Journal))
      this.problems.delete('storage')
    } catch (e) { this.problems.set('storage', `Local recovery copy failed: ${errorText(e)}`) }
    this.emit()
  }
  private learningSaved = () => {
    if (!this.live() || !this.initialized) return
    try {
      if (localStorage.getItem(OWNER_KEY) !== this.userId) return
      const raw = localStorage.getItem(LEARNING_KEY)
      if (raw) this.capture('curriculum', 'curriculum', raw)
    } catch (e) { this.problems.set('source-storage', errorText(e)) }
    this.persist()
    if (this.ready && this.pending()) this.schedule(0)
  }
  private storageChanged = (event: StorageEvent) => {
    if (event.key === OWNER_KEY && event.newValue !== this.userId) this.stop()
    else if (event.key === LEARNING_KEY && event.newValue !== event.oldValue)
      this.problems.set('other-tab', 'Learning changed in another tab. Export this tab and reload to reconcile.')
    this.emit()
  }

  start(): Promise<void> {
    if (!this.live()) return Promise.resolve()
    if (this.starting) return this.starting
    this.starting = this.pull().catch((e) => {
      if (!this.live()) return
      this.networkError = true; this.problems.set('read', errorText(e)); this.schedule()
    }).finally(() => { this.starting = null; this.emit() })
    return this.starting
  }
  private async pull() {
    if (!this.initialized) this.note(sanitizeProgress(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')))
    let cursor: string | null = null, account: AccountRead | null = null
    const rows: (RemoteRevision & { id: string })[] = []
    do {
      const { data, error } = await this.client.rpc('read_learning_sync_v1', { p: { protocol: 1, cursor } })
      if (!this.live()) return
      if (error) throw error
      const page = data as AccountRead
      if (page?.protocol !== 1 || page.accountId !== this.userId) throw new Error('Account sync upgrade/reconciliation required')
      for (const row of [...page.hands, page.trainer, page.curriculum].filter((r): r is RemoteRevision => r !== null)) {
        if (typeof row.serialized !== 'string' || await digest(row.serialized) !== row.digest || canonical(JSON.parse(row.serialized)) !== canonical(row.payload))
          throw new Error('Account read payload could not be verified')
      }
      if (!this.live()) return
      if (account && canonical(account.deletionGenerations) !== canonical(page.deletionGenerations)) throw new Error('History changed during read; retry reconciliation')
      account = page; rows.push(...page.hands)
      if (cursor && page.cursor && page.cursor <= cursor) throw new Error('Invalid sync cursor')
      cursor = page.cursor
    } while (cursor)
    const incoming = new Map<string, RemoteRevision>()
    for (const row of rows) incoming.set(keyOf('practice_hand', row.id), row)
    if (account.trainer) incoming.set('trainer:trainer', account.trainer)
    if (account.curriculum) incoming.set('curriculum:curriculum', account.curriculum)
    for (const [key, entry] of this.entries) {
      const remote = incoming.get(key), base = remote?.serialized ?? null
      const same = base !== null && canonical(JSON.parse(entry.local)) === canonical(remote!.payload)
      const generation = account.deletionGenerations[entry.kind === 'practice_hand' ? 'practice' : 'learning']
      if (entry.generation !== generation && !same) {
        entry.conflict = { base: entry.base && JSON.parse(entry.base), local: JSON.parse(entry.local), remote: remote?.payload ?? null,
          serialized: base, revision: remote?.revision ?? 0, lifecycle: remote?.lifecycle ?? 'provisional', reason: 'deleted_on_account' }
      } else if (same || entry.local === entry.base || (entry.base === null && remote && entry.kind === 'trainer' && entry.local === canonical(trainerDoc(emptyProgress())))) {
        if (remote) { entry.local = base!; entry.base = base; entry.serverRevision = remote.revision; entry.lifecycle = remote.lifecycle; entry.generation = generation; delete entry.mutation }
        else { this.entries.delete(key); continue }
      } else if (remote && entry.mutation?.serialized === base && remote.revision === entry.mutation.baseRevision + 1) {
        entry.base = base; entry.serverRevision = remote.revision; entry.lifecycle = remote.lifecycle; entry.generation = generation; delete entry.mutation
      } else if ((remote?.revision ?? 0) !== entry.serverRevision || (entry.base === null && remote)) {
        entry.conflict = { base: entry.base && JSON.parse(entry.base), local: JSON.parse(entry.local), remote: remote?.payload ?? null,
          serialized: base, revision: remote?.revision ?? 0, lifecycle: remote?.lifecycle ?? 'provisional', reason: 'concurrent_changes' }
      }
      incoming.delete(key)
    }
    for (const [key, remote] of incoming) {
      const [kind, ...id] = key.split(':')
      this.entries.set(key, { kind: kind as RevisionKind, id: id.join(':'), local: remote.serialized, base: remote.serialized,
        localRevision: ++this.watermark, serverRevision: remote.revision, generation: account.deletionGenerations[kind === 'practice_hand' ? 'practice' : 'learning'], lifecycle: remote.lifecycle })
    }
    this.generations = account.deletionGenerations; this.ready = true; this.networkError = false; this.problems.delete('read')
    this.applyLocal(); this.persist()
    if (this.pending()) this.schedule(0)
  }
  private applyLocal() {
    if (!this.live()) return
    const trainer = this.entries.get('trainer:trainer')
    const hands = [...this.entries.values()].filter((e) => e.kind === 'practice_hand' && (!this.clearing || (e.localRevision > this.clearing.cutoff && e.serverRevision === 0))).map((e) => JSON.parse(e.local) as HandRecord)
    const clearAt = Math.max(this.clearedAt, this.clearing?.at ?? 0, this.latest?.historyClearedAt ?? 0)
    const progress: Progress = { ...emptyProgress(), ...(trainer ? sanitizeProgress(JSON.parse(trainer.local)) : {}),
      hands: mergeHands([], hands), owner: this.userId, ...(clearAt ? { historyClearedAt: clearAt } : {}) }
    this.latest = progress
    this.hooks.merge((current) => this.live() ? progress : current)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(progress))
      const curriculum = this.entries.get('curriculum:curriculum')
      if (curriculum) localStorage.setItem(LEARNING_KEY, JSON.parse(curriculum.local) as string)
      else localStorage.removeItem(LEARNING_KEY)
      localStorage.setItem(OWNER_KEY, this.userId)
      this.hooks.reloadLearning()
      this.problems.delete('source-storage')
    } catch (e) { this.problems.set('source-storage', errorText(e)) }
  }

  conflicts() { return [...this.entries.values()].filter((e) => e.conflict).map((e) => ({ key: keyOf(e.kind, e.id), ...e.conflict! })) }
  resolveConflict(key: string, choice: 'local' | 'remote') {
    const e = this.entries.get(key), c = e?.conflict
    if (!this.live() || !e || !c) return
    if (choice === 'local' && c.reason === 'deleted_on_account') throw new Error('Deleted evidence cannot be re-stamped; export it or accept account deletion')
    if (c.reason === 'other_tab_recovery') {
      if (choice === 'remote') e.local = canonical(c.remote)
      delete e.conflict; delete e.mutation; e.localRevision = ++this.watermark
      this.applyLocal(); this.persist(); this.schedule(0); return
    }
    e.base = c.remote === null ? null : c.serialized ?? canonical(c.remote); e.serverRevision = c.revision; e.lifecycle = c.lifecycle
    e.generation = this.generations![e.kind === 'practice_hand' ? 'practice' : 'learning']
    delete e.conflict; delete e.mutation
    if (choice === 'remote') { if (e.base === null) this.entries.delete(key); else e.local = e.base }
    e.localRevision = ++this.watermark
    this.applyLocal(); this.persist(); this.schedule(0)
  }
  hasUnclaimed() { return this.guest !== null }
  isReconciled() { return this.ready }
  deletionGenerations() { return this.generations ? { ...this.generations } : null }
  claimGuest(accountId: string) {
    if (!this.live() || accountId !== this.userId || !this.ready || !this.guest) throw new Error('Confirm the current account after reconciliation')
    const guest = this.guest
    for (const hand of guest.progress?.hands ?? []) this.importGuest('practice_hand', hand.id, hand)
    if (guest.progress?.lessons.length) {
      const current = JSON.parse(this.entries.get('trainer:trainer')!.local) as TrainerDoc
      this.capture('trainer', 'trainer', { ...current, lessons: [...new Set([...current.lessons, ...guest.progress.lessons])] })
    }
    if (guest.curriculum) this.importGuest('curriculum', 'curriculum', guest.curriculum)
    this.applyLocal(); this.persist()
    if (this.problems.has('storage')) throw new Error('Import recovery copy failed; guest original retained')
    this.guest = null; localStorage.removeItem(GUEST_KEY); this.schedule(0); this.emit()
  }
  private importGuest(kind: RevisionKind, id: string, payload: unknown) {
    const e = this.entries.get(keyOf(kind, id))
    if (e && e.local !== canonical(payload)) e.conflict = { base: e.base && JSON.parse(e.base), local: payload, remote: JSON.parse(e.local), revision: e.serverRevision, lifecycle: e.lifecycle, reason: 'guest_import' }
    this.capture(kind, id, payload)
  }
  discardGuest() { localStorage.removeItem(GUEST_KEY); this.guest = null; this.emit() }
  reportSourceBlocked(source: string, reason: string | null) {
    if (reason) this.problems.set(`producer:${source}`, reason); else this.problems.delete(`producer:${source}`)
    this.emit()
  }
  /** Adapter for in-memory curriculum work when its own persistence fails. */
  noteCurriculum(raw: string, storageError?: string) {
    if (!this.live() || !this.initialized) return
    this.capture('curriculum', 'curriculum', raw); this.reportSourceBlocked('curriculum', storageError ?? null)
    this.persist(); if (this.ready) this.schedule(0)
  }
  registerParticipant(participant: SaveParticipant) { this.participants.add(participant); return () => this.participants.delete(participant) }
  pending() { return !this.ready || this.entriesDirty().length > 0 || !!this.clearing || this.clearChanged() || this.problems.size > 0 || this.conflicts().length > 0 }
  private entriesDirty() { return [...this.entries.values()].filter((e) => e.local !== e.base || e.mutation) }
  private clearChanged() { return (this.latest?.historyClearedAt ?? 0) > this.clearedAt }
  private prepareClear() {
    this.clearing = { at: this.latest!.historyClearedAt!, cutoff: this.watermark,
      request: { protocol: 1, accountId: this.userId, mutationId: crypto.randomUUID(), scope: 'practice', expectedGeneration: this.generations?.practice ?? 0 } }
  }
  status(): SyncStatus {
    if ([...this.problems.keys()].some((k) => k !== 'read')) return 'blocked'
    if (this.conflicts().length) return 'conflict'
    if (!this.ready) return this.networkError ? 'unable_to_verify' : 'checking_account'
    for (const p of this.participants) {
      const status = p.status?.(this.scope)
      if (status && status !== 'saved_to_account') return status
    }
    if (this.networkError) return 'offline_local_changes'
    return this.pending() || this.sending ? 'saving' : 'saved_to_account'
  }
  private retry = () => { this.wait = 5000; this.schedule(0) }
  private schedule(delay = this.wait) {
    if (!this.live()) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void (this.ready ? this.send() : this.start()).finally(() => {
        if (this.pending()) { this.wait = Math.min(this.wait * 2, 300_000); this.schedule() }
      })
    }, delay)
  }
  private send() {
    if (!this.sending) this.sending = this.drain().catch(() => { if (this.live()) this.networkError = true }).finally(() => { this.sending = null; this.emit() })
    return this.sending
  }
  private async drain() {
    if (!this.ready || !this.live() || this.problems.has('journal')) return
    this.networkError = false
    if (this.clearChanged() || this.clearing) {
      if (!this.clearing) this.prepareClear()
      this.persist()
      if (this.problems.has('storage')) return
      const clearing = this.clearing!
      const { data, error } = await this.client.rpc('clear_learning_scope_v1', { p: clearing.request })
      if (!this.live()) return
      if (error) throw error
      const request = clearing.request as { mutationId: string; expectedGeneration: number }
      if (data?.status !== 'accepted' || data.mutationId !== request.mutationId || data.deletionGeneration !== request.expectedGeneration + 1) { this.problems.set('deletion', 'History deletion conflicted or its receipt could not be verified; export and reconcile before retrying'); return }
      this.generations!.practice = data.deletionGeneration
      this.clearedAt = clearing.at; this.clearing = undefined
      for (const [key, e] of this.entries) if (e.kind === 'practice_hand') {
        if (e.localRevision <= clearing.cutoff || e.serverRevision !== 0) this.entries.delete(key)
        else e.generation = data.deletionGeneration
      }
      this.applyLocal(); this.persist()
    }
    // Re-read current entries after every ACK; no unrelated edit is needed to drain final grading.
    for (;;) {
      if (!this.live() || this.clearChanged() || this.clearing) return
      const entry = this.entriesDirty().find((e) => !e.conflict && !this.problems.has(keyOf(e.kind, e.id)))
      if (!entry || this.problems.has('storage')) return
      const key = keyOf(entry.kind, entry.id)
      if (byteLength(entry.local) > (entry.kind === 'curriculum' ? CURRICULUM_MAX_BYTES : RECORD_MAX_BYTES)) {
        this.problems.set(key, 'Record exceeds account size limit; retained for export'); this.emit(); continue
      }
      if (!entry.mutation) {
        const serialized = entry.local, payload: unknown = JSON.parse(serialized)
        const life: Lifecycle = entry.kind === 'practice_hand' && (payload as HandRecord).graded === false ? 'provisional'
          : entry.kind === 'practice_hand' && entry.lifecycle !== 'provisional' && entry.serverRevision ? 'corrected' : 'final'
        const hash = await digest(serialized)
        if (!this.live()) return
        const mutation: RevisionWrite = { protocol: 1, mutationId: crypto.randomUUID(), accountId: this.userId, kind: entry.kind, id: entry.id,
          baseRevision: entry.serverRevision, deletionGeneration: entry.generation, digest: hash, serialized, payload,
          lifecycle: life, supersedesRevision: life === 'corrected' ? entry.serverRevision : null }
        entry.mutation = mutation
        this.entries.get(key)!.mutation = mutation
        this.persist()
        if (this.problems.has('storage')) return
      }
      const sent = entry.mutation
      const { data, error } = await this.client.rpc('write_learning_revision_v1', { p: sent })
      if (!this.live()) return
      if (error) throw error
      const result = data as RevisionResult
      // capture() can replace the entry while this payload is in flight.
      const current = this.entries.get(key)!
      if (result?.status === 'accepted') {
        if (result.mutationId !== sent.mutationId || result.digest !== sent.digest || result.deletionGeneration !== sent.deletionGeneration || result.revision !== sent.baseRevision + 1) throw new Error('Unverifiable acknowledgement')
        current.base = sent.serialized; current.serverRevision = result.revision; current.lifecycle = sent.lifecycle
        delete current.mutation
      } else if (result?.status === 'conflict') {
        if (result.current !== null && (!result.serialized || await digest(result.serialized) !== result.digest || canonical(JSON.parse(result.serialized)) !== canonical(result.current))) throw new Error('Unverifiable conflict payload')
        if (!this.live()) return
        current.conflict = { base: current.base && JSON.parse(current.base), local: JSON.parse(current.local), remote: result.current,
          serialized: result.serialized, revision: result.revision, lifecycle: result.lifecycle, reason: 'concurrent_changes' }
      } else this.problems.set(key, result?.status === 'deleted' ? 'Account history was deleted; stale local work is export-only. Reconcile before creating new work.' : result?.reason ?? 'Account writer upgrade required')
      this.persist()
    }
  }
  async barrier(): Promise<SaveBarrier> {
    const entries = [...this.entries.values()].map((e) => ({ ...e })), watermark = this.watermark
    return { scope: this.scope, watermark, targets: await Promise.all(entries.map(async (e) => ({ kind: e.kind, id: e.id, localRevision: e.localRevision, digest: await digest(e.local) }))) }
  }
  async flush(ms: number): Promise<FlushResult> {
    const barrier = await this.barrier(), reasons: string[] = []
    let timeout = false, timer: ReturnType<typeof setTimeout> | undefined
    const run = async () => {
      if (!this.ready) await this.start()
      if (!this.live()) return
      await this.send()
      for (const p of this.participants) {
        const result = await p.flush(await p.barrier(this.scope), ms)
        if (result.status !== 'saved') reasons.push(`Evidence outbox: ${result.status}`)
      }
    }
    try { await Promise.race([run(), new Promise<void>((resolve) => { timer = setTimeout(() => { timeout = true; resolve() }, ms) })]) }
    catch (e) { reasons.push(errorText(e)) }
    finally { if (timer) clearTimeout(timer) }
    const pending = (await this.barrier()).targets.filter((t) => { const e = this.entries.get(keyOf(t.kind as RevisionKind, t.id)); return e?.local !== e?.base || e?.conflict || !!e?.mutation })
    if (this.guest) reasons.push('Unclaimed guest work is not saved to this account; import or export before signing out')
    const status: FlushResult['status'] = !this.live() ? 'account_changed' : this.conflicts().length ? 'conflict'
      : [...this.problems.keys()].some((k) => k !== 'read') || reasons.length ? 'blocked'
      : !this.ready ? 'unknown' : timeout || this.pending() || this.sending ? 'timeout' : 'saved'
    return { barrier, status, pending, reasons: [...this.problems.values(), ...reasons] }
  }
  async exportAccount(): Promise<Blob> {
    const outboxes = await Promise.all([...this.participants].map(async (p) => JSON.parse(await (await p.exportAccount(this.scope)).text()) as unknown))
    return new Blob([JSON.stringify({ schema: 'deltadeck.recovery.v1', accountId: this.userId, progress: this.latest,
      entries: [...this.entries.values()], generations: this.generations, unclaimed: this.guest, problems: [...this.problems.values()],
      recoveryJournals: Object.fromEntries(storageKeys().filter((k) => k.startsWith(`${PREFIX}${this.userId}.`)).map((k) => [k, localStorage.getItem(k)])), outboxes }, null, 2)], { type: 'application/json' })
  }
  async clearDevice() {
    this.stop()
    for (const p of this.participants) await p.clearAccount(this.scope)
    await clearPrivateOutbox()
    clearLocalPractice(); this.entries.clear(); this.latest = null; this.guest = null
  }
}
export async function clearPrivateOutbox() {
  if (typeof indexedDB !== 'undefined') await (await import('./syncOutbox')).clearOutboxDevice()
}
export interface SaveParticipant {
  status?(scope: SyncScope): SyncStatus
  barrier(scope: SyncScope): Promise<SaveBarrier>
  flush(barrier: SaveBarrier, timeoutMs: number): Promise<FlushResult>
  exportAccount(scope: SyncScope): Promise<Blob>
  clearAccount(scope: SyncScope): Promise<void>
  stop(scope: SyncScope): void
}
export function registerSaveParticipant(participant: SaveParticipant) {
  const sync = activeSync()
  if (!sync) throw new Error('An established account sync is required')
  return sync.registerParticipant(participant)
}
export function clearLocalPractice() {
  const keys = new Set([STORAGE_KEY, LEGACY_KEY, LEARNING_KEY, LEARNING_V1_KEY, LEARNING_BACKUP_KEY, OWNER_KEY, 'qp.sync.trainer', 'qp.pendingClaim', ...storageKeys().filter((k) => k.startsWith(PREFIX))])
  const failed: string[] = []
  for (const key of keys) try { localStorage.removeItem(key) } catch { failed.push(key) }
  if (failed.length) throw new Error('Browser could not remove private learning data. Close this shared browser and clear site data before leaving it.')
}
