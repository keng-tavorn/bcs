import { z } from 'zod'
import { satangToAmount } from '@/core/money/dto'
import { authorize, matchingGrants } from '@/server/authz'
import { systemCtx, type Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import type { OutboxDraft } from '@/server/events/outbox'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { startRoute } from '../approvals/route'
import { requireModule } from '../modules'
import { fail, guard, lockedInvoice } from './common'
import { runMatch, type MatchRunOutcome } from './match-run'
import { enqueueSupplierNotice, SUPPLIER_TEMPLATES, type SupplierNoticeEffects } from '@/server/notifications/supplier-notices'

// What happens to an invoice the match did not pass (spec §7.14 BR-MATCH-09, BR-MATCH-10, FR-AP-103, FR-AP-105): it is
// checked again (after a GR, a PO change or a budget transfer — by FINANCE, by whoever its differences are sent to, or by
// SYSTEM on gr.posted), reopened as a draft, rejected with a reason (the supplier is told), a possible duplicate is
// dismissed, or a price variance is sent for approval under DOA INVOICE_EXCEPTION. The approval itself is decided by the
// INVOICE subject adapter (../approvals/subjects/invoice.ts).

const VersionInput = { invoiceId: z.uuid(), version: z.number().int().min(0) }
const Reason = z.string().trim().min(1).max(500)

/** The result a recheck or a dismissal gives the screen */
export interface RecheckedInvoice {
  readonly invoiceId: string
  readonly status: 'READY_FOR_PAYMENT' | 'EXCEPTION'
  readonly exceptions: ReadonlyArray<{ type: string; amount: string; lineNo: number | null }>
}

/** The events, notices to members and supplier e-mails of one run of the match */
async function afterMatch(tx: TenantTx, ctx: Ctx, invoiceId: string, run: MatchRunOutcome, trigger: 'USER' | 'SYSTEM') {
  const notice = run.status === 'READY_FOR_PAYMENT' ? await readyNotice(tx, ctx, invoiceId) : null
  return {
    outbox: notice?.outbox ?? [],
    notifications: [...run.notifications, ...(notice?.notifications ?? [])],
    events: [{ type: 'invoice.rechecked', aggregateType: 'Invoice', aggregateId: invoiceId, data: { matchId: run.matchId, runNo: run.runNo, triggeredBy: trigger, status: run.status } }, ...run.events, ...(notice?.events ?? [])] as EventDraft[],
  }
}

/** BR-AP-08: the supplier hears when the invoice is ready for payment, once per invoice */
export async function readyNotice(tx: TenantTx, ctx: Ctx, invoiceId: string): Promise<SupplierNoticeEffects> {
  const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { supplierId: true, number: true, supplierInvoiceNo: true, dueDate: true, payableSatang: true, expectedWhtSatang: true } })
  const notice = await enqueueSupplierNotice(tx, ctx, {
    templateKey: SUPPLIER_TEMPLATES.invoiceReady,
    supplierId: invoice.supplierId,
    subjectType: 'Invoice',
    subjectId: invoiceId,
    dedupeKey: `invoice_ready:${invoiceId}`,
    data: { number: invoice.number, supplierInvoiceNo: invoice.supplierInvoiceNo, dueDate: invoice.dueDate?.toISOString().slice(0, 10) ?? null, payableSatang: invoice.payableSatang.toString(), expectedWhtSatang: invoice.expectedWhtSatang.toString() },
  })
  return notice
}

/** Who may run the match again on this invoice: FINANCE, or a member of the role its open differences are sent to */
async function mayRecheck(tx: TenantTx, ctx: Ctx, invoiceId: string): Promise<{ ok: true } | ReturnType<typeof fail>> {
  if (ctx.actor.type === 'SYSTEM') return { ok: true }
  const record = await authorize(tx, ctx, 'invoice.record')
  if (record.ok) return { ok: true }
  const resolve = await authorize(tx, ctx, 'invoice.exception.resolve')
  if (!resolve.ok) return { ok: false, error: resolve.error }
  const principal = resolve.data
  if (principal.kind !== 'member') return fail('FORBIDDEN', 'members only')
  const open = await tx.matchException.findMany({ where: { invoiceId, status: 'OPEN' }, select: { assigneeRole: true } })
  const roles = new Set(open.map((e) => e.assigneeRole))
  const holds = (role: 'PROCUREMENT' | 'RECEIVER' | 'FINANCE') => matchingGrants(principal, 'invoice.exception.resolve').some((g) => g.grantee.kind === 'ROLE' && g.grantee.role === role)
  if ([...roles].some((r) => holds(r))) return { ok: true }
  return fail('FORBIDDEN', 'the invoice’s differences are not sent to you', { capability: 'invoice.exception.resolve' })
}

// ---------- invoice.recheck ----------

const RecheckInput = z.strictObject({ ...VersionInput })

export const recheckInvoiceCommand = defineCommand({
  name: 'invoice.recheck',
  capability: 'invoice.exception.resolve',
  input: RecheckInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<RecheckedInvoice>> {
    const pay = await requireModule(ctx, 'PAY', tx)
    if (!pay.ok) return { ok: false, error: pay.error }
    const head = await tx.invoice.findFirst({ where: { id: input.invoiceId }, select: { poId: true } })
    if (!head) return fail('NOT_FOUND', 'invoice not found')
    await lockRowsForUpdate(tx, 'PurchaseOrder', ctx.organizationId, [head.poId])
    const locked = await lockedInvoice(tx, ctx, input.invoiceId, 'invoice.recheck_matched', ctx.actor.type === 'SYSTEM' ? undefined : input.version)
    if (!locked.ok) return locked
    const allowed = await mayRecheck(tx, ctx, input.invoiceId)
    if (!allowed.ok) return allowed
    const trigger = ctx.actor.type === 'SYSTEM' ? 'SYSTEM' : 'USER'
    const run = await runMatch(tx, ctx, input.invoiceId, trigger)
    if (!run.ok) return run.refusal.code === 'TAX_RATE_NOT_CONFIGURED' ? fail('TAX_RATE_NOT_CONFIGURED', 'no VAT rate covers the invoice date', { date: run.refusal.date }) : fail('DUPLICATE_INVOICE', 'the supplier already has an invoice with this number', { invoiceNo: run.refusal.invoiceNo })
    const after = await afterMatch(tx, ctx, input.invoiceId, run.data, trigger)
    return {
      ok: true,
      result: { invoiceId: input.invoiceId, status: run.data.status, exceptions: run.data.exceptions.map((e) => ({ type: e.type, amount: satangToAmount(e.amountSatang), lineNo: e.lineNo })) },
      events: after.events,
      notifications: after.notifications,
      outbox: after.outbox,
    }
  },
})

// ---------- invoice.reopen ----------

const ReopenInput = z.strictObject({ ...VersionInput })

export const reopenInvoiceCommand = defineCommand({
  name: 'invoice.reopen',
  capability: 'invoice.record',
  input: ReopenInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ invoiceId: string }>> {
    const who = await guard(tx, ctx, 'invoice.record')
    if (!who.ok) return who
    const locked = await lockedInvoice(tx, ctx, input.invoiceId, 'invoice.reopen', input.version)
    if (!locked.ok) return locked
    await tx.matchException.updateMany({ where: { invoiceId: input.invoiceId, status: { in: ['OPEN', 'ACCEPT_REQUESTED'] } }, data: { status: 'CLOSED', resolvedAt: ctx.now, version: { increment: 1 } } })
    await tx.invoice.update({ where: { id: input.invoiceId }, data: { status: locked.to, matchResult: null, version: { increment: 1 } } })
    return { ok: true, result: { invoiceId: input.invoiceId }, events: [{ type: 'invoice.reopened', aggregateType: 'Invoice', aggregateId: input.invoiceId, data: {} }] }
  },
})

// ---------- invoice.reject (BR-AP-08) ----------

const RejectInput = z.strictObject({ ...VersionInput, reason: Reason })

export const rejectInvoiceCommand = defineCommand({
  name: 'invoice.reject',
  capability: 'invoice.reject',
  input: RejectInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ invoiceId: string }>> {
    const who = await guard(tx, ctx, 'invoice.reject')
    if (!who.ok) return who
    const locked = await lockedInvoice(tx, ctx, input.invoiceId, 'invoice.reject', input.version)
    if (!locked.ok) return locked
    await tx.matchException.updateMany({ where: { invoiceId: input.invoiceId, status: { in: ['OPEN', 'ACCEPT_REQUESTED'] } }, data: { status: 'CLOSED', resolvedAt: ctx.now, version: { increment: 1 } } })
    await tx.invoice.update({ where: { id: input.invoiceId }, data: { status: locked.to, rejectedById: who.memberId, rejectedAt: ctx.now, rejectReason: input.reason, version: { increment: 1 } } })
    const invoice = locked.invoice
    const notice = await enqueueSupplierNotice(tx, ctx, {
      templateKey: SUPPLIER_TEMPLATES.invoiceRejected,
      supplierId: invoice.supplierId,
      subjectType: 'Invoice',
      subjectId: invoice.id,
      dedupeKey: `invoice_rejected:${invoice.id}`,
      data: { number: invoice.number, supplierInvoiceNo: invoice.supplierInvoiceNo, reason: input.reason },
    })
    return { ok: true, result: { invoiceId: input.invoiceId }, events: [{ type: 'invoice.rejected', aggregateType: 'Invoice', aggregateId: input.invoiceId, data: { from: invoice.status, reason: input.reason } }, ...notice.events], notifications: notice.notifications, outbox: notice.outbox }
  },
})

// ---------- match_exception.dismiss (POSSIBLE_DUPLICATE only) ----------

const DismissInput = z.strictObject({ exceptionId: z.uuid(), reason: Reason })

export const dismissExceptionCommand = defineCommand({
  name: 'match_exception.dismiss',
  capability: 'invoice.record',
  input: DismissInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<RecheckedInvoice>> {
    const who = await guard(tx, ctx, 'invoice.record')
    if (!who.ok) return who
    const exception = await tx.matchException.findFirst({ where: { id: input.exceptionId }, select: { id: true, invoiceId: true, type: true, status: true, invoice: { select: { poId: true, version: true } } } })
    if (!exception) return fail('NOT_FOUND', 'exception not found')
    await lockRowsForUpdate(tx, 'PurchaseOrder', ctx.organizationId, [exception.invoice.poId])
    const locked = await lockedInvoice(tx, ctx, exception.invoiceId, 'invoice.recheck_matched')
    if (!locked.ok) return locked
    // BR-MATCH-10: only a possible duplicate is dismissed; anything else is fixed at its cause or the invoice is rejected
    if (exception.type !== 'POSSIBLE_DUPLICATE') return fail('VALIDATION_FAILED', 'only a possible duplicate is dismissed', { field: 'exceptionId', reason: 'NOT_DISMISSABLE', type: exception.type })
    if (exception.status !== 'OPEN') return fail('INVALID_STATE_TRANSITION', `match_exception.dismiss is not allowed from ${exception.status}`, { from: exception.status, command: 'match_exception.dismiss' })
    await tx.matchException.update({ where: { id: exception.id }, data: { status: 'DISMISSED', resolvedById: who.memberId, resolvedAt: ctx.now, reason: input.reason, version: { increment: 1 } } })
    const events: EventDraft[] = [{ type: 'match_exception.dismissed', aggregateType: 'Invoice', aggregateId: exception.invoiceId, data: { exceptionId: exception.id, type: exception.type, reason: input.reason } }]
    // Nothing else open: the match runs again at once (the dismissed duplicate is not raised again)
    const others = await tx.matchException.count({ where: { invoiceId: exception.invoiceId, status: 'OPEN' } })
    if (others > 0) {
      const open = await tx.matchException.findMany({ where: { invoiceId: exception.invoiceId, status: 'OPEN' }, select: { type: true, amountSatang: true, invoiceLine: { select: { lineNo: true } } } })
      return { ok: true, result: { invoiceId: exception.invoiceId, status: 'EXCEPTION', exceptions: open.map((e) => ({ type: e.type, amount: satangToAmount(e.amountSatang), lineNo: e.invoiceLine?.lineNo ?? null })) }, events }
    }
    const run = await runMatch(tx, ctx, exception.invoiceId, 'USER')
    if (!run.ok) return run.refusal.code === 'TAX_RATE_NOT_CONFIGURED' ? fail('TAX_RATE_NOT_CONFIGURED', 'no VAT rate covers the invoice date', { date: run.refusal.date }) : fail('DUPLICATE_INVOICE', 'the supplier already has an invoice with this number', { invoiceNo: run.refusal.invoiceNo })
    const after = await afterMatch(tx, ctx, exception.invoiceId, run.data, 'USER')
    return {
      ok: true,
      result: { invoiceId: exception.invoiceId, status: run.data.status, exceptions: run.data.exceptions.map((e) => ({ type: e.type, amount: satangToAmount(e.amountSatang), lineNo: e.lineNo })) },
      events: [...events, ...after.events],
      notifications: after.notifications,
      outbox: after.outbox,
    }
  },
})

// ---------- invoice.requestVarianceApproval (BR-MATCH-10, BR-AP-05, BR-AP-06) ----------

const VarianceInput = z.strictObject({ ...VersionInput, reason: Reason })

export const requestVarianceCommand = defineCommand({
  name: 'invoice.requestVarianceApproval',
  capability: 'invoice.variance.request',
  input: VarianceInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ invoiceId: string; status: 'PENDING_APPROVAL' | 'READY_FOR_PAYMENT'; routeId: string | null }>> {
    const who = await guard(tx, ctx, 'invoice.variance.request')
    if (!who.ok) return who
    const head = await tx.invoice.findFirst({ where: { id: input.invoiceId }, select: { poId: true } })
    if (!head) return fail('NOT_FOUND', 'invoice not found')
    await lockRowsForUpdate(tx, 'PurchaseOrder', ctx.organizationId, [head.poId])
    const locked = await lockedInvoice(tx, ctx, input.invoiceId, 'invoice.requestVarianceApproval', input.version)
    if (!locked.ok) return locked
    // A fresh match first: another invoice may have taken the received quantity since (BR-MATCH-10, INV-AP-01)
    const run = await runMatch(tx, ctx, input.invoiceId, 'USER')
    if (!run.ok) return run.refusal.code === 'TAX_RATE_NOT_CONFIGURED' ? fail('TAX_RATE_NOT_CONFIGURED', 'no VAT rate covers the invoice date', { date: run.refusal.date }) : fail('DUPLICATE_INVOICE', 'the supplier already has an invoice with this number', { invoiceNo: run.refusal.invoiceNo })
    if (run.data.status === 'READY_FOR_PAYMENT') {
      const after = await afterMatch(tx, ctx, input.invoiceId, run.data, 'USER')
      return { ok: true, result: { invoiceId: input.invoiceId, status: 'READY_FOR_PAYMENT', routeId: null }, events: after.events, notifications: after.notifications, outbox: after.outbox }
    }
    const other = run.data.exceptions.find((e) => e.type !== 'PRICE_OVER')
    if (other || !run.data.doaAmount) return fail('VARIANCE_NOT_ACCEPTABLE', `a ${other?.type ?? 'difference'} is not approved: fix it at its cause or reject the invoice`, { type: other?.type ?? 'UNKNOWN' })

    // BR-AP-06: the variance with its VAT, charged to the budget line of the line over the most; BR-AP-05 conflicts
    const invoice = locked.invoice
    const top = invoice.lines.find((l) => l.lineNo === run.data.doaAmount!.lineNo)!
    const department = (await tx.poLine.findUniqueOrThrow({ where: { id: top.poLineId }, select: { budgetLine: { select: { departmentId: true } } } })).budgetLine.departmentId
    const route = await startRoute(
      tx,
      ctx,
      { type: 'INVOICE', id: invoice.id, label: invoice.number ?? invoice.id },
      {
        documentType: 'INVOICE_EXCEPTION',
        amount: { netSatang: run.data.doaAmount.netSatang, vatSatang: run.data.doaAmount.vatSatang },
        requesterMemberId: who.memberId,
        chargedDepartmentId: department,
        conflictMemberIds: [...new Set([who.memberId, ...(invoice.recordedById ? [invoice.recordedById] : [])])],
        at: ctx.now,
      },
    )
    if (!route.ok) return { ok: false, error: route.error }
    await tx.matchException.updateMany({ where: { invoiceId: invoice.id, status: 'OPEN', type: 'PRICE_OVER' }, data: { status: 'ACCEPT_REQUESTED', version: { increment: 1 } } })
    await tx.invoice.update({ where: { id: invoice.id }, data: { status: 'PENDING_APPROVAL', currentRouteId: route.data.routeId, version: { increment: 1 } } })
    const events: EventDraft[] = [
      ...run.data.events,
      {
        type: 'invoice.variance_submitted',
        aggregateType: 'Invoice',
        aggregateId: invoice.id,
        data: { routeId: route.data.routeId, netSatang: run.data.doaAmount.netSatang.toString(), vatSatang: run.data.doaAmount.vatSatang.toString(), reason: input.reason, doaVersionId: route.data.route.doaVersionId, doaRuleCode: route.data.route.ruleCode },
      },
      ...route.data.events,
    ]
    return { ok: true, result: { invoiceId: invoice.id, status: 'PENDING_APPROVAL', routeId: route.data.routeId }, events, notifications: route.data.notifications }
  },
})

export function recheckInvoice(ctx: Ctx, input: z.input<typeof RecheckInput>, options: RunOptions) {
  return runCommand(ctx, recheckInvoiceCommand, input, options)
}
export function reopenInvoice(ctx: Ctx, input: z.input<typeof ReopenInput>, options: RunOptions) {
  return runCommand(ctx, reopenInvoiceCommand, input, options)
}
export function rejectInvoice(ctx: Ctx, input: z.input<typeof RejectInput>, options: RunOptions) {
  return runCommand(ctx, rejectInvoiceCommand, input, options)
}
export function dismissMatchException(ctx: Ctx, input: z.input<typeof DismissInput>, options: RunOptions) {
  return runCommand(ctx, dismissExceptionCommand, input, options)
}
export function requestVarianceApproval(ctx: Ctx, input: z.input<typeof VarianceInput>, options: RunOptions) {
  return runCommand(ctx, requestVarianceCommand, input, options)
}


/** The outbox event a goods receipt sends when its PO has invoices waiting in EXCEPTION (job invoice-auto-recheck) */
export const INVOICE_RECHECK_EVENT = 'bcs/invoice.recheck_requested'

/** For gr.post and an approved PO change: the outbox draft that rechecks the PO's EXCEPTION invoices, if there are any */
export async function recheckRequest(tx: TenantTx, organizationId: string, poId: string, cause: string): Promise<OutboxDraft[]> {
  const waiting = await tx.invoice.count({ where: { poId, status: 'EXCEPTION' } })
  return waiting > 0 ? [{ eventName: INVOICE_RECHECK_EVENT, payload: { organizationId, poId, cause } }] : []
}

/** Job invoice-auto-recheck: every invoice of the PO waiting in EXCEPTION matched again by SYSTEM, one key per invoice and cause */
export async function recheckPoInvoices(organizationId: string, poId: string, cause: string, now: Date) {
  const invoices = await forTenant(organizationId).invoice.findMany({ where: { poId, status: 'EXCEPTION' }, select: { id: true, version: true }, orderBy: { createdAt: 'asc' } })
  const results = []
  for (const inv of invoices) {
    results.push(await recheckInvoice(systemCtx(organizationId, now, 'invoice-auto-recheck'), { invoiceId: inv.id, version: inv.version }, { idempotencyKey: `invoice-auto-recheck:${inv.id}:${cause}` }))
  }
  return results
}
