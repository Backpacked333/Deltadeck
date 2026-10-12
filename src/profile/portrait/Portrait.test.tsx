import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PlayedHand } from './hands'
import type { EveryHand } from './load'

const loaded = vi.hoisted(() => ({
  every: null as EveryHand | null,
  fail: false,
}))
vi.mock('./load', () => ({
  loadEveryHand: async () => {
    if (loaded.fail) throw new Error('offline')
    return loaded.every
  },
}))
const { Portrait } = await import('./Portrait')

afterEach(() => {
  loaded.every = null
  loaded.fail = false
})

const base = {
  kind: 'six-casual' as const,
  players: 6,
  opponents: ['bob'],
  threeBetChance: false,
  threeBet: false,
  foldTo3betChance: false,
  foldTo3bet: false,
  facedCbet: false,
  foldedToCbet: false,
  showdown: false,
  wonShowdown: false,
}

/** 100 six-max hands: one in five raised and bet on the flop. */
const sixMax = (): PlayedHand[] =>
  Array.from({ length: 100 }, (_, i) =>
    i % 5 === 0
      ? {
          ...base,
          id: `h${i}`,
          at: i,
          format: 'six-max',
          position: i % 2 ? 'BTN' : 'CO',
          hole: 'AKs',
          holeGroup: 'premium',
          acts: [
            {
              street: 'preflop',
              action: 'raise',
              facing: 1,
              pot: 1.5,
              size: 3,
              ms: 2000,
            },
            {
              street: 'flop',
              action: 'raise',
              facing: 0,
              pot: 7,
              size: 4,
              ms: 3000,
            },
          ],
          vpip: true,
          pfr: true,
          sawFlop: true,
          cbetChance: true,
          cbet: true,
          net: 3,
        }
      : {
          ...base,
          id: `h${i}`,
          at: i,
          format: 'six-max',
          position: i % 2 ? 'BTN' : 'CO',
          hole: '72o',
          holeGroup: 'weak',
          acts: [
            {
              street: 'preflop',
              action: 'fold',
              facing: 1,
              pot: 1.5,
              size: 0,
              ms: 1000,
            },
          ],
          vpip: false,
          pfr: false,
          sawFlop: false,
          cbetChance: false,
          cbet: false,
          net: 0,
        },
  )

describe('the player portrait', () => {
  it('names the style, draws the big picture and shows the numbers by context', async () => {
    loaded.every = { hands: sixMax(), missing: [] }
    render(<Portrait client={null} userId={null} local={[]} />)
    const region = screen.getByRole('region', { name: 'Your player portrait' })
    expect(await within(region).findByText('The Shark')).toBeVisible()
    expect(region).toHaveTextContent('Early read · 100 hands')
    expect(
      within(region).getByRole('img', { name: /Style map: looseness/ }),
    ).toBeVisible()
    expect(
      within(region).getByRole('heading', { name: 'The big picture' }),
    ).toBeVisible()
    expect(region).toHaveTextContent(
      'You put money in 20% of hands at six-max tables',
    )
    expect(within(region).getByText('Looseness')).toBeVisible()
    expect(
      within(region).getByRole('table', {
        name: 'Your stats in each position',
      }),
    ).toHaveTextContent('CO')
    expect(
      within(region).getByRole('table', {
        name: 'Your stats with each group of starting hands',
      }),
    ).toHaveTextContent('Weak (everything else)')
    expect(
      within(region).getByRole('heading', { name: 'How your game has moved' }),
    ).toBeVisible()
  })

  it('names a part it could not read', async () => {
    loaded.every = { hands: sixMax(), missing: ['online'] }
    render(<Portrait client={null} userId={null} local={[]} />)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Drawn without your online hands',
    )
  })

  it('offers to try again when nothing could be read', async () => {
    loaded.fail = true
    render(<Portrait client={null} userId={null} local={[]} />)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your hands could not be read.',
    )
    loaded.fail = false
    loaded.every = { hands: [], missing: [] }
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(
      await screen.findByText('Your portrait starts with your first hand.'),
    ).toBeVisible()
  })
})
