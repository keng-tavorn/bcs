import { TZDate } from '@date-fns/tz'
import { stepUpNeeded } from '@/core/pin'
import { nextRunDate } from '@/core/payment'
import type { BusinessCalendar } from '@/core/sla'
import { taxDateOf } from '@/core/vat'
import { systemClock } from '@/lib/clock'
import { MS_PER_DAY, MS_PER_MINUTE } from '@/lib/constants'
import { paymentSettingsOf } from '@/lib/org-settings'
import { grantStepUp } from '@/server/auth/step-up'
import { makeCtx, type Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { sendSupplierNotice } from '@/server/notifications/supplier-notices'
import { REASON_FLAGS } from '@/server/queries/payment-runs'
import type { Result } from '@/core/result'
import type { RunOptions } from '../_pipeline'
import { decideTask } from '../approvals/decide'
import { generatePaymentFile, markPaymentRunSentToBank, requestPaymentFileDownload } from '../payments/files'
import { recordPaymentResults } from '../payments/results'
import { addPaymentDocuments, createPaymentRun, setPaymentFlagReason, submitPaymentRun } from '../payments/runs'

// S9-10 (docs/sub-specs/S9.md "การอ่านชีตของไฟล์ระยะ 1", BR-PAY-02 BR-PAY-12): the payment runs of the past. Every
// invoice of a Request_History row with paymentStatus PAID — left READY_FOR_PAYMENT by S8-12 — is paid in a weekly run
// on the first run weekday (Friday, OQ-130; a holiday moves it to the working day before) from the day after it became
// ready and from its due date, one run per pay day, through the commands of S9 at the business times of that week:
// fin_tre1 or fin_tre2 (never the one who recorded an invoice of the run, BR-SOD-04) prepares it two working days
// before, explains a flag that needs a reason, and sends it; the approver the DOA route names (PAY-01 cfo, PAY-02 ceo)
// approves with the PIN when it is over the stepUpThreshold; on the pay day the preparer makes the neutral file,
// downloads it and marks it sent, and records every item paid that afternoon. A pay day not before today falls back to
// the last working day before today. The payment advices of the past go to the fake sender of the history (marked sent),
// so no supplier of the demo gets an old e-mail. Every step's events carry the step's key (demo-history:pay:<day>:<step>).

/** What the history's context gives this part */
export interface PaymentHistoryContext {
  readonly organizationId: string
  readonly now: Date
  readonly calendar: BusinessCalendar
  readonly members: ReadonlyMap<string, string>
  readonly pin: string
}

const PREPARERS = ['fin_tre1', 'fin_tre2'] as const
/** Days of the week before the pay day the run is prepared: two working days */
const PREPARE_WORKING_DAYS_BEFORE = 2
const FLAG_REASON = 'ตรวจสถานะกับฝ่ายจัดซื้อแล้ว งานส่งมอบครบก่อนสถานะเปลี่ยน'

export interface PaymentHistoryReport {
  readonly runs: number
  readonly invoices: number
}

const KEY = 'demo-history:pay:'

function must<T>(day: string, what: string, result: Result<T>): T {
  if (!result.ok) throw new Error(`Demo_History payment run of ${day}: ${what} was refused (${result.error.code}${result.error.details ? ` ${JSON.stringify(result.error.details)}` : ''})`)
  return result.data
}

const dayNumber = (day: string) => Math.round(Date.parse(`${day}T00:00:00Z`) / MS_PER_DAY)
const dayOf = (n: number) => new Date(n * MS_PER_DAY).toISOString().slice(0, 10)

export async function seedPaymentHistory(c: PaymentHistoryContext, paidInvoiceNos: ReadonlySet<string>): Promise<PaymentHistoryReport> {
  const db = forTenant(c.organizationId)
  if (paidInvoiceNos.size === 0) return { runs: 0, invoices: 0 }
  const org = await db.organization.findUniqueOrThrow({ where: { id: c.organizationId }, select: { settings: true } })
  const policy = paymentSettingsOf(org.settings)
  const payCalendar = { workdays: c.calendar.workdays, holidays: c.calendar.holidays }
  const isWorkday = (day: string) => {
    const weekday = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][new Date(`${day}T00:00:00Z`).getUTCDay()]!
    return (c.calendar.workdays as readonly string[]).includes(weekday) && !(c.calendar.holidays as readonly string[]).includes(day)
  }
  const today = taxDateOf(c.now)
  const lastWorkdayBefore = (day: string) => {
    for (let n = dayNumber(day) - 1; ; n--) if (isWorkday(dayOf(n))) return dayOf(n)
  }
  const at = (day: string, hour: number, minute = 0) => {
    const [y, m, d] = day.split('-').map(Number)
    return new Date(new TZDate(y!, m! - 1, d!, hour, minute, 0, c.calendar.timezone).getTime())
  }
  const member = (code: string) => {
    const id = c.members.get(code)
    if (!id) throw new Error(`Demo_History: no member ${code}`)
    return id
  }
  const ctxOf = (code: string, when: Date, step: string): Ctx => makeCtx({ organizationId: c.organizationId, actor: { type: 'USER', memberId: member(code) }, channel: 'WEB', now: when, requestId: step })
  const optionsOf = (step: string): RunOptions => ({ idempotencyKey: step, sender: null, suppressOutbox: true })

  const invoices = await db.invoice.findMany({
    where: { status: 'READY_FOR_PAYMENT', supplierInvoiceNo: { in: [...paidInvoiceNos] } },
    select: { id: true, dueDate: true, readyAt: true, recordedById: true, supplierInvoiceNo: true },
  })
  // the pay day of each invoice: the first run day from the day after it was ready and from its due date
  const byDay = new Map<string, typeof invoices>()
  for (const invoice of invoices) {
    const ready = taxDateOf(invoice.readyAt ?? c.now)
    const due = invoice.dueDate ? invoice.dueDate.toISOString().slice(0, 10) : ready
    const from = [dayOf(dayNumber(ready) + 1), due].sort().at(-1)!
    let day = nextRunDate(from, policy, payCalendar)
    if (day >= today) day = lastWorkdayBefore(today)
    if (day <= ready) throw new Error(`Demo_History: invoice ${invoice.supplierInvoiceNo} was ready on ${ready} and has no pay day before today`)
    byDay.set(day, [...(byDay.get(day) ?? []), invoice])
  }
  const payer = await db.bankAccount.findFirstOrThrow({ where: { ownerKind: 'ORGANIZATION', status: 'ACTIVE', code: 'CB-01' }, select: { id: true } })

  let runs = 0
  let paid = 0
  for (const [day, group] of [...byDay].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const recorders = new Set(group.map((i) => i.recordedById))
    const preparer = [PREPARERS[runs % PREPARERS.length]!, ...PREPARERS].find((code) => !recorders.has(member(code)))
    if (!preparer) throw new Error(`Demo_History payment run of ${day}: both preparers recorded its invoices (BR-SOD-04)`)
    const step = (name: string) => `${KEY}${day}:${name}`
    // prepared two working days before (after the last invoice became ready), sent half an hour later
    let prepareDay = day
    for (let n = 0; n < PREPARE_WORKING_DAYS_BEFORE; n++) prepareDay = lastWorkdayBefore(prepareDay)
    const lastReady = Math.max(...group.map((i) => (i.readyAt ?? c.now).getTime()))
    const prepareAt = new Date(Math.max(at(prepareDay, 10).getTime(), lastReady + 30 * MS_PER_MINUTE))
    const runId = must(day, 'create', await createPaymentRun(ctxOf(preparer, prepareAt, step('create')), { payerBankAccountId: payer.id, payDate: day }, optionsOf(step('create')))).paymentRunId
    const version = async () => (await db.paymentRun.findUniqueOrThrow({ where: { id: runId }, select: { version: true } })).version
    must(day, 'add documents', await addPaymentDocuments(ctxOf(preparer, prepareAt, step('add')), { paymentRunId: runId, version: await version(), invoiceIds: group.map((i) => i.id) }, optionsOf(step('add'))))
    // a flag that needs the preparer's reason (a supplier whose registry changed, BR-PAY-06)
    const flagged = await db.paymentRunItem.findMany({ where: { paymentRunId: runId, flags: { hasSome: [...REASON_FLAGS] } }, select: { supplierId: true } })
    for (const item of flagged) {
      const s = step(`reason:${item.supplierId}`)
      must(day, 'flag reason', await setPaymentFlagReason(ctxOf(preparer, prepareAt, s), { paymentRunId: runId, version: await version(), supplierId: item.supplierId, reason: FLAG_REASON }, optionsOf(s)))
    }
    const submitAt = new Date(prepareAt.getTime() + 30 * MS_PER_MINUTE)
    const sent = must(day, 'submit', await submitPaymentRun(ctxOf(preparer, submitAt, step('submit')), { paymentRunId: runId, version: await version() }, optionsOf(step('submit'))))

    // the approver the route names, the next morning (the PIN over the stepUpThreshold)
    const task = await db.approvalTask.findFirstOrThrow({
      where: { status: 'OPEN', step: { route: { subjectType: 'PAYMENT_RUN', subjectId: runId } } },
      select: { id: true, assignee: { select: { id: true, employeeCode: true } }, step: { select: { route: { select: { amountSatang: true, doaVersion: { select: { stepUpThresholdSatang: true } } } } } } },
    })
    const approveAt = new Date(Math.max(at(lastWorkdayBefore(day), 9, 30).getTime(), submitAt.getTime() + 60 * MS_PER_MINUTE))
    if (stepUpNeeded({ subjectType: 'PAYMENT_RUN', amountSatang: task.step.route.amountSatang, stepUpThresholdSatang: task.step.route.doaVersion.stepUpThresholdSatang })) {
      const granted = await grantStepUp({ organizationId: c.organizationId, memberId: task.assignee.id, subjectType: 'PAYMENT_RUN', subjectId: runId, method: 'PIN', pin: c.pin, channel: 'WEB' }, systemClock.now(), { sender: null })
      if (!granted.ok) throw new Error(`Demo_History payment run of ${day}: the PIN step-up of ${task.assignee.employeeCode} was refused (${granted.reason})`)
    }
    must(day, 'approve', await decideTask(ctxOf(task.assignee.employeeCode!, approveAt, step('approve')), { taskId: task.id, decision: 'APPROVE', subjectInput: { flagsKey: sent.flagsKey } }, optionsOf(step('approve'))))

    // the pay day: the file, its download, sent to the bank, and the results that afternoon
    must(day, 'file', await generatePaymentFile(ctxOf(preparer, at(day, 9), step('file')), { paymentRunId: runId, version: await version() }, optionsOf(step('file'))))
    const file = await db.paymentFile.findFirstOrThrow({ where: { paymentRunId: runId, status: 'CURRENT' }, select: { id: true } })
    must(day, 'download', await requestPaymentFileDownload(ctxOf(preparer, at(day, 9, 5), step('download')), { paymentRunId: runId, paymentFileId: file.id }, optionsOf(step('download'))))
    must(day, 'sent', await markPaymentRunSentToBank(ctxOf(preparer, at(day, 9, 10), step('sent')), { paymentRunId: runId, version: await version() }, optionsOf(step('sent'))))
    must(day, 'results', await recordPaymentResults(ctxOf(preparer, at(day, 15), step('results')), { paymentRunId: runId, version: await version(), allPaidExcept: { paidOn: day, failed: [] } }, optionsOf(step('results'))))
    runs++
    paid += group.length
  }

  // the advices of the past were sent then: through the history's fake sender, so they are SENT and nobody is e-mailed now
  const advices = await db.supplierNotice.findMany({ where: { templateKey: 'payment.advice', status: 'PENDING' }, select: { id: true } })
  for (const n of advices) await sendSupplierNotice(c.organizationId, n.id, c.now)
  return { runs, invoices: paid }
}
