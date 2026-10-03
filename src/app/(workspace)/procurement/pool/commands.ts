import { z } from 'zod'
import { formatSatang } from '@/core/money/format'
import type { Ctx } from '@/server/context'
import { draftsMade } from '@/server/queries/procurement'
import { assignSupplier, consolidateNow, listPool } from '@/server/services/procurement'
import { toPoolFailure, type DraftView, type PoolOutcome } from '@/ui/procurement/outcome'

// The commands behind the buttons of the procurement pool (FR-P2P-001 AC2, FR-P2P-002 AC3), apart from the session and
// the page cache so tests run them with a context. Every input is parsed first, so a malformed call gets
// VALIDATION_FAILED and never a crash; then the service checks po.create and the pool again (BR-AUTH-05) and changes
// what it changes in one command with its Event. What the screen shows after — the drafts made, the lines left and why
// — is read back afterwards with the member's own context.

const Key = z.uuid()
const AssignInput = z.object({ requestLineIds: z.array(z.uuid()).min(1).max(500), supplierId: z.uuid().nullable() })
const BAD_KEY: PoolOutcome = { ok: false, code: 'VALIDATION_FAILED', field: 'idempotencyKey' }

async function draftViews(ctx: Ctx, purchaseOrderIds: readonly string[]): Promise<DraftView[]> {
  return (await draftsMade(ctx, purchaseOrderIds)).map((d) => ({
    id: d.id,
    supplierName: d.supplierName,
    siteName: d.siteName,
    kind: d.kind,
    lineCount: d.lineCount,
    net: formatSatang(d.netSatang),
    requestNumbers: d.requestNumbers,
  }))
}

/** Choose (or take back) the supplier of several pool lines at once; an urgent request is drafted at once (BR-CONS-02) */
export async function assignLines(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<PoolOutcome> {
  if (!Key.safeParse(idempotencyKey).success) return BAD_KEY
  const parsed = AssignInput.safeParse(input)
  if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED', field: 'requestLineIds' }
  const result = await assignSupplier(ctx, parsed.data, { idempotencyKey: idempotencyKey as string })
  if (!result.ok) return toPoolFailure(result.error)
  return { ok: true, assigned: result.data.assigned, drafts: await draftViews(ctx, result.data.purchaseOrderIds) }
}

/** "รวมเป็นร่าง PO ตอนนี้": a round by hand, then what it made and what it left in the pool and why (BR-CONS-03) */
export async function consolidatePool(ctx: Ctx, idempotencyKey: unknown): Promise<PoolOutcome> {
  if (!Key.safeParse(idempotencyKey).success) return BAD_KEY
  const result = await consolidateNow(ctx, { idempotencyKey: idempotencyKey as string })
  if (!result.ok) return toPoolFailure(result.error)
  const [drafts, pool] = await Promise.all([draftViews(ctx, result.data.purchaseOrderIds), listPool(ctx)])
  const lines = pool.ok ? pool.data : []
  return {
    ok: true,
    drafts,
    left: lines.filter((l) => l.needsSupplier).length,
    waiting: lines.filter((l) => !l.needsSupplier).length,
  }
}
