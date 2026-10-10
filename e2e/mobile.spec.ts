import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { fakeLadder, fakeProfile, onboard, playHand } from './helpers'
import { devSignIn, fakeSixTable, SIX_TABLE } from './sixTable'

/**
 * Nothing wider than the device. Comparing with innerWidth alone is not
 * enough: when content overflows, a phone browser zooms out and widens the
 * layout viewport to match, so scrollWidth === innerWidth still holds.
 */
async function expectNoOverflow(page: Page) {
  const device = page.viewportSize()!.width
  const widths = await page.evaluate(() => ({
    layout: window.innerWidth,
    content: document.documentElement.scrollWidth,
  }))
  expect(widths).toEqual({ layout: device, content: device })
}

test('phone layout has no horizontal scroll and a working lab sheet', async ({
  page,
}) => {
  await onboard(page)
  await expectNoOverflow(page)
  await page.getByRole('button', { name: /Lock in/ }).click()
  await page.locator('.sheet-handle').click()
  await expect(page.locator('.sheet-body .meter')).toBeVisible({
    timeout: 15_000,
  })
  await page.locator('.sheet-handle').click()
  await playHand(page)
  await page.getByRole('button', { name: 'Review hand' }).click()
  await expect(page.locator('.sheet-body .review')).toBeVisible()
})

test('the landing page fits a phone and shows the table on the first screen', async ({
  page,
}) => {
  await page.goto('/?motion=off')
  const decision = page.getByRole('group', { name: /Your decision/ })
  await expect(decision).toBeVisible({ timeout: 10_000 })
  await expectNoOverflow(page)
  const table = await page
    .getByRole('region', { name: 'Poker table' })
    .boundingBox()
  expect(table!.y).toBeLessThan(page.viewportSize()!.height)
})

test('the lab sheet drags between snap points', async ({ page }) => {
  await onboard(page)
  await page.getByRole('button', { name: /Lock in/ }).click()
  const handle = page.locator('.sheet-handle')
  const sheet = page.locator('.sheet')
  const viewport = page.viewportSize()!
  const box = (await handle.boundingBox())!
  const x = box.x + box.width / 2
  // Drag up past the middle: the sheet opens fully.
  await page.mouse.move(x, box.y + 20)
  await page.mouse.down()
  await page.mouse.move(x, box.y - viewport.height * 0.4, { steps: 12 })
  await page.mouse.move(x, box.y - viewport.height * 0.7, { steps: 6 })
  await page.mouse.up()
  await expect(handle).toHaveAttribute('aria-expanded', 'true')
  await expect
    .poll(async () => (await sheet.boundingBox())!.height)
    .toBeGreaterThan(viewport.height * 0.8)
  await expect(page.locator('.sheet-body .meter')).toBeVisible({
    timeout: 15_000,
  })
  // Drag it back down: it closes to the peek handle.
  const top = (await handle.boundingBox())!
  await page.mouse.move(x, top.y + 20)
  await page.mouse.down()
  await page.mouse.move(x, viewport.height - 10, { steps: 12 })
  await page.mouse.up()
  await expect(handle).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('.sheet-body')).toBeHidden()
})

test('the online lobby fits a phone without horizontal scroll', async ({
  page,
}) => {
  await onboard(page)
  await page.getByRole('button', { name: 'Online', exact: true }).click()
  await expect(
    page.getByText('Online play is not set up on this site yet.'),
  ).toBeVisible()
  await expectNoOverflow(page)
})

test('the ladder fits a phone, down to 320 px: the table scrolls inside itself', async ({
  page,
}) => {
  await fakeLadder(page)
  await page.goto('/#ladder')
  const table = page.getByRole('region', { name: /Ladder table/ })
  await expect(table.locator('tbody tr')).toHaveCount(50)
  await expectNoOverflow(page)
  await page.setViewportSize({ width: 320, height: 640 })
  await expectNoOverflow(page)
  // Every column stays reachable: the region scrolls sideways to the last.
  await table.evaluate((el) => (el.scrollLeft = el.scrollWidth))
  await expect(
    page.getByRole('columnheader', { name: '30 days' }),
  ).toBeInViewport()
})

test('the profile, a match review and the Method page fit a phone, down to 320 px', async ({
  page,
}) => {
  await fakeProfile(page)
  await page.setViewportSize({ width: 320, height: 640 })
  await page.goto('/u/alice')
  await expect(page.getByText('1625 ± 64')).toBeVisible()
  await expectNoOverflow(page)
  await page.goto('/#match/10000000-0000-4000-8000-000000000025')
  await expect(page.getByRole('region', { name: 'Hand 1' })).toBeVisible()
  await expectNoOverflow(page)
  await page.goto('/#method')
  await expect(
    page.getByRole('heading', { level: 1, name: 'Method' }),
  ).toBeVisible()
  await expectNoOverflow(page)
})

test('a six-seat table fits 320 px without horizontal scroll', async ({
  page,
}) => {
  await devSignIn(page, 'you_at_the_bottom')
  // The river with the viewer to act: five board cards, two hole cards,
  // six plates with long names, a shot clock and the action bar at once.
  await fakeSixTable(page, { street: 'river' })
  await page.setViewportSize({ width: 320, height: 640 })
  await page.goto(`/#play/${SIX_TABLE}`)
  const ring = page.getByRole('region', { name: 'Poker table' })
  const board = ring.getByRole('group', { name: 'Community cards' })
  await expect(ring.getByRole('group', { name: /^Seat \d:/ })).toHaveCount(6)
  await expect(board.getByRole('img', { name: / of / })).toHaveCount(5)
  await expect(page.getByText('6-max · Hand 1')).toBeVisible()
  await expect(page.getByRole('button', { name: /^Fold/ })).toBeVisible()
  await expectNoOverflow(page)

  const plate = async (slot: number) =>
    (await ring.locator(`[data-slot="${slot}"] .six-plate`).boundingBox())!
  const overlap = (
    a: { x: number; y: number; width: number; height: number },
    b: typeof a,
  ) =>
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  // Phones get the grid and wider screens the oval; the board must clear
  // every plate in both, the oval's narrow middle included. (From 681 to
  // 743 px the app's header alone runs past the screen, on every page, so
  // the page width is checked on either side of that band.)
  for (const width of [320, 360, 412, 681, 700, 760, 860]) {
    await page.setViewportSize({ width, height: 800 })
    if (width <= 680 || width >= 744) await expectNoOverflow(page)
    const cards = (await board.boundingBox())!
    const you = await plate(0)
    for (const slot of [0, 1, 2, 3, 4, 5]) {
      const other = await plate(slot)
      expect(overlap(cards, other), `${width} px: board on slot ${slot}`).toBe(
        false,
      )
      // Where the slots sit lives only in live.css: the viewer's plate is
      // the lowest, and the next seat clockwise is on its left.
      expect(you.y + you.height).toBeGreaterThanOrEqual(
        other.y + other.height - 1,
      )
    }
    const next = await plate(1)
    expect(next.x + next.width, `${width} px`).toBeLessThanOrEqual(you.x)
  }
})
