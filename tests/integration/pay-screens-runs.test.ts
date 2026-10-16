import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  addDocumentsFor,
  cancelApprovedFor,
  cancelDraftFor,
  createRunFor,
  downloadFileFor,
  generateFileFor,
  markSentFor,
  recordResultsFor,
  regenerateFileFor,
  removeDocumentsFor,
  resendAdviceFor,
  revertSentFor,
  setFlagReasonFor,
  submitRunFor,
} from '@/app/(workspace)/finance/payments/commands'
import { decideRequestTask } from '@/app/(workspace)/_tracking/commands'
import type { Ctx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { getPaymentRunTaskView } from '@/server/queries/payment-runs'
import { getPaymentRunPage, listPaymentRuns, newPaymentRunView, type PaymentRunPageDto } from '@/server/services/payments/view'
import { payErrorKey, type PayOutcome } from '@/ui/payments/outcome'
import { AP_NOW, ok } from '../support/ap'
import { addDocs, draftRun, PAY_DATE, paySupplier, payOrg, readyInvoice, runVersion, sentRun, type PayOrg } from '../support/pay'
import { testStepUpSession } from '../support/pin'

// S9-09 (docs/sub-specs/S9.md "หน้าจอ"): what /finance/payments, /finance/payments/new and /finance/payments/[id] read
// and do, through the views and the screen commands with a real database. The list by tab with its counts; what a new
// run proposes (the next Friday, CB-01 masked, the invoices due by then) and the draft made with them, once for a
// resend; one run through its life on its page — flagged items first with the reason the preparer gives, the Sheet's
// documents, sending, the approver's decision with the key of the flags the page showed, the file made, downloaded by
// POST, made again with the word that it was not sent, marked sent and taken back, the results "paid, all but" one and
// the advice sent again, the history with its DOA stamp. Every view and command refuses who may not: AUDITOR and the
// approver read masked, a member without a task reads nothing, another FINANCE member does not edit the preparer's
// draft, and an organization with PAY off gets MODULE_DISABLED. No whole account number reaches a page.

const uuid = () => randomUUID()
/** After the pay date: the transfers are recorded on a later day than the run was prepared and approved */
const LATER = new Date('2026-10-19T03:00:00Z')
const DUE = '2026-10-15'
const PAYER_NO = '1000000016'

function failed(outcome: PayOutcome) {
  if (outcome.ok) throw new Error('expected a refusal')
  return outcome
}
function done(outcome: PayOutcome) {
  if (!outcome.ok) throw new Error(JSON.stringify(outcome))
  return outcome
}

describe('[FR-PAY-101/AC1] /finance/payments and /finance/payments/new', () => {
  let ap: PayOrg
  let dueId: string
  const at = (code: string, now = AP_NOW): Ctx => ap.org.ctxOf(code, now)
  beforeAll(async () => {
    ap = await payOrg()
    const s = await paySupplier(ap)
    dueId = await readyInvoice(ap, s.id, '1000.00', '70.00', DUE)
    // due after the pay date: not proposed
    await readyInvoice(ap, s.id, '500.00', '35.00', '2026-10-28')
  })

  it('proposes the next run day, the payer accounts masked and what a run on that day would take; a holiday is said and the proposal shown', async () => {
    const view = ok(await newPaymentRunView(at('fin_officer')))
    expect(view.payDate).toBe(PAY_DATE)
    expect(view.asked).toBeNull()
    expect(view.payers).toEqual([{ id: ap.payerId, code: 'CB-01', bankCode: '004', bankName: 'ธนาคารกสิกรไทย', bankShort: 'KBANK', last4: '0016', neutralTemplate: true }])
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: dueId } })
    expect(view.proposed).toEqual({ documents: 1, invoices: 1, retentions: 0, suppliers: 1, payableSatang: invoice.payableSatang.toString() })
    expect(JSON.stringify(view)).not.toContain(PAYER_NO)
    // 23 Oct is a holiday of the fixture's calendar
    const holiday = ok(await newPaymentRunView(at('fin_officer'), { payDate: '2026-10-23' }))
    expect(holiday.asked).toEqual({ date: '2026-10-23', code: 'PAYMENT_DATE_INVALID', reason: 'NOT_BUSINESS_DAY' })
    expect(holiday.payDate).toBe(PAY_DATE)
    expect(payErrorKey({ ok: false, code: 'PAYMENT_DATE_INVALID', reason: 'NOT_BUSINESS_DAY' })).toBe('DATE_NOT_BUSINESS_DAY')
    // a later working day takes the invoice due on the 28th too
    expect(ok(await newPaymentRunView(at('fin_officer'), { payDate: '2026-10-30' })).proposed.documents).toBe(2)
    // AUDITOR reads runs but does not prepare one (FR-PAY-101 AC10)
    expect(await newPaymentRunView(at('auditor'))).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })

  it('[FR-PAY-101/AC10] "สร้างร่าง" makes the draft with the proposed documents once, however often the same submission is sent; who may not prepare is refused', async () => {
    const key = uuid()
    const input = { payerBankAccountId: ap.payerId, payDate: PAY_DATE }
    const made = done(await createRunFor(at('fin_officer'), input, key))
    expect(made).toMatchObject({ paymentRunId: expect.any(String), added: 1 })
    expect(made.addFailure).toBeUndefined()
    const again = done(await createRunFor(at('fin_officer'), input, key))
    expect(again).toMatchObject({ paymentRunId: made.paymentRunId, added: 1 })
    expect(await prisma.paymentRun.count({ where: { organizationId: ap.org.organizationId } })).toBe(1)
    expect(await prisma.paymentRunDocument.findMany({ where: { paymentRunId: made.paymentRunId! }, select: { invoiceId: true } })).toEqual([{ invoiceId: dueId }])
    // a malformed call is VALIDATION_FAILED at its field, never a crash; the key is the form's
    expect(failed(await createRunFor(at('fin_officer'), { payerBankAccountId: 'x', payDate: PAY_DATE }, uuid()))).toMatchObject({ code: 'VALIDATION_FAILED', field: 'payerBankAccountId' })
    expect(failed(await createRunFor(at('fin_officer'), input, 'not-a-key'))).toMatchObject({ code: 'VALIDATION_FAILED', field: 'idempotencyKey' })
    expect(failed(await createRunFor(at('fin_officer'), { ...input, payDate: '2026-10-23' }, uuid()))).toMatchObject({ code: 'PAYMENT_DATE_INVALID', reason: 'NOT_BUSINESS_DAY' })
    expect(failed(await createRunFor(at('auditor'), input, uuid()))).toMatchObject({ code: 'FORBIDDEN' })
  })

  it('lists the runs by tab with their counts: FINANCE prepares, AUDITOR reads every run, a member without a task none', async () => {
    const list = ok(await listPaymentRuns(at('fin_officer')))
    expect(list.tab).toBe('draft')
    expect(list.counts).toEqual({ draft: 1, pending: 0, toBank: 0, sent: 0, completed: 0, cancelled: 0 })
    expect(list.canPrepare).toBe(true)
    expect(list.rows).toHaveLength(1)
    expect(list.rows[0]).toMatchObject({ number: null, status: 'DRAFT', payDate: PAY_DATE, payer: { code: 'CB-01', last4: '0016' }, itemCount: 1, flaggedItems: 0 })
    expect(JSON.stringify(list)).not.toContain(PAYER_NO)
    const audit = ok(await listPaymentRuns(at('auditor'), { tab: 'draft' }))
    expect(audit.counts.draft).toBe(1)
    expect(audit.canPrepare).toBe(false)
    const outsider = ok(await listPaymentRuns(at('req_con')))
    expect(outsider.counts.draft).toBe(0)
    expect(outsider.rows).toEqual([])
    expect(ok(await listPaymentRuns(at('fin_officer'), { tab: 'completed', page: 9 }))).toMatchObject({ rows: [], page: 1, pageCount: 1 })
  })

  it('[FR-PAY-101/AC10] with module PAY off every view says MODULE_DISABLED', async () => {
    const runId = (await prisma.paymentRun.findFirstOrThrow({ where: { organizationId: ap.org.organizationId } })).id
    await prisma.orgModule.updateMany({ where: { organizationId: ap.org.organizationId, module: 'PAY' }, data: { enabled: false } })
    try {
      expect(await listPaymentRuns(at('fin_officer'))).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
      expect(await getPaymentRunPage(at('fin_officer'), runId)).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
      expect(await newPaymentRunView(at('fin_officer'))).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
    } finally {
      await prisma.orgModule.updateMany({ where: { organizationId: ap.org.organizationId, module: 'PAY' }, data: { enabled: true } })
    }
  })
})

describe('/finance/payments/[id]: one run through its life on its page', () => {
  let ap: PayOrg
  let flagged: Awaited<ReturnType<typeof paySupplier>>
  let clean: Awaited<ReturnType<typeof paySupplier>>
  let extraId: string
  let runId: string
  const at = (code: string, now = AP_NOW): Ctx => ap.org.ctxOf(code, now)
  const page = async (code = 'fin_officer', now = AP_NOW): Promise<PaymentRunPageDto> => ok(await getPaymentRunPage(at(code, now), runId))
  const version = () => runVersion(runId)
  const noAccountNumber = (view: unknown) => {
    const json = JSON.stringify(view)
    for (const no of [flagged.accountNo!, clean.accountNo!, PAYER_NO]) expect(json).not.toContain(no)
  }

  beforeAll(async () => {
    ap = await payOrg()
    flagged = await paySupplier(ap)
    clean = await paySupplier(ap)
    await readyInvoice(ap, clean.id, '700.00', '49.00', DUE)
    await readyInvoice(ap, flagged.id, '900.00', '63.00', DUE)
    extraId = await readyInvoice(ap, clean.id, '300.00', '21.00', '2026-10-28')
    // the register says the supplier ceased after its invoice was ready (BR-VAT-06 refuses one made after)
    await prisma.supplier.update({ where: { id: flagged.id }, data: { registryFlag: 'CEASED' } })
    runId = done(await createRunFor(at('fin_officer'), { payerBankAccountId: ap.payerId, payDate: PAY_DATE }, uuid())).paymentRunId!
  })

  it('[FR-PAY-101/AC4] [FR-PAY-101/AC5] the draft lists the flagged item first with its flag and no reason yet; accounts masked; the Sheet offers what is still ready', async () => {
    const run = await page()
    expect(run).toMatchObject({ status: 'DRAFT', number: null, payDate: PAY_DATE, neutralTemplate: true, payer: { code: 'CB-01', last4: '0016' }, itemCount: 2, documentCount: 2, flaggedItems: 1, decision: null })
    expect(run.items.map((i) => i.supplier.code)).toEqual([flagged.code, clean.code])
    expect(run.items[0]).toMatchObject({ flags: ['REGISTRY_CHANGED'], flagReason: null, reasonNeeded: true, status: 'INCLUDED', account: { bankCode: '014', last4: flagged.accountNo!.slice(-4) } })
    expect(run.items[1]).toMatchObject({ flags: [], reasonNeeded: false })
    expect(run.may).toMatchObject({ edit: true, cancelDraft: true, generate: false, download: false, recordResults: false })
    // the Sheet: the invoice due on the 28th, under its supplier
    const offered = run.addable.find((s) => s.supplier.id === clean.id)!
    expect(offered.supplier.hasAccount).toBe(true)
    expect(offered.documents).toEqual([expect.objectContaining({ kind: 'INVOICE', id: extraId, dueDate: '2026-10-28' })])
    expect(run.history.map((e) => e.type)).toEqual(['payment_run.drafted', 'payment_run.documents_added'])
    noAccountNumber(run)
  })

  it('[FR-PAY-101/AC10] [FR-PAY-102/AC8] another FINANCE member and AUDITOR read it without acting; a member without a task of the run reads nothing', async () => {
    const other = await page('dm_fin')
    expect(other.may).toMatchObject({ edit: false, cancelDraft: false, generate: false, download: false, markSent: false, cancelApproved: false, recordResults: false })
    expect(other.addable).toEqual([])
    expect(failed(await addDocumentsFor(at('dm_fin'), { paymentRunId: runId, version: await version(), invoiceIds: [extraId], retentionIds: [] }, uuid()))).toMatchObject({ code: 'FORBIDDEN' })
    const audit = await page('auditor')
    expect(Object.values(audit.may).some(Boolean)).toBe(false)
    expect(audit.items[0]!.account).toMatchObject({ last4: flagged.accountNo!.slice(-4) })
    noAccountNumber(audit)
    expect(await getPaymentRunPage(at('req_con'), runId)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await getPaymentRunPage(at('fin_officer'), uuid())).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await getPaymentRunPage(at('fin_officer'), 'not-an-id')).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })

  it('[FR-PAY-101/AC2] [FR-PAY-101/AC3] the preparer adds a document from the Sheet and takes it out again; nothing chosen is said', async () => {
    expect(payErrorKey(failed(await addDocumentsFor(at('fin_officer'), { paymentRunId: runId, version: await version(), invoiceIds: [], retentionIds: [] }, uuid())))).toBe('NOTHING_CHOSEN')
    done(await addDocumentsFor(at('fin_officer'), { paymentRunId: runId, version: await version(), invoiceIds: [extraId], retentionIds: [] }, uuid()))
    let run = await page()
    const item = run.items.find((i) => i.supplier.id === clean.id)!
    expect(item.documents.map((d) => d.dueDate)).toContain('2026-10-28')
    expect(run.documentCount).toBe(3)
    expect(run.addable.flatMap((s) => s.documents).map((d) => d.id)).not.toContain(extraId)
    // the same document again is held already: DOCUMENT_NOT_PAYABLE
    expect(payErrorKey(failed(await addDocumentsFor(at('fin_officer'), { paymentRunId: runId, version: await version(), invoiceIds: [extraId], retentionIds: [] }, uuid())))).toBe('DOCUMENT_NOT_PAYABLE')
    // a stale version: CHANGED
    expect(payErrorKey(failed(await removeDocumentsFor(at('fin_officer'), { paymentRunId: runId, version: 0, invoiceIds: [extraId], retentionIds: [] }, uuid())))).toBe('CHANGED')
    done(await removeDocumentsFor(at('fin_officer'), { paymentRunId: runId, version: await version(), invoiceIds: [extraId], retentionIds: [] }, uuid()))
    run = await page()
    expect(run.documentCount).toBe(2)
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: extraId } })).status).toBe('READY_FOR_PAYMENT')
  })

  it('[FR-PAY-101/AC4] sending without the flag’s reason is refused in words; the reason given, the run goes for approval with its number', async () => {
    const refused = failed(await submitRunFor(at('fin_officer'), { paymentRunId: runId, version: await version() }, uuid()))
    expect(refused).toMatchObject({ code: 'PAYMENT_FLAG_REASON_REQUIRED', supplier: flagged.code, flag: 'REGISTRY_CHANGED' })
    expect(payErrorKey(refused)).toBe('PAYMENT_FLAG_REASON_REQUIRED')
    expect(payErrorKey(failed(await setFlagReasonFor(at('fin_officer'), { paymentRunId: runId, version: await version(), supplierId: flagged.id, reason: ' ab ' }, uuid())))).toBe('REASON')
    expect(failed(await setFlagReasonFor(at('dm_fin'), { paymentRunId: runId, version: await version(), supplierId: flagged.id, reason: 'งานส่งมอบครบก่อนเลิกกิจการ' }, uuid()))).toMatchObject({ code: 'FORBIDDEN' })
    done(await setFlagReasonFor(at('fin_officer'), { paymentRunId: runId, version: await version(), supplierId: flagged.id, reason: 'งานส่งมอบครบก่อนเลิกกิจการ ตรวจกับจัดซื้อแล้ว' }, uuid()))
    expect((await page()).items[0]).toMatchObject({ flagReason: 'งานส่งมอบครบก่อนเลิกกิจการ ตรวจกับจัดซื้อแล้ว', reasonNeeded: false })
    expect(failed(await submitRunFor(at('fin_officer'), { paymentRunId: 'x', version: 0 }, uuid()))).toMatchObject({ code: 'VALIDATION_FAILED', field: 'paymentRunId' })
    const sent = done(await submitRunFor(at('fin_officer'), { paymentRunId: runId, version: await version() }, uuid()))
    expect(sent.number).toMatch(/^PAY-\d{4}-\d{5}$/)
  })

  it('[FR-PAY-101/AC5] only the approver holding the task gets the decision bar, with the key of the flags shown; another key is PAYMENT_FLAGS_CHANGED and that key approves', async () => {
    const preparer = await page()
    expect(preparer).toMatchObject({ status: 'PENDING_APPROVAL', decision: null })
    expect(preparer.may).toMatchObject({ edit: false, cancelDraft: true })
    const task = (await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectType: 'PAYMENT_RUN', subjectId: runId } } } }))
    expect(task.assigneeMemberId).toBe(ap.org.member.cfo)
    const approver = await page('cfo')
    const shown = (await getPaymentRunTaskView(at('cfo'), runId))!.flagsKey
    expect(shown).toBe(`${flagged.code}:REGISTRY_CHANGED`)
    expect(approver.decision).toEqual({ taskId: task.id, stepUp: false, flagsKey: shown })
    expect(approver.flaggedItems).toBe(1)
    expect(Object.values(approver.may).some(Boolean)).toBe(false)
    noAccountNumber(approver)
    expect(ok(await listPaymentRuns(at('cfo'), { tab: 'pending' })).rows.map((r) => r.id)).toEqual([runId])
    expect((await page('auditor')).decision).toBeNull()

    const decide = (flagsKey: string) => decideRequestTask(at('cfo'), { taskId: task.id, decision: 'APPROVE', subjectInput: { flagsKey } }, uuid(), 'th', testStepUpSession())
    expect(await decide('')).toMatchObject({ ok: false, code: 'PAYMENT_FLAGS_CHANGED' })
    expect((await prisma.approvalTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('OPEN')
    expect(await decide(approver.decision!.flagsKey)).toMatchObject({ ok: true, documentStatus: 'APPROVED' })
    expect((await page('cfo')).decision).toBeNull()
  })

  it('[FR-PAY-102/AC1] [FR-PAY-102/AC4] [FR-PAY-102/AC6] the file is made, downloaded by POST only by FINANCE, made again with the word it was not sent, then marked sent', async () => {
    expect(failed(await generateFileFor(at('auditor'), { paymentRunId: runId, version: await version() }, uuid()))).toMatchObject({ code: 'FORBIDDEN' })
    done(await generateFileFor(at('fin_officer'), { paymentRunId: runId, version: await version() }, uuid()))
    let run = await page()
    expect(run.status).toBe('FILE_READY')
    expect(run.files).toHaveLength(1)
    expect(run.files[0]).toMatchObject({ version: 1, status: 'CURRENT', itemCount: 2, totalSatang: run.totalTransferSatang, firstDownloadedAt: null })
    expect(run.files[0]!.sha256Short).toMatch(/^[0-9a-f]{12}$/)
    expect(run.files[0]!.fileName).toContain('NOT-A-BANK-FORMAT')
    expect(run.may).toMatchObject({ download: true, markSent: true, regenerate: true, cancelApproved: true, generate: false })
    expect(run.downloaded).toEqual({ any: false, current: false })
    // BR-PAY-11: not downloaded yet
    expect(payErrorKey(failed(await markSentFor(at('fin_officer'), { paymentRunId: runId, version: await version() }, uuid())))).toBe('FILE_NOT_DOWNLOADED')
    const v1 = run.files[0]!.id
    expect(failed(await downloadFileFor(at('auditor'), { paymentRunId: runId, paymentFileId: v1 }, uuid()))).toMatchObject({ code: 'FORBIDDEN' })
    const got = done(await downloadFileFor(at('fin_officer'), { paymentRunId: runId, paymentFileId: v1 }, uuid()))
    expect(got.url).toMatch(/^https?:\/\//)
    expect(got.fileName).toBe(run.files[0]!.fileName)
    run = await page()
    expect(run.downloaded).toEqual({ any: true, current: true })
    expect(run.history.find((e) => e.type === 'file.downloaded')).toMatchObject({ fileVersion: 1 })
    // made again after a download: the word that it was not sent to the bank (BR-BANK-07)
    expect(payErrorKey(failed(await regenerateFileFor(at('fin_officer'), { paymentRunId: runId, version: await version(), reason: 'แก้ชื่อไฟล์ตามที่ธนาคารขอ', confirmNotSentToBank: false }, uuid())))).toBe('EXPORT_CONFIRMATION_REQUIRED')
    done(await regenerateFileFor(at('fin_officer'), { paymentRunId: runId, version: await version(), reason: 'แก้ชื่อไฟล์ตามที่ธนาคารขอ', confirmNotSentToBank: true }, uuid()))
    run = await page()
    expect(run.files.map((f) => [f.version, f.status])).toEqual([
      [2, 'CURRENT'],
      [1, 'SUPERSEDED'],
    ])
    expect(run.files[0]!.reason).toBe('แก้ชื่อไฟล์ตามที่ธนาคารขอ')
    expect(run.downloaded).toEqual({ any: true, current: false })
    expect(payErrorKey(failed(await downloadFileFor(at('fin_officer'), { paymentRunId: runId, paymentFileId: v1 }, uuid())))).toBe('FILE_NOT_CURRENT')
    done(await downloadFileFor(at('fin_officer'), { paymentRunId: runId, paymentFileId: run.files[0]!.id }, uuid()))
    done(await markSentFor(at('fin_officer'), { paymentRunId: runId, version: await version() }, uuid()))
    expect((await page()).status).toBe('SENT_TO_BANK')
  })

  it('[FR-PAY-103/AC5] sent to the bank is taken back with a reason while no result is recorded', async () => {
    expect(payErrorKey(failed(await revertSentFor(at('fin_officer'), { paymentRunId: runId, version: await version(), reason: 'no' }, uuid())))).toBe('REASON')
    done(await revertSentFor(at('fin_officer'), { paymentRunId: runId, version: await version(), reason: 'กดส่งก่อนอัปโหลดจริง' }, uuid()))
    const run = await page()
    expect(run.status).toBe('FILE_READY')
    expect(run.history.find((e) => e.type === 'payment_run.sent_reverted')).toMatchObject({ note: 'กดส่งก่อนอัปโหลดจริง', actor: { th: expect.any(String) } })
    done(await markSentFor(at('fin_officer'), { paymentRunId: runId, version: await version() }, uuid()))
  })

  it('[FR-PAY-103/AC1] [FR-PAY-103/AC3] "paid, all but" one: the run completes, the paid item has its advice, the failed one its reason; the advice is sent again', async () => {
    const before = await page('fin_officer', LATER)
    expect(before.may).toMatchObject({ recordResults: true, revertSent: true })
    expect(before.today).toBe('2026-10-19')
    const cleanItem = before.items.find((i) => i.supplier.id === clean.id)!
    const flaggedItem = before.items.find((i) => i.supplier.id === flagged.id)!
    const all = (paidOn: string, reason: string) => ({ paymentRunId: runId, version: before.version, allPaidExcept: { paidOn, bankReference: '', failed: [{ paymentRunItemId: cleanItem.id, reason }] } })
    expect(payErrorKey(failed(await recordResultsFor(at('fin_officer', LATER), all(PAY_DATE, 'x'), uuid())))).toBe('REASON')
    expect(payErrorKey(failed(await recordResultsFor(at('fin_officer', LATER), all('2026-10-15', 'บัญชีปลายทางปิดแล้ว'), uuid())))).toBe('PAID_ON_BEFORE_PAY_DATE')
    expect(failed(await recordResultsFor(at('auditor', LATER), all(PAY_DATE, 'บัญชีปลายทางปิดแล้ว'), uuid()))).toMatchObject({ code: 'FORBIDDEN' })
    expect(done(await recordResultsFor(at('fin_officer', LATER), all(PAY_DATE, 'บัญชีปลายทางปิดแล้ว'), uuid())).completed).toBe(true)

    const run = await page('fin_officer', LATER)
    expect(run.status).toBe('COMPLETED')
    const paid = run.items.find((i) => i.id === flaggedItem.id)!
    const lost = run.items.find((i) => i.id === cleanItem.id)!
    expect(paid).toMatchObject({ status: 'PAID', paidOn: PAY_DATE, bankReference: null, advice: { sendings: 1 } })
    expect(lost).toMatchObject({ status: 'FAILED', failureReason: 'บัญชีปลายทางปิดแล้ว', advice: null })
    expect(run.may).toMatchObject({ recordResults: false, revertSent: false, resendAdvice: true })
    expect(payErrorKey(failed(await resendAdviceFor(at('fin_officer', LATER), { paymentRunItemId: paid.id, reason: '' }, uuid())))).toBe('REASON')
    done(await resendAdviceFor(at('fin_officer', LATER), { paymentRunItemId: paid.id, reason: 'ผู้ขายขอสำเนาอีกครั้ง' }, uuid()))
    expect((await page('fin_officer', LATER)).items.find((i) => i.id === paid.id)!.advice).toMatchObject({ sendings: 2 })
    expect(ok(await listPaymentRuns(at('fin_officer'), { tab: 'completed' })).rows.map((r) => r.id)).toEqual([runId])
  })

  it('[FR-PAY-101/AC9] the history tells the run in order, the approval as a stamp of its DOA rule, each reason as written', async () => {
    const run = await page('auditor', LATER)
    const types = run.history.map((e) => e.type)
    for (const type of ['payment_run.drafted', 'payment_run.submitted', 'approval_task.assigned', 'approval_task.decided', 'payment_run.approved', 'payment_run.file_generated', 'payment_run.sent_to_bank', 'payment_run_item.paid', 'payment_run_item.failed', 'payment_run.completed', 'payment_run_item.advice_resent']) {
      expect(types).toContain(type)
    }
    expect(types.indexOf('payment_run.submitted')).toBeLessThan(types.indexOf('approval_task.decided'))
    expect(types.indexOf('approval_task.decided')).toBeLessThan(types.indexOf('payment_run.file_generated'))
    const decided = run.history.find((e) => e.type === 'approval_task.decided')!
    expect(decided).toMatchObject({ decision: 'APPROVE', doa: { ruleCode: expect.any(String), versionNo: expect.any(Number) } })
    expect(run.history.find((e) => e.type === 'payment_run_item.failed')).toMatchObject({ supplierCode: clean.code, note: 'บัญชีปลายทางปิดแล้ว' })
    expect(run.history.find((e) => e.type === 'payment_run_item.advice_resent')).toMatchObject({ supplierCode: flagged.code, note: 'ผู้ขายขอสำเนาอีกครั้ง' })
    expect(run.history.filter((e) => e.type === 'payment_run.file_generated').map((e) => e.fileVersion)).toEqual([1, 2])
    noAccountNumber(run)
  })
})

describe('[FR-PAY-101/AC11] cancelling: a draft by its preparer, an approved run after a download with the word that the file was not sent', () => {
  let ap: PayOrg
  const at = (code: string): Ctx => ap.org.ctxOf(code, AP_NOW)
  beforeAll(async () => {
    ap = await payOrg()
  })

  it('a draft: another FINANCE member may not, its preparer does with a reason; every document is ready again', async () => {
    const s = await paySupplier(ap)
    const invoice = await readyInvoice(ap, s.id, '400.00', '28.00', DUE)
    const runId = await draftRun(ap)
    ok(await addDocs(ap, runId, { invoiceIds: [invoice] }))
    expect(failed(await cancelDraftFor(at('dm_fin'), { paymentRunId: runId, version: await runVersion(runId), reason: 'เตรียมผิดรอบ' }, uuid()))).toMatchObject({ code: 'FORBIDDEN' })
    expect(payErrorKey(failed(await cancelDraftFor(at('fin_officer'), { paymentRunId: runId, version: await runVersion(runId), reason: '' }, uuid())))).toBe('REASON')
    done(await cancelDraftFor(at('fin_officer'), { paymentRunId: runId, version: await runVersion(runId), reason: 'เตรียมผิดรอบ' }, uuid()))
    const run = ok(await getPaymentRunPage(at('fin_officer'), runId))
    expect(run).toMatchObject({ status: 'CANCELLED', cancelReason: 'เตรียมผิดรอบ' })
    expect(run.history.find((e) => e.type === 'payment_run.cancelled')).toMatchObject({ note: 'เตรียมผิดรอบ' })
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice } })).status).toBe('READY_FOR_PAYMENT')
    expect(ok(await listPaymentRuns(at('fin_officer'), { tab: 'cancelled' })).rows.map((r) => r.id)).toContain(runId)
  })

  it('an approved run whose file was downloaded asks for "not sent to the bank" first', async () => {
    const s = await paySupplier(ap)
    const sent = await sentRun(ap, [await readyInvoice(ap, s.id, '600.00', '42.00', DUE)])
    const task = (await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectType: 'PAYMENT_RUN', subjectId: sent.runId } } } }))
    expect(task.assigneeMemberId).toBe(ap.org.member.cfo)
    const approver = ok(await getPaymentRunPage(at('cfo'), sent.runId)).decision!
    expect(await decideRequestTask(at('cfo'), { taskId: approver.taskId, decision: 'APPROVE', subjectInput: { flagsKey: approver.flagsKey } }, uuid(), 'th', testStepUpSession())).toMatchObject({ ok: true })
    done(await generateFileFor(at('fin_officer'), { paymentRunId: sent.runId, version: await runVersion(sent.runId) }, uuid()))
    const file = ok(await getPaymentRunPage(at('fin_officer'), sent.runId)).files[0]!
    done(await downloadFileFor(at('fin_officer'), { paymentRunId: sent.runId, paymentFileId: file.id }, uuid()))
    const cancel = (confirmNotSentToBank: boolean) => cancelApprovedFor(at('fin_officer'), { paymentRunId: sent.runId, version: 0, reason: 'ผู้บริหารให้รวมกับรอบหน้า', confirmNotSentToBank }, uuid())
    const version = await runVersion(sent.runId)
    expect(payErrorKey(failed(await cancelApprovedFor(at('fin_officer'), { paymentRunId: sent.runId, version, reason: 'ผู้บริหารให้รวมกับรอบหน้า', confirmNotSentToBank: false }, uuid())))).toBe('EXPORT_CONFIRMATION_REQUIRED')
    expect(payErrorKey(failed(await cancel(true)))).toBe('CHANGED')
    expect(failed(await cancelApprovedFor(at('auditor'), { paymentRunId: sent.runId, version, reason: 'ผู้บริหารให้รวมกับรอบหน้า', confirmNotSentToBank: true }, uuid()))).toMatchObject({ code: 'FORBIDDEN' })
    done(await cancelApprovedFor(at('fin_officer'), { paymentRunId: sent.runId, version, reason: 'ผู้บริหารให้รวมกับรอบหน้า', confirmNotSentToBank: true }, uuid()))
    expect(ok(await getPaymentRunPage(at('fin_officer'), sent.runId))).toMatchObject({ status: 'CANCELLED', cancelReason: 'ผู้บริหารให้รวมกับรอบหน้า', downloaded: { any: true, current: false } })
  })
})
