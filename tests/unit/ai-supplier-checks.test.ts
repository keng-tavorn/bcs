import { describe, expect, it } from 'vitest'
import { checkSupplierReading, fieldOutcomes, shouldReadDocument, supplierFieldConfidence, type SupplierCheckContext } from '@/core/ai-checks/supplier'

// BR-AI-29 BR-AI-30 (FR-AI-304 AC2 · S7-14): the checks of what the Supplier Onboarding Agent read, the confidence each
// field keeps after its check, and which documents the agent reads at all. The golden cases GC-AI-92 to GC-AI-95 hold the
// demo's numbers; these cover every branch.

const ctx: SupplierCheckContext = {
  application: { taxId: '0999998020010', branchCode: '00000', payeeType: 'JURISTIC', nameTh: 'บริษัท ราชบุรีคอนสตรัคชั่น จำกัด', address: '99 หมู่ 4 ต.เจดีย์หัก' },
  registry: { name: 'บริษัท ราชบุรีคอนสตรัคชั่น จำกัด', address: '1 ถนนอื่น' },
  validityDays: 180,
  today: '2026-11-02',
}
const codes = (checks: readonly { code: string; result: string }[]) => Object.fromEntries(checks.map((c) => [c.code, c.result]))

describe('[FR-AI-304/AC2] checks of a supplier document as read', () => {
  it('everything as the application and the registry say: all PASS, the abbreviation of the legal form ignored', () => {
    expect(codes(checkSupplierReading({ nameTh: 'บจก. ราชบุรีคอนสตรัคชั่น', taxId: '0-9999-98020-01-0', branchCode: '00000', registeredAddress: ' 99  หมู่ 4 ต.เจดีย์หัก ', issuedOn: '2026-10-20' }, ctx))).toEqual({
      TAXID_CHECKSUM: 'PASS',
      TAXID_MISMATCH: 'PASS',
      REGISTRY_NAME_MISMATCH: 'PASS',
      REGISTRY_ADDRESS_MISMATCH: 'PASS',
      DOC_DATE_FUTURE: 'PASS',
      DOC_EXPIRED: 'PASS',
    })
  })

  it('a bad check digit, another number or branch, another name or address, a future or expired document', () => {
    expect(codes(checkSupplierReading({ taxId: '0999998020011' }, ctx))).toEqual({ TAXID_CHECKSUM: 'FAIL', TAXID_MISMATCH: 'FAIL' })
    expect(codes(checkSupplierReading({ taxId: '0999998020010', branchCode: '00001' }, ctx))).toEqual({ TAXID_CHECKSUM: 'PASS', TAXID_MISMATCH: 'FAIL' })
    expect(codes(checkSupplierReading({ nameTh: 'บริษัท ราชบุรีก่อสร้าง จำกัด', registeredAddress: '99/1 หมู่ 4' }, ctx))).toEqual({ REGISTRY_NAME_MISMATCH: 'WARN', REGISTRY_ADDRESS_MISMATCH: 'WARN' })
    expect(codes(checkSupplierReading({ issuedOn: '2026-11-03' }, ctx))).toEqual({ DOC_DATE_FUTURE: 'FAIL', DOC_EXPIRED: 'PASS' })
    expect(codes(checkSupplierReading({ issuedOn: '2026-05-01' }, ctx))).toEqual({ DOC_DATE_FUTURE: 'PASS', DOC_EXPIRED: 'FAIL' })
    // the last day of its validity is still valid: 2026-05-07 + 179 = 2026-11-02
    expect(codes(checkSupplierReading({ issuedOn: '2026-05-07' }, ctx)).DOC_EXPIRED).toBe('PASS')
  })

  it('nothing to compare, nothing checked: no application tax id, no registry, no validity, a date that is not a date', () => {
    const bare: SupplierCheckContext = { ...ctx, application: { ...ctx.application, taxId: null, address: null }, registry: null, validityDays: null }
    expect(checkSupplierReading({ taxId: '0999998020010', nameTh: 'x', registeredAddress: 'y', issuedOn: '2026-10-01' }, bare)).toEqual([
      { code: 'TAXID_CHECKSUM', result: 'PASS' },
      { code: 'DOC_DATE_FUTURE', result: 'PASS' },
    ])
    expect(checkSupplierReading({ issuedOn: '20/10/2026' }, ctx)).toEqual([])
    expect(checkSupplierReading({}, ctx)).toEqual([])
    // the typed address missing: the registry's is compared
    expect(codes(checkSupplierReading({ registeredAddress: '1 ถนนอื่น' }, { ...ctx, application: { ...ctx.application, address: null } }))).toEqual({ REGISTRY_ADDRESS_MISMATCH: 'PASS' })
  })
})

describe('[FR-AI-304/AC2] confidence after the checks (BR-AI-16 · BR-AI-30)', () => {
  it('the worst check of a field wins whatever the order', () => {
    expect(fieldOutcomes([{ code: 'TAXID_CHECKSUM', result: 'PASS' }, { code: 'TAXID_MISMATCH', result: 'FAIL' }])).toEqual({ taxId: 'FAIL' })
    expect(fieldOutcomes([{ code: 'DOC_EXPIRED', result: 'FAIL' }, { code: 'DOC_DATE_FUTURE', result: 'PASS' }])).toEqual({ issuedOn: 'FAIL' })
  })

  it('a FAIL is 0, a WARN at most 5000; critical fields and those below the floor are confirmed one by one; a field without a confidence is 0', () => {
    const reading = { nameTh: 'n', taxId: '0999998020011', registeredAddress: 'a', issuedOn: '2026-10-20', nameEn: null, documentNumber: '' }
    const checks = checkSupplierReading(reading, { ...ctx, registry: null })
    expect(supplierFieldConfidence(reading, { nameTh: 95, taxId: 99, registeredAddress: 91, issuedOn: 95 }, checks, 9000)).toEqual({
      nameTh: { confidenceBp: 9500, mustConfirm: true },
      taxId: { confidenceBp: 0, mustConfirm: true },
      registeredAddress: { confidenceBp: 5000, mustConfirm: true },
      issuedOn: { confidenceBp: 9500, mustConfirm: false },
    })
    expect(supplierFieldConfidence({ registrationDate: '2001-01-01' }, {}, [], 9000)).toEqual({ registrationDate: { confidenceBp: 0, mustConfirm: true } })
  })
})

describe('[FR-AI-304/AC1] which documents the agent reads (GC-AI-95)', () => {
  it('not a readable type, a payee the type excludes, or read; no list of payees reads every payee', () => {
    expect(shouldReadDocument({ aiReadable: false, aiReadablePayeeTypes: [] }, 'JURISTIC')).toEqual({ read: false, reason: 'NOT_AI_READABLE' })
    expect(shouldReadDocument({ aiReadable: true, aiReadablePayeeTypes: ['JURISTIC'] }, 'INDIVIDUAL')).toEqual({ read: false, reason: 'PAYEE_TYPE_EXCLUDED' })
    expect(shouldReadDocument({ aiReadable: true, aiReadablePayeeTypes: ['JURISTIC'] }, 'JURISTIC')).toEqual({ read: true })
    expect(shouldReadDocument({ aiReadable: true, aiReadablePayeeTypes: [] }, 'FOREIGN')).toEqual({ read: true })
  })
})
