import { activeSync, type PracticeSync, type SaveParticipant } from './sync'
import type { SaveBarrier, SyncScope, SyncStatus } from './syncRevision'

type Loader = () => Promise<{
  initializeLearningEvidence: (sync: PracticeSync) => Promise<void>
}>
const bootstraps = new WeakMap<PracticeSync, EvidenceBootstrap>()

/** Exists before the lazy module or its database can be opened. */
class EvidenceBootstrap implements SaveParticipant {
  private pending: Promise<void> | null = null
  private ready: string | null = null
  private attempted: string | null = null
  private error: string | null = null
  private active = true

  constructor(private sync: PracticeSync, private load: Loader) {
    sync.registerParticipant(this)
  }
  private live() { return this.active && activeSync() === this.sync }
  private key() {
    const generations = this.sync.deletionGenerations()
    return this.sync.isReconciled() && generations ? JSON.stringify(generations) : null
  }
  start(retry = false): Promise<void> {
    if (!this.live()) return Promise.resolve()
    if (this.pending) return this.pending
    const key = this.key()
    if (key && (this.ready === key || (!retry && this.attempted === key))) return Promise.resolve()
    this.error = null
    this.pending = Promise.resolve().then(async () => {
      if (!this.sync.isReconciled()) await this.sync.start()
      if (!this.live()) return
      const generation = this.key()
      if (!generation) throw new Error('Account reconciliation must finish before evidence recovery')
      this.attempted = generation
      const { initializeLearningEvidence } = await this.load()
      if (!this.live()) return
      await initializeLearningEvidence(this.sync)
      if (!this.live()) return
      if (this.key() !== generation) throw new Error('Evidence history changed during recovery; retry')
      this.ready = generation
    }).catch((e) => {
      if (this.live()) this.error = String(e)
    }).finally(() => {
      this.pending = null
      if (this.live()) window.dispatchEvent(new Event('qp-sync-changed'))
    })
    return this.pending
  }
  status(): SyncStatus {
    return this.error ? 'blocked' : this.pending || !this.key() || this.ready !== this.key()
      ? 'checking_account' : 'saved_to_account'
  }
  async barrier(scope: SyncScope): Promise<SaveBarrier> {
    await this.start(true)
    return { scope, watermark: 0, targets: [] }
  }
  async flush(barrier: SaveBarrier) {
    const status = !this.live() ? 'account_changed' as const
      : this.status() === 'saved_to_account' ? 'saved' as const : 'blocked' as const
    return { barrier, status, pending: [],
      reasons: status === 'saved' ? [] : [this.error ?? 'Evidence recovery has not completed'] }
  }
  async exportAccount() {
    return new Blob([JSON.stringify({ source: 'evidence-bootstrap', error: this.error, status: this.status() })], { type: 'application/json' })
  }
  async clearAccount() { this.active = false }
  stop() { this.active = false }
}

/** Synchronously register the save fence; retries never need a curriculum mount. */
export function startEvidenceBootstrap(
  sync: PracticeSync,
  retry = false,
  load: Loader = () => import('../curriculum/learning/runtime'),
) {
  let bootstrap = bootstraps.get(sync)
  if (!bootstrap) {
    bootstrap = new EvidenceBootstrap(sync, load)
    bootstraps.set(sync, bootstrap)
  }
  return bootstrap.start(retry)
}
