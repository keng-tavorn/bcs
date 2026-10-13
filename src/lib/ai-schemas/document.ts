import { z } from 'zod'

// What the Document Agent returns for a quotation, a delivery note or an invoice (FR-AI-303, BR-AI-10, ADR-141). The
// same Zod schema goes to the API as the structured output and checks the answer; the evaluation (pnpm ai:eval)
// scores the same fields. Values are text exactly as the document shows them, normalized only as the prompt asks
// (amounts as plain decimals, dates ISO, a tax id as its digits); the core checks of S13-06 verify every amount.
// No minimum or maximum on numbers: the API does not take them, the code checks ranges (ADR-141). No bank account
// field (BR-AI-18).

const text = z.string().nullable()

export const DocumentLine = z.strictObject({
  description: text,
  qty: text,
  unit: text,
  unitPrice: text,
  amount: text,
})

export const DocumentReading = z.strictObject({
  docType: z.enum(['QUOTATION', 'DELIVERY_NOTE', 'TAX_INVOICE', 'OTHER']),
  docNo: text,
  docDate: text,
  currency: text,
  priceIncludesVat: z.boolean().nullable(),
  seller: z.strictObject({ name: text, taxId: text, branch: text }),
  buyer: z.strictObject({ taxId: text }),
  lines: z.array(DocumentLine),
  discountTotal: text,
  net: text,
  vat: text,
  gross: text,
  /** The model's confidence per field path (0–100, the code clamps it: BR-AI-16) */
  confidence: z.array(z.strictObject({ field: z.string(), value: z.number().int() })),
})
export type DocumentReading = z.infer<typeof DocumentReading>

/** The fields the evaluation scores per document, by path; lines are scored per line (lines.<i>.<field>) */
export const DOCUMENT_HEADER_FIELDS = ['docNo', 'docDate', 'seller.taxId', 'seller.branch', 'buyer.taxId', 'discountTotal', 'net', 'vat', 'gross'] as const
export const DOCUMENT_LINE_FIELDS = ['description', 'qty', 'unit', 'unitPrice', 'amount'] as const

/**
 * Critical fields (OQ-141): document number, seller tax id, the branch of a tax invoice, amounts before VAT, VAT and
 * gross, and the quantities of a delivery note. They pass at 9800 bp with no wrong value slipping through.
 */
export function isCriticalField(docType: string, field: string): boolean {
  if (['docNo', 'seller.taxId', 'net', 'vat', 'gross'].includes(field)) return true
  if (field === 'seller.branch') return docType === 'TAX_INVOICE'
  return docType === 'DELIVERY_NOTE' && /^lines\.\d+\.qty$/.test(field)
}
