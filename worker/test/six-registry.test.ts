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
import type { TableEntry, TableReport } from '../src/registry'
import { NEXT_HAND_MS } from '../src/table'
import type { TableDO } from '../src/table'
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

/** Every report the lobby receives from now on, by table. */
function watchReports() {
  const spy = vi.spyOn(LobbyDO.prototype, 'reportTable')
  return (tableId: string) =>
    spy.mock.calls.filter(([id]) => id === tableId).map(([, r]) => r)
}

/**
 * Waits for every registry call the table has made to land: they are sent
 * without the table waiting on them, one after another.
 */
const settled = (matchId: string) =>
  runInDurableObject(stub(matchId), async (instance: TableDO) => {
    await (instance as unknown as { listingCalls?: Promise<unknown> })
      .listingCalls
  })

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
})

describe('leaving the list', () => {
  it('a table that deletes itself removes its entry', async () => {
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
    // with nobody seated (quick-sit may still send a player there).
    await elapse(matchId, IDLE_MS)
    await settled(matchId)
    expect(await entryOf(matchId)).toMatchObject(counts(0, 20, 2))
    // Then it deletes itself, and leaves the list.
    await elapse(matchId, IDLE_MS)
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

  it('a six table that halts leaves the list', async () => {
    // Hand 2's plan names no players: the table halts as an engine fault.
    const cash = new CashController()
    const matchId = await sixTable()
    await runInDurableObject(stub(matchId), (instance: TableDO) => {
      instance.sixController = {
        nextHandPlan: (
          handNo: number,
          config: MatchConfig,
          roster?: Roster,
        ) => {
          const plan = cash.nextHandPlan(handNo, config, roster)
          return plan && handNo === 2 ? { ...plan, users: undefined } : plan
        },
      }
    })
    const a = await sitDown(matchId, 'halt-reg-a', 0)
    const b = await sitDown(matchId, 'halt-reg-b', 3)
    await a.next(isState(1))
    await settled(matchId)
    expect(await entryOf(matchId)).toBeDefined()
    await playOut(matchId, { 0: a, 3: b }, fold)
    await elapse(matchId, NEXT_HAND_MS)
    await a.next((f) => f.t === 'match_end')
    await eventually(async () => (await entryOf(matchId)) === undefined)
  })

  it('a waiting table refreshes its entry at each idle check, so it never goes stale', async () => {
    const at = 1_900_000_000_000
    await setLobbyClock(at)
    const matchId = await sixTable()
    await sitDown(matchId, 'fresh-a', 0)
    await settled(matchId)
    expect(await entryOf(matchId)).toMatchObject({ seated: 1, updatedAt: at })
    // Nobody else comes for half an hour: three idle checks, each of
    // which keeps the table for its seated player and refreshes the entry.
    for (let i = 1; i <= 3; i++) {
      await setLobbyClock(at + i * IDLE_MS)
      await elapse(matchId, IDLE_MS)
      await settled(matchId)
      expect(await entryOf(matchId)).toMatchObject({
        seated: 1,
        updatedAt: at + i * IDLE_MS,
      })
    }
    expect((await listed()).map((t) => t.tableId)).toContain(matchId)
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
})

describe('restarts and sessions', () => {
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
  it('no client path lists or creates six tables yet', async () => {
    // A six table is on the list...
    const matchId = await sixTable()
    await sitDown(matchId, 'gate-a', 0)
    await eventually(async () => (await entryOf(matchId)) !== undefined)
    // ...but no route lists it (PR-24 adds GET /api/tables or a frame)...
    const route = await SELF.fetch(`${ORIGIN}/api/tables`, {
      headers: { Authorization: `Bearer ${token('gate-b')}` },
    })
    expect(route.status).toBe(404)
    // ...no lobby message asks for the list or queues for a six table...
    const client = await lobby('gate-b')
    await client.next((f) => f.t === 'presence')
    client.ws.send(JSON.stringify({ t: 'tables' }))
    expect(await client.next((f) => f.t === 'error')).toMatchObject({
      code: 'illegal',
    })
    const from = client.frames.length
    client.ws.send(JSON.stringify({ t: 'queue', kind: 'six-casual' }))
    expect(await client.next((f) => f.t === 'error', from)).toMatchObject({
      code: 'illegal',
    })
    // ...no lobby frame carries a table or its figures...
    expect(JSON.stringify(client.frames)).not.toContain(matchId)
    for (const f of client.frames) checkLobbyFrame(f)
    // ...and the invite route still makes heads-up tables only.
    const made = await createMatch('gate-c')
    expect(made.status).toBe(201)
    const { matchId: invite } = (await made.json()) as { matchId: string }
    const { match } = await peek(invite)
    expect((match as unknown as { config: { kind: string } }).config.kind).toBe(
      'hu-casual',
    )
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
