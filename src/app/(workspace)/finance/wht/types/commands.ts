import { z } from 'zod'
import { BASIS_POINTS_WHOLE } from '@/lib/constants'
import type { Ctx } from '@/server/context'
import { confirmIncomeType, updateIncomeType } from '@/server/services/ap/wht'
import type { TaxOutcome } from '@/ui/wht/outcome'
import type { Locale } from '../../../_tracking/present'
import { invalid, taxFailure } from '../failure'

// The commands behind /finance/wht/types (S8-13, FR-AP-104 AC2, BR-WHT-03), apart from the session so tests run them
// with a context. The rate is typed as a percentage ("3", "1.5") and turned into basis points here from its text —
// whole and fraction digits as integers, never a float. Then wht.incomeType.update / .confirm decide: FINANCE
// (wht.configure), PAY on, and the confirmer is never the member who changed the type last (SOD_VIOLATION).

const Key = z.uuid()
const CODE = /^[A-Z0-9_]{1,40}$/
const PERCENT = /^(\d{1,3})(?:\.(\d{1,2}))?$/

const TypeForm = z.object({
  code: z.string().max(80),
  nameTh: z.string().max(400),
  nameEn: z.string().max(400),
  rate: z.string().max(20),
  form: z.enum(['PND3_53', 'PND53', 'PND3']),
  legalRefTh: z.string().max(400),
  active: z.boolean(),
})
const ConfirmForm = z.object({ code: z.string().min(1).max(40) })

/** "3" → 300, "1.5" → 150, "0.75" → 75, "3%" → 300; null when it is not a percentage from 0 to 100 with ≤ 2 decimals */
export function percentToBasisPoints(text: string): number | null {
  const match = PERCENT.exec(text.trim().replace(/\s*%$/, ''))
  if (!match) return null
  const bp = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'))
  return bp <= BASIS_POINTS_WHOLE ? bp : null
}

const optional = (text: string): string | null => (text.trim() ? text.trim() : null)

export async function updateIncomeTypeFor(ctx: Ctx, input: unknown, idempotencyKey: unknown, locale: Locale): Promise<TaxOutcome> {
  if (!Key.safeParse(idempotencyKey).success) return invalid('INPUT')
  const parsed = TypeForm.safeParse(input)
  if (!parsed.success) return invalid('INPUT')
  const value = parsed.data
  const code = value.code.trim().toUpperCase()
  if (!CODE.test(code)) return invalid('CODE')
  const nameTh = value.nameTh.trim()
  if (!nameTh || nameTh.length > 200) return invalid('NAME')
  const rateBp = percentToBasisPoints(value.rate)
  if (rateBp === null) return invalid('RATE')
  const nameEn = optional(value.nameEn)
  const legalRefTh = optional(value.legalRefTh)
  if ((nameEn?.length ?? 0) > 200 || (legalRefTh?.length ?? 0) > 200) return invalid('INPUT')
  const result = await updateIncomeType(ctx, { code, nameTh, nameEn, rateBp, form: value.form, legalRefTh, active: value.active }, { idempotencyKey: idempotencyKey as string })
  return result.ok ? { ok: true } : taxFailure(result.error, locale)
}

export async function confirmIncomeTypeFor(ctx: Ctx, input: unknown, idempotencyKey: unknown, locale: Locale): Promise<TaxOutcome> {
  if (!Key.safeParse(idempotencyKey).success) return invalid('INPUT')
  const parsed = ConfirmForm.safeParse(input)
  if (!parsed.success) return invalid('INPUT')
  const result = await confirmIncomeType(ctx, parsed.data, { idempotencyKey: idempotencyKey as string })
  return result.ok ? { ok: true } : taxFailure(result.error, locale)
}
