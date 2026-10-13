import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { memberRef, isUuid, type MemberRefDto } from './requests'

// The changes of a sent PO as the screens show them (S8-13, FR-AP-107 AC2 AC3, BR-POC-01 to BR-POC-05): each change
// with what it does to every line — the quantity and unit price before and after, the line's amount before and after —
// and to the PO's totals, who proposed it and when. Read only: the PO page (its tab "ใบแก้ไข"), the change page and the
// approval task of subject PO_CHANGE (web and LIFF) read these after checking who may see them.

export interface PoChangeLineDto {
  readonly poLineId: string
  readonly lineNo: number
  readonly description: string
  readonly uom: string
  readonly oldQuantity: string
  readonly newQuantity: string
  readonly oldUnitPriceSatang: bigint
  readonly newUnitPriceSatang: bigint
  readonly oldNetSatang: bigint
  readonly newNetSatang: bigint
}

export interface PoChangeTotalsDto {
  readonly netSatang: bigint
  readonly vatSatang: bigint
  readonly grossSatang: bigint
}

export interface PoChangeDto {
  readonly id: string
  readonly poId: string
  readonly changeNo: number
  readonly status: string
  /** Only the delivery date or the notes changed (BR-POC-02): approved when it is sent */
  readonly autoApproved: boolean
  readonly reason: string | null
  readonly old: PoChangeTotalsDto
  readonly new: PoChangeTotalsDto
  /** "YYYY-MM-DD" or null */
  readonly deliveryDate: string | null
  readonly notesToSupplier: string | null
  readonly quantityDisposition: string | null
  readonly createdBy: MemberRefDto
  readonly createdAt: Date
  readonly submittedAt: Date | null
  readonly decidedAt: Date | null
  readonly appliedRevisionNo: number | null
  readonly sentAt: Date | null
  readonly version: number
  readonly lines: readonly PoChangeLineDto[]
}

const PERSON = { select: { id: true, displayNameTh: true, displayNameEn: true } } as const

const CHANGE_SELECT = {
  id: true,
  poId: true,
  changeNo: true,
  status: true,
  autoApproved: true,
  reason: true,
  oldNetSatang: true,
  oldVatSatang: true,
  oldGrossSatang: true,
  newNetSatang: true,
  newVatSatang: true,
  newGrossSatang: true,
  deliveryDate: true,
  notesToSupplier: true,
  quantityDisposition: true,
  createdBy: PERSON,
  createdAt: true,
  submittedAt: true,
  decidedAt: true,
  appliedRevisionNo: true,
  sentAt: true,
  version: true,
  lines: {
    select: {
      poLineId: true,
      oldQuantity: true,
      newQuantity: true,
      oldUnitPriceSatang: true,
      newUnitPriceSatang: true,
      oldNetSatang: true,
      newNetSatang: true,
      poLine: { select: { lineNo: true, description: true, uom: true } },
    },
  },
} as const

type ChangeRow = Awaited<ReturnType<typeof loadChanges>>[number]

function loadChanges(ctx: Ctx, where: { poId: string } | { id: string }) {
  return forTenant(ctx.organizationId).poChange.findMany({ where, orderBy: { changeNo: 'desc' }, select: CHANGE_SELECT })
}

function toDto(c: ChangeRow): PoChangeDto {
  return {
    id: c.id,
    poId: c.poId,
    changeNo: c.changeNo,
    status: c.status,
    autoApproved: c.autoApproved,
    reason: c.reason,
    old: { netSatang: c.oldNetSatang, vatSatang: c.oldVatSatang, grossSatang: c.oldGrossSatang },
    new: { netSatang: c.newNetSatang, vatSatang: c.newVatSatang, grossSatang: c.newGrossSatang },
    deliveryDate: c.deliveryDate?.toISOString().slice(0, 10) ?? null,
    notesToSupplier: c.notesToSupplier,
    quantityDisposition: c.quantityDisposition,
    createdBy: memberRef(c.createdBy),
    createdAt: c.createdAt,
    submittedAt: c.submittedAt,
    decidedAt: c.decidedAt,
    appliedRevisionNo: c.appliedRevisionNo,
    sentAt: c.sentAt,
    version: c.version,
    lines: c.lines
      .map((l) => ({
        poLineId: l.poLineId,
        lineNo: l.poLine.lineNo,
        description: l.poLine.description,
        uom: l.poLine.uom,
        oldQuantity: l.oldQuantity.toString(),
        newQuantity: l.newQuantity.toString(),
        oldUnitPriceSatang: l.oldUnitPriceSatang,
        newUnitPriceSatang: l.newUnitPriceSatang,
        oldNetSatang: l.oldNetSatang,
        newNetSatang: l.newNetSatang,
      }))
      .sort((a, b) => a.lineNo - b.lineNo),
  }
}

/** Every change of the PO, the latest first */
export async function listPoChanges(ctx: Ctx, poId: string): Promise<PoChangeDto[]> {
  if (!isUuid(poId)) return []
  return (await loadChanges(ctx, { poId })).map(toDto)
}

/** One change */
export async function getPoChange(ctx: Ctx, poChangeId: string): Promise<PoChangeDto | null> {
  if (!isUuid(poChangeId)) return null
  const [row] = await loadChanges(ctx, { id: poChangeId })
  return row ? toDto(row) : null
}

export interface PoChangeTaskViewDto extends PoChangeDto {
  readonly po: { readonly id: string; readonly number: string | null; readonly revisionNo: number }
  readonly supplier: { readonly nameTh: string }
}

/**
 * What the approver of a change decides on (subject PO_CHANGE): the PO and its supplier, every changed line before and
 * after, and the PO's totals before and after. The page that shows it has already checked the task is the reader's
 * (getTaskAccess).
 */
export async function getPoChangeTaskView(ctx: Ctx, poChangeId: string): Promise<PoChangeTaskViewDto | null> {
  const change = await getPoChange(ctx, poChangeId)
  if (!change) return null
  const po = await forTenant(ctx.organizationId).purchaseOrder.findUnique({ where: { id: change.poId }, select: { id: true, number: true, revisionNo: true, supplier: { select: { nameTh: true } } } })
  if (!po) return null
  return { ...change, po: { id: po.id, number: po.number, revisionNo: po.revisionNo }, supplier: po.supplier }
}
