import path from 'node:path'
import { ESLint } from 'eslint'
import { beforeAll, describe, expect, it, vi } from 'vitest'

// INV-SUP-04 (S7-10 · ADR-190): S7 reaches bank accounts through proposeBankAccountChange only — a file of the portal or
// of the supplier services that imports the bank-accounts service is refused by lint; bank-proposal.ts is the one way.

const ROOT = path.resolve(import.meta.dirname, '..', '..')
vi.setConfig({ testTimeout: 60_000 })
let eslint: ESLint
beforeAll(() => {
  eslint = new ESLint({ cwd: ROOT })
})

async function restricted(file: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(ROOT, file), warnIgnored: true })
  return (result?.messages ?? []).filter((m) => m.ruleId === 'no-restricted-imports').map((m) => m.message)
}

const IMPORT = "import { createBankAccountChange } from '../bank-accounts'\nexport const x = createBankAccountChange\n"

describe('[INV-SUP-04] the bank-accounts service only through proposeBankAccountChange', () => {
  it('a supplier service or the portal importing it is refused', async () => {
    expect((await restricted('src/server/services/suppliers/sneaky.ts', IMPORT)).join(' ')).toContain('INV-SUP-04')
    expect((await restricted('src/server/portal/sneaky.ts', "import { createBankAccountChange } from '@/server/services/bank-accounts'\nexport const x = createBankAccountChange\n")).join(' ')).toContain('INV-SUP-04')
  })

  it('bank-proposal.ts may, and Prisma stays refused everywhere there', async () => {
    expect(await restricted('src/server/services/suppliers/bank-proposal.ts', IMPORT)).toEqual([])
    expect((await restricted('src/server/services/suppliers/sneaky.ts', "import { PrismaClient } from '@prisma/client'\nexport const x = PrismaClient\n")).join(' ')).toContain('Prisma')
  })
})
