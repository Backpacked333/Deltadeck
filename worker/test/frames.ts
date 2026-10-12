// What each frame type may carry on the wire, shared by the tests that
// check frames (leaks, rated-leak, rating, rematch, lobby, six) and by
// frames.test.ts, which checks that every type is covered. The compiler
// checks every list against src/shared/protocol.ts: a field added to a
// frame without a line here fails `npm run typecheck:worker`, so no field
// reaches a client unreviewed.
import { expect } from 'vitest'
import {
  GAME_CODE_RE,
  GAME_ID_RE,
  REQUEST_ID_RE,
} from '../../src/shared/gameCode'
import type {
  ErrorCode,
  GameRow,
  HandRecordV1,
  InviteRequest,
  LobbyMsg,
  MatchKind,
  ServerMsg,
  TableRow,
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
  'upgrade_required',
  'rating_unavailable',
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
  // A sit_in refused: no chips to be dealt in with (rebuy first).
  'no_chips',
  // The lobby, to a quick-sit: no table for this account, and none opens.
  'tables_full',
])
/**
 * Codes only a six table sends, answering sit, stand, rebuy and sit_in,
 * which a heads-up table refuses as `illegal`. checkFrame refuses them in a
 * heads-up flow, so heads-up error frames keep the codes they had.
 */
const SIX_ERROR_CODES: ErrorCode[] = [
  'seat_taken',
  'table_full',
  'sit_cooldown',
  'not_seated',
  'in_hand',
  'not_below',
  'no_chips',
]
/** Codes only the lobby sends: checkFrame refuses them from any table. */
const LOBBY_ERROR_CODES: ErrorCode[] = ['tables_full']

// Exactly the keys each frame type may carry (optional ones marked '?').
export const FRAME_KEYS: Record<ServerMsg['t'], string[]> = {
  command_outcome: keysOf<Msg<'command_outcome'>>()([
    't',
    'v',
    'commandId',
    'disposition',
    'effect',
    'stateVersion',
    'reason',
    'scope',
    'seq',
    'matchId',
  ]),
  cancel_start_result: keysOf<Msg<'cancel_start_result'>>()([
    't',
    'commandId',
    'status',
    'stateVersion',
    'seq',
    'matchId',
  ]),
  welcome: keysOf<Msg<'welcome'>>()([
    't',
    'seq',
    'matchId',
    'serverNow',
    'seat',
    'table',
    'view',
    'ownControl?',
    'completion?',
    'start?',
    'presentation?',
  ]),
  state: keysOf<Msg<'state'>>()([
    't',
    'seq',
    'matchId',
    'serverNow',
    'table',
    'view',
    'ownControl?',
    'completion?',
    'start?',
    'presentation?',
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
    'completion?',
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
  // The host's prompt at an invite table (ADR amendment 2026-10-12, "Live
  // games"): its own code, and who asked as a name and an age. Never an
  // account (INVITE_REQUEST_KEYS), never part of a view or a table.
  invite: keysOf<Msg<'invite'>>()([
    't',
    'seq',
    'matchId',
    'code',
    'listed',
    'requests',
    'reservedFor',
  ]),
}
// The lobby socket's frames: presence goes to everyone online and the rest
// to one socket. They carry counts, a table id and the player's own match,
// never another account. `tables` lists six tables (TABLE_ROW_KEYS each).
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
  sit_at: keysOf<Lobby<'sit_at'>>()(['t', 'seq', 'tableId']),
  tables: keysOf<Lobby<'tables'>>()(['t', 'seq', 'tables']),
  // The open games: a list handle, a name and an age per row, nothing that
  // seats (GAME_ROW_KEYS). `join_status` says how a request or a code went.
  games: keysOf<Lobby<'games'>>()(['t', 'seq', 'games']),
  join_status: keysOf<Lobby<'join_status'>>()([
    't',
    'seq',
    'state',
    'expiresInMs?',
  ]),
}
// An open game as the list shows it: the handle that can only ask the host,
// the host's public name and how long it has waited. No table id, no code,
// no account.
export const GAME_ROW_KEYS = keysOf<GameRow>()(['gameId', 'host', 'openForMs'])
// One join request in the host's prompt: an id the host answers with, a name
// and an age. The requester's account never reaches a frame.
export const INVITE_REQUEST_KEYS = keysOf<InviteRequest>()([
  'id',
  'username',
  'ageMs',
])
const UUID_ANYWHERE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/

// A listed six table: its id and four counts (ADR, clarifications from
// PR-23 and PR-24). No account, and not the lobby's updatedAt.
export const TABLE_ROW_KEYS = keysOf<TableRow>()([
  'tableId',
  'seated',
  'maxSeats',
  'avgPot',
  'playersPerHour',
])
/** Table ids are the lobby's crypto.randomUUID(): never a name. */
const TABLE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const isCount = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0
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
// Six-casual adds each seat's stack outside the hand being played (as of
// its deal while dealt in, as the last hand left it otherwise: public at
// the hand's end) and whether it is playing or sitting out (six-only,
// RULES). Any table: the player's own picture (a path in the public avatars
// bucket, named by the account id players already shows anyone) and their
// verified school's domain, each left out when there is none.
export const TABLE_PLAYER_KEYS = keysOf<View['match']['players'][number]>()([
  'seat',
  'username',
  'avatar?',
  'school?',
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
const FORBIDDEN_KEYS =
  /^(deck|secret|holes|holesByUser|salts?Secret|terminalProof|completedHands|timeoutEvidence|absences|interruptedArchive|archiveDigest|recordDigest)$/
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
export const forbiddenKeys = (value: unknown) => [
  ...keysMatching(FORBIDDEN_KEYS, value),
  ...invalidHandKeys(value),
]

function invalidHandKeys(value: unknown, path = ''): string[] {
  if (Array.isArray(value))
    return value.flatMap((v, i) => invalidHandKeys(v, `${path}[${i}]`))
  if (!value || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([k, v]) => [
    ...(k === 'hand' &&
    v !== null &&
    (!v ||
      typeof v !== 'object' ||
      Object.keys(v).sort().join() !== 'handNo,matchId,tableId')
      ? [`${path}.hand`]
      : []),
    ...invalidHandKeys(v, `${path}.${k}`),
  ])
}

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
    if (f.ownControl) {
      expectKeys(
        f.ownControl,
        [
          'scope',
          'stateVersion',
          'pendingIntent',
          'standing',
          'commandOutcomes',
        ],
        `${f.t}.ownControl`,
      )
      if (f.ownControl.scope)
        expectKeys(
          f.ownControl.scope,
          [
            'tableId',
            'activationId',
            'membershipGeneration',
            'seat',
            'seatGeneration',
          ],
          'scope',
        )
      if (f.ownControl.pendingIntent)
        expectKeys(
          f.ownControl.pendingIntent,
          ['commandId', 'kind', 'acceptedAtVersion', 'appliesAfter'],
          'pendingIntent',
        )
      for (const o of f.ownControl.commandOutcomes)
        expectKeys(
          o,
          [
            't',
            'v',
            'commandId',
            'disposition',
            'effect',
            'stateVersion',
            'reason',
            'scope',
          ],
          'commandOutcome',
        )
    }
    if (f.presentation) {
      expectKeys(
        f.presentation,
        ['completion', 'currentDecision', 'serverNow'],
        'presentation',
      )
      if (f.presentation.currentDecision)
        expectKeys(
          f.presentation.currentDecision,
          ['decision', 'stateVersion', 'startedAt', 'deadlineAt'],
          'currentDecision',
        )
    }
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
    expect(
      LOBBY_ERROR_CODES,
      `error.code ${f.code} from a table`,
    ).not.toContain(f.code)
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
  if (f.t === 'invite') {
    // The host's own code (or none), and requests by id, name and age.
    expect(f.code === null || GAME_CODE_RE.test(f.code), 'invite.code').toBe(
      true,
    )
    expect(typeof f.listed, 'invite.listed').toBe('boolean')
    expect(f.reservedFor === null || typeof f.reservedFor === 'string').toBe(
      true,
    )
    for (const r of f.requests) {
      expectKeys(r, INVITE_REQUEST_KEYS, 'invite.requests')
      expect(r.id, 'invite request id').toMatch(REQUEST_ID_RE)
      expect(Number.isSafeInteger(r.ageMs) && r.ageMs >= 0, 'ageMs').toBe(true)
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
  if (f.t === 'sit_at') expect(f.tableId, 'sit_at.tableId').toMatch(TABLE_ID)
  // Each row by its keys and by value: an id, then counts. A name where a
  // count or the id goes would fail here even under an allowed key.
  if (f.t === 'tables')
    for (const row of f.tables) {
      expectKeys(row, TABLE_ROW_KEYS, 'lobby tables row')
      expect(row.tableId, 'tables row tableId').toMatch(TABLE_ID)
      for (const key of ['seated', 'maxSeats', 'playersPerHour'] as const)
        expect(isCount(row[key]), `tables row ${key}`).toBe(true)
      expect(
        row.avgPot === null || isCount(row.avgPot),
        'tables row avgPot',
      ).toBe(true)
    }
  if (f.t === 'games')
    for (const row of f.games) {
      expectKeys(row, GAME_ROW_KEYS, 'lobby games row')
      expect(row.gameId, 'games row gameId').toMatch(GAME_ID_RE)
      expect(typeof row.host, 'games row host').toBe('string')
      expect(isCount(row.openForMs), 'games row openForMs').toBe(true)
    }
  // The list names nothing that seats: no table id, no code, no account,
  // under whatever key.
  if (f.t === 'games' || f.t === 'join_status') {
    const text = JSON.stringify(f)
    expect(text, `lobby ${f.t}: a table id`).not.toMatch(UUID_ANYWHERE)
    expect(
      keysMatching(/^(matchId|code|userId|hostId)$/, f),
      `lobby ${f.t}: seating keys`,
    ).toEqual([])
  }
  if (f.t === 'join_status') {
    expect(
      ['pending', 'declined', 'unavailable'],
      'join_status.state',
    ).toContain(f.state)
    // A time left goes with a pending request, and with nothing else.
    expect('expiresInMs' in f, 'join_status.expiresInMs').toBe(
      f.state === 'pending',
    )
  }
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
  cancelStart: ['welcome', 'state', 'match_end', 'cancel_start_result'],
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
  stand: [
    'welcome',
    'state',
    'hand_start',
    'hand_end',
    'reveal',
    'error',
    'command_outcome',
  ],
  /**
   * six.test.ts: rebuys refused (no seat, in the hand, not below 100 bb)
   * and granted between hands, seen by a socket without a seat too.
   */
  rebuy: [
    'welcome',
    'state',
    'hand_start',
    'hand_end',
    'reveal',
    'error',
    'command_outcome',
  ],
  /**
   * six-sitout.test.ts: sit_out and sit_in refused without a seat, a
   * sit_out during a hand, a bust and its no_chips sit_in, and a sit_in
   * that deals at a waiting table, seen by a socket without a seat too.
   */
  sitOut: [
    'welcome',
    'state',
    'hand_start',
    'hand_end',
    'reveal',
    'error',
    'command_outcome',
  ],
  /**
   * six-reconnect.test.ts: a player dealt into a hand, one seated but not
   * dealt in and a socket without a seat drop during it and come back
   * after the grace, and the hand plays out.
   */
  reconnect: ['welcome', 'state', 'hand_start', 'hand_end', 'reveal'],
  /**
   * games.test.ts: the host of an invite table, from the waiting room
   * through a request, an accept and the guest's arrival to the first deal.
   */
  invite: ['welcome', 'invite', 'state', 'hand_start'],
} satisfies Record<string, ServerMsg['t'][]>
