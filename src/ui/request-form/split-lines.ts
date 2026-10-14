import { amountToSatang } from '@/core/money/dto'
import { lineNet, parseQuantity, roundHalfUpDiv, type Satang } from '@/core/money/math'
import { QUANTITY_SCALE } from '@/core/money/constants'
import { plainNumber, validMoney, validQuantity, type FormLine, type FormValues } from './model'

// "แบ่งบรรทัด" of the request form (S6-17 · FR-BUD-102 AC2 · BR-BUD-16 · OQ-106): one line becomes two parts or more by
// quantity, at the same unit price, each part on the request's budget line or one of its own. The parts add up to the
// line's quantity — a split never changes what is asked for — and each part's amount is rounded once (BR-MONEY-02 (1)),
// so their total may differ from the line's amount by up to (parts − 1) satang; the dialog shows that difference before
// anything is saved. Screens may not import core/budget (eslint boundaries: ui takes core/{thai,money,result,forms}), so
// the preview works with core/money as core/budget splitLine does — tests/unit/budget-split-screens.test.ts checks the
// two agree on GC-BUD-25 and GC-BUD-26. Pure.

/** One part as the dialog hands it to the form: its quantity (plain digits) and its budget line (null: the request's) */
export interface SplitPart {
  readonly key: string
  readonly quantity: string
  readonly budgetLineId: string | null
}

/** Most parts one split makes */
export const MAX_SPLIT_PARTS = 10

/** A quantity in ten-thousandths (core/money parseQuantity) as people write it: 25000n → "2.5" */
export function quantityText(scaled: bigint): string {
  const whole = scaled / QUANTITY_SCALE
  const rest = (scaled % QUANTITY_SCALE).toString().padStart(4, '0').replace(/0+$/, '')
  return rest ? `${whole}.${rest}` : whole.toString()
}

/**
 * The two parts a split starts with: the line's quantity in halves, the first part taking the odd ten-thousandth
 * ("3" → "1.5" and "1.5"; "0.0001" cannot be halved: null). Null when the quantity is no number above zero.
 */
export function halves(quantity: string): [string, string] | null {
  if (!validQuantity(quantity)) return null
  const q = parseQuantity(plainNumber(quantity))
  const second = q / 2n
  const first = q - second
  return second > 0n ? [quantityText(first), quantityText(second)] : null
}

export interface SplitPreview {
  /** Each part's amount (BR-MONEY-02 (1)); null while its quantity is no number above zero */
  readonly nets: ReadonlyArray<Satang | null>
  /** Which parts' quantities are no number above zero (by index) */
  readonly invalid: readonly number[]
  /** The line's quantity less what the parts add up to, in ten-thousandths: 0n when they add up; null until all are numbers */
  readonly left: bigint | null
  /** The parts' total and the line's amount, once every part is valid and they add up */
  readonly total: Satang | null
  readonly original: Satang | null
  /** total − original: the rounding of each part (at most parts − 1 satang either way) */
  readonly difference: Satang | null
  /** Two parts or more, every one valid, adding up to the line's quantity */
  readonly ready: boolean
}

/** What a split of `line` into `quantities` gives, as the dialog shows it while the requester types */
export function splitPreview(line: Pick<FormLine, 'quantity' | 'unitPrice'>, quantities: readonly string[]): SplitPreview {
  const priced = validMoney(line.unitPrice) && validQuantity(line.quantity)
  const unit = priced ? amountToSatang(plainNumber(line.unitPrice)) : 0n
  const invalid = quantities.flatMap((q, i) => (validQuantity(q) ? [] : [i]))
  const nets = quantities.map((q) => (priced && validQuantity(q) ? lineNet(plainNumber(q), unit) : null))
  const none = { nets, invalid, left: null, total: null, original: null, difference: null, ready: false }
  if (!priced || invalid.length) return none
  const left = parseQuantity(plainNumber(line.quantity)) - quantities.reduce((sum, q) => sum + parseQuantity(plainNumber(q)), 0n)
  if (left !== 0n || quantities.length < 2) return { ...none, left }
  // As core/budget splitLine: each part rounded once, the original from the whole quantity rounded once
  const parts = nets as Satang[]
  const total = parts.reduce((sum, n) => sum + n, 0n)
  const original = roundHalfUpDiv(parseQuantity(plainNumber(line.quantity)) * unit, QUANTITY_SCALE)
  return { nets: parts, invalid, left, total, original, difference: total - original, ready: true }
}

/**
 * The form with `key`'s line replaced by its parts: each keeps the line's description, unit, unit price, VAT, end date
 * and catalogue item, with its own quantity and budget line. The first part is the saved line (its id, and what it holds
 * on a returned request, §6.4); the others are new lines, saved with the next save.
 */
export function splitFormLine(values: FormValues, key: string, parts: readonly SplitPart[]): FormValues {
  return {
    ...values,
    lines: values.lines.flatMap((l) =>
      l.key !== key
        ? [l]
        : parts.map((p, i) => ({
            ...l,
            key: i === 0 ? l.key : p.key,
            id: i === 0 ? l.id : null,
            reserved: i === 0 ? l.reserved : null,
            quantity: p.quantity,
            budgetLineId: p.budgetLineId,
          })),
    ),
  }
}
