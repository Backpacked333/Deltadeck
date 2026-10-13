// Everything a client receives, checked against what it may know. The schema
// (src/shared/protocol.ts) has no field for the deck, the hand secret or an
// unshown hand; these tests prove the bytes on the wire agree, for every
// frame type the table sends, and that nothing about the hidden cards
// changes what a seat receives before showdown.
import { runInDurableObject } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dealSlots } from '../../src/engine/deck'
import { legalActions } from '../../src/engine/hand'
import { seededDeck } from '../../src/engine/testing'
import type { ServerMsg } from '../../src/shared/protocol'
import type { TableController } from '../src/controller'
import { RATED_CONFIG } from '../src/rated'
import type { InitBody, TableDO } from '../src/table'
import {
  bySeat,
  connect,
  createTable,
  DEV_SECRET,
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
import { checkFrame, checkFrames, FLOW_TYPES } from './frames'

/** Plays checks and calls (or one fold) from the server's real state. */
async function play(
  matchId: string,
  clients: Record<number, Client>,
  handNo: number,
  fold = false,
) {
  for (let guard = 0; guard < 20; guard++) {
    const { hand } = await peek(matchId)
    if (!hand || hand.street === 'showdown' || hand.result) return
    const seat = hand.toAct!
    const legal = legalActions(hand)
    const from = clients[seat].frames.length
    clients[seat].send({
      t: 'act',
      reqId: `h${handNo}-${hand.actions.length}`,
      handNo,
      actionIndex: hand.actions.length,
      action: fold
        ? { type: 'fold' }
        : legal.canCheck
          ? { type: 'check' }
          : { type: 'call' },
    })
    await clients[seat].next(isState(handNo, hand.actions.length + 1), from)
  }
}

async function storedDeck(matchId: string, handNo: number) {
  return runInDurableObject(stub(matchId), async (instance: TableDO) => {
    const ctx = (instance as unknown as { ctx: DurableObjectState }).ctx
    return (await ctx.storage.get(`deck:${handNo}`)) as {
      deck: number[]
      secret: string
    }
  })
}

let logged: string[] = []
beforeEach(() => {
  logged = []
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const)
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => String(a)).join(' '))
    })
})
afterEach(() => vi.restoreAllMocks())

describe('every frame a seat receives', () => {
  it('carries only allowed keys, and never the deck, the secret or an unshown hand', async () => {
    const matchId = await createTable('alice', 2)
    const alice = await connect(matchId, 'alice')
    const bob = await connect(matchId, 'bob')
    const clients: Record<number, Client> = { 0: alice, 1: bob }
    await alice.next(isState(1))
    await bob.next(isState(1))
    // Hand 1 to showdown, with a resync and a junk frame in the middle.
    bob.send({ t: 'resync' })
    bob.ws.send('{"t":"act"}')
    await bob.next((f) => f.t === 'error')
    await play(matchId, clients, 1)
    await alice.next((f) => f.t === 'reveal' && f.handNo === 1)
    // Hand 2 ends with a fold before the flop: nobody shows.
    await elapseToNextDeal(matchId)
    await alice.next(isState(2))
    await play(matchId, clients, 2, true)
    await elapseToNextDeal(matchId)
    await alice.next((f) => f.t === 'match_end')
    await bob.next((f) => f.t === 'match_end')

    const all = [...alice.frames, ...bob.frames]
    expect(checkFrames(all)).toEqual(new Set(FLOW_TYPES.casual))

    const wire = all.map((f) => JSON.stringify(f)).join('\n')
    for (const handNo of [1, 2]) {
      const { deck, secret } = await storedDeck(matchId, handNo)
      const hex = Array.from(atob(secret), (c) =>
        c.charCodeAt(0).toString(16).padStart(2, '0'),
      ).join('')
      expect(wire).not.toContain(secret)
      expect(wire).not.toContain(hex)
      expect(wire).not.toContain(JSON.stringify(deck))
    }

    // Hand 2: each seat's cards reach only that seat, for every pair of
    // seats; the reveal opens no hole slot, and the record shows no hand.
    const { deck } = await storedDeck(matchId, 2)
    const { match } = await peek(matchId)
    const config = {
      handNo: 2,
      seats: [
        { seat: 0, stack: 2000 },
        { seat: 1, stack: 2000 },
      ],
      button: 1,
      blinds: { sb: 10, bb: 20 },
    }
    expect(match.handNo).toBe(2)
    const holes = dealSlots(config).holes
    for (const [seat, other] of seatPairs(config.seats.map((s) => s.seat))) {
      const theirs = holes[other].map((slot) => deck[slot])
      for (const f of clients[seat].frames) {
        if ((f.t === 'state' || f.t === 'welcome') && f.view?.handNo === 2)
          expect(bySeat(f.view.players, other).cards).toBeNull()
        if (f.t === 'hand_end' && f.handNo === 2)
          expect(f.record.shown).toEqual([])
        if (f.t === 'reveal' && f.handNo === 2) {
          expect(f.slots).toEqual([])
          expect(f.slots.map((s) => s.card)).not.toEqual(
            expect.arrayContaining(theirs),
          )
          // Each seat can check its own folded cards, and only its own.
          expect(f.own?.map((s) => [s.slot, s.card])).toEqual(
            holes[seat].map((slot) => [slot, deck[slot]]),
          )
          for (const s of f.own ?? []) {
            expect(holes[other]).not.toContain(s.slot)
            expect(theirs).not.toContain(s.card)
          }
        }
      }
    }

    // Logs carry no token, secret or deck.
    const logs = logged.join('\n')
    expect(logs).not.toContain(DEV_SECRET)
    expect(logs).not.toMatch(/bearer\.|eyJ[\w-]{10,}/)
  })
})

describe('every frame of a rated match', () => {
  it('carries only allowed keys, through an all-in showdown and a forfeit', async () => {
    const matchId = crypto.randomUUID()
    const body: InitBody = {
      matchId,
      creator: { userId: 'alice', username: 'alice' },
      opponent: { userId: 'bob', username: 'bob' },
      kind: 'hu-rated',
    }
    await stub(matchId).fetch('https://table/init', {
      method: 'POST',
      body: JSON.stringify(body),
    })
    await freezeClock(matchId)
    const alice = await connect(matchId, 'alice')
    const bob = await connect(matchId, 'bob')
    const clients: Record<number, Client> = { 0: alice, 1: bob }
    await alice.next(isState(1))
    await bob.next(isState(1))
    const passive = (hand: Parameters<typeof legalActions>[0]) =>
      legalActions(hand).canCheck
        ? ({ type: 'check' } as const)
        : ({ type: 'call' } as const)
    // Hand 1: all in on the flop, settled at equity after the showdown.
    await move(matchId, clients, passive)
    await move(matchId, clients, passive)
    await move(matchId, clients, (hand) => ({
      type: 'raise',
      to: legalActions(hand).maxRaiseTo,
    }))
    await move(matchId, clients, passive)
    await alice.next((f) => f.t === 'reveal' && f.handNo === 1)
    // Hands 2 to 4: Bob times out three times in a row and forfeits.
    const away = RATED_CONFIG.decisionMs + RATED_CONFIG.bankMs
    await elapseToNextDeal(matchId)
    await alice.next(isState(2))
    await elapse(matchId, away)
    await elapseToNextDeal(matchId)
    await alice.next(isState(3))
    await move(matchId, clients, () => ({ type: 'raise', to: 60 }))
    await elapse(matchId, away)
    await elapseToNextDeal(matchId)
    await alice.next(isState(4))
    await elapse(matchId, away)
    await alice.next((f) => f.t === 'match_end')
    await bob.next((f) => f.t === 'match_end')

    const all = [...alice.frames, ...bob.frames]
    for (const f of all) checkFrame(f)
    const end = all.find((f) => f.t === 'match_end')
    expect(end?.t === 'match_end' && Object.keys(end.result).sort()).toEqual([
      'adjustedBySeat',
      'forfeit',
      'netBySeat',
      'outcomeBySeat',
      'reason',
    ])
    expect(all.map((f) => JSON.stringify(f)).join('\n')).not.toMatch(
      /"(luck|equity|allInAt)"/,
    )
  })
})

describe('a seat before showdown', () => {
  /** A table that deals `deck` for hand 1 with seat 0 on the button. */
  async function tableWith(deck: number[]) {
    const matchId = await createTable('alice', 1)
    await freezeClock(matchId)
    const fixed: TableController = {
      nextHandPlan: (handNo, config) =>
        handNo > 1
          ? null
          : {
              config: {
                handNo,
                seats: [
                  { seat: 0, stack: config.startingStack },
                  { seat: 1, stack: config.startingStack },
                ],
                button: 0,
                blinds: config.blinds,
              },
              deck,
              secret: new Uint8Array(32).fill(7),
            },
    }
    await runInDurableObject(stub(matchId), (instance: TableDO) => {
      instance.controller = fixed
    })
    const alice = await connect(matchId, 'alice')
    const bob = await connect(matchId, 'bob')
    await alice.next(isState(1))
    await play(matchId, { 0: alice, 1: bob }, 1)
    // Finish the match so both accounts are free for the next table.
    await elapseToNextDeal(matchId)
    await alice.next((f) => f.t === 'match_end')
    return alice
  }

  it('receives the same bytes whatever the opponent holds', async () => {
    const config = {
      handNo: 1,
      seats: [
        { seat: 0, stack: 2000 },
        { seat: 1, stack: 2000 },
      ],
      button: 0,
      blinds: { sb: 10, bb: 20 },
    }
    const { holes } = dealSlots(config)
    const a = seededDeck(41)
    // Same board and same cards for alice; bob's two cards swapped with
    // two slots nobody is dealt.
    const b = [...a]
    const [x, y] = holes[1]
    ;[b[x], b[20]] = [a[20], a[x]]
    ;[b[y], b[21]] = [a[21], a[y]]

    const before = (frames: ServerMsg[]) => {
      const out: string[] = []
      for (const f of frames) {
        if (f.t === 'hand_end' || f.t === 'reveal' || f.t === 'match_end') break
        if ((f.t === 'state' || f.t === 'welcome') && f.view?.result) break
        // The match id and the commitment differ by construction.
        const text = JSON.stringify(f)
          .replaceAll(f.matchId, '<match>')
          .replace(/[0-9a-f]{64}/g, '<commitment>')
          .replace(/"activationId":"[^"]+"/g, '"activationId":"<activation>"')
          .replace(/"membershipGeneration":\d+/g, '"membershipGeneration":1')
        out.push(text)
      }
      return out
    }
    const seenA = before((await tableWith(a)).frames)
    const seenB = before((await tableWith(b)).frames)
    expect(seenA.length).toBeGreaterThan(5)
    expect(seenB).toEqual(seenA)
  })
})
