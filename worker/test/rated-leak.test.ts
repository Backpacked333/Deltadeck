// P1-03: nothing to analyse during a rated match. One full 40-hand rated
// match is played with everything that changes what the server sends: an
// all-in settled at equity, a timeout, a second tab, a disconnect past the
// grace and the return, junk and stale frames, and a look back after the
// end. Every frame either seat received carries exactly the keys its type
// allows (frames.ts), no analysis key at any depth, and the opponent's
// cards only once that hand reached its showdown.
import { env } from 'cloudflare:test'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { dealSlots } from '../../src/engine/deck'
import { legalActions } from '../../src/engine/hand'
import type { HandState, PlayerAction, SeatId } from '../../src/engine/types'
import type { ServerMsg } from '../../src/shared/protocol'
import { forgetUsernames } from '../src/auth'
import { GRACE_MS, RATED_CONFIG } from '../src/rated'
import type { InitBody } from '../src/table'
import { analysisKeys, checkFrames, FLOW_TYPES } from './frames'
import {
  bySeat,
  connect,
  elapse,
  elapseToNextDeal,
  freezeClock,
  isState,
  move,
  peek,
  seatPairs,
  stub,
} from './helpers'
import type { Client } from './helpers'

const ALICE = '11111111-1111-4111-8111-111111111111'
const BOB = '22222222-2222-4222-8222-222222222222'
const NAMES: Record<string, string> = { [ALICE]: 'alice', [BOB]: 'bob' }
const T0 = 1_800_000_000_000

const passive = (hand: HandState): PlayerAction =>
  legalActions(hand).canCheck ? { type: 'check' } : { type: 'call' }
const fold = (): PlayerAction => ({ type: 'fold' })
const raiseTo =
  (to: number | 'max') =>
  (hand: HandState): PlayerAction => ({
    type: 'raise',
    to: to === 'max' ? legalActions(hand).maxRaiseTo : to,
  })

/** The seats dealt in and their two hole cards, from the table's real hand. */
const holesOf = (hand: HandState) => {
  const { holes } = dealSlots(hand.config)
  const seats = hand.config.seats.map((s) => s.seat)
  const cards: Record<SeatId, number[]> = {}
  for (const seat of seats)
    cards[seat] = holes[seat].map((slot) => hand.deck[slot])
  return { seats, slots: holes as Record<SeatId, number[]>, cards }
}

type Played = {
  /** Every frame each seat received, over all of its sockets. */
  frames: Record<SeatId, ServerMsg[]>
  sockets: Client[]
  dealt: Record<number, ReturnType<typeof holesOf>>
}
let played: Played

beforeAll(() => {
  // The archive answers every call, so the outbox never holds play back.
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
      return new Response(null, { status: 204 })
    },
  )
  forgetUsernames()
})
afterAll(() => vi.unstubAllGlobals())

beforeAll(async () => {
  const matchId = crypto.randomUUID()
  const body: InitBody = {
    matchId,
    creator: { userId: ALICE, username: 'alice' },
    opponent: { userId: BOB, username: 'bob' },
    kind: 'hu-rated',
  }
  await stub(matchId).fetch('https://table/init', {
    method: 'POST',
    body: JSON.stringify(body),
  })
  // A frozen clock far ahead of real time: no alarm fires unless elapsed.
  await freezeClock(matchId, T0)
  const alice = await connect(matchId, ALICE)
  const bob = await connect(matchId, BOB)
  const sockets = [alice, bob]
  const seats: Record<SeatId, Client> = { 0: alice, 1: bob }
  const dealt: Played['dealt'] = {}
  const deal = async (handNo: number) => {
    await seats[0].next(isState(handNo))
    dealt[handNo] = holesOf((await peek(matchId)).hand!)
  }
  const nextHand = async (handNo: number) => {
    await elapseToNextDeal(matchId)
    await deal(handNo)
  }
  const playOut = async (choose: (hand: HandState) => PlayerAction) => {
    for (;;) {
      const { hand } = await peek(matchId)
      if (hand!.result) return
      await move(matchId, seats, choose)
    }
  }

  // Hand 1 (Alice's button): Alice limps, Bob checks, Bob moves in on the
  // flop and Alice calls: an all-in showdown, settled at equity.
  await deal(1)
  await move(matchId, seats, passive)
  await move(matchId, seats, passive)
  await move(matchId, seats, raiseTo('max'))
  await move(matchId, seats, passive)
  await alice.next((f) => f.t === 'reveal' && f.handNo === 1)

  // Hand 2 (Bob's button): Bob runs out of time and folds on the clock.
  await nextHand(2)
  await elapse(matchId, RATED_CONFIG.decisionMs + RATED_CONFIG.bankMs)
  await alice.next((f) => f.t === 'reveal' && f.handNo === 2)

  // Hand 3: Alice raises, then opens the table in a second tab, which
  // replaces the first. Bob calls, drops on the flop and stays away past
  // the grace, so his turn is played for him; he comes back for the turn.
  await nextHand(3)
  await move(matchId, seats, raiseTo(60))
  const alice2 = await connect(matchId, ALICE)
  sockets.push(alice2)
  seats[0] = alice2
  await alice2.next(isState(3))
  await move(matchId, seats, passive)
  bob.ws.close(1000, 'bye')
  await alice2.next(
    (f) =>
      f.t === 'state' &&
      f.table.players.find((p) => p.seat === 1)?.connected === false,
  )
  await elapse(matchId, GRACE_MS)
  expect((await peek(matchId)).hand!.toAct).toBe(0)
  await move(matchId, seats, passive)
  const bob2 = await connect(matchId, BOB)
  sockets.push(bob2)
  seats[1] = bob2
  await bob2.next(isState(3))
  await playOut(passive)
  await alice2.next((f) => f.t === 'reveal' && f.handNo === 3)

  // Hand 4: a junk frame and a stale move, each answered with an error.
  await nextHand(4)
  alice2.ws.send('{"t":"act"}')
  await alice2.next((f) => f.t === 'error')
  const from = alice2.frames.length
  alice2.send({
    t: 'act',
    reqId: 'stale',
    handNo: 4,
    actionIndex: 99,
    action: { type: 'check' },
  })
  await alice2.next((f) => f.t === 'error' && f.reqId === 'stale', from)

  // Hands 4 to 40: Bob folds whenever he is to act.
  for (let n = 4; n <= 40; n++) {
    if (n > 4) await nextHand(n)
    await playOut((hand) => (hand.toAct === 1 ? fold() : passive(hand)))
  }
  await elapseToNextDeal(matchId)
  await alice2.next((f) => f.t === 'match_end')
  await bob2.next((f) => f.t === 'match_end')

  // Alice looks back at the finished table: the last hand, the result and
  // the rematch offer.
  await alice2.next((f) => f.t === 'rematch_state')
  const alice3 = await connect(matchId, ALICE)
  sockets.push(alice3)
  await alice3.next((f) => f.t === 'reveal' && f.handNo === 40)
  await alice3.next((f) => f.t === 'match_end')
  await alice3.next((f) => f.t === 'rematch_state')

  played = {
    frames: {
      0: [...alice.frames, ...alice2.frames, ...alice3.frames],
      1: [...bob.frames, ...bob2.frames],
    },
    sockets,
    dealt,
  }
}, 90_000)

describe('every frame of a 40-hand rated match', () => {
  it('has exactly the allowed key set for its type, and no analysis key anywhere', () => {
    const all = [...played.frames[0], ...played.frames[1]]
    expect(checkFrames(all)).toEqual(new Set(FLOW_TYPES.ratedMatch))
    for (const f of all)
      expect(analysisKeys(f), `${f.t}: analysis keys`).toEqual([])
    expect(all.map((f) => JSON.stringify(f)).join('\n')).not.toMatch(
      /"(equity|ev|range|grade|luck|allInAt|accuracy)"/i,
    )

    // What the frames above went through: all 40 hands with their reveals,
    // two showdowns, the clock and the grace playing for a seat, a second
    // tab, three welcomes for Alice, and a complete rated result.
    const ends = all.filter((f) => f.t === 'hand_end')
    expect([...new Set(ends.map((f) => f.handNo))]).toEqual(
      Array.from({ length: 40 }, (_, i) => i + 1),
    )
    for (const seat of [0, 1] as const)
      expect(
        played.frames[seat].filter((f) => f.t === 'reveal').length,
      ).toBeGreaterThanOrEqual(40)
    const showdowns = ends.filter((f) => f.record.showdown)
    expect([...new Set(showdowns.map((f) => f.handNo))]).toEqual([1, 3])
    const timed = ends.filter((f) =>
      f.record.actions.some((a) => a.source === 'timeout'),
    )
    expect([...new Set(timed.map((f) => f.handNo))]).toEqual([2, 3])
    expect(
      played.frames[0].filter((f) => f.t === 'welcome').length,
    ).toBeGreaterThanOrEqual(3)
    const end = all.find((f) => f.t === 'match_end')
    expect(end?.t === 'match_end' && end.result.reason).toBe('complete')
    expect(end?.t === 'match_end' && end.result.outcomeBySeat).toBeDefined()
  })

  it('shows the opponent hole cards in no frame or close reason before that hand reached its showdown', () => {
    const shownAt = new Map<number, SeatId[]>()
    for (const f of played.frames[0])
      if (f.t === 'hand_end')
        shownAt.set(
          f.handNo,
          f.record.shown.map((s) => s.seat),
        )
    let hidden = 0
    // The seats the table dealt in, not the ones this test kept frames for.
    for (const [seat, other] of seatPairs(played.dealt[1].seats)) {
      for (const f of played.frames[seat]) {
        if ((f.t === 'welcome' || f.t === 'state') && f.view) {
          const { cards } = played.dealt[f.view.handNo]
          // Your own cards are always yours.
          expect(bySeat(f.view.players, seat).cards).toEqual(cards[seat])
          const theirs = bySeat(f.view.players, other)
          if (theirs.cards === null) hidden++
          else {
            expect(
              f.view.result?.showdown,
              `hand ${f.view.handNo}: opponent cards before the showdown`,
            ).toBe(true)
            expect(theirs.shown).toBe(true)
            expect(theirs.cards).toEqual(cards[other])
          }
        }
        if (f.t === 'hand_end') {
          // A record shows hands only at a showdown, and only real ones.
          if (!f.record.showdown) expect(f.record.shown).toEqual([])
          for (const s of f.record.shown)
            expect(s.cards).toEqual(played.dealt[f.handNo].cards[s.seat])
        }
        if (f.t === 'reveal') {
          const { slots } = played.dealt[f.handNo]
          const opened = f.slots.map((s) => s.slot)
          if (!shownAt.get(f.handNo)?.includes(other))
            for (const slot of slots[other]) expect(opened).not.toContain(slot)
          // `own` opens this seat's slots only.
          expect((f.own ?? []).map((s) => s.slot)).toEqual(slots[seat])
        }
      }
    }
    // Most views had the opponent's cards hidden: 38 hands ended in a fold.
    expect(hidden).toBeGreaterThan(100)

    // The server closed Alice's first tab; no close reason names a card.
    const replaced = played.sockets[0].closed
    expect(replaced).toEqual({ code: 4001, reason: 'replaced' })
    for (const socket of played.sockets) {
      const reason = socket.closed?.reason ?? ''
      expect(reason).not.toMatch(/\d/)
      expect(reason).not.toMatch(/\b[2-9TJQKA][cdhs]\b/)
    }
  })
})
