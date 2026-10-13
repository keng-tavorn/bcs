import { describe, expect, it } from 'vitest'
import { dueDate, suggestCoding, type CodingHistory } from '@/core/invoice/ap'
import { loadYaml, pick } from './doa-fixtures'

// tests/golden/ap.yaml (spec §7.18): the due date of an invoice (BR-AP-07) and the account code suggested from the
// history (BR-AP-10, 365 days by the default of OQ-128). Every case of the file, counted from it.

interface ApCase {
  id: string
  title?: string
  fn: 'dueDate' | 'suggestCoding'
  input: Record<string, unknown>
  expect: Record<string, unknown>
}

const suite = loadYaml<{ cases: ApCase[] }>('ap.yaml')
const WINDOW_DAYS = 365

function run(c: ApCase): Record<string, unknown> {
  if (c.fn === 'dueDate') {
    const i = c.input as { invoiceDate: string; poTermDays: number | null; supplierTermDays: number | null; defaultTermDays: number }
    return { dueDate: dueDate(i) }
  }
  const i = c.input as { invoiceDate: string; taxId: string; categoryCode: string; budgetLine: { accountCode: string | null; costCenter: string }; history: CodingHistory[] }
  return { ...suggestCoding({ ...i, windowDays: WINDOW_DAYS }) }
}

describe('[FR-AP-102/AC3] [FR-AP-108/AC1] golden ap.yaml', () => {
  it('has cases', () => expect(suite.cases.length).toBeGreaterThan(0))
  for (const c of suite.cases) {
    it(`[${c.id}] ${c.title ?? ''}`.trim(), () => {
      const actual = run(c)
      expect(pick(actual, c.expect)).toEqual(c.expect)
      expect(Object.keys(actual).sort()).toEqual(Object.keys(c.expect).sort())
    })
  }
})

describe('dueDate and suggestCoding beyond the golden cases', () => {
  it('refuses a date that does not exist, negative credit days and a negative window', () => {
    expect(() => dueDate({ invoiceDate: '2026-02-30', poTermDays: 1, supplierTermDays: null, defaultTermDays: 30 })).toThrow(RangeError)
    expect(() => dueDate({ invoiceDate: '30/10/2026', poTermDays: 1, supplierTermDays: null, defaultTermDays: 30 })).toThrow(RangeError)
    expect(() => dueDate({ invoiceDate: '2026-10-30', poTermDays: -1, supplierTermDays: null, defaultTermDays: 30 })).toThrow(RangeError)
    const base = { invoiceDate: '2026-10-11', taxId: 'T', categoryCode: 'C', budgetLine: { accountCode: '510101', costCenter: 'CC' }, history: [] }
    expect(() => suggestCoding({ ...base, windowDays: -1 })).toThrow(RangeError)
  })

  it('a supplier without a tax id has no history; a use after the invoice date does not count', () => {
    const history = [{ taxId: 'T', categoryCode: 'C', accountCode: '530101', invoiceDate: '2026-10-01' }]
    const base = { invoiceDate: '2026-10-11', categoryCode: 'C', budgetLine: { accountCode: '510101', costCenter: 'CC' }, windowDays: 365 }
    expect(suggestCoding({ ...base, taxId: null, history })).toMatchObject({ source: 'BUDGET_LINE', accountCode: '510101' })
    expect(suggestCoding({ ...base, taxId: 'T', history: [{ ...history[0]!, invoiceDate: '2026-10-12' }] })).toMatchObject({ source: 'BUDGET_LINE' })
    // the same code used twice keeps its latest day
    expect(suggestCoding({ ...base, taxId: 'T', history: [history[0]!, { ...history[0]!, invoiceDate: '2026-09-01' }] })).toMatchObject({ source: 'HISTORY', count: 2 })
  })
})
