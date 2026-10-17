import { createHash } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { readNeutralFile } from '@/core/bankfile'
import { readObject } from '@/integrations/storage'
import { prisma } from '@/server/db/client'
import { renderNotification } from '@/server/notifications/templates'
import { decideTask } from '@/server/services/approvals/decide'
import { getDownloadUrl } from '@/server/services/files'
import {
  cancelApprovedPaymentRun,
  generatePaymentFile,
  markPaymentRunSentToBank,
  regeneratePaymentFile,
  requestPaymentFileDownload,
  revertPaymentRunSent,
} from '@/server/services/payments/files'
import { cancelPaymentRun, submitPaymentRun } from '@/server/services/payments/runs'
import { AP_NOW, fin, key, ok } from '../support/ap'
import { logsOf } from '../support/logs'
import { addDocs, draftRun, paySupplier, payOrg, readyInvoice, runVersion, sentRun, type PayOrg } from '../support/pay'
import { stepUpForTask } from '../support/pin'

// S9-07 (FR-PAY-102 AC1 to AC6, FR-PAY-101 AC11, FR-PAY-103 AC5, BR-BANK-03 to BR-BANK-08, BR-PAY-10 BR-PAY-11,
// OQ-136): FINANCE makes the bank file of an approved run in the payer account's template (the neutral one of the demo
// layer), after the check before export; the stored bytes read back state the run's count and total. A file is never
// changed: a new version needs a reason, and once the version in use was downloaded, the word that it was not sent to
// the bank and a notice to the approvers. Only FINANCE gets a link, by POST, for five minutes at most, to the version
// in use of a run on its way to the bank. The run is marked sent to the bank and taken back while no result is
// recorded; cancelled after approval, its documents carry PREVIOUSLY_EXPORTED into the next run when a file had been
// downloaded. No whole account number in a log, an event or a notification.

let ap: PayOrg
const DUE = '2026-10-15'
const ctxOf = (code: string) => ap.org.ctxOf(code, AP_NOW)
const codeOf = (memberId: string) => Object.entries(ap.org.member).find(([, id]) => id === memberId)![0]
const runOf = (runId: string) => prisma.paymentRun.findUniqueOrThrow({ where: { id: runId } })
const filesOf = (runId: string) => prisma.paymentFile.findMany({ where: { paymentRunId: runId }, orderBy: { version: 'asc' } })
const REASON = 'แก้ชื่อไฟล์ตามที่ธนาคารขอ'

/** A run of `count` suppliers (one invoice each, no flag) from the payer account (CB-01 unless given), sent by fin_officer and approved */
async function approvedRun(count: number, payerId = ap.payerId) {
  const suppliers = []
  const invoices = []
  for (let i = 0; i < count; i++) {
    const s = await paySupplier(ap)
    suppliers.push(s)
    invoices.push(await readyInvoice(ap, s.id, '1000.00', '70.00', DUE))
  }
  const sent = await sentRun({ ...ap, payerId }, invoices)
  const task = (await prisma.approvalTask.findFirst({ where: { status: 'OPEN', step: { route: { subjectType: 'PAYMENT_RUN', subjectId: sent.runId } } } }))!
  await stepUpForTask(task.id, task.assigneeMemberId)
  ok(await decideTask(ctxOf(codeOf(task.assigneeMemberId)), { taskId: task.id, decision: 'APPROVE' }, key()))
  return { runId: sent.runId, number: sent.number, suppliers, invoices, approverId: task.assigneeMemberId }
}

const generate = async (runId: string, by = 'fin_officer') => generatePaymentFile(fin(ap, by), { paymentRunId: runId, version: await runVersion(runId) }, key())
const regenerate = async (runId: string, extra: { reason?: string; confirmNotSentToBank?: boolean } = {}) =>
  regeneratePaymentFile(fin(ap), { paymentRunId: runId, version: await runVersion(runId), reason: REASON, ...extra }, key())
const download = (runId: string, paymentFileId: string, by = 'fin_officer') => requestPaymentFileDownload(fin(ap, by), { paymentRunId: runId, paymentFileId }, key())

beforeAll(async () => {
  ap = await payOrg()
})

describe('[FR-PAY-102/AC1] [FR-PAY-102/AC3] the file of an approved run, read back from its stored bytes', () => {
  it('FINANCE makes version 1 in the neutral template: UTF-8 with a BOM, CRLF, the run stated in H, D and T, its sha256 kept', async () => {
    const run = await approvedRun(2)
    const made = ok(await generate(run.runId))
    expect(made.version).toBe(1)
    const r = await runOf(run.runId)
    expect(r.status).toBe('FILE_READY')
    const file = await prisma.paymentFile.findUniqueOrThrow({ where: { id: made.paymentFileId }, include: { file: true } })
    expect(file).toMatchObject({ version: 1, status: 'CURRENT', templateCode: 'BCS-NEUTRAL-1', itemCount: 2, totalSatang: r.totalTransferSatang, reason: null, firstDownloadedAt: null, sha256: made.sha256, generatedById: ap.org.member.fin_officer })
    // the name and the H row say no bank takes it (ADR-130)
    expect(file.fileName).toBe(`BCS-NEUTRAL-1_NOT-A-BANK-FORMAT_${run.number}_v1.csv`)
    const bytes = await readObject(file.file.storageKey)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256)
    expect(file.file).toMatchObject({ sha256: file.sha256, sizeBytes: bytes.length, mimeType: 'text/csv', status: 'AVAILABLE', fileName: file.fileName })
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)
    expect(text.startsWith('﻿')).toBe(true)
    const rows = text.slice(1).split('\r\n')
    expect(rows.at(-1)).toBe('')
    expect(rows[0]).toMatch(new RegExp(`^H,BCS-NEUTRAL-1,NOT-A-BANK-FORMAT,${run.number},1,2026-10-16,004,1000000016,2,`))
    // each item to the account it was approved with, by seq
    const items = await prisma.paymentRunItem.findMany({ where: { paymentRunId: run.runId }, orderBy: { seq: 'asc' } })
    expect(rows.slice(1, 3).map((row) => row.split(',').slice(0, 4).join(','))).toEqual(items.map((i) => `D,${i.seq},014,${i.payeeAccountNo}`))
    // INV-PAY-02: T = Σ D = the run's transfer, and the count is the run's
    const back = readNeutralFile(text)
    for (const part of [back.header, back.details, back.trailer]) expect(part).toEqual({ count: 2, totalSatang: r.totalTransferSatang })
    expect(await prisma.event.findFirstOrThrow({ where: { aggregateId: run.runId, type: 'payment_run.file_generated' } })).toMatchObject({
      data: { paymentFileId: file.id, version: 1, templateCode: 'BCS-NEUTRAL-1', sha256: file.sha256, itemCount: 2, totalTransferSatang: r.totalTransferSatang.toString(), afterExport: false },
    })
    // the file opens only through requestPaymentFileDownload: the general download refuses it, FINANCE included; it is
    // no member's upload, so no service attaches it elsewhere as "a file you uploaded"
    expect(file.file.uploadedById).toBeNull()
    expect(await prisma.fileLink.findMany({ where: { fileId: file.fileId }, select: { subjectType: true, subjectId: true } })).toEqual([{ subjectType: 'PaymentFile', subjectId: file.id }])
    expect(await getDownloadUrl(fin(ap), { fileId: file.fileId })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    // made once: a second time is a new version with its reason
    expect(await generate(run.runId)).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION' } })
  })

  it('only an approved run has a file, and only FINANCE makes it', async () => {
    const s = await paySupplier(ap)
    const sent = await sentRun(ap, [await readyInvoice(ap, s.id, '500.00', '35.00', DUE)])
    expect(await generate(sent.runId)).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION', details: { from: 'PENDING_APPROVAL' } } })
    const run = await approvedRun(1)
    for (const code of ['auditor', 'cfo']) expect(await generate(run.runId, code)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await prisma.paymentFile.count({ where: { paymentRunId: run.runId } })).toBe(0)
  })
})

describe('[FR-PAY-102/AC5] payer accounts of the organization, each with its template; a run pays from one', () => {
  it('a run from CB-02 states CB-02 in its H row; a payer whose template has no builder yet gets no file (TEMPLATE_NOT_BUILT)', async () => {
    const payer = (code: string, bankCode: string, accountNo: string, fileTemplateCode: string) =>
      prisma.bankAccount.create({ data: { organizationId: ap.org.organizationId, ownerKind: 'ORGANIZATION', code, bankCode, accountNo, accountName: 'องค์กรทดสอบ DOA', accountType: 'SAVINGS', fileTemplateCode, activatedAt: AP_NOW } })
    const cb02 = await payer('CB-02', '014', '2000000025', 'BCS-NEUTRAL-1')
    const first = await approvedRun(1)
    const second = await approvedRun(1, cb02.id)
    expect((await runOf(first.runId)).payerBankAccountId).toBe(ap.payerId)
    expect((await runOf(second.runId)).payerBankAccountId).toBe(cb02.id)
    const headOf = async (runId: string) => {
      const made = ok(await generate(runId))
      const file = await prisma.paymentFile.findUniqueOrThrow({ where: { id: made.paymentFileId }, include: { file: true } })
      return new TextDecoder('utf-8').decode(await readObject(file.file.storageKey)).split('\r\n')[0]!.split(',').slice(6, 8)
    }
    expect(await headOf(first.runId)).toEqual(['004', '1000000016'])
    expect(await headOf(second.runId)).toEqual(['014', '2000000025'])

    // a bank's own template comes with its spec (P0-03): until then a run from that account has no file
    const cb03 = await payer('CB-03', '002', '3000000034', 'TEST-BANK-1')
    const third = await approvedRun(1, cb03.id)
    expect((await runOf(third.runId)).fileTemplateCode).toBe('TEST-BANK-1')
    expect(await generate(third.runId)).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'TEMPLATE_NOT_BUILT', templateCode: 'TEST-BANK-1' } } })
    expect(await prisma.paymentFile.count({ where: { paymentRunId: third.runId } })).toBe(0)
    expect((await runOf(third.runId)).status).toBe('APPROVED')
  })
})

describe('[FR-PAY-102/AC2] the check before export (BR-BANK-06): every failure listed, nothing stored', () => {
  it('the payer closed, an account renamed, an account closed, documents no longer held (S8, a released link): BANK_FILE_CHECK_FAILED; put right, the file is made', async () => {
    const run = await approvedRun(4)
    const items = await prisma.paymentRunItem.findMany({ where: { paymentRunId: run.runId }, orderBy: { seq: 'asc' }, include: { documents: true } })
    const [renamed, closed, loose, released] = items
    const releasedLink = released!.documents[0]!
    const accountOf = (supplierId: string) => prisma.bankAccount.findFirstOrThrow({ where: { supplierId, status: 'ACTIVE' } })
    const renamedAccount = await accountOf(renamed!.supplierId)
    const closedAccount = await accountOf(closed!.supplierId)
    const looseInvoice = loose!.documents[0]!.invoiceId!
    await prisma.bankAccount.update({ where: { id: ap.payerId }, data: { status: 'CLOSED' } })
    await prisma.bankAccount.update({ where: { id: renamedAccount.id }, data: { accountName: 'ชื่อที่แก้ภายหลัง' } })
    await prisma.bankAccount.update({ where: { id: closedAccount.id }, data: { status: 'CLOSED' } })
    // S8 no longer holds the invoice for this run, though the run's link still says HELD
    await prisma.invoice.update({ where: { id: looseInvoice }, data: { status: 'READY_FOR_PAYMENT' } })
    // a link of the run let go while the item still pays for it
    await prisma.paymentRunDocument.update({ where: { id: releasedLink.id }, data: { status: 'RELEASED', releaseReason: 'ปล่อยระหว่างทาง' } })
    const objects = await prisma.fileObject.count({ where: { organizationId: ap.org.organizationId } })
    const version = await runVersion(run.runId)
    try {
      const refused = await generate(run.runId)
      expect(refused).toMatchObject({ ok: false, error: { code: 'BANK_FILE_CHECK_FAILED' } })
      if (refused.ok) return
      expect(refused.error.details).toMatchObject({
        checks: `PAYER_ACCOUNT_INVALID, ACCOUNT_MISMATCH#${renamed!.seq}:accountName, ACCOUNT_NOT_ACTIVE#${closed!.seq}, DOCUMENT_NOT_HELD#${loose!.seq}, DOCUMENT_NOT_HELD#${released!.seq}`,
        failures: [
          { check: 'PAYER_ACCOUNT_INVALID' },
          { seq: renamed!.seq, check: 'ACCOUNT_MISMATCH', field: 'accountName' },
          { seq: closed!.seq, check: 'ACCOUNT_NOT_ACTIVE' },
          { seq: loose!.seq, check: 'DOCUMENT_NOT_HELD', document: looseInvoice },
          { seq: released!.seq, check: 'DOCUMENT_NOT_HELD', document: releasedLink.invoiceId },
        ],
      })
      expect(await prisma.paymentFile.count({ where: { paymentRunId: run.runId } })).toBe(0)
      expect(await prisma.fileObject.count({ where: { organizationId: ap.org.organizationId } })).toBe(objects)
      expect(await runOf(run.runId)).toMatchObject({ status: 'APPROVED', version })
    } finally {
      await prisma.bankAccount.update({ where: { id: ap.payerId }, data: { status: 'ACTIVE' } })
      await prisma.bankAccount.update({ where: { id: renamedAccount.id }, data: { accountName: renamedAccount.accountName } })
      await prisma.bankAccount.update({ where: { id: closedAccount.id }, data: { status: 'ACTIVE' } })
      await prisma.invoice.update({ where: { id: looseInvoice }, data: { status: 'IN_PAYMENT_RUN' } })
      await prisma.paymentRunDocument.update({ where: { id: releasedLink.id }, data: { status: 'HELD', releaseReason: null } })
    }
    expect(ok(await generate(run.runId))).toMatchObject({ version: 1 })
  })
})

describe('[FR-PAY-102/AC4] a file is never changed; a new version has a reason, and after a download the word and the approvers', () => {
  it('the trigger refuses to edit or remove a file; v2 with a reason; v3 after v2 was downloaded needs confirmNotSentToBank and tells the approver', async () => {
    const run = await approvedRun(1)
    const v1 = ok(await generate(run.runId))
    await expect(prisma.paymentFile.update({ where: { id: v1.paymentFileId }, data: { totalSatang: 0n } })).rejects.toThrow(/INV-PAY-03/)
    await expect(prisma.paymentFile.update({ where: { id: v1.paymentFileId }, data: { sha256: '0'.repeat(64) } })).rejects.toThrow(/INV-PAY-03/)
    await expect(prisma.paymentFile.delete({ where: { id: v1.paymentFileId } })).rejects.toThrow(/INV-PAY-03|permission denied/)
    expect(await regeneratePaymentFile(ctxOf('auditor'), { paymentRunId: run.runId, version: await runVersion(run.runId), reason: REASON }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    // a new version needs its reason
    expect(await regenerate(run.runId, { reason: ' ' })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    const v2 = ok(await regenerate(run.runId))
    expect(v2.version).toBe(2)
    expect(v2.sha256).not.toBe(v1.sha256)
    expect((await filesOf(run.runId)).map((f) => [f.version, f.status, f.reason])).toEqual([
      [1, 'SUPERSEDED', null],
      [2, 'CURRENT', REASON],
    ])
    // v1 had not been downloaded: nobody is told
    expect(await prisma.notification.count({ where: { templateKey: 'payment_run.file_regenerated', subjectId: run.runId } })).toBe(0)

    ok(await download(run.runId, v2.paymentFileId))
    expect(await regenerate(run.runId)).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'EXPORT_CONFIRMATION_REQUIRED' } } })
    expect((await filesOf(run.runId)).map((f) => f.status)).toEqual(['SUPERSEDED', 'CURRENT'])
    const v3 = ok(await regenerate(run.runId, { confirmNotSentToBank: true }))
    expect(v3.version).toBe(3)
    const files = await filesOf(run.runId)
    expect(files.map((f) => f.status)).toEqual(['SUPERSEDED', 'SUPERSEDED', 'CURRENT'])
    expect(files[1]!.firstDownloadedAt).toEqual(AP_NOW)
    const events = await prisma.event.findMany({ where: { aggregateId: run.runId, type: 'payment_run.file_generated' }, orderBy: { seq: 'asc' } })
    expect(events.map((e) => [(e.data as { version: number }).version, (e.data as { afterExport: boolean }).afterExport])).toEqual([
      [1, false],
      [2, false],
      [3, true],
    ])
    const told = await prisma.notification.findMany({ where: { templateKey: 'payment_run.file_regenerated', subjectId: run.runId } })
    expect(told.map((n) => n.recipientMemberId)).toEqual([run.approverId])
    expect(renderNotification(told[0]!, 'th').title).toBe(`ไฟล์จ่ายเงินของรอบ ${run.number} ถูกสร้างใหม่เป็นเวอร์ชัน 3 หลังดาวน์โหลดไฟล์เดิมแล้ว`)
    // made again only while the file is ready, not before it was made
    const other = await approvedRun(1)
    expect(await regenerate(other.runId)).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION' } })
  })
})

describe('[FR-PAY-102/AC6] the link to the file: FINANCE only, by POST, five minutes at most, the version in use only', () => {
  it('AUDITOR and the approver are refused; FINANCE gets a short link, file.downloaded, and the first download is kept; an old version is FILE_NOT_CURRENT', async () => {
    const run = await approvedRun(1)
    const v1 = ok(await generate(run.runId))
    for (const code of ['auditor', 'cfo']) expect(await download(run.runId, v1.paymentFileId, code)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', details: { capability: 'paymentRun.file' } } })
    expect((await prisma.paymentFile.findUniqueOrThrow({ where: { id: v1.paymentFileId } })).firstDownloadedAt).toBeNull()

    const first = ok(await download(run.runId, v1.paymentFileId))
    expect(first).toMatchObject({ firstDownload: true, fileName: `BCS-NEUTRAL-1_NOT-A-BANK-FORMAT_${run.number}_v1.csv` })
    expect(first.expiresInSeconds).toBeLessThanOrEqual(300)
    expect(Number(new URL(first.url).searchParams.get('X-Amz-Expires'))).toBeLessThanOrEqual(300)
    const later = ok(await download(run.runId, v1.paymentFileId, 'dm_fin'))
    expect(later.firstDownload).toBe(false)
    const file = await prisma.paymentFile.findUniqueOrThrow({ where: { id: v1.paymentFileId } })
    expect(file.firstDownloadedAt).toEqual(AP_NOW)
    const downloads = await prisma.event.findMany({ where: { aggregateId: file.fileId, type: 'file.downloaded' } })
    expect(downloads.map((e) => e.actorMemberId).sort()).toEqual([ap.org.member.fin_officer, ap.org.member.dm_fin].sort())
    // every payee's number whole: each download is a reveal on record (NFR-PRIV-03), the refused ones none
    const reveals = await prisma.sensitiveAccessLog.findMany({ where: { subjectType: 'PaymentFile', subjectId: file.id } })
    expect(reveals.map((r) => [r.memberId, r.fields, r.purpose]).sort()).toEqual(
      [
        [ap.org.member.fin_officer, ['accountNo'], 'download'],
        [ap.org.member.dm_fin, ['accountNo'], 'download'],
      ].sort(),
    )

    // a file of another run is not this run's
    const other = await approvedRun(1)
    expect(await download(other.runId, v1.paymentFileId)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    ok(await regenerate(run.runId, { confirmNotSentToBank: true }))
    expect(await download(run.runId, v1.paymentFileId)).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'FILE_NOT_CURRENT' } } })
  })

  it('a resend with the same key is checked again before it gets a link: a version superseded since, or a run cancelled since, gets none (BR-BANK-08)', async () => {
    const run = await approvedRun(1)
    const v1 = ok(await generate(run.runId))
    const sameKey = key()
    const input = { paymentRunId: run.runId, paymentFileId: v1.paymentFileId }
    ok(await requestPaymentFileDownload(fin(ap), input, sameKey))
    // the same request again while nothing changed: a fresh link to the same version
    expect(ok(await requestPaymentFileDownload(fin(ap), input, sameKey)).fileName).toBe(`BCS-NEUTRAL-1_NOT-A-BANK-FORMAT_${run.number}_v1.csv`)
    const v2 = ok(await regenerate(run.runId, { confirmNotSentToBank: true }))
    expect(await requestPaymentFileDownload(fin(ap), input, sameKey)).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'FILE_NOT_CURRENT' } } })

    const v2Key = key()
    ok(await requestPaymentFileDownload(fin(ap), { paymentRunId: run.runId, paymentFileId: v2.paymentFileId }, v2Key))
    ok(await cancelApprovedPaymentRun(fin(ap), { paymentRunId: run.runId, version: await runVersion(run.runId), reason: 'ยกเลิกเพื่อทดสอบ', confirmNotSentToBank: true }, key()))
    expect(await requestPaymentFileDownload(fin(ap), { paymentRunId: run.runId, paymentFileId: v2.paymentFileId }, v2Key)).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'FILE_NOT_CURRENT' } } })
  })
})

describe('[FR-PAY-103/AC5] sent to the bank, and taken back while no result is recorded (BR-PAY-11)', () => {
  it('FINANCE marks it sent; taking it back needs a reason, kept as a Comment; once an item has its result it stays sent', async () => {
    const run = await approvedRun(1)
    const v1 = ok(await generate(run.runId))
    expect(await markPaymentRunSentToBank(ctxOf('auditor'), { paymentRunId: run.runId, version: await runVersion(run.runId) }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    // what reaches the bank is the version in use: downloaded first
    expect(await markPaymentRunSentToBank(fin(ap), { paymentRunId: run.runId, version: await runVersion(run.runId) }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'FILE_NOT_DOWNLOADED' } } })
    ok(await download(run.runId, v1.paymentFileId))
    ok(await markPaymentRunSentToBank(fin(ap), { paymentRunId: run.runId, version: await runVersion(run.runId) }, key()))
    expect(await runOf(run.runId)).toMatchObject({ status: 'SENT_TO_BANK', sentToBankAt: AP_NOW })
    expect(await prisma.event.findFirstOrThrow({ where: { aggregateId: run.runId, type: 'payment_run.sent_to_bank' } })).toMatchObject({ data: { paymentFileId: v1.paymentFileId, fileVersion: 1 } })
    // the file in use opens still while the bank works on it; a new version is no longer made
    ok(await download(run.runId, v1.paymentFileId))
    expect(await regenerate(run.runId, { confirmNotSentToBank: true })).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION' } })

    const revert = async (reason: string) => revertPaymentRunSent(fin(ap), { paymentRunId: run.runId, version: await runVersion(run.runId), reason }, key())
    expect(await revert('')).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(await revertPaymentRunSent(ctxOf('auditor'), { paymentRunId: run.runId, version: await runVersion(run.runId), reason: 'ส่งใหม่' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    ok(await revert('ธนาคารปฏิเสธไฟล์ ต้องส่งใหม่'))
    expect(await runOf(run.runId)).toMatchObject({ status: 'FILE_READY', sentToBankAt: null })
    const reverted = await prisma.event.findFirstOrThrow({ where: { aggregateId: run.runId, type: 'payment_run.sent_reverted' } })
    const comment = await prisma.comment.findUniqueOrThrow({ where: { id: (reverted.data as { reasonCommentId: string }).reasonCommentId } })
    expect(comment).toMatchObject({ subjectType: 'PaymentRun', subjectId: run.runId, body: 'ธนาคารปฏิเสธไฟล์ ต้องส่งใหม่', authorMemberId: ap.org.member.fin_officer })
    expect(JSON.stringify(reverted.data)).not.toContain('ธนาคารปฏิเสธ')

    ok(await markPaymentRunSentToBank(fin(ap), { paymentRunId: run.runId, version: await runVersion(run.runId) }, key()))
    // the result of its item recorded (S9-08 records it so)
    await prisma.paymentRunItem.updateMany({ where: { paymentRunId: run.runId }, data: { status: 'PAID', paidOn: new Date('2026-10-16T00:00:00Z'), resultRecordedById: ap.org.member.fin_officer, resultRecordedAt: AP_NOW } })
    expect(await revert('ส่งผิดรอบ')).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION', details: { reason: 'RESULTS_RECORDED' } } })
    expect((await runOf(run.runId)).status).toBe('SENT_TO_BANK')
  })
})

describe('[FR-PAY-101/AC11] cancelled after approval by FINANCE (BR-PAY-10, OQ-136)', () => {
  it('after a download: EXPORT_CONFIRMATION_REQUIRED, then cancelled with the word; the approver and the preparer are told; the next run flags PREVIOUSLY_EXPORTED', async () => {
    const run = await approvedRun(2)
    const v1 = ok(await generate(run.runId))
    ok(await download(run.runId, v1.paymentFileId))
    const cancel = async (by: string, extra: { confirmNotSentToBank?: boolean } = {}) =>
      cancelApprovedPaymentRun(fin(ap, by), { paymentRunId: run.runId, version: await runVersion(run.runId), reason: 'ผู้ขายขอเลื่อนรับเงิน', ...extra }, key())
    // the preparer's cancel is for a run not approved yet; the approver is not FINANCE
    expect(await cancelPaymentRun(fin(ap), { paymentRunId: run.runId, version: await runVersion(run.runId), reason: 'ยกเลิก' }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION' } })
    expect(await cancel('cfo', { confirmNotSentToBank: true })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await cancel('dm_fin')).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'EXPORT_CONFIRMATION_REQUIRED' } } })
    expect((await runOf(run.runId)).status).toBe('FILE_READY')

    expect(ok(await cancel('dm_fin', { confirmNotSentToBank: true }))).toEqual({ paymentRunId: run.runId, afterExport: true })
    expect(await runOf(run.runId)).toMatchObject({ status: 'CANCELLED', cancelledAt: AP_NOW, cancelReason: 'ผู้ขายขอเลื่อนรับเงิน' })
    expect((await filesOf(run.runId)).map((f) => f.status)).toEqual(['SUPERSEDED'])
    expect(await download(run.runId, v1.paymentFileId)).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'FILE_NOT_CURRENT' } } })
    const links = await prisma.paymentRunDocument.findMany({ where: { paymentRunId: run.runId } })
    expect(links.map((l) => [l.status, l.releasedAfterExport])).toEqual([
      ['RELEASED', true],
      ['RELEASED', true],
    ])
    expect((await prisma.invoice.findMany({ where: { id: { in: run.invoices } } })).map((i) => i.status)).toEqual(['READY_FOR_PAYMENT', 'READY_FOR_PAYMENT'])
    expect(await prisma.event.findFirstOrThrow({ where: { aggregateId: run.runId, type: 'payment_run.cancelled' } })).toMatchObject({ data: { from: 'FILE_READY', afterExport: true, documentCount: 2 } })
    const told = await prisma.notification.findMany({ where: { templateKey: 'payment_run.cancelled', subjectId: run.runId } })
    expect(told.map((n) => n.recipientMemberId).sort()).toEqual([run.approverId, ap.org.member.fin_officer].sort())
    expect(renderNotification(told[0]!, 'th').body).toContain('ยืนยันว่ายังไม่ได้ส่งธนาคาร')

    // the documents again in a run: each item carries PREVIOUSLY_EXPORTED, which needs the preparer's reason
    const next = await draftRun(ap)
    ok(await addDocs(ap, next, { invoiceIds: run.invoices }))
    expect((await prisma.paymentRunItem.findMany({ where: { paymentRunId: next } })).map((i) => i.flags)).toEqual([['PREVIOUSLY_EXPORTED'], ['PREVIOUSLY_EXPORTED']])
    expect(await submitPaymentRun(fin(ap), { paymentRunId: next, version: await runVersion(next) }, key())).toMatchObject({ ok: false, error: { code: 'PAYMENT_FLAG_REASON_REQUIRED', details: { flag: 'PREVIOUSLY_EXPORTED' } } })
  })

  it('an approved run with no file is cancelled with its reason and no word; its documents carry no flag', async () => {
    const run = await approvedRun(1)
    ok(await cancelApprovedPaymentRun(fin(ap, 'dm_fin'), { paymentRunId: run.runId, version: await runVersion(run.runId), reason: 'รวมกับรอบหน้า' }, key()))
    expect(await prisma.paymentRunDocument.findFirstOrThrow({ where: { paymentRunId: run.runId } })).toMatchObject({ status: 'RELEASED', releasedAfterExport: false })
    expect(await prisma.event.findFirstOrThrow({ where: { aggregateId: run.runId, type: 'payment_run.cancelled' } })).toMatchObject({ data: { from: 'APPROVED', afterExport: false, documentCount: 1 } })
    const told = await prisma.notification.findMany({ where: { templateKey: 'payment_run.cancelled', subjectId: run.runId } })
    expect(told.map((n) => n.recipientMemberId).sort()).toEqual([run.approverId, ap.org.member.fin_officer].sort())
    expect(renderNotification(told[0]!, 'th').body).toBeNull()
    // a closed run is not cancelled twice
    expect(await cancelApprovedPaymentRun(fin(ap), { paymentRunId: run.runId, version: await runVersion(run.runId), reason: 'ซ้ำ' }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION' } })
  })
})

describe('[FR-PAY-102/AC6] [NFR-SEC-09] no whole account number in a log, an event or a notification of the file', () => {
  it('from the file to its cancellation', async () => {
    let runId = ''
    let accountNo = ''
    const logged = await logsOf(async () => {
      const run = await approvedRun(1)
      runId = run.runId
      accountNo = run.suppliers[0]!.accountNo!
      const v1 = ok(await generate(run.runId))
      ok(await download(run.runId, v1.paymentFileId))
      const v2 = ok(await regenerate(run.runId, { confirmNotSentToBank: true }))
      ok(await download(run.runId, v2.paymentFileId))
      ok(await markPaymentRunSentToBank(fin(ap), { paymentRunId: run.runId, version: await runVersion(run.runId) }, key()))
      ok(await revertPaymentRunSent(fin(ap), { paymentRunId: run.runId, version: await runVersion(run.runId), reason: 'ส่งใหม่พรุ่งนี้' }, key()))
      ok(await cancelApprovedPaymentRun(fin(ap, 'dm_fin'), { paymentRunId: run.runId, version: await runVersion(run.runId), reason: 'เลื่อนจ่าย', confirmNotSentToBank: true }, key()))
    })
    expect(logged).toContain('log capture probe')
    const files = await prisma.paymentFile.findMany({ where: { paymentRunId: runId } })
    expect(files).toHaveLength(2)
    const events = await prisma.event.findMany({ where: { organizationId: ap.org.organizationId, aggregateId: { in: [runId, ...files.map((f) => f.fileId)] } } })
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['payment_run.file_generated', 'file.downloaded', 'payment_run.sent_to_bank', 'payment_run.sent_reverted', 'payment_run.cancelled']))
    const notifications = await prisma.notification.findMany({ where: { organizationId: ap.org.organizationId, subjectId: runId } })
    expect(notifications.map((n) => n.templateKey)).toEqual(expect.arrayContaining(['payment_run.file_regenerated', 'payment_run.cancelled']))
    const rendered = notifications.flatMap((n) => ['th', 'en'].map((l) => renderNotification(n, l as 'th' | 'en')))
    // the payee's number and the payer's (CB-01), whole, stay in the file and the run's snapshot only
    for (const number of [accountNo, '1000000016']) {
      for (const [what, text] of [
        ['log', logged],
        ['events', JSON.stringify(events.map((e) => e.data))],
        ['notifications', JSON.stringify(notifications.map((n) => n.data))],
        ['rendered', JSON.stringify(rendered)],
      ] as const) {
        expect(text.includes(number), `${what} has ${number}`).toBe(false)
      }
    }
  })
})
