import { useSyncExternalStore } from 'react'

const subscribe = (listener: () => void) => {
  window.addEventListener('hashchange', listener)
  return () => window.removeEventListener('hashchange', listener)
}

export function useHash() {
  return useSyncExternalStore(subscribe, () => window.location.hash)
}

/** The query string, re-read on every hashchange (a sign-in's ?code=…). */
export function useSearch() {
  return useSyncExternalStore(subscribe, () => window.location.search)
}

export function isLearningRoute(hash: string) {
  return hash === '#learn' || hash.startsWith('#learn/')
}
