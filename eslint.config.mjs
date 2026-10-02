import { defineConfig, globalIgnores } from 'eslint/config'
import nextVitals from 'eslint-config-next/core-web-vitals'
import nextTs from 'eslint-config-next/typescript'
import boundaries from 'eslint-plugin-boundaries'
import bcs from './eslint/bcs-plugin.mjs'

// Layer elements of spec §4.10. Order matters: the first matching descriptor wins.
const ELEMENTS = [
  { type: 'core', pattern: 'src/core/*/**', partialMatch: false, capture: ['module'] },
  { type: 'core', pattern: 'src/core/*', partialMatch: false },
  { type: 'db', pattern: 'src/server/db/**', partialMatch: false },
  { type: 'services', pattern: 'src/server/services/**', partialMatch: false },
  { type: 'queries', pattern: 'src/server/queries/**', partialMatch: false },
  { type: 'jobs', pattern: 'src/server/jobs/**', partialMatch: false },
  { type: 'server', pattern: 'src/server/**', partialMatch: false },
  { type: 'channels', pattern: 'src/channels/**', partialMatch: false },
  { type: 'ai', pattern: 'src/integrations/ai/**', partialMatch: false },
  { type: 'integrations', pattern: 'src/integrations/**', partialMatch: false },
  { type: 'app', pattern: 'src/app/**', partialMatch: false },
  { type: 'ui', pattern: 'src/ui/**', partialMatch: false },
  { type: 'i18n', pattern: 'src/i18n/**', partialMatch: false },
  { type: 'lib', pattern: 'src/lib/**', partialMatch: false },
]

const to = (...types) => ({ to: { element: { types: { anyOf: types } } } })
// Parts of core that adapters may use: formatting (§4.10: core/{thai,money}) plus core/result (error codes and
// the Result type, pure data) so screens and LINE replies can map codes to messages (docs/sub-specs/S1.md)
const coreFormatting = { to: { element: { type: 'core', captured: { module: '{thai,money,result}' } } } }

const POLICIES = [
  // External packages and Node built-ins: allowed everywhere except core (core has its own allowlist below
  // and the stricter bcs/core-imports rule).
  { from: { element: { type: '!core' } }, allow: { to: { module: { origin: 'external' } } } },
  { from: { element: { type: '!core' } }, allow: { to: { module: { origin: 'core' } } } },
  { from: { element: { type: 'core' } }, allow: { to: { module: { origin: 'external', source: ['zod', 'zod/**', 'decimal.js', 'date-fns', 'date-fns/**', '@date-fns/tz'] } } } },

  { from: { element: { type: 'core' } }, allow: to('core') },
  { from: { element: { type: 'services' } }, allow: to('core', 'services', 'server', 'db', 'queries', 'integrations', 'lib') },
  { from: { element: { type: 'queries' } }, allow: to('core', 'db', 'queries', 'lib') },
  { from: { element: { type: 'db' } }, allow: to('db', 'core', 'lib') },
  { from: { element: { type: 'jobs' } }, allow: to('jobs', 'services', 'queries', 'server', 'core', 'integrations', 'channels', 'lib') },
  { from: { element: { type: 'server' } }, allow: to('server', 'db', 'core', 'queries', 'integrations', 'channels', 'lib', 'i18n') },
  { from: { element: { type: 'channels' } }, allow: to('channels', 'services', 'queries', 'lib', 'i18n') },
  { from: { element: { type: 'channels' } }, allow: coreFormatting },
  { from: { element: { type: 'app' } }, allow: to('app', 'services', 'queries', 'channels', 'ui', 'lib', 'i18n', 'server', 'jobs') },
  { from: { element: { type: 'app' } }, allow: coreFormatting },
  { from: { element: { type: 'ui' } }, allow: to('ui', 'lib', 'i18n') },
  { from: { element: { type: 'ui' } }, allow: coreFormatting },
  { from: { element: { type: 'integrations' } }, allow: to('integrations', 'lib') },
  { from: { element: { type: 'ai' } }, allow: to('ai', 'integrations', 'lib') },
  { from: { element: { type: 'i18n' } }, allow: to('i18n', 'lib') },
  { from: { element: { type: 'lib' } }, allow: to('lib') },
]

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
  // Layer boundaries (§4.10)
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { boundaries },
    settings: {
      'boundaries/elements': ELEMENTS,
      'boundaries/include': ['src/**/*'],
    },
    rules: {
      'boundaries/dependencies': ['error', { default: 'disallow', policies: POLICIES }],
    },
  },
  // Project rules everywhere in src (§4.10, §17.3)
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { bcs },
    rules: {
      'bcs/no-money-literal': ['error', { allowFiles: ['src/core/**/constants.ts', 'src/lib/constants.ts'] }],
      'bcs/no-org-code': 'error',
      'no-console': 'error',
      'no-restricted-syntax': [
        'error',
        { selector: "MemberExpression[property.name='$queryRawUnsafe']", message: 'ห้าม $queryRawUnsafe ทุกที่ (§4.8)' },
        { selector: "MemberExpression[property.name='$executeRawUnsafe']", message: 'ห้าม $executeRawUnsafe ทุกที่ (§4.8)' },
      ],
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['@prisma/*', '**/server/db/generated/**', '@/server/db/generated/**'], message: 'Prisma ใช้ได้เฉพาะใน src/server/db (§4.10)' }] },
      ],
    },
  },
  // Raw SQL only in src/server/db/sql (§4.8)
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/server/db/sql/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: "MemberExpression[property.name='$queryRawUnsafe']", message: 'ห้าม $queryRawUnsafe ทุกที่ (§4.8)' },
        { selector: "MemberExpression[property.name='$executeRawUnsafe']", message: 'ห้าม $executeRawUnsafe ทุกที่ (§4.8)' },
        { selector: "MemberExpression[property.name=/^\\$(queryRaw|executeRaw)$/]", message: 'raw SQL อยู่ได้เฉพาะ src/server/db/sql (§4.8)' },
      ],
    },
  },
  {
    files: ['src/server/db/**/*.{ts,tsx}'],
    rules: { 'no-restricted-imports': 'off' },
  },
  // Functional core: no I/O, no ambient time or randomness (§4.2, §17.3)
  {
    files: ['src/core/**/*.{ts,tsx}'],
    rules: {
      'bcs/core-imports': 'error',
      'no-restricted-syntax': [
        'error',
        { selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']", message: 'ห้าม Date.now() ใน src/core — รับเวลา now เป็นพารามิเตอร์ (§17.3)' },
        { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: 'ห้าม new Date() ไม่มีอาร์กิวเมนต์ใน src/core (§17.3)' },
        { selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']", message: 'ห้าม Math.random() ใน src/core (§4.2)' },
        { selector: "MemberExpression[object.name='process'][property.name='env']", message: 'ห้าม process.env ใน src/core (§4.2)' },
        { selector: "MemberExpression[property.name='$queryRawUnsafe']", message: 'ห้าม $queryRawUnsafe ทุกที่ (§4.8)' },
        { selector: "MemberExpression[property.name=/^\\$(queryRaw|executeRaw)$/]", message: 'raw SQL อยู่ได้เฉพาะ src/server/db/sql (§4.8)' },
      ],
    },
  },
  // Screen text comes from next-intl messages (NFR-I18N-01)
  {
    files: ['src/app/**/*.{ts,tsx}', 'src/ui/**/*.{ts,tsx}'],
    rules: { 'bcs/no-thai-literal': 'error' },
  },
  // No default exports except files that Next.js / next-intl require (§14.4)
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: DEFAULT_EXPORT_FILES,
    rules: { 'import/no-default-export': 'error' },
  },
  // Tests: never skip or focus tests to make them pass (CLAUDE.md §9)
  {
    files: ['tests/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: "MemberExpression[object.name=/^(it|test|describe|suite)$/][property.name=/^(skip|only|todo|skipIf|runIf)$/]", message: 'ห้ามข้ามหรือเลือกรันเทสต์ (.skip/.only/.todo) — CLAUDE.md §9' },
      ],
    },
  },
])
