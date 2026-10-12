import { describe, expect, it } from 'vitest'
import { fakeSupabase } from '../../net/fakeSupabase'
import type { HandRecord } from '../../lib/storage'
import type { HandRecordV1 } from '../../shared/protocol'
import { loadEveryHand, PAGE } from './load'

const practice = (id: string, graded = true): HandRecord => ({
  id,
  hand: 1,
  net: 20,
  result: 'You won',
  guided: false,
  at: 1,
  graded,
  decisions: graded
    ? [
        {
          street: 'preflop',
          action: 'raise',
          amount: 60,
          pot: 30,
          toCall: 10,
          grade: 'Best',
          evLost: 0,
          accuracy: 100,
          chosenEV: 0,
          bestEV: 0,
          bestLabel: '',
          equity: 0.6,
          handClass: '',
        },
      ]
    : [],
})

const record = (matchId: string, handNo: number): HandRecordV1 => ({
  v: 1,
  matchId,
  handNo,
  segment: 1,
  config: {
    handNo,
    seats: [
      { seat: 0, stack: 2000 },
      { seat: 1, stack: 2000 },
    ],
    button: 0,
    blinds: { sb: 10, bb: 20 },
  },
  seats: [
    { seat: 0, userId: 'me', username: 'me' },
    { seat: 1, userId: 'them', username: 'them' },
  ],
  commitment: '0'.repeat(64),
  actions: [
    {
      seat: 0,
      action: { type: 'call' },
      street: 'preflop',
      boardCount: 0,
      amount: 10,
      toCall: 10,
      pot: 30,
      canRaise: true,
      atMs: 0,
      decisionMs: 1500,
      source: 'client',
    },
  ],
  board: [],
  shown: [],
  awards: [],
  netBySeat: { 0: 20, 1: -20 },
  showdown: false,
})

describe('every hand', () => {
  it("reads all the account's practice hands, page by page, with this browser's", async () => {
    const rows = Array.from({ length: PAGE + 5 }, (_, i) => ({
      user_id: 'me',
      played_at: String(i).padStart(6, '0'),
      record: practice(`p${i}`, i !== 0),
    }))
    const { client, reads } = fakeSupabase({ tables: { practice_hands: rows } })
    const every = await loadEveryHand(client, 'me', [
      practice('p0'),
      practice('local'),
    ])
    expect(every.missing).toEqual([])
    expect(every.hands).toHaveLength(PAGE + 6)
    // The browser's graded copy replaces the account's provisional one.
    expect(every.hands.find((h) => h.id === 'practice:p0')!.acts).toHaveLength(
      1,
    )
    expect(reads.filter((r) => r.table === 'practice_hands')).toHaveLength(2)
  })

  it('reads every hand of every match that is over, with hole cards and grades', async () => {
    const { client } = fakeSupabase({
      tables: {
        match_players: [
          { match_id: 'm1', user_id: 'me' },
          { match_id: 'm2', user_id: 'me' },
          { match_id: 'm1', user_id: 'them' },
        ],
        matches: [
          { id: 'm1', kind: 'hu-rated', status: 'finished' },
          { id: 'm2', kind: 'hu-casual', status: 'playing' },
        ],
        hands: [
          {
            id: 'm1:1',
            match_id: 'm1',
            record: record('m1', 1),
            created_at: '2026-10-01T00:00:00Z',
          },
          {
            id: 'm1:2',
            match_id: 'm1',
            record: record('m1', 2),
            created_at: '2026-10-01T00:01:00Z',
          },
          {
            id: 'm2:1',
            match_id: 'm2',
            record: record('m2', 1),
            created_at: '2026-10-02T00:00:00Z',
          },
        ],
        hand_holes: [{ hand_id: 'm1:1', user_id: 'me', cards: [48, 49] }],
        hand_grades: [
          {
            hand_id: 'm1:2',
            user_id: 'me',
            idx: 0,
            grade: 'good',
            ev_lost: 4,
            accuracy: 85,
          },
        ],
      },
    })
    const every = await loadEveryHand(client, 'me', [])
    const online = every.hands.filter((h) => h.format !== 'practice')
    // The match in play is left out.
    expect(online.map((h) => h.id)).toEqual(['m1:1', 'm1:2'])
    expect(online[0]).toMatchObject({
      hole: 'AA',
      kind: 'hu-rated',
      net: 1,
      at: Date.parse('2026-10-01T00:00:00Z'),
    })
    expect(online[1].acts[0]).toMatchObject({
      grade: 'Good',
      accuracy: 85,
      evLost: 0.2,
    })
  })

  it('draws without a part that fails, and names it', async () => {
    const { client } = fakeSupabase({ tables: {}, fail: ['match_players'] })
    const every = await loadEveryHand(client, 'me', [practice('a')])
    expect(every.missing).toEqual(['online'])
    expect(every.hands).toHaveLength(1)
  })

  it("reads this browser's practice alone when signed out", async () => {
    const every = await loadEveryHand(null, null, [
      practice('a'),
      { ...practice('g'), guided: true },
    ])
    expect(every).toEqual({
      hands: [expect.objectContaining({ id: 'practice:a' })],
      missing: [],
    })
  })
})
