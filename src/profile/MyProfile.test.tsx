import { render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyProgress } from '../lib/storage'
import type { HandRecord } from '../lib/storage'
import type { AccountHistory } from './account'

const online = vi.hoisted(() => ({
  history: null as AccountHistory | null,
  fail: false,
}))
vi.mock('../net/supabase', () => ({
  loadOnline: async () => ({ client: {} }),
}))
vi.mock('./account', () => ({
  loadAccountHistory: async () => {
    if (online.fail) throw new Error('offline')
    return online.history
  },
}))

const { default: MyProfile } = await import('./MyProfile')

const hand = (id: string, net: number): HandRecord => ({
  id,
  hand: 3,
  net,
  result: net > 0 ? 'You won' : 'You lost',
  guided: false,
  decisions: [
    {
      accuracy: 90,
      grade: 'Best',
      evLost: 0,
      equity: 0.6,
    } as NonNullable<HandRecord['decisions']>[number],
  ],
})

const history: AccountHistory = {
  profile: {
    player: {
      userId: 'u1',
      username: 'carol',
      country: null,
      bio: '',
      createdAt: '2026-09-01T00:00:00Z',
    },
    rating: {
      rating: 1612,
      rd: 64,
      matches: 3,
      wins: 2,
      draws: 0,
      abandoned: 0,
      lastMatchAt: '2026-10-10T00:00:00Z',
    },
    history: [
      { at: '2026-10-01T00:00:00Z', rating: 1500, rd: 200 },
      { at: '2026-10-10T00:00:00Z', rating: 1612, rd: 64 },
    ],
    recent: [
      {
        matchId: 'm1',
        finishedAt: '2026-10-10T00:00:00Z',
        outcome: 'win',
        opponent: 'dave',
        before: 1580,
        after: 1612,
      },
    ],
  },
  school: 'uni.edu',
  challenges: [
    { hand: 'overpair', accuracy: 87, playedAt: '2026-10-02T00:00:00Z' },
  ],
}

afterEach(() => {
  online.history = null
  online.fail = false
})

describe('Your profile', () => {
  it('brings practice, online play, lessons and challenge scores together', async () => {
    online.history = history
    render(
      <MyProfile
        progress={{
          ...emptyProgress(),
          hands: [hand('a', 40), hand('b', -10)],
        }}
        username="carol"
      />,
    )
    expect(
      screen.getByRole('heading', { level: 1, name: 'carol' }),
    ).toBeVisible()
    await screen.findByText(/Playing since 1 Sept? 2026 · uni.edu/)
    const glance = screen.getByLabelText('At a glance')
    expect(glance).toHaveTextContent('Practice accuracy90')
    expect(glance).toHaveTextContent('1612 ±64')
    expect(glance).toHaveTextContent('87')
    const matches = screen.getByRole('region', { name: 'Online' })
    expect(within(matches).getByRole('link', { name: 'dave' })).toHaveAttribute(
      'href',
      '#u/dave',
    )
    expect(matches).toHaveTextContent('1580 → 1612 (+32)')
    expect(
      screen.getByRole('region', { name: 'Challenge scores' }),
    ).toHaveTextContent('Overpair under pressure87/100')
    expect(
      screen.getByRole('link', { name: 'View your public profile' }),
    ).toHaveAttribute('href', '#u/carol')
  })

  it('says what to do first when there is no history', async () => {
    online.history = {
      ...history,
      profile: { ...history.profile, rating: null, history: [], recent: [] },
      challenges: [],
    }
    render(<MyProfile progress={emptyProgress()} username="carol" />)
    expect(await screen.findByText(/No rated matches yet\./)).toBeVisible()
    expect(screen.getByText(/No hands yet\./)).toBeVisible()
    expect(screen.getByText(/No saved scores yet\./)).toBeVisible()
  })

  it('keeps practice and lessons when the account cannot be reached', async () => {
    online.fail = true
    render(
      <MyProfile
        progress={{ ...emptyProgress(), hands: [hand('a', 40)] }}
        username="carol"
      />,
    )
    expect(
      await screen.findByText(/Your online history could not be loaded/),
    ).toBeVisible()
    expect(screen.getByRole('region', { name: 'Practice' })).toHaveTextContent(
      'You won',
    )
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible()
  })
})
