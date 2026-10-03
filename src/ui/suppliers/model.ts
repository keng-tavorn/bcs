import { isValidThaiTaxId, normalizeTaxId } from '@/core/thai/taxid'

// Pure rules the supplier screens run as the user types (S4-02, BR-TAXID-01): the tax id's shape and check digit (the
// same core/thai check the server runs again), branch and supplier codes, and how a tax id reads. Tested in
// tests/unit/suppliers-screens.test.ts.

/** The supplier code the register takes (src/server/services/suppliers Code) */
export const SUPPLIER_CODE = /^[A-Z0-9][A-Z0-9_-]{0,39}$/
export const BRANCH_CODE = /^\d{5}$/
export const HEAD_OFFICE = '00000'
/** Longest values the register takes */
export const SUPPLIER_LIMITS = { name: 200, address: 500, category: 200, expressVendorCode: 50, email: 200, phone: 50 } as const
/** A tax id as typed: 13 digits with dashes or spaces between */
export const TAX_ID_INPUT_MAX = 17

export type TaxIdState =
  | { readonly kind: 'empty' }
  /** Fewer than 13 digits so far */
  | { readonly kind: 'typing'; readonly digits: number }
  /** Not digits, or more than 13 */
  | { readonly kind: 'shape' }
  /** 13 digits whose last one is not the check digit */
  | { readonly kind: 'checksum' }
  | { readonly kind: 'valid'; readonly taxId: string; readonly juristic: boolean }

/** BR-TAXID-01 as the user types: dashes and spaces are only for reading */
export function taxIdState(text: string): TaxIdState {
  const digits = normalizeTaxId(text)
  if (digits === '') return { kind: 'empty' }
  if (!/^\d+$/.test(digits) || digits.length > 13) return { kind: 'shape' }
  if (digits.length < 13) return { kind: 'typing', digits: digits.length }
  if (!isValidThaiTaxId(digits)) return { kind: 'checksum' }
  // BR-SUP-02: a tax id starting with 0 is a juristic person's; an individual's is their national id number
  return { kind: 'valid', taxId: digits, juristic: digits.startsWith('0') }
}

/** "0999999000012" → "0-9999-99000-01-2" (the way Thai documents print it); anything else as it is */
export function formatTaxId(taxId: string): string {
  if (!/^[0-9X]{13}$/.test(taxId)) return taxId
  return `${taxId.slice(0, 1)}-${taxId.slice(1, 5)}-${taxId.slice(5, 10)}-${taxId.slice(10, 12)}-${taxId.slice(12)}`
}

/** Codes are kept in capitals; the user may type them in any case */
export const normalizeCode = (text: string): string => text.trim().toUpperCase()

/** A short text field: trimmed, and null when empty (the register keeps "nothing" as null) */
export const optionalText = (text: string): string | null => {
  const trimmed = text.trim()
  return trimmed === '' ? null : trimmed
}

/** A plain check of an e-mail address's shape; the server checks it again */
export const looksLikeEmail = (text: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text.trim())
