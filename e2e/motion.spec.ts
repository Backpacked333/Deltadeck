import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { devSignIn, fakeSixTable, SIX_TABLE } from './sixTable'

/** Records the gap before every requestAnimationFrame from now on. */
async function sampleFrames(page: Page) {
  await page.evaluate(() => {
    const frames: number[] = []
    Object.assign(window, { sampledFrames: frames })
    let last = performance.now()
    const tick = (now: number) => {
      frames.push(now - last)
      last = now
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

/**
 * Thresholds leave room for shared CI cores while still catching layout
 * thrash or a blocked main thread (which shows up as a run of long frames).
 */
async function expectNoLongFrames(page: Page) {
  const frames = await page.evaluate(
    () => (window as unknown as { sampledFrames: number[] }).sampledFrames,
  )
  const sorted = [...frames].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  // In the report, so a run on slower hardware shows how close it came.
  const long = frames.filter((f) => f > 150).length
  test.info().annotations.push({
    type: 'frames',
    description: `${frames.length} frames, median ${median.toFixed(1)} ms, ${long} over 150 ms, longest ${sorted.at(-1)?.toFixed(1)} ms`,
  })
  expect(frames.length).toBeGreaterThan(90)
  expect(median).toBeLessThanOrEqual(34)
  expect(frames.filter((f) => f > 150).length).toBeLessThanOrEqual(3)
}

// Samples requestAnimationFrame through the heaviest choreography, an all-in
// runout with card reveals, equity bars and chip flights.
test('the all-in runout animates without long frames', async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      'quantpoker.progress.v2',
      JSON.stringify({ onboarded: true }),
    ),
  )
  await page.goto('/?seed=3')
  await page.getByRole('button', { name: 'All-in' }).click()
  await sampleFrames(page)
  await page.getByRole('button', { name: /Raise to 1,940/ }).click()
  await expect(page.locator('.runout')).toBeVisible()
  await expect(page.locator('.runout')).toBeHidden({ timeout: 15_000 })
  await page.waitForTimeout(800)
  await expectNoLongFrames(page)
})

// The six-seat table's heaviest hand (P2-06b): three players all in on
// successive streets, each street's bets gathered from up to four seats,
// then three pots paid to three seats, the last side pot first. Sampled
// the same way, from just before the first all-in until the payout ends.
// The six table runs no card reveals of its own (the server deals a board
// with the act that closes the betting), so its load is the chips.
test('a 3-way all-in runout with two side pots has no long frames', async ({
  page,
}) => {
  await devSignIn(page, 'you_at_the_bottom')
  const table = await fakeSixTable(page, { runout: true })
  await page.goto(`/#play/${SIX_TABLE}`)
  const ring = page.getByRole('region', { name: 'Poker table' })
  await expect(page.getByText('bartholomew_99 to act')).toBeVisible()
  await sampleFrames(page)
  await table.runout()
  await expect(ring.getByRole('list', { name: 'Pots paid' })).toHaveText(
    /^Side pot 2: 2,200 .*maximilian_okafor.*Side pot 1: 1,680 .*bartholomew_99.*Main pot: 3,760 .*evangeline_marten$/,
  )
  // The last pot leaves 1.3 s after the result and lands 0.6 s later.
  await page.waitForTimeout(2500)
  await expectNoLongFrames(page)
})

// The chip flights' layer lies over the whole ring, above the plates, so
// it must let every click through: here to an empty seat's Sit here, with
// the mouse, which (unlike the keyboard) lands on whatever is on top.
test("Sit here takes a click through the chip flights' layer", async ({
  page,
}) => {
  await devSignIn(page, 'you_at_the_bottom')
  const table = await fakeSixTable(page)
  await page.goto(`/#play/${SIX_TABLE}`)
  // She folds, the others play the hand out and its chips fly; between
  // hands Stand up frees her seat at once, and it is offered back.
  await page.getByRole('button', { name: /^Fold/ }).click()
  await expect(page.getByText('Next hand in a few seconds.')).toBeVisible()
  await page.getByRole('button', { name: 'Stand up' }).click()
  await expect(page.getByText('Pick an empty seat to play.')).toBeVisible()
  await expect(page.locator('.six-ring .six-flights')).toHaveCount(1)
  await page.getByRole('button', { name: /^Sit here/ }).click()
  await expect.poll(() => table.received.at(-1)).toEqual({ t: 'sit', seat: 0 })
})
