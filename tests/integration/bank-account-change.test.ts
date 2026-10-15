import { randomUUID } from 'node:crypto'
import { Writable } from 'node:stream'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createLogger, logger } from '@/lib/logger'
import type { Ctx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { approvalCardMessage } from '@/server/line/postback-cards'
import { sendSupplierNotice } from '@/server/notifications/supplier-notices'
import { renderNotification } from '@/server/notifications/templates'
import { LINE_TEMPLATES } from '@/server/notifications/deliver'
import { decideTask } from '@/server/services/approvals/decide'
import {
  attachBankProof,
  cancelBankAccountChange,
  createBankAccountChange,
  detachBankProof,
  submitBankAccountChange,
  updateBankAccountChange,
} from '@/server/services/bank-accounts'
import { getBankAccountChange, listBankAccounts, revealBankAccount, revealBankAccountChange } from '@/server/services/bank-accounts/view'
import { getDownloadUrl } from '@/server/services/files'
import { AP_NOW, apOrg, key, ok, type ApOrg } from '../support/ap'
import { messagesTo } from '../support/mailpit'
import { stepUpForTask } from '../support/pin'

// S9-04 (FR-PAY-102 AC7 AC8, BR-SUP-06, BR-SUP-07, BR-SOD-05, BR-DOA-25, NFR-PRIV-03, NFR-SEC-09, OQ-133, OQ-137): the
// accounts of suppliers and of the organization change only through a BankAccountChange that FINANCE proposes with its
// proof and that DOA BANK_ACCOUNT_CHANGE approves (BA-01 → CFO in the phase-1 fixtures) with a step-up every time, on
// the web or in LIFF only. The proposer never approves; a supplier's new account is told to the supplier once by e-mail
// at the address in the register; numbers are masked everywhere and opened whole by FINANCE and the approver only, with
// a log row each time; and no log line, event, notification, LINE card or e-mail carries a number whole.

let ap: ApOrg
const fin = () => ap.org.ctxOf('fin_officer', AP_NOW)
const ctxOf = (code: string, channel: Ctx['channel'] = 'WEB') => ap.org.ctxOf(code, AP_NOW, channel)
const codeOf = (memberId: string) => Object.entries(ap.org.member).find(([, id]) => id === memberId)![0]
const openTaskOf = (changeId: string) => prisma.approvalTask.findFirst({ where: { status: 'OPEN', step: { route: { subjectType: 'BANK_ACCOUNT_CHANGE', subjectId: changeId } } } })
const versionOf = async (changeId: string) => (await prisma.bankAccountChange.findUniqueOrThrow({ where: { id: changeId } })).version
const activeOf = (supplierId: string) => prisma.bankAccount.findMany({ where: { supplierId, status: 'ACTIVE' } })

/** A supplier of its own, with an e-mail address of its own for Mailpit */
async function supplier(withEmail = true) {
  const n = randomUUID().slice(0, 8)
  const email = withEmail ? `bank-${n}@supplier.test.bcs.local` : null
  const s = await prisma.supplier.create({ data: { organizationId: ap.org.organizationId, code: `SB-${n}`, nameTh: `ผู้ขาย ${n}`, taxId: `09${Array.from({ length: 11 }, () => Math.floor(Math.random() * 10)).join('')}`, email } })
  return { id: s.id, code: s.code, email }
}

/** A paper uploaded by the member (the files service would have checked it) */
async function proof(by = 'fin_officer', mimeType = 'application/pdf') {
  const f = await prisma.fileObject.create({ data: { organizationId: ap.org.organizationId, storageKey: `test/${randomUUID()}.pdf`, fileName: 'หนังสือจากผู้ขาย.pdf', mimeType, sizeBytes: 1, sha256: '0'.repeat(64), status: 'AVAILABLE', uploadedById: ap.org.member[by]! } })
  return f.id
}

/** Drafts a request, attaches a proof and records the call when asked, then sends it; returns its id */
async function sent(input: Parameters<typeof createBankAccountChange>[1], options: { call?: boolean } = {}) {
  const { changeId } = ok(await createBankAccountChange(fin(), input, key()))
  if (input.kind !== 'CLOSE') ok(await attachBankProof(fin(), { changeId, version: await versionOf(changeId), fileId: await proof() }, key()))
  if (options.call) ok(await updateBankAccountChange(fin(), { changeId, version: await versionOf(changeId), callVerificationNote: 'โทรเบอร์ในทะเบียน 02-123-4567 คุณสมชายยืนยัน' }, key()))
  ok(await submitBankAccountChange(fin(), { changeId, version: await versionOf(changeId) }, key()))
  return changeId
}

/** The CFO approves on the web with the PIN, as BA-01 assigns */
async function approve(changeId: string, channel: Ctx['channel'] = 'WEB') {
  const task = (await openTaskOf(changeId))!
  await stepUpForTask(task.id, task.assigneeMemberId, channel === 'LIFF' ? 'LIFF' : undefined)
  return decideTask(ctxOf(codeOf(task.assigneeMemberId), channel), { taskId: task.id, decision: 'APPROVE' }, key())
}

beforeAll(async () => {
  ap = await apOrg()
})
afterEach(() => vi.restoreAllMocks())

describe('[FR-PAY-102/AC7] a supplier’s account comes into force only by an approved BankAccountChange', () => {
  it('an addition: drafted and sent by FINANCE, not in force while it waits, approved by the CFO with the PIN, the supplier e-mailed once', async () => {
    const s = await supplier()
    const changeId = await sent({ kind: 'ADD', ownerKind: 'SUPPLIER', supplierId: s.id, bankCode: '004', accountNo: '123-4-56789-0', accountName: 'บริษัท ทดสอบ จำกัด', reason: 'ผู้ขายรายใหม่ส่งหนังสือยืนยันบัญชี' })
    const change = await prisma.bankAccountChange.findUniqueOrThrow({ where: { id: changeId } })
    expect(change).toMatchObject({ status: 'PENDING_APPROVAL', accountNo: '1234567890', number: expect.stringMatching(/^BAC-\d{4}-\d{5}$/) })
    const route = await prisma.approvalRoute.findFirstOrThrow({ where: { subjectType: 'BANK_ACCOUNT_CHANGE', subjectId: changeId } })
    expect(route).toMatchObject({ ruleCode: 'BA-01', amountSatang: null })
    const task = (await openTaskOf(changeId))!
    expect(task.assigneeMemberId).toBe(ap.org.member.cfo)
    // BR-DOA-25: no LINE button and no e-mail link is issued for the task
    expect(await prisma.actionToken.count({ where: { taskId: task.id } })).toBe(0)
    // not in force while it waits: nothing to pay into
    expect(await activeOf(s.id)).toHaveLength(0)

    // a step-up every time, whatever the amount (ALWAYS_STEP_UP_SUBJECTS)
    expect(await decideTask(ctxOf('cfo'), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'STEP_UP_REQUIRED' } })
    expect(ok(await approve(changeId))).toMatchObject({ documentStatus: 'APPROVED' })
    const [account] = await activeOf(s.id)
    expect(account).toMatchObject({ ownerKind: 'SUPPLIER', accountNo: '1234567890', bankCode: '004', sourceChangeId: changeId })
    expect(await prisma.bankAccountChange.findUniqueOrThrow({ where: { id: changeId } })).toMatchObject({ status: 'APPROVED', appliedBankAccountId: account!.id })
    expect(await prisma.event.findFirstOrThrow({ where: { aggregateId: account!.id, type: 'bank_account.activated' } })).toMatchObject({ data: { via: 'CHANGE', changeId, last4: '7890' } })

    // BR-SUP-06: one e-mail per account in force, at the address in the register, sent by the job
    const notices = await prisma.supplierNotice.findMany({ where: { supplierId: s.id } })
    expect(notices).toEqual([expect.objectContaining({ templateKey: 'bank_account.notice', subjectType: 'BANK_ACCOUNT', subjectId: account!.id, toEmail: s.email, status: 'PENDING' })])
    expect(await sendSupplierNotice(ap.org.organizationId, notices[0]!.id, AP_NOW)).toBe('SENT')
    const [mail] = await messagesTo(s.email!)
    expect(mail!.Text).toContain('7890')
    expect(mail!.Text).not.toContain('1234567890')

    // the proposer hears the decision, by LINE where linked (§10.1)
    const told = await prisma.notification.findFirstOrThrow({ where: { recipientMemberId: ap.org.member.fin_officer!, templateKey: 'bank_account_change.decided', subjectId: changeId } })
    expect(told.data).toMatchObject({ outcome: 'APPROVED' })
    expect(renderNotification(told, 'th').title).toContain('อนุมัติแล้ว')
    expect(LINE_TEMPLATES.has('bank_account_change.decided')).toBe(true)
  })

  it('a replacement needs the paper and the call to the number in the register; the old account is superseded and the supplier hears once per new account', async () => {
    const s = await supplier()
    await sent({ kind: 'ADD', ownerKind: 'SUPPLIER', supplierId: s.id, bankCode: '014', accountNo: '2223334445', accountName: 'ร้าน ก', reason: 'บัญชีแรก' }).then(approve)
    const [first] = await activeOf(s.id)

    const { changeId } = ok(await createBankAccountChange(fin(), { kind: 'REPLACE', ownerKind: 'SUPPLIER', supplierId: s.id, targetBankAccountId: first!.id, bankCode: '006', accountNo: '6667778889', accountName: 'ร้าน ก', reason: 'ผู้ขายแจ้งเปลี่ยนบัญชี' }, key()))
    expect(await submitBankAccountChange(fin(), { changeId, version: await versionOf(changeId) }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'PROOF_REQUIRED' } } })
    const fileId = await proof()
    ok(await attachBankProof(fin(), { changeId, version: await versionOf(changeId), fileId }, key()))
    expect(await submitBankAccountChange(fin(), { changeId, version: await versionOf(changeId) }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'CALL_VERIFICATION_REQUIRED' } } })
    // the note names no account: neither the new number nor the one replaced, however it is written
    for (const note of ['ยืนยันเลข 666-777-8889 แล้ว', 'บัญชีเดิม 2223334445 ปิดแล้ว', 'เลขใหม่ ๖๖๖๗๗๗๘๘๘๙', 'เลข 666.777.8889 ตามสมุด', 'เลขเดิม 222/333/4445']) {
      expect(await updateBankAccountChange(fin(), { changeId, version: await versionOf(changeId), callVerificationNote: note }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'NOTE_HAS_ACCOUNT_NO' } } })
    }
    ok(await updateBankAccountChange(fin(), { changeId, version: await versionOf(changeId), callVerificationNote: 'โทร 081-234-5678 ตามทะเบียน ผู้ขายยืนยันการเปลี่ยน' }, key()))
    // a call confirms the account as it was: changing the number asks for the call again
    ok(await updateBankAccountChange(fin(), { changeId, version: await versionOf(changeId), accountNo: '6667778880' }, key()))
    expect(await prisma.bankAccountChange.findUniqueOrThrow({ where: { id: changeId } })).toMatchObject({ callVerifiedAt: null, callVerificationNote: null })
    ok(await updateBankAccountChange(fin(), { changeId, version: await versionOf(changeId), callVerificationNote: 'โทรซ้ำ 081-234-5678 ยืนยันเลขใหม่' }, key()))
    ok(await submitBankAccountChange(fin(), { changeId, version: await versionOf(changeId) }, key()))
    // not in force while it waits: the first account is still the one paid into
    expect((await activeOf(s.id)).map((a) => a.id)).toEqual([first!.id])
    ok(await approve(changeId))
    const after = await prisma.bankAccount.findMany({ where: { supplierId: s.id }, orderBy: { createdAt: 'asc' } })
    expect(after.map((a) => [a.accountNo, a.status])).toEqual([
      ['2223334445', 'SUPERSEDED'],
      ['6667778880', 'ACTIVE'],
    ])
    expect(await prisma.event.findFirstOrThrow({ where: { aggregateId: first!.id, type: 'bank_account.superseded' } })).toMatchObject({ data: { changeId, byBankAccountId: after[1]!.id, last4: '4445' } })
    const notices = await prisma.supplierNotice.findMany({ where: { supplierId: s.id }, orderBy: { createdAt: 'asc' } })
    expect(notices.map((n) => n.subjectId)).toEqual(after.map((a) => a.id))
  })

  it('a closure needs no paper; the account leaves force and no e-mail is sent', async () => {
    const s = await supplier()
    await sent({ kind: 'ADD', ownerKind: 'SUPPLIER', supplierId: s.id, bankCode: '002', accountNo: '1112223334', accountName: 'ร้าน ข', reason: 'บัญชีแรก' }).then(approve)
    const [account] = await activeOf(s.id)
    expect(await createBankAccountChange(fin(), { kind: 'CLOSE', ownerKind: 'SUPPLIER', supplierId: s.id, targetBankAccountId: account!.id, accountNo: '1112223335', reason: 'ผู้ขายปิดบัญชี' }, key())).toMatchObject({ ok: false, error: { details: { reason: 'CLOSE_HAS_ACCOUNT' } } })
    expect(await createBankAccountChange(fin(), { kind: 'CLOSE', ownerKind: 'SUPPLIER', supplierId: s.id, targetBankAccountId: account!.id, branchName: 'สาขาสีลม', reason: 'ผู้ขายปิดบัญชี' }, key())).toMatchObject({ ok: false, error: { details: { reason: 'CLOSE_HAS_ACCOUNT' } } })
    expect(await createBankAccountChange(fin(), { kind: 'CLOSE', ownerKind: 'SUPPLIER', supplierId: s.id, targetBankAccountId: account!.id, reason: 'ปิดบัญชี 111-222-3334 แล้ว' }, key())).toMatchObject({ ok: false, error: { details: { field: 'reason', reason: 'NOTE_HAS_ACCOUNT_NO' } } })
    const changeId = await sent({ kind: 'CLOSE', ownerKind: 'SUPPLIER', supplierId: s.id, targetBankAccountId: account!.id, reason: 'ผู้ขายปิดบัญชี' })
    ok(await approve(changeId))
    expect(await prisma.bankAccount.findUniqueOrThrow({ where: { id: account!.id } })).toMatchObject({ status: 'CLOSED' })
    expect(await prisma.supplierNotice.count({ where: { supplierId: s.id } })).toBe(1)
  })

  it('an account of the organization: its type is required, it pays with the neutral template, approved in LIFF with the PIN', async () => {
    expect(await createBankAccountChange(fin(), { kind: 'ADD', ownerKind: 'ORGANIZATION', bankCode: '004', accountNo: '4445556667', accountName: 'องค์กรทดสอบ DOA', reason: 'เปิดบัญชีจ่ายใหม่' }, key())).toMatchObject({ ok: false, error: { details: { field: 'accountType', reason: 'REQUIRED' } } })
    const changeId = await sent({ kind: 'ADD', ownerKind: 'ORGANIZATION', bankCode: '004', accountNo: '4445556667', accountName: 'องค์กรทดสอบ DOA', accountType: 'CURRENT', reason: 'เปิดบัญชีจ่ายใหม่' })
    expect(ok(await approve(changeId, 'LIFF'))).toMatchObject({ documentStatus: 'APPROVED' })
    const account = await prisma.bankAccount.findFirstOrThrow({ where: { sourceChangeId: changeId } })
    expect(account).toMatchObject({ ownerKind: 'ORGANIZATION', supplierId: null, accountType: 'CURRENT', fileTemplateCode: 'BCS-NEUTRAL-1', status: 'ACTIVE' })
  })

  it('returned to the proposer: back to the draft, edited and sent again under its number; rejected: no account moves', async () => {
    const s = await supplier()
    const changeId = await sent({ kind: 'ADD', ownerKind: 'SUPPLIER', supplierId: s.id, bankCode: '025', accountNo: '7778889990', accountName: 'ร้าน ค', reason: 'บัญชีแรก' })
    const number = (await prisma.bankAccountChange.findUniqueOrThrow({ where: { id: changeId } })).number
    let task = (await openTaskOf(changeId))!
    await stepUpForTask(task.id, task.assigneeMemberId)
    ok(await decideTask(ctxOf('cfo'), { taskId: task.id, decision: 'RETURN', reason: 'ชื่อบัญชีไม่ตรงหนังสือ' }, key()))
    expect(await prisma.bankAccountChange.findUniqueOrThrow({ where: { id: changeId } })).toMatchObject({ status: 'DRAFT', currentRouteId: null, decidedAt: null })
    expect(await prisma.notification.findFirstOrThrow({ where: { templateKey: 'bank_account_change.decided', subjectId: changeId } })).toMatchObject({ data: { outcome: 'RETURNED' } })
    ok(await updateBankAccountChange(fin(), { changeId, version: await versionOf(changeId), accountName: 'ร้าน ค จำกัด' }, key()))
    ok(await submitBankAccountChange(fin(), { changeId, version: await versionOf(changeId) }, key()))
    expect(await prisma.bankAccountChange.findUniqueOrThrow({ where: { id: changeId } })).toMatchObject({ number, status: 'PENDING_APPROVAL' })
    expect(await prisma.event.findFirstOrThrow({ where: { aggregateId: changeId, type: 'bank_account_change.submitted' }, orderBy: { seq: 'desc' } })).toMatchObject({ data: { resubmitted: true, number } })
    task = (await openTaskOf(changeId))!
    await stepUpForTask(task.id, task.assigneeMemberId)
    ok(await decideTask(ctxOf('cfo'), { taskId: task.id, decision: 'REJECT', reason: 'ไม่มีหนังสือยืนยันจากธนาคาร' }, key()))
    expect(await prisma.bankAccountChange.findUniqueOrThrow({ where: { id: changeId } })).toMatchObject({ status: 'REJECTED' })
    expect(await prisma.bankAccount.count({ where: { supplierId: s.id } })).toBe(0)
  })

  it('cancelled while waiting: its route and task close; a supplier has one open request, and an addition is refused once an account is in force', async () => {
    const s = await supplier()
    const changeId = await sent({ kind: 'ADD', ownerKind: 'SUPPLIER', supplierId: s.id, bankCode: '011', accountNo: '3334445556', accountName: 'ร้าน ง', reason: 'บัญชีแรก' })
    expect(await createBankAccountChange(fin(), { kind: 'ADD', ownerKind: 'SUPPLIER', supplierId: s.id, bankCode: '011', accountNo: '3334445557', accountName: 'ร้าน ง', reason: 'อีกใบ' }, key())).toMatchObject({ ok: false, error: { details: { reason: 'CHANGE_OPEN', changeId } } })
    // the reason names no account, and it is kept as a Comment: free text never goes into Event.data
    expect(await cancelBankAccountChange(fin(), { changeId, version: await versionOf(changeId), reason: 'เลข 333-444-5556 ผิด' }, key())).toMatchObject({ ok: false, error: { details: { field: 'reason', reason: 'NOTE_HAS_ACCOUNT_NO' } } })
    ok(await cancelBankAccountChange(fin(), { changeId, version: await versionOf(changeId), reason: 'ผู้ขายขอยกเลิก' }, key()))
    const cancelled = await prisma.event.findFirstOrThrow({ where: { aggregateId: changeId, type: 'bank_account_change.cancelled' } })
    expect(cancelled.data).toEqual({ from: 'PENDING_APPROVAL', reasonCommentId: expect.any(String) })
    expect(await prisma.comment.findUniqueOrThrow({ where: { id: (cancelled.data as { reasonCommentId: string }).reasonCommentId } })).toMatchObject({ subjectType: 'BankAccountChange', subjectId: changeId, body: 'ผู้ขายขอยกเลิก' })
    expect(await openTaskOf(changeId)).toBeNull()
    expect(await prisma.approvalRoute.findFirstOrThrow({ where: { subjectType: 'BANK_ACCOUNT_CHANGE', subjectId: changeId } })).toMatchObject({ status: 'CANCELLED' })
    await sent({ kind: 'ADD', ownerKind: 'SUPPLIER', supplierId: s.id, bankCode: '011', accountNo: '3334445556', accountName: 'ร้าน ง', reason: 'ส่งใหม่' }).then(approve)
    expect(await createBankAccountChange(fin(), { kind: 'ADD', ownerKind: 'SUPPLIER', supplierId: s.id, bankCode: '011', accountNo: '3334445558', accountName: 'ร้าน ง', reason: 'บัญชีที่สอง' }, key())).toMatchObject({ ok: false, error: { details: { reason: 'ACCOUNT_EXISTS' } } })
  })

  it('the account replaced left force while the request waited: TARGET_NOT_ACTIVE at the approval, nothing changes and the task stays open', async () => {
    const s = await supplier()
    await sent({ kind: 'ADD', ownerKind: 'SUPPLIER', supplierId: s.id, bankCode: '024', accountNo: '5556667778', accountName: 'ร้าน จ', reason: 'บัญชีแรก' }).then(approve)
    const [account] = await activeOf(s.id)
    const changeId = await sent({ kind: 'REPLACE', ownerKind: 'SUPPLIER', supplierId: s.id, targetBankAccountId: account!.id, bankCode: '024', accountNo: '5556667779', accountName: 'ร้าน จ', reason: 'เปลี่ยนบัญชี' }, { call: true })
    await prisma.bankAccount.update({ where: { id: account!.id }, data: { status: 'CLOSED', closedAt: AP_NOW } })
    expect(await approve(changeId)).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'TARGET_NOT_ACTIVE' } } })
    expect(await openTaskOf(changeId)).not.toBeNull()
    expect(await prisma.bankAccount.count({ where: { supplierId: s.id } })).toBe(1)
  })

  it('a draft payment run that pays the supplier: its preparer is told the account changed (digest)', async () => {
    const s = await supplier()
    await sent({ kind: 'ADD', ownerKind: 'SUPPLIER', supplierId: s.id, bankCode: '030', accountNo: '8889990001', accountName: 'ร้าน ฉ', reason: 'บัญชีแรก' }).then(approve)
    const [account] = await activeOf(s.id)
    // a payer account of the organization, as the seed of a sample organization makes one
    const payerId = (await prisma.bankAccount.create({ data: { organizationId: ap.org.organizationId, ownerKind: 'ORGANIZATION', code: `CB-${randomUUID().slice(0, 4)}`, bankCode: '004', accountNo: '1000000016', accountName: 'องค์กรทดสอบ DOA', accountType: 'CURRENT', fileTemplateCode: 'BCS-NEUTRAL-1', activatedAt: AP_NOW } })).id
    const run = await prisma.paymentRun.create({ data: { organizationId: ap.org.organizationId, payDate: new Date('2026-10-16T00:00:00Z'), payerBankAccountId: payerId, fileTemplateCode: 'BCS-NEUTRAL-1', preparedById: ap.org.member.dm_fin! } })
    await prisma.paymentRunItem.create({ data: { organizationId: ap.org.organizationId, paymentRunId: run.id, supplierId: s.id } })
    const changeId = await sent({ kind: 'REPLACE', ownerKind: 'SUPPLIER', supplierId: s.id, targetBankAccountId: account!.id, bankCode: '030', accountNo: '8889990002', accountName: 'ร้าน ฉ', reason: 'เปลี่ยนบัญชี' }, { call: true })
    ok(await approve(changeId))
    const told = await prisma.notification.findFirstOrThrow({ where: { recipientMemberId: ap.org.member.dm_fin!, templateKey: 'payment_run.account_changed' } })
    expect(told).toMatchObject({ urgency: 'DIGEST', subjectType: 'PAYMENT_RUN', subjectId: run.id })
    expect(renderNotification(told, 'th')).toMatchObject({ href: `/finance/payments/${run.id}` })
  })
})

describe('[FR-PAY-102/AC7] what is refused', () => {
  it('[BR-SOD-05] the proposer may not approve their own request: SOD_VIOLATION with security.sod_blocked, the task stays open', async () => {
    const s = await supplier()
    const changeId = await sent({ kind: 'ADD', ownerKind: 'SUPPLIER', supplierId: s.id, bankCode: '069', accountNo: '9990001112', accountName: 'ร้าน ช', reason: 'บัญชีแรก' })
    const task = (await openTaskOf(changeId))!
    await prisma.approvalTask.update({ where: { id: task.id }, data: { assigneeMemberId: ap.org.member.fin_officer! } })
    await stepUpForTask(task.id, ap.org.member.fin_officer!)
    expect(await decideTask(fin(), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'SOD_VIOLATION', details: { rule: 'BR-SOD-05' } } })
    expect(await prisma.event.findFirst({ where: { type: 'security.sod_blocked', aggregateId: changeId } })).toMatchObject({ data: { rule: 'BR-SOD-05', subjectType: 'BANK_ACCOUNT_CHANGE' } })
    expect((await prisma.approvalTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('OPEN')
    expect(await activeOf(s.id)).toHaveLength(0)
  })

  it('[BR-DOA-25] not from a chat button or an e-mail link: FORBIDDEN reason CHANNEL even with the PIN', async () => {
    const s = await supplier()
    const changeId = await sent({ kind: 'ADD', ownerKind: 'SUPPLIER', supplierId: s.id, bankCode: '073', accountNo: '1212121212', accountName: 'ร้าน ซ', reason: 'บัญชีแรก' })
    const task = (await openTaskOf(changeId))!
    await stepUpForTask(task.id, task.assigneeMemberId)
    for (const channel of ['LINE_CHAT', 'EMAIL'] as const) {
      expect(await decideTask(ctxOf('cfo', channel), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', details: { reason: 'CHANNEL' } } })
    }
    expect(await activeOf(s.id)).toHaveLength(0)
  })

  it('[BR-SUP-06] only FINANCE proposes, and only the proposer edits, sends or cancels', async () => {
    const s = await supplier()
    const input = { kind: 'ADD' as const, ownerKind: 'SUPPLIER' as const, supplierId: s.id, bankCode: '004', accountNo: '1231231231', accountName: 'ร้าน ฌ', reason: 'บัญชีแรก' }
    for (const code of ['proc_officer', 'auditor', 'admin', 'cfo']) {
      expect(await createBankAccountChange(ctxOf(code), input, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', details: { capability: 'bankAccountChange.propose' } } })
    }
    const { changeId } = ok(await createBankAccountChange(fin(), input, key()))
    const other = ctxOf('dm_fin')
    expect(await updateBankAccountChange(other, { changeId, version: await versionOf(changeId), accountName: 'อื่น' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await attachBankProof(other, { changeId, version: await versionOf(changeId), fileId: await proof('dm_fin') }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await submitBankAccountChange(other, { changeId, version: await versionOf(changeId) }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await cancelBankAccountChange(other, { changeId, version: await versionOf(changeId), reason: 'ไม่ใช่ของฉัน' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    // a file the proposer did not upload, or not a paper
    expect(await attachBankProof(fin(), { changeId, version: await versionOf(changeId), fileId: await proof('dm_fin') }, key())).toMatchObject({ ok: false, error: { details: { reason: 'FILE' } } })
    expect(await attachBankProof(fin(), { changeId, version: await versionOf(changeId), fileId: await proof('fin_officer', 'application/xml') }, key())).toMatchObject({ ok: false, error: { details: { reason: 'TYPE_NOT_ALLOWED' } } })
    const fileId = await proof()
    ok(await attachBankProof(fin(), { changeId, version: await versionOf(changeId), fileId }, key()))
    ok(await detachBankProof(fin(), { changeId, version: await versionOf(changeId), fileId }, key()))
    expect(await submitBankAccountChange(fin(), { changeId, version: await versionOf(changeId) }, key())).toMatchObject({ ok: false, error: { details: { reason: 'PROOF_REQUIRED' } } })
  })

  it('[BR-SUP-07] the number, the bank and the name are checked as GC-SUP-01 to GC-SUP-08 check them', async () => {
    const s = await supplier()
    const base = { kind: 'ADD' as const, ownerKind: 'SUPPLIER' as const, supplierId: s.id, bankCode: '004', accountNo: '1234567890', accountName: 'ร้าน ญ', reason: 'บัญชีแรก' }
    const refusal = async (change: Partial<typeof base>) => (await createBankAccountChange(fin(), { ...base, ...change }, key())) as unknown as { ok: false; error: { details: { reason: string } } }
    expect((await refusal({ accountNo: '123456789' })).error.details.reason).toBe('ACCOUNT_NO_LENGTH')
    expect((await refusal({ accountNo: '12345A7890' })).error.details.reason).toBe('ACCOUNT_NO_FORMAT')
    expect((await refusal({ bankCode: '999' })).error.details.reason).toBe('BANK_CODE_UNKNOWN')
    expect((await refusal({ accountName: 'ร้าน\u0007ญ' })).error.details.reason).toBe('ACCOUNT_NAME_FORMAT')
    expect(await createBankAccountChange(fin(), { ...base, accountName: 'ก'.repeat(201) }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(await createBankAccountChange(fin(), { ...base, accountType: 'SAVINGS' }, key())).toMatchObject({ ok: false, error: { details: { field: 'accountType', reason: 'OWNER' } } })
    expect(await createBankAccountChange(fin(), { ...base, reason: 'ผู้ขายแจ้งเลข ๑๒๓๔๕๖๗๘๙๐' }, key())).toMatchObject({ ok: false, error: { details: { field: 'reason', reason: 'NOTE_HAS_ACCOUNT_NO' } } })
    const { changeId } = ok(await createBankAccountChange(fin(), { ...base, accountNo: '1234 567-890' }, key()))
    expect(await prisma.bankAccountChange.findUniqueOrThrow({ where: { id: changeId } })).toMatchObject({ accountNo: '1234567890' })
  })

  it('a supplier using an account another tax id uses is drafted with the warning SHARED_BANK_ACCOUNT', async () => {
    const a = await supplier()
    await sent({ kind: 'ADD', ownerKind: 'SUPPLIER', supplierId: a.id, bankCode: '006', accountNo: '4040404040', accountName: 'ร้านร่วม', reason: 'บัญชีแรก' }).then(approve)
    const b = await supplier()
    expect(ok(await createBankAccountChange(fin(), { kind: 'ADD', ownerKind: 'SUPPLIER', supplierId: b.id, bankCode: '006', accountNo: '4040404040', accountName: 'ร้านร่วม', reason: 'บัญชีเดียวกัน' }, key()))).toMatchObject({ warnings: ['SHARED_BANK_ACCOUNT'] })
  })

  it('[BR-PAY-01] module PAY off: MODULE_DISABLED to propose and to decide, the task stays open', async () => {
    const s = await supplier()
    const changeId = await sent({ kind: 'ADD', ownerKind: 'SUPPLIER', supplierId: s.id, bankCode: '004', accountNo: '5050505050', accountName: 'ร้าน ฎ', reason: 'บัญชีแรก' })
    await prisma.orgModule.updateMany({ where: { organizationId: ap.org.organizationId, module: 'PAY' }, data: { enabled: false } })
    try {
      expect(await createBankAccountChange(fin(), { kind: 'ADD', ownerKind: 'ORGANIZATION', bankCode: '004', accountNo: '5050505051', accountName: 'องค์กร', accountType: 'SAVINGS', reason: 'ทดสอบ' }, key())).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
      expect(await approve(changeId)).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
      expect(await openTaskOf(changeId)).not.toBeNull()
      expect(await listBankAccounts(fin())).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
    } finally {
      await prisma.orgModule.updateMany({ where: { organizationId: ap.org.organizationId, module: 'PAY' }, data: { enabled: true } })
    }
  })
})

describe('[FR-PAY-102/AC8] numbers masked on every page; opened whole by FINANCE and the approver only, logged', () => {
  it('AUDITOR and PROCUREMENT see masked numbers and may not open them; FINANCE and the approver open them with a SensitiveAccessLog row each', async () => {
    const s = await supplier()
    const changeId = await sent({ kind: 'ADD', ownerKind: 'SUPPLIER', supplierId: s.id, bankCode: '014', accountNo: '6060606061', accountName: 'ร้าน ฏ', reason: 'บัญชีแรก' })
    const logs = (subjectId: string) => prisma.sensitiveAccessLog.findMany({ where: { subjectId } })

    // the approver (CFO, no role FINANCE) reads the request masked and opens it whole; a member without a task may not
    const asCfo = ok(await getBankAccountChange(ctxOf('cfo'), { changeId }))
    expect(asCfo).toMatchObject({ canReveal: true, proposed: { accountNoMasked: '••••••6061', last4: '6061' } })
    expect(JSON.stringify(asCfo)).not.toContain('6060606061')
    expect(await getBankAccountChange(ctxOf('vp_ops'), { changeId })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(ok(await revealBankAccountChange(ctxOf('cfo'), { changeId }))).toEqual({ accountNo: '6060606061', targetAccountNo: null })
    expect(await logs(changeId)).toEqual([expect.objectContaining({ memberId: ap.org.member.cfo, subjectType: 'BankAccountChange', fields: ['accountNo'], purpose: 'bankAccount.reveal' })])
    // its proofs show the number whole: downloaded under the same rule, logged
    expect(await getDownloadUrl(ctxOf('cfo'), { fileId: (await prisma.fileLink.findFirstOrThrow({ where: { subjectId: changeId, kind: 'BANK_PROOF' } })).fileId })).toMatchObject({ ok: true })
    expect((await logs(changeId)).map((l) => l.purpose)).toEqual(expect.arrayContaining(['download']))
    ok(await approve(changeId))
    const [account] = await activeOf(s.id)

    for (const code of ['auditor', 'proc_officer']) {
      const listed = ok(await listBankAccounts(ctxOf(code), { supplierId: s.id }))
      expect(listed).toEqual([expect.objectContaining({ id: account!.id, accountNoMasked: '••••••6061', last4: '6061', bankName: 'ธนาคารไทยพาณิชย์' })])
      expect(JSON.stringify(listed)).not.toContain('6060606061')
      expect(await revealBankAccount(ctxOf(code), { bankAccountId: account!.id })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', details: { capability: 'bankAccount.reveal' } } })
      expect(await revealBankAccountChange(ctxOf(code), { changeId })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
      const fileId = (await prisma.fileLink.findFirstOrThrow({ where: { subjectId: changeId, kind: 'BANK_PROOF' } })).fileId
      expect(await getDownloadUrl(ctxOf(code), { fileId })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    }
    expect(await listBankAccounts(ctxOf('req_con'))).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', details: { capability: 'bankAccount.view' } } })
    // decided, the approver opens the request's numbers still, but no longer the account's (only while a request on it waits)
    expect(ok(await revealBankAccountChange(ctxOf('cfo'), { changeId }))).toMatchObject({ accountNo: '6060606061' })
    expect(await revealBankAccount(ctxOf('cfo'), { bankAccountId: account!.id })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(ok(await revealBankAccount(fin(), { bankAccountId: account!.id }))).toEqual({ accountNo: '6060606061' })
    expect(await logs(account!.id)).toEqual([expect.objectContaining({ memberId: ap.org.member.fin_officer, subjectType: 'BankAccount', fields: ['accountNo'] })])
  })
})

/** The JSON lines the app logs while `run` runs (the app's serializers and redaction) */
async function logsOf(run: () => Promise<unknown>): Promise<string> {
  const lines: string[] = []
  const sink = createLogger(new Writable({ write: (chunk, _e, done) => (lines.push(String(chunk)), done()) }), 'trace')
  const spies = [vi.spyOn(logger, 'child').mockImplementation(((b, o) => sink.child(b, o)) as typeof logger.child)]
  for (const level of ['info', 'warn', 'error', 'debug'] as const) spies.push(vi.spyOn(logger, level).mockImplementation(((...a: unknown[]) => (sink[level] as (...x: unknown[]) => void)(...a)) as never) as never)
  try {
    logger.info({ probe: true }, 'log capture probe')
    await run()
  } finally {
    spies.forEach((s) => s.mockRestore())
  }
  return lines.join('\n')
}

describe('[NFR-SEC-09] no account number whole in a log, an event, a notification, a LINE card or an e-mail', () => {
  it('a replacement from proposal to the supplier’s e-mail', async () => {
    const OLD = '7070707071'
    const NEW = '7171717172'
    const s = await supplier()
    let changeId = ''
    let card = ''
    const logged = await logsOf(async () => {
      await sent({ kind: 'ADD', ownerKind: 'SUPPLIER', supplierId: s.id, bankCode: '022', accountNo: OLD, accountName: 'ร้าน ฐ', reason: 'บัญชีแรก' }).then(approve)
      const [first] = await activeOf(s.id)
      changeId = await sent({ kind: 'REPLACE', ownerKind: 'SUPPLIER', supplierId: s.id, targetBankAccountId: first!.id, bankCode: '022', accountNo: NEW, accountName: 'ร้าน ฐ', reason: 'เปลี่ยนบัญชี' }, { call: true })
      const task = (await openTaskOf(changeId))!
      // the card as delivery builds it for task.assigned: the label the notification carries
      const assigned = await prisma.notification.findFirstOrThrow({ where: { templateKey: 'task.assigned', subjectId: changeId } })
      const label = (assigned.data as { label: string }).label
      const message = await approvalCardMessage(ap.org.organizationId, { taskId: task.id, memberId: task.assigneeMemberId, fallbackLabel: label }, AP_NOW, { locale: 'th', liffId: null, appUrl: 'http://localhost' })
      card = JSON.stringify(message)
      ok(await approve(changeId))
      for (const n of await prisma.supplierNotice.findMany({ where: { supplierId: s.id } })) await sendSupplierNotice(ap.org.organizationId, n.id, AP_NOW)
    })
    expect(logged).toContain('log capture probe')
    expect(card).toMatch(/BAC-\d{4}-\d{5} เปลี่ยนบัญชี ผู้ขาย SB-/)
    const changes = await prisma.bankAccountChange.findMany({ where: { supplierId: s.id }, select: { id: true } })
    const accounts = await prisma.bankAccount.findMany({ where: { supplierId: s.id }, select: { id: true } })
    const ids = [...changes, ...accounts].map((r) => r.id)
    const tasks = await prisma.approvalTask.findMany({ where: { step: { route: { subjectId: { in: changes.map((c) => c.id) } } } }, select: { id: true } })
    const events = await prisma.event.findMany({ where: { organizationId: ap.org.organizationId, aggregateId: { in: [...ids, ...tasks.map((t) => t.id)] } } })
    expect(events.length).toBeGreaterThan(8)
    const notifications = await prisma.notification.findMany({ where: { organizationId: ap.org.organizationId, subjectId: { in: [...changes.map((c) => c.id)] } } })
    const mails = await messagesTo(s.email!)
    expect(mails).toHaveLength(2)
    const notices = await prisma.supplierNotice.findMany({ where: { supplierId: s.id } })
    for (const number of [OLD, NEW]) {
      for (const [what, text] of [
        ['log', logged],
        ['events', JSON.stringify(events.map((e) => e.data))],
        ['notifications', JSON.stringify(notifications.map((n) => n.data))],
        ['LINE card', card],
        ['e-mails', JSON.stringify(mails.map((m) => [m.Subject, m.Text, m.HTML]))],
        ['supplier notices', JSON.stringify(notices.map((n) => n.data))],
      ] as const) {
        expect({ what, leaked: text.includes(number) }).toEqual({ what, leaked: false })
      }
    }
  })
})
