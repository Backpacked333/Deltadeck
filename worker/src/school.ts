// A school badge from a second email (L-14):
//
//   POST /api/school/start   {email} + Bearer → 204 | 400 not_school | 429 | 503
//   POST /api/school/confirm {code}  + Bearer → {school} | 400 wrong | 410 | 429
//
// The address must be a school's (our list in Postgres, else any .edu or
// .ac.uk, as the sign-in trigger decides). A six-digit code goes to it by
// Resend; ScoreDO keeps only the code's hash for CODE_TTL_MS, allows
// CODE_TRIES guesses and SENDS_PER_DAY sends a day. A right code queues
// set_player_school through ScoreDO's outbox. The address itself is never
// stored in Postgres and leaves ScoreDO when the code is used or expires.
import type { WorkerEnv } from './env'
import { describeError, logEvent } from './log'

export const CODE_TTL_MS = 15 * 60_000
export const CODE_TRIES = 5
export const SENDS_PER_DAY = 3
const EMAIL = /^[^\s@<>"]{1,64}@([a-z0-9-]+(\.[a-z0-9-]+)+)$/

export type School = { domain: string; school: string }

/** The domains to look up for `email`, nearest first, or null if invalid. */
export function candidates(email: string): string[] | null {
  const domain = email.trim().toLowerCase().match(EMAIL)?.[1]
  if (!domain || domain.length > 190) return null
  const labels = domain.split('.')
  return labels.slice(0, -1).map((_, i) => labels.slice(i).join('.'))
}

/** An unlisted .edu or .ac.uk domain stands for itself, as in SQL. */
export function fallbackSchool(domain: string): School | null {
  const found =
    domain.match(/([a-z0-9-]+\.edu)$/)?.[1] ??
    domain.match(/([a-z0-9-]+\.ac\.uk)$/)?.[1]
  return found ? { domain: found, school: found } : null
}

/** The school an address belongs to, read with the publishable key. */
export async function schoolFor(
  env: WorkerEnv,
  email: string,
): Promise<School | null> {
  const domains = candidates(email)
  if (!domains) return null
  const url = new URL('/rest/v1/school_domains', env.SUPABASE_URL)
  url.searchParams.set('select', 'domain,school')
  url.searchParams.set('domain', `in.(${domains.join(',')})`)
  const response = await fetch(url, {
    headers: {
      apikey: env.SUPABASE_PUBLISHABLE_KEY,
      Accept: 'application/json',
    },
  })
  if (!response.ok) throw new Error(`school_domains: ${response.status}`)
  const rows = (await response.json()) as School[]
  for (const domain of domains) {
    const row = rows.find((r) => r.domain === domain)
    if (row) return row
  }
  return fallbackSchool(domains[0])
}

/** A uniformly random six-digit code. */
export function newCode() {
  const max = 4_294_000_000 // a multiple of 1e6 below 2^32: no modulo bias
  const one = new Uint32Array(1)
  do crypto.getRandomValues(one)
  while (one[0] >= max)
  return String(one[0] % 1_000_000).padStart(6, '0')
}

/** The stored form of a code: bound to the account, never the code itself. */
export async function codeHash(userId: string, code: string) {
  const bytes = new TextEncoder().encode(`${userId}:${code}`)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Sends the code. False when email is not set up or the send failed. */
export async function sendCode(
  env: WorkerEnv,
  to: string,
  code: string,
  school: string,
): Promise<boolean> {
  if (!env.RESEND_API_KEY || !env.SCHOOL_EMAIL_FROM) return false
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.SCHOOL_EMAIL_FROM,
        to: [to],
        subject: `${code} is your DeltaDeck school code`,
        text: `Your code to verify ${school} on DeltaDeck is ${code}. It works for 15 minutes.\n\nIf you did not ask for it, ignore this email.`,
      }),
    })
    if (!response.ok) {
      logEvent('error', { reason: 'school_email', code: response.status })
      return false
    }
    return true
  } catch (error) {
    logEvent('error', { reason: 'school_email', detail: describeError(error) })
    return false
  }
}
