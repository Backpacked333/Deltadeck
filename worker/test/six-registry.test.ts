/// <reference types="vite/client" />
// The lobby's list of six tables (P2-08a; ADR amendment 2026-10-10, "Table
// list and quick-sit", and its clarifications from PR-23). A six table
// tells the lobby its seats, average pot and players per hour, counts only,
// at most once every 30 s of its clock and never on a hand's critical path;
// it leaves the list when it deletes itself. Heads-up tables never report.
// Every report is watched where it lands, on the lobby's own method.
import {
  abortAllDurableObjects,
  env,
  runInDurableObject,
  SELF,
} from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { legalActions } from '../../src/engine/hand'
import { CLOSE_GONE } from '../../src/shared/protocol'
import type { HandState, PlayerAction } from '../../src/engine/types'
import type { MatchConfig } from '../../src/shared/protocol'
import { CashController } from '../src/controller'
import type { Roster } from '../src/controller'
import { IDLE_MS } from '../src/deadlines'
import { LobbyDO, lobbyStub } from '../src/lobby'
import {
  newListing,
  noteHand,
  REGISTRY_ACCOUNTS,
  REGISTRY_WINDOW_MS,
  reportOf,
  REPORT_MS,
} from '../src/registry'
import type { Listing, TableEntry, TableReport } from '../src/registry'
import { NEXT_HAND_MS, SIT_OUT_MS, TableDO } from '../src/table'
import type { InitBody } from '../src/table'
import { checkLobbyFrame } from './frames'
import {
  connect,
  createMatch,
  createTable,
  elapse,
  eventually,
  freezeClock,
  isState,
  lobby,
  ORIGIN,
  peek,
  playOut,
  setClock,
  setLobbyClock,
  sitDown,
  sixTable,
  storageOf,
  stub,
  token,
} from './helpers'
import type { Client } from './helpers'

afterEach(() => vi.restoreAllMocks())

/** The Worker's own sources, for the exposure gate's routes. */
const workerSources = import.meta.glob<string>('../src/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
})

/** Every report the lobby receives from now on, by table. */
function watchReports() {
  const spy = vi.spyOn(LobbyDO.prototype, 'reportTable')
  return (tableId: string) =>
    spy.mock.calls.filter(([id]) => id === tableId).map(([, r]) => r)
}

/**
 * Waits for every registry call the table has made to land: they are sent
 * without the table waiting on them, one after another. Until none is
 * added while it waits, so a call made once an earlier one lands (as a
 * report sent after the removal would be) is waited for too.
 */
const settled = (matchId: string) =>
  runInDurableObject(stub(matchId), async (instance: TableDO) => {
    const table = instance as unknown as { listingCalls?: Promise<unknown> }
    for (let last; last !== table.listingCalls; ) {
      last = table.listingCalls
      await last
    }
  })

/**
 * A slow lobby, as the table sees it: every report the table sends waits
 * until the test lets them all go (`letGo`), then goes through. `seen`
 * counts the reports sent, and records, for each removal the table sends,
 * how many of its reports had not landed yet.
 */
async function slowLobby(matchId: string) {
  let letGo: () => void = () => {}
  // Made here, not in the table: a promise the table made could not be
  // resolved from the test (workerd's per-object I/O rule).
  const held = new Promise<void>((resolve) => (letGo = resolve))
  const seen = { reports: 0, inFlight: 0, inFlightAtRemoval: [] as number[] }
  await runInDurableObject(stub(matchId), (instance: TableDO) => {
    const real = env.LOBBY
    const lobbyOf = (id: DurableObjectId) => {
      const lobby = real.get(id, { locationHint: 'enam' })
      return {
        claim: (userId: string, table: string) => lobby.claim(userId, table),
        release: (userIds: string[], table: string) =>
          lobby.release(userIds, table),
        reportTable: async (tableId: string, report: TableReport) => {
          seen.reports++
          seen.inFlight++
          try {
            await held
            return await lobby.reportTable(tableId, report)
          } finally {
            seen.inFlight--
          }
        },
        removeTable: (tableId: string) => {
          seen.inFlightAtRemoval.push(seen.inFlight)
          return lobby.removeTable(tableId)
        },
      }
    }
    ;(instance as unknown as { env: typeof env }).env = {
      ...env,
      LOBBY: {
        idFromName: (name: string) => real.idFromName(name),
        get: lobbyOf,
      } as unknown as typeof env.LOBBY,
    }
  })
  return { letGo: () => letGo(), seen }
}

/** Every time the table asks to leave the lobby's list, by table. */
function watchUnlist() {
  const spy = vi.spyOn(
    TableDO.prototype as unknown as {
      unlist: (tableId: string) => Promise<boolean>
    },
    'unlist',
  )
  return (tableId: string) =>
    spy.mock.calls.filter(([id]) => id === tableId).length
}

/** Waits for `done` to hold, then asserts it does (named `what`). */
async function until(what: string, done: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 400 && !(await done()); i++)
    await new Promise((r) => setTimeout(r, 5))
  expect(await done(), what).toBe(true)
}

/**
 * `work`, which must not wait on the lobby: it fails, named `what`, if it
 * has not finished within 2 s (each step takes milliseconds).
 */
async function promptly<T>(what: string, work: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | null = null
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} waited on the lobby`)),
      2000,
    )
  })
  try {
    return await Promise.race([work, late])
  } finally {
    clearTimeout(timer)
  }
}

/** The table's clock now. */
const clockOf = (matchId: string) =>
  runInDurableObject(stub(matchId), (instance: TableDO) =>
    instance.clock(),
  ) as Promise<number>

/** What the table keeps for its entry, as stored. */
const listingOf = (matchId: string) =>
  runInDurableObject(stub(matchId), (_: TableDO, state) =>
    state.storage.get<Listing>('listing'),
  )

/** The lobby's stored entry for a table, if any. */
const entryOf = (tableId: string) =>
  runInDurableObject(lobbyStub(env), (_: LobbyDO, state) =>
    state.storage.get<TableEntry>(`table:${tableId}`),
  )

const listed = () =>
  runInDurableObject(lobbyStub(env), (instance: LobbyDO) => instance.tables())

/** The table the lobby holds `userId` at, if any. */
const lobbyHolds = (userId: string) =>
  runInDurableObject(lobbyStub(env), (_: LobbyDO, state) =>
    state.storage.get<string>(`active:${userId}`),
  )

const fold = (): PlayerAction => ({ type: 'fold' })
const passive = (hand: HandState): PlayerAction =>
  legalActions(hand).canCheck ? { type: 'check' } : { type: 'call' }
/** What a finished hand's winners were awarded. */
const potOf = (hand: HandState) =>
  hand.result!.awards.reduce((sum, a) => sum + a.amount, 0)

/** The next deal is due: the clock moves past the pause after a hand. */
async function dealNext(matchId: string, client: Client, handNo: number) {
  await elapse(matchId, NEXT_HAND_MS)
  await client.next(isState(handNo))
}

/** `client` stands up; resolves with the welcome that answers it. */
async function standUp(client: Client) {
  const from = client.frames.length
  client.send({ t: 'stand' })
  return client.next((f) => f.t === 'welcome', from)
}

/** Who holds a seat at the table now, as it stores them. */
async function seated(matchId: string) {
  const { match } = await peek(matchId)
  return (
    match as unknown as { players: { seat: number; standing?: boolean }[] }
  ).players
}

/** `client` sits out; resolves with the welcome that answers it. */
async function sitOut(client: Client) {
  const from = client.frames.length
  client.send({ t: 'sit_out' })
  return client.next((f) => f.t === 'welcome', from)
}

/** Hand 2's plan names no players: the table halts at its deal. */
async function haltAtHandTwo(matchId: string) {
  const cash = new CashController()
  await runInDurableObject(stub(matchId), (instance: TableDO) => {
    instance.sixController = {
      nextHandPlan: (handNo: number, config: MatchConfig, roster?: Roster) => {
        const plan = cash.nextHandPlan(handNo, config, roster)
        return plan && handNo === 2 ? { ...plan, users: undefined } : plan
      },
    }
  })
}

const counts = (
  seated: number,
  avgPot: number | null,
  playersPerHour: number,
): TableReport => ({ seated, maxSeats: 6, avgPot, playersPerHour })

describe('reporting to the lobby', () => {
  it('reports at most once per 30 s per table; a change held back goes out at the first alarm after', async () => {
    const sent = watchReports()
    const matchId = await sixTable()
    const a = await sitDown(matchId, 'th-a', 0)
    await settled(matchId)
    // The first change reports at once: a seat is taken.
    expect(sent(matchId)).toEqual([counts(1, null, 0)])
    // Inside the next 30 s two sits, a hand, a stand and an alarm (which
    // deals hand 2) each change the entry or could carry it: none writes.
    const b = await sitDown(matchId, 'th-b', 2)
    await a.next(isState(1))
    const c = await sitDown(matchId, 'th-c', 4)
    const seats = { 0: a, 2: b }
    await playOut(matchId, seats, fold)
    expect(await standUp(c)).toMatchObject({ seat: null })
    await elapse(matchId, REPORT_MS - 1)
    await a.next(isState(2))
    await settled(matchId)
    expect(sent(matchId)).toHaveLength(1)
    // The first alarm after the window sends the table as it is then, once.
    await elapse(matchId, 1)
    await settled(matchId)
    expect(sent(matchId)).toEqual([counts(1, null, 0), counts(2, 20, 2)])
    // Ten hands over the next 30 s of the table's clock: one more write,
    // at the alarm that opens the next window.
    for (let n = 2; n <= 11; n++) {
      await playOut(matchId, seats, fold)
      await dealNext(matchId, a, n + 1)
    }
    await settled(matchId)
    expect(sent(matchId)).toEqual([
      counts(1, null, 0),
      counts(2, 20, 2),
      counts(2, 20, 2),
    ])
  }, 30_000)

  it('avgPot and playersPerHour cover the hour before a report, and avgPot at most the last 20 hands', async () => {
    const sent = watchReports()
    const matchId = await sixTable()
    const a = await sitDown(matchId, 'win-a', 0)
    const b = await sitDown(matchId, 'win-b', 2)
    await a.next(isState(1))
    const c = await sitDown(matchId, 'win-c', 4)
    const clients = { 0: a, 2: b, 4: c }
    // Hand 1 (A and B) is folded: 20. Hand 2 deals C in, and is checked
    // down three ways: 60. Then C stands, and A and B fold 20 hands of 20.
    expect(potOf(await playOut(matchId, clients, fold))).toBe(20)
    await dealNext(matchId, a, 2)
    expect(potOf(await playOut(matchId, clients, passive))).toBe(60)
    await standUp(c)
    for (let n = 3; n <= 22; n++) {
      await dealNext(matchId, a, n)
      await playOut(matchId, clients, fold)
    }
    // B stands too; the table waits for a second player. The next report
    // averages the last 20 hands only (hand 2's 60 has dropped out), and
    // counts the three accounts dealt in this hour.
    await standUp(b)
    await elapse(matchId, REPORT_MS)
    await settled(matchId)
    expect(sent(matchId).at(-1)).toEqual(counts(1, 20, 3))
    // An hour on, the idle check refreshes the entry: no hand ended in the
    // hour before it, so no average and nobody dealt in.
    await elapse(matchId, REGISTRY_WINDOW_MS)
    await settled(matchId)
    expect(sent(matchId).at(-1)).toEqual(counts(1, null, 0))
    // C is back, and checks a hand down with A: 40, between the two of
    // them. B's last hand is more than an hour old.
    // (A new session's hand 1: its hand_start, since the welcome to the
    // sit still shows the last session's hand 1.)
    const back = await sitDown(matchId, 'win-c', 4)
    await back.next((f) => f.t === 'hand_start')
    expect(potOf(await playOut(matchId, { 0: a, 4: back }, passive))).toBe(40)
    await elapse(matchId, REPORT_MS)
    await settled(matchId)
    expect(sent(matchId).at(-1)).toEqual(counts(2, 40, 2))
  }, 60_000)

  it('what a table sends names no account: four counts', async () => {
    const sent = watchReports()
    await setLobbyClock(1_900_000_000_000)
    const matchId = await sixTable()
    const a = await sitDown(matchId, 'zed-anon-a', 0)
    const b = await sitDown(matchId, 'yan-anon-b', 2)
    await a.next(isState(1))
    await playOut(matchId, { 0: a, 2: b }, passive)
    await elapse(matchId, REPORT_MS)
    await settled(matchId)
    expect(sent(matchId)).toHaveLength(2)
    for (const r of sent(matchId)) {
      expect(Object.keys(r).sort()).toEqual([
        'avgPot',
        'maxSeats',
        'playersPerHour',
        'seated',
      ])
      expect(JSON.stringify(r)).not.toMatch(/anon/)
    }
    const entry = await entryOf(matchId)
    expect(Object.keys(entry!).sort()).toEqual([
      'avgPot',
      'maxSeats',
      'playersPerHour',
      'seated',
      'updatedAt',
    ])
    expect(JSON.stringify(entry)).not.toMatch(/anon/)
  })

  it('a stand between hands reports the seat it frees, with no change held', async () => {
    const sent = watchReports()
    const matchId = await sixTable()
    const a = await sitDown(matchId, 'free-a', 0)
    const b = await sitDown(matchId, 'free-b', 2)
    await a.next(isState(1))
    // 30 s on, hand 1 ends with a report due: it goes at once, and leaves
    // nothing held.
    await setClock(matchId, (await clockOf(matchId)) + REPORT_MS)
    await playOut(matchId, { 0: a, 2: b }, fold)
    await settled(matchId)
    expect(sent(matchId)).toEqual([counts(1, null, 0), counts(2, 20, 2)])
    expect(await listingOf(matchId)).toMatchObject({ pending: false })
    // 30 s more, before any alarm: A stands, and the stand itself reports.
    await setClock(matchId, (await clockOf(matchId)) + REPORT_MS)
    expect(await standUp(a)).toMatchObject({ seat: null })
    await settled(matchId)
    expect(sent(matchId).at(-1)).toEqual(counts(1, 20, 2))
  })

  it('a removal by the sitout alarm reports the seat it frees', async () => {
    const sent = watchReports()
    const matchId = await sixTable()
    const a = await sitDown(matchId, 'gone-a', 0)
    const b = await sitDown(matchId, 'gone-b', 2)
    await a.next(isState(1))
    await playOut(matchId, { 0: a, 2: b }, fold)
    // B sits out between hands; the next deal finds one player, and waits.
    await sitOut(b)
    await elapse(matchId, NEXT_HAND_MS)
    expect((await peek(matchId)).match.status).toBe('waiting')
    // The first alarm after the window sends what was held, and leaves
    // nothing held.
    await elapse(matchId, REPORT_MS)
    await settled(matchId)
    expect(sent(matchId).at(-1)).toEqual(counts(2, 20, 2))
    expect(await listingOf(matchId)).toMatchObject({ pending: false })
    // Five minutes after B sat out, the sitout alarm stands B up: a seat
    // freed, reported by the removal itself.
    await elapse(matchId, SIT_OUT_MS - NEXT_HAND_MS - REPORT_MS)
    expect((await seated(matchId)).map((p) => p.seat)).toEqual([0])
    await settled(matchId)
    expect(sent(matchId).at(-1)).toEqual(counts(1, 20, 2))
  })

  it('a change held at a waiting table goes out when its window passes, not at the idle check', async () => {
    // Quick-sit skips a table listed as full and ranks by the list, so a
    // waiting table may not keep a stale count until its idle check (ADR,
    // clarifications from PR-24, decision 6).
    const sent = watchReports()
    const matchId = await sixTable()
    const t0 = await clockOf(matchId)
    const a = await sitDown(matchId, 'held-a', 0)
    await settled(matchId)
    expect(sent(matchId)).toEqual([counts(1, null, 0)])
    // A stands at once: held, with the table waiting and empty. Its alarm
    // is the report's, 30 s after the last one, before the idle check.
    expect(await standUp(a)).toMatchObject({ seat: null })
    expect((await storageOf(matchId)).alarm).toBe(t0 + REPORT_MS)
    await elapse(matchId, REPORT_MS)
    await settled(matchId)
    expect(sent(matchId)).toEqual([counts(1, null, 0), counts(0, null, 0)])
    // A sit at the empty waiting table inside the next window is held
    // too, and arms the report itself.
    await setClock(matchId, t0 + REPORT_MS + 10_000)
    await sitDown(matchId, 'held-c', 2)
    await settled(matchId)
    expect(sent(matchId)).toHaveLength(2)
    expect((await storageOf(matchId)).alarm).toBe(t0 + 2 * REPORT_MS)
    await elapse(matchId, REPORT_MS - 10_000)
    await settled(matchId)
    expect(sent(matchId).at(-1)).toEqual(counts(1, null, 0))
    // Nothing held: the next alarm is the idle check, as before.
    expect(await listingOf(matchId)).toMatchObject({ pending: false })
    expect((await storageOf(matchId)).alarm).toBe(t0 + IDLE_MS)
  })

  it('seated counts a player who stood during a hand, until it ends', async () => {
    const sent = watchReports()
    const matchId = await sixTable()
    const a = await sitDown(matchId, 'mid-a', 0)
    const b = await sitDown(matchId, 'mid-b', 2)
    await a.next(isState(1))
    const c = await sitDown(matchId, 'mid-c', 4)
    await playOut(matchId, { 0: a, 2: b }, fold)
    await dealNext(matchId, a, 2)
    // C, dealt into hand 2, stands during it: the seat is C's until the
    // hand ends.
    expect(await standUp(c)).toMatchObject({ seat: 4 })
    expect((await seated(matchId)).map((p) => [p.seat, !!p.standing])).toEqual([
      [0, false],
      [2, false],
      [4, true],
    ])
    // After the window D sits, which reports: four seats are held.
    await setClock(matchId, (await clockOf(matchId)) + REPORT_MS)
    await sitDown(matchId, 'mid-d', 5)
    await settled(matchId)
    expect(sent(matchId).at(-1)).toEqual(counts(4, 20, 2))
  })

  it('a hand over at the deal counts in the figures', async () => {
    const sent = watchReports()
    const matchId = await sixTable()
    const a = await sitDown(matchId, 'deal-a', 0)
    const b = await sitDown(matchId, 'deal-b', 2)
    await a.next(isState(1))
    expect(potOf(await playOut(matchId, { 0: a, 2: b }, passive))).toBe(40)
    // Seat 2 keeps 10 chips: hand 2 makes it the small blind, all in as it
    // posts, and the hand is over at the deal, nobody acting (pot 20).
    await runInDurableObject(stub(matchId), (instance: TableDO) => {
      const { hand } = instance as unknown as { hand: HandState }
      const zero = hand.players.find((p) => p.seat === 0)!
      const two = hand.players.find((p) => p.seat === 2)!
      zero.stack += two.stack - 10
      two.stack = 10
    })
    await elapse(matchId, NEXT_HAND_MS)
    const two = (await peek(matchId)).hand!
    expect(two.config.handNo).toBe(2)
    expect(two.actions).toEqual([])
    expect(two.street).toBe('showdown')
    expect(potOf(two)).toBe(20)
    // After the window C sits, which reports before any other hand is
    // dealt (one that split hand 2's pot could deal hand 3 over at the
    // deal too): the average is over both hands, (40 + 20) / 2.
    await setClock(matchId, (await clockOf(matchId)) + REPORT_MS)
    await sitDown(matchId, 'deal-c', 4)
    await settled(matchId)
    expect(sent(matchId).at(-1)).toEqual(counts(3, 30, 2))
  })

  it('a heads-up table never reports, nor leaves a list it was never on', async () => {
    const sent = watchReports()
    const removed = vi.spyOn(LobbyDO.prototype, 'removeTable')
    const matchId = await createTable('hu-reg-a', 2)
    const a = await connect(matchId, 'hu-reg-a')
    const b = await connect(matchId, 'hu-reg-b')
    await a.next(isState(1))
    const seats = { 0: a, 1: b }
    await playOut(matchId, seats, fold)
    await dealNext(matchId, a, 2)
    await playOut(matchId, seats, passive)
    // Mid-match, two hands ended: the table keeps nothing for the list
    // (its storage is wiped at the end, which would hide a stray key).
    expect((await storageOf(matchId)).keys).not.toContain('listing')
    // A heads-up match ends at the deal after its last hand.
    await elapse(matchId, NEXT_HAND_MS)
    await a.next((f) => f.t === 'match_end')
    await freezeClock(matchId)
    await elapse(matchId, IDLE_MS)
    expect(await storageOf(matchId)).toEqual({ keys: [], alarm: null })
    expect(sent(matchId)).toEqual([])
    expect(removed.mock.calls.filter(([id]) => id === matchId)).toEqual([])
    expect(await entryOf(matchId)).toBeUndefined()
  })

  it('a rated heads-up table keeps nothing for the list either', async () => {
    const sent = watchReports()
    const matchId = crypto.randomUUID()
    const body: InitBody = {
      matchId,
      creator: { userId: 'hr-reg-a', username: 'hr-reg-a' },
      opponent: { userId: 'hr-reg-b', username: 'hr-reg-b' },
      kind: 'hu-rated',
    }
    const made = await stub(matchId).fetch('https://table/init', {
      method: 'POST',
      body: JSON.stringify(body),
    })
    expect(made.status).toBe(201)
    await freezeClock(matchId)
    const a = await connect(matchId, 'hr-reg-a')
    const b = await connect(matchId, 'hr-reg-b')
    await a.next(isState(1))
    const seats = { 0: a, 1: b }
    await playOut(matchId, seats, fold)
    await dealNext(matchId, a, 2)
    await playOut(matchId, seats, passive)
    expect((await storageOf(matchId)).keys).not.toContain('listing')
    await settled(matchId)
    expect(sent(matchId)).toEqual([])
    expect(await entryOf(matchId)).toBeUndefined()
  })
})

describe('leaving the list', () => {
  it('a table that deletes itself removes its entry', async () => {
    const removed = vi.spyOn(LobbyDO.prototype, 'removeTable')
    const removals = () => removed.mock.calls.filter(([id]) => id === matchId)
    const matchId = await sixTable()
    const a = await sitDown(matchId, 'del-a', 1)
    const b = await sitDown(matchId, 'del-b', 4)
    await a.next(isState(1))
    await playOut(matchId, { 1: a, 4: b }, fold)
    await standUp(a)
    await standUp(b)
    await elapse(matchId, NEXT_HAND_MS)
    expect((await peek(matchId)).match.status).toBe('waiting')
    // IDLE_MS on, the session ends; the table stays IDLE_MS more, listed
    // with nobody seated (quick-sit may still send a player there). The
    // session's end removes nothing, not even for a moment: the next
    // session is the same table, under the same id.
    await elapse(matchId, IDLE_MS)
    expect(
      ((await peek(matchId)).match as unknown as { sessionOver?: boolean })
        .sessionOver,
    ).toBe(true)
    await settled(matchId)
    expect(removals()).toEqual([])
    expect(await entryOf(matchId)).toMatchObject(counts(0, 20, 2))
    // Then it deletes itself, and leaves the list: once.
    await elapse(matchId, IDLE_MS)
    await settled(matchId)
    expect(await storageOf(matchId)).toEqual({ keys: [], alarm: null })
    expect(removals()).toEqual([[matchId]])
    expect(await entryOf(matchId)).toBeUndefined()
  })

  it('a report still on its way when the table deletes itself lands before the removal is sent', async () => {
    const unlisted = watchUnlist()
    const matchId = await sixTable()
    const lobby = await slowLobby(matchId)
    // The lobby has not answered the sit's report when the table, empty
    // again, deletes itself.
    await standUp(await sitDown(matchId, 'slow-del-a', 0))
    expect(lobby.seen.reports).toBe(1)
    const gone = elapse(matchId, IDLE_MS)
    await until(
      'the table asked to leave the list',
      () => unlisted(matchId) > 0,
    )
    // The removal waits for the report ahead of it: landing first, it
    // would be undone by the report, listing a table that is gone.
    expect(lobby.seen.inFlightAtRemoval).toEqual([])
    lobby.letGo()
    await gone
    await settled(matchId)
    expect(lobby.seen.inFlightAtRemoval).toEqual([0])
    expect(await storageOf(matchId)).toEqual({ keys: [], alarm: null })
    expect(await entryOf(matchId)).toBeUndefined()
  })

  it('a sit sent while the table deletes itself is closed with it: nobody is seated and wiped, and no report lists it again', async () => {
    // The lobby holds the removal until the test lets it go, so anything
    // the table lets in while the removal is on its way gets in.
    let letGo: () => void = () => {}
    const held = new Promise<void>((resolve) => (letGo = resolve))
    const remove = LobbyDO.prototype.removeTable
    const removed = vi
      .spyOn(LobbyDO.prototype, 'removeTable')
      .mockImplementation(async function (this: LobbyDO, tableId: string) {
        await held
        return remove.call(this, tableId)
      })
    const matchId = await sixTable()
    // A sat and stood (a held change), so the next sit reports at once.
    await standUp(await sitDown(matchId, 'gap-a', 0))
    const b = await connect(matchId, 'gap-b')
    const c = await connect(matchId, 'gap-c')
    await b.next((f) => f.t === 'welcome')
    await c.next((f) => f.t === 'welcome')
    // IDLE_MS with nobody seated: the idle check deletes the table. B and
    // C ask for seats once its removal has reached the lobby (two seated
    // would deal a hand), if their sockets are still open by then.
    const alarm = elapse(matchId, IDLE_MS)
    await eventually(async () =>
      removed.mock.calls.some(([id]) => id === matchId),
    )
    for (const [client, seat] of [
      [b, 1],
      [c, 3],
    ] as const)
      if (client.ws.readyState === WebSocket.READY_STATE_OPEN)
        client.send({ t: 'sit', seat })
    const seats = (client: Client) =>
      client.frames.flatMap((f) =>
        f.t === 'welcome' && f.seat !== null ? [f.seat] : [],
      )
    const answered = (client: Client) =>
      client.closed !== null || seats(client).length > 0
    await eventually(async () => answered(b) && answered(c))
    letGo()
    await alarm
    await settled(matchId)
    await eventually(async () => b.closed !== null && c.closed !== null)
    expect({
      seated: [...seats(b), ...seats(c)],
      claims: [await lobbyHolds('gap-b'), await lobbyHolds('gap-c')],
      closed: [b.closed?.code, c.closed?.code],
      table: await storageOf(matchId),
      entry: await entryOf(matchId),
    }).toEqual({
      seated: [],
      claims: [undefined, undefined],
      closed: [CLOSE_GONE, CLOSE_GONE],
      table: { keys: [], alarm: null },
      entry: undefined,
    })
  })

  it('a socket that arrives while the removal is on its way finds the table gone, and cannot sit', async () => {
    // As above, but the newcomer connects only once the removal is on its
    // way, after the table has closed the sockets it had: the table must
    // be gone by then, or the newcomer sits and is wiped with it.
    let letGo: () => void = () => {}
    const held = new Promise<void>((resolve) => (letGo = resolve))
    const remove = LobbyDO.prototype.removeTable
    const removed = vi
      .spyOn(LobbyDO.prototype, 'removeTable')
      .mockImplementation(async function (this: LobbyDO, tableId: string) {
        await held
        return remove.call(this, tableId)
      })
    const matchId = await sixTable()
    await standUp(await sitDown(matchId, 'late-a', 0))
    const alarm = elapse(matchId, IDLE_MS)
    await eventually(async () =>
      removed.mock.calls.some(([id]) => id === matchId),
    )
    const d = await connect(matchId, 'late-d')
    await eventually(
      async () => d.closed !== null || d.frames.some((f) => f.t === 'welcome'),
    )
    if (d.closed === null) {
      d.send({ t: 'sit', seat: 2 })
      await eventually(async () =>
        d.frames.some((f) => f.t === 'welcome' && f.seat !== null),
      )
    }
    letGo()
    await alarm
    await settled(matchId)
    expect({
      seated: d.frames.some((f) => f.t === 'welcome' && f.seat !== null),
      claim: await lobbyHolds('late-d'),
      closed: d.closed?.code,
      table: await storageOf(matchId),
      entry: await entryOf(matchId),
    }).toEqual({
      seated: false,
      claim: undefined,
      closed: CLOSE_GONE,
      table: { keys: [], alarm: null },
      entry: undefined,
    })
  })

  it('a six table that halts leaves the list', async () => {
    const removed = vi.spyOn(LobbyDO.prototype, 'removeTable')
    // Hand 2's plan names no players: the table halts as an engine fault.
    const matchId = await sixTable()
    await haltAtHandTwo(matchId)
    const a = await sitDown(matchId, 'halt-reg-a', 0)
    const b = await sitDown(matchId, 'halt-reg-b', 3)
    await a.next(isState(1))
    await settled(matchId)
    expect(await entryOf(matchId)).toBeDefined()
    await playOut(matchId, { 0: a, 3: b }, fold)
    await elapse(matchId, NEXT_HAND_MS)
    await a.next((f) => f.t === 'match_end')
    // The removal follows the lobby's release; once it is sent, whatever
    // the table sends to the list has landed, and the table is not on it.
    await eventually(async () =>
      removed.mock.calls.some(([id]) => id === matchId),
    )
    await settled(matchId)
    expect(await entryOf(matchId)).toBeUndefined()
  })

  it('a report still on its way when a six table halts lands before the removal is sent', async () => {
    const unlisted = watchUnlist()
    const matchId = await sixTable()
    await haltAtHandTwo(matchId)
    const lobby = await slowLobby(matchId)
    const a = await sitDown(matchId, 'slow-halt-a', 0)
    const b = await sitDown(matchId, 'slow-halt-b', 3)
    await a.next(isState(1))
    // 30 s on, hand 1 ends with a report due, behind the sit's that the
    // lobby has not answered; the next deal halts the table.
    await setClock(matchId, (await clockOf(matchId)) + REPORT_MS)
    await playOut(matchId, { 0: a, 3: b }, fold)
    await elapse(matchId, NEXT_HAND_MS)
    await a.next((f) => f.t === 'match_end')
    await until(
      'the table asked to leave the list',
      () => unlisted(matchId) > 0,
    )
    expect(lobby.seen.inFlightAtRemoval).toEqual([])
    lobby.letGo()
    await until(
      'the removal was sent',
      () => lobby.seen.inFlightAtRemoval.length > 0,
    )
    await settled(matchId)
    expect(lobby.seen.inFlightAtRemoval).toEqual([0])
    expect(await entryOf(matchId)).toBeUndefined()
  })

  it('a waiting table refreshes its entry at each idle check, so it never goes stale', async () => {
    const at = 1_900_000_000_000
    await setLobbyClock(at)
    const matchId = await sixTable()
    await sitDown(matchId, 'fresh-a', 0)
    await settled(matchId)
    expect(await entryOf(matchId)).toMatchObject({ seated: 1, updatedAt: at })
    const ids = async () => (await listed()).map((t) => t.tableId)
    // Nobody else comes for half an hour: three idle checks, each of
    // which keeps the table for its seated player and refreshes the entry.
    // Just before each, the entry is nearly IDLE_MS old, and listed.
    for (let i = 1; i <= 3; i++) {
      await setLobbyClock(at + i * IDLE_MS - 1)
      expect(await ids()).toContain(matchId)
      await setLobbyClock(at + i * IDLE_MS)
      await elapse(matchId, IDLE_MS)
      await settled(matchId)
      expect(await entryOf(matchId)).toMatchObject({
        seated: 1,
        updatedAt: at + i * IDLE_MS,
      })
    }
    expect(await ids()).toContain(matchId)
    // One idle check of slack: with the next one missed (an alarm a whole
    // IDLE_MS late), the table is still listed 20 minutes after its last
    // refresh, and taken for dead only after that.
    const last = at + 3 * IDLE_MS
    await setLobbyClock(last + 20 * 60_000)
    expect(await ids()).toContain(matchId)
    await setLobbyClock(last + 20 * 60_000 + 1)
    expect(await ids()).not.toContain(matchId)
  })
})

describe('when the lobby fails', () => {
  it('a report the lobby refuses stops neither the hand nor the table, and is sent again', async () => {
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '))
    })
    const refuse = vi
      .spyOn(LobbyDO.prototype, 'reportTable')
      .mockRejectedValue(new Error('lobby down'))
    const matchId = await sixTable()
    const a = await sitDown(matchId, 'down-a', 0)
    const b = await sitDown(matchId, 'down-b', 2)
    const seats = { 0: a, 2: b }
    await a.next(isState(1))
    // 30 s on, hand 1 ends with a report due. The lobby refuses it, as it
    // refused the sit's, and the next hand is dealt regardless.
    const t = (await runInDurableObject(stub(matchId), (i: TableDO) =>
      i.clock(),
    )) as number
    await setClock(matchId, t + REPORT_MS)
    expect(potOf(await playOut(matchId, seats, fold))).toBe(20)
    await dealNext(matchId, a, 2)
    await settled(matchId)
    expect(refuse).toHaveBeenCalledTimes(2)
    expect(
      errors.some((line) => line.includes('"reason":"lobby_report"')),
    ).toBe(true)
    expect((await peek(matchId)).match.status).toBe('playing')
    // The lobby is back. Nothing has changed since the refused report, but
    // it is sent again at the first alarm after the window.
    refuse.mockRestore()
    await elapse(matchId, REPORT_MS)
    await settled(matchId)
    expect(await entryOf(matchId)).toMatchObject(counts(2, 20, 2))
    // And the table plays on.
    await playOut(matchId, seats, passive)
    await dealNext(matchId, a, 3)
  })

  it('a report the lobby refuses is still sent again after the table restarts', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const refuse = vi
      .spyOn(LobbyDO.prototype, 'reportTable')
      .mockRejectedValue(new Error('lobby down'))
    // A sits alone at a new table: the sit's report goes at once, and the
    // lobby refuses it. A quiet table like this one is soon evicted from
    // memory, so the retry must be in its storage, not only in memory.
    const matchId = await sixTable()
    await sitDown(matchId, 'evict-a', 0)
    await settled(matchId)
    expect(refuse).toHaveBeenCalledTimes(1)
    await eventually(async () => (await listingOf(matchId))?.pending === true)
    const t = (await runInDurableObject(stub(matchId), (i: TableDO) =>
      i.clock(),
    )) as number
    await abortAllDurableObjects()
    await freezeClock(matchId, t)
    // The lobby is back: the first alarm after the window sends the table
    // as it is, long before its idle check would.
    refuse.mockRestore()
    await elapse(matchId, REPORT_MS)
    await settled(matchId)
    expect(await entryOf(matchId)).toMatchObject(counts(1, null, 0))
  })

  it('a lobby that does not answer holds up no alarm, deal or hand', async () => {
    const matchId = await sixTable()
    const lobby = await slowLobby(matchId)
    const a = await sitDown(matchId, 'mute-a', 0)
    const b = await sitDown(matchId, 'mute-b', 2)
    const seats = { 0: a, 2: b }
    await a.next(isState(1))
    // The lobby does not answer the sit's report, and every later report
    // waits behind it. 30 s on, hand 1 ends with a report due.
    await setClock(matchId, (await clockOf(matchId)) + REPORT_MS)
    await promptly('hand 1', playOut(matchId, seats, fold))
    await promptly('the alarm that deals hand 2', elapse(matchId, NEXT_HAND_MS))
    await a.next(isState(2))
    // Hand 2 ends inside the window, held; 30 s on, the alarm that deals
    // hand 3 sends it, and completes all the same.
    await promptly('hand 2', playOut(matchId, seats, fold))
    await setClock(matchId, (await clockOf(matchId)) + REPORT_MS)
    await promptly('the alarm that deals hand 3', elapse(matchId, NEXT_HAND_MS))
    await a.next(isState(3))
    expect((await peek(matchId)).match.status).toBe('playing')
    expect(lobby.seen.reports).toBe(1)
    // The lobby answers: what was sent lands, in order.
    lobby.letGo()
    await settled(matchId)
    expect(await entryOf(matchId)).toMatchObject(counts(2, 20, 2))
  })
})

describe('restarts and sessions', () => {
  it('a restart right after a report sent at once keeps the hand it reported, and the throttle', async () => {
    const sent = watchReports()
    const matchId = await sixTable()
    const a = await sitDown(matchId, 'now-a', 0)
    const b = await sitDown(matchId, 'now-b', 2)
    await a.next(isState(1))
    // 30 s on, hand 1 ends (20) with a report due: it goes at once.
    await setClock(matchId, (await clockOf(matchId)) + REPORT_MS)
    expect(potOf(await playOut(matchId, { 0: a, 2: b }, fold))).toBe(20)
    await settled(matchId)
    expect(sent(matchId)).toEqual([counts(1, null, 0), counts(2, 20, 2)])
    // The object restarts; both players are back 10 s later, and hand 2
    // is dealt and checked down (40).
    const t = await clockOf(matchId)
    await abortAllDurableObjects()
    await freezeClock(matchId, t + 10_000)
    const a2 = await connect(matchId, 'now-a')
    const b2 = await connect(matchId, 'now-b')
    await a2.next((f) => f.t === 'welcome')
    await b2.next((f) => f.t === 'welcome')
    await elapse(matchId, 0)
    await a2.next(isState(2))
    expect(potOf(await playOut(matchId, { 0: a2, 2: b2 }, passive))).toBe(40)
    // 10 s after hand 1's report, hand 2's end is held...
    await settled(matchId)
    expect(sent(matchId)).toHaveLength(2)
    // ...until the window opens; that report averages both hands.
    await elapse(matchId, REPORT_MS)
    await settled(matchId)
    expect(sent(matchId)).toEqual([
      counts(1, null, 0),
      counts(2, 20, 2),
      counts(2, 30, 2),
    ])
  })

  it('a restart keeps the 30 s throttle and the hour of figures', async () => {
    const sent = watchReports()
    const matchId = await sixTable()
    const a = await sitDown(matchId, 'rr-a', 0)
    const b = await sitDown(matchId, 'rr-b', 2)
    await a.next(isState(1))
    await playOut(matchId, { 0: a, 2: b }, fold)
    // The window's alarm deals hand 2 and reports hand 1.
    await elapse(matchId, REPORT_MS)
    await settled(matchId)
    expect(sent(matchId).at(-1)).toEqual(counts(2, 20, 2))
    const t = (await runInDurableObject(stub(matchId), (i: TableDO) =>
      i.clock(),
    )) as number
    // Hand 2 is checked down (40), then the object restarts; both players
    // come back 10 s later.
    expect(potOf(await playOut(matchId, { 0: a, 2: b }, passive))).toBe(40)
    await abortAllDurableObjects()
    await freezeClock(matchId, t + 10_000)
    const a2 = await connect(matchId, 'rr-a')
    await connect(matchId, 'rr-b')
    await a2.next((f) => f.t === 'welcome')
    // An alarm inside the window deals hand 3: hand 2's end is still held.
    await elapse(matchId, 10_000)
    await a2.next(isState(3))
    await settled(matchId)
    expect(sent(matchId)).toHaveLength(2)
    // The window opens: the held report goes out, its average over both
    // hands, the one before the restart included.
    await elapse(matchId, REPORT_MS - 20_000)
    await settled(matchId)
    expect(sent(matchId)).toEqual([
      counts(1, null, 0),
      counts(2, 20, 2),
      counts(2, 30, 2),
    ])
  })

  it('a session rotation keeps the entry and its figures under the table id', async () => {
    const sent = watchReports()
    const matchId = await sixTable()
    const a = await sitDown(matchId, 'rot-a', 0)
    const b = await sitDown(matchId, 'rot-b', 2)
    await a.next(isState(1))
    await playOut(matchId, { 0: a, 2: b }, fold)
    // B stands; the table waits, and IDLE_MS on its session ends (the idle
    // check that ends it refreshes the entry).
    await standUp(b)
    await elapse(matchId, NEXT_HAND_MS)
    await elapse(matchId, IDLE_MS)
    const { match } = await peek(matchId)
    expect(match as unknown as { sessionOver?: boolean }).toMatchObject({
      sessionOver: true,
    })
    await settled(matchId)
    expect(sent(matchId).at(-1)).toEqual(counts(1, 20, 2))
    // C sits: the next session deals its hand 1, which A and C check down.
    const c = await sitDown(matchId, 'rot-c', 4)
    await c.next((f) => f.t === 'hand_start')
    expect(potOf(await playOut(matchId, { 0: a, 4: c }, passive))).toBe(40)
    await elapse(matchId, REPORT_MS)
    await settled(matchId)
    // The same entry, its figures over both sessions: B's hand counts.
    const { sessionId } = (await peek(matchId)).match as unknown as {
      sessionId: string
    }
    expect(sessionId).not.toBe(matchId)
    expect(sent(matchId).at(-1)).toEqual(counts(2, 30, 3))
    expect(sent(sessionId)).toEqual([])
    expect(await entryOf(sessionId)).toBeUndefined()
    expect(await entryOf(matchId)).toMatchObject(counts(2, 30, 3))
  })
})

describe('the exposure gate', () => {
  // PR-24 opens it, through the lobby socket only: quick-sit, and the list
  // (ADR, clarifications from PR-24). Everything else stays shut.
  it('quick-sit and the tables frame are the only client paths to six tables', async () => {
    // A six table is on the list...
    const matchId = await sixTable()
    await sitDown(matchId, 'gate-a', 0)
    await eventually(async () => (await entryOf(matchId)) !== undefined)
    const client = await lobby('gate-b')
    await client.next((f) => f.t === 'presence')
    // ...which no lobby frame names until the list is asked for...
    expect(JSON.stringify(client.frames)).not.toContain(matchId)
    // ...and then as its id and four counts, to that socket alone.
    client.send({ t: 'tables' })
    expect(await client.next((f) => f.t === 'tables')).toEqual({
      t: 'tables',
      seq: expect.any(Number),
      tables: [
        {
          tableId: matchId,
          seated: 1,
          maxSeats: 6,
          avgPot: null,
          playersPerHour: 0,
        },
      ],
    })
    // Quick-sit sends a player to it, and opens a six table only when no
    // listed table has a seat for them: an empty six-casual table.
    let from = client.frames.length
    client.send({ t: 'quick_sit' })
    expect(await client.next((f) => f.t === 'sit_at', from)).toMatchObject({
      tableId: matchId,
    })
    from = client.frames.length
    client.send({ t: 'quick_sit', tried: [matchId] })
    const opened = await client.next((f) => f.t === 'sit_at', from)
    if (opened.t !== 'sit_at') throw new Error('no table opened')
    expect(opened.tableId).not.toBe(matchId)
    const { match } = await peek(opened.tableId)
    expect(match).toMatchObject({
      config: { kind: 'six-casual' },
      players: [],
      status: 'waiting',
    })
    for (const f of client.frames) checkLobbyFrame(f)
  })

  it('every other path to a six table stays shut', async () => {
    // No route lists six tables: the list is a lobby frame.
    const route = await SELF.fetch(`${ORIGIN}/api/tables`, {
      headers: { Authorization: `Bearer ${token('gate-b')}` },
    })
    expect(route.status).toBe(404)
    // The heads-up queue still refuses six-casual.
    const client = await lobby('gate-b')
    await client.next((f) => f.t === 'presence')
    client.ws.send(JSON.stringify({ t: 'queue', kind: 'six-casual' }))
    expect(await client.next((f) => f.t === 'error')).toMatchObject({
      code: 'illegal',
    })
    for (const f of client.frames) checkLobbyFrame(f)
    // The invite route still makes heads-up tables only...
    const made = await createMatch('gate-c')
    expect(made.status).toBe(201)
    const { matchId: invite } = (await made.json()) as { matchId: string }
    const { match } = await peek(invite)
    expect((match as unknown as { config: { kind: string } }).config.kind).toBe(
      'hu-casual',
    )
    // ...and no route of the Worker names a six table: only the lobby and
    // the invite route call a table's /init, and the routes never with
    // that kind. The lobby's pairing and rematch take heads-up kinds only
    // (HeadsUpKind), so its one six-casual /init is quick-sit's.
    const callers = Object.entries(workerSources)
      .filter(([, src]) => src.includes('https://table/init'))
      .map(([path]) => path)
    expect(callers.sort()).toEqual(['../src/index.ts', '../src/lobby.ts'])
    expect(workerSources['../src/index.ts']).not.toContain('six-casual')
    // The table's own init still refuses a six table with an opponent or
    // a start deadline, the shape a pairing would give it.
    for (const extra of [
      { opponent: { userId: 'gate-d', username: 'gate-d' } },
      { startWithinMs: 30_000 },
    ]) {
      const matchId = crypto.randomUUID()
      const body: InitBody = {
        matchId,
        creator: { userId: 'gate-c', username: 'gate-c' },
        kind: 'six-casual',
        ...extra,
      }
      const refused = await stub(matchId).fetch('https://table/init', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      expect(refused.status).toBe(400)
      expect(await storageOf(matchId)).toEqual({ keys: [], alarm: null })
    }
  })
})

describe('the figures', () => {
  it('playersPerHour counts each account once, at most 100, the oldest dropped first', () => {
    const listing = newListing()
    noteHand(listing, 1000, 25, ['a', 'b'])
    noteHand(listing, 2000, 30, ['a', 'c'])
    // Two hands of 25 and 30: 27.5 rounds to 28. Three accounts, not four.
    expect(reportOf(listing, 2000, 3, 6)).toEqual(counts(3, 28, 3))
    for (let i = 0; i < 120; i++) noteHand(listing, 3000 + i, 20, [`u${i}`])
    expect(reportOf(listing, 3200, 3, 6).playersPerHour).toBe(REGISTRY_ACCOUNTS)
    expect(Object.keys(listing.seen)).toHaveLength(REGISTRY_ACCOUNTS)
    expect(listing.seen).not.toHaveProperty('a')
    expect(listing.seen).toHaveProperty('u119')
    expect(listing.seen).not.toHaveProperty('u19')
    expect(listing.seen).toHaveProperty('u20')
  })

  it('a hand counts for the hour after it ends, to the millisecond', () => {
    const listing = newListing()
    noteHand(listing, 1000, 40, ['a', 'b'])
    expect(reportOf(listing, 1000 + REGISTRY_WINDOW_MS, 2, 6)).toEqual(
      counts(2, 40, 2),
    )
    expect(reportOf(listing, 1001 + REGISTRY_WINDOW_MS, 2, 6)).toEqual(
      counts(2, null, 0),
    )
  })
})
