// How long a finished hand stays on the table before the next deal. Shared
// by the server, which schedules the deal, and the client, which stages an
// all-in runout one card at a time: the deal must never land while a board
// is still being revealed (audit F02). No imports: the trainer's entry chunk
// carries it.

/** One revealed card (the flop's three come together). */
export const RUNOUT_STEP_MS = 900
/** The extra beat before the river. */
export const RIVER_BEAT_MS = 500

/**
 * How long the client takes to reveal the rest of an all-in board, from
 * `boardBefore` cards on the table to the result: 4100 ms from preflop,
 * 3200 from the flop, 2300 from the turn, 0 when nothing was left to come.
 */
export function runoutMs(boardBefore: number) {
  if (boardBefore >= 5) return 0
  let ms = 0
  for (let shown = boardBefore; shown < 5; ) {
    const next = shown < 3 ? 3 : shown + 1
    ms += next === 5 ? RUNOUT_STEP_MS + RIVER_BEAT_MS : RUNOUT_STEP_MS
    shown = next
  }
  // The last card's own beat before the result shows.
  return ms + RUNOUT_STEP_MS
}
