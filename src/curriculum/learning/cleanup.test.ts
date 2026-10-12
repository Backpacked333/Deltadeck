// @vitest-environment node
import { createServer } from 'node:http'
import { buildSync } from 'esbuild'
import { chromium, type Browser, type Page } from 'playwright'
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest'
import type * as Cleanup from './cleanup'
import type * as Outbox from '../../net/syncOutbox'
declare global {
  interface Window {
    learningCleanup: typeof Cleanup
    learningOutbox: typeof Outbox
  }
}
let browser: Browser, page: Page, url: string
const enabled = process.env.INDEXEDDB_BROWSER_TESTS === '1'
const server = createServer((_req, res) =>
  res.end('<!doctype html><title>Evidence deletion API test</title>'),
)
beforeAll(async () => {
  if (!enabled) return
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  })
}, 30000)
beforeEach(async () => {
  if (!enabled) return
  if (page) await page.context().close()
  page = await browser.newPage()
  await page.goto(url)
  for (const [path, name] of [
    ['src/curriculum/learning/cleanup.ts', 'learningCleanup'],
    ['src/net/syncOutbox.ts', 'learningOutbox'],
  ])
    await page.addScriptTag({
      content: buildSync({
        entryPoints: [path],
        bundle: true,
        format: 'iife',
        globalName: name,
        write: false,
      }).outputFiles[0]!.text,
    })
})
afterAll(async () => {
  await browser?.close()
  if (server.listening) await new Promise<void>((r) => server.close(() => r()))
})
describe.skipIf(!enabled)(
  'F09 real IndexedDB deletion fences (no application UI)',
  () => {
    it('retires explicitly deleted practice dependencies and jobs atomically, preserving curriculum work', async () => {
      const result = await page.evaluate(async () => {
        const scope = { accountId: 'A', epoch: 1 },
          box = new window.learningOutbox.DurableOutbox(scope, 0, async () => {
            throw Error('offline')
          })
        await box.enqueue('p', {
          kind: 'submission',
          source: 'practice',
          practice: { practiceGeneration: 0 },
        })
        await box.enqueue('e', { kind: 'evaluation', submissionId: 'p' })
        await box.enqueue('r', {
          kind: 'recommendation',
          practiceGeneration: 0,
        })
        await box.enqueue('f', { kind: 'feedback', recommendationId: 'r' })
        await box.enqueue('c', { kind: 'submission', source: 'curriculum' })
        box.stop(scope)
        await window.learningCleanup.cleanupDeletedEvidence(
          scope,
          { learning: 0, practice: 1 },
          () => true,
        )
        const stored = JSON.parse(await (await box.exportAccount(scope)).text())
        return {
          events: stored.events.map((e: { id: string }) => e.id),
          jobs: stored.jobs.map((e: { id: string }) => e.id),
        }
      })
      expect(result).toEqual({ events: ['c'], jobs: ['c'] })
    })
    it('account/epoch fences prevent stale cleanup; explicit learning deletion removes only that account', async () => {
      const result = await page.evaluate(async () => {
        const a = { accountId: 'A', epoch: 2 },
          b = { accountId: 'B', epoch: 3 }
        const writer = async () => {
          throw Error('offline')
        }
        const first = new window.learningOutbox.DurableOutbox(a, 0, writer),
          second = new window.learningOutbox.DurableOutbox(b, 0, writer)
        await first.enqueue('a', { kind: 'submission' })
        await second.enqueue('b', { kind: 'submission' })
        first.stop(a)
        second.stop(b)
        let stale = false,
          changed = false
        try {
          await window.learningCleanup.cleanupDeletedEvidence(
            { ...a, epoch: 1 },
            { learning: 1, practice: 0 },
            () => true,
          )
        } catch {
          stale = true
        }
        try {
          await window.learningCleanup.cleanupDeletedEvidence(
            a,
            { learning: 1, practice: 0 },
            () => false,
          )
        } catch {
          changed = true
        }
        const before = JSON.parse(await (await first.exportAccount(a)).text())
          .events.length
        await window.learningCleanup.cleanupDeletedEvidence(
          a,
          { learning: 1, practice: 0 },
          () => true,
        )
        return {
          stale,
          changed,
          before,
          after: JSON.parse(await (await first.exportAccount(a)).text()).events
            .length,
          other: JSON.parse(await (await second.exportAccount(b)).text()).events
            .length,
        }
      })
      expect(result).toEqual({
        stale: true,
        changed: true,
        before: 1,
        after: 0,
        other: 1,
      })
    })
  },
)
