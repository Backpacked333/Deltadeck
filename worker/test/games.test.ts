/// <reference types="vite/client" />
// Live games (ADR amendment 2026-10-12, "Live games"): an invite table has a
// code, may be listed, and lets a stranger ask its host for the other seat.
// What these tests hold to: no frame of the list ever names a table, a code
// or an account; a code is a seat capability, so guesses are limited and
// every miss looks the same; the table's join() is the only place seat 1 is
// decided, and an Accept only holds it; and nothing here sits on a move.
import {
  abortAllDurableObjects,
  env,
  runInDurableObject,
  SELF,
} from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GAME_CODE_ALPHABET,
  GAME_CODE_LENGTH,
  GAME_CODE_RE,
  GAME_ID_RE,
  normaliseCode,
  REQUEST_ID_RE,
} from '../../src/shared/gameCode'
import type { LobbyMsg, ServerMsg } from '../../src/shared/protocol'
import { forgetUsernames } from '../src/auth'
import { CUTOFF, newGameCode, newGameId, newRequestId } from '../src/gamecode'
import {
  DECLINED_MAX,
  GAME_PRUNE_MS,
  GAME_STALE_MS,
  GAMES_CACHE_MS,
  GAMES_MAX,
  INIT_GRACE_MS,
  OPEN_HEARTBEAT_MS,
  REQUEST_TTL_MS,
  REQUESTS_PER_GAME,
  RESERVE_MS,
} from '../src/games'
import type { OpenGame } from '../src/games'
import {
  CODE_FAILS,
  CODE_FAILS_GLOBAL,
  GAME_LISTS,
  JOIN_REQUESTS,
} from '../src/limits'
import { LobbyDO, lobbyStub } from '../src/lobby'
import worker from '../src/index'
import { regionHint } from '../src/region'
import { TableDO } from '../src/table'
import type { InitBody } from '../src/table'
import { checkFrames, checkLobbyFrame, FLOW_TYPES } from './frames'
import {
  connect,
  createTable,
  elapse,
  eventually,
  isState,
  lobby,
  ORIGIN,
  peek,
  setClock,
  setLobbyClock,
  sitDown,
  sixTable,
  storageOf,
  stub,
  token,
  tryConnect,
} from './helpers'
import type { Client, LobbyClient } from './helpers'

afterEach(() => vi.restoreAllMocks())

/** The Worker's own sources, for the hot-path guard. */
const workerSources = import.meta.glob<string>('../src/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
})

// ---- Helpers -------------------------------------------------------------------

/** POST /api/matches as `user`, with a JSON `body` (none by default). */
const post = (user: string, body?: string) =>
  SELF.fetch(`${ORIGIN}/api/matches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token(user)}`,
      'Content-Type': 'application/json',
    },
    body,
  })

/** What the lobby stores, by key prefix. */
const lobbyRows = (prefix: string) =>
  runInDurableObject(lobbyStub(env), async (_: LobbyDO, state) =>
    Object.fromEntries(await state.storage.list({ prefix })),
  )

const openRow = (matchId: string) =>
  runInDurableObject(lobbyStub(env), (_: LobbyDO, state) =>
    state.storage.get<OpenGame>(`open:${matchId}`),
  )

/** Waits for every call the table has queued for the lobby to land. */
const settled = (matchId: string) =>
  runInDurableObject(stub(matchId), async (instance: TableDO) => {
    const table = instance as unknown as { listingCalls?: Promise<unknown> }
    for (let last; last !== table.listingCalls; ) {
      last = table.listingCalls
      await last
    }
  })

/** The table's clock now. */
const clockOf = (matchId: string) =>
  runInDurableObject(stub(matchId), (instance: TableDO) =>
    instance.clock(),
  ) as Promise<number>

/** Stops the table's clock where it is; `elapse` and `setClock` move it. */
async function pin(matchId: string) {
  const at = await clockOf(matchId)
  await setClock(matchId, at)
  return at
}

/** The lobby forgets the list it read, so the next `games` reads afresh. */
const forgetList = () =>
  runInDurableObject(lobbyStub(env), (instance: LobbyDO) => {
    const inside = instance as unknown as {
      snapshot: unknown
      generation: number
    }
    inside.snapshot = null
    inside.generation++
  })

/** The lobby's next codes, then real ones. */
const forceCodes = (...codes: string[]) =>
  runInDurableObject(lobbyStub(env), (instance: LobbyDO) => {
    const queue = [...codes]
    instance.newCode = () => queue.shift() ?? newGameCode()
  })

/** Every line the console gets while a test runs. */
function watchConsole() {
  const lines: string[] = []
  const take = (...args: unknown[]) =>
    void lines.push(args.map(String).join(' '))
  vi.spyOn(console, 'log').mockImplementation(take)
  vi.spyOn(console, 'error').mockImplementation(take)
  vi.spyOn(console, 'warn').mockImplementation(take)
  return lines
}

type Game = {
  matchId: string
  code: string
  gameId: string
  host: Client
  name: string
}

/**
 * `name` makes a game and sits in its waiting room: the table has told the
 * lobby the host is here.
 */
async function openGame(name: string, listed = true): Promise<Game> {
  const made = await post(name, JSON.stringify({ listed }))
  expect(made.status).toBe(201)
  const { matchId, code } = (await made.json()) as {
    matchId: string
    code: string
  }
  const host = await connect(matchId, name)
  await host.next((f) => f.t === 'invite')
  await settled(matchId)
  return { matchId, code, gameId: (await openRow(matchId))!.gameId, host, name }
}

async function lobbyOf(user: string) {
  const client = await lobby(user)
  await client.next((f) => f.t === 'presence')
  return client
}

/** `client` asks for the list; the games it gets back. */
async function listGames(client: LobbyClient) {
  const from = client.frames.length
  client.send({ t: 'games' })
  const frame = await client.next((f) => f.t === 'games', from)
  if (frame.t !== 'games') throw new Error('no games frame')
  return frame.games
}

/** The frame that answers the next message, minus its sequence number. */
async function answer(
  client: LobbyClient,
  send: () => void,
  test: (f: LobbyMsg) => boolean = (f) =>
    f.t === 'join_status' || f.t === 'matched' || f.t === 'error',
) {
  const from = client.frames.length
  send()
  const frame = await client.next(test, from)
  return { ...frame, seq: 0 } as LobbyMsg
}

const joinCode = (client: LobbyClient, code: string) =>
  answer(client, () => client.send({ t: 'join_code', code }))

const inviteOf = (f: ServerMsg) => {
  if (f.t !== 'invite') throw new Error(`not an invite: ${f.t}`)
  return f
}

/** The host's latest prompt. */
const promptOf = (host: Client) =>
  inviteOf(host.frames.filter((f) => f.t === 'invite').at(-1)!)

/** `user` asks the host of `game` for the seat; their lobby socket. */
async function ask(user: string, game: Pick<Game, 'gameId'>) {
  const client = await lobbyOf(user)
  client.send({ t: 'join_request', gameId: game.gameId })
  return client
}

/** The prompt once it names `n` requests. */
async function promptWith(host: Client, n: number, from = 0) {
  return inviteOf(
    await host.next((f) => f.t === 'invite' && f.requests.length === n, from),
  )
}

const closedWithin = async (client: Client) => {
  await eventually(async () => client.closed !== null)
  return client.closed
}

/** Waits until the table has no socket open (a closed one is noticed late). */
const noSockets = (matchId: string) =>
  eventually(() =>
    runInDurableObject(
      stub(matchId),
      async (_: TableDO, state) => state.getWebSockets().length === 0,
    ),
  )

// ---- Codes -----------------------------------------------------------------------

describe('game codes', () => {
  it('draw from 31 symbols with no lookalikes, and 248 of 256 bytes are used', () => {
    expect(GAME_CODE_ALPHABET).toHaveLength(31)
    expect(new Set(GAME_CODE_ALPHABET).size).toBe(31)
    for (const c of '01ILO') expect(GAME_CODE_ALPHABET).not.toContain(c)
    // The cut-off is derived from the alphabet and leaves whole multiples.
    expect(CUTOFF % GAME_CODE_ALPHABET.length).toBe(0)
    expect(CUTOFF).toBe(248)
  })

  /** A byte source that gives `byte` every time. */
  const only = (byte: number) => (bytes: Uint8Array) => bytes.fill(byte)

  it('give every symbol the same number of bytes, and throw away the rest', () => {
    // One byte value each: its symbol is byte % 31, so the 248 usable bytes
    // reach every symbol exactly 8 times; a modulo of all 256 would give the
    // first 8 symbols a ninth.
    const reached = new Map<string, number>()
    for (let byte = 0; byte < CUTOFF; byte++) {
      const code = newGameCode(only(byte))
      expect(code).toBe(GAME_CODE_ALPHABET[byte % 31].repeat(GAME_CODE_LENGTH))
      reached.set(code[0], (reached.get(code[0]) ?? 0) + 1)
    }
    expect([...reached.values()]).toEqual(Array(31).fill(8))
    // The bytes from the cut-off up are never used; a source that gives only
    // those is refused, not looped on or wrapped round.
    for (let byte = CUTOFF; byte < 256; byte++)
      expect(() => newGameCode(only(byte))).toThrow()
  })

  it('skip bytes at or above the cut-off inside a batch and never index past the alphabet', () => {
    let batches = 0
    const mixed = (bytes: Uint8Array) => {
      batches++
      // Alternating: unusable, then usable (byte 1 gives the symbol 3).
      for (let i = 0; i < bytes.length; i++) bytes[i] = i % 2 ? 1 : 255
      return bytes
    }
    expect(newGameCode(mixed)).toBe('3'.repeat(GAME_CODE_LENGTH))
    expect(batches).toBe(1)
    for (let i = 0; i < 2000; i++) expect(newGameCode()).toMatch(GAME_CODE_RE)
  })

  it('and the handles are hex of the right length, apart from any code', () => {
    for (let i = 0; i < 50; i++) {
      expect(newGameId()).toMatch(GAME_ID_RE)
      expect(newRequestId()).toMatch(REQUEST_ID_RE)
    }
    expect(newGameId()).not.toBe(newGameId())
  })

  it('are typed forgivingly and never remapped', () => {
    expect(normaliseCode(' abc-234 ')).toBe('ABC234')
    expect(normaliseCode('ABC230')).toBeNull()
    expect(normaliseCode('ABC-2345')).toBeNull()
    expect(normaliseCode('x'.repeat(17))).toBeNull()
  })

  it('are redrawn when taken, and two creates at once never share one', async () => {
    // Both creates draw the same code first; the second finds it held and
    // draws again.
    await forceCodes('222222', '222222', '333333')
    const [a, b] = await Promise.all([post('dup-a'), post('dup-b')])
    expect(a.status).toBe(201)
    expect(b.status).toBe(201)
    const codes = [
      ((await a.json()) as { code: string }).code,
      ((await b.json()) as { code: string }).code,
    ]
    expect(codes.sort()).toEqual(['222222', '333333'])
    expect(Object.keys(await lobbyRows('code:')).sort()).toEqual([
      'code:222222',
      'code:333333',
    ])
  })

  it('five taken in a row is busy: 503, nothing made, nothing spent', async () => {
    await forceCodes('222222')
    expect((await post('busy-a')).status).toBe(201)
    await forceCodes(...Array(5).fill('222222'))
    const refused = await post('busy-b')
    expect(refused.status).toBe(503)
    expect(await refused.json()).toEqual({ error: 'busy' })
    expect(await lobbyRows('creates:')).toEqual({
      [`creates:${new Date().toISOString().slice(0, 10)}:busy-a`]: 1,
    })
    expect(await lobbyRows('active:')).not.toHaveProperty('active:busy-b')
  })
})

describe('regionHint', () => {
  it('is the default region without a location, and sorts a request by where it is', () => {
    expect(regionHint(undefined)).toBe('enam')
    expect(regionHint(null)).toBe('enam')
    expect(regionHint({})).toBe('enam')
    const at = (continent: string, longitude: string, country = 'XX') => ({
      continent,
      longitude,
      country,
    })
    expect(regionHint(at('NA', '-122.3'))).toBe('wnam')
    expect(regionHint(at('NA', '-157.8'))).toBe('wnam')
    expect(regionHint(at('NA', '-74.0'))).toBe('enam')
    expect(regionHint(at('NA', '-99.1'))).toBe('enam')
    expect(regionHint({ continent: 'NA' })).toBe('enam')
    expect(regionHint(at('SA', '-46.6'))).toBe('sam')
    expect(regionHint(at('EU', '-0.1'))).toBe('weur')
    expect(regionHint(at('EU', '13.4'))).toBe('weur')
    expect(regionHint(at('EU', '21.0'))).toBe('eeur')
    expect(regionHint(at('EU', '37.6', 'RU'))).toBe('eeur')
    expect(regionHint({ continent: 'EU' })).toBe('weur')
    expect(regionHint(at('AS', '139.7', 'JP'))).toBe('apac')
    expect(regionHint(at('AS', '55.3', 'AE'))).toBe('me')
    expect(regionHint(at('OC', '151.2', 'AU'))).toBe('oc')
    expect(regionHint(at('AF', '18.4', 'ZA'))).toBe('afr')
    expect(regionHint(at('AN', '0'))).toBe('enam')
    expect(regionHint({ continent: 'T1' })).toBe('enam')
  })
})

// ---- Making a game ------------------------------------------------------------------

describe('POST /api/matches', () => {
  it('answers the creator with the table, a code and whether it is listed; never the list handle', async () => {
    const made = await post('mk-a', JSON.stringify({ listed: true }))
    expect(made.status).toBe(201)
    const body = (await made.json()) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['code', 'listed', 'matchId'])
    expect(body.matchId).toMatch(/^[0-9a-f-]{36}$/)
    expect(body.code).toMatch(GAME_CODE_RE)
    expect(body.listed).toBe(true)
    // Three ids, none derived from another.
    const row = (await openRow(body.matchId as string))!
    expect(row.gameId).toMatch(GAME_ID_RE)
    expect(JSON.stringify(body)).not.toContain(row.gameId)
    expect(row.gameId).not.toContain((body.matchId as string).replace(/-/g, ''))
    expect(row.code).toBe(body.code)
  })

  it('takes an empty body or `{}` as an unlisted game, and nothing else', async () => {
    for (const body of [undefined, '', '  ', '{}', '{"listed":false}']) {
      const made = await post('mk-b', body)
      expect(made.status, String(body)).toBe(201)
      expect(((await made.json()) as { listed: boolean }).listed).toBe(false)
      await runInDurableObject(lobbyStub(env), (_: LobbyDO, s) =>
        s.storage.delete('active:mk-b'),
      )
    }
    for (const body of [
      '{"listed":"yes"}',
      '{"listed":1}',
      '{"listed":null}',
      '{"listed":true,"extra":1}',
      '{"kind":"six-casual"}',
      '{"code":"ABC234"}',
      '[]',
      'null',
      '"listed"',
      '{"listed":true',
      `{"listed":true,"pad":"${'x'.repeat(400)}"}`,
    ]) {
      const refused = await post('mk-b', body)
      expect(refused.status, body).toBe(400)
      expect(await refused.json()).toEqual({ error: 'bad request' })
    }
    // A refused body made nothing: only the five that were taken did, and a
    // host's new game closes their earlier one, so one row is left.
    expect(Object.keys(await lobbyRows('open:'))).toHaveLength(1)
  })

  it('writes the day, the table, and the game by code and handle in one put', async () => {
    const puts: string[][] = []
    await runInDurableObject(lobbyStub(env), (_: LobbyDO, state) => {
      const put = state.storage.put.bind(state.storage) as (
        ...args: unknown[]
      ) => Promise<void>
      ;(state.storage as unknown as { put: typeof put }).put = (...args) => {
        const first = args[0]
        puts.push(
          typeof first === 'string' ? [first] : Object.keys(first as object),
        )
        return put(...args)
      }
    })
    const made = await post('mk-c', JSON.stringify({ listed: true }))
    const { matchId, code } = (await made.json()) as {
      matchId: string
      code: string
    }
    const gameId = (await openRow(matchId))!.gameId
    const together = puts.filter((keys) => keys.includes(`open:${matchId}`))
    expect(together).toHaveLength(1)
    expect(together[0].sort()).toEqual(
      [
        `active:mk-c`,
        `code:${code}`,
        `creates:${new Date().toISOString().slice(0, 10)}:mk-c`,
        `gameid:${gameId}`,
        `open:${matchId}`,
      ].sort(),
    )
    await abortAllDurableObjects()
  })

  it('makes a listed game only for an account that may; otherwise it is made unlisted, and the answer says so', async () => {
    // Dev accounts are always eligible (auth.test.ts covers the others).
    const listed = await post('el-a', JSON.stringify({ listed: true }))
    expect(((await listed.json()) as { listed: boolean }).listed).toBe(true)
  })

  it('refuses nothing for a full list: past GAMES_MAX stored games a listed game is made unlisted', async () => {
    const t = Date.now()
    const rows = (from: number, to: number) =>
      Object.fromEntries(
        Array.from({ length: to - from }, (_, i) => [
          `open:full-${from + i}`,
          {
            gameId: newGameId(),
            code: newGameCode(),
            hostId: `h${from + i}`,
            hostName: `h${from + i}`,
            listed: true,
            openedAt: t,
            updatedAt: t,
          } satisfies OpenGame,
        ]),
      )
    await runInDurableObject(lobbyStub(env), async (_: LobbyDO, state) => {
      await state.storage.put(rows(0, 100))
      await state.storage.put(rows(100, GAMES_MAX))
    })
    const made = await post('over-a', JSON.stringify({ listed: true }))
    expect(made.status).toBe(201)
    const { matchId, code, listed } = (await made.json()) as {
      matchId: string
      code: string
      listed: boolean
    }
    expect(listed).toBe(false)
    // It still has its code, which works.
    expect(await openRow(matchId)).toMatchObject({ code, listed: false })
    expect(Object.keys(await lobbyRows('code:'))).toContain(`code:${code}`)
  })

  /** A fresh open row; `listed` or not, by `hostId`. */
  const seedRow = (
    hostId: string,
    over: Partial<OpenGame> = {},
    t = Date.now(),
  ): OpenGame => ({
    gameId: newGameId(),
    code: newGameCode(),
    hostId,
    hostName: hostId,
    listed: true,
    openedAt: t,
    updatedAt: t,
    ...over,
  })
  const seed = (rows: Record<string, OpenGame>) =>
    runInDurableObject(lobbyStub(env), async (_: LobbyDO, state) => {
      const entries = Object.entries(rows)
      for (let i = 0; i < entries.length; i += 100)
        await state.storage.put(Object.fromEntries(entries.slice(i, i + 100)))
    })

  it('counts only listed, fresh games against the cap: unlisted and stale rows cannot switch listing off', async () => {
    const t = Date.now()
    const rows: Record<string, OpenGame> = {}
    for (let i = 0; i < GAMES_MAX; i++)
      rows[`open:cheap-${i}`] = seedRow(`c${i}`, { listed: false }, t)
    for (let i = 0; i < GAMES_MAX; i++)
      rows[`open:stale-${i}`] = seedRow(
        `s${i}`,
        { updatedAt: t - GAME_STALE_MS - 1 },
        t,
      )
    await seed(rows)
    const made = await post('cap-a', JSON.stringify({ listed: true }))
    expect(((await made.json()) as { listed: boolean }).listed).toBe(true)
  })

  it('shows a listed game whatever its key sorts as among many rows', async () => {
    const t = Date.now()
    const rows: Record<string, OpenGame> = {}
    for (let i = 0; i < GAMES_MAX + 50; i++)
      rows[`open:a-${String(i).padStart(4, '0')}`] = seedRow(
        `u${i}`,
        { listed: false },
        t,
      )
    // Past the 200th key: a read that cuts at 200 before it filters misses it.
    rows['open:z-last'] = seedRow('real-host', { hostName: 'Real Host' }, t)
    await seed(rows)
    const games = await listGames(await lobbyOf('cap-watcher'))
    expect(games.map((g) => g.host)).toEqual(['Real Host'])
  })

  it("closes a host's earlier waiting game when they make another, with its code and handle", async () => {
    const first = await post('again-a', JSON.stringify({ listed: true }))
    const one = (await first.json()) as { matchId: string; code: string }
    const gameId = (await openRow(one.matchId))!.gameId
    await runInDurableObject(lobbyStub(env), (_: LobbyDO, s) =>
      s.storage.delete('active:again-a'),
    )
    const second = await post('again-a', JSON.stringify({ listed: true }))
    const two = (await second.json()) as { matchId: string; listed: boolean }
    expect(two.listed).toBe(true)
    expect(await openRow(one.matchId)).toBeUndefined()
    expect(await lobbyRows('code:')).not.toHaveProperty(`code:${one.code}`)
    expect(await lobbyRows('gameid:')).not.toHaveProperty(`gameid:${gameId}`)
    expect(Object.keys(await lobbyRows('open:'))).toEqual([
      `open:${two.matchId}`,
    ])
  })

  it('lists one game per host: a second table of the same host is made unlisted, never refused', async () => {
    const t = Date.now()
    await seed({ 'open:mine-a': seedRow('hog', {}, t) })
    // The second table reports itself open (its row was pruned or never made).
    const report = (listed: boolean) => ({
      gameId: newGameId(),
      code: newGameCode(),
      hostId: 'hog',
      hostName: 'hog',
      listed,
    })
    const answer = await runInDurableObject(
      lobbyStub(env),
      async (l: LobbyDO) => l.reportOpen('mine-b', report(true)),
    )
    expect(answer).toEqual({})
    expect(await openRow('mine-b')).toMatchObject({ listed: false })
    // Another host is not held back by it.
    await runInDurableObject(lobbyStub(env), (l: LobbyDO) =>
      l.reportOpen('other-b', { ...report(true), hostId: 'other' }),
    )
    expect(await openRow('other-b')).toMatchObject({ listed: true })
  })

  it('rolls everything back when the table refuses its /init, and keeps it when the call throws', async () => {
    // The answer is made where the table runs: a Response from the test
    // cannot be read from inside the object (workerd's per-object I/O rule).
    vi.spyOn(TableDO.prototype, 'fetch').mockImplementation(async () =>
      Response.json({ error: 'exists' }, { status: 409 }),
    )
    const refused = await post('rb-a', JSON.stringify({ listed: true }))
    expect(refused.status).toBe(500)
    for (const prefix of ['open:', 'code:', 'gameid:', 'active:'])
      expect(await lobbyRows(prefix), prefix).toEqual({})
    // The day's create was given back.
    expect(Object.values(await lobbyRows('creates:'))).toEqual([0])
    vi.restoreAllMocks()

    // The call to the table throws (not a refusal): the Worker is run here
    // with a table namespace that does, since a handler that throws inside
    // an object is also reported by the runtime as an uncaught exception.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken = {
      ...env,
      TABLE: {
        idFromName: (name: string) => env.TABLE.idFromName(name),
        get: () => ({
          fetch: async () => {
            throw new Error('gone')
          },
        }),
      },
    } as unknown as typeof env
    const thrown = await worker.fetch(
      new Request(`${ORIGIN}/api/matches`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token('rb-b')}` },
        body: JSON.stringify({ listed: true }),
      }),
      broken,
      { waitUntil() {}, passThroughOnException() {} } as never,
    )
    expect(thrown.status).toBe(500)
    // It may have been made: the rows stay, and go stale without a heartbeat.
    expect(Object.keys(await lobbyRows('open:'))).toHaveLength(1)
    expect(Object.keys(await lobbyRows('code:'))).toHaveLength(1)
    expect(Object.keys(await lobbyRows('gameid:'))).toHaveLength(1)
  })

  it('takes the code, handle and listing from the Worker only: the table refuses them half given or on another sort of table', async () => {
    const attempts: Partial<InitBody>[] = [
      { code: 'ABC234' },
      { code: 'ABC234', gameId: newGameId() },
      { code: 'abc234', gameId: newGameId(), listed: true },
      { code: 'ABC234', gameId: 'x', listed: true },
      { code: 'ABC234', gameId: newGameId(), listed: 'yes' as never },
      {
        code: 'ABC234',
        gameId: newGameId(),
        listed: true,
        kind: 'hu-rated',
      },
      {
        code: 'ABC234',
        gameId: newGameId(),
        listed: true,
        opponent: { userId: 'b', username: 'b' },
      },
    ]
    for (const extra of attempts) {
      const matchId = crypto.randomUUID()
      const body: InitBody = {
        matchId,
        creator: { userId: 'init-a', username: 'init-a' },
        ...extra,
      }
      const refused = await stub(matchId).fetch('https://table/init', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      expect(refused.status, JSON.stringify(extra)).toBe(400)
      expect(await storageOf(matchId)).toEqual({ keys: [], alarm: null })
    }
  })
})

// ---- The list ------------------------------------------------------------------------

describe('the list of open games', () => {
  it('shows a listed game as a handle, a name and an age; the table, code and account are in no frame', async () => {
    forgetUsernames()
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]
    const names = ['leak-ann', 'leak-ben', 'leak-cat']
    const realFetch = globalThis.fetch
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        )
        if (url.origin !== new URL(env.SUPABASE_URL).origin)
          return realFetch(input, init)
        if (url.pathname === '/rest/v1/players') {
          const id = url.searchParams.get('user_id')!.slice(3)
          return Response.json([{ username: names[ids.indexOf(id)] }])
        }
        return new Response(null, { status: 204 })
      },
    )
    try {
      await setLobbyClock(1_900_000_000_000)
      const game = await openGame(ids[0])
      const watcher = await lobbyOf(ids[1])
      // Longer waiting first: a second game, a moment later.
      await setLobbyClock(1_900_000_005_000)
      const second = await openGame(ids[2])
      await setLobbyClock(1_900_000_009_000)
      const games = await listGames(watcher)
      expect(games).toEqual([
        { gameId: game.gameId, host: 'leak-ann', openForMs: 9000 },
        { gameId: second.gameId, host: 'leak-cat', openForMs: 4000 },
      ])
      for (const f of watcher.frames) checkLobbyFrame(f)
      // Serialised and searched: nothing that seats, nothing that names an
      // account, in any frame the watcher was sent.
      const wire = JSON.stringify(watcher.frames)
      for (const secret of [
        game.matchId,
        game.code,
        second.matchId,
        second.code,
        ids[0],
        ids[2],
      ])
        expect(wire).not.toContain(secret)
      // Only those games' handles are on it.
      expect(wire).toContain(game.gameId)
    } finally {
      vi.unstubAllGlobals()
      forgetUsernames()
    }
  })

  it('leaves out the asker’s own game, after the cache', async () => {
    const mine = await openGame('own-a')
    const other = await openGame('own-b')
    const a = await lobbyOf('own-a')
    const b = await lobbyOf('own-b')
    expect((await listGames(a)).map((g) => g.gameId)).toEqual([other.gameId])
    // Served from the one read, not a second.
    expect((await listGames(b)).map((g) => g.gameId)).toEqual([mine.gameId])
  })

  it('never lists an unlisted game, a rated table, a table made without an invite or a six table', async () => {
    await openGame('hid-a', false)
    // A rated pairing, an invite table made straight at the table, a six table.
    const rated = crypto.randomUUID()
    const body: InitBody = {
      matchId: rated,
      creator: { userId: 'hid-r1', username: 'hid-r1' },
      opponent: { userId: 'hid-r2', username: 'hid-r2' },
      kind: 'hu-rated',
    }
    await stub(rated).fetch('https://table/init', {
      method: 'POST',
      body: JSON.stringify(body),
    })
    const bare = await createTable('hid-b')
    await connect(bare, 'hid-b')
    const six = await sixTable()
    await sitDown(six, 'hid-six')
    const watcher = await lobbyOf('hid-w')
    expect(await listGames(watcher)).toEqual([])
    // Nothing of them is stored either, other than the unlisted game's own.
    expect(Object.keys(await lobbyRows('open:'))).toHaveLength(1)
  })

  it('drops a game once its host has been silent for GAME_STALE_MS, and prunes it after GAME_PRUNE_MS with its code', async () => {
    const t0 = 1_900_000_000_000
    await setLobbyClock(t0)
    const game = await openGame('stale-a')
    const watcher = await lobbyOf('stale-w')
    expect(await listGames(watcher)).toHaveLength(1)
    await setLobbyClock(t0 + GAME_STALE_MS - 1)
    await forgetList()
    expect(await listGames(watcher)).toHaveLength(1)
    await setLobbyClock(t0 + GAME_STALE_MS)
    await forgetList()
    expect(await listGames(watcher)).toEqual([])
    // Its code stops working with it (the same answer as any miss).
    expect(await joinCode(watcher, game.code)).toMatchObject({
      t: 'join_status',
      state: 'unavailable',
    })
    // Still stored: the code is held, so it is not given out again at once.
    expect(await openRow(game.matchId)).toBeDefined()
    await setLobbyClock(t0 + GAME_PRUNE_MS + 1)
    await forgetList()
    expect(await listGames(watcher)).toEqual([])
    expect(await lobbyRows('open:')).toEqual({})
    expect(await lobbyRows('code:')).toEqual({})
    expect(await lobbyRows('gameid:')).toEqual({})
  })

  it('answers 200 sockets that poll together with one read of the games', async () => {
    await setLobbyClock(1_900_000_000_000)
    await openGame('poll-host')
    const count = await runInDurableObject(
      lobbyStub(env),
      (_: LobbyDO, state) => {
        const reads = { n: 0 }
        const list = state.storage.list.bind(state.storage) as (options?: {
          prefix?: string
        }) => Promise<Map<string, unknown>>
        ;(state.storage as unknown as { list: typeof list }).list = (
          options,
        ) => {
          if (options?.prefix === 'open:') reads.n++
          return list(options)
        }
        return reads
      },
    )
    const sockets = await Promise.all(
      Array.from({ length: 200 }, (_, i) => lobbyOf(`poll-${i}`)),
    )
    const from = sockets.map((s) => s.frames.length)
    for (const s of sockets) s.send({ t: 'games' })
    const frames = await Promise.all(
      sockets.map((s, i) => s.next((f) => f.t === 'games', from[i])),
    )
    expect(frames.every((f) => f.t === 'games' && f.games.length === 1)).toBe(
      true,
    )
    // Inside the cache window, a second round is read from the first.
    for (const s of sockets.slice(0, 20)) s.send({ t: 'games' })
    await Promise.all(
      sockets
        .slice(0, 20)
        .map((s, i) => s.next((f) => f.t === 'games', from[i] + 1)),
    )
    // The openGame above ran before the count began; the polls ran one read.
    expect(await runInDurableObject(lobbyStub(env), () => count.n)).toBe(1)
    await abortAllDurableObjects()
  }, 60_000)

  it('is read again after GAMES_CACHE_MS, not before', async () => {
    const t0 = 1_900_000_000_000
    await setLobbyClock(t0)
    const watcher = await lobbyOf('cache-w')
    expect(await listGames(watcher)).toEqual([])
    // A game made inside the window is listed with the next read after it.
    await openGame('cache-host')
    await setLobbyClock(t0 + GAMES_CACHE_MS - 1)
    expect(await listGames(watcher)).toEqual([])
    await setLobbyClock(t0 + GAMES_CACHE_MS)
    expect(await listGames(watcher)).toHaveLength(1)
  })

  it('limits each account’s reads, and answers the rest with rate_limited', async () => {
    await setLobbyClock(1_900_000_000_000)
    const client = await lobbyOf('lim-a')
    const from = client.frames.length
    for (let i = 0; i < GAME_LISTS + 1; i++) client.send({ t: 'games' })
    await client.next((f) => f.t === 'error', from)
    const answers = client.frames.slice(from)
    expect(answers.filter((f) => f.t === 'games')).toHaveLength(GAME_LISTS)
    expect(answers.filter((f) => f.t === 'error')).toEqual([
      expect.objectContaining({ code: 'rate_limited' }),
    ])
    // Another account has its own; a minute on, this one has some again.
    expect(await listGames(await lobbyOf('lim-b'))).toEqual([])
    await setLobbyClock(1_900_000_000_000 + 60_000)
    expect(await listGames(client)).toEqual([])
    for (const f of client.frames) checkLobbyFrame(f)
  })

  it('does not wake the lobby’s other sockets or change presence', async () => {
    const a = await lobbyOf('quiet-a')
    const b = await lobbyOf('quiet-b')
    const before = b.frames.length
    await listGames(a)
    await openGame('quiet-host')
    await listGames(a)
    // Nothing was pushed to b by any of it.
    expect(b.frames.slice(before)).toEqual([])
  })
})

// ---- Liveness: a game is as open as its host is here ---------------------------------

describe('a game is open while its host is here', () => {
  it('beats only while the host is connected, once per OPEN_HEARTBEAT_MS', async () => {
    const opened = vi.spyOn(LobbyDO.prototype, 'reportOpen')
    const made = await post('hb-a', JSON.stringify({ listed: true }))
    const { matchId, code } = (await made.json()) as {
      matchId: string
      code: string
    }
    const t0 = await pin(matchId)
    // Nobody is here: no heartbeat, whatever the clock does.
    await elapse(matchId, OPEN_HEARTBEAT_MS)
    await settled(matchId)
    expect(opened).not.toHaveBeenCalled()
    // The host arrives: the lobby hears at once, and the next beat is due.
    const host = await connect(matchId, 'hb-a')
    await host.next((f) => f.t === 'invite')
    await settled(matchId)
    expect(opened).toHaveBeenCalledTimes(1)
    expect(opened.mock.calls[0]).toEqual([
      matchId,
      {
        gameId: (await openRow(matchId))!.gameId,
        code,
        hostId: 'hb-a',
        hostName: 'hb-a',
        listed: true,
      },
    ])
    const beatAt = (await clockOf(matchId)) + OPEN_HEARTBEAT_MS
    expect((await storageOf(matchId)).alarm).toBe(beatAt)
    // An alarm inside the window beats nothing; one at its end beats once.
    await elapse(matchId, OPEN_HEARTBEAT_MS - 1)
    await settled(matchId)
    expect(opened).toHaveBeenCalledTimes(1)
    await elapse(matchId, 1)
    await settled(matchId)
    expect(opened).toHaveBeenCalledTimes(2)
    // The host leaves: the beats stop, and no alarm is left for them.
    host.ws.close(1000, 'bye')
    await noSockets(matchId)
    await elapse(matchId, 10 * OPEN_HEARTBEAT_MS)
    await settled(matchId)
    expect(opened).toHaveBeenCalledTimes(2)
    expect((await storageOf(matchId)).alarm).toBeGreaterThan(t0 + 3_600_000)
  })

  it('goes stale 90 s after the last beat, and a reconnect brings it back', async () => {
    const t0 = 1_900_000_000_000
    await setLobbyClock(t0)
    const game = await openGame('rev-a')
    const watcher = await lobbyOf('rev-w')
    expect(await listGames(watcher)).toHaveLength(1)
    // The host closes the tab; 90 s on the lobby no longer offers the game.
    game.host.ws.close(1000, 'bye')
    await noSockets(game.matchId)
    await setLobbyClock(t0 + GAME_STALE_MS)
    await forgetList()
    expect(await listGames(watcher)).toEqual([])
    expect(await joinCode(watcher, game.code)).toMatchObject({
      state: 'unavailable',
    })
    // The host is back: listed again, and the code works again.
    const back = await connect(game.matchId, 'rev-a')
    await back.next((f) => f.t === 'invite')
    await settled(game.matchId)
    await forgetList()
    expect(await listGames(watcher)).toHaveLength(1)
    expect(await joinCode(await lobbyOf('rev-w2'), game.code)).toMatchObject({
      t: 'matched',
      matchId: game.matchId,
    })
  })

  it('is made again if the lobby pruned it, with its code if free, and a fresh code (adopted, and sent to the host) if another game took it', async () => {
    const t0 = 1_900_000_000_000
    await setLobbyClock(t0)
    const game = await openGame('prune-a')
    game.host.ws.close(1000, 'bye')
    await noSockets(game.matchId)
    const watcher = await lobbyOf('prune-w')
    await setLobbyClock(t0 + GAME_PRUNE_MS + 1)
    expect(await listGames(watcher)).toEqual([])
    expect(await lobbyRows('open:')).toEqual({})
    // Back with the code free: the same code, a new row.
    const back = await connect(game.matchId, 'prune-a')
    await back.next((f) => f.t === 'invite')
    await settled(game.matchId)
    expect(await openRow(game.matchId)).toMatchObject({ code: game.code })
    expect(await lobbyRows('code:')).toEqual({
      [`code:${game.code}`]: game.matchId,
    })
    // Gone again, and another game takes the code meanwhile.
    back.ws.close(1000, 'bye')
    await noSockets(game.matchId)
    await setLobbyClock(t0 + 2 * GAME_PRUNE_MS + 2)
    await forgetList()
    expect(await listGames(watcher)).toEqual([])
    await forceCodes(game.code)
    const taker = await post('prune-b', JSON.stringify({ listed: true }))
    expect(((await taker.json()) as { code: string }).code).toBe(game.code)
    // The first host returns: its game is given another code, which it shows.
    const again = await connect(game.matchId, 'prune-a')
    const prompt = inviteOf(
      await again.next((f) => f.t === 'invite' && f.code !== game.code),
    )
    await settled(game.matchId)
    expect(prompt.code).toMatch(GAME_CODE_RE)
    expect(prompt.code).not.toBe(game.code)
    expect((await openRow(game.matchId))!.code).toBe(prompt.code)
    // Both codes work, each for its own game.
    const finder = await lobbyOf('prune-f')
    expect(await joinCode(finder, prompt.code!)).toMatchObject({
      matchId: game.matchId,
    })
  })

  it('leaves the list at once when the seat fills, and its code dies with it', async () => {
    await setLobbyClock(1_900_000_000_000)
    const game = await openGame('fill-a')
    const watcher = await lobbyOf('fill-w')
    expect(await listGames(watcher)).toHaveLength(1)
    const guest = await connect(game.matchId, 'fill-b')
    await guest.next((f) => f.t === 'welcome')
    await settled(game.matchId)
    // The same clock, inside the cache window: the fill dropped the cache.
    expect(await listGames(watcher)).toEqual([])
    expect(await lobbyRows('open:')).toEqual({})
    expect(await lobbyRows('code:')).toEqual({})
    expect(await lobbyRows('gameid:')).toEqual({})
    expect(await joinCode(await lobbyOf('fill-c'), game.code)).toMatchObject({
      state: 'unavailable',
    })
  })

  it('a heartbeat that is still on its way when the seat fills lands before the close, and cannot list the game again', async () => {
    const reportOpen = LobbyDO.prototype.reportOpen
    const order: string[] = []
    let letGo: () => void = () => {}
    const held = new Promise<void>((resolve) => (letGo = resolve))
    let hold = false
    vi.spyOn(LobbyDO.prototype, 'reportOpen').mockImplementation(
      async function (this: LobbyDO, ...args: Parameters<typeof reportOpen>) {
        order.push('report sent')
        if (hold) await held
        const answer = await reportOpen.apply(this, args)
        order.push('report landed')
        return answer
      },
    )
    const close = LobbyDO.prototype.closeGame
    vi.spyOn(LobbyDO.prototype, 'closeGame').mockImplementation(async function (
      this: LobbyDO,
      matchId: string,
    ) {
      order.push('close landed')
      return close.call(this, matchId)
    })
    const made = await post('ord-a', JSON.stringify({ listed: true }))
    const { matchId } = (await made.json()) as { matchId: string }
    await pin(matchId)
    const host = await connect(matchId, 'ord-a')
    await host.next((f) => f.t === 'invite')
    await settled(matchId)
    order.length = 0
    // The next beat is slow to land...
    hold = true
    await elapse(matchId, OPEN_HEARTBEAT_MS)
    await eventually(async () => order.includes('report sent'))
    // ...when the guest sits. The table does not wait for the lobby.
    const guest = await connect(matchId, 'ord-b')
    await guest.next(isState(1))
    expect(order).toEqual(['report sent'])
    letGo()
    await settled(matchId)
    expect(order).toEqual(['report sent', 'report landed', 'close landed'])
    expect(await lobbyRows('open:')).toEqual({})
    expect(await lobbyRows('code:')).toEqual({})
  })

  it('removes a game whose table deleted itself, so an invite nobody joined leaves the list', async () => {
    const t0 = 1_900_000_000_000
    await setLobbyClock(t0)
    const game = await openGame('idle-a')
    await pin(game.matchId)
    await elapse(game.matchId, 24 * 3600_000 + 1)
    await settled(game.matchId)
    expect(await storageOf(game.matchId)).toEqual({ keys: [], alarm: null })
    expect(await lobbyRows('open:')).toEqual({})
    expect(await lobbyRows('code:')).toEqual({})
  })
})

// ---- Joining by code ------------------------------------------------------------------

describe('joining by code', () => {
  it('sends the holder of a right code to the table, which seats them', async () => {
    const game = await openGame('code-a')
    const guest = await lobbyOf('code-b')
    const frame = await joinCode(guest, game.code)
    expect(frame).toEqual({
      t: 'matched',
      matchId: game.matchId,
      resumed: false,
      seq: 0,
    })
    // The seat is not taken by the lobby: the table decides, at connect.
    expect(await lobbyRows('active:')).not.toHaveProperty('active:code-b')
    const seat = await connect(game.matchId, 'code-b')
    expect(await seat.next((f) => f.t === 'welcome')).toMatchObject({ seat: 1 })
    await game.host.next(isState(1))
    // Typed forgivingly: lower case, with a hyphen.
    const other = await openGame('code-c')
    const typed =
      `${other.code.slice(0, 3)}-${other.code.slice(3)}`.toLowerCase()
    expect(await joinCode(await lobbyOf('code-d'), typed)).toMatchObject({
      matchId: other.matchId,
    })
  })

  it('answers every code that opens no game with the same frame', async () => {
    const t0 = 1_900_000_000_000
    await setLobbyClock(t0)
    // Stale: its host left, and 90 s have passed.
    const stale = await openGame('miss-stale')
    stale.host.ws.close(1000, 'bye')
    await noSockets(stale.matchId)
    await setLobbyClock(t0 + GAME_STALE_MS)
    // Full: the table filled, and the close was lost on its way.
    vi.spyOn(LobbyDO.prototype, 'closeGame').mockResolvedValue(undefined)
    const full = await openGame('miss-full')
    await (
      await connect(full.matchId, 'miss-guest')
    ).next((f) => f.t === 'welcome')
    // Closed: the table deleted itself, and the close was lost too.
    const closed = await openGame('miss-closed')
    await pin(closed.matchId)
    await elapse(closed.matchId, 24 * 3600_000 + 1)
    await settled(closed.matchId)
    expect(await storageOf(closed.matchId)).toEqual({ keys: [], alarm: null })
    vi.restoreAllMocks()
    // And a game that is open, whose host asks for its own code.
    const own = await openGame('miss-own')
    const misses: [string, string, string][] = [
      ['unknown', '222222', 'miss-1'],
      ['stale', stale.code, 'miss-2'],
      ['full', full.code, 'miss-3'],
      ['closed', closed.code, 'miss-4'],
      ['own', own.code, 'miss-own'],
    ]
    const frames: string[] = []
    for (const [, code, user] of misses)
      frames.push(JSON.stringify(await joinCode(await lobbyOf(user), code)))
    expect(new Set(frames).size, frames.join('\n')).toBe(1)
    expect(JSON.parse(frames[0])).toEqual({
      t: 'join_status',
      state: 'unavailable',
      seq: 0,
    })
    // The table that was over is deleted from the lobby when it is found out.
    expect(await openRow(closed.matchId)).toBeUndefined()
    expect(await openRow(full.matchId)).toBeDefined()
    // A code that is not a code at all is refused by the parser, as any
    // malformed message is: it names no game, spends nothing, and says no more.
    const typo = await lobbyOf('miss-typo')
    for (const code of ['ABC230', 'ABC', 'ABC-2345', '']) {
      const refused = await answer(typo, () =>
        typo.ws.send(JSON.stringify({ t: 'join_code', code })),
      )
      expect(refused).toMatchObject({ t: 'error', code: 'illegal' })
    }
    expect(Object.keys(await lobbyRows('codefail:')).join()).not.toContain(
      'miss-typo',
    )
    for (const f of typo.frames) checkLobbyFrame(f)
  })

  it('limits an account to five failed tries, and a right code costs nothing', async () => {
    await setLobbyClock(1_900_000_000_000)
    const game = await openGame('tries-host')
    const guesser = await lobbyOf('tries-a')
    // Four misses, a hit, a fifth miss: the hit did not spend.
    for (let i = 0; i < CODE_FAILS - 1; i++)
      expect(await joinCode(guesser, '222222')).toMatchObject({
        state: 'unavailable',
      })
    expect(await joinCode(guesser, game.code)).toMatchObject({
      t: 'matched',
      matchId: game.matchId,
    })
    expect(await joinCode(guesser, '222222')).toMatchObject({
      state: 'unavailable',
    })
    // The sixth: refused before the lookup, even for a right code.
    expect(await joinCode(guesser, '222222')).toMatchObject({
      t: 'error',
      code: 'rate_limited',
    })
    expect(await joinCode(guesser, game.code)).toMatchObject({
      t: 'error',
      code: 'rate_limited',
    })
    // Someone else is not held up by it.
    expect(await joinCode(await lobbyOf('tries-b'), game.code)).toMatchObject({
      t: 'matched',
    })
    // Ten minutes buy five tries back.
    await setLobbyClock(1_900_000_000_000 + 600_000)
    expect(await joinCode(guesser, '222222')).toMatchObject({
      state: 'unavailable',
    })
    for (const f of guesser.frames) checkLobbyFrame(f)
  })

  it('trips a breaker on failed tries by everyone, logs it once with no code, and still serves a right code', async () => {
    const lines = watchConsole()
    await setLobbyClock(1_900_000_000_000)
    const game = await openGame('scan-host')
    // 60 misses from 12 accounts: each within its own five.
    const scanners = await Promise.all(
      Array.from({ length: CODE_FAILS_GLOBAL / CODE_FAILS }, (_, i) =>
        lobbyOf(`scan-${i}`),
      ),
    )
    for (const s of scanners)
      for (let i = 0; i < CODE_FAILS; i++)
        expect(await joinCode(s, '333333')).toMatchObject({
          state: 'unavailable',
        })
    const tripped = lines.filter((l) => l.includes('"reason":"code_scan"'))
    expect(tripped).toHaveLength(1)
    expect(JSON.parse(tripped[0])).toEqual({
      evt: 'limit_hit',
      code: 429,
      reason: 'code_scan',
    })
    // A stranger's wrong code is refused now, and spends nothing more...
    const fresh = await lobbyOf('scan-fresh')
    expect(await joinCode(fresh, '444444')).toMatchObject({
      t: 'error',
      code: 'rate_limited',
    })
    expect(await joinCode(fresh, '444444')).toMatchObject({
      t: 'error',
      code: 'rate_limited',
    })
    // ...but a friend with the right code is served all the same.
    expect(await joinCode(fresh, game.code)).toMatchObject({
      t: 'matched',
      matchId: game.matchId,
    })
    // The trip was logged once, and no line has a code or a handle in it.
    expect(lines.filter((l) => l.includes('code_scan'))).toHaveLength(1)
    for (const line of lines) {
      for (const secret of ['333333', '444444', game.code, game.gameId])
        expect(line).not.toContain(secret)
    }
    // A minute on, the breaker has refilled.
    await setLobbyClock(1_900_000_000_000 + 60_000)
    expect(await joinCode(await lobbyOf('scan-later'), '555555')).toMatchObject(
      {
        state: 'unavailable',
      },
    )
  })

  it('logs the breaker once per trip, not for every miss while the scan goes on', async () => {
    const lines = watchConsole()
    const t0 = 1_900_000_000_000
    await setLobbyClock(t0)
    const trips = () => lines.filter((l) => l.includes('code_scan')).length
    const burst = async (tag: string) => {
      for (let a = 0; a < CODE_FAILS_GLOBAL / CODE_FAILS; a++) {
        const s = await lobbyOf(`${tag}-${a}`)
        for (let i = 0; i < CODE_FAILS; i++) await joinCode(s, '333333')
      }
    }
    await burst('trip-a')
    expect(trips()).toBe(1)
    // Each second a token refills and a miss spends it: the bucket stays dry
    // the whole time, which is one trip, not three.
    for (let i = 1; i <= 3; i++) {
      await setLobbyClock(t0 + i * 1_000)
      await joinCode(await lobbyOf(`trip-b-${i}`), '333333')
    }
    expect(trips()).toBe(1)
    // The scan stops, the bucket recovers, and the next one is a new trip.
    await setLobbyClock(t0 + 5 * 60_000)
    await joinCode(await lobbyOf('trip-calm'), '333333')
    await burst('trip-c')
    expect(trips()).toBe(2)
  })

  it('logs no code and no handle through a whole game', async () => {
    const lines = watchConsole()
    const game = await openGame('log-host')
    const guest = await lobbyOf('log-guest')
    await joinCode(guest, '222222')
    await joinCode(guest, game.code)
    guest.send({ t: 'join_request', gameId: game.gameId })
    await game.host.next((f) => f.t === 'invite' && f.requests.length === 1)
    const seat = await connect(game.matchId, 'log-guest')
    await seat.next((f) => f.t === 'welcome')
    await settled(game.matchId)
    for (const line of lines) {
      expect(line).not.toContain(game.code)
      expect(line).not.toContain(game.gameId)
    }
  })

  it('sends a player already at a table back to it, without spending a try', async () => {
    const game = await openGame('back-host')
    const seated = await connect(game.matchId, 'back-guest')
    await seated.next((f) => f.t === 'welcome')
    await game.host.next(isState(1))
    const other = await openGame('back-other')
    const lobbyGuest = await lobbyOf('back-guest')
    expect(await joinCode(lobbyGuest, other.code)).toEqual({
      t: 'matched',
      matchId: game.matchId,
      resumed: true,
      seq: 0,
    })
    expect(await lobbyRows('codefail:')).toEqual({})
  })

  it('takes a searching player out of the queue, and has no dev account name a separator', async () => {
    const game = await openGame('q-host')
    const guest = await lobbyOf('q-guest')
    guest.send({ t: 'queue', kind: 'hu-casual' })
    await guest.next((f) => f.t === 'queued')
    await joinCode(guest, game.code)
    expect(await lobbyRows('queue:')).toEqual({})
    // Keys are joined with ':', so an account id may not contain one.
    const response = await SELF.fetch(`${ORIGIN}/ws/lobby`, {
      headers: {
        Upgrade: 'websocket',
        Origin: ORIGIN,
        'Sec-WebSocket-Protocol':
          'qp.v1, bearer.dev.a:b.worker-test-secret-0001',
      },
    })
    expect(response.status).toBe(401)
  })
})

// ---- A game being made ---------------------------------------------------------------

describe('a game the lobby has written and its table has not yet been told about', () => {
  /** The lobby's rows for a game, as POST /api/matches writes them, without /init. */
  async function written(host: string) {
    const matchId = crypto.randomUUID()
    const made = await runInDurableObject(lobbyStub(env), (l: LobbyDO) =>
      l.createMatch(host, matchId, { listed: true, hostName: host }),
    )
    expect(made).toMatchObject({ listed: true })
    const row = (await openRow(matchId))!
    return { matchId, code: row.code, gameId: row.gameId }
  }

  it('is not closed by a request or a code lookup inside INIT_GRACE_MS, and is once it has had that long', async () => {
    const t0 = 1_900_000_000_000
    await setLobbyClock(t0)
    const game = await written('grace-host')
    const asker = await lobbyOf('grace-ask')
    asker.send({ t: 'join_request', gameId: game.gameId })
    await asker.next((f) => f.t === 'join_status')
    expect(await openRow(game.matchId)).toBeDefined()
    expect(
      await joinCode(await lobbyOf('grace-code'), game.code),
    ).toMatchObject({ state: 'unavailable' })
    expect(await openRow(game.matchId)).toBeDefined()
    expect(Object.keys(await lobbyRows('code:'))).toContain(`code:${game.code}`)
    // A table that never comes is still found out, once the row has aged.
    await setLobbyClock(t0 + INIT_GRACE_MS)
    await joinCode(await lobbyOf('grace-late'), game.code)
    expect(await openRow(game.matchId)).toBeUndefined()
  })
})

// ---- Asking the host ----------------------------------------------------------------

describe('asking the host for the seat', () => {
  it('shows the host a name and an age, and the asker that it is pending', async () => {
    const game = await openGame('ask-host')
    const bob = await ask('ask-bob', game)
    expect(await bob.next((f) => f.t === 'join_status')).toEqual({
      t: 'join_status',
      seq: expect.any(Number),
      state: 'pending',
      expiresInMs: REQUEST_TTL_MS,
    })
    const prompt = await promptWith(game.host, 1)
    expect(prompt.requests).toEqual([
      {
        id: expect.stringMatching(REQUEST_ID_RE),
        username: 'ask-bob',
        ageMs: expect.any(Number),
      },
    ])
    expect(prompt.code).toBe(game.code)
    expect(prompt.listed).toBe(true)
    expect(prompt.reservedFor).toBeNull()
    // Nothing of the request names an account: the host sees the id, a name
    // and an age.
    expect(Object.keys(prompt.requests[0]).sort()).toEqual([
      'ageMs',
      'id',
      'username',
    ])
    for (const f of bob.frames) checkLobbyFrame(f)
  })

  it('seats nobody on an accept: the requester is sent to the table, and only they', async () => {
    const game = await openGame('acc-host')
    const bob = await ask('acc-bob', game)
    const carol = await lobbyOf('acc-carol')
    const prompt = await promptWith(game.host, 1)
    const from = game.host.frames.length
    game.host.send({
      t: 'join_answer',
      requestId: prompt.requests[0].id,
      accept: true,
    })
    const sent = await bob.next((f) => f.t === 'matched')
    expect(sent).toMatchObject({ matchId: game.matchId, resumed: false })
    // The seat is held, not filled: the host's prompt says for whom.
    expect(
      inviteOf(await game.host.next((f) => f.t === 'invite', from)).reservedFor,
    ).toBe('acc-bob')
    expect((await peek(game.matchId)).match.status).toBe('waiting')
    expect(carol.frames.some((f) => f.t === 'matched')).toBe(false)
    // Bob opens the table from that frame and sits; hand 1 is dealt.
    const seat = await connect(game.matchId, 'acc-bob')
    expect(await seat.next((f) => f.t === 'welcome')).toMatchObject({ seat: 1 })
    await seat.next(isState(1))
    await game.host.next(isState(1))
    // The prompt went with the seat.
    const before = game.host.frames.filter((f) => f.t === 'invite').length
    expect(before).toBeGreaterThan(0)
    expect(await lobbyRows('joinreq:')).toEqual({})
    expect(await lobbyRows('open:')).toEqual({})
  })

  it('sticks a decline: the asker is told, and asking again does not reach the host', async () => {
    const game = await openGame('dec-host')
    const bob = await ask('dec-bob', game)
    const prompt = await promptWith(game.host, 1)
    game.host.send({
      t: 'join_answer',
      requestId: prompt.requests[0].id,
      accept: false,
    })
    expect(
      await bob.next((f) => f.t === 'join_status' && f.state === 'declined'),
    ).toBeDefined()
    await promptWith(game.host, 0, game.host.frames.indexOf(prompt) + 1)
    const prompts = game.host.frames.filter((f) => f.t === 'invite').length
    // Again: declined at once, and the host's screen does not move.
    const again = await answer(bob, () =>
      bob.send({ t: 'join_request', gameId: game.gameId }),
    )
    expect(again).toMatchObject({ t: 'join_status', state: 'declined' })
    await settled(game.matchId)
    expect(game.host.frames.filter((f) => f.t === 'invite')).toHaveLength(
      prompts,
    )
    expect(await lobbyRows('joinreq:')).toEqual({})
    // The decline is the table’s, kept with it; others are not affected.
    const dan = await ask('dec-dan', game)
    expect(await dan.next((f) => f.t === 'join_status')).toMatchObject({
      state: 'pending',
    })
  })

  it('forgets a decline after DECLINED_MAX others, oldest first', async () => {
    const game = await openGame('decmax-host')
    const matchId = game.matchId
    const asked = async (name: string) => {
      const client = await ask(name, game)
      const from = game.host.frames.length
      const prompt = await promptWith(game.host, 1, from)
      game.host.send({
        t: 'join_answer',
        requestId: prompt.requests[0].id,
        accept: false,
      })
      await promptWith(game.host, 0, game.host.frames.length)
      await client.next((f) => f.t === 'join_status' && f.state === 'declined')
      return client
    }
    // The bucket is six; the table’s own list is what is tested here.
    for (let i = 0; i < 3; i++) await asked(`decmax-${i}`)
    const stored = () =>
      runInDurableObject(stub(matchId), (_: TableDO, state) =>
        state.storage.get<{ invite: { declined: string[] } }>('match'),
      )
    expect((await stored())!.invite.declined).toEqual([
      'decmax-0',
      'decmax-1',
      'decmax-2',
    ])
    // Over the limit the oldest go (as the table keeps them).
    await runInDurableObject(
      stub(matchId),
      async (instance: TableDO, state) => {
        const table = instance as unknown as {
          match: { invite: { declined: string[] } }
        }
        table.match.invite.declined = Array.from(
          { length: DECLINED_MAX },
          (_, i) => `old-${i}`,
        )
        await state.storage.put('match', table.match)
      },
    )
    await asked('decmax-late')
    const kept = (await stored())!.invite.declined
    expect(kept).toHaveLength(DECLINED_MAX)
    expect(kept.at(-1)).toBe('decmax-late')
    expect(kept).not.toContain('old-0')
  })

  it('lets a request lapse after REQUEST_TTL_MS, and an answer to it do nothing', async () => {
    const game = await openGame('lap-host')
    const matchId = game.matchId
    await pin(matchId)
    const bob = await ask('lap-bob', game)
    const prompt = await promptWith(game.host, 1)
    const id = prompt.requests[0].id
    // A tick short of 60 s it is still there; at 60 s the alarm clears the
    // host’s prompt, which has no deadline of its own for it.
    const from = game.host.frames.length
    await elapse(matchId, REQUEST_TTL_MS - 1)
    await settled(matchId)
    expect(
      game.host.frames.slice(from).filter((f) => f.t === 'invite'),
    ).toEqual([])
    await elapse(matchId, 1)
    const cleared = await promptWith(game.host, 0, from)
    expect(cleared.requests).toEqual([])
    const frames = game.host.frames.length
    game.host.send({ t: 'join_answer', requestId: id, accept: true })
    const resent = inviteOf(
      await game.host.next((f) => f.t === 'invite', frames),
    )
    expect(resent.reservedFor).toBeNull()
    expect(bob.frames.some((f) => f.t === 'matched')).toBe(false)
    expect((await peek(matchId)).match.status).toBe('waiting')
  })

  it('holds at most REQUESTS_PER_GAME requests; a sixth is turned away; asking again only renews', async () => {
    const game = await openGame('cap-host')
    for (let i = 0; i < REQUESTS_PER_GAME; i++) {
      const client = await ask(`cap-${i}`, game)
      expect(await client.next((f) => f.t === 'join_status')).toMatchObject({
        state: 'pending',
      })
    }
    const sixth = await ask('cap-6', game)
    expect(await sixth.next((f) => f.t === 'join_status')).toMatchObject({
      state: 'unavailable',
    })
    expect(promptOf(game.host).requests).toHaveLength(REQUESTS_PER_GAME)
    // One already there asks again: replaced, still five.
    const first = await lobbyOf('cap-0')
    const reply = await answer(first, () =>
      first.send({ t: 'join_request', gameId: game.gameId }),
    )
    expect(reply).toMatchObject({ state: 'pending' })
    await eventually(async () => promptOf(game.host).requests.length === 5)
    expect(
      promptOf(game.host).requests.filter((r) => r.username === 'cap-0'),
    ).toHaveLength(1)
  })

  it('keeps one pending request per account: asking another game withdraws the first', async () => {
    const a = await openGame('one-a')
    const b = await openGame('one-b')
    const bob = await ask('one-bob', a)
    await promptWith(a.host, 1)
    bob.send({ t: 'join_request', gameId: b.gameId })
    await promptWith(b.host, 1)
    await promptWith(a.host, 0, a.host.frames.length - 1)
    expect(Object.keys(await lobbyRows('joinreq:'))).toEqual([
      'joinreq:one-bob',
    ])
    // Cancelling withdraws it from the host's prompt too.
    bob.send({ t: 'cancel_request' })
    await promptWith(b.host, 0, b.host.frames.length - 1)
    expect(await lobbyRows('joinreq:')).toEqual({})
  })

  it('withdraws a request when the asker’s lobby socket closes', async () => {
    const game = await openGame('leave-host')
    const bob = await ask('leave-bob', game)
    await promptWith(game.host, 1)
    bob.ws.close(1000, 'bye')
    await promptWith(game.host, 0, game.host.frames.length - 1)
    expect(await lobbyRows('joinreq:')).toEqual({})
  })

  it('limits an account’s requests, and says so as rate_limited', async () => {
    await setLobbyClock(1_900_000_000_000)
    const bob = await lobbyOf('lim-bob')
    // Handles that open nothing still count: asking is what is limited.
    for (let i = 0; i < JOIN_REQUESTS; i++)
      expect(
        await answer(bob, () =>
          bob.send({ t: 'join_request', gameId: newGameId() }),
        ),
      ).toMatchObject({ state: 'unavailable' })
    expect(
      await answer(bob, () =>
        bob.send({ t: 'join_request', gameId: newGameId() }),
      ),
    ).toMatchObject({ t: 'error', code: 'rate_limited' })
    await setLobbyClock(1_900_000_000_000 + 300_000)
    expect(
      await answer(bob, () =>
        bob.send({ t: 'join_request', gameId: newGameId() }),
      ),
    ).toMatchObject({ state: 'unavailable' })
  })

  it('sends an asker who is playing back to that table', async () => {
    const mine = await openGame('away-me')
    const seated = await connect(mine.matchId, 'away-bob')
    await seated.next((f) => f.t === 'welcome')
    await mine.host.next(isState(1))
    const other = await openGame('away-other')
    const bob = await lobbyOf('away-bob')
    expect(
      await answer(bob, () =>
        bob.send({ t: 'join_request', gameId: other.gameId }),
      ),
    ).toMatchObject({ t: 'matched', matchId: mine.matchId, resumed: true })
    expect(promptOf(other.host).requests).toEqual([])
  })

  it('turns away a host who has a game of their own open, and a request for their own game', async () => {
    const mine = await openGame('host-me')
    const other = await openGame('host-other')
    const me = await lobbyOf('host-me')
    expect(
      await answer(me, () =>
        me.send({ t: 'join_request', gameId: other.gameId }),
      ),
    ).toMatchObject({ t: 'join_status', state: 'unavailable' })
    expect(
      await answer(me, () =>
        me.send({ t: 'join_request', gameId: mine.gameId }),
      ),
    ).toMatchObject({ state: 'unavailable' })
    expect(promptOf(other.host).requests).toEqual([])
    // Not for an unlisted game, or one the host has left.
    const hidden = await openGame('host-hidden', false)
    const bob = await lobbyOf('host-bob')
    expect(
      await answer(bob, () =>
        bob.send({ t: 'join_request', gameId: hidden.gameId }),
      ),
    ).toMatchObject({ state: 'unavailable' })
  })

  it('does not take a request for a host that is not here', async () => {
    const game = await openGame('gone-host')
    game.host.ws.close(1000, 'bye')
    await noSockets(game.matchId)
    const bob = await lobbyOf('gone-bob')
    expect(
      await answer(bob, () =>
        bob.send({ t: 'join_request', gameId: game.gameId }),
      ),
    ).toMatchObject({ state: 'unavailable' })
    expect(await lobbyRows('joinreq:')).toEqual({})
  })

  it('refuses join_answer from anyone but the host, as illegal, and closes the seat after too many', async () => {
    const game = await openGame('who-host')
    const guest = await connect(game.matchId, 'who-guest')
    await guest.next(isState(1))
    const msg = { t: 'join_answer', requestId: newRequestId(), accept: true }
    for (let i = 0; i < 3; i++) {
      const from = guest.frames.length
      guest.ws.send(JSON.stringify(msg))
      expect(await guest.next((f) => f.t === 'error', from)).toMatchObject({
        code: 'illegal',
      })
    }
    for (let i = 0; i < 4; i++) guest.ws.send(JSON.stringify(msg))
    expect((await closedWithin(guest))?.code).toBe(4400)
    // The host’s own late answer, with the table filled, is no offence.
    const from = game.host.frames.length
    game.host.ws.send(JSON.stringify(msg))
    await new Promise((r) => setTimeout(r, 50))
    expect(game.host.frames.slice(from).filter((f) => f.t === 'error')).toEqual(
      [],
    )
    // And the lobby takes no table message, as a table takes no lobby one.
    const lobbySocket = await lobbyOf('who-lobby')
    expect(
      await answer(lobbySocket, () => lobbySocket.ws.send(JSON.stringify(msg))),
    ).toMatchObject({ t: 'error', code: 'illegal' })
    // A six table has no host to answer.
    const six = await sixTable()
    const sitter = await sitDown(six, 'who-six')
    const fromSix = sitter.frames.length
    sitter.ws.send(JSON.stringify(msg))
    expect(await sitter.next((f) => f.t === 'error', fromSix)).toMatchObject({
      code: 'illegal',
    })
    // None of the lobby frames above carried anything they should not.
    for (const f of lobbySocket.frames) checkLobbyFrame(f)
  })

  it('refuses the lobby’s other messages at a table', async () => {
    const game = await openGame('tbl-host')
    for (const msg of [
      { t: 'games' },
      { t: 'join_request', gameId: newGameId() },
      { t: 'cancel_request' },
      { t: 'join_code', code: 'ABC234' },
    ]) {
      const from = game.host.frames.length
      game.host.ws.send(JSON.stringify(msg))
      expect(await game.host.next((f) => f.t === 'error', from)).toMatchObject({
        code: 'illegal',
      })
    }
  })
})

// ---- The seat: reservations and races ------------------------------------------------

/** The host accepts the one request; resolves with the prompt that follows. */
async function accept(game: Game, requester: string) {
  const prompt = promptOf(game.host)
  const request = prompt.requests.find((r) => r.username === requester)!
  const from = game.host.frames.length
  game.host.send({ t: 'join_answer', requestId: request.id, accept: true })
  return inviteOf(await game.host.next((f) => f.t === 'invite', from))
}

describe('the seat is decided at the table', () => {
  it('holds the seat for the accepted account: a stranger with the link or the code gets table full, and the reserved account is admitted', async () => {
    const game = await openGame('res-host')
    const bob = await ask('res-bob', game)
    await promptWith(game.host, 1)
    const held = await accept(game, 'res-bob')
    expect(held.reservedFor).toBe('res-bob')
    expect(held.requests).toEqual([])
    await bob.next((f) => f.t === 'matched')
    // The link: refused before the lobby is asked for a claim at all.
    const claimed = vi.spyOn(LobbyDO.prototype, 'claim')
    const carol = await tryConnect(game.matchId, 'res-carol')
    expect(carol.status).toBe(403)
    expect(claimed.mock.calls.map(([userId]) => userId)).not.toContain(
      'res-carol',
    )
    // The code still leads to the table; the table says no.
    const dan = await lobbyOf('res-dan')
    expect(await joinCode(dan, game.code)).toMatchObject({
      t: 'matched',
      matchId: game.matchId,
    })
    expect((await tryConnect(game.matchId, 'res-dan')).status).toBe(403)
    expect(await lobbyRows('active:')).not.toHaveProperty('active:res-carol')
    expect(await lobbyRows('active:')).not.toHaveProperty('active:res-dan')
    expect((await peek(game.matchId)).match.status).toBe('waiting')
    // The account the host accepted is seated, and hand 1 is dealt.
    const seat = await connect(game.matchId, 'res-bob')
    expect(await seat.next((f) => f.t === 'welcome')).toMatchObject({ seat: 1 })
    await game.host.next(isState(1))
    expect(await lobbyRows('active:')).toMatchObject({
      'active:res-bob': game.matchId,
    })
  })

  it('opens the seat again when the reservation runs out, and tells the host', async () => {
    const game = await openGame('exp-host')
    await pin(game.matchId)
    const bob = await ask('exp-bob', game)
    await promptWith(game.host, 1)
    await accept(game, 'exp-bob')
    await bob.next((f) => f.t === 'matched')
    expect((await tryConnect(game.matchId, 'exp-carol')).status).toBe(403)
    // One tick short of the end, still held; at the end, the seat reopens
    // and the host’s prompt says so, with no deadline of its own for it.
    await elapse(game.matchId, RESERVE_MS - 1)
    expect((await tryConnect(game.matchId, 'exp-carol')).status).toBe(403)
    const from = game.host.frames.length
    await elapse(game.matchId, 1)
    expect(
      inviteOf(
        await game.host.next(
          (f) => f.t === 'invite' && f.reservedFor === null,
          from,
        ),
      ).reservedFor,
    ).toBeNull()
    const carol = await connect(game.matchId, 'exp-carol')
    expect(await carol.next((f) => f.t === 'welcome')).toMatchObject({
      seat: 1,
    })
  })

  it('a stranger whose claim was under way when the host accepted is refused, and the claim is given back', async () => {
    const game = await openGame('race-host')
    // A guest is claimed together with the host (claimBoth, audit F06).
    const claimBoth = LobbyDO.prototype.claimBoth
    let entered = false
    let letGo: () => void = () => {}
    const held = new Promise<void>((resolve) => (letGo = resolve))
    vi.spyOn(LobbyDO.prototype, 'claimBoth').mockImplementation(async function (
      this: LobbyDO,
      userIds: string[],
      matchId: string,
    ) {
      if (userIds.includes('race-carol')) {
        entered = true
        await held
      }
      return claimBoth.call(this, userIds, matchId)
    })
    // Carol is through the table’s first check and waits on the lobby...
    const carol = tryConnect(game.matchId, 'race-carol')
    await eventually(async () => entered)
    // ...when Bob asks and the host accepts.
    const bob = await ask('race-bob', game)
    await promptWith(game.host, 1)
    await accept(game, 'race-bob')
    await bob.next((f) => f.t === 'matched')
    letGo()
    expect((await carol).status).toBe(403)
    // The claim she was given went back, and nobody sits but Bob.
    await eventually(
      async () => !('active:race-carol' in (await lobbyRows('active:'))),
    )
    const seat = await connect(game.matchId, 'race-bob')
    expect(await seat.next((f) => f.t === 'welcome')).toMatchObject({ seat: 1 })
    await game.host.next(isState(1))
    const { match } = await peek(game.matchId)
    expect(
      (match as unknown as { players: { userId: string }[] }).players.map(
        (p) => p.userId,
      ),
    ).toEqual(['race-host', 'race-bob'])
  })

  it('and when the stranger sits first, a later accept finds the table full and does nothing', async () => {
    const game = await openGame('first-host')
    const bob = await ask('first-bob', game)
    const prompt = await promptWith(game.host, 1)
    // Carol opens the link and sits before the host answers.
    const carol = await connect(game.matchId, 'first-carol')
    expect(await carol.next((f) => f.t === 'welcome')).toMatchObject({
      seat: 1,
    })
    await game.host.next(isState(1))
    // Bob is told the seat went; the host’s answer, late, changes nothing.
    expect(
      await bob.next((f) => f.t === 'join_status' && f.state === 'unavailable'),
    ).toBeDefined()
    game.host.send({
      t: 'join_answer',
      requestId: prompt.requests[0].id,
      accept: true,
    })
    await new Promise((r) => setTimeout(r, 50))
    await settled(game.matchId)
    expect(bob.frames.some((f) => f.t === 'matched')).toBe(false)
    expect((await tryConnect(game.matchId, 'first-bob')).status).toBe(403)
    const { match } = await peek(game.matchId)
    expect(
      (match as unknown as { players: { userId: string }[] }).players,
    ).toHaveLength(2)
    expect(await lobbyRows('joinreq:')).toEqual({})
  })

  it('seats one of two accepts: the second request was told the seat went, and a repeated accept sends nothing twice', async () => {
    const game = await openGame('two-host')
    const bob = await ask('two-bob', game)
    const dan = await ask('two-dan', game)
    const prompt = await promptWith(game.host, 2)
    const ids = Object.fromEntries(
      prompt.requests.map((r) => [r.username, r.id]),
    )
    const from = game.host.frames.length
    // Both answers in one breath, and the first again.
    game.host.send({
      t: 'join_answer',
      requestId: ids['two-bob'],
      accept: true,
    })
    game.host.send({
      t: 'join_answer',
      requestId: ids['two-dan'],
      accept: true,
    })
    game.host.send({
      t: 'join_answer',
      requestId: ids['two-bob'],
      accept: true,
    })
    await bob.next((f) => f.t === 'matched')
    await dan.next((f) => f.t === 'join_status' && f.state === 'unavailable')
    await eventually(async () => game.host.frames.length >= from + 3)
    await settled(game.matchId)
    expect(bob.frames.filter((f) => f.t === 'matched')).toHaveLength(1)
    expect(dan.frames.some((f) => f.t === 'matched')).toBe(false)
    const last = promptOf(game.host)
    expect(last.reservedFor).toBe('two-bob')
    expect(last.requests).toEqual([])
    expect((await tryConnect(game.matchId, 'two-dan')).status).toBe(403)
  })

  it('accepts nothing while the seat is already held, whatever request is open', async () => {
    // Not a state the table gets into (a hold drops the open requests, and
    // takes no new one), so it is made by hand: the check is the table's own.
    const game = await openGame('held-host')
    const bob = await ask('held-bob', game)
    const prompt = await promptWith(game.host, 1)
    await runInDurableObject(stub(game.matchId), (instance: TableDO) => {
      const table = instance as unknown as {
        match: {
          invite: {
            reserved?: { userId: string; username: string; until: number }
          }
        }
      }
      table.match.invite.reserved = {
        userId: 'held-someone',
        username: 'held-someone',
        until: Date.now() + RESERVE_MS,
      }
    })
    const from = game.host.frames.length
    game.host.send({
      t: 'join_answer',
      requestId: prompt.requests[0].id,
      accept: true,
    })
    const resent = inviteOf(await game.host.next((f) => f.t === 'invite', from))
    expect(resent.reservedFor).toBe('held-someone')
    expect(resent.requests).toHaveLength(1)
    expect(bob.frames.some((f) => f.t === 'matched')).toBe(false)
  })

  it('gives the seat back at once when the accepted account has no lobby socket to be told on', async () => {
    const game = await openGame('nosock-host')
    const bob = await ask('nosock-bob', game)
    await promptWith(game.host, 1)
    const answered = vi
      .spyOn(LobbyDO.prototype, 'answerRequest')
      .mockResolvedValue(false)
    const from = game.host.frames.length
    const prompt = promptOf(game.host)
    game.host.send({
      t: 'join_answer',
      requestId: prompt.requests[0].id,
      accept: true,
    })
    // The prompt shows the hold, then the seat open again.
    await game.host.next(
      (f) => f.t === 'invite' && f.reservedFor !== null,
      from,
    )
    await game.host.next(
      (f) => f.t === 'invite' && f.reservedFor === null,
      from,
    )
    expect(answered).toHaveBeenCalledWith(
      'nosock-bob',
      game.matchId,
      'accepted',
    )
    expect(bob.frames.some((f) => f.t === 'matched')).toBe(false)
    const carol = await connect(game.matchId, 'nosock-carol')
    expect(await carol.next((f) => f.t === 'welcome')).toMatchObject({
      seat: 1,
    })
  })

  it('answers an accept only for a request the account still has, and says whether it reached them', async () => {
    const matchId = crypto.randomUUID()
    const lobbyRpc = lobbyStub(env)
    const put = (key: string, value: unknown) =>
      runInDurableObject(lobbyRpc, (_: LobbyDO, state) =>
        state.storage.put(key, value),
      )
    // Asked, and no socket of theirs open: nobody to tell.
    await put('joinreq:ghost', { matchId, gameId: newGameId(), at: Date.now() })
    expect(await lobbyRpc.answerRequest('ghost', matchId, 'accepted')).toBe(
      false,
    )
    expect(await lobbyRows('joinreq:')).toEqual({})
    // Another game’s request, an old one, or none: not an answer.
    await put('joinreq:ghost', { matchId, gameId: newGameId(), at: Date.now() })
    expect(
      await lobbyRpc.answerRequest('ghost', crypto.randomUUID(), 'declined'),
    ).toBe(false)
    await put('joinreq:ghost', {
      matchId,
      gameId: newGameId(),
      at: Date.now() - REQUEST_TTL_MS,
    })
    expect(await lobbyRpc.answerRequest('ghost', matchId, 'declined')).toBe(
      false,
    )
    expect(await lobbyRpc.answerRequest('nobody', matchId, 'taken')).toBe(false)
  })

  it('refuses an accepted account that sat down elsewhere meanwhile, at the answer or at the connect', async () => {
    const game = await openGame('else-host')
    const bob = await ask('else-bob', game)
    await promptWith(game.host, 1)
    // Bob takes a seat at another table before the host answers.
    const other = await openGame('else-zed')
    const there = await connect(other.matchId, 'else-bob')
    await there.next((f) => f.t === 'welcome')
    await other.host.next(isState(1))
    const held = await accept(game, 'else-bob')
    expect(held.reservedFor).toBe('else-bob')
    expect(
      await bob.next((f) => f.t === 'join_status' && f.state === 'unavailable'),
    ).toBeDefined()
    expect(bob.frames.some((f) => f.t === 'matched')).toBe(false)
    // The hold was given back, and a connect of his own is closed with the
    // table he is at (the claim).
    await game.host.next(
      (f) => f.t === 'invite' && f.reservedFor === null,
      game.host.frames.length - 1,
    )
    const tried = await tryConnect(game.matchId, 'else-bob')
    expect(await tried.closed).toEqual({ code: 4409, reason: other.matchId })
    expect((await peek(game.matchId)).match.status).toBe('waiting')
  })

  it('keeps requests and a reservation in the table when the objects restart, and drops only what was in memory', async () => {
    const game = await openGame('abort-host')
    const bob = await ask('abort-bob', game)
    await ask('abort-dan', game)
    await promptWith(game.host, 2)
    await accept(game, 'abort-bob')
    await bob.next((f) => f.t === 'matched')
    // A list is remembered for 2 s.
    const watcher = await lobbyOf('abort-w')
    await listGames(watcher)
    expect(
      await runInDurableObject(
        lobbyStub(env),
        (i: LobbyDO) => (i as never as { snapshot: unknown }).snapshot,
      ),
    ).not.toBeNull()
    await abortAllDurableObjects()
    expect(
      await runInDurableObject(
        lobbyStub(env),
        (i: LobbyDO) => (i as never as { snapshot: unknown }).snapshot,
      ),
    ).toBeNull()
    // The hold is still there: a stranger is refused, and Bob is seated.
    expect((await tryConnect(game.matchId, 'abort-carol')).status).toBe(403)
    const stored = await runInDurableObject(
      stub(game.matchId),
      (_: TableDO, s) =>
        s.storage.get<{
          invite: { reserved?: { userId: string }; code: string }
        }>('match'),
    )
    expect(stored!.invite.reserved?.userId).toBe('abort-bob')
    expect(stored!.invite.code).toBe(game.code)
    const seat = await connect(game.matchId, 'abort-bob')
    expect(await seat.next((f) => f.t === 'welcome')).toMatchObject({ seat: 1 })
  })

  it('keeps open requests across a restart, and shows them to the host when they are back', async () => {
    const game = await openGame('keep-host')
    await ask('keep-bob', game)
    await promptWith(game.host, 1)
    await abortAllDurableObjects()
    const back = await connect(game.matchId, 'keep-host')
    const prompt = inviteOf(await back.next((f) => f.t === 'invite'))
    expect(prompt.requests.map((r) => r.username)).toEqual(['keep-bob'])
    expect(prompt.code).toBe(game.code)
  })
})

// ---- What the other seat and the hot path see ------------------------------------------

describe('what no one else sees, and what a move does not wait on', () => {
  it('sends the code, the handle and the requests to the host alone, and stops the prompt when the seat fills', async () => {
    const game = await openGame('red-host')
    const bob = await ask('red-bob', game)
    await promptWith(game.host, 1)
    await accept(game, 'red-bob')
    await bob.next((f) => f.t === 'matched')
    const guest = await connect(game.matchId, 'red-bob')
    await guest.next(isState(1))
    await game.host.next(isState(1))
    await settled(game.matchId)
    // The guest’s table is the game, and nothing of the lobby’s business.
    const seen = JSON.stringify(guest.frames)
    for (const secret of [
      game.code,
      game.gameId,
      'invite',
      'requests',
      'reservedFor',
    ])
      expect(seen).not.toContain(secret)
    expect(checkFrames(guest.frames).has('invite')).toBe(false)
    // The host’s game frames carry none of it either, and the prompt
    // stopped when the seat filled.
    const gameFrames = game.host.frames.filter((f) => f.t !== 'invite')
    for (const secret of [game.code, game.gameId])
      expect(JSON.stringify(gameFrames)).not.toContain(secret)
    const prompts = game.host.frames.filter((f) => f.t === 'invite').length
    await elapse(game.matchId, OPEN_HEARTBEAT_MS)
    await settled(game.matchId)
    expect(game.host.frames.filter((f) => f.t === 'invite')).toHaveLength(
      prompts,
    )
    // And the host’s frames, prompt included, are all within the allowlist.
    expect(checkFrames(game.host.frames)).toEqual(new Set(FLOW_TYPES.invite))
  })

  it('keeps every lobby call out of applyActionNow', () => {
    const source = workerSources['../src/table.ts']
    const start = source.indexOf('private async applyActionNow(')
    const end = source.indexOf('private startNextHand()')
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const body = source
      .slice(start, end)
      .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
    for (const call of ['lobbyStub', 'toLobbyList', 'reportOpen', 'closeGame'])
      expect(body, call).not.toContain(call)
    // The seating path awaits no call to the lobby either for the list.
    const join = source.slice(
      source.indexOf('private async join('),
      source.indexOf('private refuse('),
    )
    expect(join).not.toMatch(/await[^\n]*closeGame/)
    expect(join).not.toMatch(/await[^\n]*closeOpen/)
  })
})

describe('signing keys', () => {
  it('are fetched once when the page asks for its settings, off the response', async () => {
    const fetched: string[] = []
    const realFetch = globalThis.fetch
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        )
        if (url.origin !== new URL(env.SUPABASE_URL).origin)
          return realFetch(input, init)
        fetched.push(url.pathname)
        return Response.json({ keys: [] })
      },
    )
    try {
      const config = await SELF.fetch(`${ORIGIN}/api/config`)
      expect(config.status).toBe(200)
      expect(Object.keys(await config.json()).sort()).toEqual([
        'supabaseKey',
        'supabaseUrl',
      ])
      await eventually(async () => fetched.length > 0)
      // Again, at once: the keys are fresh, so nothing more is fetched.
      await SELF.fetch(`${ORIGIN}/api/config`)
      await new Promise((r) => setTimeout(r, 50))
      expect(fetched).toEqual(['/auth/v1/.well-known/jwks.json'])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

// ---- Latency: where a table is made, and what a hand’s end costs ---------------------

describe('placement', () => {
  /** The location hints each table the Worker is asked for is made with. */
  async function hintsFor(cf?: RequestInit['cf']) {
    const hints: (string | undefined)[] = []
    const watched = {
      ...env,
      TABLE: {
        idFromName: (name: string) => env.TABLE.idFromName(name),
        get: (id: DurableObjectId, options?: { locationHint?: string }) => {
          hints.push(options?.locationHint)
          return env.TABLE.get(id, options as never)
        },
      },
    } as unknown as typeof env
    const made = await worker.fetch(
      new Request(`${ORIGIN}/api/matches`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token('place-a')}` },
        ...(cf ? { cf } : {}),
      }),
      watched,
      { waitUntil() {}, passThroughOnException() {} } as never,
    )
    expect(made.status).toBe(201)
    return hints
  }

  it('puts a new invite table near its host, and uses the default without a location', async () => {
    expect(await hintsFor()).toEqual(['enam'])
    await runInDurableObject(lobbyStub(env), (_: LobbyDO, s) =>
      s.storage.deleteAll(),
    )
    expect(
      await hintsFor({ continent: 'EU', longitude: '2.35', country: 'FR' }),
    ).toEqual(['weur'])
  })
})

describe('the end of a hand', () => {
  it('computes the 52 salts once, and the bytes are the same either way', async () => {
    const { commitDeck, revealSlots, salts } = await import(
      '../../src/engine/deck'
    )
    const deck = Array.from({ length: 52 }, (_, i) => (i * 7) % 52)
    const secret = crypto.getRandomValues(new Uint8Array(32))
    const shared = await salts(secret)
    const plain = await commitDeck(deck, secret)
    const same = await commitDeck(deck, secret, shared)
    expect(same.commitment).toBe(plain.commitment)
    expect(same.leaves).toEqual(plain.leaves)
    expect(await revealSlots(deck, secret, [3, 9, 40], shared)).toEqual(
      await revealSlots(deck, secret, [3, 9, 40]),
    )
    // The hand that ends signs once per slot, not once per opening.
    const matchId = await createTable('salt-a')
    const a = await connect(matchId, 'salt-a')
    const b = await connect(matchId, 'salt-b')
    await a.next(isState(1))
    await b.next(isState(1))
    const sign = vi.spyOn(crypto.subtle, 'sign')
    const { hand } = await peek(matchId)
    const seats: Record<number, Client> = { 0: a, 1: b }
    const from = a.frames.length
    seats[hand!.toAct!].send({
      t: 'act',
      reqId: 'salt-fold',
      handNo: 1,
      actionIndex: 0,
      action: { type: 'fold' },
    })
    await a.next((f) => f.t === 'reveal', from)
    expect(sign).toHaveBeenCalledTimes(52)
    // Each seat still gets its own opening, and only its own.
    for (const client of [a, b]) {
      const reveal = client.frames.find((f) => f.t === 'reveal')
      if (reveal?.t !== 'reveal') throw new Error('no reveal')
      expect(reveal.own).toHaveLength(2)
    }
  })
})
