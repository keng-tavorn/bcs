import { describe, expect, it } from 'vitest'
import { normalizeAccount } from '@/core/bankfile'
import { BANKS } from '@/core/bankfile/banks'
import { loadYaml } from './doa-fixtures'

// tests/golden/bank-account.yaml (spec §7.15, BR-SUP-07): each case through normalizeAccount; the suite's list of banks
// is the program's (ADR-131).

interface AccountCase {
  id: string
  title: string
  fn: 'normalizeAccount'
  input: { bankCode: string; accountNo: string; accountName?: string }
  expect: Record<string, unknown>
}

const suite = loadYaml<{ banks: string[]; cases: AccountCase[] }>('bank-account.yaml')

describe('golden bank-account.yaml', () => {
  it('has the cases of the suite, and the banks of the program', () => {
    expect(suite.cases.length).toBe(8)
    expect(suite.banks).toEqual(BANKS.map((b) => b.code))
  })
  for (const c of suite.cases) {
    it(`[${c.id}] ${c.title}`, () => {
      const r = normalizeAccount(c.input)
      expect(r.ok ? { accountNo: r.accountNo, masked: r.masked } : { error: r.code, reason: r.reason }).toEqual(c.expect)
    })
  }
})
