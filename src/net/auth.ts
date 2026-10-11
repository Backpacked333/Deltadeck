import { useEffect, useState } from 'react'
import type { Session, SupabaseClient } from '@supabase/supabase-js'
import { rememberAuthReturn } from '../lib/authReturn'

export type OAuthProvider = 'google' | 'apple'
export type Providers = Record<OAuthProvider | 'email', boolean>

const FALLBACK: Providers = { google: false, apple: false, email: true }

/** The shortest and longest password the sign-up form accepts. */
export const PASSWORD_MIN = 8
export const PASSWORD_MAX = 72

/**
 * Which sign-in methods the project has turned on, from Supabase Auth's public
 * settings endpoint, so the page never shows a button that cannot work.
 */
export async function loadProviders(
  url: string,
  key: string,
  fetcher: typeof fetch = fetch,
): Promise<Providers> {
  try {
    const response = await fetcher(`${url}/auth/v1/settings`, {
      headers: { apikey: key },
    })
    if (!response.ok) return FALLBACK
    const { external = {} } = (await response.json()) as {
      external?: Partial<Providers>
    }
    return {
      google: external.google === true,
      apple: external.apple === true,
      email: external.email !== false,
    }
  } catch {
    return FALLBACK
  }
}

export type AuthState =
  | { status: 'loading' }
  | { status: 'signed-out' }
  | { status: 'signed-in'; session: Session }

export function useAuth(client: SupabaseClient): AuthState {
  const [state, setState] = useState<AuthState>({ status: 'loading' })
  useEffect(() => {
    let live = true
    const apply = (session: Session | null) =>
      live &&
      setState(
        session ? { status: 'signed-in', session } : { status: 'signed-out' },
      )
    client.auth
      .getSession()
      .then(({ data }) => apply(data.session))
      .catch(() => apply(null))
    const { data } = client.auth.onAuthStateChange((_event, session) =>
      apply(session),
    )
    return () => {
      live = false
      data.subscription.unsubscribe()
    }
  }, [client])
  return state
}

/** Providers come back to the bare page; authReturn restores the route. */
const returnUrl = () => `${window.location.origin}${window.location.pathname}`

export async function signInWithProvider(
  client: SupabaseClient,
  provider: OAuthProvider,
) {
  rememberAuthReturn(window.location.hash || '#lobby')
  const { error } = await client.auth.signInWithOAuth({
    provider,
    options: { redirectTo: returnUrl() },
  })
  return error ? authMessage(error) : null
}

/** What an auth call reports when it fails: supabase-js's AuthError, loosely. */
type AuthProblem = {
  message: string
  code?: string
  status?: number
  name?: string
  reasons?: string[]
}

/** Plain words for a failed auth call, from its error code, never its text. */
export function authMessage(error: AuthProblem): string {
  if (error.status === 0 || error.name === 'AuthRetryableFetchError')
    return 'We could not reach the server. Check your connection and try again.'
  switch (error.code) {
    case 'invalid_credentials':
      return 'That email and password do not match an account.'
    case 'weak_password':
      return error.reasons?.includes('pwned')
        ? 'That password has appeared in a data breach. Choose another one.'
        : `Choose a stronger password: at least ${PASSWORD_MIN} characters.`
    case 'otp_expired':
      return 'That code is wrong or has expired. Check it, or send a new one.'
    case 'over_email_send_rate_limit':
      return 'Too many emails were sent just now. Wait a minute, then try again.'
    case 'over_request_rate_limit':
      return 'Too many attempts. Wait a minute, then try again.'
    case 'email_address_not_authorized':
      return 'Email sign-up is not open yet. Use another way to sign in, or try again later.'
    case 'email_address_invalid':
    case 'validation_failed':
      return 'Enter a valid email address.'
    case 'user_already_exists':
    case 'email_exists':
      return 'There is already an account with that email. Sign in instead.'
    case 'signup_disabled':
      return 'New accounts are paused right now. Try again later.'
    case 'same_password':
      return 'That is your current password. Choose a new one.'
    case 'email_provider_disabled':
      return 'Email sign-in is turned off right now.'
    default:
      return error.message || 'Something went wrong. Try again.'
  }
}

export type SignUpResult =
  | { status: 'code-sent' }
  | { status: 'exists' }
  | { status: 'signed-in' }
  | { status: 'error'; message: string }

/**
 * Creates an account with a password. With email confirmation on, Supabase
 * sends a code and returns no session; for an address that already has a
 * confirmed account it returns a user with no identities and sends nothing.
 */
export async function signUpWithEmail(
  client: SupabaseClient,
  email: string,
  password: string,
): Promise<SignUpResult> {
  const { data, error } = await client.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: returnUrl(),
      data: { terms_at: new Date().toISOString() },
    },
  })
  if (error) return { status: 'error', message: authMessage(error) }
  if (data.session) return { status: 'signed-in' }
  if (data.user && data.user.identities?.length === 0)
    return { status: 'exists' }
  return { status: 'code-sent' }
}

export type SignInResult =
  | { status: 'signed-in' }
  | { status: 'unconfirmed' }
  | { status: 'error'; message: string }

/**
 * Signs in with a password. An account whose email was never confirmed is
 * sent a fresh code, so the player can finish signing up from here.
 */
export async function signInWithEmail(
  client: SupabaseClient,
  email: string,
  password: string,
): Promise<SignInResult> {
  const { error } = await client.auth.signInWithPassword({ email, password })
  if (!error) return { status: 'signed-in' }
  if (error.code === 'email_not_confirmed') {
    const problem = await resendSignupCode(client, email)
    return problem
      ? { status: 'error', message: problem }
      : { status: 'unconfirmed' }
  }
  return { status: 'error', message: authMessage(error) }
}

/** Checks an emailed code: a new account's confirmation, or a reset. */
export async function verifyEmailCode(
  client: SupabaseClient,
  email: string,
  token: string,
  purpose: 'signup' | 'recovery',
) {
  const { error } = await client.auth.verifyOtp({
    email,
    token,
    type: purpose === 'signup' ? 'email' : 'recovery',
  })
  return error ? authMessage(error) : null
}

export async function resendSignupCode(client: SupabaseClient, email: string) {
  const { error } = await client.auth.resend({
    type: 'signup',
    email,
    options: { emailRedirectTo: returnUrl() },
  })
  return error ? authMessage(error) : null
}

export async function sendResetCode(client: SupabaseClient, email: string) {
  const { error } = await client.auth.resetPasswordForEmail(email, {
    redirectTo: returnUrl(),
  })
  return error ? authMessage(error) : null
}

export async function setNewPassword(client: SupabaseClient, password: string) {
  const { error } = await client.auth.updateUser({ password })
  return error ? authMessage(error) : null
}

/** Signs out this browser only; the player's other devices stay signed in. */
export async function signOutHere(client: SupabaseClient) {
  await client.auth.signOut({ scope: 'local' })
}
