import { z } from 'zod'
import { amountToSatang } from '@/core/money/dto'
import { documentTotals, lineNet, parseQuantity, type Satang } from '@/core/money/math'
import { formatQuantity } from '@/core/receiving'
import { err, ok, type Result } from '@/core/result'
import { PO_MACHINE, transition, type PoState } from '@/core/state-machines'
import { rateFor, taxDateOf } from '@/core/vat'
import { PAYMENT_TERM_MAX_DAYS, PO_NOTE_MAX_LENGTH, REASON_MAX_LENGTH } from '@/lib/constants'
import { newId } from '@/lib/ids'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { listTaxRates } from '@/server/db/lookups'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import { itemKey, priceHistoryOf } from '@/server/queries/purchase-orders'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { startRoute } from '../approvals/route'
import { issueDocumentNumber } from '../numbering'
import { releasableFor, requestLineBasis } from '../procurement/pool'
import { budgetRefusalFor, poBudgetLines, releaseCancelledPo, reserveForPo } from './budget'
import { unmergeableLine } from '../budget/overrun-use'
import { issueDocumentVerification } from '../documents/verification'
import { completeFinishedRequests, unorderSourceLines } from './requests'
import { hasOpenChange } from './close'

export { closePurchaseOrder } from './close'
export { previewPoSubmit, type PoRoutePreviewDto, type PoSubmitPreviewDto } from './preview'

// Purchase orders, tier 1 (spec §6.4 PO table, FR-P2P-003, FR-P2P-004, FR-P2P-010 AC1, BR-BUD-05, BR-BUD-06): PROCUREMENT
// edits a draft — prices, quantities up to what is left of the request lines, payment terms and notes — and the
// totals come from core/money only (AC3); a draft is sent for approval on the DOA rule of PURCHASE_ORDER with its
// number, today's VAT rate and the budget delta reserved, or nothing at all; an approved PO is cancelled with a
// disposition for its request lines and a reason. Every PO line comes from request lines (OQ-24).

type FailCode = 'VALIDATION_FAILED' | 'NOT_FOUND' | 'CONFLICT_VERSION' | 'INVALID_STATE_TRANSITION' | 'TAX_RATE_NOT_CONFIGURED' | 'PO_CHANGE_OPEN'
const fail = (code: FailCode, message: string, details?: Record<string, unknown>) => ({ ok: false, error: { code, message, ...(details ? { details } : {}) } }) as const

const MIN_REASON_LENGTH = 3
const Quantity = z.string().trim().regex(/^\d{1,14}(\.\d{1,4})?$/)
const Amount = z.string().trim().regex(/^\d{1,13}(\.\d{1,2})?$/)
const scaled = (d: { toString(): string }) => parseQuantity(d.toString())

async function lockedPo(tx: TenantTx, ctx: Ctx, poId: string) {
  const [locked] = await lockRowsForUpdate(tx, 'PurchaseOrder', ctx.organizationId, [poId])
  if (!locked) return null
  return tx.purchaseOrder.findUniqueOrThrow({ where: { id: poId }, include: { lines: { orderBy: { lineNo: 'asc' }, include: { sources: true } } } })
}

type LoadedPo = NonNullable<Awaited<ReturnType<typeof lockedPo>>>

/** The requests whose lines a PO orders, locked in id order before anything of theirs changes (INV-PLT-03) */
async function lockSourceRequests(tx: TenantTx, ctx: Ctx, po: LoadedPo): Promise<string[]> {
  const lineIds = po.lines.flatMap((l) => l.sources.map((s) => s.requestLineId))
  const lines = await tx.requestLine.findMany({ where: { id: { in: lineIds } }, select: { requestId: true } })
  return lockRowsForUpdate(
    tx,
    'Request',
    ctx.organizationId,
    lines.map((l) => l.requestId),
  )
}

/** Totals from core (BR-VAT-02, FR-P2P-003 AC3): VAT once on the VAT-able lines, prices before VAT */
function totalsOf(lines: ReadonlyArray<{ quantity: string; unitPriceSatang: Satang; vatable: boolean }>, rateBp: number) {
  return documentTotals(lines, rateBp, false)
}

// ---------- edit a draft (FR-P2P-003 AC2, AC3) ----------

const EditInput = z.strictObject({
  poId: z.uuid(),
  expectedVersion: z.number().int().min(0),
  lines: z.array(z.strictObject({ poLineId: z.uuid(), quantity: Quantity.optional(), unitPrice: Amount.optional() })).max(200).default([]),
  /** Lines that go back to the pool */
  removeLineIds: z.array(z.uuid()).max(200).default([]),
  paymentTermDays: z.number().int().min(0).max(PAYMENT_TERM_MAX_DAYS).nullable().optional(),
  notesToSupplier: z.string().trim().max(PO_NOTE_MAX_LENGTH).nullable().optional(),
})

export const editDraftCommand = defineCommand({
  name: 'po.edit',
  capability: 'po.edit',
  input: EditInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ poId: string; version: number }>> {
    const allowed = await authorize(tx, ctx, 'po.edit')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    const po = await lockedPo(tx, ctx, input.poId)
    if (!po) return fail('NOT_FOUND', 'purchase order not found')
    if (po.status !== 'DRAFT') return fail('INVALID_STATE_TRANSITION', 'only a draft is edited', { from: po.status, command: 'po.edit' })
    if (po.version !== input.expectedVersion) return fail('CONFLICT_VERSION', 'the purchase order changed since it was opened', { currentVersion: po.version })
    await lockSourceRequests(tx, ctx, po)

    const changed = new Set<string>()
    const removing = new Set(input.removeLineIds)
    for (const id of removing) if (!po.lines.some((l) => l.id === id)) return fail('VALIDATION_FAILED', 'the line is not on this purchase order', { field: 'removeLineIds', reason: 'LINE' })
    const kept = po.lines.filter((l) => !removing.has(l.id))
    if (kept.length === 0) return fail('VALIDATION_FAILED', 'a purchase order keeps at least one line', { field: 'removeLineIds', reason: 'NO_LINES' })
    const basis = await requestLineBasis(
      tx,
      po.lines.flatMap((l) => l.sources.map((s) => s.requestLineId)),
    )
    const next = new Map(kept.map((l) => [l.id, { quantity: l.quantity.toString(), unitPriceSatang: l.unitPriceSatang }]))
    for (const [i, edit] of input.lines.entries()) {
      const line = kept.find((l) => l.id === edit.poLineId)
      if (!line) return fail('VALIDATION_FAILED', 'the line is not on this purchase order', { field: `lines.${i}.poLineId`, reason: 'LINE' })
      const target = next.get(line.id)!
      if (edit.unitPrice !== undefined) target.unitPriceSatang = amountToSatang(edit.unitPrice)
      if (edit.quantity !== undefined) {
        const quantity = parseQuantity(edit.quantity)
        if (quantity <= 0n) return fail('VALIDATION_FAILED', 'a quantity above zero is needed', { field: `lines.${i}.quantity`, reason: 'QUANTITY' })
        // A merged line orders several request lines: its quantity changes by splitting it, not here (BR-CONS-04)
        if (line.sources.length !== 1) return fail('VALIDATION_FAILED', 'the quantity of a merged line cannot change', { field: `lines.${i}.quantity`, reason: 'MERGED_LINE' })
        const source = line.sources[0]!
        const b = basis.get(source.requestLineId)!
        const elsewhere = [...b.ordering].filter(([id]) => id !== source.id).reduce((sum, [, q]) => sum + q, 0n)
        const left = b.quantity - b.cancelled - elsewhere
        if (quantity > left) return fail('VALIDATION_FAILED', 'more than is left of the request line', { field: `lines.${i}.quantity`, reason: 'QUANTITY_OVER_REQUEST', left: formatQuantity(left) })
        target.quantity = formatQuantity(quantity)
      }
    }

    // Removed lines go back to the pool with their sources
    if (removing.size) {
      await tx.poLineSource.deleteMany({ where: { poLineId: { in: [...removing] } } })
      await tx.poLine.deleteMany({ where: { id: { in: [...removing] } } })
      changed.add('lines.removed')
    }
    for (const [index, line] of kept.entries()) {
      const target = next.get(line.id)!
      const net = lineNet(target.quantity, target.unitPriceSatang)
      const quantityChanged = scaled(line.quantity) !== parseQuantity(target.quantity)
      if (quantityChanged) changed.add('lines.quantity')
      if (target.unitPriceSatang !== line.unitPriceSatang) changed.add('lines.unitPrice')
      // Line numbers stay 1, 2, 3 … after a removal (ascending, so a number is free before it is taken)
      if (quantityChanged || target.unitPriceSatang !== line.unitPriceSatang || line.lineNo !== index + 1) {
        await tx.poLine.update({ where: { id: line.id }, data: { quantity: target.quantity, unitPriceSatang: target.unitPriceSatang, netSatang: net, lineNo: index + 1 } })
      }
      if (quantityChanged) {
        const source = line.sources[0]!
        await tx.poLineSource.update({ where: { id: source.id }, data: { quantity: target.quantity, releasableSatang: releasableFor(basis.get(source.requestLineId)!, parseQuantity(target.quantity)) } })
      }
    }
    if (input.paymentTermDays !== undefined && input.paymentTermDays !== po.paymentTermDays) changed.add('paymentTermDays')
    if (input.notesToSupplier !== undefined && (input.notesToSupplier || null) !== po.notesToSupplier) changed.add('notesToSupplier')
    if (changed.size === 0) return fail('VALIDATION_FAILED', 'nothing to change', { reason: 'NO_CHANGE' })

    const totals = totalsOf(
      kept.map((l) => ({ ...next.get(l.id)!, vatable: l.vatable })),
      po.vatRateBp ?? 0,
    )
    const saved = await tx.purchaseOrder.updateMany({
      where: { id: po.id, version: po.version },
      data: {
        netSatang: totals.net,
        vatSatang: totals.vat,
        grossSatang: totals.gross,
        ...(input.paymentTermDays !== undefined ? { paymentTermDays: input.paymentTermDays } : {}),
        ...(input.notesToSupplier !== undefined ? { notesToSupplier: input.notesToSupplier || null } : {}),
        version: { increment: 1 },
      },
    })
    if (saved.count !== 1) return fail('CONFLICT_VERSION', 'the purchase order changed since it was opened')
    return {
      ok: true,
      result: { poId: po.id, version: po.version + 1 },
      events: [{ type: 'po.updated', aggregateType: 'PurchaseOrder', aggregateId: po.id, data: { changed: [...changed], lineCount: kept.length, netSatang: totals.net.toString() } }],
    }
  },
})

export function editDraftPo(ctx: Ctx, input: z.input<typeof EditInput>, options: RunOptions) {
  return runCommand(ctx, editDraftCommand, input, options)
}

// ---------- send for approval (FR-P2P-004, BR-BUD-05) ----------

const SubmitInput = z.strictObject({ poId: z.uuid() })

export const submitPoCommand = defineCommand({
  name: 'po.submit',
  capability: 'po.submit',
  input: SubmitInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ number: string; routeId: string; assigneeMemberId: string }>> {
    const allowed = await authorize(tx, ctx, 'po.submit')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    const actor = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
    if (!actor) return { ok: false, error: { code: 'FORBIDDEN', message: 'only a member sends a purchase order' } }
    const po = await lockedPo(tx, ctx, input.poId)
    if (!po) return fail('NOT_FOUND', 'purchase order not found')
    const moved = transition(PO_MACHINE, po.status as PoState, 'po.submit')
    if (!moved.ok) return fail('INVALID_STATE_TRANSITION', `po.submit is not allowed from ${po.status}`, { from: po.status, command: 'po.submit' })
    await lockSourceRequests(tx, ctx, po)

    // §6.4: an active supplier, lines that all come from requests (OQ-24), and a VAT rate for the tax date
    const supplier = await tx.supplier.findUniqueOrThrow({ where: { id: po.supplierId }, select: { status: true } })
    if (supplier.status !== 'ACTIVE') return fail('VALIDATION_FAILED', 'the supplier is inactive', { field: 'supplierId', reason: 'SUPPLIER_INACTIVE' })
    if (po.lines.length === 0 || po.lines.some((l) => l.sources.length === 0)) return fail('VALIDATION_FAILED', 'every line needs its source request line', { field: 'lines', reason: 'NO_SOURCE_REQUEST' })
    // BR-BUD-18 (S6-16): a request with an over-budget amount outstanding never shares a PO line with another request line
    const unmergeable = await unmergeableLine(tx, po.lines)
    if (unmergeable !== null) return fail('VALIDATION_FAILED', 'the line orders a request whose over-budget amount is outstanding together with other lines', { field: `lines.${unmergeable}`, reason: 'OVERRUN_LINE_NOT_MERGEABLE' })
    const taxDate = taxDateOf(ctx.now)
    const rate = rateFor(taxDate, await listTaxRates())
    if (!rate.ok) return fail('TAX_RATE_NOT_CONFIGURED', 'no VAT rate covers the tax date', { date: taxDate })
    const totals = totalsOf(
      po.lines.map((l) => ({ quantity: l.quantity.toString(), unitPriceSatang: l.unitPriceSatang, vatable: l.vatable })),
      rate.rateBp,
    )

    // The drafter of a consolidation round is the system: whoever sends it owns it, for BR-SOD-03
    const creator = po.createdById ?? actor
    const sourceRequests = await tx.request.findMany({ where: { lines: { some: { poSources: { some: { poLine: { poId: po.id } } } } } }, select: { requesterMemberId: true } })
    const requesters = [...new Set(sourceRequests.map((r) => r.requesterMemberId))]
    // A PO returned for changes keeps the number it was given (BR-NUM-01: a number is never used twice)
    const number = po.number ?? (await issueDocumentNumber(tx, ctx, { document: 'PO' }))

    const budgetLines = await poBudgetLines(tx, po.id)
    const budget = await reserveForPo(tx, ctx, po.id, budgetLines)
    // How much is missing is told only to whoever may view the budget line (§2.4 budget.view)
    if (!budget.ok)
      return {
        ok: false,
        error: await budgetRefusalFor(
          tx,
          allowed.data,
          budget.error,
          budgetLines.map((l) => l.budgetLineId),
        ),
      }
    const chargedDepartmentId = (await tx.budgetLine.findUniqueOrThrow({ where: { id: po.lines[0]!.budgetLineId }, select: { departmentId: true } })).departmentId
    const route = await startRoute(
      tx,
      ctx,
      { type: 'PURCHASE_ORDER', id: po.id, label: number, number },
      {
        documentType: 'PURCHASE_ORDER',
        amount: { netSatang: totals.net, vatSatang: totals.vat },
        requesterMemberId: creator,
        chargedDepartmentId,
        // BR-SOD-01, BR-SOD-03: neither the requesters of its PRs nor its creator approve it
        conflictMemberIds: [...new Set([creator, ...requesters])],
        at: ctx.now,
      },
    )
    if (!route.ok) return { ok: false, error: route.error }
    await tx.purchaseOrder.update({
      where: { id: po.id },
      data: {
        status: moved.to,
        number,
        netSatang: totals.net,
        vatSatang: totals.vat,
        grossSatang: totals.gross,
        vatRateBp: rate.rateBp,
        taxPointDate: new Date(`${taxDate}T00:00:00Z`),
        createdById: creator,
        submittedAt: ctx.now,
        currentRouteId: route.data.routeId,
        version: { increment: 1 },
      },
    })
    // S6-19 (BR-QR-01): the QR of the printed PO names this content; a resend of the same content keeps its QR
    const verification = await issueDocumentVerification(tx, ctx, { subjectType: 'PURCHASE_ORDER', subjectId: po.id })
    const events: EventDraft[] = [
      ...verification.events,
      {
        type: 'po.submitted',
        aggregateType: 'PurchaseOrder',
        aggregateId: po.id,
        data: {
          number,
          netSatang: totals.net.toString(),
          vatSatang: totals.vat.toString(),
          grossSatang: totals.gross.toString(),
          vatRateBp: rate.rateBp,
          routeId: route.data.routeId,
          doaVersionId: route.data.route.doaVersionId,
          doaRuleCode: route.data.route.ruleCode,
          escalatedFromRuleCode: route.data.route.escalatedFromRuleCode,
        },
      },
      ...budget.events,
      ...route.data.events,
    ]
    return { ok: true, result: { number, routeId: route.data.routeId, assigneeMemberId: route.data.firstTask.assigneeMemberId }, events, notifications: route.data.notifications }
  },
})

export function submitPo(ctx: Ctx, input: z.input<typeof SubmitInput>, options: RunOptions) {
  return runCommand(ctx, submitPoCommand, input, options)
}

// ---------- cancel an approved PO (FR-P2P-010 AC1, BR-BUD-06) ----------

const CancelInput = z.strictObject({
  poId: z.uuid(),
  disposition: z.enum(['RETURN_TO_POOL', 'CANCEL_REQUEST_LINES']),
  reason: z.string().trim().min(MIN_REASON_LENGTH).max(REASON_MAX_LENGTH),
})

export const cancelPoCommand = defineCommand({
  name: 'po.cancel',
  capability: 'po.cancel',
  input: CancelInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ poId: string; status: string }>> {
    const allowed = await authorize(tx, ctx, 'po.cancel')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    const po = await lockedPo(tx, ctx, input.poId)
    if (!po) return fail('NOT_FOUND', 'purchase order not found')
    const moved = transition(PO_MACHINE, po.status as PoState, 'po.cancel')
    if (!moved.ok) return fail('INVALID_STATE_TRANSITION', `po.cancel is not allowed from ${po.status}`, { from: po.status, command: 'po.cancel' })
    if (await hasOpenChange(tx, po.id)) return fail('PO_CHANGE_OPEN', 'the purchase order has a change that is not finished')
    // §6.4: nothing received yet
    if (await tx.goodsReceipt.count({ where: { poId: po.id, status: 'POSTED' } })) return fail('INVALID_STATE_TRANSITION', 'goods were received on this purchase order', { from: po.status, command: 'po.cancel', reason: 'GR_POSTED' })
    const requestIds = await lockSourceRequests(tx, ctx, po)
    const budgetLines = await poBudgetLines(tx, po.id)
    const budget = await releaseCancelledPo(tx, ctx, po.id, budgetLines, input.disposition)
    // RETURN_TO_POOL reserves for the requests again: how much is missing only for whoever may view the budget line
    if (!budget.ok)
      return {
        ok: false,
        error: await budgetRefusalFor(
          tx,
          allowed.data,
          budget.error,
          budgetLines.map((l) => l.budgetLineId),
        ),
      }
    const requests = await unorderSourceLines(tx, po.id, input.disposition)
    await tx.purchaseOrder.update({ where: { id: po.id }, data: { status: moved.to, cancelledAt: ctx.now, cancelReason: input.reason, cancelDisposition: input.disposition, version: { increment: 1 } } })
    const completed = await completeFinishedRequests(tx, requestIds)
    const reasonCommentId = newId()
    await tx.comment.create({ data: { id: reasonCommentId, organizationId: ctx.organizationId, subjectType: 'PurchaseOrder', subjectId: po.id, authorMemberId: ctx.actor.type === 'USER' ? ctx.actor.memberId : null, body: input.reason } })
    const statuses = new Map([...requests, ...completed].map((r) => [r.requestId, r.status]))
    return {
      ok: true,
      result: { poId: po.id, status: moved.to },
      events: [
        { type: 'po.cancelled', aggregateType: 'PurchaseOrder', aggregateId: po.id, data: { from: po.status, disposition: input.disposition, reasonCommentId, requests: [...statuses].map(([requestId, status]) => ({ requestId, status })) } },
        ...budget.events,
        ...completed.map((c): EventDraft => ({ type: 'request.completed', aggregateType: 'Request', aggregateId: c.requestId, data: { purchaseOrderIds: c.purchaseOrderIds } })),
      ],
    }
  },
})

export function cancelPurchaseOrder(ctx: Ctx, input: z.input<typeof CancelInput>, options: RunOptions) {
  return runCommand(ctx, cancelPoCommand, input, options)
}

// ---------- price history (FR-P2P-003 AC1) ----------

export interface PriceHistoryDto {
  readonly poLineId: string
  /** The last three unit prices of the same item on approved POs, newest first */
  readonly previous: ReadonlyArray<{ readonly poNumber: string; readonly approvedAt: string; readonly unitPriceSatang: Satang }>
  /** The new price is above the last one by more than settings.priceAlertPct */
  readonly alert: boolean
}

/** "the same item": the category and the description with spaces collapsed and case folded */
export { itemKey }

/**
 * The price history of a draft for PROCUREMENT (po.edit). The reading itself is the query priceHistoryOf, which the
 * decision page of a PO task also uses for its approver (the page checks the task's deciders first).
 */
export async function priceHistory(ctx: Ctx, poId: string): Promise<Result<PriceHistoryDto[]>> {
  const db = forTenant(ctx.organizationId)
  const allowed = await db.$transaction((tx) => authorize(tx, ctx, 'po.edit'))
  if (!allowed.ok) return err(allowed.error.code, allowed.error.message, allowed.error.details)
  const history = await priceHistoryOf(db, ctx.organizationId, poId)
  if (!history) return err('NOT_FOUND', 'purchase order not found')
  return ok(
    history.lines.map((line) => ({
      poLineId: line.poLineId,
      previous: line.previous.map((p) => ({ poNumber: p.poNumber, approvedAt: p.approvedAt.toISOString(), unitPriceSatang: p.unitPriceSatang })),
      alert: line.alert,
    })),
  )
}
