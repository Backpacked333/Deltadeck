import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { AvatarBase } from '../avatarBase'
import { fakeSupabase } from '../fakeSupabase'
import { Profile } from './Profile'

const ALICE = '00000000-0000-4000-8000-00000000000a'
const opp = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const match = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const day = (n: number) =>
  new Date(Date.UTC(2026, 8, 1) + n * 86_400_000).toISOString()

/** Alice: 25 rated matches, one change a day, plus a sanction-free record. */
function aliceTables({ matches = 25, rd = 64 } = {}) {
  const history = Array.from({ length: matches }, (_, i) => ({
    user_id: ALICE,
    format: 'hu-duplicate',
    kind: 'match',
    match_id: match(i + 1),
    outcome: i % 3 === 0 ? 'loss' : i % 5 === 0 ? 'draw' : 'win',
    before_rating: 1500 + i * 5,
    before_rd: 300 - i * 9,
    after_rating: 1505 + i * 5,
    after_rd: 291 - i * 9,
    created_at: day(i),
    played_at: day(i),
  }))
  return {
    players: [
      {
        user_id: ALICE,
        username: 'alice',
        country: 'GB',
        bio: 'Studying statistics',
        created_at: day(-10),
      },
      ...Array.from({ length: matches }, (_, i) => ({
        user_id: opp(i + 1),
        username: `rival${i + 1}`,
      })),
    ],
    ratings: [
      {
        user_id: ALICE,
        format: 'hu-duplicate',
        rating: 1625.4,
        rd,
        matches,
        wins: 14,
        draws: 2,
        abandoned: 1,
        last_match_at: day(matches),
      },
    ],
    rating_history: history,
    match_players: history.flatMap((h, i) => [
      { match_id: h.match_id, user_id: ALICE },
      { match_id: h.match_id, user_id: opp(i + 1) },
    ]),
    matches: history.map((h) => ({
      id: h.match_id,
      finished_at: h.created_at,
    })),
  }
}

describe('the public profile', () => {
  it('shows rating ± RD, the established badge, volume, abandonment and an empty sanctions field', async () => {
    const { client } = fakeSupabase({ tables: aliceTables() })
    render(<Profile client={client} username="alice" />)
    expect(await screen.findByText('1625 ± 64')).toBeInTheDocument()
    expect(screen.getByText('Established')).toBeInTheDocument()
    const stat = (name: string) =>
      screen.getByText(name, { selector: 'dt' }).nextElementSibling!.textContent
    expect(stat('Rated matches')).toBe('25')
    expect(stat('Won · drawn · lost')).toBe('14 · 2 · 9')
    expect(stat('Win rate')).toBe('56%')
    expect(stat('Abandoned')).toBe('1 of 25 (4%)')
    expect(stat('Sanctions')).toBe('None')
    expect(screen.getByRole('link', { name: 'Method' })).toHaveAttribute(
      'href',
      '#method',
    )
    expect(
      screen.getByRole('img', { name: /Rating over time/ }),
    ).toBeInTheDocument()
    expect(screen.getByText('Studying statistics')).toBeInTheDocument()
  })

  it('lists the last 20 rated matches, newest first, each linking to its hands', async () => {
    const { client } = fakeSupabase({ tables: aliceTables() })
    render(<Profile client={client} username="alice" />)
    const list = await screen.findByRole('list')
    const items = within(list).getAllByRole('listitem')
    expect(items).toHaveLength(20)
    // Match 25 (index 24) was a loss in this data: 1620 → 1625.
    expect(items[0]).toHaveTextContent('Lost vs rival25')
    expect(items[0]).toHaveTextContent('1620 → 1625 (+5)')
    expect(
      within(items[0]).getByRole('link', { name: /Review/ }),
    ).toHaveAttribute('href', `#match/${match(25)}`)
    expect(
      within(items[0]).getByRole('link', { name: 'rival25' }),
    ).toHaveAttribute('href', '#u/rival25')
    expect(items[19]).toHaveTextContent('rival6')
    expect(
      screen.getByRole('heading', { name: 'Last 20 rated matches' }),
    ).toBeInTheDocument()
  })

  it('lists matches in the order they were played, even one rated days late', async () => {
    const tables = aliceTables({ matches: 3 })
    // Match 1 was played first but its rating applied after match 3's.
    tables.rating_history[0].created_at = day(10)
    const { client } = fakeSupabase({ tables })
    render(<Profile client={client} username="alice" />)
    const items = within(await screen.findByRole('list')).getAllByRole(
      'listitem',
    )
    expect(
      items.map(
        (i) => within(i).getByRole('link', { name: /rival/ }).textContent,
      ),
    ).toEqual(['rival3', 'rival2', 'rival1'])
    // Each shows the day it was played.
    expect(items[2]).toHaveTextContent('1 Sept 2026')
  })

  it('a provisional player shows how many matches are left', async () => {
    const tables = aliceTables({ matches: 13, rd: 140 })
    const { client } = fakeSupabase({ tables })
    render(<Profile client={client} username="alice" />)
    expect(
      await screen.findByText('Provisional · 7 rated matches to go'),
    ).toBeInTheDocument()
  })

  it('an unknown name says so; a failed read offers a retry', async () => {
    const { client } = fakeSupabase({ tables: aliceTables() })
    const view = render(<Profile client={client} username="nobody" />)
    expect(
      await screen.findByText('No player is called nobody.'),
    ).toBeInTheDocument()
    view.unmount()
    const down = fakeSupabase({ tables: aliceTables(), fail: ['ratings'] })
    render(<Profile client={down.client} username="alice" />)
    expect(
      await screen.findByText('The profile could not be loaded.'),
    ).toBeInTheDocument()
  })

  it('reads only public tables, and never hole cards or grades', async () => {
    const { client, reads } = fakeSupabase({ tables: aliceTables() })
    render(<Profile client={client} username="alice" />)
    await screen.findByText('1625 ± 64')
    const tables = new Set(reads.map((r) => r.table))
    for (const t of tables)
      expect([
        'players',
        'ratings',
        'rating_history',
        'match_players',
        'matches',
        'accuracy',
        'rpc:rated_luck',
      ]).toContain(t)
  })
})

describe('the picture and crest on a profile', () => {
  const VIEWER = '00000000-0000-4000-8000-0000000000bb'
  /** Alice with a picture and a verified Princeton email. */
  function pictured(extra: Record<string, unknown> = {}) {
    const tables = aliceTables({ matches: 1 })
    ;(tables.players as Record<string, unknown>[])[0] = {
      ...tables.players[0],
      avatar_version: 9,
      school_domain: 'princeton.edu',
      school_verified_at: day(-5),
      ...extra,
    }
    return tables
  }

  it('shows them, and lets another signed-in player report the picture', async () => {
    const reported: unknown[] = []
    const { client } = fakeSupabase({
      tables: pictured(),
      userId: VIEWER,
      rpc: { report_avatar: (args) => void reported.push(args) },
    })
    const { container } = render(
      <AvatarBase.Provider value="https://x.supabase.co">
        <Profile client={client} username="alice" />
      </AvatarBase.Provider>,
    )
    const report = await screen.findByRole('button', {
      name: 'Report picture',
    })
    expect(container.querySelector('.player-avatar img')).toHaveAttribute(
      'src',
      `https://x.supabase.co/storage/v1/object/public/avatars/${ALICE}.webp?v=9`,
    )
    expect(screen.getByRole('img', { name: 'Princeton' })).toBeInTheDocument()
    await userEvent.click(report)
    expect(reported).toEqual([{ p_player: ALICE }])
    expect(
      await screen.findByText('Thanks — a person will look at it.'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Report picture' })).toBeNull()
  })

  it('offers no report to the player themselves or to a signed-out viewer', async () => {
    for (const userId of [ALICE, null]) {
      const { client } = fakeSupabase({ tables: pictured(), userId })
      const { unmount, container } = render(
        <Profile client={client} username="alice" />,
      )
      await screen.findByRole('img', { name: 'Princeton' })
      // The session check has had its turn.
      await new Promise((r) => setTimeout(r, 0))
      expect(container.querySelector('.player-avatar')).not.toBeNull()
      expect(
        screen.queryByRole('button', { name: 'Report picture' }),
      ).toBeNull()
      unmount()
    }
  })

  it('shows no crest for an unverified school, and no picture section without either', async () => {
    const { client } = fakeSupabase({
      tables: pictured({ avatar_version: null, school_verified_at: null }),
      userId: VIEWER,
    })
    const { container } = render(<Profile client={client} username="alice" />)
    await screen.findByText('Sanctions')
    expect(container.querySelector('.live-profile-who')).toBeNull()
    expect(screen.queryByRole('img', { name: 'Princeton' })).toBeNull()
  })
})
