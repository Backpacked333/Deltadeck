import type { AtlasStyle } from './atlas'
import type { Grade } from './grading'
import { GRADES } from './grading'
import type { OpponentModel } from './model'

export type LessonId =
  | 'equity'
  | 'options'
  | 'insurance'
  | 'pot-odds'
  | 'variance'
  | 'ranges'
export const LESSON_IDS: LessonId[] = [
  'equity',
  'pot-odds',
  'variance',
  'ranges',
  'options',
  'insurance',
]

export type DecisionRecord = {
  street: 'preflop' | 'flop' | 'turn' | 'river'
  action: 'fold' | 'check' | 'call' | 'raise'
  amount: number
  pot: number
  toCall: number
  grade: Grade
  evLost: number
  accuracy: number
  chosenEV: number
  bestEV: number
  bestLabel: string
  equity: number
  guess?: number
  handClass: string
}
export type HandRecord = {
  id: string
  hand: number
  net: number
  result: string
  guided: boolean
  at?: number
  /** Model expectation at the final decision, net of chips already sunk. */
  expectedNet?: number
  decisions?: DecisionRecord[]
  hero?: string[]
  board?: string[]
  villain?: string[]
  style?: AtlasStyle
  showdown?: boolean
  /**
   * False while the hand is saved but its decisions are still being graded.
   * A reload in that window keeps the result; the grades are simply absent.
   */
  graded?: boolean
}
export type Settings = {
  mode: 'beginner' | 'analyst'
  theme: 'system' | 'light' | 'dark'
  atlasStyle: AtlasStyle
  speed: 'relaxed' | 'normal' | 'fast'
  guessFirst: boolean
  atlasVoice: boolean
  sound: boolean
  /** Sound volume, 0–1. */
  volume: number
  /** Share of the desktop width given to the table; the lab gets the rest. */
  split: number
  hints: boolean
  opponentModel: OpponentModel
}
export type Progress = {
  hands: HandRecord[]
  lessons: LessonId[]
  settings: Settings
  onboarded: boolean
  guidedComplete: boolean
  /**
   * The account this progress belongs to, once a signed-in player's history
   * was merged into it; absent for play before signing in. Kept inside the
   * stored progress, so another tab saving its copy keeps it too.
   */
  owner?: string
  /** When the player last cleared their history (ms); older hands stay gone. */
  historyClearedAt?: number
}

export const DEFAULT_SETTINGS: Settings = {
  mode: 'beginner',
  theme: 'system',
  atlasStyle: 'balanced',
  speed: 'normal',
  guessFirst: true,
  atlasVoice: true,
  sound: false,
  volume: 0.7,
  split: 0.54,
  hints: true,
  opponentModel: 'range',
}
export const emptyProgress = (): Progress => ({
  hands: [],
  lessons: [],
  settings: { ...DEFAULT_SETTINGS },
  onboarded: false,
  guidedComplete: false,
})

export const STORAGE_KEY = 'quantpoker.progress.v2'
/** Fired by the curriculum after it saves, for the account's copy. */
export const LEARNING_SAVED_EVENT = 'qp-learning-saved'
export const LEGACY_KEY = 'quantpoker.progress.v1'
export const HAND_LIMIT = 100

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const oneOf = <T extends string>(value: unknown, options: readonly T[]) =>
  options.includes(value as T) ? (value as T) : undefined
const finite = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value)
const STREETS = ['preflop', 'flop', 'turn', 'river'] as const
const ACTIONS = ['fold', 'check', 'call', 'raise'] as const

function cleanDecision(value: unknown): DecisionRecord | null {
  if (!isObject(value)) return null
  const street = oneOf(value.street, STREETS)
  const action = oneOf(value.action, ACTIONS)
  const grade = oneOf(value.grade, GRADES)
  const numbers = [
    'amount',
    'pot',
    'toCall',
    'evLost',
    'accuracy',
    'chosenEV',
    'bestEV',
    'equity',
  ] as const
  if (!street || !action || !grade || !numbers.every((k) => finite(value[k])))
    return null
  return {
    street,
    action,
    grade,
    amount: value.amount as number,
    pot: value.pot as number,
    toCall: value.toCall as number,
    evLost: value.evLost as number,
    accuracy: value.accuracy as number,
    chosenEV: value.chosenEV as number,
    bestEV: value.bestEV as number,
    equity: value.equity as number,
    bestLabel: typeof value.bestLabel === 'string' ? value.bestLabel : '',
    handClass: typeof value.handClass === 'string' ? value.handClass : '',
    ...(finite(value.guess) ? { guess: value.guess as number } : {}),
  }
}

const strings = (value: unknown) =>
  Array.isArray(value) && value.every((v) => typeof v === 'string')
    ? (value as string[]).slice(0, 7)
    : undefined

function cleanHand(value: unknown): HandRecord | null {
  if (
    !isObject(value) ||
    typeof value.id !== 'string' ||
    !Number.isInteger(value.hand) ||
    !finite(value.net) ||
    typeof value.result !== 'string' ||
    typeof value.guided !== 'boolean'
  )
    return null
  const hand: HandRecord = {
    id: value.id,
    hand: value.hand as number,
    net: value.net as number,
    result: value.result,
    guided: value.guided,
  }
  if (finite(value.at)) hand.at = value.at as number
  if (finite(value.expectedNet)) hand.expectedNet = value.expectedNet as number
  if (Array.isArray(value.decisions))
    hand.decisions = value.decisions
      .map(cleanDecision)
      .filter((d): d is DecisionRecord => d !== null)
  const hero = strings(value.hero),
    board = strings(value.board),
    villain = strings(value.villain)
  if (hero) hand.hero = hero
  if (board) hand.board = board
  if (villain) hand.villain = villain
  const style = oneOf(value.style, ['tight', 'balanced', 'aggressive'] as const)
  if (style) hand.style = style
  if (typeof value.showdown === 'boolean') hand.showdown = value.showdown
  if (typeof value.graded === 'boolean') hand.graded = value.graded
  return hand
}

function cleanSettings(value: unknown): Settings {
  const v = isObject(value) ? value : {}
  const bool = (key: keyof Settings) =>
    typeof v[key] === 'boolean'
      ? (v[key] as boolean)
      : (DEFAULT_SETTINGS[key] as boolean)
  return {
    mode:
      oneOf(v.mode, ['beginner', 'analyst'] as const) ?? DEFAULT_SETTINGS.mode,
    theme:
      oneOf(v.theme, ['system', 'light', 'dark'] as const) ??
      DEFAULT_SETTINGS.theme,
    atlasStyle:
      oneOf(v.atlasStyle, ['tight', 'balanced', 'aggressive'] as const) ??
      DEFAULT_SETTINGS.atlasStyle,
    speed:
      oneOf(v.speed, ['relaxed', 'normal', 'fast'] as const) ??
      DEFAULT_SETTINGS.speed,
    opponentModel:
      oneOf(v.opponentModel, ['range', 'uniform'] as const) ??
      DEFAULT_SETTINGS.opponentModel,
    guessFirst: bool('guessFirst'),
    atlasVoice: bool('atlasVoice'),
    sound: bool('sound'),
    volume:
      typeof v.volume === 'number' && v.volume >= 0 && v.volume <= 1
        ? v.volume
        : DEFAULT_SETTINGS.volume,
    split:
      typeof v.split === 'number' && v.split >= 0.2 && v.split <= 0.8
        ? v.split
        : DEFAULT_SETTINGS.split,
    hints: bool('hints'),
  }
}

/** Validate untrusted data (storage, imports) into a usable Progress. */
export function sanitizeProgress(parsed: unknown): Progress {
  const value = isObject(parsed) ? parsed : {}
  const hands = Array.isArray(value.hands)
    ? value.hands
        .map(cleanHand)
        .filter((h): h is HandRecord => h !== null)
        .slice(-HAND_LIMIT)
    : []
  const lessons = Array.isArray(value.lessons)
    ? [
        ...new Set(
          value.lessons.filter((l): l is LessonId =>
            LESSON_IDS.includes(l as LessonId),
          ),
        ),
      ]
    : []
  return {
    hands,
    lessons,
    settings: cleanSettings(value.settings),
    onboarded: value.onboarded === true,
    guidedComplete: value.guidedComplete === true,
    ...(typeof value.owner === 'string' && /^[\w-]{1,64}$/.test(value.owner)
      ? { owner: value.owner }
      : {}),
    ...(finite(value.historyClearedAt)
      ? { historyClearedAt: value.historyClearedAt as number }
      : {}),
  }
}

/** Storage seam: the account's copy is synced by src/net/sync.ts. */
export interface SyncAdapter {
  load(): Progress
  save(progress: Progress): boolean
}

export const localAdapter: SyncAdapter = {
  load() {
    try {
      const current = localStorage.getItem(STORAGE_KEY)
      if (current !== null) return sanitizeProgress(JSON.parse(current))
      const legacy = localStorage.getItem(LEGACY_KEY)
      if (legacy === null) return emptyProgress()
      // v1 stored only hands and lessons; returning players skip onboarding.
      const migrated = sanitizeProgress(JSON.parse(legacy))
      return {
        ...migrated,
        onboarded: migrated.hands.length > 0,
        guidedComplete: migrated.hands.length > 0,
      }
    } catch {
      return emptyProgress()
    }
  },
  save(progress) {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          version: 2,
          ...progress,
          hands: progress.hands.slice(-HAND_LIMIT),
        }),
      )
      return true
    } catch {
      return false
    }
  },
}

/** Insert a hand, or replace the record with the same id in place. */
export function upsertHand(progress: Progress, record: HandRecord): Progress {
  const index = progress.hands.findIndex((h) => h.id === record.id)
  const hands =
    index === -1
      ? [...progress.hands, record].slice(-HAND_LIMIT)
      : progress.hands.map((h, i) => (i === index ? record : h))
  return { ...progress, hands }
}

export const readProgress = () => localAdapter.load()
export const saveProgress = (progress: Progress) => localAdapter.save(progress)

export const exportProgress = (progress: Progress) =>
  JSON.stringify(
    { version: 2, exportedAt: new Date().toISOString(), ...progress },
    null,
    2,
  )

export function importProgress(text: string): Progress | null {
  try {
    const parsed: unknown = JSON.parse(text)
    if (!isObject(parsed) || !Array.isArray(parsed.hands)) return null
    // An exported file says nothing about which account owns this browser.
    const progress = sanitizeProgress(parsed)
    delete progress.owner
    delete progress.historyClearedAt
    return progress
  } catch {
    return null
  }
}
