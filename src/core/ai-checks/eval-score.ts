import { normalizeInvoiceNo } from '../invoice'
import { BP_PER_WHOLE } from '../money/constants'
import { amountToSatang, satangToAmount } from '../money/dto'
import { lineNet, parseQuantity } from '../money/math'
import { normalizeTaxId } from '../thai/taxid'

// Scoring the evaluation set (BR-AI-26, golden ai-eval-score, §12.4): a value the AI read is compared with the answer
// after both are normalized the same way — a tax id as its 13 digits (BR-TAXID-01), a document number without spaces
// and in capitals (BR-IVC-03), money as satang, a quantity to 4 places, a date as ISO — and "ไม่มีเลขที่" in the answer
// sheet means no number. A field's accuracy is floor(correct × 10000 ÷ all) bp and passes at the threshold or above;
// a critical field fails when one wrong value slipped through (confident and passing the checks).

/** What DocSamples writes for a document that has no number */
export const NO_DOC_NO = 'ไม่มีเลขที่'

export type FieldKind = 'TAX_ID' | 'DOC_NO' | 'MONEY' | 'QUANTITY' | 'DATE' | 'TEXT'

// gt and lte: the limits of a DOA rule the drafter writes, baht compared as satang like every amount
const MONEY_FIELDS = new Set(['net', 'vat', 'gross', 'discountTotal', 'unitPrice', 'amount', 'gt', 'lte'])

/** The kind of a field path, by its last segment ("lines.0.unitPrice" → MONEY) */
export function fieldKind(field: string): FieldKind {
  const last = field.split('.').at(-1)!
  if (last === 'taxId') return 'TAX_ID'
  if (last === 'docNo') return 'DOC_NO'
  if (MONEY_FIELDS.has(last)) return 'MONEY'
  if (last === 'qty') return 'QUANTITY'
  if (last === 'docDate') return 'DATE'
  return 'TEXT'
}

const blank = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '')

/** A value as its kind compares it; undefined when it cannot be read as that kind (it then matches nothing) */
export function normalizeValue(field: string, value: unknown): string | null | undefined {
  const kind = fieldKind(field)
  if (blank(value)) return null
  const text = String(value).trim()
  try {
    switch (kind) {
      case 'TAX_ID':
        return normalizeTaxId(text)
      case 'DOC_NO':
        return text === NO_DOC_NO ? null : normalizeInvoiceNo(text)
      case 'MONEY':
        return satangToAmount(amountToSatang(text.replace(/,/g, '')))
      case 'QUANTITY':
        return parseQuantity(text.replace(/,/g, '')).toString()
      case 'DATE':
        return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : undefined
      case 'TEXT':
        return text.replace(/\s+/g, ' ')
    }
  } catch {
    return undefined
  }
}

/** Whether the value the AI read matches the answer of the evaluation set */
export function matchField(field: string, expected: unknown, actual: unknown): boolean {
  const e = normalizeValue(field, expected)
  const a = normalizeValue(field, actual)
  return e !== undefined && a !== undefined && e === a
}

export interface AnswerLine {
  readonly description?: string
  readonly qty?: string | number | null
  readonly unit?: string | null
  readonly unitPrice?: string | number | null
  readonly amount?: string | number | null
}

/** Satang of an amount as the checks of a reading read it (thousands separators dropped); null when it is no amount */
function satangOrNull(v: unknown): bigint | null {
  if (blank(v)) return null
  try {
    return amountToSatang(String(v).trim().replace(/,/g, ''))
  } catch {
    return null
  }
}

/**
 * An answer (or a reading) with its discount where BR-AI-14 keeps it: a line of a negative amount moves out of the
 * lines into discountTotal. An answer that already has discountTotal keeps it, with the negative lines added. An
 * amount that cannot be read stays where it is, so the scoring counts it wrong instead of stopping.
 */
export function normalizeAnswer(answer: { readonly lines: readonly AnswerLine[]; readonly discountTotal?: string | number | null }): {
  readonly lines: readonly AnswerLine[]
  readonly discountTotal: string | null
} {
  const readDiscount = satangOrNull(answer.discountTotal)
  let discount = readDiscount ?? 0n
  const kept: AnswerLine[] = []
  for (const line of answer.lines) {
    const unitPrice = satangOrNull(line.unitPrice)
    let amount = satangOrNull(line.amount)
    if (amount === null && blank(line.amount) && unitPrice !== null && !blank(line.qty)) {
      try {
        amount = lineNet(String(line.qty).trim().replace(/,/g, ''), unitPrice)
      } catch {
        amount = null
      }
    }
    if (amount !== null && amount < 0n) discount += -amount
    else kept.push(line)
  }
  if (readDiscount === null && !blank(answer.discountTotal)) return { lines: kept, discountTotal: String(answer.discountTotal) }
  return { lines: kept, discountTotal: discount > 0n || !blank(answer.discountTotal) ? satangToAmount(discount) : null }
}

/** Accuracy of one field in bp, and whether it passes its threshold (BR-AI-26) */
export function fieldScore(input: { correct: number; total: number; thresholdBp: number; missed: number; critical?: boolean }): { scoreBp: number; pass: boolean } {
  const scoreBp = input.total === 0 ? Number(BP_PER_WHOLE) : Math.floor((input.correct * Number(BP_PER_WHOLE)) / input.total)
  return { scoreBp, pass: scoreBp >= input.thresholdBp && !(input.critical && input.missed > 0) }
}
