import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'
import { fakeLobby, fakeSitTables, fakeSixTable, SIX_TABLE } from './sixTable'

type Frame = {
  t: string
  seat?: number | null
  handNo?: number
  view?: {
    you: number
    handNo: number
    players: { seat: number; cards: [number, number] | null; shown: boolean }[]
  } | null
  record?: {
    actions: { action: { type: string }; source: string }[]
  }
  own?: { card: number }[]
}

/** A signed-in player in their own browser, recording every frame. */
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
  const frames: Frame[] = []
  page.on('websocket', (ws) =>
    ws.on('framereceived', (f) => frames.push(JSON.parse(String(f.payload)))),
  )
  return { page, frames, close: () => context.close() }
}

// The local server keeps its state between runs, and an account with an
// unfinished table is (correctly) sent back to it; fresh names each run.
const RUN = Date.now().toString(36)
const named = (who: string) => `${who}_${RUN}`

const myTurn = (page: Page) =>
  page.locator('.action-status strong', { hasText: 'Your move' })

/** Every key at any depth of the frames. */
const frameKeys = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.flatMap(frameKeys)
    : value && typeof value === 'object'
      ? Object.entries(value).flatMap(([k, v]) => [k, ...frameKeys(v)])
      : []

test('two browsers play a hand against each other', async ({ browser }) => {
  const alice = await player(browser, named('alice'))
  const bob = await player(browser, named('bob'))

  await alice.page.goto('/#lobby')
  await expect(alice.page.getByText('Signed in as')).toContainText(
    named('alice'),
  )
  await alice.page
    .getByRole('button', { name: 'Play a friend by link' })
    .click()
  await expect(alice.page).toHaveURL(/#play\/[0-9a-f-]{36}$/)
  await expect(alice.page.getByText('Waiting for your opponent')).toBeVisible()
  const link = await alice.page.getByLabel('Invite link').inputValue()

  await bob.page.goto(link)
  for (const { page } of [alice, bob]) {
    await expect(page.getByText('Hand 1 of 20')).toBeVisible()
    await expect(page.getByRole('timer')).toBeVisible()
    await expect(
      page.getByRole('region', { name: 'Poker table' }),
    ).toContainText('Live table')
  }
  await expect(
    alice.page.getByRole('region', { name: 'Poker table' }),
  ).toContainText(`vs ${named('bob')}`)
  await expect(
    bob.page.getByRole('region', { name: 'Poker table' }),
  ).toContainText(`vs ${named('alice')}`)

  // Exactly one of them is to act at any time; check or call down.
  const everyone = [alice, bob]
  const done = (page: Page) => page.getByText('Next hand in a few seconds.')
  for (let i = 0; i < 40 && !(await done(alice.page).isVisible()); i++) {
    for (const { page } of [alice, bob])
      if (await myTurn(page).isVisible()) {
        // The big blind can act twice in a row (pre-flop option, then first
        // on the flop), so wait for the server's answer, not for the label.
        const before = everyone.reduce((n, p) => n + p.frames.length, 0)
        await page.locator('.act-call').click()
        await expect
          .poll(() => everyone.reduce((n, p) => n + p.frames.length, 0))
          .toBeGreaterThan(before)
      }
    await alice.page.waitForTimeout(100)
  }
  for (const { page } of [alice, bob]) await expect(done(page)).toBeVisible()

  // Each browser checks the deal against the commitment it got before the
  // first card, with its own Web Crypto.
  for (const { page } of [alice, bob]) {
    await page.getByRole('button', { name: 'Review hand 1' }).click()
    await expect(page.getByText('Deck verified')).toBeVisible()
  }

  // The server deals the next hand by itself.
  for (const { page } of [alice, bob])
    await expect(page.getByText('Hand 2 of 20')).toBeVisible({
      timeout: 10_000,
    })

  // Privacy over the wire: no frame carried the opponent's cards before
  // they were shown at showdown.
  for (const { frames } of [alice, bob]) {
    const views = frames.flatMap((f) => (f.view ? [f.view] : []))
    expect(views.length).toBeGreaterThan(5)
    for (const view of views) {
      // By seat, not list position: with empty seats they differ.
      const mine = view.players.find((p) => p.seat === view.you)
      const opponent = view.players.find((p) => p.seat !== view.you)
      if (!mine || !opponent)
        throw new Error(`hand ${view.handNo}: you or the opponent is missing`)
      if (!opponent.shown) expect(opponent.cards).toBeNull()
      expect(mine.cards).not.toBeNull()
    }
    expect(JSON.stringify(frames)).not.toContain('"deck"')
  }

  const axe = await new AxeBuilder({ page: alice.page }).analyze()
  const serious = axe.violations.filter((v) =>
    ['serious', 'critical'].includes(v.impact ?? ''),
  )
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([])

  await alice.close()
  await bob.close()
})

test('a third person cannot take a full table', async ({ browser }) => {
  const alice = await player(browser, named('alice2'))
  const bob = await player(browser, named('bob2'))
  const carol = await player(browser, named('carol'))
  await alice.page.goto('/#lobby')
  await alice.page
    .getByRole('button', { name: 'Play a friend by link' })
    .click()
  const link = await alice.page.getByLabel('Invite link').inputValue()
  await bob.page.goto(link)
  await expect(bob.page.getByText('Hand 1 of 20')).toBeVisible()
  await carol.page.goto(link)
  await expect(carol.page.getByRole('alert')).toContainText(
    'Could not join this table',
    {
      timeout: 15_000,
    },
  )
  for (const p of [alice, bob, carol]) await p.close()
})

test('keyboard loop at a six-seat table', async ({ browser }) => {
  // No table server here: six tables cannot be opened over HTTP before
  // quick-sit (P2-08), so the page's socket is answered by sixTable.ts.
  const me = await player(browser, named('six'))
  const { page } = me
  const table = await fakeSixTable(page)
  const acts = () =>
    table.received.flatMap((m) => (m.t === 'act' ? [m.action] : []))
  await page.goto(`/#play/${SIX_TABLE}`)
  await expect(page.getByText('6-max · Hand 1')).toBeVisible()
  const board = page
    .getByRole('group', { name: 'Community cards' })
    .getByRole('img', { name: / of / })

  // Pre-flop, in the small blind after four calls: 2 picks ¾ of the pot
  // (20 + ¾ × 120) and R raises to it.
  await expect(myTurn(page)).toBeVisible()
  await expect(page.locator('.action-bar kbd')).toHaveText(['F', 'C', 'R'])
  await page.keyboard.press('2')
  await expect(
    page.getByRole('button', { name: /^Raise to 110/ }),
  ).toBeVisible()
  await page.keyboard.press('r')
  await expect.poll(acts).toEqual([{ type: 'raise', to: 110 }])

  // Everyone called. Flop and turn: C checks.
  for (const cards of [3, 4]) {
    await expect(board).toHaveCount(cards)
    await expect(myTurn(page)).toBeVisible()
    await page.keyboard.press('c')
    await expect.poll(() => acts().length).toBe(cards - 1)
  }

  // River: 3 picks the pot (660) and B bets it; everyone calls.
  await expect(board).toHaveCount(5)
  await expect(myTurn(page)).toBeVisible()
  await page.keyboard.press('3')
  await expect(page.getByRole('button', { name: /^Bet 660/ })).toBeVisible()
  await page.keyboard.press('b')
  await expect(page.getByText('Next hand in a few seconds.')).toBeVisible()
  expect(acts()).toEqual([
    { type: 'raise', to: 110 },
    { type: 'check' },
    { type: 'check' },
    { type: 'raise', to: 660 },
  ])

  // The hand is over and it is nobody's turn: the keys make no move.
  await page.keyboard.press('c')
  await page.keyboard.press('f')
  await page.waitForTimeout(300)
  expect(acts()).toHaveLength(4)
  // The page refuses a move out of turn anyway, so that holds even with the
  // keys bound. This does not: with no listener, no key is taken.
  const taken = await page.evaluate(() =>
    ['c', 'f', 'r', 'b', '1', '2', '3', '4'].filter(
      (key) =>
        !document.body.dispatchEvent(
          new KeyboardEvent('keydown', {
            key,
            bubbles: true,
            cancelable: true,
          }),
        ),
    ),
  )
  expect(taken).toEqual([])

  // Out of the hand on 1,230, below 100 bb: Rebuy, by keyboard, sends
  // the bare message, and the table's answer takes it away.
  const own = page.getByRole('group', { name: /^Seat 1:/ })
  await expect(own).toContainText('1,230')
  const rebuy = page.getByRole('button', { name: /^Rebuy/ })
  await expect(rebuy).toHaveAccessibleName('Rebuy to 2,000 chips')
  await rebuy.focus()
  await page.keyboard.press('Enter')
  await expect(rebuy).toHaveCount(0)
  await expect(own).toContainText('2,000')
  await expect(own).toBeFocused()
  // Sit out, by keyboard: the seat stays, its plate and the seat controls'
  // live line say so, and Sit in takes the button's place.
  const seatLine = page
    .getByRole('group', { name: 'Your seat' })
    .getByRole('status')
  await page.getByRole('button', { name: 'Sit out' }).focus()
  await page.keyboard.press('Enter')
  await expect(seatLine).toHaveText('Sitting out: sit in to be dealt in.')
  await expect(own).toContainText('Sitting out')
  await expect(page.getByRole('button', { name: 'Sit out' })).toHaveCount(0)
  // Sit in, by keyboard: back from the next hand.
  await page.getByRole('button', { name: 'Sit in' }).focus()
  await page.keyboard.press('Enter')
  await expect(seatLine).toHaveText('Back in from the next hand.')
  await expect(own).not.toContainText('Sitting out')
  // Stand up between hands frees the seat at once.
  await page.getByRole('button', { name: 'Stand up' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByText('Pick an empty seat to play.')).toBeVisible()
  expect(table.received.filter((m) => m.t !== 'act')).toEqual([
    { t: 'rebuy' },
    { t: 'sit_out' },
    { t: 'sit_in' },
    { t: 'stand' },
  ])
  await me.close()
})

test('a stand mid-hand at a six-seat table keeps the seat until the hand ends', async ({
  browser,
}) => {
  const me = await player(browser, named('stand'))
  const { page } = me
  // The others wait after the viewer's stand, so the page shows the hand
  // going on without them.
  const table = await fakeSixTable(page, { hold: true })
  await page.goto(`/#play/${SIX_TABLE}`)
  await expect(myTurn(page)).toBeVisible()
  // Dealt in: no rebuy while the hand is played.
  await expect(page.getByRole('button', { name: /^Rebuy/ })).toHaveCount(0)
  const serious = async () =>
    (
      await new AxeBuilder({ page }).include('.six-seat-controls').analyze()
    ).violations
      .filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))
      .map((v) => `${v.id}: ${v.help}`)
  expect(await serious()).toEqual([])
  await page.getByRole('button', { name: 'Stand up' }).focus()
  await page.keyboard.press('Enter')
  // On their turn the stand folds them; the seat stays theirs, and only
  // their own page knows they are leaving.
  const seatControls = page.getByRole('group', { name: 'Your seat' })
  await expect(seatControls.getByRole('status')).toHaveText(
    'Leaving after this hand',
  )
  await expect(page.getByText(/ to act$/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stand up' })).toHaveCount(0)
  expect(await serious()).toEqual([])
  expect(table.received).toEqual([{ t: 'stand' }])
  // The others finish the hand and the seat frees.
  table.release()
  await expect(page.getByText('Pick an empty seat to play.')).toBeVisible()
  await expect(page.getByText('Leaving after this hand')).toHaveCount(0)
  await expect(seatControls).toHaveCount(0)
  await me.close()
})

// Six tables through the real lobby. Local state persists, and a player
// left seated at a table would be dealt in and time out in the next test:
// these run in order, in one worker, and stand their players up after
// each test, whether it passed or not.
test.describe('six tables through the real lobby', () => {
  test.describe.configure({ mode: 'default' })

  type Player = Awaited<ReturnType<typeof player>>
  let opened: { p: Player; errors: string[] }[] = []
  /** A player of this test, its console errors kept. */
  async function sitter(browser: Browser, who: string) {
    const p = await player(browser, named(who))
    const errors: string[] = []
    p.page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text())
    })
    opened.push({ p, errors })
    return { ...p, errors }
  }
  test.afterEach(async () => {
    const players = opened.map((o) => o.p)
    opened = []
    for (const p of players) {
      const stand = p.page.getByRole('button', { name: 'Stand up' })
      if (await stand.isVisible().catch(() => false))
        await stand.click().catch(() => {})
    }
    for (const p of players)
      await expect(p.page.getByRole('group', { name: /\(you\)$/ }))
        .toHaveCount(0, { timeout: 60_000 })
        .catch(() => {})
    for (const p of players) await p.close()
  })

  test('Quick sit seats a player at a six-seat table from the keyboard, and the lobby lists it', async ({
    browser,
  }) => {
    // The real lobby and tables. Local state persists between runs, so a
    // quick-sit may land at a table an earlier run left: only that each
    // player is seated is asserted, not that both share one table.
    const ada = await sitter(browser, 'ada')
    await ada.page.goto('/#lobby')
    const quick = ada.page.getByRole('button', { name: 'Quick sit' })
    await expect(quick).toBeEnabled()
    await quick.focus()
    await ada.page.keyboard.press('Enter')
    await expect(ada.page).toHaveURL(/#play\/[0-9a-f-]{36}$/)
    const mine = ada.page.getByRole('group', { name: /\(you\)$/ })
    await expect(mine).toBeVisible()
    await expect(mine).toBeFocused()
    await expect(
      ada.page.getByRole('button', { name: /^Sit here/ }),
    ).toHaveCount(0)

    const bo = await sitter(browser, 'bo')
    await bo.page.goto('/#lobby')
    const list = bo.page.getByRole('table', { name: 'Six-max tables' })
    await expect(list.getByRole('row').nth(1)).toBeVisible()
    const results = await new AxeBuilder({ page: bo.page })
      .include('.live-cards')
      .analyze()
    expect(
      results.violations.filter(
        (v) => v.impact === 'serious' || v.impact === 'critical',
      ),
    ).toEqual([])
    await bo.page.getByRole('button', { name: 'Quick sit' }).click()
    await expect(bo.page).toHaveURL(/#play\/[0-9a-f-]{36}$/)
    await expect(bo.page.getByRole('group', { name: /\(you\)$/ })).toBeVisible()
    for (const p of [ada, bo]) expect(p.errors).toEqual([])
  })

  test('two browsers at a six-seat table', async ({ browser }) => {
    // P2-11: two real browsers at one real six table. Ana quick-sits; Ben
    // opens her table by its id, as a link does, and sits. Once both are
    // dealt in, whoever is to act folds from the keyboard (F), and the
    // next hand deals to both. Neither ever receives the other's cards
    // unshown, a view for another seat, or another seat's opening.
    const ana = await sitter(browser, 'ana6')
    await ana.page.goto('/#lobby')
    await ana.page.getByRole('button', { name: 'Quick sit' }).click()
    await expect(ana.page).toHaveURL(/#play\/[0-9a-f-]{36}$/)
    await expect(
      ana.page.getByRole('group', { name: /\(you\)$/ }),
    ).toBeVisible()
    const tableId = ana.page.url().split('#play/')[1]

    const ben = await sitter(browser, 'ben6')
    await ben.page.goto(`/#play/${tableId}`)
    await ben.page
      .getByRole('button', { name: /^Sit here/ })
      .first()
      .click()
    await expect(
      ben.page.getByRole('group', { name: /\(you\)$/ }),
    ).toBeVisible()

    // Dealt in, both: a table reused from an earlier test still shows its
    // finished hand until this one deals.
    const label = (page: Page) => page.getByText(/^6-max · Hand \d+$/)
    for (const { page } of [ana, ben])
      await expect(
        page.getByRole('group', { name: 'Your cards' }),
      ).toBeVisible()
    await expect
      .poll(async () => {
        const [a, b] = [
          await label(ana.page).textContent(),
          await label(ben.page).textContent(),
        ]
        return a !== null && a === b
      })
      .toBe(true)
    const first = (await label(ana.page).textContent())!
    const handNo = Number(first.split('Hand ')[1])
    // F folds for whoever is to act; well inside the 20 s turn clock, so
    // the table's own timeout cannot end the hand instead.
    await expect(async () => {
      for (const { page } of [ana, ben])
        if (await myTurn(page).isVisible()) await page.keyboard.press('f')
      await expect(label(ana.page)).not.toHaveText(first, { timeout: 1000 })
    }).toPass({ timeout: 15_000 })
    const next = (await label(ana.page).textContent())!
    await expect(label(ben.page)).toHaveText(next)
    // The record of that hand has the fold, from a client.
    const ended = ana.frames.find(
      (f) => f.t === 'hand_end' && f.handNo === handNo,
    )
    expect(
      ended?.record?.actions.some(
        (a) => a.action.type === 'fold' && a.source === 'client',
      ),
    ).toBe(true)

    for (const p of [ana, ben]) {
      // The seat this page sat at, from its last welcome with one.
      const seat = p.frames
        .filter((f) => f.t === 'welcome' && typeof f.seat === 'number')
        .at(-1)?.seat
      const views = p.frames.flatMap((f) => (f.view ? [f.view] : []))
      expect(views.length).toBeGreaterThan(2)
      const mine = new Set<number>()
      for (const v of views) {
        expect([seat, null]).toContain(v.you)
        for (const s of v.players) {
          if (s.seat === v.you && s.cards) s.cards.forEach((c) => mine.add(c))
          else expect(s.cards === null || s.shown).toBe(true)
        }
      }
      for (const f of p.frames)
        for (const o of f.own ?? []) expect(mine).toContain(o.card)
      expect(
        frameKeys(p.frames).filter((k) => /^(deck|secret|holes)$/.test(k)),
      ).toEqual([])
      expect(p.errors).toEqual([])
    }
  })
})

test('a quick-sit refused at one table sits at the next, across pages', async ({
  browser,
}) => {
  // The lobby and both tables answered here: T1 is full, T2 seats us.
  const T1 = '0b7c4a52-6f0e-4d7b-9b55-3c1f2a9e8d01'
  const T2 = '1c8d5b63-7a1f-4e8c-8c66-4d2a3b0f9e12'
  const me = await player(browser, named('hop'))
  const { page } = me
  const lobby = await fakeLobby(page, {
    answer: (tried) => ({ t: 'sit_at', tableId: tried.length ? T2 : T1 }),
  })
  const tables = await fakeSitTables(page, { [T1]: 'full', [T2]: 'seat' })
  await page.goto('/#lobby')
  const quick = page.getByRole('button', { name: 'Quick sit' })
  await expect(quick).toBeEnabled()
  await quick.focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`#play/${T2}$`))
  await expect(
    page.getByRole('group', { name: 'Seat 2: you (you)' }),
  ).toBeFocused()
  expect(
    lobby.received.map((frames) => frames.filter((m) => m.t === 'quick_sit')),
  ).toEqual([[{ t: 'quick_sit' }], [{ t: 'quick_sit', tried: [T1] }]])
  expect(tables.received[T1]).toEqual([{ t: 'sit' }])
  expect(tables.received[T2]).toEqual([{ t: 'sit' }])
  // The table that refused is no step of the history: Back is the lobby.
  await page.goBack()
  await expect(page).toHaveURL(/#lobby$/)
  await me.close()
})

// One lobby holds every matchmaking queue, so two rated tests in parallel
// workers can pair with each other's players and both fail. The tests that
// queue run in order, in one worker.
test.describe('matchmaking', () => {
  test.describe.configure({ mode: 'default' })

  test('two players find a rated match and both see Hand 1 of 40', async ({
    browser,
  }) => {
    const rae = await player(browser, named('rae'))
    const ray = await player(browser, named('ray'))
    for (const { page } of [rae, ray]) await page.goto('/#lobby')
    await expect(
      rae.page.getByRole('heading', { name: 'Play rated 1v1' }),
    ).toBeVisible()
    await rae.page.getByRole('button', { name: 'Find a rated match' }).click()
    await expect(rae.page.getByText('Looking for an opponent')).toBeVisible()
    await ray.page.getByRole('button', { name: 'Find a rated match' }).click()
    for (const { page } of [rae, ray]) {
      await expect(page).toHaveURL(/#play\/[0-9a-f-]{36}$/)
      await expect(page.getByText('Rated · Hand 1 of 40')).toBeVisible()
    }
    expect(rae.page.url()).toBe(ray.page.url())
    for (const p of [rae, ray]) await p.close()
  })

  test('two players find each other with quick match', async ({ browser }) => {
    const ann = await player(browser, named('ann'))
    const ben = await player(browser, named('ben'))
    for (const { page } of [ann, ben]) await page.goto('/#lobby')
    await ann.page.getByRole('button', { name: 'Find a match' }).click()
    await expect(ann.page.getByText('Looking for an opponent')).toBeVisible()
    await ben.page.getByRole('button', { name: 'Find a match' }).click()
    for (const { page } of [ann, ben]) {
      await expect(page).toHaveURL(/#play\/[0-9a-f-]{36}$/)
      await expect(page.getByText('Hand 1 of 20')).toBeVisible()
    }
    expect(ann.page.url()).toBe(ben.page.url())
    // Looking again sends you back to the table you are playing.
    await ann.page.goto('/#lobby')
    await expect(
      ann.page.getByRole('link', { name: 'Return to your table' }),
    ).toBeVisible()
    await ann.page.getByRole('button', { name: 'Find a match' }).click()
    await expect(ann.page).toHaveURL(ben.page.url())
    for (const p of [ann, ben]) await p.close()
  })

  test('during a rated hand neither browser receives analysis keys or opponent cards and no lab control is visible', async ({
    browser,
  }) => {
    const rio = await player(browser, named('rio'))
    const rex = await player(browser, named('rex'))
    const everyone = [rio, rex]
    for (const { page } of everyone) await page.goto('/#lobby')
    await rio.page.getByRole('button', { name: 'Find a rated match' }).click()
    await expect(rio.page.getByText('Looking for an opponent')).toBeVisible()
    await rex.page.getByRole('button', { name: 'Find a rated match' }).click()
    for (const { page } of everyone)
      await expect(page.getByText('Rated · Hand 1 of 40')).toBeVisible()

    // Check or call down hand 1. At every decision the table offers nothing
    // to analyse: no equity ring, no odds or EV, no read prompt, no lab.
    const done = (page: Page) => page.getByText('Next hand in a few seconds.')
    let decisions = 0
    for (let i = 0; i < 40 && !(await done(rio.page).isVisible()); i++) {
      for (const { page } of everyone)
        if (await myTurn(page).isVisible()) {
          await expect(page.locator('.ring')).toHaveCount(0)
          await expect(page.locator('.action-bar')).not.toContainText(
            /%|break-even|\bEV\b/,
          )
          await expect(
            page.getByRole('slider', { name: /equity/i }),
          ).toHaveCount(0)
          await expect(page.getByRole('button', { name: /lab/i })).toHaveCount(
            0,
          )
          decisions++
          const before = everyone.reduce((n, p) => n + p.frames.length, 0)
          await page.locator('.act-call').click()
          await expect
            .poll(() => everyone.reduce((n, p) => n + p.frames.length, 0))
            .toBeGreaterThan(before)
        }
      await rio.page.waitForTimeout(100)
    }
    expect(decisions).toBeGreaterThanOrEqual(4)
    for (const { page } of everyone) await expect(done(page)).toBeVisible()

    // Over the wire, lobby and table alike: no analysis key and no secret at
    // any depth, and the opponent's cards only once shown.
    const keys = (value: unknown): string[] =>
      Array.isArray(value)
        ? value.flatMap(keys)
        : value && typeof value === 'object'
          ? Object.entries(value).flatMap(([k, v]) => [k, ...keys(v)])
          : []
    const analysis =
      /^(equity|equities|ev|evs|evLost|ev_lost|callEV|raiseEV|range|ranges|grade|grades|accuracy|luck|allInAt|bestKind|foldProbability|breakEven)$/i
    for (const { frames } of everyone) {
      const views = frames.flatMap((f) => (f.view ? [f.view] : []))
      expect(views.length).toBeGreaterThan(5)
      expect(keys(frames).filter((k) => analysis.test(k))).toEqual([])
      expect(
        keys(frames).filter((k) => /^(deck|secret|holes)$/.test(k)),
      ).toEqual([])
      for (const view of views) {
        // By seat, not list position: with empty seats they differ.
        const mine = view.players.find((p) => p.seat === view.you)
        const opponent = view.players.find((p) => p.seat !== view.you)
        if (!mine || !opponent)
          throw new Error(`hand ${view.handNo}: you or the opponent is missing`)
        if (!opponent.shown) expect(opponent.cards).toBeNull()
        expect(mine.cards).not.toBeNull()
      }
    }
    for (const p of everyone) await p.close()
  })
})
