import { attemptFor, fixedClock } from '../core/__fixtures__/testing'
import type { AttemptSnapshot } from '../core/types'
import { taskById } from './content'
import { evaluateSubmission, seal, submission } from './evidence'
export const OWNER = '11111111-1111-4111-8111-111111111111'
export function attempt(
  slug = 'incremental-poker-call',
  changes: Partial<AttemptSnapshot> = {},
) {
  return attemptFor(taskById.get(`targeted-${slug}`)!.case, {
    submittedAt: fixedClock().toISOString(),
    phase: 'results_ready',
    ...changes,
    ...(changes.submittedAt
      ? { submittedAt: new Date(changes.submittedAt).toISOString() }
      : {}),
  })
}
export async function records(
  slug = 'incremental-poker-call',
  changes: Partial<AttemptSnapshot> = {},
) {
  const s = submission(OWNER, attempt(slug, changes))
  return [await seal(s), await seal(evaluateSubmission(s))]
}
