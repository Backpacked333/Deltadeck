import { Blob as NodeBlob } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LEARNING_KEY as CURRICULUM_KEY, LEARNING_V1_KEY as CURRICULUM_V1_KEY } from '../curriculum/core/persistence'
import { emptyProgress, LEARNING_SAVED_EVENT, STORAGE_KEY } from '../lib/storage'
import type { HandRecord, Progress } from '../lib/storage'
import { activeSync, clearLocalPractice, LEARNING_BACKUP_KEY, LEARNING_KEY, LEARNING_V1_KEY, mergeHands, PracticeSync } from './sync'
import { deferred, revisionService } from './syncTestHarness'
import { canonical, digest } from './syncRevision'

const ME = 'u1'
beforeEach(() => vi.stubGlobal('Blob', NodeBlob))
const hand = (id = 'h', extra: Partial<HandRecord> = {}): HandRecord => ({ id, hand: 1, at: 1, net: 10, result: 'won', guided: false, ...extra })
function setup(service = revisionService(), initial: Progress = { ...emptyProgress(), owner: ME }) {
  let progress = initial
  const reload = vi.fn()
  const sync = new PracticeSync(service.client, ME, { merge: (update) => { progress = update(progress) }, reloadLearning: reload })
  sync.note(progress)
  return { service, sync, reload, progress: () => progress }
}
afterEach(() => { activeSync()?.stop(); vi.restoreAllMocks() })

describe('F08 exact snapshot acknowledgement', () => {
  it('F08_provisional_final_overlap_drains_without_edit', async () => {
    const { service, sync } = setup()
    await sync.start(); await sync.flush(1000)
    const entered = deferred(), release = deferred()
    service.state.beforeWrite = async (p) => { if (p.kind === 'practice_hand' && p.lifecycle === 'provisional') { entered.resolve(); await release.promise } }
    sync.note({ ...emptyProgress(), owner: ME, hands: [hand('h', { graded: false })] })
    const flush = sync.flush(1500)
    await entered.promise
    sync.note({ ...emptyProgress(), owner: ME, hands: [hand('h', { graded: true, expectedNet: 11 })] })
    expect((await sync.flush(5)).status).toBe('timeout')
    release.resolve()
    expect((await flush).status).toBe('saved')
    expect(service.state.hands.get('h')).toMatchObject({ graded: true, expectedNet: 11 })
    expect(service.state.docs.get('practice_hand:h')?.revision).toBe(2)
  })
  it('F08 changed curriculum while an ACK is in flight drains exact bytes', async () => {
    const { service, sync } = setup(); await sync.start(); await sync.flush(1000)
    const entered = deferred(), release = deferred()
    service.state.beforeWrite = async (p) => { if (p.kind === 'curriculum' && p.baseRevision === 0) { entered.resolve(); await release.promise } }
    sync.noteCurriculum('{"notes":"first"}')
    const flush = sync.flush(1500)
    await entered.promise
    sync.noteCurriculum('{"notes":"second"}')
    release.resolve()
    expect((await flush).status).toBe('saved')
    expect(service.state.docs.get('curriculum:curriculum')?.payload).toBe('{"notes":"second"}')
  })
  it('F08_size_cap_quota_block_flush and preserve exportable data', async () => {
    const { sync, service } = setup(); await sync.start(); await sync.flush(1000)
    sync.note({ ...emptyProgress(), owner: ME, hands: [hand('huge', { result: 'x'.repeat(9000) })] })
    expect((await sync.flush(1000)).status).toBe('blocked')
    expect(service.state.hands.has('huge')).toBe(false)
    expect(await (await sync.exportAccount()).text()).toContain('huge')
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Quota', 'QuotaExceededError') })
    sync.note({ ...emptyProgress(), owner: ME, lessons: ['equity'] })
    expect((await sync.flush(1000)).status).toBe('blocked')
    set.mockRestore()
  })
  it('F08 wrong digest never counts as saved; retry reuses the mutation ID', async () => {
    const { sync, service } = setup()
    service.state.badAck = true
    await sync.start()
    expect((await sync.flush(1000)).status).not.toBe('saved')
    service.state.badAck = false
    expect((await sync.flush(1000)).status).toBe('saved')
    const writes = service.rpc.mock.calls.filter(([name]) => name === 'write_learning_revision_v1')
    expect(writes[0]![1].p.mutationId).toBe(writes[1]![1].p.mutationId)
  })
  it('F08 producer quota failure blocks acknowledgement even if remote upload succeeds', async () => {
    const { sync } = setup(); await sync.start()
    sync.noteCurriculum('{"private":"memory only"}', 'curriculum local storage quota')
    expect((await sync.flush(1000)).status).toBe('blocked')
    expect(await (await sync.exportAccount()).text()).toContain('memory only')
    sync.reportSourceBlocked('curriculum', null)
    expect((await sync.flush(1000)).status).toBe('saved')
  })
})

describe('F09 CAS reconciliation', () => {
  it.each([false, true])('F09_both_device_arrival_orders_preserve_or_conflict (%s)', async (reverse) => {
    const remote = reverse ? '{"note":"A","updatedAt":999999}' : '{"note":"B","updatedAt":1}'
    const local = reverse ? '{"note":"B","updatedAt":1}' : '{"note":"A","updatedAt":999999}'
    const { sync, service } = setup(revisionService({ curriculum: remote }))
    sync.noteCurriculum(local)
    await sync.start()
    expect((await sync.flush(1000)).status).toBe('conflict')
    expect(sync.conflicts()[0]).toMatchObject({ local, remote })
    expect(await (await sync.exportAccount()).text()).toContain('concurrent_changes')
    sync.resolveConflict('curriculum:curriculum', 'local')
    expect((await sync.flush(1000)).status).toBe('saved')
    expect(service.state.docs.get('curriculum:curriculum')).toMatchObject({ payload: local, revision: 2 })
  })
  it('F09 unions disjoint hand IDs and does not echo unchanged server hands', async () => {
    const { sync, service, progress } = setup(revisionService({ hands: [hand('remote')] }), { ...emptyProgress(), owner: ME, hands: [hand('local')] })
    await sync.start(); expect((await sync.flush(1000)).status).toBe('saved')
    expect(progress().hands.map((h) => h.id).sort()).toEqual(['local', 'remote'])
    expect(service.state.docs.get('practice_hand:remote')?.revision).toBe(1)
    expect(mergeHands([hand('local')], [hand('remote')])).toHaveLength(2)
  })
  it('F09 legacy JSONB whitespace has an exact verified digest and is not echoed', async () => {
    const service = revisionService({ hands: [hand('legacy')] }), row = service.state.docs.get('practice_hand:legacy')!
    row.serialized = JSON.stringify(row.payload, null, 2); row.digest = await digest(row.serialized)
    const { sync, progress } = setup(service)
    await sync.start(); sync.note(progress())
    expect((await sync.flush(1000)).status).toBe('saved')
    const barrier = await sync.barrier()
    expect(barrier.targets.find((t) => t.id === 'legacy')?.digest).toBe(row.digest)
    expect(service.rpc.mock.calls.filter(([name, args]) => name === 'write_learning_revision_v1' && args.p.id === 'legacy')).toHaveLength(0)
  })
  it('F09 conflict on same ID never silently picks timestamp or grade', async () => {
    const { sync } = setup(revisionService({ hands: [hand('h', { at: 9999, graded: true })] }), { ...emptyProgress(), owner: ME, hands: [hand('h', { graded: false })] })
    await sync.start()
    expect((await sync.flush(1000)).status).toBe('conflict')
    expect(sync.conflicts()[0]?.key).toBe('practice_hand:h')
  })
  it('F09_stale_upload_cannot_undo_delete and local clear increments generation', async () => {
    const { sync, service } = setup(revisionService({ hands: [hand('h')] }))
    await sync.start(); await sync.flush(1000)
    sync.note({ ...emptyProgress(), owner: ME, hands: [], historyClearedAt: 100 })
    expect((await sync.flush(1000)).status).toBe('saved')
    expect(service.state.practice).toBe(1); expect(service.state.hands.size).toBe(0)
    sync.note({ ...emptyProgress(), owner: ME, hands: [hand('new')], historyClearedAt: 100 })
    service.state.practice++
    expect((await sync.flush(1000)).status).toBe('blocked')
    expect(service.state.hands.size).toBe(0)
  })
  it('F09 pull after deletion quarantines stale IDs instead of re-stamping', async () => {
    const service = revisionService(); service.state.practice = 1
    const { sync } = setup(service, { ...emptyProgress(), owner: ME, hands: [hand('offline')] })
    await sync.start()
    expect((await sync.flush(1000)).status).toBe('conflict')
    expect(() => sync.resolveConflict('practice_hand:offline', 'local')).toThrow(/Deleted/)
    sync.resolveConflict('practice_hand:offline', 'remote')
    expect((await sync.flush(1000)).status).toBe('saved')
    expect(service.state.hands.size).toBe(0)
  })
})

describe('F10 durability and account boundaries', () => {
  it('F10_failed_initial_pull_blocks_saved_signout and retains new work through retry', async () => {
    const { sync, service } = setup(); service.state.readError = true
    await sync.start()
    sync.note({ ...emptyProgress(), owner: ME, hands: [hand('new-during-failure')] })
    sync.noteCurriculum('{"notes":"new during failure"}')
    expect(sync.status()).toBe('unable_to_verify')
    expect((await sync.flush(1000)).status).toBe('unknown')
    expect(Object.values(localStorage).join('')).toContain('new-during-failure')
    service.state.readError = false
    expect((await sync.flush(1000)).status).toBe('saved')
    expect(service.state.hands.has('new-during-failure')).toBe(true)
  })
  it('F10 clear during failed first read is durable and preserves work created after that clear', async () => {
    const service = revisionService({ hands: [hand('old')] }), { sync, progress } = setup(service)
    service.state.readError = true; await sync.start()
    sync.note({ ...emptyProgress(), owner: ME, hands: [], historyClearedAt: 100 })
    sync.note({ ...emptyProgress(), owner: ME, hands: [hand('after-clear')], historyClearedAt: 100 })
    service.state.readError = false
    expect((await sync.flush(1000)).status).toBe('saved')
    expect(service.state.practice).toBe(1)
    expect([...service.state.hands.keys()]).toEqual(['after-clear'])
    expect(progress().hands.map((h) => h.id)).toEqual(['after-clear'])
  })
  it('F10 crash/reload after ACK loss verifies the stored payload without duplicating its revision', async () => {
    const service = revisionService(), first = setup(service)
    await first.sync.start(); await first.sync.flush(1000)
    service.state.afterWrite = async () => { service.state.offline = true; throw new Error('response lost') }
    first.sync.noteCurriculum('{"notes":"durable"}')
    expect((await first.sync.flush(1000)).status).not.toBe('saved')
    first.sync.stop()
    const second = setup(service)
    service.state.offline = false; service.state.afterWrite = async () => {}
    await second.sync.start()
    expect((await second.sync.flush(1000)).status).toBe('saved')
    expect(service.state.docs.get('curriculum:curriculum')?.revision).toBe(1)
  })
  it('F08 crash after provisional commit retains and automatically drains the queued final grade', async () => {
    const service = revisionService(), first = setup(service)
    await first.sync.start(); await first.sync.flush(1000)
    service.state.afterWrite = async (p) => {
      if (p.kind !== 'practice_hand' || p.lifecycle !== 'provisional') return
      first.sync.note({ ...emptyProgress(), owner: ME, hands: [hand('crash', { graded: true, expectedNet: 7 })] })
      service.state.offline = true
      throw new Error('Lost provisional ACK')
    }
    first.sync.note({ ...emptyProgress(), owner: ME, hands: [hand('crash', { graded: false })] })
    expect((await first.sync.flush(1000)).status).not.toBe('saved')
    first.sync.stop(); service.state.offline = false; service.state.afterWrite = async () => {}
    const second = setup(service)
    await second.sync.start()
    expect((await second.sync.flush(1000)).status).toBe('saved')
    expect(service.state.docs.get('practice_hand:crash')).toMatchObject({ revision: 2, payload: { graded: true, expectedNet: 7 } })
  })
  it('F10 unverifiable initial read is not readiness or account saved', async () => {
    const service = revisionService({ hands: [hand('remote')] }); service.state.badRead = true
    const { sync } = setup(service)
    await sync.start()
    expect(sync.isReconciled()).toBe(false); expect(sync.status()).toBe('unable_to_verify')
    expect((await sync.flush(1000)).status).toBe('unknown')
  })
  it('F10_old_epoch_response_cannot_touch_new_account', async () => {
    const service = revisionService({ hands: [hand('private-A')] }), entered = deferred(), release = deferred()
    service.state.beforeRead = async () => { entered.resolve(); await release.promise }
    const first = setup(service); const pull = first.sync.start(); await entered.promise
    const other = revisionService({ accountId: 'B' }), merge = vi.fn()
    const second = new PracticeSync(other.client, 'B', { merge, reloadLearning: () => {} })
    second.note({ ...emptyProgress(), owner: 'B' }); await second.start(); await second.flush(1000)
    const before = localStorage.getItem(STORAGE_KEY)
    release.resolve(); await pull
    expect(localStorage.getItem(STORAGE_KEY)).toBe(before)
    expect((await first.sync.flush(1000)).status).toBe('account_changed')
    expect(before).not.toContain('private-A')
  })
  it('F10_guest_requires_explicit_claim, no whichever-account import', async () => {
    localStorage.setItem(LEARNING_KEY, '{"guest":true}')
    const { sync, service } = setup(revisionService(), { ...emptyProgress(), hands: [hand('guest')] })
    await sync.start(); await sync.flush(1000)
    expect(sync.hasUnclaimed()).toBe(true)
    expect(service.state.hands.size).toBe(0)
    expect(service.state.docs.has('curriculum:curriculum')).toBe(false)
    expect(() => sync.claimGuest('other')).toThrow()
    sync.claimGuest(ME)
    expect((await sync.flush(1000)).status).toBe('saved')
    expect(service.state.hands.has('guest')).toBe(true)
    expect(sync.hasUnclaimed()).toBe(false)
  })
  it('F10 curriculum storage event and existing persistence keys remain compatible', async () => {
    expect(LEARNING_KEY).toBe(CURRICULUM_KEY); expect(LEARNING_V1_KEY).toBe(CURRICULUM_V1_KEY)
    const { sync, service } = setup(); await sync.start()
    localStorage.setItem(LEARNING_KEY, '{"notes":"saved"}')
    window.dispatchEvent(new Event(LEARNING_SAVED_EVENT))
    expect((await sync.flush(1000)).status).toBe('saved')
    expect(service.state.docs.get('curriculum:curriculum')?.payload).toBe('{"notes":"saved"}')
  })
  it('F10 cleanup removes private backups, journals, guest work; removal failures throw', async () => {
    for (const key of [LEARNING_BACKUP_KEY, LEARNING_V1_KEY, LEARNING_KEY, STORAGE_KEY, 'qp.sync.v1.unclaimed', 'qp.sync.v1.u1.tab']) localStorage.setItem(key, 'private')
    localStorage.setItem('unrelated', 'keep')
    clearLocalPractice()
    expect(localStorage.getItem('unrelated')).toBe('keep')
    expect(localStorage.length).toBe(1)
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('denied') })
    expect(clearLocalPractice).toThrow(/private learning data/)
  })
  it('F10 unsupported journal blocks instead of overwriting a recovery copy', async () => {
    sessionStorage.setItem('qp.sync.v1.tab', 'tab')
    localStorage.setItem('qp.sync.v1.u1.tab', '{"version":99,"private":"work"}')
    const { sync } = setup(); await sync.start()
    expect((await sync.flush(1000)).status).toBe('blocked')
    expect(localStorage.getItem('qp.sync.v1.u1.tab')).toContain('"version":99')
    expect(await (await sync.exportAccount()).text()).toContain('work')
  })
  it('F08 canonicalization is key-order stable and rejects nonfinite numbers', () => {
    expect(canonical({ b: 2, a: 1 })).toBe(canonical({ a: 1, b: 2 }))
    expect(() => canonical({ value: Infinity })).toThrow()
  })
})
