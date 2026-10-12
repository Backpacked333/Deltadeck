// Rated hands are graded off the game path (P1-09): once a rated hand is
// archived and verified, the hands queue consumer grades every decision of
// both players against the population model and writes the grades with
// record_grades. Supabase is an in-memory fake that keeps archived hands (as
// in verify.test.ts) and grades the way Postgres does: one row per (hand,
// seat, decision), and a repeat changes nothing. The SQL side, including who
// may read a grade and when, is supabase/tests/grades.test.ts.
import {
  createExecutionContext,
  createMessageBatch,
  env,
  getQueueResult,
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
import type { HandState, PlayerAction, SeatId } from '../../src/engine/types'
import { gradeHand } from '../../src/lib/gradeHand'
import type { GradeRow } from '../../src/lib/gradeHand'
import { GRADE_VERSION } from '../../src/lib/grader'
import { forgetUsernames } from '../src/auth'
import { HU_FORMAT } from '../src/grade'
import worker from '../src/index'
import { RATED_CONFIG } from '../src/rated'
import type { InitBody, TableDO } from '../src/table'
import type { AuditedHand, HandMessage } from '../src/verify'
import { HANDS_QUEUE } from '../src/verify'
import {
  connect,
  createTable,
  elapse,
  elapseToNextDeal,
  freezeClock,
  isState,
  move,
  peek,
  setClock,
  stub,
} from './helpers'
import type { Client } from './helpers'

const ALICE = '31111111-1111-4111-8111-111111111111'
const BOB = '32222222-2222-4222-8222-222222222222'
const NAMES: Record<string, string> = { [ALICE]: 'alice', [BOB]: 'bob' }
const T0 = 1_800_000_000_000

type GradeCall = {
  handId: string
  format: string
  modelVersion: string
  grades: GradeRow[]
}
const fake = {
  hands: new Map<string, AuditedHand>(),
  /** What Postgres would hold: the first write of each decision wins. */
  grades: new Map<string, GradeRow>(),
  gradeCalls: [] as GradeCall[],
  verified: [] as string[],
  ends: [] as { matchId: string; result: Record<string, unknown> }[],
  gradesDown: false,
}

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
      const fn = url.pathname.replace('/rest/v1/rpc/', '')
      const p = JSON.parse(String(init!.body)).p
      switch (fn) {
        case 'record_match':
          if (p.result) fake.ends.push({ matchId: p.id, result: p.result })
          return new Response(null, { status: 204 })
        case 'record_hand':
          fake.hands.set(p.id, {
            id: p.id,
            matchId: p.matchId,
            handNo: p.handNo,
            commitment: p.commitment,
            leaves: p.leaves,
            reveal: p.reveal,
            record: p.record,
            verified: false,
            deck: p.deck,
            secret: p.secret,
            holes: p.holes,
            kind: 'hu-rated',
            archive: structuredClone(p),
            sourceToken: `source:${p.id}`,
          })
          return new Response(null, { status: 204 })
        case 'audit_hand':
          return Response.json(fake.hands.get(p.id) ?? null)
        case 'verify_hand_v2':
          expect(p.sourceToken).toBe(`source:${p.id}`)
          fake.hands.get(p.id)!.verification = {
            version: p.version,
            recordDigest: p.recordDigest,
            archiveDigest: p.archiveDigest,
          }
          fake.verified.push(p.id)
          fake.hands.get(p.id)!.verified = true
          return new Response(null, { status: 204 })
        case 'verify_hand':
          fake.verified.push(p.id)
          fake.hands.get(p.id)!.verified = true
          return new Response(null, { status: 204 })
        case 'record_grades': {
          if (fake.gradesDown) return new Response('down', { status: 503 })
          const call = p as GradeCall
          fake.gradeCalls.push(structuredClone(call))
          for (const g of call.grades) {
            const k = `${call.handId}|${g.seat}|${g.idx}`
            if (!fake.grades.has(k)) fake.grades.set(k, g)
          }
          return new Response(null, { status: 204 })
        }
        case 'record_incident':
          return new Response(null, { status: 204 })
      }
      return new Response('not stubbed', { status: 599 })
    },
  )
})
afterAll(() => vi.unstubAllGlobals())
beforeEach(() => {
  fake.hands.clear()
  fake.grades.clear()
  fake.gradeCalls = []
  fake.verified = []
  fake.ends = []
  fake.gradesDown = false
  forgetUsernames()
})

async function until(test: () => boolean, ms = 20_000) {
  for (let t = 0; t < ms && !test(); t += 10)
    await new Promise((r) => setTimeout(r, 10))
  if (!test()) throw new Error('timed out')
}

/** A rated table as the lobby makes one, with both players seated. */
async function rated(queue?: Queue) {
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
  if (queue) await routeQueue(matchId, queue)
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

/** Points a table's HAND_QUEUE at `queue` instead of the real one. */
const routeQueue = (matchId: string, queue: Queue) =>
  runInDurableObject(stub(matchId), (instance: TableDO) => {
    const inside = instance as unknown as { env: typeof env }
    inside.env = { ...inside.env, HAND_QUEUE: queue }
  })

/** A queue that only remembers what it was sent. */
function recorder() {
  const sent: unknown[] = []
  const queue = {
    send: async (body: unknown) => {
      sent.push(body)
    },
  } as unknown as Queue
  return { sent, queue }
}

/** A rated hand's archive (and so its grading) is released as the next starts. */
async function nextHand(matchId: string, alice: Client, handNo: number) {
  await elapseToNextDeal(matchId)
  await alice.next(isState(handNo))
}

/** Plays the current hand to its end, every move by `choose`. */
async function finish(
  matchId: string,
  seats: Record<SeatId, Client>,
  choose: (hand: HandState) => PlayerAction,
) {
  for (;;) {
    const { hand } = await peek(matchId)
    if (hand!.result) return
    await move(matchId, seats, choose)
  }
}

/** Lets the seat to act run out of time; resolves once the table acted. */
async function timeOut(matchId: string, seats: Record<SeatId, Client>) {
  const { hand } = await peek(matchId)
  const from = seats[0].frames.length
  await elapse(matchId, RATED_CONFIG.decisionMs + RATED_CONFIG.bankMs)
  await seats[0].next(
    (f) =>
      isState(hand!.config.handNo, hand!.actions.length + 1)(f) ||
      f.t === 'match_end',
    from,
  )
}

const fold = (): PlayerAction => ({ type: 'fold' })
const passive = (hand: HandState): PlayerAction =>
  legalActions(hand).canCheck ? { type: 'check' } : { type: 'call' }
const raiseTo = (to: number) => (): PlayerAction => ({ type: 'raise', to })

async function deliver(bodies: unknown[], attempts: number) {
  const batch = createMessageBatch(
    HANDS_QUEUE,
    bodies.map((body, i) => ({
      id: `m${i}`,
      timestamp: new Date(),
      attempts,
      body,
    })),
  )
  const ctx = createExecutionContext()
  await worker.queue(batch, env)
  return getQueueResult(batch, ctx)
}

const gradesOf = (handId: string) =>
  [...fake.grades]
    .filter(([k]) => k.startsWith(`${handId}|`))
    .map(([, g]) => g)
    .sort((a, b) => a.idx - b.idx)

describe('grading a rated hand', () => {
  it('grades every decision of both players once the hand is verified, through the real queue', async () => {
    const { matchId, alice, seats } = await rated()
    await finish(matchId, seats, passive) // to showdown: 8 decisions
    await nextHand(matchId, alice, 2)
    const id = `${matchId}:1`
    await until(() => fake.gradeCalls.some((c) => c.handId === id))
    expect(fake.verified).toContain(id)

    const call = fake.gradeCalls.find((c) => c.handId === id)!
    expect(call.format).toBe(HU_FORMAT)
    expect(call.modelVersion).toBe(GRADE_VERSION)
    // Exactly the archived hand's decisions, in order, each by its player.
    const { record, deck } = fake.hands.get(id)!
    expect(record.actions).toHaveLength(8)
    expect(call.grades.map((g) => [g.idx, g.seat])).toEqual(
      record.actions.map((a, idx) => [idx, a.seat]),
    )
    expect(new Set(call.grades.map((g) => g.seat))).toEqual(new Set([0, 1]))
    expect(call.grades).toEqual(gradeHand(record, deck))
    for (const g of call.grades) {
      expect(['best', 'good', 'inaccuracy', 'mistake', 'blunder']).toContain(
        g.grade,
      )
      expect(g.accuracy).toBeGreaterThanOrEqual(0)
      expect(g.accuracy).toBeLessThanOrEqual(100)
      expect(g.evLost).toBeGreaterThanOrEqual(0)
    }
    expect(gradesOf(id)).toEqual(call.grades)
    // No grade, or anything like one, ever reaches a player's socket.
    for (const c of Object.values(seats))
      expect(JSON.stringify(c.frames)).not.toMatch(/"(evLost|accuracy|grade)"/i)
  }, 60_000)

  it('writes no duplicate and changes no grade when the message is redelivered', async () => {
    const { matchId, alice, seats } = await rated()
    await finish(matchId, seats, passive)
    await nextHand(matchId, alice, 2)
    const id = `${matchId}:1`
    await until(() => gradesOf(id).length === 8)
    const first = gradesOf(id)
    const body: HandMessage = { matchId, handNo: 1, rated: true }
    for (const attempts of [2, 3]) {
      const result = await deliver([body], attempts)
      expect(result.explicitAcks).toEqual(['m0'])
      expect(result.retryMessages).toEqual([])
    }
    expect(gradesOf(id)).toEqual(first)
    // Every delivery graded the hand bit for bit the same, and the hand was
    // verified once.
    const calls = fake.gradeCalls.filter((c) => c.handId === id)
    expect(calls.length).toBeGreaterThanOrEqual(3)
    for (const c of calls) expect(c.grades).toEqual(first)
    expect(fake.verified.filter((v) => v === id)).toEqual([id])
  }, 60_000)

  it('grades a move the clock made for a player who ran out of time, like any other', async () => {
    const { matchId, alice, seats } = await rated()
    await move(matchId, seats, raiseTo(60)) // Alice, the button
    await timeOut(matchId, seats) // Bob folds on the clock
    await nextHand(matchId, alice, 2)
    const id = `${matchId}:1`
    await until(() => fake.gradeCalls.some((c) => c.handId === id))
    expect(fake.hands.get(id)!.record.actions.map((a) => a.source)).toEqual([
      'client',
      'timeout',
    ])
    expect(gradesOf(id).map((g) => [g.idx, g.seat])).toEqual([
      [0, 0],
      [1, 1],
    ])
  }, 60_000)
})

describe('a grading failure', () => {
  it('holds up nothing: verification, the next hands, the match result and its rating call all go ahead, and the grades come later', async () => {
    fake.gradesDown = true
    const { matchId, alice, seats } = await rated()
    // Hand 1: Alice raises, Bob folds. Hands 2 to 4: Bob is away and folds on
    // the clock each time; the third timeout in a row forfeits the match.
    await move(matchId, seats, raiseTo(60))
    await move(matchId, seats, fold)
    await nextHand(matchId, alice, 2)
    await until(() => fake.verified.includes(`${matchId}:1`))
    await timeOut(matchId, seats)
    await nextHand(matchId, alice, 3)
    await move(matchId, seats, raiseTo(60))
    await timeOut(matchId, seats)
    await nextHand(matchId, alice, 4)
    await timeOut(matchId, seats)
    await alice.next((f) => f.t === 'match_end')
    // The result reached Postgres (record_match also settles the rating), and
    // every hand was archived and verified, while no grade could be written.
    await until(() => fake.ends.some((e) => e.matchId === matchId))
    expect(fake.ends.find((e) => e.matchId === matchId)!.result).toMatchObject({
      reason: 'forfeit',
      forfeit: 1,
    })
    const ids = [1, 2, 3, 4].map((n) => `${matchId}:${n}`)
    await until(() => ids.every((id) => fake.verified.includes(id)))
    expect(ids.flatMap(gradesOf)).toEqual([])

    // A delivery while grading still fails is retried, not verified again.
    const bodies = [1, 2, 3, 4].map(
      (handNo): HandMessage => ({ matchId, handNo, rated: true }),
    )
    const failed = await deliver([bodies[0]], 2)
    expect(failed.explicitAcks).toEqual([])
    expect(failed.retryMessages.map((m) => m.msgId)).toEqual(['m0'])
    expect(fake.verified.filter((v) => v === ids[0])).toEqual([ids[0]])

    // Once it works, the retries grade every move of every hand, the
    // clock's included.
    fake.gradesDown = false
    const later = await deliver(bodies, 3)
    expect(later.explicitAcks.sort()).toEqual(['m0', 'm1', 'm2', 'm3'])
    expect(ids.map((id) => gradesOf(id).map((g) => [g.idx, g.seat]))).toEqual([
      [
        [0, 0],
        [1, 1],
      ],
      [[0, 1]], // Bob's button: the clock folds
      [
        [0, 0],
        [1, 1],
      ],
      [[0, 1]],
    ])
  }, 90_000)
})

describe('what is graded', () => {
  it('the table marks rated hands for grading, and only rated hands', async () => {
    const ratedQueue = recorder()
    const r = await rated(ratedQueue.queue)
    await move(r.matchId, r.seats, fold)
    await nextHand(r.matchId, r.alice, 2)
    await until(() => ratedQueue.sent.length === 1)
    expect(ratedQueue.sent).toEqual([
      { matchId: r.matchId, handNo: 1, rated: true },
    ])

    const casualQueue = recorder()
    const casualA = '33333333-3333-4333-8333-333333333333'
    const casualB = '34444444-4444-4444-8444-444444444444'
    NAMES[casualA] = 'casual_alice'
    NAMES[casualB] = 'casual_bob'
    const matchId = await createTable(casualA, 1)
    await routeQueue(matchId, casualQueue.queue)
    await freezeClock(matchId)
    const seats: Record<SeatId, Client> = {
      0: await connect(matchId, casualA),
      1: await connect(matchId, casualB),
    }
    await seats[0].next(isState(1))
    await move(matchId, seats, fold)
    await until(() => casualQueue.sent.length === 1)
    expect(casualQueue.sent).toEqual([{ matchId, handNo: 1 }])
  }, 60_000)

  it('the consumer verifies but does not grade a hand whose message is not marked rated', async () => {
    const { matchId, alice, seats } = await rated(recorder().queue)
    await move(matchId, seats, raiseTo(60))
    await move(matchId, seats, fold)
    await nextHand(matchId, alice, 2)
    const id = `${matchId}:1`
    await until(() => fake.hands.has(id))
    for (const rated of [undefined, 'yes', 1]) {
      const result = await deliver([{ matchId, handNo: 1, rated }], 1)
      expect(result.explicitAcks).toEqual(['m0'])
    }
    expect(fake.verified).toEqual([id])
    expect(fake.gradeCalls).toEqual([])
  }, 60_000)
})

describe('decision time', () => {
  it('is kept for every action in the archived hand, for integrity checks later (no detection yet)', async () => {
    const { matchId, alice, seats } = await rated(recorder().queue)
    await setClock(matchId, T0 + 4_500) // Alice thinks for 4.5 s
    await move(matchId, seats, raiseTo(60))
    await timeOut(matchId, seats) // Bob uses his decision time and his bank
    await nextHand(matchId, alice, 2)
    const id = `${matchId}:1`
    await until(() => fake.hands.has(id))
    const think = RATED_CONFIG.decisionMs + RATED_CONFIG.bankMs
    expect(
      fake.hands
        .get(id)!
        .record.actions.map((a) => [a.source, a.decisionMs, a.atMs]),
    ).toEqual([
      ['client', 4_500, 4_500],
      ['timeout', think, 4_500 + think],
    ])
  })
})
