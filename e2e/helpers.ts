import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'

/**
 * A signed-in visitor, as far as the page can tell: a stored session of the
 * shape supabase-js writes, under the key the fake account service's host
 * would use. Practice, lessons and progress need one. Without an account
 * service (Vite preview) nothing checks it with a server.
 */
export async function signedInVisitor(page: Page, username = 'tester') {
  await page.addInitScript((name) => {
    localStorage.setItem(
      'sb-accounts-auth-token',
      JSON.stringify({
        access_token: 'e2e-access-token',
        refresh_token: 'e2e-refresh-token',
        expires_at: 4102444800,
        token_type: 'bearer',
        user: { id: '11111111-1111-4111-8111-111111111111' },
      }),
    )
    localStorage.setItem('qp.username', name)
  }, username)
}

/**
 * A signed-in visitor straight to the table, new to it: welcome, choose a
 * mode, skip the tour.
 */
export async function onboard(page: Page, mode: 'new' | 'rules' = 'new') {
  await signedInVisitor(page)
  await page.goto('/#table')
  await page
    .getByRole('button', {
      name: mode === 'new' ? /new to poker/ : /know the rules/,
    })
    .click()
  await page.getByRole('button', { name: 'Skip tour' }).click()
}

/** Play the current hand to the end, locking a read and calling or checking. */
export async function playHand(page: Page) {
  for (let i = 0; i < 80; i++) {
    if (await page.locator('.action-done').count()) return
    if (await page.locator('.guess-bar').count()) {
      await page.getByRole('button', { name: /Lock in/ }).click()
      continue
    }
    const call = page.locator('.act-call:not([disabled])')
    if (await call.count()) {
      await call.click()
      continue
    }
    await page.waitForTimeout(250)
  }
  await expect(page.locator('.action-done')).toBeVisible()
}

type Row = Record<string, unknown>

/**
 * A stand-in account service for the public pages: /api/config points the
 * app at a fake Supabase that answers table reads (PostgREST filters eq, neq
 * and in, order, limit) and RPCs from the rows given. Nothing leaves the
 * browser.
 */
export async function fakeAccountService(
  page: Page,
  {
    tables = {},
    rpc = {},
  }: {
    tables?: Record<string, Row[]>
    rpc?: Record<string, (args: Record<string, unknown>) => unknown>
  },
) {
  const url = 'https://accounts.e2e.test'
  await page.route('**/api/config', (route) =>
    route.fulfill({
      json: { supabaseUrl: url, supabaseKey: 'e2e-publishable-key' },
    }),
  )
  await page.route(`${url}/**`, async (route) => {
    const at = new URL(route.request().url())
    const fn = at.pathname.match(/^\/rest\/v1\/rpc\/(\w+)$/)?.[1]
    if (fn && rpc[fn])
      return route.fulfill({
        json: rpc[fn](route.request().postDataJSON() ?? {}),
      })
    const table = at.pathname.match(/^\/rest\/v1\/(\w+)$/)?.[1]
    if (!table || !tables[table])
      return route.fulfill({ status: 404, json: { message: 'not here' } })
    let found = tables[table]
    let limit = Infinity
    for (const [key, value] of at.searchParams) {
      if (key === 'select') continue
      if (key === 'limit') limit = Number(value)
      else if (key === 'order') {
        const [column, dir] = value.split('.')
        found = [...found].sort(
          (a, b) =>
            (String(a[column]) < String(b[column]) ? -1 : 1) *
            (dir === 'desc' ? -1 : 1),
        )
      } else {
        const [op, ...rest] = value.split('.')
        const arg = rest.join('.')
        const list = arg.replace(/^\(|\)$/g, '').split(',')
        found = found.filter((r) => {
          const v = String(r[key])
          return op === 'eq'
            ? v === arg
            : op === 'neq'
              ? v !== arg
              : op === 'in'
                ? list.includes(v)
                : true
        })
      }
    }
    return route.fulfill({ json: found.slice(0, limit) })
  })
}

/** Ladder rows for `players` generated players, keyset-paged like the SQL. */
export async function fakeLadder(page: Page, players = 120) {
  const rows = Array.from({ length: players }, (_, i) => {
    const n = i + 1
    return {
      user_id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
      username: `player${n}`,
      rating: 2100 - n * 4.5,
      rd: 55 + (n % 40),
      matches: 20 + n,
      wins: 10 + Math.floor(n / 2),
      draws: n % 3,
      accuracy: n % 9 === 0 ? null : 64 + (n % 15),
      trend: n % 4 === 0 ? null : n % 2 ? 14.2 : -6.8,
    }
  })
  const page_ = (listed: typeof rows) => (args: Record<string, unknown>) => {
    const after = args.p_after_rating as number | null
    const start =
      after === null
        ? 0
        : listed.findIndex(
            (r) =>
              r.rating < after ||
              (r.rating === after && r.user_id > String(args.p_after_user)),
          )
    const size = Math.min(args.p_page as number, 100)
    return start < 0 ? [] : listed.slice(start, start + size)
  }
  await fakeAccountService(page, {
    rpc: { ladder: page_(rows), ladder_month: page_(rows.slice(0, 30)) },
  })
}

const MATCH_ID = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`

/**
 * A profile to open at /u/alice: 25 rated matches with a rating history and
 * opponents, and one match with two hands to review (a showdown and a
 * fold), as the public archive holds them.
 */
export async function fakeProfile(page: Page) {
  const alice = '00000000-0000-4000-8000-00000000000a'
  const rival = (n: number) =>
    `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  const day = (n: number) =>
    new Date(Date.UTC(2026, 8, 1) + n * 86_400_000).toISOString()
  const history = Array.from({ length: 25 }, (_, i) => ({
    user_id: alice,
    format: 'hu-duplicate',
    kind: 'match',
    match_id: MATCH_ID(i + 1),
    outcome: i % 3 === 0 ? 'loss' : 'win',
    before_rating: 1500 + i * 5,
    before_rd: 300 - i * 9,
    after_rating: 1505 + i * 5,
    after_rd: 291 - i * 9,
    created_at: day(i),
    played_at: day(i),
  }))
  const hand = (handNo: number, showdown: boolean) => ({
    v: 1,
    matchId: MATCH_ID(25),
    handNo,
    segment: 1,
    config: {
      handNo,
      seats: [
        { seat: 0, stack: 2000 },
        { seat: 1, stack: 2000 },
      ],
      button: 0,
      blinds: { sb: 10, bb: 20 },
    },
    seats: [
      { seat: 0, userId: alice, username: 'alice' },
      { seat: 1, userId: rival(25), username: 'rival25' },
    ],
    commitment: 'ab'.repeat(32),
    actions: showdown
      ? [
          {
            seat: 0,
            action: { type: 'call' },
            street: 'preflop',
            boardCount: 0,
            amount: 10,
            toCall: 10,
            pot: 30,
            canRaise: true,
            atMs: 0,
            decisionMs: 900,
            source: 'client',
          },
          {
            seat: 1,
            action: { type: 'check' },
            street: 'preflop',
            boardCount: 0,
            amount: 0,
            toCall: 0,
            pot: 40,
            canRaise: true,
            atMs: 0,
            decisionMs: 700,
            source: 'client',
          },
        ]
      : [
          {
            seat: 0,
            action: { type: 'fold' },
            street: 'preflop',
            boardCount: 0,
            amount: 0,
            toCall: 10,
            pot: 30,
            canRaise: true,
            atMs: 0,
            decisionMs: 500,
            source: 'timeout',
          },
        ],
    board: showdown ? [0, 13, 26, 39, 4] : [],
    shown: showdown
      ? [
          { seat: 0, cards: [12, 25] },
          { seat: 1, cards: [1, 2] },
        ]
      : [],
    awards: [],
    netBySeat: showdown ? { 0: 20, 1: -20 } : { 0: -10, 1: 10 },
    showdown,
  })
  await fakeAccountService(page, {
    tables: {
      players: [
        {
          user_id: alice,
          username: 'alice',
          country: 'GB',
          bio: 'Studying statistics',
          created_at: day(-10),
        },
        ...Array.from({ length: 25 }, (_, i) => ({
          user_id: rival(i + 1),
          username: `rival${i + 1}`,
        })),
      ],
      ratings: [
        {
          user_id: alice,
          format: 'hu-duplicate',
          rating: 1625.4,
          rd: 64,
          matches: 25,
          wins: 16,
          draws: 0,
          abandoned: 1,
          last_match_at: day(25),
        },
      ],
      rating_history: history,
      match_players: history.flatMap((h, i) => [
        { match_id: h.match_id, user_id: alice, seat: 0, outcome: h.outcome },
        {
          match_id: h.match_id,
          user_id: rival(i + 1),
          seat: 1,
          outcome: h.outcome === 'win' ? 'loss' : 'win',
        },
      ]),
      matches: history.map((h) => ({
        id: h.match_id,
        kind: 'hu-rated',
        status: 'finished',
        finished_at: h.created_at,
      })),
      hands: [
        {
          match_id: MATCH_ID(25),
          hand_no: 1,
          record: hand(1, true),
          verified: true,
        },
        {
          match_id: MATCH_ID(25),
          hand_no: 2,
          record: hand(2, false),
          verified: true,
        },
      ],
      accuracy: [],
    },
    rpc: { rated_luck: () => [] },
  })
}
