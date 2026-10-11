// The school banners say "badges for students at these schools": every one
// must really get a badge, have its logo shipped, be read once by a screen
// reader (the loop's copy is hidden), and sit above the not-endorsed line.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SchoolBanners } from './SchoolBanners'
import { SCHOOLS } from './schools'

/** The repository, where Vitest runs. */
const at = (path: string) => join(process.cwd(), path)

describe('school banners', () => {
  it('names twenty schools, each read once', () => {
    render(<SchoolBanners signedIn={false} onJoin={() => {}} />)
    const section = screen.getByRole('region', {
      name: 'Represent your school',
    })
    const items = within(section).getAllByRole('listitem')
    expect(items.map((li) => li.textContent)).toEqual(
      SCHOOLS.map((s) => s.name),
    )
    // The loop's second copy is there for the eye only.
    expect(section.querySelectorAll('.school-banner')).toHaveLength(40)
    expect(section.querySelectorAll('ul[aria-hidden="true"]')).toHaveLength(2)
  })

  it('ships a logo for every school, decorative beside its name', () => {
    render(<SchoolBanners signedIn={false} onJoin={() => {}} />)
    const logos =
      document.querySelectorAll<HTMLImageElement>('.school-plate img')
    for (const img of logos) {
      expect(img.alt).toBe('')
      expect(img.getAttribute('loading')).toBe('lazy')
    }
    for (const school of SCHOOLS)
      expect(
        existsSync(at(`public/schools/${school.id}.webp`)),
        school.id,
      ).toBe(true)
  })

  it('shows only schools that really get a badge', () => {
    const seeded = readFileSync(
      at('supabase/migrations/20261010110000_landing.sql'),
      'utf8',
    )
    for (const school of SCHOOLS)
      expect(seeded, school.name).toContain(`'${school.name}', 'US'`)
  })

  it('says the schools do not endorse DeltaDeck', () => {
    render(<SchoolBanners signedIn={false} onJoin={() => {}} />)
    expect(
      screen.getByText(/not affiliated with, sponsored or endorsed by/),
    ).toBeInTheDocument()
  })

  it('offers sign-up to visitors, and nothing to members', async () => {
    const join = vi.fn()
    const { rerender } = render(
      <SchoolBanners signedIn={false} onJoin={join} />,
    )
    await userEvent.click(
      screen.getByRole('button', { name: /Claim your school's badge/ }),
    )
    expect(join).toHaveBeenCalledTimes(1)
    rerender(<SchoolBanners signedIn onJoin={join} />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})
