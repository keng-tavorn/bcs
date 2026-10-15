import { z } from 'zod'
import { PAYMENT_RUN_ITEM_MACHINE, PAYMENT_RUN_MACHINE, transition, type PaymentRunItemState, type PaymentRunState } from '@/core/state-machines'
import { taxDateOf } from '@/core/vat'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { paymentSettingsOf } from '@/lib/org-settings'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import type { TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import type { OutboxDraft } from '@/server/events/outbox'
import type { NotificationDraft } from '@/server/notifications/create'
import { enqueueSupplierNotice } from '@/server/notifications/supplier-notices'
import { PAY_SUPPLIER_TEMPLATES } from '@/server/notifications/supplier-templates-pay'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { fail, type Fail } from '../ap/common'
import { recordInvoicePayment } from '../ap/payment'
import { requireModule } from '../modules'
import { releaseAll } from './runs'

// The results of a payment run sent to the bank (S9-08, FR-PAY-103 AC1 to AC4 AC6, BR-PAY-12 BR-PAY-13 BR-PAY-14,
// OQ-134 OQ-135 OQ-136). FINANCE (paymentRun.recordResult) records each item by hand — the bank's result file has no
// spec yet (OQ-135) — or "paid, all but these": an item PAID on a day from the pay date to today (Thai time) with the
// bank's reference when there is one, or FAILED with a reason. A result is final in phase 1 (undoing it is S9-16).
// PAID calls S8's recordInvoicePayment once for the item, in the same transaction: its invoices and retentions become
// PAID, its tax is written as WithholdingTax rows of the item and one 50 ทวิ (when anything is withheld), and the
// supplier gets one payment advice by e-mail (SupplierNotice payment.advice, unless payment.adviceEmail is off). FAILED
// lets the item's documents go back to S8 marked as released after an export, so the next run flags them
// PREVIOUSLY_EXPORTED. The last result completes the run. The run writes no budget ledger (BR-PAY-14). Free text (the
// failure's reason, the bank's reference) stays on the item, never in Event.data.

const MIN_REASON_LENGTH = 3
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const reference = z.string().trim().min(1).max(100)
const reason = z.string().trim().min(MIN_REASON_LENGTH).max(REASON_MAX_LENGTH)

const ItemResult = z.discriminatedUnion('outcome', [
  z.strictObject({ paymentRunItemId: z.uuid(), outcome: z.literal('PAID'), paidOn: day, bankReference: reference.optional() }),
  z.strictObject({ paymentRunItemId: z.uuid(), outcome: z.literal('FAILED'), reason }),
])
type ItemResult = z.infer<typeof ItemResult>

const RecordInput = z.union([
  z.strictObject({ paymentRunId: z.uuid(), version: z.number().int().min(0), items: z.array(ItemResult).min(1).max(500) }),
  /** "paid, all but these": every item without a result is PAID on paidOn, except the ones listed as FAILED */
  z.strictObject({
    paymentRunId: z.uuid(),
    version: z.number().int().min(0),
    allPaidExcept: z.strictObject({ paidOn: day, bankReference: reference.optional(), failed: z.array(z.strictObject({ paymentRunItemId: z.uuid(), reason })).max(500) }),
  }),
])

async function finance(tx: TenantTx, ctx: Ctx, capability: 'paymentRun.recordResult' | 'paymentAdvice.resend'): Promise<{ ok: true; memberId: string } | Fail> {
  const allowed = await authorize(tx, ctx, capability)
  if (!allowed.ok) return { ok: false, error: allowed.error }
  if (allowed.data.kind !== 'member') return fail('FORBIDDEN', 'only a member records a payment')
  const pay = await requireModule(ctx, 'PAY', tx)
  if (!pay.ok) return { ok: false, error: pay.error }
  return { ok: true, memberId: allowed.data.memberId }
}

/** BR-PAY-12: from the pay date to today (Thai calendar day) */
function checkPaidOn(paidOn: string, payDate: string, now: Date): Fail | null {
  if (Number.isNaN(Date.parse(`${paidOn}T00:00:00Z`)) || new Date(`${paidOn}T00:00:00Z`).toISOString().slice(0, 10) !== paidOn) return fail('VALIDATION_FAILED', 'the date paid is a calendar day', { field: 'paidOn', reason: 'FORMAT' })
  if (paidOn < payDate) return fail('VALIDATION_FAILED', `the date paid ${paidOn} is before the pay date ${payDate}`, { field: 'paidOn', reason: 'PAID_ON_BEFORE_PAY_DATE', payDate })
  if (paidOn > taxDateOf(now)) return fail('VALIDATION_FAILED', `the date paid ${paidOn} is after today`, { field: 'paidOn', reason: 'PAID_ON_FUTURE' })
  return null
}

type ItemRow = Awaited<ReturnType<typeof readItems>>[number]

function readItems(tx: TenantTx, paymentRunId: string) {
  return tx.paymentRunItem.findMany({
    where: { paymentRunId },
    orderBy: { seq: 'asc' },
    include: {
      supplier: { select: { code: true } },
      whtLines: { orderBy: [{ incomeType: 'asc' }, { rateBp: 'asc' }] },
      documents: { where: { status: 'HELD' }, select: { invoiceId: true, retentionId: true, invoice: { select: { number: true, supplierInvoiceNo: true } }, retention: { select: { invoice: { select: { number: true, supplierInvoiceNo: true } } } } } },
    },
  })
}

interface PaidEffects {
  readonly events: EventDraft[]
  readonly outbox: OutboxDraft[]
  readonly notifications: NotificationDraft[]
}

/** One item PAID: S8 records the payment of its documents once, the item keeps the result, the supplier is told */
async function payItem(tx: TenantTx, ctx: Ctx, run: { id: string; number: string }, item: ItemRow, result: { paidOn: string; bankReference?: string | undefined }, memberId: string, adviceEmail: boolean): Promise<({ ok: true } & PaidEffects) | Fail> {
  const invoiceIds = item.documents.flatMap((d) => (d.invoiceId ? [d.invoiceId] : []))
  const retentionIds = item.documents.flatMap((d) => (d.retentionId ? [d.retentionId] : []))
  const paid = await recordInvoicePayment(tx, ctx, {
    invoiceIds,
    retentionIds,
    paymentRunItemId: item.id,
    paidOn: result.paidOn,
    whtLines: item.whtLines.map((l) => ({ incomeType: l.incomeType, rateBp: l.rateBp, baseSatang: l.baseSatang, whtSatang: l.whtSatang })),
  })
  if (!paid.ok) return paid
  // the item's tax was worked out when the run was sent: S8 writes the same (WHT_MISMATCH otherwise)
  if (paid.whtSatang !== item.whtSatang) return fail('VALIDATION_FAILED', 'the tax recorded is not the tax of the item', { field: 'whtLines', reason: 'WHT_MISMATCH' })
  const moved = transition(PAYMENT_RUN_ITEM_MACHINE, item.status as PaymentRunItemState, 'paymentRunItem.paid')
  if (!moved.ok) return fail('INVALID_STATE_TRANSITION', `the item of ${item.supplier.code} has its result already`, { from: item.status, command: 'paymentRunItem.paid', paymentRunItemId: item.id })
  await tx.paymentRunDocument.updateMany({ where: { paymentRunItemId: item.id, status: 'HELD' }, data: { status: 'PAID' } })
  await tx.paymentRunItem.update({ where: { id: item.id }, data: { status: moved.to, paidOn: new Date(`${result.paidOn}T00:00:00Z`), bankReference: result.bankReference ?? null, resultRecordedById: memberId, resultRecordedAt: ctx.now } })
  const events: EventDraft[] = [
    {
      type: 'payment_run_item.paid',
      aggregateType: 'PaymentRunItem',
      aggregateId: item.id,
      data: { paymentRunId: run.id, supplierId: item.supplierId, paidOn: result.paidOn, transferSatang: item.transferSatang.toString(), whtSatang: item.whtSatang.toString(), certificateId: paid.certificateId, documentCount: item.documents.length },
    },
    ...paid.events,
  ]
  if (!adviceEmail) return { ok: true, events, outbox: [], notifications: [] }
  // BR-PAY-13: one advice per paid item, Thai and English, the account as its bank and last four digits only
  const certificate = paid.certificateId ? await tx.whtCertificate.findUniqueOrThrow({ where: { id: paid.certificateId }, select: { number: true, fileId: true } }) : null
  const notice = await enqueueSupplierNotice(tx, ctx, {
    templateKey: PAY_SUPPLIER_TEMPLATES.paymentAdvice,
    supplierId: item.supplierId,
    subjectType: 'PAYMENT_RUN_ITEM',
    subjectId: item.id,
    dedupeKey: `payment_advice:${item.id}`,
    data: await adviceData(tx, run, item, result.paidOn, certificate),
  })
  return { ok: true, events: [...events, ...notice.events], outbox: notice.outbox, notifications: notice.notifications }
}

/** What the payment advice shows (supplier-templates-pay.ts): numbers, amounts in satang, no account number whole */
async function adviceData(tx: TenantTx, run: { number: string }, item: ItemRow, paidOn: string, certificate: { number: string; fileId: string | null } | null): Promise<Record<string, unknown>> {
  const types = await tx.whtIncomeType.findMany({ where: { code: { in: item.whtLines.map((l) => l.incomeType) } }, select: { code: true, nameTh: true } })
  const docNumber = (i: { number: string | null; supplierInvoiceNo: string | null } | null | undefined) => i?.supplierInvoiceNo ?? i?.number ?? ''
  return {
    number: run.number,
    paidOn,
    supplierCode: item.supplier.code,
    transferSatang: item.transferSatang.toString(),
    payableSatang: item.payableSatang.toString(),
    whtSatang: item.whtSatang.toString(),
    invoices: item.documents.filter((d) => d.invoiceId).map((d) => docNumber(d.invoice)),
    retentions: item.documents.filter((d) => d.retentionId).map((d) => docNumber(d.retention?.invoice)),
    wht: item.whtLines.map((l) => ({ incomeType: l.incomeType, incomeName: types.find((t) => t.code === l.incomeType)?.nameTh ?? '', rateBp: l.rateBp, baseSatang: l.baseSatang.toString(), whtSatang: l.whtSatang.toString() })),
    bankCode: item.payeeBankCode ?? '',
    last4: (item.payeeAccountNo ?? '').slice(-4),
    certificateNumber: certificate?.number ?? null,
    certificateFileId: certificate?.fileId ?? null,
  }
}

// ---------- paymentRun.recordResults ----------

export const recordPaymentResultsCommand = defineCommand({
  name: 'paymentRun.recordResults',
  capability: 'paymentRun.recordResult',
  input: RecordInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ paymentRunId: string; paid: number; failed: number; completed: boolean }>> {
    const who = await finance(tx, ctx, 'paymentRun.recordResult')
    if (!who.ok) return who
    const [locked] = await lockRowsForUpdate(tx, 'PaymentRun', ctx.organizationId, [input.paymentRunId])
    const run = locked ? await tx.paymentRun.findFirst({ where: { id: input.paymentRunId } }) : null
    if (!run) return fail('NOT_FOUND', 'payment run not found')
    const recording = transition(PAYMENT_RUN_MACHINE, run.status as PaymentRunState, 'paymentRun.recordResults')
    if (!recording.ok) return fail('INVALID_STATE_TRANSITION', `results are recorded for a run sent to the bank, not ${run.status}`, { from: run.status, command: 'paymentRun.recordResults' })
    if (run.version !== input.version) return fail('CONFLICT_VERSION', 'the run changed since it was read', { version: run.version })
    const items = await readItems(tx, run.id)
    const open = items.filter((i) => i.status === 'INCLUDED')
    // the results asked for, item by item
    const results: ItemResult[] =
      'items' in input
        ? input.items
        : [
            ...input.allPaidExcept.failed.map((f) => ({ paymentRunItemId: f.paymentRunItemId, outcome: 'FAILED' as const, reason: f.reason })),
            ...open.filter((i) => !input.allPaidExcept.failed.some((f) => f.paymentRunItemId === i.id)).map((i) => ({ paymentRunItemId: i.id, outcome: 'PAID' as const, paidOn: input.allPaidExcept.paidOn, bankReference: input.allPaidExcept.bankReference })),
          ]
    if (new Set(results.map((r) => r.paymentRunItemId)).size !== results.length) return fail('VALIDATION_FAILED', 'name each item once', { field: 'items', reason: 'TWICE' })
    if (results.length === 0) return fail('VALIDATION_FAILED', 'every item has its result already', { field: 'items', reason: 'REQUIRED' })
    const payDate = run.payDate.toISOString().slice(0, 10)
    for (const r of results) {
      const item = items.find((i) => i.id === r.paymentRunItemId)
      if (!item) return fail('NOT_FOUND', 'no such item in the run', { paymentRunItemId: r.paymentRunItemId })
      if (item.status !== 'INCLUDED') return fail('INVALID_STATE_TRANSITION', `the item of ${item.supplier.code} has its result already`, { from: item.status, command: r.outcome === 'PAID' ? 'paymentRunItem.paid' : 'paymentRunItem.failed', paymentRunItemId: item.id })
      if (r.outcome === 'PAID') {
        const date = checkPaidOn(r.paidOn, payDate, ctx.now)
        if (date) return date
      }
    }

    const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true } })
    const adviceEmail = paymentSettingsOf(org.settings).adviceEmail
    const events: EventDraft[] = []
    const outbox: OutboxDraft[] = []
    const notifications: NotificationDraft[] = []
    const number = run.number ?? ''
    let paid = 0
    let failed = 0
    for (const r of results) {
      const item = items.find((i) => i.id === r.paymentRunItemId)!
      if (r.outcome === 'PAID') {
        const done = await payItem(tx, ctx, { id: run.id, number }, item, r, who.memberId, adviceEmail)
        if (!done.ok) return done
        events.push(...done.events)
        outbox.push(...done.outbox)
        notifications.push(...done.notifications)
        paid++
      } else {
        // the documents back to S8, ready for payment and flagged PREVIOUSLY_EXPORTED in the next run (BR-PAY-06)
        const released = await releaseAll(tx, ctx, run.id, r.reason, true, [item.id])
        if (!released.ok) return released
        const moved = transition(PAYMENT_RUN_ITEM_MACHINE, item.status as PaymentRunItemState, 'paymentRunItem.failed')
        if (!moved.ok) return fail('INVALID_STATE_TRANSITION', `the item of ${item.supplier.code} has its result already`, { from: item.status, command: 'paymentRunItem.failed', paymentRunItemId: item.id })
        await tx.paymentRunItem.update({ where: { id: item.id }, data: { status: moved.to, failureReason: r.reason, resultRecordedById: who.memberId, resultRecordedAt: ctx.now } })
        events.push({ type: 'payment_run_item.failed', aggregateType: 'PaymentRunItem', aggregateId: item.id, data: { paymentRunId: run.id, supplierId: item.supplierId, documentCount: released.count } }, ...released.events)
        failed++
      }
    }
    // BR-PAY-12: every item has its result → COMPLETED
    const left = open.length - results.length
    const completed = left === 0
    if (completed) {
      const all = await tx.paymentRunItem.findMany({ where: { paymentRunId: run.id }, select: { status: true, transferSatang: true } })
      const paidItems = all.filter((i) => i.status === 'PAID')
      await tx.paymentRun.update({ where: { id: run.id }, data: { status: 'COMPLETED', completedAt: ctx.now, version: { increment: 1 } } })
      events.push({
        type: 'payment_run.completed',
        aggregateType: 'PaymentRun',
        aggregateId: run.id,
        data: { number, paidItems: paidItems.length, failedItems: all.length - paidItems.length, paidTransferSatang: paidItems.reduce((a, i) => a + i.transferSatang, 0n).toString() },
      })
    } else {
      await tx.paymentRun.update({ where: { id: run.id }, data: { version: { increment: 1 } } })
    }
    return { ok: true, result: { paymentRunId: run.id, paid, failed, completed }, events, outbox, notifications }
  },
})

export function recordPaymentResults(ctx: Ctx, input: z.input<typeof RecordInput>, options: RunOptions) {
  return runCommand(ctx, recordPaymentResultsCommand, input, options)
}

// ---------- paymentAdvice.resend ----------

const ResendInput = z.strictObject({ paymentRunItemId: z.uuid(), reason })

export const resendPaymentAdviceCommand = defineCommand({
  name: 'paymentAdvice.resend',
  capability: 'paymentAdvice.resend',
  input: ResendInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ paymentRunItemId: string; noticeId: string | null; status: string }>> {
    const who = await finance(tx, ctx, 'paymentAdvice.resend')
    if (!who.ok) return who
    // the run's lock serializes this with the results of its items
    const runOf = await tx.paymentRunItem.findFirst({ where: { id: input.paymentRunItemId }, select: { paymentRunId: true } })
    const [locked] = runOf ? await lockRowsForUpdate(tx, 'PaymentRun', ctx.organizationId, [runOf.paymentRunId]) : []
    const item = locked
      ? await tx.paymentRunItem.findFirst({
          where: { id: input.paymentRunItemId },
          include: {
            run: { select: { id: true, number: true } },
            supplier: { select: { code: true } },
            whtLines: { orderBy: [{ incomeType: 'asc' }, { rateBp: 'asc' }] },
            whtCertificate: { select: { number: true, fileId: true } },
            documents: { where: { status: 'PAID' }, select: { invoiceId: true, retentionId: true, invoice: { select: { number: true, supplierInvoiceNo: true } }, retention: { select: { invoice: { select: { number: true, supplierInvoiceNo: true } } } } } },
          },
        })
      : null
    if (!item) return fail('NOT_FOUND', 'payment item not found')
    if (item.status !== 'PAID' || !item.paidOn) return fail('INVALID_STATE_TRANSITION', 'only a paid item has an advice', { from: item.status, command: 'paymentAdvice.resend' })
    // the n-th sending: a key of its own, so the advice goes again however often the first was sent (BR-PAY-13)
    const sent = await tx.supplierNotice.count({ where: { templateKey: PAY_SUPPLIER_TEMPLATES.paymentAdvice, subjectType: 'PAYMENT_RUN_ITEM', subjectId: item.id } })
    const comment = await tx.comment.create({ data: { organizationId: ctx.organizationId, subjectType: 'PaymentRunItem', subjectId: item.id, authorMemberId: who.memberId, body: input.reason }, select: { id: true } })
    const notice = await enqueueSupplierNotice(tx, ctx, {
      templateKey: PAY_SUPPLIER_TEMPLATES.paymentAdvice,
      supplierId: item.supplierId,
      subjectType: 'PAYMENT_RUN_ITEM',
      subjectId: item.id,
      dedupeKey: `payment_advice:${item.id}:r${sent}`,
      data: await adviceData(tx, { number: item.run.number ?? '' }, item, item.paidOn.toISOString().slice(0, 10), item.whtCertificate),
    })
    const status = notice.noticeId ? ((await tx.supplierNotice.findUniqueOrThrow({ where: { id: notice.noticeId }, select: { status: true } })).status as string) : 'DUPLICATE'
    return {
      ok: true,
      result: { paymentRunItemId: item.id, noticeId: notice.noticeId, status },
      events: [{ type: 'payment_run_item.advice_resent', aggregateType: 'PaymentRunItem', aggregateId: item.id, data: { paymentRunId: item.run.id, noticeId: notice.noticeId, reasonCommentId: comment.id } }, ...notice.events],
      outbox: notice.outbox,
      notifications: notice.notifications,
    }
  },
})

export function resendPaymentAdvice(ctx: Ctx, input: z.input<typeof ResendInput>, options: RunOptions) {
  return runCommand(ctx, resendPaymentAdviceCommand, input, options)
}
