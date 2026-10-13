export type SyncScope = { accountId: string; epoch: number }
export type SyncTarget = { kind: 'practice_hand' | 'trainer' | 'curriculum' | 'evidence'; id: string; localRevision: number; digest: string }
export type SaveBarrier = { scope: SyncScope; watermark: number; targets: SyncTarget[] }
export type FlushResult = { barrier: SaveBarrier; status: 'saved' | 'timeout' | 'unknown' | 'blocked' | 'conflict' | 'account_changed'; pending: SyncTarget[]; reasons: string[] }
export type SyncStatus = 'checking_account' | 'saved_on_device' | 'saving' | 'saved_to_account' | 'offline_local_changes' | 'conflict' | 'blocked' | 'unable_to_verify'
export type RevisionKind = 'practice_hand' | 'trainer' | 'curriculum'
export type Lifecycle = 'provisional' | 'final' | 'corrected'
export type RemoteRevision = { revision: number; digest: string; serialized: string; payload: unknown; lifecycle: Lifecycle }
export type RevisionWrite = {
  protocol: 1; mutationId: string; accountId: string; kind: RevisionKind; id: string;
  baseRevision: number; deletionGeneration: number; digest: string; serialized: string;
  lifecycle: Lifecycle; supersedesRevision: number | null; payload: unknown
}
export type RevisionResult =
  | { status: 'accepted'; mutationId: string; revision: number; digest: string; deletionGeneration: number }
  | { status: 'conflict'; revision: number; digest: string; serialized: string | null; deletionGeneration: number; current: unknown; lifecycle: Lifecycle }
  | { status: 'deleted' | 'blocked' | 'upgrade_required'; reason: string; deletionGeneration?: number }

/** Stable bytes identify the payload, not client clocks or object insertion order. */
export function canonical(value: unknown): string {
  if (value === undefined) throw new Error('undefined payload')
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('non-finite payload')
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().filter((key) => object[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`
}
export async function digest(serialized: string): Promise<string> {
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized))
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
export const byteLength = (value: string) => new TextEncoder().encode(value).length
