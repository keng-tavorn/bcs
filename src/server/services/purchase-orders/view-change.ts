import { z } from 'zod'
import { versionAt } from '@/core/doa'
import { amountToSatang } from '@/core/money/dto'
import { parseQuantity, type Satang } from '@/core/money/math'
import { changeTotals, type ChangeLine } from '@/core/po-change'
import { formatQuantity } from '@/core/receiving'
import { err, ok, type Result } from '@/core/result'
import { isAllowed, loadPrincipal, type Principal } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { loadRoutePolicy } from '@/server/doa/policy'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { listPoChanges, type PoChangeDto } from '@/server/queries/po-changes'
import { getPoAccess } from '@/server/queries/purchase-orders'
import { INVOICED_STATUSES } from '../ap/match-run'
import { requestLineBasis } from '../procurement/pool'
import { requireModule } from '../modules'

// What S8 adds to the purchase-order screens (S8-13, FR-AP-106 AC1 AC5, FR-AP-107 AC2 AC3 AC5, BR-AP-13, BR-POC-05):
// - the PO page: its tier-2 invoices, and while it is a draft the milestones of a service line and the retention —
//   only with module PAY on (BR-AP-13: hidden, the services refuse MODULE_DISABLED anyway); its changes, with the
//   button "แก้ไข PO" only when the DOA version in effect has a PO_CHANGE rule and the member holds po.change
//   (BR-POC-05: the DEMO organization sees neither), and "send the revision" while the latest approved one is unsent;
// - the change page (po.change): the PO's lines with what bounds each change (received, invoiced, what the request
//   has left), the open change if there is one, and the new totals of a change before it is drafted — computed with
//   changeTotals of src/core/po-change exactly as po_change.create checks them (the command checks again under lock),
//   so the browser never adds money up.
// Every function checks the capability itself; nothing here writes.

const CHANGEABLE_PO: readonly string[] = ['APPROVED', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED']

/** BR-POC-05: the DOA version in effect has a rule for PO_CHANGE */
async function hasChangeRule(tx: TenantTx, ctx: Ctx): Promise<boolean> {
  const version = versionAt((await loadRoutePolicy(tx)).versions, ctx.now)
  return !!version?.rules.some((r) => r.documentType === 'PO_CHANGE')
}

// ---------- the PO page ----------

export interface PoApInvoiceRowDto {
  readonly id: string
  readonly number: string | null
  readonly supplierInvoiceNo: string | null
  readonly status: string
  readonly grossSatang: bigint
  readonly payableSatang: bigint
}

export interface PoSplittableLineDto {
  readonly id: string
  readonly lineNo: number
  readonly description: string
  readonly quantity: string
  readonly uom: string
}

export interface PoS8ViewDto {
  readonly poId: string
  readonly status: string
  readonly version: number
  readonly revisionNo: number
  /** Module PAY is on (BR-AP-13) */
  readonly pay: boolean
  /** The tier-2 invoices of the PO, oldest first; null with PAY off */
  readonly invoices: readonly PoApInvoiceRowDto[] | null
  /** A draft with PAY on, to whoever edits POs (po.edit): its retention and the service lines that split into milestones */
  readonly draft: {
    readonly retentionBp: number
    readonly retentionHoldDays: number | null
    readonly splittable: readonly PoSplittableLineDto[]
  } | null
  /** The changes, latest first; null when the DOA has no PO_CHANGE rule and the PO has no change */
  readonly changes: readonly PoChangeDto[] | null
  /** "แก้ไข PO": the DOA has a PO_CHANGE rule, the member holds po.change and the PO is in a state that is changed */
  readonly canChange: boolean
  /** The revision approved last, not yet sent to the supplier, for whoever holds po.change */
  readonly revisionToSend: { readonly revisionNo: number; readonly changeNo: number } | null
}

async function canViewPo(ctx: Ctx, principal: Principal, poId: string): Promise<boolean> {
  const access = await getPoAccess(ctx, poId)
  if (!access) return false
  return isAllowed(principal, 'po.view', { ownerMemberIds: [...(access.createdById ? [access.createdById] : []), ...access.requesterMemberIds], assigneeMemberIds: access.approverMemberIds })
}

/** The parts S8 adds to /procurement/pos/[id], for whoever may see the PO (po.view) */
export async function getPoS8View(ctx: Ctx, poId: string): Promise<Result<PoS8ViewDto>> {
  const db = forTenant(ctx.organizationId)
  const facts = await db.$transaction(async (tx) => {
    const principal = await loadPrincipal(tx, ctx)
    const po = await tx.purchaseOrder.findFirst({
      where: { id: poId },
      select: { id: true, status: true, kind: true, version: true, revisionNo: true, retentionBp: true, retentionHoldDays: true, lines: { orderBy: { lineNo: 'asc' }, select: { id: true, lineNo: true, description: true, quantity: true, uom: true, milestoneNo: true, _count: { select: { sources: true } } } } },
    })
    if (!po) return null
    return { principal, po, pay: (await requireModule(ctx, 'PAY', tx)).ok, rule: await hasChangeRule(tx, ctx) }
  })
  if (!facts) return err('NOT_FOUND', 'purchase order not found')
  const { principal, po, pay, rule } = facts
  if (!(await canViewPo(ctx, principal, po.id))) return err('FORBIDDEN', 'missing capability po.view', { capability: 'po.view' })

  const [invoices, changes] = await Promise.all([
    pay
      ? db.invoice.findMany({ where: { poId: po.id }, orderBy: { createdAt: 'asc' }, select: { id: true, number: true, supplierInvoiceNo: true, status: true, grossSatang: true, payableSatang: true } })
      : Promise.resolve(null),
    listPoChanges(ctx, po.id),
  ])
  const mayChange = isAllowed(principal, 'po.change')
  const draft =
    po.status === 'DRAFT' && pay && isAllowed(principal, 'po.edit')
      ? {
          retentionBp: po.retentionBp,
          retentionHoldDays: po.retentionHoldDays,
          // BR-RET-01: a line of a service PO, not split before, ordered for one request line
          splittable:
            po.kind === 'SERVICE'
              ? po.lines
                  .filter((l) => l.milestoneNo === null && l._count.sources === 1)
                  .map((l) => ({ id: l.id, lineNo: l.lineNo, description: l.description, quantity: l.quantity.toString(), uom: l.uom }))
              : [],
        }
      : null
  const latest = changes.find((c) => c.status === 'APPROVED' && c.appliedRevisionNo === po.revisionNo)
  return ok({
    poId: po.id,
    status: po.status,
    version: po.version,
    revisionNo: po.revisionNo,
    pay,
    invoices,
    draft,
    changes: rule || changes.length > 0 ? changes : null,
    canChange: rule && mayChange && CHANGEABLE_PO.includes(po.status),
    revisionToSend: mayChange && po.revisionNo > 0 && latest && !latest.sentAt ? { revisionNo: po.revisionNo, changeNo: latest.changeNo } : null,
  })
}

// ---------- the change page ----------

export interface PoChangeFormLineDto {
  readonly id: string
  readonly lineNo: number
  readonly description: string
  readonly uom: string
  readonly quantity: string
  readonly unitPriceSatang: bigint
  readonly netSatang: bigint
  readonly received: string
  readonly invoiced: string
  /** The most the quantity may be: what it orders now and what its request line has left (null: ordered for several request lines, the quantity stays) */
  readonly maxQuantity: string | null
  /** The least the quantity may be: what was received or invoiced */
  readonly minQuantity: string
  /** The price stays: the line has an invoice (BR-POC-01) */
  readonly priceLocked: boolean
}

export interface PoChangeFormDto {
  readonly po: {
    readonly id: string
    readonly number: string | null
    readonly status: string
    readonly supplierName: string
    readonly revisionNo: number
    readonly netSatang: bigint
    readonly vatSatang: bigint
    readonly grossSatang: bigint
    readonly notesToSupplier: string | null
    /** The delivery date agreed by the last approved change that set one, "YYYY-MM-DD" */
    readonly deliveryDate: string | null
  }
  /** The PO is in a state that is changed (APPROVED, SENT, PARTIALLY_RECEIVED, RECEIVED) */
  readonly changeable: boolean
  readonly lines: readonly PoChangeFormLineDto[]
  /** The change not finished yet (DRAFT or PENDING_APPROVAL): one at a time (PO_CHANGE_OPEN) */
  readonly open: PoChangeDto | null
}

/** po.change and a PO_CHANGE rule in the DOA version in effect (BR-POC-05), as po_change.create asks */
async function changer(tx: TenantTx, ctx: Ctx): Promise<Result<Principal>> {
  const principal = await loadPrincipal(tx, ctx)
  if (!isAllowed(principal, 'po.change')) return err('FORBIDDEN', 'missing capability po.change', { capability: 'po.change' })
  if (!(await hasChangeRule(tx, ctx))) return err('DOA_NOT_CONFIGURED', 'DOA ยังไม่มีข้อสำหรับแก้ PO', { documentType: 'PO_CHANGE' })
  return ok(principal)
}

/** The PO with its lines, what each line has received and been invoiced, and the request lines they order */
async function poWithProgress(tx: TenantTx, poId: string) {
  const po = await tx.purchaseOrder.findFirst({
    where: { id: poId },
    include: { supplier: { select: { nameTh: true } }, lines: { orderBy: { lineNo: 'asc' }, include: { sources: true } } },
  })
  if (!po) return null
  const invoiced = await tx.invoiceLine.groupBy({ by: ['poLineId'], where: { poLineId: { in: po.lines.map((l) => l.id) }, invoice: { status: { in: [...INVOICED_STATUSES] } } }, _sum: { quantity: true } })
  const basis = await requestLineBasis(tx, po.lines.flatMap((l) => l.sources.map((s) => s.requestLineId)))
  const invoicedOf = (poLineId: string) => parseQuantity((invoiced.find((i) => i.poLineId === poLineId)?._sum.quantity ?? 0).toString())
  // what is left of the request line beyond what every PO orders now (as po_change.create reads it)
  const leftOf = (line: (typeof po.lines)[number]): bigint => {
    const source = line.sources[0]
    const b = source ? basis.get(source.requestLineId) : undefined
    if (!b) return 0n
    const ordering = [...b.ordering].reduce((s, [, q]) => s + q, 0n)
    const left = b.quantity - b.cancelled - ordering
    return left > 0n ? left : 0n
  }
  return { po, invoicedOf, leftOf }
}

/** /procurement/pos/[id]/change: the PO's lines and bounds, and its open change */
export async function getPoChangeForm(ctx: Ctx, poId: string): Promise<Result<PoChangeFormDto>> {
  const db = forTenant(ctx.organizationId)
  const read = await db.$transaction(async (tx) => {
    const who = await changer(tx, ctx)
    if (!who.ok) return who
    const found = await poWithProgress(tx, poId)
    if (!found) return err('NOT_FOUND', 'purchase order not found')
    const agreed = await tx.poChange.findFirst({ where: { poId, status: 'APPROVED', deliveryDate: { not: null } }, orderBy: { changeNo: 'desc' }, select: { deliveryDate: true } })
    return ok({ ...found, agreed: agreed?.deliveryDate?.toISOString().slice(0, 10) ?? null })
  })
  if (!read.ok) return read
  const { po, invoicedOf, leftOf, agreed } = read.data
  const changes = await listPoChanges(ctx, po.id)
  const lines = po.lines.map((l) => {
    const ordered = parseQuantity(l.quantity.toString())
    const received = parseQuantity(l.receivedQuantity.toString())
    const invoiced = invoicedOf(l.id)
    return {
      id: l.id,
      lineNo: l.lineNo,
      description: l.description,
      uom: l.uom,
      quantity: formatQuantity(ordered),
      unitPriceSatang: l.unitPriceSatang,
      netSatang: l.netSatang,
      received: formatQuantity(received),
      invoiced: formatQuantity(invoiced),
      maxQuantity: l.sources.length === 1 ? formatQuantity(ordered + leftOf(l)) : null,
      minQuantity: formatQuantity(received > invoiced ? received : invoiced),
      priceLocked: invoiced > 0n,
    }
  })
  return ok({
    po: {
      id: po.id,
      number: po.number,
      status: po.status,
      supplierName: po.supplier.nameTh,
      revisionNo: po.revisionNo,
      netSatang: po.netSatang,
      vatSatang: po.vatSatang,
      grossSatang: po.grossSatang,
      notesToSupplier: po.notesToSupplier,
      deliveryDate: agreed,
    },
    changeable: CHANGEABLE_PO.includes(po.status),
    lines,
    open: changes.find((c) => c.status === 'DRAFT' || c.status === 'PENDING_APPROVAL') ?? null,
  })
}

const PreviewInput = z.strictObject({
  poId: z.uuid(),
  lines: z
    .array(
      z.strictObject({
        poLineId: z.uuid(),
        newQuantity: z.string().trim().regex(/^\d{1,14}(\.\d{1,4})?$/).optional(),
        newUnitPrice: z.string().trim().regex(/^\d{1,13}(\.\d{1,2})?$/).optional(),
      }),
    )
    .max(200),
})

export interface PoChangePreviewDto {
  readonly old: { readonly netSatang: Satang; readonly vatSatang: Satang; readonly grossSatang: Satang }
  readonly new: { readonly netSatang: Satang; readonly vatSatang: Satang; readonly grossSatang: Satang }
}

/**
 * The PO's totals after the change (BR-POC-02: documentTotals at the PO's rate through changeTotals), or why
 * po_change.create would refuse it: PO_CHANGE_BELOW_PROGRESS (reason RECEIVED, INVOICED, LINE_INVOICED),
 * PO_CHANGE_EXCEEDS_REQUEST (left), VALIDATION_FAILED MERGED_LINE — with the number of the line
 */
export async function previewPoChange(ctx: Ctx, input: z.input<typeof PreviewInput>): Promise<Result<PoChangePreviewDto>> {
  const parsed = PreviewInput.safeParse(input)
  if (!parsed.success) return err('VALIDATION_FAILED', 'invalid input', { field: String(parsed.error.issues[0]?.path[0] ?? 'input') })
  const { poId } = parsed.data
  return forTenant(ctx.organizationId).$transaction(async (tx): Promise<Result<PoChangePreviewDto>> => {
    const who = await changer(tx, ctx)
    if (!who.ok) return who
    const found = await poWithProgress(tx, poId)
    if (!found) return err('NOT_FOUND', 'purchase order not found')
    const { po, invoicedOf, leftOf } = found
    const lines: ChangeLine[] = []
    for (const l of po.lines) {
      const c = parsed.data.lines.find((x) => x.poLineId === l.id)
      const ordered = parseQuantity(l.quantity.toString())
      const newQty = c?.newQuantity !== undefined ? parseQuantity(c.newQuantity) : ordered
      const newPrice = c?.newUnitPrice !== undefined ? amountToSatang(c.newUnitPrice) : l.unitPriceSatang
      if (newQty <= 0n) return err('VALIDATION_FAILED', 'a quantity above zero is needed', { field: 'lines', reason: 'QUANTITY', lineNo: l.lineNo })
      if (newQty !== ordered && l.sources.length !== 1) return err('VALIDATION_FAILED', 'the quantity of a line ordered for several request lines does not change', { field: 'lines', reason: 'MERGED_LINE', lineNo: l.lineNo })
      lines.push({
        ordered: formatQuantity(ordered),
        received: l.receivedQuantity.toString(),
        invoiced: formatQuantity(invoicedOf(l.id)),
        requestLeft: formatQuantity(leftOf(l)),
        unitPriceSatang: l.unitPriceSatang,
        vatable: l.vatable,
        ...(newQty !== ordered || newPrice !== l.unitPriceSatang ? { change: { newQty: formatQuantity(newQty), newUnitPriceSatang: newPrice } } : {}),
      })
    }
    const totals = changeTotals(lines, po.vatRateBp ?? 0)
    if (!totals.ok) {
      const lineNo = po.lines[totals.line - 1]!.lineNo
      return totals.code === 'PO_CHANGE_EXCEEDS_REQUEST'
        ? err('PO_CHANGE_EXCEEDS_REQUEST', 'more than is left of the request line', { left: totals.left, lineNo })
        : err('PO_CHANGE_BELOW_PROGRESS', 'below what was received or invoiced', { reason: totals.reason, lineNo })
    }
    return ok({ old: { netSatang: po.netSatang, vatSatang: po.vatSatang, grossSatang: po.grossSatang }, new: { netSatang: totals.netSatang, vatSatang: totals.vatSatang, grossSatang: totals.grossSatang } })
  })
}
