import { ArrowRight, Keyboard } from 'lucide-react'
import type { ReactNode } from 'react'
import { STYLES } from '../lib/atlas'
import type { AtlasStyle } from '../lib/atlas'
import type { Settings } from '../lib/storage'
import type { Game } from '../lib/poker'
import { Modal } from './Modal'
import { playSound, setVolume } from '../lib/sound'

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: [T, string][]
  onChange: (value: T) => void
}) {
  return (
    <div className="setting">
      <span className="setting-label">{label}</span>
      <div className="segmented" role="group" aria-label={label}>
        {options.map(([key, text]) => (
          <button
            key={key}
            className={value === key ? 'on' : ''}
            aria-pressed={value === key}
            onClick={() => onChange(key)}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  )
}

function Toggle({
  label,
  hint,
  value,
  onChange,
}: {
  label: string
  hint: string
  value: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <button
      className="setting setting-toggle"
      role="switch"
      aria-checked={value}
      onClick={() => onChange(!value)}
    >
      <span>
        <span className="setting-label">{label}</span>
        <small>{hint}</small>
      </span>
      <span className={`switch ${value ? 'on' : ''}`} aria-hidden />
    </button>
  )
}

const SHORTCUTS: [string, string][] = [
  ['F', 'Fold'],
  ['C', 'Check or call'],
  ['R', 'Bet or raise'],
  ['1–4', 'Size: ½ pot, ¾ pot, pot, all-in'],
  ['↵', 'Lock in your read / deal next hand'],
  ['P', 'Pause or resume'],
  ['?', 'Help'],
]

export function SettingsDialog({
  settings,
  onChange,
  onClose,
  onReplayGuided,
}: {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
  onClose: () => void
  onReplayGuided: () => void
}) {
  return (
    <Modal title="Your table, your pace." onClose={onClose}>
      <div className="settings">
        <Segmented
          label="Atlas plays"
          value={settings.atlasStyle}
          options={(Object.keys(STYLES) as AtlasStyle[]).map((k) => [
            k,
            STYLES[k].label,
          ])}
          onChange={(atlasStyle) => onChange({ atlasStyle })}
        />
        <p className="setting-note">
          {STYLES[settings.atlasStyle].description} Takes effect from the next
          shuffled hand.
        </p>
        <Segmented
          label="Atlas speed"
          value={settings.speed}
          options={[
            ['relaxed', 'Relaxed'],
            ['normal', 'Normal'],
            ['fast', 'Fast'],
          ]}
          onChange={(speed) => onChange({ speed })}
        />
        <Segmented
          label="Lab detail"
          value={settings.mode}
          options={[
            ['beginner', 'Simple'],
            ['analyst', 'Analyst'],
          ]}
          onChange={(mode) => onChange({ mode })}
        />
        <Segmented
          label="Theme"
          value={settings.theme}
          options={[
            ['system', 'System'],
            ['light', 'Light'],
            ['dark', 'Dark'],
          ]}
          onChange={(theme) => onChange({ theme })}
        />
        <Toggle
          label="Guess before the lab opens"
          hint="Lock in your equity read each street, then see how close you were."
          value={settings.guessFirst}
          onChange={(guessFirst) => onChange({ guessFirst })}
        />
        <Toggle
          label="Action bubbles"
          hint="Show what Atlas just did beside its seat."
          value={settings.atlasVoice}
          onChange={(atlasVoice) => onChange({ atlasVoice })}
        />
        <Toggle
          label="Gentle sounds"
          hint="Soft cues for cards, chips and results."
          value={settings.sound}
          onChange={(sound) => {
            onChange({ sound })
            if (sound) playSound('chip')
          }}
        />
        {settings.sound && (
          <label className="setting setting-range">
            <span className="setting-label">Volume</span>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={Math.round(settings.volume * 100)}
              onChange={(event) => {
                const volume = Number(event.target.value) / 100
                onChange({ volume })
                setVolume(volume)
              }}
              onPointerUp={() => playSound('chip')}
              onKeyUp={() => playSound('chip')}
            />
            <output>{Math.round(settings.volume * 100)}%</output>
          </label>
        )}
        <Toggle
          label="Learning hints"
          hint="Short tips beneath the table."
          value={settings.hints}
          onChange={(hints) => onChange({ hints })}
        />
        <button className="btn btn-quiet" onClick={onReplayGuided}>
          Replay the three guided hands
        </button>
        <p className="modal-note">
          Signed in, your settings, lessons and hands are saved to your account;
          this browser keeps your last 100 hands. Reloading deals a fresh hand.
        </p>
      </div>
    </Modal>
  )
}

export function HelpDialog({ onClose }: { onClose: () => void }) {
  const steps: [string, string, string][] = [
    [
      '01',
      'Make your read',
      'Before the lab opens, guess how often your hand wins. Calibrated intuition is the skill.',
    ],
    [
      '02',
      'Act at the table',
      'Fold, call or raise against Atlas, a transparent practice bot with a published strategy.',
    ],
    [
      '03',
      'See the mathematics',
      'The lab prices every option using only what you can see and what Atlas’s actions reveal.',
    ],
    [
      '04',
      'Review the decision',
      'After each hand, decisions get chess-style grades. Results are shown separately as variance.',
    ],
  ]
  return (
    <Modal title="Poker is the beginning. Not the point." onClose={onClose}>
      <div className="help">
        <p className="modal-intro">
          Learn to make good decisions when the outcome is uncertain.
        </p>
        {steps.map(([n, title, body]) => (
          <div className="help-step" key={n}>
            <span>{n}</span>
            <div>
              <h3>{title}</h3>
              <p>{body}</p>
            </div>
          </div>
        ))}
        <div className="caveat">
          Heads-up no-limit Hold’em · blinds 10/20 · 2,000 starting chips · no
          rake. Play money only; not financial advice.
        </div>
        <h4>Hand rankings, strongest first</h4>
        <p>
          Straight flush → four of a kind → full house → flush → straight →
          three of a kind → two pair → one pair → high card.
        </p>
        <h4>
          <Keyboard size={14} /> Keyboard
        </h4>
        <div className="shortcut-list">
          {SHORTCUTS.map(([key, text]) => (
            <span key={key}>
              <kbd>{key}</kbd> {text}
            </span>
          ))}
        </div>
        <button className="btn btn-primary" onClick={onClose}>
          Let’s play <ArrowRight size={15} />
        </button>
      </div>
    </Modal>
  )
}

export function HistoryDialog({
  game,
  onClose,
}: {
  game: Game
  onClose: () => void
}) {
  return (
    <Modal title={`Hand #${game.id} · action history`} onClose={onClose}>
      <ol className="history-list">
        {game.log.map((entry, i) => (
          <li key={i}>
            <span>{String(i + 1).padStart(2, '0')}</span>
            {entry}
          </li>
        ))}
      </ol>
      <p className="modal-note">
        Atlas&apos;s reasoning is revealed in the hand review once the hand
        ends.
      </p>
    </Modal>
  )
}

export function WelcomeDialog({
  onChoose,
}: {
  onChoose: (mode: Settings['mode']) => void
}) {
  const option = (mode: Settings['mode'], title: string, body: ReactNode) => (
    <button
      className="welcome-option"
      autoFocus={mode === 'beginner'}
      onClick={() => onChoose(mode)}
    >
      <strong>{title}</strong>
      <span>{body}</span>
      <ArrowRight size={16} />
    </button>
  )
  return (
    <Modal
      title="Play the hand. Understand the odds."
      onClose={() => onChoose('beginner')}
    >
      <div className="welcome">
        <p className="modal-intro">
          QuantPoker is a decision trainer disguised as a poker game. You will
          guess, act, and then see exactly how good the decision was, separate
          from luck.
        </p>
        <ul className="welcome-points">
          <li>
            Play money only. Signed in, your practice is saved to your account.
          </li>
          <li>Three guided hands, then shuffled practice against Atlas.</li>
          <li>
            Every decision graded like a chess engine would, on expected value.
          </li>
        </ul>
        {option(
          'beginner',
          'I’m new to poker',
          'Simple lab, plain language, a short tour.',
        )}
        {option(
          'analyst',
          'I know the rules',
          'Analyst lab with ranges, decision maps and finance lenses.',
        )}
      </div>
    </Modal>
  )
}
