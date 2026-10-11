import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { fakeLadder, fakeProfile, onboard, playHand } from './helpers'
import { devSignIn, fakeLobby, fakeSixTable, SIX_TABLE } from './sixTable'

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

test('the six-table list fits 320 px, with long figures and while finding a seat', async ({
  page,
}) => {
  await devSignIn(page, 'you_at_the_bottom')
  // Twelve tables, some full, with the widest figures the list can show:
  // 61,728 bb pots and 100+ players. Quick sit's answer is held.
  const tables = Array.from({ length: 12 }, (_, i) => ({
    tableId: `0b7c4a52-6f0e-4d7b-9b55-3c1f2a9e8d${String(i).padStart(2, '0')}`,
    seated: i % 3 === 0 ? 6 : 5,
    maxSeats: 6,
    avgPot: i % 4 === 0 ? null : 1_234_560,
    playersPerHour: 100,
  }))
  await fakeLobby(page, { tables, answer: () => null })
  await page.setViewportSize({ width: 320, height: 640 })
  await page.goto('/#lobby')
  const list = page.getByRole('table', { name: 'Six-max tables' })
  await expect(list.getByRole('row')).toHaveCount(1 + 10)
  await expect(list.getByText('61,728 bb').first()).toBeVisible()
  await expect(list.getByText('100+').first()).toBeVisible()
  await expect(page.getByText('And 2 more.')).toBeVisible()
  await expectNoOverflow(page)
  await page.getByRole('button', { name: 'Quick sit' }).click()
  await expect(page.getByText('Finding you a seat…')).toBeVisible()
  await expectNoOverflow(page)
})

test('a six-seat table fits 320 px without horizontal scroll', async ({
  page,
}) => {
  await devSignIn(page, 'you_at_the_bottom')
  // The river with the viewer to act: five board cards, two hole cards,
  // six plates with long names, a shot clock and the action bar at once,
  // and two players who dropped, their plates a line taller.
  await fakeSixTable(page, { street: 'river', away: [2, 4] })
  await page.setViewportSize({ width: 320, height: 640 })
  await page.goto(`/#play/${SIX_TABLE}`)
  const ring = page.getByRole('region', { name: 'Poker table' })
  const board = ring.getByRole('group', { name: 'Community cards' })
  await expect(ring.getByRole('group', { name: /^Seat \d:/ })).toHaveCount(6)
  await expect(board.getByRole('img', { name: / of / })).toHaveCount(5)
  await expect(page.getByText('6-max · Hand 1')).toBeVisible()
  await expect(page.getByRole('button', { name: /^Fold/ })).toBeVisible()
  for (const name of ['seraphina_lindqvist', 'evangeline_marten'])
    await expect(
      ring
        .getByRole('group', { name: new RegExp(`^Seat \\d: ${name}`) })
        .getByText('Disconnected'),
    ).toBeVisible()
  await expectNoOverflow(page)
  await expectRingFits(page, { board })
})

test('a six-seat table with two side pots fits 320 px, in the hand and at its result', async ({
  page,
}) => {
  await devSignIn(page, 'you_at_the_bottom')
  // The river with the viewer to act and two players all in: the middle
  // holds the total, three pots, five board cards and two hole cards.
  await fakeSixTable(page, { sidePots: true })
  await page.setViewportSize({ width: 320, height: 640 })
  await page.goto(`/#play/${SIX_TABLE}`)
  const ring = page.getByRole('region', { name: 'Poker table' })
  const board = ring.getByRole('group', { name: 'Community cards' })
  await expect(board.getByRole('img', { name: / of / })).toHaveCount(5)
  const pots = ring.getByRole('list', { name: 'Pots' })
  await expect(pots.getByRole('listitem')).toHaveText([
    /^Main pot: 5,640 /,
    /^Side pot 1: 2,800 /,
    /^Side pot 2: 800 /,
  ])
  await expectNoOverflow(page)
  await expectRingFits(page, { board, pots })

  // The others check it down and seraphina_lindqvist, the longest name,
  // takes all three: three lines, the last side pot first.
  await page.getByRole('button', { name: /^(Call|Check)/ }).click()
  const paid = ring.getByRole('list', { name: 'Pots paid' })
  await expect(paid.getByRole('listitem')).toHaveText([
    /^Side pot 2: 800 .*seraphina_lindqvist$/,
    /^Side pot 1: 2,800 .*seraphina_lindqvist$/,
    /^Main pot: 5,640 .*seraphina_lindqvist$/,
  ])
  await expectRingFits(page, { board, pots: paid })
})

test('a six-seat table fits 320 px when its side pots are split between the longest names', async ({
  page,
}) => {
  await devSignIn(page, 'you_at_the_bottom')
  // A royal flush on the board plays for everyone, so each pot is split
  // between all who can win it: the "Pots paid" lines are the longest the
  // middle gets, up to six names with a share each.
  await fakeSixTable(page, { sidePots: true, split: true })
  await page.setViewportSize({ width: 320, height: 640 })
  await page.goto(`/#play/${SIX_TABLE}`)
  const ring = page.getByRole('region', { name: 'Poker table' })
  const board = ring.getByRole('group', { name: 'Community cards' })
  await expect(board.getByRole('img', { name: / of / })).toHaveCount(5)
  await page.getByRole('button', { name: /^(Call|Check)/ }).click()
  const paid = ring.getByRole('list', { name: 'Pots paid' })
  await expect(paid.getByRole('listitem')).toHaveText([
    'Side pot 2: 800 chips, split: you 200, maximilian_okafor 200, seraphina_lindqvist 200, ozymandias_kings 200',
    'Side pot 1: 2,800 chips, split: you 560, maximilian_okafor 560, seraphina_lindqvist 560, bartholomew_99 560, ozymandias_kings 560',
    'Main pot: 5,640 chips, split: you 940, maximilian_okafor 940, seraphina_lindqvist 940, bartholomew_99 940, evangeline_marten 940, ozymandias_kings 940',
  ])
  await expectNoOverflow(page)
  await expectRingFits(page, { board, pots: paid })
})

/**
 * The ring from 320 to 860 px. Phones get the grid and wider screens the
 * oval; what is in the middle (the board, and any pots) must clear every
 * plate in both, the oval's narrow middle included. (From 681 to 743 px
 * the app's header alone runs past the screen, on every page, so the page
 * width is checked on either side of that band.)
 */
async function expectRingFits(page: Page, middle: Record<string, Locator>) {
  const ring = page.getByRole('region', { name: 'Poker table' })
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
  for (const width of [320, 360, 412, 681, 700, 760, 860]) {
    await page.setViewportSize({ width, height: 800 })
    if (width <= 680 || width >= 744) await expectNoOverflow(page)
    const you = await plate(0)
    for (const [name, item] of Object.entries(middle)) {
      const box = (await item.boundingBox())!
      for (const slot of [0, 1, 2, 3, 4, 5])
        expect(
          overlap(box, await plate(slot)),
          `${width} px: ${name} on slot ${slot}`,
        ).toBe(false)
    }
    // Where the slots sit lives only in live.css: the viewer's plate is
    // the lowest, and the next seat clockwise is on its left.
    for (const slot of [0, 1, 2, 3, 4, 5]) {
      const other = await plate(slot)
      expect(you.y + you.height).toBeGreaterThanOrEqual(
        other.y + other.height - 1,
      )
    }
    const next = await plate(1)
    expect(next.x + next.width, `${width} px`).toBeLessThanOrEqual(you.x)
  }
}

test('the space under a six-seat ring keeps its height from turn to turn', async ({
  page,
}) => {
  await devSignIn(page, 'steady_under_the_ring')
  // The others wait after the viewer's move, so the page shows one of them
  // to act where the action bar was.
  const table = await fakeSixTable(page, { hold: true })
  await page.goto(`/#play/${SIX_TABLE}`)
  const ring = page.getByRole('region', { name: 'Poker table' })
  const column = page.locator('.six-table')
  /** From the bottom of the ring to the bottom of the table's column. */
  const under = async () => {
    const r = (await ring.boundingBox())!
    const c = (await column.boundingBox())!
    return c.y + c.height - (r.y + r.height)
  }
  for (const width of [320, 360, 412]) {
    await page.setViewportSize({ width, height: 800 })
    await expect(page.getByRole('button', { name: /^Fold/ })).toBeVisible()
    const turn = await under()
    // A phone scrolled down to the bar would jump if the page got shorter
    // under it as the bar gave way to the one-line status.
    await page.getByRole('button', { name: /^(Call|Check)/ }).click()
    await expect(page.getByText(/ to act$/)).toBeVisible()
    expect(await under(), `${width} px`).toBeCloseTo(turn, 0)
    table.release()
  }
})

test('the header is solid over a six-seat table on a phone, and keeps its blur on the trainer', async ({
  page,
}) => {
  await devSignIn(page, 'you_at_the_bottom')
  await fakeSixTable(page)
  const blur = () =>
    page
      .locator('.header')
      .evaluate((el) => getComputedStyle(el).backdropFilter)
  // The six table scrolls under the header on a phone, where a blur would
  // be redrawn on every frame the chips fly beneath it (P2-06b).
  await page.goto(`/#play/${SIX_TABLE}`)
  await expect(page.getByText('6-max · Hand 1')).toBeVisible()
  await expect.poll(blur).toBe('none')
  // Back to the trainer in the app, with no reload: the six table's
  // stylesheet stays on the page, and the trainer's header keeps its blur.
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('button', { name: 'Play' })
    .click()
  await expect(page.locator('.six-table')).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Poker table' })).toBeVisible()
  const liveSheet = () =>
    page.evaluate(() =>
      [...document.styleSheets].some((sheet) =>
        [...sheet.cssRules].some((rule) =>
          rule.cssText.startsWith('.six-ring {'),
        ),
      ),
    )
  expect(await liveSheet()).toBe(true)
  await expect.poll(blur).toBe('blur(14px)')
  // One pixel wider than the phone rule's 680 px, the six table keeps the
  // blur like every other page.
  await page.goto(`/#play/${SIX_TABLE}`)
  await expect(page.getByText('6-max · Hand 1')).toBeVisible()
  await expect.poll(blur).toBe('none')
  await page.setViewportSize({ width: 681, height: 800 })
  await expect.poll(blur).toBe('blur(14px)')
})

test('the header fits a 320 px phone, signed out and signed in', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 640 })
  await page.goto('/?motion=off')
  const header = page.locator('header.header')
  await expect(header.getByRole('link', { name: 'Sign in' })).toBeVisible()
  await expect(header.getByRole('link', { name: 'Join free' })).toBeVisible()
  await expectNoOverflow(page)

  await page.evaluate(() => {
    localStorage.setItem(
      'sb-test-auth-token',
      JSON.stringify({
        access_token: 'a',
        refresh_token: 'r',
        expires_at: 4102444800,
        user: { id: '11111111-1111-4111-8111-111111111111' },
      }),
    )
    localStorage.setItem('qp.username', 'bartholomew_99')
  })
  await page.reload()
  const account = header.getByRole('button', {
    name: 'Account: bartholomew_99',
  })
  await expect(account).toBeVisible()
  await expect(header.getByRole('link', { name: 'Sign in' })).toHaveCount(0)
  await account.click()
  const signOut = header.getByRole('link', { name: 'Sign out' })
  await expect(signOut).toBeInViewport()
  await expectNoOverflow(page)
})
