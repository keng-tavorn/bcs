import { describe, expect, it } from 'vitest'
import { amountToSatang } from '@/core/money/dto'
import { checkAgreement, checkAgreementLine, type Agreement } from '@/core/pricing'
import { loadYaml } from './doa-fixtures'

// tests/golden/price-reference.yaml (spec §7.17): GC-PRC-01 to GC-PRC-05, the agreed prices of the catalogue (BR-PRC-06).
// The price reference of S6-11 (GC-PRC-06 onwards) joins this file with its own runner.

interface Period {
  item: string
  supplier: string
  validFrom: string
  validTo: string
}
interface PriceCase {
  id: string
  title?: string
  fn?: string
  input: {
    existing?: Period[]
    add?: Period
    agreement?: { item: string; supplier: string; unitPrice: string }
    line?: { item: string; supplier: string; unitPrice: string }
    offAgreementReason?: string
  }
  expect: Record<string, unknown>
}

const suite = loadYaml<{ cases: PriceCase[] }>('price-reference.yaml')
const period = (p: Period) => ({ catalogItemId: p.item, supplierId: p.supplier, validFrom: p.validFrom, validTo: p.validTo })
const outcome = (r: { ok: true } | { ok: false; error: { code: string; details?: Record<string, unknown> } }) => (r.ok ? { ok: true } : { error: r.error.code, reason: r.error.details?.reason })

describe('[FR-INT-102/AC2] golden price-reference.yaml: agreed prices', () => {
  const cases = suite.cases.filter((c) => c.fn === 'checkAgreement' || c.fn === 'checkAgreementLine')
  it('has the cases of S6-10', () => expect(cases.map((c) => c.id)).toEqual(['GC-PRC-01', 'GC-PRC-02', 'GC-PRC-03', 'GC-PRC-04', 'GC-PRC-05']))
  for (const c of cases) {
    it(`[${c.id}] ${c.title ?? c.fn}`, () => {
      if (c.fn === 'checkAgreement') {
        expect(outcome(checkAgreement(c.input.existing!.map(period), period(c.input.add!)))).toEqual(c.expect)
        return
      }
      const a = c.input.agreement!
      const agreement: Agreement = { id: 'A1', catalogItemId: a.item, supplierId: a.supplier, unitPriceSatang: amountToSatang(a.unitPrice), validFrom: '2026-01-01', validTo: '2027-01-01' }
      const l = c.input.line!
      expect(outcome(checkAgreementLine([agreement], { catalogItemId: l.item, supplierId: l.supplier, unitPriceSatang: amountToSatang(l.unitPrice) }, c.input.offAgreementReason ?? null))).toEqual(c.expect)
    })
  }
})
