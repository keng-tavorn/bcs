import { describe, expect, it } from 'vitest'
import { dueDate } from '@/core/invoice/ap'
import { loadYaml, pick } from './doa-fixtures'

// tests/golden/ap.yaml (spec §7.18): the due date of an invoice (BR-AP-07); the account-code suggestions (BR-AP-10)
// join in S8-11. Every case of the file, counted from it.

interface ApCase {
  id: string
  title?: string
  fn: 'dueDate' | 'suggestCoding'
  input: Record<string, unknown>
  expect: Record<string, unknown>
}

const suite = loadYaml<{ cases: ApCase[] }>('ap.yaml')

describe('[FR-AP-102/AC3] golden ap.yaml', () => {
  it('has cases', () => expect(suite.cases.length).toBeGreaterThan(0))
  for (const c of suite.cases) {
    it(`[${c.id}] ${c.title ?? ''}`.trim(), () => {
      const i = c.input as { invoiceDate: string; poTermDays: number | null; supplierTermDays: number | null; defaultTermDays: number }
      expect(c.fn).toBe('dueDate')
      expect(pick({ dueDate: dueDate(i) }, c.expect)).toEqual(c.expect)
    })
  }
})

describe('dueDate beyond the golden cases', () => {
  it('refuses a date that does not exist and negative credit days', () => {
    expect(() => dueDate({ invoiceDate: '2026-02-30', poTermDays: 1, supplierTermDays: null, defaultTermDays: 30 })).toThrow(RangeError)
    expect(() => dueDate({ invoiceDate: '30/10/2026', poTermDays: 1, supplierTermDays: null, defaultTermDays: 30 })).toThrow(RangeError)
    expect(() => dueDate({ invoiceDate: '2026-10-30', poTermDays: -1, supplierTermDays: null, defaultTermDays: 30 })).toThrow(RangeError)
  })
})
