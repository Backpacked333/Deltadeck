// Fails the build when the entry chunk outgrows its gzip budget. Heavy
// features (3D, curriculum, motion features) must stay in lazy chunks.
import { readFileSync, readdirSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

const BUDGET_KB = 150
const dir = new URL('../dist/assets/', import.meta.url)
// The entry chunk is the module script index.html loads.
const html = readFileSync(
  new URL('../dist/index.html', import.meta.url),
  'utf8',
)
const entry = html.match(
  /<script type="module"[^>]*src="\/assets\/([^"]+\.js)"/,
)?.[1]
if (!entry) throw new Error('No entry chunk found; run vite build first.')
// A lazy chunk named after the account client would list that name in the
// entry chunk's preload map, and say what loads where.
const named = readdirSync(dir).find((f) => /supabase|gotrue/i.test(f))
if (named) {
  console.error(`A chunk is named after the account client: ${named}`)
  process.exit(1)
}
const source = readFileSync(new URL(entry, dir))
const kb = gzipSync(source).length / 1000
const line = `${entry}: ${kb.toFixed(1)} kB gzip (budget ${BUDGET_KB} kB)`
if (kb > BUDGET_KB) {
  console.error(`Bundle budget exceeded. ${line}`)
  process.exit(1)
}
// The account client must load lazily: not imported by the entry chunk,
// not preloaded by the page.
if (
  /from\s*"\.\/accounts-/.test(source.toString('utf8')) ||
  /rel="modulepreload"[^>]*accounts-/.test(html)
) {
  console.error(`The entry chunk loads the account chunk eagerly. ${line}`)
  process.exit(1)
}
// Online play (accounts, sockets) must load only with the #lobby chunk.
const leaked = source.toString('utf8').match(/supabase|gotrue|auth\/v1\//i)
if (leaked) {
  console.error(`Online code reached the entry chunk ("${leaked[0]}"). ${line}`)
  process.exit(1)
}
console.log(line)
