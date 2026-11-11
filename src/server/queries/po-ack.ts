import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'

// What the workspace shows of the supplier's acknowledgement of a PO (S7-11 · FR-SUP-105 AC4 · BR-SUP ข้อ 14): the strip of
// a PO's page — acknowledged when, the date promised and the one it moved from — read by a page that checked the reader
// may see the PO (canViewPo). The list of POs not acknowledged yet is in services/suppliers/po-ack.ts (it checks po.view).

export interface PoAckStrip {
  readonly status: 'NOT_ACKNOWLEDGED' | 'ACKNOWLEDGED' | 'DELIVERY_UPDATED'
  readonly acknowledgedAt: string | null
  readonly promisedDeliveryOn: string | null
  /** The date before the latest move, when the supplier moved it */
  readonly movedFrom: string | null
  readonly revisionNo: number
}

const day = (d: Date | null | undefined) => d?.toISOString().slice(0, 10) ?? null

/** The supplier's acknowledgement of a sent PO, or null for a PO not sent (no strip) */
export async function getPoAckStrip(ctx: Ctx, poId: string): Promise<PoAckStrip | null> {
  if (!/^[0-9a-f-]{36}$/.test(poId)) return null
  const db = forTenant(ctx.organizationId)
  const po = await db.purchaseOrder.findUnique({ where: { id: poId }, select: { status: true, revisionNo: true, supplierAckStatus: true, supplierAcknowledgedAt: true, supplierPromisedDeliveryOn: true } })
  if (!po || !['SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED'].includes(po.status)) return null
  const moved = po.supplierAckStatus === 'DELIVERY_UPDATED' ? await db.poAcknowledgement.findFirst({ where: { poId, revisionNo: po.revisionNo, kind: 'DELIVERY_UPDATE' }, orderBy: { createdAt: 'desc' }, select: { previousPromisedOn: true } }) : null
  return { status: po.supplierAckStatus, acknowledgedAt: po.supplierAcknowledgedAt?.toISOString() ?? null, promisedDeliveryOn: day(po.supplierPromisedDeliveryOn), movedFrom: day(moved?.previousPromisedOn), revisionNo: po.revisionNo }
}
