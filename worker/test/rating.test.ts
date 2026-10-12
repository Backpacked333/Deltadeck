// The rating update at match end (P1-12): once a rated match with a result
// is archived, the table's outbox rates it with Glicko-2 (glicko2.v1) and
// applies it with apply_rating, and both players see the change. Supabase
// is an in-memory fake here: matches as record_match leaves them, and
// ratings with apply_rating's compare-and-set and repeat rules (the SQL
// side is supabase/tests/ratings.test.ts).
import { env, runInDurableObject } from 'cloudflare:test'
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
import { DEFAULT, idle, rateMatch, VERSION } from '../../src/rating/glicko2'
import type { Rating } from '../../src/rating/glicko2'
import type { RatingChange, ServerMsg } from '../../src/shared/protocol'
import { forgetUsernames } from '../src/auth'
import { RATED_CONFIG } from '../src/rated'
import { evidenceDigest } from '../src/live-evidence'
import type { SettlementSource } from '../src/settlement-evidence'
import { problemsWith } from '../src/verify'
import type { AuditedHand } from '../src/verify'
import type { InitBody, TableDO } from '../src/table'
import { checkFrame, checkFrames, FLOW_TYPES } from './frames'
import {
  connect,
  elapse,
  elapseToNextDeal,
  freezeClock,
  isState,
  move,
  peek,
  stub,
} from './helpers'
import type { Client } from './helpers'

const ALICE = '61111111-1111-4111-8111-111111111111'
const BOB = '62222222-2222-4222-8222-222222222222'
const NAMES: Record<string, string> = { [ALICE]: 'alice', [BOB]: 'bob' }
const T0 = 1_800_000_000_000
const DAY = 86_400_000

type Row = Rating & {
  user_id: string
  version: number
  matches: number
  last_match_at: string | null
}
type Applied = RatingChange & { userId: string; outcome: string }
const fake = {
  ratings: new Map<string, Row>(),
  /** apply_rating's change per match, once applied. */
  rated: new Map<string, Applied[]>(),
  /** Every apply_rating payload, in order. */
  applies: [] as {
    matchId: string
    finishedAt?: string
    players: Record<string, unknown>[]
  }[],
  outcomes: new Map<string, Record<string, string>>(),
  down: false,
  sources: new Map<string, SettlementSource>(),
  /** Before the next apply checks versions, another match rates this player. */
  bumpBeforeNext: null as null | { userId: string; rating: number },
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
      if (fake.down) return new Response('down', { status: 503 })
      if (url.pathname === '/rest/v1/ratings') {
        const ids = url.searchParams.get('user_id')!.slice(4, -1).split(',')
        return Response.json(
          ids.flatMap((id) =>
            fake.ratings.has(id) ? [fake.ratings.get(id)] : [],
          ),
        )
      }
      const fn = url.pathname.replace('/rest/v1/rpc/', '')
      const p = JSON.parse(String(init!.body)).p
      if (fn === 'record_match') {
        const previous = fake.sources.get(p.id)
        fake.sources.set(p.id, {
          matchId: p.id,
          kind: p.kind,
          status: p.result
            ? ['no_show', 'abandoned', 'engine_fault'].includes(p.result.reason)
              ? 'void'
              : 'finished'
            : 'playing',
          config: p.config,
          result: p.result ?? {},
          players: p.players.map((a: { seat: number; userId: string }) => ({
            ...a,
            outcome: p.result?.outcomeBySeat?.[a.seat] ?? null,
          })),
          hands: previous?.hands ?? [],
          terminal: previous?.terminal ?? null,
          sourceToken: `source:${p.id}`,
        })
        if (p.result?.outcomeBySeat)
          fake.outcomes.set(
            p.id,
            Object.fromEntries(
              p.players.map((s: { seat: number; userId: string }) => [
                s.userId,
                p.result.outcomeBySeat[s.seat],
              ]),
            ),
          )
        return new Response(null, { status: 204 })
      }
      if (fn === 'record_hand') {
        const h: AuditedHand = {
          ...p,
          holesByUser: p.holesByUser.map(
            (x: { userId: string; cards: number[] }) => ({
              user_id: x.userId,
              cards: x.cards,
            }),
          ),
          kind: 'hu-rated',
          archive: p,
          sourceToken: `source:${p.id}`,
          verified: true,
        }
        expect(await problemsWith(h)).toEqual([])
        h.verification = {
          version: 'hand.v2',
          recordDigest: await evidenceDigest(p.record),
          archiveDigest: await evidenceDigest(p),
        }
        const s = fake.sources.get(p.matchId)!
        s.hands = s.hands.filter((x) => x.id !== p.id)
        s.hands.push(h)
      }
      if (fn === 'record_terminal')
        fake.sources.get(p.proof.matchId)!.terminal = p
      if (fn === 'audit_settlement')
        return Response.json(fake.sources.get(p.matchId) ?? null)
      if (fn === 'apply_rating') return applyRating(p)
      return new Response(null, { status: 204 })
    },
  )
})
afterAll(() => vi.unstubAllGlobals())
beforeEach(() => {
  fake.ratings.clear()
  fake.rated.clear()
  fake.applies = []
  fake.outcomes.clear()
  fake.down = false
  fake.sources.clear()
  fake.bumpBeforeNext = null
  forgetUsernames()
})

/** apply_rating as Postgres runs it (supabase/migrations/…_ratings.sql). */
function applyRating(p: {
  matchId: string
  modelVersion: string
  players: (Rating & { userId: string; outcome: string; version: number })[]
}) {
  fake.applies.push(structuredClone(p))
  const done = fake.rated.get(p.matchId)
  if (done) return Response.json(done)
  const outcomes = fake.outcomes.get(p.matchId)
  if (!outcomes) return Response.json({ code: 'P0002' }, { status: 400 })
  if (fake.bumpBeforeNext) {
    const { userId, rating } = fake.bumpBeforeNext
    fake.bumpBeforeNext = null
    const row = fake.ratings.get(userId) ?? blank(userId)
    fake.ratings.set(userId, {
      ...row,
      rating,
      version: row.version + 1,
      matches: row.matches + 1,
    })
  }
  for (const x of p.players) {
    const row = fake.ratings.get(x.userId) ?? blank(x.userId)
    if (row.version !== x.version)
      return Response.json({ code: '40001' }, { status: 409 })
    if (outcomes[x.userId] !== x.outcome)
      return Response.json({ code: '23514' }, { status: 400 })
  }
  const applied: Applied[] = p.players.map((x) => {
    const row = fake.ratings.get(x.userId) ?? blank(x.userId)
    const after: Row = {
      ...row,
      rating: x.rating,
      rd: x.rd,
      sigma: x.sigma,
      version: row.version + 1,
      matches: row.matches + 1,
      last_match_at: new Date(T0).toISOString(),
    }
    fake.ratings.set(x.userId, after)
    return {
      userId: x.userId,
      outcome: x.outcome,
      before: { rating: row.rating, rd: row.rd },
      after: { rating: x.rating, rd: x.rd },
      matches: after.matches,
    }
  })
  fake.rated.set(p.matchId, applied)
  return Response.json(applied)
}

const blank = (userId: string): Row => ({
  user_id: userId,
  ...DEFAULT,
  version: 0,
  matches: 0,
  last_match_at: null,
})

async function until(test: () => boolean, ms = 20_000) {
  for (let t = 0; t < ms && !test(); t += 10)
    await new Promise((r) => setTimeout(r, 10))
  if (!test()) throw new Error('timed out')
}

/** A rated table as the lobby makes one; both seated unless `alone`. */
async function rated(alone = false) {
  const matchId = crypto.randomUUID()
  await freezeClock(matchId, T0)
  const body: InitBody = {
    matchId,
    creator: { userId: ALICE, username: 'alice' },
    opponent: { userId: BOB, username: 'bob' },
    kind: 'hu-rated',
    activation: {
      v: 1,
      id: `activation:${matchId}`,
      tableId: matchId,
      state: 'committed',
      expiresAt: T0 + 30_000,
      members: [ALICE, BOB].map((userId) => ({
        userId,
        tableId: matchId,
        generation: 1,
      })),
    },
    ...(alone ? { startWithinMs: 30_000 } : {}),
  }
  const made = await stub(matchId).fetch('https://table/init', {
    method: 'POST',
    body: JSON.stringify(body),
  })
  expect(made.status).toBe(201)
  await freezeClock(matchId, T0)
  const alice = await connect(matchId, ALICE)
  if (alone)
    return { matchId, alice, seats: { 0: alice } as Record<SeatId, Client> }
  const bob = await connect(matchId, BOB)
  await alice.next(isState(1))
  return {
    matchId,
    alice,
    seats: { 0: alice, 1: bob } as Record<SeatId, Client>,
  }
}

const fold = (): PlayerAction => ({ type: 'fold' })
const passive = (hand: HandState): PlayerAction =>
  legalActions(hand).canCheck ? { type: 'check' } : { type: 'call' }
const raiseTo = (to: number) => (): PlayerAction => ({ type: 'raise', to })

async function nextHand(matchId: string, alice: Client, handNo: number) {
  await elapseToNextDeal(matchId)
  await alice.next(isState(handNo))
}

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

/** Hand 1 to Bob, then Bob times out three hands in a row: he forfeits. */
async function bobForfeits(
  matchId: string,
  alice: Client,
  seats: Record<SeatId, Client>,
) {
  await move(matchId, seats, raiseTo(60))
  await move(matchId, seats, fold)
  await nextHand(matchId, alice, 2)
  await timeOut(matchId, seats)
  await nextHand(matchId, alice, 3)
  await move(matchId, seats, raiseTo(60))
  await timeOut(matchId, seats)
  await nextHand(matchId, alice, 4)
  await timeOut(matchId, seats)
  await alice.next((f) => f.t === 'match_end')
}

type RatingFrame = Extract<ServerMsg, { t: 'rating' }>
const ratingOf = (c: Client) =>
  c.frames.find((f) => f.t === 'rating') as RatingFrame | undefined

describe('the rating update', () => {
  it('F07 binds an interrupted hand with three timeout checks and excludes its chips', async () => {
    const { matchId, alice, seats } = await rated()
    await move(matchId, seats, passive)
    await timeOut(matchId, seats)
    await timeOut(matchId, seats)
    await move(matchId, seats, passive)
    await timeOut(matchId, seats)
    await alice.next((f) => f.t === 'match_end')
    await until(() => !!ratingOf(alice))
    const source = fake.sources.get(matchId)!
    expect(source.hands).toHaveLength(0)
    expect(source.terminal!.proof.interruptedHand).toMatchObject({
      disposition: 'excluded_incomplete',
      hand: { handNo: 1 },
    })
    expect(fake.applies[0].players).toMatchObject([
      { outcome: 'win' },
      { outcome: 'loss' },
    ])
  }, 60_000)
  it('a completed rated match applies Glicko-2 to both players, and both see before, after and the change', async () => {
    const { matchId, alice, seats } = await rated()
    // Bob folds whenever he is to act: Alice wins the match.
    for (let n = 1; n <= RATED_CONFIG.handsTotal; n++) {
      if (n > 1) await nextHand(matchId, alice, n)
      for (;;) {
        const { hand } = await peek(matchId)
        if (hand!.result) break
        await move(matchId, seats, hand!.toAct === 1 ? fold : passive)
      }
    }
    await elapseToNextDeal(matchId)
    await alice.next((f) => f.t === 'match_end')
    await until(() => !!ratingOf(alice) && !!ratingOf(seats[1]))

    const [win, loss] = rateMatch(DEFAULT, DEFAULT, 1)
    expect(fake.applies).toHaveLength(1)
    expect(fake.applies[0]).toMatchObject({
      matchId,
      modelVersion: VERSION,
      players: [
        { userId: ALICE, outcome: 'win', version: 0, ...win },
        { userId: BOB, outcome: 'loss', version: 0, ...loss },
      ],
    })
    for (const c of [alice, seats[1]]) {
      const frame = ratingOf(c)!
      expect(frame.change).toEqual({
        0: {
          before: { rating: 1500, rd: 350 },
          after: { rating: win.rating, rd: win.rd },
          matches: 1,
        },
        1: {
          before: { rating: 1500, rd: 350 },
          after: { rating: loss.rating, rd: loss.rd },
          matches: 1,
        },
      })
    }
    // Every frame either player got carries only its allowed keys, and the
    // rating frame only public ratings, keyed by seat. The rematch offer
    // races the rating, so it is waited for before taking the types.
    for (const c of [alice, seats[1]])
      await c.next((f) => f.t === 'rematch_state')
    expect(checkFrames([...alice.frames, ...seats[1].frames])).toEqual(
      new Set(FLOW_TYPES.rating),
    )
    expect(win.rating).toBeGreaterThan(1500)
    expect(loss.rating).toBeLessThan(1500)
  }, 90_000)

  it('a forfeit rates as a loss for the player who forfeited', async () => {
    const { matchId, alice, seats } = await rated()
    await bobForfeits(matchId, alice, seats)
    await until(() => !!ratingOf(alice))
    expect(fake.applies[0].players).toMatchObject([
      { userId: ALICE, outcome: 'win' },
      { userId: BOB, outcome: 'loss' },
    ])
    expect(ratingOf(alice)!.change[1].after.rating).toBeLessThan(1500)
  }, 60_000)

  it('a no-show is void and not rated', async () => {
    const { matchId, alice } = await rated(true)
    await elapse(matchId, 30_000)
    expect(await alice.next((f) => f.t === 'match_end')).toMatchObject({
      result: { reason: 'no_show', noShow: [1] },
    })
    // Long past any retry: nothing was ever sent to apply_rating.
    await elapse(matchId, 600_000)
    expect(fake.applies).toEqual([])
    expect(ratingOf(alice)).toBeUndefined()
  })

  it('two matches finishing out of order for one player both apply, each against the then-current rating', async () => {
    const { matchId, alice, seats } = await rated()
    // Between this table reading Bob's rating and applying, another of
    // Bob's matches is rated: his rating is now 1610 at a new version.
    fake.bumpBeforeNext = { userId: BOB, rating: 1610 }
    await bobForfeits(matchId, alice, seats)
    await until(() => !!ratingOf(alice))
    expect(fake.applies).toHaveLength(2)
    expect(fake.applies[0].players[1]).toMatchObject({ version: 0 })
    // Recomputed from the fresh row: 1610 at version 1.
    const bob = { ...DEFAULT, rating: 1610 }
    const [win, loss] = rateMatch(DEFAULT, bob, 1)
    expect(fake.applies[1].players).toMatchObject([
      { userId: ALICE, version: 0, ...win },
      { userId: BOB, version: 1, ...loss },
    ])
    expect(ratingOf(alice)!.change[1].before.rating).toBe(1610)
  }, 60_000)

  it('with Supabase down at the end of the match, the rating applies later from the outbox', async () => {
    const { matchId, alice, seats } = await rated()
    fake.down = true
    await bobForfeits(matchId, alice, seats)
    const finishedAt = await runInDurableObject(stub(matchId), (t: TableDO) =>
      t.clock(),
    )
    await elapse(matchId, 60_000)
    expect(ratingOf(alice)).toBeUndefined()
    fake.down = false
    await elapse(matchId, 600_000)
    await until(() => !!ratingOf(alice))
    expect(fake.applies).toHaveLength(1)
    // Rated 11 minutes late, but as of when the match was played.
    expect(fake.applies[0]).toMatchObject({
      finishedAt: new Date(finishedAt).toISOString(),
    })
  }, 60_000)

  it('a player who reconnects after the rating sees it again', async () => {
    const { matchId, alice, seats } = await rated()
    await bobForfeits(matchId, alice, seats)
    await until(() => !!ratingOf(alice))
    const again = await connect(matchId, ALICE)
    const frame = await again.next((f) => f.t === 'rating')
    checkFrame(frame)
    expect(frame).toMatchObject({ change: ratingOf(alice)!.change })
  }, 60_000)

  it('widens RD for the 30-day periods a player sat out before rating the match', async () => {
    // Alice last played 95 days ago, settled at 1700 ± 60: three idle periods.
    const settled = { rating: 1700, rd: 60, sigma: 0.06 }
    fake.ratings.set(ALICE, {
      user_id: ALICE,
      ...settled,
      version: 7,
      matches: 30,
      last_match_at: new Date(T0 - 95 * DAY).toISOString(),
    })
    const { matchId, alice, seats } = await rated()
    await bobForfeits(matchId, alice, seats)
    await until(() => !!ratingOf(alice))
    const [win] = rateMatch(idle(settled, 3), DEFAULT, 1)
    expect(fake.applies[0].players[0]).toMatchObject({ version: 7, ...win })
    expect(idle(settled, 3).rd).toBeGreaterThan(60)
  }, 60_000)
})
