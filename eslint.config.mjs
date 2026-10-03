import { defineConfig, globalIgnores } from 'eslint/config'
import nextVitals from 'eslint-config-next/core-web-vitals'
import nextTs from 'eslint-config-next/typescript'
import boundaries from 'eslint-plugin-boundaries'
import bcs from './eslint/bcs-plugin.mjs'

// Every JavaScript/TypeScript flavour gets the same rules, so a .js or .mts file cannot escape them.
const CODE = '{ts,tsx,mts,cts,js,jsx,mjs,cjs}'
const SRC = [`src/**/*.${CODE}`]
const ALL = [`**/*.${CODE}`]
const importPlugin = nextVitals.find((c) => c.plugins?.import)?.plugins?.import
if (!importPlugin) throw new Error('eslint-config-next ไม่ได้ลงทะเบียน plugin import แล้ว — แก้ eslint.config.mjs')

// Layer elements of spec §4.10. Order matters: the first matching descriptor wins.
const ELEMENTS = [
  { type: 'core', pattern: 'src/core/*/**', partialMatch: false, capture: ['module'] },
  { type: 'core', pattern: 'src/core/*', partialMatch: false },
  // Request context type shared by every server layer and adapter (spec §4.3 step 3)
  { type: 'context', pattern: 'src/server/context/**', partialMatch: false },
  { type: 'db', pattern: 'src/server/db/**', partialMatch: false },
  { type: 'services', pattern: 'src/server/services/**', partialMatch: false },
  { type: 'queries', pattern: 'src/server/queries/**', partialMatch: false },
  { type: 'jobs', pattern: 'src/server/jobs/**', partialMatch: false },
  // The parts of src/server that app and channels may reach besides services and queries
  { type: 'auth', pattern: 'src/server/auth/**', partialMatch: false },
  { type: 'authz', pattern: 'src/server/authz/**', partialMatch: false },
  { type: 'server', pattern: 'src/server/**', partialMatch: false },
  { type: 'channels', pattern: 'src/channels/**', partialMatch: false },
  { type: 'ai', pattern: 'src/integrations/ai/**', partialMatch: false },
  { type: 'integrations', pattern: 'src/integrations/**', partialMatch: false },
  { type: 'app', pattern: 'src/app/**', partialMatch: false },
  { type: 'ui', pattern: 'src/ui/**', partialMatch: false },
  { type: 'i18n', pattern: 'src/i18n/**', partialMatch: false },
  { type: 'lib', pattern: 'src/lib/**', partialMatch: false },
]
// Single files that are a layer of their own (element patterns only describe folders)
const FILES = [{ category: 'inngest-client', pattern: 'src/server/inngest.ts' }]
const inngestClient = { to: { file: { categories: 'inngest-client' } } }

const SERVER = ['server', 'auth', 'authz']
const to = (...types) => ({ to: { element: { types: { anyOf: types } } } })
// Parts of core that screens may use: formatting (§4.10: core/{thai,money}) plus core/result (error codes and
// the Result type, pure data) so screens can map codes to messages (docs/sub-specs/S1.md)
const coreFormatting = { to: { element: { type: 'core', captured: { module: '{thai,money,result}' } } } }
// Shared screen components (src/ui, not in the §4.10 table) also run the form rules the server runs: fields shown or
// hidden as the requester types (FR-INT-002 AC1) and quotations compared (BR-FORM-06) with the same core/forms
const coreForUi = { to: { element: { type: 'core', captured: { module: '{thai,money,result,forms}' } } } }
// Channels get exactly the §4.10 row: core/{thai,money} for formatting, nothing else of core
const coreFormattingForChannels = { to: { element: { type: 'core', captured: { module: '{thai,money}' } } } }

const POLICIES = [
  // External packages and Node built-ins: allowed everywhere except core (core has its own allowlist below
  // and the stricter bcs/core-imports rule). Database drivers are limited by bcs/restricted-imports.
  { from: { element: { type: '!core' } }, allow: { to: { module: { origin: 'external' } } } },
  { from: { element: { type: '!core' } }, allow: { to: { module: { origin: 'core' } } } },
  { from: { element: { type: 'core' } }, allow: { to: { module: { origin: 'external', source: ['zod', 'zod/**', 'decimal.js', 'date-fns', 'date-fns/**', '@date-fns/tz'] } } } },

  { from: { element: { type: 'core' } }, allow: to('core') },
  { from: { element: { type: 'services' } }, allow: to('core', 'services', ...SERVER, 'db', 'queries', 'integrations', 'lib', 'context') },
  { from: { element: { type: 'queries' } }, allow: to('core', 'db', 'queries', 'lib', 'context') },
  { from: { element: { type: 'db' } }, allow: to('db', 'core', 'lib') },
  { from: { element: { type: 'jobs' } }, allow: to('jobs', 'services', 'queries', ...SERVER, 'core', 'integrations', 'channels', 'lib', 'context') },
  { from: { element: { types: { anyOf: SERVER } } }, allow: to(...SERVER, 'db', 'core', 'queries', 'integrations', 'channels', 'lib', 'i18n', 'context') },
  // §4.10: channels may import services · queries · core/{thai,money} · lib, and nothing else (no auth, i18n or
  // context: the current channel code needs none of them); app also gets the auth/authz/inngest/jobs glue.
  { from: { element: { type: 'channels' } }, allow: to('channels', 'services', 'queries', 'lib') },
  { from: { element: { type: 'channels' } }, allow: coreFormattingForChannels },
  { from: { element: { type: 'app' } }, allow: to('app', 'services', 'queries', 'channels', 'ui', 'lib', 'i18n', 'context', 'auth', 'authz', 'jobs') },
  { from: { element: { type: 'app' } }, allow: inngestClient },
  { from: { element: { type: 'app' } }, allow: coreFormatting },
  { from: { element: { type: 'ui' } }, allow: to('ui', 'lib', 'i18n') },
  { from: { element: { type: 'ui' } }, allow: coreForUi },
  { from: { element: { type: 'integrations' } }, allow: to('integrations', 'lib') },
  { from: { element: { type: 'ai' } }, allow: to('ai', 'integrations', 'lib') },
  { from: { element: { type: 'i18n' } }, allow: to('i18n', 'lib') },
  { from: { element: { type: 'lib' } }, allow: to('lib') },
  { from: { element: { type: 'context' } }, allow: to('lib') },
]

// Who may hold a client that is not scoped to one tenant, or a raw database driver (§4.8, §4.10, §17.3).
// The modules of the unscoped client (repo paths without extension); the write rules below get the same list.
const UNSCOPED_CLIENT_MODULES = ['src/server/db/client', 'src/server/db/system', 'src/server/db']
// src cannot import these, so a module handed on there never reaches application code
const OUTSIDE_SRC = ['scripts/**', 'prisma/**', 'tests/**']
const IMPORT_POLICY = {
  entries: [
    {
      paths: UNSCOPED_CLIENT_MODULES,
      // src/server/jobs is not here: jobs reach the database only through src/server/events/outbox and services
      allow: ['src/server/db/**', 'src/server/events/outbox.ts', 'src/server/auth/**', 'src/server/seed/**', 'src/server/platform/**', ...OUTSIDE_SRC],
      // Only the client modules themselves hand the client on. Every other allowed file is checked so it cannot
      // launder it to code that may not import it: no re-export, no export holding or returning it, no global,
      // no setter of another module (services import auth, and anything in src/server/db).
      reexportAllow: ['src/server/db/{client,system,index}.ts', ...OUTSIDE_SRC],
      // Reviewed exceptions: exports that hold the client on purpose
      exportAllow: [
        { file: 'src/server/db/tenant.ts', names: ['forTenant'], reason: 'forTenant() returns the client wrapped by the tenant extension: the scoped client of §4.8' },
        {
          file: 'src/server/auth/auth.ts',
          names: ['auth'],
          reason: 'the Better Auth instance keeps the client for its identity tables, which are not tenant tables (§4.8, §5.1)',
        },
      ],
      message: 'client ที่ไม่แยก tenant — services queries และ adapter ต้องใช้ db.forTenant() จาก src/server/db/tenant (§4.8)',
    },
    {
      // The generated Prisma client and Prisma's packages: only the db layer builds a client. Also catches relative
      // imports (../db/generated/client), import() and require(), which no-restricted-imports does not see.
      paths: ['src/server/db/generated/**'],
      packages: ['@prisma/*'],
      allow: ['src/server/db/**', ...OUTSIDE_SRC],
      reexportAllow: ['src/server/db/client.ts', 'src/server/db/generated/**', ...OUTSIDE_SRC],
      handoutNames: ['PrismaClient'],
      message: 'Prisma client ที่ generate และ @prisma/* ใช้ได้เฉพาะ src/server/db (§4.10)',
    },
    {
      packages: ['pg', 'pg-*', 'postgres', '@neondatabase/*', '@vercel/postgres'],
      allow: ['src/server/db/**', 'scripts/**', 'tests/**'],
      reexportAllow: ['src/server/db/client.ts', ...OUTSIDE_SRC],
      message: 'driver ฐานข้อมูลใช้ได้เฉพาะ src/server/db (§4.10 §17.3)',
    },
    {
      // createRequire() loads modules by names that no rule can check
      packages: ['module', 'node:module'],
      allow: [...OUTSIDE_SRC, 'eslint/**', '*.config.{ts,mts,mjs,js,cjs}'],
      message: 'createRequire() โหลดโมดูลด้วยชื่อที่ตรวจไม่ได้ — ใช้ import แบบ static (§4.10)',
    },
  ],
  srcBoundary: { allow: ['messages/**'] },
}
// Where a database write can hide from bcs/query-read-only and bcs/service-tx-writes: helpers in src/server/db/sql run
// raw SQL (claimDueOutboxRows writes through $queryRaw). A helper that only reads is listed here after review.
const DB_WRITE_OPTIONS = {
  clientModules: UNSCOPED_CLIENT_MODULES,
  opaqueModules: ['src/server/db/sql/**'],
  readHelpers: ['pingDatabase', 'oldestPendingOutboxAgeMs', 'countOtherActiveMemberships', 'setTransactionTimeouts'],
}
// Test files of every runner: vitest's unit project also runs src/**/*.test.{ts,tsx} (vitest.config.ts)
const TEST_FILES = [`tests/**/*.${CODE}`, `src/**/*.{test,spec}.${CODE}`, `src/**/__tests__/**/*.${CODE}`]

// Files Next.js or next-intl load by default export (spec §14.4: no default exports otherwise)
const DEFAULT_EXPORT_FILES = [
  'src/app/**/{page,layout,template,loading,error,global-error,not-found,forbidden,unauthorized,default}.tsx',
  'src/app/**/{opengraph-image,twitter-image,icon,apple-icon}.tsx',
  'src/app/{manifest,robots,sitemap}.ts',
  'src/app/**/sw.ts',
  'src/i18n/request.ts',
  'src/proxy.ts',
]

export default defineConfig([
  globalIgnores([
    '.next/**',
    '.next-e2e/**',
    '.e2e-runs/**',
    'out/**',
    'coverage/**',
    'playwright-report/**',
    'test-results/**',
    'scratch/**',
    '.worktrees/**',
    'next-env.d.ts',
    'src/server/db/generated/**',
  ]),
  ...nextVitals,
  ...nextTs,
  {
    settings: {
      'import/resolver': { typescript: { alwaysTryTypes: true, project: './tsconfig.json' } },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  // Gate rules cannot be switched off from inside a file: eslint-disable and /* eslint */ comments have no effect
  // anywhere (§17.3, CLAUDE.md §9). A rule that will not report itself cannot guard against a blanket
  // eslint-disable, so this is set for every file. An exception must be a reviewed entry in this file.
  {
    files: ALL,
    linterOptions: { noInlineConfig: true },
  },
  // eslint-config-next registers its plugins for every flavour except .cjs; without this a .cjs file in src
  // stops the whole lint run with "Could not find plugin import".
  {
    files: ['**/*.cjs'],
    plugins: { import: importPlugin },
  },
  // Layer boundaries (§4.10)
  {
    files: SRC,
    plugins: { boundaries },
    settings: {
      'boundaries/elements': ELEMENTS,
      'boundaries/files': FILES,
      'boundaries/include': ['src/**/*'],
    },
    rules: {
      'boundaries/dependencies': ['error', { default: 'disallow', policies: POLICIES }],
    },
  },
  // Unscoped database clients, drivers, and src importing from outside src (§4.8, §4.10).
  // `any` needs a reason comment (NFR-MNT-01): with inline config off, bcs/explained-any replaces
  // @typescript-eslint/no-explicit-any and accepts "// any: <reason>" on the same or the previous line.
  {
    files: ALL,
    plugins: { bcs },
    rules: {
      'bcs/restricted-imports': ['error', IMPORT_POLICY],
      '@typescript-eslint/no-explicit-any': 'off',
      'bcs/explained-any': 'error',
    },
  },
  // Project rules everywhere in src (§4.8, §4.10, §17.3)
  {
    files: SRC,
    plugins: { bcs },
    rules: {
      // src/lib/encoding.ts is a character table (Windows-874 code points), not amounts
      'bcs/no-money-literal': ['error', { allowFiles: ['src/lib/constants.ts', 'src/core/money/constants.ts', 'src/lib/encoding.ts'] }],
      'bcs/no-org-code': 'error',
      'bcs/no-raw-sql': ['error', { allowFiles: ['src/server/db/sql/**'] }],
      'no-console': 'error',
    },
  },
  {
    files: SRC,
    ignores: ['src/server/db/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['@prisma/*', '**/server/db/generated/**', '@/server/db/generated/**'], message: 'Prisma ใช้ได้เฉพาะใน src/server/db (§4.10)' }] },
      ],
    },
  },
  // Functional core: no I/O, no ambient time, randomness or environment (§4.2, §17.3)
  {
    files: [`src/core/**/*.${CODE}`],
    rules: {
      'bcs/core-imports': 'error',
      'bcs/core-purity': 'error',
    },
  },
  // Queries only read; services write only through the tx that runCommand hands to execute() (§4.2, §4.3).
  // _pipeline.ts is runCommand itself: it opens the transaction and writes CommandLog, Event and Outbox.
  {
    files: [`src/server/queries/**/*.${CODE}`],
    rules: { 'bcs/query-read-only': ['error', DB_WRITE_OPTIONS] },
  },
  {
    files: [`src/server/services/**/*.${CODE}`],
    rules: { 'bcs/service-tx-writes': ['error', { ...DB_WRITE_OPTIONS, allowFiles: ['src/server/services/_pipeline.ts'] }] },
  },
  // Screen text comes from next-intl messages (NFR-I18N-01, FR-PLT-002 AC2)
  {
    files: [`src/app/**/*.${CODE}`, `src/ui/**/*.${CODE}`],
    rules: {
      'bcs/no-thai-literal': 'error',
      'bcs/no-ui-literal': 'error',
    },
  },
  // No default exports except files that Next.js / next-intl require (§14.4)
  {
    files: SRC,
    ignores: DEFAULT_EXPORT_FILES,
    rules: { 'import/no-default-export': 'error' },
  },
  // Tests: never skip, focus, leave as todo or invert tests to make them pass (CLAUDE.md §9), wherever a runner
  // picks them up (tests/ and the test files under src/)
  {
    files: TEST_FILES,
    plugins: { bcs },
    rules: { 'bcs/no-test-skip': 'error' },
  },
])
