import { BP_PER_WHOLE } from '../money/constants'

// Confidence of a field the AI filled (BR-AI-16, golden ai-confidence, OQ-147): the model's whole number clamped to
// 0–100, in bp, capped by the field's check (FAIL → 0, WARN → 5000, PASS or none → 10000). A field is confirmed one by one
// when it is critical (money, quantities, tax ids, branches, the request type) or below the organization's
// minConfidenceBp; the others are confirmed together by a button the person presses.

/** Critical fields (OQ-147); "*" stands for any line number */
export const CRITICAL_FIELDS = ['net', 'vat', 'gross', 'discountTotal', 'lines.*.qty', 'lines.*.unitPrice', 'lines.*.amount', 'seller.taxId', 'seller.branch', 'buyer.taxId', 'requestType'] as const

const WHOLE_BP = Number(BP_PER_WHOLE)
/** The most a field may be trusted after its check: a warning halves it, a failure leaves nothing */
const CAP = { FAIL: 0, WARN: WHOLE_BP / 2, PASS: WHOLE_BP } as const
const PERCENT_TO_BP = WHOLE_BP / 100

export function isCritical(field: string, critical: readonly string[] = CRITICAL_FIELDS): boolean {
  return critical.includes(field.replace(/^lines\.\d+\./, 'lines.*.'))
}

export function fieldConfidence(input: { field: string; modelConfidence: number; check: 'PASS' | 'WARN' | 'FAIL' | null; minConfidenceBp: number; critical?: readonly string[] }): {
  confidenceBp: number
  mustConfirm: boolean
} {
  const clamped = Math.min(100, Math.max(0, Math.trunc(input.modelConfidence)))
  const confidenceBp = Math.min(clamped * PERCENT_TO_BP, CAP[input.check ?? 'PASS'])
  return { confidenceBp, mustConfirm: isCritical(input.field, input.critical) || confidenceBp < input.minConfidenceBp }
}
