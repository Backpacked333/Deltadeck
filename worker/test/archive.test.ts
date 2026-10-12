// The outbox to Postgres: what a finished match sends, in what order, and
// what happens while Supabase is down. Supabase is a stubbed fetch here; the
// SQL side of the same payloads is tested in supabase/tests.
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
import { dealSlots, fromBase64, verifyDeal } from '../../src/engine/deck'
import type { HandRecordV1 } from '../../src/shared/protocol'
import type { TerminalProofV1 } from '../../src/shared/protocol'
import { evidenceDigest } from '../src/live-evidence'
import { forgetUsernames } from '../src/auth'
import { START_WITHIN_MS } from '../src/lobby'
import { IDLE_MS } from '../src/deadlines'
import { NEXT_HAND_MS, OUTBOX_SAFETY_MS } from '../src/table'
import type { Outbox, TableDO } from '../src/table'
import {
  connect,
  createTable,
  elapse,
  freezeClock,
  isState,
  lobby,
  peek,
  storageOf,
  stub,
} from './helpers'
import type { Client } from './helpers'

const ALICE = 'a11ce000-0000-4000-8000-000000000001'
const BOB = 'b0b00000-0000-4000-8000-000000000002'
const NAMES: Record<string, string> = { [ALICE]: 'alice', [BOB]: 'bob' }

type Call = { rpc: string; p: Record<string, unknown> }
let calls: Call[] = []
let failing = false
/**
 * Answers one rpc instead of the default 204 (a refusal or an outage), or
 * holds it: a promise of null answers 204 once it settles.
 */
let respond:
  | ((
      rpc: string,
      p: Record<string, unknown>,
    ) => Response | null | Promise<Response | null>)
  | null = null
/** Every rpc attempt, answered or not. */
let tried: string[] = []
/** Every request the Worker made, wherever it went. */
let sent: { url: string; headers: Headers; body: string }[] = []

beforeAll(() => {
  const realFetch = globalThis.fetch
  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      sent.push({
        url: url.toString(),
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? init.body : '',
      })
      if (url.origin !== new URL(env.SUPABASE_URL).origin)
        return realFetch(input, init)
      if (url.pathname === '/rest/v1/players') {
        const id = url.searchParams.get('user_id')!.slice(3)
        return Response.json([{ username: NAMES[id] }])
      }
      if (url.pathname.startsWith('/rest/v1/rpc/')) {
        expect(new Headers(init?.headers).get('apikey')).toBe('sb_secret_test')
        if (failing) return new Response('down', { status: 503 })
        // The verify consumer reads hands back; verification itself is
        // verify.test.ts. Here every hand reads as verified already.
        if (url.pathname.endsWith('/audit_hand'))
          return Response.json({ verified: true })
        const rpc = url.pathname.slice('/rest/v1/rpc/'.length)
        const p = JSON.parse(String(init!.body)).p
        tried.push(rpc)
        const custom = await respond?.(rpc, p)
        if (custom) return custom
        calls.push({ rpc, p })
        return new Response(null, { status: 204 })
      }
      return new Response('not stubbed', { status: 599 })
    },
  )
})
afterAll(() => vi.unstubAllGlobals())
beforeEach(() => {
  calls = []
  sent = []
  tried = []
  respond = null
  failing = false
  forgetUsernames()
})

async function until(test: () => boolean) {
  for (let i = 0; i < 400 && !test(); i++)
    await new Promise((r) => setTimeout(r, 5))
  if (!test()) throw new Error('timed out')
}

async function table(handsTotal: number) {
  const matchId = await createTable(ALICE, handsTotal)
  await freezeClock(matchId)
  const alice = await connect(matchId, ALICE)
  const bob = await connect(matchId, BOB)
  await alice.next(isState(1))
  return { matchId, seats: { 0: alice, 1: bob } as Record<number, Client> }
}

/** The player to act folds. */
async function foldHand(matchId: string, seats: Record<number, Client>) {
  const { hand } = await peek(matchId)
  const c = seats[hand!.toAct!]
  const from = c.frames.length
  c.send({
    t: 'act',
    reqId: `f${hand!.config.handNo}`,
    handNo: hand!.config.handNo,
    actionIndex: 0,
    action: { type: 'fold' },
  })
  await c.next(isState(hand!.config.handNo, 1), from)
}

/** Gives the table a verify queue that records what it is sent. */
async function recordQueue(matchId: string) {
  const sent: { matchId: string; handNo: number }[] = []
  await runInDurableObject(stub(matchId), (instance: TableDO) => {
    const self = instance as unknown as { env: Record<string, unknown> }
    self.env = {
      ...self.env,
      HAND_QUEUE: {
        send: async (m: { matchId: string; handNo: number }) => {
          sent.push(m)
        },
      },
    }
  })
  return sent
}

const outbox = (matchId: string) =>
  runInDurableObject(stub(matchId), async (instance: TableDO) => {
    const state = (instance as unknown as { ctx: DurableObjectState }).ctx
    return [...(await state.storage.list<Outbox>({ prefix: 'outbox:' }))]
  })

describe('the archive', () => {
  it('sends the secret key only to the service functions', async () => {
    const { matchId, seats } = await table(1)
    await foldHand(matchId, seats)
    await elapse(matchId, NEXT_HAND_MS)
    await until(() => calls.length === 4)
    const secret = 'sb_secret_test'
    const carrying = sent.filter(
      (r) =>
        r.url.includes(secret) ||
        r.body.includes(secret) ||
        [...r.headers.values()].some((v) => v.includes(secret)),
    )
    // The three archive calls, plus the verify consumer's reads.
    expect(
      carrying.filter((r) => /record_(match|hand)$/.test(r.url)),
    ).toHaveLength(3)
    for (const r of carrying)
      expect(r.url).toMatch(
        new RegExp(
          `^${env.SUPABASE_URL}/rest/v1/rpc/(record_(match|hand|incident|terminal)|audit_hand|verify_hand)$`,
        ),
      )
    // Username lookups go out with the publishable key, never the secret.
    const lookups = sent.filter((r) => r.url.includes('/rest/v1/players'))
    expect(lookups.length).toBeGreaterThan(0)
    for (const r of lookups)
      expect(r.headers.get('apikey')).toBe(env.SUPABASE_PUBLISHABLE_KEY)
  })

  it('records the match, each hand, then the result, in that order', async () => {
    const { matchId, seats } = await table(2)
    await foldHand(matchId, seats)
    await until(() => calls.length === 2)
    await elapse(matchId, NEXT_HAND_MS)
    await seats[0].next(isState(2))
    await foldHand(matchId, seats)
    await until(() => calls.length === 3)
    await elapse(matchId, NEXT_HAND_MS) // no hand 3: the match ends
    await until(() => calls.length === 5)

    expect(calls.map((c) => c.rpc)).toEqual([
      'record_match',
      'record_hand',
      'record_hand',
      'record_match',
      'record_terminal',
    ])
    expect(calls[0].p).toMatchObject({
      id: matchId,
      kind: 'hu-casual',
      players: [
        { seat: 0, userId: ALICE },
        { seat: 1, userId: BOB },
      ],
    })
    expect(calls[0].p.result).toBeUndefined()

    const hand = calls[1].p as Record<string, unknown> & {
      record: HandRecordV1
      deck: number[]
      holes: Record<number, number[]>
      holesByUser: { userId: string; cards: number[] }[]
      netByUser: Record<string, number>
      reveal: { slot: number; card: number; salt: string }[]
    }
    expect(hand.id).toBe(`${matchId}:1`)
    // The audit copy has every hole card; the public record has none of a
    // folded hand.
    const holes = dealSlots(hand.record.config).holes
    for (const seat of [0, 1])
      expect(hand.holes[seat]).toEqual(holes[seat].map((s) => hand.deck[s]))
    expect(hand.holesByUser.map((h) => h.userId).sort()).toEqual(
      [ALICE, BOB].sort(),
    )
    expect(hand.record.shown).toEqual([])
    expect(JSON.stringify(hand.record)).not.toContain('"deck"')
    expect(Object.values(hand.netByUser).reduce((a, b) => a + b)).toBe(0)
    expect(
      await verifyDeal(
        hand.commitment as string,
        fromBase64(hand.leaves as string),
        hand.reveal,
        hand.record,
      ),
    ).toBe(true)

    const end = calls[3].p
    const proof = calls[4].p.proof as TerminalProofV1
    expect(proof).toMatchObject({
      reason: 'complete',
      cause: 'hand_limit',
      matchId,
    })
    expect(proof.completedHands.map((entry) => entry.handNo)).toEqual([1, 2])
    for (const [i, entry] of proof.completedHands.entries()) {
      expect(entry.recordDigest).toBe(
        await evidenceDigest(calls[i + 1].p.record),
      )
      expect(entry.archiveDigest).toBe(await evidenceDigest(calls[i + 1].p))
    }
    expect(end.result).toMatchObject({ reason: 'complete' })
    expect(end.timeouts).toEqual({ 0: 0, 1: 0 })
    expect(await outbox(matchId)).toEqual([])
  })

  it('sends a call queued while a flush is under way, in that same flush', async () => {
    const { matchId, seats } = await table(1)
    // Hold the hand's archive call, so the flush is mid-pass when the
    // match ends and queues its result.
    let release!: () => void
    const held = new Promise<null>((r) => (release = () => r(null)))
    respond = (rpc) => (rpc === 'record_hand' ? held : null)
    await foldHand(matchId, seats)
    await until(() => tried.includes('record_hand'))
    await elapse(matchId, NEXT_HAND_MS) // no hand 2: the match ends
    await seats[0].next((f) => f.t === 'match_end')
    release()
    // No clock moves: the result goes out with the pass already running,
    // not stranded behind a safety deadline that pass removed.
    await until(() =>
      calls.some((c) => c.rpc === 'record_match' && !!c.p.result),
    )
    expect(calls.map((c) => c.rpc)).toEqual([
      'record_match',
      'record_hand',
      'record_match',
      'record_terminal',
    ])
    expect(await outbox(matchId)).toEqual([])
  })

  it('keeps calls queued in order while Supabase is down, then catches up', async () => {
    failing = true
    const { matchId, seats } = await table(5)
    await foldHand(matchId, seats)
    // The match call failed, so the hand behind it was never tried.
    let queued: [string, Outbox][] = []
    for (let i = 0; i < 400 && !(queued[0]?.[1].attempts >= 1); i++) {
      queued = await outbox(matchId)
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(queued.map(([key]) => key)).toEqual([
      'outbox:0000:match',
      'outbox:0001:hand',
      'outbox:0001:verify',
    ])
    expect(queued[0][1].attempts).toBeGreaterThanOrEqual(1)
    expect(queued[1][1].attempts).toBe(0)
    expect(calls).toEqual([])

    // Play is not held up by the archive.
    await elapse(matchId, NEXT_HAND_MS)
    await seats[0].next(isState(2))

    failing = false
    // Past the retry, short of the next turn clock.
    expect(await elapse(matchId, 10_000)).toBe(true)
    await until(() => calls.length === 2)
    expect(calls.map((c) => c.rpc)).toEqual(['record_match', 'record_hand'])
    queued = await outbox(matchId)
    expect(queued).toEqual([])
  })

  it('still delivers a queued call when the table restarts before sending', async () => {
    const { matchId, seats } = await table(5)
    await until(() => calls.length === 1) // the match row
    // Lose the immediate send, then lose the object itself.
    await runInDurableObject(stub(matchId), (instance: TableDO) => {
      instance.flushOutbox = async () => {}
    })
    await foldHand(matchId, seats)
    expect((await outbox(matchId)).map(([key]) => key)).toEqual([
      'outbox:0001:hand',
      'outbox:0001:verify',
    ])
    await abortAllDurableObjects()
    await freezeClock(matchId) // the fresh object starts on the real clock
    expect(calls).toHaveLength(1)
    // The fallback deadline was written with the call, so it survives.
    expect(await elapse(matchId, OUTBOX_SAFETY_MS)).toBe(true)
    await until(() => calls.length === 2)
    expect(calls[1].rpc).toBe('record_hand')
    expect(await outbox(matchId)).toEqual([])
  })

  it('records a no-show as a void match naming the absent seat', async () => {
    const [la, lb] = [await lobby(ALICE), await lobby(BOB)]
    la.send({ t: 'queue', kind: 'hu-casual' })
    await la.next((f) => f.t === 'queued')
    lb.send({ t: 'queue', kind: 'hu-casual' })
    const m = await la.next((f) => f.t === 'matched')
    const matchId = m.t === 'matched' ? m.matchId : ''
    await connect(matchId, ALICE)
    await freezeClock(matchId)
    await elapse(matchId, START_WITHIN_MS)
    await until(() => calls.length === 2)
    expect(calls[0]).toMatchObject({
      rpc: 'record_match',
      p: {
        id: matchId,
        players: [
          { seat: 0, userId: ALICE },
          { seat: 1, userId: BOB },
        ],
        result: { reason: 'no_show', noShow: [1] },
      },
    })
  })

  it('deletes a finished table only once its archive calls are done', async () => {
    failing = true
    const { matchId, seats } = await table(1)
    await foldHand(matchId, seats)
    await elapse(matchId, NEXT_HAND_MS)
    await seats[0].next((f) => f.t === 'match_end')
    // Supabase is still down when the table would be cleaned up.
    await elapse(matchId, IDLE_MS)
    expect((await outbox(matchId)).map(([key]) => key)).toEqual([
      'outbox:0000:match',
      'outbox:0001:hand',
      'outbox:0001:verify',
      'outbox:9999:end',
      'outbox:9999:proof',
    ])
    expect((await peek(matchId)).match?.status).toBe('finished')
    failing = false
    // The next retry empties the outbox; the next idle check cleans up.
    await elapse(matchId, 300_000)
    await until(() => calls.length === 4)
    await elapse(matchId, IDLE_MS)
    expect(await storageOf(matchId)).toEqual({ keys: [], alarm: null })
  })

  it('parks a call refused 12 times for its data, reports it once, and sends what follows', async () => {
    // A hand that can never be stored (a seat's account was deleted, say):
    // Postgres refuses it with a foreign-key violation every time.
    let refusals = 0
    respond = (rpc, p) => {
      if (rpc !== 'record_hand' || p.handNo !== 1) return null
      refusals++
      return Response.json(
        { code: '23503', message: 'violates foreign key constraint' },
        { status: 409 },
      )
    }
    const { matchId, seats } = await table(2)
    const toQueue = await recordQueue(matchId)
    await foldHand(matchId, seats)
    await elapse(matchId, NEXT_HAND_MS)
    await seats[0].next(isState(2))
    await foldHand(matchId, seats)
    await elapse(matchId, NEXT_HAND_MS)
    await seats[0].next((f) => f.t === 'match_end')
    for (let i = 0; i < 20 && refusals < 12; i++) {
      const before = refusals
      await elapse(matchId, 300_000)
      await until(() => refusals > before)
    }
    expect(refusals).toBe(12)
    // Behind it, hand 2 and the match result go through, then the incident.
    await elapse(matchId, 300_000)
    await until(() => calls.some((c) => c.rpc === 'record_incident'))
    expect(calls.map((c) => [c.rpc, c.p.handNo ?? null])).toEqual([
      ['record_match', null],
      ['record_hand', 2],
      ['record_match', 2],
      ['record_terminal', null],
      ['record_incident', 1],
    ])
    const incident = calls.find((c) => c.rpc === 'record_incident')!.p
    expect(incident).toMatchObject({
      matchId,
      handNo: 1,
      kind: 'archive_parked:hand',
      detail: { rpc: 'record_hand', status: 409, code: '23503' },
    })
    // The parked hand rides in the incident (service role only), so it
    // can be replayed once the cause is fixed.
    expect((incident.detail as { body: { handNo: number } }).body.handNo).toBe(
      1,
    )
    // Its verification is parked with it: the verifier would only find no
    // hand and report a false failure. Hand 2 is verified as usual.
    expect(toQueue.map((m) => m.handNo)).toEqual([2])
    expect(refusals).toBe(12)
    expect(await outbox(matchId)).toEqual([])
  })

  it('never parks terminal proof or skips past it to rating after repeated permanent refusals', async () => {
    let refusals = 0
    respond = (rpc) => {
      if (rpc !== 'record_terminal') return null
      refusals++
      return Response.json({ code: 'PGRST202' }, { status: 404 })
    }
    const { matchId, seats } = await table(1)
    await foldHand(matchId, seats)
    await elapse(matchId, NEXT_HAND_MS)
    await seats[0].next((f) => f.t === 'match_end')
    await until(() => refusals > 0)
    const rating = {
      rpc: 'apply_rating',
      body: { matchId, players: [], finishedAt: 0 },
      attempts: 0,
    }
    await runInDurableObject(stub(matchId), async (_table: TableDO, state) => {
      await state.storage.put('outbox:9999:rate', rating)
    })
    for (let i = 0; i < 13; i++) {
      const before = refusals
      await elapse(matchId, 300_000)
      await until(() => refusals > before)
    }
    const pending = new Map(await outbox(matchId))
    expect(pending.get('outbox:9999:proof')).toMatchObject({
      rpc: 'record_terminal',
      refused: expect.any(Number),
    })
    expect(pending.get('outbox:9999:rate')).toEqual(rating)
    expect((await storageOf(matchId)).keys).not.toContain('parked:9999:proof')
  })

  it('reports each parked call of a match separately', async () => {
    // The match row itself is refused: its start and its result both park.
    respond = (rpc) =>
      rpc === 'record_match'
        ? Response.json({ code: '23514' }, { status: 400 })
        : null
    const { matchId, seats } = await table(1)
    await foldHand(matchId, seats)
    await elapse(matchId, NEXT_HAND_MS)
    await seats[0].next((f) => f.t === 'match_end')
    const matchTries = () => tried.filter((r) => r === 'record_match').length
    for (let i = 0; i < 40 && matchTries() < 24; i++) {
      const before = matchTries()
      await elapse(matchId, 300_000)
      await until(() => matchTries() > before)
    }
    expect(matchTries()).toBe(24)
    await elapse(matchId, 300_000)
    await until(
      () => calls.filter((c) => c.rpc === 'record_incident').length === 2,
    )
    // Two incidents, not one: same match, no hand number, distinct kinds.
    expect(
      calls
        .filter((c) => c.rpc === 'record_incident')
        .map((c) => [c.p.handNo, c.p.kind]),
    ).toEqual([
      [null, 'archive_parked:match'],
      [null, 'archive_parked:end'],
    ])
  })

  it('never parks an incident report: it holds nothing up, so it keeps its retries', async () => {
    respond = (rpc, p) =>
      (rpc === 'record_hand' && p.handNo === 1) || rpc === 'record_incident'
        ? Response.json({ code: '23502' }, { status: 400 })
        : null
    const { matchId, seats } = await table(1)
    await foldHand(matchId, seats)
    await elapse(matchId, NEXT_HAND_MS)
    await seats[0].next((f) => f.t === 'match_end')
    const incidentTries = () =>
      tried.filter((r) => r === 'record_incident').length
    for (let i = 0; i < 40 && incidentTries() < 14; i++) {
      const before = tried.length
      await elapse(matchId, 300_000)
      await until(() => tried.length > before)
    }
    expect(incidentTries()).toBeGreaterThanOrEqual(14)
    const queued = await outbox(matchId)
    expect(queued.map(([key]) => key)).toEqual(['outbox:0001:hand:parked'])
    expect(queued[0][1].attempts).toBeGreaterThanOrEqual(14)
  })

  it('never parks a call that failed for an outage, a key or a missing function', async () => {
    const answers = [
      () => new Response('down', { status: 503 }),
      () => new Response('no key', { status: 401 }),
      () => new Response('wrong key', { status: 403 }),
      () => Response.json({ code: 'PGRST202' }, { status: 404 }),
      () => Response.json({ code: '42883' }, { status: 400 }),
    ]
    respond = (rpc) =>
      rpc === 'record_match'
        ? answers[
            tried.filter((r) => r === 'record_match').length % answers.length
          ]()
        : null
    const { matchId, seats } = await table(1)
    await foldHand(matchId, seats)
    const matchTries = () => tried.filter((r) => r === 'record_match').length
    for (let i = 0; i < 20 && matchTries() < 15; i++) {
      const before = matchTries()
      await elapse(matchId, 300_000)
      await until(() => matchTries() > before)
    }
    expect(matchTries()).toBe(15)
    expect(calls).toEqual([])
    const queued = await outbox(matchId)
    expect(queued[0][0]).toBe('outbox:0000:match')
    expect(queued[0][1].attempts).toBe(15)
  })

  it('archives nothing for local dev accounts', async () => {
    const matchId = await createTable('carol', 1)
    const carol = await connect(matchId, 'carol')
    const dave = await connect(matchId, 'dave')
    await carol.next(isState(1))
    await foldHand(matchId, { 0: carol, 1: dave })
    await carol.next((f) => f.t === 'reveal')
    expect(await outbox(matchId)).toEqual([])
    expect(calls).toEqual([])
  })
})
