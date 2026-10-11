import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'

// Engine and protocol suites opt into `// @vitest-environment node`, where
// there is no DOM to prepare or clean up.
const dom = typeof window !== 'undefined'

if (dom) {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open')
  }
}

beforeEach(() => {
  if (!dom) return
  localStorage.clear()
  sessionStorage.clear()
  window.history.replaceState(null, '', '/')
  vi.stubGlobal('scrollTo', vi.fn())
})
afterEach(() => {
  if (!dom) return
  cleanup()
  vi.unstubAllGlobals()
})
