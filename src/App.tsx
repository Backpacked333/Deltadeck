import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react'
import type { CSSProperties } from 'react'
import {
  BookOpen,
  ChartNoAxesCombined,
  CircleHelp,
  Coins,
  Diamond,
  Gauge,
  Globe,
  GraduationCap,
  Lightbulb,
  Lock,
  Monitor,
  Moon,
  Settings2,
  Spade,
  Sun,
  Target,
  X,
} from 'lucide-react'
import { atlasDecision } from './lib/atlas'
import type { DecisionAction } from './lib/finance'
import { gradeDecision } from './lib/grading'
import type { DecisionGrade } from './lib/grading'
import { heroContext, raiseAnalysis, spotOutcome } from './lib/model'
import { cardLabel, legalActions } from './lib/poker'
import type { Action, Game } from './lib/poker'
import type { FullSpot } from './lib/range'
import { motionOff } from './env'
import { random } from './lib/random'
import { playSound, setVolume } from './lib/sound'
import type { SoundKind } from './lib/sound'
import {
  emptyProgress,
  LESSON_IDS,
  readProgress,
  saveProgress,
  upsertHand,
} from './lib/storage'
import type {
  DecisionRecord,
  HandRecord,
  LessonId,
  Progress,
  Settings,
} from './lib/storage'
import { useMediaQuery } from './hooks'
import { isLearningRoute, useHash, useSearch } from './lib/navigation'
import type { LearningSession } from './curriculum/core/session'
import { spotKey, useSpots } from './state/spots'
import { guessKey, initialTrainer, trainerReducer } from './state/trainer'
import { useRunout } from './state/runout'
import { LazyMotion, useReducedMotionConfig } from 'motion/react'
import type { FinishedHand } from './state/trainer'
import { Table } from './components/table/Table'
import { ActionBar } from './components/table/ActionBar'
import { buildPresets } from './lib/presets'
import type { Preset } from './lib/presets'
import { LabSkeleton } from './components/lab/LabSkeleton'
import { LabSheet } from './components/LabSheet'
import { SplitHandle } from './components/SplitHandle'
import { HandReview } from './components/review/HandReview'
import { ProgressView } from './components/progress/ProgressView'
import { LearnView } from './components/learn/LearnView'
import {
  HelpDialog,
  HistoryDialog,
  SettingsDialog,
  WelcomeDialog,
} from './components/Dialogs'
import { Tour } from './components/Tour'
import { CardDefs } from './components/cards/CardArt'
import type { TourStep } from './components/Tour'
import { backFromSignIn } from './lib/landing'
import { useAccount } from './lib/account'
import { AccountMenu } from './components/AccountMenu'
import { track } from './lib/track'

type View =
  | 'play'
  | 'curriculum'
  | 'quick'
  | 'progress'
  | 'gallery'
  | 'live'
  | 'info'
  | 'landing'
type Route = { view: View; lesson: LessonId | null }
const Curriculum = lazy(() => import('./curriculum/Curriculum'))
const LiveApp = lazy(() => import('./net/LiveApp'))
// Signed in: checks the stored session with the account service (lazy, so
// the account client never reaches the entry chunk).
const SessionKeeper = lazy(() => import('./net/Session'))
const InfoPage = lazy(() => import('./info/InfoPages'))
const Gallery = lazy(() => import('./dev/Gallery'))
const Landing = lazy(() => import('./landing/Landing'))
// The lab is the heaviest view; it loads in parallel with the first paint.
const labModule = import('./components/lab/Lab')
const Lab = lazy(() => labModule.then((module) => ({ default: module.Lab })))

/**
 * Hash routes: the landing page (the bare URL, #start, or #c/<receipt> for a
 * friend's challenge), #table (default), #progress, #lobby[/find],
 * #play/<id>, #ladder[/month], #u/<username> and #match/<id> (online play),
 * #signup and #signin, #fair-play, #terms and #method, #learn/...
 * and #learn/quick[/id]. A return from a sign-in provider (?code=…) opens the
 * online area, which finishes the sign-in, whatever the hash.
 */
function parseRoute(hash: string, search = ''): Route {
  if (backFromSignIn(search)) return { view: 'live', lesson: null }
  if (
    hash === '#start' ||
    /^#c\/[0-9a-f]{32}$/.test(hash) ||
    hash === '' ||
    hash === '#'
  )
    return { view: 'landing', lesson: null }
  const quick = hash.match(/^#learn\/quick(?:\/([\w-]+))?$/)
  if (quick) {
    const id = quick[1] as LessonId | undefined
    return { view: 'quick', lesson: id && LESSON_IDS.includes(id) ? id : null }
  }
  if (isLearningRoute(hash)) return { view: 'curriculum', lesson: null }
  if (hash === '#progress') return { view: 'progress', lesson: null }
  if (
    /^#lobby(?:\/find)?$/.test(hash) ||
    /^#play\/[0-9a-f-]{36}$/.test(hash) ||
    /^#ladder(?:\/month)?$/.test(hash) ||
    /^#u\/[a-z0-9_]{3,20}$/.test(hash) ||
    /^#match\/[0-9a-f-]{36}$/.test(hash) ||
    hash === '#welcome/onboard' ||
    hash === '#signup' ||
    hash === '#signin' ||
    hash === '#signout'
  )
    return { view: 'live', lesson: null }
  if (hash === '#fair-play' || hash === '#terms' || hash === '#method')
    return { view: 'info', lesson: null }
  if (import.meta.env.DEV && hash === '#dev/gallery')
    return { view: 'gallery', lesson: null }
  return { view: 'play', lesson: null }
}
/**
 * Navigate between views. Where supported, the browser cross-fades the old
 * and new page (View Transitions API); the hashchange that re-renders the
 * app resolves the transition.
 */
function go(hash: string) {
  const target = hash ? `#${hash}` : ''
  if (window.location.hash === target) return
  // Home is the bare URL: no trailing '#', and no sign-in ?code left over.
  const navigate = () => {
    if (hash) window.location.hash = hash
    else {
      window.history.pushState(null, '', window.location.pathname)
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    }
  }
  const doc = document as Document & {
    startViewTransition?: (update: () => Promise<void>) => unknown
  }
  const reduced =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (!doc.startViewTransition || reduced || motionOff) {
    navigate()
    return
  }
  doc.startViewTransition(
    () =>
      new Promise<void>((resolve) => {
        window.addEventListener(
          'hashchange',
          () => requestAnimationFrame(() => resolve()),
          { once: true },
        )
        navigate()
      }),
  )
}
type Dialog = 'settings' | 'help' | 'history' | null
const chips = (n: number) => Math.round(n).toLocaleString('en-US')
const toDecisionAction = (action: Action): DecisionAction =>
  action.type === 'fold'
    ? 'fold'
    : action.type === 'raise'
      ? 'raise'
      : 'continue'

/**
 * The stored record for a finished hand. Without grades it is provisional:
 * saved the moment the hand ends so a reload cannot lose it, then replaced
 * in place once every decision has been analyzed.
 */
function buildRecord(
  hand: FinishedHand,
  grades: DecisionGrade[] | null,
  sessionId: string,
): HandRecord {
  const { game } = hand
  const result = game.result!
  const base: HandRecord = {
    id: `${sessionId}:${game.id}`,
    hand: game.id,
    net: result.net,
    result: result.text,
    guided: game.guided,
    at: Date.now(),
    hero: game.cards[0].map(cardLabel),
    board: game.board.map(cardLabel),
    ...(result.showdown ? { villain: game.cards[1].map(cardLabel) } : {}),
    style: hand.style,
    showdown: result.showdown,
  }
  if (!grades) return { ...base, graded: false }
  const decisions: DecisionRecord[] = hand.decisions.map((d, i) => {
    const g = grades[i]
    const legal = legalActions(d.snapshot)
    return {
      street: d.snapshot.street as DecisionRecord['street'],
      action: d.action.type,
      amount:
        d.action.type === 'raise'
          ? d.action.to
          : d.action.type === 'call'
            ? legal.toCall
            : 0,
      pot: d.snapshot.pot,
      toCall: legal.toCall,
      grade: g.grade,
      evLost: g.evLost,
      accuracy: g.accuracy,
      chosenEV: g.chosen.ev,
      bestEV: g.best.ev,
      bestLabel: g.best.label,
      equity: g.equity,
      handClass: d.handClass,
      ...(d.guess !== undefined ? { guess: d.guess } : {}),
    }
  })
  const last = hand.decisions.length - 1
  return {
    ...base,
    graded: true,
    expectedNet:
      last >= 0
        ? grades[last].chosen.ev - hand.decisions[last].snapshot.invested[0]
        : result.net,
    decisions,
  }
}

const TIPS = [
  'Look at the price before the cards: what share of the final pot are you paying?',
  'A thoughtful decision can still lose. Judge it by expected value, not the result.',
  'Atlas’s bets are evidence. In Analyst mode, the Atlas range view shows how they reshape its likely hands.',
  'Bigger bets make Atlas fold more often but risk more when it calls. Compare the EV on each size preset.',
  'Your reads improve fastest when you commit to a number before looking.',
]

const loadMotionFeatures = () =>
  import('./motionFeatures').then((module) => module.default)

export default function App() {
  const [progress, setProgress] = useState<Progress>(readProgress)
  const settings = progress.settings
  const [trainer, dispatch] = useReducer(trainerReducer, undefined, () =>
    initialTrainer(!progress.guidedComplete, progress.settings.atlasStyle),
  )
  const { spots, request } = useSpots()
  const hash = useHash()
  const search = useSearch()
  const { view, lesson } = parseRoute(hash, search)
  // Signed in or not, as the entry chunk can tell; the online chunk confirms.
  const account = useAccount()
  const member = account.signedIn
  const learningSession = useRef<LearningSession | null>(null)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [paused, setPaused] = useState(false)
  const [tour, setTour] = useState(false)
  const [storageOk, setStorageOk] = useState(true)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [tipHidden, setTipHidden] = useState(false)
  const [sizing, setSizing] = useState<{ id: string; to: number } | null>(null)
  const [guessDraft, setGuessDraft] = useState<{
    key: string
    value: number
  } | null>(null)
  const [reviewPick, setReviewPick] = useState<{
    id: number
    index: number
  } | null>(null)
  const sessionId = useRef(crypto.randomUUID())
  const labRef = useRef<HTMLDivElement>(null)
  const workspaceRef = useRef<HTMLDivElement>(null)
  const playHeading = useRef<HTMLHeadingElement>(null)
  const compact = useMediaQuery('(max-width: 940px)')
  const finePointer = useMediaQuery('(pointer: fine)')
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)')

  const game = trainer.game
  const runout = useRunout(game)
  const reducedMotion = useReducedMotionConfig()
  const style = trainer.style
  const model = settings.opponentModel
  // Not over an invite link: a friend opening #play/<id> goes straight in.
  const welcome =
    !progress.onboarded &&
    view !== 'live' &&
    view !== 'info' &&
    view !== 'landing'
  // Atlas waits while you are away from the table.
  const blocked = welcome || tour || view !== 'play'
  const legal = legalActions(game.turn === 0 ? game : { ...game, turn: 0 })
  const heroTurn = game.turn === 0 && !game.result && !paused
  const yourTurn = heroTurn && !blocked
  const updateSettings = useCallback(
    (patch: Partial<Settings>) =>
      setProgress((p) => ({ ...p, settings: { ...p.settings, ...patch } })),
    [],
  )
  useEffect(() => setVolume(settings.volume), [settings.volume])
  const sound = useCallback(
    (kind: SoundKind) => {
      if (settings.sound && !playSound(kind)) updateSettings({ sound: false })
    },
    [settings.sound, updateSettings],
  )

  // Returning to the table from a lesson lands keyboard and screen-reader
  // focus on the table's heading, like any page change.
  const lastView = useRef(view)
  useEffect(() => {
    if (view === 'play' && lastView.current !== 'play')
      playHeading.current?.focus()
    lastView.current = view
  }, [view])

  // ---- Theme and persistence ---------------------------------------------
  useEffect(() => {
    const root = document.documentElement
    if (settings.theme === 'system') delete root.dataset.theme
    else root.dataset.theme = settings.theme
  }, [settings.theme])
  const themeKey =
    settings.theme === 'system'
      ? prefersDark
        ? 'dark'
        : 'light'
      : settings.theme
  useEffect(() => {
    setStorageOk(saveProgress(progress))
  }, [progress])

  // ---- Analysis requests ---------------------------------------------------
  const liveKey = spotKey(game, style)
  useEffect(() => {
    if (!game.result) request(game, style)
  }, [game, style, request])
  const liveSpot = spots.get(liveKey)
  const liveFull = liveSpot?.stage === 'full' ? liveSpot : null

  // ---- Atlas ----------------------------------------------------------------
  useEffect(() => {
    if (game.turn !== 1 || game.result || paused || blocked) return
    const base =
      settings.speed === 'fast'
        ? 120
        : settings.speed === 'relaxed'
          ? 1500
          : 750
    const spread =
      settings.speed === 'fast' ? 80 : settings.speed === 'relaxed' ? 900 : 650
    const timer = window.setTimeout(
      () => dispatch({ type: 'atlas', decision: atlasDecision(game, style) }),
      base + random() * spread,
    )
    return () => window.clearTimeout(timer)
  }, [game, style, paused, blocked, settings.speed])
  useEffect(() => {
    if (!trainer.bubble) return
    const timer = window.setTimeout(
      () => dispatch({ type: 'clearBubble' }),
      2800,
    )
    return () => window.clearTimeout(timer)
  }, [trainer.bubble])

  // ---- Sounds on table transitions -------------------------------------------
  const lastGame = useRef<Game>(game)
  useEffect(() => {
    const before = lastGame.current
    lastGame.current = game
    if (before === game) return
    if (before.id !== game.id || game.board.length > before.board.length)
      sound('deal')
    if (game.result && !before.result) {
      // An all-in runout plays its own cues as the board is revealed.
      if (game.result.showdown && before.board.length < 5 && !reducedMotion)
        return
      const won = game.result.net >= 0
      window.setTimeout(() => sound(won ? 'win' : 'lose'), 380)
      return
    }
    const last = game.history[game.history.length - 1]
    if (
      before.id === game.id &&
      last &&
      game.history.length > before.history.length
    )
      sound(
        last.action === 'fold'
          ? 'fold'
          : last.action === 'check'
            ? 'check'
            : 'chip',
      )
  }, [game, sound, reducedMotion])

  const lastVisible = useRef(runout.visible)
  useEffect(() => {
    if (runout.revealing && runout.visible > lastVisible.current) sound('deal')
    lastVisible.current = runout.visible
  }, [runout.visible, runout.revealing, sound])
  const wasRevealing = useRef(false)
  useEffect(() => {
    if (wasRevealing.current && !runout.revealing && game.result)
      sound(game.result.net >= 0 ? 'win' : 'lose')
    wasRevealing.current = runout.revealing
  }, [runout.revealing, game.result, sound])

  // ---- Guess first -------------------------------------------------------------
  const currentGuessKey = guessKey(game)
  const guessEntry = trainer.guesses[currentGuessKey]
  const guessPending =
    settings.guessFirst && !game.result && guessEntry === undefined
  const guessValue =
    guessDraft?.key === currentGuessKey ? guessDraft.value : 0.5
  const liveOutcome = liveFull ? spotOutcome(liveFull, 'range') : null
  const lockGuess = useCallback(
    () => dispatch({ type: 'guess', value: guessValue }),
    [guessValue],
  )

  // ---- Bet sizing and live action math ---------------------------------------
  const decisionId = `${game.id}:${game.history.length}`
  const context = heroContext(game)
  const presets: Preset[] = useMemo(
    () =>
      buildPresets(
        {
          canRaise: legal.canRaise,
          minRaiseTo: legal.minRaiseTo,
          maxRaiseTo: legal.maxRaiseTo,
        },
        context.pot,
        context.toCall,
        game.bets,
      ).map((preset) =>
        liveFull
          ? {
              ...preset,
              ev: raiseAnalysis(
                liveFull,
                model,
                {
                  pot: context.pot,
                  heroBet: context.heroBet,
                  atlasBet: context.atlasBet,
                  raiseTo: preset.to,
                },
                style,
              ).ev,
            }
          : preset,
      ),
    [
      legal.canRaise,
      legal.maxRaiseTo,
      legal.minRaiseTo,
      game.bets,
      context.pot,
      context.toCall,
      context.heroBet,
      context.atlasBet,
      liveFull,
      model,
      style,
    ],
  )
  const defaultRaise = presets[0]?.to ?? legal.minRaiseTo
  const raiseTo = Math.min(
    legal.maxRaiseTo,
    Math.max(
      legal.minRaiseTo,
      sizing?.id === decisionId ? sizing.to : defaultRaise,
    ),
  )
  const setRaiseTo = (to: number) => setSizing({ id: decisionId, to })
  const actionMath = useMemo(() => {
    const outcome = liveFull ? spotOutcome(liveFull, model) : null
    const callEV = outcome
      ? outcome.equity * context.pot - (1 - outcome.equity) * context.toCall
      : undefined
    const raise =
      liveFull && legal.canRaise
        ? raiseAnalysis(
            liveFull,
            model,
            {
              pot: context.pot,
              heroBet: context.heroBet,
              atlasBet: context.atlasBet,
              raiseTo,
            },
            style,
          )
        : null
    const options: ['fold' | 'continue' | 'raise', number][] = []
    if (context.toCall) options.push(['fold', 0])
    if (callEV !== undefined) options.push(['continue', callEV])
    if (raise) options.push(['raise', raise.ev])
    const best = options.length
      ? options.reduce((a, b) => (b[1] > a[1] ? b : a))[0]
      : undefined
    return {
      revealed: !guessPending,
      ready: !!outcome,
      equity: outcome?.equity,
      breakEven: context.toCall
        ? context.toCall / (context.pot + context.toCall)
        : 0,
      callEV,
      raiseEV: raise?.ev,
      foldProbability: raise?.foldProbability,
      bestKind: best,
    }
  }, [
    liveFull,
    model,
    context.pot,
    context.toCall,
    context.heroBet,
    context.atlasBet,
    legal.canRaise,
    raiseTo,
    style,
    guessPending,
  ])

  const heroAct = useCallback(
    (kind: 'fold' | 'continue' | 'raise') => {
      if (!yourTurn) return
      if (kind === 'raise' && !legal.canRaise) return
      const action: Action =
        kind === 'fold'
          ? { type: 'fold' }
          : kind === 'continue'
            ? { type: legal.canCheck ? 'check' : 'call' }
            : { type: 'raise', to: raiseTo }
      dispatch({ type: 'hero', action })
    },
    [yourTurn, legal.canRaise, legal.canCheck, raiseTo],
  )

  // ---- Review and recording ---------------------------------------------------
  // The review opens once the result is shown, after any all-in runout.
  const reviewing = !!game.result && !runout.revealing
  const decisions = trainer.decisions
  const grades = useMemo(
    () =>
      decisions.map((d) => {
        const spot = spots.get(d.key)
        return spot?.stage === 'full'
          ? gradeDecision(d.snapshot, d.action, spot, style)
          : null
      }),
    [decisions, spots, style],
  )
  const reviewIndex =
    reviewPick?.id === game.id
      ? Math.min(reviewPick.index, decisions.length - 1)
      : decisions.length - 1
  useEffect(() => {
    for (const hand of trainer.finished) {
      const provisional = buildRecord(hand, null, sessionId.current)
      setProgress((p) =>
        p.hands.some((h) => h.id === provisional.id)
          ? p
          : upsertHand(p, provisional),
      )
      const found = hand.decisions.map((d) => {
        const spot = spots.get(d.key)
        if (!spot) request(d.snapshot, hand.style)
        return spot?.stage === 'full' ? (spot as FullSpot) : null
      })
      if (found.some((s) => !s)) continue
      const handGrades = hand.decisions.map((d, i) =>
        gradeDecision(d.snapshot, d.action, found[i]!, hand.style),
      )
      const record = buildRecord(hand, handGrades, sessionId.current)
      setProgress((p) => upsertHand(p, record))
      dispatch({ type: 'recorded', id: hand.game.id })
    }
  }, [trainer.finished, spots, request])

  // ---- Dealing -------------------------------------------------------------------
  const deal = useCallback(() => {
    if (!game.result) return
    if (trainer.guidedStep === 3)
      setProgress((p) => ({ ...p, guidedComplete: true }))
    dispatch({ type: 'deal', style: settings.atlasStyle })
    setPaused(false)
    setSheetOpen(false)
  }, [game.result, trainer.guidedStep, settings.atlasStyle])
  const skipGuided = () => {
    setProgress((p) => ({ ...p, guidedComplete: true }))
    dispatch({ type: 'skipGuided', style: settings.atlasStyle })
  }
  const showReview = () => {
    if (compact) setSheetOpen(true)
    else
      labRef.current?.scrollIntoView({
        behavior: reducedMotion ? 'auto' : 'smooth',
        block: 'start',
      })
  }

  // ---- Keyboard --------------------------------------------------------------------
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || dialog || blocked)
        return
      if (view !== 'play') return
      const target = event.target as HTMLElement
      if (
        target.closest(
          'textarea, select, [contenteditable="true"], input:not([type="range"])',
        )
      )
        return
      const key = event.key.toLowerCase()
      if (key === 'enter') {
        if (target.tagName === 'BUTTON') return
        if (game.result) deal()
        else if (guessPending && yourTurn) lockGuess()
        else return
        event.preventDefault()
        return
      }
      if (key === '?') setDialog('help')
      else if (key === 'p') setPaused((p) => !p)
      else if (key === 'f' && legal.toCall) heroAct('fold')
      else if (key === 'c') heroAct('continue')
      else if (key === 'r' || key === 'b') heroAct('raise')
      else if (['1', '2', '3', '4'].includes(key) && yourTurn) {
        const preset = presets.find((p) => p.key === key)
        if (preset) setSizing({ id: decisionId, to: preset.to })
      } else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    dialog,
    blocked,
    view,
    game.result,
    deal,
    guessPending,
    yourTurn,
    lockGuess,
    heroAct,
    legal.toCall,
    presets,
    decisionId,
  ])

  // ---- Lab inputs (live or a frozen review snapshot) ------------------------------
  // While a runout is revealed, the lab stays on the last decision, frozen.
  const reviewDecision = reviewing
    ? reviewIndex >= 0
      ? decisions[reviewIndex]
      : null
    : game.result
      ? (decisions[decisions.length - 1] ?? null)
      : null
  const labGame = reviewDecision?.snapshot ?? game
  const labSpot = reviewDecision ? spots.get(reviewDecision.key) : liveSpot
  let labRaise = raiseTo
  if (reviewDecision) {
    const snap = legalActions(reviewDecision.snapshot)
    labRaise =
      reviewDecision.action.type === 'raise'
        ? reviewDecision.action.to
        : Math.min(
            snap.maxRaiseTo,
            Math.max(
              snap.minRaiseTo,
              Math.round(
                Math.max(...reviewDecision.snapshot.bets) +
                  (reviewDecision.snapshot.pot + snap.toCall) / 2,
              ),
            ),
          )
  }
  const labLocked = guessPending && !reviewing
  const labGuess =
    reviewDecision?.guess ??
    (!reviewing && typeof guessEntry === 'number' ? guessEntry : undefined)
  const review = reviewing ? (
    <HandReview
      game={game}
      decisions={decisions}
      grades={grades}
      selected={Math.max(0, reviewIndex)}
      onSelect={(index) => setReviewPick({ id: game.id, index })}
    />
  ) : null

  // ---- Session summary ---------------------------------------------------------------
  // A hand still being revealed is not counted yet, so it can't spoil it.
  const hidden = runout.revealing ? `${sessionId.current}:${game.id}` : null
  const session = progress.hands.filter(
    (h) => h.id.startsWith(sessionId.current) && h.id !== hidden,
  )
  const sessionNet = session.reduce((s, h) => s + h.net, 0)
  const sessionDecisions = session.flatMap((h) => h.decisions ?? [])
  const sessionAccuracy = sessionDecisions.length
    ? sessionDecisions.reduce((s, d) => s + d.accuracy, 0) /
      sessionDecisions.length
    : null
  const reads = sessionDecisions.filter((d) => d.guess !== undefined)
  const readError = reads.length
    ? reads.reduce((s, d) => s + Math.abs(d.guess! - d.equity), 0) /
      reads.length
    : null

  const tourSteps: TourStep[] = [
    {
      target: 'table',
      title: 'Your table',
      body: 'Heads-up Hold’em against Atlas. The first three hands are guided setups; after that every hand is shuffled.',
    },
    {
      target: 'guess',
      title: 'Make your read first',
      body: 'Before the math appears, guess how often your hand wins. Lock it in, then see how close you were.',
    },
    {
      target: 'actions',
      title: 'Act with conviction',
      body: 'Fold, call or raise. Once you have made your read, the ring shows your equity against the price. Keyboard: F, C, R.',
    },
    {
      target: 'lab',
      title: 'The quant lab',
      body: 'Every option priced in chips, how Atlas’s actions reshape its likely hands, and what the next card could do.',
    },
    {
      target: 'progress',
      title: 'Track real improvement',
      body: 'Decision accuracy and read calibration, with luck separated out. Results are noisy; decisions are what you control.',
    },
  ]

  const handAccuracy =
    grades.length && grades.every(Boolean)
      ? Math.round(grades.reduce((s, g) => s + g!.accuracy, 0) / grades.length)
      : null
  const sheetSummary = labLocked ? (
    <span className="sheet-summary">
      <Lock size={14} /> Make your read to open the lab
    </span>
  ) : reviewing ? (
    <span className="sheet-summary">
      <Target size={14} /> Hand review
      {handAccuracy !== null ? ` · accuracy ${handAccuracy}` : ''}
    </span>
  ) : (
    <span className="sheet-summary">
      <Gauge size={14} />
      {actionMath.ready
        ? `Equity ${Math.round((actionMath.equity ?? 0) * 100)}%${context.toCall ? ` · need ${Math.round(actionMath.breakEven * 100)}%` : ''}`
        : 'Reading the spot…'}
    </span>
  )

  const lab = (
    <Suspense fallback={<LabSkeleton />}>
      <Lab
        game={labGame}
        spot={labSpot}
        style={style}
        settings={settings}
        raiseTo={labRaise}
        playedAction={
          reviewDecision ? toDecisionAction(reviewDecision.action) : undefined
        }
        locked={labLocked}
        guess={labGuess}
        reviewing={reviewing}
        review={review}
        themeKey={themeKey}
        resetKey={
          reviewDecision
            ? `review-${game.id}-${reviewIndex}`
            : `live-${decisionId}`
        }
        onSettings={updateSettings}
        onReveal={() => dispatch({ type: 'guess', value: null })}
        onLesson={(id) => {
          setSheetOpen(false)
          go(`learn/quick/${id}`)
        }}
      />
    </Suspense>
  )

  const ThemeIcon =
    settings.theme === 'dark'
      ? Moon
      : settings.theme === 'light'
        ? Sun
        : Monitor
  const nextTheme: Settings['theme'] =
    settings.theme === 'system'
      ? 'light'
      : settings.theme === 'light'
        ? 'dark'
        : 'system'

  return (
    <LazyMotion features={loadMotionFeatures} strict>
      <CardDefs />
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="header">
        <a
          className="brand"
          href="/"
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
            e.preventDefault()
            go('')
          }}
          aria-label="QuantPoker home"
        >
          <span className="brand-mark">
            <Spade size={18} fill="currentColor" />
          </span>
          <span>
            quant<span className="brand-light">poker</span>
          </span>
        </a>
        <nav className="nav" aria-label="Main">
          {(
            [
              ['play', 'Play', Diamond, 'table'],
              ['live', 'Online', Globe, 'lobby'],
              ['learn', 'Learn', BookOpen, 'learn/path'],
              ['progress', 'Progress', ChartNoAxesCombined, 'progress'],
            ] as const
          ).map(([key, label, Icon, hash]) => {
            const on =
              key === 'learn'
                ? view === 'curriculum' || view === 'quick'
                : view === key
            return (
              <button
                key={key}
                className={on ? 'on' : ''}
                aria-current={on ? 'page' : undefined}
                data-tour={key === 'progress' ? 'progress' : undefined}
                aria-label={label}
                title={label}
                onClick={() => go(hash)}
              >
                <Icon size={15} aria-hidden="true" /> <span>{label}</span>
              </button>
            )
          })}
        </nav>
        <div className="header-tools">
          <span className="pill">
            <i /> Play money
          </span>
          {member ? (
            <AccountMenu username={account.username} />
          ) : (
            <span className="header-account">
              <a href="#signin" className="header-signin">
                Sign in
              </a>
              <a
                href="#signup"
                className="btn btn-accent header-join"
                onClick={() => track('signup_start')}
              >
                <span className="header-join-long">Create free account</span>
                <span className="header-join-short">Join free</span>
              </a>
            </span>
          )}
          <button
            className="icon-btn header-theme"
            onClick={() => updateSettings({ theme: nextTheme })}
            aria-label={`Theme: ${settings.theme}. Switch to ${nextTheme}.`}
            title={`Theme: ${settings.theme}`}
          >
            <ThemeIcon size={17} />
          </button>
          <button
            className="icon-btn"
            onClick={() => setDialog('help')}
            aria-label="How it works"
            title="How it works (?)"
          >
            <CircleHelp size={17} />
          </button>
          <button
            className="icon-btn"
            onClick={() => setDialog('settings')}
            aria-label="Settings"
            title="Settings"
          >
            <Settings2 size={17} />
          </button>
        </div>
      </header>

      <main id="main">
        {view === 'play' && (
          <div
            className={`workspace ${compact ? '' : 'resizable'}`}
            ref={workspaceRef}
            style={
              compact
                ? undefined
                : ({
                    '--split-a': `${settings.split * 100}fr`,
                    '--split-b': `${(1 - settings.split) * 100}fr`,
                  } as CSSProperties)
            }
          >
            <section className="play-column" aria-label="Play">
              <h1 className="sr-only" tabIndex={-1} ref={playHeading}>
                Play the hand. Understand the odds.
              </h1>
              <Table
                game={game}
                style={style}
                bubble={trainer.bubble}
                paused={paused}
                yourTurn={yourTurn}
                guidedStep={trainer.guidedStep}
                showBubbles={settings.atlasVoice}
                onTogglePause={() => setPaused(!paused)}
                onHistory={() => setDialog('history')}
                onSettings={() => setDialog('settings')}
                onSkipGuided={skipGuided}
                runout={runout}
              />
              <ActionBar
                game={game}
                legal={legal}
                yourTurn={yourTurn}
                heroTurn={heroTurn}
                paused={paused}
                raiseTo={raiseTo}
                presets={presets}
                math={actionMath}
                shortcuts={finePointer}
                guess={{
                  show: guessPending || typeof guessEntry === 'number',
                  value: guessValue,
                  locked:
                    typeof guessEntry === 'number'
                      ? {
                          guess: guessEntry,
                          actual: liveOutcome?.equity ?? null,
                        }
                      : null,
                  onChange: (value) =>
                    setGuessDraft({ key: currentGuessKey, value }),
                  onLock: lockGuess,
                  onSkip: () => dispatch({ type: 'guess', value: null }),
                }}
                onRaiseTo={setRaiseTo}
                onAct={heroAct}
                onDeal={deal}
                onReview={showReview}
                revealing={runout.revealing}
              />
              {trainer.notice && (
                <p className="notice" role="status">
                  <span>{trainer.notice}</span>
                  <button
                    className="icon-btn"
                    aria-label="Dismiss"
                    onClick={() => dispatch({ type: 'clearNotice' })}
                  >
                    <X size={14} />
                  </button>
                </p>
              )}
              {!storageOk && (
                <p className="notice">
                  Browser storage is unavailable. Progress lasts only until you
                  leave this page.
                </p>
              )}
              <div className="session">
                <div>
                  <Coins size={17} />
                  <span>
                    Session
                    <strong className={sessionNet < 0 ? 'negative' : ''}>
                      {sessionNet >= 0 ? '+' : '−'}
                      {chips(Math.abs(sessionNet))}
                    </strong>
                  </span>
                </div>
                <div>
                  <Gauge size={17} />
                  <span>
                    Accuracy
                    <strong>
                      {sessionAccuracy === null
                        ? '—'
                        : Math.round(sessionAccuracy)}
                    </strong>
                  </span>
                </div>
                <div>
                  <Target size={17} />
                  <span>
                    Read error
                    <strong>
                      {readError === null
                        ? '—'
                        : `±${Math.round(readError * 100)}`}
                    </strong>
                  </span>
                </div>
                <button onClick={() => go('learn/quick')}>
                  <GraduationCap size={17} />
                  <span>
                    Lessons
                    <strong>
                      {progress.lessons.length}
                      <small>/6</small>
                    </strong>
                  </span>
                </button>
              </div>
              {settings.hints && !tipHidden && (
                <div className="tip">
                  <Lightbulb size={17} />
                  <p>{TIPS[game.id % TIPS.length]}</p>
                  <button
                    className="icon-btn"
                    aria-label="Hide tip"
                    onClick={() => setTipHidden(true)}
                  >
                    <X size={14} />
                  </button>
                </div>
              )}
            </section>
            {compact ? (
              <LabSheet
                open={sheetOpen}
                onOpenChange={setSheetOpen}
                summary={sheetSummary}
                haptics={settings.sound}
                sheetRef={labRef}
              >
                {lab}
              </LabSheet>
            ) : (
              <>
                <SplitHandle
                  target={workspaceRef}
                  value={settings.split}
                  onCommit={(split) => updateSettings({ split })}
                />
                <div className="lab-column" ref={labRef}>
                  {lab}
                </div>
              </>
            )}
          </div>
        )}
        {view === 'curriculum' && (
          <Suspense
            fallback={
              <div className="curriculum-loading" role="status">
                Opening the curriculum… Your hand is paused.
              </div>
            }
          >
            <Curriculum
              session={learningSession}
              liveHand={{
                number: game.id,
                cards: game.cards[0].map(cardLabel).join(' '),
                board: game.board.map(cardLabel).join(' ') || 'Preflop',
                pot: game.result
                  ? game.invested[0] + game.invested[1]
                  : game.pot,
                call: game.result ? 0 : legal.toCall,
                equity:
                  liveOutcome?.equity ??
                  (liveSpot
                    ? liveSpot.quick.win + liveSpot.quick.tie / 2
                    : null),
                finished: Boolean(game.result),
                heroTurn: game.turn === 0,
              }}
            />
          </Suspense>
        )}
        {view === 'quick' && (
          <LearnView
            selected={lesson}
            completed={progress.lessons}
            onSelect={(id) => {
              go(id ? `learn/quick/${id}` : 'learn/quick')
              window.scrollTo({ top: 0 })
            }}
            onComplete={(id) =>
              setProgress((p) =>
                p.lessons.includes(id)
                  ? p
                  : { ...p, lessons: [...p.lessons, id] },
              )
            }
            onPlay={() => go('table')}
          />
        )}
        {view === 'live' && (
          <Suspense
            fallback={
              <div className="curriculum-loading" role="status">
                Opening online play… Your hand is paused.
              </div>
            }
          >
            <LiveApp />
          </Suspense>
        )}
        {view === 'info' && (
          <Suspense fallback={null}>
            <InfoPage
              page={
                hash === '#terms'
                  ? 'terms'
                  : hash === '#method'
                    ? 'method'
                    : 'fair-play'
              }
            />
          </Suspense>
        )}
        {view === 'landing' && (
          <Suspense
            fallback={
              <div className="curriculum-loading" role="status">
                Dealing your hand…
              </div>
            }
          >
            <Landing signedIn={member} />
          </Suspense>
        )}
        {view === 'gallery' && (
          <Suspense fallback={null}>
            <Gallery />
          </Suspense>
        )}
        {view === 'progress' && (
          <ProgressView
            progress={progress}
            sessionId={sessionId.current}
            onReplace={(next) => setProgress({ ...next, onboarded: true })}
            onClear={() =>
              setProgress((p) => ({
                ...emptyProgress(),
                settings: p.settings,
                onboarded: true,
                guidedComplete: p.guidedComplete,
              }))
            }
            onPlay={() => go('table')}
          />
        )}
      </main>
      {member && (
        <Suspense fallback={null}>
          <SessionKeeper />
        </Suspense>
      )}

      <footer className="footer">
        <span>
          <Spade size={12} fill="currentColor" /> A better feel for risk.
        </span>
        <span>
          For learning, not financial advice. No deposits, no withdrawals. Just
          practice.
        </span>
      </footer>

      {dialog === 'settings' && (
        <SettingsDialog
          settings={settings}
          onChange={updateSettings}
          onClose={() => setDialog(null)}
          onReplayGuided={() => {
            dispatch({ type: 'startGuided' })
            setDialog(null)
            go('table')
          }}
        />
      )}
      {dialog === 'help' && <HelpDialog onClose={() => setDialog(null)} />}
      {dialog === 'history' && (
        <HistoryDialog game={game} onClose={() => setDialog(null)} />
      )}
      {welcome && (
        <WelcomeDialog
          onChoose={(mode) => {
            setProgress((p) => ({
              ...p,
              onboarded: true,
              settings: { ...p.settings, mode },
            }))
            go('table')
            setTour(true)
          }}
        />
      )}
      {tour && view === 'play' && (
        <Tour
          steps={tourSteps.filter(
            (s) => s.target !== 'guess' || settings.guessFirst,
          )}
          onDone={() => setTour(false)}
        />
      )}
    </LazyMotion>
  )
}
