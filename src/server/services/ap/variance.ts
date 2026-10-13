import { actualize, closePo, holdMore } from '@/core/budget'
import { dueDate } from '@/core/invoice/ap'
import { approveVariance } from '@/core/matching'
import { satangToAmount } from '@/core/money/dto'
import { apPolicyOf } from '@/lib/org-settings'
import { applyBudget, lockBudgetLines, type BudgetOperation } from '@/server/budget/ledger'
import type { Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import type { TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import type { NotificationDraft } from '@/server/notifications/create'
import type { SubjectDecided, SubjectDecision } from '../approvals/subjects'
import { readyNotice } from './exceptions'
import { expectedWhtOf } from './wht'
import { holdRetentionOfInvoice } from './retention'

// The decision on a price variance (BR-MATCH-11, FR-AP-105 AC3 AC4), called by the INVOICE subject adapter once the
// route has its result. Approved: under the PO's lock, every line holds what it lacks beyond what it holds — the
// PRICE_OVER lines and those over within the tolerance alike — then the invoice moves to ACTUAL and is ready for payment
// with its due date (BR-AP-07); a budget line without enough available refuses the decision (BUDGET_INSUFFICIENT) and
// everything rolls back with the task still open. Returned or rejected: the invoice goes back to EXCEPTION and its price
// differences are open again. The asker and the recorder are told either way. The supplier's ready e-mail is a
// SupplierNotice row the sweep of supplier-notice-send sends (an approval decision carries no outbox).

export async function decideVariance(tx: TenantTx, ctx: Ctx, invoiceId: string, decision: SubjectDecision): Promise<SubjectDecided> {
  const head = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { poId: true } })
  await lockRowsForUpdate(tx, 'PurchaseOrder', ctx.organizationId, [head.poId])
  const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { lines: { orderBy: { lineNo: 'asc' } } } })
  if (invoice.status !== 'PENDING_APPROVAL') return { ok: false, error: { code: 'INVALID_STATE_TRANSITION', message: `the invoice is ${invoice.status}`, details: { from: invoice.status, command: 'invoice.final_approval' } } }
  const told = [...new Set([decision.facts.ownerMemberId, invoice.recordedById].filter((m): m is string => !!m))]
  const notifications = (outcome: string): NotificationDraft[] =>
    told.map((memberId) => ({
      recipientMemberId: memberId,
      templateKey: 'invoice.variance_decided',
      data: { number: invoice.number, invoiceId, outcome },
      urgency: 'IMMEDIATE',
      dedupeKey: `invoice.variance_decided:${invoiceId}:${invoice.version}:${memberId}`,
      subjectType: 'INVOICE',
      subjectId: invoiceId,
    }))

  if (decision.outcome !== 'APPROVED') {
    await tx.matchException.updateMany({ where: { invoiceId, status: 'ACCEPT_REQUESTED' }, data: { status: 'OPEN', version: { increment: 1 } } })
    await tx.invoice.update({ where: { id: invoiceId }, data: { status: 'EXCEPTION', version: { increment: 1 } } })
    const events: EventDraft[] = [{ type: 'invoice.variance_rejected', aggregateType: 'Invoice', aggregateId: invoiceId, data: { decision: decision.outcome, reasonCommentId: decision.reasonCommentId } }]
    return { ok: true, documentStatus: 'EXCEPTION', events, notifications: notifications(decision.outcome) }
  }

  const po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id: invoice.poId }, include: { lines: { orderBy: { lineNo: 'asc' } } } })
  const held = await tx.budgetAllocation.findMany({ where: { sourceType: 'PO_LINE', sourceId: { in: po.lines.map((l) => l.id) } }, select: { sourceId: true, committedSatang: true } })
  const budgetLineIds = [...new Set(po.lines.map((l) => l.budgetLineId))]
  const states = await lockBudgetLines(tx, ctx, budgetLineIds)
  const lineNoOf = new Map(po.lines.map((l) => [l.id, l.lineNo]))
  const poLineOfNo = new Map(po.lines.map((l) => [l.lineNo, l]))
  const approved = approveVariance({
    poLines: po.lines.map((l) => ({ line: l.lineNo, heldSatang: held.find((h) => h.sourceId === l.id)?.committedSatang ?? 0n, budgetLine: l.budgetLineId })),
    available: Object.fromEntries(budgetLineIds.map((id) => [id, states.get(id)?.buckets.available ?? 0n])),
    invoice: {
      discountSatang: invoice.discountSatang,
      priceIncludesVat: invoice.priceIncludesVat,
      isFinal: invoice.isFinal,
      lines: invoice.lines.map((l) => ({ poLine: lineNoOf.get(l.poLineId)!, qty: l.quantity.toString(), unitPriceSatang: l.unitPriceSatang, vatable: l.vatable })),
    },
    poClosed: po.status === 'CLOSED',
    vatRateBp: invoice.vatRateBp ?? 0,
  })
  if (!approved.ok) {
    const available = states.get(approved.budgetLine)?.buckets.available ?? 0n
    return { ok: false, error: { code: 'BUDGET_INSUFFICIENT', message: 'not enough budget left for the variance', details: { available: satangToAmount(available), shortfall: satangToAmount(approved.shortfallSatang) } } }
  }
  const document = { type: 'PURCHASE_ORDER' as const, id: po.id }
  const operations: BudgetOperation[] = []
  for (const m of approved.poLineMoves) {
    const poLine = poLineOfNo.get(m.poLine)!
    if (m.holdMoreSatang > 0n) operations.push({ budgetLineId: poLine.budgetLineId, document, run: (s) => holdMore(s, poLine.id, m.holdMoreSatang) })
    if (m.actualSatang > 0n) operations.push({ budgetLineId: poLine.budgetLineId, document, run: (s) => actualize(s, poLine.id, m.actualSatang) })
  }
  if (invoice.isFinal && po.status === 'CLOSED') for (const poLine of po.lines) operations.push({ budgetLineId: poLine.budgetLineId, document, run: (s) => closePo(s, poLine.id, 0n) })
  const budget = await applyBudget(tx, ctx, operations)
  if (!budget.ok) return { ok: false, error: budget.error }

  const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true } })
  const supplier = await tx.supplier.findUniqueOrThrow({ where: { id: invoice.supplierId }, select: { paymentTermDays: true } })
  const invoiceDate = invoice.invoiceDate!.toISOString().slice(0, 10)
  const due = dueDate({ invoiceDate, poTermDays: po.paymentTermDays, supplierTermDays: supplier.paymentTermDays, defaultTermDays: apPolicyOf(org.settings).defaultTermDays })
  const payable = invoice.grossSatang - invoice.retentionSatang
  const expectedWht = await expectedWhtOf(tx, org.settings, invoiceId)
  await tx.matchException.updateMany({ where: { invoiceId, status: 'ACCEPT_REQUESTED' }, data: { status: 'APPROVED', resolvedAt: ctx.now, version: { increment: 1 } } })
  await tx.invoice.update({ where: { id: invoiceId }, data: { status: 'READY_FOR_PAYMENT', payableSatang: payable, expectedWhtSatang: expectedWht, dueDate: new Date(`${due}T00:00:00Z`), readyAt: ctx.now, version: { increment: 1 } } })
  // the outbox of the e-mail is left to the sweep (an approval decision carries no outbox)
  const notice = await readyNotice(tx, ctx, invoiceId)
  const moves = approved.poLineMoves
  const sum = (pick: (m: (typeof moves)[number]) => bigint) => moves.reduce((a, m) => a + pick(m), 0n).toString()
  const events: EventDraft[] = [
    { type: 'invoice.variance_approved', aggregateType: 'Invoice', aggregateId: invoiceId, data: { holdMoreSatang: sum((m) => m.holdMoreSatang) } },
    {
      type: 'invoice.ready',
      aggregateType: 'Invoice',
      aggregateId: invoiceId,
      data: { dueDate: due, payableSatang: payable.toString(), expectedWhtSatang: expectedWht.toString(), actualSatang: sum((m) => m.actualSatang), holdMoreSatang: sum((m) => m.holdMoreSatang), releasedSatang: invoice.isFinal && po.status === 'CLOSED' ? sum((m) => m.releaseSatang) : '0' },
    },
    ...budget.events,
    ...notice.events,
    ...(await holdRetentionOfInvoice(tx, ctx, { id: invoiceId, poId: invoice.poId, supplierId: invoice.supplierId, retentionSatang: invoice.retentionSatang })),
  ]
  return { ok: true, documentStatus: 'READY_FOR_PAYMENT', events, notifications: [...notifications('APPROVED'), ...notice.notifications] }
}
