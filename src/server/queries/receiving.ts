import { parseQuantity } from '@/core/money/math'
import { formatQuantity } from '@/core/receiving'
import type { Ctx } from '@/server/context'
import { forTenant, type TenantDb } from '@/server/db/tenant'
import { departmentsOf, isUuid, membersById, type DepartmentRefDto, type MemberRefDto, type NameDto } from './requests'

// Read-only views of purchase orders for receiving (spec §9.1 /receiving, FR-P2P-006, FR-P2P-007, FR-P2P-010 AC2): the
// POs that wait for goods, a page at a time, one PO with its lines (ordered, received so far, given up, still to come,
// damaged goods waiting to be kept), its receipts with their photos and variances, and its close-short requests; and,
// for any PO, the people tied to it — who asked for the goods and who approved the PRs or the PO, from which the
// receiving service decides who may receive (gr.post, BR-SOD-02), and who may view it (po.view). Queries never check
// permissions: src/server/services/receiving/view.ts does before it hands anything on.

/** PO statuses that take goods (§6.4: a GR is posted on SENT or PARTIALLY_RECEIVED) */
export const RECEIVABLE_PO_STATUSES = ['SENT', 'PARTIALLY_RECEIVED'] as const
/** POs per page of /receiving: a phone scrolls through this many comfortably */
export const RECEIVING_PAGE_SIZE = 50

const quantityText = (d: { toString(): string }): string => formatQuantity(parseQuantity(d.toString()))
const scaled = (d: { toString(): string }): bigint => parseQuantity(d.toString())
const nameOf = (th: string, en: string | null | undefined): NameDto => ({ th, en: en ?? null })

/** What is still to come on a line: ordered less what was accepted and what was given up, never below zero */
function outstandingOf(line: { quantity: { toString(): string }; receivedQuantity: { toString(): string }; cancelledQuantity: { toString(): string } }): bigint {
  const left = scaled(line.quantity) - scaled(line.receivedQuantity) - scaled(line.cancelledQuantity)
  return left > 0n ? left : 0n
}

// ---------- the people tied to a PO ----------

export interface PoRequestDto {
  readonly id: string
  readonly number: string | null
  readonly title: string
  readonly requesterMemberId: string
  readonly requesterDepartmentId: string
}

export interface ReceivingPartiesDto {
  readonly requests: readonly PoRequestDto[]
  /** Who approved the PRs or the PO: the deciders of approved tasks and the members a delegate acted for (ADR-038 ข้อ 8) */
  readonly approvers: readonly string[]
}

/** The tables receivingParties reads: the tenant client, or a transaction of it (the file download policy runs in one) */
type PartiesReader = Pick<TenantDb, 'poLineSource' | 'approvalTask'>

/** The requests each PO orders for, and everyone who approved them or the PO, by PO id */
export async function receivingParties(db: PartiesReader, poIds: readonly string[]): Promise<Map<string, ReceivingPartiesDto>> {
  const out = new Map<string, { requests: Map<string, PoRequestDto>; approvers: Set<string> }>(poIds.map((id) => [id, { requests: new Map(), approvers: new Set() }]))
  if (poIds.length === 0) return new Map()
  const sources = await db.poLineSource.findMany({
    where: { poLine: { poId: { in: [...poIds] } } },
    select: {
      poLine: { select: { poId: true } },
      requestLine: { select: { request: { select: { id: true, number: true, title: true, requesterMemberId: true, requesterDepartmentId: true } } } },
    },
  })
  const posOfRequest = new Map<string, Set<string>>()
  for (const s of sources) {
    const request = s.requestLine.request
    out.get(s.poLine.poId)?.requests.set(request.id, request)
    posOfRequest.set(request.id, (posOfRequest.get(request.id) ?? new Set()).add(s.poLine.poId))
  }
  const decided = await db.approvalTask.findMany({
    where: {
      status: 'APPROVED',
      step: { route: { OR: [{ subjectType: 'REQUEST', subjectId: { in: [...posOfRequest.keys()] } }, { subjectType: 'PURCHASE_ORDER', subjectId: { in: [...poIds] } }] } },
    },
    select: { decidedByMemberId: true, principalMemberId: true, step: { select: { route: { select: { subjectType: true, subjectId: true } } } } },
  })
  for (const task of decided) {
    const route = task.step.route
    const pos = route.subjectType === 'PURCHASE_ORDER' ? [route.subjectId] : [...(posOfRequest.get(route.subjectId) ?? [])]
    for (const poId of pos) {
      for (const memberId of [task.decidedByMemberId, task.principalMemberId]) if (memberId) out.get(poId)?.approvers.add(memberId)
    }
  }
  return new Map([...out].map(([poId, p]) => [poId, { requests: [...p.requests.values()], approvers: [...p.approvers].sort() }]))
}

/**
 * The facts of po.view (§2.4) for one PO, read as the PO's PDF (services/documents/pdf.ts) and the PO page read them, so
 * every screen of a PO opens for the same people
 */
export interface PoViewFactsDto {
  /** OWN: who sent it for approval and the requesters of its PRs */
  readonly ownerMemberIds: readonly string[]
  /** ASSIGNED: everyone who has or had an approval task on the PO, and whom they acted for */
  readonly assigneeMemberIds: readonly string[]
}

type FactsReader = Pick<TenantDb, 'purchaseOrder' | 'poLineSource' | 'approvalTask'>

export async function poViewFacts(db: FactsReader, poId: string): Promise<PoViewFactsDto> {
  const [po, sources, tasks] = await Promise.all([
    db.purchaseOrder.findFirst({ where: { id: poId }, select: { createdById: true } }),
    db.poLineSource.findMany({ where: { poLine: { poId } }, select: { requestLine: { select: { request: { select: { requesterMemberId: true } } } } } }),
    db.approvalTask.findMany({ where: { step: { route: { subjectType: 'PURCHASE_ORDER', subjectId: poId } } }, select: { assigneeMemberId: true, principalMemberId: true } }),
  ])
  const present = (ids: ReadonlyArray<string | null | undefined>) => [...new Set(ids.filter((m): m is string => Boolean(m)))].sort()
  return {
    ownerMemberIds: present([po?.createdById, ...sources.map((s) => s.requestLine.request.requesterMemberId)]),
    assigneeMemberIds: present(tasks.flatMap((t) => [t.assigneeMemberId, t.principalMemberId])),
  }
}

/**
 * Who took part in one goods receipt: the member who received the goods (and took its photos), and the approvers of its
 * variances — a damaged-goods photo is the evidence they decide on (BR-GR-05)
 */
export async function receiptParticipants(db: Pick<TenantDb, 'goodsReceipt' | 'variance' | 'approvalTask'>, grId: string): Promise<{ readonly poId: string; readonly memberIds: readonly string[] } | null> {
  const gr = await db.goodsReceipt.findFirst({ where: { id: grId }, select: { poId: true, receiverMemberId: true } })
  if (!gr) return null
  const variances = await db.variance.findMany({ where: { grId }, select: { id: true } })
  const tasks = variances.length
    ? await db.approvalTask.findMany({ where: { step: { route: { subjectType: 'VARIANCE', subjectId: { in: variances.map((v) => v.id) } } } }, select: { assigneeMemberId: true, principalMemberId: true } })
    : []
  return { poId: gr.poId, memberIds: [...new Set([gr.receiverMemberId, ...tasks.flatMap((t) => [t.assigneeMemberId, ...(t.principalMemberId ? [t.principalMemberId] : [])])])] }
}

// ---------- the list ----------

export interface ReceivingCandidateDto {
  readonly id: string
  readonly number: string | null
  readonly status: (typeof RECEIVABLE_PO_STATUSES)[number]
  readonly sentAt: Date | null
  readonly supplier: NameDto
  readonly site: NameDto | null
  readonly requests: ReadonlyArray<{ readonly id: string; readonly number: string | null; readonly requester: MemberRefDto | null; readonly department: DepartmentRefDto | null }>
  readonly lineCount: number
  /** Lines with something still to come */
  readonly outstandingLines: number
  readonly parties: ReceivingPartiesDto
}

export interface ReceivingCandidatePageDto {
  /** Every PO of the filter, on all pages */
  readonly total: number
  readonly rows: readonly ReceivingCandidateDto[]
}

/**
 * POs that take goods now (SENT or PARTIALLY_RECEIVED) and that a member could be asked to receive: a request of the PO
 * came from one of `departmentIds`, or from `requesterMemberId` (the member's own requests, when they may receive them).
 * Oldest sent first, `page` (from 1) of RECEIVING_PAGE_SIZE. The service decides who may receive each one.
 */
export async function listReceivingCandidates(
  ctx: Ctx,
  filter: { readonly departmentIds: readonly string[]; readonly requesterMemberId: string | null; readonly page: number },
): Promise<ReceivingCandidatePageDto> {
  const db = forTenant(ctx.organizationId)
  const asked = [
    ...(filter.departmentIds.length ? [{ requesterDepartmentId: { in: [...filter.departmentIds] } }] : []),
    ...(filter.requesterMemberId ? [{ requesterMemberId: filter.requesterMemberId }] : []),
  ]
  if (asked.length === 0) return { total: 0, rows: [] }
  const where = { status: { in: [...RECEIVABLE_PO_STATUSES] }, lines: { some: { sources: { some: { requestLine: { request: { OR: asked } } } } } } }
  const page = Number.isInteger(filter.page) && filter.page > 0 ? filter.page : 1
  const [total, rows] = await Promise.all([
    db.purchaseOrder.count({ where }),
    db.purchaseOrder.findMany({
      where,
      orderBy: [{ sentAt: 'asc' }, { number: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * RECEIVING_PAGE_SIZE,
      take: RECEIVING_PAGE_SIZE,
      select: {
        id: true,
        number: true,
        status: true,
        sentAt: true,
        supplier: { select: { nameTh: true, nameEn: true } },
        deliverySite: { select: { nameTh: true } },
        lines: { select: { quantity: true, receivedQuantity: true, cancelledQuantity: true } },
      },
    }),
  ])
  const parties = await receivingParties(
    db,
    rows.map((r) => r.id),
  )
  const people = await membersById(
    db,
    [...parties.values()].flatMap((p) => p.requests.map((r) => r.requesterMemberId)),
  )
  const departments = await departmentsOf(db)
  return {
    total,
    rows: rows.map((r) => {
      const p = parties.get(r.id) ?? { requests: [], approvers: [] }
      return {
        id: r.id,
        number: r.number,
        status: r.status as ReceivingCandidateDto['status'],
        sentAt: r.sentAt,
        supplier: nameOf(r.supplier.nameTh, r.supplier.nameEn),
        site: r.deliverySite ? nameOf(r.deliverySite.nameTh, null) : null,
        requests: p.requests.map((q) => ({ id: q.id, number: q.number, requester: people.get(q.requesterMemberId) ?? null, department: departments.byId.get(q.requesterDepartmentId) ?? null })),
        lineCount: r.lines.length,
        outstandingLines: r.lines.filter((l) => outstandingOf(l) > 0n).length,
        parties: p,
      }
    }),
  }
}

// ---------- one PO ----------

export type VarianceTypeDto = 'OVER' | 'SHORT' | 'DAMAGED'
export type VarianceDispositionDto = 'ACCEPT_EXCESS' | 'RETURN_EXCESS' | 'ACCEPT_DAMAGED' | 'RETURN_REPLACE' | 'CLOSE_SHORT'
export type VarianceStatusDto = 'RECORDED' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED'

export interface VarianceDto {
  readonly id: string
  readonly poLineId: string
  readonly description: string
  readonly uom: string
  readonly type: VarianceTypeDto
  readonly disposition: VarianceDispositionDto
  readonly status: VarianceStatusDto
  readonly quantity: string
  readonly amountSatang: bigint
  readonly reason: string | null
  readonly createdAt: Date
  readonly decidedAt: Date | null
}

export interface ReceivingLineDto {
  readonly id: string
  readonly lineNo: number
  readonly description: string
  readonly uom: string
  readonly ordered: string
  /** Accepted on posted receipts, with the excess kept */
  readonly received: string
  /** Given up: closed short (or cancelled) */
  readonly cancelled: string
  /** Not in yet: ordered less what was accepted and what was given up (damaged goods waiting to be kept included) */
  readonly outstanding: string
  /** Of that, damaged goods the receiver asked to keep, waiting for the GR_VARIANCE approver (ACCEPT_DAMAGED) */
  readonly keepPending: string
  readonly unitPriceSatang: bigint
  /** The department of the line's budget: the GR_VARIANCE approver comes from it (BR-DOA-05) */
  readonly budgetDepartmentId: string
}

export interface ReceiptDto {
  readonly id: string
  readonly number: string | null
  readonly status: 'DRAFT' | 'POSTED' | 'REVERSED'
  readonly receivedAt: Date
  readonly receiver: MemberRefDto | null
  readonly deliveryNoteNo: string | null
  readonly notes: string | null
  readonly reversedAt: Date | null
  readonly reverseReason: string | null
  readonly lines: ReadonlyArray<{
    readonly poLineId: string
    readonly description: string
    readonly uom: string
    readonly received: string
    readonly accepted: string
    /** Not accepted by this receipt (BR-GR-01: received = accepted + rejected), the excess beyond the order included */
    readonly rejected: string
    /** Of that, refused as damaged or for another reason: the excess is told by its OVER variance instead */
    readonly refused: string
    readonly remark: string | null
  }>
  readonly photos: ReadonlyArray<{ readonly fileId: string; readonly fileName: string; readonly sizeBytes: number }>
  readonly variances: readonly VarianceDto[]
}

export interface ReceivingPoDto {
  readonly id: string
  readonly number: string | null
  readonly status: string
  readonly sentAt: Date | null
  readonly vatRateBp: number | null
  readonly supplier: NameDto
  readonly site: NameDto | null
  readonly requests: ReadonlyArray<{ readonly id: string; readonly number: string | null; readonly title: string; readonly requester: MemberRefDto | null; readonly department: DepartmentRefDto | null }>
  readonly lines: readonly ReceivingLineDto[]
  /** Newest first */
  readonly receipts: readonly ReceiptDto[]
  /** Requests to close the PO although goods are still to come (CLOSE_SHORT, no receipt), newest first */
  readonly closeShort: readonly VarianceDto[]
  readonly parties: ReceivingPartiesDto
}

export async function getReceivingPo(ctx: Ctx, poId: string): Promise<ReceivingPoDto | null> {
  if (!isUuid(poId)) return null
  const db = forTenant(ctx.organizationId)
  const po = await db.purchaseOrder.findFirst({
    where: { id: poId },
    select: {
      id: true,
      number: true,
      status: true,
      sentAt: true,
      vatRateBp: true,
      supplier: { select: { nameTh: true, nameEn: true } },
      deliverySite: { select: { nameTh: true } },
      lines: {
        orderBy: { lineNo: 'asc' },
        select: {
          id: true,
          lineNo: true,
          description: true,
          uom: true,
          quantity: true,
          receivedQuantity: true,
          cancelledQuantity: true,
          unitPriceSatang: true,
          budgetLine: { select: { departmentId: true } },
        },
      },
    },
  })
  if (!po) return null
  const [receipts, variances, parties] = await Promise.all([
    db.goodsReceipt.findMany({
      where: { poId },
      orderBy: [{ receivedAt: 'desc' }, { number: 'desc' }],
      select: {
        id: true,
        number: true,
        status: true,
        receivedAt: true,
        receiverMemberId: true,
        deliveryNoteNo: true,
        notes: true,
        reversedAt: true,
        reverseReason: true,
        lines: { select: { poLineId: true, receivedQuantity: true, acceptedQuantity: true, rejectedQuantity: true, remark: true } },
      },
    }),
    db.variance.findMany({ where: { poId }, orderBy: { createdAt: 'desc' } }),
    receivingParties(db, [poId]),
  ])
  const photos = receipts.length
    ? await db.fileLink.findMany({
        where: { subjectType: 'GoodsReceipt', subjectId: { in: receipts.map((r) => r.id) }, kind: 'PHOTO', file: { status: 'AVAILABLE' } },
        orderBy: { createdAt: 'asc' },
        select: { subjectId: true, file: { select: { id: true, fileName: true, sizeBytes: true } } },
      })
    : []
  const p = parties.get(poId) ?? { requests: [], approvers: [] }
  const [people, departments] = await Promise.all([membersById(db, [...receipts.map((r) => r.receiverMemberId), ...p.requests.map((r) => r.requesterMemberId)]), departmentsOf(db)])
  const lineById = new Map(po.lines.map((l) => [l.id, l]))
  const keepPendingOf = (poLineId: string) =>
    variances.filter((v) => v.poLineId === poLineId && v.disposition === 'ACCEPT_DAMAGED' && v.status === 'PENDING_APPROVAL').reduce((sum, v) => sum + scaled(v.quantity), 0n)
  const excessOf =(grId: string, poLineId: string) => variances.filter((v) => v.grId === grId && v.poLineId === poLineId && v.type === 'OVER').reduce((sum, v) => sum + scaled(v.quantity), 0n)
  const refusedOf = (grId: string, g: { poLineId: string; rejectedQuantity: { toString(): string } }) => {
    const refused = scaled(g.rejectedQuantity) - excessOf(grId, g.poLineId)
    return formatQuantity(refused > 0n ? refused : 0n)
  }
  const varianceDto = (v: (typeof variances)[number]): VarianceDto => {
    const line = lineById.get(v.poLineId)
    return {
      id: v.id,
      poLineId: v.poLineId,
      description: line?.description ?? '',
      uom: line?.uom ?? '',
      type: v.type,
      disposition: v.disposition,
      status: v.status,
      quantity: quantityText(v.quantity),
      amountSatang: v.amountSatang,
      reason: v.reason,
      createdAt: v.createdAt,
      decidedAt: v.decidedAt,
    }
  }
  return {
    id: po.id,
    number: po.number,
    status: po.status,
    sentAt: po.sentAt,
    vatRateBp: po.vatRateBp,
    supplier: nameOf(po.supplier.nameTh, po.supplier.nameEn),
    site: po.deliverySite ? nameOf(po.deliverySite.nameTh, null) : null,
    requests: p.requests.map((r) => ({ id: r.id, number: r.number, title: r.title, requester: people.get(r.requesterMemberId) ?? null, department: departments.byId.get(r.requesterDepartmentId) ?? null })),
    lines: po.lines.map((l) => ({
      id: l.id,
      lineNo: l.lineNo,
      description: l.description,
      uom: l.uom,
      ordered: quantityText(l.quantity),
      received: quantityText(l.receivedQuantity),
      cancelled: quantityText(l.cancelledQuantity),
      outstanding: formatQuantity(outstandingOf(l)),
      keepPending: formatQuantity(keepPendingOf(l.id)),
      unitPriceSatang: l.unitPriceSatang,
      budgetDepartmentId: l.budgetLine.departmentId,
    })),
    receipts: receipts.map((r) => ({
      id: r.id,
      number: r.number,
      status: r.status,
      receivedAt: r.receivedAt,
      receiver: people.get(r.receiverMemberId) ?? null,
      deliveryNoteNo: r.deliveryNoteNo,
      notes: r.notes,
      reversedAt: r.reversedAt,
      reverseReason: r.reverseReason,
      lines: r.lines
        .map((g) => ({ g, line: lineById.get(g.poLineId) }))
        .sort((a, b) => (a.line?.lineNo ?? 0) - (b.line?.lineNo ?? 0))
        .map(({ g, line }) => ({
          poLineId: g.poLineId,
          description: line?.description ?? '',
          uom: line?.uom ?? '',
          received: quantityText(g.receivedQuantity),
          accepted: quantityText(g.acceptedQuantity),
          rejected: quantityText(g.rejectedQuantity),
          refused: refusedOf(r.id, g),
          remark: g.remark,
        })),
      photos: photos.filter((f) => f.subjectId === r.id).map((f) => ({ fileId: f.file.id, fileName: f.file.fileName, sizeBytes: f.file.sizeBytes })),
      variances: variances.filter((v) => v.grId === r.id).map(varianceDto),
    })),
    closeShort: variances.filter((v) => v.grId === null && v.disposition === 'CLOSE_SHORT').map(varianceDto),
    parties: p,
  }
}
