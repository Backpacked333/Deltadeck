import { fileURLToPath } from 'node:url'
import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

// Runs worker/test inside the Workers runtime (Miniflare) with the real
// wrangler.jsonc bindings. Dev tokens are on only here.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: fileURLToPath(
          new URL('../wrangler.jsonc', import.meta.url),
        ),
      },
      miniflare: {
        bindings: {
          // Matches DEV_SECRET in test/helpers.ts; at least MIN_DEV_SECRET long.
          DEV_AUTH_SECRET: 'worker-test-secret-0001',
          SUPABASE_SECRET_KEY: 'sb_secret_test',
          // School codes by email; the Resend API is stubbed in tests.
          RESEND_API_KEY: 're_test',
          SCHOOL_EMAIL_FROM: 'DeltaDeck <verify@quantpoker.test>',
          // The test site is the canonical one; canonical.test.ts asks from
          // other hosts.
          CANONICAL_ORIGIN: 'https://quantpoker.test',
          // Never the real project: a request a stub misses fails here
          // instead of reaching production.
          SUPABASE_URL: 'https://supabase.test',
        },
      },
    }),
  ],
  test: {
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
  },
})
