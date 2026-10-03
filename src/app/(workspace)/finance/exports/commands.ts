import { z } from 'zod'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import type { Ctx } from '@/server/context'
import { exportExpress } from '@/server/services/exports/express'
import { exportJobAgain } from '@/server/services/exports/view'
import { toFinanceFailure, type ExportOutcome, type FinanceFailure } from '@/ui/finance/outcome'
import { amountText } from '../present'

// The commands behind the Express export page (S4-09, FR-P2P-009, BR-EXP-01 to BR-EXP-04), apart from the session and
// the page cache so tests run them with a context. Making the file marks its invoices exported, so the screen asks for
// a tick first and sends the fingerprint of the list the person ticked: the command refuses when that list changed
// meanwhile (an invoice recorded, or exported by someone else), so nothing goes into a file unseen. Exporting an
// earlier file's invoices again needs a reason (BR-EXP-02). The export.express command checks the permission and every
// rule again (BR-AUTH-05).

const Key = z.uuid()
const NowInput = z.object({ confirmed: z.boolean(), fingerprint: z.string().regex(/^[0-9a-f]{64}$/) })
const AgainInput = z.object({ exportJobId: z.string().max(64), reason: z.string().max(REASON_MAX_LENGTH) })
const REASON_MIN = 3

const invalid = (field: string, reason?: string): FinanceFailure => ({ ok: false, code: 'VALIDATION_FAILED', field, ...(reason ? { reason } : {}) })

type ExportResult = Awaited<ReturnType<typeof exportExpress>>

function outcomeOf(result: ExportResult): ExportOutcome {
  if (!result.ok) return toFinanceFailure(result.error)
  const d = result.data
  return { ok: true, exportJobId: d.exportJobId, fileId: d.fileId, rowCount: d.rowCount, total: amountText(d.total) ?? d.total, checksum: d.checksum, excluded: d.excluded.length }
}

/** FR-P2P-009 AC1: every invoice not exported yet that the layout takes, in one file — the list the person ticked */
export async function exportNow(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<ExportOutcome> {
  if (!Key.safeParse(idempotencyKey).success) return invalid('idempotencyKey')
  const parsed = NowInput.safeParse(input)
  if (!parsed.success || !parsed.data.confirmed) return invalid('confirm')
  return outcomeOf(await exportExpress(ctx, { pendingFingerprint: parsed.data.fingerprint }, { idempotencyKey: idempotencyKey as string }))
}

/** BR-EXP-02: the invoices of an earlier file again, as a new file, with a reason */
export async function exportAgain(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<ExportOutcome> {
  if (!Key.safeParse(idempotencyKey).success) return invalid('idempotencyKey')
  const parsed = AgainInput.safeParse(input)
  if (!parsed.success) return invalid('reason', 'REASON_REQUIRED')
  const reason = parsed.data.reason.trim()
  if (reason.length < REASON_MIN) return invalid('reason', 'REASON_REQUIRED')
  if (!z.uuid().safeParse(parsed.data.exportJobId).success) return { ok: false, code: 'NOT_FOUND' }
  return outcomeOf(await exportJobAgain(ctx, { exportJobId: parsed.data.exportJobId, reason }, { idempotencyKey: idempotencyKey as string }))
}
