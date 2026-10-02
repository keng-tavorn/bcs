// Gate canaries: each project lint rule must reject a known-bad sample, so the lint gate can never pass
// vacuously (spec §4.10, §17.3). Files are linted virtually via lintText; nothing is written to src/.
import path from 'node:path'
import { ESLint } from 'eslint'
import { beforeAll, describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
let eslint: ESLint

beforeAll(() => {
  eslint = new ESLint({ cwd: ROOT })
}, 60_000)

async function ruleIds(file: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(ROOT, file) })
  return (result?.messages ?? []).map((m) => m.ruleId ?? `fatal:${m.message}`)
}

const count = (ids: string[], id: string) => ids.filter((x) => x === id).length

describe('bcs/no-money-literal (P-2)', () => {
  it('rejects a numeric approval limit in src', async () => {
    expect(await ruleIds('src/server/services/canary.ts', 'export const limit = 20000\n')).toContain('bcs/no-money-literal')
  })
  it('rejects bigint and money-shaped strings', async () => {
    const ids = await ruleIds(
      'src/server/services/canary.ts',
      'export const a = 100000n\nexport const b = "20,000.00"\nexport const c = "100000.00"\n',
    )
    expect(count(ids, 'bcs/no-money-literal')).toBe(3)
  })
  it('allows small numbers and the technical constants file', async () => {
    expect(await ruleIds('src/server/services/canary.ts', 'export const pageSize = 100\n')).not.toContain('bcs/no-money-literal')
    expect(await ruleIds('src/core/money/constants.ts', 'export const BP_DENOMINATOR = 10_000n\n')).not.toContain(
      'bcs/no-money-literal',
    )
  })
})

describe('bcs/no-org-code (NG-7)', () => {
  it('rejects an organization code literal and comparisons with org codes', async () => {
    expect(await ruleIds('src/server/services/canary.ts', "export const x = 'LK-RICH'\n")).toContain('bcs/no-org-code')
    expect(
      await ruleIds('src/server/services/canary.ts', "export function f(org: { code: string }) { return org.code === 'ACME' }\n"),
    ).toContain('bcs/no-org-code')
  })
})

describe('functional core purity (§4.2, §17.3)', () => {
  it('rejects ambient time, randomness and env in src/core', async () => {
    const ids = await ruleIds(
      'src/core/canary/clock.ts',
      'export const a = Date.now()\nexport const b = new Date()\nexport const c = Math.random()\nexport const d = process.env.X\n',
    )
    expect(count(ids, 'no-restricted-syntax')).toBe(4)
  })
  it('allows new Date(value) in core', async () => {
    expect(await ruleIds('src/core/canary/clock.ts', 'export const toDate = (iso: string) => new Date(iso)\n')).not.toContain(
      'no-restricted-syntax',
    )
  })
  it('rejects non-allowlisted imports in src/core', async () => {
    const ids = await ruleIds(
      'src/core/canary/io.ts',
      "import fs from 'node:fs'\nimport { locales } from '@/i18n/locales'\nexport { fs, locales }\n",
    )
    expect(count(ids, 'bcs/core-imports')).toBe(2)
  })
  it('allows zod, decimal.js, date-fns and @date-fns/tz in src/core', async () => {
    const code =
      "import { z } from 'zod'\nimport Decimal from 'decimal.js'\nimport { addDays } from 'date-fns'\nimport { TZDate } from '@date-fns/tz'\nexport { z, Decimal, addDays, TZDate }\n"
    expect(await ruleIds('src/core/canary/ok.ts', code)).not.toContain('bcs/core-imports')
  })
})

describe('layer boundaries (§4.10)', () => {
  it('rejects core importing another layer', async () => {
    expect(await ruleIds('src/core/canary/layer.ts', "import { locales } from '@/i18n/locales'\nexport { locales }\n")).toContain(
      'boundaries/dependencies',
    )
  })
  it('rejects ui importing app, and lib importing i18n', async () => {
    expect(await ruleIds('src/ui/canary.tsx', "import Page from '@/app/page'\nexport { Page }\n")).toContain('boundaries/dependencies')
    expect(await ruleIds('src/lib/canary.ts', "import { locales } from '@/i18n/locales'\nexport { locales }\n")).toContain(
      'boundaries/dependencies',
    )
  })
  it('allows app importing i18n', async () => {
    const code = "import { locales } from '@/i18n/locales'\nexport default function P() { return locales.length }\n"
    expect(await ruleIds('src/app/canary/page.tsx', code)).not.toContain('boundaries/dependencies')
  })
  it('rejects Prisma imports outside src/server/db', async () => {
    expect(
      await ruleIds('src/server/services/canary.ts', "import { PrismaClient } from '@prisma/client'\nexport { PrismaClient }\n"),
    ).toContain('no-restricted-imports')
  })
})

describe('raw SQL only in src/server/db/sql (§4.8)', () => {
  it('rejects $queryRaw in a service and $queryRawUnsafe anywhere', async () => {
    const code = 'declare const db: any\nexport const a = db.$queryRaw`select 1`\nexport const b = db.$queryRawUnsafe("select 1")\n'
    expect(count(await ruleIds('src/server/services/canary.ts', code), 'no-restricted-syntax')).toBe(2)
    expect(count(await ruleIds('src/server/db/sql/canary.ts', code), 'no-restricted-syntax')).toBe(1)
  })
})

describe('screen text, exports and test hygiene', () => {
  it('rejects Thai text hard-coded in screens (NFR-I18N-01)', async () => {
    const code = 'export default function P() { return <p>ส่งขออนุมัติ</p> }\n'
    expect(await ruleIds('src/app/canary/page.tsx', code)).toContain('bcs/no-thai-literal')
  })
  it('rejects default exports outside Next.js special files (§14.4)', async () => {
    expect(await ruleIds('src/lib/canary.ts', 'const x = 1\nexport default x\n')).toContain('import/no-default-export')
    expect(await ruleIds('src/app/canary/page.tsx', 'export default function P() { return null }\n')).not.toContain(
      'import/no-default-export',
    )
  })
  it('rejects skipped or focused tests (CLAUDE.md §9)', async () => {
    const code = "import { it } from 'vitest'\nit.skip('x', () => {})\nit.only('y', () => {})\n"
    expect(count(await ruleIds('tests/unit/canary.test.ts', code), 'no-restricted-syntax')).toBe(2)
  })
})
