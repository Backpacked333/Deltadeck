import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandOutcomeV1, ServerMsg } from '../shared/protocol'
import { PENDING_WATCHDOG_MS, TableConnection } from './client'
import {
  control,
  FakeSocket,
  firstHand,
  frame,
  MATCH,
  sixFrame,
  sixHand,
} from './testing'

type Snapshot = Extract<ServerMsg, { t: 'welcome' }>
let connection: TableConnection
let clock = 0
const snapshot = (seq = 1) =>
  sixFrame('welcome', seq, 2, 2, sixHand()) as Snapshot
const sent = (socket = FakeSocket.last()) =>
  socket.sent.map((m) => JSON.parse(m))
const outcome = (
  disposition: CommandOutcomeV1['disposition'],
  effect: CommandOutcomeV1['effect'] = 'none',
  commandId = 'request-1',
): Extract<ServerMsg, { t: 'command_outcome' }> => ({
  t: 'command_outcome',
  v: 1,
  commandId,
  disposition,
  effect,
  stateVersion: 1,
  reason: disposition === 'unknown' ? 'not_found' : 'ok',
  scope: control(1, 2).scope,
  seq: 1,
  matchId: MATCH,
})

beforeEach(async () => {
  vi.useFakeTimers()
  FakeSocket.all = []
  clock = 0
  let request = 0
  connection = new TableConnection(MATCH, async () => 'test-token', {
    WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    origin: 'wss://test.invalid',
    now: () => clock,
    newRequestId: () => `request-${++request}`,
  })
  connection.start()
  await vi.advanceTimersByTimeAsync(0)
  FakeSocket.last().open()
  FakeSocket.last().emit(snapshot())
})
afterEach(() => {
  connection.stop()
  vi.useRealTimers()
})

describe('journaled seat commands', () => {
  it('a late accepted outcome supersedes a locally invalidated retry scope', () => {
    connection.stand()
    FakeSocket.last().emit(snapshot(2))
    expect(connection.getState().command?.phase).toBe('stale')
    expect(sent().at(-1)).toEqual({
      t: 'command_status',
      commandId: 'request-1',
    })
    FakeSocket.last().emit(outcome('accepted', 'pending'))
    expect(connection.getState().command?.phase).toBe('accepted-pending-effect')
  })

  it('an expired journal cannot authorize a same-id retry', () => {
    connection.stand()
    FakeSocket.last().emit({ ...outcome('unknown'), reason: 'retry_expired' })
    expect(connection.retryCommand()).toBe(false)
  })

  it.each(['stand', 'rebuy', 'sitOut', 'sitIn'] as const)(
    'fences %s to the exact seat, hand, membership and state',
    (kind) => {
      expect(connection[kind]()).toBe(true)
      expect(sent()[0]).toMatchObject({
        t: 'seat_command',
        v: 1,
        commandId: 'request-1',
        tableId: MATCH,
        membershipGeneration: 1,
        seatGeneration: 1,
        expectedStateVersion: 1,
        hand: { tableId: MATCH, matchId: MATCH, handNo: 1 },
      })
      expect(connection.getState().command?.phase).toBe('sending')
      expect(connection.getState().ownControl?.standing).toBe(false)
      expect(connection.stand()).toBe(false)
    },
  )

  it('a dropped request becomes unknown, queries state+journal, and retries the identical envelope', async () => {
    connection.stand()
    const original = FakeSocket.last().sent[0]
    await vi.advanceTimersByTimeAsync(PENDING_WATCHDOG_MS)
    expect(connection.getState().command?.phase).toBe('unknown')
    expect(sent().slice(1)).toEqual([
      { t: 'resync' },
      { t: 'command_status', commandId: 'request-1' },
    ])
    expect(connection.retryCommand()).toBe(false)
    FakeSocket.last().emit(snapshot())
    FakeSocket.last().emit(outcome('unknown'))
    expect(connection.retryCommand()).toBe(true)
    expect(FakeSocket.last().sent.at(-1)).toBe(original)
  })

  it('lost acknowledgement recovers accepted-pending-effect from a snapshot, then completion', async () => {
    connection.stand()
    await vi.advanceTimersByTimeAsync(PENDING_WATCHDOG_MS)
    const next = snapshot(2)
    next.ownControl = {
      ...control(2, 2),
      standing: true,
      commandOutcomes: [outcome('accepted', 'pending')],
    }
    FakeSocket.last().emit(next)
    expect(connection.getState().command?.phase).toBe('accepted-pending-effect')
    expect(connection.retryCommand()).toBe(false)
    FakeSocket.last().emit(outcome('unknown'))
    expect(connection.getState().command?.phase).toBe('accepted-pending-effect')
    FakeSocket.last().emit(outcome('accepted', 'completed'))
    FakeSocket.last().emit(outcome('accepted', 'pending'))
    expect(connection.getState().command?.phase).toBe('completed')
  })

  it.each(['hand', 'seat', 'membership', 'version'] as const)(
    'never retries into a changed %s',
    async (changed) => {
      connection.stand()
      await vi.advanceTimersByTimeAsync(PENDING_WATCHDOG_MS)
      const next = snapshot()
      if (changed === 'hand') next.view!.handNo++
      if (changed === 'seat') next.ownControl!.scope!.seatGeneration++
      if (changed === 'membership')
        next.ownControl!.scope!.membershipGeneration++
      if (changed === 'version') {
        next.seq++
        next.ownControl!.stateVersion++
      }
      FakeSocket.last().emit(next)
      FakeSocket.last().emit(outcome('unknown'))
      expect(connection.getState().command?.phase).toBe('stale')
      expect(connection.retryCommand()).toBe(false)
      expect(sent().filter((m) => m.t === 'seat_command')).toHaveLength(1)
    },
  )

  it('reconnect after completed effect recovers the journal without sending the command again', async () => {
    connection.stand()
    const old = FakeSocket.last()
    old.drop()
    await vi.advanceTimersByTimeAsync(500)
    const fresh = FakeSocket.last()
    fresh.open()
    const next = sixFrame('welcome', 2, null, null, null) as Snapshot
    next.ownControl!.commandOutcomes = [outcome('accepted', 'completed')]
    fresh.emit(next)
    old.emit(snapshot())
    expect(connection.getState().seat).toBeNull()
    expect(connection.getState().command?.phase).toBe('completed')
    expect(sent(fresh)).toEqual([])
  })

  it('does not enable an unscoped legacy writer', () => {
    const legacy = snapshot(2)
    delete legacy.ownControl
    FakeSocket.last().emit(legacy)
    expect(connection.stand()).toBe(false)
    expect(sent()).toEqual([])
  })

  it('rejected command is explicit and a new intent has a fresh identity', () => {
    connection.rebuy()
    FakeSocket.last().emit({ ...outcome('rejected'), reason: 'illegal_now' })
    expect(connection.getState().command).toMatchObject({
      phase: 'rejected',
      reason: 'illegal_now',
      retryable: false,
    })
    expect(connection.stand()).toBe(true)
    expect(sent().at(-1).commandId).toBe('request-2')
  })
})

describe('pre-deal cancellation', () => {
  function waiting() {
    const next = frame('welcome', 2, 0, null) as Snapshot
    next.start = {
      activationId: 'activation-1',
      waitingForHost: true,
      deadlineAt: 30_000,
    }
    next.presentation = {
      completion: null,
      currentDecision: null,
      serverNow: 0,
    }
    FakeSocket.last().emit(next)
    return next
  }
  it('does not call a sent cancellation successful, and preserves its ID on retry', async () => {
    const next = waiting()
    expect(connection.cancelStart()).toBe(true)
    const envelope = FakeSocket.last().sent[0]
    expect(connection.getState().cancellation?.phase).toBe('sending')
    expect(connection.cancelStart()).toBe(false)
    await vi.advanceTimersByTimeAsync(PENDING_WATCHDOG_MS)
    expect(connection.getState().cancellation?.phase).toBe('unknown')
    expect(connection.cancelStart()).toBe(false)
    FakeSocket.last().emit(next)
    expect(connection.cancelStart()).toBe(true)
    expect(FakeSocket.last().sent.at(-1)).toBe(envelope)
  })
  it.each(['cancelled', 'game_started', 'stale'] as const)(
    'uses the authoritative %s outcome',
    (status) => {
      waiting()
      connection.cancelStart()
      FakeSocket.last().emit({
        t: 'cancel_start_result',
        commandId: 'request-1',
        status,
        seq: 3,
        matchId: MATCH,
        stateVersion: 3,
      })
      expect(connection.getState().cancellation?.phase).toBe(status)
      expect(sent().at(-1)).toEqual({ t: 'resync' })
    },
  )
  it('first-deal state supersedes a lost cancellation acknowledgement', () => {
    waiting()
    connection.cancelStart()
    FakeSocket.last().emit(frame('state', 3, 0, firstHand()))
    expect(connection.getState().cancellation?.phase).toBe('game_started')
    expect(connection.cancelStart()).toBe(false)
  })
  it.each(['activation', 'membership'] as const)(
    'does not retry cancellation after changed %s',
    async (changed) => {
      const next = waiting()
      connection.cancelStart()
      await vi.advanceTimersByTimeAsync(PENDING_WATCHDOG_MS)
      if (changed === 'activation') next.start!.activationId = 'activation-2'
      else next.ownControl!.scope!.membershipGeneration++
      FakeSocket.last().emit(next)
      expect(connection.cancelStart()).toBe(false)
    },
  )
})

it('uses only local monotonic timestamps with decision identity for intent/sent/frame/render', () => {
  clock = 12
  connection.stand()
  clock = 20
  FakeSocket.last().emit(outcome('accepted', 'pending'))
  clock = 21
  FakeSocket.last().emit({ ...snapshot(2), serverNow: -9_999_999 })
  clock = 23
  connection.markRendered(connection.getState().frameTiming)
  connection.markRendered(connection.getState().frameTiming)
  const samples = connection.timing.read()
  expect(samples.map((s) => [s.phase, s.at])).toEqual([
    ['frame', 0],
    ['intent', 12],
    ['sent', 12],
    ['acknowledgement', 20],
    ['frame', 21],
    ['render', 23],
  ])
  expect(samples.at(-1)?.identity).toMatchObject({
    tableId: MATCH,
    matchId: MATCH,
    handNo: 1,
    actionIndex: 0,
    stateVersion: 2,
  })
  expect(JSON.stringify(samples)).not.toMatch(/cards|username|token/)
})
