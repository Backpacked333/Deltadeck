import { Blob as NodeBlob } from 'node:buffer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { activeSync, PracticeSync } from '../../net/sync'
import { deferred, revisionService } from '../../net/syncTestHarness'
import { canonical, digest } from '../../net/syncRevision'
import { emptyProgress, saveProgress } from '../../lib/storage'
import type { DurableEvent, EventWriter } from '../../net/syncOutbox'
import { startEvidenceBootstrap } from '../../net/evidenceBootstrap'
import { attempt, OWNER } from './__fixtures__'
import { submission } from './evidence'

const mock = vi.hoisted(() => ({
  online: null as unknown, cleanup: vi.fn(), restoreFailure: false,
  events: [] as DurableEvent[], restored: 0, uploaded: [] as string[], beforeIngest: async () => {},
}))
vi.mock('../../net/supabase', () => ({ loadOnline: async () => mock.online }))
vi.mock('./cleanup', () => ({ cleanupDeletedEvidence: mock.cleanup }))
vi.mock('../../net/syncOutbox', () => ({ DurableOutbox: class {
  private active = true
  constructor(readonly scope: { accountId: string; epoch: number }, readonly generation: number, readonly writer: EventWriter) {}
  async enqueue(id: string, payload: unknown) {
    const serialized = canonical(payload), hash = await digest(serialized)
    const event: DurableEvent = { id, accountId: this.scope.accountId, schema: 1, deletionGeneration: this.generation,
      serialized, digest: hash, localRevision: mock.events.length + 1 }
    if (!mock.events.some((e) => e.id === id)) mock.events.push(event)
    return event
  }
  async exportAccount() {
    mock.restored++
    if (mock.restoreFailure) throw new Error('Unreadable local evidence')
    return new NodeBlob([JSON.stringify({ events: mock.events })])
  }
  status() { return mock.events.every((e) => mock.uploaded.includes(e.id)) ? 'saved_to_account' : 'offline_local_changes' }
  async barrier(scope: unknown) { return { scope, watermark: mock.events.length, targets: [] } }
  async flush(barrier: { watermark: number }) {
    for (const event of mock.events.filter((e) => e.localRevision <= barrier.watermark)) {
      if (!this.active) throw new Error('Account changed')
      const ack = await this.writer(event, this.scope)
      if (ack.status !== 'accepted') throw new Error('Not accepted')
      mock.uploaded.push(event.id)
    }
    return { barrier, status: 'saved', pending: [], reasons: [] }
  }
  async retry() {}
  async clearAccount() {}
  stop() { this.active = false }
} }))
import { evidenceRuntime, startLearningEvidence } from './runtime'

async function setup() {
  const service = revisionService({ accountId: OWNER })
  const rpc = service.client.rpc.bind(service.client)
  service.client.rpc = vi.fn(async (name, args) => {
    if (name === 'read_learning_evidence_v1') return { data: { accountId: OWNER, deletionGeneration: 0, rows: [], serverNow: new Date(0).toISOString(), assignment: null }, error: null }
    if (name === 'ingest_learning_evidence_v1') {
      await mock.beforeIngest()
      return { data: { status: 'accepted', ...args!.p }, error: null }
    }
    return rpc(name, args)
  }) as unknown as typeof service.client.rpc
  mock.online = { client: service.client }
  const sync = new PracticeSync(service.client, OWNER, { merge: () => {}, reloadLearning: () => {} })
  sync.note({ ...emptyProgress(), owner: OWNER })
  await sync.start()
  return sync
}
beforeEach(() => {
  vi.stubGlobal('Blob', NodeBlob)
  mock.events = []; mock.uploaded = []; mock.restored = 0; mock.restoreFailure = false
  mock.beforeIngest = async () => {}
  mock.cleanup.mockReset().mockResolvedValue(undefined)
})
afterEach(() => { activeSync()?.stop(); window.dispatchEvent(new Event('qp-sync-changed')) })

it('F10 cleanup failure blocks saving before runtime registration; ordinary flush retries restoration and capture', async () => {
  const sync = await setup()
  const event = submission(OWNER, attempt()), serialized = canonical(event)
  mock.events.push({ schema: 1, accountId: OWNER, id: event.id, deletionGeneration: 0, serialized, digest: await digest(serialized), localRevision: 1 })
  mock.cleanup.mockRejectedValueOnce(new DOMException('Newer schema', 'VersionError'))
  startLearningEvidence()
  await vi.waitFor(() => expect(sync.status()).toBe('blocked'))
  expect(evidenceRuntime()).toBeNull()
  expect(mock.restored).toBe(0)
  saveProgress({ ...emptyProgress(), owner: OWNER, hands: [{ id: 'final', hand: 1, at: 1, net: 1, result: 'won', guided: false, graded: true }] })
  expect((await sync.flush(1000)).status).toBe('saved')
  expect(mock.cleanup).toHaveBeenCalledTimes(2)
  expect(mock.restored).toBe(1)
  expect(evidenceRuntime()?.rows.some((r) => r.event.id === event.id)).toBe(true)
  expect(mock.events).toHaveLength(3)
  expect(new Set(mock.uploaded).size).toBe(3)
})

it('F10 pending cleanup remains fenced for concurrent flushes and finishes without a curriculum mount', async () => {
  const sync = await setup(), entered = deferred(), release = deferred()
  mock.cleanup.mockImplementationOnce(async () => { entered.resolve(); await release.promise })
  const boot = startEvidenceBootstrap(sync)
  await entered.promise
  expect((await sync.flush(5)).status).toBe('timeout')
  expect(evidenceRuntime()).toBeNull()
  release.resolve(); await boot
  expect((await sync.flush(1000)).status).toBe('saved')
  expect(evidenceRuntime()?.sync).toBe(sync)
})

it('F10 failed restoration is not skipped on retry and no partial runtime certifies saved', async () => {
  const sync = await setup()
  mock.restoreFailure = true
  await startEvidenceBootstrap(sync)
  expect(evidenceRuntime()).toBeNull()
  expect((await sync.flush(1000)).status).toBe('blocked')
  mock.restoreFailure = false
  expect((await sync.flush(1000)).status).toBe('saved')
  expect(mock.restored).toBe(3)
  expect(mock.cleanup).toHaveBeenCalledTimes(3)
})

it('F10 missing online client blocks bootstrap until explicit save retry recovers it', async () => {
  const sync = await setup(), online = mock.online
  mock.online = null
  await startEvidenceBootstrap(sync)
  expect((await sync.flush(1000)).status).toBe('blocked')
  expect(mock.cleanup).not.toHaveBeenCalled()
  mock.online = online
  expect((await sync.flush(1000)).status).toBe('saved')
})

it('F10 account switch during cleanup cannot register or capture old evidence into the new account', async () => {
  const sync = await setup(), entered = deferred(), release = deferred()
  mock.cleanup.mockImplementationOnce(async () => { entered.resolve(); await release.promise })
  const boot = startEvidenceBootstrap(sync)
  await entered.promise
  const other = new PracticeSync(revisionService().client, 'other', { merge: () => {}, reloadLearning: () => {} })
  release.resolve(); await boot
  expect(evidenceRuntime()).toBeNull()
  expect(activeSync()).toBe(other)
  expect(mock.restored).toBe(0)
  expect((await sync.flush(100)).status).toBe('account_changed')
})

it('F08 save drains a final grade arriving during a delayed evidence ACK without another explicit capture', async () => {
  const sync = await setup(), entered = deferred(), release = deferred()
  const initial = { ...emptyProgress(), owner: OWNER, hands: [{ id: 'late-grade', hand: 1, at: 1, net: 1, result: 'won', guided: false, graded: false }] }
  saveProgress(initial); sync.note(initial)
  await startEvidenceBootstrap(sync)
  let first = true
  mock.beforeIngest = async () => {
    if (first) {
      first = false; entered.resolve(); await release.promise
    }
  }
  const saving = sync.flush(1000)
  await entered.promise
  const final = { ...initial, hands: [{ ...initial.hands[0], graded: true, expectedNet: 2 }] }
  saveProgress(final); sync.note(final)
  release.resolve()
  // The document autosave may finish meanwhile; otherwise the changed document stays unsaved.
  expect(['saved', 'timeout']).toContain((await saving).status)
  expect(mock.events.filter((e) => JSON.parse(e.serialized).kind === 'submission')).toHaveLength(2)
  expect(new Set(mock.uploaded)).toEqual(new Set(mock.events.map((e) => e.id)))
  expect((await sync.flush(1000)).status).toBe('saved')
})
