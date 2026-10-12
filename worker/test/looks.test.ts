// The picture and school badge beside each name at a table: read once per
// connect from public.players, sent to the table as headers, checked again
// there, and shown to everyone at the table as a bucket path and a domain.
import { env } from 'cloudflare:test'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ServerMsg } from '../../src/shared/protocol'
import { forgetUsernames, identityHeaders, profileFor } from '../src/auth'
import { checkFrame } from './frames'
import { connect, createTable, isState, stub } from './helpers'

const BOB = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b'
const ROWS: Record<string, Record<string, unknown>> = {
  [BOB]: {
    username: 'bob',
    avatar_version: 17,
    school_domain: 'princeton.edu',
    school_verified_at: '2026-10-01T00:00:00Z',
  },
  // A school row without verification never shows a badge.
  ['0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c']: {
    username: 'carol',
    avatar_version: null,
    school_domain: 'mit.edu',
    school_verified_at: null,
  },
}

beforeAll(() => {
  const realFetch = globalThis.fetch
  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.origin !== new URL(env.SUPABASE_URL).origin)
        return realFetch(input, init)
      if (url.pathname === '/rest/v1/players') {
        const row = ROWS[url.searchParams.get('user_id')!.slice(3)]
        return Response.json(row ? [row] : [])
      }
      return new Response('not stubbed', { status: 599 })
    },
  )
  forgetUsernames()
})
afterAll(() => vi.unstubAllGlobals())

describe('profileFor', () => {
  it('reads the picture and a verified school only', async () => {
    expect(await profileFor(BOB, env)).toEqual({
      username: 'bob',
      avatar: 17,
      school: 'princeton.edu',
    })
    expect(
      await profileFor('0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c', env),
    ).toEqual({ username: 'carol', avatar: null, school: null })
    // Dev accounts have no row, so nothing to show.
    expect(await profileFor('dave', env)).toEqual({
      username: 'dave',
      avatar: null,
      school: null,
    })
  })

  it('sends headers only for what there is', () => {
    expect(
      identityHeaders({
        userId: BOB,
        username: 'bob',
        avatar: 17,
        school: 'princeton.edu',
      }),
    ).toEqual({ 'x-avatar': '17', 'x-school': 'princeton.edu' })
    expect(
      identityHeaders({
        userId: BOB,
        username: 'bob',
        avatar: null,
        school: null,
      }),
    ).toEqual({})
  })
})

/** Bob's socket straight to the table, with the headers the Worker sends. */
async function bobJoins(matchId: string, headers: Record<string, string>) {
  const response = await stub(matchId).fetch('https://table/connect', {
    headers: {
      Upgrade: 'websocket',
      'x-user-id': BOB,
      'x-username': 'bob',
      ...headers,
    },
  })
  expect(response.status).toBe(101)
  response.webSocket!.accept()
  return response.webSocket!
}

const players = (f: ServerMsg) =>
  (f as Extract<ServerMsg, { t: 'state' }>).view!.match.players

describe('a table', () => {
  it("shows a player's picture and school in everyone's frames", async () => {
    const matchId = await createTable('alice')
    const alice = await connect(matchId, 'alice')
    await bobJoins(matchId, { 'x-avatar': '17', 'x-school': 'princeton.edu' })
    const frame = await alice.next(isState(1))
    checkFrame(frame)
    expect(players(frame)).toEqual([
      expect.not.objectContaining({ avatar: expect.anything() }),
      expect.objectContaining({
        username: 'bob',
        avatar: `${BOB}.webp?v=17`,
        school: 'princeton.edu',
      }),
    ])
    expect(players(frame)[0]).not.toHaveProperty('school')
  })

  it('drops a header value it cannot read', async () => {
    const matchId = await createTable('alice')
    const alice = await connect(matchId, 'alice')
    await bobJoins(matchId, {
      'x-avatar': '1e3',
      'x-school': '../evil/<script>',
    })
    const frame = await alice.next(isState(1))
    checkFrame(frame)
    const bob = players(frame)[1]
    expect(bob.username).toBe('bob')
    expect(bob).not.toHaveProperty('avatar')
    expect(bob).not.toHaveProperty('school')
  })

  it('drops an out-of-range version', async () => {
    const matchId = await createTable('alice')
    const alice = await connect(matchId, 'alice')
    await bobJoins(matchId, { 'x-avatar': '1000000001' })
    const frame = await alice.next(isState(1))
    expect(players(frame)[1]).not.toHaveProperty('avatar')
  })
})
