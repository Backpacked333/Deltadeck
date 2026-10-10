import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { act, isOver, legalActions, startHand } from '../engine/hand'
import { deckWith } from '../engine/testing'
import type { HandConfig, SeatId } from '../engine/types'
import type { HandRecordV1 } from '../shared/protocol'
import { fakeSupabase } from './fakeSupabase'
import { MatchReview } from './MatchReview'
import { finishedHand, MATCH } from './testing'

async function tables(status = 'finished') {
  const showdown = (await finishedHand()).record
  const folded: HandRecordV1 = {
    ...(await finishedHand({ fold: true })).record,
    handNo: 2,
  }
  return {
    matches: [
      {
        id: MATCH,
        kind: 'hu-rated',
        status,
        finished_at: '2026-10-10T10:00:00Z',
      },
    ],
    match_players: [
      { match_id: MATCH, seat: 0, user_id: 'u-alice', outcome: 'win' },
      { match_id: MATCH, seat: 1, user_id: 'u-bob', outcome: 'loss' },
    ],
    players: [
      { user_id: 'u-alice', username: 'alice' },
      { user_id: 'u-bob', username: 'bob' },
    ],
    hands: [
      { match_id: MATCH, hand_no: 1, record: showdown, verified: true },
      { match_id: MATCH, hand_no: 2, record: folded, verified: true },
    ],
  }
}

const cards = () =>
  [...document.querySelectorAll('.mini-card')].map((c) => c.textContent)

describe('the public match review', () => {
  it('shows each hand with only the cards shown at showdown', async () => {
    const { client } = fakeSupabase({ tables: await tables() })
    render(<MatchReview client={client} matchId={MATCH} />)
    const hand1 = await screen.findByRole('region', { name: 'Hand 1' })
    expect(screen.getByText('alice won, bob lost.')).toBeInTheDocument()
    // Hand 1 went to showdown: both hands were shown, and the board.
    expect(within(hand1).getByText('alice showed')).toBeInTheDocument()
    expect(within(hand1).getByText('bob showed')).toBeInTheDocument()
    expect(cards()).toHaveLength(9)
    expect(within(hand1).getByText('Verified')).toBeInTheDocument()
    // Decision times stay out of the public review.
    expect(hand1).not.toHaveTextContent(/1\.5 s/)

    // Hand 2 ended with a fold before the flop: no card of anyone's.
    fireEvent.click(screen.getByRole('button', { name: 'Next hand' }))
    const hand2 = await screen.findByRole('region', { name: 'Hand 2' })
    expect(within(hand2).queryByText(/showed/)).toBeNull()
    expect(cards()).toEqual([])
    expect(hand2).toHaveTextContent('alice folds')
    expect(screen.getByText('Hand 2 of 2')).toBeInTheDocument()
  })

  it('a match still being played is not shown, and its hands are not read', async () => {
    const { client, reads } = fakeSupabase({
      tables: await tables('playing'),
    })
    render(<MatchReview client={client} matchId={MATCH} />)
    expect(
      await screen.findByText(/This match is still being played/),
    ).toBeInTheDocument()
    expect(reads.map((r) => r.table)).toEqual(['matches'])
    expect(cards()).toEqual([])
  })

  it('a match still in play can be checked again, and shows its hands once it ends', async () => {
    const t = await tables('playing')
    const { client } = fakeSupabase({ tables: t })
    render(<MatchReview client={client} matchId={MATCH} />)
    await screen.findByText(/This match is still being played/)
    t.matches[0].status = 'finished'
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(
      await screen.findByRole('region', { name: 'Hand 1' }),
    ).toBeInTheDocument()
  })

  it('a void match says why, without blaming both players for a no-show', async () => {
    const t = await tables('void')
    Object.assign(t.matches[0], { result: { reason: 'no_show' } })
    for (const p of t.match_players) p.outcome = null as unknown as string
    const { client } = fakeSupabase({ tables: t })
    render(<MatchReview client={client} matchId={MATCH} />)
    expect(
      await screen.findByText('Void: a player did not arrive. Not rated.'),
    ).toBeInTheDocument()
    expect(screen.queryByText(/both players left/)).toBeNull()
  })

  it('an unknown match says so', async () => {
    const { client } = fakeSupabase({ tables: await tables() })
    render(
      <MatchReview
        client={client}
        matchId="99999999-9999-4999-8999-999999999999"
      />,
    )
    expect(
      await screen.findByText('There is no such match.'),
    ).toBeInTheDocument()
  })
})

/**
 * One hand of a six-casual session, checked down to showdown from real engine
 * states and archived as the server writes it: `seats` is who sat where in
 * this hand (record.seats), named as they were when they sat down. The board
 * gives 7c 2h two pair, which beats As Kd and Qs Qd.
 */
function sessionHand(
  handNo: number,
  seats: { seat: SeatId; user: string; holes: string }[],
): HandRecordV1 {
  const cfg: HandConfig = {
    handNo,
    seats: seats.map(({ seat }) => ({ seat, stack: 2000 })),
    button: seats[0].seat,
    blinds: { sb: 10, bb: 20 },
  }
  const holes = Object.fromEntries(seats.map((s) => [s.seat, s.holes]))
  let hand = startHand(cfg, deckWith(cfg, holes, '2c 7d 9h Tc 3s'))
  while (!isOver(hand))
    hand = act(hand, hand.toAct!, {
      type: legalActions(hand).canCheck ? 'check' : 'call',
    })
  return {
    v: 1,
    matchId: MATCH,
    handNo,
    segment: 1,
    config: cfg,
    seats: seats.map(({ seat, user }) => ({
      seat,
      userId: `u-${user}`,
      username: user,
    })),
    commitment: 'ab'.repeat(32),
    actions: hand.actions.map((a) => ({
      ...a,
      atMs: 0,
      decisionMs: 1500,
      source: 'client' as const,
    })),
    board: hand.board,
    shown: hand.players
      .filter((p) => p.shown)
      .map((p) => ({ seat: p.seat, cards: p.cards! })),
    awards: hand.result!.awards,
    netBySeat: hand.result!.netBySeat,
    showdown: hand.result!.showdown,
  }
}

/**
 * A finished six-casual session as the archive holds it after P2-03a:
 * match_players has one row per account, its seat the last one held, so a
 * seat number can belong to several rows. Casual play records no outcome.
 */
function session(
  players: { user: string; seat: SeatId; name?: string }[],
  hands: HandRecordV1[],
) {
  return {
    matches: [
      {
        id: MATCH,
        kind: 'six-casual',
        status: 'finished',
        finished_at: '2026-10-10T10:00:00Z',
      },
    ],
    match_players: players.map(({ user, seat }) => ({
      match_id: MATCH,
      seat,
      user_id: `u-${user}`,
      outcome: null,
    })),
    players: players.map(({ user, name }) => ({
      user_id: `u-${user}`,
      username: name ?? user,
    })),
    hands: hands.map((record) => ({
      match_id: MATCH,
      hand_no: record.handNo,
      record,
      verified: true,
    })),
  }
}

/** React's warnings for two list children with one key. */
const duplicateKeys = (calls: unknown[][]) =>
  calls.filter((args) => args.some((a) => String(a).includes('same key')))

describe('the public review of a six-casual session', () => {
  it('names the player of each hand from that hand, when two accounts used seat 1', async () => {
    const error = vi.spyOn(console, 'error')
    const { client } = fakeSupabase({
      tables: session(
        [
          { user: 'alice', seat: 0 },
          // bob has renamed himself since hand 1: a hand names the account
          // by its name now, as the header does, not the name it sat with.
          { user: 'bob', seat: 1, name: 'robert' },
          { user: 'dave', seat: 1 },
        ],
        [
          sessionHand(1, [
            { seat: 0, user: 'alice', holes: 'As Kd' },
            { seat: 1, user: 'bob', holes: '7c 2h' },
          ]),
          // bob stood up after hand 1 and dave took seat 1.
          sessionHand(2, [
            { seat: 0, user: 'alice', holes: 'As Kd' },
            { seat: 1, user: 'dave', holes: '7c 2h' },
          ]),
        ],
      ),
    })
    render(<MatchReview client={client} matchId={MATCH} />)

    const hand1 = await screen.findByRole('region', { name: 'Hand 1' })
    expect(within(hand1).getByText('robert showed')).toBeInTheDocument()
    expect(hand1).toHaveTextContent('robert checks')
    expect(hand1).toHaveTextContent('alice −20 · robert +20 chips')
    expect(hand1).not.toHaveTextContent('dave')

    fireEvent.click(screen.getByRole('button', { name: 'Next hand' }))
    const hand2 = await screen.findByRole('region', { name: 'Hand 2' })
    expect(within(hand2).getByText('dave showed')).toBeInTheDocument()
    expect(hand2).toHaveTextContent('dave checks')
    expect(hand2).toHaveTextContent('alice −20 · dave +20 chips')
    expect(hand2).not.toHaveTextContent(/robert|bob/)

    // The header still lists every account once, keyed by account.
    for (const name of ['alice', 'robert', 'dave'])
      expect(screen.getByRole('link', { name })).toHaveAttribute(
        'href',
        `#u/${name}`,
      )
    expect(duplicateKeys(error.mock.calls)).toEqual([])
  })

  it('a player who sits down after hand 1 is named from their first hand', async () => {
    const { client } = fakeSupabase({
      tables: session(
        [
          { user: 'alice', seat: 0 },
          { user: 'bob', seat: 1 },
          { user: 'carol', seat: 3 },
        ],
        [
          sessionHand(1, [
            { seat: 0, user: 'alice', holes: 'As Kd' },
            { seat: 1, user: 'bob', holes: '7c 2h' },
          ]),
          // carol sat down in seat 3 during hand 1 and was dealt in at hand 2.
          sessionHand(2, [
            { seat: 0, user: 'alice', holes: 'As Kd' },
            { seat: 1, user: 'bob', holes: '7c 2h' },
            { seat: 3, user: 'carol', holes: 'Qs Qd' },
          ]),
        ],
      ),
    })
    render(<MatchReview client={client} matchId={MATCH} />)

    const hand1 = await screen.findByRole('region', { name: 'Hand 1' })
    expect(hand1).not.toHaveTextContent('carol')
    expect(hand1).toHaveTextContent('alice −20 · bob +20 chips')

    fireEvent.click(screen.getByRole('button', { name: 'Next hand' }))
    const hand2 = await screen.findByRole('region', { name: 'Hand 2' })
    expect(within(hand2).getByText('carol showed')).toBeInTheDocument()
    expect(hand2).toHaveTextContent('carol checks')
    // Every seat dealt in has its net, seat 3 included: nothing is dropped.
    expect(hand2).toHaveTextContent('alice −20 · bob +40 · carol −20 chips')
  })
})
