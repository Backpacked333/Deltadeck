// The landing page's endpoints and ScoreDO: a line is re-scored from the
// pre-scored tree (never trusted), the percentile switches from model players
// to real players at PLAYER_BASIS scores, funnel events count once per
// visitor per day, and a score claim reaches Postgres through the outbox.
import {
  env,
  runDurableObjectAlarm,
  runInDurableObject,
  SELF,
} from 'cloudflare:test'
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { scorePath } from '../../src/challenge/score'
import type {
  ActionCode,
  ChallengeOption,
  ChallengeTree,
} from '../../src/challenge/score'
import { treeFor } from '../../src/challenge/trees'
import { challengeRoute, forgetFunnel } from '../src/challenge'
import {
  candidates,
  CODE_TRIES,
  CODE_TTL_MS,
  fallbackSchool,
  newCode,
  SENDS_PER_DAY,
} from '../src/school'
import { describeShared, sharePage } from '../src/share'
import { now } from '../src/clock'
import { CROWD_MIN, EVENT_DAYS, PLAYER_BASIS, scoreStub } from '../src/scores'
import type { ScoreDO, ScoreResult } from '../src/scores'
import { ORIGIN, token } from './helpers'

const VID = '3b9f2c1e-7a4d-4e8b-9c2a-1f0e6d5c4b3a'
const OTHER_VID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'

function post(path: string, body: unknown, headers: HeadersInit = {}) {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { Origin: ORIGIN, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

/** The first complete line through a tree, always taking `pick`. */
function lineOf(tree: ChallengeTree, pick = 0): ActionCode[] {
  const line: ActionCode[] = []
  let at: number | null = 0
  while (at !== null) {
    const options: ChallengeOption[] = tree.nodes[at].options
    const option: ChallengeOption = options[Math.min(pick, options.length - 1)]
    line.push(option.code)
    at = option.next
  }
  return line
}

const tree = treeFor('overpair')!
const line = lineOf(tree, 1)

let rpcCalls: { fn: string; body: unknown }[] = []
let emails: { to: string[]; subject: string; text: string; from: string }[] = []
let resendStatus = 200
const LISTED = [{ domain: 'mit.edu', school: 'MIT' }]
let rpcStatus = 200
let rpcCode: string | undefined

beforeAll(() => {
  const realFetch = globalThis.fetch
  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.origin === 'https://api.resend.com') {
        expect(new Headers(init?.headers).get('Authorization')).toBe(
          'Bearer re_test',
        )
        emails.push(JSON.parse(String(init?.body)))
        return new Response('{}', { status: resendStatus })
      }
      if (url.origin !== new URL(env.SUPABASE_URL).origin)
        return realFetch(input, init)
      if (url.pathname === '/rest/v1/school_domains') {
        const wanted = url.searchParams.get('domain')!.slice(4, -1).split(',')
        return Response.json(LISTED.filter((r) => wanted.includes(r.domain)))
      }
      // Outbox calls go through ScoreDO.send, replaced in beforeEach.
      throw new Error(`unexpected Supabase call ${url.pathname}`)
    },
  )
})
afterAll(() => vi.unstubAllGlobals())

beforeEach(async () => {
  rpcCalls = []
  emails = []
  resendStatus = 200
  rpcStatus = 200
  rpcCode = undefined
  forgetFunnel()
  await runInDurableObject(scoreStub(env), async (instance: ScoreDO) => {
    const inside = instance as unknown as { ctx: DurableObjectState }
    for (const table of [
      'histogram',
      'node_counts',
      'events',
      'receipts',
      'outbox',
      'school_codes',
      'school_sends',
    ])
      inside.ctx.storage.sql.exec(`DELETE FROM ${table}`)
    await inside.ctx.storage.deleteAlarm()
    instance.clock = now
    instance.send = async (call) => {
      rpcCalls.push({ fn: call.rpc, body: call.body })
      return rpcStatus === 200
        ? { ok: true }
        : { ok: false, status: rpcStatus, code: rpcCode }
    }
  })
})

describe('POST /api/challenge/score', () => {
  it('re-scores the line from the tree and returns a receipt', async () => {
    const response = await post('/api/challenge/score', {
      hand: tree.id,
      ver: tree.ver,
      path: line,
    })
    expect(response.status).toBe(200)
    const result = (await response.json()) as ScoreResult
    expect(result.accuracy).toBe(scorePath(tree, line)!.accuracy)
    expect(result.basis).toBe('model')
    expect(result.percentile).toBeGreaterThanOrEqual(0)
    expect(result.percentile).toBeLessThanOrEqual(100)
    expect(result.crowd).toEqual(line.map(() => null))
    expect(result.receipt).toMatch(/^[0-9a-f]{32}$/)
  })

  it.each([
    [
      'an unknown line',
      {
        hand: tree.id,
        ver: tree.ver,
        path: ['c', 'c', 'c', 'c', 'c', 'c', 'c', 'c'],
      },
      400,
    ],
    [
      'an unfinished line',
      { hand: tree.id, ver: tree.ver, path: line.slice(0, -1) },
      400,
    ],
    ['an unknown hand', { hand: 'nope', ver: 1, path: line }, 400],
    [
      'a retired version',
      { hand: tree.id, ver: tree.ver + 1, path: line },
      400,
    ],
    [
      'a malformed code',
      { hand: tree.id, ver: tree.ver, path: ['raise'] },
      400,
    ],
    ['a non-object', [1, 2], 400],
    ['broken JSON', '{"hand":', 400],
  ])('refuses %s', async (_, body, status) => {
    expect((await post('/api/challenge/score', body)).status).toBe(status)
  })

  it('refuses another site, a GET and an oversized body', async () => {
    const body = { hand: tree.id, ver: tree.ver, path: line }
    expect(
      (
        await post('/api/challenge/score', body, {
          Origin: 'https://evil.example',
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await SELF.fetch(`${ORIGIN}/api/challenge/score`, {
          headers: { Origin: ORIGIN },
        })
      ).status,
    ).toBe(405)
    expect(
      (await post('/api/challenge/score', { ...body, pad: 'x'.repeat(3000) }))
        .status,
    ).toBe(413)
  })

  it('switches to real players at PLAYER_BASIS scores', async () => {
    const accuracy = scorePath(tree, line)!.accuracy
    // Everyone else scored below this line: a real top percentile.
    await runInDurableObject(scoreStub(env), (instance: ScoreDO) => {
      const sql = (instance as unknown as { ctx: DurableObjectState }).ctx
        .storage.sql
      sql.exec(
        `INSERT INTO histogram (hand, ver, bucket, n) VALUES (?, ?, ?, ?)`,
        tree.id,
        tree.ver,
        Math.max(0, accuracy - 1),
        PLAYER_BASIS - 2,
      )
    })
    const before = (await (
      await post('/api/challenge/score', {
        hand: tree.id,
        ver: tree.ver,
        path: line,
      })
    ).json()) as ScoreResult
    expect(before.basis).toBe('model')
    const after = (await (
      await post('/api/challenge/score', {
        hand: tree.id,
        ver: tree.ver,
        path: line,
      })
    ).json()) as ScoreResult
    expect(after.basis).toBe('players')
    // 198 below, 2 tied (both of these): (198 + 1) / 200.
    expect(after.percentile).toBe(
      Math.round((100 * (PLAYER_BASIS - 2 + 1)) / PLAYER_BASIS),
    )
  })

  it('shows the crowd share once a decision has CROWD_MIN visits', async () => {
    const other = lineOf(tree, 0)
    for (let i = 0; i < CROWD_MIN - 1; i++)
      await runInDurableObject(scoreStub(env), (instance: ScoreDO) =>
        instance.score(tree.id, tree.ver, i % 2 ? line : other),
      )
    const result = (await (
      await post('/api/challenge/score', {
        hand: tree.id,
        ver: tree.ver,
        path: line,
      })
    ).json()) as ScoreResult
    // 25 of the 49 earlier visits plus this one chose the same first move.
    expect(result.crowd[0]).toBe(Math.round((100 * 25) / CROWD_MIN) / 100)
  })
})

describe('POST /api/events and GET /api/funnel', () => {
  it('counts each event once per visitor per day and reports step rates', async () => {
    for (const vid of [VID, VID, OTHER_VID])
      expect(
        (await post('/api/events', { name: 'landing_view', vid })).status,
      ).toBe(204)
    expect(
      (await post('/api/events', { name: 'challenge_start', vid: VID })).status,
    ).toBe(204)
    const response = await SELF.fetch(`${ORIGIN}/api/funnel`)
    const { days } = (await response.json()) as {
      days: {
        day: string
        counts: Record<string, number>
        rates: Record<string, number>
      }[]
    }
    expect(days).toHaveLength(1)
    expect(days[0].counts).toEqual({ landing_view: 2, challenge_start: 1 })
    expect(days[0].rates).toEqual({ challenge_start: 0.5 })
  })

  it.each([
    ['an unknown event', { name: 'pageview', vid: VID }],
    ['a missing visitor', { name: 'landing_view' }],
    [
      'a visitor id that is not a UUID',
      { name: 'landing_view', vid: 'alice@example.com' },
    ],
  ])('refuses %s', async (_, body) => {
    expect((await post('/api/events', body)).status).toBe(400)
  })

  it('takes a beacon (text/plain) from our own pages only', async () => {
    const body = JSON.stringify({ name: 'landing_view', vid: VID })
    expect(
      (
        await post('/api/events', body, {
          'Content-Type': 'text/plain;charset=UTF-8',
        })
      ).status,
    ).toBe(204)
    expect(
      (await post('/api/events', body, { Origin: 'https://evil.example' }))
        .status,
    ).toBe(403)
  })

  it(`forgets events after ${EVENT_DAYS} days`, async () => {
    await post('/api/events', { name: 'landing_view', vid: VID })
    await runInDurableObject(scoreStub(env), (instance: ScoreDO) => {
      instance.clock = () => now() + (EVENT_DAYS + 1) * 86_400_000
    })
    await runInDurableObject(scoreStub(env), (instance: ScoreDO) =>
      instance.alarm(),
    )
    await runInDurableObject(scoreStub(env), (instance: ScoreDO) => {
      expect(instance.funnel()).toEqual([])
    })
  })
})

describe('POST /api/challenge/claim', () => {
  async function receipt() {
    const result = (await (
      await post('/api/challenge/score', {
        hand: tree.id,
        ver: tree.ver,
        path: line,
      })
    ).json()) as ScoreResult
    return result.receipt
  }
  const claim = (id: string, user: string | null = 'alice') =>
    post(
      '/api/challenge/claim',
      { receipt: id },
      user ? { Authorization: `Bearer ${token(user)}` } : {},
    )

  it('needs a signed-in account and a known receipt', async () => {
    const id = await receipt()
    expect((await claim(id, null)).status).toBe(401)
    expect((await claim('0'.repeat(32))).status).toBe(404)
    expect((await claim('not-a-receipt')).status).toBe(400)
  })

  it('attaches the score once, then sends it to Postgres from the alarm', async () => {
    const id = await receipt()
    expect((await claim(id)).status).toBe(204)
    expect((await claim(id)).status).toBe(204)
    expect((await claim(id, 'bob')).status).toBe(409)
    // The claim arms the alarm for now; it may already have run.
    await runDurableObjectAlarm(scoreStub(env))
    // It may already be running on its own: wait for it.
    await vi.waitFor(() =>
      expect(rpcCalls).toEqual([
        {
          fn: 'record_challenge_claim',
          body: expect.objectContaining({
            userId: 'alice',
            hand: tree.id,
            ver: tree.ver,
            accuracy: scorePath(tree, line)!.accuracy,
            receipt: id,
          }),
        },
      ]),
    )
    await runInDurableObject(scoreStub(env), (instance: ScoreDO) => {
      const sql = (instance as unknown as { ctx: DurableObjectState }).ctx
        .storage.sql
      expect(sql.exec(`SELECT count(*) AS n FROM outbox`).one().n).toBe(0)
    })
  })

  it('keeps the claim while the key is missing (401) and drops a refusal for its data', async () => {
    await claim(await receipt())
    rpcStatus = 401
    await runDurableObjectAlarm(scoreStub(env))
    const count = () =>
      runInDurableObject(scoreStub(env), (instance: ScoreDO) => {
        const sql = (instance as unknown as { ctx: DurableObjectState }).ctx
          .storage.sql
        return sql.exec(`SELECT count(*) AS n FROM outbox`).one().n
      })
    expect(await count()).toBe(1)
    rpcStatus = 400
    rpcCode = '23514'
    await runInDurableObject(scoreStub(env), (instance: ScoreDO) => {
      instance.clock = () => now() + 3_600_000
      return instance.alarm()
    })
    expect(await count()).toBe(0)
  })
})

describe('shared scores: /api/challenge/shared/<receipt> and /c/<receipt>', () => {
  const APP = `<!doctype html><html><head>
<meta name="description" content="x" />
<meta property="og:type" content="website" />
<meta property="og:title" content="DeltaDeck" />
<meta property="og:description" content="x" />
<meta property="og:url" content="/" />
<meta property="og:image" content="/og-default.png" />
<title>DeltaDeck</title></head><body></body></html>`
  const assets = {
    fetch: async () =>
      new Response(APP, { headers: { 'Content-Type': 'text/html' } }),
  } as unknown as Fetcher
  let n = 0
  const tag = (html: string, property: string) =>
    html.match(
      new RegExp(`<meta (?:property|name)="${property}" content="([^"]*)"`),
    )?.[1] ?? null

  async function scored() {
    return (await (
      await post('/api/challenge/score', {
        hand: tree.id,
        ver: tree.ver,
        path: line,
      })
    ).json()) as ScoreResult
  }

  it('looks a receipt up: the hand, the score and where it ranks now', async () => {
    const result = await scored()
    const response = await SELF.fetch(
      `${ORIGIN}/api/challenge/shared/${result.receipt}`,
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      hand: tree.id,
      ver: tree.ver,
      accuracy: result.accuracy,
      percentile: result.percentile,
      basis: 'model',
    })
    expect(
      (await SELF.fetch(`${ORIGIN}/api/challenge/shared/${'0'.repeat(32)}`))
        .status,
    ).toBe(404)
  })

  it('serves the app with the score to beat in its link preview', async () => {
    const result = await scored()
    const response = await sharePage(
      new Request(`${ORIGIN}/c/${result.receipt}`),
      env,
      { assets, cache: await caches.open(`share-${n++}`) },
    )
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(tag(html, 'og:title')).toBe(
      `Beat ${result.accuracy}/100 on “Overpair under pressure” · DeltaDeck`,
    )
    expect(tag(html, 'og:description')).toContain(
      `Someone scored ${result.accuracy}/100 on this hand`,
    )
    expect(tag(html, 'og:image')).toBe(`${ORIGIN}/og-challenge.png`)
    expect(tag(html, 'og:url')).toBe(`${ORIGIN}/c/${result.receipt}`)
  })

  it('an unknown or malformed link still opens the app, with a generic preview', async () => {
    for (const path of [`/c/${'0'.repeat(32)}`, '/c/nope']) {
      const response = await sharePage(new Request(`${ORIGIN}${path}`), env, {
        assets,
        cache: await caches.open(`share-${n++}`),
      })
      expect(response.status).toBe(404)
      expect(tag(await response.text(), 'og:title')).toMatch(/misprice/)
    }
  })

  it('names the percentile only once it is against real players', () => {
    const base = { hand: 'nut-draw', ver: 1, accuracy: 91 }
    expect(
      describeShared({ ...base, percentile: 83, basis: 'model' }).description,
    ).not.toContain('percentile')
    expect(
      describeShared({ ...base, percentile: 83, basis: 'players' }).description,
    ).toContain('83rd percentile')
  })
})

// A school badge from a second email (L-14). Kept in this file: both use
// the one ScoreDO, and files run in parallel.
const postAs = (path: string, body: unknown, user: string | null = 'alice') =>
  SELF.fetch(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      Origin: ORIGIN,
      ...(user ? { Authorization: `Bearer ${token(user)}` } : {}),
    },
    body: JSON.stringify(body),
  })
const codeSent = () => emails.at(-1)!.subject.slice(0, 6)

describe('school codes', () => {
  it('sends a code to a listed school and sets the badge once it comes back', async () => {
    const start = await postAs('/api/school/start', {
      email: 'Ada@CSAIL.MIT.edu',
    })
    expect(start.status).toBe(200)
    expect(await start.json()).toEqual({ school: 'MIT' })
    expect(emails).toHaveLength(1)
    expect(emails[0].to).toEqual(['ada@csail.mit.edu'])
    expect(emails[0].from).toBe('DeltaDeck <verify@quantpoker.test>')
    expect(codeSent()).toMatch(/^\d{6}$/)
    expect(emails[0].text).toContain(codeSent())
    // Only a hash is kept.
    await runInDurableObject(scoreStub(env), (instance: ScoreDO) => {
      const sql = (instance as unknown as { ctx: DurableObjectState }).ctx
        .storage.sql
      const row = sql
        .exec<{ hash: string }>(`SELECT hash FROM school_codes`)
        .one()
      expect(row.hash).toMatch(/^[0-9a-f]{64}$/)
      expect(row.hash).not.toContain(codeSent())
    })
    const confirm = await postAs('/api/school/confirm', { code: codeSent() })
    expect(confirm.status).toBe(200)
    expect(await confirm.json()).toEqual({ school: 'MIT' })
    await runDurableObjectAlarm(scoreStub(env))
    // It may already be running on its own: wait for it.
    await vi.waitFor(() =>
      expect(rpcCalls).toEqual([
        {
          fn: 'set_player_school',
          body: expect.objectContaining({
            userId: 'alice',
            domain: 'mit.edu',
            school: 'MIT',
          }),
        },
      ]),
    )
    // The code is used up.
    expect(
      (await postAs('/api/school/confirm', { code: codeSent() })).status,
    ).toBe(410)
  })

  it('takes an unlisted .edu or .ac.uk as its domain, and refuses anything else', async () => {
    expect(
      await (
        await postAs('/api/school/start', { email: 'a@smallcollege.edu' })
      ).json(),
    ).toEqual({
      school: 'smallcollege.edu',
    })
    expect(
      (await postAs('/api/school/start', { email: 'a@gmail.com' })).status,
    ).toBe(400)
    expect(
      (await postAs('/api/school/start', { email: 'not an email' })).status,
    ).toBe(400)
    expect(
      (await postAs('/api/school/start', { email: 'a@mit.edu' }, null)).status,
    ).toBe(401)
  })

  it(`burns the code after ${CODE_TRIES} wrong guesses`, async () => {
    await postAs('/api/school/start', { email: 'ada@mit.edu' })
    const wrong = codeSent() === '000000' ? '111111' : '000000'
    for (let i = 1; i < CODE_TRIES; i++)
      expect(
        (await postAs('/api/school/confirm', { code: wrong })).status,
      ).toBe(400)
    expect((await postAs('/api/school/confirm', { code: wrong })).status).toBe(
      429,
    )
    expect(
      (await postAs('/api/school/confirm', { code: codeSent() })).status,
    ).toBe(410)
  })

  it('expires a code', async () => {
    await postAs('/api/school/start', { email: 'ada@mit.edu' })
    await runInDurableObject(scoreStub(env), (instance: ScoreDO) => {
      instance.clock = () => now() + CODE_TTL_MS + 1
    })
    expect(
      (await postAs('/api/school/confirm', { code: codeSent() })).status,
    ).toBe(410)
  })

  it(`allows ${SENDS_PER_DAY} sends a day, and refunds a failed send`, async () => {
    resendStatus = 500
    expect(
      (await postAs('/api/school/start', { email: 'ada@mit.edu' })).status,
    ).toBe(503)
    resendStatus = 200
    for (let i = 0; i < SENDS_PER_DAY; i++)
      expect(
        (await postAs('/api/school/start', { email: 'ada@mit.edu' })).status,
      ).toBe(200)
    expect(
      (await postAs('/api/school/start', { email: 'ada@mit.edu' })).status,
    ).toBe(429)
    // Each account has its own allowance.
    expect(
      (await postAs('/api/school/start', { email: 'bo@mit.edu' }, 'bob'))
        .status,
    ).toBe(200)
  })

  it('answers 503 when email is not set up', async () => {
    const request = new Request(`${ORIGIN}/api/school/start`, {
      method: 'POST',
      headers: { Origin: ORIGIN, Authorization: `Bearer ${token('alice')}` },
      body: JSON.stringify({ email: 'ada@mit.edu' }),
    })
    const response = await challengeRoute(
      request,
      { ...env, RESEND_API_KEY: undefined },
      '/api/school/start',
    )
    expect(response!.status).toBe(503)
    expect(emails).toEqual([])
  })
})

describe('school helpers', () => {
  it('lists the domains to look up, nearest first', () => {
    expect(candidates('a@cs.ox.ac.uk')).toEqual([
      'cs.ox.ac.uk',
      'ox.ac.uk',
      'ac.uk',
    ])
    expect(candidates('a@gmail')).toBeNull()
    expect(candidates('<a>@mit.edu')).toBeNull()
    expect(fallbackSchool('mail.smallcollege.edu')).toEqual({
      domain: 'smallcollege.edu',
      school: 'smallcollege.edu',
    })
    expect(fallbackSchool('edu.example.com')).toBeNull()
  })

  it('draws six-digit codes', () => {
    const codes = new Set(Array.from({ length: 200 }, newCode))
    for (const code of codes) expect(code).toMatch(/^\d{6}$/)
    expect(codes.size).toBeGreaterThan(190)
  })
})
