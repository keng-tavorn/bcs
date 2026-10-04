import { amountToSatang } from '../money/dto'
import type { Satang } from '../money/math'

// Money written in a form (BR-MONEY-01, §7.0 (3)): an amount in a condition of the form's rules, or typed into a field
// of type money, is baht text such as "12345.50", never a JSON number, so no amount passes through floating point.
// Kept apart from fields.ts so the screens, which run core/forms as the requester types, do not load zod with it.

/** Baht text: up to 13 digits and at most two decimals; no sign, separators or spaces */
export const MONEY_TEXT = /^\d{1,13}(\.\d{1,2})?$/

/**
 * The amount of a value in satang: baht text (MONEY_TEXT), or bigint satang passed from code. Anything else is no
 * amount (null): a number, even a whole one, and any text that is not MONEY_TEXT.
 */
export function satangOf(value: unknown): Satang | null {
  if (typeof value === 'bigint') return value
  return typeof value === 'string' && MONEY_TEXT.test(value) ? amountToSatang(value) : null
}
