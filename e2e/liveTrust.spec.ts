import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import type { Page, WebSocketRoute } from '@playwright/test'
import { act } from '../src/engine/hand'
import type {
  ClientMsg,
  HandCompletionV1,
  ServerMsg,
} from '../src/shared/protocol'
import {
  finishedHand,
  firstHand,
  frame,
  MATCH,
  sixFrame,
  sixHand,
} from '../src/net/testing'
import type { TimingSample } from '../src/net/liveTiming'
import { devSignIn } from './sixTable'

type Snapshot = Extract<ServerMsg, { t: 'welcome' | 'state' }>
type TimingWindow = Window & { trustTiming?: TimingSample[] }
test.use({ viewport: { width: 1366, height: 768 } })

async function harness(page: Page, initial: Snapshot) {
  await devSignIn(page, 'trust_fixture')
  await page.route('**/api/me', (route) =>
    route.fulfill({ json: { activeMatch: null } }),
  )
  await page.addInitScript(() => {
    const target = window as TimingWindow
    target.trustTiming = []
    window.addEventListener('qp:live-timing', (event) =>
      target.trustTiming!.push((event as CustomEvent<TimingSample>).detail),
    )
  })
  let socket: WebSocketRoute
  let current = initial
  const received: ClientMsg[] = []
  await page.routeWebSocket(/\/ws\/table\//, (ws) => {
    socket = ws
    ws.send(JSON.stringify(current))
    ws.onMessage((raw) => {
      if (String(raw) === 'ping') {
        ws.send('pong')
        return
      }
      const message = JSON.parse(String(raw)) as ClientMsg
      received.push(message)
      if (message.t === 'resync') ws.send(JSON.stringify(current))
      if (message.t === 'command_status')
        ws.send(
          JSON.stringify({
            t: 'command_outcome',
            v: 1,
            commandId: message.commandId,
            disposition: 'unknown',
            effect: 'none',
            reason: 'not_found',
            scope: current.ownControl?.scope ?? null,
            stateVersion: current.seq,
            seq: current.seq,
            matchId: MATCH,
          }),
        )
    })
  })
  await page.goto(`/#play/${MATCH}`)
  await expect(page.locator('.live-table')).toBeVisible()
  return {
    received,
    send(message: ServerMsg) {
      if (message.t === 'welcome' || message.t === 'state') current = message
      socket.send(JSON.stringify(message))
    },
  }
}

function ourTurn(): Snapshot {
  let hand = sixHand()
  hand = act(hand, 5, { type: 'call' })
  hand = act(hand, 0, { type: 'call' })
  return sixFrame('welcome', 1, 2, 2, hand) as Snapshot
}

test('stand unknown preserves actions, keyboard focus and identical retry at laptop size', async ({
  page,
}) => {
  const table = await harness(page, ourTurn())
  const stand = page.getByRole('button', { name: 'Stand up' })
  const call = page.getByRole('button', { name: /^Call / })
  await expect(call).toBeEnabled()
  const bounds = await call.boundingBox()
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(768)
  await stand.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByText(/Stand: request sent/)).toBeVisible()
  await expect(call).toBeEnabled()
  await expect(page.locator('.six-seat[data-slot="0"]')).toBeFocused()
  await expect(page.getByText(/Stand: outcome unknown/)).toBeVisible({
    timeout: 8000,
  })
  const retry = page.getByRole('button', { name: 'Retry same request' })
  await expect(retry).toBeEnabled()
  const waitingBounds = await call.boundingBox()
  expect(waitingBounds!.y + waitingBounds!.height).toBeLessThanOrEqual(768)
  const feltBounds = await page.locator('.six-ring').boundingBox()
  const dockBounds = await page.locator('.six-dock').boundingBox()
  expect(dockBounds!.y + dockBounds!.height).toBeLessThan(
    feltBounds!.y + feltBounds!.height,
  )
  await retry.click()
  const commands = table.received.filter((m) => m.t === 'seat_command')
  expect(commands).toHaveLength(2)
  expect(commands[1]).toEqual(commands[0])
  const report = await new AxeBuilder({ page }).include('.live-table').analyze()
  expect(
    report.violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    ),
  ).toEqual([])
  const samples = await page.evaluate(
    () => (window as TimingWindow).trustTiming!,
  )
  const initialFrame = samples.find((s) => s.phase === 'frame')!
  const render = samples.find(
    (s) => s.phase === 'render' && s.frameId === initialFrame.frameId,
  )!
  expect(render.at).toBeGreaterThanOrEqual(initialFrame.at)
  expect(render.identity.handNo).toBe(1)
  expect(
    samples.some(
      (s) => s.phase === 'intent' && s.requestId === commands[0].commandId,
    ),
  ).toBe(true)
})

test('pre-deal cancellation losing the deal race never claims successful release', async ({
  page,
}) => {
  const initial = frame('welcome', 1, 0, null) as Snapshot
  const now = Date.now()
  initial.start = {
    activationId: 'activation-1',
    deadlineAt: now + 30_000,
    waitingForHost: true,
  }
  initial.presentation = {
    completion: null,
    currentDecision: null,
    serverNow: now,
  }
  const table = await harness(page, initial)
  await expect(
    page.getByText(/Waiting for host — your seat is reserved/),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Cancel before deal' }).click()
  await expect(
    page.getByText(/Cancel sent — awaiting confirmation/),
  ).toBeVisible()
  const cancel = table.received.find((m) => m.t === 'cancel_start')!
  const dealt = frame('state', 2, 0, firstHand())
  table.send(dealt)
  table.send({
    t: 'cancel_start_result',
    commandId: cancel.commandId,
    status: 'game_started',
    stateVersion: 2,
    seq: 2,
    matchId: MATCH,
  })
  await expect(page.getByText(/The deal won the race/)).toBeVisible()
  await expect(page.getByText(/Start cancelled by the table/)).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Call / })).toBeEnabled()
})

test('late completion stays in immutable Last hand while the current decision is immediately playable', async ({
  page,
}) => {
  const { hand, record } = await finishedHand()
  const key = { tableId: MATCH, matchId: MATCH, handNo: 1 }
  const completion: HandCompletionV1 = {
    v: 1,
    hand: key,
    terminalStateVersion: 9,
    completedAt: 100_000,
    resultAvailable: true,
    final: {
      hand: key,
      board: record.board,
      shown: record.shown,
      participants: [
        { seat: 0, seatGeneration: 1, username: 'alice' },
        { seat: 1, seatGeneration: 1, username: 'bob' },
      ],
      stacksBySeat: {},
      pots: [],
      awards: record.awards,
      netBySeat: record.netBySeat,
      showdown: record.showdown,
    },
    schedule: {
      version: 'completion.v1',
      shape: 'all_in_preflop',
      beats: [
        { offsetMs: 900, boardCount: 3 },
        { offsetMs: 1800, boardCount: 4 },
        { offsetMs: 3200, boardCount: 5 },
      ],
      resultHoldMs: 1500,
      earliestNextDealAt: 104_700,
    },
  }
  const initial = frame('welcome', 9, 0, hand) as Snapshot
  initial.presentation = {
    completion,
    currentDecision: null,
    serverNow: 110_000,
  }
  const table = await harness(page, initial)
  await expect(page.getByText(/Last hand · 1 · Showdown/)).toBeVisible()
  const nextHand = firstHand()
  nextHand.config.handNo = 2
  const next = frame('state', 10, 0, nextHand) as Snapshot
  next.presentation = {
    completion,
    serverNow: 110_100,
    currentDecision: {
      decision: { ...key, handNo: 2, actionIndex: 0, seat: 0 },
      stateVersion: 10,
      startedAt: 110_100,
      deadlineAt: 130_100,
    },
  }
  table.send(next)
  await expect(page.getByRole('button', { name: /^Call / })).toBeEnabled()
  await page.getByText(/Last hand · 1 · Showdown/).click()
  await expect(page.locator('.live-last-hand')).toContainText('alice:')
  await expect(page.getByRole('button', { name: /^Call / })).toBeEnabled()
  await expect(page.locator('.live-phase')).toHaveCount(0)
})
