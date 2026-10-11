import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { seedSession, TEST_SESSION_KEY } from '../test/session'
import {
  cachedUsername,
  devToken,
  forgetAccount,
  hadAccount,
  hasStoredSession,
  rememberHadAccount,
  rememberUsername,
  signedIn,
  useAccount,
} from './account'

const session = {
  access_token: 'a',
  refresh_token: 'r',
  expires_at: 1,
  user: { id: 'u1' },
}

describe('who is signed in', () => {
  it('counts a stored session only with both tokens, an expiry and a user id', () => {
    expect(hasStoredSession()).toBe(false)
    for (const broken of [
      '{}',
      'not json',
      JSON.stringify({ ...session, refresh_token: undefined }),
      JSON.stringify({ ...session, expires_at: '1' }),
      JSON.stringify({ ...session, user: {} }),
    ]) {
      localStorage.setItem('sb-x-auth-token', broken)
      expect(hasStoredSession(), broken).toBe(false)
    }
    // A PKCE verifier is not a session.
    localStorage.setItem('sb-x-auth-token-code-verifier', '"v"')
    expect(hasStoredSession()).toBe(false)
    localStorage.setItem('sb-x-auth-token', JSON.stringify(session))
    expect(hasStoredSession()).toBe(true)
    expect(signedIn()).toBe(true)
  })

  it('counts a development token', () => {
    sessionStorage.setItem('qp.devToken', 'dev.alice.e2e-local-secret-0001')
    expect(devToken()).toBe('dev.alice.e2e-local-secret-0001')
    expect(signedIn()).toBe(true)
    sessionStorage.setItem('qp.devToken', 'dev.alice')
    expect(signedIn()).toBe(false)
  })

  it('keeps a username only when it looks like one', () => {
    rememberUsername('alice_9')
    expect(cachedUsername()).toBe('alice_9')
    localStorage.setItem('qp.username', '<b>x</b>')
    expect(cachedUsername()).toBeNull()
  })

  it('remembers that this browser has had an account', () => {
    expect(hadAccount()).toBe(false)
    rememberHadAccount()
    expect(hadAccount()).toBe(true)
  })
})

describe('useAccount', () => {
  it('follows sign-in, the cached name and sign-out', () => {
    const { result } = renderHook(() => useAccount())
    expect(result.current).toEqual({ signedIn: false, username: null })
    act(() => {
      seedSession({ username: null })
      rememberUsername('alice')
    })
    expect(result.current).toEqual({ signedIn: true, username: 'alice' })
    act(() => forgetAccount())
    expect(result.current).toEqual({ signedIn: false, username: null })
    expect(localStorage.getItem(TEST_SESSION_KEY)).toBeNull()
  })

  it('hears another tab sign out', () => {
    seedSession()
    const { result } = renderHook(() => useAccount())
    expect(result.current.signedIn).toBe(true)
    act(() => {
      localStorage.removeItem(TEST_SESSION_KEY)
      window.dispatchEvent(new StorageEvent('storage'))
    })
    expect(result.current.signedIn).toBe(false)
  })
})

describe('forgetAccount', () => {
  it('drops every stored session, the name and a development token', () => {
    seedSession()
    localStorage.setItem('sb-other-auth-token', JSON.stringify(session))
    sessionStorage.setItem('qp.devToken', 'dev.alice.secret')
    rememberHadAccount()
    forgetAccount()
    expect(signedIn()).toBe(false)
    expect(cachedUsername()).toBeNull()
    // The next visit offers sign-in rather than a new account.
    expect(hadAccount()).toBe(true)
  })
})
