// Is production serving exactly this build? Compares the local dist/ (run
// `npm run build` first) with the live site file by file, and checks the
// Worker's public endpoints. Read-only: the same GET requests a browser makes.
//
//   node scripts/verify-deploy.ts [--url https://…] [--dist dist] [--wait 900]
//
// --wait polls (every 20 s, up to that many seconds) until the site matches,
// for CI right after a push to main while Cloudflare is still building.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROTOCOL } from '../src/shared/protocol.ts'

export const SITE = 'https://deltadeck.net'

type Get = (url: string) => Promise<Response>
const digest = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex')

/** What differs between `dist` and the site at `base`; empty when nothing. */
export async function deployProblems(
  base: string,
  dist: string,
  get: Get = (url) => fetch(url),
): Promise<string[]> {
  const problems: string[] = []
  const files = [
    'index.html',
    ...readdirSync(join(dist, 'assets')).map((f) => `assets/${f}`),
  ]
  for (const file of files) {
    const response = await get(`${base}/${file === 'index.html' ? '' : file}`)
    if (!response.ok) {
      problems.push(`${file}: HTTP ${response.status}`)
      continue
    }
    const live = new Uint8Array(await response.arrayBuffer())
    if (digest(live) !== digest(readFileSync(join(dist, file))))
      problems.push(`${file}: differs from this build`)
  }

  // The browser's runtime config: the Supabase URL and publishable key,
  // and nothing else (never a secret key).
  const config = (await (await get(`${base}/api/config`)).json()) as Record<
    string,
    unknown
  >
  if (Object.keys(config).sort().join() !== 'supabaseKey,supabaseUrl')
    problems.push(`/api/config fields: ${Object.keys(config).sort().join()}`)
  if (!String(config.supabaseKey).startsWith('sb_publishable_'))
    problems.push('/api/config: not a publishable key')
  if (!String(config.supabaseUrl).startsWith('https://'))
    problems.push('/api/config: Supabase URL is not https')

  const health = (await (await get(`${base}/api/health`)).json()) as {
    ok?: boolean
    protocol?: string
  }
  if (!health.ok || health.protocol !== PROTOCOL)
    problems.push(`/api/health: ${JSON.stringify(health)}`)
  return problems
}

async function main() {
  const arg = (name: string) => {
    const i = process.argv.indexOf(`--${name}`)
    return i > 0 ? process.argv[i + 1] : undefined
  }
  const base = (arg('url') ?? SITE).replace(/\/$/, '')
  const dist = arg('dist') ?? 'dist'
  const deadline = Date.now() + Number(arg('wait') ?? 0) * 1000
  for (;;) {
    const problems = await deployProblems(base, dist)
    if (!problems.length) {
      console.log(`${base} serves this build (protocol ${PROTOCOL}).`)
      return
    }
    if (Date.now() >= deadline) {
      for (const problem of problems) console.error(`::error::${problem}`)
      process.exit(1)
    }
    console.log(`Not yet (${problems.length} differences); retrying in 20 s.`)
    await new Promise((r) => setTimeout(r, 20_000))
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
