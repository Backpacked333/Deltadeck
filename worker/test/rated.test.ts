// Rated heads-up in the table server (P1-01, ADR amendment 2026-10-10):
// 40 fresh-deck hands, a 60 s bank for each half, the result from the
// luck-adjusted total with a draw band, and the forfeit rule. Players are
// real account ids, so every call reaches the (stubbed) archive.
import {
  abortAllDurableObjects,
  env,
  runInDurableObject,
} from 'cloudflare:test'
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { legalActions } from '../../src/engine/hand'
import { luckAdjusted } from '../../src/engine/luck'
import type { HandState, PlayerAction, SeatId } from '../../src/engine/types'
import type { HandRecordV1, ServerMsg } from '../../src/shared/protocol'
import { forgetUsernames } from '../src/auth'
import { DRAW_BAND_BB, GRACE_MS, outcomes, RATED_CONFIG } from '../src/rated'
import { runoutMs } from '../../src/shared/pacing'
import { NEXT_HAND_MS } from '../src/table'
import type { InitBody, TableDO } from '../src/table'
import {
  connect,
  createTable,
  elapse,
  freezeClock,
  isState,
  move,
  peek,
  setClock,
  stub,
} from './helpers'
import type { Client } from './helpers'

const ALICE = '11111111-1111-4111-8111-111111111111'
const BOB = '22222222-2222-4222-8222-222222222222'
const NAMES: Record<string, string> = { [ALICE]: 'alice', [BOB]: 'bob' }
const T0 = 1_800_000_000_000

type Call = { rpc: string; p: Record<string, unknown> }
let calls: Call[] = []

beforeAll(() => {
  const realFetch = globalThis.fetch
  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.origin !== new URL(env.SUPABASE_URL).origin)
        return realFetch(input, init)
      if (url.pathname === '/rest/v1/players') {
        const id = url.searchParams.get('user_id')!.slice(3)
        return Response.json([{ username: NAMES[id] }])
      }
      if (url.pathname.endsWith('/audit_hand'))
        return Response.json({ verified: true })
      if (url.pathname.startsWith('/rest/v1/rpc/')) {
        const rpc = url.pathname.slice('/rest/v1/rpc/'.length)
        calls.push({ rpc, p: JSON.parse(String(init!.body)).p })
        return new Response(null, { status: 204 })
      }
      return new Response('not stubbed', { status: 599 })
    },
  )
})
afterAll(() => vi.unstubAllGlobals())
beforeEach(() => {
  calls = []
  forgetUsernames()
})

async function until(test: () => boolean) {
  for (let i = 0; i < 600 && !test(); i++)
    await new Promise((r) => setTimeout(r, 5))
  if (!test()) throw new Error('timed out')
}

/** A rated table as the lobby makes one, with both players seated. */
async function rated() {
  const matchId = crypto.randomUUID()
  const body: InitBody = {
    matchId,
    creator: { userId: ALICE, username: 'alice' },
    opponent: { userId: BOB, username: 'bob' },
    kind: 'hu-rated',
  }
  const made = await stub(matchId).fetch('https://table/init', {
    method: 'POST',
    body: JSON.stringify(body),
  })
  expect(made.status).toBe(201)
  await freezeClock(matchId, T0)
  const alice = await connect(matchId, ALICE)
  const bob = await connect(matchId, BOB)
  await alice.next(isState(1))
  return {
    matchId,
    alice,
    seats: { 0: alice, 1: bob } as Record<SeatId, Client>,
  }
}

/** Lets the seat to act run out of time; resolves once the table acted. */
async function timeOut(matchId: string, seats: Record<SeatId, Client>) {
  const { hand } = await peek(matchId)
  const from = seats[0].frames.length
  // Past any decision clock plus a full bank: only the turn deadline is due.
  await elapse(matchId, RATED_CONFIG.decisionMs + RATED_CONFIG.bankMs)
  await seats[0].next(
    (f) =>
      isState(hand!.config.handNo, hand!.actions.length + 1)(f) ||
      f.t === 'match_end',
    from,
  )
}

async function nextHand(matchId: string, alice: Client, handNo: number) {
  await elapse(matchId, NEXT_HAND_MS)
  await alice.next(isState(handNo))
}

const fold = (): PlayerAction => ({ type: 'fold' })
const passive = (hand: HandState): PlayerAction =>
  legalActions(hand).canCheck ? { type: 'check' } : { type: 'call' }
const raiseTo =
  (to: number | 'max') =>
  (hand: HandState): PlayerAction => ({
    type: 'raise',
    to: to === 'max' ? legalActions(hand).maxRaiseTo : to,
  })

const handCalls = () =>
  calls
    .filter((c) => c.rpc === 'record_hand')
    .map((c) => c.p as { handNo: number; record: HandRecordV1 })
const endCall = () =>
  calls.find((c) => c.rpc === 'record_match' && c.p.result)?.p as
    | { kind: string; config: unknown; result: Record<string, unknown> }
    | undefined
const matchEnd = (c: Client) =>
  c.frames.find((f) => f.t === 'match_end') as
    | Extract<ServerMsg, { t: 'match_end' }>
    | undefined

describe('a rated match', () => {
  it('deals 40 hands and ends complete with an outcome per player', async () => {
    const { matchId, alice, seats } = await rated()
    const welcome = alice.frames.find((f) => f.t === 'welcome')!
    expect(welcome.t === 'welcome' && welcome.table).toMatchObject({
      kind: 'hu-rated',
      handsTotal: 40,
    })
    // Bob folds whenever he is to act; Alice calls. Bob loses his big blind
    // on Alice's buttons and his small blind on his own: 20 × 30 = 600.
    for (let n = 1; n <= 40; n++) {
      if (n > 1) await nextHand(matchId, alice, n)
      for (;;) {
        const { hand } = await peek(matchId)
        if (hand!.result) break
        await move(matchId, seats, hand!.toAct === 1 ? fold : passive)
      }
    }
    await elapse(matchId, NEXT_HAND_MS) // no hand 41: the match ends
    await alice.next((f) => f.t === 'match_end')
    expect(matchEnd(alice)!.result).toEqual({
      netBySeat: { 0: 600, 1: -600 },
      reason: 'complete',
      adjustedBySeat: { 0: 600, 1: -600 },
      outcomeBySeat: { 0: 'win', 1: 'loss' },
    })
    await until(() => endCall() !== undefined)
    const end = endCall()!
    expect(end.kind).toBe('hu-rated')
    expect(end.config).toEqual(RATED_CONFIG)
    expect(end.result).toMatchObject({
      adjustedBySeat: { 0: 600, 1: -600 },
      outcomeBySeat: { 0: 'win', 1: 'loss' },
    })
    // Every hand is archived, each with its (here unchanged) luck entry.
    const hands = handCalls()
    expect(hands.map((h) => h.handNo)).toEqual(
      Array.from({ length: 40 }, (_, i) => i + 1),
    )
    for (const h of hands)
      expect(h.record.luck).toEqual({
        allInAt: null,
        equity: null,
        adjustedBySeat: h.record.netBySeat,
      })
  }, 60_000)

  it('gives each half its own 60 s bank; unused bank does not carry over', async () => {
    const { matchId, alice, seats } = await rated()
    // Hand 1: Alice (button, first to act) thinks for 70 s: 50 s of bank.
    await setClock(matchId, T0 + 70_000)
    await move(matchId, seats, fold)
    const banks = async () =>
      (
        (await peek(matchId)).match as unknown as {
          players: { bankMs: number }[]
        }
      ).players.map((p) => p.bankMs)
    expect(await banks()).toEqual([10_000, 60_000])
    for (let n = 2; n <= 20; n++) {
      await nextHand(matchId, alice, n)
      await move(matchId, seats, fold)
    }
    expect(await banks()).toEqual([10_000, 60_000])
    await nextHand(matchId, alice, 21)
    expect(await banks()).toEqual([60_000, 60_000])
    // Hand 21: Alice's button; her clock shows the refilled bank.
    const view = alice.frames.filter(isState(21)).at(-1)
    expect(
      (view?.t === 'state' || view?.t === 'welcome') && view.view?.clock,
    ).toMatchObject({ bankMs: 60_000 })
  }, 30_000)

  it('settles an all-in hand at equity before archiving it, in the record and the total', async () => {
    const { matchId, alice, seats } = await rated()
    // Hand 1: Alice limps, Bob checks; on the flop Bob moves in, Alice calls.
    await move(matchId, seats, passive)
    await move(matchId, seats, passive)
    await move(matchId, seats, raiseTo('max'))
    await move(matchId, seats, passive)
    const { hand } = await peek(matchId)
    expect(hand!.result!.showdown).toBe(true)
    const luck = luckAdjusted(hand!)
    expect(luck.allInAt).toBe(3)
    // Held until the luck is settled: the match call goes, the hand waits.
    await until(() => calls.some((c) => c.rpc === 'record_match'))
    expect(handCalls()).toEqual([])
    // The next deal waits for the flop all-in's turn and river (audit F02).
    await elapse(matchId, NEXT_HAND_MS + runoutMs(3))
    await alice.next(isState(2))
    await until(() => handCalls().length === 1)
    expect(handCalls()[0].record.luck).toEqual({
      allInAt: 3,
      equity: luck.equity,
      adjustedBySeat: luck.netBySeat,
    })
    const { match } = await peek(matchId)
    expect((match as unknown as { adjusted: unknown }).adjusted).toEqual(
      luck.netBySeat,
    )
  })

  it('ends at the third timeout in a row as a loss for that player, even one ahead on chips', async () => {
    const { matchId, alice, seats } = await rated()
    // Hand 1: Bob wins 600 (Alice raises, Bob moves in, Alice folds).
    await move(matchId, seats, raiseTo(600))
    await move(matchId, seats, raiseTo('max'))
    await move(matchId, seats, fold)
    // Hands 2 to 4: Bob is away and folds on the clock each time.
    await nextHand(matchId, alice, 2)
    await timeOut(matchId, seats) // Bob's button: -10
    await nextHand(matchId, alice, 3)
    await move(matchId, seats, raiseTo(60))
    await timeOut(matchId, seats) // -20
    await nextHand(matchId, alice, 4)
    await timeOut(matchId, seats) // -10, the third in a row
    await alice.next((f) => f.t === 'match_end')
    expect(matchEnd(alice)!.result).toEqual({
      netBySeat: { 0: -560, 1: 560 },
      reason: 'forfeit',
      forfeit: 1,
      adjustedBySeat: { 0: -560, 1: 560 },
      outcomeBySeat: { 0: 'win', 1: 'loss' },
    })
    await until(() => endCall() !== undefined)
    expect(endCall()!.result).toMatchObject({
      reason: 'forfeit',
      forfeit: 1,
      outcomeBySeat: { 0: 'win', 1: 'loss' },
    })
    // The last hand was held for its luck; the finish releases it.
    await until(() => handCalls().length === 4)
    expect(handCalls().map((h) => h.handNo)).toEqual([1, 2, 3, 4])
  })
})

/** Closes a seat's socket and waits until the table has seen it go. */
async function leave(matchId: string, c: Client) {
  c.ws.close(1000, 'gone')
  for (let i = 0; i < 400; i++) {
    const open = await runInDurableObject(
      stub(matchId),
      (t: TableDO) =>
        (t as unknown as { ctx: DurableObjectState }).ctx
          .getWebSockets()
          .filter((ws) => ws.readyState === 1).length,
    )
    const graces = await runInDurableObject(
      stub(matchId),
      (t: TableDO) =>
        (t as unknown as { deadlines: { kind: string }[] }).deadlines.filter(
          (d) => d.kind === 'grace',
        ).length,
    )
    if (graces > 0 && open < 2) return graces
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('the table never saw the socket close')
}

const actionsOf = async (matchId: string) =>
  (await peek(matchId)).hand!.actions.length

describe('a player who leaves a rated match', () => {
  it('has each turn played at once after 60 s away, and three in a row forfeit', async () => {
    const { matchId, alice, seats } = await rated()
    await move(matchId, seats, passive) // hand 1: Alice limps; Bob to act
    await leave(matchId, seats[1])
    await elapse(matchId, GRACE_MS - 1)
    expect(await actionsOf(matchId)).toBe(1) // still Bob's to make
    await elapse(matchId, 1) // the grace ends: his turn is played for him
    expect(await actionsOf(matchId)).toBe(2)
    // The flop: Bob acts first, and his turn is played with no clock at all.
    await elapse(matchId, 0)
    expect(await actionsOf(matchId)).toBe(3)
    await move(matchId, seats, passive) // Alice checks
    await elapse(matchId, 0) // the turn: Bob's third timeout in a row
    await alice.next((f) => f.t === 'match_end')
    expect(matchEnd(alice)!.result).toMatchObject({
      reason: 'forfeit',
      forfeit: 1,
      outcomeBySeat: { 0: 'win', 1: 'loss' },
    })
  })

  it('keeps the normal clock if they are back within the grace', async () => {
    const { matchId, seats } = await rated()
    await move(matchId, seats, passive) // Bob to act
    await leave(matchId, seats[1])
    await elapse(matchId, 30_000)
    const back = await connect(matchId, BOB)
    await back.next((f) => f.t === 'welcome')
    await elapse(matchId, 30_001) // past where the grace would have ended
    expect(await actionsOf(matchId)).toBe(1)
    // His own clock still runs: 20 s plus the 60 s bank from his turn.
    await elapse(matchId, 20_000)
    expect(await actionsOf(matchId)).toBe(2)
    const { match } = await peek(matchId)
    expect(
      (match as unknown as { players: { timeouts: number }[] }).players[1]
        .timeouts,
    ).toBe(1)
  })

  it('gives a player back from away a fresh clock for a turn still pending', async () => {
    const { matchId, seats } = await rated()
    await move(matchId, seats, passive) // Bob to act
    await leave(matchId, seats[1])
    await elapse(matchId, GRACE_MS) // away; his preflop turn played for him
    // The flop is his to act, due at once, but the alarm is 30 s late and
    // he is back first.
    await setClock(matchId, T0 + GRACE_MS + 30_000)
    const back = await connect(matchId, BOB)
    await back.next((f) => f.t === 'welcome')
    // 20 s + his 20 s of bank left, from now: not from when the turn began.
    await elapse(matchId, 39_999)
    expect(await actionsOf(matchId)).toBe(2)
    await elapse(matchId, 1)
    expect(await actionsOf(matchId)).toBe(3)
  })

  it('charges no bank for a turn played while away, even when the alarm is late', async () => {
    const { matchId, seats } = await rated()
    await move(matchId, seats, passive) // Bob to act
    await leave(matchId, seats[1])
    await elapse(matchId, GRACE_MS)
    const bank = async () =>
      (
        (await peek(matchId)).match as unknown as {
          players: { bankMs: number }[]
        }
      ).players[1].bankMs
    // The turn he left on ran 60 s of his normal clock: 40 s of bank.
    expect(await bank()).toBe(20_000)
    // The flop turn began while he was away; its alarm runs 45 s late.
    await setClock(matchId, T0 + GRACE_MS + 45_000)
    await elapse(matchId, 0)
    expect(await actionsOf(matchId)).toBe(3)
    expect(await bank()).toBe(20_000)
  })

  it('is void when both players are gone past the grace, with an abandonment for each', async () => {
    const { matchId, seats } = await rated()
    await leave(matchId, seats[0])
    await leave(matchId, seats[1])
    await elapse(matchId, GRACE_MS)
    const { match } = await peek(matchId)
    expect(match.status).toBe('finished')
    await until(() => endCall() !== undefined)
    // No hand finished, nobody wins: v4 voids it and writes leave_mid_hand
    // for each seat in `abandoned`.
    expect(endCall()!.result).toEqual({
      netBySeat: { 0: 0, 1: 0 },
      reason: 'abandoned',
      abandoned: [0, 1],
      adjustedBySeat: { 0: 0, 1: 0 },
    })
  })
})

describe('a restart while a rated match is played (audit F04)', () => {
  const gracesOf = (matchId: string) =>
    runInDurableObject(stub(matchId), (t: TableDO) =>
      (
        t as unknown as {
          deadlines: { kind: string; seat: number; at: number }[]
        }
      ).deadlines.filter((d) => d.kind === 'grace'),
    )
  /** A deploy: every object dropped, storage kept, every socket closed unseen. */
  async function restart(matchId: string, at: number) {
    await abortAllDurableObjects()
    await freezeClock(matchId, at)
  }
  const turnLimit = RATED_CONFIG.decisionMs + RATED_CONFIG.bankMs

  it('with nobody back, both get the grace and the match is void, not a forfeit', async () => {
    const { matchId, seats } = await rated()
    await move(matchId, seats, passive) // Bob to act
    await restart(matchId, T0)
    // Bob's turn runs out: the alarm finds both seats without a socket and
    // starts their grace from now, never backdated.
    await elapse(matchId, turnLimit)
    expect((await gracesOf(matchId)).map((d) => [d.seat, d.at])).toEqual([
      [0, T0 + turnLimit + GRACE_MS],
      [1, T0 + turnLimit + GRACE_MS],
    ])
    await elapse(matchId, GRACE_MS)
    expect((await peek(matchId)).match.status).toBe('finished')
    await until(() => endCall() !== undefined)
    expect(endCall()!.result).toMatchObject({
      reason: 'abandoned',
      abandoned: [0, 1],
    })
  })

  it('a second restart does not renew the grace', async () => {
    const { matchId, seats } = await rated()
    await move(matchId, seats, passive)
    await restart(matchId, T0)
    await elapse(matchId, turnLimit) // graces from T0 + turnLimit
    await restart(matchId, T0 + turnLimit + 30_000)
    await elapse(matchId, 0)
    expect((await gracesOf(matchId)).map((d) => d.at)).toEqual([
      T0 + turnLimit + GRACE_MS,
      T0 + turnLimit + GRACE_MS,
    ])
    await elapse(matchId, 30_000)
    await until(() => endCall() !== undefined)
    expect(endCall()!.result).toMatchObject({ reason: 'abandoned' })
  })

  it('the player who comes back starts the grace of the one still away', async () => {
    const { matchId, seats } = await rated()
    await move(matchId, seats, passive)
    await restart(matchId, T0 + 5000)
    const alice = await connect(matchId, ALICE)
    await alice.next((f) => f.t === 'welcome')
    expect((await gracesOf(matchId)).map((d) => [d.seat, d.at])).toEqual([
      [1, T0 + 5000 + GRACE_MS],
    ])
  })
})

describe('the draw band', () => {
  it('+40 chips (2.00 bb) over the match is a draw and +41 is a win', () => {
    const bb = RATED_CONFIG.blinds.bb
    expect(DRAW_BAND_BB).toBe(2)
    expect(outcomes({ 0: 40, 1: -40 }, bb)).toEqual({ 0: 'draw', 1: 'draw' })
    expect(outcomes({ 0: -40, 1: 40 }, bb)).toEqual({ 0: 'draw', 1: 'draw' })
    expect(outcomes({ 0: 41, 1: -41 }, bb)).toEqual({ 0: 'win', 1: 'loss' })
    expect(outcomes({ 0: -41, 1: 41 }, bb)).toEqual({ 0: 'loss', 1: 'win' })
    // Equity sums carry float noise; the two seats never disagree.
    expect(outcomes({ 0: 40 + 1e-12, 1: -40 + 1e-12 }, bb)).toEqual({
      0: 'draw',
      1: 'draw',
    })
  })
})

describe('a casual match', () => {
  it('is archived exactly as before: no luck, adjusted totals or outcomes', async () => {
    const matchId = await createTable(ALICE, 1)
    await freezeClock(matchId, T0)
    const alice = await connect(matchId, ALICE)
    const bob = await connect(matchId, BOB)
    await alice.next(isState(1))
    await move(matchId, { 0: alice, 1: bob }, fold)
    await elapse(matchId, NEXT_HAND_MS)
    await alice.next((f) => f.t === 'match_end')
    expect(Object.keys(matchEnd(alice)!.result).sort()).toEqual([
      'netBySeat',
      'reason',
    ])
    await until(() => endCall() !== undefined)
    expect(Object.keys(endCall()!.result).sort()).toEqual([
      'netBySeat',
      'reason',
    ])
    expect(handCalls()[0].record.luck).toBeUndefined()
  })
})
