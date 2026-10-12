import { describe, expect, it, vi } from 'vitest'
import {
  createGame,
  createMatch,
  devIdentity,
  inviteLink,
  joinCodeLink,
} from './api'

const token = async () => 'jwt'

describe('createMatch', () => {
  it('posts with the bearer token and returns the new table', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ matchId: 'm-1' }, { status: 201 }),
    )
    expect(await createMatch(token, fetcher)).toEqual({
      ok: true,
      matchId: 'm-1',
    })
    expect(fetcher).toHaveBeenCalledWith('/api/matches', {
      method: 'POST',
      headers: { Authorization: 'Bearer jwt' },
    })
  })

  it('explains each failure', async () => {
    const status = (n: number) =>
      vi.fn(async () => new Response('', { status: n }))
    expect(await createMatch(token, status(401))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/session expired/),
    })
    expect(await createMatch(token, status(500))).toMatchObject({ ok: false })
    const offline = vi.fn(async () => {
      throw new Error('offline')
    })
    expect(await createMatch(token, offline)).toMatchObject({
      reason: expect.stringMatching(/No connection/),
    })
    expect(await createMatch(async () => null, status(201))).toMatchObject({
      ok: false,
    })
  })
})

describe('createGame', () => {
  it('posts the choice as JSON and returns the table with its code', async () => {
    const fetcher = vi.fn(async () =>
      Response.json(
        { matchId: 'm-1', code: 'ABC234', listed: true },
        { status: 201 },
      ),
    )
    expect(await createGame(token, { listed: true }, fetcher)).toEqual({
      ok: true,
      matchId: 'm-1',
      code: 'ABC234',
      listed: true,
    })
    expect(fetcher).toHaveBeenCalledWith('/api/matches', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer jwt',
        'Content-Type': 'application/json',
      },
      body: '{"listed":true}',
    })
  })

  it('reports what the server did, not what was asked', async () => {
    // No confirmed email: the server opens the table unlisted.
    const fetcher = vi.fn(async () =>
      Response.json(
        { matchId: 'm-1', code: 'ABC234', listed: false },
        { status: 201 },
      ),
    )
    expect(await createGame(token, { listed: true }, fetcher)).toMatchObject({
      ok: true,
      listed: false,
    })
  })

  it('keeps no code it can not read', async () => {
    for (const code of [undefined, null, 'abc234', 'ABC23', 'ABC0IL', 7]) {
      const fetcher = vi.fn(async () =>
        Response.json({ matchId: 'm-1', code }, { status: 201 }),
      )
      expect(await createGame(token, { listed: false }, fetcher)).toEqual({
        ok: true,
        matchId: 'm-1',
        code: null,
        listed: false,
      })
    }
  })

  it('explains each failure, and points to the table already in play', async () => {
    const status = (n: number) =>
      vi.fn(async () => new Response('', { status: n }))
    expect(
      await createGame(token, { listed: false }, status(401)),
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/session expired/),
    })
    expect(
      await createGame(token, { listed: false }, status(503)),
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/Could not create/),
    })
    const busy = vi.fn(async () =>
      Response.json({ matchId: 'm-9' }, { status: 409 }),
    )
    expect(await createGame(token, { listed: false }, busy)).toEqual({
      ok: false,
      reason: 'You are already playing at another table.',
      activeMatch: 'm-9',
    })
    const offline = vi.fn(async () => {
      throw new Error('offline')
    })
    expect(await createGame(token, { listed: false }, offline)).toMatchObject({
      reason: expect.stringMatching(/No connection/),
    })
    expect(
      await createGame(async () => null, { listed: false }, status(201)),
    ).toMatchObject({ ok: false })
  })
})

describe('devIdentity', () => {
  it('plays as the user named in a dev token, and only a well-formed one', async () => {
    sessionStorage.setItem('qp.devToken', 'dev.alice.e2e')
    const dev = devIdentity()
    expect(dev?.player).toEqual({ userId: 'alice', username: 'alice' })
    expect(await dev?.getToken()).toBe('dev.alice.e2e')
    for (const bad of ['dev:alice:e2e', 'alice', 'dev..e2e', 'eyJ.x.y'])
      expect(
        devIdentity({ getItem: () => bad } as unknown as Storage),
      ).toBeNull()
    sessionStorage.removeItem('qp.devToken')
    expect(devIdentity()).toBeNull()
  })
})

describe('inviteLink', () => {
  it('points at the table route on this page', () => {
    expect(
      inviteLink('m-1', {
        origin: 'https://qp.dev',
        pathname: '/',
      } as Location),
    ).toBe('https://qp.dev/#play/m-1')
  })
})

describe('joinCodeLink', () => {
  it('points at the join route on this page, with the code unhyphenated', () => {
    expect(
      joinCodeLink('ABC234', {
        origin: 'https://qp.dev',
        pathname: '/',
      } as Location),
    ).toBe('https://qp.dev/#join/ABC234')
  })
})
