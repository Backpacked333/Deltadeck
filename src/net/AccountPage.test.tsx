import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { rememberAuthReturn } from '../lib/authReturn'
import { seedSession, TEST_SESSION_KEY } from '../test/session'
import { signedIn } from '../lib/account'
import { emptyProgress } from '../lib/storage'
import type { HandRecord } from '../lib/storage'
import { revisionService } from './syncTestHarness'
import { activeSync, PracticeSync } from './sync'
import { startEvidenceBootstrap } from './evidenceBootstrap'
import { AccountPage, AuthCallback, SignOut } from './AccountPage'
import type { Online } from './supabase'

/** Auth and the players table: signed in (as a named or new player) or not. */
function online({
  signedIn = true,
  username = 'alice',
}: { signedIn?: boolean; username?: string } = {}): Online {
  const client = {
    auth: {
      getSession: vi.fn(async () => ({
        data: { session: signedIn ? { user: { id: 'u1' } } : null },
      })),
      onAuthStateChange: vi.fn(() => ({
        data: { subscription: { unsubscribe: vi.fn() } },
      })),
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
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ external: {} }))),
  )
  return {
    client: client as unknown as SupabaseClient,
    url: 'https://x.supabase.co',
    key: 'k',
  }
}

const at = (url: string) => window.history.replaceState(null, '', url)
const unsentHand = {
  id: 's:1',
  hand: 1,
  net: 5,
  result: 'won',
  guided: false,
  at: 1,
} as HandRecord
afterEach(() => { activeSync()?.stop(); vi.restoreAllMocks() })
async function prepared() {
  const account = revisionService()
  const sync = new PracticeSync(account.client, 'u1', { merge: () => {}, reloadLearning: () => {} })
  sync.note({ ...emptyProgress(), owner: 'u1' })
  await sync.start(); await sync.flush(1000)
  return { account, sync }
}

describe('AccountPage', () => {
  it('sends a signed-in player on to where they were going', async () => {
    at('/#signin')
    rememberAuthReturn('#progress')
    render(<AccountPage online={online()} mode="signin" />)
    await waitFor(() => expect(window.location.hash).toBe('#progress'))
  })

  it('sends a player with nowhere remembered to the practice table', async () => {
    at('/#signin')
    render(<AccountPage online={online()} mode="signin" />)
    await waitFor(() => expect(window.location.hash).toBe('#table'))
  })

  it('sends a new account to choose its name, keeping where it was going', async () => {
    at('/#signup')
    rememberAuthReturn('#learn/path')
    render(
      <AccountPage
        online={online({ username: 'player_0123456789ab' })}
        mode="signup"
      />,
    )
    await waitFor(() => expect(window.location.hash).toBe('#welcome/onboard'))
    expect(sessionStorage.getItem('qp.afterAuth')).toBe('#learn/path')
  })

  it('shows the form to someone signed out, headed by a waiting score', async () => {
    at('/#signup')
    localStorage.setItem(
      'qp.pendingClaim',
      JSON.stringify({
        receipt: 'a'.repeat(32),
        hand: 'h1',
        ver: 1,
        accuracy: 91,
        percentile: null,
        at: 0,
      }),
    )
    render(<AccountPage online={online({ signedIn: false })} mode="signup" />)
    expect(
      await screen.findByRole('heading', {
        name: 'Save your score of 91 and get rated',
      }),
    ).toBeInTheDocument()
    expect(window.location.hash).toBe('#signup')
  })

  it('explains a site with no account service', () => {
    render(<AccountPage online={null} mode="signin" />)
    expect(screen.getByText(/not set up on this site/)).toBeInTheDocument()
  })
})

describe('AuthCallback', () => {
  it('finishes a provider sign-in and opens the page the player left, without the code', async () => {
    at('/?code=abc#table')
    render(<AuthCallback online={online()} route="#table" />)
    expect(screen.getByRole('status')).toHaveTextContent('Signing you in')
    await waitFor(() => expect(window.location.search).toBe(''))
    expect(window.location.hash).toBe('#table')
  })

  it('sends a new account from a provider to choose its name', async () => {
    at('/?code=abc')
    render(
      <AuthCallback
        online={online({ username: 'player_0123456789ab' })}
        route=""
      />,
    )
    await waitFor(() => expect(window.location.hash).toBe('#welcome/onboard'))
    expect(window.location.search).toBe('')
    expect(sessionStorage.getItem('qp.afterAuth')).toBe('#table')
  })

  it('shows a provider error with a way to try again', async () => {
    at('/?error=access_denied&error_description=Access+denied#table')
    render(<AuthCallback online={online({ signedIn: false })} route="#table" />)
    expect(screen.getByRole('alert')).toHaveTextContent('Access denied')
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(window.location.hash).toBe('#signin')
    expect(window.location.search).toBe('')
    expect(sessionStorage.getItem('qp.afterAuth')).toBe('#table')
  })

  it('says so when the code no longer signs anyone in', async () => {
    at('/?code=stale')
    render(<AuthCallback online={online({ signedIn: false })} route="" />)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'opened in a different browser',
    )
  })
})

describe('SignOut', () => {
  it('retries the same account sync when initialization finishes after sign-out mounts', async () => {
    seedSession()
    const replace = vi.fn(); vi.stubGlobal('location', { ...window.location, replace })
    render(<SignOut online={online()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('unverified')
    const { sync } = await prepared()
    const flush = vi.spyOn(sync, 'flush')
    await userEvent.click(screen.getByRole('button', { name: 'Wait and retry save' }))
    await waitFor(() => expect(replace).toHaveBeenCalled())
    expect(flush).toHaveBeenCalled()
  })
  it('exports the same account sync when initialization finishes after sign-out mounts', async () => {
    seedSession()
    const replace = vi.fn(); vi.stubGlobal('location', { ...window.location, replace })
    render(<SignOut online={online()} />)
    await screen.findByRole('alert')
    const { sync } = await prepared()
    const exporter = vi.spyOn(sync, 'exportAccount')
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() }))
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    await userEvent.click(screen.getByRole('button', { name: 'Export and sign out' }))
    await screen.findByRole('button', { name: 'I saved the export — sign out' })
    expect(exporter).toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
  })
  it('never adopts another account initialized after sign-out mounts', async () => {
    seedSession()
    const replace = vi.fn(); vi.stubGlobal('location', { ...window.location, replace })
    render(<SignOut online={online()} />)
    await screen.findByRole('alert')
    const account = revisionService()
    const other = new PracticeSync(account.client, 'u2', { merge: () => {}, reloadLearning: () => {} })
    const flush = vi.spyOn(other, 'flush')
    const exporter = vi.spyOn(other, 'exportAccount')
    const clear = vi.spyOn(other, 'clearDevice')
    await userEvent.click(screen.getByRole('button', { name: 'Wait and retry save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The account changed')
    await userEvent.click(screen.getByRole('button', { name: 'Export and sign out' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The account changed')
    expect(flush).not.toHaveBeenCalled()
    expect(exporter).not.toHaveBeenCalled()
    expect(clear).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
  })
  it('F10 failed pre-runtime evidence bootstrap prevents sign-out from clearing private work', async () => {
    const { sync } = await prepared()
    seedSession()
    localStorage.setItem('quantpoker.learning.v2', '{"private":"retained"}')
    const replace = vi.fn(); vi.stubGlobal('location', { ...window.location, replace })
    const clear = vi.spyOn(sync, 'clearDevice')
    await startEvidenceBootstrap(sync, false, async () => { throw new Error('Evidence chunk unavailable') })
    render(<SignOut online={online()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('not verified')
    expect(clear).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
    expect(localStorage.getItem('quantpoker.learning.v2')).toBe('{"private":"retained"}')
    expect(signedIn()).toBe(true)
  })
  it('signs this browser out, forgets the account and starts at the home page', async () => {
    await prepared()
    seedSession({ username: 'alice' })
    at('/#signout')
    const replace = vi.fn()
    vi.stubGlobal('location', { ...window.location, replace })
    const service = online()
    const signOut = vi.fn(async () => ({ error: null }))
    Object.assign(service.client.auth, { signOut })
    render(<SignOut online={service} />)
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/'))
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' })
    expect(localStorage.getItem(TEST_SESSION_KEY)).toBeNull()
    expect(localStorage.getItem('qp.username')).toBeNull()
  })

  it("forgets this browser's practice: the account keeps it", async () => {
    await prepared()
    seedSession()
    localStorage.setItem('quantpoker.progress.v2', '{"hands":[]}')
    localStorage.setItem('quantpoker.learning.v2', '{}')
    const replace = vi.fn()
    vi.stubGlobal('location', { ...window.location, replace })
    render(<SignOut online={online()} />)
    await waitFor(() => expect(replace).toHaveBeenCalled())
    expect(localStorage.getItem('quantpoker.progress.v2')).toBeNull()
    expect(localStorage.getItem('quantpoker.learning.v2')).toBeNull()
  })

  it('asks before dropping practice that could not reach the account', async () => {
    seedSession()
    const replace = vi.fn()
    vi.stubGlobal('location', { ...window.location, replace })
    const account = revisionService()
    const sync = new PracticeSync(account.client, 'u1', {
      merge: () => {},
      reloadLearning: () => {},
    })
    try {
      await sync.start()
      account.state.offline = true
      sync.note({ ...emptyProgress(), owner: 'u1', hands: [unsentHand] })
      render(<SignOut online={online()} />)
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'not verified',
      )
      expect(replace).not.toHaveBeenCalled()
      await userEvent.click(
        screen.getByRole('button', { name: 'Stay signed in' }),
      )
      // (window.location is stubbed here; the document's is the real one.)
      expect(document.location.hash).toBe('#table')
      expect(signedIn()).toBe(true)
    } finally {
      sync.stop()
    }
  })

  it('still signs out when the account service cannot be reached', async () => {
    await prepared()
    seedSession()
    const replace = vi.fn()
    vi.stubGlobal('location', { ...window.location, replace })
    const service = online()
    Object.assign(service.client.auth, {
      signOut: vi.fn(async () => {
        throw new Error('offline')
      }),
    })
    render(<SignOut online={service} />)
    await waitFor(() => expect(replace).toHaveBeenCalled())
    expect(localStorage.getItem(TEST_SESSION_KEY)).toBeNull()
  })

  it('F10 initial-pull failure blocks leave; explicit discard requires second confirmation', async () => {
    seedSession()
    const { account, sync } = await prepared()
    account.state.offline = true
    sync.note({ ...emptyProgress(), owner: 'u1', hands: [unsentHand] })
    const replace = vi.fn(); vi.stubGlobal('location', { ...window.location, replace })
    render(<SignOut online={online()} />)
    await screen.findByRole('alert')
    await userEvent.click(screen.getByRole('button', { name: 'Discard unsaved work and sign out' }))
    expect(replace).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Confirm permanent discard and sign out' }))
    await waitFor(() => expect(replace).toHaveBeenCalled())
    expect(localStorage.getItem(TEST_SESSION_KEY)).toBeNull()
  })
  it('F10 export failure never clears data or exits; download requires explicit saved-file confirmation', async () => {
    seedSession()
    const { account, sync } = await prepared()
    account.state.offline = true
    sync.note({ ...emptyProgress(), owner: 'u1', hands: [unsentHand] })
    const replace = vi.fn(); vi.stubGlobal('location', { ...window.location, replace })
    const exporter = vi.spyOn(sync, 'exportAccount').mockRejectedValueOnce(new Error('export disk failed'))
    render(<SignOut online={online()} />)
    await screen.findByRole('alert')
    await userEvent.click(screen.getByRole('button', { name: 'Export and sign out' }))
    expect(await screen.findByText(/export disk failed/)).toBeInTheDocument()
    expect(signedIn()).toBe(true); expect(replace).not.toHaveBeenCalled()
    exporter.mockRestore()
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() }))
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    await userEvent.click(screen.getByRole('button', { name: 'Export and sign out' }))
    await screen.findByRole('button', { name: 'I saved the export — sign out' })
    expect(signedIn()).toBe(true); expect(replace).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'I saved the export — sign out' }))
    await waitFor(() => expect(replace).toHaveBeenCalled())
  })
  it('F10 storage removal failure is a visible privacy failure, not completion', async () => {
    seedSession(); await prepared()
    const replace = vi.fn(); vi.stubGlobal('location', { ...window.location, replace })
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('denied') })
    render(<SignOut online={online()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Privacy cleanup failed')
    expect(replace).not.toHaveBeenCalled()
  })
  it('F10 absence of initial account reconciliation is not saved', async () => {
    seedSession()
    const replace = vi.fn(); vi.stubGlobal('location', { ...window.location, replace })
    render(<SignOut online={online()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('unverified')
    expect(replace).not.toHaveBeenCalled()
  })
})
