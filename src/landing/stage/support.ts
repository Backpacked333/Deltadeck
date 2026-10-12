// Whether the landing page draws the 3D stage. The hero is the neon table
// (the trainer's 2D Table) by default; the 3D stage is opt-in with
// ?stage=3d, and then still needs WebGL, wanted motion, and not a test or a
// ?motion=off run. Entry-light: no three.
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
  if (new URLSearchParams(window.location.search).get('stage') !== '3d')
    return false
  // jsdom (unit tests) has no canvas: the 2D table, without probing.
  if (navigator.userAgent.includes('jsdom')) return false
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
    return false
  return webglAvailable()
}
