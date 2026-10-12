import { render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Online } from './supabase'
import { cachedUsername, hadAccount, signedIn } from '../lib/account'
import { emptyProgress } from '../lib/storage'
import type { HandRecord, Progress } from '../lib/storage'
import { seedSession, TEST_SESSION_KEY } from '../test/session'
import { revisionService } from './syncTestHarness'
import SessionKeeper from './Session'

const loadOnline = vi.fn<() => Promise<Online | null>>()
vi.mock('./supabase', () => ({ loadOnline: () => loadOnline() }))

/**
 * The project at https://test.supabase.co (its session is kept in
 * sb-test-auth-token): auth, the players table, and the account's
 * practice tables (fakeAccount).
 */
function service(
  session: { user: { id: string } } | null,
  username = 'alice',
  account = revisionService(),
) {
  const players = {
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({
          data: { user_id: 'u1', username },
          error: null,
        }),
      }),
    }),
  }
  const client = {
    auth: {
      onAuthStateChange: vi.fn((fn: (event: string, s: unknown) => void) => {
        queueMicrotask(() => fn('INITIAL_SESSION', session))
        return { data: { subscription: { unsubscribe: vi.fn() } } }
      }),
    },
    from: () => players,
    rpc: account.client.rpc,
  }
  return {
    client,
    url: 'https://test.supabase.co',
    key: 'k',
  } as unknown as Online
}

/** App's part: the progress state, handed to the keeper. */
function Host({
  initial = emptyProgress(),
  onReady = () => {},
}: {
  initial?: Progress
  onReady?: () => void
}) {
  const [progress, setProgress] = useState(initial)
  return (
    <>
      <p data-testid="hands">{progress.hands.map((h) => h.id).join(',')}</p>
      <SessionKeeper
        progress={progress}
        onMerge={setProgress}
        onLearningReplaced={() => {}}
        onReady={onReady}
      />
    </>
  )
}

const hand = (id: string, at: number) =>
  ({ id, hand: at, net: 1, result: 'won', guided: false, at }) as HandRecord

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
    render(<Host />)
    await waitFor(() => expect(signedIn()).toBe(false))
    expect(localStorage.getItem('sb-old-auth-token')).toBeNull()
    expect(cachedUsername()).toBeNull()
  })

  it('keeps an offline player signed in: the stored session is still there', async () => {
    seedSession({ username: 'alice' })
    loadOnline.mockResolvedValue(service(null))
    render(<Host />)
    await waitFor(() => expect(loadOnline).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(signedIn()).toBe(true)
    expect(cachedUsername()).toBe('alice')
  })

  it('caches the signed-in player name for the header', async () => {
    seedSession({ username: null })
    loadOnline.mockResolvedValue(service({ user: { id: 'u1' } }, 'bob_7'))
    render(<Host />)
    await waitFor(() => expect(cachedUsername()).toBe('bob_7'))
    expect(hadAccount()).toBe(true)
  })

  it('never loads the account client for a development identity', async () => {
    sessionStorage.setItem('qp.devToken', 'dev.alice.secret')
    render(<Host />)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(loadOnline).not.toHaveBeenCalled()
  })

  it('leaves the stored session alone where there is no account service', async () => {
    seedSession()
    loadOnline.mockResolvedValue(null)
    render(<Host />)
    await waitFor(() => expect(loadOnline).toHaveBeenCalled())
    expect(signedIn()).toBe(true)
  })
})

describe('practice history', () => {
  it("brings the account's hands into this browser and sends this browser's", async () => {
    seedSession()
    const account = revisionService({ hands: [hand('on-account', 1)] })
    loadOnline.mockResolvedValue(
      service({ user: { id: 'u1' } }, 'alice', account),
    )
    const ready = vi.fn()
    render(
      <Host
        initial={{ ...emptyProgress(), owner: 'u1', hands: [hand('here', 2)] }}
        onReady={ready}
      />,
    )
    await waitFor(() =>
      expect(screen.getByTestId('hands')).toHaveTextContent('on-account,here'),
    )
    expect(ready).toHaveBeenCalled()
    await waitFor(() => expect(account.state.hands.has('here')).toBe(true))
  })

  it('is ready at once without an account service', async () => {
    seedSession()
    loadOnline.mockResolvedValue(null)
    const ready = vi.fn()
    render(<Host onReady={ready} />)
    await waitFor(() => expect(ready).toHaveBeenCalled())
  })

  it('F10 failed first pull never calls ready and exposes unverified state', async () => {
    seedSession()
    const account = revisionService(); account.state.readError = true
    loadOnline.mockResolvedValue(service({ user: { id: 'u1' } }, 'alice', account))
    const ready = vi.fn()
    render(<Host onReady={ready} />)
    await screen.findByText(/Unable to verify account history/)
    expect(ready).not.toHaveBeenCalled()
  })
})
