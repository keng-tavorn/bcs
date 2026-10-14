import { z } from 'zod'
import type { Ctx } from '@/server/context'
import { releaseRetention } from '@/server/services/ap/retention'
import type { TaxOutcome } from '@/ui/wht/outcome'
import type { Locale } from '../../_tracking/present'
import { invalid, taxFailure } from '../wht/failure'

// The command behind /finance/retentions (S8-13, FR-AP-106 AC4), apart from the session so tests run it with a
// context: the input is parsed first, then retention.release decides — FINANCE, PAY on, the row's version, and the due
// date (RETENTION_NOT_DUE with the date in words). The idempotencyKey comes from the form, one per submission.

const Key = z.uuid()
const ReleaseInput = z.object({ retentionId: z.uuid(), version: z.number().int().min(0) })

export async function releaseRetentionFor(ctx: Ctx, input: unknown, idempotencyKey: unknown, locale: Locale): Promise<TaxOutcome> {
  if (!Key.safeParse(idempotencyKey).success) return invalid('INPUT')
  const parsed = ReleaseInput.safeParse(input)
  if (!parsed.success) return invalid('INPUT')
  const result = await releaseRetention(ctx, parsed.data, { idempotencyKey: idempotencyKey as string })
  return result.ok ? { ok: true } : taxFailure(result.error, locale)
}
