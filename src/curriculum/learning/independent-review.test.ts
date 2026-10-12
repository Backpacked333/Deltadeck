import { afterEach, expect, it, vi } from 'vitest'
import { PracticeSync, activeSync } from '../../net/sync'
import { revisionService } from '../../net/syncTestHarness'
import { emptyProgress } from '../../lib/storage'

const deps = vi.hoisted(() => ({ online: null as unknown, cleanup: vi.fn() }))
vi.mock('../../net/supabase', () => ({ loadOnline: async () => deps.online }))
vi.mock('./cleanup', () => ({ cleanupDeletedEvidence: deps.cleanup }))
import { startLearningEvidence, evidenceRuntime } from './runtime'

afterEach(() => activeSync()?.stop())

it('F10 evidence bootstrap failure must not certify an account save', async () => {
  const service = revisionService()
  deps.online = { client: service.client }
  deps.cleanup.mockRejectedValue(new DOMException('Outbox schema is newer than supported', 'VersionError'))
  const sync = new PracticeSync(service.client, 'u1', { merge: () => {}, reloadLearning: () => {} })
  sync.note({ ...emptyProgress(), owner: 'u1' })
  await sync.start()
  startLearningEvidence()
  await vi.waitFor(() => expect(deps.cleanup).toHaveBeenCalled())
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(evidenceRuntime()).toBeNull()
  const result = await sync.flush(1000)
  expect(result.status).not.toBe('saved')
})
