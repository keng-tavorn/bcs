import { z } from 'zod'
import { lineNet, parseQuantity, type Satang } from '@/core/money/math'
import { formatQuantity } from '@/core/receiving'
import { PO_MACHINE, transition, type PoState } from '@/core/state-machines'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import type { TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import type { AppError } from '@/core/result'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { poBudgetLines, releaseClosedPo } from './budget'
import { completeFinishedRequests } from './requests'

// Closing a PO (spec §6.4 po.close, BR-BUD-06, FR-P2P-010 AC2 AC3, ADR-038 ข้อ 10): every line must have come in full,
// or its shortfall be given up by an approved CLOSE_SHORT variance (its quantity then counts as cancelled). What each
// line still holds goes back, except what was received and not yet invoiced — held until the invoice comes, which can
// be recorded on the closed PO; once the final invoice is in, nothing is kept. Requests whose POs are all closed or
// cancelled are completed.
// The same rule holds for a PO received in full and for one with some invoices then closed (short or not): keep what was
// received and not invoiced, give back the rest (NEW-11, the user 2026-10-08).

type Fail = { ok: false; error: AppError }
const scaled = (d: { toString(): string }) => parseQuantity(d.toString())

/** Lines that still wait for goods: neither received in full nor given up (cancelled) */
export async function unsettledLines(tx: TenantTx, poId: string) {
  const lines = await tx.poLine.findMany({ where: { poId }, orderBy: { lineNo: 'asc' } })
  return lines.filter((l) => scaled(l.receivedQuantity) + scaled(l.cancelledQuantity) < scaled(l.quantity))
}

/** Received and not yet invoiced, per PO line, before VAT (BR-RPT-01 at today's date) */
async function receivedNotInvoiced(tx: TenantTx, poId: string): Promise<Map<string, Satang>> {
  // A tier-2 invoice counts once it moved to ACTUAL (ready for payment or later, BR-AP-11); one track per PO (BR-IVC-06)
  const actualized = { status: { in: ['READY_FOR_PAYMENT' as const, 'IN_PAYMENT_RUN' as const, 'PAID' as const] } }
  if (await tx.invoiceConfirmation.count({ where: { poId, isFinal: true } })) return new Map()
  if (await tx.invoice.count({ where: { poId, isFinal: true, ...actualized } })) return new Map()
  const lines = await tx.poLine.findMany({
    where: { poId },
    select: { id: true, receivedQuantity: true, unitPriceSatang: true, invoiceParts: { select: { netSatang: true } }, invoiceLines: { where: { invoice: actualized }, select: { netSatang: true } } },
  })
  const keep = new Map<string, Satang>()
  for (const l of lines) {
    const received = lineNet(formatQuantity(scaled(l.receivedQuantity)), l.unitPriceSatang)
    const invoiced = l.invoiceParts.reduce((sum, p) => sum + p.netSatang, 0n) + l.invoiceLines.reduce((sum, p) => sum + p.netSatang, 0n)
    if (received > invoiced) keep.set(l.id, received - invoiced)
  }
  return keep
}

/** Closes a PO the caller has locked, with its source requests locked after it (INV-PLT-03) */
export async function closePoInTx(tx: TenantTx, ctx: Ctx, po: { id: string; status: string }, via: 'PROCUREMENT' | 'CLOSE_SHORT'): Promise<{ ok: true; status: string; events: EventDraft[] } | Fail> {
  const moved = transition(PO_MACHINE, po.status as PoState, 'po.close')
  if (!moved.ok) return { ok: false, error: { code: 'INVALID_STATE_TRANSITION', message: `po.close is not allowed from ${po.status}`, details: { from: po.status, command: 'po.close' } } }
  // FR-P2P-010 AC2: a shortfall needs an approved CLOSE_SHORT
  if ((await unsettledLines(tx, po.id)).length) return { ok: false, error: { code: 'INVALID_STATE_TRANSITION', message: 'some lines are not received in full', details: { from: po.status, command: 'po.close', reason: 'SHORT_NOT_APPROVED' } } }
  const requests = await tx.request.findMany({ where: { lines: { some: { poSources: { some: { poLine: { poId: po.id } } } } } }, select: { id: true } })
  const requestIds = await lockRowsForUpdate(
    tx,
    'Request',
    ctx.organizationId,
    requests.map((r) => r.id),
  )
  const lines = await poBudgetLines(tx, po.id)
  const keep = await receivedNotInvoiced(tx, po.id)
  const heldBefore = await tx.budgetAllocation.findMany({ where: { sourceType: 'PO_LINE', sourceId: { in: lines.map((l) => l.poLineId) } }, select: { committedSatang: true } })
  const budget = await releaseClosedPo(tx, ctx, po.id, lines, keep)
  if (!budget.ok) return budget
  const heldAfter = await tx.budgetAllocation.findMany({ where: { sourceType: 'PO_LINE', sourceId: { in: lines.map((l) => l.poLineId) } }, select: { committedSatang: true } })
  const sum = (rows: { committedSatang: bigint }[]) => rows.reduce((s, r) => s + r.committedSatang, 0n)
  await tx.purchaseOrder.update({ where: { id: po.id }, data: { status: moved.to, closedAt: ctx.now, version: { increment: 1 } } })
  const completed = await completeFinishedRequests(tx, requestIds)
  return {
    ok: true,
    status: moved.to,
    events: [
      {
        type: 'po.closed',
        aggregateType: 'PurchaseOrder',
        aggregateId: po.id,
        data: { from: po.status, keptSatang: sum(heldAfter).toString(), releasedSatang: (sum(heldBefore) - sum(heldAfter)).toString(), via, requests: completed.map((c) => ({ requestId: c.requestId, status: c.status })) },
      },
      ...budget.events,
      ...completed.map((c): EventDraft => ({ type: 'request.completed', aggregateType: 'Request', aggregateId: c.requestId, data: { purchaseOrderIds: c.purchaseOrderIds } })),
    ],
  }
}

const CloseInput = z.strictObject({ poId: z.uuid() })

export const closePoCommand = defineCommand({
  name: 'po.close',
  capability: 'po.close',
  input: CloseInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ poId: string; status: string }>> {
    const allowed = await authorize(tx, ctx, 'po.close')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    const [locked] = await lockRowsForUpdate(tx, 'PurchaseOrder', ctx.organizationId, [input.poId])
    if (!locked) return { ok: false, error: { code: 'NOT_FOUND', message: 'purchase order not found' } }
    const po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id: input.poId }, select: { id: true, status: true } })
    const closed = await closePoInTx(tx, ctx, po, 'PROCUREMENT')
    if (!closed.ok) return closed
    return { ok: true, result: { poId: po.id, status: closed.status }, events: closed.events }
  },
})

export function closePurchaseOrder(ctx: Ctx, input: z.input<typeof CloseInput>, options: RunOptions) {
  return runCommand(ctx, closePoCommand, input, options)
}
