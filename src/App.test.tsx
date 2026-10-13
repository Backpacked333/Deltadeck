import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import App from './App'
import { LEGACY_KEY, STORAGE_KEY as TABLE_KEY } from './lib/storage'
import { STORAGE_KEY as LEARNING_V1_KEY } from './curriculum/lib/progress'
import { LEARNING_KEY } from './curriculum/core/persistence'
import * as atlas from './lib/atlas'
import { analyzeSpot, quickOutcome } from './lib/range'
import type { SpotRequest } from './lib/range'
import { lcg } from './lib/sim'
import { seedSession, TEST_SESSION_KEY } from './test/session'

// Online play is configured per deployment; tests never reach the network.
vi.mock('./net/supabase', () => ({ loadOnline: async () => null }))

vi.mock('./components/lab/Surface3D', () => ({
  default: () => <div data-testid="surface">Interactive terrain</div>,
}))

/** A synchronous stand-in for the analysis worker that runs the real model. */
class AnalysisWorker {
  onmessage?: (event: unknown) => void
  postMessage(request: SpotRequest) {
    this.onmessage?.({
      data: {
        key: request.key,
        stage: 'quick',
        quick: quickOutcome(request.hole, request.board, lcg(1), 200),
      },
    })
    this.onmessage?.({ data: analyzeSpot(request, lcg(2)) })
  }
  terminate() {}
}
/** A worker that never answers, to model a reload before grading finishes. */
class SilentWorker {
  onmessage?: (event: unknown) => void
  postMessage() {}
  terminate() {}
}

const onboarded = () =>
  localStorage.setItem(TABLE_KEY, JSON.stringify({ onboarded: true }))

// The lab and the curriculum are lazy-loaded; load them once so no test is
// racing a chunk's first transform on a busy machine (the curriculum took
// over findBy's 1 s in 2 of 6 parallel runs).
beforeAll(() =>
  Promise.all([
    import('./components/lab/Lab'),
    import('./curriculum/Curriculum'),
  ]),
)
beforeEach(() => {
  vi.stubGlobal('Worker', AnalysisWorker)
  // Practice, lessons and progress are for signed-in players.
  seedSession()
  onboarded()
  // The bare URL is the landing page; these tests start at the trainer.
  window.history.replaceState(null, '', '/#table')
})
afterEach(() => vi.useRealTimers())

function navigate(hash: string) {
  act(() => {
    window.history.pushState(null, '', hash)
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  })
}

describe('table and curriculum integration', () => {
  it('opens a related lesson with only visible cards and returns to the same hand', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(
      await screen.findByRole('button', { name: 'Reveal without guessing' }),
    )
    const table = screen.getByRole('region', { name: 'Poker table' })
    const hand = table.textContent
    await user.click(
      screen.getByRole('link', { name: /Pot odds → expected payoff/ }),
    )
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(
      'The price of a decision',
    )
    expect(
      screen.queryByRole('region', { name: 'Poker table' }),
    ).not.toBeInTheDocument()
    const bridge = screen.getByRole('region', { name: 'Your table connection' })
    expect(bridge).toHaveTextContent('YOUR HAND IS PAUSED')
    expect(bridge).toHaveTextContent(/Estimated equity\s*\d+\.\d%/)
    expect(bridge).toHaveTextContent('Break-even equity')
    expect(bridge).not.toHaveTextContent('9♥')
    await user.click(screen.getByRole('link', { name: /Return to this hand/ }))
    expect(
      (await screen.findByRole('region', { name: 'Poker table' })).textContent,
    ).toBe(hand)
    expect(screen.getByRole('heading', { level: 1 })).toHaveFocus()
  })

  it('suspends the pending bot turn during study and resumes it on return', async () => {
    const bot = vi.spyOn(atlas, 'atlasDecision').mockReturnValue({
      action: { type: 'fold' },
      equity: 0.2,
      odds: 0.3,
      kind: 'fold',
      explanation: 'Folded.',
    })
    render(<App />)
    navigate('#learn/path')
    await screen.findByRole('heading', {
      name: 'Foundations for defensible decisions',
    })
    navigate('#table')
    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: /Raise to/ }))
    expect(screen.getByLabelText('Atlas is thinking')).toBeInTheDocument()
    navigate('#learn/module/fold/learn')
    await act(async () => {})
    expect(
      screen.getByRole('region', { name: 'Your table connection' }),
    ).toHaveTextContent('Atlas is paused too')
    act(() => vi.advanceTimersByTime(5000))
    expect(bot).not.toHaveBeenCalled()
    navigate('#table')
    expect(screen.getByLabelText('Atlas is thinking')).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(2500))
    expect(bot).toHaveBeenCalledTimes(1)
    expect(screen.queryByLabelText('Atlas is thinking')).not.toBeInTheDocument()
  })

  it('preserves manually paused state and notebook contents across round trips', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: /Pause table/ }))
    navigate('#learn/notebook')
    const notes = await screen.findByRole('textbox', {
      name: 'Notes for The price of a decision',
    })
    await user.type(notes, 'Price the decision, not the outcome.')
    navigate('#table')
    expect(screen.getAllByText('Table paused').length).toBeGreaterThan(0)
    navigate('#learn/notebook')
    expect(
      await screen.findByRole('textbox', {
        name: 'Notes for The price of a decision',
      }),
    ).toHaveValue('Price the decision, not the outcome.')
  })

  it('keeps table lessons and history separate when curriculum data is reset', async () => {
    const user = userEvent.setup()
    const legacy = {
      hands: [{ id: 'prior:1', hand: 1, net: 25, result: 'Won', guided: true }],
      lessons: ['equity'],
    }
    localStorage.removeItem(TABLE_KEY)
    localStorage.setItem(LEGACY_KEY, JSON.stringify(legacy))
    localStorage.setItem(
      LEARNING_V1_KEY,
      JSON.stringify({
        version: 1,
        completed: ['odds'],
        notes: { odds: 'Original' },
      }),
    )
    navigate('#learn/notebook')
    render(<App />)
    await user.click(
      await screen.findByRole('button', { name: 'Reset local learning data' }),
    )
    await user.click(
      screen.getByRole('button', { name: 'Delete my local learning data' }),
    )
    const table = JSON.parse(localStorage.getItem(TABLE_KEY)!)
    expect(table.hands).toEqual(legacy.hands)
    expect(table.lessons).toEqual(legacy.lessons)
    expect(
      JSON.parse(localStorage.getItem(LEARNING_KEY)!).legacy.completed,
    ).toEqual([])
    navigate('#table')
    await user.click(
      await screen.findByRole('button', { name: 'Reveal without guessing' }),
    )
    await user.click(
      screen.getByRole('button', { name: /Learn the idea behind this view/ }),
    )
    expect(
      await screen.findByRole('heading', { name: 'Think in expected value' }),
    ).toBeInTheDocument()
  })

  it('retains in-memory learning notes across table navigation when storage is blocked', async () => {
    const user = userEvent.setup()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Blocked')
    })
    navigate('#learn/notebook')
    render(<App />)
    const notes = await screen.findByRole('textbox', {
      name: 'Notes for The price of a decision',
    })
    await user.type(notes, 'Keep this in memory')
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Browser storage is unavailable',
    )
    navigate('#table')
    navigate('#learn/notebook')
    expect(
      await screen.findByRole('textbox', {
        name: 'Notes for The price of a decision',
      }),
    ).toHaveValue('Keep this in memory')
  })

  it('provides working module links from every lab view', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(
      await screen.findByRole('button', { name: 'Reveal without guessing' }),
    )
    await user.click(screen.getByRole('button', { name: 'Analyst' }))
    const expected = [
      ['Decision', ['odds', 'outs', 'equity']],
      ['Atlas range', ['fold', 'equity', 'outs']],
      ['Optionality', ['fold', 'pricing', 'replication']],
      ['Protection', ['variance', 'replication', 'risk']],
    ] as const
    for (const [lens, ids] of expected) {
      await user.click(screen.getByRole('tab', { name: lens }))
      const links = within(
        screen.getByLabelText('Related curriculum modules'),
      ).getAllByRole('link')
      expect(links.map((link) => link.getAttribute('href'))).toEqual(
        ids.map((id) => `#learn/module/${id}/learn`),
      )
      if (lens === 'Protection') {
        expect(
          screen.getByText('Illustrative all-in cashout'),
        ).toBeInTheDocument()
        expect(screen.getByText('Run-twice dispersion')).toBeInTheDocument()
        expect(screen.getByText('Full Kelly ceiling')).toBeInTheDocument()
        expect(
          screen.getByText(/resembles insurance—not a CDS price/),
        ).toBeInTheDocument()
      }
    }
  })

  it('handles a curriculum deep link, hash navigation, and completed-hand return without resetting the game', async () => {
    const user = userEvent.setup()
    navigate('#learn/module/replication/lab')
    render(<App />)
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(
      'Build the same payoff twice',
    )
    await user.click(screen.getByRole('button', { name: 'Play' }))
    await user.click(
      await screen.findByRole('button', { name: /Fold.*Step away/ }),
    )
    expect(
      screen.getByRole('button', { name: /Deal next hand/ }),
    ).toBeInTheDocument()
    navigate('#learn/map')
    expect(
      await screen.findByRole('region', { name: 'Your table connection' }),
    ).toHaveTextContent('YOUR COMPLETED HAND')
    navigate('#table')
    expect(
      screen.getByRole('button', { name: /Deal next hand/ }),
    ).toBeInTheDocument()
    const hands = JSON.parse(localStorage.getItem(TABLE_KEY)!).hands
    expect(hands).toHaveLength(1)
    expect(hands[0].graded).toBe(true)
    expect(hands[0].decisions).toHaveLength(1)
  })

  it('opens the six quick lessons from the curriculum sidebar', async () => {
    const user = userEvent.setup()
    navigate('#learn/path')
    render(<App />)
    await user.click(
      (await screen.findAllByRole('link', { name: /Quick lessons/ }))[0],
    )
    expect(
      await screen.findByRole('heading', {
        name: 'A little knowledge. A better decision.',
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: /Full curriculum/ }),
    ).toHaveAttribute('href', '#learn/path')
  })
})

describe('online play', () => {
  it('opens from the nav, keeps the hand, and comes back to it', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(
      await screen.findByRole('button', { name: 'Reveal without guessing' }),
    )
    const hand = screen.getByRole('region', { name: 'Poker table' }).textContent
    await user.click(screen.getByRole('button', { name: 'Online' }))
    expect(window.location.hash).toBe('#lobby')
    expect(
      await screen.findByText('Accounts are not set up on this site yet.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Online' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    await user.click(screen.getByRole('button', { name: 'Play' }))
    expect(
      (await screen.findByRole('region', { name: 'Poker table' })).textContent,
    ).toBe(hand)
  })
})

describe('recording finished hands', () => {
  it('saves the hand as soon as it ends, before any analysis returns', async () => {
    vi.stubGlobal('Worker', SilentWorker)
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: /Fold.*Step away/ }))
    const hands = JSON.parse(localStorage.getItem(TABLE_KEY)!).hands
    expect(hands).toHaveLength(1)
    expect(hands[0]).toMatchObject({ net: -60, graded: false })
    expect(hands[0].decisions).toBeUndefined()
  })
})

/** The app's own header (pages have their own <header> elements too). */
const appHeader = () => document.querySelector<HTMLElement>('header.header')!

describe('the header', () => {
  it('offers Sign in and Create free account on every page when signed out', async () => {
    localStorage.removeItem(TEST_SESSION_KEY)
    localStorage.removeItem('qp.username')
    render(<App />)
    for (const hash of ['#ladder', '#fair-play', '#method', '#start']) {
      navigate(hash)
      const header = appHeader()
      expect(
        within(header).getByRole('link', { name: 'Sign in' }),
      ).toHaveAttribute('href', '#signin')
      expect(
        within(header).getByRole('link', { name: /Create free account/ }),
      ).toHaveAttribute('href', '#signup')
    }
    expect(screen.queryByRole('button', { name: /^Account/ })).toBeNull()
  })

  it('shows the signed-in player a menu with their profile, online play and sign out', async () => {
    seedSession({ username: 'alice' })
    const user = userEvent.setup()
    render(<App />)
    const header = appHeader()
    expect(within(header).queryByRole('link', { name: 'Sign in' })).toBeNull()
    const account = within(header).getByRole('button', {
      name: 'Account: alice',
    })
    expect(account).toHaveTextContent('A')
    expect(account).toHaveAttribute('aria-expanded', 'false')
    await user.click(account)
    expect(account).toHaveAttribute('aria-expanded', 'true')
    expect(within(header).getByText('alice')).toBeVisible()
    expect(
      within(header).getByRole('link', { name: 'Your profile' }),
    ).toHaveAttribute('href', '#me')
    expect(
      within(header).getByRole('link', { name: 'Play online' }),
    ).toHaveAttribute('href', '#lobby')
    expect(
      within(header).getByRole('link', { name: 'Sign out' }),
    ).toHaveAttribute('href', '#signout')
    await user.keyboard('{Escape}')
    expect(account).toHaveAttribute('aria-expanded', 'false')
    expect(account).toHaveFocus()
  })

  it('offers no profile before a new account has chosen its name', async () => {
    seedSession({ username: 'player_0123456789ab' })
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: /^Account/ }))
    expect(screen.queryByRole('link', { name: 'Your profile' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Sign out' })).toBeVisible()
  })
})

describe('the account gate', () => {
  const signedOut = () => {
    localStorage.removeItem(TEST_SESSION_KEY)
    localStorage.removeItem('qp.username')
  }

  it('sends a signed-out visitor from practice, lessons or progress to sign up, and remembers the way back', async () => {
    signedOut()
    for (const hash of [
      '#table',
      '#progress',
      '#me',
      '#learn/path',
      '#learn/quick',
    ]) {
      window.history.replaceState(null, '', `/?seed=3${hash}`)
      const length = window.history.length
      const { unmount } = render(<App />)
      expect(
        await screen.findByRole('heading', {
          level: 1,
          name: 'Join DeltaDeck',
        }),
      ).toBeVisible()
      expect(window.location.hash).toBe('#signup')
      expect(window.location.search).toBe('?seed=3')
      // Replaced, not pushed: Back leaves for the page before.
      expect(window.history.length).toBe(length)
      expect(sessionStorage.getItem('qp.afterAuth')).toBe(hash)
      expect(screen.queryByRole('region', { name: 'Poker table' })).toBeNull()
      unmount()
    }
  })

  it('offers sign-in instead on a browser that has had an account', async () => {
    signedOut()
    localStorage.setItem('qp.hadAccount', '1')
    render(<App />)
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Welcome back' }),
    ).toBeVisible()
    expect(window.location.hash).toBe('#signin')
  })

  it('keeps the public pages open', async () => {
    signedOut()
    for (const hash of [
      '#start',
      '#ladder',
      '#fair-play',
      '#terms',
      '#privacy',
      '#method',
    ]) {
      window.history.replaceState(null, '', `/${hash}`)
      const { unmount } = render(<App />)
      await act(async () => {})
      expect(window.location.hash, hash).toBe(hash)
      unmount()
    }
  })

  it('opens the privacy page at #privacy', async () => {
    signedOut()
    window.history.replaceState(null, '', '/#privacy')
    render(<App />)
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Privacy' }),
    ).toBeVisible()
  })

  it('does not take a malformed stored session for an account', async () => {
    signedOut()
    localStorage.setItem('sb-abc-auth-token', '{}')
    render(<App />)
    await screen.findByRole('heading', { level: 1, name: 'Join DeltaDeck' })
    expect(window.location.hash).toBe('#signup')
  })

  it('asks a new account to choose its name before it plays', async () => {
    seedSession({ username: 'player_0123456789ab' })
    render(<App />)
    await act(async () => {})
    expect(window.location.hash).toBe('#welcome/onboard')
    expect(sessionStorage.getItem('qp.afterAuth')).toBe('#table')
  })

  it('lets a signed-in player play', async () => {
    render(<App />)
    expect(
      await screen.findByRole('region', { name: 'Poker table' }),
    ).toBeVisible()
    expect(window.location.hash).toBe('#table')
  })
})

describe('keyboard shortcuts (audit F17)', () => {
  it('a held key or a key that composes text is not a decision', async () => {
    render(<App />)
    await screen.findByRole('button', { name: 'Reveal without guessing' })
    // Auto-repeat from a key held down, and keys an input method is
    // composing into text, lock nothing and make no move.
    for (const init of [{ repeat: true }, { isComposing: true }])
      for (const key of ['Enter', 'c', 'f', 'r', '1'])
        fireEvent.keyDown(document.body, { key, ...init })
    expect(
      screen.getByRole('button', { name: 'Reveal without guessing' }),
    ).toBeInTheDocument()
    fireEvent.keyDown(document.body, { key: 'Enter' })
    expect(
      screen.queryByRole('button', { name: 'Reveal without guessing' }),
    ).not.toBeInTheDocument()
  })
})
