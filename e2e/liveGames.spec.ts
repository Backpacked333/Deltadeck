import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'
import { devSignIn, fakeLobby } from './sixTable'

// Live games (ADR amendment 2026-10-12, "Live games"), against the real
// Worker like live.spec.ts: a listed game, a request the host answers, and a
// seat by code or code link. The filename carries "live" so the `live`
// project (and scripts/check-e2e.ts) picks it up.

/** A signed-in player in their own browser, recording every frame received. */
async function player(browser: Browser, name: string) {
  const context = await browser.newContext()
  await context.addInitScript((token) => {
    localStorage.setItem(
      'quantpoker.progress.v2',
      JSON.stringify({ onboarded: true }),
    )
    sessionStorage.setItem('qp.devToken', token)
  }, `dev.${name}.e2e-local-secret-0001`)
  const page = await context.newPage()
  page.on('pageerror', (error) => {
    throw error
  })
  /** Everything received over any WebSocket, as text (pongs included). */
  const wire: string[] = []
  const frames: { t: string }[] = []
  page.on('websocket', (ws) =>
    ws.on('framereceived', (f) => {
      const text = String(f.payload)
      wire.push(text)
      // The page's heartbeat is answered with the bare text `pong`.
      if (text !== 'pong') frames.push(JSON.parse(text))
    }),
  )
  return { page, wire, frames, close: () => context.close() }
}
type Player = Awaited<ReturnType<typeof player>>

// The local server keeps its state between runs, and an account with an
// unfinished table is (correctly) sent back to it; fresh names each run.
const RUN = Date.now().toString(36)
const named = (who: string) => `${who}_${RUN}`

const myTurn = (page: Page) =>
  page.locator('.action-status strong', { hasText: 'Your move' })

/** Serious or critical axe violations inside `selector`. */
const serious = async (page: Page, selector: string) =>
  (await new AxeBuilder({ page }).include(selector).analyze()).violations
    .filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))
    .map((v) => `${v.id}: ${v.help}`)

/** Opens a heads-up game as the host and returns its table id and code. */
async function host(who: Player, { listed }: { listed: boolean }) {
  await who.page.goto('/#lobby')
  if (listed)
    await who.page.getByRole('checkbox', { name: 'Show in open games' }).check()
  await who.page.getByRole('button', { name: 'Play a friend by link' }).click()
  await expect(who.page).toHaveURL(/#play\/[0-9a-f-]{36}$/)
  await expect(who.page.getByText('Waiting for your opponent')).toBeVisible()
  const matchId = who.page.url().split('#play/')[1]
  const shown = await who.page.locator('.live-code-text').textContent()
  expect(shown).toMatch(/^[2-9A-HJKMNP-Z]{3}-[2-9A-HJKMNP-Z]{3}$/)
  return { matchId, code: shown!.replace('-', ''), shown: shown! }
}

/** One move by whoever is to act: both sides see the server's answer. */
async function playOneMove(players: Player[]) {
  const total = () => players.reduce((n, p) => n + p.frames.length, 0)
  const before = total()
  await expect
    .poll(async () => {
      for (const p of players) if (await myTurn(p.page).isVisible()) return true
      return false
    })
    .toBe(true)
  for (const p of players)
    if (await myTurn(p.page).isVisible()) {
      await p.page.locator('.act-call').click()
      break
    }
  await expect.poll(total).toBeGreaterThan(before)
}

test('a listed game: the list shows neither code nor id, the host accepts, both play', async ({
  browser,
}) => {
  const alice = await player(browser, named('gal'))
  const bob = await player(browser, named('gbo'))
  const game = await host(alice, { listed: true })
  await expect(
    alice.page.getByRole('region', { name: 'Join requests' }),
  ).toBeVisible()

  // Bob sees a row by name, and nothing in his page or on his wire would
  // seat him: not the table's id, not the code.
  await bob.page.goto('/#lobby')
  const row = bob.page.getByRole('row').filter({ hasText: named('gal') })
  await expect(row).toBeVisible({ timeout: 15_000 })
  await expect(row).toContainText(/open (under a minute|\d+ min)/)
  expect(await bob.page.content()).not.toContain(game.matchId)
  expect(await bob.page.content()).not.toContain(game.code)
  expect(await bob.page.content()).not.toContain(game.shown)
  for (const text of bob.wire) {
    expect(text).not.toContain(game.matchId)
    expect(text).not.toContain(game.code)
  }
  expect(await serious(bob.page, '.live-card-wide')).toEqual([])

  // He asks; the host sees his name and nothing else about him.
  await row.getByRole('button', { name: /^Request to join/ }).click()
  await expect(row.getByText('Waiting for host…')).toBeVisible()
  const ask = alice.page
    .getByRole('region', { name: 'Join requests' })
    .getByRole('listitem')
    .filter({ hasText: `${named('gbo')} wants to join` })
  await expect(ask).toBeVisible()
  expect(await serious(alice.page, '.live-signin')).toEqual([])
  await alice.page
    .getByRole('button', { name: `Accept ${named('gbo')}` })
    .click()

  // Accepted: the lobby sends Bob to the table, and the hand deals.
  for (const { page } of [alice, bob])
    await expect(page.getByText('Hand 1 of 20')).toBeVisible({
      timeout: 15_000,
    })
  await expect(bob.page).toHaveURL(/#play\/[0-9a-f-]{36}$/)
  await playOneMove([alice, bob])

  // The code died with the open seat: it no longer seats a third account.
  const carol = await player(browser, named('gca'))
  await carol.page.goto('/#lobby')
  await carol.page.getByRole('textbox', { name: 'Game code' }).fill(game.code)
  await carol.page.getByRole('button', { name: 'Join game' }).click()
  await expect(carol.page.getByRole('alert')).toContainText(
    "That code doesn't match an open game",
  )
  for (const p of [alice, bob, carol]) await p.close()
})

test('a declined request ends in "Not this time" and cannot ask the host again', async ({
  browser,
}) => {
  const alice = await player(browser, named('dal'))
  const bob = await player(browser, named('dbo'))
  await host(alice, { listed: true })
  await bob.page.goto('/#lobby')
  const row = () => bob.page.getByRole('row').filter({ hasText: named('dal') })
  await expect(row()).toBeVisible({ timeout: 15_000 })
  await row()
    .getByRole('button', { name: /^Request to join/ })
    .click()
  await alice.page
    .getByRole('button', { name: `Decline ${named('dbo')}` })
    .click()
  await expect(row().getByText('Not this time')).toBeVisible()
  // Nothing to press in that row: the answer stands.
  await expect(row().getByRole('button')).toHaveCount(0)
  await expect(
    alice.page.getByText(
      'No requests yet. Anyone with your code or link joins instantly.',
    ),
  ).toBeVisible()

  // Asking again over a fresh page gets the same answer, and the host is
  // not told a second time.
  await bob.page.reload()
  await expect(row()).toBeVisible({ timeout: 15_000 })
  await row()
    .getByRole('button', { name: /^Request to join/ })
    .click()
  await expect(row().getByText('Not this time')).toBeVisible()
  await expect(
    alice.page.getByRole('listitem').filter({ hasText: 'wants to join' }),
  ).toHaveCount(0)
  for (const p of [alice, bob]) await p.close()
})

test('a typed code seats the player, and an unlisted game never shows in the list', async ({
  browser,
}) => {
  const alice = await player(browser, named('cal'))
  const bob = await player(browser, named('cbo'))
  const game = await host(alice, { listed: false })

  await bob.page.goto('/#lobby')
  await expect(bob.page.getByText('Connecting to the lobby…')).toBeHidden()
  // Not listed, however long Bob looks (the list is asked for every 5 s).
  await bob.page.waitForTimeout(6_000)
  await expect(
    bob.page.getByRole('row').filter({ hasText: named('cal') }),
  ).toHaveCount(0)

  // As typed or said aloud: lower case, a space, the hyphen set for him.
  const field = bob.page.getByRole('textbox', { name: 'Game code' })
  await field.fill(
    `${game.code.slice(0, 3)} ${game.code.slice(3)}`.toLowerCase(),
  )
  await expect(field).toHaveValue(game.shown)
  expect(await serious(bob.page, '.live-card-wide')).toEqual([])
  await bob.page.getByRole('button', { name: 'Join game' }).click()
  for (const { page } of [alice, bob])
    await expect(page.getByText('Hand 1 of 20')).toBeVisible({
      timeout: 15_000,
    })
  await playOneMove([alice, bob])
  for (const p of [alice, bob]) await p.close()
})

test('a code link seats the player, and leaves no code in the address bar', async ({
  browser,
}) => {
  const alice = await player(browser, named('lal'))
  const bob = await player(browser, named('lbo'))
  const game = await host(alice, { listed: false })
  await bob.page.goto(`/#join/${game.code}`)
  for (const { page } of [alice, bob])
    await expect(page.getByText('Hand 1 of 20')).toBeVisible({
      timeout: 15_000,
    })
  await expect(bob.page).toHaveURL(/#play\/[0-9a-f-]{36}$/)
  expect(bob.page.url()).not.toContain(game.code)

  // The same link on the full table is a miss, and the code is not kept.
  const carol = await player(browser, named('lca'))
  await carol.page.goto(`/#join/${game.code}`)
  await expect(carol.page.getByRole('alert')).toContainText(
    "That code doesn't match an open game",
  )
  expect(carol.page.url()).not.toContain(game.code)
  await expect(
    carol.page.getByRole('link', { name: 'Back to lobby' }),
  ).toBeVisible()
  for (const p of [alice, bob, carol]) await p.close()
})

test('six wrong codes get rate limited', async ({ browser }) => {
  const dave = await player(browser, named('rdv'))
  await dave.page.goto('/#lobby')
  const field = dave.page.getByRole('textbox', { name: 'Game code' })
  await expect(dave.page.getByText('Connecting to the lobby…')).toBeHidden()
  const answers = () =>
    dave.wire.filter((text) => /"join_status"|"rate_limited"/.test(text)).length
  // Five misses spend the account's allowance, one at a time; each is
  // answered the same way, whatever the code was.
  for (let n = 0; n < 5; n++) {
    await field.fill(`ZZZZZ${2 + n}`)
    await dave.page.getByRole('button', { name: 'Join game' }).click()
    await expect.poll(answers).toBe(n + 1)
    await expect(dave.page.getByRole('alert')).toContainText(
      "That code doesn't match an open game",
    )
  }
  await field.fill('ZZZZZ8')
  await dave.page.getByRole('button', { name: 'Join game' }).click()
  await expect(dave.page.getByRole('alert')).toContainText(
    'Too many tries. Wait a few minutes.',
  )
  await dave.close()
})

test('the open games card against a scripted lobby fits 320 px and walks every row state', async ({
  page,
}) => {
  // The lobby's socket is answered here (sixTable.ts), so every state shows
  // without a second player: the list, a pending request, a decline, a miss.
  await devSignIn(page, named('mock'))
  const games = [
    { gameId: 'a'.repeat(32), host: 'maximilian_okafor', openForMs: 185_000 },
    { gameId: 'b'.repeat(32), host: 'seraphina_lindqvist', openForMs: 20_000 },
  ]
  const lobby = await fakeLobby(page, {
    games,
    answer: () => null,
    onJoinRequest: (gameId) =>
      gameId.startsWith('a')
        ? { t: 'join_status', state: 'pending', expiresInMs: 60_000 }
        : { t: 'join_status', state: 'declined' },
    onJoinCode: () => ({ t: 'join_status', state: 'unavailable' }),
  })
  await page.setViewportSize({ width: 320, height: 640 })
  await page.goto('/#lobby')
  const list = page.getByRole('table', { name: 'Open games' })
  await expect(list.getByRole('row')).toHaveCount(1 + 2)
  const first = list.getByRole('row').filter({ hasText: 'maximilian_okafor' })
  const second = list
    .getByRole('row')
    .filter({ hasText: 'seraphina_lindqvist' })
  await expect(first).toContainText('open 3 min')
  const fits = () =>
    page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    )
  expect(await fits()).toBe(true)

  await first.getByRole('button', { name: /^Request to join/ }).click()
  await expect(first.getByText('Waiting for host…')).toBeVisible()
  await expect(
    second.getByRole('button', { name: /^Request to join/ }),
  ).toBeDisabled()
  expect(await fits()).toBe(true)
  expect(await serious(page, '.live-card-wide')).toEqual([])
  await first.getByRole('button', { name: 'Cancel' }).click()

  await second.getByRole('button', { name: /^Request to join/ }).click()
  await expect(second.getByText('Not this time')).toBeVisible()

  await page.getByRole('textbox', { name: 'Game code' }).fill('zzzzz2')
  await page.getByRole('button', { name: 'Join game' }).click()
  await expect(page.getByRole('alert')).toContainText(
    "That code doesn't match an open game",
  )
  expect(await fits()).toBe(true)
  expect(lobby.received.flat().map((m) => m.t)).toEqual(
    expect.arrayContaining([
      'games',
      'join_request',
      'cancel_request',
      'join_code',
    ]),
  )
})
