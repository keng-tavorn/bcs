import { describe, expect, it } from 'vitest'
import { applyErrorOf, changedFields, stepFields } from '@/server/portal/apply-form'
import type { PortalApplicationView } from '@/server/portal/queries'

// S7-08 (ADR-184 · BR-SUP ข้อ 07): what one step of the portal's application form sends to supplierApplication.update —
// its own fields only, the ones that changed, a blank optional field cleared, a blank account number left as stored —
// and the words of a refusal.

const form = (values: Record<string, string>) => {
  const f = new FormData()
  for (const [k, v] of Object.entries(values)) f.set(k, v)
  return f
}

const app = {
  fields: {
    nameTh: 'บริษัท ก จำกัด',
    nameEn: null,
    payeeType: 'JURISTIC',
    address: '1 ถนนพระราม 4',
    phone: null,
    email: null,
    category: null,
    taxId: '0105555000017',
    branchCode: '00000',
    isVatRegistered: false,
    bankCode: '004',
    accountNoLast4: '7890',
    accountName: 'บริษัท ก จำกัด',
    bankBranch: null,
  },
} as unknown as PortalApplicationView

describe('[S7-08] the portal form sends what its step shows and what changed', () => {
  it('company: blank optional fields are cleared; unchanged ones are not sent', () => {
    const sent = stepFields('company', form({ nameTh: ' บริษัท ก จำกัด ', nameEn: '', payeeType: 'JURISTIC', address: '1 ถนนพระราม 4', phone: '02-000-0000', email: '', category: '' }))
    expect(sent).toEqual({ nameTh: 'บริษัท ก จำกัด', nameEn: null, payeeType: 'JURISTIC', address: '1 ถนนพระราม 4', phone: '02-000-0000', email: null, category: null })
    expect(changedFields(sent, app)).toEqual({ phone: '02-000-0000' })
  })

  it('a payee type outside the list is not sent', () => {
    expect(stepFields('company', form({ nameTh: 'x', payeeType: 'ROBOT' }))).not.toHaveProperty('payeeType')
  })

  it('tax: the VAT tick is read as given; a foreign supplier\'s form has no tax id, so none is sent', () => {
    expect(changedFields(stepFields('tax', form({ taxId: '0105555000017', branchCode: '00000', isVatRegistered: '1' })), app)).toEqual({ isVatRegistered: true })
    expect(stepFields('tax', form({ branchCode: '00000' }))).toEqual({ branchCode: '00000', isVatRegistered: false })
  })

  it('bank: a blank account number keeps the stored one; a typed one is always sent', () => {
    expect(changedFields(stepFields('bank', form({ bankCode: '004', accountNo: '', accountName: 'บริษัท ก จำกัด', bankBranch: '' })), app)).toEqual({})
    expect(changedFields(stepFields('bank', form({ bankCode: '004', accountNo: ' 123-4-56789-0 ', accountName: 'บริษัท ก จำกัด', bankBranch: '' })), app)).toEqual({ accountNo: '123-4-56789-0' })
  })

  it('contact, documents and review send no application field', () => {
    for (const step of ['contact', 'documents', 'review'] as const) expect(stepFields(step, form({ nameTh: 'x' }))).toEqual({})
  })

  it('refusals: by their reason first, then the account field, then the code', () => {
    expect(applyErrorOf({ code: 'VALIDATION_FAILED', message: '', details: { field: 'taxId', reason: 'TAXID_CHECKSUM' } })).toBe('TAXID_CHECKSUM')
    expect(applyErrorOf({ code: 'VALIDATION_FAILED', message: '', details: { field: 'duplicateReasons', reason: 'DUPLICATE_REASON_REQUIRED' } })).toBe('DUPLICATE_REASON_REQUIRED')
    expect(applyErrorOf({ code: 'VALIDATION_FAILED', message: '', details: { field: 'fields.accountNo', reason: 'LENGTH' } })).toBe('ACCOUNT')
    expect(applyErrorOf({ code: 'CONFLICT_VERSION', message: '' })).toBe('CONFLICT_VERSION')
  })
})
