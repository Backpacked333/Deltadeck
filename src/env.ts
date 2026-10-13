// Test and screenshot switches read once from the URL query string.
import { seedRandom } from './lib/random'

const params = new URLSearchParams(
  typeof window === 'undefined' ? '' : window.location.search,
)

/** `?motion=off` freezes all animation for deterministic screenshots. */
export const motionOff = params.get('motion') === 'off'

const seed = params.get('seed')
if (seed !== null && Number.isFinite(Number(seed))) seedRandom(Number(seed))

/**
 * How richly the table is drawn. `lite` on a software renderer (no GPU:
 * the table's blurs, perspective and glass cost a frame each there, as the
 * 3D stage's tier 0 does for the same reason); `full` otherwise.
 * `?render=lite|full` pins it, for tests and screenshots.
 */
export const renderTier: 'full' | 'lite' = (() => {
  const asked = params.get('render')
  if (asked === 'lite' || asked === 'full') return asked
  if (typeof document === 'undefined') return 'full'
  if (navigator.userAgent.includes('jsdom')) return 'full'
  try {
    const gl = document.createElement('canvas').getContext('webgl')
    const info = gl?.getExtension('WEBGL_debug_renderer_info')
    const name = info
      ? String(gl!.getParameter(info.UNMASKED_RENDERER_WEBGL))
      : ''
    return /swiftshader|llvmpipe|softpipe|software/i.test(name)
      ? 'lite'
      : 'full'
  } catch {
    return 'full'
  }
})()
