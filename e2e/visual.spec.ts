import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

// Opt-in screenshot comparisons (see playwright.config.ts). Seeded deals and
// `motion=off` make every state reproducible.
const URL = '/?seed=7&motion=off'
const onboarded = (page: Page) =>
  page.addInitScript(() =>
    localStorage.setItem(
      'quantpoker.progress.v2',
      JSON.stringify({ onboarded: true }),
    ),
  )
const settle = async (page: Page) => {
  await expect(page.locator('.lab-loading, .lab-skeleton')).toHaveCount(0, {
    timeout: 15_000,
  })
  await page.evaluate(() => document.fonts.ready)
}
const snap = async (page: Page, name: string) => {
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
  await expect(page).toHaveScreenshot(`${name}.png`, { fullPage: true })
}

for (const colorScheme of ['light', 'dark'] as const)
  test.describe(colorScheme, () => {
    test.use({ colorScheme })

    test('welcome', async ({ page }) => {
      await page.goto(`${URL}#table`)
      await expect(page.getByRole('dialog')).toBeVisible()
      await snap(page, `${colorScheme}-welcome`)
    })

    test('table, lab and review', async ({ page, isMobile }) => {
      await onboarded(page)
      await page.goto(`${URL}#table`)
      await expect(page.locator('.guess-bar')).toBeVisible()
      await snap(page, `${colorScheme}-guess`)
      if (isMobile) await page.locator('.sheet-handle').click()
      await page
        .getByRole('button', { name: 'Reveal without guessing' })
        .click()
      await settle(page)
      await snap(page, `${colorScheme}-revealed`)
      if (isMobile) await page.locator('.sheet-handle').click()
      await page.getByRole('button', { name: /Fold/ }).first().click()
      await page.getByRole('button', { name: 'Review hand' }).click()
      await settle(page)
      await snap(page, `${colorScheme}-review`)
      await page.goto(`${URL}#progress`)
      await snap(page, `${colorScheme}-progress`)
    })

    test('curriculum and quick lessons', async ({ page }) => {
      await onboarded(page)
      await page.goto(`${URL}#learn/path`)
      await expect(
        page.getByRole('heading', {
          name: 'Foundations for defensible decisions',
        }),
      ).toBeVisible()
      await snap(page, `${colorScheme}-curriculum`)
      await page.goto(`${URL}#learn/quick`)
      await expect(
        page.getByRole('heading', {
          name: 'A little knowledge. A better decision.',
        }),
      ).toBeVisible()
      await snap(page, `${colorScheme}-quick-lessons`)
    })
  })
