// @vitest-environment node
import { createServer } from 'node:http'
import { buildSync } from 'esbuild'
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type * as API from './syncOutbox'

declare global { interface Window { outboxAPI: typeof API } }
let browser: Browser, page: Page, url: string
const enabled = process.env.INDEXEDDB_BROWSER_TESTS === '1'
const server = createServer((_req, res) => res.end('<!doctype html><title>IndexedDB API tests</title>'))
const bundle = buildSync({ entryPoints: ['src/net/syncOutbox.ts'], bundle: true, format: 'iife', globalName: 'outboxAPI', write: false }).outputFiles[0]!.text
beforeAll(async () => {
  if (!enabled) return
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH })
}, 30_000)
beforeEach(async () => {
  if (!enabled) return
  if (page) await page.context().close()
  page = await browser.newPage(); await page.goto(url); await page.addScriptTag({ content: bundle })
})
afterAll(async () => { await browser?.close(); if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve())) })

describe.skipIf(!enabled)('F08–F10 real IndexedDB API (headless, no application UI)', () => {
  it('F08 event+job commit atomically; immutable IDs dedupe; exact ACK', async () => {
    const result = await page.evaluate(async () => {
      const { DurableOutbox } = window.outboxAPI, scope = { accountId: 'A', epoch: 1 }
      const writer = async (e: API.DurableEvent): Promise<API.EventAck> => ({ status: 'accepted', id: e.id, digest: e.digest, deletionGeneration: e.deletionGeneration })
      const box = new DurableOutbox(scope, 0, writer)
      const first = await box.enqueue('attempt-1', { answer: 42 }), duplicate = await box.enqueue('attempt-1', { answer: 42 })
      const result = await box.flush(await box.barrier(scope), 1000)
      const saved = JSON.parse(await (await box.exportAccount(scope)).text())
      let reused = false
      try { await box.enqueue('attempt-1', { answer: 99 }) } catch { reused = true }
      box.stop(scope)
      return { result, first, duplicate, saved, reused }
    })
    expect(result.result.status).toBe('saved')
    expect(result.first).toEqual(result.duplicate)
    expect(result.saved.events).toHaveLength(1); expect(result.saved.jobs).toHaveLength(1)
    expect(result.saved.jobs[0].state).toBe('acked'); expect(result.reused).toBe(true)
  })
  it('F08 quota/transaction failure rolls back the event and does not report saved', async () => {
    const result = await page.evaluate(async () => {
      const scope = { accountId: 'A', epoch: 1 }, box = new window.outboxAPI.DurableOutbox(scope, 0, async () => { throw new Error('offline') })
      await box.barrier(scope)
      const add = IDBObjectStore.prototype.add
      IDBObjectStore.prototype.add = function (...args) {
        if (this.name === 'jobs') throw new DOMException('full', 'QuotaExceededError')
        return add.apply(this, args)
      }
      let failed = false
      try { await box.enqueue('atomic', { private: 'event' }) } catch { failed = true }
      finally { IDBObjectStore.prototype.add = add }
      const exported = JSON.parse(await (await box.exportAccount(scope)).text())
      const status = box.status(); box.stop(scope)
      return { failed, exported, status }
    })
    expect(result.failed).toBe(true); expect(result.status).toBe('blocked')
    expect(result.exported.events).toHaveLength(0); expect(result.exported.jobs).toHaveLength(0)
    expect(result.exported.failedEnqueues).toMatchObject([{ id: 'atomic', payload: { private: 'event' } }])
  })
  it('F08 barrier waits for already-started event serialization instead of reporting an empty queue saved', async () => {
    const result = await page.evaluate(async () => {
      const scope = { accountId: 'A', epoch: 1 }, box = new window.outboxAPI.DurableOutbox(scope, 0, async (e) => ({ status: 'accepted', id: e.id, digest: e.digest, deletionGeneration: 0 }))
      await box.barrier(scope)
      const original = crypto.subtle.digest.bind(crypto.subtle)
      let release!: () => void; const gate = new Promise<void>((r) => { release = r })
      crypto.subtle.digest = async (...args) => { await gate; return original(...args) }
      const creating = box.enqueue('serializing', { event: 'pending digest' })
      let finished = false
      const capturing = box.barrier(scope).then((barrier) => { finished = true; return barrier })
      await new Promise((r) => setTimeout(r, 10))
      const before = { finished, status: box.status() }
      release(); await creating; crypto.subtle.digest = original
      const barrier = await capturing, result = await box.flush(barrier, 1000)
      box.stop(scope); return { before, result, barrier }
    })
    expect(result.before).toEqual({ finished: false, status: 'saving' })
    expect(result.barrier.targets).toHaveLength(1); expect(result.result.status).toBe('saved')
  })
  it('F08 false ACK backs off with pending event intact; fresh retry succeeds', async () => {
    const result = await page.evaluate(async () => {
      const scope = { accountId: 'A', epoch: 1 }; let now = 100, bad = true, sends = 0
      const box = new window.outboxAPI.DurableOutbox(scope, 0, async (e) => {
        sends++; return { status: 'accepted', id: e.id, digest: bad ? 'wrong' : e.digest, deletionGeneration: 0 }
      }, indexedDB, () => now)
      await box.enqueue('retry', { x: 1 })
      const barrier = await box.barrier(scope), failed = await box.flush(barrier, 100)
      await box.flush(barrier, 100)
      const before = sends
      now += 5000; bad = false
      const saved = await box.flush(barrier, 1000)
      box.stop(scope)
      return { failed, saved, before, sends }
    })
    expect(result.failed.status).toBe('timeout'); expect(result.before).toBe(1)
    expect(result.saved.status).toBe('saved'); expect(result.sends).toBe(2)
  })
  it('F10 restart replays leased jobs with new epoch, no event loss', async () => {
    await page.evaluate(async () => {
      const scope = { accountId: 'A', epoch: 1 }
      const box = new window.outboxAPI.DurableOutbox(scope, 0, () => new Promise(() => {}))
      await box.enqueue('restart', { evidence: true })
      await box.flush(await box.barrier(scope), 10)
    })
    await page.reload(); await page.addScriptTag({ content: bundle })
    const result = await page.evaluate(async () => {
      const scope = { accountId: 'A', epoch: 2 }
      const box = new window.outboxAPI.DurableOutbox(scope, 0, async (e) => ({ status: 'accepted', id: e.id, digest: e.digest, deletionGeneration: 0 }))
      const barrier = await box.barrier(scope), result = await box.flush(barrier, 1000)
      box.stop(scope); return { result, barrier }
    })
    expect(result.barrier.targets).toHaveLength(1); expect(result.result.status).toBe('saved')
  })
  it('F10 old ACK cannot mutate a new account epoch or resurrect after privacy cleanup', async () => {
    const result = await page.evaluate(async () => {
      const { DurableOutbox } = window.outboxAPI, scope = { accountId: 'A', epoch: 1 }
      let release!: (ack: API.EventAck) => void, sent!: API.DurableEvent
      let entered!: () => void; const started = new Promise<void>((r) => { entered = r })
      const first = new DurableOutbox(scope, 0, async (e) => { sent = e; entered(); return new Promise((r) => { release = r }) })
      await first.enqueue('private-A', { notes: 'secret' }); const barrier = await first.barrier(scope)
      const pending = first.flush(barrier, 1000); await started
      await first.clearAccount(scope)
      const second = new DurableOutbox({ accountId: 'B', epoch: 2 }, 0, async () => { throw new Error('offline') })
      await second.enqueue('private-B', { notes: 'different' })
      release({ status: 'accepted', id: sent.id, digest: sent.digest, deletionGeneration: 0 })
      const late = await pending
      const db = await window.outboxAPI.openOutbox()
      const tx = db.transaction('events'), rows = await new Promise<API.DurableEvent[]>((r) => { const q = tx.objectStore('events').getAll(); q.onsuccess = () => r(q.result) })
      db.close(); second.stop(second.scope)
      return { late, accounts: rows.map((r) => r.accountId) }
    })
    expect(result.late.status).toBe('account_changed'); expect(result.accounts).toEqual(['B'])
  })
  it('F09 old generation and future event schema remain exportable but never upload', async () => {
    const result = await page.evaluate(async () => {
      const { DurableOutbox, openOutbox } = window.outboxAPI, scope = { accountId: 'A', epoch: 1 }
      const old = new DurableOutbox(scope, 0, async () => { throw new Error('offline') })
      await old.enqueue('old', { evidence: 1 }); await old.enqueue('future', { evidence: 2 }); old.stop(scope)
      const db = await openOutbox(), tx = db.transaction('events', 'readwrite'), store = tx.objectStore('events')
      const q = store.get(['A', 'future']); q.onsuccess = () => store.put({ ...q.result, schema: 99 })
      await new Promise<void>((r) => { tx.oncomplete = () => r() }); db.close()
      let sends = 0
      const current = new DurableOutbox({ accountId: 'A', epoch: 2 }, 1, async () => { sends++; throw new Error('must not send') })
      const result = await current.flush(await current.barrier(current.scope), 1000)
      const data = JSON.parse(await (await current.exportAccount(current.scope)).text())
      current.stop(current.scope); return { sends, result, data }
    })
    expect(result.sends).toBe(0); expect(result.result.status).toBe('blocked')
    expect(result.data.events).toHaveLength(2)
  })
  it('F10 a stale cleanup cannot remove events from a newer epoch of the same account', async () => {
    const result = await page.evaluate(async () => {
      const { DurableOutbox } = window.outboxAPI, writer = async () => { throw new Error('offline') }
      const first = new DurableOutbox({ accountId: 'A', epoch: 1 }, 0, writer)
      await first.enqueue('old', { answer: 1 }); first.stop(first.scope)
      const next = new DurableOutbox({ accountId: 'A', epoch: 2 }, 0, writer)
      await next.enqueue('new', { answer: 2 })
      let rejected = false
      try { await first.clearAccount(first.scope) } catch { rejected = true }
      const saved = JSON.parse(await (await next.exportAccount(next.scope)).text())
      next.stop(next.scope); return { rejected, ids: saved.events.map((e: API.DurableEvent) => e.id) }
    })
    expect(result.rejected).toBe(true); expect(result.ids.sort()).toEqual(['new', 'old'])
  })
  it('F09 future database schema blocks writes but has a read-only account recovery export', async () => {
    const result = await page.evaluate(async () => {
      const { OUTBOX_DB, DurableOutbox, openOutbox } = window.outboxAPI
      const original = await openOutbox(); original.close()
      const opening = indexedDB.open(OUTBOX_DB, 2)
      const db = await new Promise<IDBDatabase>((resolve) => { opening.onsuccess = () => resolve(opening.result) })
      const tx = db.transaction('events', 'readwrite')
      tx.objectStore('events').put({ schema: 2, accountId: 'A', id: 'recover', private: 'preserved' })
      tx.objectStore('events').put({ schema: 2, accountId: 'B', id: 'other', private: 'never export another account' })
      await new Promise<void>((r) => { tx.oncomplete = () => r() }); db.close()
      const scope = { accountId: 'A', epoch: 1 }, box = new DurableOutbox(scope, 0, async () => { throw new Error('must not write') })
      let blocked = false
      try { await box.barrier(scope) } catch { blocked = true }
      const data = JSON.parse(await (await box.exportAccount(scope)).text()); box.stop(scope)
      return { blocked, data }
    })
    expect(result.blocked).toBe(true)
    expect(result.data.recovery.databaseVersion).toBe(2)
    expect(result.data.recovery.stores.events).toEqual([{ schema: 2, accountId: 'A', id: 'recover', private: 'preserved' }])
  })
})
