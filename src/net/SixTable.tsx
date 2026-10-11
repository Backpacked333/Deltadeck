// A live casual 6-max table (P2-05b). It renders straight from the server's
// frames, the roster from MatchInfo and the hand from SeatView, with no
// two-seat Game in between (toHeroGame is heads-up only). A viewer is one
// of three: without a seat (the table summary and "Sit here", never a
// hand), seated but not dealt into the hand on the table (that hand as
// nobody's seat sees it), or dealt in (their own cards, and the action bar
// while it is their move). Every card drawn here is one the frame carried.
// A seated viewer also has their seat's controls: Rebuy and Stand up.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { ActionBar } from '../components/table/ActionBar'
import { PlayingCard } from '../components/PlayingCard'
import type { LegalActions, PlayerAction, SeatId } from '../engine/types'
import { categories } from '../lib/poker'
import { buildPresets } from '../lib/presets'
import type { Preset } from '../lib/presets'
import { categoryOf, fromId } from '../lib/sim'
import { buyIn, SIX_BLINDS } from '../engine/stacks'
import { isSeated } from '../shared/protocol'
import type { MatchInfo, SeatedView, SeatView } from '../shared/protocol'
import type { TableState } from './client'
import { Cards } from './ReviewLive'
import type { PlateSeat } from './SeatPlate'
import { SixRing } from './SixRing'

const SEATS = 6
/**
 * The buy-in, and what a rebuy tops up to: 100 bb (R-10). Only to offer
 * Rebuy: the server tops up from the table's stored blinds
 * (`match.config.blinds`), so if stakes ever vary per table this must
 * come over the wire instead.
 */
const TOP_UP = buyIn(SIX_BLINDS.bb)
const noop = () => {}
/** Where a tab keeps the hand it stood from (`matchId:handNo:seat`). */
const STOOD_KEY = 'qp.six.stoodFrom'
const readStood = (): string | null => {
  try {
    return sessionStorage.getItem(STOOD_KEY)
  } catch {
    return null
  }
}
const keepStood = (key: string) => {
  try {
    sessionStorage.setItem(STOOD_KEY, key)
  } catch {
    // Storage refused (a private window): this page still knows.
  }
}
const chips = (n: number) => Math.round(n).toLocaleString('en-US')
const NO_GUESS = {
  show: false,
  value: 0.5,
  locked: null,
  onChange: noop,
  onLock: noop,
  onSkip: noop,
}

type Move = 'fold' | 'continue' | 'raise'

export function SixTable({
  table,
  state,
  act,
  sit,
  rebuy,
  stand,
}: {
  table: MatchInfo
  state: TableState
  act: (action: PlayerAction) => boolean
  sit: (seat: SeatId) => boolean
  rebuy: () => boolean
  stand: () => boolean
}) {
  const { view, seat } = state
  const dealt = view && isSeated(view) ? view : null
  const live = view && !view.result ? view : null
  // Our own seat's controls. The hand we are dealt into while it is being
  // played, if any: a rebuy waits for it to end, and a stand during it
  // keeps the seat until then. The wire has no marker of that pending
  // stand (ADR, clarifications from PR-12), so we remember the hand and
  // seat we stood from ourselves, in this tab, so a reload still knows.
  const playing = dealt && !dealt.result ? dealt : null
  const handKey = view ? `${view.matchId}:${view.handNo}` : null
  const standKey = playing ? `${handKey}:${playing.you}` : null
  const [stoodFrom, setStoodFrom] = useState(readStood)
  const leaving = standKey !== null && stoodFrom === standKey
  // The bar only while the move is ours to make: dealt in, our turn by the
  // server's own legal moves, a socket to send on, no move in flight, and
  // not after we stood from this hand (the table folds us; it refuses a
  // move from a player who stood).
  const legal =
    dealt &&
    !dealt.result &&
    dealt.toAct === dealt.you &&
    state.status === 'open' &&
    !state.pending &&
    !leaving
      ? dealt.legal
      : null
  // Per-hand names come from the hand's own record once it has one; until
  // then a dealt seat is still held by the player dealt into it.
  const record = view ? state.hands[view.handNo]?.record : undefined
  const nameOf = (s: SeatId) =>
    record?.seats.find((r) => r.seat === s)?.username ??
    table.players.find((p) => p.seat === s)?.username ??
    `Seat ${s + 1}`

  const [flash, setFlash] = useState<string | null>(null)
  useEffect(() => {
    if (!state.error || state.error.code === 'unauthorized') return
    setFlash(state.error.message)
    const timer = window.setTimeout(() => setFlash(null), 3000)
    return () => window.clearTimeout(timer)
  }, [state.error])

  // "Sit here" and the action bar unmount under the keyboard: the welcome
  // takes the one away, our own move the other. Focus would fall to <body>
  // and the next Tab start again from the top of the page, so it goes to
  // our own seat, which stays put, or without a seat to the table status.
  const root = useRef<HTMLDivElement>(null)
  const focused = useRef<Element | null>(null)
  useLayoutEffect(() => {
    const last = focused.current
    if (!last || last.isConnected) return
    focused.current = null
    const active = document.activeElement
    if (active && active !== document.body) return
    root.current
      ?.querySelector<HTMLElement>(
        seat !== null ? '.six-seat[data-slot="0"]' : '.six-wait',
      )
      ?.focus()
  })

  // The bar's height while it was last up. On a phone it is several times
  // the height of the status that replaces it, so the space under the ring
  // keeps it (live.css): a page scrolled down to the bar would otherwise
  // jump on every turn.
  const [dock, setDock] = useState(0)

  const canSit =
    seat === null && state.status === 'open' && table.status !== 'finished'
  const mine =
    seat === null ? undefined : table.players.find((p) => p.seat === seat)
  const controls = state.status === 'open' && table.status !== 'finished'
  // A Rebuy, or a Stand up between hands, sent and not yet answered. The
  // answer is a welcome (the new stack; no seat) or an error, and the
  // button stays away until then: a double press would send the frame
  // twice, and the second one's refusal (not_below, not_seated) would
  // flash just after the first worked. Keyed by the hand and our stack,
  // which the answer changes. A dropped socket may have lost the frame,
  // and a new seat has asked nothing, so either forgets it.
  const [asked, setAsked] = useState<string | null>(null)
  const askKey = `${handKey}:${mine?.stack}`
  useEffect(() => setAsked(null), [state.status, seat])
  // The roster's stack is what the next hand deals us (after the last
  // hand, or a rebuy); the server decides, this only offers.
  const canRebuy =
    controls &&
    !playing &&
    mine?.stack !== undefined &&
    mine.stack < TOP_UP &&
    asked !== `rebuy:${askKey}`
  const canStand = controls && !!mine && !leaving && asked !== `stand:${askKey}`
  // Seated without chips and out of any hand being played: no hand deals
  // us in until we rebuy (the server deals only funded players).
  const broke = !playing && mine?.stack === 0
  const onRebuy = () => {
    if (rebuy()) setAsked(`rebuy:${askKey}`)
  }
  const onStand = () => {
    if (!stand()) return
    if (standKey) {
      setStoodFrom(standKey)
      keepStood(standKey)
    } else setAsked(`stand:${askKey}`)
  }
  return (
    <div
      className="play-column live-table six-table"
      ref={root}
      onFocus={(event) => {
        focused.current = event.target
      }}
    >
      <div className="live-matchbar" role="status" aria-live="polite">
        <span>{view ? `6-max · Hand ${view.handNo}` : '6-max'}</span>
        <span>{`${table.players.length} of ${SEATS} seats taken`}</span>
        {/* The bar's own status mounts with the bar, already saying "Your
            move", and screen readers do not reliably announce a live
            region that arrives with its text. This one stays. */}
        {dealt && legal && <span className="sr-only">Your move</span>}
        {state.status === 'reconnecting' && (
          <span className="live-warn">
            {state.error?.code === 'rate_limited'
              ? state.error.message
              : 'Reconnecting…'}
          </span>
        )}
      </div>
      <SixRing
        players={plates(table, view, nameOf)}
        you={seat}
        button={view?.button ?? null}
        sb={view?.sb ?? null}
        bb={view?.bb ?? null}
        toAct={live?.toAct ?? null}
        clock={live && live.toAct !== null ? live.clock : null}
        clockOffset={state.clockOffset}
        onSit={canSit ? (s) => void sit(s) : undefined}
      >
        <Middle view={view} />
      </SixRing>
      <div
        className="six-dock"
        style={
          seat !== null && dock
            ? ({ '--dock': `${dock}px` } as CSSProperties)
            : undefined
        }
      >
        {dealt && legal ? (
          <SixActions view={dealt} legal={legal} act={act} onHeight={setDock} />
        ) : (
          <SixStatus
            table={table}
            view={view}
            state={state}
            nameOf={nameOf}
            broke={broke}
          />
        )}
      </div>
      {seat !== null && (
        <SeatControls
          canRebuy={canRebuy}
          canStand={canStand}
          leaving={leaving}
          broke={broke}
          onRebuy={onRebuy}
          onStand={onStand}
        />
      )}
      {flash && (
        <p className="live-error" role="alert">
          {flash}
        </p>
      )}
    </div>
  )
}

/**
 * Who sits where, from the roster. While a hand is played, a seat dealt
 * into it shows its chips behind and in front from that hand. Anyone else,
 * and every seat once the hand is over, shows the stack the roster gives:
 * what the next hand deals them (after the last hand, or a rebuy). A seat
 * whose player left as the hand ended may have a new one by then.
 */
function plates(
  table: MatchInfo,
  view: SeatView | null,
  nameOf: (seat: SeatId) => string,
): PlateSeat[] {
  const live = view && !view.result ? view : null
  const seated: PlateSeat[] = table.players.map((p) => {
    const inHand = live?.players.find((h) => h.seat === p.seat)
    return {
      seat: p.seat,
      username: p.username,
      stack: inHand?.stack ?? p.stack ?? 0,
      bet: inHand?.bet ?? 0,
      status: p.status ?? 'playing',
    }
  })
  // A player who stood during the hand leaves the roster as it ends. While
  // its result shows and the next hand is coming, their seat still shows
  // them with what they had there, unless someone has sat in it since.
  if (!view?.result || table.status !== 'playing') return seated
  const left: PlateSeat[] = view.players
    .filter((h) => !table.players.some((p) => p.seat === h.seat))
    .map((h) => ({
      seat: h.seat,
      username: nameOf(h.seat),
      stack: h.stack,
      bet: h.bet,
      status: 'sitting_out',
      left: true,
    }))
  return [...seated, ...left]
}

/**
 * The viewer's own seat. Rebuy is offered below 100 bb out of the hand
 * being played; Stand up to anyone seated, until they have stood from the
 * hand they are dealt into. The line under them says when a stand waits
 * for the hand to end, or that a player with no chips must rebuy to be
 * dealt in. It is a live region mounted with the controls, so its change
 * is announced, as the hand's result is: a player who busts hears both.
 */
function SeatControls({
  canRebuy,
  canStand,
  leaving,
  broke,
  onRebuy,
  onStand,
}: {
  canRebuy: boolean
  canStand: boolean
  leaving: boolean
  broke: boolean
  onRebuy: () => void
  onStand: () => void
}) {
  return (
    <div className="six-seat-controls" role="group" aria-label="Your seat">
      {canRebuy && (
        <button type="button" className="btn btn-outline" onClick={onRebuy}>
          Rebuy<span className="sr-only"> to {chips(TOP_UP)} chips</span>
        </button>
      )}
      {canStand && (
        <button type="button" className="btn btn-quiet" onClick={onStand}>
          Stand up
        </button>
      )}
      <p className="six-seat-status" role="status">
        {leaving
          ? 'Leaving after this hand'
          : broke
            ? 'No chips left: rebuy to be dealt in.'
            : ''}
      </p>
    </div>
  )
}

/** The middle of the felt: the pot, the board, and the viewer's own cards. */
function Middle({ view }: { view: SeatView | null }) {
  const mine =
    view && view.you !== null
      ? view.players.find((p) => p.seat === view.you)
      : undefined
  return (
    <>
      {view && !view.result && (
        <p className="six-pot">
          Pot <b>{chips(view.pot.total)}</b>
        </p>
      )}
      <div className="six-board" role="group" aria-label="Community cards">
        {Array.from({ length: 5 }, (_, i) =>
          view && view.board[i] !== undefined ? (
            <PlayingCard
              key={`${view.handNo}-${view.board[i]}`}
              card={fromId(view.board[i])}
            />
          ) : (
            <PlayingCard key={`empty-${i}`} empty />
          ),
        )}
      </div>
      {mine?.cards && (
        <div className="six-hole" role="group" aria-label="Your cards">
          {mine.cards.map((id) => (
            <PlayingCard key={id} card={fromId(id)} dim={mine.folded} />
          ))}
        </div>
      )}
    </>
  )
}

/** The trainer's action bar, fed from the six-seat hand. */
function SixActions({
  view,
  legal,
  act,
  onHeight,
}: {
  view: SeatedView
  legal: LegalActions
  act: (action: PlayerAction) => boolean
  /** The bar's own height, whenever it changes. */
  onHeight: (px: number) => void
}) {
  const box = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = box.current!
    onHeight(el.offsetHeight)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => onHeight(el.offsetHeight))
    observer.observe(el)
    return () => observer.disconnect()
  }, [onHeight])
  const bets = view.players.map((p) => p.bet)
  const pot = view.pot.total
  const presets = buildPresets(legal, pot, legal.toCall, bets)
  // A size picked for one decision does not carry into the next.
  const decision = `${view.handNo}:${view.actions.length}`
  const [sizing, setSizing] = useState<{ id: string; to: number } | null>(null)
  const raiseTo = Math.min(
    legal.maxRaiseTo,
    Math.max(
      legal.minRaiseTo,
      sizing?.id === decision
        ? sizing.to
        : (presets[0]?.to ?? legal.minRaiseTo),
    ),
  )
  const size = (to: number) => setSizing({ id: decision, to })
  const move = (kind: Move) => {
    if (kind === 'fold') act({ type: 'fold' })
    else if (kind === 'continue')
      act({ type: legal.canCheck ? 'check' : 'call' })
    else if (legal.canRaise) act({ type: 'raise', to: raiseTo })
  }
  useMoveKeys(legal, presets, move, size)
  return (
    <div className="six-actions" ref={box}>
      <ActionBar
        game={{ bets, pot, stacks: view.players.map((p) => p.stack) }}
        legal={legal}
        yourTurn
        heroTurn
        paused={false}
        raiseTo={raiseTo}
        presets={presets}
        math={{
          revealed: false,
          ready: false,
          breakEven: legal.toCall / (pot + legal.toCall || 1),
        }}
        guess={NO_GUESS}
        shortcuts
        onRaiseTo={size}
        onAct={move}
        onDeal={noop}
        onReview={noop}
        // Shown only while the move is not ours, which never happens here:
        // this bar is mounted for the viewer's turn alone.
        versus={{ opponent: 'The table', next: '' }}
      />
    </div>
  )
}

/**
 * The trainer's keys (App.tsx): F folds when there is a bet to fold to, C
 * checks or calls, R or B bets or raises, 1 to 4 pick a size. The listener
 * exists only while SixActions is mounted, so a key never acts out of turn.
 * It re-subscribes on every render to always hold this decision's handlers.
 */
function useMoveKeys(
  legal: LegalActions,
  presets: Preset[],
  move: (kind: Move) => void,
  size: (to: number) => void,
) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      // A key held down repeats, and a key an input method is composing
      // into text is not a move.
      if (event.repeat || event.isComposing) return
      const target = event.target
      if (
        target instanceof Element &&
        target.closest(
          'textarea, select, [contenteditable="true"], input:not([type="range"])',
        )
      )
        return
      const key = event.key.toLowerCase()
      const preset = presets.find((p) => p.key === key)
      if (key === 'f' && legal.toCall) move('fold')
      else if (key === 'c') move('continue')
      else if (key === 'r' || key === 'b') move('raise')
      else if (preset) size(preset.to)
      else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
}

/** Where the table stands when the move is not the viewer's. */
function SixStatus({
  table,
  view,
  state,
  nameOf,
  broke,
}: {
  table: MatchInfo
  view: SeatView | null
  state: TableState
  nameOf: (seat: SeatId) => string
  /** Seated with no chips: the seat controls say to rebuy (SixTable). */
  broke: boolean
}) {
  const seated = state.seat !== null
  const result = view?.result ?? null
  const net =
    result && view && view.you !== null
      ? (result.netBySeat[view.you] ?? 0)
      : null
  // Cards the frame shows face up: showdown hands other than our own.
  const shown = view
    ? view.players.flatMap((p) =>
        p.shown && p.cards && p.seat !== view.you
          ? [{ seat: p.seat, cards: p.cards }]
          : [],
      )
    : []
  const title =
    table.status === 'finished'
      ? 'This table has closed.'
      : result && view
        ? resultText(view, result, nameOf)
        : !seated
          ? table.players.length >= SEATS
            ? 'Every seat is taken.'
            : 'Pick an empty seat to play.'
          : !view
            ? table.players.length < 2
              ? 'Waiting for a second player to sit down.'
              : 'The next hand deals in a moment.'
            : view.toAct === null
              ? 'Dealing…'
              : view.toAct === view.you
                ? state.status === 'open'
                  ? 'Move sent…'
                  : 'Your move, once reconnected.'
                : `${nameOf(view.toAct)} to act`
  const caption =
    table.status === 'finished' ? (
      <a href="#lobby">Back to the lobby</a>
    ) : broke ? null : seated && view?.you === null ? (
      'You are dealt in from the next hand.'
    ) : !seated && table.players.length < SEATS ? (
      'Take a seat to be dealt in from the next hand.'
    ) : result ? (
      table.status === 'waiting' ? (
        'Waiting for players to deal the next hand.'
      ) : (
        'Next hand in a few seconds.'
      )
    ) : null
  return (
    // Focusable, so focus can land here when the control holding it goes
    // and there is no seat of our own to land on (SixTable).
    <div className="six-wait" tabIndex={-1}>
      <div className="action-status" aria-live="polite">
        <span
          className={`status-dot ${net === null || net === 0 ? 'wait' : net > 0 ? 'up' : 'down'}`}
        />
        <strong>{title}</strong>
        {net !== null && (
          <span className={net >= 0 ? 'positive' : 'negative'}>
            {net >= 0 ? '+' : '−'}
            {chips(Math.abs(net))} chips
          </span>
        )}
      </div>
      {shown.length > 0 && (
        <ul className="six-shown" aria-label="Shown hands">
          {shown.map((p) => (
            <li key={p.seat}>
              {nameOf(p.seat)} <Cards ids={p.cards} />
            </li>
          ))}
        </ul>
      )}
      {caption && <p className="action-caption">{caption}</p>}
    </div>
  )
}

/**
 * "You win · Flush", "carol wins", "bob and carol win · Two pair". Side
 * pots can go to different hands, so each winner is named with their own:
 * "You win · Two pair; carol wins · Flush".
 */
function resultText(
  view: SeatView,
  result: NonNullable<SeatView['result']>,
  nameOf: (seat: SeatId) => string,
) {
  // Whoever was awarded a pot, even a side pot worth less than they put in.
  const awarded = new Set(
    result.awards.filter((a) => a.amount > 0).map((a) => a.seat),
  )
  const winners = view.players.map((p) => p.seat).filter((s) => awarded.has(s))
  // Everyone got back what they put in.
  if (winners.every((s) => (result.netBySeat[s] ?? 0) === 0)) return 'Split pot'
  const phrase = (seats: SeatId[]) => {
    const names = seats.map((s) => (s === view.you ? 'You' : nameOf(s)))
    const who =
      names.length === 1
        ? names[0]
        : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
    return `${who} ${names.length === 1 && seats[0] !== view.you ? 'wins' : 'win'}`
  }
  if (!result.showdown) return phrase(winners)
  // Every award to a seat carries that seat's own hand.
  const handOf = (seat: SeatId) =>
    categories[
      categoryOf(
        Math.max(
          0,
          ...result.awards.filter((a) => a.seat === seat).map((a) => a.score),
        ),
      )
    ]
  const byHand = new Map<string, SeatId[]>()
  for (const s of winners)
    byHand.set(handOf(s), [...(byHand.get(handOf(s)) ?? []), s])
  return [...byHand]
    .map(([hand, seats]) => `${phrase(seats)} · ${hand}`)
    .join('; ')
}
