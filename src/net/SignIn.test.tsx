import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { authMessage } from './auth'
import { RESEND_AFTER_S, SignIn } from './SignIn'
import type { SignInMode } from './SignIn'

type Problem = { code?: string; message: string; status?: number }

/** Just the auth calls the form makes, each answering with `error` by default. */
function fakeAuth(
  overrides: Partial<Record<string, (...args: unknown[]) => unknown>> = {},
) {
  const ok = async () => ({ data: {}, error: null })
  const auth = {
    signUp: vi.fn(async () => ({
      data: { user: { identities: [{ id: 'i1' }] }, session: null },
      error: null as Problem | null,
    })),
    signInWithPassword: vi.fn(async () => ({
      data: {},
      error: null as Problem | null,
    })),
    signInWithOAuth: vi.fn(ok),
    verifyOtp: vi.fn(ok),
    resend: vi.fn(ok),
    resetPasswordForEmail: vi.fn(ok),
    updateUser: vi.fn(ok),
    ...overrides,
  }
  return { auth } as unknown as SupabaseClient & { auth: typeof auth }
}

function settings(external: Record<string, boolean>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ external }))),
  )
}

const renderForm = (client: SupabaseClient, mode: SignInMode = 'signup') =>
  render(
    <SignIn
      client={client}
      url="https://x.supabase.co"
      apiKey="k"
      mode={mode}
    />,
  )

const here = `${window.location.origin}/`

afterEach(() => {
  vi.useRealTimers()
  sessionStorage.clear()
})

describe('SignIn', () => {
  it('creates an account with email and password, then confirms it with the emailed code', async () => {
    settings({ email: true })
    const client = fakeAuth()
    renderForm(client)
    expect(
      await screen.findByRole('heading', { name: 'Create your free account' }),
    ).toBeInTheDocument()
    expect(screen.getByText(/school badge/)).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('Email'), ' sam@uni.edu ')
    await userEvent.type(screen.getByLabelText('Password'), 'correct horse')
    await userEvent.click(
      screen.getByRole('button', { name: 'Create account' }),
    )
    expect(client.auth.signUp).toHaveBeenCalledWith({
      email: 'sam@uni.edu',
      password: 'correct horse',
      options: {
        emailRedirectTo: here,
        data: { terms_at: expect.any(String) },
      },
    })
    expect(
      await screen.findByRole('heading', { name: 'Check your email' }),
    ).toBeInTheDocument()
    expect(screen.getByText('sam@uni.edu')).toBeInTheDocument()
    const code = screen.getByLabelText('Code from the email')
    expect(code).toHaveAttribute('autocomplete', 'one-time-code')
    await userEvent.type(code, '12 34-56')
    expect(code).toHaveValue('123456')
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(client.auth.verifyOtp).toHaveBeenCalledWith({
      email: 'sam@uni.edu',
      token: '123456',
      type: 'email',
    })
  })

  it('refuses a password under 8 characters before calling the server', async () => {
    settings({ email: true })
    const client = fakeAuth()
    renderForm(client)
    await userEvent.type(await screen.findByLabelText('Email'), 'a@b.co')
    await userEvent.type(screen.getByLabelText('Password'), 'short')
    await userEvent.click(
      screen.getByRole('button', { name: 'Create account' }),
    )
    expect(screen.getByRole('alert')).toHaveTextContent('at least 8 characters')
    expect(client.auth.signUp).not.toHaveBeenCalled()
  })

  it('offers sign-in for an email that already has an account', async () => {
    settings({ email: true })
    const client = fakeAuth({
      signUp: vi.fn(async () => ({
        data: { user: { identities: [] }, session: null },
        error: null,
      })),
    })
    renderForm(client)
    await userEvent.type(await screen.findByLabelText('Email'), 'a@b.co')
    await userEvent.type(screen.getByLabelText('Password'), 'long enough')
    await userEvent.click(
      screen.getByRole('button', { name: 'Create account' }),
    )
    expect(
      await screen.findByRole('heading', { name: 'Sign in to DeltaDeck' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(
      'There is already an account for a@b.co',
    )
    expect(screen.getByLabelText('Email')).toHaveValue('a@b.co')
  })

  it('says a wrong password does not match, without saying which part', async () => {
    settings({ email: true })
    const client = fakeAuth({
      signInWithPassword: vi.fn(async () => ({
        data: {},
        error: {
          code: 'invalid_credentials',
          message: 'Invalid login credentials',
          status: 400,
        },
      })),
    })
    renderForm(client, 'signin')
    await userEvent.type(await screen.findByLabelText('Email'), 'a@b.co')
    await userEvent.type(screen.getByLabelText('Password'), 'not it at all')
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That email and password do not match an account.',
    )
    expect(client.auth.signInWithPassword).toHaveBeenCalledWith({
      email: 'a@b.co',
      password: 'not it at all',
    })
  })

  it('sends a new code to an account that never confirmed its email', async () => {
    settings({ email: true })
    const client = fakeAuth({
      signInWithPassword: vi.fn(async () => ({
        data: {},
        error: {
          code: 'email_not_confirmed',
          message: 'Email not confirmed',
          status: 400,
        },
      })),
    })
    renderForm(client, 'signin')
    await userEvent.type(await screen.findByLabelText('Email'), 'a@b.co')
    await userEvent.type(screen.getByLabelText('Password'), 'long enough')
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(
      await screen.findByRole('heading', { name: 'Check your email' }),
    ).toBeInTheDocument()
    expect(client.auth.resend).toHaveBeenCalledWith({
      type: 'signup',
      email: 'a@b.co',
      options: { emailRedirectTo: here },
    })
  })

  it('lets a new code be sent only after a minute', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    settings({ email: true })
    const client = fakeAuth()
    renderForm(client)
    await user.type(await screen.findByLabelText('Email'), 'a@b.co')
    await user.type(screen.getByLabelText('Password'), 'long enough')
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    const wait = await screen.findByRole('button', {
      name: /Send a new code in \d+ s/,
    })
    expect(wait).toBeDisabled()
    await act(async () => {
      vi.advanceTimersByTime(RESEND_AFTER_S * 1000 + 1000)
    })
    await user.click(screen.getByRole('button', { name: 'Send a new code' }))
    expect(client.auth.resend).toHaveBeenCalledTimes(1)
    expect(await screen.findByRole('status')).toHaveTextContent(
      'We sent a new code to a@b.co.',
    )
    expect(
      screen.getByRole('button', { name: /Send a new code in \d+ s/ }),
    ).toBeDisabled()
  })

  it('resets a forgotten password with a code and a new password', async () => {
    settings({ email: true })
    const client = fakeAuth()
    renderForm(client, 'signin')
    await userEvent.click(
      await screen.findByRole('button', { name: 'Forgot your password?' }),
    )
    await userEvent.type(screen.getByLabelText('Email'), 'a@b.co')
    await userEvent.click(
      screen.getByRole('button', { name: 'Send reset code' }),
    )
    expect(client.auth.resetPasswordForEmail).toHaveBeenCalledWith('a@b.co', {
      redirectTo: here,
    })
    await userEvent.type(
      await screen.findByLabelText('Code from the email'),
      '654321',
    )
    await userEvent.type(
      screen.getByLabelText('New password'),
      'brand new pass',
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Set new password' }),
    )
    expect(client.auth.verifyOtp).toHaveBeenCalledWith({
      email: 'a@b.co',
      token: '654321',
      type: 'recovery',
    })
    expect(client.auth.updateUser).toHaveBeenCalledWith({
      password: 'brand new pass',
    })
  })

  it('keeps the old password when the reset code is wrong', async () => {
    settings({ email: true })
    const client = fakeAuth({
      verifyOtp: vi.fn(async () => ({
        data: {},
        error: {
          code: 'otp_expired',
          message: 'Token has expired',
          status: 403,
        },
      })),
    })
    renderForm(client, 'signin')
    await userEvent.click(
      await screen.findByRole('button', { name: 'Forgot your password?' }),
    )
    await userEvent.type(screen.getByLabelText('Email'), 'a@b.co')
    await userEvent.click(
      screen.getByRole('button', { name: 'Send reset code' }),
    )
    await userEvent.type(
      await screen.findByLabelText('Code from the email'),
      '000000',
    )
    await userEvent.type(
      screen.getByLabelText('New password'),
      'brand new pass',
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Set new password' }),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That code is wrong or has expired',
    )
    expect(client.auth.updateUser).not.toHaveBeenCalled()
  })

  it('shows Apple and Google only when enabled, and remembers where to come back to', async () => {
    window.history.replaceState(null, '', '/#welcome/onboard')
    settings({ google: true, apple: true, email: true })
    const client = fakeAuth()
    renderForm(client)
    await userEvent.click(
      await screen.findByRole('button', { name: 'Continue with Apple' }),
    )
    expect(client.auth.signInWithOAuth).toHaveBeenCalledWith({
      provider: 'apple',
      options: { redirectTo: here },
    })
    expect(sessionStorage.getItem('qp.afterAuth')).toBe('#welcome/onboard')
    expect(
      screen.getByRole('button', { name: 'Continue with Google' }),
    ).toBeInTheDocument()
    expect(screen.getByText('or')).toBeInTheDocument()
    window.history.replaceState(null, '', '/')
  })

  it('shows no email form when email sign-in is off', async () => {
    settings({ google: true, apple: false, email: false })
    renderForm(fakeAuth())
    expect(
      await screen.findByRole('button', { name: 'Continue with Google' }),
    ).toBeInTheDocument()
    expect(screen.queryByLabelText('Email')).toBeNull()
    expect(screen.queryByText('or')).toBeNull()
  })

  it('explains an address the email service will not send to yet', async () => {
    settings({ email: true })
    const client = fakeAuth({
      signUp: vi.fn(async () => ({
        data: { user: null, session: null },
        error: {
          code: 'email_address_not_authorized',
          message: 'Email address not authorized',
          status: 400,
        },
      })),
    })
    renderForm(client)
    await userEvent.type(await screen.findByLabelText('Email'), 'a@b.co')
    await userEvent.type(screen.getByLabelText('Password'), 'long enough')
    await userEvent.click(
      screen.getByRole('button', { name: 'Create account' }),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Email sign-up is not open yet',
    )
  })
})

describe('authMessage', () => {
  it('turns error codes into plain words, never the server text', () => {
    expect(
      authMessage({
        code: 'over_email_send_rate_limit',
        message: 'email rate limit exceeded',
        status: 429,
      }),
    ).toBe('Too many emails were sent just now. Wait a minute, then try again.')
    expect(
      authMessage({
        code: 'weak_password',
        message: 'weak',
        status: 422,
        reasons: ['pwned'],
      }),
    ).toMatch(/data breach/)
    expect(
      authMessage({
        code: 'weak_password',
        message: 'weak',
        reasons: ['length'],
      }),
    ).toMatch(/at least 8 characters/)
    expect(
      authMessage({
        name: 'AuthRetryableFetchError',
        message: 'Failed to fetch',
        status: 0,
      }),
    ).toMatch(/could not reach the server/)
    expect(authMessage({ message: 'Something new' })).toBe('Something new')
  })
})
