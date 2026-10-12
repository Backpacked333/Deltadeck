// A live table. Everything shown comes from the server's snapshot for this
// seat. Heads-up, it is projected into the trainer's Game so the same Table
// and ActionBar render it; a six-casual table renders the six-seat ring
// instead (SixTable). No analysis runs here: the lab stays off in play.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { ActionBar } from '../components/table/ActionBar'
import type { Sending } from '../components/table/ActionBar'
import { Table } from '../components/table/Table'
import { toHeroGame } from '../engine/project'
import type { SeatId } from '../engine/types'
import { legalActions } from '../lib/poker'
import { buildPresets } from '../lib/presets'
import { isSeated, QUICK_SIT_TABLES } from '../shared/protocol'
import type {
  ErrorCode,
  MatchInfo,
  SeatedView,
  SeatView,
} from '../shared/protocol'
import { useRunout } from '../state/runout'
import { PlayerAvatar, SchoolCrest } from './Avatar'
import { inviteLink } from './api'
import type { Identity } from './api'
import type { TableState } from './client'
import { HostInvite } from './HostInvite'
import { MatchEnd } from './MatchEnd'
import { matchOverText } from './matchResult'
import { ReviewLive } from './ReviewLive'
import { SixTable } from './SixTable'
import type { Passed, QuickSit } from './TableList'
import { TurnClock } from './TurnClock'
import { useRtt, useTable } from './useTable'
import type { RttStore } from './heartbeat'

const noop = () => {}
const keep = () => {}

/**
 * A quick-sit's sit unanswered this long is given up (ADR, clarifications
 * from PR-25): the table can stay silent when it halted during the sit's
 * lobby claim, or the claim threw.
 */
export const SIT_ANSWER_MS = 10_000

/** The refusals a quick-sit moves on from, and how the lobby page says it. */
const MOVE_ON: Partial<Record<ErrorCode, Passed>> = {
  table_full: 'table_full',
  sit_cooldown: 'sit_cooldown',
  // "There is no seat to take here": the table halted since the list.
  illegal: 'closed',
}

export function LiveTable({
  matchId,
  identity,
  quickSit = null,
  setQuickSit = keep,
}: {
  matchId: string
  identity: Identity
  /** A quick-sit on its way between pages (LiveApp). */
  quickSit?: QuickSit | null
  setQuickSit?: (next: QuickSit | null) => void
}) {
  const {
    state,
    act,
    rematch,
    sit,
    resync,
    rebuy,
    stand,
    sitOut,
    sitIn,
    answer,
    rtt,
  } = useTable(matchId, identity.getToken)
  const { taking, arrived } = useSitOnArrival(
    matchId,
    state,
    sit,
    resync,
    quickSit,
    setQuickSit,
  )
  const { status, table, view, seat } = state

  // While a quick-sit hands off to the next page, this one says only that
  // it is taking a seat: no closed or elsewhere page on the way out.
  if (status === 'elsewhere' && !taking)
    return (
      <div className="empty live-empty" role="alert">
        <h3>You are already playing at another table.</h3>
        <p>Finish that match first; one table at a time.</p>
        {state.elsewhere && (
          <a className="btn btn-primary" href={`#play/${state.elsewhere}`}>
            Go to your table
          </a>
        )}
      </div>
    )
  // A six table has no invites and no heads-up search to offer.
  if (
    status === 'closed' &&
    !taking &&
    (arrived || table?.kind === 'six-casual')
  )
    return (
      <div className="empty live-empty" role="alert">
        <h3>This table has closed.</h3>
        <a className="btn btn-primary" href="#lobby">
          Back to the lobby
        </a>
      </div>
    )
  if (status === 'closed' && !taking)
    return (
      <div className="empty live-empty" role="alert">
        <h3>This table has closed</h3>
        <p>
          Finished tables close after a few minutes, and unused invites after a
          day.
        </p>
        <a className="btn btn-primary" href="#lobby/find">
          Find a match
        </a>
      </div>
    )
  if (status === 'failed' || status === 'replaced')
    return (
      <div className="empty live-empty" role="alert">
        <h3>
          {status === 'replaced'
            ? 'This table is open in another tab.'
            : 'Could not join this table.'}
        </h3>
        <p>
          {status === 'replaced'
            ? 'Keep playing there, or reload this page to play here instead.'
            : (state.error?.message ??
              'The table may be full or the link may be wrong.')}
        </p>
        <a className="btn btn-outline" href="#lobby">
          Back to the lobby
        </a>
      </div>
    )
  // A six table has viewers without a seat; it renders from its own frames.
  if (table?.kind === 'six-casual')
    return (
      <SixTable
        table={table}
        state={state}
        taking={taking}
        act={act}
        sit={sit}
        rebuy={rebuy}
        stand={stand}
        sitOut={sitOut}
        sitIn={sitIn}
      />
    )
  if (!table || seat === null)
    return (
      <p className="live-status" role="status">
        Joining the table…
      </p>
    )

  const opponent = table.players.find((p) => p.seat !== seat)
  return (
    <div className="play-column live-table">
      <MatchBar table={table} seat={seat} view={view} state={state} rtt={rtt} />
      {view && isSeated(view) ? (
        <LiveHand
          view={view}
          opponent={opponent?.username ?? 'Opponent'}
          state={state}
          act={act}
          rematch={rematch}
        />
      ) : (
        <WaitingRoom
          matchId={matchId}
          table={table}
          seat={seat}
          ended={state.ended}
          invite={state.invite}
          open={state.status === 'open'}
          answer={answer}
        />
      )}
    </div>
  )
}

/**
 * The player's round trip to the table as a dot: green under 80 ms, amber
 * under 200, red above, the figure in its tooltip. Reads its own store, so
 * a ping every few seconds re-renders this and nothing else.
 */
function Signal({ store }: { store: RttStore | null }) {
  const ms = useRtt(store)
  if (ms === null) return null
  const level = ms < 80 ? 'good' : ms < 200 ? 'fair' : 'poor'
  return (
    <span
      className={`live-signal live-signal-${level}`}
      role="img"
      aria-label={`Connection ${ms} ms`}
      title={`${ms} ms`}
    />
  )
}

function MatchBar({
  table,
  seat,
  view,
  state,
  rtt,
}: {
  table: MatchInfo
  seat: SeatId
  view: SeatView | null
  state: TableState
  rtt: RttStore | null
}) {
  const opponent = table.players.find((p) => p.seat !== seat)
  return (
    <div className="live-matchbar" role="status" aria-live="polite">
      <span>
        {view
          ? `${table.kind === 'hu-rated' ? 'Rated · ' : ''}Hand ${view.handNo} of ${table.handsTotal}`
          : 'Waiting room'}
      </span>
      {opponent && (
        <span className={opponent.connected ? '' : 'live-warn'}>
          vs{' '}
          {opponent.avatar && (
            <PlayerAvatar
              username={opponent.username}
              avatar={opponent.avatar}
              size={20}
            />
          )}
          <b>{opponent.username}</b>
          <SchoolCrest school={opponent.school} />
          {!opponent.connected && ' · disconnected'}
        </span>
      )}
      {view?.clock && !view.result && view.toAct !== null && (
        <TurnClock
          clock={view.clock}
          offset={state.clockOffset}
          who={
            view.toAct === seat
              ? 'Your clock'
              : (opponent?.username ?? 'Opponent')
          }
        />
      )}
      {state.status === 'reconnecting' && (
        <span className="live-warn">
          {state.error?.code === 'rate_limited'
            ? state.error.message
            : 'Reconnecting…'}
        </span>
      )}
      <Signal store={rtt} />
    </div>
  )
}

function WaitingRoom({
  matchId,
  table,
  seat,
  ended,
  invite,
  open,
  answer,
}: {
  matchId: string
  table: MatchInfo
  seat: SeatId
  ended: TableState['ended']
  invite: TableState['invite']
  open: boolean
  answer: (requestId: string, accept: boolean) => boolean
}) {
  const link = inviteLink(matchId)
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }
  const opponent = table.players.find((p) => p.seat !== seat)
  if (ended?.reason === 'no_show')
    return (
      <section className="panel live-signin" aria-labelledby="waiting-title">
        <h2 id="waiting-title">
          {opponent ? `${opponent.username} did not show up` : 'Nobody came'}
        </h2>
        <p className="live-muted">
          The table closed after 30 seconds. Nothing was played or recorded
          against you.
        </p>
        <a className="btn btn-primary" href="#lobby/find">
          Find another match
        </a>
      </section>
    )
  if (table.status === 'finished')
    return (
      <section className="panel live-signin" aria-labelledby="waiting-title">
        <h2 id="waiting-title">This table has closed</h2>
        <p className="live-muted">
          Not everyone arrived in time, so no hands were dealt.
        </p>
        <a className="btn btn-primary" href="#lobby/find">
          Find a match
        </a>
      </section>
    )
  const full = table.players.length === 2
  if (full && opponent && !opponent.connected)
    return (
      <section className="panel live-signin" aria-labelledby="waiting-title">
        <h2 id="waiting-title">Waiting for {opponent.username}</h2>
        <p className="live-muted">
          You were paired. The first hand deals as soon as they open the table;
          if they do not within 30 seconds, the table closes.
        </p>
      </section>
    )
  return (
    <section className="panel live-signin" aria-labelledby="waiting-title">
      <h2 id="waiting-title">
        {full ? 'Both players are here' : 'Waiting for your opponent'}
      </h2>
      {seat === 0 && !full ? (
        <>
          <p className="live-muted">
            Send this link. The first person to open it takes the other seat,
            and the first hand deals as soon as you are both here.
          </p>
          <div className="live-row">
            <input
              aria-label="Invite link"
              readOnly
              value={link}
              onFocus={(e) => e.target.select()}
            />
            <button className="btn btn-primary" onClick={() => void copy()}>
              {copied ? <Check size={16} /> : <Copy size={16} />}
              {copied ? 'Copied' : 'Copy link'}
            </button>
          </div>
          <HostInvite
            invite={invite}
            answer={answer}
            open={open}
            matchId={matchId}
          />
        </>
      ) : (
        <p className="live-muted">The first hand deals in a moment.</p>
      )}
    </section>
  )
}

function LiveHand({
  view,
  opponent,
  state,
  act,
  rematch,
}: {
  view: SeatedView
  opponent: string
  state: TableState
  act: ReturnType<typeof useTable>['act']
  rematch: () => void
}) {
  const game = useMemo(() => toHeroGame(view, opponent), [view, opponent])
  // The rail light drains the clock of whoever is to act.
  const { clockOffset } = state
  const clock = useMemo(
    () =>
      view.clock && !view.result && view.toAct !== null
        ? {
            clock: { ...view.clock, offset: clockOffset },
            hero: view.toAct === view.you,
          }
        : null,
    [view.clock, view.result, view.toAct, view.you, clockOffset],
  )
  const runout = useRunout(game)
  const yourTurn =
    !game.result && view.toAct === view.you && state.status === 'open'
  // The server's legal moves when it is our turn; otherwise what we would
  // face, so the bar can show it greyed out.
  const legal = view.legal ?? legalActions({ ...game, turn: 0 })
  const presets = buildPresets(legal, game.pot, legal.toCall, game.bets)
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
  const [flash, setFlash] = useState<string | null>(null)
  useEffect(() => {
    if (!state.error || state.error.code === 'unauthorized') return
    setFlash(state.error.message)
    const timer = window.setTimeout(() => setFlash(null), 3000)
    return () => window.clearTimeout(timer)
  }, [state.error])

  // The move just sent, shown at once on its button and in the status line
  // (ActionBar `sending`). Local to this decision: it ends when the server
  // answers (pending clears), and a snapshot of a later decision is not it.
  const [sent, setSent] = useState<({ decision: string } & Sending) | null>(
    null,
  )
  const sending: Sending | null =
    state.pending && sent?.decision === decision
      ? { kind: sent.kind, label: sent.label }
      : null
  useEffect(() => {
    if (!state.pending) setSent(null)
  }, [state.pending])

  const chips = (n: number) => Math.round(n).toLocaleString('en-US')
  const onAct = (kind: Sending['kind']) => {
    if (!yourTurn) return
    let label: string
    let sentOk = false
    if (kind === 'fold') {
      label = 'Fold'
      sentOk = act({ type: 'fold' })
    } else if (kind === 'continue') {
      label = legal.canCheck ? 'Check' : `Call ${chips(legal.toCall)}`
      sentOk = act({ type: legal.canCheck ? 'check' : 'call' })
    } else if (legal.canRaise) {
      const betting = Math.max(...game.bets) === 0
      label = `${betting ? 'Bet' : 'Raise to'} ${chips(raiseTo)}`
      sentOk = act({ type: 'raise', to: raiseTo })
    } else return
    if (sentOk) setSent({ decision, kind, label })
  }

  const ended = state.ended
  // The big blind of the match's hands, for a rated total in bb.
  const bb = Object.values(state.hands).find((h) => h.record)?.record?.config
    .blinds.bb
  const next = ended
    ? matchOverText(ended, view.you, bb)
    : view.handNo >= (state.table?.handsTotal ?? Infinity)
      ? 'That was the last hand.'
      : 'Next hand in a few seconds.'

  return (
    <>
      <Table
        game={game}
        style="balanced"
        bubble={null}
        paused={false}
        yourTurn={yourTurn}
        guidedStep={null}
        showBubbles={false}
        onTogglePause={noop}
        onHistory={noop}
        onSettings={noop}
        onSkipGuided={noop}
        runout={runout}
        versus={{ opponent }}
        clock={clock}
      />
      <ActionBar
        game={game}
        legal={legal}
        yourTurn={yourTurn && !state.pending}
        heroTurn={yourTurn}
        paused={false}
        raiseTo={raiseTo}
        presets={presets}
        math={{
          revealed: false,
          ready: false,
          breakEven: legal.toCall / (game.pot + legal.toCall || 1),
        }}
        guess={{
          show: false,
          value: 0.5,
          locked: null,
          onChange: noop,
          onLock: noop,
          onSkip: noop,
        }}
        shortcuts={false}
        onRaiseTo={(to) => setSizing({ id: decision, to })}
        onAct={onAct}
        onDeal={noop}
        onReview={noop}
        revealing={runout.revealing}
        versus={{ opponent, next, rated: view.match.kind === 'hu-rated' }}
        sending={sending}
      />
      {ended?.outcomeBySeat ? (
        <MatchEnd
          result={ended}
          you={view.you}
          bb={bb}
          opponent={opponent}
          rematch={state.rematch}
          rating={state.rating}
          clockOffset={state.clockOffset}
          onRematch={rematch}
        />
      ) : (
        ended && (
          <div className="live-ended" role="status">
            <strong>
              {ended.reason === 'forfeit'
                ? ended.forfeit === view.you
                  ? 'Match over: you ran out of time three times in a row.'
                  : `Match over: ${opponent} ran out of time three times in a row.`
                : ended.reason === 'abandoned'
                  ? 'Match over: both players were away, so it is void.'
                  : 'Match over.'}
            </strong>{' '}
            <a href="#lobby">Back to the lobby</a>
          </div>
        )
      )}
      <HandReviews state={state} you={view.you} />
      {flash && (
        <p className="live-error" role="alert">
          {flash}
        </p>
      )}
    </>
  )
}

/** Finished hands of this match, newest first, one open at a time. */
function HandReviews({ state, you }: { state: TableState; you: SeatId }) {
  const done = Object.keys(state.hands)
    .map(Number)
    .filter((n) => state.hands[n].record)
    .sort((a, b) => b - a)
  const [open, setOpen] = useState<number | null>(null)
  if (!done.length) return null
  const latest = done[0]
  const at = open !== null && state.hands[open]?.record ? open : null
  const index = at === null ? -1 : done.indexOf(at)
  return (
    <div className="live-reviews">
      {at === null ? (
        <button className="btn btn-outline" onClick={() => setOpen(latest)}>
          Review hand {latest}
        </button>
      ) : (
        <>
          <div className="live-row live-review-nav">
            <button
              className="btn btn-outline"
              disabled={index >= done.length - 1}
              onClick={() => setOpen(done[index + 1])}
            >
              Earlier hand
            </button>
            <button
              className="btn btn-outline"
              disabled={index <= 0}
              onClick={() => setOpen(done[index - 1])}
            >
              Later hand
            </button>
            <button className="btn" onClick={() => setOpen(null)}>
              Close review
            </button>
          </div>
          <ReviewLive seen={state.hands[at]} you={you} />
        </>
      )}
    </div>
  )
}

type Step = 'sit' | 'done' | { since: TableState['error'] }

/**
 * Sent here by a quick-sit (ADR, clarifications from PR-25): one bare sit
 * once the table says it has a seat for us to take, and on a refusal, back
 * to the lobby to ask again, naming this table. True while the sit is on
 * its way. Every exit ends the quick-sit here: seated; sent on (a refusal,
 * or the account's own table); or stopped, with Sit here offered, when the
 * socket went (the sit is never sent twice) or the table never answered.
 */
function useSitOnArrival(
  matchId: string,
  state: TableState,
  sit: () => boolean,
  resync: () => boolean,
  quickSit: QuickSit | null,
  setQuickSit: (next: QuickSit | null) => void,
) {
  // Taken on the first render and cleared, so a reload, a link or a later
  // visit to this table sits nobody.
  const [tried] = useState(() =>
    quickSit?.at === matchId ? quickSit.tried : null,
  )
  const [held] = useState(quickSit !== null)
  useEffect(() => {
    if (held) setQuickSit(null)
  }, [held, setQuickSit])
  const [taking, setTaking] = useState(tried !== null)
  // A ref: the effect below runs on every frame, and acts once per step.
  const step = useRef<Step>(tried ? 'sit' : 'done')
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const { status, table, seat, error, elsewhere } = state
  useEffect(() => {
    if (!tried || step.current === 'done') return
    // Leaving for another page: still taking a seat until it unmounts,
    // so this page puts up no refusal of its own on the way out.
    const end = (leaving = false) => {
      step.current = 'done'
      window.clearTimeout(timer.current)
      if (!leaving) setTaking(false)
    }
    const moveOn = (passed: Passed) => {
      // A whole quick-sit asks the lobby at most 1 + QUICK_SIT_TABLES times.
      const again = tried.length < QUICK_SIT_TABLES
      end(again)
      if (again)
        setQuickSit({
          tried: [...new Set([...tried, matchId])],
          at: null,
          passed,
          from: matchId,
        })
    }
    if (status === 'closed') return moveOn('closed')
    if (status === 'elsewhere') {
      end(!!elsewhere)
      if (elsewhere) window.location.replace(`#play/${elsewhere}`)
      return
    }
    if (step.current === 'sit') {
      if (status === 'replaced' || status === 'failed') return end()
      if (status !== 'open' || !table) return
      if (table.kind !== 'six-casual' || seat !== null) return end()
      if (table.status === 'finished') return moveOn('closed')
      if (!sit()) return
      step.current = { since: error }
      timer.current = window.setTimeout(() => {
        if (step.current === 'done') return
        end()
        resync()
      }, SIT_ANSWER_MS)
      return
    }
    if (seat !== null) return end()
    const passed =
      error && error !== step.current.since ? MOVE_ON[error.code] : undefined
    if (passed) return moveOn(passed)
    if (status !== 'open') return end()
  }, [
    tried,
    status,
    table,
    seat,
    error,
    elsewhere,
    matchId,
    sit,
    resync,
    setQuickSit,
  ])
  return { taking, arrived: tried !== null }
}
