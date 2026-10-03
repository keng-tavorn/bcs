import path from 'node:path'
import { defineConfig } from 'vitest/config'

const alias = { '@': path.resolve(import.meta.dirname, 'src') }

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
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
})
