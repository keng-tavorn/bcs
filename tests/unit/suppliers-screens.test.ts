import { describe, expect, it } from 'vitest'
import en from '../../messages/en.json'
import th from '../../messages/th.json'
import { suggestSupplierCode } from '@/server/services/suppliers/codes'
import { formatTaxId, looksLikeEmail, normalizeCode, optionalText, SUPPLIER_CODE, taxIdState } from '@/ui/suppliers/model'
import { SUPPLIER_ERROR_KEYS, supplierErrorKey, supplierFailureStep, toSupplierFailure } from '@/ui/suppliers/outcome'

// The rules the supplier screens run as the user types (S4-02): the tax id's check digit with the same core/thai check
// the server runs again (BR-TAXID-01, the golden cases of tests/golden/taxid.yaml), how a tax id reads, the code the form
// suggests, and the words of every refusal in Thai and English (§9.9 rule 7).

describe('[GC-TAXID-01] [GC-TAXID-02] [GC-TAXID-03] [GC-TAXID-04] [GC-TAXID-05] [GC-TAXID-06] [GC-TAXID-07] the new-supplier form checks the tax id as it is typed', () => {
  it('says valid, wrong check digit, still typing or not digits, and whether it is a juristic person (BR-SUP-02)', () => {
    expect(taxIdState('1234567890121')).toEqual({ kind: 'valid', taxId: '1234567890121', juristic: false })
    expect(taxIdState('0999999999991')).toEqual({ kind: 'valid', taxId: '0999999999991', juristic: true })
    expect(taxIdState('1-2345-67890-12-1')).toEqual({ kind: 'valid', taxId: '1234567890121', juristic: false })
    expect(taxIdState('0 9999 99000 09 8')).toEqual({ kind: 'valid', taxId: '0999999000098', juristic: true })
    expect(taxIdState('1234567890122')).toEqual({ kind: 'checksum' })
    expect(taxIdState('0999999999990')).toEqual({ kind: 'checksum' })
    expect(taxIdState('123456789012')).toEqual({ kind: 'typing', digits: 12 })
    expect(taxIdState('12345678901ab')).toEqual({ kind: 'shape' })
    expect(taxIdState('12345678901234')).toEqual({ kind: 'shape' })
    expect(taxIdState('  ')).toEqual({ kind: 'empty' })
  })

  it('prints a tax id the way Thai documents do, a masked one too', () => {
    expect(formatTaxId('0999999000012')).toBe('0-9999-99000-01-2')
    // BR-AUTH-04: the last four digits stay readable
    expect(formatTaxId('XXXXXXXXX0121')).toBe('X-XXXX-XXXX0-12-1')
    expect(formatTaxId('FOREIGN-1')).toBe('FOREIGN-1')
  })
})

describe('[S4-02] codes and fields of the supplier forms', () => {
  it('suggests the next code in the organization’s own pattern', () => {
    expect(suggestSupplierCode(['S1', 'S2', 'S3', 'S4', 'S5'])).toBe('S6')
    expect(suggestSupplierCode(['S1', 'S2', 'S9', 'F1'])).toBe('S10')
    expect(suggestSupplierCode(['V009', 'V010', 'X'])).toBe('V011')
    expect(suggestSupplierCode(['ABC'])).toBeNull()
    expect(suggestSupplierCode([])).toBeNull()
  })

  it('keeps codes in capitals and empty optional fields as nothing', () => {
    expect(normalizeCode(' s6 ')).toBe('S6')
    expect(SUPPLIER_CODE.test('S-6_A')).toBe(true)
    expect(SUPPLIER_CODE.test('-S6')).toBe(false)
    expect(optionalText('  ')).toBeNull()
    expect(optionalText(' V0001 ')).toBe('V0001')
    expect(looksLikeEmail('sales@supplier.test')).toBe(true)
    expect(looksLikeEmail('sales@')).toBe(false)
  })
})

describe('[S4-02] a refusal says what happened and where to fix it, in Thai and English', () => {
  it('maps the service’s reasons and fields to their own messages and steps', () => {
    const key = (code: string, details: Record<string, unknown> = {}) => supplierErrorKey(toSupplierFailure({ code, details }))
    expect(key('VALIDATION_FAILED', { field: 'registry', reason: 'REGISTRY_PROOF_REQUIRED', outcome: 'UNAVAILABLE' })).toBe('REGISTRY_PROOF_REQUIRED')
    expect(key('VALIDATION_FAILED', { field: 'taxId', reason: 'SUPPLIER_EXISTS', supplierId: 'x', code: 'S1' })).toBe('SUPPLIER_EXISTS')
    expect(toSupplierFailure({ code: 'VALIDATION_FAILED', details: { reason: 'SUPPLIER_EXISTS', supplierId: 'x', code: 'S1' } })).toMatchObject({ supplierId: 'x', existingCode: 'S1' })
    expect(key('VALIDATION_FAILED', { field: 'code', reason: 'CODE_EXISTS' })).toBe('CODE_EXISTS')
    expect(key('VALIDATION_FAILED', { field: 'email' })).toBe('EMAIL')
    expect(key('VALIDATION_FAILED', { field: 'registry.proofFileId', reason: 'FILE' })).toBe('FILE')
    expect(key('VALIDATION_FAILED', { reason: 'NO_CHANGE' })).toBe('NO_CHANGE')
    expect(key('VALIDATION_FAILED', { field: 'somethingElse' })).toBe('INPUT')
    expect(key('CONFLICT_VERSION')).toBe('CONFLICT_VERSION')
    expect(key('FORBIDDEN', { capability: 'supplier.manage' })).toBe('FORBIDDEN')
    expect(key('EXTERNAL_SERVICE_ERROR')).toBe('SERVICE')
    expect(key('SOMETHING_NEW')).toBe('FAILED')
    expect(supplierFailureStep('REGISTRY_PROOF_REQUIRED')).toBe('identity')
    expect(supplierFailureStep('NAME')).toBe('details')
    expect(supplierFailureStep('CODE_EXISTS')).toBe('codes')
    expect(supplierFailureStep('BUSY')).toBeNull()
  })

  it('every message key exists in Thai and English', () => {
    for (const key of SUPPLIER_ERROR_KEYS) {
      expect(th.suppliers.errors[key], key).toBeTruthy()
      expect(en.suppliers.errors[key], key).toBeTruthy()
    }
    // The confirmation repeats the button's words (§9.9 rule 7)
    expect(th.suppliers.detail.created.startsWith(`${th.suppliers.new.save}แล้ว`)).toBe(true)
    expect(th.suppliers.edit.detailsSaved).toBe(`${th.suppliers.edit.detailsSubmit}แล้ว`)
    expect(th.suppliers.edit.codesSaved).toBe(`${th.suppliers.edit.codesSubmit}แล้ว`)
  })

  it('Thai screen text mixes in only the English words the company uses (§9.9)', () => {
    const allowed = new Set(['VAT', 'DBD', 'Express', 'KB'])
    const words: string[] = []
    const walk = (value: unknown): void => {
      if (typeof value === 'string') {
        // Placeholders and the example e-mail address are not words of the text
        const text = value.replace(/\{[^}]*\}/g, '').replace(/\S+@\S+/g, '')
        words.push(...(text.match(/[A-Za-z]+/g) ?? []))
      } else if (value && typeof value === 'object') Object.values(value).forEach(walk)
    }
    walk(th.suppliers)
    expect(words.filter((w) => !allowed.has(w))).toEqual([])
  })
})
