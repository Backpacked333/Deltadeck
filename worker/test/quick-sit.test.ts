// Quick-sit and the list of six tables (P2-08b; ADR amendment 2026-10-10,
// "Table list and quick-sit", and its clarifications from PR-24). The lobby
// answers a quick-sit with the account's own table, or the fullest listed
// table with a free seat it has not tried, or a table it opens under a cap
// of 50; the client sits there and, refused (table_full, sit_cooldown, or
// the table closed), asks again naming the tables it tried. Tables run for
// real behind the lobby where a test sits at them; elsewhere the list is
// seeded with reports, as the lobby's own tests do.
import {
  abortAllDurableObjects,
  env,
  runInDurableObject,
} from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PlayerAction } from '../../src/engine/types'
import { QUICK_SIT_TABLES } from '../../src/shared/protocol'
import type {
  LobbyMsg,
  MatchConfig,
  ServerMsg,
} from '../../src/shared/protocol'
import { CashController } from '../src/controller'
import type { Roster } from '../src/controller'
import { IDLE_MS } from '../src/deadlines'
import {
  MATCH_CREATES_PER_DAY,
  QUICK_SIT_WINDOW_MS,
  QUICK_SITS,
} from '../src/limits'
import { CREATED_MS, LobbyDO, lobbyStub, SIX_TABLES_MAX } from '../src/lobby'
import type { TableEntry, TableReport } from '../src/registry'
import { REGISTRY_STALE_MS, REPORT_MS } from '../src/registry'
import { NEXT_HAND_MS, TableDO } from '../src/table'
import { checkLobbyFrame, expectKeys, TABLE_ROW_KEYS } from './frames'
import {
  connect,
  elapse,
  eventually,
  freezeClock,
  isState,
  lobby,
  playOut,
  setLobbyClock,
  sitDown,
  sixTable,
  stub,
  tryConnect,
} from './helpers'
import type { Client, LobbyClient } from './helpers'

afterEach(() => vi.restoreAllMocks())

/** The lobby's clock while a test needs it still. */
const AT = 1_900_000_000_000

const counts = (seated: number): TableReport => ({
  seated,
  maxSeats: 6,
  avgPot: 40,
  playersPerHour: 3,
})

/** A listed table that exists only as the lobby's entry for it. */
async function listed(seated: number, tableId: string = crypto.randomUUID()) {
  await lobbyStub(env).reportTable(tableId, counts(seated))
  return tableId
}

/** `n` listed tables, every seat taken. */
async function fullTables(n: number) {
  const ids: string[] = []
  for (let i = 0; i < n; i++) ids.push(await listed(6))
  return ids
}

/** The lobby's stored entry for a table, if any. */
const entryOf = (tableId: string) =>
  runInDurableObject(lobbyStub(env), (_: LobbyDO, state) =>
    state.storage.get<TableEntry>(`table:${tableId}`),
  )

/** The lobby's record of a table it opened, if any. */
const createdOf = (tableId: string) =>
  runInDurableObject(lobbyStub(env), (_: LobbyDO, state) =>
    state.storage.get<{ at: number; by: string; ready: boolean }>(
      `created:${tableId}`,
    ),
  )

/** Every table the lobby has a record of opening. */
const createdIds = () =>
  runInDurableObject(lobbyStub(env), async (_: LobbyDO, state) =>
    [...(await state.storage.list({ prefix: 'created:' })).keys()].map((k) =>
      k.slice('created:'.length),
    ),
  )

const listedIds = async () =>
  (
    await runInDurableObject(lobbyStub(env), (instance: LobbyDO) =>
      instance.tables(),
    )
  ).map((t) => t.tableId)

/** `client` asks to quick-sit; resolves with the lobby's answer. */
async function quickSit(client: LobbyClient, tried?: string[]) {
  const from = client.frames.length
  client.send(tried ? { t: 'quick_sit', tried } : { t: 'quick_sit' })
  return client.next(
    (f) => f.t === 'sit_at' || f.t === 'matched' || f.t === 'error',
    from,
  )
}

/** The table quick-sit sent `client` to (it must have sent one). */
async function sentTo(client: LobbyClient, tried?: string[]) {
  const answer = await quickSit(client, tried)
  if (answer.t !== 'sit_at')
    throw new Error(`no table: ${JSON.stringify(answer)}`)
  return answer.tableId
}

/** A signed-in player's lobby socket, once the lobby has counted it. */
async function inLobby(user: string) {
  const client = await lobby(user)
  await client.next((f) => f.t === 'presence')
  return client
}

/** `client` asks for the list; resolves with its rows, checked. */
async function tablesFrame(client: LobbyClient) {
  const from = client.frames.length
  client.send({ t: 'tables' })
  const frame = await client.next((f) => f.t === 'tables', from)
  if (frame.t !== 'tables') throw new Error('no tables frame')
  checkLobbyFrame(frame)
  return frame.tables
}

/** `client` sends a bare sit; resolves with the welcome or error answering. */
async function sit(client: Client) {
  const from = client.frames.length
  client.send({ t: 'sit' })
  return client.next(
    (f) => (f.t === 'welcome' && f.seat !== null) || f.t === 'error',
    from,
  )
}

/** Waits for every registry call the table has sent to land. */
const settled = (matchId: string) =>
  runInDurableObject(stub(matchId), async (instance: TableDO) => {
    const table = instance as unknown as { listingCalls?: Promise<unknown> }
    for (let last; last !== table.listingCalls; ) {
      last = table.listingCalls
      await last
    }
  })

/** A six table where `users` sit, its first report landed. */
async function tableWith(...users: string[]) {
  const matchId = await sixTable()
  const clients: Client[] = []
  for (const user of users) clients.push(await sitDown(matchId, user))
  await settled(matchId)
  return { matchId, clients }
}

const fold = (): PlayerAction => ({ type: 'fold' })

/** Waits for `done` to hold, then asserts it does (named `what`). */
async function until(what: string, done: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 400 && !(await done()); i++)
    await new Promise((r) => setTimeout(r, 5))
  expect(await done(), what).toBe(true)
}

/** A lobby answer to a quick-sit. */
const answered = (f: LobbyMsg) =>
  f.t === 'sit_at' || f.t === 'matched' || f.t === 'error'

/**
 * Holds tables' /init (the first `count` of them, or all) until `letGo`.
 * The lobby's open is a call that lets other events in, and this keeps it
 * open while the test acts. The promise is made here, in the test, so the
 * table can wait on it (workerd's per-object I/O rule).
 */
function holdInit(count = Infinity) {
  let letGo: () => void = () => {}
  const gate = new Promise<void>((resolve) => (letGo = resolve))
  let held = 0
  const real = TableDO.prototype.fetch
  const spy = vi
    .spyOn(TableDO.prototype, 'fetch')
    .mockImplementation(async function (this: TableDO, request: Request) {
      if (new URL(request.url).pathname === '/init' && held < count) {
        held++
        await gate
      }
      return real.call(this, request)
    })
  return {
    held: () => held,
    letGo: () => letGo(),
    restore: () => spy.mockRestore(),
  }
}

/** How often the lobby has read its list of tables since this was called. */
function watchListReads() {
  const spy = vi.spyOn(LobbyDO.prototype, 'tables')
  return () => spy.mock.calls.length
}

/** The lobby's stored day count of tables `userId` made, if any. */
const createsOf = (userId: string) =>
  runInDurableObject(lobbyStub(env), (_: LobbyDO, state) =>
    state.storage.get<number>(
      `creates:${new Date().toISOString().slice(0, 10)}:${userId}`,
    ),
  )

describe('quick-sit picks a table', () => {
  it('quick-sit picks the fullest table with a free seat', async () => {
    const two = await listed(2)
    const five = await listed(5)
    await listed(6)
    await listed(0)
    const q = await inLobby('pick-q')
    // Not the emptiest, nor a full one: the fullest that still seats one.
    expect(await quickSit(q)).toMatchObject({ t: 'sit_at', tableId: five })
    // Once five is tried, the next fullest.
    expect(await quickSit(q, [five])).toMatchObject({
      t: 'sit_at',
      tableId: two,
    })
    for (const f of q.frames) checkLobbyFrame(f)
  })

  it('quick-sit resumes the account claimed table first', async () => {
    // Seated at a six table, an account is sent back there, whatever else
    // has a seat: one table per account.
    const { matchId } = await tableWith('resume-a', 'resume-b')
    await listed(5)
    const a = await inLobby('resume-a')
    expect(await quickSit(a)).toMatchObject({
      t: 'matched',
      matchId,
      resumed: true,
    })
    // The same for a heads-up table it is playing.
    const [hx, hy] = [await inLobby('resume-x'), await inLobby('resume-y')]
    hx.send({ t: 'queue', kind: 'hu-casual' })
    await hx.next((f) => f.t === 'queued')
    hy.send({ t: 'queue', kind: 'hu-casual' })
    const paired = await hx.next((f) => f.t === 'matched')
    expect(await quickSit(hx)).toMatchObject({
      t: 'matched',
      matchId: (paired as Extract<LobbyMsg, { t: 'matched' }>).matchId,
      resumed: true,
    })
    // Neither resume opened a table.
    expect(await createdIds()).toEqual([])
    for (const f of [...a.frames, ...hx.frames]) checkLobbyFrame(f)
  })

  it('a quick-sit ends the account heads-up search, so one account is never sent two ways', async () => {
    const tableId = await listed(3)
    const q = await inLobby('search-q')
    q.send({ t: 'queue', kind: 'hu-casual' })
    await q.next((f) => f.t === 'queued')
    expect(await quickSit(q)).toMatchObject({ t: 'sit_at', tableId })
    await q.next((f) => f.t === 'presence' && f.queued === 0)
    // Another player looking for heads-up is not paired with it.
    const other = await inLobby('search-o')
    other.send({ t: 'queue', kind: 'hu-casual' })
    await other.next((f) => f.t === 'queued')
    await new Promise((r) => setTimeout(r, 50))
    expect(other.frames.some((f) => f.t === 'matched')).toBe(false)
    expect(q.frames.some((f) => f.t === 'matched')).toBe(false)
  })

  it('a quick-sit refused by its budget still ends the heads-up search', async () => {
    // Devin's review: the client stops looking when it asks to quick-sit,
    // so the lobby must too, even when it has no quick-sit left to give.
    await setLobbyClock(AT)
    const tableId = await listed(3)
    const q = await inLobby('spent-q')
    for (let i = 0; i < QUICK_SITS; i++)
      expect(await quickSit(q)).toMatchObject({ t: 'sit_at', tableId })
    q.send({ t: 'queue', kind: 'hu-casual' })
    await q.next((f) => f.t === 'queued')
    expect(await quickSit(q)).toMatchObject({
      t: 'error',
      code: 'rate_limited',
    })
    expect(
      await runInDurableObject(lobbyStub(env), (_: LobbyDO, state) =>
        state.storage.get('queue:spent-q'),
      ),
    ).toBeUndefined()
    // Another player looking for heads-up is not paired with it.
    const other = await inLobby('spent-o')
    other.send({ t: 'queue', kind: 'hu-casual' })
    await other.next((f) => f.t === 'queued')
    await new Promise((r) => setTimeout(r, 50))
    expect(other.frames.some((f) => f.t === 'matched')).toBe(false)
    expect(q.frames.some((f) => f.t === 'matched')).toBe(false)
  })

  it('a claim whose table is gone is not resumed, and is cleared', async () => {
    // The claim is checked with its table, not taken on trust: a table
    // that ended (its release lost) holds nobody.
    const tableId = await listed(3)
    await runInDurableObject(lobbyStub(env), (_: LobbyDO, state) =>
      state.storage.put('active:gone-q', crypto.randomUUID()),
    )
    const q = await inLobby('gone-q')
    expect(await quickSit(q)).toMatchObject({ t: 'sit_at', tableId })
    expect(
      await runInDurableObject(lobbyStub(env), (_: LobbyDO, state) =>
        state.storage.get('active:gone-q'),
      ),
    ).toBeUndefined()
  })

  it('a listed table with players comes before an empty one the lobby opened', async () => {
    await fullTables(1)
    const empty = await sentTo(await inLobby('ord-a'))
    const withPlayers = await listed(4)
    expect(await sentTo(await inLobby('ord-b'))).toBe(withPlayers)
    expect(withPlayers).not.toBe(empty)
  })

  it('quick-sit neither offers nor counts an entry gone stale', async () => {
    await setLobbyClock(AT)
    const stale = await listed(3)
    await setLobbyClock(AT + REGISTRY_STALE_MS + 1)
    const q = await inLobby('stale-r')
    const opened = await sentTo(q)
    expect(opened).not.toBe(stale)
    expect(await createdOf(opened)).toMatchObject({ by: 'stale-r' })
  })

  it('a pairing pass that read the queue before a quick-sit does not pair that account', async () => {
    // Review B4. The first pairing's /init is held: the passes started by
    // two later queue requests read the queue (u in it) and wait behind
    // that pairing. u then quick-sits, which deletes its row without
    // waiting on them, and is sent to a six table.
    const init = holdInit(1)
    const real = (
      LobbyDO.prototype as unknown as { pairUp: () => Promise<void> }
    ).pairUp
    const passes = { started: 0, running: 0 }
    vi.spyOn(
      LobbyDO.prototype as unknown as { pairUp: () => Promise<void> },
      'pairUp',
    ).mockImplementation(async function (this: LobbyDO) {
      passes.started++
      passes.running++
      try {
        return await real.call(this)
      } finally {
        passes.running--
      }
    })
    const queued = (userId: string) =>
      runInDurableObject(
        lobbyStub(env),
        async (_: LobbyDO, state) =>
          (await state.storage.get(`queue:${userId}`)) !== undefined,
      )
    const [a, b, u, v] = [
      await inLobby('stale-pq-a'),
      await inLobby('stale-pq-b'),
      await inLobby('stale-pq-u'),
      await inLobby('stale-pq-v'),
    ]
    a.send({ t: 'queue', kind: 'hu-casual' })
    await a.next((f) => f.t === 'queued')
    b.send({ t: 'queue', kind: 'hu-casual' })
    await until('a and b are being paired', () => init.held() === 1)
    u.send({ t: 'queue', kind: 'hu-casual' })
    await until('u is queued', () => queued('stale-pq-u'))
    v.send({ t: 'queue', kind: 'hu-casual' })
    await until('v is queued', () => queued('stale-pq-v'))
    // a's pass ended; b's, u's and v's are running.
    await until('three passes wait', () => passes.running === 3)
    const answer = await quickSit(u)
    if (answer.t !== 'sit_at') throw new Error(JSON.stringify(answer))
    init.letGo()
    await a.next((f) => f.t === 'matched')
    await until('every pass ended', () => passes.running === 0)
    // u was not paired for heads-up, and sits where quick-sit sent it.
    expect(u.frames.filter((f) => f.t === 'matched')).toEqual([])
    init.restore()
    const there = await connect(answer.tableId, 'stale-pq-u')
    await there.next((f) => f.t === 'welcome')
    expect(await sit(there)).toMatchObject({ t: 'welcome', seat: 0 })
    // v still waits, alone.
    expect(await queued('stale-pq-v')).toBe(true)
    expect(v.frames.filter((f) => f.t === 'matched')).toEqual([])
  })
})

describe('quick-sit tries the next table', () => {
  it('quick-sit retries the next table on full', async () => {
    // Six sit at `full`; the lobby still lists it with a seat (its entry
    // lags: the throttle held the later sits), and it ranks first.
    const full = await tableWith(...[1, 2, 3, 4, 5, 6].map((n) => `full-${n}`))
    await lobbyStub(env).reportTable(full.matchId, counts(5))
    const next = await tableWith('next-a')
    const q = await inLobby('full-q')
    expect(await sentTo(q)).toBe(full.matchId)
    const there = await connect(full.matchId, 'full-q')
    await there.next((f) => f.t === 'welcome')
    expect(await sit(there)).toMatchObject({ t: 'error', code: 'table_full' })
    // Asked again with the table it tried: the next one, where it sits.
    expect(await sentTo(q, [full.matchId])).toBe(next.matchId)
    const seated = await connect(next.matchId, 'full-q')
    await seated.next((f) => f.t === 'welcome')
    expect(await sit(seated)).toMatchObject({ t: 'welcome', seat: 1 })
    // A table the client tried stays listed for everyone else: it is
    // alive, only full.
    expect(await listedIds()).toContain(full.matchId)
    expect(await entryOf(full.matchId)).toBeDefined()
    for (const f of q.frames) checkLobbyFrame(f)
  })

  it('quick-sit retries the next table on sit_cooldown', async () => {
    // cool-q sat at `cool` and stood up: it may not sit there again yet.
    const cool = await tableWith('cool-a', 'cool-b')
    const mine = await sitDown(cool.matchId, 'cool-q')
    const from = mine.frames.length
    mine.send({ t: 'stand' })
    await mine.next((f) => f.t === 'welcome' && f.seat === null, from)
    await lobbyStub(env).reportTable(cool.matchId, counts(4))
    const next = await tableWith('cool-n')
    const q = await inLobby('cool-q')
    expect(await sentTo(q)).toBe(cool.matchId)
    expect(await sit(mine)).toMatchObject({
      t: 'error',
      code: 'sit_cooldown',
    })
    expect(await sentTo(q, [cool.matchId])).toBe(next.matchId)
    expect(await listedIds()).toContain(cool.matchId)
  })

  it('quick-sit drops a table that answered closed, and retries the next', async () => {
    // `gone` deleted itself and its removal was lost: still listed.
    const gone = await listed(5)
    const next = await tableWith('closed-n')
    const q = await inLobby('closed-q')
    expect(await sentTo(q)).toBe(gone)
    const tried = await tryConnect(gone, 'closed-q')
    expect(await tried.closed).toEqual({ code: 4404, reason: 'closed' })
    expect(await sentTo(q, [gone])).toBe(next.matchId)
    // The lobby asked the table itself, and drops what is gone, for
    // everyone: no one else is sent there.
    expect(await entryOf(gone)).toBeUndefined()
    expect(await listedIds()).not.toContain(gone)
    expect(await sentTo(await inLobby('closed-r'))).toBe(next.matchId)
  })

  it('a quick-sit tries at most three listed tables, then opens one', async () => {
    const tried = [await listed(5), await listed(4), await listed(3)]
    const fourth = await listed(2)
    const q = await inLobby('three-q')
    expect(await sentTo(q, tried.slice(0, 2))).toBe(tried[2])
    // Three tried: not the fourth listed table, but a new one.
    const opened = await sentTo(q, tried)
    expect([...tried, fourth]).not.toContain(opened)
    expect(await createdOf(opened)).toMatchObject({ by: 'three-q' })
  })
})

describe('quick-sit asks only the tables it knows', () => {
  it('a tried id the lobby does not know is never asked; a known one is, once', async () => {
    const asked = vi.spyOn(TableDO.prototype, 'liveness')
    const known = await listed(5)
    const free = await listed(3)
    const q = await inLobby('wake-q')
    expect(await sentTo(q, [crypto.randomUUID()])).toBe(known)
    expect(asked).not.toHaveBeenCalled()
    expect(await sentTo(q, [known])).toBe(free)
    expect(asked).toHaveBeenCalledTimes(1)
  })

  it('a tried table whose liveness call fails stays listed, and the next is offered', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const busy = await listed(5)
    const free = await listed(3)
    vi.spyOn(TableDO.prototype, 'liveness').mockRejectedValue(new Error('x'))
    expect(await sentTo(await inLobby('err-q'), [busy])).toBe(free)
    expect(await entryOf(busy)).toBeDefined()
  })

  it("another account's empty table, tried, does not stop this account opening", async () => {
    // The one-unseated-table rule is the opener's own.
    await fullTables(1)
    const theirs = await sentTo(await inLobby('peer-a'))
    const b = await inLobby('peer-b')
    expect(await sentTo(b)).toBe(theirs)
    const mine = await sentTo(b, [theirs])
    expect(mine).not.toBe(theirs)
    expect(await createdOf(mine)).toMatchObject({ by: 'peer-b' })
  })

  it('an opened table that died with its removal lost is dropped, record and all, when tried', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await fullTables(1)
    const a = await inLobby('lost-a')
    const gone = await sentTo(a)
    // Nobody sits: the table deletes itself, and its removal is lost.
    const removal = vi
      .spyOn(LobbyDO.prototype, 'removeTable')
      .mockRejectedValue(new Error('lobby down'))
    await elapse(gone, IDLE_MS)
    await settled(gone)
    expect(removal).toHaveBeenCalled()
    removal.mockRestore()
    expect(await createdOf(gone)).toBeDefined()
    // Still its own unseated table, so it is sent there; tried, the table
    // answers that it is over, and its record goes with its entry.
    expect(await sentTo(a)).toBe(gone)
    const next = await sentTo(a, [gone])
    expect(next).not.toBe(gone)
    expect(await createdOf(gone)).toBeUndefined()
  })
})

describe('quick-sit opens a table', () => {
  it('opens an empty six table when no table has a free seat', async () => {
    const full = await fullTables(2)
    const q = await inLobby('open-q')
    const tableId = await sentTo(q)
    expect(full).not.toContain(tableId)
    // A real six-casual table, empty until the player sits.
    const client = await connect(tableId, 'open-q')
    const welcome = await client.next((f) => f.t === 'welcome')
    expect(welcome).toMatchObject({ seat: null })
    expect(
      (welcome as Extract<ServerMsg, { t: 'welcome' }>).table,
    ).toMatchObject({ kind: 'six-casual', players: [] })
    expect(await sit(client)).toMatchObject({ t: 'welcome', seat: 0 })
    // Counted against the cap, and toward the opener's daily creations.
    expect(await createdOf(tableId)).toMatchObject({
      by: 'open-q',
      ready: true,
    })
    const day = new Date().toISOString().slice(0, 10)
    expect(
      await runInDurableObject(lobbyStub(env), (_: LobbyDO, state) =>
        state.storage.get(`creates:${day}:open-q`),
      ),
    ).toBe(1)
  })

  it('an open the table refuses frees its place, gives the day back, and answers tables_full', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // The minted id is a table that exists: its /init answers 409.
    const taken = await sixTable()
    const q = await inLobby('fail-q')
    vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce(
      taken as ReturnType<typeof crypto.randomUUID>,
    )
    expect(await quickSit(q)).toMatchObject({
      t: 'error',
      code: 'tables_full',
    })
    expect(await createdIds()).toEqual([])
    expect((await createsOf('fail-q')) ?? 0).toBe(0)
    // Nothing holds the account: its next quick-sit opens a table.
    const opened = await sentTo(q)
    expect(opened).not.toBe(taken)
    expect(await createdIds()).toEqual([opened])
    expect(await createsOf('fail-q')).toBe(1)
    for (const f of q.frames) checkLobbyFrame(f)
  })

  it('two players who quick-sit at once at an empty lobby land at one table', async () => {
    // At once for real: A's open is held at the table's /init, which lets
    // other events into the lobby, and B asks meanwhile. B finds nothing
    // to offer but A's open in flight, and waits for it (review B1).
    const a = await inLobby('once-a')
    const b = await inLobby('once-b')
    const init = holdInit()
    const reads = watchListReads()
    const [fa, fb] = [a.frames.length, b.frames.length]
    a.send({ t: 'quick_sit' })
    await until('A opens a table', () => init.held() === 1)
    b.send({ t: 'quick_sit' })
    // B has read the list, so it has made its choice.
    await until('B reads the list', () => reads() >= 2)
    init.letGo()
    const [x, y] = await Promise.all([
      a.next(answered, fa),
      b.next(answered, fb),
    ])
    init.restore()
    if (x.t !== 'sit_at') throw new Error(`A: ${JSON.stringify(x)}`)
    const tableId = x.tableId
    expect(y).toMatchObject({ t: 'sit_at', tableId })
    expect(init.held()).toBe(1)
    const [ca, cb] = [
      await connect(tableId, 'once-a'),
      await connect(tableId, 'once-b'),
    ]
    await ca.next((f) => f.t === 'welcome')
    await cb.next((f) => f.t === 'welcome')
    await sit(ca)
    await sit(cb)
    await ca.next(isState(1))
    expect(await createdIds()).toEqual([tableId])
  })

  it('opens up to the cap of 50, then refuses with tables_full', async () => {
    expect(SIX_TABLES_MAX).toBe(50)
    // 50 tables, every seat taken: none opens.
    await fullTables(50)
    const q = await inLobby('cap-q')
    expect(await quickSit(q)).toMatchObject({
      t: 'error',
      code: 'tables_full',
    })
    expect(await createdIds()).toEqual([])
    for (const f of q.frames) checkLobbyFrame(f)
  })

  it('counts a table it opened once, listed or not', async () => {
    // 48 full tables and one the lobby opened, sat at and listed full: 49
    // tables, so one more opens; then a table nobody has sat at counts too.
    const full = await fullTables(48)
    const mine = await listed(6)
    await runInDurableObject(lobbyStub(env), (instance: LobbyDO, state) =>
      state.storage.put(`created:${mine}`, {
        at: instance.clock(),
        by: 'count-x',
        ready: true,
      }),
    )
    const q = await inLobby('count-q')
    const fiftieth = await sentTo(q)
    expect([...full, mine]).not.toContain(fiftieth)
    // 50 now: the opened table is tried and full, and no other opens.
    const r = await inLobby('count-r')
    expect(await quickSit(r, [fiftieth])).toMatchObject({
      t: 'error',
      code: 'tables_full',
    })
  })

  it('two concurrent quick-sits cannot overshoot the cap', async () => {
    await fullTables(SIX_TABLES_MAX - 1)
    const [a, b] = [await inLobby('race-a'), await inLobby('race-b')]
    // A opens the 50th, its /init held. B asks meanwhile, naming that
    // table as tried, so it has no table to be offered or to wait for
    // (review B1: a bare quick-sit now waits for A's, below): it must
    // count A's opening, written before the /init.
    const fiftieth = crypto.randomUUID()
    vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce(
      fiftieth as ReturnType<typeof crypto.randomUUID>,
    )
    const init = holdInit()
    const [fa, fb] = [a.frames.length, b.frames.length]
    a.send({ t: 'quick_sit' })
    await until('A opens a table', () => init.held() === 1)
    b.send({ t: 'quick_sit', tried: [fiftieth] })
    const refused = await b.next((f) => f.t === 'sit_at' || f.t === 'error', fb)
    init.letGo()
    const answers = await Promise.all([
      a.next((f) => f.t === 'sit_at' || f.t === 'error', fa),
      refused,
    ])
    init.restore()
    // One table opened, the 50th; the other quick-sit found the cap.
    expect(answers.map((f) => f.t).sort()).toEqual(['error', 'sit_at'])
    expect(answers.find((f) => f.t === 'error')).toMatchObject({
      code: 'tables_full',
    })
    expect(await createdIds()).toHaveLength(1)
    expect(answers[0]).toMatchObject({ t: 'sit_at', tableId: fiftieth })
  })

  it('two bare quick-sits at once at 49 tables both land at the 50th', async () => {
    // Review B1 at the cap: B, asking while A opens the 50th, is sent to
    // it once it is open, not told every table is full.
    await fullTables(SIX_TABLES_MAX - 1)
    const [a, b] = [await inLobby('both-a'), await inLobby('both-b')]
    const init = holdInit()
    const reads = watchListReads()
    const [fa, fb] = [a.frames.length, b.frames.length]
    a.send({ t: 'quick_sit' })
    await until('A opens a table', () => init.held() === 1)
    b.send({ t: 'quick_sit' })
    await until('B reads the list', () => reads() >= 2)
    init.letGo()
    const [x, y] = await Promise.all([
      a.next(answered, fa),
      b.next(answered, fb),
    ])
    init.restore()
    if (x.t !== 'sit_at') throw new Error(`A: ${JSON.stringify(x)}`)
    expect(y).toEqual({ t: 'sit_at', tableId: x.tableId, seq: y.seq })
    expect(await createdIds()).toEqual([x.tableId])
    expect(init.held()).toBe(1)
  })
})

describe('an open the lobby never finished', () => {
  // Review B2: a `created:` record that is not ready and not in flight was
  // left by an earlier instance of the lobby (a reset during /init), or by
  // an /init call that threw. Its table is asked what it is.
  it('a lobby reset during an open leaves the account free to quick-sit', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await fullTables(2)
    const init = holdInit()
    const q = await inLobby('reset-q')
    q.send({ t: 'quick_sit' })
    await until(
      'the open is recorded',
      async () => (await createdIds()).length === 1,
    )
    const [orphan] = await createdIds()
    expect(await createdOf(orphan)).toMatchObject({ ready: false })
    // The lobby restarts mid-open, then the table lets the init go.
    await abortAllDurableObjects()
    init.restore()
    init.letGo()
    const r = await inLobby('reset-q')
    const answer = await quickSit(r)
    expect(answer).toMatchObject({ t: 'sit_at' })
    if (answer.t !== 'sit_at') return
    // Whichever way the held init went, the record says so now: its
    // table exists and is offered, or is gone and so is the record.
    const record = await createdOf(orphan)
    if (answer.tableId === orphan) expect(record).toMatchObject({ ready: true })
    else expect(record).toBeUndefined()
    for (const f of r.frames) checkLobbyFrame(f)
  })

  it('a record whose table is open is offered; one whose table is gone stops counting', async () => {
    // Left by an earlier instance: an open whose table exists...
    const alive = await sixTable()
    // ...and one whose table was never made (or deleted itself).
    const gone = crypto.randomUUID()
    await runInDurableObject(
      lobbyStub(env),
      async (instance: LobbyDO, state) => {
        await state.storage.put(`created:${alive}`, {
          at: instance.clock(),
          by: 'orphan-x',
          ready: false,
        })
        await state.storage.put(`created:${gone}`, {
          at: instance.clock(),
          by: 'orphan-q',
          ready: false,
        })
      },
    )
    // 48 full tables and the two records: the cap, as counted before.
    await fullTables(SIX_TABLES_MAX - 2)
    const q = await inLobby('orphan-q')
    // The live one is offered (it is ready now); the dead one no longer
    // holds orphan-q to one unseated table, nor a place under the cap.
    expect(await sentTo(q)).toBe(alive)
    expect(await createdOf(alive)).toMatchObject({ ready: true })
    expect(await createdOf(gone)).toBeUndefined()
    const opened = await sentTo(q, [alive])
    expect([alive, gone]).not.toContain(opened)
    expect(await createdOf(opened)).toMatchObject({
      by: 'orphan-q',
      ready: true,
    })
  })

  it('an /init call that throws keeps its record and the day count until its table is asked', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const real = TableDO.prototype.fetch
    const thrown = vi
      .spyOn(TableDO.prototype, 'fetch')
      .mockImplementationOnce(async () => {
        throw new Error('connection reset')
      })
    const q = await inLobby('thrown-q')
    expect(await quickSit(q)).toMatchObject({
      t: 'error',
      code: 'tables_full',
    })
    // The table may exist: the record and the opening stay.
    const [kept] = await createdIds()
    expect(await createdOf(kept)).toMatchObject({
      by: 'thrown-q',
      ready: false,
    })
    expect(await createsOf('thrown-q')).toBe(1)
    thrown.mockImplementation(function (this: TableDO, request: Request) {
      return real.call(this, request)
    })
    // The next quick-sit asks it: never made, so the record goes, and the
    // account opens a table (the thrown one's opening is not given back).
    const opened = await sentTo(q)
    expect(opened).not.toBe(kept)
    expect(await createdIds()).toEqual([opened])
    expect(await createsOf('thrown-q')).toBe(2)
  })
})

describe('the cap releases', () => {
  it('when a table quick-sit opened deletes itself, nobody having sat there', async () => {
    await fullTables(SIX_TABLES_MAX - 1)
    const q = await inLobby('idle-q')
    const tableId = await sentTo(q)
    const r = await inLobby('idle-r')
    expect(await quickSit(r, [tableId])).toMatchObject({
      code: 'tables_full',
    })
    // Nobody sits: IDLE_MS on it deletes itself, and leaves the count.
    await elapse(tableId, IDLE_MS)
    await settled(tableId)
    expect(await createdOf(tableId)).toBeUndefined()
    const reopened = await sentTo(r, [tableId])
    expect(reopened).not.toBe(tableId)
  })

  it('when a table quick-sit opened halts', async () => {
    const q = await inLobby('halt-q')
    const tableId = await sentTo(q)
    await freezeClock(tableId)
    // Hand 2's plan names no players: the table halts at its deal.
    const cash = new CashController()
    await runInDurableObject(stub(tableId), (instance: TableDO) => {
      instance.sixController = {
        nextHandPlan: (n: number, config: MatchConfig, roster?: Roster) => {
          const plan = cash.nextHandPlan(n, config, roster)
          return plan && n === 2 ? { ...plan, users: undefined } : plan
        },
      }
    })
    const a = await sitDown(tableId, 'halt-q', 0)
    const b = await sitDown(tableId, 'halt-b', 3)
    await a.next(isState(1))
    await playOut(tableId, { 0: a, 3: b }, fold)
    await elapse(tableId, NEXT_HAND_MS)
    await a.next((f) => f.t === 'match_end')
    await eventually(async () => (await createdOf(tableId)) === undefined)
    await settled(tableId)
    expect(await createdOf(tableId)).toBeUndefined()
    expect(await entryOf(tableId)).toBeUndefined()
  })

  it('a table the lobby opened counts for 20 minutes, alive or not', async () => {
    expect(CREATED_MS).toBe(20 * 60_000)
    await setLobbyClock(AT)
    await fullTables(SIX_TABLES_MAX - 1)
    const fiftieth = await sentTo(await inLobby('life-a'))
    // IDLE_MS on, when nobody sitting there it would delete itself: still
    // counted, though another account has tried it.
    await setLobbyClock(AT + IDLE_MS)
    expect(await quickSit(await inLobby('life-b'), [fiftieth])).toMatchObject({
      t: 'error',
      code: 'tables_full',
    })
  })

  it('and a record whose removal was lost stops counting 20 minutes after the table opened', async () => {
    await setLobbyClock(AT)
    // An opening the lobby never heard the end of: its init never
    // answered, and no removal came. Its table cannot be asked either
    // (review B2 asks a table that can: see "an open the lobby never
    // finished"). It counts, and is offered to nobody.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(TableDO.prototype, 'liveness').mockRejectedValue(
      new Error('unreachable'),
    )
    const lost = crypto.randomUUID()
    await runInDurableObject(lobbyStub(env), (_: LobbyDO, state) =>
      state.storage.put(`created:${lost}`, {
        at: AT,
        by: 'lost-x',
        ready: false,
      }),
    )
    await setLobbyClock(AT + CREATED_MS)
    await fullTables(SIX_TABLES_MAX - 1)
    const q = await inLobby('lost-q')
    // Exactly 20 minutes on: still counted, so the cap is reached.
    expect(await quickSit(q)).toMatchObject({ code: 'tables_full' })
    // A moment later it no longer counts, and goes.
    await setLobbyClock(AT + CREATED_MS + 1)
    const opened = await sentTo(q)
    expect(opened).not.toBe(lost)
    expect(await createdOf(lost)).toBeUndefined()
  })
})

describe('abuse', () => {
  it('three tried tables are leave to open, never a ban on a seat', async () => {
    // Review B3. At the cap, three made-up tried ids (they count as tried
    // too) cannot hold a player away from a listed table with a free seat.
    await fullTables(SIX_TABLES_MAX - 1)
    const free = await listed(3)
    const q = await inLobby('ban-q')
    const madeUp = [
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
    ]
    expect(await quickSit(q, madeUp)).toMatchObject({
      t: 'sit_at',
      tableId: free,
    })
    expect(await createdIds()).toEqual([])
    for (const f of q.frames) checkLobbyFrame(f)
  })

  it('three tried tables and a table of its own still waiting: sent to its own', async () => {
    // Review B3: the account may not open a second unseated table, so the
    // one it has, which it has not tried, is offered.
    const tried = [
      (await tableWith('own-a')).matchId,
      (await tableWith('own-b')).matchId,
      (await tableWith('own-c')).matchId,
    ]
    const q = await inLobby('own-q')
    const mine = await sentTo(q, tried)
    expect(tried).not.toContain(mine)
    expect(await createdOf(mine)).toMatchObject({ by: 'own-q', ready: true })
    expect(await sentTo(q, tried)).toBe(mine)
    expect(await createdIds()).toEqual([mine])
  })

  it('a quick-sit whose claimed table cannot be asked is still answered', async () => {
    // Review B6: the claim is checked with its table, and that call can
    // throw. The client is told, so its seating ends.
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '))
    })
    const tableId = await sixTable()
    await runInDurableObject(lobbyStub(env), (_: LobbyDO, state) =>
      state.storage.put('active:throw-q', tableId),
    )
    vi.spyOn(TableDO.prototype, 'liveness').mockRejectedValue(
      new Error('reset'),
    )
    const q = await inLobby('throw-q')
    expect(await quickSit(q)).toEqual({
      t: 'error',
      code: 'tables_full',
      message: 'Could not check your table just now. Try again in a moment.',
      seq: expect.any(Number),
    })
    expect(
      errors.some(
        (line) =>
          line.includes('"reason":"quick_sit"') && line.includes('throw-q'),
      ),
    ).toBe(true)
    expect(await createdIds()).toEqual([])
    for (const f of q.frames) checkLobbyFrame(f)
  })

  it('the quick-sit budget holds two whole quick-sits of four requests', async () => {
    // Review B7: a whole quick-sit is a bare request and three retries.
    expect(QUICK_SITS).toBe(2 * (QUICK_SIT_TABLES + 1))
    expect(QUICK_SITS).toBe(8)
    await setLobbyClock(AT)
    // Three live tables, one player each (a sit after the first is held
    // by the report throttle), in the order quick-sit offers them.
    for (const user of ['whole-a', 'whole-b', 'whole-c']) await tableWith(user)
    const [t1, t2, t3] = await listedIds()
    const q = await inLobby('whole-q')
    let mine: string | null = null
    for (let round = 0; round < 2; round++) {
      expect(await sentTo(q)).toBe(t1)
      expect(await sentTo(q, [t1])).toBe(t2)
      expect(await sentTo(q, [t1, t2])).toBe(t3)
      // Three tried: it opens one, then is sent back to it.
      const last = await sentTo(q, [t1, t2, t3])
      expect([t1, t2, t3]).not.toContain(last)
      mine ??= last
      expect(last).toBe(mine)
    }
    expect(await quickSit(q, [t1])).toMatchObject({
      t: 'error',
      code: 'rate_limited',
    })
    for (const f of q.frames) checkLobbyFrame(f)
  })

  it('a lobby restart does not refill the quick-sit budget', async () => {
    // Review B7: a quiet lobby hibernates within seconds, and a budget
    // kept only in memory came back full.
    await setLobbyClock(AT)
    const tableId = await listed(3)
    const q = await inLobby('restart-q')
    for (let i = 0; i < QUICK_SITS; i++)
      expect(await quickSit(q)).toMatchObject({ t: 'sit_at', tableId })
    expect(await quickSit(q)).toMatchObject({ code: 'rate_limited' })
    await abortAllDurableObjects()
    await setLobbyClock(AT)
    const again = await inLobby('restart-q')
    expect(await quickSit(again)).toMatchObject({
      t: 'error',
      code: 'rate_limited',
    })
    // The window still refills it.
    await setLobbyClock(AT + QUICK_SIT_WINDOW_MS / QUICK_SITS)
    expect(await quickSit(again)).toMatchObject({ t: 'sit_at', tableId })
  })

  it('the stored quick-sit budget carries over midnight, and older days are pruned', async () => {
    const midnight = Date.UTC(2030, 2, 18)
    // A bucket left from three days before.
    const old = 'quicksit:2030-03-15:prune-x'
    await runInDurableObject(lobbyStub(env), (_: LobbyDO, state) =>
      state.storage.put(old, { tokens: 0, at: midnight - 3 * 86_400_000 }),
    )
    await setLobbyClock(midnight - 1)
    const tableId = await listed(3)
    const q = await inLobby('midnight-q')
    for (let i = 0; i < QUICK_SITS; i++)
      expect(await quickSit(q)).toMatchObject({ t: 'sit_at', tableId })
    // A new UTC day starts no new budget: yesterday's is read.
    await setLobbyClock(midnight + 1)
    expect(await quickSit(q)).toMatchObject({ code: 'rate_limited' })
    // Another account's first quick-sit of the day prunes days before
    // yesterday; yesterday's buckets stay.
    expect(await quickSit(await inLobby('midnight-r'))).toMatchObject({
      t: 'sit_at',
    })
    const keys = await runInDurableObject(
      lobbyStub(env),
      async (_: LobbyDO, state) => [
        ...(await state.storage.list({ prefix: 'quicksit:' })).keys(),
      ],
    )
    expect(keys.sort()).toEqual([
      'quicksit:2030-03-17:midnight-q',
      'quicksit:2030-03-18:midnight-r',
    ])
  })

  it('one account cannot open more than one table at a time', async () => {
    const a = await inLobby('one-a')
    const first = await sentTo(a)
    // Its own table, nobody seated yet, is where it is sent again...
    expect(await sentTo(a)).toBe(first)
    // ...and naming it as tried does not open a second.
    expect(await quickSit(a, [first])).toMatchObject({
      t: 'error',
      code: 'tables_full',
    })
    expect(await createdIds()).toEqual([first])
    // Once someone sits there, the account may open another.
    await sitDown(first, 'one-b')
    await settled(first)
    const second = await sentTo(a, [first])
    expect(second).not.toBe(first)
    expect((await createdIds()).sort()).toEqual([first, second].sort())
  })

  it('an opening counts toward the account daily creation cap', async () => {
    await fullTables(1)
    const day = new Date().toISOString().slice(0, 10)
    await runInDurableObject(lobbyStub(env), (_: LobbyDO, state) =>
      state.storage.put(`creates:${day}:daily-q`, MATCH_CREATES_PER_DAY),
    )
    const q = await inLobby('daily-q')
    expect(await quickSit(q)).toMatchObject({ code: 'tables_full' })
    expect(await createdIds()).toEqual([])
    // Another account still opens one.
    expect(await quickSit(await inLobby('daily-r'))).toMatchObject({
      t: 'sit_at',
    })
  })

  it('the per-account quick-sit rate limit holds', async () => {
    await setLobbyClock(AT)
    const tableId = await listed(3)
    const q = await inLobby('rate-q')
    for (let i = 0; i < QUICK_SITS; i++)
      expect(await quickSit(q)).toMatchObject({ t: 'sit_at', tableId })
    // One more within the window is refused, and the socket stays open:
    // a costly request, not a flood.
    expect(await quickSit(q)).toMatchObject({
      t: 'error',
      code: 'rate_limited',
    })
    expect(q.closed).toBeNull()
    // Others are not affected, and the budget refills with time.
    expect(await quickSit(await inLobby('rate-r'))).toMatchObject({
      t: 'sit_at',
    })
    await setLobbyClock(AT + 10_000)
    expect(await quickSit(q)).toMatchObject({ t: 'sit_at', tableId })
    expect(await quickSit(q)).toMatchObject({ code: 'rate_limited' })
    for (const f of q.frames) checkLobbyFrame(f)
  })
})

describe('the tables frame', () => {
  it('lists every listed six table as its id and four counts, nothing more', async () => {
    const three = await tableWith('row-ann', 'row-ben', 'row-cat')
    // The throttle held the later sits: 30 s on, the table reports all three.
    await elapse(three.matchId, REPORT_MS)
    await settled(three.matchId)
    const one = await tableWith('row-dan')
    // A table the lobby opened that nobody has sat at is not listed.
    const unseated = crypto.randomUUID()
    await runInDurableObject(lobbyStub(env), (instance: LobbyDO, state) =>
      state.storage.put(`created:${unseated}`, {
        at: instance.clock(),
        by: 'row-eve',
        ready: true,
      }),
    )
    const client = await inLobby('row-eve')
    client.send({ t: 'tables' })
    const frame = await client.next((f) => f.t === 'tables')
    if (frame.t !== 'tables') throw new Error('no tables frame')
    checkLobbyFrame(frame)
    for (const row of frame.tables) expectKeys(row, TABLE_ROW_KEYS, 'row')
    // Quick-sit's order, as tables() lists them: the fuller first. Each
    // row is the entry's four counts, copied by name.
    const rows = await runInDurableObject(lobbyStub(env), (instance: LobbyDO) =>
      instance.tables(),
    )
    expect(frame.tables).toEqual(
      rows.map(({ tableId, seated, maxSeats, avgPot, playersPerHour }) => ({
        tableId,
        seated,
        maxSeats,
        avgPot,
        playersPerHour,
      })),
    )
    expect(frame.tables.map((r) => r.tableId)).toEqual([
      three.matchId,
      one.matchId,
    ])
    expect(frame.tables[0]).toMatchObject({ seated: 3 })
    expect(frame.tables[1]).toEqual({
      tableId: one.matchId,
      seated: 1,
      maxSeats: 6,
      avgPot: null,
      playersPerHour: 0,
    })
    // No account, seated or asking, and nothing of the lobby's own.
    const json = JSON.stringify(frame)
    expect(json).not.toMatch(/row-|updatedAt|userId|username/)
  })

  it('the list goes to the socket that asked, no other', async () => {
    await listed(3)
    const other = await inLobby('only-b')
    const asker = await inLobby('only-a')
    expect(await tablesFrame(asker)).toHaveLength(1)
    // A later broadcast reaches `other` after anything sent before it.
    await inLobby('only-c')
    await other.next((f) => f.t === 'presence' && f.online === 3)
    expect(other.frames.some((f) => f.t === 'tables')).toBe(false)
  })

  it('the list leaves out an entry gone stale', async () => {
    await setLobbyClock(AT)
    await listed(3)
    await setLobbyClock(AT + REGISTRY_STALE_MS + 1)
    expect(await tablesFrame(await inLobby('stale-s'))).toEqual([])
  })

  it('the list holds full tables too, in quick-sit order whatever the ids', async () => {
    // Ids in the reverse of quick-sit's order: a free seat first, the
    // fullest first, full tables last.
    const five = await listed(5, 'ffffffff-0000-4000-8000-000000000000')
    const two = await listed(2, '00000000-0000-4000-8000-000000000000')
    const full = await listed(6, '11111111-0000-4000-8000-000000000000')
    const rows = await tablesFrame(await inLobby('order-q'))
    expect(rows.map((r) => [r.tableId, r.seated])).toEqual([
      [five, 5],
      [two, 2],
      [full, 6],
    ])
  })
})
