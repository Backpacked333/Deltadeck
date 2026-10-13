import { beforeEach, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { PracticeSync } from '../../net/sync'
import type { EventWriter } from '../../net/syncOutbox'
import { canonical, digest } from '../../net/syncRevision'
import { LearningSession } from '../core/session'
import { MemoryStorage, fixedClock } from '../core/__fixtures__/testing'
import { LEARNING_KEY } from '../core/persistence'
import { emptyProgress, saveProgress } from '../../lib/storage'
import { attempt, OWNER, records } from './__fixtures__'
import { submission } from './evidence'
const mock = vi.hoisted(() => ({
  sync: null as unknown,
  writer: null as unknown,
  fail: false,
  events: [] as {
    accountId: string
    id: string
    deletionGeneration: number
    serialized: string
    digest: string
  }[],
  registered: null as unknown,
}))
vi.mock('../../net/sync', () => ({
  activeSync: () => mock.sync,
  registerSaveParticipant: (p: unknown) => {
    mock.registered = p
    return () => {
      mock.registered = null
    }
  },
}))
vi.mock('../../net/syncOutbox', () => ({
  DurableOutbox: class {
    constructor(
      readonly scope: { accountId: string; epoch: number },
      readonly gen: number,
      writer: unknown,
    ) {
      mock.writer = writer
    }
    async enqueue(id: string, p: unknown) {
      if (mock.fail) throw Error('quota')
      const serialized = canonical(p),
        d = await digest(serialized)
      const e = {
        accountId: this.scope.accountId,
        id,
        deletionGeneration: this.gen,
        serialized,
        digest: d,
      }
      mock.events.push(e)
      return e
    }
    async retry() {
      mock.fail = false
    }
    status() {
      return 'saved_to_account'
    }
    async barrier() {
      return { watermark: mock.events.length, scope: this.scope }
    }
    async exportAccount() {
      return { text: async () => JSON.stringify({ events: mock.events }) }
    }
    stop() {}
    async clearAccount() {
      mock.events = []
    }
  },
}))
import { EvidenceRuntime, attachLearningSession } from './runtime'
let sync: PracticeSync, rpc: ReturnType<typeof vi.fn>, runtime: EvidenceRuntime
beforeEach(() => {
  localStorage.clear()
  mock.events = []
  mock.fail = false
  rpc = vi.fn()
  sync = {
    scope: { accountId: OWNER, epoch: 1 },
    reportSourceBlocked: vi.fn(),
    deletionGenerations: () => ({ practice: 0, learning: 0 }),
  } as unknown as PracticeSync
  mock.sync = sync
  runtime = new EvidenceRuntime(
    sync,
    { rpc } as unknown as SupabaseClient,
    0,
    0,
  )
})
it('deletion generation advancing during issue request rejects a late issue without exposing it', async () => {
  let answer!: (value: unknown) => void
  rpc.mockImplementation(
    () =>
      new Promise((resolve) => {
        answer = resolve
      }),
  )
  const pending = runtime.issueAssessment('incremental')
  sync.deletionGenerations = () => ({ practice: 0, learning: 1 })
  answer({
    data: {
      status: 'issued',
      issueId: 'old',
      caseId: 'targeted-incremental-delayed-warranty',
    },
    error: null,
  })
  await expect(pending).rejects.toThrow('Account changed')
  await expect(runtime.emit(submission(OWNER, attempt()))).rejects.toThrow(
    'Account changed',
  )
})

it('F08 writer sends exact protected envelope and refuses cross-account late ACK', async () => {
  const event = submission(OWNER, attempt())
  await runtime.emit(event)
  const stored = { schema: 1 as const, localRevision: 1, ...mock.events[0] }
  rpc.mockResolvedValue({
    data: {
      status: 'accepted',
      id: event.id,
      digest: stored.digest,
      deletionGeneration: 0,
    },
    error: null,
  })
  expect(await (mock.writer as EventWriter)(stored, sync.scope)).toMatchObject({
    status: 'accepted',
  })
  expect(rpc).toHaveBeenCalledWith('ingest_learning_evidence_v1', {
    p: { protocol: 1, ...stored },
  })
  rpc.mockImplementation(async () => {
    mock.sync = null
    return { data: { status: 'accepted' } }
  })
  expect(await (mock.writer as EventWriter)(stored, sync.scope)).toMatchObject({
    status: 'blocked',
    reason: 'account_changed',
  })
})
it('F08 exact duplicate is not re-enqueued, failed enqueue stays visible and retry uses the same ID', async () => {
  const event = submission(OWNER, attempt())
  mock.fail = true
  await expect(runtime.emit(event)).rejects.toThrow('quota')
  expect(runtime.rows).toEqual([])
  mock.fail = false
  await runtime.emit(event)
  await runtime.emit(event)
  expect(mock.events).toHaveLength(1)
  expect(runtime.rows[0].event.id).toBe(event.id)
})
it('F08 save barrier covers already-started curriculum and practice capture, including finalized grade revision', async () => {
  const session = new LearningSession(new MemoryStorage(), fixedClock)
  session.recordAttempt(attempt())
  const detach = attachLearningSession(session)
  saveProgress({
    ...emptyProgress(),
    owner: OWNER,
    hands: [
      {
        id: 'h',
        hand: 1,
        net: 99,
        guided: false,
        result: 'won',
        graded: false,
        at: 100,
      },
    ],
  })
  const pending = runtime.capture(session)
  await runtime.barrier(sync.scope)
  await pending
  expect(mock.events).toHaveLength(5)
  saveProgress({
    ...emptyProgress(),
    owner: OWNER,
    hands: [
      {
        id: 'h',
        hand: 1,
        net: 99,
        guided: false,
        result: 'won',
        graded: true,
        at: 100,
      },
    ],
  })
  await runtime.capture(session)
  expect(mock.events).toHaveLength(7)
  expect(new Set(mock.events.map((e) => e.id)).size).toBe(7)
  detach()
})
it('F10 a stale in-memory session cannot be rebound to another account', async () => {
  const session = new LearningSession(new MemoryStorage(), fixedClock)
  session.recordAttempt(attempt())
  const detach = attachLearningSession(session)
  const second = {
    scope: { accountId: crypto.randomUUID(), epoch: 2 },
    reportSourceBlocked: vi.fn(),
    deletionGenerations: () => ({ practice: 0, learning: 0 }),
  } as unknown as PracticeSync
  mock.sync = second
  const other = new EvidenceRuntime(
    second,
    { rpc } as unknown as SupabaseClient,
    0,
    0,
  )
  await other.capture(session)
  expect(mock.events).toEqual([])
  detach()
})
it('F09 source errors are reported rather than falsely saved; failed memory is still owned by the session', async () => {
  const session = new LearningSession(new MemoryStorage(), fixedClock)
  session.recordAttempt(attempt())
  const detach = attachLearningSession(session)
  mock.fail = true
  await runtime.capture(session)
  expect(runtime.status()).toBe('blocked')
  expect(sync.reportSourceBlocked).toHaveBeenCalledWith(
    'evidence',
    expect.stringContaining('quota'),
  )
  detach()
})
it('F10 remote page hashes, owner and deletion generation must all validate; replay stays separated from raw export', async () => {
  const rows = await records()
  rpc.mockResolvedValue({
    data: {
      accountId: OWNER,
      deletionGeneration: 0,
      rows,
      serverNow: fixedClock().toISOString(),
      assignment: null,
    },
  })
  await runtime.refresh()
  expect(runtime.rows).toEqual(rows)
  expect(runtime.error).toBeNull()
  rpc.mockResolvedValue({
    data: { accountId: OWNER, deletionGeneration: 1, rows: [] },
  })
  await runtime.refresh()
  expect(runtime.error).toContain('deletion generation')
  rpc.mockResolvedValue({
    data: {
      accountId: OWNER,
      deletionGeneration: 0,
      rows: [{ ...rows[0], digest: 'wrong' }],
    },
  })
  await runtime.refresh()
  expect(runtime.error).toContain('Unsupported remote evidence')
  expect(runtime.remoteRaw.length).toBeGreaterThan(0)
})
it('F10 unsupported local data is blocked, never interpreted as a projection', async () => {
  mock.events = [
    {
      accountId: OWNER,
      id: 'future',
      deletionGeneration: 0,
      serialized: JSON.stringify({ schema: 99 }),
      digest: 'bad',
    },
  ]
  await expect(runtime.restore()).rejects.toThrow('Unsupported or corrupt')
  expect(runtime.rows).toEqual([])
  expect(localStorage.getItem(LEARNING_KEY)).toBeNull()
})
