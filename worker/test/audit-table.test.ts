// Regression tests for the table findings of the October 2026 foundation
// audit (F02, F03, F05, F06, F11). Each failed on the audited revision.
// F04 (a restart at a rated table) is in rated.test.ts with its helpers.
import { env, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { legalActions } from '../../src/engine/hand'
import type { SeatId } from '../../src/engine/types'
import { runoutMs } from '../../src/shared/pacing'
import { CLOSE_GONE } from '../../src/shared/protocol'
import type { ServerMsg } from '../../src/shared/protocol'
import type { Deadline } from '../src/deadlines'
import { lobbyStub, START_WITHIN_MS } from '../src/lobby'
import type { LobbyDO } from '../src/lobby'
import { NEXT_HAND_MS } from '../src/table'
import type { TableDO } from '../src/table'
import { checkFrames } from './frames'
import {
  connect,
  createMatch,
  createTable,
  elapse,
  eventually,
  freezeClock,
  isState,
  lobby,
  move,
  peek,
  setClock,
  sitDown,
  sixTable,
  stub,
  tryConnect,
} from './helpers'
import type { Client } from './helpers'

const T0 = 1_800_000_000_000

const deadlinesOf = (matchId: string) =>
  runInDurableObject(
    stub(matchId),
    (instance: TableDO) =>
      (instance as unknown as { deadlines: Deadline[] }).deadlines,
  )

/** A casual heads-up table with both players seated and hand 1 dealt. */
async function headsUp(prefix: string) {
  const matchId = await createTable(`${prefix}-a`, 5)
  await freezeClock(matchId, T0)
  const a = await connect(matchId, `${prefix}-a`)
  const b = await connect(matchId, `${prefix}-b`)
  await a.next(isState(1))
  await b.next(isState(1))
  return { matchId, seats: { 0: a, 1: b } as Record<SeatId, Client> }
}

const activeOf = (userId: string) =>
  runInDurableObject(lobbyStub(env), (_: LobbyDO, state) =>
    state.storage.get<string>(`active:${userId}`),
  )

describe('the next hand waits for an all-in board (audit F02)', () => {
  it('deals after the reveal and the result pause, not 3 s after the shove', async () => {
    const { matchId, seats } = await headsUp('pace')
    // Preflop all in and called: the client reveals five cards, 4.1 s.
    await move(matchId, seats, (hand) => ({
      type: 'raise',
      to: legalActions(hand).maxRaiseTo,
    }))
    await move(matchId, seats, () => ({ type: 'call' }))
    expect((await peek(matchId)).hand!.result!.showdown).toBe(true)
    expect(runoutMs(0)).toBe(4100)
    const deal = (await deadlinesOf(matchId)).find((d) => d.kind === 'nextHand')
    expect(deal?.at).toBe(T0 + NEXT_HAND_MS + 4100)
    await elapse(matchId, NEXT_HAND_MS)
    expect((await peek(matchId)).match.handNo).toBe(1)
    await elapse(matchId, 4100)
    await seats[0].next(isState(2))

    // A fold reveals nothing: the usual pause.
    await move(matchId, seats, () => ({ type: 'fold' }))
    const fold = (await deadlinesOf(matchId)).find((d) => d.kind === 'nextHand')
    expect(fold?.at).toBe(T0 + NEXT_HAND_MS + 4100 + NEXT_HAND_MS)
  })

  it('reveals from the flop and the turn take 3.2 s and 2.3 s', () => {
    expect(runoutMs(3)).toBe(3200)
    expect(runoutMs(4)).toBe(2300)
    expect(runoutMs(5)).toBe(0)
  })
})

describe('the clock decides a late move, not the alarm (audit F11)', () => {
  it('a move at its deadline is stale, and the timeout is applied first', async () => {
    const { matchId, seats } = await headsUp('late')
    const { hand } = await peek(matchId)
    const actor = hand!.toAct!
    const turn = (await deadlinesOf(matchId)).find((d) => d.kind === 'turn')!
    // The deadline has passed; its alarm has not run yet.
    await setClock(matchId, turn.at)
    const from = seats[actor].frames.length
    seats[actor].send({
      t: 'act',
      reqId: 'late',
      handNo: 1,
      actionIndex: 0,
      action: { type: 'call' },
    })
    expect(await seats[actor].next((f) => f.t === 'error', from)).toMatchObject(
      { code: 'stale', reqId: 'late' },
    )
    const after = await peek(matchId)
    // The small blind could not check, so the clock folded it.
    expect(after.hand!.actions[0]).toMatchObject({
      seat: actor,
      action: { type: 'fold' },
    })
    const players = (
      after.match as unknown as {
        players: { seat: number; timeouts: number }[]
      }
    ).players
    expect(players.find((p) => p.seat === actor)!.timeouts).toBe(1)
  })

  it('a move a moment before its deadline is played', async () => {
    const { matchId, seats } = await headsUp('ontime')
    const actor = (await peek(matchId)).hand!.toAct!
    const turn = (await deadlinesOf(matchId)).find((d) => d.kind === 'turn')!
    await setClock(matchId, turn.at - 1)
    await move(matchId, seats, () => ({ type: 'call' }))
    expect((await peek(matchId)).hand!.actions[0]).toMatchObject({
      seat: actor,
      action: { type: 'call' },
    })
  })
})

describe('an invite whose host is gone (audit F05)', () => {
  /** An invite made through the Worker; the host never opens it. */
  async function invite(host: string) {
    const made = await createMatch(host)
    expect(made.status).toBe(201)
    const { matchId } = (await made.json()) as { matchId: string }
    await freezeClock(matchId, T0)
    return matchId
  }

  it('closes after 30 s and frees the guest, not after the link’s 24 h', async () => {
    const matchId = await invite('gone-host')
    const guest = await connect(matchId, 'gone-guest')
    await guest.next((f) => f.t === 'welcome')
    expect(await activeOf('gone-guest')).toBe(matchId)
    const start = (await deadlinesOf(matchId)).find((d) => d.kind === 'start')
    expect(start?.at).toBe(T0 + START_WITHIN_MS)
    await elapse(matchId, START_WITHIN_MS)
    const end = await guest.next((f) => f.t === 'match_end')
    expect(end).toMatchObject({ result: { reason: 'no_show', noShow: [0] } })
    await eventually(async () => (await activeOf('gone-guest')) === undefined)
    // Free to play elsewhere at once.
    const l = await lobby('gone-guest')
    l.send({ t: 'queue', kind: 'hu-casual' })
    expect(
      await l.next((f) => f.t === 'queued' || f.t === 'matched'),
    ).toMatchObject({ t: 'queued' })
    l.send({ t: 'dequeue' })
  })

  it('lets the guest cancel before the deal', async () => {
    const matchId = await invite('cancel-host')
    const guest = await connect(matchId, 'cancel-guest')
    await guest.next((f) => f.t === 'welcome')
    guest.send({ t: 'stand' })
    expect(await guest.next((f) => f.t === 'match_end')).toMatchObject({
      result: { reason: 'no_show', noShow: [0] },
    })
    await eventually(async () => (await activeOf('cancel-guest')) === undefined)
  })

  it('a cancel that loses the race to the deal is told the game started', async () => {
    const matchId = await invite('race-host')
    const host = await connect(matchId, 'race-host')
    await host.next((f) => f.t === 'welcome')
    const guest = await connect(matchId, 'race-guest')
    await guest.next(isState(1))
    const from = guest.frames.length
    guest.send({ t: 'stand' })
    expect(await guest.next((f) => f.t === 'error', from)).toMatchObject({
      code: 'stale',
    })
    await guest.next((f) => f.t === 'state', from)
    expect((await peek(matchId)).match.status).toBe('playing')
    checkFrames(guest.frames)
  })
})

describe('one host, two invites (audit F06)', () => {
  it('only one starts: the second guest finds the game closed', async () => {
    const one = (await (await createMatch('two-host')).json()) as {
      matchId: string
    }
    const two = (await (await createMatch('two-host')).json()) as {
      matchId: string
    }
    expect(two.matchId).not.toBe(one.matchId)
    // The host waits at both, in two tabs.
    for (const matchId of [one.matchId, two.matchId]) {
      const host = await connect(matchId, 'two-host')
      await host.next((f) => f.t === 'welcome')
    }
    const first = await connect(one.matchId, 'two-guest-1')
    await first.next(isState(1))
    expect((await peek(one.matchId)).match.status).toBe('playing')
    expect(await activeOf('two-host')).toBe(one.matchId)

    const second = await tryConnect(two.matchId, 'two-guest-2')
    expect(await second.closed).toMatchObject({ code: CLOSE_GONE })
    const other = await peek(two.matchId)
    expect(other.match.status).toBe('waiting')
    expect(
      (other.match as unknown as { players: unknown[] }).players,
    ).toHaveLength(1)
    // Neither account was moved: the host stays at the game they play.
    expect(await activeOf('two-host')).toBe(one.matchId)
    expect(await activeOf('two-guest-2')).toBeUndefined()
  })
})

describe('a pending stand is the table’s word, not the client’s (audit F03)', () => {
  it('tells the player who stood, and only them, until the seat frees', async () => {
    const matchId = await sixTable()
    const players = [
      await sitDown(matchId, 'stand-0'),
      await sitDown(matchId, 'stand-1'),
      await sitDown(matchId, 'stand-2'),
    ]
    await players[0].next(isState(1))
    const { hand } = await peek(matchId)
    // Someone not to act stands: accepted now, effective at the hand's end.
    const seatOf = (i: number) =>
      (hand!.config.seats.map((s) => s.seat) as SeatId[])[i]
    const standing = [0, 1, 2].find((i) => seatOf(i) !== hand!.toAct)!
    const from = players[standing].frames.length
    players[standing].send({ t: 'stand' })
    const accepted = await players[standing].next(
      (f) => f.t === 'welcome',
      from,
    )
    expect(accepted).toMatchObject({ leaving: true })
    // A resync (as after a reconnect) says the same.
    const resynced = players[standing].frames.length
    players[standing].send({ t: 'resync' })
    expect(
      await players[standing].next((f) => f.t === 'welcome', resynced),
    ).toMatchObject({ leaving: true })
    // Nobody else hears of it.
    for (const [i, client] of players.entries())
      if (i !== standing)
        expect(client.frames.some((f: ServerMsg) => 'leaving' in f)).toBe(false)
    for (const client of players) checkFrames(client.frames, 'six-casual')
  })
})
