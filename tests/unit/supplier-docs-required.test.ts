import { describe, expect, it } from 'vitest'
import { requiredDocumentFor } from '@/core/supplier-docs'

// S7-28 (BR-SDOC-01): a type is required of a payee when it is required, applies to the payee's type, and — the VAT
// registration (ภ.พ.20) — when the payee is registered for VAT

describe('[FR-SUP-102/AC4] S7-28 the required documents of a payee', () => {
  it('the rule: required, of the payee type, and for VAT_CERT registered for VAT', () => {
    const vat = { code: 'VAT_CERT', required: true, appliesTo: ['JURISTIC', 'INDIVIDUAL'] }
    expect(requiredDocumentFor(vat, { payeeType: 'INDIVIDUAL', isVatRegistered: false })).toBe(false)
    expect(requiredDocumentFor(vat, { payeeType: 'INDIVIDUAL', isVatRegistered: true })).toBe(true)
    expect(requiredDocumentFor(vat, { payeeType: 'FOREIGN', isVatRegistered: true })).toBe(false)
    expect(requiredDocumentFor({ code: 'ID_CARD', required: true, appliesTo: ['INDIVIDUAL'] }, { payeeType: 'INDIVIDUAL', isVatRegistered: false })).toBe(true)
    expect(requiredDocumentFor({ code: 'ISO_CERT', required: false, appliesTo: ['INDIVIDUAL'] }, { payeeType: 'INDIVIDUAL', isVatRegistered: true })).toBe(false)
  })

})
