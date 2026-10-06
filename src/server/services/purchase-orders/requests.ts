import { parseQuantity } from '@/core/money/math'
import { formatQuantity } from '@/core/receiving'
import { REQUEST_MACHINE, transition, type RequestCommand, type RequestState } from '@/core/state-machines'
import type { TenantTx } from '@/server/db/tenant'

// What a PO does to its source requests (spec §6.4 PR table): when a PO is approved its request lines count the
// quantity as ordered and a request whose every line is ordered or cancelled becomes ORDERED (otherwise PARTIALLY_
// ORDERED); when an approved PO is cancelled the quantity is ordered no more — back in the pool (RETURN_TO_POOL,
// NEW-23) or cancelled on the request (CANCEL_REQUEST_LINES, BR-BUD-06). Quantities are decimal text ×10⁴ (§6.1).

export interface RequestStatusChange {
  readonly requestId: string
  readonly status: string
}

const scaled = (d: { toString(): string }) => parseQuantity(d.toString())

/** The sources of a PO, summed per request line */
async function orderedBySource(tx: TenantTx, poId: string): Promise<Map<string, bigint>> {
  const sources = await tx.poLineSource.findMany({ where: { poLine: { poId } }, select: { requestLineId: true, quantity: true } })
  const out = new Map<string, bigint>()
  for (const s of sources) out.set(s.requestLineId, (out.get(s.requestLineId) ?? 0n) + scaled(s.quantity))
  return out
}

/** Moves each request through REQUEST_MACHINE by the command `pick` chooses for it; returns those that moved */
async function moveRequests(tx: TenantTx, requestIds: readonly string[], pick: (request: { status: RequestState; lines: { quantity: bigint; ordered: bigint; cancelled: bigint }[] }) => RequestCommand | null): Promise<RequestStatusChange[]> {
  const requests = await tx.request.findMany({ where: { id: { in: [...requestIds] } }, select: { id: true, status: true, lines: { select: { quantity: true, orderedQuantity: true, cancelledQuantity: true } } } })
  const moved: RequestStatusChange[] = []
  for (const r of requests) {
    const command = pick({ status: r.status as RequestState, lines: r.lines.map((l) => ({ quantity: scaled(l.quantity), ordered: scaled(l.orderedQuantity), cancelled: scaled(l.cancelledQuantity) })) })
    if (!command) continue
    const t = transition(REQUEST_MACHINE, r.status as RequestState, command)
    if (!t.ok) continue
    await tx.request.update({ where: { id: r.id }, data: { status: t.to, version: { increment: 1 } } })
    moved.push({ requestId: r.id, status: t.to })
  }
  return moved
}

const allSettled = (lines: readonly { quantity: bigint; ordered: bigint; cancelled: bigint }[]) => lines.every((l) => l.ordered + l.cancelled >= l.quantity)

/** §6.4: an approved PO orders its source lines; their requests become ORDERED or PARTIALLY_ORDERED */
export async function orderSourceLines(tx: TenantTx, poId: string): Promise<RequestStatusChange[]> {
  const ordered = await orderedBySource(tx, poId)
  const lines = await tx.requestLine.findMany({ where: { id: { in: [...ordered.keys()] } }, select: { id: true, requestId: true, orderedQuantity: true } })
  for (const l of lines) await tx.requestLine.update({ where: { id: l.id }, data: { orderedQuantity: formatQuantity(scaled(l.orderedQuantity) + ordered.get(l.id)!) } })
  return moveRequests(
    tx,
    [...new Set(lines.map((l) => l.requestId))],
    (r) => (allSettled(r.lines) ? 'po.approved_fully' : r.status === 'APPROVED' ? 'po.approved_partially' : null),
  )
}

/** BR-BUD-06: an approved PO cancelled orders its lines no more; RETURN_TO_POOL puts them back, else they are cancelled */
export async function unorderSourceLines(tx: TenantTx, poId: string, disposition: 'RETURN_TO_POOL' | 'CANCEL_REQUEST_LINES'): Promise<RequestStatusChange[]> {
  const ordered = await orderedBySource(tx, poId)
  const lines = await tx.requestLine.findMany({ where: { id: { in: [...ordered.keys()] } }, select: { id: true, requestId: true, orderedQuantity: true, cancelledQuantity: true } })
  for (const l of lines) {
    const quantity = ordered.get(l.id)!
    await tx.requestLine.update({
      where: { id: l.id },
      data: {
        orderedQuantity: formatQuantity(scaled(l.orderedQuantity) - quantity),
        ...(disposition === 'CANCEL_REQUEST_LINES' ? { cancelledQuantity: formatQuantity(scaled(l.cancelledQuantity) + quantity) } : {}),
      },
    })
  }
  const requestIds = [...new Set(lines.map((l) => l.requestId))]
  // Cancelled on the request: a request with nothing left to order is ORDERED (§6.4 "ยกเลิกส่วนที่เหลือ")
  if (disposition === 'CANCEL_REQUEST_LINES') return moveRequests(tx, requestIds, (r) => (allSettled(r.lines) && r.status !== 'ORDERED' ? 'request.cancel_remaining' : null))
  return moveRequests(tx, requestIds, (r) => (r.lines.some((l) => l.ordered > 0n) ? (r.status === 'ORDERED' ? 'po.cancelled_to_pool_partially' : null) : 'po.cancelled_to_pool_fully'))
}

/** POs that order a request's lines and are still open: not CLOSED, CANCELLED or REJECTED */
const OPEN_PO_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED'] as const

/**
 * §6.4: an ORDERED request whose POs are all closed (or cancelled) is COMPLETED. Returns the requests completed with
 * the POs that ordered them, for their request.completed events.
 */
export async function completeFinishedRequests(tx: TenantTx, requestIds: readonly string[]): Promise<Array<RequestStatusChange & { purchaseOrderIds: string[] }>> {
  const done: Array<RequestStatusChange & { purchaseOrderIds: string[] }> = []
  const ordered = await tx.request.findMany({ where: { id: { in: [...requestIds] }, status: 'ORDERED' }, select: { id: true } })
  for (const r of ordered) {
    const pos = await tx.purchaseOrder.findMany({ where: { lines: { some: { sources: { some: { requestLine: { requestId: r.id } } } } } }, select: { id: true, status: true } })
    if (pos.some((p) => (OPEN_PO_STATUSES as readonly string[]).includes(p.status))) continue
    const t = transition(REQUEST_MACHINE, 'ORDERED', 'po.all_closed')
    if (!t.ok) continue
    await tx.request.update({ where: { id: r.id }, data: { status: t.to, version: { increment: 1 } } })
    done.push({ requestId: r.id, status: t.to, purchaseOrderIds: pos.map((p) => p.id) })
  }
  return done
}
