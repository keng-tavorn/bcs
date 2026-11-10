import { z } from 'zod'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import type { Ctx } from '@/server/context'
import { createPreferredSupplier, endPreferredSupplier } from '@/server/services/sourcing'
import { validDay, validToOf } from '@/ui/catalog/model'
import { toPreferredFailure, type PreferredFailure, type PreferredOutcome } from '@/ui/sourcing/preferred-model'

// The commands behind the buttons of /suppliers/preferred (S10-13 · BR-RFX-14 · ADR-207), apart from the session and
// the page cache so tests run them with a context. Server actions are public endpoints (BR-AUTH-05): every argument is
// parsed before it is read, so a malformed call gets VALIDATION_FAILED naming its field and never a crash; then the
// commands of preferred.ts check SOURCING (to set one), sourcing.preferred.manage (PROCUREMENT) and every rule again.
// A period arrives as its first and last day (included, the last one optional) and goes on as
// [validFrom, validTo), validTo the day after the last — left out, the organization's preferredSupplierDays apply.

const Key = z.uuid()
const invalid = (field: string): PreferredFailure => ({ ok: false, code: 'VALIDATION_FAILED', field })
const BAD_KEY = invalid('idempotencyKey')

const NewPreferred = z.strictObject({ categoryCode: z.string().max(50), supplierId: z.uuid(), validFrom: z.string().max(10), lastDay: z.string().max(10), note: z.string().max(REASON_MAX_LENGTH) })
const EndPreferred = z.strictObject({ preferredSupplierId: z.uuid(), reason: z.string().max(REASON_MAX_LENGTH) })

function parseFailure(issues: readonly z.core.$ZodIssue[]): PreferredFailure {
  const first = issues[0]
  if (first?.code === 'unrecognized_keys') return invalid(first.keys[0] ?? '(input)')
  return invalid(typeof first?.path[0] === 'string' ? first.path[0] : '(input)')
}

/** "ตั้งผู้ขายที่แนะนำ": MANUAL, with its reason; a blank last day leaves the period to the organization's default */
export async function createPreferredFromScreen(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<PreferredOutcome<{ preferredSupplierId: string }>> {
  if (!Key.safeParse(idempotencyKey).success) return BAD_KEY
  const parsed = NewPreferred.safeParse(input)
  if (!parsed.success) return parseFailure(parsed.error.issues)
  const v = parsed.data
  if (!validDay(v.validFrom)) return invalid('validFrom')
  const lastDay = v.lastDay.trim()
  if (lastDay && !validDay(lastDay)) return invalid('lastDay')
  const result = await createPreferredSupplier(
    ctx,
    { categoryCode: v.categoryCode, supplierId: v.supplierId, validFrom: v.validFrom, ...(lastDay ? { validTo: validToOf(lastDay) } : {}), note: v.note },
    { idempotencyKey: String(idempotencyKey) },
  )
  return result.ok ? { ok: true, preferredSupplierId: result.data.preferredSupplierId } : toPreferredFailure(result.error)
}

/** "สิ้นสุดผู้ขายที่แนะนำ": from now on the request form no longer fills it (irreversible; a new one may be set) */
export async function endPreferredFromScreen(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<PreferredOutcome<{ preferredSupplierId: string }>> {
  if (!Key.safeParse(idempotencyKey).success) return BAD_KEY
  const parsed = EndPreferred.safeParse(input)
  if (!parsed.success) return parseFailure(parsed.error.issues)
  const result = await endPreferredSupplier(ctx, parsed.data, { idempotencyKey: String(idempotencyKey) })
  return result.ok ? { ok: true, preferredSupplierId: result.data.preferredSupplierId } : toPreferredFailure(result.error)
}
