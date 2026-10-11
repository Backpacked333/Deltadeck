import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import InfoPage from './InfoPages'

describe('Fair play', () => {
  it('says what is guaranteed today, including what the deck check does not prove', () => {
    render(<InfoPage page="fair-play" />)
    expect(
      screen.getByRole('heading', { level: 1, name: 'Fair play' }),
    ).toBeInTheDocument()
    const today = screen.getByRole('region', {
      name: 'What we guarantee today',
    })
    for (const claim of [
      /server owns the cards/i,
      /lab is never on at the live table/i,
      /committed before the first card/i,
      /board, the shown hands and your own two cards/i,
      /biased shuffle/i,
      /abandon/i,
    ])
      expect(today).toHaveTextContent(claim)
  })

  it('lists collusion and real-time assistance under "not detected"', () => {
    render(<InfoPage page="fair-play" />)
    const notYet = screen.getByRole('region', { name: 'Not detected yet' })
    expect(notYet).toHaveTextContent(/collusion/i)
    expect(notYet).toHaveTextContent(/real-time assistance/i)
    expect(notYet).toHaveTextContent(/more than one account/i)
  })

  it('says how to report', () => {
    render(<InfoPage page="fair-play" />)
    expect(
      screen.getByRole('region', { name: 'How to report' }),
    ).toHaveTextContent(/match link/i)
  })
})

describe('Terms', () => {
  it('state play money, no prizes, 18+, public hand histories and recorded decision times', () => {
    render(<InfoPage page="terms" />)
    expect(
      screen.getByRole('heading', { level: 1, name: 'Terms of play' }),
    ).toBeInTheDocument()
    const page = screen.getByRole('article')
    for (const term of [
      /play money only/i,
      /no prizes/i,
      /no deposits/i,
      /18 or older/i,
      /public and permanent/i,
      /decision times/i,
      /your folded cards are never published/i,
    ])
      expect(page).toHaveTextContent(term)
  })
})

describe('Privacy', () => {
  it('says what is kept, where, who sees it, and how to have it deleted', () => {
    render(<InfoPage page="privacy" />)
    expect(
      screen.getByRole('heading', { level: 1, name: 'Privacy' }),
    ).toBeInTheDocument()
    const kept = screen.getByRole('region', { name: 'What we keep' })
    for (const item of [/email address/i, /username/i, /practice/i, /school/i])
      expect(kept).toHaveTextContent(item)
    const where = screen.getByRole('region', { name: 'Where it is kept' })
    for (const service of [/Supabase/, /Cloudflare/, /Resend/, /Google/])
      expect(where).toHaveTextContent(service)
    expect(
      screen.getByRole('region', { name: 'Who can see it' }),
    ).toHaveTextContent(/only you can see your email address/i)
    const deletion = screen.getByRole('region', {
      name: 'Deleting your account',
    })
    expect(
      within(deletion).getByRole('link', { name: 'support@deltadeck.net' }),
    ).toHaveAttribute('href', 'mailto:support@deltadeck.net')
  })
})

describe('reporting', () => {
  it('gives the support address on Fair play', () => {
    render(<InfoPage page="fair-play" />)
    expect(
      within(screen.getByRole('region', { name: 'How to report' })).getByRole(
        'link',
        { name: 'support@deltadeck.net' },
      ),
    ).toHaveAttribute('href', 'mailto:support@deltadeck.net')
  })
})
