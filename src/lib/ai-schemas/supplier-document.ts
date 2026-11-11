import { z } from 'zod'

// What the Supplier Onboarding Agent returns for a supplier's document (FR-AI-304 · BR-AI-29 · ADR-189): a company
// certificate or a VAT registration (ภ.พ.20) of a juristic person, and the bank and account name only when the customer
// lets the AI read the bank book (OQ-186). The same Zod schema is the structured output and checks the answer; the
// evaluation (pnpm ai:eval, S7-15) scores the same fields. **No account number field** (BR-AI-18: the supplier types it).

const text = z.string().nullable()

export const SupplierDocumentReading = z.strictObject({
  docType: z.enum(['COMPANY_CERT', 'VAT_CERT', 'BANK_BOOK', 'OTHER']),
  nameTh: text,
  nameEn: text,
  /** 13 digits, without dashes */
  taxId: text,
  /** 5 digits; 00000 for the head office */
  branchCode: text,
  registeredAddress: text,
  /** ISO dates YYYY-MM-DD in the Gregorian calendar (the prompt converts Buddhist years) */
  registrationDate: text,
  issuedOn: text,
  isVatRegistered: z.boolean().nullable(),
  bankName: text,
  accountName: text,
  documentNumber: text,
  /** The model's confidence per field (0–100, the code clamps it: BR-AI-16) */
  confidence: z.array(z.strictObject({ field: z.string(), value: z.number().int() })),
})
export type SupplierDocumentReading = z.infer<typeof SupplierDocumentReading>

/** The fields the evaluation scores (OQ-186's floors: taxId branchCode ≥ 98 % · nameTh issuedOn ≥ 95 % · address ≥ 90 %) */
export const SUPPLIER_DOCUMENT_FIELDS = ['nameTh', 'taxId', 'branchCode', 'registeredAddress', 'issuedOn', 'isVatRegistered', 'bankName', 'accountName'] as const
