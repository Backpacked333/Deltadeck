import { useEffect, useRef, useState } from 'react'
import { useReducedMotionConfig } from 'motion/react'
import type { Game } from '../lib/poker'
import type {
  HandCompletionV1,
  PresentationStateV1,
  SeatView,
} from '../shared/protocol'

export type Runout = {
  /** Board cards currently shown (the engine has already dealt all five). */
  visible: number
  /** True while an all-in runout is still being revealed. */
  revealing: boolean
}

/** Schedule age uses two server timestamps, then only local monotonic elapsed. */
export function completionPhase(
  completion: HandCompletionV1,
  serverNow: number,
  elapsed: number,
  reduced = false,
) {
  const age =
    Math.max(0, serverNow - completion.completedAt) + Math.max(0, elapsed)
  const { beats, earliestNextDealAt } = completion.schedule
  const due = beats.filter((beat) => beat.offsetMs <= age)
  const initial =
    completion.schedule.shape === 'all_in_preflop'
      ? 0
      : completion.schedule.shape === 'all_in_flop'
        ? 3
        : completion.schedule.shape === 'all_in_turn'
          ? 4
          : completion.final.board.length
  const visible = reduced
    ? completion.final.board.length
    : (due.at(-1)?.boardCount ?? initial)
  const revealing = visible < completion.final.board.length
  return {
    visible,
    revealing,
    holding: !revealing && age < earliestNextDealAt - completion.completedAt,
  }
}

export function useLiveRunout(
  view: SeatView | null,
  presentation: PresentationStateV1 | null,
  receivedAt: number | undefined,
  epoch: number,
) {
  const reduced = useReducedMotionConfig()
  const [now, setNow] = useState(() => performance.now())
  const completion = presentation?.completion
  const current =
    !!completion &&
    !!view?.result &&
    completion.hand.matchId === view.matchId &&
    completion.hand.handNo === view.handNo &&
    !presentation?.currentDecision
  useEffect(() => {
    if (!current || reduced) return
    const timer = window.setInterval(() => {
      const at = performance.now()
      setNow(at)
      if (
        completion &&
        receivedAt !== undefined &&
        presentation &&
        presentation.serverNow + at - receivedAt >=
          completion.schedule.earliestNextDealAt
      )
        window.clearInterval(timer)
    }, 80)
    const wake = () => setNow(performance.now())
    document.addEventListener('visibilitychange', wake)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', wake)
    }
  }, [current, completion, presentation, receivedAt, epoch, reduced])
  if (!current || receivedAt === undefined)
    return {
      visible: view?.board.length ?? 0,
      revealing: false,
      holding: false,
    }
  return completionPhase(
    completion,
    presentation.serverNow,
    Math.max(now, performance.now()) - receivedAt,
    !!reduced,
  )
}

const STEP_MS = 900
const RIVER_BEAT_MS = 500

/**
 * When a hand ends in an all-in, the engine deals the rest of the board at
 * once. Broadcast mode reveals it one card at a time instead, with an extra
 * beat before the river, so equity can swing on screen like a TV runout.
 */
export function useRunout(game: Game): Runout {
  const reduced = useReducedMotionConfig()
  const previous = useRef(game)
  const [reveal, setReveal] = useState<{ id: number; shown: number } | null>(
    null,
  )

  useEffect(() => {
    const before = previous.current
    previous.current = game
    if (before === game || before.id !== game.id) return
    const allInRunout =
      !!game.result?.showdown && !before.result && before.board.length < 5
    if (!allInRunout || reduced) return
    setReveal({ id: game.id, shown: before.board.length })
  }, [game, reduced])

  useEffect(() => {
    if (!reveal) return
    if (reveal.shown >= 5) {
      const done = window.setTimeout(() => setReveal(null), STEP_MS)
      return () => window.clearTimeout(done)
    }
    // Flop cards arrive together; the turn and river get their own beat.
    const next = reveal.shown < 3 ? 3 : reveal.shown + 1
    const wait = next === 5 ? STEP_MS + RIVER_BEAT_MS : STEP_MS
    const timer = window.setTimeout(
      () => setReveal({ id: reveal.id, shown: next }),
      wait,
    )
    return () => window.clearTimeout(timer)
  }, [reveal])

  const active = reveal !== null && reveal.id === game.id
  return {
    visible: active ? reveal.shown : game.board.length,
    revealing: active,
  }
}
