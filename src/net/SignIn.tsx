// Account creation and sign-in: Google and Apple where the project has turned
// them on, and an email with a password. A new email is confirmed with a code
// typed on this page rather than a link, so it works whichever device opens
// the email, and a forgotten password is reset the same way. Signing in
// changes the client's session; the page around this form follows it.
import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { Mail } from 'lucide-react'
import {
  loadProviders,
  PASSWORD_MAX,
  PASSWORD_MIN,
  resendSignupCode,
  sendResetCode,
  setNewPassword,
  signInWithEmail,
  signInWithProvider,
  signUpWithEmail,
  verifyEmailCode,
} from './auth'
import type { OAuthProvider, Providers } from './auth'
import { useNow } from './useNow'

export type SignInMode = 'signup' | 'signin'

type Step =
  | { kind: 'signup' }
  | { kind: 'signin' }
  | { kind: 'code'; email: string }
  | { kind: 'forgot' }
  | { kind: 'reset'; email: string }

/** Seconds before a code can be sent again (Supabase allows one a minute). */
export const RESEND_AFTER_S = 60

const PROVIDER_LABELS: Record<OAuthProvider, string> = {
  google: 'Continue with Google',
  apple: 'Continue with Apple',
}

type Props = {
  client: SupabaseClient
  url: string
  apiKey: string
  mode: SignInMode
  /** Headings for the two forms, where the page has a reason to sign in. */
  titles?: Partial<Record<SignInMode, string>>
}

export function SignIn({ client, url, apiKey, mode, titles = {} }: Props) {
  const [providers, setProviders] = useState<Providers | null>(null)
  const [step, setStep] = useState<Step>({ kind: mode })
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [sentAt, setSentAt] = useState(0)

  useEffect(() => {
    let live = true
    loadProviders(url, apiKey).then((p) => live && setProviders(p))
    return () => {
      live = false
    }
  }, [url, apiKey])

  const go = (next: Step, message: string | null = null) => {
    setStep(next)
    setNotice(message)
    setError(null)
    setCode('')
    if (next.kind === 'reset' || next.kind === 'signup') setPassword('')
  }
  const codeSent = (next: Step) => {
    setSentAt(Date.now())
    go(next)
  }
  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await work()
    } finally {
      setBusy(false)
    }
  }
  const address = email.trim()
  const shortPassword = password.length < PASSWORD_MIN

  const oauth = (provider: OAuthProvider) =>
    run(async () => setError(await signInWithProvider(client, provider)))

  const signUp = (event: FormEvent) => {
    event.preventDefault()
    if (shortPassword) {
      setError(`Use at least ${PASSWORD_MIN} characters for your password.`)
      return
    }
    void run(async () => {
      const result = await signUpWithEmail(client, address, password)
      if (result.status === 'error') setError(result.message)
      else if (result.status === 'exists')
        go(
          { kind: 'signin' },
          `There is already an account for ${address}. Sign in instead.`,
        )
      else if (result.status === 'code-sent')
        codeSent({ kind: 'code', email: address })
    })
  }
  const signIn = (event: FormEvent) => {
    event.preventDefault()
    void run(async () => {
      const result = await signInWithEmail(client, address, password)
      if (result.status === 'error') setError(result.message)
      else if (result.status === 'unconfirmed')
        codeSent({ kind: 'code', email: address })
    })
  }
  const confirm = (event: FormEvent) => {
    event.preventDefault()
    if (step.kind !== 'code') return
    void run(async () =>
      setError(await verifyEmailCode(client, step.email, code, 'signup')),
    )
  }
  const forgot = (event: FormEvent) => {
    event.preventDefault()
    void run(async () => {
      const problem = await sendResetCode(client, address)
      if (problem) setError(problem)
      else codeSent({ kind: 'reset', email: address })
    })
  }
  const reset = (event: FormEvent) => {
    event.preventDefault()
    if (step.kind !== 'reset') return
    if (shortPassword) {
      setError(`Use at least ${PASSWORD_MIN} characters for your password.`)
      return
    }
    // The code signs the player in, so the new password is set straight after.
    void run(async () => {
      const problem =
        (await verifyEmailCode(client, step.email, code, 'recovery')) ??
        (await setNewPassword(client, password))
      setError(problem)
    })
  }
  const resend = () =>
    void run(async () => {
      if (step.kind !== 'code' && step.kind !== 'reset') return
      const problem =
        step.kind === 'code'
          ? await resendSignupCode(client, step.email)
          : await sendResetCode(client, step.email)
      if (problem) setError(problem)
      else {
        setSentAt(Date.now())
        setNotice(`We sent a new code to ${step.email}.`)
      }
    })

  const title =
    step.kind === 'code'
      ? 'Check your email'
      : step.kind === 'forgot' || step.kind === 'reset'
        ? 'Reset your password'
        : step.kind === 'signup'
          ? (titles.signup ?? 'Create your free account')
          : (titles.signin ?? 'Sign in to DeltaDeck')

  return (
    <section className="panel live-signin" aria-labelledby="signin-title">
      <h2 id="signin-title">{title}</h2>
      {notice && (
        <p className="live-sent" role="status">
          <Mail size={16} /> {notice}
        </p>
      )}
      {providers === null ? (
        <p className="live-status" role="status">
          Loading sign-in options…
        </p>
      ) : step.kind === 'signup' || step.kind === 'signin' ? (
        <>
          {(['google', 'apple'] as const)
            .filter((p) => providers[p])
            .map((p) => (
              <button
                key={p}
                type="button"
                className="btn btn-outline btn-lg live-wide"
                disabled={busy}
                onClick={() => void oauth(p)}
              >
                {PROVIDER_LABELS[p]}
              </button>
            ))}
          {providers.email && (providers.google || providers.apple) && (
            <p className="live-or" aria-hidden="true">
              or
            </p>
          )}
          {providers.email &&
            (step.kind === 'signup' ? (
              <form className="live-form" onSubmit={signUp}>
                <EmailField value={email} onChange={setEmail} />
                <PasswordField
                  value={password}
                  onChange={setPassword}
                  autoComplete="new-password"
                  hint={`At least ${PASSWORD_MIN} characters.`}
                />
                <button className="btn btn-primary btn-lg" disabled={busy}>
                  Create account
                </button>
              </form>
            ) : (
              <form className="live-form" onSubmit={signIn}>
                <EmailField value={email} onChange={setEmail} />
                <PasswordField
                  value={password}
                  onChange={setPassword}
                  autoComplete="current-password"
                />
                <button className="btn btn-primary btn-lg" disabled={busy}>
                  Sign in
                </button>
                <button
                  type="button"
                  className="btn btn-quiet live-link"
                  onClick={() => go({ kind: 'forgot' })}
                >
                  Forgot your password?
                </button>
              </form>
            ))}
          {!providers.email && !providers.google && !providers.apple && (
            <p role="alert">Sign-in is turned off for this site right now.</p>
          )}
          {step.kind === 'signup' ? (
            <>
              <p className="live-muted live-small">
                Students: sign up with your school email, or your school’s
                Google account, and your school badge is added once the email is
                confirmed.
              </p>
              <p className="live-switch">
                Already have an account?{' '}
                <button
                  type="button"
                  className="btn btn-quiet live-link"
                  onClick={() => go({ kind: 'signin' })}
                >
                  Sign in
                </button>
              </p>
            </>
          ) : (
            <p className="live-switch">
              New to DeltaDeck?{' '}
              <button
                type="button"
                className="btn btn-quiet live-link"
                onClick={() => go({ kind: 'signup' })}
              >
                Create a free account
              </button>
            </p>
          )}
        </>
      ) : step.kind === 'code' ? (
        <form className="live-form" onSubmit={confirm}>
          <p className="live-muted">
            We sent a code to <b>{step.email}</b>. Enter it here to confirm your
            account. It can take a minute to arrive; check your spam folder too.
          </p>
          <CodeField value={code} onChange={setCode} />
          <button className="btn btn-primary btn-lg" disabled={busy}>
            Confirm
          </button>
          <CodeActions
            sentAt={sentAt}
            busy={busy}
            onResend={resend}
            back="Use a different email"
            onBack={() => go({ kind: 'signup' })}
          />
        </form>
      ) : step.kind === 'forgot' ? (
        <form className="live-form" onSubmit={forgot}>
          <p className="live-muted">
            We will email you a code to choose a new password.
          </p>
          <EmailField value={email} onChange={setEmail} />
          <button className="btn btn-primary btn-lg" disabled={busy}>
            Send reset code
          </button>
          <button
            type="button"
            className="btn btn-quiet live-link"
            onClick={() => go({ kind: 'signin' })}
          >
            Back to sign in
          </button>
        </form>
      ) : (
        <form className="live-form" onSubmit={reset}>
          <p className="live-muted">
            If <b>{step.email}</b> has an account, we sent it a code. Enter it
            with your new password.
          </p>
          <CodeField value={code} onChange={setCode} />
          <PasswordField
            label="New password"
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
            hint={`At least ${PASSWORD_MIN} characters.`}
          />
          <button className="btn btn-primary btn-lg" disabled={busy}>
            Set new password
          </button>
          <CodeActions
            sentAt={sentAt}
            busy={busy}
            onResend={resend}
            back="Back to sign in"
            onBack={() => go({ kind: 'signin' })}
          />
        </form>
      )}
      {error && (
        <p className="live-error" role="alert">
          {error}
        </p>
      )}
      <p className="live-muted live-small">
        By continuing you confirm you are 18 or older and agree to the{' '}
        <a href="#terms">Terms</a>. Play money only: no prizes, no deposits.
        Your username and finished hands are public; your email is not.{' '}
        <a href="#privacy">Privacy</a> says what we keep.
      </p>
    </section>
  )
}

function EmailField({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  return (
    <div className="live-field">
      <label htmlFor="signin-email">Email</label>
      <input
        id="signin-email"
        type="email"
        autoComplete="email"
        required
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  )
}

function PasswordField({
  label = 'Password',
  value,
  onChange,
  autoComplete,
  hint,
}: {
  label?: string
  value: string
  onChange: (value: string) => void
  autoComplete: 'new-password' | 'current-password'
  hint?: string
}) {
  const [shown, setShown] = useState(false)
  return (
    <div className="live-field">
      <label htmlFor="signin-password">{label}</label>
      <div className="live-row live-row-tight">
        <input
          id="signin-password"
          type={shown ? 'text' : 'password'}
          autoComplete={autoComplete}
          required
          maxLength={PASSWORD_MAX}
          value={value}
          aria-describedby={hint ? 'signin-password-hint' : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          className="btn btn-outline"
          aria-pressed={shown}
          onClick={() => setShown(!shown)}
        >
          {shown ? 'Hide' : 'Show'}
        </button>
      </div>
      {hint && (
        <p id="signin-password-hint" className="live-muted live-small">
          {hint}
        </p>
      )}
    </div>
  )
}

function CodeField({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  return (
    <div className="live-field">
      <label htmlFor="signin-code">Code from the email</label>
      <input
        id="signin-code"
        className="live-code"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{6,10}"
        required
        maxLength={10}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))}
      />
    </div>
  )
}

function CodeActions({
  sentAt,
  busy,
  onResend,
  back,
  onBack,
}: {
  sentAt: number
  busy: boolean
  onResend: () => void
  back: string
  onBack: () => void
}) {
  const now = useNow(1000)
  const wait = Math.max(
    0,
    Math.ceil((sentAt + RESEND_AFTER_S * 1000 - now) / 1000),
  )
  return (
    <div className="live-actions">
      <button
        type="button"
        className="btn btn-outline"
        disabled={busy || wait > 0}
        onClick={onResend}
      >
        {wait > 0 ? `Send a new code in ${wait} s` : 'Send a new code'}
      </button>
      <button type="button" className="btn btn-quiet" onClick={onBack}>
        {back}
      </button>
    </div>
  )
}
