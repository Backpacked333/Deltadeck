// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { PROTOCOL } from '../src/shared/protocol.ts'
import { deployProblems } from './verify-deploy.ts'

const BASE = 'https://site.test'
let dist = ''
const FILES: Record<string, string> = {
  'index.html': '<script src="/assets/index-abc.js"></script>',
  'assets/index-abc.js': 'console.log(1)',
  'assets/index-def.css': 'body{}',
}

beforeAll(() => {
  dist = mkdtempSync(join(tmpdir(), 'dist-'))
  mkdirSync(join(dist, 'assets'))
  for (const [file, body] of Object.entries(FILES))
    writeFileSync(join(dist, file), body)
})

/** A fake production: the same files unless `changes` says otherwise. */
function site(changes: Record<string, string | null | object> = {}) {
  const served: Record<string, string | null | object> = {
    '/': FILES['index.html'],
    '/assets/index-abc.js': FILES['assets/index-abc.js'],
    '/assets/index-def.css': FILES['assets/index-def.css'],
    '/api/config': {
      supabaseUrl: 'https://x.supabase.co',
      supabaseKey: 'sb_publishable_x',
    },
    '/api/health': { ok: true, protocol: PROTOCOL },
    ...changes,
  }
  return async (url: string) => {
    const body = served[url.slice(BASE.length)]
    if (body === null || body === undefined)
      return new Response('nope', { status: 404 })
    return typeof body === 'string' ? new Response(body) : Response.json(body)
  }
}

describe('verify-deploy', () => {
  // CI runs `node scripts/verify-deploy.ts` with Node's own TypeScript loader,
  // which, unlike Vite and Vitest, resolves no extensionless import. A value
  // import in src/shared without ".ts" passes every other test and breaks the
  // deploy check on main.
  it('loads under plain node, the way CI runs it', () => {
    expect(() =>
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          "await import('./scripts/verify-deploy.ts')",
        ],
        { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'pipe' },
      ),
    ).not.toThrow()
  })

  it('passes when production serves exactly this build', async () => {
    expect(await deployProblems(BASE, dist, site())).toEqual([])
  })

  it('fails when a built asset is missing or differs in production', async () => {
    expect(
      await deployProblems(
        BASE,
        dist,
        site({
          '/assets/index-abc.js': null,
          '/assets/index-def.css': 'body{color:red}',
        }),
      ),
    ).toEqual([
      'assets/index-abc.js: HTTP 404',
      'assets/index-def.css: differs from this build',
    ])
  })

  it('fails when /api/config has any field besides supabaseUrl and supabaseKey', async () => {
    const problems = await deployProblems(
      BASE,
      dist,
      site({
        '/api/config': {
          supabaseUrl: 'https://x.supabase.co',
          supabaseKey: 'sb_secret_oops',
          secret: 'x',
        },
      }),
    )
    expect(problems).toEqual([
      '/api/config fields: secret,supabaseKey,supabaseUrl',
      '/api/config: not a publishable key',
    ])
  })

  it('fails when the Worker speaks another protocol', async () => {
    expect(
      await deployProblems(
        BASE,
        dist,
        site({ '/api/health': { ok: true, protocol: 'qp.v0' } }),
      ),
    ).toEqual(['/api/health: {"ok":true,"protocol":"qp.v0"}'])
  })
})
