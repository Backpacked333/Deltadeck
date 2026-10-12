import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PracticeSync, activeSync } from '../../net/sync'
import { deferred, revisionService } from '../../net/syncTestHarness'
import { emptyProgress, saveProgress } from '../../lib/storage'
import { canonical, digest } from '../../net/syncRevision'
const mock = vi.hoisted(() => ({ events: [] as unknown[] }))
vi.mock('../../net/syncOutbox', () => ({ DurableOutbox: class {
  async enqueue(id: string, payload: unknown) {
    mock.events.push(payload)
    const serialized = canonical(payload)
    const result = { id, digest: await digest(serialized), serialized }
    window.dispatchEvent(new Event('qp-sync-changed'))
    return result
  }
  async barrier(scope: unknown) { return { scope, watermark: 0, targets: [] } }
  stop() {}
} }))
import { EvidenceRuntime } from './runtime'

beforeEach(() => { mock.events = [] })
afterEach(() => { activeSync()?.stop(); vi.restoreAllMocks() })

it('F08 capture drains a final grade arriving during provisional evidence capture without another event', async () => {
  const service = revisionService()
  const sync = new PracticeSync(service.client, 'u1', { merge: () => {}, reloadLearning: () => {} })
  sync.note({ ...emptyProgress(), owner: 'u1' })
  await sync.start()
  await sync.flush(1000)
  const runtime = new EvidenceRuntime(sync, service.client, 0, 0)
  const onSyncChanged = () => { void runtime.capture() }
  window.addEventListener('qp-sync-changed', onSyncChanged)
  const tail = { id: 'tail', hand: 2, at: 200, net: 0, result: 'tie', guided: false, graded: true }
  saveProgress({ ...emptyProgress(), owner: 'u1', hands: [tail] })
  await runtime.capture()
  mock.events = []
  const started = deferred(), release = deferred()
  const originalDigest = crypto.subtle.digest.bind(crypto.subtle)
  let first = true
  vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
    if (first && new TextDecoder().decode(data) === 'tail') {
      first = false; started.resolve(); await release.promise
    }
    return originalDigest(algorithm, data)
  })
  const initial = { ...emptyProgress(), owner: 'u1', hands: [{ id: 'h', hand: 1, at: 100, net: 1, result: 'won', guided: false, graded: false }, tail] }
  saveProgress(initial)
  const provisional = runtime.capture()
  await started.promise
  saveProgress({ ...initial, hands: [{ ...initial.hands[0], graded: true, expectedNet: 2 }, tail] })
  const final = runtime.capture()
  release.resolve()
  await Promise.all([provisional, final])
  const submissions = mock.events.filter((e) => (e as {kind: string}).kind === 'submission')
  window.removeEventListener('qp-sync-changed', onSyncChanged)
  expect(submissions).toHaveLength(2)
})

it('F08 a request between the last capture pass and promise cleanup also drains automatically', async () => {
  const service = revisionService()
  const sync = new PracticeSync(service.client, 'u1', { merge: () => {}, reloadLearning: () => {} })
  sync.note({ ...emptyProgress(), owner: 'u1' })
  await sync.start()
  const runtime = new EvidenceRuntime(sync, service.client, 0, 0)
  const initial = { ...emptyProgress(), owner: 'u1', hands: [{ id: 'h', hand: 1, at: 100, net: 1, result: 'won', guided: false, graded: false }] }
  saveProgress(initial)
  await runtime.capture()
  const internals = runtime as unknown as { captureSources(): Promise<void> }
  const original = internals.captureSources.bind(runtime)
  vi.spyOn(internals, 'captureSources').mockImplementationOnce(async () => {
    await original()
    queueMicrotask(() => queueMicrotask(() => {
      saveProgress({ ...initial, hands: [{ ...initial.hands[0], graded: true, expectedNet: 2 }] })
      void runtime.capture()
    }))
  })
  await runtime.capture()
  expect(mock.events.filter((e) => (e as {kind: string}).kind === 'submission')).toHaveLength(2)
})
