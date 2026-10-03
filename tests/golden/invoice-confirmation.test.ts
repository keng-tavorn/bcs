import { describe, expect, it } from 'vitest'
import { confirmInvoice, normalizeInvoiceNo } from '@/core/invoice'
import { amountToSatang, satangToAmount } from '@/core/money/dto'
import { loadYaml, pick } from './doa-fixtures'

// tests/golden/invoice-confirmation.yaml (spec §7.12): GC-IVC-01 to GC-IVC-05. The invoices of a case are recorded in
// order against the same PO; a refused one changes nothing.

interface InvoiceSuite {
  cases: Array<{
    id: string
    title?: string
    input: { committed: string[]; existingInvoiceNos?: string[]; invoices: Array<{ invoiceNo: string; net: string }> }
    expect: Record<string, unknown>
  }>
}

const suite = loadYaml<InvoiceSuite>('invoice-confirmation.yaml')

describe('[FR-P2P-008/AC1] golden invoice-confirmation.yaml', () => {
  it('has cases', () => expect(suite.cases.length).toBeGreaterThan(0))
  for (const c of suite.cases) {
    it(`[${c.id}] ${c.title ?? ''}`.trim(), () => {
      let remaining = c.input.committed.map(amountToSatang)
      const actual = remaining.map(() => 0n)
      const existing = new Set((c.input.existingInvoiceNos ?? []).map(normalizeInvoiceNo))
      const results: string[] = []
      for (const inv of c.input.invoices) {
        const r = confirmInvoice(remaining, amountToSatang(inv.net), inv.invoiceNo, existing)
        if (!r.ok) {
          results.push(r.error)
          continue
        }
        results.push('ok')
        existing.add(r.normalizedNo)
        r.allocation.forEach((a, i) => (actual[i] = actual[i]! + a))
        remaining = [...r.remaining]
      }
      expect(pick({ results, actualByLine: actual.map(satangToAmount), remaining: remaining.map(satangToAmount) }, c.expect)).toEqual(c.expect)
    })
  }
})

describe('invoice confirmation beyond the golden cases', () => {
  it('shares ties to the earlier line first, and refuses amounts that are not above zero', () => {
    expect(confirmInvoice([100n, 100n, 100n], 100n, 'X', new Set())).toMatchObject({ ok: true, allocation: [34n, 33n, 33n] })
    expect(() => confirmInvoice([100n], 0n, 'X', new Set())).toThrow(RangeError)
    expect(normalizeInvoiceNo('\tab 12 c\n')).toBe('AB12C')
  })
})
