import { describe, expect, it } from 'vitest'
import { amountToSatang, satangToAmount } from '@/core/money/dto'
import { checkAgreement, checkAgreementLine, priceReference, quoteRange, type Agreement } from '@/core/pricing'
import { loadYaml, pick } from './doa-fixtures'

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

interface RefSuite {
  settings: { windowDays: number; minSamples: number; alertBp: number }
  defaults: { at: string; approvedAt: string; priceIncludesVat: boolean }
  cases: Array<{
    id: string
    title?: string
    fn?: string
    input: {
      samples?: Array<{ unitPrice: string; approvedAt?: string; priceIncludesVat?: boolean }>
      price?: string
      requestIncludesVat?: boolean
      at?: string
      vatRateBp?: number
      quotes?: Array<{ ref: string; amount: string; includesVat: boolean }>
      selected?: string
    }
    expect: Record<string, unknown>
  }>
}

const refSuite = loadYaml<RefSuite>('price-reference.yaml')
const baht = (s: bigint | null) => (s === null ? null : satangToAmount(s))

describe('[FR-DOA-101/AC1] golden price-reference.yaml: the price reference and the quotation range', () => {
  const cases = refSuite.cases.filter((c) => c.fn === undefined || c.fn === 'quoteRange')
  it('has the cases of S6-11', () => expect(cases.map((c) => c.id)).toEqual(['GC-PRC-06', 'GC-PRC-07', 'GC-PRC-08', 'GC-PRC-09', 'GC-PRC-10', 'GC-PRC-11', 'GC-PRC-12', 'GC-PRC-13', 'GC-PRC-14', 'GC-PRC-15']))
  for (const c of cases) {
    it(`[${c.id}] ${c.title ?? c.fn ?? 'priceReference'}`, () => {
      if (c.fn === 'quoteRange') {
        const r = quoteRange(c.input.quotes!.map((q) => ({ ref: q.ref, amountSatang: amountToSatang(q.amount), includesVat: q.includesVat })), c.input.selected ?? null, c.input.vatRateBp!)
        expect({ count: r.count, lowest: baht(r.lowest), highest: baht(r.highest), selected: baht(r.selected), selectedIsLowest: r.selectedIsLowest }).toEqual(c.expect)
        return
      }
      const d = refSuite.defaults
      const samples = c.input.samples!.map((s) => ({ unitPriceSatang: amountToSatang(s.unitPrice), approvedAt: new Date(s.approvedAt ?? d.approvedAt), priceIncludesVat: s.priceIncludesVat ?? d.priceIncludesVat }))
      const r = priceReference(samples, amountToSatang(c.input.price!), c.input.requestIncludesVat ?? false, new Date(c.input.at ?? d.at), refSuite.settings)
      const actual = { ...r, min: baht(r.min), median: baht(r.median), max: baht(r.max), last: baht(r.last) }
      expect(pick(actual, c.expect)).toEqual(c.expect)
    })
  }
})
