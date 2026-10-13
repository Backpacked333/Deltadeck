// Every archived hand is re-verified off the game path (ADR §Post-hand
// grading placement): the table queues { matchId, handNo } once Postgres has
// the hand, and the queue consumer replays it from the full deck. Supabase is
// an in-memory fake here that keeps what record_hand was sent and serves it
// back through audit_hand; the SQL side is supabase/tests/verify.test.ts.
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
import { luckAdjusted } from '../../src/engine/luck'
import { forgetUsernames } from '../src/auth'
import type { TableController } from '../src/controller'
import { LocalController } from '../src/controller'
import worker from '../src/index'
import { NEXT_HAND_MS } from '../src/table'
import type { Outbox, TableDO } from '../src/table'
import type { AuditedHand } from '../src/verify'
import { HANDS_DLQ, HANDS_QUEUE, problemsWith, retryDelay } from '../src/verify'
import {
  connect,
  createTable,
  elapse,
  freezeClock,
  isState,
  move,
  peek,
  stub,
} from './helpers'
import type { Client } from './helpers'

const ALICE = 'a11ce000-0000-4000-8000-000000000011'
const BOB = 'b0b00000-0000-4000-8000-000000000012'
const NAMES: Record<string, string> = { [ALICE]: 'alice', [BOB]: 'bob' }

type Incident = {
  matchId: string
  handNo?: number
  kind: string
  detail: unknown
}
const fake = {
  hands: new Map<string, AuditedHand>(),
  incidents: [] as Incident[],
  verified: [] as string[],
  audits: [] as string[],
  archived: [] as string[],
  down: false,
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
      expect(new Headers(init?.headers).get('apikey')).toBe('sb_secret_test')
      if (fake.down) return new Response('down', { status: 503 })
      const p = JSON.parse(String(init!.body)).p
      switch (fn) {
        case 'record_match':
          return new Response(null, { status: 204 })
        case 'record_hand':
          fake.archived.push(p.id)
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
          })
          return new Response(null, { status: 204 })
        case 'audit_hand':
          fake.audits.push(p.id)
          return Response.json(fake.hands.get(p.id) ?? null)
        case 'verify_hand':
          fake.verified.push(p.id)
          fake.hands.get(p.id)!.verified = true
          return new Response(null, { status: 204 })
        case 'record_incident':
          // Postgres keeps one per (match, hand, kind); so does the fake.
          if (
            !fake.incidents.some(
              (i) =>
                i.matchId === p.matchId &&
                i.handNo === p.handNo &&
                i.kind === p.kind,
            )
          )
            fake.incidents.push(p)
          return new Response(null, { status: 204 })
      }
      return new Response('not stubbed', { status: 599 })
    },
  )
})
afterAll(() => vi.unstubAllGlobals())
beforeEach(() => {
  fake.hands.clear()
  fake.incidents = []
  fake.verified = []
  fake.audits = []
  fake.archived = []
  fake.down = false
  forgetUsernames()
})

async function until(test: () => boolean, ms = 10_000) {
  for (let t = 0; t < ms && !test(); t += 10)
    await new Promise((r) => setTimeout(r, 10))
  if (!test()) throw new Error('timed out')
}

/** A recordable match, played hand by hand to showdown with calls/checks. */
async function play(handsTotal: number, controller?: TableController) {
  const matchId = await createTable(ALICE, handsTotal)
  await freezeClock(matchId)
  if (controller)
    await runInDurableObject(stub(matchId), (instance: TableDO) => {
      instance.controller = controller
    })
  const seats: Record<number, Client> = {
    0: await connect(matchId, ALICE),
    1: await connect(matchId, BOB),
  }
  for (let handNo = 1; handNo <= handsTotal; handNo++) {
    await seats[0].next(isState(handNo))
    for (let guard = 0; guard < 20; guard++) {
      const { hand } = await peek(matchId)
      if (hand!.street === 'showdown') break
      const c = seats[hand!.toAct!]
      const from = c.frames.length
      c.send({
        t: 'act',
        reqId: `v${handNo}-${hand!.actions.length}`,
        handNo,
        actionIndex: hand!.actions.length,
        action: legalActions(hand!).canCheck
          ? { type: 'check' }
          : { type: 'call' },
      })
      await c.next(isState(handNo, hand!.actions.length + 1), from)
    }
    await elapse(matchId, NEXT_HAND_MS)
  }
  return { matchId, seats }
}

async function deliver(queue: string, bodies: unknown[], attempts = 1) {
  const batch = createMessageBatch(
    queue,
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

const outbox = (matchId: string) =>
  runInDurableObject(stub(matchId), async (_, state) => [
    ...(await state.storage.list<Outbox>({ prefix: 'outbox:' })).keys(),
  ])

describe('the hand queue, end to end', () => {
  it('verifies every archived hand of a match through the real queue', async () => {
    const { matchId } = await play(2)
    await until(() => fake.verified.length === 2)
    expect(fake.verified.sort()).toEqual([`${matchId}:1`, `${matchId}:2`])
    expect(fake.incidents).toEqual([])
  })

  it('queues nothing while Supabase is down, keeps playing, and verifies once it is back', async () => {
    fake.down = true
    const { matchId, seats } = await play(2)
    await seats[0].next((f) => f.t === 'match_end')
    expect(fake.audits).toEqual([])
    expect(await outbox(matchId)).toEqual([
      'outbox:0000:match',
      'outbox:0001:hand',
      'outbox:0001:verify',
      'outbox:0002:hand',
      'outbox:0002:verify',
      'outbox:9999:end',
    ])
    fake.down = false
    await elapse(matchId, 300_000)
    await until(() => fake.verified.length === 2)
    expect(await outbox(matchId)).toEqual([])
  })

  it('never holds up the archive when the queue refuses messages', async () => {
    const matchId = await createTable(ALICE, 2)
    await runInDurableObject(stub(matchId), (instance: TableDO) => {
      const inside = instance as unknown as { env: typeof env }
      inside.env = {
        ...inside.env,
        HAND_QUEUE: {
          send: async () => {
            throw new Error('queue unavailable')
          },
        } as unknown as Queue,
      }
    })
    await freezeClock(matchId)
    const seats: Record<number, Client> = {
      0: await connect(matchId, ALICE),
      1: await connect(matchId, BOB),
    }
    for (const handNo of [1, 2]) {
      await seats[0].next(isState(handNo))
      const { hand } = await peek(matchId)
      const c = seats[hand!.toAct!]
      c.send({
        t: 'act',
        reqId: `q${handNo}`,
        handNo,
        actionIndex: 0,
        action: { type: 'fold' },
      })
      await c.next(isState(handNo, 1))
      await elapse(matchId, NEXT_HAND_MS)
    }
    await seats[0].next((f) => f.t === 'match_end')
    await until(() => fake.archived.length === 2)
    // Both hands and the result reached Postgres; only the queue sends wait.
    let left: string[] = []
    for (let i = 0; i < 200; i++) {
      left = await outbox(matchId)
      if (left.length === 2) break
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(left).toEqual(['outbox:0001:verify', 'outbox:0002:verify'])
  })
})

describe('the verify consumer', () => {
  async function archivedHand() {
    const { matchId } = await play(1)
    await until(() => fake.verified.length === 1)
    const id = `${matchId}:1`
    const hand = structuredClone(fake.hands.get(id)!)
    return { matchId, id, hand }
  }

  it('finds nothing wrong with a hand the table played', async () => {
    const { hand } = await archivedHand()
    expect(await problemsWith(hand)).toEqual([])
  })

  it.each([
    [
      'a different card in the deck',
      (h: AuditedHand) => {
        const top = h.deck.indexOf(h.record.board[0])
        const unused = h.deck[51]
        h.deck[51] = h.deck[top]
        h.deck[top] = unused
      },
      'commitment',
    ],
    [
      'a different secret',
      (h: AuditedHand) => {
        h.secret = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)))
      },
      'commitment',
    ],
    [
      'a changed result',
      (h: AuditedHand) => {
        h.record.netBySeat = { 0: 1, 1: -1 }
      },
      'result',
    ],
    [
      'a changed board in the record',
      (h: AuditedHand) => {
        h.record.board = [...h.record.board].reverse()
      },
      'board',
    ],
    [
      'a reveal that opens another slot',
      (h: AuditedHand) => {
        h.reveal[0] = { ...h.reveal[0], slot: (h.reveal[0].slot + 1) % 52 }
      },
      'reveal',
    ],
    [
      'audit hole cards that differ from the deal',
      (h: AuditedHand) => {
        h.holes[0] = [...h.holes[1]]
      },
      'holes',
    ],
    [
      'an action the engine refuses',
      (h: AuditedHand) => {
        h.record.actions[0] = {
          ...h.record.actions[0],
          action: { type: 'raise', to: 1 },
        }
      },
      'replay',
    ],
  ])('catches %s', async (_, tamper, problem) => {
    const { hand } = await archivedHand()
    tamper(hand)
    expect(await problemsWith(hand)).toContain(problem)
  })

  describe('the luck a rating settles on (audit F07)', () => {
    /** A hand all in preflop and called, archived with its luck as rated. */
    async function allInHand() {
      const matchId = await createTable(ALICE, 1)
      await freezeClock(matchId)
      const seats: Record<number, Client> = {
        0: await connect(matchId, ALICE),
        1: await connect(matchId, BOB),
      }
      await seats[0].next(isState(1))
      await move(matchId, seats, (h) => ({
        type: 'raise',
        to: legalActions(h).maxRaiseTo,
      }))
      await move(matchId, seats, () => ({ type: 'call' }))
      const { hand: played } = await peek(matchId)
      await until(() => fake.verified.length === 1)
      const hand = structuredClone(fake.hands.get(`${matchId}:1`)!)
      const luck = luckAdjusted(played!)
      expect(luck.allInAt).toBe(0)
      hand.record.luck = {
        allInAt: luck.allInAt,
        equity: luck.equity,
        adjustedBySeat: luck.netBySeat,
      }
      return hand
    }

    it('is recomputed, and agrees with what the table recorded', async () => {
      const hand = await allInHand()
      expect(await problemsWith(hand, true)).toEqual([])
      // As Postgres hands it back: jsonb orders an object's keys its own way.
      const { allInAt, equity, adjustedBySeat } = hand.record.luck!
      hand.record.luck = { equity, adjustedBySeat, allInAt }
      expect(await problemsWith(hand, true)).toEqual([])
    })

    it.each([
      [
        'an adjusted net moved by a fraction of a chip',
        (h: AuditedHand) => {
          h.record.luck!.adjustedBySeat[0] += 1e-6
        },
      ],
      [
        'a different equity',
        (h: AuditedHand) => {
          h.record.luck!.equity = { 0: 0.5, 1: 0.5 }
        },
      ],
      [
        'a different all-in point',
        (h: AuditedHand) => {
          h.record.luck!.allInAt = 3
        },
      ],
      [
        'no luck at all on a rated hand',
        (h: AuditedHand) => {
          delete h.record.luck
        },
      ],
    ])('catches %s', async (_, tamper) => {
      const hand = await allInHand()
      tamper(hand)
      expect(await problemsWith(hand, true)).toContain('luck')
    })
  })

  it('records one verify_failed incident for a tampered hand, never verifies it, and acks', async () => {
    const { matchId, id, hand } = await archivedHand()
    hand.verified = false
    hand.record.netBySeat = { 0: 5, 1: -5 }
    fake.hands.set(id, hand)
    fake.verified = []
    const body = { matchId, handNo: 1 }
    for (let i = 0; i < 2; i++) {
      const result = await deliver(HANDS_QUEUE, [body], i + 1)
      expect(result.explicitAcks).toEqual(['m0'])
      expect(result.retryMessages).toEqual([])
    }
    expect(fake.verified).toEqual([])
    expect(fake.incidents).toEqual([
      {
        matchId,
        handNo: 1,
        kind: 'verify_failed',
        detail: { problems: ['result'] },
      },
    ])
  })

  it('acks a redelivered message for a hand already verified without verifying it again', async () => {
    const { matchId } = await archivedHand()
    fake.verified = []
    const result = await deliver(HANDS_QUEUE, [{ matchId, handNo: 1 }], 2)
    expect(result.explicitAcks).toEqual(['m0'])
    expect(fake.verified).toEqual([])
  })

  it('verifies hands delivered out of order', async () => {
    const { matchId } = await play(2)
    await until(() => fake.verified.length === 2)
    for (const id of [`${matchId}:1`, `${matchId}:2`])
      fake.hands.get(id)!.verified = false
    fake.verified = []
    const result = await deliver(HANDS_QUEUE, [
      { matchId, handNo: 2 },
      { matchId, handNo: 1 },
    ])
    expect(result.explicitAcks.sort()).toEqual(['m0', 'm1'])
    expect(fake.verified).toEqual([`${matchId}:2`, `${matchId}:1`])
  })

  it('retries a message for a hand not archived yet, and one Supabase failed on', async () => {
    const missing = await deliver(HANDS_QUEUE, [
      { matchId: crypto.randomUUID(), handNo: 1 },
    ])
    expect(missing.explicitAcks).toEqual([])
    // (The test harness does not report the delay; retryDelay is below.)
    expect(missing.retryMessages.map((m) => m.msgId)).toEqual(['m0'])
    fake.down = true
    const failed = await deliver(HANDS_QUEUE, [
      { matchId: crypto.randomUUID(), handNo: 1 },
    ])
    expect(failed.retryMessages.map((m) => m.msgId)).toEqual(['m0'])
  })

  it('waits 10 s before the first retry, doubling to at most 10 minutes', () => {
    expect([1, 2, 3, 4, 5, 6, 10].map(retryDelay)).toEqual([
      10, 20, 40, 80, 160, 320, 600,
    ])
  })

  it('acks a malformed message rather than retrying it forever', async () => {
    const result = await deliver(HANDS_QUEUE, [
      { matchId: 'not-a-uuid', handNo: 1 },
      'junk',
      { matchId: crypto.randomUUID(), handNo: 0 },
    ])
    expect(result.explicitAcks.sort()).toEqual(['m0', 'm1', 'm2'])
    expect(fake.audits).toEqual([])
  })

  it('turns every dead letter into one dlq incident and acks the batch', async () => {
    const matchId = crypto.randomUUID()
    const result = await deliver(
      HANDS_DLQ,
      [
        { matchId, handNo: 3 },
        { matchId, handNo: 3 },
      ],
      6,
    )
    expect(result.explicitAcks.sort()).toEqual(['m0', 'm1'])
    expect(fake.incidents).toEqual([
      { matchId, handNo: 3, kind: 'dlq', detail: { attempts: 6 } },
    ])
  })
})

describe('an engine fault', () => {
  it('sends the full evidence to incidents, never to the log', async () => {
    const logged: string[] = []
    for (const level of ['log', 'error'] as const)
      vi.spyOn(console, level).mockImplementation((...a: unknown[]) => {
        logged.push(a.map(String).join(' '))
      })
    const broken: TableController = {
      nextHandPlan: (handNo, config) => {
        const plan = new LocalController().nextHandPlan(handNo, config)
        return plan && { ...plan, deck: plan.deck.map(() => 7) }
      },
    }
    const matchId = await createTable(ALICE, 2)
    await runInDurableObject(stub(matchId), (instance: TableDO) => {
      instance.controller = broken
    })
    const alice = await connect(matchId, ALICE)
    await connect(matchId, BOB)
    await alice.next((f) => f.t === 'match_end')
    await until(() => fake.incidents.length === 1)
    expect(fake.incidents[0]).toMatchObject({
      matchId,
      handNo: 1,
      kind: 'engine_fault',
      detail: { error: 'Invalid deck', evidence: { deck: Array(52).fill(7) } },
    })
    // A heads-up plan's evidence, exactly: the six table's orbit fields
    // are not added to it.
    const { evidence } = fake.incidents[0].detail as { evidence: object }
    expect(Object.keys(evidence).sort()).toEqual(['config', 'deck', 'secret'])
    expect(logged.join('\n')).not.toMatch(/"deck"|7,7,7/)
    vi.restoreAllMocks()
  })
})
