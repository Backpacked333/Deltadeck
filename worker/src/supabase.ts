// The archive and the audit: finished matches, hands and incidents go to
// Postgres through service-role functions (supabase/migrations/*record_*.sql,
// *verify_hand.sql), all idempotent, so the outbox and the queue consumer may
// retry any call. The secret key goes in `apikey` and nowhere else.
import type { WorkerEnv } from './env'
import { describeError, logEvent } from './log'

export type ArchiveCall = {
  /** apply_rating's payload is computed when it is sent (worker/src/rating.ts). */
  rpc:
    | 'record_match'
    | 'record_hand'
    | 'record_terminal'
    | 'record_incident'
    | 'apply_rating'
    | 'record_challenge_claim'
    | 'set_player_school'
  body: Record<string, unknown>
}

/** The service-role functions the Worker may call (secret key only). */
type ServiceFn =
  | ArchiveCall['rpc']
  | 'audit_hand'
  | 'verify_hand'
  | 'record_grades'

/** A call that must succeed: throws on any failure, returns the JSON result. */
export async function rpc<T = unknown>(
  env: WorkerEnv,
  fn: ServiceFn,
  body: Record<string, unknown>,
): Promise<T | null> {
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SECRET_KEY ?? '',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p: body }),
  })
  if (!response.ok)
    throw new Error(
      `${fn} ${response.status} ${(await errorCode(response)) ?? ''}`.trim(),
    )
  const text = await response.text()
  return text ? (JSON.parse(text) as T) : null
}

/** What became of an archive call: accepted, or refused and why. */
export type ArchiveOutcome = { ok: boolean; status?: number; code?: string }

/**
 * True when Postgres refused a call for its data: an error of class 22 (bad
 * data) or 23 (a broken constraint), which no retry can change. An outage
 * (5xx, network), a missing or wrong key (401, 403) or a missing function
 * can all be fixed, and then every queued call must still go through, so
 * none of those counts.
 */
export const refusedForData = (o: ArchiveOutcome) =>
  !o.ok &&
  o.status !== undefined &&
  o.status >= 400 &&
  o.status < 500 &&
  o.status !== 401 &&
  o.status !== 403 &&
  /^2[23]/.test(o.code ?? '')

/** Sends one archive call. Never throws. */
export async function archive(
  env: WorkerEnv,
  call: ArchiveCall,
): Promise<ArchiveOutcome> {
  try {
    const response = await fetch(
      `${env.SUPABASE_URL}/rest/v1/rpc/${call.rpc}`,
      {
        method: 'POST',
        // A secret key goes in `apikey` alone; the gateway maps it to the
        // service role.
        headers: {
          apikey: env.SUPABASE_SECRET_KEY ?? '',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ p: call.body }),
      },
    )
    if (response.ok) return { ok: true }
    // Only the status and Postgres's error code: an error message can quote
    // the failing row, and a hand's row holds its deck.
    const code = await errorCode(response)
    logEvent('error', {
      reason: 'archive',
      rpc: call.rpc,
      code: response.status,
      detail: code,
    })
    return { ok: false, status: response.status, code }
  } catch (error) {
    logEvent('error', {
      reason: 'archive',
      rpc: call.rpc,
      detail: describeError(error),
    })
    return { ok: false }
  }
}

/** PostgREST's error code (e.g. 23514), never its message or details. */
async function errorCode(response: Response) {
  try {
    const body = (await response.json()) as { code?: unknown }
    return typeof body.code === 'string' ? body.code.slice(0, 16) : undefined
  } catch {
    return undefined
  }
}
