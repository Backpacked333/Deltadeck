// The shot clock for whoever is to act. The server owns the deadline and
// acts when it passes; this only counts down to it in local time.
import type { SeatView } from '../shared/protocol'
import { clockParts } from './clockParts'
import { useNow } from './useNow'

export function TurnClock({
  clock,
  offset,
  who,
}: {
  clock: NonNullable<SeatView['clock']>
  /** Server time minus local time. */
  offset: number
  who: string
}) {
  const now = useNow(250)
  const { phase, seconds } = clockParts(clock, now + offset)
  return (
    <span
      role="timer"
      className={phase === 'bank' ? 'live-clock live-warn' : 'live-clock'}
      aria-label={`${who}: ${seconds} seconds${phase === 'bank' ? ' of time bank' : ''} left`}
    >
      {who} · {phase === 'bank' ? `bank ${seconds}s` : `${seconds}s`}
    </span>
  )
}
