import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

// Cap Vitest pool concurrency in CI: docker executors report the HOST's
// core count via os.cpus(), so uncapped vitest over-forks and worker IPC
// (onTaskUpdate) times out. Keep this cap == the vCPU count of the
// executor running this suite (node-20-xl / xlarge.gen2, 8 vCPU — see
// .circleci/config.yml); bump both together. 16 forks on 16 vCPUs tripped
// a 5s test timeout under collect-phase load, so 8 is also the measured
// flake-free ceiling. Tests run fine at full parallelism locally.
const isCI = !!process.env.CI
const poolOptions = isCI
  ? { forks: { minForks: 1, maxForks: 8 } }
  : undefined

export default defineConfig({
  plugins: [react()],
  test: {
    passWithNoTests: true,
    globals: true,
    environment: 'node',
    environmentMatchGlobs: [
      ['src/components/**', 'jsdom'],
      ['src/__tests__/components/**', 'jsdom'],
      ['src/hooks/**', 'jsdom'],
      ['src/app/**', 'jsdom'],
      ['src/lib/stores/**/*', 'jsdom'],
    ],
    setupFiles: ['src/test-setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    pool: 'forks',
    poolOptions,
    // CI forks share the box during the collect/transform crunch, so a test
    // that takes 100ms warm can blow the 5s default under load (the exact
    // failure the 16-fork probe hit on 2026-07-22). Locally keep 5s so real
    // hangs surface fast.
    testTimeout: isCI ? 15_000 : 5_000,
    // Hooks need the same CI headroom for the same reason, and were an
    // oversight: they were left on vitest's 10s default while tests got 15s.
    // The hooks that matter here are the ones deliberately warming an
    // expensive module graph OUT of a test's budget (e.g.
    // scheduled-skill-tools.test.ts's beforeAll, which loads the ~208-tool
    // TOOL_CATALOG) — that work is exactly as contention-sensitive as the
    // test it was hoisted out of, so capping it lower just moved the flake
    // from the test to the hook. Observed red on CI 2026-09-01 (build 29866)
    // on a commit that did not touch that file or its imports.
    hookTimeout: isCI ? 15_000 : 10_000,
    teardownTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/lib/**', 'src/components/**', 'src/hooks/**', 'src/app/**'],
      exclude: ['src/lib/db/**', 'src/**/__tests__/**'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // server-only is a Next.js guard that throws at import time in non-RSC contexts.
      // In Vitest (node/jsdom), we replace it with an empty no-op module.
      'server-only': path.resolve(__dirname, 'src/__mocks__/server-only.ts'),
    },
  },
})
