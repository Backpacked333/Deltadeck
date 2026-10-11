import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { rememberAuthReturn } from '../lib/authReturn'
import { AccountPage, AuthCallback } from './AccountPage'
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
