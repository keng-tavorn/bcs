import { describe, expect, it } from 'vitest'
import { agreementDay, agreementsInEffect, checkAgreement, checkAgreementLine, type Agreement } from '@/core/pricing'

// BR-PRC-06 beyond the golden cases: a period that ends before it starts, another item or supplier never clashes, the
// agreements of a day, an item without agreements, and the agreed line that refers to its agreement.

const A: Agreement = { id: 'A1', catalogItemId: 'MAT-004', supplierId: 'S1', unitPriceSatang: 17_700n, validFrom: '2026-01-01', validTo: '2027-01-01' }

describe('[FR-INT-102/AC2] agreed prices', () => {
  it('a period must end after it starts; other items and suppliers never clash', () => {
    expect(checkAgreement([], { ...A, validTo: '2026-01-01' })).toMatchObject({ ok: false, error: { details: { reason: 'INVALID_PERIOD' } } })
    expect(checkAgreement([A], { ...A, supplierId: 'S2' })).toEqual({ ok: true, data: undefined })
    expect(checkAgreement([A], { ...A, catalogItemId: 'MAT-005' })).toEqual({ ok: true, data: undefined })
  })

  it('the day of an instant is its Thai calendar day', () => {
    expect(agreementDay(new Date('2026-12-31T16:59:59Z'))).toBe('2026-12-31')
    expect(agreementDay(new Date('2026-12-31T17:00:00Z'))).toBe('2027-01-01')
  })

  it('the agreements in effect on a day: from validFrom, up to the day before validTo', () => {
    expect(agreementsInEffect([A], 'MAT-004', '2026-01-01')).toEqual([A])
    expect(agreementsInEffect([A], 'MAT-004', '2026-12-31')).toEqual([A])
    expect(agreementsInEffect([A], 'MAT-004', '2027-01-01')).toEqual([])
    expect(agreementsInEffect([A], 'MAT-004', '2025-12-31')).toEqual([])
    expect(agreementsInEffect([A], 'MAT-005', '2026-06-01')).toEqual([])
  })

  it('an agreed line refers to its agreement; an item without one is free; no supplier with an agreed item needs a reason', () => {
    expect(checkAgreementLine([A], { catalogItemId: 'MAT-004', supplierId: 'S1', unitPriceSatang: 17_700n }, null)).toEqual({ ok: true, data: { priceAgreementId: 'A1' } })
    expect(checkAgreementLine([A], { catalogItemId: 'MAT-009', supplierId: null, unitPriceSatang: 1n }, null)).toEqual({ ok: true, data: { priceAgreementId: null } })
    expect(checkAgreementLine([A], { catalogItemId: 'MAT-004', supplierId: null, unitPriceSatang: 17_700n }, '  ')).toMatchObject({ ok: false, error: { details: { reason: 'AGREEMENT_OFF' } } })
  })
})
