// Quick-match: the queue, pairing, the one-table rule, the pair limiter and
// no-shows. Players are dev accounts; tables run for real behind the lobby.
import {
  abortAllDurableObjects,
  env,
  runDurableObjectAlarm,
  runInDurableObject,
  SELF,
} from 'cloudflare:test'
import { afterEach, describe, expect, it } from 'vitest'
import { legalActions } from '../../src/engine/hand'
import type { HandState, PlayerAction } from '../../src/engine/types'
import type { LobbyMsg } from '../../src/shared/protocol'
import { lobbyStub, REPAIR_MS, START_WITHIN_MS } from '../src/lobby'
import type { LobbyDO } from '../src/lobby'
import { REGISTRY_STALE_MS, REPORT_MS } from '../src/registry'
import type { TableEntry, TableReport } from '../src/registry'
import { NEXT_HAND_MS } from '../src/table'
import { checkLobbyFrame, LOBBY_FRAME_KEYS } from './frames'
import {
  connect,
  createTable,
  elapse,
  eventually,
  freezeClock,
  isState,
  lobby,
  ORIGIN,
  peek,
  playOut,
  setLobbyClock,
  sitDown,
  sixTable,
  token,
  tryConnect,
} from './helpers'
import type { LobbyClient } from './helpers'

const matched = (f: LobbyMsg) => f.t === 'matched'
const idOf = (f: LobbyMsg) => (f.t === 'matched' ? f.matchId : '')

async function queue(client: LobbyClient) {
  client.send({ t: 'queue', kind: 'hu-casual' })
}

/** Two players queue and are paired; returns the table they were sent to. */
async function pair(a: string, b: string) {
  const [la, lb] = [await lobby(a), await lobby(b)]
  await queue(la)
  await la.next((f) => f.t === 'queued')
  await queue(lb)
  const [ma, mb] = [await la.next(matched), await lb.next(matched)]
  expect(idOf(ma)).toBe(idOf(mb))
  return { matchId: idOf(ma), la, lb }
}

/** Lets a paired table's start window pass with nobody there. */
async function expire(matchId: string) {
  await freezeClock(matchId)
  await elapse(matchId, START_WITHIN_MS)
}

const lobbyTables = () =>
  runInDurableObject(lobbyStub(env), (instance: LobbyDO) => instance.tables())

const lobbyState = () =>
  runInDurableObject(lobbyStub(env), async (instance: LobbyDO) => {
    const state = (instance as unknown as { ctx: DurableObjectState }).ctx
    return Object.fromEntries(await state.storage.list())
  })

describe('the queue', () => {
  it('pairs two waiting players at one new table, both seated', async () => {
    const { matchId, la } = await pair('alice', 'bob')
    expect(matchId).toMatch(/^[0-9a-f-]{36}$/)
    const { match } = await peek(matchId)
    expect(match.status).toBe('waiting')
    // The first hand deals once both open the table.
    const alice = await connect(matchId, 'alice')
    await connect(matchId, 'bob')
    await alice.next(isState(1))
    // Nobody is left waiting.
    const presence = await la.next(
      (f) => f.t === 'presence' && f.queued === 0,
      la.frames.findIndex(matched),
    )
    expect(presence).toMatchObject({ online: 2, queued: 0 })
    const stored = await lobbyState()
    expect(stored['active:alice']).toBe(matchId)
    expect(stored['active:bob']).toBe(matchId)
  })

  it('tells a waiting player their place and everyone the counts', async () => {
    const alice = await lobby('alice')
    await queue(alice)
    expect(await alice.next((f) => f.t === 'queued')).toMatchObject({
      position: 1,
    })
    const carol = await lobby('carol')
    expect(
      await carol.next((f) => f.t === 'presence' && f.online === 2),
    ).toMatchObject({ online: 2, queued: 1 })
  })

  it('drops a player who cancels or leaves', async () => {
    const alice = await lobby('alice')
    const carol = await lobby('carol')
    await queue(alice)
    await carol.next((f) => f.t === 'presence' && f.queued === 1)
    let from = carol.frames.length
    alice.send({ t: 'dequeue' })
    await carol.next((f) => f.t === 'presence' && f.queued === 0, from)

    await queue(alice)
    await carol.next((f) => f.t === 'presence' && f.queued === 1)
    from = carol.frames.length
    alice.ws.close(1000)
    await carol.next(
      (f) => f.t === 'presence' && f.queued === 0 && f.online === 1,
      from,
    )
    expect(
      Object.keys(await lobbyState()).some((k) => k.startsWith('queue:')),
    ).toBe(false)
  })

  it('forgets waiting players whose sockets did not survive a restart', async () => {
    const alice = await lobby('alice')
    await queue(alice)
    await alice.next((f) => f.t === 'queued')
    await abortAllDurableObjects()
    const carol = await lobby('carol')
    expect(await carol.next((f) => f.t === 'presence')).toMatchObject({
      queued: 0,
    })
  })

  it('refuses a lobby socket without an account or with an old protocol', async () => {
    const url = `${ORIGIN}/ws/lobby`
    const bare = await SELF.fetch(url, {
      headers: {
        Upgrade: 'websocket',
        Origin: ORIGIN,
        'Sec-WebSocket-Protocol': 'qp.v1',
      },
    })
    expect(bare.status).toBe(401)
    const old = await SELF.fetch(url, {
      headers: {
        Upgrade: 'websocket',
        Origin: ORIGIN,
        'Sec-WebSocket-Protocol': `qp.v0, bearer.${token('a')}`,
      },
    })
    expect(old.status).toBe(426)
  })
})

describe('one active table per account', () => {
  it('sends a player who queues again back to their table', async () => {
    const { matchId, la } = await pair('alice', 'bob')
    const from = la.frames.length
    await queue(la)
    expect(await la.next(matched, from)).toMatchObject({
      matchId,
      resumed: true,
    })
  })

  it('will not open an invite table while playing, and says which table', async () => {
    const { matchId } = await pair('alice', 'bob')
    const busy = await SELF.fetch(`${ORIGIN}/api/matches`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token('alice')}` },
    })
    expect(busy.status).toBe(409)
    expect(await busy.json()).toEqual({ error: 'active', matchId })
    const me = await SELF.fetch(`${ORIGIN}/api/me`, {
      headers: { Authorization: `Bearer ${token('alice')}` },
    })
    expect(await me.json()).toEqual({ activeMatch: matchId })
  })

  it('will not seat a player at an invite while they play elsewhere', async () => {
    const { matchId } = await pair('alice', 'bob')
    const invite = await createTable('carol')
    const carol = await connect(invite, 'carol')
    const tried = await tryConnect(invite, 'bob')
    expect(await tried.closed).toEqual({ code: 4409, reason: matchId })
    // The seat stays open for someone free.
    await connect(invite, 'dave')
    await carol.next(isState(1))
  })

  it('lets go when the table ends, even if the release was lost', async () => {
    const { matchId, la } = await pair('alice', 'bob')
    await expire(matchId) // no-show: the table is over
    // Simulate a lost release: the lobby still thinks alice is there.
    await runInDurableObject(lobbyStub(env), async (instance: LobbyDO) => {
      const state = (instance as unknown as { ctx: DurableObjectState }).ctx
      await state.storage.put('active:alice', matchId)
    })
    const from = la.frames.length
    await queue(la)
    expect(await la.next((f) => f.t === 'queued', from)).toMatchObject({
      position: 1,
    })
    expect(la.frames.slice(from).some(matched)).toBe(false)
  })

  it('does not count an invite nobody joined as playing', async () => {
    const created = await SELF.fetch(`${ORIGIN}/api/matches`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token('alice')}` },
    })
    expect(created.status).toBe(201)
    const la = await lobby('alice')
    await queue(la)
    expect(await la.next((f) => f.t === 'queued')).toMatchObject({
      position: 1,
    })
  })

  it('a stale table it asks about never costs a claim made meanwhile', async () => {
    const created = await SELF.fetch(`${ORIGIN}/api/matches`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token('alice')}` },
    })
    const { matchId: invite } = (await created.json()) as { matchId: string }
    // The lobby takes other calls while it waits on a table: during its
    // first question to the invite (which holds nobody), alice sits at
    // another table and the claim lands.
    await runInDurableObject(lobbyStub(env), (instance: LobbyDO) => {
      const real = env.TABLE
      let first = true
      const tableOf = (id: DurableObjectId) => {
        const table = real.get(id)
        return {
          liveness: async (userId: string) => {
            if (first) {
              first = false
              await instance.claim(userId, 'elsewhere')
            }
            return table.liveness(userId)
          },
        }
      }
      ;(instance as unknown as { env: typeof env }).env = {
        ...env,
        TABLE: {
          idFromName: (name: string) => real.idFromName(name),
          get: tableOf,
        } as unknown as typeof env.TABLE,
      }
    })
    try {
      expect(await lobbyStub(env).activeFor('alice')).toBeNull()
      const claimed = await runInDurableObject(
        lobbyStub(env),
        (_: LobbyDO, state) => state.storage.get('active:alice'),
      )
      expect({ invite, claimed }).toEqual({ invite, claimed: 'elsewhere' })
    } finally {
      // The lobby object outlives the test: the next one gets a fresh one,
      // without the stand-in tables.
      await abortAllDurableObjects()
    }
  })
})

describe('the pair limiter', () => {
  it('pairs the same two accounts at most twice a day', async () => {
    for (let round = 0; round < 2; round++) {
      const { matchId, la, lb } = await pair('alice', 'bob')
      await expire(matchId)
      la.ws.close()
      lb.ws.close()
    }
    const [la, lb] = [await lobby('alice'), await lobby('bob')]
    await queue(la)
    await queue(lb)
    await lb.next((f) => f.t === 'queued' && f.position === 2)
    expect([...la.frames, ...lb.frames].some(matched)).toBe(false)
    // Someone new is fine.
    const lc = await lobby('carol')
    await queue(lc)
    const m = await lc.next(matched)
    expect(idOf(await la.next(matched))).toBe(idOf(m))
  })
})

describe('rated play', () => {
  it('pairs rated players only with each other, at a rated table', async () => {
    const [alice, bob] = [await lobby('alice'), await lobby('bob')]
    alice.send({ t: 'queue', kind: 'hu-rated' })
    await alice.next((f) => f.t === 'queued')
    await queue(bob) // casual
    expect(await bob.next((f) => f.t === 'queued')).toMatchObject({
      position: 1,
    })
    // Presence counts each line: two waiting, one of them rated.
    expect(
      await bob.next((f) => f.t === 'presence' && f.queued === 2),
    ).toMatchObject({ queued: 2, rated: 1 })
    expect([...alice.frames, ...bob.frames].some(matched)).toBe(false)
    const carol = await lobby('carol')
    carol.send({ t: 'queue', kind: 'hu-rated' })
    const m = await carol.next(matched)
    expect(idOf(await alice.next(matched))).toBe(idOf(m))
    const { match } = await peek(idOf(m))
    expect(
      (match as unknown as { config: { kind: string; handsTotal: number } })
        .config,
    ).toMatchObject({ kind: 'hu-rated', handsTotal: 40 })
    // Bob is still waiting for a casual opponent.
    expect(bob.frames.some(matched)).toBe(false)
    const dave = await lobby('dave')
    await queue(dave)
    const casual = await dave.next(matched)
    expect(idOf(await bob.next(matched))).toBe(idOf(casual))
    expect(
      (
        (await peek(idOf(casual))).match as unknown as {
          config: { kind: string }
        }
      ).config.kind,
    ).toBe('hu-casual')
  })
})

describe('no-shows', () => {
  it('ends a paired table nobody else opened, and frees both players', async () => {
    const { matchId, la } = await pair('alice', 'bob')
    const alice = await connect(matchId, 'alice')
    await alice.next((f) => f.t === 'welcome')
    await expire(matchId)
    expect(await alice.next((f) => f.t === 'match_end')).toMatchObject({
      result: { reason: 'no_show', noShow: [1] },
    })
    expect((await peek(matchId)).match.status).toBe('finished')
    // Free to queue again at once.
    const from = la.frames.length
    await queue(la)
    await la.next((f) => f.t === 'queued', from)
    expect(la.frames.slice(from).some(matched)).toBe(false)
  })

  it('does nothing once both players are there', async () => {
    const { matchId } = await pair('alice', 'bob')
    await freezeClock(matchId)
    const alice = await connect(matchId, 'alice')
    await connect(matchId, 'bob')
    await alice.next(isState(1))
    await elapse(matchId, START_WITHIN_MS)
    expect((await peek(matchId)).match.status).toBe('playing')
  })
})

describe('rated pairing by rating', () => {
  // Noon UTC tomorrow: always ahead of the real clock, which an alarm
  // cannot be set behind, and an hour of play never crosses a UTC day.
  const DAY = 86_400_000
  const T0 = Math.floor(Date.now() / DAY) * DAY + DAY + DAY / 2
  const MIN = 60_000
  const ratedQueue = (c: LobbyClient) =>
    c.send({ t: 'queue', kind: 'hu-rated' })
  /** Each account's rating, as the lobby reads it at queue time. */
  const ratings = (map: Record<string, number>) =>
    runInDurableObject(lobbyStub(env), (l: LobbyDO) => {
      l.ratingOf = async (userId) => map[userId] ?? 1500
    })
  const alarmAt = () =>
    runInDurableObject(lobbyStub(env), (_l: LobbyDO, state) =>
      state.storage.getAlarm(),
    )
  /** Moves the lobby's clock and fires its alarm (the 15 s re-pairing). */
  const later = async (at: number) => {
    await setLobbyClock(at)
    await runDurableObjectAlarm(lobbyStub(env))
  }
  async function waiting(name: string, at: number) {
    await setLobbyClock(at)
    const c = await lobby(name)
    ratedQueue(c)
    await c.next((f) => f.t === 'queued')
    return c
  }

  afterEach(async () => {
    await setLobbyClock(null)
  })

  it('players 400 apart pair only after 6 minutes', async () => {
    await ratings({ alice: 1500, bob: 1900 })
    const alice = await waiting('alice', T0)
    const bob = await waiting('bob', T0)
    // Apart: the lobby will look again in 15 s.
    expect(await alarmAt()).toBe(T0 + REPAIR_MS)
    await later(T0 + 6 * MIN - 1000) // a window of 399
    expect([...alice.frames, ...bob.frames].some(matched)).toBe(false)
    await later(T0 + 6 * MIN) // 100 + 50 × 6 = 400
    const m = await alice.next(matched)
    expect(idOf(await bob.next(matched))).toBe(idOf(m))
    expect(await alarmAt()).toBeNull()
  })

  it('the closest eligible opponent is chosen, oldest first on ties', async () => {
    // Bob and carol are both within reach of alice at 3 minutes (a window
    // of 250); carol is closer. Bob and carol are 380 apart.
    await ratings({ alice: 1500, bob: 1700, carol: 1320 })
    const alice = await waiting('alice', T0)
    const bob = await waiting('bob', T0 + 1000)
    const carol = await waiting('carol', T0 + 2000)
    await later(T0 + 3 * MIN)
    const m = await alice.next(matched)
    expect(idOf(await carol.next(matched))).toBe(idOf(m))
    expect(bob.frames.some(matched)).toBe(false)
    bob.ws.close()

    // A tie at 200 either side: the one who has waited longer.
    await ratings({ dave: 1500, erin: 1700, frank: 1300 })
    const t1 = T0 + 10 * MIN
    const dave = await waiting('dave', t1)
    const erin = await waiting('erin', t1 + 1000)
    const frank = await waiting('frank', t1 + 2000)
    await later(t1 + 3 * MIN)
    const tie = await dave.next(matched)
    expect(idOf(await erin.next(matched))).toBe(idOf(tie))
    expect(frank.frames.some(matched)).toBe(false)
  })

  it('a pair that met twice today is never paired again today, even alone in the queue', async () => {
    await ratings({ alice: 1500, bob: 1500 })
    for (let round = 0; round < 2; round++) {
      const a = await waiting('alice', T0 + round * MIN)
      const b = await lobby('bob')
      ratedQueue(b)
      const matchId = idOf(await a.next(matched))
      await expire(matchId)
      a.ws.close()
      b.ws.close()
    }
    const alice = await waiting('alice', T0 + 5 * MIN)
    const bob = await waiting('bob', T0 + 5 * MIN)
    await later(T0 + 60 * MIN)
    expect([...alice.frames, ...bob.frames].some(matched)).toBe(false)
  })

  it('a search cancelled or closed while its rating is read never comes back', async () => {
    for (const leaveBy of ['cancel', 'close'] as const) {
      // Alice's rating read hangs until the test lets it finish.
      await runInDurableObject(lobbyStub(env), (l: LobbyDO) => {
        const slow = l as LobbyDO & { finish?: () => void }
        l.ratingOf = (userId) =>
          userId === 'alice'
            ? new Promise((done) => (slow.finish = () => done(1500)))
            : Promise.resolve(1500)
      })
      const reading = () =>
        runInDurableObject(
          lobbyStub(env),
          (l: LobbyDO) => !!(l as LobbyDO & { finish?: () => void }).finish,
        )
      await setLobbyClock(T0)
      const alice = await lobby('alice')
      const watcher = await lobby('watcher')
      ratedQueue(alice)
      while (!(await reading())) await new Promise((r) => setTimeout(r, 5))
      // She leaves while the read is still out; the lobby sees her go.
      const seen = watcher.frames.length
      if (leaveBy === 'cancel') alice.send({ t: 'dequeue' })
      else alice.ws.close()
      await watcher.next((f) => f.t === 'presence', seen)
      await runInDurableObject(lobbyStub(env), (l: LobbyDO) =>
        (l as LobbyDO & { finish: () => void }).finish(),
      )
      // Bob, at the same rating, finds nobody: no ghost of alice to meet.
      const bob = await lobby('bob')
      ratedQueue(bob)
      const answer = await bob.next((f) => f.t === 'queued' || matched(f))
      expect(answer.t).toBe('queued')
      expect(Object.keys(await lobbyState())).not.toContain('queue:alice')
      for (const c of [alice, watcher, bob]) c.ws.close()
      await runInDurableObject(lobbyStub(env), (l: LobbyDO) => {
        delete (l as LobbyDO & { finish?: () => void }).finish
      })
    }
  })

  it('no alarm is armed while fewer than 2 rated players wait', async () => {
    await ratings({ alice: 1500, bob: 2100 })
    const alice = await waiting('alice', T0)
    expect(await alarmAt()).toBeNull()
    // A casual player is not a rated opponent.
    await queue(await lobby('carol'))
    expect(await alarmAt()).toBeNull()
    const bob = await waiting('bob', T0)
    expect(await alarmAt()).toBe(T0 + REPAIR_MS)
    bob.send({ t: 'dequeue' })
    await later(T0 + REPAIR_MS)
    expect(await alarmAt()).toBeNull()
    expect(alice.frames.some(matched)).toBe(false)
  })
})

describe('lobby frames', () => {
  it('queued/matched/presence/error/sit_at/tables carry only allowed keys', async () => {
    // A pairing, then the same player queueing again (matched, resumed).
    const { matchId, la, lb } = await pair('alice', 'bob')
    const from = la.frames.length
    await queue(la)
    expect(await la.next(matched, from)).toMatchObject({
      matchId,
      resumed: true,
    })
    // A table frame sent to the lobby is refused with an error.
    lb.send({ t: 'resync' })
    expect(await lb.next((f) => f.t === 'error')).toMatchObject({
      code: 'illegal',
    })
    // A six table someone sits at: the list names it, and quick-sit sends
    // a player there (P2-08b).
    const six = await sixTable()
    await sitDown(six, 'dave')
    await eventually(async () => (await lobbyTables()).length === 1)
    const lc = await lobby('carol')
    await lc.next((f) => f.t === 'presence')
    lc.send({ t: 'tables' })
    expect(await lc.next((f) => f.t === 'tables')).toMatchObject({
      tables: [{ tableId: six, seated: 1 }],
    })
    lc.send({ t: 'quick_sit' })
    expect(await lc.next((f) => f.t === 'sit_at')).toMatchObject({
      tableId: six,
    })

    // Every type the lobby can send was seen, so none goes unchecked.
    const all = [...la.frames, ...lb.frames, ...lc.frames]
    expect(new Set(all.map((f) => f.t)), 'lobby frame types seen').toEqual(
      new Set(Object.keys(LOBBY_FRAME_KEYS)),
    )
    for (const f of all) checkLobbyFrame(f)
  })
})

describe('the six-table registry (P2-08)', () => {
  /** The lobby's clock while these tests run, so updatedAt is exact. */
  const LOBBY_AT = 1_900_000_000_000
  const entryOf = (tableId: string) =>
    runInDurableObject(lobbyStub(env), (_: LobbyDO, state) =>
      state.storage.get<TableEntry>(`table:${tableId}`),
    )
  const listed = () =>
    runInDurableObject(lobbyStub(env), (instance: LobbyDO) => instance.tables())
  const report = (tableId: string, entry: TableReport) =>
    lobbyStub(env).reportTable(tableId, entry)
  const counts = (seated: number): TableReport => ({
    seated,
    maxSeats: 6,
    avgPot: 40,
    playersPerHour: 3,
  })
  const fold = (): PlayerAction => ({ type: 'fold' })
  const passive = (hand: HandState): PlayerAction =>
    legalActions(hand).canCheck ? { type: 'check' } : { type: 'call' }
  /** What a finished hand's winners were awarded. */
  const potOf = (hand: HandState) =>
    hand.result!.awards.reduce((sum, a) => sum + a.amount, 0)

  it('the table list shows seats, average pot and players/hour', async () => {
    await setLobbyClock(LOBBY_AT)
    const matchId = await sixTable()
    const a = await sitDown(matchId, 'list-a', 0)
    const b = await sitDown(matchId, 'list-b', 2)
    await a.next(isState(1))
    // C sits during hand 1: seated at once, dealt in from hand 2.
    const c = await sitDown(matchId, 'list-c', 4)
    const clients = { 0: a, 2: b, 4: c }
    // Hand 1, heads-up: the small blind folds. Its pot is what the big
    // blind was awarded, 20; the uncalled half of the big blind went back.
    expect(potOf(await playOut(matchId, clients, fold))).toBe(20)
    // Hand 2 deals all three in, and they check it down: 60.
    await elapse(matchId, NEXT_HAND_MS)
    await a.next(isState(2))
    expect(potOf(await playOut(matchId, clients, passive))).toBe(60)
    // A table reports at most every 30 s; the first alarm after that sends
    // the table as it is then (hand 3 is dealt meanwhile).
    await elapse(matchId, REPORT_MS)
    await eventually(async () => (await entryOf(matchId))?.avgPot === 40)
    // Three seats of six, the mean of 20 and 60, and three accounts dealt
    // in this hour: counts only.
    const entry = {
      seated: 3,
      maxSeats: 6,
      avgPot: 40,
      playersPerHour: 3,
      updatedAt: LOBBY_AT,
    }
    expect(await entryOf(matchId)).toEqual(entry)
    expect(await listed()).toContainEqual({ tableId: matchId, ...entry })
  })

  it('lists the fullest table with a free seat first, and full tables last', async () => {
    await setLobbyClock(LOBBY_AT)
    await report('d-full', counts(6))
    await report('c-two', counts(2))
    await report('b-five', counts(5))
    await report('a-two', counts(2))
    await report('e-empty', counts(0))
    // Quick-sit's order: a free seat first, fullest first, ties by id.
    expect((await listed()).map((t) => t.tableId)).toEqual([
      'b-five',
      'a-two',
      'c-two',
      'e-empty',
      'd-full',
    ])
  })

  it('an entry not refreshed for 20 minutes is not listed, and is dropped', async () => {
    await setLobbyClock(LOBBY_AT)
    await report('old', counts(2))
    await setLobbyClock(LOBBY_AT + 60_000)
    await report('new', counts(2))
    // Exactly 20 minutes old: still listed.
    await setLobbyClock(LOBBY_AT + REGISTRY_STALE_MS)
    expect((await listed()).map((t) => t.tableId)).toEqual(['new', 'old'])
    // Older than that: treated as gone (its table died without removing
    // itself), and the read drops it.
    await setLobbyClock(LOBBY_AT + REGISTRY_STALE_MS + 1)
    expect((await listed()).map((t) => t.tableId)).toEqual(['new'])
    expect(await entryOf('old')).toBeUndefined()
    expect(await entryOf('new')).toBeDefined()
  })

  it('an entry holds counts only, whatever a report carries', async () => {
    await setLobbyClock(LOBBY_AT)
    // A report that names accounts (no table sends one) is stored without them.
    await report('named', {
      ...counts(2),
      username: 'eve',
      userIds: ['eve-id'],
    } as TableReport)
    expect(await entryOf('named')).toEqual({
      ...counts(2),
      updatedAt: LOBBY_AT,
    })
    const stored = await lobbyState()
    expect(JSON.stringify(stored['table:named'])).not.toMatch(/eve/)
    // By value too: a field that is not a count (a name where a number
    // goes, NaN, a fraction, a negative) is refused whole. Nothing is
    // stored, and an entry already there stays as it was.
    const mangled: Record<string, unknown>[] = [
      { avgPot: 'eve' },
      { seated: 'eve' },
      { seated: Number.NaN },
      { playersPerHour: Infinity },
      { maxSeats: 6.5 },
      { seated: -1 },
      { avgPot: undefined },
    ]
    for (const fields of mangled) {
      // A native promise: vitest's rejects does not see an RPC promise
      // that resolves as a failure.
      for (const tableId of ['mangled', 'named'])
        await expect(
          (async () =>
            report(tableId, { ...counts(3), ...fields } as TableReport))(),
        ).rejects.toThrow('A table report is four counts')
      expect(await entryOf('mangled')).toBeUndefined()
      expect(await entryOf('named')).toEqual({
        ...counts(2),
        updatedAt: LOBBY_AT,
      })
    }
  })

  it('a table removed from the list is no longer listed', async () => {
    await setLobbyClock(LOBBY_AT)
    await report('gone', counts(1))
    await lobbyStub(env).removeTable('gone')
    expect(await entryOf('gone')).toBeUndefined()
    expect(await listed()).toEqual([])
  })
})
