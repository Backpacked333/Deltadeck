import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyProgress } from '../lib/storage'
import type { HandRecord } from '../lib/storage'
import type { AccountHistory } from './account'

const online = vi.hoisted(() => ({
  history: null as AccountHistory | null,
  fail: false,
  client: {} as Record<string, unknown>,
}))
vi.mock('../net/supabase', () => ({
  loadOnline: async () => ({
    client: online.client,
    url: 'https://x.supabase.co',
  }),
}))
// The canvas work is avatar.test.ts's; here a photo resizes to this.
const resized = vi.hoisted(() => ({ fail: null as string | null }))
vi.mock('../lib/avatar', async (original) => ({
  ...(await original<typeof import('../lib/avatar')>()),
  resizeToWebp: async () => {
    if (resized.fail) throw new Error(resized.fail)
    return new Blob(['webp'], { type: 'image/webp' })
  },
}))
vi.mock('./account', () => ({
  loadAccountHistory: async () => {
    if (online.fail) throw new Error('offline')
    return online.history
  },
}))

// Every hand the portrait reads: this browser's here (load.test.ts reads
// the account's), and who it was asked for.
const everyHand = vi.hoisted(() => ({ asked: [] as unknown[][] }))
vi.mock('./portrait/load', async (original) => {
  const { fromPractice } = await import('./portrait/hands')
  return {
    ...(await original<typeof import('./portrait/load')>()),
    loadEveryHand: async (...args: unknown[]) => {
      everyHand.asked.push(args)
      return {
        hands: (args[2] as HandRecord[]).map(fromPractice).filter(Boolean),
        missing: [],
      }
    },
  }
})

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
      avatar: null,
      school: null,
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
  online.client = {}
  resized.fail = null
  everyHand.asked = []
})

const USER = '0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c'

/** A client that records uploads, removals and RPCs. */
function pictureClient({ uploadError = false } = {}) {
  const calls: unknown[][] = []
  const bucket = {
    upload: async (...args: unknown[]) => {
      calls.push(['upload', ...args])
      return { data: {}, error: uploadError ? new Error('denied') : null }
    },
    remove: async (...args: unknown[]) => {
      calls.push(['remove', ...args])
      return { data: [], error: null }
    },
  }
  online.client = {
    auth: {
      getSession: async () => ({
        data: { session: { user: { id: USER } } },
      }),
    },
    storage: {
      from: (name: string) => {
        calls.push(['bucket', name])
        return bucket
      },
    },
    rpc: async (...args: unknown[]) => {
      calls.push(['rpc', ...args])
      return { data: null, error: null }
    },
  }
  return calls
}

describe('Your profile picture', () => {
  const photo = new File(['jpeg'], 'me.jpg', { type: 'image/jpeg' })

  it('uploads a resized picture as your own file, then points your row at it', async () => {
    const calls = pictureClient()
    online.history = history
    render(<MyProfile progress={emptyProgress()} username="carol" />)
    const region = await screen.findByRole('region', {
      name: 'Profile picture',
    })
    expect(
      within(region).queryByRole('button', { name: 'Remove picture' }),
    ).toBeNull()
    await userEvent.upload(
      within(region).getByLabelText('Choose a picture'),
      photo,
    )
    await within(region).findByRole('button', { name: 'Remove picture' })
    expect(calls[0]).toEqual(['bucket', 'avatars'])
    expect(calls[1]).toEqual([
      'upload',
      `${USER}.webp`,
      expect.any(Blob),
      { upsert: true, contentType: 'image/webp' },
    ])
    expect(calls[2]).toEqual([
      'rpc',
      'set_avatar',
      { p_version: expect.any(Number) },
    ])
    const version = (calls[2][2] as { p_version: number }).p_version
    expect(region.querySelector('.player-avatar img')).toHaveAttribute(
      'src',
      `https://x.supabase.co/storage/v1/object/public/avatars/${USER}.webp?v=${version}`,
    )
    expect(
      within(region).getByRole('button', { name: 'Change picture' }),
    ).toBeVisible()
  })

  it('removes it: the row first, then the file', async () => {
    const calls = pictureClient()
    online.history = {
      ...history,
      profile: {
        ...history.profile,
        player: { ...history.profile.player, avatar: `${USER}.webp?v=4` },
      },
    }
    render(<MyProfile progress={emptyProgress()} username="carol" />)
    const remove = await screen.findByRole('button', { name: 'Remove picture' })
    await userEvent.click(remove)
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Remove picture' }),
      ).toBeNull(),
    )
    expect(calls).toEqual([
      ['rpc', 'remove_avatar'],
      ['bucket', 'avatars'],
      ['remove', [`${USER}.webp`]],
    ])
  })

  it('says what went wrong, inline', async () => {
    const calls = pictureClient({ uploadError: true })
    online.history = history
    render(<MyProfile progress={emptyProgress()} username="carol" />)
    const input = await screen.findByLabelText('Choose a picture')
    await userEvent.upload(input, photo)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The picture could not be uploaded.',
    )
    expect(calls.some((c) => c[0] === 'rpc')).toBe(false)
    resized.fail = 'That image is over 5 MB. Choose a smaller one.'
    await userEvent.upload(input, photo)
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('over 5 MB'),
    )
  })
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

  it("draws the portrait from every hand on the player's account", async () => {
    online.history = history
    render(
      <MyProfile
        progress={{ ...emptyProgress(), hands: [hand('a', 40)] }}
        username="carol"
      />,
    )
    const portrait = await screen.findByRole('region', {
      name: 'Your player portrait',
    })
    expect(
      await within(portrait).findByText(/Play 29 more for a first read/),
    ).toBeVisible()
    expect(everyHand.asked).toEqual([
      [online.client, 'u1', [expect.any(Object)]],
    ])
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
