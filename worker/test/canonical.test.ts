// The site has one address: a page asked for on another host (the old
// workers.dev address, www) moves there for good, path and query kept. APIs
// and sockets answer wherever they are asked, so open tabs keep working.
import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { canonicalRedirect } from '../src/canonical'
import { ORIGIN } from './helpers'

const SITE = 'https://deltadeck.net'
const OLD = 'https://quantpoker.bbcroysalman.workers.dev'
const moved = (url: string, init?: RequestInit) =>
  canonicalRedirect(new Request(url, init), SITE)

describe('canonicalRedirect', () => {
  it.each([
    [`${OLD}/`, `${SITE}/`],
    [`${OLD}/?ref=share`, `${SITE}/?ref=share`],
    [`${OLD}/u/alice`, `${SITE}/u/alice`],
    [
      `${OLD}/c/0123456789abcdef0123456789abcdef`,
      `${SITE}/c/0123456789abcdef0123456789abcdef`,
    ],
    ['https://www.deltadeck.net/?code=abc', `${SITE}/?code=abc`],
  ])('moves %s to %s with a 301', (from, to) => {
    const response = moved(from)
    expect(response?.status).toBe(301)
    expect(response?.headers.get('Location')).toBe(to)
  })

  it('moves a HEAD as well as a GET, and nothing that sends data', () => {
    expect(moved(`${OLD}/`, { method: 'HEAD' })?.status).toBe(301)
    expect(moved(`${OLD}/c/x`, { method: 'POST' })).toBeNull()
  })

  it.each([
    ['the canonical site', `${SITE}/u/alice`],
    ['an API', `${OLD}/api/health`],
    ['a socket', `${OLD}/ws/lobby`],
    ['a local server', 'http://localhost:8787/'],
    ['a local address', 'http://127.0.0.1:8787/'],
    ['a preview URL', 'https://my-branch-quantpoker.bbcroysalman.workers.dev/'],
    ['a version URL', 'https://1a2b3c4d-quantpoker.bbcroysalman.workers.dev/'],
  ])('leaves %s where it is', (_, url) => {
    expect(moved(url)).toBeNull()
  })

  it('moves nothing when no canonical address is set', () => {
    expect(canonicalRedirect(new Request(`${OLD}/`), undefined)).toBeNull()
  })
})

describe('the Worker', () => {
  it('moves the page on another host and answers its API there', async () => {
    const page = await SELF.fetch('https://quantpoker.example/?ref=x', {
      redirect: 'manual',
    })
    expect(page.status).toBe(301)
    expect(page.headers.get('Location')).toBe(`${ORIGIN}/?ref=x`)

    const health = await SELF.fetch('https://quantpoker.example/api/health')
    expect(health.status).toBe(200)
  })
})
