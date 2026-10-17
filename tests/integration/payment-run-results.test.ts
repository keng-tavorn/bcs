import { randomUUID } from 'node:crypto'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { setEmailProvider, EmailSendError } from '@/integrations/email-provider'
import type { Ctx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { renderNotification } from '@/server/notifications/templates'
import { sendSupplierNotice } from '@/server/notifications/supplier-notices'
import { decideTask } from '@/server/services/approvals/decide'
import { generatePaymentFile, markPaymentRunSentToBank, requestPaymentFileDownload } from '@/server/services/payments/files'
import { recordPaymentResults, resendPaymentAdvice } from '@/server/services/payments/results'
import { submitPaymentRun } from '@/server/services/payments/runs'
import { AP_NOW, fin, key, ok } from '../support/ap'
import { attachmentOf, messagesTo } from '../support/mailpit'
import { addDocs, draftRun, paySupplier, payOrg, readyInvoice, releasableRetention, runVersion, type PayOrg } from '../support/pay'
import { stepUpForTask } from '../support/pin'

// S9-08 (FR-PAY-103 AC1 to AC4 AC6, BR-PAY-12 BR-PAY-13 BR-PAY-14, OQ-134 OQ-135 OQ-136): FINANCE records the result of
// each item of a run sent to the bank, by hand, or "paid, all but these". PAID calls S8 once per item in the same
// transaction — the documents PAID, the tax as WithholdingTax rows of the item adding up to its tax, one 50 ทวิ — and
// the supplier gets one payment advice by e-mail with the 50 ทวิ attached, its account by the last four digits only.
// FAILED sends the documents back to S8, flagged PREVIOUSLY_EXPORTED in the next run. A failure part way changes
// nothing. The last result completes the run; a run writes no budget ledger.

let ap: PayOrg
const DUE = '2026-10-15'
/** Monday 19 Oct 2026, 10:00 in Bangkok: after the runs' pay date (Friday 16 Oct) */
const LATER = new Date('2026-10-19T03:00:00Z')
const at = (code = 'fin_officer', now = LATER): Ctx => ap.org.ctxOf(code, now)
const codeOf = (memberId: string) => Object.entries(ap.org.member).find(([, id]) => id === memberId)![0]
const runOf = (runId: string) => prisma.paymentRun.findUniqueOrThrow({ where: { id: runId } })
const itemsOf = (runId: string) => prisma.paymentRunItem.findMany({ where: { paymentRunId: runId }, orderBy: { seq: 'asc' }, include: { supplier: true } })

/** One supplier each: invoices (service ones withhold 3%) and retentions; the run sent, approved, its file downloaded and sent to the bank */
async function sentToBank(suppliers: Array<{ service?: boolean; retention?: bigint; email?: boolean }>, beforeRun: () => Promise<void> = async () => {}) {
  const made: Array<{ id: string; code: string; email: string; accountNo: string | null; invoiceId: string; retentionId: string | null }> = []
  for (const s of suppliers) {
    const supplier = await paySupplier(ap)
    if (s.email === false) await prisma.supplier.update({ where: { id: supplier.id }, data: { email: null } })
    const invoiceId = await readyInvoice(ap, supplier.id, '20000.00', '1400.00', DUE, s.service ?? false)
    const retentionId = s.retention ? await releasableRetention(ap, supplier.id, s.retention) : null
    made.push({ ...supplier, invoiceId, retentionId })
  }
  await beforeRun()
  const runId = await draftRun(ap)
  ok(await addDocs(ap, runId, { invoiceIds: made.map((m) => m.invoiceId), retentionIds: made.flatMap((m) => (m.retentionId ? [m.retentionId] : [])) }))
  const sent = ok(await submitPaymentRun(fin(ap), { paymentRunId: runId, version: await runVersion(runId) }, key()))
  const task = (await prisma.approvalTask.findFirst({ where: { status: 'OPEN', step: { route: { subjectType: 'PAYMENT_RUN', subjectId: runId } } } }))!
  await stepUpForTask(task.id, task.assigneeMemberId)
  ok(await decideTask(ap.org.ctxOf(codeOf(task.assigneeMemberId), AP_NOW), { taskId: task.id, decision: 'APPROVE', ...(sent.flagsKey ? { subjectInput: { flagsKey: sent.flagsKey } } : {}) }, key()))
  const file = ok(await generatePaymentFile(fin(ap), { paymentRunId: runId, version: await runVersion(runId) }, key()))
  ok(await requestPaymentFileDownload(fin(ap), { paymentRunId: runId, paymentFileId: file.paymentFileId }, key()))
  ok(await markPaymentRunSentToBank(fin(ap), { paymentRunId: runId, version: await runVersion(runId) }, key()))
  const items = await itemsOf(runId)
  const itemOf = (supplierId: string) => items.find((i) => i.supplierId === supplierId)!
  return { runId, number: sent.number, suppliers: made, itemOf }
}

const record = async (runId: string, items: unknown[], ctx = at()) => recordPaymentResults(ctx, { paymentRunId: runId, version: await runVersion(runId), items } as never, key())
const allPaidExcept = async (runId: string, body: { paidOn: string; bankReference?: string; failed: Array<{ paymentRunItemId: string; reason: string }> }) =>
  recordPaymentResults(at(), { paymentRunId: runId, version: await runVersion(runId), allPaidExcept: body }, key())
/** Every PENDING advice of the organization sent now, as the job would */
async function sendAdvices() {
  const pending = await prisma.supplierNotice.findMany({ where: { organizationId: ap.org.organizationId, templateKey: 'payment.advice', status: 'PENDING' } })
  for (const n of pending) await sendSupplierNotice(ap.org.organizationId, n.id, LATER)
}

beforeAll(async () => {
  ap = await payOrg()
})
afterEach(() => setEmailProvider(null))

describe('[FR-PAY-103/AC1] results by hand, item by item or "paid, all but these"; final; all recorded → COMPLETED', () => {
  it('a paid day from the pay date to today; a failure needs its reason; a result is not recorded twice; the last one completes the run', async () => {
    const run = await sentToBank([{}, {}, {}])
    const [a, b, c] = run.suppliers.map((s) => run.itemOf(s.id))
    // results only for a run sent to the bank, and only by FINANCE
    expect(await record(run.runId, [{ paymentRunItemId: a!.id, outcome: 'PAID', paidOn: '2026-10-15' }])).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'PAID_ON_BEFORE_PAY_DATE' } } })
    expect(await record(run.runId, [{ paymentRunItemId: a!.id, outcome: 'PAID', paidOn: '2026-10-20' }])).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'PAID_ON_FUTURE' } } })
    expect(await record(run.runId, [{ paymentRunItemId: b!.id, outcome: 'FAILED', reason: '' }])).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(await record(run.runId, [{ paymentRunItemId: randomUUID(), outcome: 'FAILED', reason: 'ไม่มีรายการนี้' }])).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })

    expect(ok(await record(run.runId, [{ paymentRunItemId: a!.id, outcome: 'PAID', paidOn: '2026-10-16', bankReference: 'TRX-778812' }, { paymentRunItemId: b!.id, outcome: 'FAILED', reason: 'บัญชีปิดแล้ว ธนาคารคืนเงิน' }]))).toEqual({ paymentRunId: run.runId, paid: 1, failed: 1, completed: false })
    expect(await prisma.paymentRunItem.findUniqueOrThrow({ where: { id: a!.id } })).toMatchObject({ status: 'PAID', paidOn: new Date('2026-10-16T00:00:00Z'), bankReference: 'TRX-778812', resultRecordedById: ap.org.member.fin_officer, resultRecordedAt: LATER })
    expect(await prisma.paymentRunItem.findUniqueOrThrow({ where: { id: b!.id } })).toMatchObject({ status: 'FAILED', failureReason: 'บัญชีปิดแล้ว ธนาคารคืนเงิน' })
    expect((await runOf(run.runId)).status).toBe('SENT_TO_BANK')
    // recorded once: a result of an item that has one is refused, nothing changes
    expect(await record(run.runId, [{ paymentRunItemId: a!.id, outcome: 'FAILED', reason: 'บันทึกผิด' }])).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION', details: { paymentRunItemId: a!.id } } })
    // the free text stays on the item
    const failedEvent = await prisma.event.findFirstOrThrow({ where: { aggregateId: b!.id, type: 'payment_run_item.failed' } })
    expect(JSON.stringify(failedEvent.data)).not.toContain('บัญชีปิด')
    expect(JSON.stringify((await prisma.event.findFirstOrThrow({ where: { aggregateId: a!.id, type: 'payment_run_item.paid' } })).data)).not.toContain('TRX-778812')
    // nor in the events S8 writes for the documents it lets go: they name the run (BR-BANK-08 · a reason may hold a number)
    const docs = await prisma.paymentRunDocument.findMany({ where: { paymentRunItemId: b!.id } })
    const released = await prisma.event.findMany({ where: { aggregateId: { in: docs.flatMap((d) => [d.invoiceId, d.retentionId].filter((x): x is string => !!x)) }, type: { in: ['invoice.payment_released', 'retention.payment_released'] } } })
    expect(released.length).toBe(docs.length)
    for (const e of released) expect(e.data).toEqual({ paymentRunId: run.runId })

    expect(ok(await record(run.runId, [{ paymentRunItemId: c!.id, outcome: 'PAID', paidOn: '2026-10-19' }]))).toMatchObject({ completed: true })
    expect(await runOf(run.runId)).toMatchObject({ status: 'COMPLETED', completedAt: LATER })
    expect(await prisma.event.findFirstOrThrow({ where: { aggregateId: run.runId, type: 'payment_run.completed' } })).toMatchObject({ data: { paidItems: 2, failedItems: 1, paidTransferSatang: (a!.transferSatang + c!.transferSatang).toString() } })
    expect(await record(run.runId, [{ paymentRunItemId: c!.id, outcome: 'PAID', paidOn: '2026-10-19' }])).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION', details: { from: 'COMPLETED' } } })
  })

  it('"paid, all but these": every item without a result PAID on the day, the ones named FAILED', async () => {
    const run = await sentToBank([{}, {}, {}])
    const [a, b, c] = run.suppliers.map((s) => run.itemOf(s.id))
    ok(await record(run.runId, [{ paymentRunItemId: a!.id, outcome: 'PAID', paidOn: '2026-10-16' }]))
    expect(ok(await allPaidExcept(run.runId, { paidOn: '2026-10-16', bankReference: 'BATCH-1016', failed: [{ paymentRunItemId: c!.id, reason: 'ชื่อบัญชีไม่ตรง' }] }))).toEqual({ paymentRunId: run.runId, paid: 1, failed: 1, completed: true })
    const items = new Map((await itemsOf(run.runId)).map((i) => [i.id, i]))
    expect(items.get(a!.id)).toMatchObject({ status: 'PAID', bankReference: null })
    expect(items.get(b!.id)).toMatchObject({ status: 'PAID', bankReference: 'BATCH-1016', paidOn: new Date('2026-10-16T00:00:00Z') })
    expect(items.get(c!.id)).toMatchObject({ status: 'FAILED', failureReason: 'ชื่อบัญชีไม่ตรง' })
    expect((await runOf(run.runId)).status).toBe('COMPLETED')
  })
})

describe('[FR-PAY-103/AC2] PAID through S8 in the same transaction; FAILED back to ready for payment; a failure part way changes nothing', () => {
  it('a service invoice and a retention paid: both PAID, the tax rows of the item add up to its tax, one 50 ทวิ of the item; a failed item flags its invoice in the next run', async () => {
    const run = await sentToBank([{ service: true, retention: 500_000n }, { retention: 200_000n }])
    const [paid, failed] = run.suppliers
    const paidItem = run.itemOf(paid!.id)
    expect(paidItem.whtSatang).toBeGreaterThan(0n)
    ok(await record(run.runId, [{ paymentRunItemId: paidItem.id, outcome: 'PAID', paidOn: '2026-10-16' }, { paymentRunItemId: run.itemOf(failed!.id).id, outcome: 'FAILED', reason: 'ธนาคารคืนเงิน' }]))
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: paid!.invoiceId } })).status).toBe('PAID')
    expect((await prisma.retention.findUniqueOrThrow({ where: { id: paid!.retentionId! } })).status).toBe('PAID')
    expect((await prisma.paymentRunDocument.findMany({ where: { paymentRunItemId: paidItem.id } })).map((d) => d.status)).toEqual(['PAID', 'PAID'])
    const rows = await prisma.withholdingTax.findMany({ where: { paymentRunItemId: paidItem.id } })
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.reduce((a, r) => a + r.taxSatang, 0n)).toBe(paidItem.whtSatang)
    const certificates = await prisma.whtCertificate.findMany({ where: { paymentRunItemId: paidItem.id } })
    expect(certificates).toHaveLength(1)
    expect(certificates[0]!.totalTaxSatang).toBe(paidItem.whtSatang)
    expect(new Set(rows.map((r) => r.certificateId))).toEqual(new Set([certificates[0]!.id]))

    // the failed item: its invoice ready for payment again, its link released after an export
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: failed!.invoiceId } })).status).toBe('READY_FOR_PAYMENT')
    expect((await prisma.retention.findUniqueOrThrow({ where: { id: failed!.retentionId! } })).status).toBe('RELEASABLE')
    expect((await prisma.paymentRunDocument.findMany({ where: { paymentRunItemId: run.itemOf(failed!.id).id } })).map((d) => [d.status, d.releasedAfterExport])).toEqual([
      ['RELEASED', true],
      ['RELEASED', true],
    ])
    const next = await draftRun(ap)
    ok(await addDocs(ap, next, { invoiceIds: [failed!.invoiceId] }))
    expect((await prisma.paymentRunItem.findFirstOrThrow({ where: { paymentRunId: next } })).flags).toEqual(['PREVIOUSLY_EXPORTED'])
  })

  it('S8 refuses the second item part way: nothing of the run, its invoices, its retention or its notices changed', async () => {
    const run = await sentToBank([{ service: true }, { service: true, retention: 300_000n }])
    const [first, second] = run.suppliers
    // the tax the second item was sent with no longer agrees with its documents (S8: WHT_MISMATCH)
    const line = await prisma.paymentRunItemWht.findFirstOrThrow({ where: { paymentRunItemId: run.itemOf(second!.id).id } })
    await prisma.paymentRunItemWht.update({ where: { id: line.id }, data: { whtSatang: line.whtSatang + 1n } })
    const version = await runVersion(run.runId)
    const refused = await allPaidExcept(run.runId, { paidOn: '2026-10-16', failed: [] })
    expect(refused).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'WHT_MISMATCH' } } })
    expect(await runOf(run.runId)).toMatchObject({ status: 'SENT_TO_BANK', version })
    expect((await itemsOf(run.runId)).map((i) => i.status)).toEqual(['INCLUDED', 'INCLUDED'])
    expect((await prisma.invoice.findMany({ where: { id: { in: [first!.invoiceId, second!.invoiceId] } } })).map((i) => i.status)).toEqual(['IN_PAYMENT_RUN', 'IN_PAYMENT_RUN'])
    expect((await prisma.retention.findUniqueOrThrow({ where: { id: second!.retentionId! } })).status).toBe('IN_PAYMENT_RUN')
    expect(await prisma.withholdingTax.count({ where: { paymentRunItem: { paymentRunId: run.runId } } })).toBe(0)
    expect(await prisma.whtCertificate.count({ where: { paymentRunItem: { paymentRunId: run.runId } } })).toBe(0)
    expect(await prisma.supplierNotice.count({ where: { subjectId: { in: (await itemsOf(run.runId)).map((i) => i.id) } } })).toBe(0)
  })
})

describe('[FR-PAY-103/AC3] one payment advice per paid item by e-mail (BR-PAY-13)', () => {
  it('Thai and English, the 50 ทวิ attached when tax was withheld, the account by its last four digits; recorded again or replayed, no second notice; sent again with a reason', async () => {
    const run = await sentToBank([{ service: true }, {}])
    const [taxed, plain] = run.suppliers
    const taxedItem = run.itemOf(taxed!.id)
    const plainItem = run.itemOf(plain!.id)
    const idem = key()
    const body = { paymentRunId: run.runId, version: await runVersion(run.runId), allPaidExcept: { paidOn: '2026-10-16', failed: [] } }
    ok(await recordPaymentResults(at(), body, idem))
    // the same request again: the stored answer, no second notice
    ok(await recordPaymentResults(at(), body, idem))
    const notices = await prisma.supplierNotice.findMany({ where: { templateKey: 'payment.advice', subjectId: { in: [taxedItem.id, plainItem.id] } } })
    expect(notices.map((n) => [n.subjectId, n.dedupeKey, n.status, n.toEmail]).sort()).toEqual(
      [
        [taxedItem.id, `payment_advice:${taxedItem.id}`, 'PENDING', taxed!.email],
        [plainItem.id, `payment_advice:${plainItem.id}`, 'PENDING', plain!.email],
      ].sort(),
    )
    await sendAdvices()
    await sendAdvices()
    const [taxedMail, ...more] = await messagesTo(taxed!.email)
    expect(more).toHaveLength(0)
    expect(taxedMail!.Subject).toContain(run.number)
    expect(taxedMail!.Text).toContain('โอนเงิน')
    expect(taxedMail!.Text).toContain('transferred THB')
    expect(taxedMail!.Text).toContain(`ลงท้าย ${taxed!.accountNo!.slice(-4)}`)
    expect(taxedMail!.Text).not.toContain(taxed!.accountNo!)
    expect(taxedMail!.HTML).not.toContain(taxed!.accountNo!)
    const certificate = await prisma.whtCertificate.findFirstOrThrow({ where: { paymentRunItemId: taxedItem.id } })
    expect(taxedMail!.Text).toContain(certificate.number)
    expect(taxedMail!.Attachments).toHaveLength(1)
    expect(taxedMail!.Attachments[0]).toMatchObject({ ContentType: 'application/pdf' })
    const pdf = await attachmentOf(taxedMail!, taxedMail!.Attachments[0]!.PartID)
    expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe('%PDF-')
    const [plainMail] = await messagesTo(plain!.email)
    expect(plainMail!.Attachments).toHaveLength(0)
    expect(plainMail!.Text).not.toContain('50 ทวิ')

    // sent again with a reason: a notice of its own key, the reason a Comment of the item
    expect(await resendPaymentAdvice(at('auditor'), { paymentRunItemId: plainItem.id, reason: 'ผู้ขายขอสำเนา' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    const again = ok(await resendPaymentAdvice(at(), { paymentRunItemId: plainItem.id, reason: 'ผู้ขายขอสำเนา' }, key()))
    expect(await prisma.supplierNotice.findUniqueOrThrow({ where: { id: again.noticeId! } })).toMatchObject({ dedupeKey: `payment_advice:${plainItem.id}:r1` })
    await sendAdvices()
    expect(await messagesTo(plain!.email)).toHaveLength(2)
    const resent = await prisma.event.findFirstOrThrow({ where: { aggregateId: plainItem.id, type: 'payment_run_item.advice_resent' } })
    expect((await prisma.comment.findUniqueOrThrow({ where: { id: (resent.data as { reasonCommentId: string }).reasonCommentId } })).body).toBe('ผู้ขายขอสำเนา')
  })

  it('no e-mail address: NO_EMAIL and FINANCE told; the provider refuses: the preparer told; payment.adviceEmail off: no notice', async () => {
    const run = await sentToBank([{ email: false }, {}])
    const [silent, refused] = run.suppliers
    ok(await record(run.runId, [{ paymentRunItemId: run.itemOf(silent!.id).id, outcome: 'PAID', paidOn: '2026-10-16' }]))
    expect(await prisma.supplierNotice.findFirstOrThrow({ where: { subjectId: run.itemOf(silent!.id).id } })).toMatchObject({ status: 'NO_EMAIL' })
    expect(await prisma.notification.count({ where: { templateKey: 'supplier.no_email', recipientMemberId: ap.org.member.fin_officer, data: { path: ['subjectId'], equals: run.itemOf(silent!.id).id } } })).toBe(1)

    ok(await record(run.runId, [{ paymentRunItemId: run.itemOf(refused!.id).id, outcome: 'PAID', paidOn: '2026-10-16' }]))
    setEmailProvider({
      async send() {
        throw new EmailSendError(true, '550')
      },
    })
    await sendAdvices()
    expect(await prisma.supplierNotice.findFirstOrThrow({ where: { subjectId: run.itemOf(refused!.id).id } })).toMatchObject({ status: 'FAILED', error: 'PROVIDER_REFUSED' })
    const told = await prisma.notification.findFirstOrThrow({ where: { templateKey: 'payment_run.advice_failed', subjectId: run.runId } })
    expect(told.recipientMemberId).toBe(ap.org.member.fin_officer)
    expect(renderNotification(told, 'th').title).toBe(`ส่งอีเมลแจ้งการชำระถึงผู้ขาย ${refused!.code} ไม่สำเร็จ (รอบ ${run.number})`)
    setEmailProvider(null)

    // OQ-134: the organization may turn the advice off
    const settings = (await prisma.organization.findUniqueOrThrow({ where: { id: ap.org.organizationId } })).settings as Record<string, unknown>
    await prisma.organization.update({ where: { id: ap.org.organizationId }, data: { settings: { ...settings, payment: { ...(settings.payment as object), adviceEmail: false } } } })
    try {
      const off = await sentToBank([{}])
      ok(await allPaidExcept(off.runId, { paidOn: '2026-10-16', failed: [] }))
      const offItem = off.itemOf(off.suppliers[0]!.id).id
      expect(await prisma.supplierNotice.count({ where: { subjectId: offItem } })).toBe(0)
      expect(await resendPaymentAdvice(at(), { paymentRunItemId: offItem, reason: 'ผู้ขายขอสำเนา' }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'ADVICE_EMAIL_OFF' } } })
    } finally {
      await prisma.organization.update({ where: { id: ap.org.organizationId }, data: { settings: settings as object } })
    }
  })
})

describe('[FR-PAY-103/AC3] an advice whose 50 ทวิ is no longer available', () => {
  it('fails once for good (ATTACHMENT_UNAVAILABLE) instead of throwing, the preparer is told, and the next notice still goes', async () => {
    const run = await sentToBank([{ service: true }, {}])
    const [taxed, plain] = run.suppliers
    ok(await allPaidExcept(run.runId, { paidOn: '2026-10-16', failed: [] }))
    const certificate = await prisma.whtCertificate.findFirstOrThrow({ where: { paymentRunItemId: run.itemOf(taxed!.id).id } })
    await prisma.fileObject.update({ where: { id: certificate.fileId! }, data: { status: 'REJECTED' } })
    try {
      const notices = await prisma.supplierNotice.findMany({ where: { subjectId: { in: [run.itemOf(taxed!.id).id, run.itemOf(plain!.id).id] } } })
      // in the sweep's order, the broken one first: it fails (no throw, nothing to retry) and the next one goes
      expect(await sendSupplierNotice(ap.org.organizationId, notices.find((n) => n.supplierId === taxed!.id)!.id, LATER)).toBe('FAILED')
      expect(await sendSupplierNotice(ap.org.organizationId, notices.find((n) => n.supplierId === plain!.id)!.id, LATER)).toBe('SENT')
      expect(await prisma.supplierNotice.findFirstOrThrow({ where: { supplierId: taxed!.id, templateKey: 'payment.advice' } })).toMatchObject({ status: 'FAILED', error: 'ATTACHMENT_UNAVAILABLE' })
      expect(await prisma.supplierNotice.findFirstOrThrow({ where: { supplierId: plain!.id, templateKey: 'payment.advice' } })).toMatchObject({ status: 'SENT' })
      expect((await messagesTo(taxed!.email)).filter((m) => m.Subject.includes('Payment advice'))).toHaveLength(0)
      expect(await prisma.notification.count({ where: { templateKey: 'payment_run.advice_failed', subjectId: run.runId, recipientMemberId: ap.org.member.fin_officer } })).toBe(1)
    } finally {
      await prisma.fileObject.update({ where: { id: certificate.fileId! }, data: { status: 'AVAILABLE' } })
    }
  })
})

describe('[FR-PAY-103/AC4] results recorded by hand in phase 1 (OQ-135)', () => {
  it('the command takes results item by item; a bank result file is not taken', async () => {
    const run = await sentToBank([{}])
    expect(await recordPaymentResults(at(), { paymentRunId: run.runId, version: await runVersion(run.runId), resultFile: 'bank-result.csv' } as never, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect((await runOf(run.runId)).status).toBe('SENT_TO_BANK')
  })
})

describe('[FR-PAY-103/AC6] FINANCE records results; a run writes no budget ledger (BR-PAY-14)', () => {
  it('AUDITOR and the approver are refused; from sending to completion not one BudgetLedgerEntry is written', async () => {
    const ledger = () => prisma.budgetLedgerEntry.count({ where: { organizationId: ap.org.organizationId } })
    // the invoices were matched (and charged the budget, BR-MATCH-04) before the run: count from the run's first step
    let start = -1
    const run = await sentToBank([{ service: true }], async () => {
      start = await ledger()
    })
    expect(start).toBeGreaterThan(0)
    const item = run.itemOf(run.suppliers[0]!.id)
    for (const code of ['auditor', 'cfo']) expect(await record(run.runId, [{ paymentRunItemId: item.id, outcome: 'PAID', paidOn: '2026-10-16' }], at(code))).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    ok(await record(run.runId, [{ paymentRunItemId: item.id, outcome: 'PAID', paidOn: '2026-10-16' }]))
    expect((await runOf(run.runId)).status).toBe('COMPLETED')
    expect(await ledger()).toBe(start)
    const ledgerEvents = await prisma.event.count({ where: { organizationId: ap.org.organizationId, aggregateId: run.runId, type: { startsWith: 'budget' } } })
    expect(ledgerEvents).toBe(0)
  })
})
