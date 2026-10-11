// GET /u/<username>: the app page with that player's link preview. Profiles
// are public; the preview says only the name and rating ± RD, escaped, and
// one read per name per minute reaches Supabase.
import { env } from 'cloudflare:test'
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { OG_IMAGE, profilePage } from '../src/profile'

const SITE = 'https://quantpoker.test'
/** The built index.html's head, as far as the preview is concerned. */
const APP = `<!doctype html><html lang="en"><head>
<meta name="description" content="Learn the mathematics of risk." />
<meta property="og:type" content="website" />
<meta property="og:title" content="DeltaDeck" />
<meta property="og:description" content="Learn the mathematics of risk." />
<meta property="og:url" content="/" />
<meta property="og:image" content="/og-default.png" />
<title>DeltaDeck — Play your way to a better understanding.</title>
</head><body><div id="root"></div><script type="module" src="/assets/index.js"></script></body></html>`

const assets = {
  fetch: async () =>
    new Response(APP, {
      headers: {
        'Content-Type': 'text/html',
        ETag: '"index-html"',
        'Last-Modified': 'Fri, 09 Oct 2026 00:00:00 GMT',
      },
    }),
} as unknown as Fetcher

type Row = {
  username: string
  ratings: { rating: number; rd: number; matches: number }[]
  /** The name it is found by, when the stored one differs (a forged row). */
  key?: string
}
let players: Row[] = []
let asked: URL[] = []
let down = false
let n = 0
let cache: Cache

beforeAll(() => {
  const realFetch = globalThis.fetch
  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.origin !== new URL(env.SUPABASE_URL).origin)
        return realFetch(input, init)
      asked.push(url)
      expect(new Headers(init?.headers).get('apikey')).toBe(
        env.SUPABASE_PUBLISHABLE_KEY,
      )
      if (down) return new Response('down', { status: 503 })
      const name = url.searchParams.get('username')!.slice(3)
      return Response.json(
        players
          .filter((p) => (p.key ?? p.username) === name)
          .map(({ username, ratings }) => ({ username, ratings })),
      )
    },
  )
})
afterAll(() => vi.unstubAllGlobals())
beforeEach(async () => {
  players = [
    { username: 'alice', ratings: [{ rating: 1612.4, rd: 63.6, matches: 48 }] },
    { username: 'bob', ratings: [{ rating: 1540, rd: 121, matches: 13 }] },
    { username: 'carol', ratings: [] },
  ]
  asked = []
  down = false
  // A fresh edge cache for every test.
  cache = await caches.open(`profiles-${n++}`)
})

const get = (path: string) =>
  profilePage(new Request(`${SITE}${path}`), env, { assets, cache })

/** The value of a preview tag in the page. */
function tag(html: string, property: string) {
  const at = html.match(
    new RegExp(`<meta (?:property|name)="${property}" content="([^"]*)"`),
  )
  return at?.[1] ?? null
}

describe('GET /u/<username>', () => {
  it('GET /u/alice returns the app with og:title "alice · DeltaDeck" and the rating in og:description', async () => {
    const response = await get('/u/alice')
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain('<div id="root"></div>')
    expect(html).toContain('<title>alice · DeltaDeck</title>')
    expect(tag(html, 'og:title')).toBe('alice · DeltaDeck')
    expect(tag(html, 'og:description')).toBe(
      'Rating 1612 ± 64 over 48 rated heads-up matches on DeltaDeck.',
    )
    expect(tag(html, 'description')).toBe(tag(html, 'og:description'))
    expect(tag(html, 'og:type')).toBe('profile')
    expect(tag(html, 'og:url')).toBe(`${SITE}/u/alice`)
    // Not index.html's validators: the body is this player's page.
    expect(response.headers.get('ETag')).toBeNull()
    expect(response.headers.get('Last-Modified')).toBeNull()
    expect(response.headers.get('Content-Type')).toContain('text/html')
    expect(asked).toHaveLength(1)
    expect(asked[0].pathname).toBe('/rest/v1/players')
    expect(asked[0].searchParams.get('username')).toBe('eq.alice')
  })

  it('og:image points at the share card, as an absolute URL', async () => {
    const html = await (await get('/u/alice')).text()
    expect(tag(html, 'og:image')).toBe(`${SITE}${OG_IMAGE}`)
    expect(OG_IMAGE).toBe('/og-default.png')
  })

  it('says provisional, or nothing about a rating, when that is the truth', async () => {
    expect(tag(await (await get('/u/bob')).text(), 'og:description')).toBe(
      'Provisional rating 1540 ± 121 after 13 rated heads-up matches on DeltaDeck.',
    )
    expect(tag(await (await get('/u/carol')).text(), 'og:description')).toBe(
      'carol plays rated heads-up poker on DeltaDeck.',
    )
  })

  it('an unknown user is a 404 with the app and a generic preview; an impossible name is not looked up', async () => {
    const missing = await get('/u/nobody')
    expect(missing.status).toBe(404)
    const html = await missing.text()
    expect(html).toContain('<div id="root"></div>')
    expect(tag(html, 'og:title')).toBe('DeltaDeck')
    asked = []
    for (const path of ['/u/Alice', '/u/a', '/u/alice/x', '/u/al%22ice'])
      expect((await get(path)).status).toBe(404)
    expect(asked).toHaveLength(0)
  })

  it('a username or bio cannot inject markup into meta tags', async () => {
    // Names are [a-z0-9_]{3,20} in the database, and the preview uses the
    // name from the path, checked against the same pattern; a stored row
    // that broke the rule still puts nothing of its own in the page.
    const forged = '"><script>alert(1)</script>'
    players.push({ key: 'evil', username: `evil${forged}`, ratings: [] })
    const html = await (await get('/u/evil')).text()
    expect(html).not.toContain('script>alert')
    expect(html.match(/<script/g)).toHaveLength(1)
    expect(tag(html, 'og:title')).toBe('evil · DeltaDeck')
    // The rewriter escapes values too: a quote cannot close an attribute.
    expect(html).not.toMatch(/content="[^"]*"[^ />]/)
  })

  it('Supabase down: the page still loads, with the generic preview', async () => {
    down = true
    const response = await get('/u/alice')
    expect(response.status).toBe(200)
    expect(tag(await response.text(), 'og:title')).toBe('DeltaDeck')
  })

  it('one read per name per minute: repeats come from the edge cache', async () => {
    for (let i = 0; i < 5; i++) {
      const html = await (await get('/u/alice')).text()
      expect(tag(html, 'og:title')).toBe('alice · DeltaDeck')
    }
    expect(asked).toHaveLength(1)
  })
})
