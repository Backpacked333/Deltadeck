import {
  ArrowRight,
  ArrowUpRight,
  Lock,
  ScanSearch,
  Target,
} from 'lucide-react'
import type { legalActions } from '../../lib/poker'
import type { Preset } from '../../lib/presets'

export type { Preset }

/**
 * What the bar reads of the hand. The trainer's heads-up Game has all of
 * it; a live six-seat table passes every seat's bet and stack instead, so
 * it needs no two-seat Game.
 */
export type ActionHand = {
  result?: { text: string; net: number }
  bets: readonly number[]
  pot: number
  stacks: readonly number[]
}

const chips = (n: number) => Math.round(n).toLocaleString('en-US')
const signed = (n: number) =>
  `${n < 0 ? '−' : '+'}${Math.abs(n).toFixed(Math.abs(n) < 10 ? 1 : 0)}`
const pct = (n: number) => `${Math.round(n * 100)}%`

export type ActionMath = {
  revealed: boolean
  ready: boolean
  equity?: number
  breakEven: number
  callEV?: number
  raiseEV?: number
  foldProbability?: number
  bestKind?: 'fold' | 'continue' | 'raise'
}
export type GuessProps = {
  show: boolean
  value: number
  locked: { guess: number; actual: number | null } | null
  onChange: (value: number) => void
  onLock: () => void
  onSkip: () => void
}

export function EquityRing({
  equity,
  breakEven,
  revealed,
}: {
  equity?: number
  breakEven: number
  revealed: boolean
}) {
  const r = 15
  const c = 2 * Math.PI * r
  const shown = revealed && equity !== undefined
  const good = shown && equity! >= breakEven
  const tick = (breakEven - 0.25) * 2 * Math.PI
  return (
    <span
      className={`ring ${shown ? (good ? 'ring-good' : 'ring-bad') : 'ring-locked'}`}
      aria-hidden
    >
      <svg viewBox="0 0 40 40" width="40" height="40">
        <circle cx="20" cy="20" r={r} className="ring-track" />
        {shown && (
          <circle
            cx="20"
            cy="20"
            r={r}
            className="ring-fill"
            strokeDasharray={`${c * equity!} ${c}`}
            transform="rotate(-90 20 20)"
          />
        )}
        {breakEven > 0 && (
          <line
            className="ring-tick"
            x1={20 + Math.cos(tick) * 11}
            y1={20 + Math.sin(tick) * 11}
            x2={20 + Math.cos(tick) * 19.5}
            y2={20 + Math.sin(tick) * 19.5}
          />
        )}
      </svg>
      <span className="ring-label">
        {shown ? pct(equity!) : <Lock size={11} />}
      </span>
    </span>
  )
}

function GuessBar({ guess }: { guess: GuessProps }) {
  if (guess.locked) {
    const { guess: g, actual } = guess.locked
    const error = actual === null ? null : g - actual
    const close = error !== null && Math.abs(error) <= 0.05
    return (
      <div className={`guess-result ${close ? 'close' : ''}`} role="status">
        <Target size={15} />
        <span>
          Your read <b>{pct(g)}</b>
        </span>
        <span className="guess-sep" />
        <span>
          Model <b>{actual === null ? 'scoring…' : pct(actual)}</b>
        </span>
        {error !== null && (
          <em>
            {close
              ? 'Sharp read'
              : `${Math.round(Math.abs(error) * 100)} pts ${error > 0 ? 'high' : 'low'}`}
          </em>
        )}
      </div>
    )
  }
  return (
    <div className="guess-bar" data-tour="guess">
      <div className="guess-head">
        <ScanSearch size={16} />
        <span>
          <strong>Your read first.</strong> Against what Atlas likely holds, how
          often do you win at showdown?
        </span>
      </div>
      <div className="guess-controls">
        <input
          type="range"
          min="0"
          max="100"
          step="1"
          value={Math.round(guess.value * 100)}
          aria-label="Your equity estimate in percent"
          onChange={(e) => guess.onChange(Number(e.target.value) / 100)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') guess.onLock()
          }}
        />
        <output className="guess-value">{pct(guess.value)}</output>
        <button className="btn btn-primary" onClick={guess.onLock}>
          Lock in <kbd>↵</kbd>
        </button>
        <button className="btn btn-quiet" onClick={guess.onSkip}>
          Skip
        </button>
      </div>
    </div>
  )
}

export function ActionBar({
  game,
  legal,
  yourTurn,
  heroTurn,
  paused,
  raiseTo,
  presets,
  math,
  guess,
  shortcuts,
  onRaiseTo,
  onAct,
  onDeal,
  onReview,
  revealing = false,
  versus,
}: {
  game: ActionHand
  legal: ReturnType<typeof legalActions>
  yourTurn: boolean
  /** Hero to act, even while onboarding temporarily blocks input. */
  heroTurn: boolean
  paused: boolean
  raiseTo: number
  presets: Preset[]
  math: ActionMath
  guess: GuessProps
  shortcuts: boolean
  onRaiseTo: (value: number) => void
  onAct: (kind: 'fold' | 'continue' | 'raise') => void
  onDeal: () => void
  onReview: () => void
  /** An all-in runout is still being revealed; hold the result. */
  revealing?: boolean
  /**
   * A table against a real opponent: their name in the status, and the
   * server deals, so a finished hand shows `next` instead of deal buttons.
   * `rated`: nothing to analyse while the hand is live, so no equity ring
   * and no break-even figure (integrity v1, HU AC6).
   */
  versus?: { opponent: string; next: string; rated?: boolean }
}) {
  const result = game.result
  if (result && revealing)
    return (
      <div className="action-bar action-done">
        <div className="action-status" aria-live="polite">
          <span className="status-dot wait" />
          <strong>All-in</strong>
          <span className="muted">
            Both hands are face up. Running out the board…
          </span>
        </div>
      </div>
    )
  if (result)
    return (
      <div className="action-bar action-done">
        <div className="action-status" aria-live="polite">
          <span className={`status-dot ${result.net < 0 ? 'down' : 'up'}`} />
          <strong>{result.text}</strong>
          <span className={result.net >= 0 ? 'positive' : 'negative'}>
            {result.net >= 0 ? '+' : '−'}
            {chips(Math.abs(result.net))} chips
          </span>
        </div>
        <p className="action-caption">
          {versus
            ? versus.next
            : 'One outcome is a data point, not a verdict. Review the decision, not the result.'}
        </p>
        {!versus && (
          <div className="done-buttons">
            <button className="btn btn-outline" onClick={onReview}>
              Review hand
            </button>
            <button className="btn btn-accent btn-lg" onClick={onDeal}>
              {game.stacks.some((s) => s === 0)
                ? 'Refill & deal next hand'
                : 'Deal next hand'}
              {shortcuts ? <kbd>↵</kbd> : <ArrowRight size={16} />}
            </button>
          </div>
        )}
      </div>
    )
  const facing = legal.toCall > 0
  const betting = Math.max(...game.bets) === 0
  const canAct = yourTurn && !paused
  const show = math.revealed && math.ready
  return (
    <div className="action-bar">
      <div className="action-status" aria-live="polite">
        <span className={`status-dot ${canAct ? 'live' : 'wait'}`} />
        <strong>
          {paused
            ? 'Table paused'
            : canAct
              ? 'Your move'
              : `${versus?.opponent ?? 'Atlas'} to act`}
        </strong>
        <span className="muted">
          {canAct
            ? facing
              ? versus?.rated
                ? `${chips(legal.toCall)} to call into ${chips(game.pot)}`
                : `${chips(legal.toCall)} to call into ${chips(game.pot)} · break-even ${pct(math.breakEven)}`
              : 'You can check for free'
            : 'No rush. Think in probabilities.'}
        </span>
      </div>
      {heroTurn && guess.show && <GuessBar guess={guess} />}
      <div className="action-buttons" data-tour="actions">
        <button
          className={`act act-fold ${show && math.bestKind === 'fold' ? 'act-best' : ''}`}
          disabled={!canAct}
          onClick={() => onAct('fold')}
        >
          <span className="act-main">Fold {shortcuts && <kbd>F</kbd>}</span>
          <span className="act-sub">{show ? 'EV 0' : 'Step away'}</span>
        </button>
        <button
          className={`act act-call ${show && math.bestKind === 'continue' ? 'act-best' : ''}`}
          disabled={!canAct}
          onClick={() => onAct('continue')}
        >
          {!versus?.rated && (
            <EquityRing
              equity={math.equity}
              breakEven={facing ? math.breakEven : 0}
              revealed={show}
            />
          )}
          <span className="act-text">
            <span className="act-main">
              {facing ? `Call ${chips(legal.toCall)}` : 'Check'}{' '}
              {shortcuts && <kbd>C</kbd>}
            </span>
            <span className="act-sub">
              {show && math.callEV !== undefined
                ? `${signed(math.callEV)} EV`
                : facing
                  ? 'Stay in the hand'
                  : 'Keep options open'}
            </span>
          </span>
        </button>
        <button
          className={`act act-raise ${show && math.bestKind === 'raise' ? 'act-best' : ''}`}
          disabled={!canAct || !legal.canRaise}
          onClick={() => onAct('raise')}
        >
          <span className="act-main">
            {betting ? 'Bet' : 'Raise to'} {chips(raiseTo)}
            {shortcuts ? <kbd>R</kbd> : <ArrowUpRight size={15} />}
          </span>
          <span className="act-sub">
            {show && math.raiseEV !== undefined
              ? `${signed(math.raiseEV)} EV · Atlas folds ~${pct(math.foldProbability ?? 0)}`
              : raiseTo === legal.maxRaiseTo
                ? 'All-in for the effective stack'
                : 'Put your conviction to work'}
          </span>
        </button>
      </div>
      <div className="sizing">
        <label htmlFor="raise-size">{betting ? 'Bet' : 'Raise'} size</label>
        <input
          id="raise-size"
          type="range"
          min={legal.minRaiseTo}
          max={Math.max(legal.minRaiseTo, legal.maxRaiseTo)}
          step="1"
          value={raiseTo}
          disabled={!canAct || !legal.canRaise}
          onChange={(e) => onRaiseTo(Number(e.target.value))}
        />
        <div className="presets">
          {presets.map((preset) => (
            <button
              key={preset.label}
              className={preset.to === raiseTo ? 'on' : ''}
              disabled={!canAct || !legal.canRaise}
              onClick={() => onRaiseTo(preset.to)}
              title={shortcuts ? `Shortcut ${preset.key}` : undefined}
            >
              <span>{preset.label}</span>
              {show && preset.ev !== undefined && (
                <em className={preset.ev >= 0 ? 'positive' : 'negative'}>
                  {signed(preset.ev)}
                </em>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
