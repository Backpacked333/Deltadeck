import { useEffect, useRef, useState } from 'react'
import { useReducedMotionConfig } from 'motion/react'
import type { Game } from '../lib/poker'
import { RIVER_BEAT_MS, RUNOUT_STEP_MS as STEP_MS } from '../shared/pacing'

export type Runout = {
  /** Board cards currently shown (the engine has already dealt all five). */
  visible: number
  /** True while an all-in runout is still being revealed. */
  revealing: boolean
}

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
