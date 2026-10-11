import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Online } from './supabase'
import { cachedUsername, hadAccount, signedIn } from '../lib/account'
import { seedSession, TEST_SESSION_KEY } from '../test/session'
import SessionKeeper from './Session'

const loadOnline = vi.fn<() => Promise<Online | null>>()
vi.mock('./supabase', () => ({ loadOnline: () => loadOnline() }))

/** The project at https://test.supabase.co keeps its session in sb-test-auth-token. */
function service(session: { user: { id: string } } | null, username = 'alice') {
  const client = {
    auth: {
      onAuthStateChange: vi.fn((fn: (event: string, s: unknown) => void) => {
        queueMicrotask(() => fn('INITIAL_SESSION', session))
        return { data: { subscription: { unsubscribe: vi.fn() } } }
      }),
    },
    from: vi.fn(() => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { user_id: 'u1', username },
            error: null,
          }),
        }),
      }),
    })),
  }
  return {
    client,
    url: 'https://test.supabase.co',
    key: 'k',
  } as unknown as Online
}

beforeEach(() => loadOnline.mockReset())

describe('SessionKeeper', () => {
  it('forgets a session the service no longer honours, so the header offers Sign in', async () => {
    seedSession({ username: 'alice' })
    localStorage.setItem(
      'sb-old-auth-token',
      localStorage.getItem(TEST_SESSION_KEY)!,
    )
    loadOnline.mockResolvedValue(service(null))
    // supabase-js removed its own key when the refresh was refused.
    localStorage.removeItem(TEST_SESSION_KEY)
    render(<SessionKeeper />)
    await waitFor(() => expect(signedIn()).toBe(false))
    expect(localStorage.getItem('sb-old-auth-token')).toBeNull()
    expect(cachedUsername()).toBeNull()
  })

  it('keeps an offline player signed in: the stored session is still there', async () => {
    seedSession({ username: 'alice' })
    loadOnline.mockResolvedValue(service(null))
    render(<SessionKeeper />)
    await waitFor(() => expect(loadOnline).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(signedIn()).toBe(true)
    expect(cachedUsername()).toBe('alice')
  })

  it('caches the signed-in player name for the header', async () => {
    seedSession({ username: null })
    loadOnline.mockResolvedValue(service({ user: { id: 'u1' } }, 'bob_7'))
    render(<SessionKeeper />)
    await waitFor(() => expect(cachedUsername()).toBe('bob_7'))
    expect(hadAccount()).toBe(true)
  })

  it('never loads the account client for a development identity', async () => {
    sessionStorage.setItem('qp.devToken', 'dev.alice.secret')
    render(<SessionKeeper />)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(loadOnline).not.toHaveBeenCalled()
  })

  it('leaves the stored session alone where there is no account service', async () => {
    seedSession()
    loadOnline.mockResolvedValue(null)
    render(<SessionKeeper />)
    await waitFor(() => expect(loadOnline).toHaveBeenCalled())
    expect(signedIn()).toBe(true)
  })
})
