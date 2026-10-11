import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parse } from 'dotenv'
import { defineConfig } from 'vitest/config'

const alias = { '@': path.resolve(import.meta.dirname, 'src') }

// A parallel lane (spec §16.13) caps the forks that hold database pools (BCS_TEST_WORKERS in its .env, set by
// pnpm lane:create) so three lanes and main stay under Postgres max_connections. Read without loading .env into
// the test processes; unset = Vitest's default.
const envFile = path.resolve(import.meta.dirname, '.env')
const testWorkers = Number((existsSync(envFile) ? parse(readFileSync(envFile)) : {}).BCS_TEST_WORKERS) || undefined
const dbPool = testWorkers ? { maxWorkers: testWorkers } : {}

// Projects map to spec §15.1 test layers and the §5.4 scripts (test, test:golden, test:int …).
export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['tests/unit/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'], environment: 'node' },
      },
      { extends: true, test: { name: 'golden', include: ['tests/golden/**/*.test.ts'], environment: 'node' } },
      // Property runs make thousands of operations per test; under coverage they take longer than the 5 s default
      { extends: true, test: { name: 'property', include: ['tests/property/**/*.test.ts'], environment: 'node', testTimeout: 60_000 } },
      {
        extends: true,
        test: {
          name: 'int',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['tests/integration/global-setup.ts'],
          setupFiles: ['tests/support/env-setup.ts'],
          pool: 'forks',
          ...dbPool,
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'generated',
          include: ['tests/generated/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['tests/integration/global-setup.ts'],
          setupFiles: ['tests/support/env-setup.ts'],
          pool: 'forks',
          ...dbPool,
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
})
