import { createHash } from 'node:crypto'
import { z } from 'zod'
import { versionAt } from '@/core/doa'
import { amountToSatang } from '@/core/money/dto'
import { formatSatang } from '@/core/money/format'
import { lineNet, parseQuantity, type Satang } from '@/core/money/math'
import { approveChange, changeTotals, rejectChange, submitChange, type ChangeLine } from '@/core/po-change'
import { formatQuantity } from '@/core/receiving'
import { PO_CHANGE_MACHINE, transition, type PoChangeState } from '@/core/state-machines'
import { PO_NOTE_MAX_LENGTH, REASON_MAX_LENGTH } from '@/lib/constants'
import { newId } from '@/lib/ids'
import { EmailSendError, getEmailProvider } from '@/integrations/email-provider'
import { putObject } from '@/integrations/storage'
import { authorize } from '@/server/authz'
import { applyBudget, type BudgetOperation } from '@/server/budget/ledger'
import type { Ctx } from '@/server/context'
import { loadRoutePolicy } from '@/server/doa/policy'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import type { TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import { poEmail } from '@/server/notifications/templates/po-email'
import { printablePurchaseOrder } from '@/server/pdf/printable'
import { renderPdf } from '@/server/pdf/render'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { closeRoute, startRoute } from '../approvals/route'
import type { SubjectDecided, SubjectDecision } from '../approvals/subjects'
import { fail, type Fail } from '../ap/common'
import { INVOICED_STATUSES } from '../ap/match-run'
import { releasableFor, requestLineBasis } from '../procurement/pool'
import { reorderSourceLine } from './requests'

// Changes to a sent PO (ADR-125, BR-POC-01 to BR-POC-05, OQ-126, FR-AP-107), in module CORE: PROCUREMENT drafts a change
// of prices, quantities (never below what was received or invoiced, never above what is left of the request line,
// not on a line ordered for several request lines), the delivery date or the notes; one change is open per PO. A
// change of only the date or the notes is approved when it is sent (no task, no budget move). A price or quantity
// change reserves what an increase needs (BUDGET_INSUFFICIENT) and goes to DOA PO_CHANGE with the PO's new totals;
// without a PO_CHANGE rule in the DOA in effect nothing is drafted or sent (DOA_NOT_CONFIGURED). The last approval
// (the adapter of ../approvals/subjects/po-change.ts) checks the progress again under the PO's lock, then changes the
// PO lines, their sources and the PO's totals, holds or gives back the difference, and the PO is a new revision
// whose PDF PROCUREMENT sends with po.sendRevision. The budget moves come from src/core/po-change only.

const CHANGEABLE_PO = ['APPROVED', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED'] as const
const PDF_MIME = 'application/pdf'
// TODO(OQ-126): a quantity taken off a PO goes back to the request's pool unless PROCUREMENT says otherwise
const DEFAULT_DISPOSITION = 'RETURN_TO_POOL' as const


async function changeGuard(tx: TenantTx, ctx: Ctx): Promise<{ ok: true; memberId: string } | Fail> {
  const allowed = await authorize(tx, ctx, 'po.change')
  if (!allowed.ok) return { ok: false, error: allowed.error }
  if (allowed.data.kind !== 'member') return fail('FORBIDDEN', 'members only')
  // BR-POC-05: the DOA in effect must have a rule for PO_CHANGE
  const policy = await loadRoutePolicy(tx)
  const version = versionAt(policy.versions, ctx.now)
  if (!version?.rules.some((r) => r.documentType === 'PO_CHANGE')) return fail('DOA_NOT_CONFIGURED', 'DOA ยังไม่มีข้อสำหรับแก้ PO', { documentType: 'PO_CHANGE' })
  return { ok: true, memberId: allowed.data.memberId }
}

/** The PO locked with its lines, sources and what each line has received and been invoiced */
async function lockedPo(tx: TenantTx, ctx: Ctx, poId: string) {
  const [id] = await lockRowsForUpdate(tx, 'PurchaseOrder', ctx.organizationId, [poId])
  if (!id) return null
  const po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id }, include: { lines: { orderBy: { lineNo: 'asc' }, include: { sources: true } } } })
  const invoiced = await tx.invoiceLine.groupBy({ by: ['poLineId'], where: { poLineId: { in: po.lines.map((l) => l.id) }, invoice: { status: { in: [...INVOICED_STATUSES] } } }, _sum: { quantity: true } })
  const basis = await requestLineBasis(tx, po.lines.flatMap((l) => l.sources.map((s) => s.requestLineId)))
  return { po, invoicedOf: (poLineId: string) => parseQuantity((invoiced.find((i) => i.poLineId === poLineId)?._sum.quantity ?? 0).toString()), basis }
}
type Locked = NonNullable<Awaited<ReturnType<typeof lockedPo>>>

const LineChange = z.strictObject({
  poLineId: z.uuid(),
  newQuantity: z.string().trim().regex(/^\d{1,14}(\.\d{1,4})?$/).optional(),
  newUnitPrice: z.string().trim().regex(/^\d{1,13}(\.\d{1,2})?$/).optional(),
})

/** BR-POC-01 against the PO as it is now: the new lines and totals, or the refusal */
function checkChange(locked: Locked, changes: ReadonlyArray<{ poLineId: string; newQuantity: bigint; newUnitPriceSatang: Satang }>) {
  const { po } = locked
  const lines: ChangeLine[] = []
  for (const l of po.lines) {
    const c = changes.find((x) => x.poLineId === l.id)
    const ordered = parseQuantity(l.quantity.toString())
    const quantityChanged = c ? c.newQuantity !== ordered : false
    if (quantityChanged && l.sources.length !== 1) return fail('VALIDATION_FAILED', 'the quantity of a line ordered for several request lines does not change', { field: 'lines', reason: 'MERGED_LINE', poLineId: l.id })
    // what is left of the request line beyond what every PO orders now
    const source = l.sources[0]
    const b = source ? locked.basis.get(source.requestLineId) : undefined
    const ordering = b ? [...b.ordering].reduce((s, [, q]) => s + q, 0n) : 0n
    const left = b ? b.quantity - b.cancelled - ordering : 0n
    lines.push({
      ordered: formatQuantity(ordered),
      received: l.receivedQuantity.toString(),
      invoiced: formatQuantity(locked.invoicedOf(l.id)),
      requestLeft: formatQuantity(left > 0n ? left : 0n),
      unitPriceSatang: l.unitPriceSatang,
      vatable: l.vatable,
      ...(c ? { change: { newQty: formatQuantity(c.newQuantity), newUnitPriceSatang: c.newUnitPriceSatang } } : {}),
    })
  }
  const totals = changeTotals(lines, po.vatRateBp ?? 0)
  if (!totals.ok) {
    const poLineId = po.lines[totals.line - 1]!.id
    return totals.code === 'PO_CHANGE_EXCEEDS_REQUEST'
      ? fail('PO_CHANGE_EXCEEDS_REQUEST', 'more than is left of the request line', { left: totals.left, poLineId })
      : fail('PO_CHANGE_BELOW_PROGRESS', 'below what was received or invoiced', { reason: totals.reason, poLineId })
  }
  return { ok: true as const, totals }
}

// ---------- po_change.create ----------

const CreateInput = z.strictObject({
  poId: z.uuid(),
  reason: z.string().trim().min(1).max(REASON_MAX_LENGTH),
  lines: z.array(LineChange).max(200).default([]),
  deliveryDate: z.iso.date().nullable().optional(),
  notesToSupplier: z.string().trim().max(PO_NOTE_MAX_LENGTH).nullable().optional(),
  /** A quantity taken off: back to the pool (default) or cancelled on the request */
  quantityDisposition: z.enum(['RETURN_TO_POOL', 'CANCEL_REQUEST_LINES']).optional(),
})

export const createPoChangeCommand = defineCommand({
  name: 'po_change.create',
  capability: 'po.change',
  input: CreateInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ poChangeId: string; changeNo: number; autoApproved: boolean }>> {
    const who = await changeGuard(tx, ctx)
    if (!who.ok) return who
    const locked = await lockedPo(tx, ctx, input.poId)
    if (!locked) return fail('NOT_FOUND', 'purchase order not found')
    const { po } = locked
    if (!(CHANGEABLE_PO as readonly string[]).includes(po.status)) return fail('INVALID_STATE_TRANSITION', `a ${po.status} purchase order is not changed`, { from: po.status, command: 'po_change.create' })
    if (await tx.poChange.count({ where: { poId: po.id, status: { in: ['DRAFT', 'PENDING_APPROVAL'] } } })) return fail('PO_CHANGE_OPEN', 'the purchase order has a change that is not finished')
    const ids = input.lines.map((l) => l.poLineId)
    if (new Set(ids).size !== ids.length) return fail('VALIDATION_FAILED', 'a line appears twice', { field: 'lines', reason: 'LINE_TWICE' })
    const changes = []
    for (const c of input.lines) {
      const line = po.lines.find((l) => l.id === c.poLineId)
      if (!line) return fail('VALIDATION_FAILED', 'the line is not on this purchase order', { field: 'lines', reason: 'LINE' })
      const newQuantity = c.newQuantity !== undefined ? parseQuantity(c.newQuantity) : parseQuantity(line.quantity.toString())
      if (newQuantity <= 0n) return fail('VALIDATION_FAILED', 'a quantity above zero is needed', { field: 'lines', reason: 'QUANTITY' })
      const newUnitPriceSatang = c.newUnitPrice !== undefined ? amountToSatang(c.newUnitPrice) : line.unitPriceSatang
      if (newQuantity === parseQuantity(line.quantity.toString()) && newUnitPriceSatang === line.unitPriceSatang) continue
      changes.push({ poLineId: line.id, newQuantity, newUnitPriceSatang })
    }
    // the delivery date agreed is the one of the last approved change that set one (a PO has none of its own)
    const agreed = (await tx.poChange.findFirst({ where: { poId: po.id, status: 'APPROVED', deliveryDate: { not: null } }, orderBy: { changeNo: 'desc' }, select: { deliveryDate: true } }))?.deliveryDate ?? null
    const dateChanged = input.deliveryDate !== undefined && (input.deliveryDate ?? null) !== (agreed?.toISOString().slice(0, 10) ?? null)
    const notesChanged = input.notesToSupplier !== undefined && (input.notesToSupplier || null) !== po.notesToSupplier
    if (changes.length === 0 && !dateChanged && !notesChanged) return fail('VALIDATION_FAILED', 'nothing to change', { reason: 'NO_CHANGE' })
    const checked = checkChange(locked, changes)
    if (!checked.ok) return checked
    const changeNo = (await tx.poChange.count({ where: { poId: po.id } })) + 1
    const poChangeId = newId()
    await tx.poChange.create({
      data: {
        id: poChangeId,
        organizationId: ctx.organizationId,
        poId: po.id,
        changeNo,
        status: 'DRAFT',
        autoApproved: changes.length === 0,
        reason: input.reason,
        oldNetSatang: po.netSatang,
        oldVatSatang: po.vatSatang,
        oldGrossSatang: po.grossSatang,
        newNetSatang: checked.totals.netSatang,
        newVatSatang: checked.totals.vatSatang,
        newGrossSatang: checked.totals.grossSatang,
        notesToSupplier: input.notesToSupplier !== undefined ? input.notesToSupplier || null : po.notesToSupplier,
        deliveryDate: input.deliveryDate !== undefined ? (input.deliveryDate ? new Date(`${input.deliveryDate}T00:00:00Z`) : null) : agreed,
        quantityDisposition: changes.some((c) => c.newQuantity < parseQuantity(po.lines.find((l) => l.id === c.poLineId)!.quantity.toString())) ? (input.quantityDisposition ?? DEFAULT_DISPOSITION) : null,
        createdById: who.memberId,
      },
    })
    for (const c of changes) {
      const line = po.lines.find((l) => l.id === c.poLineId)!
      await tx.poChangeLine.create({
        data: {
          organizationId: ctx.organizationId,
          poChangeId,
          poLineId: line.id,
          oldQuantity: line.quantity,
          newQuantity: formatQuantity(c.newQuantity),
          oldUnitPriceSatang: line.unitPriceSatang,
          newUnitPriceSatang: c.newUnitPriceSatang,
          oldNetSatang: line.netSatang,
          newNetSatang: lineNet(formatQuantity(c.newQuantity), c.newUnitPriceSatang),
        },
      })
    }
    return {
      ok: true,
      result: { poChangeId, changeNo, autoApproved: changes.length === 0 },
      events: [{ type: 'po_change.drafted', aggregateType: 'PoChange', aggregateId: poChangeId, data: { poId: po.id, changeNo, lineCount: changes.length, newNetSatang: checked.totals.netSatang.toString(), autoApproved: changes.length === 0 } }],
    }
  },
})

/** The PO change locked with its lines, checked against its machine */
async function lockedChange(tx: TenantTx, ctx: Ctx, poChangeId: string, command: Parameters<typeof transition<PoChangeState, string>>[2]) {
  const head = await tx.poChange.findFirst({ where: { id: poChangeId }, select: { poId: true } })
  if (!head) return null
  const locked = await lockedPo(tx, ctx, head.poId)
  await lockRowsForUpdate(tx, 'PoChange', ctx.organizationId, [poChangeId])
  const change = await tx.poChange.findUniqueOrThrow({ where: { id: poChangeId }, include: { lines: true } })
  const moved = transition(PO_CHANGE_MACHINE, change.status as PoChangeState, command as never)
  return { locked: locked!, change, moved }
}

/** The budget of one changed line: its budget line, the request line, the amount it moves and the releasables */
function budgetLine(locked: Locked, line: { poLineId: string; oldQuantity: { toString(): string }; newQuantity: { toString(): string }; oldNetSatang: bigint; newNetSatang: bigint }) {
  const poLine = locked.po.lines.find((l) => l.id === line.poLineId)!
  const source = poLine.sources[0]!
  const b = locked.basis.get(source.requestLineId)!
  const diff = parseQuantity(line.newQuantity.toString()) - parseQuantity(line.oldQuantity.toString())
  return {
    budgetLineId: poLine.budgetLineId,
    change: { poLineId: poLine.id, requestLineId: source.requestLineId, deltaSatang: line.newNetSatang - line.oldNetSatang, addedReleasableSatang: diff > 0n ? releasableFor(b, diff) : 0n },
    removedReleasableSatang: diff < 0n ? releasableFor(b, -diff) : 0n,
    quantityDiff: diff,
    source,
  }
}

/** Applies an approved change to the PO (BR-POC-04): lines, sources, request lines, totals and the revision number */
async function applyChange(tx: TenantTx, ctx: Ctx, locked: Locked, change: Awaited<ReturnType<typeof lockedChange>> extends infer T ? (T extends { change: infer C } ? C : never) : never): Promise<{ revisionNo: number; events: EventDraft[] }> {
  const { po } = locked
  for (const line of change.lines) {
    const b = budgetLine(locked, line)
    await tx.poLine.update({ where: { id: line.poLineId }, data: { quantity: line.newQuantity, unitPriceSatang: line.newUnitPriceSatang, netSatang: line.newNetSatang } })
    if (b.quantityDiff !== 0n) {
      const basis = locked.basis.get(b.source.requestLineId)!
      await tx.poLineSource.update({ where: { id: b.source.id }, data: { quantity: line.newQuantity, releasableSatang: releasableFor(basis, parseQuantity(line.newQuantity.toString())) } })
      await reorderSourceLine(tx, b.source.requestLineId, b.quantityDiff, change.quantityDisposition ?? DEFAULT_DISPOSITION)
    }
  }
  const revisionNo = po.revisionNo + 1
  await tx.purchaseOrder.update({
    where: { id: po.id },
    data: { netSatang: change.newNetSatang, vatSatang: change.newVatSatang, grossSatang: change.newGrossSatang, notesToSupplier: change.notesToSupplier, revisionNo, version: { increment: 1 } },
  })
  await tx.poChange.update({ where: { id: change.id }, data: { status: 'APPROVED', decidedAt: ctx.now, appliedRevisionNo: revisionNo, version: { increment: 1 } } })
  return {
    revisionNo,
    events: [
      { type: 'po_change.approved', aggregateType: 'PoChange', aggregateId: change.id, data: { poId: po.id, revisionNo, autoApproved: change.autoApproved } },
      { type: 'po.revised', aggregateType: 'PurchaseOrder', aggregateId: po.id, data: { poChangeId: change.id, revisionNo, netSatang: change.newNetSatang.toString() } },
    ],
  }
}

// ---------- po_change.submit ----------

const SubmitInput = z.strictObject({ poChangeId: z.uuid(), version: z.number().int().min(0) })

export const submitPoChangeCommand = defineCommand({
  name: 'po_change.submit',
  capability: 'po.change',
  input: SubmitInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ poChangeId: string; status: string; routeId: string | null; revisionNo: number | null }>> {
    const who = await changeGuard(tx, ctx)
    if (!who.ok) return who
    const found = await lockedChange(tx, ctx, input.poChangeId, 'po_change.submit')
    if (!found) return fail('NOT_FOUND', 'change not found')
    const { locked, change } = found
    if (change.status !== 'DRAFT') return fail('INVALID_STATE_TRANSITION', `po_change.submit is not allowed from ${change.status}`, { from: change.status, command: 'po_change.submit' })
    if (change.version !== input.version) return fail('CONFLICT_VERSION', 'the change changed since it was read', { version: change.version })
    const checked = checkChange(
      locked,
      change.lines.map((l) => ({ poLineId: l.poLineId, newQuantity: parseQuantity(l.newQuantity.toString()), newUnitPriceSatang: l.newUnitPriceSatang })),
    )
    if (!checked.ok) return checked
    await tx.poChange.update({ where: { id: change.id }, data: { submittedById: who.memberId, submittedAt: ctx.now } })

    // BR-POC-02: only the date or the notes — approved now, no task, no budget move
    if (change.autoApproved) {
      const applied = await applyChange(tx, ctx, locked, change)
      return { ok: true, result: { poChangeId: change.id, status: 'APPROVED', routeId: null, revisionNo: applied.revisionNo }, events: [{ type: 'po_change.submitted', aggregateType: 'PoChange', aggregateId: change.id, data: { poId: change.poId, routeId: null, autoApproved: true } }, ...applied.events] }
    }
    // BR-POC-03: an increase reserves what it needs beyond the request's releasable, in the PO line's name
    const document = { type: 'PURCHASE_ORDER' as const, id: change.poId }
    const operations: BudgetOperation[] = []
    const reserved = new Map<string, Satang>()
    for (const line of change.lines) {
      const b = budgetLine(locked, line)
      if (b.change.deltaSatang > 0n) {
        operations.push({ budgetLineId: b.budgetLineId, document, run: (s) => submitChange(s, b.change) })
        reserved.set(line.id, b.change.deltaSatang > b.change.addedReleasableSatang ? b.change.deltaSatang - b.change.addedReleasableSatang : 0n)
      }
    }
    const budget = await applyBudget(tx, ctx, operations)
    if (!budget.ok) return { ok: false, error: budget.error }
    for (const [id, amount] of reserved) await tx.poChangeLine.update({ where: { id }, data: { reservedSatang: amount } })
    // DOA PO_CHANGE with the PO's new totals; the PO's creator, the proposer and the requesters do not approve (BR-POC-02)
    const requesters = await tx.request.findMany({ where: { lines: { some: { poSources: { some: { poLine: { poId: change.poId } } } } } }, select: { requesterMemberId: true } })
    const chargedDepartmentId = (await tx.budgetLine.findUniqueOrThrow({ where: { id: locked.po.lines[0]!.budgetLineId }, select: { departmentId: true } })).departmentId
    const route = await startRoute(
      tx,
      ctx,
      { type: 'PO_CHANGE', id: change.id, label: `${locked.po.number ?? ''} #${change.changeNo}` },
      {
        documentType: 'PO_CHANGE',
        amount: { netSatang: checked.totals.netSatang, vatSatang: checked.totals.vatSatang },
        requesterMemberId: who.memberId,
        chargedDepartmentId,
        conflictMemberIds: [...new Set([who.memberId, change.createdById, ...(locked.po.createdById ? [locked.po.createdById] : []), ...requesters.map((r) => r.requesterMemberId)])],
        at: ctx.now,
      },
    )
    if (!route.ok) return { ok: false, error: route.error }
    await tx.poChange.update({ where: { id: change.id }, data: { status: 'PENDING_APPROVAL', currentRouteId: route.data.routeId, version: { increment: 1 } } })
    return {
      ok: true,
      result: { poChangeId: change.id, status: 'PENDING_APPROVAL', routeId: route.data.routeId, revisionNo: null },
      events: [{ type: 'po_change.submitted', aggregateType: 'PoChange', aggregateId: change.id, data: { poId: change.poId, routeId: route.data.routeId, autoApproved: false } }, ...budget.events, ...route.data.events],
      notifications: route.data.notifications,
    }
  },
})

/** The decision of DOA PO_CHANGE (the subject adapter calls it): applied under the PO's lock, or given back */
export async function decidePoChange(tx: TenantTx, ctx: Ctx, poChangeId: string, decision: SubjectDecision): Promise<SubjectDecided> {
  const command = decision.outcome === 'APPROVED' ? 'po_change.final_approval' : decision.outcome === 'RETURNED' ? 'approval.return' : 'approval.reject'
  const found = await lockedChange(tx, ctx, poChangeId, command)
  if (!found) return { ok: false, error: { code: 'NOT_FOUND', message: 'change not found' } }
  const { locked, change, moved } = found
  if (!moved.ok) return { ok: false, error: { code: 'INVALID_STATE_TRANSITION', message: `${command} is not allowed from ${change.status}`, details: { from: change.status, command } } }
  const document = { type: 'PURCHASE_ORDER' as const, id: change.poId }
  if (decision.outcome !== 'APPROVED') {
    const operations: BudgetOperation[] = change.lines.filter((l) => l.reservedSatang > 0n).map((l) => ({ budgetLineId: budgetLine(locked, l).budgetLineId, document, run: (s) => rejectChange(s, l.poLineId) }))
    const budget = await applyBudget(tx, ctx, operations)
    if (!budget.ok) return { ok: false, error: budget.error }
    await tx.poChangeLine.updateMany({ where: { poChangeId: change.id }, data: { reservedSatang: 0n } })
    await tx.poChange.update({ where: { id: change.id }, data: { status: moved.to, decidedAt: ctx.now, currentRouteId: moved.to === 'DRAFT' ? null : change.currentRouteId, version: { increment: 1 } } })
    const type = decision.outcome === 'RETURNED' ? 'po_change.returned' : 'po_change.rejected'
    return { ok: true, documentStatus: moved.to, events: [{ type, aggregateType: 'PoChange', aggregateId: change.id, data: { poId: change.poId, reasonCommentId: decision.reasonCommentId } }, ...budget.events], notifications: decidedNotice(change, decision.outcome) }
  }
  // BR-POC-04: the PO may have moved while the change waited
  const checked = checkChange(
    locked,
    change.lines.map((l) => ({ poLineId: l.poLineId, newQuantity: parseQuantity(l.newQuantity.toString()), newUnitPriceSatang: l.newUnitPriceSatang })),
  )
  if (!checked.ok) return { ok: false, error: checked.error as never }
  const operations: BudgetOperation[] = change.lines.map((l) => {
    const b = budgetLine(locked, l)
    const decrease = b.change.deltaSatang < 0n ? { disposition: change.quantityDisposition ?? DEFAULT_DISPOSITION, removedReleasableSatang: b.removedReleasableSatang } : null
    return { budgetLineId: b.budgetLineId, document, run: (s) => approveChange(s, b.change, decrease) }
  })
  const budget = await applyBudget(tx, ctx, operations)
  if (!budget.ok) return { ok: false, error: budget.error }
  await tx.poChangeLine.updateMany({ where: { poChangeId: change.id }, data: { reservedSatang: 0n } })
  const applied = await applyChange(tx, ctx, locked, change)
  return { ok: true, documentStatus: 'APPROVED', events: [...applied.events, ...budget.events], notifications: decidedNotice(change, 'APPROVED') }
}

/** §10.1 po_change.decided: the proposer hears the decision */
function decidedNotice(change: { id: string; createdById: string; poId: string; changeNo: number; version: number }, outcome: string) {
  return [{ recipientMemberId: change.createdById, templateKey: 'po_change.decided', data: { poChangeId: change.id, poId: change.poId, changeNo: change.changeNo, outcome }, urgency: 'IMMEDIATE' as const, dedupeKey: `po_change.decided:${change.id}:${change.version}`, subjectType: 'PO_CHANGE', subjectId: change.id }]
}

// ---------- po_change.cancel ----------

const CancelInput = z.strictObject({ poChangeId: z.uuid(), version: z.number().int().min(0), reason: z.string().trim().min(1).max(REASON_MAX_LENGTH) })

export const cancelPoChangeCommand = defineCommand({
  name: 'po_change.cancel',
  capability: 'po.change',
  input: CancelInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ poChangeId: string }>> {
    const allowed = await authorize(tx, ctx, 'po.change')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    const found = await lockedChange(tx, ctx, input.poChangeId, 'po_change.cancel')
    if (!found) return fail('NOT_FOUND', 'change not found')
    const { locked, change, moved } = found
    if (!moved.ok) return fail('INVALID_STATE_TRANSITION', `po_change.cancel is not allowed from ${change.status}`, { from: change.status, command: 'po_change.cancel' })
    if (change.version !== input.version) return fail('CONFLICT_VERSION', 'the change changed since it was read', { version: change.version })
    const document = { type: 'PURCHASE_ORDER' as const, id: change.poId }
    const budget = await applyBudget(
      tx,
      ctx,
      change.lines.filter((l) => l.reservedSatang > 0n).map((l) => ({ budgetLineId: budgetLine(locked, l).budgetLineId, document, run: (s) => rejectChange(s, l.poLineId) })),
    )
    if (!budget.ok) return { ok: false, error: budget.error }
    const events: EventDraft[] = []
    if (change.status === 'PENDING_APPROVAL') events.push(...(await closeRoute(tx, { type: 'PO_CHANGE', id: change.id }, 'CANCELLED', 'REQUEST_CANCELLED')))
    await tx.poChangeLine.updateMany({ where: { poChangeId: change.id }, data: { reservedSatang: 0n } })
    await tx.poChange.update({ where: { id: change.id }, data: { status: 'CANCELLED', version: { increment: 1 } } })
    return { ok: true, result: { poChangeId: change.id }, events: [{ type: 'po_change.cancelled', aggregateType: 'PoChange', aggregateId: change.id, data: { poId: change.poId, reason: input.reason, from: change.status } }, ...budget.events, ...events] }
  },
})

// ---------- po.sendRevision ----------

const SendRevisionInput = z.strictObject({ poId: z.uuid() })

/** FR-AP-107 AC3: the PO's latest revision e-mailed to the supplier with its PDF, as po.send sends a PO */
export const sendRevisionCommand = defineCommand({
  name: 'po.sendRevision',
  capability: 'po.change',
  input: SendRevisionInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ poId: string; revisionNo: number; pdfFileId: string }>> {
    const allowed = await authorize(tx, ctx, 'po.change')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    if (allowed.data.kind !== 'member') return fail('FORBIDDEN', 'members only')
    const actor = allowed.data.memberId
    const [id] = await lockRowsForUpdate(tx, 'PurchaseOrder', ctx.organizationId, [input.poId])
    if (!id) return fail('NOT_FOUND', 'purchase order not found')
    const po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id }, include: { supplier: { select: { nameTh: true, email: true } } } })
    const change = await tx.poChange.findFirst({ where: { poId: po.id, status: 'APPROVED', appliedRevisionNo: po.revisionNo }, orderBy: { changeNo: 'desc' } })
    if (po.revisionNo === 0 || !change) return fail('INVALID_STATE_TRANSITION', 'the purchase order has no revision to send', { from: `revision ${po.revisionNo}`, command: 'po.sendRevision' })
    const to = po.supplier.email?.trim()
    if (!to) return fail('VALIDATION_FAILED', 'the supplier has no e-mail address', { field: 'supplierEmail', reason: 'MISSING' })
    const printable = await printablePurchaseOrder(tx, ctx.organizationId, po.id, ctx.now)
    const pdf = await renderPdf(printable)
    const pdfFileId = newId()
    const storageKey = `org/${ctx.organizationId}/${pdfFileId}`
    await putObject(storageKey, pdf, PDF_MIME)
    const fileName = `${printable.number}-rev${po.revisionNo}.pdf`
    await tx.fileObject.create({ data: { id: pdfFileId, organizationId: ctx.organizationId, storageKey, fileName, mimeType: PDF_MIME, sizeBytes: pdf.length, sha256: createHash('sha256').update(pdf).digest('hex'), status: 'AVAILABLE', uploadedById: actor, scanStatus: 'NOT_REQUIRED' } })
    await tx.fileLink.create({ data: { organizationId: ctx.organizationId, fileId: pdfFileId, subjectType: 'PurchaseOrder', subjectId: po.id, kind: 'PO_PDF' } })
    const sender = await tx.member.findUniqueOrThrow({ where: { id: actor }, select: { displayNameTh: true, email: true } })
    const mail = poEmail({ supplierName: po.supplier.nameTh, organizationName: printable.organization.name, poNumber: `${printable.number} (แก้ไขครั้งที่ ${po.revisionNo})`, gross: formatSatang(po.grossSatang), senderName: sender.displayNameTh, resend: true })
    try {
      await getEmailProvider().send({ to, replyTo: sender.email, ...mail, attachments: [{ filename: fileName, content: pdf, contentType: PDF_MIME }] })
    } catch (error) {
      return fail('EXTERNAL_SERVICE_ERROR', 'the e-mail was not sent', { service: 'email', code: error instanceof EmailSendError ? error.code : 'UNKNOWN' })
    }
    await tx.poChange.update({ where: { id: change.id }, data: { pdfFileId, sentAt: ctx.now, version: { increment: 1 } } })
    await tx.purchaseOrder.update({ where: { id: po.id }, data: { pdfFileId, version: { increment: 1 } } })
    return { ok: true, result: { poId: po.id, revisionNo: po.revisionNo, pdfFileId }, events: [{ type: 'po.revision_sent', aggregateType: 'PurchaseOrder', aggregateId: po.id, data: { revisionNo: po.revisionNo, poChangeId: change.id, pdfFileId } }] }
  },
})

export function createPoChange(ctx: Ctx, input: z.input<typeof CreateInput>, options: RunOptions) {
  return runCommand(ctx, createPoChangeCommand, input, options)
}
export function submitPoChange(ctx: Ctx, input: z.input<typeof SubmitInput>, options: RunOptions) {
  return runCommand(ctx, submitPoChangeCommand, input, options)
}
export function cancelPoChange(ctx: Ctx, input: z.input<typeof CancelInput>, options: RunOptions) {
  return runCommand(ctx, cancelPoChangeCommand, input, options)
}
export function sendPoRevision(ctx: Ctx, input: z.input<typeof SendRevisionInput>, options: RunOptions) {
  return runCommand(ctx, sendRevisionCommand, input, options)
}
