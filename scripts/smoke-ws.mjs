#!/usr/bin/env node
// Load and integrity smoke: 20 WebSocket clients (10 tables at a time) play
// 500 hands against a running server and check every frame. Prints ack
// latency p50/p95/p99 and the invariants; exits 1 above 300 ms p95 or on any
// broken invariant.
//
//   npm run worker:dev -- --var DEV_AUTH_SECRET:smoke-local-secret-0001
//   npm run smoke                     # or: node scripts/smoke-ws.mjs
//   node scripts/smoke-ws.mjs --pairs 10 --hands 500 --target http://localhost:8787
//   node scripts/smoke-ws.mjs --six --pairs 3 --hands 200   # one six table (P2-11)
//
// --prod plays real, archived matches on production. It refuses unless a
// person types the confirmation phrase at the terminal and passes --tokens
// with real accounts' access tokens. Never run it without that person's go.
//
// The engine's own modules check the reveals, so the runner is bundled with
// esbuild (Vite's) on the fly: engine imports have no file extensions.
import { build } from 'esbuild'

const { outputFiles } = await build({
  entryPoints: [new URL('./smoke/run.ts', import.meta.url).pathname],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  write: false,
})
const runner = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`
)
try {
  process.exitCode = await runner.main(process.argv.slice(2))
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 2
}
