import { useEffect, useMemo, useRef, useState } from 'react'
import { History, Pause, Play, Settings2, Spade } from 'lucide-react'
import { STYLES } from '../../lib/atlas'
import type { AtlasStyle } from '../../lib/atlas'
import { cardKey, evaluate } from '../../lib/poker'
import type { Card, Game } from '../../lib/poker'
import { guidedIntro } from '../../lib/scripted'
import type { GuidedStep } from '../../lib/scripted'
import { score, toId } from '../../lib/sim'
import { faceUpEquity } from '../../lib/showdown'
import type { Runout } from '../../state/runout'
import { AnimatedNumber } from '../AnimatedNumber'
import { ChipPile } from './ChipPile'
import { PlayingCard } from '../PlayingCard'
import type { Bubble } from '../../state/trainer'
import { AtlasAvatar } from './AtlasAvatar'

const chips = (n: number) => Math.round(n).toLocaleString('en-US')

type Spot = 'hero-bet' | 'atlas-bet' | 'pot' | 'hero' | 'atlas'
type Flight = {
  id: number
  from: Spot
  to: Spot
  delay: number
  amount: number
}

/** The five cards that make the best hand, for showdown highlighting. */
function bestFive(cards: Card[]) {
  const target = score(cards.map(toId))
  for (let a = 0; a < cards.length; a++)
    for (let b = a + 1; b < cards.length; b++) {
      const five = cards.filter((_, i) => i !== a && i !== b)
      if (five.length === 5 && score(five.map(toId)) === target)
        return new Set(five.map(cardKey))
    }
  return new Set(cards.map(cardKey))
}

function BetChips({ who, amount }: { who: 'hero' | 'atlas'; amount: number }) {
  if (!amount) return null
  return (
    <div className={`bet-chips bet-${who}`} key={amount}>
      <ChipPile amount={amount} maxStacks={3} />
      <span>{chips(amount)}</span>
    </div>
  )
}

export function Table({
  game,
  style,
  bubble,
  paused,
  yourTurn,
  guidedStep,
  showBubbles,
  onTogglePause,
  onHistory,
  onSettings,
  onSkipGuided,
  runout,
  versus,
  challenge,
}: {
  game: Game
  style: AtlasStyle
  bubble: Bubble | null
  paused: boolean
  yourTurn: boolean
  guidedStep: GuidedStep | null
  showBubbles: boolean
  onTogglePause: () => void
  onHistory: () => void
  onSettings: () => void
  onSkipGuided: () => void
  runout: Runout
  /**
   * A table against a real opponent: their name replaces Atlas, and the
   * practice-only controls (pause, history, settings) are hidden.
   */
  versus?: { opponent: string }
  /**
   * The landing page's challenge hand: Atlas as usual, but without the
   * practice controls, and titled with the hand.
   */
  challenge?: { title: string }
}) {
  const opponent = versus?.opponent ?? 'Atlas'
  const [flights, setFlights] = useState<Flight[]>([])
  const previous = useRef(game)
  const flightId = useRef(0)
  const timers = useRef<number[]>([])
  useEffect(() => () => timers.current.forEach(window.clearTimeout), [])

  useEffect(() => {
    const before = previous.current
    previous.current = game
    if (before === game || before.id !== game.id) return
    const next: Flight[] = []
    const add = (from: Spot, to: Spot, amount: number, delay = 0) =>
      next.push({ id: ++flightId.current, from, to, delay, amount })
    const closed =
      game.board.length > before.board.length ||
      (!!game.result && !before.result)
    if (closed)
      ([0, 1] as const).forEach((p) => {
        const collected = before.bets[p] + game.invested[p] - before.invested[p]
        if (collected > 0)
          add(p === 0 ? 'hero-bet' : 'atlas-bet', 'pot', collected)
      })
    launch(next)
  }, [game])

  // The pot flies to the winner once the result is shown (after any
  // all-in runout has been revealed).
  const settled = !!game.result && !runout.revealing
  const paidOut = useRef<number | null>(null)
  useEffect(() => {
    if (!settled || !game.result || paidOut.current === game.id) return
    paidOut.current = game.id
    const { winner } = game.result
    const total = game.invested[0] + game.invested[1]
    const pay = (to: Spot, amount: number): Flight => ({
      id: ++flightId.current,
      from: 'pot',
      to,
      delay: 420,
      amount,
    })
    launch(
      winner === 'tie'
        ? [pay('hero', total / 2), pay('atlas', total / 2)]
        : [pay(winner === 0 ? 'hero' : 'atlas', total)],
    )
  }, [settled, game])

  function launch(next: Flight[]) {
    if (!next.length) return
    setFlights((list) => [...list, ...next])
    const ids = new Set(next.map((f) => f.id))
    timers.current.push(
      window.setTimeout(
        () => setFlights((list) => list.filter((f) => !ids.has(f.id))),
        1300,
      ),
    )
  }

  const result = settled ? game.result : undefined
  const showdown = !!game.result?.showdown
  const visibleBoard = game.board.slice(0, runout.visible)
  // Until a runout finishes, show stacks and pot as they were before payout.
  const potTotal = game.invested[0] + game.invested[1]
  const heroPayout =
    runout.revealing && game.result ? game.result.net + game.invested[0] : 0
  const stacks: [number, number] = runout.revealing
    ? [game.stacks[0] - heroPayout, game.stacks[1] - (potTotal - heroPayout)]
    : game.stacks
  const live = useMemo(
    () =>
      runout.revealing
        ? faceUpEquity(game.cards[0], game.cards[1], visibleBoard)
        : null,
    // visibleBoard is derived from these two.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runout.revealing, runout.visible, game],
  )
  const winning = useMemo(() => {
    if (!result?.showdown || result.winner === 'tie') return null
    return bestFive([...game.cards[result.winner], ...game.board])
  }, [result, game.cards, game.board])
  const handName =
    visibleBoard.length >= 3
      ? evaluate([...game.cards[0], ...visibleBoard]).name
      : game.cards[0][0].rank === game.cards[0][1].rank
        ? 'Pocket pair'
        : `${game.cards[0][0].suit === game.cards[0][1].suit ? 'Suited' : 'Offsuit'} hole cards`
  const atlasName =
    showdown && visibleBoard.length >= 3
      ? evaluate([...game.cards[1], ...visibleBoard]).name
      : null
  const thinking = game.turn === 1 && !game.result && !paused
  const guided = guidedStep ? guidedIntro[guidedStep] : null

  return (
    <section className="table" aria-label="Poker table" data-tour="table">
      <div className="table-top">
        <span className="table-title">
          <span className="live-dot" />
          {versus
            ? 'Live table'
            : challenge
              ? 'Challenge'
              : guided
                ? 'Guided path'
                : 'Practice table'}
          <span className="table-sep">/</span>
          <span className="table-sub">
            {versus
              ? `Heads-up · 10/20 · vs ${opponent}`
              : challenge
                ? challenge.title
                : `Heads-up · 10/20 · Atlas plays ${STYLES[style].label.toLowerCase()}`}
          </span>
        </span>
        {!versus && !challenge && (
          <span className="table-tools">
            <button
              className="icon-btn on-dark"
              onClick={onTogglePause}
              aria-label={paused ? 'Resume table (P)' : 'Pause table (P)'}
              title={paused ? 'Resume (P)' : 'Pause (P)'}
            >
              {paused ? <Play size={15} /> : <Pause size={15} />}
            </button>
            <button
              className="icon-btn on-dark"
              onClick={onHistory}
              aria-label="Hand history"
              title="Hand history"
            >
              <History size={15} />
            </button>
            <button
              className="icon-btn on-dark"
              onClick={onSettings}
              aria-label="Table settings"
              title="Settings"
            >
              <Settings2 size={15} />
            </button>
          </span>
        )}
      </div>
      {guided && (
        <div className="guided-banner">
          <div>
            <strong>{guided.title}</strong>
            <span>{guided.body}</span>
          </div>
          <button onClick={onSkipGuided}>Skip to shuffled hands</button>
        </div>
      )}
      <div className={`stage ${result ? 'stage-done' : ''}`}>
        <div className="felt" aria-hidden>
          <div className="felt-ring" />
          {result && result.winner !== 'tie' && (
            <div
              key={`spot-${game.id}`}
              className={`spotlight spot-${result.winner === 0 ? 'hero' : 'atlas'}`}
            />
          )}
          <span className="felt-mark">
            <Spade size={12} fill="currentColor" /> DELTADECK
          </span>
          <span className="felt-motto">THINK IN PROBABILITIES</span>
        </div>
        <div className="deck-stack" aria-hidden />

        <div
          className={`seat seat-atlas ${thinking ? 'seat-active' : ''} ${result && result.winner === 1 ? 'seat-won' : ''} ${result?.text.startsWith(`${opponent} fold`) ? 'seat-folded' : ''}`}
        >
          <div className="seat-cards">
            {game.cards[1].map((card, i) => (
              <PlayingCard
                key={`${game.id}-a${i}`}
                card={card}
                faceDown={!showdown}
                size="sm"
                deal="atlas"
                delay={80 + i * 160}
                highlight={
                  !!winning?.has(cardKey(card)) && result?.winner === 1
                }
              />
            ))}
          </div>
          <div className="seat-plate">
            {versus ? (
              <span className="avatar avatar-player" aria-hidden>
                {opponent.slice(0, 1).toUpperCase()}
              </span>
            ) : (
              <AtlasAvatar thinking={thinking} />
            )}
            <span className="seat-text">
              <strong>
                {opponent}{' '}
                {!versus && (
                  <em className="seat-badge">{STYLES[style].label}</em>
                )}
              </strong>
              <span>
                <AnimatedNumber value={stacks[1]} /> chips
              </span>
            </span>
            {game.dealer === 1 && <span className="dealer-btn">D</span>}
          </div>
          {atlasName && <span className="seat-hand">{atlasName}</span>}
          {(thinking || (bubble && showBubbles)) && (
            <div
              className="bubble"
              key={thinking ? 'thinking' : bubble!.id}
              role="status"
            >
              {thinking ? (
                <span
                  className="thinking-dots"
                  role="img"
                  aria-label={`${opponent} is thinking`}
                >
                  <i />
                  <i />
                  <i />
                </span>
              ) : (
                <>
                  <span className="bubble-full">{bubble!.text}</span>
                  <span className="bubble-short" aria-hidden>
                    {bubble!.text.replace(/^Atlas /, '').replace(/\.$/, '')}
                  </span>
                </>
              )}
            </div>
          )}
        </div>

        <BetChips who="atlas" amount={game.result ? 0 : game.bets[1]} />

        <div className="pot">
          <ChipPile
            maxStacks={3}
            maxPerStack={5}
            amount={
              runout.revealing
                ? potTotal
                : result
                  ? 0
                  : game.pot - game.bets[0] - game.bets[1]
            }
          />
          <span className="pot-label">
            {runout.revealing ? 'All-in' : result ? 'Hand complete' : 'Pot'}
          </span>
          <strong>
            {result || runout.revealing ? (
              chips(potTotal)
            ) : (
              <AnimatedNumber value={game.pot} />
            )}
          </strong>
        </div>

        <div className="board" role="group" aria-label="Community cards">
          {Array.from({ length: 5 }, (_, i) =>
            game.board[i] && i < runout.visible ? (
              <PlayingCard
                key={`${game.id}-b${i}-${cardKey(game.board[i])}`}
                card={game.board[i]}
                deal="board"
                delay={i < 3 ? i * 110 : 0}
                dim={!!winning && !winning.has(cardKey(game.board[i]))}
                highlight={!!winning?.has(cardKey(game.board[i]))}
              />
            ) : (
              <PlayingCard key={`empty-${i}`} empty />
            ),
          )}
        </div>
        <div className="streets" aria-hidden>
          {(['preflop', 'flop', 'turn', 'river'] as const).map((street) => (
            <span key={street} className={game.street === street ? 'on' : ''}>
              {street === 'preflop' ? 'Pre-flop' : street}
            </span>
          ))}
        </div>

        <BetChips who="hero" amount={game.result ? 0 : game.bets[0]} />

        <div
          className={`seat seat-hero ${yourTurn ? 'seat-active' : ''} ${result && result.winner === 0 ? 'seat-won' : ''} ${result?.text.startsWith('You fold') ? 'seat-folded' : ''}`}
        >
          <div className="seat-cards">
            {game.cards[0].map((card, i) => (
              <PlayingCard
                key={`${game.id}-h${i}`}
                card={card}
                size="lg"
                deal="hero"
                delay={i * 160}
                dim={!!winning && result?.winner === 1}
                highlight={
                  !!winning?.has(cardKey(card)) && result?.winner === 0
                }
              />
            ))}
          </div>
          <div className="seat-plate">
            <span className="avatar avatar-hero">You</span>
            <span className="seat-text">
              <strong>
                You {yourTurn && <em className="seat-badge turn">Your turn</em>}
              </strong>
              <span>
                <AnimatedNumber value={stacks[0]} /> chips
              </span>
            </span>
            {game.dealer === 0 && <span className="dealer-btn">D</span>}
          </div>
          <span className="seat-hand">{handName}</span>
          {result && result.net !== 0 && (
            <span
              key={`net-${game.id}`}
              className={`net-pop ${result.net > 0 ? 'up' : 'down'}`}
            >
              {result.net > 0 ? '+' : '−'}
              {chips(Math.abs(result.net))}
            </span>
          )}
        </div>

        {live && (
          <div className="runout" role="status" aria-live="polite">
            <span className="runout-label">Running it out</span>
            <div className="runout-bars">
              <span className="runout-row">
                <b>You</b>
                <span className="runout-track">
                  <i
                    className="hero"
                    style={{ width: `${live.hero * 100}%` }}
                  />
                </span>
                <em>{Math.round(live.hero * 100)}%</em>
              </span>
              <span className="runout-row">
                <b>{opponent}</b>
                <span className="runout-track">
                  <i
                    className="atlas"
                    style={{ width: `${live.atlas * 100}%` }}
                  />
                </span>
                <em>{Math.round(live.atlas * 100)}%</em>
              </span>
            </div>
          </div>
        )}
        {flights.map((flight) => (
          <span
            key={flight.id}
            className={`flight from-${flight.from} to-${flight.to}`}
            style={{ animationDelay: `${flight.delay}ms` }}
            aria-hidden
          >
            <ChipPile amount={flight.amount} maxStacks={2} />
          </span>
        ))}

        {paused && !result && (
          <div className="paused">
            <Pause size={22} />
            <strong>Table paused</strong>
            <span>Take your time with the lab. Atlas will wait.</span>
            <button className="btn btn-accent" onClick={onTogglePause}>
              <Play size={14} /> Resume
            </button>
          </div>
        )}
      </div>
    </section>
  )
}
