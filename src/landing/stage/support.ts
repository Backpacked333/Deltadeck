// Whether the landing page draws the 3D stage: WebGL is there, motion is
// wanted, and this is not a test or a ?motion=off run. Entry-light: no three.
import { motionOff } from '../../env'

export function webglAvailable() {
  try {
    const c = document.createElement('canvas')
    return !!(c.getContext('webgl2') ?? c.getContext('webgl'))
  } catch {
    return false
  }
}

export function want3d() {
  if (motionOff || typeof window === 'undefined') return false
  // jsdom (unit tests) has no canvas: the 2D table, without probing.
  if (navigator.userAgent.includes('jsdom')) return false
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
    return false
  return webglAvailable()
}
