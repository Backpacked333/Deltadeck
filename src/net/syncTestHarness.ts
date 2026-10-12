import type { SupabaseClient } from '@supabase/supabase-js'
import { vi } from 'vitest'
import type { HandRecord } from '../lib/storage'
import { digest, canonical } from './syncRevision'
import type { RemoteRevision, RevisionResult, RevisionWrite } from './syncRevision'

export function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}
/** Transport fake only. The SQL suite tests the authoritative implementation. */
export function revisionService({ accountId = 'u1', hands = [], curriculum = null }: { accountId?: string; hands?: HandRecord[]; curriculum?: string | null } = {}) {
  const docs = new Map<string, RemoteRevision>()
  for (const h of hands) docs.set(`practice_hand:${h.id}`, { payload: h, serialized: canonical(h), revision: 1, digest: '', lifecycle: h.graded === false ? 'provisional' : 'final' })
  if (curriculum !== null) docs.set('curriculum:curriculum', { payload: curriculum, serialized: canonical(curriculum), revision: 1, digest: '', lifecycle: 'final' })
  const receipts = new Map<string, RevisionResult>()
  const state = { docs, hands: new Map(hands.map((h) => [h.id, h])), offline: false, readError: false,
    practice: 0, learning: 0, beforeRead: async () => {}, beforeWrite: async (p: RevisionWrite) => { void p },
    afterWrite: async (p: RevisionWrite) => { void p }, badAck: false, badRead: false }
  const rpc = vi.fn(async (name: string, { p }: { p: RevisionWrite & { expectedGeneration?: number } }) => {
    if (state.offline) return { data: null, error: new Error('offline') }
    if (name === 'read_learning_sync_v1') {
      await state.beforeRead()
      if (state.readError) return { data: null, error: new Error('read failed') }
      for (const row of docs.values()) row.digest = await digest(row.serialized)
      return { data: { protocol: 1, accountId, deletionGenerations: { practice: state.practice, learning: state.learning },
        hands: [...docs].filter(([key]) => key.startsWith('practice_hand:')).map(([key, value]) => ({ id: key.slice(14), ...value, digest: state.badRead ? 'wrong' : value.digest })),
        trainer: docs.get('trainer:trainer') ?? null, curriculum: docs.get('curriculum:curriculum') ?? null, cursor: null }, error: null }
    }
    if (name === 'clear_learning_scope_v1') {
      if (p.expectedGeneration !== state.practice) return { data: { status: 'conflict' }, error: null }
      state.practice++
      for (const key of docs.keys()) if (key.startsWith('practice_hand:')) docs.delete(key)
      state.hands.clear()
      return { data: { status: 'accepted', mutationId: p.mutationId, deletionGeneration: state.practice }, error: null }
    }
    if (name !== 'write_learning_revision_v1') throw new Error(`Unexpected RPC ${name}`)
    await state.beforeWrite(p)
    const key = `${p.kind}:${p.id}`, existing = docs.get(key), generation = p.kind === 'practice_hand' ? state.practice : state.learning
    if (p.deletionGeneration !== generation) return { data: { status: 'deleted', reason: 'generation_changed' }, error: null }
    const receipt = receipts.get(p.mutationId)
    if (receipt) return { data: state.badAck ? { ...receipt, digest: 'incorrect' } : receipt, error: null }
    if ((existing?.revision ?? 0) !== p.baseRevision) return { data: { status: 'conflict', current: existing?.payload ?? null, serialized: existing?.serialized ?? null, revision: existing?.revision ?? 0, digest: existing?.digest ?? '', lifecycle: existing?.lifecycle ?? 'provisional', deletionGeneration: generation }, error: null }
    if (await digest(p.serialized) !== p.digest || canonical(JSON.parse(p.serialized)) !== canonical(p.payload)) throw new Error('bad payload')
    const revision = p.baseRevision + 1
    docs.set(key, { payload: p.payload, serialized: p.serialized, revision, digest: p.digest, lifecycle: p.lifecycle })
    if (p.kind === 'practice_hand') state.hands.set(p.id, p.payload as HandRecord)
    const result: RevisionResult = { status: 'accepted', mutationId: p.mutationId, digest: p.digest, revision, deletionGeneration: generation }
    receipts.set(p.mutationId, result)
    await state.afterWrite(p)
    return { data: state.badAck ? { ...result, digest: 'incorrect' } : result, error: null }
  })
  return { state, rpc, client: { rpc } as unknown as SupabaseClient }
}
