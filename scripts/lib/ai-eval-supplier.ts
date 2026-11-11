import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'
import { isValidThaiTaxId, normalizeTaxId } from '../../src/core/thai/taxid'
import { normalizeSupplierName } from '../../src/core/supplier-onboarding'
import { EVAL_THRESHOLDS_BP } from '../../src/lib/ai-config'
import { ROOT } from './ai-eval-cases'

// The evaluation set of the Supplier Onboarding Agent, demo tier (S7-15 · FR-AI-304 AC5 · ADR-146 · OQ-186): the cases of
// tests/fixtures/ai-docs/supplier/cases.yaml, one shape for the file generator (scripts/ai-docs-supplier.ts), the
// evaluation (pnpm ai:eval --agent supplier) and the tests. The fields scored are OQ-186's, each with its floor:
// taxId and branchCode at least 98 % and none missed (a wrong value read with confidence 90 or more fails the field);
// nameTh and issuedOn at least 95 %; registeredAddress at least 90 % (BR-AI-26 · the bank only when a customer lets the
// AI read bank books, which this set does not).

export const SUPPLIER_DOCS_DIR = path.join(ROOT, 'tests', 'fixtures', 'ai-docs', 'supplier')

const ISO = /^\d{4}-\d{2}-\d{2}$/
const Case = z.strictObject({
  id: z.string().regex(/^S[CV]-\d{2}$/),
  docType: z.enum(['COMPANY_CERT', 'VAT_CERT']),
  layout: z.enum(['A4_TYPED', 'A4_SCANNED', 'PHOTO']),
  quality: z.enum(['CLEAN', 'SKEWED', 'BLURRY', 'STAMPED']),
  digits: z.enum(['ARABIC', 'THAI']),
  dates: z.enum(['BE_LONG', 'BE_SHORT']),
  name: z.enum(['FULL', 'ABBREVIATED']),
  nameTh: z.string().min(1),
  nameEn: z.string().nullable(),
  taxId: z.string().refine(isValidThaiTaxId, 'a tax id with its check digit'),
  branchCode: z.string().regex(/^\d{5}$/),
  registeredAddress: z.string().min(1),
  registrationDate: z.string().regex(ISO),
  issuedOn: z.string().regex(ISO),
  capital: z.string().regex(/^\d+$/).optional(),
  directors: z.array(z.string()).optional(),
})
export type SupplierCase = z.infer<typeof Case>

export function loadSupplierCases(): SupplierCase[] {
  const raw = parse(readFileSync(path.join(SUPPLIER_DOCS_DIR, 'cases.yaml'), 'utf8')) as { cases: unknown[] }
  return raw.cases.map((c) => Case.parse(c))
}

/** The fields scored, each with its floor and whether a confident wrong value fails it (OQ-186) */
export const SUPPLIER_EVAL_FIELDS = [
  { field: 'taxId', thresholdBp: EVAL_THRESHOLDS_BP.critical, critical: true },
  { field: 'branchCode', thresholdBp: EVAL_THRESHOLDS_BP.critical, critical: true },
  { field: 'nameTh', thresholdBp: EVAL_THRESHOLDS_BP.supplierKey, critical: false },
  { field: 'issuedOn', thresholdBp: EVAL_THRESHOLDS_BP.supplierKey, critical: false },
  { field: 'registeredAddress', thresholdBp: EVAL_THRESHOLDS_BP.supplierAddress, critical: false },
] as const
export type SupplierEvalField = (typeof SUPPLIER_EVAL_FIELDS)[number]['field']

/** An address as a person compares two of them: Thai and Arabic digits alike, no spaces, dots or commas */
const addressKey = (s: string) =>
  s
    .normalize('NFC')
    .replace(/[๐-๙]/g, (c) => String(c.charCodeAt(0) - 0x0e50))
    .replace(/[\s.,]/g, '')

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)

/** Whether the value read for one field is the right one (BR-AI-26: the same value after the field's normalization) */
export function supplierFieldCorrect(field: SupplierEvalField, truth: SupplierCase, read: Readonly<Record<string, unknown>>): boolean {
  const v = text(read[field])
  if (v === null) return false
  if (field === 'taxId') return normalizeTaxId(v) === truth.taxId
  if (field === 'branchCode') return v === truth.branchCode
  if (field === 'nameTh') return normalizeSupplierName(v) === normalizeSupplierName(truth.nameTh)
  if (field === 'issuedOn') return v === truth.issuedOn
  return addressKey(v) === addressKey(truth.registeredAddress)
}

/** The model's confidence for a field (0–100), 0 when it gave none */
export const supplierConfidenceOf = (read: { confidence?: ReadonlyArray<{ field: string; value: number }> }, field: string) => read.confidence?.find((c) => c.field === field)?.value ?? 0

/** What a perfect reading of a case gives: the truth in the agent's schema (src/lib/ai-schemas/supplier-document.ts) */
export function supplierTruthReading(c: SupplierCase) {
  return {
    docType: c.docType,
    nameTh: c.nameTh,
    nameEn: c.nameEn,
    taxId: c.taxId,
    branchCode: c.branchCode,
    registeredAddress: c.registeredAddress,
    registrationDate: c.registrationDate,
    issuedOn: c.issuedOn,
    isVatRegistered: c.docType === 'VAT_CERT' ? true : null,
    bankName: null,
    accountName: null,
    documentNumber: null,
    confidence: SUPPLIER_EVAL_FIELDS.map((f) => ({ field: f.field, value: 95 })),
  }
}
