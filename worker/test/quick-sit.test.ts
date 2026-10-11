// Quick-sit and the list of six tables (P2-08b; ADR amendment 2026-10-10,
// "Table list and quick-sit", and its clarifications from PR-24). The lobby
// answers a quick-sit with the account's own table, or the fullest listed
// table with a free seat it has not tried, or a table it opens under a cap
// of 50; the client sits there and, refused (table_full, sit_cooldown, or
// the table closed), asks again naming the tables it tried. Tables run for
// real behind the lobby where a test sits at them; elsewhere the list is
// seeded with reports, as the lobby's own tests do.
import { env, runInDurableObject } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PlayerAction } from '../../src/engine/types'
import type {
  LobbyMsg,
  MatchConfig,
  ServerMsg,
} from '../../src/shared/protocol'
import { CashController } from '../src/controller'
import type { Roster } from '../src/controller'
import { IDLE_MS } from '../src/deadlines'
import { MATCH_CREATES_PER_DAY, QUICK_SITS } from '../src/limits'
import { CREATED_MS, lobbyStub, SIX_TABLES_MAX } from '../src/lobby'
import type { LobbyDO } from '../src/lobby'
import type { TableEntry, TableReport } from '../src/registry'
import { REPORT_MS } from '../src/registry'
import { NEXT_HAND_MS } from '../src/table'
import type { TableDO } from '../src/table'
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
async function listed(seated: number) {
  const tableId = crypto.randomUUID()
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

  it('two players who quick-sit at once at an empty lobby land at one table', async () => {
    const a = await inLobby('once-a')
    const b = await inLobby('once-b')
    const tableId = await sentTo(a)
    expect(await sentTo(b)).toBe(tableId)
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
    const [fa, fb] = [a.frames.length, b.frames.length]
    a.send({ t: 'quick_sit' })
    b.send({ t: 'quick_sit' })
    const answers = await Promise.all([
      a.next((f) => f.t === 'sit_at' || f.t === 'error', fa),
      b.next((f) => f.t === 'sit_at' || f.t === 'error', fb),
    ])
    // One table opened, the 50th; the other quick-sit found the cap.
    expect(answers.map((f) => f.t).sort()).toEqual(['error', 'sit_at'])
    expect(answers.find((f) => f.t === 'error')).toMatchObject({
      code: 'tables_full',
    })
    expect(await createdIds()).toHaveLength(1)
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

  it('and a record whose removal was lost stops counting 20 minutes after the table opened', async () => {
    await setLobbyClock(AT)
    // An opening the lobby never heard the end of: its init never
    // answered, and no removal came. It counts, and is offered to nobody.
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
})
