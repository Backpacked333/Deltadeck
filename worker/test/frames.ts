// What each frame type may carry on the wire, shared by the tests that
// check frames (leaks, rated-leak, rating, rematch, lobby, six) and by
// frames.test.ts, which checks that every type is covered. The compiler
// checks every list against src/shared/protocol.ts: a field added to a
// frame without a line here fails `npm run typecheck:worker`, so no field
// reaches a client unreviewed.
import { expect } from 'vitest'
import type {
  ErrorCode,
  HandRecordV1,
  LobbyMsg,
  MatchKind,
  ServerMsg,
} from '../../src/shared/protocol'

type Msg<T extends ServerMsg['t']> = Extract<ServerMsg, { t: T }>
type Lobby<T extends LobbyMsg['t']> = Extract<LobbyMsg, { t: T }>
type Name<S> = S extends `${infer K}?` ? K : S

/**
 * `keys` must name every key of T and nothing else ('?' marks a key the
 * frame may omit). A missing key asks for a second argument; an extra one
 * asks for a second argument of type `unknown`. Either way, a type error.
 */
const keysOf =
  <T>() =>
  <const L extends readonly string[]>(
    keys: L,
    ...exact: [Exclude<keyof T, Name<L[number]>>] extends [never]
      ? [Exclude<Name<L[number]>, keyof T>] extends [never]
        ? []
        : [unknown: Exclude<Name<L[number]>, keyof T>]
      : [missing: Exclude<keyof T, Name<L[number]>>]
  ): string[] => {
    void exact
    return [...keys]
  }

/**
 * `list` must name every member of the union U and nothing else, the way
 * keysOf names keys: a missing member is a type error.
 */
const allOf =
  <U extends string>() =>
  <const L extends readonly U[]>(
    list: L,
    ...exact: [Exclude<U, L[number]>] extends [never]
      ? []
      : [missing: Exclude<U, L[number]>]
  ): string[] => {
    void exact
    return [...list]
  }

/**
 * Every error code a frame may carry. An error is a fixed word and a
 * message; a code added to the protocol without a line here fails
 * `npm run typecheck:worker`, and checkFrame refuses a code not listed.
 */
export const ERROR_CODES = allOf<ErrorCode>()([
  'not_your_turn',
  'illegal',
  'stale',
  'rate_limited',
  'too_large',
  'replaced',
  'halted',
  'unauthorized',
  'unverified',
  'seat_taken',
  'table_full',
  'sit_cooldown',
  'not_seated',
  // A rebuy refused: dealt into the hand being played, or not below 100 bb.
  'in_hand',
  'not_below',
])
/**
 * Codes only a six table sends, answering sit, stand and rebuy, which a
 * heads-up table refuses as `illegal`. checkFrame refuses them in a
 * heads-up flow, so heads-up error frames keep the codes they had.
 */
const SIX_ERROR_CODES: ErrorCode[] = [
  'seat_taken',
  'table_full',
  'sit_cooldown',
  'not_seated',
  'in_hand',
  'not_below',
]

// Exactly the keys each frame type may carry (optional ones marked '?').
export const FRAME_KEYS: Record<ServerMsg['t'], string[]> = {
  welcome: keysOf<Msg<'welcome'>>()([
    't',
    'seq',
    'matchId',
    'serverNow',
    'seat',
    'table',
    'view',
  ]),
  state: keysOf<Msg<'state'>>()([
    't',
    'seq',
    'matchId',
    'serverNow',
    'table',
    'view',
  ]),
  // Six-casual adds `seats` (each dealt seat's stack, by seat number) and
  // the blind seats: all public at the deal (six-only, RULES).
  hand_start: keysOf<Msg<'hand_start'>>()([
    't',
    'seq',
    'matchId',
    'handNo',
    'commitment',
    'button',
    'blinds',
    'stacks',
    'seats?',
    'sb?',
    'bb?',
  ]),
  hand_end: keysOf<Msg<'hand_end'>>()([
    't',
    'seq',
    'matchId',
    'handNo',
    'record',
  ]),
  // `own`: this seat's two hole slots, opened for this seat only.
  reveal: keysOf<Msg<'reveal'>>()([
    't',
    'seq',
    'matchId',
    'handNo',
    'leaves',
    'slots',
    'own',
  ]),
  match_end: keysOf<Msg<'match_end'>>()(['t', 'seq', 'matchId', 'result']),
  // A six table's sit_cooldown says how long the account still waits
  // (hands left and an epoch time); no other error carries either key.
  error: keysOf<Msg<'error'>>()([
    't',
    'seq',
    'matchId',
    'code',
    'message',
    'reqId?',
    'handsLeft?',
    'until?',
  ]),
  // After a rated match: public ratings only (RATING_CHANGE_KEYS per seat).
  rating: keysOf<Msg<'rating'>>()(['t', 'seq', 'matchId', 'change']),
  rematch_state: keysOf<Msg<'rematch_state'>>()([
    't',
    'seq',
    'matchId',
    'state',
    'pressed',
    'until?',
    'next?',
  ]),
}
// The lobby socket's frames: presence goes to everyone online and the rest
// to one socket. They carry counts, a table id and the player's own match,
// never another account.
export const LOBBY_FRAME_KEYS: Record<LobbyMsg['t'], string[]> = {
  queued: keysOf<Lobby<'queued'>>()(['t', 'seq', 'position', 'since']),
  matched: keysOf<Lobby<'matched'>>()(['t', 'seq', 'matchId', 'resumed?']),
  presence: keysOf<Lobby<'presence'>>()([
    't',
    'seq',
    'online',
    'queued',
    'rated?',
  ]),
  error: keysOf<Lobby<'error'>>()(['t', 'seq', 'code', 'message']),
}
type Change = Msg<'rating'>['change'][keyof Msg<'rating'>['change']]
export const RATING_CHANGE_KEYS = keysOf<Change>()([
  'before',
  'after',
  'matches',
])
// The public rating and its deviation; volatility and row versions stay in
// the database.
const RATING_BEFORE_KEYS = keysOf<Change['before']>()(['rating', 'rd'])
const RATING_AFTER_KEYS = keysOf<Change['after']>()(['rating', 'rd'])
type View = NonNullable<Msg<'welcome'>['view']>
export const VIEW_KEYS = keysOf<View>()([
  'matchId',
  'handNo',
  'you',
  'button',
  'street',
  'board',
  'commitment',
  'match',
  'pot',
  'toAct',
  'legal',
  'lastRaise',
  'actions',
  'clock',
  'players',
  'lastReqId',
  'result?',
  // Six-casual: the blind seats, public from the deal (six-only, RULES).
  'sb?',
  'bb?',
])
export const VIEW_PLAYER_KEYS = keysOf<View['players'][number]>()([
  'seat',
  'stack',
  'bet',
  'invested',
  'folded',
  'allIn',
  'cards',
  'shown',
])
// A six table has no length: `handsTotal` is heads-up only (RULES).
export const TABLE_KEYS = keysOf<View['match']>()([
  'kind',
  'status',
  'handsTotal?',
  'players',
])
// Six-casual adds each seat's stack as of the last deal and whether it is
// playing or sitting out (six-only, RULES).
export const TABLE_PLAYER_KEYS = keysOf<View['match']['players'][number]>()([
  'seat',
  'username',
  'connected',
  'consecutiveTimeouts',
  'stack?',
  'status?',
])
const HAND_START_SEAT_KEYS = keysOf<
  NonNullable<Msg<'hand_start'>['seats']>[number]
>()(['seat', 'stack'])
/**
 * Per list: keys only a six-casual frame carries (`six`), keys only a
 * heads-up frame carries (`headsUp`), and keys a six frame may leave out
 * (`sixOptional`). checkFrame requires each for its own kind and refuses it
 * for the other, so heads-up frames keep exactly the keys (and bytes) they
 * had before six tables existed.
 */
type KindRules = { six?: string[]; headsUp?: string[]; sixOptional?: string[] }
const RULES = {
  hand_start: { six: ['seats', 'sb', 'bb'] },
  // Always there heads-up, where every seat was dealt in; at a six table an
  // account that sat down during the hand gets its reveal without `own`.
  reveal: { sixOptional: ['own'] },
  table: { headsUp: ['handsTotal'] },
  tablePlayer: { six: ['stack', 'status'] },
  view: { six: ['sb', 'bb'] },
} satisfies Record<string, KindRules>
const forKind = (keys: string[], six: boolean, rules: KindRules = {}) =>
  keys.flatMap((k) => {
    const name = k.replace(/\?$/, '')
    if (rules.six?.includes(name)) return six ? [name] : []
    if (rules.headsUp?.includes(name)) return six ? [] : [name]
    if (rules.sixOptional?.includes(name)) return six ? [`${name}?`] : [k]
    return [k]
  })
// The per-hand luck (equities) stays in the archive and never reaches a
// frame, so the wire record is the archived one without it.
export const RECORD_KEYS = keysOf<Omit<HandRecordV1, 'luck'>>()([
  'v',
  'matchId',
  'handNo',
  'segment',
  'config',
  'seats',
  'commitment',
  'actions',
  'board',
  'shown',
  'awards',
  'netBySeat',
  'showdown',
])
// Rated matches add the luck-adjusted totals and outcomes.
export const RESULT_KEYS = keysOf<Msg<'match_end'>['result']>()([
  'netBySeat',
  'reason',
  'forfeit?',
  'noShow?',
  'abandoned?',
  'adjustedBySeat?',
  'outcomeBySeat?',
])
const SLOT_KEYS = keysOf<Msg<'reveal'>['slots'][number]>()([
  'slot',
  'card',
  'salt',
])
/** Keys that would mean a hidden card or a secret is on the wire. */
const FORBIDDEN_KEYS = /^(deck|secret|holes|holesByUser|salts?Secret|hand)$/
/** Keys that would mean analysis is on the wire (the lab as RTA). */
const ANALYSIS_KEYS =
  /^(equity|equities|ev|evs|evLost|ev_lost|callEV|raiseEV|range|ranges|grade|grades|accuracy|luck|allInAt|bestKind|foldProbability|breakEven)$/i

export function expectKeys(obj: object, allowed: string[], where: string) {
  const keys = Object.keys(obj)
  const required = allowed.filter((k) => !k.endsWith('?'))
  const optional = allowed.map((k) => k.replace(/\?$/, ''))
  expect(
    keys.filter((k) => !optional.includes(k)),
    `${where}: unexpected keys`,
  ).toEqual([])
  expect(
    required.filter((k) => !keys.includes(k)),
    `${where}: missing keys`,
  ).toEqual([])
}

function keysMatching(test: RegExp, value: unknown, path = ''): string[] {
  if (Array.isArray(value))
    return value.flatMap((v, i) => keysMatching(test, v, `${path}[${i}]`))
  if (value && typeof value === 'object')
    return Object.entries(value).flatMap(([k, v]) => [
      ...(test.test(k) ? [`${path}.${k}`] : []),
      ...keysMatching(test, v, `${path}.${k}`),
    ])
  return []
}

/** Paths of keys, at any depth, that name a hidden card or a secret. */
export const forbiddenKeys = (value: unknown) =>
  keysMatching(FORBIDDEN_KEYS, value)

/** Paths of keys, at any depth, that name an analysis value. */
export const analysisKeys = (value: unknown) =>
  keysMatching(ANALYSIS_KEYS, value)

/**
 * Checks one frame against its allowlist. `kind` is the table it came from:
 * heads-up by default, so every heads-up flow refuses six-only keys without
 * saying so, and a six flow must name its kind.
 */
export function checkFrame(f: ServerMsg, kind: MatchKind = 'hu-casual') {
  const six = kind === 'six-casual'
  const rules: KindRules | undefined =
    f.t === 'hand_start' || f.t === 'reveal' ? RULES[f.t] : undefined
  expectKeys(f, forKind(FRAME_KEYS[f.t], six, rules), f.t)
  expect(forbiddenKeys(f), `${f.t}: forbidden keys`).toEqual([])
  if (f.t === 'welcome' || f.t === 'state') {
    expect(f.table.kind === 'six-casual', `${f.t}.table.kind`).toBe(six)
    // Only a six table has sockets without a seat (welcome.seat null).
    if (f.t === 'welcome' && !six) expect(f.seat, 'welcome.seat').not.toBeNull()
    const table = forKind(TABLE_KEYS, six, RULES.table)
    const tablePlayer = forKind(TABLE_PLAYER_KEYS, six, RULES.tablePlayer)
    expectKeys(f.table, table, `${f.t}.table`)
    for (const p of f.table.players)
      expectKeys(p, tablePlayer, `${f.t}.table.players`)
    if (f.view) {
      if (!six) expect(f.view.you, `${f.t}.view.you`).not.toBeNull()
      expectKeys(f.view, forKind(VIEW_KEYS, six, RULES.view), `${f.t}.view`)
      expectKeys(f.view.match, table, `${f.t}.view.match`)
      for (const p of f.view.match.players)
        expectKeys(p, tablePlayer, `${f.t}.view.match.players`)
      for (const p of f.view.players)
        expectKeys(p, VIEW_PLAYER_KEYS, `${f.t}.view.players`)
    }
  }
  if (f.t === 'hand_start')
    for (const s of f.seats ?? [])
      expectKeys(s, HAND_START_SEAT_KEYS, 'hand_start.seats')
  if (f.t === 'error') {
    expect(ERROR_CODES, 'error.code').toContain(f.code)
    if (!six)
      expect(SIX_ERROR_CODES, `error.code ${f.code} heads-up`).not.toContain(
        f.code,
      )
    // Both wait fields on a sit_cooldown, as counts; neither on any other.
    const cooldown = f.code === 'sit_cooldown'
    for (const key of ['handsLeft', 'until'] as const) {
      expect(key in f, `error ${f.code}: ${key}`).toBe(cooldown)
      if (cooldown) expect(Number.isSafeInteger(f[key]), key).toBe(true)
    }
  }
  if (f.t === 'hand_end') expectKeys(f.record, RECORD_KEYS, 'hand_end.record')
  if (f.t === 'match_end') expectKeys(f.result, RESULT_KEYS, 'match_end.result')
  if (f.t === 'reveal') {
    for (const s of f.slots) expectKeys(s, SLOT_KEYS, 'slot')
    for (const s of f.own ?? []) expectKeys(s, SLOT_KEYS, 'own')
  }
  if (f.t === 'rating')
    for (const [seat, change] of Object.entries(f.change)) {
      // Keyed by seat, never by account.
      expect(seat, 'rating.change: key').toMatch(/^[0-5]$/)
      expectKeys(change, RATING_CHANGE_KEYS, 'rating.change')
      expectKeys(change.before, RATING_BEFORE_KEYS, 'rating.change.before')
      expectKeys(change.after, RATING_AFTER_KEYS, 'rating.change.after')
    }
}

export function checkLobbyFrame(f: LobbyMsg) {
  expectKeys(f, LOBBY_FRAME_KEYS[f.t], `lobby ${f.t}`)
  if (f.t === 'error') expect(ERROR_CODES, 'lobby error.code').toContain(f.code)
  expect(forbiddenKeys(f), `lobby ${f.t}: forbidden keys`).toEqual([])
}

/** Runs every frame through checkFrame and returns the types that passed. */
export function checkFrames(frames: ServerMsg[], kind?: MatchKind) {
  const passed = new Set<ServerMsg['t']>()
  for (const f of frames) {
    checkFrame(f, kind)
    passed.add(f.t)
  }
  return passed
}

/**
 * The frame types each flow test runs through checkFrames. Each flow
 * asserts its own entry exactly, as `new Set(FLOW_TYPES.<entry>)`, and
 * frames.test.ts asserts the entries together name every FRAME_KEYS type
 * and that some flow test's source asserts each entry, so a new frame type
 * fails the suite until some flow sends it and checks it. The lists live
 * here, not in a recorder shared across files, because vitest gives each
 * test file its own copy of this module and runs the files in parallel.
 */
export const FLOW_TYPES = {
  /** leaks.test.ts: a casual match with a showdown, a fold and junk. */
  casual: [
    'welcome',
    'state',
    'hand_start',
    'hand_end',
    'reveal',
    'match_end',
    'error',
  ],
  /** rated-leak.test.ts: 40 rated hands, then a look back after the end. */
  ratedMatch: [
    'welcome',
    'state',
    'hand_start',
    'hand_end',
    'reveal',
    'match_end',
    'error',
    'rematch_state',
  ],
  /** rating.test.ts: a completed rated match, its rating and the offer. */
  rating: [
    'welcome',
    'state',
    'hand_start',
    'hand_end',
    'reveal',
    'match_end',
    'rating',
    'rematch_state',
  ],
  /** six.test.ts: six-casual hands at six seats and at seats 0, 2, 5. */
  six: ['welcome', 'state', 'hand_start', 'hand_end', 'reveal'],
  /** six.test.ts: seven accounts sit at one six table, seatless ones too. */
  sit: ['welcome', 'state', 'hand_start', 'error'],
  /**
   * six.test.ts: stands mid-hand and between hands, a re-sit refused for
   * its cooldown, and a stand from a socket without a seat.
   */
  stand: ['welcome', 'state', 'hand_start', 'hand_end', 'reveal', 'error'],
  /**
   * six.test.ts: rebuys refused (no seat, in the hand, not below 100 bb)
   * and granted between hands, seen by a socket without a seat too.
   */
  rebuy: ['welcome', 'state', 'hand_start', 'hand_end', 'reveal', 'error'],
} satisfies Record<string, ServerMsg['t'][]>
