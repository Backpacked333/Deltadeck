import { expect, test } from '@playwright/test'

// The landing page's 3D stage (ADR-001) in a real browser with WebGL
// (software GPU in CI): it draws, a whole hand plays through the beats, the
// score card arrives, and the page has no errors. Frame rate is not checked
// here: a software GPU runs at a few frames a second; motion.spec.ts keeps
// the frame-time budget on the trainer table.
test.use({
  launchOptions: {
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
    ],
  },
})

test('the 3D table deals, plays every beat and reaches the score card', async ({
  page,
}) => {
  test.setTimeout(180_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto('/')
  await expect(page.locator('.landing.is-3d .stage-canvas')).toBeVisible()
  const decision = page.getByRole('group', { name: /Your decision/ })
  await expect(decision).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('.stage-plate').first()).toBeVisible()

  let rangeSeen = false
  const card = page.getByRole('region', { name: /Accuracy/ })
  for (let i = 0; i < 60 && !(await card.count()); i++) {
    const call = decision.getByRole('button', { name: /Call|Check/ })
    if (await call.count()) {
      await call.first().click()
      if (!rangeSeen) {
        // The first decision raises Atlas's range, with what it means.
        await expect(page.locator('.stage-caption')).toContainText(
          'Red beat you',
        )
        rangeSeen = true
      }
      // Any click skips a beat.
      await page.mouse.click(10, 300)
    }
    await page.waitForTimeout(500)
  }
  await expect(card).toBeVisible({ timeout: 60_000 })
  await expect(card).toContainText('/100')
  expect(rangeSeen).toBe(true)
  expect(errors).toEqual([])
})

test('a phone gets the same table, inside the screen', async ({ browser }) => {
  test.setTimeout(120_000)
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  })
  await page.goto('/')
  const box = page.locator('.stage-box')
  await expect(box).toBeVisible()
  await expect(page.getByRole('group', { name: /Your decision/ })).toBeVisible({
    timeout: 60_000,
  })
  const size = await box.boundingBox()
  expect(size!.width).toBe(390)
  expect(size!.height).toBeGreaterThan(300)
  const widths = await page.evaluate(() => [
    window.innerWidth,
    document.documentElement.scrollWidth,
  ])
  expect(widths).toEqual([390, 390])
  await page.close()
})
