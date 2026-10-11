import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { FLY_MS } from '../src/net/SixFlights'
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

type FlightSample = {
  opacity: number
  transform: string
  /** Where its animation was, in ms; null when it had none running. */
  time: number | null
  duration: number | null
  /** The CSS properties its keyframes animate. */
  properties: string[]
}

/**
 * Records every chip flight a six table launches from now on, where it
 * flies from and to, and samples the first one twice while it is in the
 * air (150 and 300 ms after it launched, of 600): what it looks like and
 * what its animation is. The page's own flights, not a stand-in.
 */
async function watchFlights(page: Page) {
  await page.evaluate(() => {
    const launched: string[] = []
    const sampled: FlightSample[] = []
    Object.assign(window, { launchedFlights: launched, sampledFlight: sampled })
    const timing = ['offset', 'computedOffset', 'easing', 'composite']
    const sample = (el: HTMLElement) => {
      const style = getComputedStyle(el)
      const [animation] = el.getAnimations()
      const effect = animation?.effect as KeyframeEffect | null | undefined
      sampled.push({
        opacity: Number(style.opacity),
        transform: style.transform,
        time: animation ? Number(animation.currentTime) : null,
        duration: effect ? Number(effect.getTiming().duration) : null,
        properties: effect
          ? [...new Set(effect.getKeyframes().flatMap(Object.keys))]
              .filter((key) => !timing.includes(key))
              .sort()
          : [],
      })
    }
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes) {
          if (!(node instanceof HTMLElement)) continue
          if (!node.classList.contains('six-flight')) continue
          launched.push(`${node.dataset.from} > ${node.dataset.to}`)
          if (launched.length > 1) continue
          setTimeout(() => sample(node), 150)
          setTimeout(() => sample(node), 300)
        }
    }).observe(document.body, { childList: true, subtree: true })
  })
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
// the same way, from just before the first all-in until the next hand's
// pot lands. The six table runs no card reveals of its own (the server
// deals a board with the act that closes the betting), so its load is
// the chips.
test('a 3-way all-in runout with two side pots has no long frames', async ({
  page,
}) => {
  await devSignIn(page, 'you_at_the_bottom')
  const table = await fakeSixTable(page, { runout: true })
  await page.goto(`/#play/${SIX_TABLE}`)
  const ring = page.getByRole('region', { name: 'Poker table' })
  await expect(page.getByText('bartholomew_99 to act')).toBeVisible()
  await watchFlights(page)
  await sampleFrames(page)
  await table.runout()
  await expect(ring.getByRole('list', { name: 'Pots paid' })).toHaveText(
    /^Side pot 2: 2,200 .*maximilian_okafor.*Side pot 1: 1,680 .*bartholomew_99.*Main pot: 3,760 .*evangeline_marten$/,
  )
  // The next hand, dealt 3 s after the result as the table deals it, by
  // when the last pot (it leaves 1.3 s after the result) has landed:
  // maximilian_okafor raises, the others fold to the viewer's big blind
  // and she folds. Its blinds go in and its pot goes to him, so chips
  // launch a fourth time in the window: a stall each time they launch
  // shows as more long frames than the gate allows.
  await table.nextHand()
  await page.getByRole('button', { name: /^Fold/ }).click()
  await expect(
    page.getByText('maximilian_okafor wins', { exact: true }),
  ).toBeVisible()
  // Sample until its pot has left (0.6 s after the result) and landed
  // (0.6 s later), when the page takes the chip off.
  const chips = page.locator('.six-ring .six-flight')
  await expect(chips.and(page.locator('[data-from="pot"]'))).toHaveCount(1)
  await expect(chips).toHaveCount(0)
  await expectNoLongFrames(page)

  // Each flight the page launched, in order, at its four launches.
  const { launched, sampled } = await page.evaluate(() => {
    const seen = window as unknown as {
      launchedFlights: string[]
      sampledFlight: FlightSample[]
    }
    return { launched: seen.launchedFlights, sampled: seen.sampledFlight }
  })
  expect(launched).toEqual([
    // The flop: the four pre-flop bets of 940.
    'seat-1 > pot',
    'seat-3 > pot',
    'seat-4 > pot',
    'seat-5 > pot',
    // The turn: the flop's three bets of 560.
    'seat-1 > pot',
    'seat-3 > pot',
    'seat-5 > pot',
    // The result: the turn's two bets, then each pot to its winner, the
    // last side pot first.
    'seat-1 > pot',
    'seat-5 > pot',
    'pot-2 > seat-1',
    'pot-1 > seat-3',
    'pot-0 > seat-4',
    // Hand 2's result: the viewer's blind and his called 20, then the pot.
    'seat-0 > pot',
    'seat-1 > pot',
    'pot > seat-1',
  ])
  // The first of them in the air: seen, moving, for as long as the
  // trainer's flights, and by transform and opacity alone, so nothing in
  // flight touches layout.
  expect(sampled).toHaveLength(2)
  for (const at of sampled) {
    expect(at.time).toBeGreaterThan(0)
    expect(at.time).toBeLessThan(FLY_MS)
    expect(at.opacity).toBeGreaterThan(0)
    expect(at.transform).toMatch(/^matrix/)
    expect(at.duration).toBe(FLY_MS)
    expect(at.properties).toEqual(['opacity', 'transform'])
  }
  expect(sampled[1].transform).not.toBe(sampled[0].transform)
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
  // A layer that took the click would make it retry until the test times
  // out; fail fast and say so instead.
  await page
    .getByRole('button', { name: /^Sit here/ })
    .click({ timeout: 5_000 })
  await expect.poll(() => table.received.at(-1)).toEqual({ t: 'sit', seat: 0 })
})
