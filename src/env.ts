// Test and screenshot switches read once from the URL query string.
import { seedRandom } from './lib/random'

const params = new URLSearchParams(
  typeof window === 'undefined' ? '' : window.location.search,
)

/** `?motion=off` freezes all animation for deterministic screenshots. */
export const motionOff = params.get('motion') === 'off'

const seed = params.get('seed')
if (seed !== null && Number.isFinite(Number(seed))) seedRandom(Number(seed))
