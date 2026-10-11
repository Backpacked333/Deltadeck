// @vitest-environment node
// The six-seat smoke's checks (scripts/smoke/six.ts), each fed the frames
// of a server fault it must report. The run itself plays against a real
// server; here the frames are built from the engine as the table builds
// them (src/net/testing.ts), then broken one way at a time.
import { describe, expect, it, vi } from 'vitest'
import type { HandRecordV1, ServerMsg } from '../../src/shared/protocol'
import { MATCH, SIX_ROSTER, sixFrame, sixHand } from '../../src/net/testing'
import { ACK_LOST_MS, SixRun } from './six'
import type { Client } from './six'

vi.spyOn(console, 'error').mockImplementation(() => {})

/** A run with the roster's four players as its clients. */
function setUp() {
  const run = new SixRun('http://localhost:8787', 'test-secret', 200)
  const sent: Record<string, unknown[]> = {}
  const at = (name: string) => {
    const c: Client = { ...run.client(name), name }
    sent[name] = []
    c.ws = { send: (d) => sent[name].push(JSON.parse(d)), close: () => {} }
    run.clients.push(c)
    return c
  }
  const [bob, alice, carol, dave] = SIX_ROSTER.map((r) => at(r.username))
  return { run, sent, bob, alice, carol, dave }
}

/** Each client welcomed at its roster seat, with `hand` dealt to all. */
async function seated(run: SixRun, clients: Client[], hand = sixHand()) {
  for (const c of clients) {
    const seat = SIX_ROSTER.find((r) => r.username === c.name)!.seat
    await run.receive(c, sixFrame('welcome', 1, seat, seat, hand))
  }
  return hand
}

const record = (
  handNo: number,
  stacks: Record<number, number>,
  net: Record<number, number> = {},
): HandRecordV1 =>
  ({
    v: 1,
    matchId: MATCH,
    handNo,
    segment: 0,
    config: {
      ...sixHand().config,
      handNo,
      seats: Object.entries(stacks).map(([seat, stack]) => ({
        seat: Number(seat),
        stack,
      })),
    },
    seats: Object.keys(stacks).map((seat) => {
      const name = SIX_ROSTER.find((r) => r.seat === Number(seat))!.username
      return { seat: Number(seat), userId: name, username: name }
    }),
    commitment: 'c',
    actions: [],
    board: [],
    shown: [],
    awards: [],
    netBySeat: Object.fromEntries(
      Object.keys(stacks).map((s) => [s, net[Number(s)] ?? 0]),
    ),
    showdown: false,
  }) as HandRecordV1

const handEnd = (r: HandRecordV1): ServerMsg => ({
  t: 'hand_end',
  seq: 5,
  matchId: MATCH,
  handNo: r.handNo,
  record: r,
})

describe('six-seat smoke: leaks', () => {
  it('counts a view built for another seat, whatever seat it names', async () => {
    // Review B1: the old check trusted view.you, so seat 0's whole view
    // (its cards included) sent to alice at seat 2 passed.
    const { run, alice } = setUp()
    const hand = await seated(run, [alice])
    expect(run.result.leaks).toBe(0)
    await run.receive(alice, sixFrame('state', 2, 0, 0, hand))
    expect(run.result.leaks).toBe(1)
  })

  it('counts a seat shown while folded, or shown before the showdown', async () => {
    const { run, alice } = setUp()
    const hand = await seated(run, [alice])
    const frame = sixFrame('state', 2, 2, 2, hand) as Extract<
      ServerMsg,
      { t: 'state' }
    >
    const bob = frame.view!.players.find((p) => p.seat === 0)!
    bob.shown = true
    bob.cards = [0, 1]
    await run.receive(alice, frame)
    expect(run.result.leaks).toBe(1)
    expect(run.result.failures[0]).toMatch(/seat 0 shown on the preflop/)
  })

  it('counts any hand frame, or a hand end it was not dealt, on a socket without a seat', async () => {
    // Review B6: a watcher that never sits gets the roster, nothing more.
    const { run } = setUp()
    const watcher = run.client('w', true)
    run.clients.push(watcher)
    await run.receive(watcher, sixFrame('welcome', 1, null, null, null))
    await run.receive(watcher, {
      t: 'hand_start',
      seq: 2,
      matchId: MATCH,
      handNo: 1,
      commitment: 'c',
      button: 0,
      blinds: { sb: 10, bb: 20 },
      stacks: [],
    })
    await run.receive(watcher, handEnd(record(1, { 0: 2000, 2: 2000 })))
    expect(run.result.leaks).toBe(2)
  })

  it('counts an own opening for a socket not dealt in, and one that does not open its own cards', async () => {
    // Review B2: the reveal's own opening was never read.
    const { run, alice, bob, carol } = setUp()
    await seated(run, [alice, bob])
    await run.receive(bob, {
      t: 'hand_start',
      seq: 2,
      matchId: MATCH,
      handNo: 1,
      commitment: 'c',
      button: 0,
      blinds: { sb: 10, bb: 20 },
      stacks: [],
    })
    // Dealt: bob (seat 0) and alice (seat 2), not carol.
    await run.receive(bob, handEnd(record(1, { 0: 2000, 2: 2000 })))
    const reveal = (own?: { slot: number; card: number; salt: string }[]) =>
      ({
        t: 'reveal',
        seq: 6,
        matchId: MATCH,
        handNo: 1,
        leaves: '',
        slots: [],
        ...(own ? { own } : {}),
      }) as ServerMsg
    const opening = [
      { slot: 0, card: 0, salt: '' },
      { slot: 1, card: 1, salt: '' },
    ]
    const leaks = run.result.leaks
    await run.receive(carol, reveal(opening))
    expect(run.result.leaks).toBe(leaks + 1)
    // Alice's own opening, not of the cards she was dealt.
    await run.receive(alice, reveal(opening))
    expect(run.result.leaks).toBe(leaks + 2)
    // A dealt socket with no own opening at all.
    await run.receive(bob, reveal())
    expect(
      run.result.failures.some((f) => /bob .* no own opening/.test(f)),
    ).toBe(true)
  })
})

describe('six-seat smoke: chips and records', () => {
  it('fails an account dealt more than its last hand left it', async () => {
    // Review B3: chips made between hands passed, each hand checked alone.
    const { run, bob } = setUp()
    bob.seat = 0
    await run.receive(bob, handEnd(record(1, { 0: 2000, 2: 2000 })))
    expect(run.result.failures).toEqual([])
    await run.receive(bob, handEnd(record(2, { 0: 5000, 2: 2000 })))
    expect(run.result.failures).toEqual([
      `${MATCH}#2: bob dealt 5000, left with 2000 by its last hand`,
    ])
  })

  it('lets a rebuy from below 100 bb deal the buy-in, and nothing else', async () => {
    const { run, bob } = setUp()
    bob.seat = 0
    await run.receive(
      bob,
      handEnd(record(1, { 0: 2000, 2: 2000 }, { 0: -2000, 2: 2000 })),
    )
    bob.toppedUp = true
    await run.receive(bob, handEnd(record(2, { 0: 2000, 2: 4000 })))
    expect(run.result.failures).toEqual([])
    // No rebuy asked this time: bob left with 2000 cannot be dealt 2500.
    await run.receive(bob, handEnd(record(3, { 0: 2500, 2: 4000 })))
    expect(run.result.failures).toHaveLength(1)
  })

  it('lets a rebuy asked as the bust hand ends deal the buy-in next hand', async () => {
    // The live run: the rebuy goes out on the hand's last state frame,
    // before that hand's record arrives, which must not use it up.
    const { run, bob } = setUp()
    bob.seat = 0
    await run.receive(bob, handEnd(record(1, { 0: 2000, 2: 2000 })))
    bob.toppedUp = true // the rebuy, as hand 2 ends with bob at 0
    await run.receive(
      bob,
      handEnd(record(2, { 0: 2000, 2: 2000 }, { 0: -2000, 2: 2000 })),
    )
    await run.receive(bob, handEnd(record(3, { 0: 2000, 2: 4000 })))
    expect(run.result.failures).toEqual([])
  })

  it('stands up only the clients holding a seat at the end', () => {
    // The live run: a stand from a socket without a seat is refused
    // (not_seated), which is an error frame and a failure.
    const { run, sent, bob, alice } = setUp()
    bob.seat = 0
    run.standSeated()
    expect(sent.bob).toEqual([{ t: 'stand' }])
    expect(sent.alice).toEqual([])
    expect(alice.stood && bob.stood).toBe(true)
  })

  it('fails a record naming another account at a seat its views gave', async () => {
    const { run, alice } = setUp()
    await seated(run, [alice])
    const r = record(1, { 0: 2000, 2: 2000, 3: 1500, 5: 3000 })
    r.seats = r.seats.map((s) =>
      s.seat === 2 ? { ...s, username: 'carol', userId: 'carol' } : s,
    )
    await run.receive(alice, handEnd(r))
    expect(
      run.result.failures.some((f) =>
        f.includes('seat 2 is alice in its views, carol in the record'),
      ),
    ).toBe(true)
  })
})

describe('six-seat smoke: frames and the end of the run', () => {
  it('fails a hand that started and never ended, or a hand never seen', () => {
    // Review B4: a started hand with no end was skipped silently.
    const { run, bob } = setUp()
    const start = (handNo: number): ServerMsg => ({
      t: 'hand_start',
      seq: handNo,
      matchId: MATCH,
      handNo,
      commitment: `c${handNo}`,
      button: 0,
      blinds: { sb: 10, bb: 20 },
      stacks: [],
    })
    bob.seat = 0
    void run.receive(bob, start(3))
    void run.receive(bob, start(5))
    run.endChecks()
    expect(run.result.failures).toEqual([
      `${MATCH}#3: started and never ended`,
      `${MATCH}#4: never seen`,
    ])
  })

  it('fails a seat lost without a stand, and does not sit again', async () => {
    // Review B5: the bare sit on any seatless welcome hid a lost seat.
    const { run, sent, alice } = setUp()
    await seated(run, [alice])
    await run.receive(alice, sixFrame('welcome', 2, null, null, null))
    expect(run.result.failures).toEqual(['alice: lost its seat'])
    expect(sent.alice).toEqual([])
  })

  it('fails a reconnect that comes back to another seat', async () => {
    const { run, alice } = setUp()
    alice.returning = 2
    await run.receive(alice, sixFrame('welcome', 1, 4, null, null))
    expect(run.result.failures).toEqual([
      'alice: back from a drop at seat 4, not 2',
    ])
  })

  it('fails a move never acknowledged, and only one older than the limit', () => {
    // Review S3.
    const { run, bob, alice } = setUp()
    bob.pending = { reqId: 'x1', sentAt: 1000 }
    alice.pending = { reqId: 'x2', sentAt: 1000 + 5000 }
    expect(run.endChecks(1000 + ACK_LOST_MS + 1)).toBe(1)
    expect(run.result.failures).toEqual(['bob: a move never acknowledged'])
  })

  it('fails a lobby listing that does not show the clients seated', () => {
    // Review N2: the seated count was printed, never checked.
    const { run, bob, alice } = setUp()
    bob.seat = 0
    alice.seat = 2
    run.listedCheck({ seated: 2 })
    expect(run.result.failures).toEqual([])
    run.listedCheck({ seated: 1 })
    run.listedCheck(undefined)
    expect(run.result.failures).toHaveLength(2)
  })

  it('fails a table holding a player from outside the run', async () => {
    // Review S2: quick-sit on a reused server can pick such a table.
    const { run } = setUp()
    const c = run.client(9)
    run.clients.push(c)
    await run.receive(c, sixFrame('welcome', 1, null, null, null))
    expect(run.result.failures).toHaveLength(0)
    run.clients.splice(0, 1)
    await run.receive(c, sixFrame('state', 2, null, null, null))
    expect(run.result.failures[0]).toMatch(/outside this run/)
  })
})
