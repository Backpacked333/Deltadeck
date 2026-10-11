// One seat of the six-seat ring: who sits there, their stack and bet, the
// dealer button and blinds, the shot clock while they are to act, and
// whether they sit out or have dropped. An empty seat offers "Sit here".
// It takes no cards, so a plate can never show a hole card the viewer may
// not see; cards stay with the live table.
// Generic on purpose: Atlas's avatar is for Atlas only (P2-05).
import { WifiOff } from 'lucide-react'
import type { SeatId } from '../engine/types'
import type { SeatView } from '../shared/protocol'
import { clockParts } from './clockParts'
import { useNow } from './useNow'

const chips = (n: number) => Math.round(n).toLocaleString('en-US')

/** The statuses of a seated player at a six table (ADR, "Sitting out"). */
export type SeatStatus = 'playing' | 'sitting_out'

/** A seated player, as the server describes them. */
export type PlateSeat = {
  seat: SeatId
  username: string
  stack: number
  /** Chips in front of them on this street. */
  bet: number
  status: SeatStatus
  /**
   * Their socket is open (MatchInfo.players[].connected). False while they
   * are away: in their 60 s grace, or sitting out after it.
   */
  connected?: boolean
  /** Stood up during the hand whose result is showing (SixTable). */
  left?: boolean
}

export type SeatClock = NonNullable<SeatView['clock']>

export function SeatPlate({
  seat,
  slot,
  player,
  you,
  button,
  sb,
  bb,
  active,
  clock,
  clockOffset,
  onSit,
}: {
  seat: SeatId
  /** Place around the ring: 0 at the bottom, then clockwise. */
  slot: number
  /** null: nobody sits here. */
  player: PlateSeat | null
  you: boolean
  /** The dealer button is here, even when the seat is empty (dead button). */
  button: boolean
  sb: boolean
  bb: boolean
  /** This seat is to act. */
  active: boolean
  clock: SeatClock | null
  /** Server time minus local time. */
  clockOffset: number
  /** Given only while the viewer may take a seat. */
  onSit?: (seat: SeatId) => void
}) {
  // People count seats from 1; seat ids on the wire are 0..5.
  const label = `Seat ${seat + 1}: ${player?.username ?? 'empty'}${you ? ' (you)' : ''}`
  const state = !player
    ? 'empty'
    : player.status === 'sitting_out'
      ? 'sitting-out'
      : 'playing'
  // Said in words, inside the group a screen reader reads with the name.
  const away = player?.connected === false
  return (
    <div
      role="group"
      aria-label={label}
      className="six-seat"
      data-slot={slot}
      data-state={state}
      data-active={active && player ? '' : undefined}
      data-away={away ? '' : undefined}
      // The viewer's own seat takes focus when the live table moves it off
      // a control that went away (Sit here, the action bar).
      tabIndex={you ? -1 : undefined}
    >
      {player ? (
        <div className="six-plate">
          <span className="six-name" title={player.username}>
            {player.username}
          </span>
          <span className="six-stack">
            {chips(player.stack)}
            <span className="sr-only"> chips</span>
          </span>
          {(state === 'sitting-out' || away || (active && clock)) && (
            <span className="six-line">
              {state === 'sitting-out' && (
                <span className="six-status">
                  {player.left ? 'Left the table' : 'Sitting out'}
                </span>
              )}
              {away && (
                <span className="six-away">
                  <WifiOff size={12} aria-hidden="true" />
                  Disconnected
                </span>
              )}
              {active && clock && (
                <PlateClock clock={clock} offset={clockOffset} />
              )}
            </span>
          )}
        </div>
      ) : onSit ? (
        <button
          type="button"
          className="six-plate six-sit"
          onClick={() => onSit(seat)}
        >
          Sit here<span className="sr-only"> (seat {seat + 1})</span>
        </button>
      ) : (
        <div className="six-plate six-empty">Empty</div>
      )}
      {/* Toward the middle of the table: button, blinds and the bet. */}
      <div className="six-chips">
        {button && (
          <Marker className="six-dealer" short="D" long="Dealer button" />
        )}
        {sb && <Marker className="six-blind" short="SB" long="Small blind" />}
        {bb && <Marker className="six-blind" short="BB" long="Big blind" />}
        {player && player.bet > 0 && (
          <span className="six-bet">Bet {chips(player.bet)}</span>
        )}
      </div>
    </div>
  )
}

/** The short mark for the eye, the full words for a screen reader. */
function Marker({
  className,
  short,
  long,
}: {
  className: string
  short: string
  long: string
}) {
  return (
    <span className={className}>
      <span aria-hidden="true">{short}</span>
      <span className="sr-only">{long}</span>
    </span>
  )
}

/**
 * The shot clock on the plate. The server owns the deadline and acts when
 * it passes; this only counts down to it in local time, like TurnClock,
 * without the name the plate already shows.
 */
function PlateClock({ clock, offset }: { clock: SeatClock; offset: number }) {
  const now = useNow(250)
  const { phase, seconds } = clockParts(clock, now + offset)
  const bank = phase === 'bank'
  return (
    <span
      role="timer"
      className={bank ? 'six-clock six-bank' : 'six-clock'}
      aria-label={`${seconds} seconds ${bank ? 'of time bank ' : ''}left`}
    >
      {bank ? `bank ${seconds}s` : `${seconds}s`}
    </span>
  )
}
