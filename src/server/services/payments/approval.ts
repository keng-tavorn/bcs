import { checkPayDate } from '@/core/payment'
import { type RecentBankChanges } from '@/core/sod'
import { PAYMENT_RUN_MACHINE, transition, type PaymentRunCommand, type PaymentRunState } from '@/core/state-machines'
import { taxDateOf } from '@/core/vat'
import { paymentSettingsOf } from '@/lib/org-settings'
import type { Ctx } from '@/server/context'
import { loadBusinessCalendar } from '@/server/doa/policy'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import type { TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import type { NotificationDraft } from '@/server/notifications/create'
import { REASON_FLAGS, runFlagsNow, supplierFacts } from '@/server/queries/payment-runs'
import type { SubjectDecided, SubjectDecision } from '../approvals/subjects'
import { requireModule } from '../modules'
import { invoiceRecordersOf, releaseAll } from './runs'

// The decision of DOA PAYMENT_RUN (S9-06, FR-PAY-101 AC5 AC8 AC9, BR-PAY-07, BR-PAY-08, BR-SOD-04 BR-SOD-09 BR-SOD-10).
// The shared approvals/decide.ts has checked the decider's separation of duties (the adapter's sodContext: the preparer,
// the recorders of the run's invoices, the proposers of a recent change of its accounts), the step-up at the version's
// stepUpThreshold and the channel; then the route's result comes here. The last approval is the approver's word on the
// flags they were shown: the flags are worked out again now, and a key that is not the one the decision page showed —
// the chat button shows none — is PAYMENT_FLAGS_CHANGED; a flag that needs the preparer's reason and has none since it
// arose is PAYMENT_FLAG_REASON_REQUIRED (the approver returns the run; they never write it); a pay date gone by is
// PAYMENT_DATE_INVALID. Each refusal rolls the whole decision back and the task stays open. A rejection lets every
// document go back to S8; a return keeps them held for the preparer. The preparer hears every decision.

/** What the adapter of PAYMENT_RUN needs beyond SubjectFacts: who may not approve and the flags its card was sent with */
export interface RunApprovalFacts {
  readonly invoiceRecorderMemberIds: readonly string[]
  readonly recentBankChanges: RecentBankChanges
  /** The flags key written at sending: '' lets the chat button through (channels.chatButton) */
  readonly sentFlagsKey: string
}

export async function runApprovalFacts(tx: TenantTx, organizationId: string, paymentRunId: string): Promise<RunApprovalFacts | null> {
  const run = await tx.paymentRun.findFirst({ where: { id: paymentRunId }, select: { payDate: true, flagsKey: true } })
  if (!run) return null
  const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { settings: true } })
  // the accounts the run pays into: the items' snapshot once sent (ADR-133), the accounts in force while a draft
  const items = await tx.paymentRunItem.findMany({ where: { paymentRunId }, select: { supplierId: true, bankAccountId: true } })
  const snapshot = items.flatMap((i) => (i.bankAccountId ? [i.bankAccountId] : []))
  const accounts = snapshot.length
    ? (await tx.bankAccount.findMany({ where: { id: { in: snapshot } }, select: { activatedAt: true, createdAt: true, sourceChange: { select: { submittedById: true } } } })).map((a) => ({ proposerMemberId: a.sourceChange?.submittedById ?? null, activatedOn: taxDateOf(a.activatedAt ?? a.createdAt) }))
    : [...(await supplierFacts(tx, items.map((i) => i.supplierId))).values()].flatMap((f) => (f.account ? [{ proposerMemberId: f.account.proposerMemberId, activatedOn: f.account.activatedOn }] : []))
  const changes = accounts.flatMap((a) => (a.proposerMemberId ? [{ proposerMemberId: a.proposerMemberId, effectiveOn: a.activatedOn }] : []))
  return {
    invoiceRecorderMemberIds: await invoiceRecordersOf(tx, paymentRunId),
    recentBankChanges: { payDate: run.payDate.toISOString().slice(0, 10), recentBankChangeDays: paymentSettingsOf(org.settings).recentBankChangeDays, changes },
    sentFlagsKey: run.flagsKey ?? '',
  }
}

/** §10.1 payment_run.decided: the preparer hears every decision */
function decidedNotice(run: { id: string; number: string | null; preparedById: string; version: number }, outcome: SubjectDecision['outcome']): NotificationDraft {
  return {
    recipientMemberId: run.preparedById,
    templateKey: 'payment_run.decided',
    data: { paymentRunId: run.id, number: run.number, outcome },
    urgency: 'IMMEDIATE',
    dedupeKey: `payment_run.decided:${run.id}:${run.version}`,
    subjectType: 'PAYMENT_RUN',
    subjectId: run.id,
  }
}

const refused = (code: 'PAYMENT_FLAGS_CHANGED' | 'PAYMENT_FLAG_REASON_REQUIRED' | 'PAYMENT_DATE_INVALID' | 'VALIDATION_FAILED' | 'INVALID_STATE_TRANSITION', message: string, details: Record<string, unknown>): SubjectDecided => ({ ok: false, error: { code, message, details } })

export async function decidePaymentRun(tx: TenantTx, ctx: Ctx, paymentRunId: string, decision: SubjectDecision): Promise<SubjectDecided> {
  const pay = await requireModule(ctx, 'PAY', tx)
  if (!pay.ok) return { ok: false, error: pay.error }
  const command: PaymentRunCommand = decision.outcome === 'APPROVED' ? 'paymentRun.final_approval' : decision.outcome === 'RETURNED' ? 'approval.return' : 'approval.reject'
  const [locked] = await lockRowsForUpdate(tx, 'PaymentRun', ctx.organizationId, [paymentRunId])
  const run = locked ? await tx.paymentRun.findFirst({ where: { id: paymentRunId } }) : null
  // A route of this subject without its run (the tests of the shared base): refused as the empty adapter was
  if (!run) return refused('VALIDATION_FAILED', 'no payment run for this task', { reason: 'SUBJECT' })
  const moved = transition(PAYMENT_RUN_MACHINE, run.status as PaymentRunState, command)
  if (!moved.ok) return refused('INVALID_STATE_TRANSITION', `${command} is not allowed from ${run.status}`, { from: run.status, command })
  const number = run.number ?? ''
  const events: EventDraft[] = []

  if (decision.outcome === 'APPROVED') {
    // BR-PAY-02: the pay date is still a working day, today or later
    const calendar = await loadBusinessCalendar(tx, ctx.organizationId)
    const payDate = run.payDate.toISOString().slice(0, 10)
    const date = checkPayDate(payDate, ctx.now, { workdays: calendar.workdays, holidays: calendar.holidays })
    if (!date.ok) return refused('PAYMENT_DATE_INVALID', `the pay date ${payDate} cannot be used`, { date: payDate, reason: date.reason })
    // BR-PAY-07: the flags now are the flags the approver was shown
    const now = (await runFlagsNow(tx, ctx.organizationId, run.id))!
    const shown = (decision.subjectInput as { flagsKey?: string } | undefined)?.flagsKey ?? ''
    if (shown !== now.flagsKey) return refused('PAYMENT_FLAGS_CHANGED', 'the flags of the run changed since the page was opened', { shown, now: now.flagsKey })
    // a flag that needs the preparer's reason and arose after it was given (or has none) is the preparer's to explain
    const unexplained = now.items.find((i) => i.requiresReason && (!i.flagReason || i.flags.some((f) => REASON_FLAGS.includes(f) && !i.storedFlags.includes(f))))
    if (unexplained) {
      const flag = unexplained.flags.find((f) => REASON_FLAGS.includes(f) && (!unexplained.flagReason || !unexplained.storedFlags.includes(f)))!
      return refused('PAYMENT_FLAG_REASON_REQUIRED', `the item of ${unexplained.supplier.code} has flag ${flag} without the preparer's reason: return the run`, { supplier: unexplained.supplier.code, flag })
    }
    await tx.paymentRun.update({ where: { id: run.id }, data: { status: moved.to, approvedAt: ctx.now, version: { increment: 1 } } })
    events.push({ type: 'payment_run.approved', aggregateType: 'PaymentRun', aggregateId: run.id, data: { number, flagsKey: now.flagsKey, totalTransferSatang: run.totalTransferSatang.toString() } })
  } else if (decision.outcome === 'REJECTED') {
    // every document back to S8, ready for payment again (FR-PAY-101 AC9)
    const released = await releaseAll(tx, ctx, run.id, decision.reason ?? 'ไม่อนุมัติรอบจ่าย', false)
    if (!released.ok) return { ok: false, error: released.error }
    await tx.paymentRun.update({ where: { id: run.id }, data: { status: moved.to, currentRouteId: null, version: { increment: 1 } } })
    events.push({ type: 'payment_run.rejected', aggregateType: 'PaymentRun', aggregateId: run.id, data: { number, reasonCommentId: decision.reasonCommentId, documentCount: released.count } }, ...released.events)
  } else {
    // back to the preparer's draft, the documents still held (BR-PAY-09)
    await tx.paymentRun.update({ where: { id: run.id }, data: { status: moved.to, currentRouteId: null, version: { increment: 1 } } })
    events.push({ type: 'payment_run.returned', aggregateType: 'PaymentRun', aggregateId: run.id, data: { number, reasonCommentId: decision.reasonCommentId } })
  }
  return { ok: true, documentStatus: moved.to, events, notifications: [decidedNotice(run, decision.outcome)] }
}
