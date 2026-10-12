import {
  abortAllDurableObjects,
  env,
  runInDurableObject,
} from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, startHand } from '../../src/engine/hand'
import { seededDeck } from '../../src/engine/testing'
import type {
  HandRecordV1,
  SeatCommandV1,
  TerminalProofV1,
} from '../../src/shared/protocol'
import { parseClientMsg } from '../../src/shared/protocol'
import { currentRating, lobbyStub, START_WITHIN_MS } from '../src/lobby'
import {
  canonicalJSON,
  completeHand,
  evidenceDigest,
} from '../src/live-evidence'
import { GRACE_MS } from '../src/rated'
import type { TableDO } from '../src/table'
import {
  checkFrame,
  checkFrames,
  FLOW_TYPES,
  forbiddenKeys,
  analysisKeys,
} from './frames'
import {
  connect,
  createTable,
  elapse,
  freezeClock,
  isState,
  move,
  peek,
  sendSeatCommand,
  setLobbyClock,
  sitDown,
  sixTable,
  stub,
  tryConnect,
} from './helpers'
import type { Client } from './helpers'

const T0 = 1_800_000_000_000
const UUID = '11111111-1111-4111-8111-111111111111'
afterEach(() => vi.unstubAllGlobals())

async function latest(client: Client) {
  const from = client.frames.length
  client.ws.send(JSON.stringify({ t: 'resync' }))
  const frame = await client.next((f) => f.t === 'welcome', from)
  if (frame.t !== 'welcome') throw new Error('welcome')
  return frame
}

async function command(
  client: Client,
  tableId: string,
  kind: SeatCommandV1['kind'],
): Promise<SeatCommandV1> {
  const frame = await latest(client)
  const scope = frame.ownControl!.scope!
  return {
    t: 'seat_command',
    v: 1,
    commandId: crypto.randomUUID(),
    tableId,
    kind,
    membershipGeneration: scope.membershipGeneration,
    seatGeneration: scope.seatGeneration,
    expectedStateVersion: frame.seq,
    hand: frame.view
      ? { tableId, matchId: frame.matchId, handNo: frame.view.handNo }
      : null,
  }
}

async function deliver(client: Client, msg: SeatCommandV1) {
  const from = client.frames.length
  client.ws.send(JSON.stringify(msg))
  return client.next(
    (f) => f.t === 'command_outcome' && f.commandId === msg.commandId,
    from,
  )
}

async function rated() {
  const id = crypto.randomUUID()
  await setLobbyClock(T0)
  await stub(id).fetch('https://table/init', {
    method: 'POST',
    body: JSON.stringify({
      matchId: id,
      creator: { userId: 'a', username: 'a' },
      opponent: { userId: 'b', username: 'b' },
      kind: 'hu-rated',
    }),
  })
  await freezeClock(id, T0)
  const a = await connect(id, 'a'),
    b = await connect(id, 'b')
  await a.next(isState(1))
  return { id, a, b }
}

describe('scoped seat command trust', () => {
  it('F03_lost_ack_resyncs_accepted_stand', async () => {
    const id = await sixTable()
    const a = await sitDown(id, 'a'),
      b = await sitDown(id, 'b')
    await a.next(isState(1))
    const waiting = (await peek(id)).hand!.toAct === 0 ? b : a
    const msg = await command(waiting, id, 'stand')
    expect(await deliver(waiting, msg)).toMatchObject({
      disposition: 'accepted',
      effect: 'pending',
    })
    waiting.frames.length = 0 // discard both acknowledgement and echoed welcome
    const resynced = await latest(waiting)
    expect(resynced.ownControl).toMatchObject({
      standing: true,
      pendingIntent: { commandId: msg.commandId, kind: 'stand' },
    })
    expect(await deliver(waiting, msg)).toMatchObject({
      disposition: 'accepted',
      effect: 'pending',
    })
    const other = waiting === a ? b : a
    expect(JSON.stringify((await latest(other)).ownControl)).not.toContain(
      msg.commandId,
    )
    const watcher = await connect(id, 'watcher')
    expect((await latest(watcher)).ownControl).toMatchObject({
      scope: null,
      commandOutcomes: [],
      pendingIntent: null,
    })
    checkFrame(resynced, 'six-casual')
  })

  it('F03_duplicate_rebuy_one_effect and journal survives restart', async () => {
    const id = await sixTable()
    const a = await sitDown(id, 'a'),
      b = await sitDown(id, 'b')
    await a.next(isState(1))
    await move(id, { 0: a, 1: b }, () => ({ type: 'fold' }))
    const msg = await command(a, id, 'rebuy')
    expect(await deliver(a, msg)).toMatchObject({
      disposition: 'accepted',
      effect: 'completed',
    })
    expect(await deliver(a, msg)).toMatchObject({
      disposition: 'accepted',
      effect: 'completed',
    })
    expect(await deliver(a, { ...msg, kind: 'stand' })).toMatchObject({
      reason: 'id_reused',
      disposition: 'rejected',
    })
    await abortAllDurableObjects()
    await freezeClock(id, T0)
    const again = await connect(id, 'a')
    expect(await deliver(again, msg)).toMatchObject({
      disposition: 'accepted',
      effect: 'completed',
    })
    expect(
      (await latest(again)).table.players.find((p) => p.seat === 0)?.stack,
    ).toBe(2000)
  })

  it('F03_stale_seat_retry_rejected and old unscoped controls are safe', async () => {
    const id = await sixTable(),
      a = await sitDown(id, 'a')
    const stale = await command(a, id, 'rebuy')
    await sendSeatCommand(a, id, 'stand')
    await elapse(id, 120_000)
    const from = a.frames.length
    a.send({ t: 'sit', seat: 0 })
    await a.next((f) => f.t === 'welcome' && f.seat === 0, from)
    expect(await deliver(a, stale)).toMatchObject({
      disposition: 'stale',
      reason: 'wrong_membership',
    })
    const rawFrom = a.frames.length
    a.ws.send(JSON.stringify({ t: 'stand' }))
    expect(await a.next((f) => f.t === 'error', rawFrom)).toMatchObject({
      code: 'upgrade_required',
    })
    expect((await latest(a)).seat).toBe(0)
  })

  it('strictly parses every scoped command field', async () => {
    const id = await sixTable(),
      a = await sitDown(id, 'a')
    const good = await command(a, id, 'sit_out')
    expect(parseClientMsg(JSON.stringify(good))).toEqual(good)
    for (const bad of [
      { ...good, seatGeneration: 0 },
      { ...good, expectedStateVersion: -1 },
      { ...good, userId: 'other' },
      { ...good, hand: { matchId: id, handNo: 1 } },
      { ...good, v: 2 },
    ])
      expect(parseClientMsg(JSON.stringify(bad))).toBeNull()
  })

  it('does not retire the current state version when old rejected commands expire', async () => {
    const id = await sixTable(),
      a = await sitDown(id, 'retained-a')
    expect(await deliver(a, await command(a, id, 'rebuy'))).toMatchObject({
      disposition: 'rejected',
    })
    await runInDurableObject(stub(id), (table: TableDO) => {
      const inside = table as unknown as {
        journal: Record<string, { at: number }>
      }
      for (const entry of Object.values(inside.journal)) entry.at = 0
    })
    expect(await deliver(a, await command(a, id, 'stand'))).toMatchObject({
      disposition: 'accepted',
    })
  })
})

describe('durable activation and cancellation', () => {
  it('F05_host_absent_cancel_reclaims_membership; cancelled frames pass the allowlist', async () => {
    const id = await createTable('host')
    await freezeClock(id, T0)
    expect(await lobbyStub(env).activeFor('host')).toBeNull()
    const guest = await connect(id, 'guest')
    const frame = await latest(guest),
      scope = frame.ownControl!.scope!
    expect(frame.start).toMatchObject({
      waitingForHost: true,
      deadlineAt: T0 + START_WITHIN_MS,
    })
    const cancel = {
      t: 'cancel_start',
      v: 1,
      commandId: crypto.randomUUID(),
      tableId: id,
      activationId: scope.activationId,
      membershipGeneration: scope.membershipGeneration,
    }
    guest.ws.send(JSON.stringify(cancel))
    await guest.next((f) => f.t === 'cancel_start_result')
    expect(await lobbyStub(env).activeFor('guest')).toBeNull()
    expect(await lobbyStub(env).activeFor('host')).toBeNull()
    expect((await peek(id)).hand).toBeNull()
    const terminal = await runInDurableObject(stub(id), (_, state) =>
      state.storage.get<TerminalProofV1>('terminalProof'),
    )
    expect(terminal).toMatchObject({
      cause: 'cancelled_before_deal',
      voluntaryCommandId: cancel.commandId,
      completedHands: [],
    })
    const checked = checkFrames(guest.frames)
    expect(checked).toEqual(new Set(FLOW_TYPES.cancelStart))
  })

  it('F05_cancel_races_first_deal returns game_started when the deal won', async () => {
    const id = await createTable('host')
    const host = await connect(id, 'host'),
      guest = await connect(id, 'guest')
    await host.next(isState(1))
    const scope = (await latest(guest)).ownControl!.scope!
    guest.ws.send(
      JSON.stringify({
        t: 'cancel_start',
        v: 1,
        commandId: crypto.randomUUID(),
        tableId: id,
        activationId: scope.activationId,
        membershipGeneration: scope.membershipGeneration,
      }),
    )
    expect(
      await guest.next((f) => f.t === 'cancel_start_result'),
    ).toMatchObject({ status: 'game_started' })
    expect((await peek(id)).match.status).toBe('playing')
    expect(await lobbyStub(env).activeFor('guest')).toBe(id)
  })

  it('F06_competing_invites_one_playable_table', async () => {
    const ids = [await createTable('host'), await createTable('host')]
    const [h0, h1] = await Promise.all(ids.map((id) => connect(id, 'host')))
    await h0.next((f) => f.t === 'welcome')
    await h1.next((f) => f.t === 'welcome')
    await Promise.all([
      tryConnect(ids[0], 'guest0'),
      tryConnect(ids[1], 'guest1'),
    ])
    const states = await Promise.all(ids.map(peek))
    expect(states.filter((s) => s.match.status === 'playing')).toHaveLength(1)
    expect(await lobbyStub(env).activeFor('host')).toBe(
      ids[states.findIndex((s) => s.match.status === 'playing')],
    )
  })

  it('F06_old_release_cannot_erase_new_generation', async () => {
    const id = await sixTable(),
      a = await sitDown(id, 'a')
    const old = (await latest(a)).ownControl!.scope!
    await sendSeatCommand(a, id, 'stand')
    await elapse(id, 120_000)
    const from = a.frames.length
    a.send({ t: 'sit' })
    await a.next((f) => f.t === 'welcome' && f.seat !== null, from)
    const fresh = (await latest(a)).ownControl!.scope!
    expect(fresh.membershipGeneration).toBeGreaterThan(old.membershipGeneration)
    await lobbyStub(env).releaseMembership([
      {
        userId: 'a',
        tableId: id,
        generation: old.membershipGeneration,
        activationId: old.activationId,
      },
    ])
    expect(await lobbyStub(env).activeFor('a')).toBe(id)
  })

  it('F06_uncommitted_local_fence_cannot_release_ownership', async () => {
    const id = await sixTable(),
      a = await sitDown(id, 'fenced-a')
    const scope = (await latest(a)).ownControl!.scope!
    await runInDurableObject(stub(id), (table: TableDO) => {
      const inside = table as unknown as { match: { status: string } }
      inside.match.status = 'finished'
    })
    expect(
      await stub(id).ownsMembership(
        'fenced-a',
        scope.activationId,
        scope.membershipGeneration,
      ),
    ).toBe(true)
    expect(await lobbyStub(env).activeFor('fenced-a')).toBe(id)
    await runInDurableObject(stub(id), async (table: TableDO, state) => {
      const inside = table as unknown as { match: unknown }
      inside.match = await state.storage.get('match')
    })
  })

  it('F06_crash_after_each_activation_step: reserve/prepare/commit/local-commit replay', async () => {
    for (const step of ['reserve', 'prepare', 'commit', 'local_commit']) {
      const id = crypto.randomUUID(),
        users = [`${step}-a`, `${step}-b`]
      await setLobbyClock(T0)
      const ticket = await lobbyStub(env).reserveActivation(
        id,
        users,
        crypto.randomUUID(),
      )
      if ('busy' in ticket) throw new Error('unexpected busy')
      expect(await lobbyStub(env).commitActivation(ticket.id)).toBeNull() // no durable prepare
      if (step !== 'reserve')
        await stub(id).fetch('https://table/init', {
          method: 'POST',
          body: JSON.stringify({
            matchId: id,
            creator: { userId: users[0], username: users[0] },
            opponent: { userId: users[1], username: users[1] },
            activation: ticket,
          }),
        })
      if (step === 'commit' || step === 'local_commit')
        expect(await lobbyStub(env).commitActivation(ticket.id)).toMatchObject({
          state: 'committed',
        })
      if (step === 'local_commit') {
        const a = await connect(id, users[0])
        await a.next((f) => f.t === 'welcome')
      }
      await abortAllDurableObjects()
      if (step === 'reserve') {
        await setLobbyClock(T0 + 60_000)
        expect(await lobbyStub(env).activeFor(users[0])).toBeNull()
        expect(await lobbyStub(env).commitActivation(ticket.id)).toMatchObject({
          state: 'cancelled',
        })
      } else {
        await freezeClock(id, T0)
        const a = await connect(id, users[0]),
          b = await connect(id, users[1])
        await a.next(isState(1))
        await b.next(isState(1))
        expect((await peek(id)).match.status).toBe('playing')
        expect(await lobbyStub(env).activeFor(users[0])).toBe(id)
      }
    }
  })
})

describe('receipt deadlines and restore', () => {
  it.each([-1, 0, 1])(
    'F11_receipt_equal_deadline_is_late offset=%i',
    async (offset) => {
      const id = await createTable('a'),
        a = await connect(id, 'a'),
        b = await connect(id, 'b')
      await a.next(isState(1))
      const frame = await latest(a),
        deadline = frame.presentation!.currentDecision!.deadlineAt
      const { hand } = await peek(id),
        actor = hand!.toAct === 0 ? a : b
      await freezeClock(id, deadline + offset)
      const from = actor.frames.length
      actor.send({
        t: 'act',
        handNo: 1,
        actionIndex: 0,
        reqId: 'boundary',
        action: { type: 'call' },
      })
      await actor.next((f) => f.t === 'state' || f.t === 'error', from)
      const action = (await peek(id)).hand!.actions[0]
      expect(action.action.type).toBe(offset < 0 ? 'call' : 'fold')
      if (offset < 0)
        expect((await latest(actor)).view?.lastReqId).toBe('boundary')
      else expect((await latest(actor)).view?.lastReqId).not.toBe('boundary')
    },
  )

  it('F11_timely_queued_receipt_not_processing_time', async () => {
    const id = await createTable('a'),
      a = await connect(id, 'a'),
      b = await connect(id, 'b')
    await a.next(isState(1))
    const deadline = (await latest(a)).presentation!.currentDecision!.deadlineAt
    await freezeClock(id, deadline - 1)
    await runInDurableObject(stub(id), (table: TableDO) => {
      const inside = table as unknown as {
        reconcile(t: number, maintenance?: boolean): Promise<void>
      }
      const real = inside.reconcile.bind(table)
      inside.reconcile = async (t, maintenance) => {
        await real(t, maintenance)
        table.clock = () => deadline + 5000
      }
    })
    const { hand } = await peek(id),
      actor = hand!.toAct === 0 ? a : b
    actor.send({
      t: 'act',
      handNo: 1,
      actionIndex: 0,
      reqId: 'timely',
      action: { type: 'call' },
    })
    await actor.next((f) => f.t === 'state' && f.view?.lastReqId === 'timely')
    expect((await peek(id)).hand!.actions[0].action.type).toBe('call')
  })

  it.each([0, 1, 2])(
    'F04_restore_zero_one_two_sockets retained=%i',
    async (retained) => {
      const { id } = await rated()
      await abortAllDurableObjects()
      await freezeClock(id, T0 + 300_000)
      if (retained >= 1) await connect(id, 'a')
      if (retained === 2) await connect(id, 'b')
      await elapse(id, 0)
      const graces = await runInDurableObject(stub(id), (_, state) =>
        state.storage.get<{ kind: string; at: number }[]>('deadlines'),
      )
      expect(graces!.filter((d) => d.kind === 'grace')).toHaveLength(
        2 - retained,
      )
      expect((await peek(id)).match.status).toBe('playing')
      if (retained === 0) {
        await abortAllDurableObjects()
        await freezeClock(id, T0 + 300_000 + GRACE_MS - 1)
        await elapse(id, 0)
        expect((await peek(id)).match.status).toBe('playing')
        await elapse(id, 1)
        const proof = await runInDurableObject(stub(id), (_, state) =>
          state.storage.get<TerminalProofV1>('terminalProof'),
        )
        expect(proof).toMatchObject({
          reason: 'abandoned',
          cause: 'mutual_absence',
          timeoutEvidence: [],
        })
        expect(proof?.absences).toHaveLength(2)
      }
    },
  )
})

describe('rating availability and immutable completion', () => {
  it('F14_unavailable_is_not_unrated', async () => {
    const local = { ...env, DEV_AUTH_SECRET: undefined }
    expect(
      await currentRating(
        { ...local, SUPABASE_URL: '' } as unknown as typeof env,
        UUID,
      ),
    ).toMatchObject({ status: 'unavailable' })
    for (const [data, status] of [
      [[], 'unrated'],
      [[{ rating: 1500, version: 0 }], 'rated'],
      [[{ rating: 1500 }], 'unavailable'],
      [{}, 'unavailable'],
    ] as const) {
      vi.stubGlobal('fetch', async () => Response.json(data))
      expect(await currentRating(local, UUID)).toMatchObject({ status })
    }
    vi.stubGlobal(
      'fetch',
      async () => new Response('unavailable', { status: 503 }),
    )
    expect(await currentRating(local, UUID)).toMatchObject({
      status: 'unavailable',
    })
    vi.stubGlobal('fetch', async () => {
      throw new Error('network')
    })
    expect(await currentRating(local, UUID)).toMatchObject({
      status: 'unavailable',
    })
  })

  it('canonical evidence is stable and rejects non-JSON values', async () => {
    expect(canonicalJSON({ z: -0, a: [true, { b: 2, a: 1 }] })).toBe(
      '{"a":[true,{"a":1,"b":2}],"z":0}',
    )
    expect(await evidenceDigest({ b: 2, a: 1 })).toBe(
      '43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777',
    )
    for (const invalid of [undefined, NaN, Infinity, { a: undefined }])
      expect(() => canonicalJSON(invalid)).toThrow()
  })

  it('B2_completion_is_immutable_bounded_and_last_hand_survives_next_deal', async () => {
    const id = await createTable('a'),
      a = await connect(id, 'a'),
      b = await connect(id, 'b')
    await a.next(isState(1))
    await freezeClock(id, T0)
    // Keep the decision timely after freezing the already-started table.
    await runInDurableObject(stub(id), (table: TableDO) => {
      const inside = table as unknown as {
        deadlines: { kind: string; at: number }[]
      }
      for (const d of inside.deadlines)
        if (d.kind === 'turn') d.at = T0 + 80_000
    })
    await move(id, { 0: a, 1: b }, () => ({ type: 'fold' }))
    const completion = (await latest(a)).completion!
    expect(completion).toMatchObject({
      resultAvailable: true,
      schedule: { shape: 'fold', earliestNextDealAt: T0 + 3000 },
    })
    expect(forbiddenKeys(completion)).toEqual([])
    expect(analysisKeys(completion)).toEqual([])
    await elapse(id, 2999)
    expect((await peek(id)).match.handNo).toBe(1)
    await elapse(id, 1)
    expect((await peek(id)).match.handNo).toBe(2)
    expect((await latest(a)).completion).toEqual(completion)
    const record = await runInDurableObject(stub(id), (_, state) =>
      state.storage.get<{ recordDigest: string }[]>('manifest'),
    )
    expect(record?.[0].recordDigest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('B2_preflop_runout_has_4100ms_bounded_schedule_and_public_allowlist', () => {
    let hand = startHand(
      {
        handNo: 1,
        seats: [
          { seat: 0, stack: 100 },
          { seat: 1, stack: 100 },
        ],
        button: 0,
        blinds: { sb: 10, bb: 20 },
      },
      seededDeck(44),
    )
    hand = act(hand, hand.toAct!, { type: 'raise', to: 100 })
    hand = act(hand, hand.toAct!, { type: 'call' })
    const record = {
      v: 1,
      matchId: crypto.randomUUID(),
      handNo: 1,
      segment: 1,
      config: hand.config,
      seats: [
        { seat: 0, userId: 'a', username: 'a' },
        { seat: 1, userId: 'b', username: 'b' },
      ],
      commitment: 'test',
      actions: [],
      board: hand.board,
      shown: hand.players
        .filter((p) => p.shown)
        .map((p) => ({ seat: p.seat, cards: p.cards! })),
      ...hand.result!,
    } satisfies HandRecordV1
    const completion = completeHand(hand, record, 3, T0, { 0: 1, 1: 1 })
    expect(completion.schedule).toMatchObject({
      shape: 'all_in_preflop',
      resultHoldMs: 900,
      earliestNextDealAt: T0 + 4100,
      beats: [
        { offsetMs: 900, boardCount: 3 },
        { offsetMs: 1800, boardCount: 4 },
        { offsetMs: 3200, boardCount: 5 },
      ],
    })
    expect(Object.keys(completion.final).sort()).toEqual(
      [
        'hand',
        'board',
        'shown',
        'participants',
        'stacksBySeat',
        'pots',
        'awards',
        'netBySeat',
        'showdown',
      ].sort(),
    )
    expect(JSON.stringify(completion)).not.toContain('userId')
    expect(forbiddenKeys(completion)).toEqual([])
  })
})
