import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { onboard, playHand } from './helpers'

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => {
    throw error
  })
})

test('guess first, act by keyboard, then review a graded hand', async ({
  page,
}) => {
  await onboard(page)
  await expect(page.getByText('Make your read first.')).toBeVisible()
  const slider = page.getByLabel('Your equity estimate in percent')
  await slider.fill('55')
  await page.keyboard.press('Enter')
  await expect(
    page.getByText('Your read', { exact: false }).first(),
  ).toBeVisible()
  await expect(page.locator('.meter')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.act-call .ring-label')).not.toHaveText('')
  await page.keyboard.press('c')
  await playHand(page)
  await expect(page.locator('.review')).toBeVisible()
  await expect(page.locator('.accuracy-badge')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.timeline-item').first()).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page.getByText('Guided hand 2 of 3')).toBeVisible()
})

test('records results that survive a reload', async ({ page }) => {
  await onboard(page)
  await page.getByRole('button', { name: /Fold/ }).first().click()
  await expect(page.locator('.accuracy-badge')).toBeVisible({ timeout: 15_000 })
  await page.reload()
  await expect(page.getByRole('button', { name: /new to poker/ })).toHaveCount(
    0,
  )
  await page.getByRole('button', { name: /Progress/ }).click()
  await expect(page.getByText(/1 hands recorded/)).toBeVisible()
  await expect(page.getByText('Luck versus skill')).toBeVisible()
})

test('analyst views, the 3D terrain and GL context cleanup', async ({
  page,
}) => {
  const warnings: string[] = []
  page.on('console', (m) => {
    if (/WebGL|context/i.test(m.text())) warnings.push(m.text())
  })
  await onboard(page, 'rules')
  await page.getByRole('button', { name: 'Reveal without guessing' }).click()
  for (const tab of ['Atlas range', 'Optionality', 'Protection', 'Decision'])
    await page.getByRole('tab', { name: tab }).click()
  await expect(page.locator('.heatmap canvas')).toBeVisible()
  for (let i = 0; i < 18; i++) {
    await page.getByRole('button', { name: '3D view' }).click()
    await expect(page.locator('.surface-viewport canvas')).toBeVisible()
    await page.keyboard.press('Escape')
  }
  expect(warnings.filter((w) => /Too many active/i.test(w))).toEqual([])
})

test('quick lessons are interactive and completable', async ({ page }) => {
  await onboard(page)
  await page.getByRole('button', { name: /Learn/ }).click()
  await page
    .getByRole('link', { name: /Quick lessons/ })
    .first()
    .click()
  await page.getByRole('button', { name: /Count outs/ }).click()
  await page.getByRole('button', { name: 'About 20%' }).click()
  await expect(page.getByText(/Exactly\./)).toBeVisible()
  await page.getByRole('button', { name: 'All lessons' }).click()
  await expect(page.getByText(/1 of 6 complete/)).toBeVisible()
})

test('the curriculum pauses the live hand and returns to it', async ({
  page,
}) => {
  await onboard(page)
  await page.getByRole('button', { name: 'Reveal without guessing' }).click()
  await page.getByRole('link', { name: /Pot odds → expected payoff/ }).click()
  const bridge = page.getByRole('region', { name: 'Your table connection' })
  await expect(bridge).toContainText('YOUR HAND IS PAUSED')
  await expect(bridge).toContainText('hand 1')
  await page.getByRole('link', { name: /Return to this hand/ }).click()
  await expect(page.getByRole('region', { name: 'Poker table' })).toBeVisible()
  await expect(page.getByText('Guided hand 1 of 3')).toBeVisible()
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused()
})

test('dark theme and reduced motion still render the table', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await onboard(page)
  const background = await page.evaluate(
    () => getComputedStyle(document.body).backgroundColor,
  )
  // The void: dark first.
  expect(background).toBe('rgb(11, 10, 16)')
  await expect(page.locator('.board .pcard')).toHaveCount(5)
})

for (const colorScheme of ['light', 'dark'] as const)
  test(`has no serious accessibility violations (${colorScheme})`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme })
    await onboard(page)
    await page.getByRole('button', { name: 'Reveal without guessing' }).click()
    await expect(page.locator('.meter')).toBeVisible({ timeout: 15_000 })
    const results = await new AxeBuilder({ page }).analyze()
    await page.getByRole('button', { name: 'Learn', exact: true }).click()
    await expect(
      page.getByRole('heading', {
        name: 'Foundations for defensible decisions',
      }),
    ).toBeVisible()
    // The curriculum's generated palette (palette.css) follows the theme; its
    // contrast is tracked separately, so here we gate the other rules and the
    // heading's legibility on the workspace.
    const curriculum = await new AxeBuilder({ page })
      .include('.curriculum-workspace')
      .disableRules(['color-contrast'])
      .analyze()
    const contrast = await page
      .getByRole('heading', { name: 'Foundations for defensible decisions' })
      .evaluate((el) => {
        const rgb = (c: string) =>
          c
            .match(/[\d.]+/g)!
            .slice(0, 3)
            .map(Number)
        const lum = (c: string) => {
          const [r, g, b] = rgb(c).map((v) => {
            const x = v / 255
            return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
          })
          return 0.2126 * r + 0.7152 * g + 0.0722 * b
        }
        // The first ancestor with a background of its own.
        let at: Element | null = el
        let bg = 'rgba(0, 0, 0, 0)'
        while (at && /rgba\(0, 0, 0, 0\)|transparent/.test(bg)) {
          bg = getComputedStyle(at).backgroundColor
          at = at.parentElement
        }
        if (/rgba\(0, 0, 0, 0\)|transparent/.test(bg))
          bg = getComputedStyle(document.body).backgroundColor
        const [a, b] = [lum(getComputedStyle(el).color), lum(bg)]
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
      })
    expect(contrast).toBeGreaterThanOrEqual(4.5)
    results.violations.push(...curriculum.violations)
    const serious = results.violations.filter((v) =>
      ['serious', 'critical'].includes(v.impact ?? ''),
    )
    expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([])
  })

test('the table and lab split drags, persists and resets', async ({ page }) => {
  await onboard(page)
  const handle = page.getByRole('separator', { name: /Resize the table/ })
  const table = page.locator('.play-column')
  const before = (await table.boundingBox())!.width
  const box = (await handle.boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + 120
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 220, y, { steps: 15 })
  await page.mouse.up()
  const after = (await table.boundingBox())!.width
  expect(after).toBeGreaterThan(before + 180)
  const value = Number(await handle.getAttribute('aria-valuenow'))
  expect(value).toBeGreaterThan(54)
  await handle.focus()
  await page.keyboard.press('ArrowLeft')
  await expect(handle).toHaveAttribute('aria-valuenow', String(value - 2))
  await page.reload()
  await expect(handle).toHaveAttribute('aria-valuenow', String(value - 2))
  await handle.dblclick()
  await expect(handle).toHaveAttribute('aria-valuenow', '54')
})

for (const colorScheme of ['light', 'dark'] as const)
  test(`online play opens from the nav and is accessible (${colorScheme})`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme })
    await onboard(page)
    await page.getByRole('button', { name: 'Online', exact: true }).click()
    await expect(page).toHaveURL(/#lobby$/)
    // CI builds have no account service, so the lobby says so plainly.
    await expect(
      page.getByText('Accounts are not set up on this site yet.'),
    ).toBeVisible()
    const results = await new AxeBuilder({ page }).analyze()
    const serious = results.violations.filter((v) =>
      ['serious', 'critical'].includes(v.impact ?? ''),
    )
    expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([])
    await page.getByRole('button', { name: 'Play', exact: true }).click()
    await expect(
      page.getByRole('region', { name: 'Poker table' }),
    ).toBeVisible()
  })

test('fair play and terms open from the lobby and are accessible', async ({
  page,
}) => {
  await onboard(page)
  await page.getByRole('button', { name: 'Online', exact: true }).click()
  for (const [link, heading] of [
    ['Fair play', 'Fair play'],
    ['Terms', 'Terms of play'],
  ]) {
    await page.goto('/#lobby')
    await page.getByRole('link', { name: link, exact: true }).click()
    await expect(
      page.getByRole('heading', { level: 1, name: heading }),
    ).toBeVisible()
    const results = await new AxeBuilder({ page }).analyze()
    const serious = results.violations.filter((v) =>
      ['serious', 'critical'].includes(v.impact ?? ''),
    )
    expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([])
  }
})
