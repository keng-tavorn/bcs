import { BANKS } from '../bankfile/banks'
import { addDays, isIsoDate } from '../supplier-docs'
import { normalizeSupplierName } from '../supplier-onboarding'
import { isValidThaiTaxId, normalizeTaxId } from '../thai/taxid'
import { fieldConfidence } from './confidence'

// The checks of what the Supplier Onboarding Agent read off a supplier's document (BR-AI-29 · golden ai-supplier-verify ·
// FR-AI-304 AC2): the tax id by its check digit and against the application (never the one the AI read as the truth), the
// name after BR-SUP-09's normalization against the registry when it answered, the address against what was typed (or
// the registry's), the date of issue not in the future and the document not past its validity today, the bank read found
// in the list of banks (BANK_UNKNOWN · a bank book only when the customer lets the AI read one, OQ-186). A check never stops
// the application: it caps the confidence of its field (BR-AI-16) so the person confirms it one by one (BR-AI-30).
// Which documents are read at all is decided per document from its type and the application's payee (shouldReadDocument).

export type SupplierCheckCode = 'TAXID_CHECKSUM' | 'TAXID_MISMATCH' | 'REGISTRY_NAME_MISMATCH' | 'REGISTRY_ADDRESS_MISMATCH' | 'DOC_DATE_FUTURE' | 'DOC_EXPIRED' | 'BANK_UNKNOWN'
export type CheckOutcome = 'PASS' | 'WARN' | 'FAIL'
export type PayeeKind = 'JURISTIC' | 'INDIVIDUAL' | 'FOREIGN'

/** What the agent read (src/lib/ai-schemas/supplier-document.ts) — no account number, ever (BR-AI-18) */
export interface SupplierReading {
  readonly nameTh?: string | null
  readonly nameEn?: string | null
  readonly taxId?: string | null
  readonly branchCode?: string | null
  readonly registeredAddress?: string | null
  readonly registrationDate?: string | null
  readonly issuedOn?: string | null
  readonly isVatRegistered?: boolean | null
  readonly bankName?: string | null
  readonly accountName?: string | null
  readonly documentNumber?: string | null
}

export interface SupplierCheckContext {
  readonly application: { readonly taxId: string | null; readonly branchCode: string; readonly payeeType: PayeeKind; readonly nameTh: string; readonly address: string | null }
  /** What the registry answered for the application (registryData), when it did */
  readonly registry: { readonly name?: string | null; readonly address?: string | null } | null
  /** The validity of the document's type in days (BR-SDOC-02), or null when the document carries its own expiry */
  readonly validityDays: number | null
  /** Today in Asia/Bangkok, YYYY-MM-DD */
  readonly today: string
}

export interface SupplierCheck {
  readonly code: SupplierCheckCode
  readonly result: CheckOutcome
}

/** The field each check speaks for (its outcome caps that field's confidence; the screens show it beside that field) */
export const SUPPLIER_CHECK_FIELD: Readonly<Record<SupplierCheckCode, keyof SupplierReading>> = {
  TAXID_CHECKSUM: 'taxId',
  TAXID_MISMATCH: 'taxId',
  REGISTRY_NAME_MISMATCH: 'nameTh',
  REGISTRY_ADDRESS_MISMATCH: 'registeredAddress',
  DOC_DATE_FUTURE: 'issuedOn',
  DOC_EXPIRED: 'issuedOn',
  BANK_UNKNOWN: 'bankName',
}

const text = (v: string) => v.normalize('NFC').replace(/\s+/g, ' ').trim()

/**
 * The bank of a name read off a bank book, by the list of banks (ADR-131): its Thai name inside the text, or its short
 * name as a word of it (BBL, KBANK, …); null when none matches (BANK_UNKNOWN: the bank is not filled in)
 */
export function bankCodeOfName(name: string): string | null {
  const compact = name.normalize('NFC').replace(/\s+/g, '')
  const words = name.toUpperCase().split(/[^A-Z]+/)
  return BANKS.find((b) => compact.includes(b.nameTh.replace(/\s+/g, '')) || words.includes(b.shortName))?.code ?? null
}

/** BR-AI-29: every check that has something to compare, in a fixed order */
export function checkSupplierReading(reading: SupplierReading, ctx: SupplierCheckContext): readonly SupplierCheck[] {
  const checks: SupplierCheck[] = []
  const taxId = reading.taxId ? normalizeTaxId(reading.taxId) : null
  if (taxId) {
    checks.push({ code: 'TAXID_CHECKSUM', result: isValidThaiTaxId(taxId) ? 'PASS' : 'FAIL' })
    if (ctx.application.taxId) {
      const same = taxId === normalizeTaxId(ctx.application.taxId) && (!reading.branchCode || text(reading.branchCode) === ctx.application.branchCode)
      checks.push({ code: 'TAXID_MISMATCH', result: same ? 'PASS' : 'FAIL' })
    }
  }
  if (reading.nameTh && ctx.registry?.name) {
    checks.push({ code: 'REGISTRY_NAME_MISMATCH', result: normalizeSupplierName(reading.nameTh) === normalizeSupplierName(ctx.registry.name) ? 'PASS' : 'WARN' })
  }
  const typedAddress = ctx.application.address ?? ctx.registry?.address ?? null
  if (reading.registeredAddress && typedAddress) {
    checks.push({ code: 'REGISTRY_ADDRESS_MISMATCH', result: text(reading.registeredAddress) === text(typedAddress) ? 'PASS' : 'WARN' })
  }
  // a date written that is no date (2026-25-10: day and month swapped) has nothing to compare; its confidence stays the model's
  if (reading.issuedOn && isIsoDate(reading.issuedOn)) {
    checks.push({ code: 'DOC_DATE_FUTURE', result: reading.issuedOn > ctx.today ? 'FAIL' : 'PASS' })
    if (ctx.validityDays !== null) checks.push({ code: 'DOC_EXPIRED', result: addDays(reading.issuedOn, ctx.validityDays - 1) < ctx.today ? 'FAIL' : 'PASS' })
  }
  if (reading.bankName) checks.push({ code: 'BANK_UNKNOWN', result: bankCodeOfName(reading.bankName) ? 'PASS' : 'WARN' })
  return checks
}

/** The worst outcome of the checks of each field (FAIL over WARN over PASS) */
export function fieldOutcomes(checks: readonly SupplierCheck[]): Readonly<Partial<Record<keyof SupplierReading, CheckOutcome>>> {
  const rank: Record<CheckOutcome, number> = { PASS: 0, WARN: 1, FAIL: 2 }
  const out: Partial<Record<keyof SupplierReading, CheckOutcome>> = {}
  for (const c of checks) {
    const field = SUPPLIER_CHECK_FIELD[c.code]
    const now = out[field]
    if (!now || rank[c.result] > rank[now]) out[field] = c.result
  }
  return out
}

/** BR-AI-30: the fields confirmed one by one whatever the confidence */
export const SUPPLIER_CRITICAL_FIELDS = ['taxId', 'branchCode', 'nameTh', 'isVatRegistered', 'bankCode', 'accountName'] as const

/**
 * The confidence of every field read (BR-AI-16: the model's percent in bp, capped by its check) and whether it is
 * confirmed one by one; a field read without a confidence counts as 0
 */
export function supplierFieldConfidence(
  reading: SupplierReading,
  confidence: Readonly<Record<string, number>>,
  checks: readonly SupplierCheck[],
  minConfidenceBp: number,
): Readonly<Record<string, { readonly confidenceBp: number; readonly mustConfirm: boolean }>> {
  const outcome = fieldOutcomes(checks)
  const out: Record<string, { confidenceBp: number; mustConfirm: boolean }> = {}
  for (const [field, value] of Object.entries(reading)) {
    if (value === null || value === undefined || value === '') continue
    out[field] = fieldConfidence({ field, modelConfidence: confidence[field] ?? 0, check: outcome[field as keyof SupplierReading] ?? null, minConfidenceBp, critical: SUPPLIER_CRITICAL_FIELDS })
  }
  return out
}

export type ReadDecision = { readonly read: true } | { readonly read: false; readonly reason: 'NOT_AI_READABLE' | 'PAYEE_TYPE_EXCLUDED' }

/**
 * BR-AI-29 · GC-AI-95: whether the agent reads one document — its type must be aiReadable and, when the type names the
 * payee types the AI may read, the application's payee must be one (a VAT certificate of an individual carries the
 * person's ID number, BR-AI-08)
 */
export function shouldReadDocument(type: { readonly aiReadable: boolean; readonly aiReadablePayeeTypes: readonly string[] }, payeeType: string): ReadDecision {
  if (!type.aiReadable) return { read: false, reason: 'NOT_AI_READABLE' }
  if (type.aiReadablePayeeTypes.length > 0 && !type.aiReadablePayeeTypes.includes(payeeType)) return { read: false, reason: 'PAYEE_TYPE_EXCLUDED' }
  return { read: true }
}
