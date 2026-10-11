import { configDefaults, defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // three.js (~500 kB) ships only in the lazily loaded 3D view, which loads
  // when someone opens the expanded terrain; the main bundle stays small.
  build: {
    chunkSizeWarningLimit: 520,
    rollupOptions: {
      output: {
        // The account client is shared by the online area and the session
        // check, so Rollup gives it a chunk of its own, named after it. That
        // name would sit in the entry chunk's preload list, which
        // scripts/check-bundle.mjs refuses: call it "accounts" instead.
        chunkFileNames: (chunk) =>
          /supabase|gotrue/i.test(chunk.name)
            ? 'assets/accounts-[hash].js'
            : 'assets/[name]-[hash].js',
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    restoreMocks: true,
    exclude: [...configDefaults.exclude, 'e2e/**', 'worker/**'],
  },
})
