import { afterEach, describe, expect, it, vi } from 'vitest'

// loadOnline caches its first answer, so each case imports a fresh module.
const fresh = async () => {
  vi.resetModules()
  return (await import('./supabase')).loadOnline
}
const reply = (body: string, type: string) =>
  vi.fn(async () => new Response(body, { headers: { 'content-type': type } }))

afterEach(() => vi.unstubAllEnvs())

describe('loadOnline', () => {
  it('reads settings from the Worker when the build has none', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', '')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '')
    const fetcher = reply(
      JSON.stringify({
        supabaseUrl: 'https://x.supabase.co',
        supabaseKey: 'sb_publishable_k',
      }),
      'application/json',
    )
    const online = await (await fresh())(fetcher)
    expect(fetcher).toHaveBeenCalledWith('/api/config')
    expect(online).toMatchObject({
      url: 'https://x.supabase.co',
      key: 'sb_publishable_k',
    })
    expect(online?.client.auth).toBeDefined()
  })

  it('stays off where there is no Worker (an HTML fallback page)', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', '')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '')
    expect(
      await (
        await fresh()
      )(reply('<!doctype html>', 'text/html')),
    ).toBeNull()
    const broken = vi.fn(async () => {
      throw new Error('offline')
    })
    expect(await (await fresh())(broken)).toBeNull()
  })

  it('prefers build settings and asks for config once', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://local.supabase.co')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'local-key')
    const fetcher = reply('{}', 'application/json')
    const load = await fresh()
    const [a, b] = await Promise.all([load(fetcher), load(fetcher)])
    expect(a).toBe(b)
    expect(a?.url).toBe('https://local.supabase.co')
    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('storageKeyFor', () => {
  it("names the key supabase-js keeps this project's session under", async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://abcd1234.supabase.co')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'sb_publishable_k')
    const online = await (await fresh())()
    const { storageKeyFor } = await import('./sessionKey')
    const key = (online!.client.auth as unknown as { storageKey: string })
      .storageKey
    expect(storageKeyFor('https://abcd1234.supabase.co')).toBe(key)
    expect(key).toBe('sb-abcd1234-auth-token')
  })
})
