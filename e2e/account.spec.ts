import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { fakeAccountService } from './helpers'

// The account path in a real browser: a signed-out visitor at the practice
// table is sent to sign up, signs in instead, comes back to the table, and
// signs out from the header's menu. The account service is a stand-in
// (fakeAccountService plus the auth endpoints below); nothing leaves the
// browser.
const AUTH = 'https://accounts.e2e.test/auth/v1'
const USER = {
  id: '33333333-3333-4333-8333-333333333333',
  aud: 'authenticated',
  role: 'authenticated',
  email: 'carol@uni.edu',
  email_confirmed_at: '2026-10-01T00:00:00Z',
}
const PASSWORD = 'correct horse battery'

async function fakeAuth(page: Page) {
  const calls: string[] = []
  await page.route(`${AUTH}/**`, async (route) => {
    const at = new URL(route.request().url())
    calls.push(`${route.request().method()} ${at.pathname}${at.search}`)
    if (at.pathname === '/auth/v1/settings')
      return route.fulfill({
        json: { external: { email: true, google: false, apple: false } },
      })
    if (at.pathname === '/auth/v1/token') {
      const body = route.request().postDataJSON() as { password?: string }
      if (body.password !== PASSWORD)
        return route.fulfill({
          status: 400,
          json: {
            error_code: 'invalid_credentials',
            msg: 'Invalid login credentials',
          },
        })
      return route.fulfill({
        json: {
          access_token: 'e2e-access',
          refresh_token: 'e2e-refresh',
          token_type: 'bearer',
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          user: USER,
        },
      })
    }
    if (at.pathname === '/auth/v1/user') return route.fulfill({ json: USER })
    if (at.pathname === '/auth/v1/logout')
      return route.fulfill({ status: 204, body: '' })
    return route.fulfill({ status: 404, json: { msg: 'not here' } })
  })
  return calls
}

test.beforeEach(async ({ page }) => {
  await fakeAccountService(page, {
    tables: {
      players: [
        {
          user_id: USER.id,
          username: 'carol',
          country: null,
          bio: '',
          school: 'uni.edu',
          created_at: '2026-09-01T00:00:00Z',
        },
      ],
      practice_hands: [],
      learning_state: [],
      ratings: [],
      rating_history: [],
      challenge_scores: [
        {
          user_id: USER.id,
          hand: 'overpair',
          accuracy: 87,
          played_at: '2026-10-02T00:00:00Z',
        },
      ],
    },
  })
})

test('the practice table sends a visitor to sign in, and back to the table after', async ({
  page,
}) => {
  const calls = await fakeAuth(page)
  await page.goto('/#table')
  await expect(page).toHaveURL(/#signup$/)
  await expect(
    page.getByRole('heading', { level: 1, name: 'Join DeltaDeck' }),
  ).toBeVisible()
  await expect(page.locator('.table')).toHaveCount(0)

  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.getByLabel('Email').fill('carol@uni.edu')
  await page.getByLabel('Password').fill('not the password')
  await page
    .locator('form')
    .getByRole('button', { name: 'Sign in', exact: true })
    .click()
  await expect(page.getByRole('alert')).toHaveText(
    'That email and password do not match an account.',
  )

  await page.getByLabel('Password').fill(PASSWORD)
  await page
    .locator('form')
    .getByRole('button', { name: 'Sign in', exact: true })
    .click()
  await expect(page).toHaveURL(/#table$/)
  await expect(page.getByRole('region', { name: 'Poker table' })).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Account: carol' }),
  ).toBeVisible()
  expect(calls).toContain('POST /auth/v1/token?grant_type=password')
})

test('signing out from the menu goes home and locks practice again', async ({
  page,
}) => {
  await fakeAuth(page)
  await page.goto('/#signin')
  await page.getByLabel('Email').fill('carol@uni.edu')
  await page.getByLabel('Password').fill(PASSWORD)
  await page
    .locator('form')
    .getByRole('button', { name: 'Sign in', exact: true })
    .click()
  await expect(page.getByRole('region', { name: 'Poker table' })).toBeVisible()
  // New to the table: the welcome first.
  await page.getByRole('button', { name: /new to poker/ }).click()
  await page.getByRole('button', { name: 'Skip tour' }).click()

  await page.getByRole('button', { name: 'Account: carol' }).click()
  await page.getByRole('link', { name: 'Sign out' }).click()
  // Sign out reloads the landing, whose 3D stage can take longer than the
  // 5 s default to draw on a busy runner.
  await expect(page.getByRole('heading', { name: /misprice/ })).toBeVisible({
    timeout: 15_000,
  })
  await expect(
    page.locator('header.header').getByRole('link', { name: 'Sign in' }),
  ).toBeVisible()
  // Nothing of the account is left in this browser: no session, and the
  // progress the home page starts is a new visitor's, owned by nobody.
  const left = await page.evaluate(() => ({
    sessions: Object.keys(localStorage).filter((k) => k.startsWith('sb-')),
    progress: JSON.parse(
      localStorage.getItem('quantpoker.progress.v2') ?? '{"hands":[]}',
    ),
  }))
  expect(left.sessions).toEqual([])
  expect(left.progress.hands).toEqual([])
  expect(left.progress.owner).toBeUndefined()

  // This browser has had an account: practice now offers sign-in.
  await page.goto('/#table')
  await expect(page).toHaveURL(/#signin$/)
  await expect(
    page.getByRole('heading', { level: 1, name: 'Welcome back' }),
  ).toBeVisible()
})

test("the account menu opens Your profile, with the account's history", async ({
  page,
}) => {
  await fakeAuth(page)
  await page.goto('/#signin')
  await page.getByLabel('Email').fill('carol@uni.edu')
  await page.getByLabel('Password').fill(PASSWORD)
  await page
    .locator('form')
    .getByRole('button', { name: 'Sign in', exact: true })
    .click()
  await page.getByRole('button', { name: /new to poker/ }).click()
  await page.getByRole('button', { name: 'Skip tour' }).click()

  await page.getByRole('button', { name: 'Account: carol' }).click()
  await page.getByRole('link', { name: 'Your profile' }).click()
  await expect(page).toHaveURL(/#me$/)
  await expect(
    page.getByRole('heading', { level: 1, name: 'carol' }),
  ).toBeVisible()
  await expect(page.getByText(/Playing since .* · uni\.edu/)).toBeVisible()
  await expect(page.getByRole('region', { name: 'Online' })).toContainText(
    'No rated matches yet',
  )
  await expect(
    page.getByRole('region', { name: 'Challenge scores' }),
  ).toContainText('Overpair under pressure')
})
