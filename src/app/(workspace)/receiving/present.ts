import { formatSatang } from '@/core/money/format'
import type { ReceivingCandidateDto } from '@/server/queries/receiving'
import type { ReceiptView as ReceiptDtoView, ApproverPreviewDto, CloseShortPlanDto, ReceiptPreviewDto, ReceivingLineView, VarianceView as VarianceDtoView } from '@/server/services/receiving/view'
import { formatDateTime } from '@/ui/format'
import { groupQuantity, isZeroQuantity } from '@/ui/receiving/quantity'
import type { ReceivingRowView } from '@/ui/receiving/receiving-list'
import type { ApproverView, CloseShortPlanView, ReceiptPreviewView, ReceiptView, ReceiveLineView, VarianceView } from '@/ui/receiving/types'

// Turns the receiving service's read models into what the receiving components show (FR-P2P-006, FR-P2P-007):
// quantities with thousands separators, money as BigInt satang formatted with 2 decimals (FR-PLT-002 AC3), names in both
// languages, dates in the reader's language — plain JSON, so a server action can hand it to the browser.

const money = (satang: bigint | null): string | null => (satang === null ? null : formatSatang(satang))

const PO_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED', 'REJECTED'] as const
export type PoStatusKey = (typeof PO_STATUSES)[number]
/** PurchaseOrder.status as a message key (receiving.status.po) */
export const poStatusKey = (status: string): PoStatusKey => ((PO_STATUSES as readonly string[]).includes(status) ? (status as PoStatusKey) : 'DRAFT')

/** One row of /receiving; `sodRule` when separation of duties refuses the member (BR-SOD-02, BR-SOD-07) */
export function rowView(c: ReceivingCandidateDto, locale: string, sodRule?: string): ReceivingRowView {
  return {
    id: c.id,
    href: `/receiving/${c.id}`,
    number: c.number,
    status: c.status,
    supplier: c.supplier,
    site: c.site,
    requests: c.requests.map((r) => ({ number: r.number, requester: r.requester?.name ?? null, department: r.department?.name ?? null })),
    sentAt: c.sentAt ? formatDateTime(locale, c.sentAt) : null,
    lineCount: c.lineCount,
    outstandingLines: c.outstandingLines,
    ...(sodRule ? { sodRule } : {}),
  }
}
const quantityOrNull = (text: string): string | null => (isZeroQuantity(text) ? null : groupQuantity(text))

export function approverView(a: ApproverPreviewDto): ApproverView {
  if (a.kind === 'BLOCKED') return { kind: 'BLOCKED', code: a.code }
  const role = a.role
  return {
    kind: 'ROUTE',
    ruleCode: a.ruleCode,
    name: a.assignee?.name ?? null,
    actingFor: a.actingFor?.name ?? null,
    position: role.kind === 'POSITION' ? (role.position ?? { th: role.positionCode, en: null }) : null,
    department: role.kind === 'POSITION' && !role.orgWide ? role.department : null,
  }
}

export function lineViews(lines: readonly ReceivingLineView[]): ReceiveLineView[] {
  return lines.map((l) => ({
    id: l.id,
    description: l.description,
    uom: l.uom,
    ordered: groupQuantity(l.ordered),
    received: groupQuantity(l.received),
    outstanding: groupQuantity(l.outstanding),
    cancelled: quantityOrNull(l.cancelled),
    keepPending: quantityOrNull(l.keepPending),
  }))
}

export function previewView(p: ReceiptPreviewDto): ReceiptPreviewView {
  return {
    poStatusAfter: p.poStatusAfter,
    linesOutstandingAfter: p.linesOutstandingAfter,
    tolerancePct: p.tolerancePct,
    lines: p.lines.map((l) => ({
      poLineId: l.poLineId,
      description: l.description,
      uom: l.uom,
      received: groupQuantity(l.received),
      rejected: quantityOrNull(l.rejected),
      accepted: groupQuantity(l.accepted),
      outstandingAfter: groupQuantity(l.outstandingAfter),
      withinTolerance: l.withinTolerance ? groupQuantity(l.withinTolerance) : null,
      hold: money(l.holdSatang),
      excess: l.excess ? { quantity: groupQuantity(l.excess.quantity), amount: money(l.excess.amountSatang), keep: approverView(l.excess.keepApprover) } : null,
      damaged: l.damaged ? { quantity: groupQuantity(l.damaged.quantity), amount: money(l.damaged.amountSatang), keep: approverView(l.damaged.keepApprover) } : null,
    })),
  }
}

export function varianceView(v: VarianceDtoView): VarianceView {
  return { id: v.id, description: v.description, uom: v.uom, type: v.type, disposition: v.disposition, status: v.status, quantity: groupQuantity(v.quantity), amount: money(v.amountSatang), reason: v.reason }
}

export function receiptViews(receipts: readonly ReceiptDtoView[], locale: string): ReceiptView[] {
  return receipts.map((r) => ({
    id: r.id,
    number: r.number,
    status: r.status,
    when: formatDateTime(locale, r.receivedAt),
    receiver: r.receiver?.name ?? null,
    deliveryNoteNo: r.deliveryNoteNo,
    notes: r.notes,
    reverseReason: r.status === 'REVERSED' ? r.reverseReason : null,
    lines: r.lines.map((l) => ({ poLineId: l.poLineId, description: l.description, uom: l.uom, received: groupQuantity(l.received), accepted: groupQuantity(l.accepted), refused: quantityOrNull(l.refused), remark: l.remark })),
    photos: r.photos.map((p) => ({ fileId: p.fileId, fileName: p.fileName })),
    variances: r.variances.map(varianceView),
  }))
}

export function closeShortPlanView(plan: CloseShortPlanDto): CloseShortPlanView {
  return {
    lines: plan.lines.map((l) => ({ poLineId: l.poLineId, description: l.description, uom: l.uom, quantity: groupQuantity(l.quantity), amount: formatSatang(l.amountSatang) })),
    total: formatSatang(plan.totalSatang),
    approvers: plan.approvers.map(approverView),
  }
}
