// The landing page's hero (L-2, L-4, landing v2): one curated hand against
// Atlas. Each decision is a button for one pre-scored option, graded the
// moment it is made; Atlas's replies come from the tree, a beat apart so
// they read like play. No analysis runs and the lab is never loaded (L-3).
//
// With a 3D stage (ADR-001) this component drives it: the stage shows the
// cards and chips, and each decision plays a beat (the range cloud on the
// first, a grade stamp in between, a slow-motion verdict on the last). HTML
// labels ride over the canvas. Without one, the 2D trainer table draws it.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useReducedMotionConfig } from 'motion/react'
import { actionOf } from '../challenge/actions'
import { CHALLENGE_HANDS, startGame } from '../challenge/hands'
import type { ChallengeSpec } from '../challenge/hands'
import type {
  AtlasStep,
  ChallengeNode,
  ChallengeOption,
  ChallengeTree,
} from '../challenge/score'
import { treeFor } from '../challenge/trees'
import { Table } from '../components/table/Table'
import type { Grade } from '../lib/grading'
import { act, cardLabel, legalActions } from '../lib/poker'
import type { Game } from '../lib/poker'
import { playSound } from '../lib/sound'
import { readProgress } from '../lib/storage'
import { track } from '../lib/track'
import { useRunout } from '../state/runout'
import type { Bubble } from '../state/trainer'
import type { AnchorName, Stage } from './stage/stage'
import { atlasSays, breakEven, why } from './why'

export type PlayedDecision = {
  node: ChallengeNode
  chosen: ChallengeOption
  /** Atlas's replies to it, with its reasoning (shown after the hand). */
  atlas: AtlasStep[]
}
export type FinishedChallenge = {
  spec: ChallengeSpec
  tree: ChallengeTree
  game: Game
  path: string[]
  decisions: PlayedDecision[]
}

type Beat = { id: number; grade: Grade; kind: 'range' | 'stamp' | 'verdict' }

const noop = () => {}
const ATLAS_BEAT_MS = 750
const GOOD: Grade[] = ['Best', 'Good']

export function ChallengeHand({
  index,
  round,
  stage = null,
  labelLayer = null,
  onDone,
}: {
  /** Which curated hand (wraps around the pool). */
  index: number
  /** Increments for each new hand, so table animations restart. */
  round: number
  /** The 3D stage, when the page has one; otherwise the 2D table. */
  stage?: Stage | null
  /** The element laid over the canvas, where the stage's labels go. */
  labelLayer?: HTMLElement | null
  onDone: (result: FinishedChallenge) => void
}) {
  const spec = CHALLENGE_HANDS[index % CHALLENGE_HANDS.length]
  const tree = treeFor(spec.id, spec.ver)!
  const reduced = useReducedMotionConfig()
  const [game, setGame] = useState<Game>(() => ({
    ...startGame(spec),
    id: round,
  }))
  const [at, setAt] = useState<number | null>(0)
  const [queue, setQueue] = useState<AtlasStep[]>([])
  const [decisions, setDecisions] = useState<PlayedDecision[]>([])
  const [bubble, setBubble] = useState<Bubble | null>(null)
  const [beat, setBeat] = useState<Beat | null>(null)
  const [settled, setSettled] = useState(false)
  const runout = useRunout(game)
  const reported = useRef(false)
  const sound = useMemo(() => readProgress().settings.sound, [])

  const node = at === null ? null : tree.nodes[at]
  const waiting = queue.length > 0
  const yourTurn = !!node && !waiting && !game.result && !beat

  // The stage shows every change to the hand.
  useEffect(() => {
    stage?.show(game)
  }, [stage, game])

  // Atlas replies one action at a time, after any beat has played.
  useEffect(() => {
    if (!queue.length || beat) return
    const timer = window.setTimeout(
      () => {
        const [step, ...rest] = queue
        setBubble({
          id: game.history.length,
          text: atlasSays(step.code, legalActions(game).toCall),
        })
        if (sound) playSound(step.code === 'f' ? 'fold' : 'chip')
        setGame(act(game, actionOf(game, step.code), step.note))
        setQueue(rest)
      },
      reduced ? 0 : ATLAS_BEAT_MS,
    )
    return () => window.clearTimeout(timer)
  }, [queue, reduced, game, beat, sound])

  // On the stage, the hand is over once the last chips and cards have moved.
  useEffect(() => {
    if (!stage || !game.result || waiting || beat) return
    let live = true
    void stage.whenIdle().then(() => live && setSettled(true))
    return () => {
      live = false
    }
  }, [stage, game, waiting, beat])

  // Over: Atlas is done, any beat has played, and any runout has landed.
  const over =
    !!game.result && !waiting && !beat && (stage ? settled : !runout.revealing)
  useEffect(() => {
    if (!over || reported.current) return
    reported.current = true
    track('challenge_complete')
    onDone({
      spec,
      tree,
      game,
      path: decisions.map((d) => d.chosen.code),
      decisions,
    })
  }, [over, game, decisions, spec, tree, onDone])

  const choose = useCallback(
    (option: ChallengeOption) => {
      if (!node || !yourTurn) return
      const first = !decisions.length
      if (first) track('challenge_start')
      track('challenge_decision')
      if (sound) playSound(option.code === 'f' ? 'fold' : 'chip')
      setDecisions((d) => [...d, { node, chosen: option, atlas: option.atlas }])
      setGame((g) => act(g, actionOf(g, option.code)))
      setQueue(option.atlas)
      setAt(option.next)
      setBubble(null)
      if (!stage) return
      // The beats escalate: the range on the first decision, the verdict on
      // the last, a stamp in between.
      const kind: Beat['kind'] =
        first && node.range?.length
          ? 'range'
          : option.next === null
            ? 'verdict'
            : 'stamp'
      const id = Date.now()
      const good = GOOD.includes(option.grade)
      setBeat({ id, grade: option.grade, kind })
      const end = () => {
        setBeat((b) => (b?.id === id ? null : b))
        if (sound && kind === 'verdict') playSound(good ? 'win' : 'lose')
      }
      if (kind === 'range') stage.rangeCloud(node.range!, end)
      else if (kind === 'verdict')
        stage.verdict(node.equity, breakEven(node), good, end)
      else stage.stamp(good, end)
    },
    [node, yourTurn, decisions.length, stage, sound],
  )

  // Any click or key ends a running beat early.
  useEffect(() => {
    if (!stage || !beat) return
    const skip = () => stage.skip()
    window.addEventListener('pointerdown', skip)
    window.addEventListener('keydown', skip)
    return () => {
      window.removeEventListener('pointerdown', skip)
      window.removeEventListener('keydown', skip)
    }
  }, [stage, beat])

  const last = decisions.at(-1)
  const options = useMemo(() => node?.options ?? [], [node])
  const lastNode = last?.node

  return (
    <div
      className={`challenge ${stage ? 'is-staged' : ''}`}
      data-hand={spec.id}
    >
      {stage ? (
        labelLayer &&
        createPortal(
          <StageLabels
            stage={stage}
            game={game}
            bubble={bubble}
            beat={beat}
            title={spec.title}
            verdict={
              beat?.kind === 'verdict' && lastNode
                ? { equity: lastNode.equity, price: breakEven(lastNode) }
                : null
            }
          />,
          labelLayer,
        )
      ) : (
        <Table
          game={game}
          style="balanced"
          bubble={bubble}
          paused={false}
          yourTurn={yourTurn}
          guidedStep={null}
          showBubbles
          onTogglePause={noop}
          onHistory={noop}
          onSettings={noop}
          onSkipGuided={noop}
          runout={runout}
          challenge={{ title: spec.title }}
        />
      )}
      <div className="challenge-bar">
        <p className="challenge-status" role="status">
          {last ? (
            <>
              <span
                className={`grade grade-${last.chosen.grade.toLowerCase()}`}
              >
                {last.chosen.grade}
              </span>{' '}
              <span>{why(last.node, last.chosen)}</span>
            </>
          ) : (
            <span>{spec.setup} Your move.</span>
          )}
        </p>
        <div
          className="challenge-actions"
          role="group"
          aria-label={
            yourTurn
              ? `Your decision on the ${node!.street}. Pot ${node!.pot}.`
              : 'Waiting for Atlas'
          }
        >
          {options.map((option, i) => (
            <button
              key={option.code}
              className={`challenge-option ${option.code === 'f' ? 'is-fold' : option.code.startsWith('r') ? 'is-raise' : 'is-call'}`}
              onClick={() => choose(option)}
              disabled={!yourTurn}
              aria-keyshortcuts={String(i + 1)}
            >
              <kbd aria-hidden>{i + 1}</kbd>
              {option.label}
            </button>
          ))}
          {!yourTurn && !game.result && (
            <span className="challenge-wait">
              {beat ? 'Grading… (click to skip)' : 'Atlas is deciding…'}
            </span>
          )}
        </div>
      </div>
      <ChallengeKeys options={options} enabled={yourTurn} onChoose={choose} />
    </div>
  )
}

/**
 * HTML over the canvas: who is where, the pot, Atlas's words, the grade
 * stamp and the verdict's figures. Positions come from the stage each frame
 * and are written to the elements directly, without re-rendering. A text
 * summary of the table is kept for screen readers (the canvas is hidden).
 */
function StageLabels({
  stage,
  game,
  bubble,
  beat,
  title,
  verdict,
}: {
  stage: Stage
  game: Game
  bubble: Bubble | null
  beat: Beat | null
  title: string
  verdict: { equity: number; price: number } | null
}) {
  const refs = useRef<Partial<Record<AnchorName, HTMLElement | null>>>({})
  useEffect(() => {
    stage.onAnchors((anchors) => {
      for (const [name, el] of Object.entries(refs.current)) {
        const at = anchors[name as AnchorName]
        if (el && at)
          el.style.transform = `translate(${at.x}px, ${at.y}px) translate(-50%, -100%)`
      }
    })
    return () => stage.onAnchors(null)
  }, [stage])

  const thinking = game.turn === 1 && !game.result
  const pot = game.pot
  const heroCards = game.cards[0].map(cardLabel).join(' ')
  const board = game.board.map(cardLabel).join(' ')
  const pct = (x: number) => `${Math.round(x * 100)}%`
  return (
    <>
      <p className="sr-only" aria-live="polite">
        {`${title}. You hold ${heroCards}. ${board ? `Board ${board}.` : ''} Pot ${pot}.`}
        {bubble ? ` Atlas: ${bubble.text}` : ''}
        {game.result?.showdown
          ? ` Atlas shows ${game.cards[1].map(cardLabel).join(' ')}.`
          : ''}
      </p>
      <div
        className="stage-label stage-plate"
        ref={(el) => void (refs.current.atlas = el)}
        aria-hidden
      >
        <span className={`stage-avatar ${thinking ? 'is-thinking' : ''}`} />
        <span>
          <b>Atlas</b>
          <small>{game.stacks[1].toLocaleString('en-US')} chips</small>
        </span>
        {(thinking || bubble) && (
          <em className="stage-says" key={thinking ? 'thinking' : bubble!.id}>
            {thinking ? '…' : bubble!.text}
          </em>
        )}
      </div>
      <div
        className="stage-label stage-plate is-hero"
        ref={(el) => void (refs.current.hero = el)}
        aria-hidden
      >
        <span>
          <b>You</b>
          <small>{game.stacks[0].toLocaleString('en-US')} chips</small>
        </span>
      </div>
      <div
        className="stage-label stage-pot"
        ref={(el) => void (refs.current.pot = el)}
        hidden={!pot}
        aria-hidden
      >
        Pot <b>{pot.toLocaleString('en-US')}</b>
      </div>
      {beat?.kind === 'range' && (
        <p className="stage-caption" aria-hidden>
          Atlas’s likeliest hands, from how it has played.{' '}
          <span className="is-ahead">Red beat you</span> ·{' '}
          <span className="is-behind">green you beat</span>
        </p>
      )}
      {verdict && (
        <>
          <div
            className="stage-label stage-figure is-equity"
            ref={(el) => void (refs.current.equityBar = el)}
            aria-hidden
          >
            <b>{pct(verdict.equity)}</b>
            <small>your equity</small>
          </div>
          <div
            className="stage-label stage-figure is-price"
            ref={(el) => void (refs.current.priceBar = el)}
            aria-hidden
          >
            <b>{verdict.price ? pct(verdict.price) : 'free'}</b>
            <small>{verdict.price ? 'the price' : 'to check'}</small>
          </div>
        </>
      )}
      {beat && (
        <div
          key={beat.id}
          className={`stage-stamp grade-${beat.grade.toLowerCase()} is-${beat.kind}`}
          aria-hidden
        >
          {beat.grade}
        </div>
      )}
    </>
  )
}

/** Number keys pick an option, like the trainer's 1–4 presets. */
function ChallengeKeys({
  options,
  enabled,
  onChoose,
}: {
  options: ChallengeOption[]
  enabled: boolean
  onChoose: (option: ChallengeOption) => void
}) {
  useEffect(() => {
    if (!enabled) return
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable]')) return
      const n = Number(event.key)
      if (Number.isInteger(n) && n >= 1 && n <= options.length) {
        event.preventDefault()
        onChoose(options[n - 1])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [options, enabled, onChoose])
  return null
}
