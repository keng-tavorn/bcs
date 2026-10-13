// Gate canaries (spec §15.5, §17.3, CLAUDE.md §9): every project lint rule and every pnpm verify gate must reject a
// known-bad sample, so no gate can pass vacuously. Lint samples are linted virtually via lintText; nothing is
// written to src/. Gate logic is tested through the pure helpers in scripts/lib and, for argument handling and
// crash handling, by running scripts/verify.ts itself.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { ESLint } from 'eslint'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { GOLDEN_STRICT_OPTIONAL, goldenDriftProblems } from '../../scripts/golden-drift'
import {
  appendOnlyTriggerProblems,
  eventSeqProblems,
  orgForeignKeyProblems,
  probeValueSql,
  stampTriggerProblems,
  strictTableProblems,
  type ColumnRow,
  type TriggerRow,
} from '../../scripts/lib/db-checks'
import { featureStatusProblems, frsFromSpec, testTitleTags, type FeatureDoc, type FileProbe, type TestIndex } from '../../scripts/lib/feature-status'
import { committedState, migrationChecksums, migrationLockProblems, nextLock } from '../../scripts/lib/migration-lock'
import {
  GATE_REQUIRES,
  casesWithoutPassingTest,
  evaluateCoverage,
  evaluateEslintRun,
  evaluatePlaywrightRun,
  mergePlaywrightReports,
  evaluateVitestRun,
  orphanTestFiles,
  parseVerifyArgs,
  type CoverageSummary,
  type VitestJson,
} from '../../scripts/lib/verify-gates'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
let eslint: ESLint

beforeAll(() => {
  eslint = new ESLint({ cwd: ROOT })
}, 60_000)

// The first lint of a run loads the whole config and its plugins; on a busy machine that alone takes seconds
vi.setConfig({ testTimeout: 60_000 })

async function messages(file: string, code: string) {
  const [result] = await eslint.lintText(code, { filePath: path.join(ROOT, file), warnIgnored: true })
  return result?.messages ?? []
}

async function ruleIds(file: string, code: string): Promise<string[]> {
  return (await messages(file, code)).filter((m) => m.severity === 2).map((m) => m.ruleId ?? `fatal:${m.message}`)
}

const count = (ids: string[], id: string) => ids.filter((x) => x === id).length
const SERVICE = 'src/server/services/canary.ts'
const CORE = 'src/core/canary/clock.ts'

describe('bcs/no-money-literal', () => {
  it('[P-2] rejects a numeric approval limit in src', async () => {
    expect(await ruleIds(SERVICE, 'export const limit = 20000\n')).toContain('bcs/no-money-literal')
  })
  it('[P-2] rejects bigint and money-shaped strings', async () => {
    const ids = await ruleIds(SERVICE, 'export const a = 100000n\nexport const b = "20,000.00"\nexport const c = "100000.00"\n')
    expect(count(ids, 'bcs/no-money-literal')).toBe(3)
  })
  it('[P-2] rejects satang amounts of 10 digits or more written as strings', async () => {
    const ids = await ruleIds(SERVICE, "export const a = BigInt('2000000000')\nexport const b = BigInt('100000000000000')\n")
    expect(count(ids, 'bcs/no-money-literal')).toBe(2)
  })
  it('[P-2] rejects currency-decorated amounts', async () => {
    const ids = await ruleIds(SERVICE, "export const a = '฿20,000'\nexport const b = '20,000 บาท'\nexport const c = 'THB 1000'\n")
    expect(count(ids, 'bcs/no-money-literal')).toBe(3)
  })
  it('[P-2] rejects an amount written as JSX text', async () => {
    expect(await ruleIds('src/ui/canary.tsx', 'export function P() { return <span>20,000.00</span> }\n')).toContain('bcs/no-money-literal')
  })
  it('[P-2] rejects a limit hidden in constant arithmetic', async () => {
    const ids = await ruleIds(SERVICE, 'export const a = 2n * 10n ** 4n\nexport const b = 25 * 40\nexport const c = (5 as number) * 400\n')
    expect(count(ids, 'bcs/no-money-literal')).toBe(3)
  })
  it('[P-2] rejects a limit in a core constants file other than the one named exception', async () => {
    expect(await ruleIds('src/core/doa/constants.ts', 'export const VP_APPROVAL_LIMIT_SATANG = 10_000_000n\n')).toContain('bcs/no-money-literal')
  })
  it('[P-2] allows small numbers and the two named technical constants files', async () => {
    expect(await ruleIds(SERVICE, 'export const pageSize = 100\n')).not.toContain('bcs/no-money-literal')
    expect(await ruleIds('src/core/money/constants.ts', 'export const BP_DENOMINATOR = 10_000n\n')).not.toContain('bcs/no-money-literal')
    expect(await ruleIds('src/lib/constants.ts', 'export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024\n')).not.toContain('bcs/no-money-literal')
  })
  it('[P-2] lints every JavaScript and TypeScript flavour in src with the same rules', async () => {
    for (const ext of ['js', 'mjs', 'mts', 'cts', 'jsx']) {
      expect(await ruleIds(`src/server/services/canary.${ext}`, 'export const limit = 20000\n'), ext).toContain('bcs/no-money-literal')
    }
    expect(await ruleIds('src/server/services/canary.cjs', 'module.exports = { limit: 20000 }\n')).toContain('bcs/no-money-literal')
  })
  it('[P-2] ignores eslint-disable and /* eslint */ comments', async () => {
    const samples = [
      '// eslint-disable-next-line bcs/no-money-literal\nexport const limit = 20000\n',
      '/* eslint-disable */\nexport const limit = 20000\n',
      '/* eslint bcs/no-money-literal: off */\nexport const limit = 20000\n',
    ]
    for (const code of samples) expect(await ruleIds(SERVICE, code), code).toContain('bcs/no-money-literal')
  })
})

describe('bcs/no-org-code', () => {
  it('[NG-7] rejects an organization code literal and comparisons with org codes', async () => {
    expect(await ruleIds(SERVICE, "export const x = 'LK-RICH'\n")).toContain('bcs/no-org-code')
    expect(await ruleIds(SERVICE, "export function f(org: { code: string }) { return org.code === 'ACME' }\n")).toContain('bcs/no-org-code')
  })
  it('[NG-7] rejects org codes looked up in a list or table written in code', async () => {
    const samples = [
      "export const f = (org: { code: string }) => ['ACME', 'BETA'].includes(org.code)\n",
      "const SPECIAL = new Set(['ACME'])\nexport const f = (org: { code: string }) => SPECIAL.has(org.code)\n",
      "const LIMITS = { ACME: 1 }\nexport const f = (org: { code: 'ACME' }) => LIMITS[org.code]\n",
    ]
    for (const code of samples) expect(await ruleIds(SERVICE, code), code).toContain('bcs/no-org-code')
  })
  it('[NG-7] rejects comparing an organization id with a literal', async () => {
    const code = "export const f = (ctx: { organizationId: string }) => ctx.organizationId === '0193f1a2-7c00-7000-8000-000000000001'\n"
    expect(await ruleIds(SERVICE, code)).toContain('bcs/no-org-code')
  })
  it('[NG-7] allows comparing two organization ids (tenant checks)', async () => {
    const code = 'export const same = (a: { organizationId: string }, b: { organizationId: string }) => a.organizationId === b.organizationId\n'
    expect(await ruleIds(SERVICE, code)).not.toContain('bcs/no-org-code')
  })
  it('[NG-7] allows format checks of an organization code that name no organization', async () => {
    const samples = [
      'export const valid = (orgCode: string) => /^[A-Z0-9-]{2,20}$/.test(orgCode)\n',
      "export const valid = (orgCode: string) => orgCode.includes('-')\n",
      'export const valid = (orgCode: string) => orgCode.match(/^(?<prefix>[A-Z]{2})-\\d{3}\\p{L}*$/u)\n',
    ]
    for (const code of samples) expect(await ruleIds(SERVICE, code), code).not.toContain('bcs/no-org-code')
  })
  it('[NG-7] rejects a regular expression or prefix that spells out an organization', async () => {
    const samples = [
      'export const special = (orgCode: string) => /^ACME$/.test(orgCode)\n',
      "const RE = new RegExp('^ACME')\nexport const special = (orgCode: string) => RE.test(orgCode)\n",
      "export const special = (orgCode: string) => orgCode.startsWith('T')\n",
    ]
    for (const code of samples) expect(await ruleIds(SERVICE, code), code).toContain('bcs/no-org-code')
  })
})

describe('functional core purity', () => {
  it('[P-1] rejects ambient time, randomness and env in src/core', async () => {
    const ids = await ruleIds(CORE, 'export const a = Date.now()\nexport const b = new Date()\nexport const c = Math.random()\nexport const d = process.env.X\n')
    expect(count(ids, 'bcs/core-purity')).toBe(4)
  })
  it('[P-1] rejects the other ways to read the clock, randomness or the environment', async () => {
    const samples = [
      'export const a = () => new Date(Date())\n',
      'export const a = () => performance.now()\n',
      'export const a = () => crypto.randomUUID()\n',
      "export const a = () => process['env'].X\n",
      'export const a = () => globalThis.process.env.X\n',
      'const D = Date\nexport const a = () => D.now()\n',
      'const { random } = Math\nexport const a = random\n',
      'export const a = (xs: number[]) => new Date(...xs)\n',
      "export const a = () => eval('1')\n",
    ]
    for (const code of samples) expect(await ruleIds(CORE, code), code).toContain('bcs/core-purity')
  })
  it('[P-1] rejects date-fns and @date-fns/tz functions that read the clock', async () => {
    const samples = [
      "import { isPast } from 'date-fns'\nexport const overdue = (d: Date) => isPast(d)\n",
      "import * as dfns from 'date-fns'\nexport const today = (d: Date) => dfns.isToday(d)\n",
      "import { startOfToday } from 'date-fns/startOfToday'\nexport const s = startOfToday\n",
      "import { TZDate } from '@date-fns/tz'\nexport const bkkNow = () => TZDate.tz('Asia/Bangkok')\n",
      "import { TZDate } from '@date-fns/tz'\nexport const bkkNow = () => new TZDate()\n",
      "import { TZDate } from '@date-fns/tz'\nconst T = TZDate\nexport const bkkNow = () => new T()\n",
      "export { isPast } from 'date-fns'\n",
      "export * from 'date-fns'\n",
    ]
    for (const code of samples) expect(await ruleIds(CORE, code), code).toContain('bcs/core-purity')
  })
  it('[P-1] allows dates built from a given value', async () => {
    const code =
      "import { addDays } from 'date-fns'\nimport { TZDate } from '@date-fns/tz'\n" +
      'export const a = (iso: string) => new Date(iso)\n' +
      "export const b = (ms: number) => TZDate.tz('Asia/Bangkok', ms)\n" +
      "export const c = (d: Date) => addDays(new TZDate(d, 'Asia/Bangkok'), 1)\n" +
      'export const d = (x: unknown) => x instanceof Date && Math.max(1, Date.UTC(2020, 0)) > 0\n' +
      'export type T = typeof Date\n'
    expect(await ruleIds(CORE, code)).not.toContain('bcs/core-purity')
  })
  it('[P-1] rejects non-allowlisted imports in src/core', async () => {
    const ids = await ruleIds('src/core/canary/io.ts', "import fs from 'node:fs'\nimport { locales } from '@/i18n/locales'\nexport { fs, locales }\n")
    expect(count(ids, 'bcs/core-imports')).toBe(2)
  })
  it('[P-1] rejects dynamic imports whose module name is not a fixed string', async () => {
    const samples = [
      'export const load = () => import(`node:fs`)\n',
      'declare const require: (s: string) => unknown\nexport const fs = require(`node:fs`)\n',
      'export const load = (name: string) => import(name)\n',
      "export const load = () => import('date-fns')\n",
    ]
    for (const code of samples) expect(await ruleIds(CORE, code), code).toContain('bcs/core-imports')
  })
  it('[P-1] allows zod, decimal.js, date-fns and @date-fns/tz in src/core', async () => {
    const code =
      "import { z } from 'zod'\nimport Decimal from 'decimal.js'\nimport { addDays } from 'date-fns'\nimport { TZDate } from '@date-fns/tz'\nexport { z, Decimal, addDays, TZDate }\n"
    expect(await ruleIds('src/core/canary/ok.ts', code)).not.toContain('bcs/core-imports')
  })
})

describe('layer boundaries', () => {
  it('[P-1] rejects core importing another layer', async () => {
    expect(await ruleIds('src/core/canary/layer.ts', "import { locales } from '@/i18n/locales'\nexport { locales }\n")).toContain('boundaries/dependencies')
  })
  it('[P-1] rejects ui importing app, and lib importing i18n', async () => {
    // src/app/layout.tsx is the root layout Next.js always requires, so the import resolves
    expect(await ruleIds('src/ui/canary.tsx', "import Layout from '@/app/layout'\nexport { Layout }\n")).toContain('boundaries/dependencies')
    expect(await ruleIds('src/lib/canary.ts', "import { locales } from '@/i18n/locales'\nexport { locales }\n")).toContain('boundaries/dependencies')
  })
  it('[P-1] rejects app importing server internals outside its allowlist', async () => {
    const samples = ["import { sweepOutbox } from '@/server/events/outbox'\nexport const GET = () => sweepOutbox\n", "import { appendEvents } from '@/server/events/append'\nexport const GET = () => appendEvents\n"]
    for (const code of samples) expect(await ruleIds('src/app/api/canary/route.ts', code), code).toContain('boundaries/dependencies')
  })
  it('[P-1] allows app the glue it needs: i18n, inngest client, jobs, context, auth and authz', async () => {
    const code =
      "import { locales } from '@/i18n/locales'\nimport { inngest } from '@/server/inngest'\nimport { functions } from '@/server/jobs'\n" +
      "import type { Ctx } from '@/server/context'\nimport { auth } from '@/server/auth/auth'\nimport * as authz from '@/server/authz'\n" +
      'export type C = Ctx\nexport const all = [locales, inngest, functions, auth, authz]\n'
    expect(await ruleIds('src/app/api/canary/route.ts', code)).not.toContain('boundaries/dependencies')
  })
  it('[P-1] rejects channels importing authz or the inngest client', async () => {
    expect(await ruleIds('src/channels/line/canary.ts', "import * as authz from '@/server/authz'\nexport const a = authz\n")).toContain('boundaries/dependencies')
    expect(await ruleIds('src/channels/line/canary.ts', "import { inngest } from '@/server/inngest'\nexport const a = inngest\n")).toContain('boundaries/dependencies')
  })
  it('[P-1] channels import only services, queries, core/{thai,money} and lib (§4.10)', async () => {
    const refused = [
      "import { upsertUserWithPassword } from '@/server/auth/provision'\nexport const a = upsertUserWithPassword\n",
      "import { locales } from '@/i18n/locales'\nexport const a = locales\n",
      "import type { Ctx } from '@/server/context'\nexport type A = Ctx\n",
      "import { ok } from '@/core/result'\nexport const a = ok\n",
    ]
    for (const code of refused) expect(await ruleIds('src/channels/line/x.ts', code), code).toContain('boundaries/dependencies')
    const allowed =
      "import { formatThaiDate } from '@/core/thai'\nimport { listEnabledModules } from '@/server/queries/organization'\n" +
      "import { completeUpload } from '@/server/services/files'\nimport { newId } from '@/lib/ids'\nexport const a = [formatThaiDate, listEnabledModules, completeUpload, newId]\n"
    expect(await ruleIds('src/channels/line/x.ts', allowed)).not.toContain('boundaries/dependencies')
  })
  it('[P-1] rejects Prisma imports outside src/server/db', async () => {
    expect(await ruleIds(SERVICE, "import { PrismaClient } from '@prisma/client'\nexport { PrismaClient }\n")).toContain('no-restricted-imports')
  })
})

describe('tenant scoping and database access', () => {
  const SYSTEM = "import { systemDb } from '@/server/db/system'\n"
  const AUTH = 'src/server/auth/canary.ts'
  // An allowed import must pass every import rule, not just the one under test
  const importErrors = (ids: string[]) => ids.filter((id) => ['bcs/restricted-imports', 'boundaries/dependencies', 'no-restricted-imports'].includes(id))
  it('[INV-TEN-01] rejects the unscoped client in services, queries and app, in every import form', async () => {
    const samples: Array<[string, string]> = [
      [SERVICE, "import { prisma } from '@/server/db/client'\nexport const all = () => prisma\n"],
      [SERVICE, "import { prisma } from '../db/client'\nexport const all = () => prisma\n"],
      [SERVICE, "import { systemDb } from '@/server/db/system'\nexport const all = () => systemDb\n"],
      ['src/server/queries/canary.ts', "import { prisma } from '@/server/db/client'\nexport const all = () => prisma\n"],
      ['src/server/events/canary.ts', "import { systemDb } from '@/server/db/system'\nexport const all = () => systemDb\n"],
      ['src/app/canary/page.tsx', "export default async function P() { const { prisma } = await import('@/server/db/client'); return String(prisma) }\n"],
      ['src/app/canary/x.ts', "export { prisma } from '@/server/db/client'\n"],
    ]
    for (const [file, code] of samples) expect(await ruleIds(file, code), `${file}: ${code}`).toContain('bcs/restricted-imports')
  })
  it('[INV-TEN-01] allows the unscoped client only where the orchestrated allowlist says', async () => {
    const samples: Array<[string, string]> = [
      ['src/server/events/outbox.ts', `${SYSTEM}export const pending = () => systemDb.outbox.count()\n`],
      [AUTH, `${SYSTEM}export const users = () => systemDb.user.count()\n`],
      ['src/server/seed/canary.ts', `${SYSTEM}export const orgs = () => systemDb.organization.count()\n`],
      [SERVICE, "import { forTenant } from '@/server/db/tenant'\nexport const a = forTenant\n"],
      ['scripts/canary.ts', "import { prisma } from '../src/server/db/client'\nexport const a = prisma\n"],
    ]
    for (const [file, code] of samples) expect(importErrors(await ruleIds(file, code)), `${file}: ${code}`).toEqual([])
  })
  it('[INV-TEN-01] jobs reach the database only through src/server/events/outbox and services, never directly', async () => {
    const samples = [
      "import { prisma } from '@/server/db/client'\nexport const count = () => prisma.member.count()\n",
      `${SYSTEM}export const count = () => systemDb.member.count()\n`,
      "export const count = async () => (await import('@/server/db/system')).systemDb.member.count()\n",
    ]
    for (const code of samples) expect(await ruleIds('src/server/jobs/canary.ts', code), code).toContain('bcs/restricted-imports')
    const sweeper = "import { sweepOutbox } from '@/server/events/outbox'\nexport const run = (now: Date) => sweepOutbox(async () => {}, now)\n"
    expect(importErrors(await ruleIds('src/server/jobs/canary.ts', sweeper))).toEqual([])
  })
  it('[INV-TEN-01] only the client modules re-export the unscoped client with export … from', async () => {
    expect(await ruleIds(AUTH, "export { systemDb } from '@/server/db/system'\n")).toContain('bcs/restricted-imports')
    expect(await ruleIds('src/server/db/canary.ts', "export { systemDb } from './system'\n")).toContain('bcs/restricted-imports')
    expect(await ruleIds('src/server/db/system.ts', "export { prisma as systemDb } from './client'\n")).not.toContain('bcs/restricted-imports')
  })
  it('[INV-TEN-01] a file that may import the unscoped client cannot hand it on in any other way', async () => {
    const samples: Array<[string, string]> = [
      [AUTH, `${SYSTEM}export { systemDb }\n`],
      [AUTH, `${SYSTEM}export const db = systemDb\n`],
      [AUTH, `${SYSTEM}export default systemDb\n`],
      [AUTH, `${SYSTEM}const x = systemDb\nexport { x as db }\n`],
      [AUTH, `${SYSTEM}export const { user } = systemDb\n`],
      [AUTH, `${SYSTEM}export const users = systemDb.user\n`],
      [AUTH, `${SYSTEM}export const db = { client: systemDb }\n`],
      [AUTH, `${SYSTEM}export function getDb() { return systemDb }\n`],
      [AUTH, `${SYSTEM}export const getDb = () => systemDb\n`],
      [AUTH, `${SYSTEM}export const db = systemDb.$extends({})\n`],
      [AUTH, `${SYSTEM}declare function wrap<T>(x: T): T\nexport const db = wrap(systemDb)\n`],
      [AUTH, `${SYSTEM}export class Repo { db = systemDb }\n`],
      [AUTH, `${SYSTEM}export let current: unknown = null\nexport function init() { current = systemDb }\n`],
      [AUTH, `${SYSTEM}const cache = new Map<string, unknown>()\ncache.set('db', systemDb)\nexport function get() { return cache.get('db') }\n`],
      [AUTH, `${SYSTEM}const g = globalThis as unknown as { db: unknown }\ng.db = systemDb\nexport const x = 1\n`],
      [AUTH, `${SYSTEM}Object.assign(globalThis, { db: systemDb })\nexport const x = 1\n`],
      [AUTH, `${SYSTEM}import { defineEvents } from '@/server/events/registry'\ndefineEvents(systemDb as never)\nexport const x = 1\n`],
      [AUTH, "export const load = () => import('@/server/db/system')\n"],
      ['src/server/auth/canary.cts', "const { systemDb } = require('../db/system')\nmodule.exports = systemDb\n"],
      ['src/server/db/canary.ts', "import { prisma } from './client'\nexport const unscoped = prisma\n"],
      ['src/server/db/canary.ts', "import { PrismaClient } from './generated/client'\nexport const Client = PrismaClient\n"],
      ['src/server/auth/auth.ts', `${SYSTEM}export const db = systemDb\n`],
    ]
    for (const [file, code] of samples) expect(await ruleIds(file, code), `${file}: ${code}`).toContain('bcs/restricted-imports')
  })
  it('[INV-TEN-01] using the client inside a function, returning data, and the two reviewed exceptions stay allowed', async () => {
    const samples: Array<[string, string]> = [
      [AUTH, `${SYSTEM}export async function findUser(email: string) { return systemDb.user.findUnique({ where: { email } }) }\n`],
      [AUTH, `${SYSTEM}export async function revoke(userId: string) { await systemDb.$transaction([systemDb.session.deleteMany({ where: { userId } })]) }\n`],
      [
        'src/server/events/outbox.ts',
        `${SYSTEM}import { claimDueOutboxRows } from '@/server/db/sql/outbox'\nexport async function sweep(now: Date) { const rows = await claimDueOutboxRows(systemDb, { now, cutoff: now, leaseUntil: now, limit: 1 }); return rows.length }\n`,
      ],
      ['src/server/db/tenant.ts', "import { prisma } from './client'\nexport function forTenant(o: string) { return prisma.$extends({ name: o }) }\n"],
      ['src/server/db/canary.ts', "import type { PrismaClient } from './generated/client'\nexport type Client = PrismaClient\n"],
    ]
    for (const [file, code] of samples) expect(await ruleIds(file, code), `${file}: ${code}`).not.toContain('bcs/restricted-imports')
    // The reviewed exceptions are exact: the same export in another file is reported
    const betterAuth =
      "import { betterAuth } from 'better-auth'\nimport { prismaAdapter } from 'better-auth/adapters/prisma'\nimport { prisma } from '@/server/db/client'\n" +
      "export const auth = betterAuth({ database: prismaAdapter(prisma, { provider: 'postgresql' }) })\n"
    const tenant = "import { prisma } from './client'\nexport function forTenant(o: string) { return prisma.$extends({ name: o }) }\n"
    expect(await ruleIds('src/server/auth/auth.ts', betterAuth)).not.toContain('bcs/restricted-imports')
    expect(await ruleIds('src/server/auth/other.ts', betterAuth)).toContain('bcs/restricted-imports')
    expect(await ruleIds('src/server/db/other.ts', tenant)).toContain('bcs/restricted-imports')
  })
  it('[INV-TEN-01] rejects database drivers outside src/server/db, scripts and tests', async () => {
    const samples: Array<[string, string]> = [
      ['src/app/canary/page.tsx', "import pg from 'pg'\nexport default function P() { return String(pg) }\n"],
      ['src/channels/line/canary.ts', "import pg from 'pg'\nexport const c = pg\n"],
      [SERVICE, "import postgres from 'postgres'\nexport const c = postgres\n"],
      [SERVICE, "import { neon } from '@neondatabase/serverless'\nexport const c = neon\n"],
      [SERVICE, "import Pool from 'pg-pool'\nexport const c = Pool\n"],
      ['prisma/canary.ts', "import pg from 'pg'\nexport const c = pg\n"],
    ]
    for (const [file, code] of samples) expect(await ruleIds(file, code), `${file}: ${code}`).toContain('bcs/restricted-imports')
    const ping = "import pg from 'pg'\nexport async function ping() { await new pg.Pool().query('select 1') }\n"
    expect(await ruleIds('src/server/db/canary.ts', ping)).not.toContain('bcs/restricted-imports')
  })
  it('[INV-TEN-01] rejects the generated Prisma client, Prisma packages and module names computed at run time outside src/server/db', async () => {
    const samples = [
      "import { PrismaClient } from '../db/generated/client'\nexport const C = PrismaClient\n",
      "export const load = async () => (await import('@prisma/client')).PrismaClient\n",
      'export const load = async () => (await import(`@/server/db/${"client"}`)).prisma\n',
      "const p = '@/server/db/client'\nexport const load = async () => (await import(p)).prisma\n",
      'export const load = async (name: string) => import(name)\n',
      "import { createRequire } from 'node:module'\nexport const r = createRequire(import.meta.url)\n",
    ]
    for (const code of samples) expect(await ruleIds(SERVICE, code), code).toContain('bcs/restricted-imports')
    const messages = 'export const load = async (locale: string) => (await import(`../../messages/${locale}.json`)).default\n'
    expect(await ruleIds('src/i18n/canary.ts', messages)).not.toContain('bcs/restricted-imports')
  })
  it('[P-1] rejects src importing files outside src', async () => {
    const code = "import { appUrl } from '../../../scripts/lib/db-urls'\nexport default function P() { return appUrl() }\n"
    expect(await ruleIds('src/app/canary/page.tsx', code)).toContain('bcs/restricted-imports')
  })
  it('[INV-TEN-01] rejects raw SQL outside src/server/db/sql and the Unsafe forms everywhere', async () => {
    const DB = 'declare const db: { $queryRaw: (s: TemplateStringsArray) => unknown; $queryRawUnsafe: (s: string) => unknown }\n'
    const code = `${DB}export const a = db.$queryRaw\`select 1\`\nexport const b = db.$queryRawUnsafe('select 1')\n`
    expect(count(await ruleIds(SERVICE, code), 'bcs/no-raw-sql')).toBe(2)
    expect(count(await ruleIds('src/server/db/sql/canary.ts', code), 'bcs/no-raw-sql')).toBe(1)
  })
  it('[INV-TEN-01] rejects raw SQL reached by other names, computed keys or destructuring', async () => {
    const DB = 'declare const db: Record<string, (...a: unknown[]) => unknown>\n'
    const samples = [
      `${DB}export const a = db.$queryRawTyped({})\n`,
      `${DB}export const a = db['$queryRaw']\n`,
      `${DB}export const a = db[\`$executeRaw\`]\n`,
      `${DB}const { $executeRaw } = db\nexport const a = $executeRaw\n`,
      `${DB}const name = '$queryRaw'\nexport const a = db[name]\n`,
      `${DB}export const a = db['$query' + 'Raw']\n`,
      `${DB}const m = ['$query', 'Raw'].join('')\nexport const a = db[m]\n`,
      `${DB}const names = ['$queryRaw']\nexport const a = db[names[0]!]\n`,
    ]
    for (const code of samples) expect(await ruleIds(SERVICE, code), code).toContain('bcs/no-raw-sql')
    expect(await ruleIds(CORE, `${DB}export const a = db.$executeRawUnsafe('delete from x')\n`)).toContain('bcs/no-raw-sql')
  })
  it('[INV-TEN-01] allows the method names in types, comparisons and membership lists that never reach a client', async () => {
    const samples = [
      "import type { TenantTx } from '@/server/db/tenant'\nexport type Raw = Pick<TenantTx, '$queryRaw'>\n",
      "export const isRaw = (op: string) => op === '$queryRaw' || op === '$executeRaw'\n",
      "const RAW = new Set(['$queryRaw', '$executeRaw'])\nexport const isRaw = (op: string) => RAW.has(op)\n",
    ]
    for (const code of samples) expect(await ruleIds(SERVICE, code), code).not.toContain('bcs/no-raw-sql')
  })
  it('[INV-TEN-01] rejects writes from src/server/queries', async () => {
    const head = "import { forTenant } from '@/server/db/tenant'\ndeclare const id: string\nconst db = forTenant(id) as unknown as Record<string, Record<string, (a: unknown) => unknown>>\n"
    for (const call of ['db.notification.update({})', 'db.notification.create({})', 'db.notification.upsert({})', 'db.notification.deleteMany({})']) {
      expect(await ruleIds('src/server/queries/canary.ts', `${head}export const w = () => ${call}\n`), call).toContain('bcs/query-read-only')
    }
    expect(await ruleIds('src/server/queries/canary.ts', `${head}export const r = () => db.notification.findMany({})\n`)).not.toContain('bcs/query-read-only')
  })
})

describe('writes follow the database client, not the method name', () => {
  const QUERY = 'src/server/queries/canary.ts'
  const FT = "import { forTenant } from '@/server/db/tenant'\ndeclare const org: string\n"
  const TX = "import type { TenantTx } from '@/server/db/tenant'\n"
  const loose = 'as never as Record<string, (a: unknown) => unknown>'
  it('[INV-EVT-02] a query cannot write through a destructured, aliased, computed or helper-held client', async () => {
    const samples = [
      `${FT}export const w = () => { const { update } = forTenant(org).notification; return update({} as never) }\n`,
      `${FT}export const w = () => { const n = forTenant(org).notification; return n.update.call(n, {} as never) }\n`,
      `${FT}export const w = () => forTenant(org).$transaction((tx) => tx.notification.update({} as never))\n`,
      `${TX}export const w = (tx: TenantTx) => tx.notification.deleteMany({})\n`,
      `${FT}const m = 'up' + 'date'\nexport const w = () => (forTenant(org).notification ${loose})[m]({})\n`,
      `${FT}export const w = (k: string) => (forTenant(org).notification ${loose})[k]({})\n`,
      `${FT}export const w = () => Reflect.get(forTenant(org).notification, 'update')\n`,
      `${FT}function write(db: unknown) { return (db as { notification: { create: (a: unknown) => unknown } }).notification.create({}) }\nexport const w = () => write(forTenant(org))\n`,
      `${FT}const deps = { db: forTenant(org), cache: new Map<string, number>() }\nexport const w = () => deps.db.notification.create({} as never)\n`,
      `${TX}import { deleteMemberSessions } from '@/server/db/sql/identity'\nexport const w = (tx: TenantTx, o: string, m: string) => deleteMemberSessions(tx, o, m)\n`,
      `${TX}import * as sql from '@/server/db/sql/locks'\nexport const w = (tx: TenantTx, o: string) => sql.lockRowsForUpdate(tx, 'Member', o, [o])\n`,
    ]
    for (const code of samples) expect(await ruleIds(QUERY, code), code).toContain('bcs/query-read-only')
  })
  it('[INV-EVT-02] calls named like writes on things that are not a database client are not writes', async () => {
    const samples = [
      'export const r = () => { const m = new Map<string, number>(); m.delete("a"); return m }\n',
      'export const r = (url: URL) => { url.searchParams.delete("a"); return url }\n',
      `${FT}const deps = { db: forTenant(org), cache: new Map<string, number>() }\nexport const r = () => deps.cache.delete('a')\n`,
      `${FT}export const r = async () => { const rows = await forTenant(org).notification.findMany({}); const s = new Set(rows.map((x) => x.id)); s.delete('a'); return s }\n`,
      "import { createHash } from 'node:crypto'\nexport const h = (s: string) => createHash('sha256').update(s).digest('hex')\n",
      `${TX}import { countOtherActiveMemberships } from '@/server/db/sql/identity'\nexport const r = (tx: TenantTx, o: string, m: string) => countOtherActiveMemberships(tx, o, m)\n`,
    ]
    for (const code of samples) expect(await ruleIds(QUERY, code), code).not.toContain('bcs/query-read-only')
  })
  it('[INV-EVT-02] a service writes only through the tx that runCommand hands to execute()', async () => {
    const samples = [
      `${FT}export const w = () => forTenant(org).notification.update({} as never)\n`,
      `${FT}export const w = () => { const db = forTenant(org); return db.notification.create({} as never) }\n`,
      `${FT}export const w = () => forTenant(org).$transaction(async (tx) => tx.notification.update({} as never))\n`,
      `${FT}export const w = () => { const { notification } = forTenant(org); return notification.deleteMany({}) }\n`,
      `${FT}import { deleteMemberSessions } from '@/server/db/sql/identity'\nexport const w = (m: string) => deleteMemberSessions(forTenant(org) as never, org, m)\n`,
    ]
    for (const code of samples) expect(await ruleIds(SERVICE, code), code).toContain('bcs/service-tx-writes')
  })
  it('[INV-EVT-02] execute(tx), helpers that receive tx, reads and runCommand itself stay allowed', async () => {
    const command =
      "import { defineCommand } from './_pipeline'\nimport { deleteMemberSessions } from '@/server/db/sql/identity'\nimport { z } from 'zod'\n" +
      "export const c = defineCommand({ name: 'x', capability: 'y', input: z.object({}), async execute(tx, _i, ctx) {\n" +
      "  await tx.notification.updateMany({ data: {} }); await deleteMemberSessions(tx, ctx.organizationId, 'm'); return { ok: true, result: null, events: [] } } })\n"
    const samples: Array<[string, string]> = [
      [SERVICE, command],
      [SERVICE, `${TX}export async function revoke(tx: TenantTx) { return tx.memberInvitation.updateMany({ data: {} }) }\n`],
      [SERVICE, `${FT}export const r = () => forTenant(org).$transaction((tx) => tx.member.findMany({}))\n`],
      [SERVICE, 'export const r = (others: Set<string>) => others.delete("a")\n'],
      ['src/server/services/_pipeline.ts', `${FT}export const w = () => forTenant(org).$transaction(async (tx) => tx.commandLog.create({} as never))\n`],
    ]
    for (const [file, code] of samples) expect(await ruleIds(file, code), `${file}: ${code}`).not.toContain('bcs/service-tx-writes')
    // the real helper that receives tx
    const revokers = 'src/server/services/members/revokers.ts'
    expect(await ruleIds(revokers, readFileSync(path.join(ROOT, revokers), 'utf8'))).not.toContain('bcs/service-tx-writes')
  })
})

describe('screen text comes from next-intl', () => {
  it('[NFR-I18N-01] rejects Thai text hard-coded in screens', async () => {
    expect(await ruleIds('src/app/canary/page.tsx', 'export default function P() { return <p>ส่งขออนุมัติ</p> }\n')).toContain('bcs/no-thai-literal')
  })
  it('[NFR-I18N-01] rejects English text hard-coded in screens and user-facing attributes', async () => {
    const samples = [
      'export function P() { return <button>Approve request</button> }\n',
      'export function P() { return <button aria-label="Close dialog" /> }\n',
      'export function P() { return <input placeholder="Search" /> }\n',
      "export function P({ ok }: { ok: boolean }) { return <p>{ok ? 'Yes' : 'No'}</p> }\n",
    ]
    for (const code of samples) expect(await ruleIds('src/ui/canary.tsx', code), code).toContain('bcs/no-ui-literal')
  })
  it('[NFR-I18N-01] allows translated text, class names and punctuation', async () => {
    const code =
      "declare const t: (k: string) => string\nexport function P() { return <p className=\"text-sm\" data-testid=\"x\">{t('approve')} · {t('n')} —</p> }\n"
    expect(await ruleIds('src/ui/canary.tsx', code)).not.toContain('bcs/no-ui-literal')
  })
})

describe('exports and any', () => {
  it('[P-1] rejects default exports outside Next.js special files', async () => {
    expect(await ruleIds('src/lib/canary.ts', 'const x = 1\nexport default x\n')).toContain('import/no-default-export')
    expect(await ruleIds('src/app/canary/page.tsx', 'export default function P() { return null }\n')).not.toContain('import/no-default-export')
  })
  it('[NFR-MNT-01] allows any only with a reason comment', async () => {
    expect(await ruleIds(SERVICE, 'export const a: any = 1\n')).toContain('bcs/explained-any')
    expect(await ruleIds(SERVICE, '// any: generic access to every delegate\nexport const a: any = 1\nexport const b: any = 2 // any: same\n')).not.toContain('bcs/explained-any')
  })
})

describe('test hygiene', () => {
  const TEST = 'tests/unit/canary.test.ts'
  const head = "import { describe, it, test } from 'vitest'\n"
  it('[EG-7] rejects skipped, focused, todo or inverted tests in any form', async () => {
    const samples = [
      "it.skip('x', () => {})\n",
      "it.only('x', () => {})\n",
      "it.todo('x')\n",
      "it.concurrent.skip('x', async () => {})\n",
      "test.concurrent.only('x', async () => {})\n",
      "describe.sequential.skip('x', () => {})\n",
      "it.fails('x', () => { throw new Error('bug') })\n",
      "it.skipIf(true)('x', () => {})\n",
      "it('x', (ctx) => { ctx.skip() })\n",
      "const t = it\nt.skip('x', () => {})\n",
      "it('x', ({ skip }) => { skip() })\n",
    ]
    for (const body of samples) expect(await ruleIds(TEST, head + body), body).toContain('bcs/no-test-skip')
  })
  it('[EG-7] rejects Playwright tests that are skipped, marked fixme or expected to fail', async () => {
    const samples = ["test.fixme('x', async () => {})\n", "test('x', async ({}, testInfo) => { testInfo.fail() })\n", "test.fail('x', async () => {})\n"]
    for (const body of samples) expect(await ruleIds('tests/e2e/canary.spec.ts', head + body), body).toContain('bcs/no-test-skip')
  })
  it('[EG-7] a disable comment cannot switch the test rules off', async () => {
    const samples = ["/* eslint-disable */\nit.skip('x', () => {})\n", "// eslint-disable-next-line bcs/no-test-skip\nit.fails('x', () => {})\n"]
    for (const body of samples) expect(await ruleIds(TEST, head + body), body).toContain('bcs/no-test-skip')
  })
  it('[EG-7] the test rules also cover the src/**/*.test.{ts,tsx} files the unit project runs', async () => {
    expect(await ruleIds('src/lib/canary.test.ts', `${head}it.skip('x', () => {})\n`)).toContain('bcs/no-test-skip')
    expect(await ruleIds('src/ui/canary.test.tsx', `${head}it.fails('x', () => { throw new Error('bug') })\n`)).toContain('bcs/no-test-skip')
  })
  it('[EG-7] rejects skipping through test options, Reflect.get, aliases, the test context and expectedStatus', async () => {
    const samples: Array<[string, string]> = [
      [TEST, `${head}it('x', { fails: true }, () => { throw new Error('bug') })\n`],
      [TEST, `${head}it('x', { skip: true }, () => {})\n`],
      [TEST, `${head}describe('x', { todo: true }, () => { it('y', () => {}) })\n`],
      [TEST, `${head}const opts = { only: true }\nit('x', opts, () => {})\n`],
      [TEST, `${head}Reflect.get(it, 'skip')('x', () => {})\n`],
      [TEST, `${head}import * as v from 'vitest'\nv.it.skip('x', () => {})\n`],
      [TEST, `${head}it.for([1])('x', (n, ctx) => { ctx.skip() })\n`],
      [TEST, `${head}import type { TestContext } from 'vitest'\nexport function maybeSkip(ctx: TestContext) { ctx.skip() }\n`],
      ['tests/e2e/canary.spec.ts', "import { test } from '@playwright/test'\ntest('x', async ({}, testInfo) => { testInfo.expectedStatus = 'failed'; throw new Error('bug') })\n"],
      ['tests/e2e/canary.spec.ts', "import { test } from '@playwright/test'\ntest('x', { annotation: { type: 'skip' } }, async () => {})\n"],
      ['tests/e2e/canary.spec.ts', "import { test } from './fixtures'\ntest.skip('x', async () => {})\n"],
    ]
    for (const [file, code] of samples) expect(await ruleIds(file, code), code).toContain('bcs/no-test-skip')
  })
  it('[EG-7] allows data with skip or only fields, it.each rows, expect.fail and harmless test options', async () => {
    const samples = [
      "it('x', () => { const q = { skip: 1, take: 2 }; expect(q.skip).toBe(1) })\n",
      "declare function paginate(n: number): { skip: number; take: number }\nit('x', () => { const { skip, take } = paginate(2); expect(skip + take).toBe(3) })\n",
      "it.each([{ skip: 1 }])('x', (row) => { expect(row.skip).toBe(1) })\n",
      "import { loadGolden } from '../golden/support'\nconst suite = loadGolden('dates')\nit('x', () => { expect((suite as unknown as { only?: number }).only).toBeUndefined() })\n",
      "it('x', () => { expect(() => expect.fail('no')).toThrow() })\n",
      "it('x', { timeout: 1000 }, () => {})\n",
    ]
    const vitest = "import { expect, it } from 'vitest'\n"
    for (const body of samples) expect(await ruleIds(TEST, vitest + body), body).not.toContain('bcs/no-test-skip')
  })
})

describe('pnpm verify arguments', () => {
  const names = ['lint', 'golden', 'integration']
  it('[EG-7] rejects unknown gate names and an empty selection instead of passing with nothing run', () => {
    expect(parseVerifyArgs(['--only=goldne,intergration'], names)).toHaveProperty('error')
    expect(parseVerifyArgs(['--only='], names)).toHaveProperty('error')
    expect(parseVerifyArgs(['--stirct'], names)).toHaveProperty('error')
    expect(parseVerifyArgs(['--strict', '--only=lint,golden'], names)).toEqual({ args: { strict: true, e2e: false, only: ['lint', 'golden'], docsOnlySince: null } })
  })
  it('[EG-7] pnpm verify --only=<typo> exits non-zero', () => {
    const r = spawnSync('pnpm exec tsx scripts/verify.ts --only=goldne,intergration', { cwd: ROOT, shell: true, encoding: 'utf8' })
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('goldne')
    expect(r.stdout).not.toMatch(/→ ผ่าน/)
    // golden case ids are reconciled after the integration gate, whose reports carry GC-BUD-07 (S3-03, §15.4)
    const order = /ด่านที่มี: (.*)$/m.exec(r.stdout)?.[1]?.split(' ') ?? []
    expect(order.indexOf('golden-ids')).toBeGreaterThan(order.indexOf('integration'))
    expect(order.indexOf('integration')).toBeGreaterThan(order.indexOf('golden'))
  }, 60_000)
  it('[EG-7] a gate selected with --only also runs the gates whose reports it reads', () => {
    const all = [...names, 'golden-ids']
    expect(GATE_REQUIRES['golden-ids']).toEqual(['golden', 'integration'])
    expect(parseVerifyArgs(['--only=golden-ids'], all, GATE_REQUIRES)).toEqual({ args: { strict: false, e2e: false, only: ['golden-ids', 'golden', 'integration'], docsOnlySince: null } })
    expect(parseVerifyArgs(['--only=lint'], all, GATE_REQUIRES)).toEqual({ args: { strict: false, e2e: false, only: ['lint'], docsOnlySince: null } })
  })
  it('[EG-7] --only=trace runs every Vitest gate whose report the traceability check reads', () => {
    const all = ['unit', 'golden', 'property', 'integration', 'e2e', 'trace']
    expect(GATE_REQUIRES.trace).toEqual(['unit', 'golden', 'property', 'integration'])
    expect(parseVerifyArgs(['--only=trace'], all, GATE_REQUIRES)).toEqual({
      args: { strict: false, e2e: false, only: ['trace', 'unit', 'golden', 'property', 'integration'], docsOnlySince: null },
    })
  })
  it('[EG-7] the trace gate is the last gate, after every gate that writes a report it reads', () => {
    const r = spawnSync('pnpm exec tsx scripts/verify.ts --only=nosuchgate', { cwd: ROOT, shell: true, encoding: 'utf8' })
    const order = /ด่านที่มี: (.*)$/m.exec(r.stdout)?.[1]?.split(' ') ?? []
    expect(order.at(-1)).toBe('trace')
    expect(order.indexOf('trace')).toBeGreaterThan(order.indexOf('e2e'))
  }, 60_000)
})

describe('pnpm verify lint gate', () => {
  const root = 'C:/repo'
  const file = (rel: string, msgs: unknown[] = []) => ({ filePath: `${root}/${rel}`, messages: msgs })
  it('[EG-7] an ESLint crash is a FAIL, whatever earlier runs left behind', () => {
    const r = evaluateEslintRun({ code: 2, stdout: '', stderr: 'Oops! Something went wrong!' }, { root, expectedFiles: [] })
    expect(r.status).toBe('FAIL')
    expect(r.detail).toContain('Oops')
  })
  it('[EG-7] unreadable output, an unlinted source file or an error is a FAIL', () => {
    expect(evaluateEslintRun({ code: 0, stdout: 'not json', stderr: '' }, { root, expectedFiles: [] }).status).toBe('FAIL')
    const ok = JSON.stringify([file('src/a.ts')])
    expect(evaluateEslintRun({ code: 0, stdout: ok, stderr: '' }, { root, expectedFiles: ['src/a.ts', 'src/b.ts'] }).status).toBe('FAIL')
    const bad = JSON.stringify([file('src/a.ts', [{ ruleId: 'bcs/no-money-literal', severity: 2, line: 3, message: '20000' }])])
    const r = evaluateEslintRun({ code: 1, stdout: bad, stderr: '' }, { root, expectedFiles: ['src/a.ts'] })
    expect(r.status).toBe('FAIL')
    expect(r.detail).toContain('src/a.ts:3 bcs/no-money-literal')
    expect(evaluateEslintRun({ code: 0, stdout: ok, stderr: '' }, { root, expectedFiles: ['src/a.ts'] }).status).toBe('PASS')
  })
  it('[EG-7] pnpm verify --only=lint fails when ESLint cannot run', () => {
    const r = spawnSync('pnpm exec tsx scripts/verify.ts --only=lint', {
      cwd: ROOT,
      shell: true,
      encoding: 'utf8',
      env: { ...process.env, ESLINT_USE_FLAT_CONFIG: 'false' },
    })
    expect(r.status).toBe(1)
    expect(r.stdout).toMatch(/FAIL\s+lint/)
  }, 120_000)
})

describe('pnpm verify vitest gates', () => {
  const root = 'C:/repo'
  const report = (statuses: string[], extra: Partial<VitestJson> = {}): VitestJson => ({
    numTotalTests: statuses.length,
    numPassedTests: statuses.filter((s) => s === 'passed').length,
    numFailedTests: statuses.filter((s) => s === 'failed').length,
    testResults: [
      { name: `${root}/tests/unit/a.test.ts`, status: 'passed', assertionResults: statuses.map((status, i) => ({ fullName: `case ${i} [GC-X-0${i + 1}]`, status })) },
    ],
    ...extra,
  })
  const opts = { root, project: 'unit', expectedFiles: ['tests/unit/a.test.ts'], impact: 'x' }
  it('[EG-7] skipped, todo or pending tests are a FAIL', () => {
    expect(evaluateVitestRun({ code: 0, out: '', report: report(['passed', 'skipped']) }, opts).status).toBe('FAIL')
    expect(evaluateVitestRun({ code: 0, out: '', report: report(['passed', 'todo']) }, opts).status).toBe('FAIL')
    expect(evaluateVitestRun({ code: 0, out: '', report: report(['passed'], { numPendingTests: 1 }) }, opts).status).toBe('FAIL')
    expect(evaluateVitestRun({ code: 0, out: '', report: report(['passed', 'passed']) }, opts).status).toBe('PASS')
  })
  it('[EG-7] a missing report, a test file that did not run, or no tests at all is a FAIL', () => {
    expect(evaluateVitestRun({ code: 1, out: 'boom', report: null }, opts).status).toBe('FAIL')
    expect(evaluateVitestRun({ code: 0, out: '', report: report(['passed']) }, { ...opts, expectedFiles: ['tests/unit/a.test.ts', 'tests/unit/b.test.ts'] }).status).toBe('FAIL')
    expect(evaluateVitestRun({ code: 0, out: '', report: { ...report([]), testResults: [] } }, { ...opts, expectedFiles: [] }).status).toBe('FAIL')
  })
  it('[EG-7] every golden case id needs a passed test named with it', () => {
    const r = report(['passed', 'failed'])
    expect(casesWithoutPassingTest(['GC-X-01', 'GC-X-02', 'GC-X-03', 'GC-X-0'], r)).toEqual(['GC-X-02', 'GC-X-03', 'GC-X-0'])
  })
  it('[EG-7] golden case ids are reconciled against every report of the run, because GC-BUD-07 runs in the int project', () => {
    const golden = report(['passed'])
    const int: VitestJson = {
      ...report([]),
      testResults: [{ name: `${root}/tests/integration/budget.test.ts`, status: 'passed', assertionResults: [{ fullName: '[GC-BUD-07] two approvals at once', status: 'passed' }] }],
    }
    expect(casesWithoutPassingTest(['GC-X-01', 'GC-BUD-07'], [golden])).toEqual(['GC-BUD-07'])
    expect(casesWithoutPassingTest(['GC-X-01', 'GC-BUD-07'], [golden, int])).toEqual([])
    const failedInt: VitestJson = { ...int, testResults: [{ ...int.testResults[0]!, assertionResults: [{ fullName: '[GC-BUD-07] two approvals at once', status: 'failed' }] }] }
    expect(casesWithoutPassingTest(['GC-X-01', 'GC-BUD-07'], [golden, failedInt])).toEqual(['GC-BUD-07'])
  })
  it('[EG-7] a test file that no runner picks up is a FAIL, not a test that silently never runs', () => {
    const vitest = ['tests/unit/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}', 'tests/integration/**/*.test.ts']
    const files = [
      'tests/unit/a.test.ts',
      'tests/unit/b.spec.ts',
      'tests/unit/c.test.js',
      'src/lib/d.test.ts',
      'src/lib/e.spec.tsx',
      'tests/integration/f.test.tsx',
      'tests/g.test.ts',
      'tests/e2e/h.spec.ts',
      'tests/support/factory.ts',
    ]
    expect(orphanTestFiles(files, [...vitest, 'tests/e2e/**'])).toEqual(['tests/unit/b.spec.ts', 'tests/unit/c.test.js', 'src/lib/e.spec.tsx', 'tests/integration/f.test.tsx', 'tests/g.test.ts'])
  })
  it('[EG-7] the e2e gate needs this run’s Playwright report, with tests that ran and none skipped', () => {
    expect(evaluatePlaywrightRun({ code: 1, out: 'boom', report: null }).status).toBe('FAIL')
    expect(evaluatePlaywrightRun({ code: 0, out: '', report: null }).status).toBe('FAIL')
    expect(evaluatePlaywrightRun({ code: 0, out: '', report: { stats: { expected: 0, skipped: 0, unexpected: 0, flaky: 0 } } }).status).toBe('FAIL')
    expect(evaluatePlaywrightRun({ code: 0, out: '', report: { stats: { expected: 3, skipped: 1, unexpected: 0, flaky: 0 } } }).status).toBe('FAIL')
    expect(evaluatePlaywrightRun({ code: 0, out: '', report: { stats: { expected: 3, skipped: 0, unexpected: 0, flaky: 1 } } }).status).toBe('FAIL')
    expect(evaluatePlaywrightRun({ code: 0, out: '', report: { stats: { expected: 3, skipped: 0, unexpected: 0, flaky: 0 } } }).status).toBe('PASS')
  })
  it('[EG-7] the screens and the demo scenes make one report: suites side by side, counts added up', () => {
    const screens = { config: { version: '1' }, suites: [{ title: 'tasks.spec.ts' }], errors: [], stats: { expected: 3, skipped: 0, unexpected: 0, flaky: 0, duration: 9 } }
    const scenes = { suites: [{ title: 'demo/01.spec.ts' }, { title: 'demo/02.spec.ts' }], errors: [{ message: 'x' }], stats: { expected: 2, skipped: 1, unexpected: 1, flaky: 0 } }
    const merged = mergePlaywrightReports([screens, scenes])
    expect(merged.suites).toEqual([{ title: 'tasks.spec.ts' }, { title: 'demo/01.spec.ts' }, { title: 'demo/02.spec.ts' }])
    expect(merged.errors).toEqual([{ message: 'x' }])
    expect(merged.stats).toEqual({ expected: 5, skipped: 1, unexpected: 1, flaky: 0, duration: 9 })
    expect(merged.config).toEqual({ version: '1' })
    expect(evaluatePlaywrightRun({ code: 0, out: '', report: merged }).status).toBe('FAIL')
  })
})

describe('pnpm verify coverage gate', () => {
  const root = 'C:/repo'
  const files = [
    { path: 'src/core/money/math.ts', source: 'export const a = 1' },
    { path: 'src/core/doa/types.ts', source: 'export type T = 1' },
  ]
  const summary = (covered: number): CoverageSummary => ({
    total: { branches: { total: 10, covered } },
    [`${root}/src/core/money/math.ts`]: { branches: { total: 10, covered } },
    [`${root}/src/core/doa/types.ts`]: { branches: { total: 0, covered: 0 } },
  })
  it('[NFR-MNT-02] every branch of every engine file needs a test', () => {
    expect(evaluateCoverage({ code: 0, out: '', summary: summary(10) }, { root, files }).status).toBe('PASS')
    const short = evaluateCoverage({ code: 0, out: '', summary: summary(9) }, { root, files })
    expect(short.status).toBe('FAIL')
    expect(short.detail).toContain('src/core/money/math.ts 9/10 branch')
  })
  it('[NFR-MNT-02] a file no test loads, an ignore comment, a failed run or a missing report is a FAIL', () => {
    const extra = [...files, { path: 'src/core/grni/index.ts', source: 'export const b = 2' }]
    expect(evaluateCoverage({ code: 0, out: '', summary: summary(10) }, { root, files: extra }).detail).toContain('src/core/grni/index.ts ไม่มีเทสต์ที่โหลดไฟล์นี้')
    const ignored = [{ path: 'src/core/money/math.ts', source: '/* v8 ignore next */\nexport const a = 1' }]
    expect(evaluateCoverage({ code: 0, out: '', summary: summary(10) }, { root, files: ignored }).status).toBe('FAIL')
    expect(evaluateCoverage({ code: 1, out: 'boom', summary: summary(10) }, { root, files }).status).toBe('FAIL')
    expect(evaluateCoverage({ code: 0, out: '', summary: null }, { root, files }).status).toBe('FAIL')
  })
})

describe('golden files against spec', () => {
  const blocks = new Map([
    ['tests/golden/money.yaml', 'suite: money\n'],
    ['tests/golden/budget.yaml', 'suite: budget\n'],
    ['tests/golden/wht.yaml', 'suite: wht\n'],
    ['tests/golden/grni.yaml', 'suite: grni\n'],
  ])
  const readFile = (f: string) => blocks.get(f) ?? ''
  it('[EG-7] strict mode requires every golden file finish line A needs', () => {
    const { problems, notes } = goldenDriftProblems({ blocks, present: ['tests/golden/money.yaml'], readFile, strict: true })
    // wht.yaml is required since S8-08 made it a full suite; grni.yaml stays optional (S4-18 is go-live)
    expect(problems).toEqual([expect.stringContaining('tests/golden/budget.yaml'), expect.stringContaining('tests/golden/wht.yaml')])
    expect(notes).toHaveLength(1)
    expect(Object.keys(GOLDEN_STRICT_OPTIONAL).sort()).toEqual(['tests/golden/grni.yaml'])
  })
  it('[EG-7] an edited golden file is a problem in every mode', () => {
    const edited = (f: string) => (f === 'tests/golden/money.yaml' ? 'suite: money\n# edited\n' : readFile(f))
    expect(goldenDriftProblems({ blocks, present: ['tests/golden/money.yaml'], readFile: edited, strict: false }).problems).toHaveLength(1)
  })
})

describe('applied migrations never change', () => {
  const a = 'a'.repeat(64)
  const b = 'b'.repeat(64)
  it('[INV-EVT-01] an edited, deleted or unlocked migration is a problem', () => {
    expect(migrationLockProblems({ files: { m1: b }, lock: { m1: a }, committed: [] })).toEqual([expect.stringContaining('m1')])
    expect(migrationLockProblems({ files: {}, lock: { m1: a }, committed: [] })).toEqual([expect.stringContaining('m1')])
    expect(migrationLockProblems({ files: { m1: a, m2: b }, lock: { m1: a }, committed: [] })).toEqual([expect.stringContaining('m2')])
    expect(migrationLockProblems({ files: { m1: a }, lock: null, committed: [] })).toHaveLength(1)
    expect(migrationLockProblems({ files: { m1: a }, lock: { m1: a }, committed: [] })).toEqual([])
  })
  it('[INV-EVT-01] a committed lock entry cannot be rewritten to match an edited migration', () => {
    const committed = [{ ref: 'HEAD', migrations: { m1: a } }]
    expect(migrationLockProblems({ files: { m1: b }, lock: { m1: b }, committed })).toEqual([expect.stringContaining('HEAD')])
    expect(migrationLockProblems({ files: {}, lock: {}, committed })).toEqual([expect.stringContaining('HEAD')])
    expect(nextLock({ files: { m1: b }, lock: { m1: a }, committed }).problems).not.toEqual([])
    expect(nextLock({ files: { m1: a, m2: b }, lock: { m1: a }, committed })).toEqual({ lock: { m1: a, m2: b }, problems: [] })
  })
  it('[INV-EVT-01] a migration.sql committed in HEAD or at the merge base is frozen even while the lock file is not committed', () => {
    const committedSql = [{ ref: 'HEAD', migrations: { m1: a } }]
    // the working copy edits the committed m1 and the uncommitted lock is regenerated to match it
    expect(migrationLockProblems({ files: { m1: b }, lock: { m1: b }, committed: [], committedSql }).join('\n')).toMatch(/m1.*HEAD/)
    expect(migrationLockProblems({ files: {}, lock: {}, committed: [], committedSql }).join('\n')).toMatch(/m1.*HEAD/)
    expect(nextLock({ files: { m1: b }, lock: null, committed: [], committedSql }).problems).not.toEqual([])
    expect(nextLock({ files: { m1: a, m2: b }, lock: null, committed: [], committedSql })).toEqual({ lock: { m1: a, m2: b }, problems: [] })
    // an edit committed on this branch: the merge base still holds the applied version
    const both = [
      { ref: '83287ede', migrations: { m1: a } },
      { ref: 'HEAD', migrations: { m1: b } },
    ]
    expect(migrationLockProblems({ files: { m1: b }, lock: { m1: b }, committed: [], committedSql: both }).join('\n')).toContain('83287ede')
  })
  it('[EG-7] --strict fails while scripts/migrations.lock.json is not committed', () => {
    const committed = [{ ref: 'HEAD', migrations: { m1: a } }]
    expect(migrationLockProblems({ files: { m1: a }, lock: { m1: a }, committed: [], lockCommitted: false, strict: true })).toEqual([expect.stringContaining('commit')])
    expect(migrationLockProblems({ files: { m1: a }, lock: { m1: a }, committed: [], lockCommitted: false, strict: false })).toEqual([])
    expect(migrationLockProblems({ files: { m1: a }, lock: { m1: a }, committed, lockCommitted: true, strict: true })).toEqual([])
  })
  it('[INV-EVT-01] committed migrations are read from git as the bytes of the committed blob', () => {
    const state = committedState(ROOT)
    const head = state.sql.find((s) => s.ref === 'HEAD')
    expect(head?.migrations['20261002024508_s1_platform']).toBe(migrationChecksums(ROOT)['20261002024508_s1_platform'])
  })
})

describe('database gate checks', () => {
  const trigger = (over: Partial<TriggerRow> = {}): TriggerRow => ({ name: 'event_append_only', functionName: 'bcs_forbid_mutation', type: 1 | 2 | 8 | 16, enabled: 'O', hasCondition: false, ...over })
  it('[INV-EVT-01] the append-only trigger must exist, be enabled, unconditional and fire before UPDATE and DELETE', () => {
    expect(appendOnlyTriggerProblems('Event', [trigger()])).toEqual([])
    expect(appendOnlyTriggerProblems('Event', [])).toHaveLength(1)
    expect(appendOnlyTriggerProblems('Event', [trigger({ enabled: 'D' })])).toHaveLength(1)
    expect(appendOnlyTriggerProblems('Event', [trigger({ enabled: 'R' })])).toHaveLength(1)
    expect(appendOnlyTriggerProblems('Event', [trigger({ hasCondition: true })])).toHaveLength(1)
    expect(appendOnlyTriggerProblems('Event', [trigger({ type: 1 | 2 | 16 })])).toHaveLength(1)
  })
  it('[EG-7] Event.createdAt is stamped by an enabled BEFORE INSERT trigger (§4.5)', () => {
    const stamp = trigger({ name: 'Event_stamp_created_at', functionName: 'bcs_stamp_created_at', type: 1 | 2 | 4 })
    expect(stampTriggerProblems([stamp])).toEqual([])
    expect(stampTriggerProblems([])).toHaveLength(1)
    expect(stampTriggerProblems([{ ...stamp, enabled: 'D' }])).toHaveLength(1)
  })
  it('[EG-7] Event.seq is assigned by the database: GENERATED ALWAYS AS IDENTITY (§4.5)', () => {
    expect(eventSeqProblems('a')).toEqual([])
    // BY DEFAULT lets an insert choose its own place in the global order
    expect(eventSeqProblems('d')).toHaveLength(1)
    expect(eventSeqProblems('')).toHaveLength(1)
    expect(eventSeqProblems(undefined)).toHaveLength(1)
    expect(eventSeqProblems('d').join('\n')).toContain('§4.5')
    expect(eventSeqProblems('d').join('\n')).not.toContain('INV-EVT-03')
  })
  it('[INV-TEN-01] a foreign key between two tenant tables must pair organizationId on both sides', () => {
    const org = new Set(['Member', 'RoleAssignment'])
    const single = { name: 'fk1', fromTable: 'RoleAssignment', toTable: 'Member', fromColumns: ['memberId'], toColumns: ['id'] }
    const composite = { ...single, fromColumns: ['organizationId', 'memberId'], toColumns: ['organizationId', 'id'] }
    const crossed = { ...single, fromColumns: ['organizationId', 'memberId'], toColumns: ['id', 'organizationId'] }
    const toRoot = { name: 'fk2', fromTable: 'Member', toTable: 'Organization', fromColumns: ['organizationId'], toColumns: ['id'] }
    expect(orgForeignKeyProblems([single, crossed], org)).toHaveLength(2)
    expect(orgForeignKeyProblems([composite, toRoot], org)).toEqual([])
  })
  it('[INV-EVT-01] strict mode requires the finish-line tables, except the go-live seal table', () => {
    const { problems, notes } = strictTableProblems(new Set(['Event']))
    expect(problems.map((p) => p.match(/"(\w+)"/)?.[1])).toEqual(['BudgetLedgerEntry', 'BudgetLineBalance', 'RequestLine', 'PositionAssignment', 'DoaVersion'])
    expect(notes).toEqual([expect.stringContaining('EventSeal')])
  })
  it('[INV-EVT-01] probe rows fill required columns and leave the rest to the database', () => {
    const col = (over: Partial<ColumnRow>): ColumnRow => ({ name: 'c', type: 'text', notNull: true, hasDefault: false, identity: '', generated: '', enumLabel: null, ...over })
    expect(probeValueSql(col({ identity: 'a' }))).toBeNull()
    expect(probeValueSql(col({ notNull: false }))).toBeNull()
    expect(probeValueSql(col({ type: 'uuid' }))).toBe('gen_random_uuid()')
    expect(probeValueSql(col({ type: '"ActorType"', enumLabel: "O'K" }))).toBe(`'O''K'::"ActorType"`)
    expect(() => probeValueSql(col({ type: 'point' }))).toThrow(/point/)
  })
})

describe('feature status', () => {
  const spec = [
    '#### FR-TST-001 — Event log',
    'ขั้น S1 · ทุกช่องทาง · §4.5',
    '- AC1 — one',
    '- AC2 — two',
    '#### FR-TST-002 — modules',
    'ขั้น S1 (โมดูล) · S5 (LINE) · Web',
    '- AC1 — one',
  ].join('\n')
  const frs = frsFromSpec(spec)
  const files: Record<string, string> = {
    'tests/integration/x.test.ts': "it('[FR-TST-001/AC1] a', ...)\nit('[FR-TST-001/AC2] b', ...)",
    'tests/unit/plain.test.ts': "it('no tag', ...)",
  }
  const fs: FileProbe = {
    kind: (p) => (p in files ? 'file' : p === 'tests' || p === '.' || p === 'tests/unit' ? 'dir' : 'missing'),
    text: (p) => files[p] ?? '',
  }
  const tested: TestIndex = {
    files: new Map([
      ['FR-TST-001/AC1', ['tests/integration/x.test.ts']],
      ['FR-TST-001/AC2', ['tests/integration/x.test.ts']],
    ]),
    passed: new Set(['FR-TST-001/AC1', 'FR-TST-001/AC2']),
  }
  const doc = (f: FeatureDoc['features']): FeatureDoc => ({ updatedAt: '2026-10-02', features: { 'FR-TST-002': { status: 'planned', step: 'S5', evidence: [] }, ...f } })
  const check = (features: FeatureDoc['features'], tests: TestIndex = tested) => featureStatusProblems({ frs, doc: doc(features), tests, fs })
  it('[EG-7] reads the step line and ACs of each FR from the spec', () => {
    expect(frs.get('FR-TST-002')).toEqual({ steps: ['S1', 'S5'], acs: ['AC1'] })
  })
  it('[EG-7] done needs tagged test files as evidence, not folders or the spec', () => {
    expect(check({ 'FR-TST-001': { status: 'done', step: 'S1', evidence: ['tests/integration/x.test.ts'] } })).toEqual([])
    expect(check({ 'FR-TST-001': { status: 'done', step: 'S1', evidence: ['.'] } }).join('\n')).toMatch(/evidence \. /)
    expect(check({ 'FR-TST-001': { status: 'done', step: 'S1', evidence: ['tests/unit'] } }).join('\n')).toContain('โฟลเดอร์')
    expect(check({ 'FR-TST-001': { status: 'done', step: 'S1', evidence: ['spec.md'] } }).join('\n')).toContain('tests/')
    expect(check({ 'FR-TST-001': { status: 'done', step: 'S1', evidence: ['tests/unit/plain.test.ts'] } }).join('\n')).toContain('แท็ก')
  })
  it('[EG-7] the step must be one named on the FR "ขั้น" line', () => {
    expect(check({ 'FR-TST-001': { status: 'done', step: 'S9', evidence: ['tests/integration/x.test.ts'] } }).join('\n')).toContain('S9')
  })
  it('[EG-7] steps S16 and S17 of spec 0.3 are valid steps, S18 is not', () => {
    const v3 = frsFromSpec(['#### FR-TST-003 — x', 'ขั้น S16 · S17 · Web', '- AC1 — one'].join('\n'))
    const planned = (step: string) => featureStatusProblems({ frs: v3, doc: { updatedAt: '2026-10-08', features: { 'FR-TST-003': { status: 'planned', step, evidence: [] } } }, tests: tested, fs })
    expect(planned('S16')).toEqual([])
    expect(planned('S17')).toEqual([])
    expect(planned('S18').join('\n')).toContain('S18')
  })
  it('[EG-7] done needs a passing tagged test for every AC', () => {
    const half: TestIndex = { files: new Map([['FR-TST-001/AC1', ['tests/integration/x.test.ts']]]), passed: new Set(['FR-TST-001/AC1']) }
    expect(check({ 'FR-TST-001': { status: 'done', step: 'S1', evidence: ['tests/integration/x.test.ts'] } }, half).join('\n')).toContain('AC2')
    const failing: TestIndex = { ...tested, passed: new Set(['FR-TST-001/AC1']) }
    expect(check({ 'FR-TST-001': { status: 'done', step: 'S1', evidence: ['tests/integration/x.test.ts'] } }, failing).join('\n')).toContain('AC2')
  })
  it('[EG-7] planned is out of date once an AC has tests, and verified/live need a real verifier', () => {
    expect(check({ 'FR-TST-001': { status: 'planned', step: 'S1', evidence: [] } }).join('\n')).toContain('planned')
    const live = { status: 'live', step: 'S1', evidence: ['tests/integration/x.test.ts'] }
    expect(check({ 'FR-TST-001': { ...live, verifiedBy: 'x' } }).join('\n')).toContain('verifiedBy')
    expect(check({ 'FR-TST-001': { ...live, verifiedBy: 'สมชาย (จัดซื้อ)' } })).toEqual([])
  })
  it('[EG-7] only tags in test titles count as tests, not tags in other strings or comments', () => {
    const source = "it('[FR-TST-001/AC1] x', () => {})\nconst note = '[FR-TST-001/AC2]'\n// [FR-TST-001/AC3]\n"
    expect(testTitleTags(source)).toEqual(['FR-TST-001/AC1'])
  })
  it('[EG-7] a tag later on the line of a test call is not in its title', () => {
    const source = "it('x', () => {}) // [FR-TST-001/AC1]\ntest('y', () => { expect('[FR-TST-001/AC2]').toBeTruthy() })\ntest.describe(`[FR-TST-001/AC3] z`, () => {})\n"
    expect(testTitleTags(source)).toEqual(['FR-TST-001/AC3'])
  })
})
