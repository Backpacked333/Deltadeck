// The online area: #lobby, #play/<matchId> and #welcome/onboard (sign-up
// from the landing page), the account pages #signup and #signin, a sign-in
// provider's return (?code=…), and the public pages:
// #ladder[/month], #u/<username> and #match/<matchId>. Lazy-loaded so the
// account client never reaches the entry chunk; the trainer works without
// any of it.
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { replaceRoute, takeAuthReturn } from '../lib/authReturn'
import { backFromSignIn } from '../lib/landing'
import { useHash } from '../lib/navigation'
import { AccountPage, AuthCallback, HOME_ROUTE } from './AccountPage'
import { devIdentity } from './api'
import type { Identity } from './api'
import { AuthGate } from './AuthGate'
import { Ladder } from './Ladder'
import { LiveTable } from './LiveTable'
import { Lobby } from './Lobby'
import { Onboarding } from './Onboarding'
import { MatchReview } from './MatchReview'
import { Profile } from './profile/Profile'
import { loadOnline } from './supabase'
import type { Online } from './supabase'
import './live.css'

const PLAY = /^#play\/([0-9a-f-]{36})$/
const LADDER = /^#ladder(\/month)?$/
const PROFILE = /^#u\/([a-z0-9_]{3,20})$/
const REVIEW = /^#match\/([0-9a-f-]{36})$/
/** After the landing page's "Save your score" (L-8). */
const ONBOARD = '#welcome/onboard'
const ACCOUNT = /^#sign(up|in)$/
/** Routes this area draws itself; a provider's return to any other finishes here. */
const OWN = [
  PLAY,
  LADDER,
  PROFILE,
  REVIEW,
  ACCOUNT,
  /^#lobby(\/find)?$/,
  /^#welcome\/onboard$/,
]

export default function LiveApp() {
  const hash = useHash()
  const matchId = hash.match(PLAY)?.[1] ?? null
  const ladder = hash.match(LADDER)
  const profile = hash.match(PROFILE)?.[1] ?? null
  const review = hash.match(REVIEW)?.[1] ?? null
  const account = hash.match(ACCOUNT)?.[1] as 'up' | 'in' | undefined
  // Back from Google or Apple: on a page of its own the gate there sees the
  // new session; from anywhere else (the bare URL, the practice table) the
  // sign-in is finished here, and so is any error the provider sent back.
  const [returning] = useState(backFromSignIn)
  const callback =
    returning &&
    (new URLSearchParams(window.location.search).has('error_description') ||
      !OWN.some((route) => route.test(hash)))
  const [dev] = useState(devIdentity)
  const [online, setOnline] = useState<Online | null | undefined>(undefined)
  useEffect(() => {
    if (dev) return
    let live = true
    void loadOnline().then((found) => live && setOnline(found))
    return () => {
      live = false
    }
  }, [dev])

  // #lobby/find starts looking straight away ("Find another match"); the
  // hash goes back to #lobby so a reload does not queue again. Derived from
  // the live hash: this component stays mounted from #play/<id> to here.
  // (replaceState fires no hashchange, so `hash` keeps the value until the
  // next navigation, and the Lobby queues once on mount.)
  const autoFind = hash === '#lobby/find'
  useEffect(() => {
    if (hash === '#lobby/find') window.history.replaceState(null, '', '#lobby')
  }, [hash])

  // A development identity is already signed in.
  useEffect(() => {
    if (dev && account) replaceRoute(takeAuthReturn() ?? HOME_ROUTE)
  }, [dev, account])

  if (callback || account)
    return (
      <div className="page live-page">
        <header className="page-head">
          {callback ? (
            <h1>Signing you in</h1>
          ) : account === 'up' ? (
            <>
              <h1>Join QuantPoker</h1>
              <p>
                One free account for practice against Atlas, the lessons, rated
                play and your public profile. Your hands are saved to it.
              </p>
            </>
          ) : (
            <>
              <h1>Welcome back</h1>
              <p>Sign in to pick up where you left off.</p>
            </>
          )}
        </header>
        {dev ? null : online === undefined ? (
          <p className="live-status" role="status">
            Connecting…
          </p>
        ) : callback ? (
          <AuthCallback online={online} route={hash} />
        ) : (
          <AccountPage
            online={online}
            mode={account === 'up' ? 'signup' : 'signin'}
          />
        )}
      </div>
    )

  const onboarding = hash === ONBOARD
  const content = (identity: Identity): ReactNode =>
    onboarding ? (
      <Onboarding identity={identity} client={online?.client ?? null} />
    ) : matchId ? (
      <LiveTable key={matchId} matchId={matchId} identity={identity} />
    ) : (
      <Lobby
        identity={identity}
        autoFind={autoFind}
        client={online?.client ?? null}
      />
    )

  // Public pages: no sign-in, read with the publishable key.
  const page: {
    title: string
    intro?: string
    body: (client: SupabaseClient) => ReactNode
  } | null = ladder
    ? {
        title: 'Ladder',
        intro: 'Rated heads-up: 40 hands a match, with all-in luck taken out.',
        body: (client) => (
          <Ladder
            key={ladder[1] ? 'month' : 'all'}
            client={client}
            view={ladder[1] ? 'month' : 'all'}
          />
        ),
      }
    : profile
      ? {
          title: profile,
          body: (client) => (
            <Profile key={profile} client={client} username={profile} />
          ),
        }
      : review
        ? {
            title: 'Match review',
            intro: 'Every hand, with only the cards shown at showdown.',
            body: (client) => (
              <MatchReview key={review} client={client} matchId={review} />
            ),
          }
        : null
  if (page)
    return (
      <div className="page live-page">
        <header className="page-head">
          <h1>{page.title}</h1>
          {page.intro && <p>{page.intro}</p>}
          <p className="live-muted">
            <a href="#ladder">Ladder</a> · <a href="#lobby">Play rated</a> ·{' '}
            <a href="#method">Method</a>
          </p>
        </header>
        {online === undefined && !dev ? (
          <p className="live-status" role="status">
            Connecting…
          </p>
        ) : online ? (
          page.body(online.client)
        ) : (
          <p className="live-muted" role="status">
            This page is not available on this site: it has no account service
            configured.
          </p>
        )}
      </div>
    )

  return (
    <div className={`page live-page ${matchId ? 'live-page-table' : ''}`}>
      {onboarding ? (
        <header className="page-head">
          <h1>Save your score</h1>
          <p>One account: your score, a rating, a public profile.</p>
        </header>
      ) : (
        !matchId && (
          <header className="page-head">
            <h1>Play online</h1>
            <p>Real opponents, play money, every hand reviewable afterwards.</p>
            <p className="live-muted">
              <a href="#ladder">Ladder</a> · <a href="#fair-play">Fair play</a>{' '}
              · <a href="#terms">Terms</a>
            </p>
          </header>
        )
      )}
      {dev ? (
        content(dev)
      ) : online === undefined ? (
        <p className="live-status" role="status">
          Connecting…
        </p>
      ) : (
        <AuthGate
          client={online?.client ?? null}
          url={online?.url ?? ''}
          apiKey={online?.key ?? ''}
          onboarding={onboarding}
        >
          {content}
        </AuthGate>
      )}
    </div>
  )
}
