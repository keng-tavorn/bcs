import { z } from 'zod'
import { amountToSatang } from '@/core/money/dto'
import type { Ctx } from '@/server/context'
import { exportWhtReturn } from '@/server/services/ap/wht-export'
import { revealWhtPayeeTaxId } from '@/server/services/ap/wht-files'
import { formatTaxId } from '@/ui/suppliers/model'
import type { ExportOutcome, RevealOutcome } from '@/ui/wht/outcome'
import type { Locale } from '../../_tracking/present'
import { money } from '../present'
import { invalid, taxFailure } from './failure'

// The commands behind /finance/wht (S8-13, FR-AP-104 AC4 AC5), apart from the session so tests run them with a
// context. Showing an individual payee's national id whole goes through revealWhtPayeeTaxId, which checks
// wht.revealTaxId and writes the SensitiveAccessLog row in the transaction that hands the value out (BR-WHT-09); the
// monthly summary through wht.export (and wht.revealTaxId again when the file holds ids whole). Inputs are parsed
// first, so a malformed call gets VALIDATION_FAILED and never a crash.

const Key = z.uuid()
const RevealInput = z.object({ certificateId: z.uuid() })
const ExportInput = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), form: z.enum(['PND3', 'PND53']), revealTaxId: z.boolean() })

/** The whole tax id of a 50 ทวิ's payee, formatted, with its log row written */
export async function revealPayeeTaxIdFor(ctx: Ctx, input: unknown, locale: Locale): Promise<RevealOutcome> {
  const parsed = RevealInput.safeParse(input)
  if (!parsed.success) return invalid('INPUT')
  const result = await revealWhtPayeeTaxId(ctx, parsed.data)
  return result.ok ? { ok: true, taxId: formatTaxId(result.data.taxId) } : taxFailure(result.error, locale)
}

/** The monthly ภ.ง.ด.3 or ภ.ง.ด.53 summary: its rows, total and sha256, and the file to download */
export async function exportWhtReturnFor(ctx: Ctx, input: unknown, idempotencyKey: unknown, locale: Locale): Promise<ExportOutcome> {
  if (!Key.safeParse(idempotencyKey).success) return invalid('INPUT')
  const parsed = ExportInput.safeParse(input)
  if (!parsed.success) return invalid(parsed.error.issues[0]?.path[0] === 'month' ? 'MONTH' : 'INPUT')
  const result = await exportWhtReturn(ctx, parsed.data, { idempotencyKey: idempotencyKey as string })
  if (!result.ok) return taxFailure(result.error, locale)
  const { fileId, rowCount, total, checksum } = result.data
  return { ok: true, fileId, rowCount, total: money(amountToSatang(total)), checksum }
}
