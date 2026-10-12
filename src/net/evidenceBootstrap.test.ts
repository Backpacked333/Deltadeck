import { afterEach, expect, it, vi } from 'vitest'
import { Blob as NodeBlob } from 'node:buffer'
import { emptyProgress } from '../lib/storage'
import { activeSync, PracticeSync, type SaveParticipant } from './sync'
import { startEvidenceBootstrap } from './evidenceBootstrap'
import { deferred, revisionService } from './syncTestHarness'

function setup() {
  const service = revisionService()
  const sync = new PracticeSync(service.client, 'u1', { merge: () => {}, reloadLearning: () => {} })
  sync.note({ ...emptyProgress(), owner: 'u1' })
  return { sync, service }
}
afterEach(() => { activeSync()?.stop(); vi.restoreAllMocks() })

it('F10 synchronously fences save before the lazy import resolves', async () => {
  const { sync } = setup()
  await sync.start()
  const imported = deferred(), entered = deferred()
  const initializeLearningEvidence = vi.fn(async () => {})
  const load = vi.fn(async () => { entered.resolve(); await imported.promise; return { initializeLearningEvidence } })
  const boot = startEvidenceBootstrap(sync, false, load)
  expect(sync.status()).not.toBe('saved_to_account')
  await entered.promise
  expect((await sync.flush(5)).status).toBe('timeout')
  expect(initializeLearningEvidence).not.toHaveBeenCalled()
  imported.resolve(); await boot
  expect((await sync.flush(1000)).status).toBe('saved')
  expect(initializeLearningEvidence).toHaveBeenCalledOnce()
})

it('F10 failed lazy import retries through the ordinary account flush', async () => {
  const { sync } = setup()
  const initializeLearningEvidence = vi.fn(async () => {})
  const load = vi.fn().mockRejectedValueOnce(new Error('chunk unavailable')).mockResolvedValue({ initializeLearningEvidence })
  await startEvidenceBootstrap(sync, false, load)
  expect(sync.status()).toBe('blocked')
  expect((await sync.flush(1000)).status).toBe('saved')
  expect(load).toHaveBeenCalledTimes(2)
  expect(initializeLearningEvidence).toHaveBeenCalledOnce()
})

it('F10 failed first account pull cannot load evidence or claim saved; retry initializes both', async () => {
  const { sync, service } = setup()
  service.state.readError = true
  const initializeLearningEvidence = vi.fn(async () => {})
  const load = vi.fn(async () => ({ initializeLearningEvidence }))
  await startEvidenceBootstrap(sync, false, load)
  expect((await sync.flush(100)).status).not.toBe('saved')
  expect(load).not.toHaveBeenCalled()
  service.state.readError = false
  expect((await sync.flush(1000)).status).toBe('saved')
  expect(initializeLearningEvidence).toHaveBeenCalledOnce()
})

it('F10 a late module import from the old epoch cannot initialize the new account', async () => {
  const { sync } = setup()
  const entered = deferred(), release = deferred()
  const initializeLearningEvidence = vi.fn(async () => {})
  const boot = startEvidenceBootstrap(sync, false, async () => {
    entered.resolve(); await release.promise; return { initializeLearningEvidence }
  })
  await entered.promise
  const other = setup().sync
  release.resolve(); await boot
  expect(activeSync()).toBe(other)
  expect((await sync.flush(100)).status).toBe('account_changed')
  expect(initializeLearningEvidence).not.toHaveBeenCalled()
})

it('F10 a deletion generation changed during bootstrap stays unverified until the new generation initializes', async () => {
  const { sync, service } = setup()
  await sync.flush(1000)
  const entered = deferred(), release = deferred()
  const initializeLearningEvidence = vi.fn(async () => { entered.resolve(); await release.promise })
  const boot = startEvidenceBootstrap(sync, false, async () => ({ initializeLearningEvidence }))
  await entered.promise
  service.state.learning = 1
  await sync.start()
  release.resolve(); await boot
  expect(sync.status()).toBe('blocked')
  expect((await sync.flush(1000)).status).toBe('saved')
  expect(initializeLearningEvidence).toHaveBeenCalledTimes(2)
})

it('F08 rechecks participants at save completion when an earlier participant becomes dirty', async () => {
  const { sync } = setup()
  let dirty = false
  const participant: SaveParticipant = {
    status: () => dirty ? 'saving' : 'saved_to_account',
    barrier: async (scope) => ({ scope, watermark: 0, targets: [] }),
    flush: async (barrier) => ({ status: 'saved', barrier, pending: [], reasons: [] }),
    exportAccount: async () => new Blob(), clearAccount: async () => {}, stop: () => {},
  }
  sync.registerParticipant(participant)
  sync.registerParticipant({ ...participant, status: () => 'saved_to_account', flush: async (barrier) => {
    dirty = true
    return { status: 'saved', barrier, pending: [], reasons: [] }
  } })
  expect((await sync.flush(1000)).status).toBe('timeout')
})

it('F10 a recovery export finishing after an account switch is rejected', async () => {
  const { sync } = setup(), entered = deferred(), release = deferred()
  sync.registerParticipant({
    barrier: async (scope) => ({ scope, watermark: 0, targets: [] }),
    flush: async (barrier) => ({ status: 'saved', barrier, pending: [], reasons: [] }),
    exportAccount: async () => { entered.resolve(); await release.promise; return new NodeBlob(['{}']) as unknown as Blob },
    clearAccount: async () => {}, stop: () => {},
  })
  const exporting = sync.exportAccount()
  await entered.promise
  const other = new PracticeSync(revisionService({ accountId: 'other' }).client, 'other', { merge: () => {}, reloadLearning: () => {} })
  release.resolve()
  await expect(exporting).rejects.toThrow('Account changed')
  expect(activeSync()).toBe(other)
})
