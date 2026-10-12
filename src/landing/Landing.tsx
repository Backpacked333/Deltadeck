// The landing page (L-1, L-2, L-9; landing v2). The hero is a cinematic 3D
// table (ADR-001) where the visitor plays one graded hand; the 2D trainer
// table stands in without WebGL or with reduced motion. Below it the page
// says what DeltaDeck is, how the grading and the ladder work, and what a
// free account gives you, with a way to create one on every screen (or, for
// a signed-in visitor, a way to play online). Lazy-loaded: it is the home
// page at the bare URL.
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowRight,
  Award,
  BookOpen,
  ChartNoAxesCombined,
  Check,
  Link2,
  Lock,
  Save,
  ShieldCheck,
  Swords,
  UserRound,
} from 'lucide-react'
import { CHALLENGE_HANDS } from '../challenge/hands'
import { rememberAuthReturn } from '../lib/authReturn'
import { hashString } from '../lib/random'
import { track, visitorId } from '../lib/track'
import { ChallengeHand } from './ChallengeHand'
import type { FinishedChallenge } from './ChallengeHand'
import { tilt, untilt, useReveal } from './motion'
import { ScoreCard } from './ScoreCard'
import type { Stage } from './stage/stage'
import { SchoolBanners } from './SchoolBanners'
import { StageCanvas } from './stage/StageCanvas'
import { want3d } from './stage/support'
import { GRADE_BANDS } from './why'
import './landing.css'

/** Each visitor starts on their own hand, so a spoiler helps nobody much. */
const firstHand = () => hashString(visitorId()) % CHALLENGE_HANDS.length
const SHARE_HASH = /^#c\/([0-9a-f]{32})$/

/** A friend's shared score (L-13), from GET /api/challenge/shared/<receipt>. */
export type Rival = {
  hand: string
  ver: number
  accuracy: number
  percentile: number
  basis: 'players' | 'model'
}

/** Sign-up, from any of the page's account buttons. */
function createAccount() {
  track('signup_start')
  window.location.hash = '#signup'
}

/** Scrolls to the explanation; #how is not a route, so the hash stays. */
function toHow(e: React.MouseEvent) {
  e.preventDefault()
  const reduced = window.matchMedia?.(
    '(prefers-reduced-motion: reduce)',
  ).matches
  document
    .getElementById('how')
    ?.scrollIntoView?.({ behavior: reduced ? 'auto' : 'smooth' })
}

/** A signed-in visitor's account buttons go online instead. */
const playOnline = () => (window.location.hash = '#lobby')
/** Onboarding claims the waiting score for a signed-in account too. */
const saveScore = () => (window.location.hash = '#welcome/onboard')
/** A new account goes to onboarding anyway; a returning one claims it there. */
function signUpToSave() {
  rememberAuthReturn('#welcome/onboard')
  createAccount()
}

export default function Landing({ signedIn = false }: { signedIn?: boolean }) {
  const [index, setIndex] = useState(firstHand)
  const [round, setRound] = useState(1)
  const [finished, setFinished] = useState<FinishedChallenge | null>(null)
  const play = useRef<HTMLDivElement>(null)
  // The 3D stage: wanted when the browser can draw it; null until it runs.
  const [mode, setMode] = useState<'3d' | '2d'>(() => (want3d() ? '3d' : '2d'))
  const [stage, setStage] = useState<Stage | null>(null)
  const [layer, setLayer] = useState<HTMLDivElement | null>(null)
  const onStage = useCallback((s: Stage) => setStage(s), [])
  const onStageFail = useCallback(() => {
    setStage(null)
    setMode('2d')
  }, [])
  // Opened from a friend's link: play their hand, with their score to beat.
  const [link] = useState(
    () => window.location.hash.match(SHARE_HASH)?.[1] ?? null,
  )
  const [rival, setRival] = useState<Rival | 'loading' | 'missing' | null>(
    link ? 'loading' : null,
  )

  useEffect(() => track('landing_view'), [])
  useEffect(() => {
    if (!link) return
    track('challenge_link_open')
    let live = true
    fetch(`/api/challenge/shared/${link}`)
      .then((r) => (r.ok ? (r.json() as Promise<Rival>) : null))
      .catch(() => null)
      .then((found) => {
        if (!live) return
        const at = found
          ? CHALLENGE_HANDS.findIndex(
              (h) => h.id === found.hand && h.ver === found.ver,
            )
          : -1
        if (!found || at < 0) return setRival('missing')
        setIndex(at)
        setRival(found)
      })
    return () => {
      live = false
    }
  }, [link])
  const against =
    rival && typeof rival === 'object' && finished?.spec.id === rival.hand
      ? rival
      : null

  const onDone = useCallback(
    (result: FinishedChallenge) => {
      setFinished(result)
      stage?.wide()
    },
    [stage],
  )
  const again = () => {
    setFinished(null)
    setIndex((i) => i + 1)
    setRound((r) => r + 1)
    stage?.seat()
  }
  const toPlay = () => {
    play.current?.scrollIntoView({ block: 'center' })
    play.current?.querySelector<HTMLButtonElement>('button:enabled')?.focus()
  }
  // While the stage loads, the hand waits for it (a lit poster shows), so
  // the first cards are dealt on the felt rather than in 2D.
  const staging = mode === '3d' && !stage

  return (
    <div
      className={`landing ${mode === '3d' ? 'is-3d' : 'is-2d'} ${finished ? 'is-done' : ''}`}
    >
      <section className="landing-hero" aria-labelledby="landing-title">
        {mode === '3d' && (
          <div className="stage-box">
            <div className="stage-poster" aria-hidden />
            <StageCanvas onReady={onStage} onFail={onStageFail} />
            <div className="stage-layer" ref={setLayer} />
          </div>
        )}
        <div className="landing-pitch">
          <p className="landing-kicker">
            <span className="landing-pulse" aria-hidden /> Heads-up hold'em ·
            graded like chess · play money
          </p>
          <h1 id="landing-title">
            Most people misprice this hand. <em>Do you?</em>
          </h1>
          <p className="landing-lede">
            DeltaDeck is a rated ladder for poker <b>decisions</b>. Every move
            is graded against the math, the luck is taken out, and you see where
            you rank. Play this hand against Atlas now; no account needed.
          </p>
          {rival && typeof rival === 'object' && (
            <p className="landing-rival" role="status">
              A friend scored <b>{rival.accuracy}/100</b> on this hand. Beat it.
            </p>
          )}
          {rival === 'missing' && (
            <p className="landing-rival" role="status">
              That challenge link has expired, so here is a fresh hand.
            </p>
          )}
          <p className="landing-links-row">
            <button className="btn btn-accent btn-hero" onClick={toPlay}>
              Play the challenge hand
            </button>
            {signedIn ? (
              <>
                <a href="#table">
                  Open your table <ArrowRight size={14} />
                </a>
                <a href="#lobby">Play online</a>
              </>
            ) : (
              <>
                <button className="landing-inline" onClick={createAccount}>
                  Create free account <ArrowRight size={14} />
                </button>
                <a href="#signin">Sign in</a>
              </>
            )}
            <a href="#how" onClick={toHow}>
              How it works
            </a>
          </p>
          <p className="landing-note">
            No account needed for the first hand. Sixty seconds, graded on the
            spot.
          </p>
        </div>
        <div className="landing-play" ref={play}>
          {rival === 'loading' || staging ? (
            <p className="landing-loading" role="status">
              {staging ? 'Lighting the table…' : "Dealing your friend's hand…"}
            </p>
          ) : finished ? (
            <ScoreCard
              finished={finished}
              rival={against}
              signedIn={signedIn}
              onSave={signedIn ? saveScore : signUpToSave}
              onAgain={signedIn ? again : signUpToSave}
              againLabel={
                signedIn
                  ? 'Play another hand'
                  : 'Create a free account to keep playing'
              }
            />
          ) : (
            <ChallengeHand
              key={round}
              index={index}
              round={round}
              stage={stage}
              labelLayer={layer}
              onDone={onDone}
            />
          )}
        </div>
        {mode === '3d' && !finished && (
          <span className="stage-hint" aria-hidden>
            Scroll for how it works
          </span>
        )}
      </section>

      <SchoolBanners signedIn={signedIn} onJoin={createAccount} />
      <HowItWorks onPlay={toPlay} />
      <YourAccount onPlay={toPlay} signedIn={signedIn} />

      <Reveal
        as="section"
        className="landing-band landing-trust"
        labelledBy="fair-title"
      >
        <div className="landing-copy">
          <h2 id="fair-title">Fair by construction</h2>
          <p>
            Play money only: no deposits, no withdrawals, no prizes. Online
            decks are committed before the deal, and your browser checks every
            card it is shown against that commitment. Rated hands are graded
            only after the match, so nobody can see an engine mid-game.
          </p>
          <p className="landing-links">
            <a href="#fair-play">
              <Lock size={13} /> Fair play
            </a>
            <a href="#method">How ratings work</a>
            <a href="#terms">Terms</a>
            <a href="#privacy">Privacy</a>
          </p>
        </div>
      </Reveal>

      <Reveal as="section" className="landing-final" labelledBy="final-title">
        <h2 id="final-title">One hand. Sixty seconds. Where do you rank?</h2>
        <div className="landing-final-cta">
          <button className="btn btn-accent btn-lg" onClick={toPlay}>
            Play the hand <ArrowRight size={16} />
          </button>
          {signedIn ? (
            <button className="btn btn-ghost-desk btn-lg" onClick={playOnline}>
              <Swords size={16} /> Play online
            </button>
          ) : (
            <button
              className="btn btn-ghost-desk btn-lg"
              onClick={createAccount}
            >
              <UserRound size={16} /> Create free account
            </button>
          )}
        </div>
      </Reveal>
    </div>
  )
}

/** A section that animates in as it scrolls into view. */
function Reveal({
  as: Tag,
  className,
  labelledBy,
  id,
  children,
}: {
  as: 'section' | 'div'
  className: string
  labelledBy?: string
  id?: string
  children: React.ReactNode
}) {
  const ref = useReveal<HTMLElement>()
  return (
    <Tag
      ref={ref as React.Ref<HTMLDivElement>}
      className={`${className} reveal`}
      aria-labelledby={labelledBy}
      id={id}
    >
      {children}
    </Tag>
  )
}

const STEPS = [
  {
    title: 'Play a hand',
    body: 'Heads-up no-limit hold’em for play money: one opponent, every decision yours. Against Atlas here, against real people once you have an account.',
    art: 'cards',
  },
  {
    title: 'Every decision is graded',
    body: 'At each decision the engine prices every option, from folding to each bet size, against the hands your opponent could hold. Your grade is the expected value you gave up, as a share of the pot, like a chess engine grading moves.',
    art: 'grades',
  },
  {
    title: 'Luck is taken out',
    body: 'The cards decide who wins a pot; they never decide your score. Results and decision quality are reported apart, and rated all-ins are settled at equity, so a lucky river cannot carry a bad player up the ladder.',
    art: 'lines',
  },
  {
    title: 'Climb a ladder that means something',
    body: 'Rated 40-hand matches against people near your level, with the analysis switched off. A Glicko-2 rating shown with its uncertainty, an accuracy number, a public profile, and a ladder by school.',
    art: 'ladder',
  },
] as const

function HowItWorks({ onPlay }: { onPlay: () => void }) {
  return (
    <section className="landing-how" id="how" aria-labelledby="how-title">
      <Reveal as="div" className="landing-how-head">
        <h2 id="how-title">How DeltaDeck works</h2>
        <p>
          Poker is a fast loop for the instincts trading desks test: pricing
          risk, sizing a bet, staying calibrated under pressure. DeltaDeck turns
          each hand into feedback.
        </p>
      </Reveal>
      <div className="landing-steps">
        {STEPS.map((step, i) => (
          <Reveal as="div" className="landing-step" key={step.title}>
            <span className="landing-step-n">
              {String(i + 1).padStart(2, '0')}
            </span>
            <div className="landing-step-copy">
              <h3>{step.title}</h3>
              <p>{step.body}</p>
              {i === 0 && (
                <button className="landing-inline" onClick={onPlay}>
                  Play the hand above <ArrowRight size={14} />
                </button>
              )}
            </div>
            <StepArt kind={step.art} />
          </Reveal>
        ))}
      </div>
    </section>
  )
}

function StepArt({ kind }: { kind: (typeof STEPS)[number]['art'] }) {
  if (kind === 'grades')
    return (
      <ul className="landing-grades art">
        {GRADE_BANDS.map(([grade, band], i) => (
          <li key={grade} style={{ '--i': i } as React.CSSProperties}>
            <span className={`grade grade-${grade.toLowerCase()}`}>
              {grade}
            </span>
            <span>{band}</span>
          </li>
        ))}
      </ul>
    )
  if (kind === 'lines')
    return (
      <div className="landing-lines art" aria-hidden>
        <svg viewBox="0 0 320 120" preserveAspectRatio="none">
          <polyline
            className="is-noise"
            points="0,70 16,30 32,96 48,40 64,104 80,20 96,80 112,36 128,100 144,50 160,12 176,92 192,56 208,108 224,28 240,82 256,44 272,98 288,34 304,72 320,52"
          />
          <polyline
            className="is-signal"
            points="0,104 40,98 80,90 120,84 160,72 200,64 240,52 280,42 320,30"
          />
        </svg>
        <span className="is-noise">Results (the cards)</span>
        <span className="is-signal">Decisions (your score)</span>
      </div>
    )
  if (kind === 'ladder')
    return (
      <ol className="landing-ladder art" aria-hidden>
        {[
          ['1', 'mit_quant', '1712 ± 58', 'MIT'],
          ['2', 'riverlogic', '1688 ± 61', 'Princeton'],
          ['3', 'you', '1650 ± 90', 'your school'],
          ['4', 'kellybet', '1641 ± 72', 'LSE'],
        ].map(([n, name, rating, school], i) => (
          <li
            key={n}
            className={name === 'you' ? 'is-you' : ''}
            style={{ '--i': i } as React.CSSProperties}
          >
            <span>{n}</span>
            <b>{name}</b>
            <em>{school}</em>
            <code>{rating}</code>
          </li>
        ))}
      </ol>
    )
  return (
    <div className="landing-fan art" aria-hidden>
      {['A♠', 'K♥', '7♦'].map((c, i) => (
        <span
          key={c}
          className={i === 1 ? 'is-red' : ''}
          style={{ '--i': i } as React.CSSProperties}
        >
          {c}
        </span>
      ))}
    </div>
  )
}

const PERKS = [
  {
    icon: Save,
    title: 'Every score saved',
    body: 'Your challenge scores and every rated match, with a hand-by-hand review.',
  },
  {
    icon: ChartNoAxesCombined,
    title: 'A rating that means something',
    body: 'Glicko-2 on luck-adjusted results, always shown with its uncertainty.',
  },
  {
    icon: Swords,
    title: 'Rated matches against people',
    body: 'Matched near your level. Forty hands, a clock, no engine during play.',
  },
  {
    icon: UserRound,
    title: 'A public profile',
    body: 'quantpoker/u/you: rating, accuracy and recent matches, made to share.',
  },
  {
    icon: Award,
    title: 'Play for your school',
    body: 'Verify a school email and your badge shows on your profile and the ladder.',
  },
  {
    icon: Link2,
    title: 'Challenge friends',
    body: 'Send a hand with your score to beat; see who priced it better.',
  },
  {
    icon: BookOpen,
    title: 'Learn between matches',
    body: 'Lessons on expected value, pot odds and ranges, linked from your mistakes.',
  },
] as const

function YourAccount({
  onPlay,
  signedIn,
}: {
  onPlay: () => void
  signedIn: boolean
}) {
  return (
    <section className="landing-account" aria-labelledby="account-title">
      <Reveal as="div" className="landing-account-head">
        <h2 id="account-title">Your free account</h2>
        <p>
          Your first hand needs nothing. An account is where it starts to count,
          and what you play with after it.
        </p>
        <ul className="landing-account-facts">
          <li>
            <Check size={14} /> Free, play money only
          </li>
          <li>
            <Check size={14} /> Sign up in under a minute
          </li>
          <li>
            <Check size={14} /> Your email is never shown
          </li>
        </ul>
        <div className="landing-account-cta">
          {signedIn ? (
            <button className="btn btn-accent btn-lg" onClick={playOnline}>
              Play online <ArrowRight size={16} />
            </button>
          ) : (
            <button className="btn btn-accent btn-lg" onClick={createAccount}>
              Create free account <ArrowRight size={16} />
            </button>
          )}
          <button className="landing-inline" onClick={onPlay}>
            Or play the hand first
          </button>
        </div>
      </Reveal>
      <div className="landing-perks">
        {PERKS.map(({ icon: Icon, title, body }, i) => (
          <Reveal as="div" className="landing-perk" key={title}>
            <div
              className="landing-perk-card"
              style={{ '--i': i } as React.CSSProperties}
              onPointerMove={tilt}
              onPointerLeave={untilt}
            >
              <Icon size={20} />
              <strong>{title}</strong>
              <span>{body}</span>
            </div>
          </Reveal>
        ))}
      </div>
      <p className="landing-account-fine">
        <ShieldCheck size={14} /> 18+. No deposits, no withdrawals, no prizes
        with cash value.
      </p>
    </section>
  )
}
