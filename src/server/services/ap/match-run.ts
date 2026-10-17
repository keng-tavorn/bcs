import { actualize, closePo, holdMore } from '@/core/budget'
import { dueDate } from '@/core/invoice/ap'
import { checkInvoiceVat, findDuplicates, matchInvoice, type MatchExceptionResult, type SupplierVatStatus } from '@/core/matching'
import { satangToAmount } from '@/core/money/dto'
import type { Satang } from '@/core/money/math'
import { rateFor } from '@/core/vat'
import { apPolicyOf } from '@/lib/org-settings'
import { expectedWhtOf } from './wht'
import { holdRetentionOfInvoice } from './retention'
import { retentionOf } from '@/core/retention'
import { applyBudget, lockBudgetLines, type BudgetOperation } from '@/server/budget/ledger'
import type { Ctx } from '@/server/context'
import { listTaxRates } from '@/server/db/lookups'
import { lockRowsForUpdate, lockSupplierInvoiceNumber } from '@/server/db/sql/locks'
import type { TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import type { NotificationDraft } from '@/server/notifications/create'
import { departmentReceivers } from '../receiving/receivers'
import { fail, type Fail } from './common'

// One run of the matching engine on a submitted invoice (spec §7.14 BR-MATCH-05 to BR-MATCH-13, §7.1 BR-VAT-05 to
// BR-VAT-07), inside the command that asked for it: invoice.submit now, invoice.recheck and the variance approval in
// S8-06. The PO is locked first (INV-AP-01: two invoices on one PO line are matched one after the other), then the
// budget lines of its lines, so what the engine reads as held and available is what the ledger moves. The run is
// stored with the thresholds it used (InvoiceMatch, BR-MATCH-13); a matched invoice moves to READY_FOR_PAYMENT with
// its ledger rows (BR-MATCH-11: hold what a line lacks, then COMMITTED → ACTUAL), an unmatched one to EXCEPTION with
// one MatchException per difference, sent to whoever can resolve it (BR-MATCH-09).

/** Invoices that count as invoiced on a PO line (BR-MATCH-08) */
export const INVOICED_STATUSES = ['PENDING_APPROVAL', 'READY_FOR_PAYMENT', 'IN_PAYMENT_RUN', 'PAID'] as const
/** Invoices in effect for the duplicate check (INV-AP-06); a draft, a rejected or a cancelled one is not */
const IN_EFFECT_STATUSES = ['EXCEPTION', ...INVOICED_STATUSES] as const

/** BR-MATCH-09: who resolves each type */
export const ASSIGNEE_OF: Readonly<Record<MatchExceptionResult['type'] | 'VAT_MISMATCH' | 'VAT_SUPPLIER_NOT_REGISTERED' | 'POSSIBLE_DUPLICATE', 'PROCUREMENT' | 'RECEIVER' | 'FINANCE'>> = {
  PRICE_OVER: 'PROCUREMENT',
  QTY_OVER_ORDERED: 'PROCUREMENT',
  QTY_NOT_RECEIVED: 'RECEIVER',
  ACCEPTANCE_PENDING: 'RECEIVER',
  VAT_MISMATCH: 'FINANCE',
  VAT_SUPPLIER_NOT_REGISTERED: 'FINANCE',
  POSSIBLE_DUPLICATE: 'FINANCE',
  BUDGET_SHORT: 'FINANCE',
}

export type MatchRunRefusal =
  | { readonly code: 'TAX_RATE_NOT_CONFIGURED'; readonly date: string }
  | { readonly code: 'DUPLICATE_INVOICE'; readonly invoiceNo: string }
  | { readonly code: 'SOD_VIOLATION'; readonly reason: 'PO_CREATOR' | 'GR_RECEIVER' }

/** The refusal of a run as every command that runs the match answers it */
export function matchRefusal(refusal: MatchRunRefusal): Fail {
  switch (refusal.code) {
    case 'TAX_RATE_NOT_CONFIGURED':
      return fail('TAX_RATE_NOT_CONFIGURED', 'no VAT rate covers the invoice date', { date: refusal.date })
    case 'DUPLICATE_INVOICE':
      return fail('DUPLICATE_INVOICE', 'the supplier already has an invoice with this number', { invoiceNo: refusal.invoiceNo })
    case 'SOD_VIOLATION':
      return fail('SOD_VIOLATION', 'whoever created the purchase order or received its goods does not record its invoice', { rule: 'BR-AP-05', reason: refusal.reason })
  }
}

export interface MatchRunOutcome {
  readonly matchId: string
  readonly runNo: number
  readonly status: 'READY_FOR_PAYMENT' | 'EXCEPTION'
  readonly exceptions: ReadonlyArray<{ type: string; amountSatang: Satang; lineNo: number | null }>
  readonly events: EventDraft[]
  /** BR-MATCH-09: the members each new difference is sent to, in the bell and by LINE (BR-AP-09) */
  readonly notifications: NotificationDraft[]
  /** When every difference is PRICE_OVER: what the variance approval is sized on, and the line that names the department (BR-AP-06) */
  readonly doaAmount: { readonly netSatang: Satang; readonly vatSatang: Satang; readonly lineNo: number } | null
}

type Exception = { type: keyof typeof ASSIGNEE_OF; amountSatang: Satang; quantity: string | null; lineNo: number | null }

const day = (d: Date) => d.toISOString().slice(0, 10)

function supplierVatOf(supplier: { isVatRegistered: boolean; registryFlag: string }): SupplierVatStatus {
  if (!supplier.isVatRegistered) return 'NOT_REGISTERED'
  if (supplier.registryFlag === 'VAT_CANCELLED') return 'REGISTRY_VAT_CANCELLED'
  if (supplier.registryFlag === 'CEASED') return 'REGISTRY_CEASED'
  return 'REGISTERED'
}

/**
 * Matches the invoice and writes the result. The caller has authorized, checked the state and locked nothing yet; the
 * invoice must have its supplier number, date and lines. Refused (nothing written) when no VAT rate covers the
 * invoice date or the supplier already has this number in effect.
 */
export async function runMatch(tx: TenantTx, ctx: Ctx, invoiceId: string, trigger: 'USER' | 'SYSTEM'): Promise<{ ok: true; data: MatchRunOutcome } | { ok: false; refusal: MatchRunRefusal }> {
  const head = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { poId: true } })
  await lockRowsForUpdate(tx, 'PurchaseOrder', ctx.organizationId, [head.poId])
  const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { lines: { orderBy: { lineNo: 'asc' } } } })
  const po = await tx.purchaseOrder.findUniqueOrThrow({
    where: { id: invoice.poId },
    include: { lines: { orderBy: { lineNo: 'asc' } }, supplier: { select: { id: true, taxId: true, isVatRegistered: true, registryFlag: true } } },
  })
  const invoiceDate = day(invoice.invoiceDate!)

  // BR-AP-05 (OQ-127): whoever recorded the invoice did not create the PO or receive its goods — at every run, not only
  // the submit: a GR posted after it (and the recheck it starts) can make the recorder a receiver of the PO
  if (invoice.recordedById) {
    const receivers = await tx.goodsReceipt.findMany({ where: { poId: po.id, status: 'POSTED' }, select: { receiverMemberId: true } })
    const reason = po.createdById === invoice.recordedById ? 'PO_CREATOR' : receivers.some((r) => r.receiverMemberId === invoice.recordedById) ? 'GR_RECEIVER' : null
    if (reason) return { ok: false, refusal: { code: 'SOD_VIOLATION', reason } }
  }

  // BR-VAT-01: the rate of the invoice date in Thai time
  const rate = rateFor(invoiceDate, await listTaxRates())
  if (!rate.ok) return { ok: false, refusal: { code: 'TAX_RATE_NOT_CONFIGURED', date: invoiceDate } }

  // INV-AP-06: one submit at a time per (supplier, number), so the check below sees an invoice submitted just before
  await lockSupplierInvoiceNumber(tx, ctx.organizationId, invoice.supplierId, invoice.supplierInvoiceNoNormalized!)
  // BR-MATCH-12 against tier-2 invoices in effect and tier-1 confirmations, of the supplier or its tax id
  const sameSeller = po.supplier.taxId ? { OR: [{ supplierId: po.supplierId }, { supplier: { taxId: po.supplier.taxId } }] } : { supplierId: po.supplierId }
  const [others, confirmations] = await Promise.all([
    tx.invoice.findMany({
      where: { id: { not: invoice.id }, status: { in: [...IN_EFFECT_STATUSES] }, ...sameSeller },
      select: { supplierId: true, supplierInvoiceNo: true, invoiceDate: true, grossSatang: true, status: true, supplier: { select: { taxId: true } } },
    }),
    tx.invoiceConfirmation.findMany({ where: sameSeller, select: { supplierId: true, invoiceNo: true, invoiceDate: true, grossSatang: true, supplier: { select: { taxId: true } } } }),
  ])
  const duplicates = findDuplicates(
    { supplier: invoice.supplierId, taxId: po.supplier.taxId, invoiceNo: invoice.supplierInvoiceNo!, invoiceDate, grossSatang: invoice.grossSatang },
    [
      ...others.map((o) => ({ supplier: o.supplierId, taxId: o.supplier.taxId, invoiceNo: o.supplierInvoiceNo!, invoiceDate: day(o.invoiceDate!), grossSatang: o.grossSatang, table: 'INVOICE' as const, status: o.status })),
      ...confirmations.map((c) => ({ supplier: c.supplierId, taxId: c.supplier.taxId, invoiceNo: c.invoiceNo, invoiceDate: day(c.invoiceDate), grossSatang: c.grossSatang, table: 'CONFIRMATION' as const, status: 'RECORDED' })),
    ],
  )
  if (duplicates.hard) return { ok: false, refusal: { code: 'DUPLICATE_INVOICE', invoiceNo: invoice.supplierInvoiceNoNormalized! } }

  // What each PO line has been invoiced on other invoices (BR-MATCH-08) and what it still holds
  const invoiced = await tx.invoiceLine.groupBy({
    by: ['poLineId'],
    where: { poLineId: { in: po.lines.map((l) => l.id) }, invoiceId: { not: invoice.id }, invoice: { status: { in: [...INVOICED_STATUSES] } } },
    _sum: { quantity: true },
  })
  const held = await tx.budgetAllocation.findMany({ where: { sourceType: 'PO_LINE', sourceId: { in: po.lines.map((l) => l.id) } }, select: { sourceId: true, committedSatang: true } })
  const budgetLineIds = [...new Set(po.lines.map((l) => l.budgetLineId))]
  const states = await lockBudgetLines(tx, ctx, budgetLineIds)

  const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true } })
  const policy = apPolicyOf(org.settings)
  const lineNoOf = new Map(po.lines.map((l) => [l.id, l.lineNo]))
  const poLineOfNo = new Map(po.lines.map((l) => [l.lineNo, l]))
  // BR-VAT-04/05: a supplier not registered for VAT charges none — its rate is 0 for the VAT check, for taking VAT out
  // of prices that include it and for the DOA amount of a price over (BR-AP-06: the invoice's rate), not the tax table's
  const vat = checkInvoiceVat({
    rateBp: rate.rateBp,
    supplierVat: supplierVatOf(po.supplier),
    priceIncludesVat: invoice.priceIncludesVat,
    discountSatang: invoice.discountSatang,
    lines: invoice.lines.map((l) => ({ qty: l.quantity.toString(), unitPriceSatang: l.unitPriceSatang, vatable: l.vatable })),
    statedVatSatang: invoice.statedVatSatang,
    vatTolSatang: policy.vatTolSatang,
  })
  const result = matchInvoice(
    {
      kind: po.kind,
      poClosed: po.status === 'CLOSED',
      poLines: po.lines.map((l) => ({
        line: l.lineNo,
        ordered: l.quantity.toString(),
        unitPriceSatang: l.unitPriceSatang,
        accepted: l.receivedQuantity.toString(),
        invoiced: (invoiced.find((i) => i.poLineId === l.id)?._sum.quantity ?? 0).toString(),
        heldSatang: held.find((h) => h.sourceId === l.id)?.committedSatang ?? 0n,
        budgetLine: l.budgetLineId,
      })),
      available: Object.fromEntries(budgetLineIds.map((id) => [id, states.get(id)?.buckets.available ?? 0n])),
      invoice: {
        discountSatang: invoice.discountSatang,
        priceIncludesVat: invoice.priceIncludesVat,
        isFinal: invoice.isFinal,
        lines: invoice.lines.map((l) => ({ poLine: lineNoOf.get(l.poLineId)!, qty: l.quantity.toString(), unitPriceSatang: l.unitPriceSatang, vatable: l.vatable })),
      },
    },
    { priceTolBp: policy.priceTolBp, priceTolSatang: policy.priceTolSatang, qtyTolBp: policy.qtyTolBp, vatRateBp: vat.rateBp },
  )

  // The exceptions of this run: the lines' (or BUDGET_SHORT) from the engine, then the invoice's own
  const exceptions: Exception[] = result.exceptions
    .filter((e) => e.type !== 'BUDGET_SHORT')
    .map((e) => ({ type: e.type, amountSatang: e.amountSatang, quantity: 'quantity' in e ? e.quantity : null, lineNo: 'line' in e ? e.line : null }))
  if (vat.status !== 'OK') exceptions.push({ type: vat.status, amountSatang: vat.diffSatang < 0n ? -vat.diffSatang : vat.diffSatang, quantity: null, lineNo: null })
  const dismissed = await tx.matchException.count({ where: { invoiceId: invoice.id, type: 'POSSIBLE_DUPLICATE', status: 'DISMISSED' } })
  if (duplicates.soft.length > 0 && dismissed === 0) exceptions.push({ type: 'POSSIBLE_DUPLICATE', amountSatang: invoice.grossSatang, quantity: null, lineNo: null })
  // BR-MATCH-11: a budget short counts only when nothing else is wrong
  if (exceptions.length === 0) {
    for (const e of result.exceptions) if (e.type === 'BUDGET_SHORT') exceptions.push({ type: 'BUDGET_SHORT', amountSatang: e.amountSatang, quantity: null, lineNo: null })
  }
  const matched = exceptions.length === 0 && result.result === 'MATCHED'

  const runNo = (await tx.invoiceMatch.count({ where: { invoiceId: invoice.id } })) + 1
  const lineResults = result.lines.map((l) => {
    const invoiceLine = invoice.lines[l.line - 1]!
    const lineExceptions = exceptions.filter((e) => e.lineNo === l.line)
    return { invoiceLine, l, status: lineExceptions.length ? ('EXCEPTION' as const) : ('MATCHED' as const) }
  })
  const match = await tx.invoiceMatch.create({
    data: {
      organizationId: ctx.organizationId,
      invoiceId: invoice.id,
      runNo,
      ranAt: ctx.now,
      result: matched ? 'MATCHED' : 'EXCEPTION',
      policy: {
        priceTolBp: policy.priceTolBp,
        priceTolAmount: satangToAmount(policy.priceTolSatang),
        qtyTolBp: policy.qtyTolBp,
        vatTolAmount: satangToAmount(policy.vatTolSatang),
        vatRateBp: rate.rateBp,
      },
      snapshot: {
        lines: lineResults.map(({ l }) => ({ lineNo: l.line, poLineNo: l.poLine, net: satangToAmount(l.netSatang), expected: satangToAmount(l.expectedSatang), over: satangToAmount(l.overSatang), flags: [...l.flags] })),
        vat: { rateBp: vat.rateBp, computed: satangToAmount(vat.computedVatSatang), stated: satangToAmount(invoice.statedVatSatang), status: vat.status },
        possibleDuplicates: duplicates.soft.map((s) => ({ invoiceNo: s.invoiceNo, days: s.days })),
      },
      triggeredBy: trigger,
    },
    select: { id: true },
  })
  for (const { invoiceLine, l, status } of lineResults) {
    await tx.invoiceLine.update({
      where: { id: invoiceLine.id },
      data: { discountSatang: l.discountSatang, netSatang: l.netSatang, expectedNetSatang: l.expectedSatang, overSatang: l.overSatang, matchStatus: status, flags: [...l.flags] },
    })
  }
  // The invoice's amount before VAT is what the lines came to with the rate of its date (a price with VAT included
  // takes its VAT out at that rate): what the ledger moves and what is owed (INV-AP-02, BR-VAT-07)
  const netSatang = result.lines.reduce((a, l) => a + l.netSatang, 0n)
  const grossSatang = netSatang + invoice.statedVatSatang
  const retentionSatang = retentionOf(netSatang, invoice.retentionBp)
  await tx.invoice.update({ where: { id: invoice.id }, data: { netSatang, grossSatang, retentionSatang, payableSatang: grossSatang - retentionSatang } })
  // An earlier run's open differences are settled by this one; what is still wrong is raised again
  await tx.matchException.updateMany({ where: { invoiceId: invoice.id, status: 'OPEN' }, data: { status: 'RESOLVED', resolvedAt: ctx.now, version: { increment: 1 } } })
  if (exceptions.length > 0) {
    await tx.matchException.createMany({
      data: exceptions.map((e) => ({
        organizationId: ctx.organizationId,
        invoiceId: invoice.id,
        invoiceMatchId: match.id,
        invoiceLineId: e.lineNo === null ? null : invoice.lines[e.lineNo - 1]!.id,
        type: e.type,
        amountSatang: e.amountSatang,
        quantity: e.quantity,
        assigneeRole: ASSIGNEE_OF[e.type],
      })),
    })
  }
  const summary = exceptions.map((e) => ({ type: e.type, amountSatang: e.amountSatang, lineNo: e.lineNo }))
  if (!matched) {
    await tx.invoice.update({ where: { id: invoice.id }, data: { status: 'EXCEPTION', matchResult: 'EXCEPTION', computedVatSatang: vat.computedVatSatang, vatRateBp: vat.rateBp, version: { increment: 1 } } })
    const events: EventDraft[] = [
      { type: 'invoice.exception_raised', aggregateType: 'Invoice', aggregateId: invoice.id, data: { matchId: match.id, runNo, exceptions: summary.map((e) => ({ ...e, amountSatang: e.amountSatang.toString() })) } },
    ]
    const notifications = await exceptionNotices(tx, ctx, { id: invoice.id, number: invoice.number, poId: po.id }, match.id, exceptions)
    const doaAmount = result.doaAmount && exceptions.every((e) => e.type === 'PRICE_OVER') ? { netSatang: result.doaAmount.netSatang, vatSatang: result.doaAmount.vatSatang, lineNo: result.doaAmount.line } : null
    return { ok: true, data: { matchId: match.id, runNo, status: 'EXCEPTION', exceptions: summary, events, notifications, doaAmount } }
  }

  // BR-MATCH-11, BR-MATCH-04: per PO line, hold what it lacks, then move the invoice's amount to ACTUAL; the last
  // invoice of a closed PO gives back what the PO's lines still hold (BR-BUD-06)
  const document = { type: 'PURCHASE_ORDER' as const, id: po.id }
  const operations: BudgetOperation[] = []
  for (const m of result.poLineMoves) {
    const poLine = poLineOfNo.get(m.poLine)!
    if (m.holdMoreSatang > 0n) operations.push({ budgetLineId: poLine.budgetLineId, document, run: (s) => holdMore(s, poLine.id, m.holdMoreSatang) })
    if (m.actualSatang > 0n) operations.push({ budgetLineId: poLine.budgetLineId, document, run: (s) => actualize(s, poLine.id, m.actualSatang) })
  }
  if (invoice.isFinal && po.status === 'CLOSED') {
    for (const poLine of po.lines) operations.push({ budgetLineId: poLine.budgetLineId, document, run: (s) => closePo(s, poLine.id, 0n) })
  }
  const budget = await applyBudget(tx, ctx, operations)
  // The engine read the same locked balances, so a refusal here means the data changed under the lock: never expected
  if (!budget.ok) throw new Error(`budget refused a matched invoice: ${budget.error.code}`)

  const supplier = await tx.supplier.findUniqueOrThrow({ where: { id: invoice.supplierId }, select: { paymentTermDays: true } })
  const due = dueDate({ invoiceDate, poTermDays: po.paymentTermDays, supplierTermDays: supplier.paymentTermDays, defaultTermDays: policy.defaultTermDays })
  const payable = grossSatang - retentionSatang
  // BR-WHT-05: the tax expected when it is paid alone, from the lines' income types (the lines carry their amounts now)
  const expectedWht = await expectedWhtOf(tx, org.settings, invoice.id)
  await tx.invoice.update({
    where: { id: invoice.id },
    data: {
      status: 'READY_FOR_PAYMENT',
      expectedWhtSatang: expectedWht,
      matchResult: 'MATCHED',
      computedVatSatang: vat.computedVatSatang,
      vatRateBp: vat.rateBp,
      payableSatang: payable,
      dueDate: new Date(`${due}T00:00:00Z`),
      readyAt: ctx.now,
      version: { increment: 1 },
    },
  })
  const sum = (pick: (m: (typeof result.poLineMoves)[number]) => Satang) => result.poLineMoves.reduce((a, m) => a + pick(m), 0n).toString()
  const events: EventDraft[] = [
    { type: 'invoice.matched', aggregateType: 'Invoice', aggregateId: invoice.id, data: { matchId: match.id, runNo, netSatang: result.netSatang.toString() } },
    {
      type: 'invoice.ready',
      aggregateType: 'Invoice',
      aggregateId: invoice.id,
      data: {
        dueDate: due,
        payableSatang: payable.toString(),
        expectedWhtSatang: expectedWht.toString(),
        actualSatang: sum((m) => m.actualSatang),
        holdMoreSatang: sum((m) => m.holdMoreSatang),
        releasedSatang: invoice.isFinal && po.status === 'CLOSED' ? sum((m) => m.releaseSatang) : '0',
      },
    },
    ...budget.events,
    // BR-RET-04: the retention is held from now on
    ...(await holdRetentionOfInvoice(tx, ctx, { id: invoice.id, poId: invoice.poId, supplierId: invoice.supplierId, retentionSatang })),
  ]
  return { ok: true, data: { matchId: match.id, runNo, status: 'READY_FOR_PAYMENT', exceptions: [], events, notifications: [], doaAmount: null } }
}

/**
 * BR-MATCH-09, FR-AP-103 AC1: each role a difference is sent to hears of the invoice once per run — PROCUREMENT and
 * FINANCE by role, the receiver side through the receivers of the departments that asked for the goods. The data names
 * the invoice, the PO and the kinds and total of the differences only, never a line or a unit price (BR-AP-09).
 */
async function exceptionNotices(tx: TenantTx, ctx: Ctx, invoice: { id: string; number: string | null; poId: string }, matchId: string, exceptions: readonly Exception[]): Promise<NotificationDraft[]> {
  const byRole = new Map<string, Exception[]>()
  for (const e of exceptions) byRole.set(ASSIGNEE_OF[e.type], [...(byRole.get(ASSIGNEE_OF[e.type]) ?? []), e])
  const po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id: invoice.poId }, select: { number: true } })
  const drafts: NotificationDraft[] = []
  for (const [role, list] of byRole) {
    let members: string[]
    if (role === 'RECEIVER') {
      const requests = await tx.request.findMany({ where: { lines: { some: { poSources: { some: { poLine: { poId: invoice.poId } } } } } }, select: { requesterDepartmentId: true } })
      members = await departmentReceivers(tx, ctx.organizationId, [...new Set(requests.map((r) => r.requesterDepartmentId))], ctx.now)
    } else {
      const holders = await tx.roleAssignment.findMany({ where: { role: role as 'PROCUREMENT' | 'FINANCE', revokedAt: null, member: { status: 'ACTIVE' } }, select: { memberId: true }, distinct: ['memberId'] })
      members = holders.map((h) => h.memberId)
    }
    const types = [...new Set(list.map((e) => e.type))]
    const total = list.reduce((a, e) => a + e.amountSatang, 0n)
    for (const memberId of members) {
      drafts.push({
        recipientMemberId: memberId,
        templateKey: 'invoice.exception',
        data: { number: invoice.number, invoiceId: invoice.id, poNumber: po.number, types, totalSatang: total.toString() },
        urgency: 'IMMEDIATE',
        // per role: a member who is both PROCUREMENT and FINANCE hears of the differences of each, not of one only
        dedupeKey: `invoice.exception:${matchId}:${role}:${memberId}`,
        subjectType: 'INVOICE',
        subjectId: invoice.id,
      })
    }
  }
  return drafts
}
