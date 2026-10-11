// GET /c/<receipt>: a shared challenge score (L-12, L-13). The page is the
// app with a link preview naming the hand and the score to beat; the app
// routes the path to #c/<receipt> (src/lib/profilePath.ts), where a friend
// plays the same hand. Anonymous: a receipt carries no name.
import { CHALLENGE_HANDS } from '../../src/challenge/hands'
import type { WorkerEnv } from './env'
import { describeError, logEvent } from './log'
import { previewPage } from './preview'
import type { Preview, PreviewOptions } from './preview'
import { scoreStub } from './scores'
import type { SharedScore } from './scores'

export const SHARE_PATH = /^\/c\/([0-9a-f]{32})\/?$/
/** The challenge share card (public/og-challenge.png, scripts/og-card.ts). */
export const CHALLENGE_IMAGE = '/og-challenge.png'

const GENERIC: Omit<Preview, 'status'> = {
  title: 'Most people misprice this hand. Do you? · DeltaDeck',
  description:
    'One hand of heads-up poker against Atlas, every decision graded like a chess move. No account needed.',
  type: 'website',
  image: CHALLENGE_IMAGE,
}

const ordinal = (n: number) =>
  n % 100 >= 11 && n % 100 <= 13
    ? 'th'
    : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')

/** The preview text for a shared score: only numbers and our own titles. */
export function describeShared(shared: SharedScore) {
  const title =
    CHALLENGE_HANDS.find((h) => h.id === shared.hand)?.title ?? 'a hand'
  const rank =
    shared.basis === 'players'
      ? `, ${shared.percentile}${ordinal(shared.percentile)} percentile`
      : ''
  return {
    title: `Beat ${shared.accuracy}/100 on “${title}” · DeltaDeck`,
    description: `Someone scored ${shared.accuracy}/100${rank} on this hand. One hand against Atlas, every decision graded. Your turn.`,
  }
}

export async function sharedScore(env: WorkerEnv, receipt: string) {
  return scoreStub(env).shared(receipt)
}

export async function sharePage(
  request: Request,
  env: WorkerEnv,
  options: PreviewOptions = {},
): Promise<Response> {
  const receipt = new URL(request.url).pathname.match(SHARE_PATH)?.[1]
  return previewPage(request, env, options, async () => {
    if (!receipt) return { status: 404, ...GENERIC }
    try {
      const shared = await sharedScore(env, receipt)
      if (!shared) return { status: 404, ...GENERIC }
      return { status: 200, ...GENERIC, ...describeShared(shared) }
    } catch (error) {
      logEvent('error', { reason: 'share', detail: describeError(error) })
      return { status: 200, ...GENERIC }
    }
  })
}
