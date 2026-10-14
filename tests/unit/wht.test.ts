import { describe, expect, it } from 'vitest'
import { paymentWithholding, retentionWhtBases, returnForm, whtBases, whtForPayment, type WhtForPaymentInput } from '@/core/wht'

// src/core/wht beyond the golden cases of tests/golden/wht.yaml (BR-WHT-04 to BR-WHT-06, BR-WHT-10): the refusals of
// bad input, the forms of each payee, and the bases of one invoice with its retention shared over its lines.

const service: WhtForPaymentInput = { payeeType: 'JURISTIC', incomeType: 'SERVICE', rateBp: 300, typeForm: 'PND3_53', poNetSatang: 500_000n, baseSatang: 100_000n, minimumBaseSatang: 100_000n }

describe('[BR-WHT-04] returnForm', () => {
  it('an income type of one return takes only its payee', () => {
    expect(returnForm('INDIVIDUAL', 'PND3')).toEqual({ ok: true, form: 'PND3' })
    expect(returnForm('JURISTIC', 'PND3')).toEqual({ ok: false, code: 'WHT_FORM_PAYEE_MISMATCH', reason: null })
    expect(returnForm('JURISTIC', 'PND53')).toEqual({ ok: true, form: 'PND53' })
    expect(returnForm('INDIVIDUAL', 'PND3_53')).toEqual({ ok: true, form: 'PND3' })
    expect(returnForm('FOREIGN', 'PND3_53')).toEqual({ ok: false, code: 'VALIDATION_FAILED', reason: 'FOREIGN_PAYEE' })
  })
})

describe('[BR-WHT-05] whtForPayment refuses what is not an amount or a rate', () => {
  it('negative amounts and rates that are not whole basis points throw', () => {
    expect(() => whtForPayment({ ...service, baseSatang: -1n })).toThrow(RangeError)
    expect(() => whtForPayment({ ...service, poNetSatang: -1n })).toThrow(RangeError)
    expect(() => whtForPayment({ ...service, minimumBaseSatang: -1n })).toThrow(RangeError)
    expect(() => whtForPayment({ ...service, rateBp: 2.5 })).toThrow(RangeError)
  })
  it('an income type without a form withholds nothing', () => {
    expect(whtForPayment({ ...service, typeForm: null })).toEqual({ ok: true, form: null, whtSatang: 0n, reason: 'NOT_APPLICABLE' })
  })
})

describe('[BR-WHT-10] paymentWithholding', () => {
  it('nothing to withhold is no group; a bad rate throws; any negative document base refuses the payment', () => {
    expect(paymentWithholding([])).toEqual({ ok: true, groups: [], whtSatang: 0n })
    expect(() => paymentWithholding([{ doc: 'A', incomeType: 'SERVICE', rateBp: -1, baseSatang: 100n }])).toThrow(RangeError)
    expect(
      paymentWithholding([
        { doc: 'A', incomeType: 'SERVICE', rateBp: 300, baseSatang: 10_000n },
        { doc: 'B', incomeType: 'SERVICE', rateBp: 300, baseSatang: -100n },
      ]),
    ).toEqual({ ok: false, code: 'VALIDATION_FAILED', reason: 'WHT_BASE_NEGATIVE' })
  })
})

describe('[BR-WHT-05] [BR-WHT-06] whtBases of one invoice', () => {
  const lines = [
    { incomeType: 'CONTRACT', rateBp: 300, netSatang: 70_000n },
    { incomeType: null, rateBp: 0, netSatang: 50_000n },
    { incomeType: 'CONTRACT', rateBp: 300, netSatang: 30_000n },
    { incomeType: 'RENT', rateBp: 500, netSatang: 10_001n },
  ]
  it('one base per (income type, rate), each line less its share of the retention; goods lines withhold nothing', () => {
    // retention 160.01 over 700 / 500 / 300 / 100.01 by largest remainder: 70.01 50.00 30.00 10.00 (the leftover
    // satang goes to the first line, whose remainder is the largest)
    const bases = whtBases({ doc: 'INV-1', lines, retentionSatang: 16_001n, poNetSatang: 1_000_000n, minimumBaseSatang: 100_000n })
    expect(bases).toEqual([
      { doc: 'INV-1', incomeType: 'CONTRACT', rateBp: 300, baseSatang: 70_000n - 7_001n + (30_000n - 3_000n) },
      { doc: 'INV-1', incomeType: 'RENT', rateBp: 500, baseSatang: 10_001n - 1_000n },
    ])
  })
  it('a PO below the minimum has no base at all', () => {
    expect(whtBases({ doc: 'INV-1', lines, retentionSatang: 0n, poNetSatang: 99_999n, minimumBaseSatang: 100_000n })).toEqual([])
  })
})

describe('[BR-WHT-05] retentionWhtBases of a released retention', () => {
  const lines = [
    { incomeType: 'CONTRACT', rateBp: 300, netSatang: 70_000n },
    { incomeType: null, rateBp: 0, netSatang: 50_000n },
    { incomeType: 'CONTRACT', rateBp: 300, netSatang: 30_000n },
  ]
  it('the retention as whtBases shares it: the same lines and types, goods withhold nothing (GC-WHT-21 by its parts)', () => {
    // 75.00 over 700 / 500 / 300: 35.00 25.00 15.00 → CONTRACT 50.00
    expect(retentionWhtBases({ doc: 'RET-1', lines, retentionSatang: 7_500n, poNetSatang: 1_000_000n, minimumBaseSatang: 100_000n })).toEqual([{ doc: 'RET-1', incomeType: 'CONTRACT', rateBp: 300, baseSatang: 5_000n }])
    expect(retentionWhtBases({ doc: 'RET-1', lines, retentionSatang: 7_500n, poNetSatang: 99_999n, minimumBaseSatang: 100_000n })).toEqual([])
  })
})
