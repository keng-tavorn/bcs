import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { decideRequestTask } from '@/app/(workspace)/_tracking/commands'
import {
  attachProofFor,
  cancelChangeFor,
  createChangeFor,
  detachProofFor,
  recordCallFor,
  revealAccountFor,
  revealChangeFor,
  submitChangeFor,
  updateChangeFor,
} from '@/app/(workspace)/finance/bank-accounts/commands'
import type { Ctx } from '@/server/context'
import { prisma } from '@/server/db/client'
import {
  getBankAccountChange,
  getBankAccountChangeActivity,
  getBankAccountChangeForm,
  getSupplierBankCard,
  listBankAccountChanges,
  listBankAccounts,
} from '@/server/services/bank-accounts/view'
import type { BankOutcome } from '@/ui/bank-accounts/outcome'
import { AP_NOW, apOrg, ok } from '../support/ap'
import { payOrg, type PayOrg } from '../support/pay'
import { ensureTestPin, TEST_PIN, testStepUpSession } from '../support/pin'

// S9-09 (docs/sub-specs/S9.md "หน้าจอ", FR-PAY-102 AC7 AC8): what /finance/bank-accounts, the proposal form, a request's
// page and the supplier's card "บัญชีรับเงิน" read and do — the organization's payer accounts and the requests by tab, the
// choices of the form (every number masked), a draft made, given its paper and its call, sent, decided by the approver
// with the PIN through the decision page's path, cancelled with a reason, the history in order, and the whole numbers
// opened by FINANCE and the approver only, each opening logged. Every view and command checks its capability and module
// PAY; members without them and organizations without PAY are refused, and the card is not shown.

let ap: PayOrg
const ctxOf = (code: string): Ctx => ap.org.ctxOf(code, AP_NOW)
const fin = () => ctxOf('fin_officer')
const uuid = () => randomUUID()
const versionOf = async (changeId: string) => (await prisma.bankAccountChange.findUniqueOrThrow({ where: { id: changeId } })).version
const done = (outcome: BankOutcome) => {
  if (!outcome.ok) throw new Error(JSON.stringify(outcome))
  return outcome
}

/** A supplier of its own with a phone in the register and, unless asked otherwise, an account in force from the seed */
async function supplier(options: { account?: boolean } = {}) {
  const n = randomUUID().slice(0, 8)
  const s = await prisma.supplier.create({
    data: { organizationId: ap.org.organizationId, code: `SB-${n}`, nameTh: `ผู้ขาย ${n}`, taxId: `08${Array.from({ length: 11 }, () => Math.floor(Math.random() * 10)).join('')}`, phone: '02-555-0101' },
  })
  const accountNo = `3${Array.from({ length: 9 }, () => Math.floor(Math.random() * 10)).join('')}`
  const account =
    options.account === false
      ? null
      : await prisma.bankAccount.create({ data: { organizationId: ap.org.organizationId, ownerKind: 'SUPPLIER', supplierId: s.id, bankCode: '014', accountNo, accountName: `ผู้ขาย ${n}`, activatedAt: new Date('2026-01-01T00:00:00Z') } })
  return { id: s.id, code: s.code, account, accountNo }
}

/** A paper the member uploaded (the files service would have checked it) */
async function proof(by = 'fin_officer') {
  const f = await prisma.fileObject.create({
    data: { organizationId: ap.org.organizationId, storageKey: `test/${randomUUID()}.pdf`, fileName: 'หนังสือแจ้งเปลี่ยนบัญชี.pdf', mimeType: 'application/pdf', sizeBytes: 1, sha256: '0'.repeat(64), status: 'AVAILABLE', uploadedById: ap.org.member[by]! },
  })
  return f.id
}

const openTaskOf = (changeId: string) => prisma.approvalTask.findFirst({ where: { status: 'OPEN', step: { route: { subjectType: 'BANK_ACCOUNT_CHANGE', subjectId: changeId } } } })

beforeAll(async () => {
  ap = await payOrg()
})

describe('[FR-PAY-102/AC8] /finance/bank-accounts: the payer accounts masked and the requests by tab', () => {
  it('lists the organization’s payer accounts masked; the requests open and all with their counts, newest first', async () => {
    const accounts = ok(await listBankAccounts(fin(), { ownerKind: 'ORGANIZATION' }))
    expect(accounts).toEqual([expect.objectContaining({ id: ap.payerId, code: 'CB-01', bankName: 'ธนาคารกสิกรไทย', accountNoMasked: '••••••0016', last4: '0016', status: 'ACTIVE', fileTemplateCode: 'BCS-NEUTRAL-1' })])
    expect(JSON.stringify(accounts)).not.toContain('1000000016')

    const s = await supplier({ account: false })
    const before = ok(await listBankAccountChanges(fin(), { tab: 'all' })).counts
    const changeId = done(await createChangeFor(fin(), { kind: 'ADD', ownerKind: 'SUPPLIER', supplierId: s.id, bankCode: '004', accountNo: '111-2-22333-4', accountName: 'ร้าน ทดสอบ', reason: 'ผู้ขายรายใหม่ส่งหนังสือ' }, uuid())).changeId!
    const open = ok(await listBankAccountChanges(fin(), { tab: 'open' }))
    expect(open.counts).toEqual({ open: before.open + 1, all: before.all + 1 })
    expect(open.rows[0]).toMatchObject({ id: changeId, number: null, kind: 'ADD', ownerKind: 'SUPPLIER', status: 'DRAFT', supplier: { id: s.id, code: s.code }, proposer: { id: ap.org.member.fin_officer }, submittedAt: null })
    expect(JSON.stringify(open)).not.toContain('1112223334')
    expect(open.canPropose).toBe(true)
    // with no tab the open ones come first
    expect(ok(await listBankAccountChanges(fin())).tab).toBe('open')
    // cancelled, it leaves the open tab and stays in all
    done(await cancelChangeFor(fin(), { changeId, version: await versionOf(changeId), reason: 'เสนอผิดผู้ขาย' }, uuid()))
    expect(ok(await listBankAccountChanges(fin(), { tab: 'open' })).rows.map((r) => r.id)).not.toContain(changeId)
    expect(ok(await listBankAccountChanges(fin(), { tab: 'all' })).rows.find((r) => r.id === changeId)).toMatchObject({ status: 'CANCELLED' })
  })

  it('PROCUREMENT and AUDITOR read it but may not propose; a member without bankAccount.view and an organization without PAY are refused', async () => {
    for (const code of ['proc_officer', 'auditor']) {
      expect(ok(await listBankAccountChanges(ctxOf(code), { tab: 'all' })).canPropose).toBe(false)
      expect(await getBankAccountChangeForm(ctxOf(code))).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', details: { capability: 'bankAccountChange.propose' } } })
    }
    expect(await listBankAccountChanges(ctxOf('req_con'))).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', details: { capability: 'bankAccount.view' } } })
    expect(await listBankAccountChanges(fin(), { tab: 'nothing' as 'all' })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    const off = await apOrg({ modules: [] })
    const offCtx = off.org.ctxOf('fin_officer', AP_NOW)
    expect(await listBankAccountChanges(offCtx)).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
    expect(await getBankAccountChangeForm(offCtx)).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
    expect(ok(await getSupplierBankCard(offCtx, { supplierId: off.supplierId }))).toBeNull()
  })
})

describe('[FR-PAY-102/AC7] the proposal form and the request page: draft, paper, call, send, decide with the PIN', () => {
  it('the form’s choices: the banks of the list, the suppliers with their account in force and the company’s accounts, all masked', async () => {
    const s = await supplier()
    const form = ok(await getBankAccountChangeForm(fin()))
    expect(form.banks).toEqual(expect.arrayContaining([{ code: '004', shortName: 'KBANK', nameTh: 'ธนาคารกสิกรไทย' }]))
    expect(form.suppliers.find((x) => x.id === s.id)).toMatchObject({ code: s.code, active: true, phone: '02-555-0101', account: { id: s.account!.id, accountNoMasked: `••••••${s.accountNo.slice(-4)}`, openChangeId: null }, openChangeId: null })
    expect(form.organizationAccounts).toEqual([expect.objectContaining({ id: ap.payerId, code: 'CB-01', accountNoMasked: '••••••0016' })])
    expect(JSON.stringify(form)).not.toContain(s.accountNo)
    expect(JSON.stringify(form)).not.toContain('1000000016')
  })

  it('refuses a malformed call, a short reason and a missing target before the service; the service’s refusals come back with their field', async () => {
    const s = await supplier()
    const base = { kind: 'REPLACE', ownerKind: 'SUPPLIER', supplierId: s.id, targetBankAccountId: s.account!.id, bankCode: '006', accountNo: '4445556667', accountName: 'ร้าน ข', reason: 'ผู้ขายแจ้งเปลี่ยนบัญชี' }
    expect(await createChangeFor(fin(), base, 'not-a-key')).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: 'idempotencyKey' })
    expect(await createChangeFor(fin(), { ...base, kind: 'MOVE' }, uuid())).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: 'kind' })
    expect(await createChangeFor(fin(), { ...base, reason: ' ก ' }, uuid())).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: 'reason', reason: 'REASON_SHORT' })
    expect(await createChangeFor(fin(), { ...base, targetBankAccountId: null }, uuid())).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: 'targetBankAccountId', reason: 'REQUIRED' })
    expect(await createChangeFor(fin(), { ...base, accountNo: '12-34' }, uuid())).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', field: 'accountNo', reason: 'ACCOUNT_NO_LENGTH' })
    expect(await createChangeFor(fin(), { ...base, kind: 'ADD', targetBankAccountId: null }, uuid())).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', field: 'kind', reason: 'ACCOUNT_EXISTS' })
    expect(await createChangeFor(fin(), { ...base, reason: 'บัญชีใหม่ 444-555-6667' }, uuid())).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', field: 'reason', reason: 'NOTE_HAS_ACCOUNT_NO' })
    // only FINANCE proposes (bankAccountChange.propose): the service refuses PROCUREMENT
    expect(await createChangeFor(ctxOf('proc_officer'), base, uuid())).toMatchObject({ ok: false, code: 'FORBIDDEN' })
  })

  it('a replacement drafted, given its paper and its call, sent, read by FINANCE, the approver and AUDITOR, approved with the PIN', async () => {
    const s = await supplier()
    const key = uuid()
    const input = { kind: 'REPLACE', ownerKind: 'SUPPLIER', supplierId: s.id, targetBankAccountId: s.account!.id, bankCode: '006', accountNo: '777-8-88999-0', accountName: ' ร้าน ค ', branchName: ' สาขาบางนา ', reason: 'ผู้ขายแจ้งเปลี่ยนบัญชีเป็นธนาคารใหม่' }
    const created = done(await createChangeFor(fin(), input, key))
    expect(created).toMatchObject({ version: 0, warnings: [] })
    const changeId = created.changeId!
    // the same submission twice makes one draft
    expect(await createChangeFor(fin(), input, key)).toMatchObject({ ok: true, changeId })
    expect(await prisma.bankAccountChange.findUniqueOrThrow({ where: { id: changeId } })).toMatchObject({ accountNo: '7778889990', accountName: 'ร้าน ค', branchName: 'สาขาบางนา', status: 'DRAFT' })
    // a supplier has one open request: the form says so for the supplier and the account
    const form = ok(await getBankAccountChangeForm(fin())).suppliers.find((x) => x.id === s.id)!
    expect(form).toMatchObject({ openChangeId: changeId, account: { openChangeId: changeId } })

    // sending asks for the paper, then for the call to the number in the register
    expect(await submitChangeFor(fin(), { changeId, version: 0 }, uuid())).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', field: 'proof', reason: 'PROOF_REQUIRED' })
    const fileId = await proof()
    expect(done(await attachProofFor(fin(), { changeId, version: 0, fileId }, uuid())).version).toBe(1)
    expect(await attachProofFor(fin(), { changeId, version: 0, fileId: await proof() }, uuid())).toMatchObject({ ok: false, code: 'CONFLICT_VERSION' })
    // another member's file is not a paper of this request
    expect(await attachProofFor(fin(), { changeId, version: 1, fileId: await proof('dm_fin') }, uuid())).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', field: 'fileId', reason: 'FILE' })
    const extra = await proof()
    expect(done(await attachProofFor(fin(), { changeId, version: 1, fileId: extra }, uuid())).version).toBe(2)
    expect(done(await detachProofFor(fin(), { changeId, version: 2, fileId: extra }, uuid())).version).toBe(3)
    expect(await submitChangeFor(fin(), { changeId, version: 3 }, uuid())).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', field: 'callVerificationNote', reason: 'CALL_VERIFICATION_REQUIRED' })
    expect(await recordCallFor(fin(), { changeId, version: 3, note: 'ok' }, uuid())).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: 'callVerificationNote', reason: 'NOTE_SHORT' })
    expect(await recordCallFor(fin(), { changeId, version: 3, note: 'ยืนยันเลข ๗๗๗๘๘๘๙๙๙๐ แล้ว' }, uuid())).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', field: 'callVerificationNote', reason: 'NOTE_HAS_ACCOUNT_NO' })
    expect(done(await recordCallFor(fin(), { changeId, version: 3, note: 'โทร 02-555-0101 ตามทะเบียน คุณสมศรียืนยันการเปลี่ยน' }, uuid())).version).toBe(4)
    // only the proposer edits the draft; nothing changed is said so
    expect(await updateChangeFor(ctxOf('dm_fin'), { changeId, version: 4, reason: 'แก้เหตุผลแทน' }, uuid())).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await updateChangeFor(fin(), { changeId, version: 4 }, uuid())).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', reason: 'NOTHING' })
    expect(done(await updateChangeFor(fin(), { changeId, version: 4, accountNo: '', accountName: 'ร้าน ค จำกัด', branchName: '' }, uuid())).version).toBe(5)
    // the name changed: the call confirmed the account as it was, so it is asked for again
    expect(await prisma.bankAccountChange.findUniqueOrThrow({ where: { id: changeId } })).toMatchObject({ accountNo: '7778889990', accountName: 'ร้าน ค จำกัด', branchName: null, callVerifiedAt: null })
    done(await recordCallFor(fin(), { changeId, version: 5, note: 'โทรซ้ำ 02-555-0101 ยืนยันชื่อบัญชีใหม่' }, uuid()))
    const sent = done(await submitChangeFor(fin(), { changeId, version: 6 }, uuid()))
    expect(sent.number).toMatch(/^BAC-\d{4}-\d{5}$/)

    // FINANCE, its proposer: the request masked, its history, who holds it now, the register's phone for the call
    const view = ok(await getBankAccountChange(fin(), { changeId }))
    expect(view).toMatchObject({ status: 'PENDING_APPROVAL', canReveal: true, proposed: { accountNoMasked: '••••••9990' }, target: { id: s.account!.id }, proofs: [{ fileId }] })
    const activity = ok(await getBankAccountChangeActivity(fin(), { changeId }))
    expect(activity).toMatchObject({ isProposer: true, openTaskId: null, supplierPhone: '02-555-0101', proposer: { id: ap.org.member.fin_officer }, waitingFor: [{ id: ap.org.member.cfo }] })
    expect(activity.banks.length).toBeGreaterThan(0)
    expect(activity.history.map((h) => h.type)).toEqual([
      'bank_account_change.drafted',
      'bank_account_change.updated',
      'bank_account_change.updated',
      'bank_account_change.updated',
      'bank_account_change.updated',
      'bank_account_change.updated',
      'bank_account_change.updated',
      'bank_account_change.submitted',
    ])
    expect(activity.history[1]).toMatchObject({ fields: ['proof'], actor: { id: ap.org.member.fin_officer }, channel: 'WEB' })
    expect(JSON.stringify(activity)).not.toContain('7778889990')

    // the approver (CFO, as BA-01 names) holds the open task: the decision bar's; another FINANCE does not propose it
    const task = (await openTaskOf(changeId))!
    expect(task.assigneeMemberId).toBe(ap.org.member.cfo)
    const asCfo = ok(await getBankAccountChangeActivity(ctxOf('cfo'), { changeId }))
    expect(asCfo).toMatchObject({ openTaskId: task.id, isProposer: false, supplierPhone: null, banks: [] })
    expect(ok(await getBankAccountChangeActivity(ctxOf('dm_fin'), { changeId }))).toMatchObject({ isProposer: false, openTaskId: null })
    // AUDITOR reads it masked and may not open the numbers; a member without bankAccount.view may not read it
    expect(ok(await getBankAccountChangeActivity(ctxOf('auditor'), { changeId }))).toMatchObject({ isProposer: false, openTaskId: null })
    expect(await revealChangeFor(ctxOf('auditor'), { changeId })).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await getBankAccountChangeActivity(ctxOf('req_con'), { changeId })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await getBankAccountChangeActivity(fin(), { changeId: 'nope' })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })

    // FINANCE and the approver open both numbers whole, each opening logged (NFR-PRIV-03)
    const logs = () => prisma.sensitiveAccessLog.count({ where: { subjectId: { in: [changeId, s.account!.id] }, purpose: 'bankAccount.reveal' } })
    const logged = await logs()
    expect(await revealChangeFor(fin(), { changeId })).toEqual({ ok: true, accountNo: '7778889990', targetAccountNo: s.accountNo })
    expect(await revealChangeFor(ctxOf('cfo'), { changeId })).toEqual({ ok: true, accountNo: '7778889990', targetAccountNo: s.accountNo })
    expect(await logs()).toBe(logged + 4)
    expect(await revealChangeFor(fin(), { changeId: 'nope' })).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: 'changeId' })

    // the decision bar's path: the proposer may not decide; the CFO decides with the PIN, never without it
    expect(await decideRequestTask(fin(), { taskId: task.id, decision: 'APPROVE', pin: TEST_PIN }, uuid(), 'th', testStepUpSession())).toMatchObject({ ok: false })
    await ensureTestPin(ap.org.member.cfo!)
    expect(await decideRequestTask(ctxOf('cfo'), { taskId: task.id, decision: 'APPROVE' }, uuid(), 'th', testStepUpSession())).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: 'pin' })
    expect(await decideRequestTask(ctxOf('cfo'), { taskId: task.id, decision: 'APPROVE', pin: TEST_PIN }, uuid(), 'th', testStepUpSession())).toEqual({ ok: true, documentStatus: 'APPROVED' })
    const [active] = await prisma.bankAccount.findMany({ where: { supplierId: s.id, status: 'ACTIVE' } })
    expect(active).toMatchObject({ accountNo: '7778889990', sourceChangeId: changeId })
    const after = ok(await getBankAccountChangeActivity(fin(), { changeId }))
    expect(after.history.slice(-2).map((h) => [h.type, h.decision])).toEqual([
      ['approval_task.decided', 'APPROVE'],
      ['bank_account_change.approved', null],
    ])
    expect(after.history.at(-2)).toMatchObject({ actor: { id: ap.org.member.cfo } })
    expect(after).toMatchObject({ openTaskId: null, waitingFor: [] })
    expect(ok(await getBankAccountChange(fin(), { changeId }))).toMatchObject({ status: 'APPROVED', applied: { id: active!.id, accountNoMasked: '••••••9990' } })
  })

  it('a return comes back to the proposer’s draft with its reason in the history; a cancellation keeps its reason, and names no account', async () => {
    const created = done(await createChangeFor(fin(), { kind: 'ADD', ownerKind: 'ORGANIZATION', bankCode: '002', accountNo: '9090909091', accountName: 'องค์กรทดสอบ', accountType: 'SAVINGS', reason: 'เปิดบัญชีผู้จ่ายที่สอง' }, uuid()))
    const changeId = created.changeId!
    expect(await prisma.bankAccountChange.findUniqueOrThrow({ where: { id: changeId } })).toMatchObject({ ownerKind: 'ORGANIZATION', accountType: 'SAVINGS', fileTemplateCode: 'BCS-NEUTRAL-1' })
    done(await attachProofFor(fin(), { changeId, version: 0, fileId: await proof() }, uuid()))
    done(await submitChangeFor(fin(), { changeId, version: 1 }, uuid()))
    const task = (await openTaskOf(changeId))!
    await ensureTestPin(task.assigneeMemberId)
    const approver = Object.entries(ap.org.member).find(([, id]) => id === task.assigneeMemberId)![0]
    expect(await decideRequestTask(ctxOf(approver), { taskId: task.id, decision: 'RETURN', reason: 'แนบหนังสือธนาคารฉบับเต็ม', pin: TEST_PIN }, uuid(), 'th', testStepUpSession())).toEqual({ ok: true, documentStatus: 'DRAFT' })
    const returned = ok(await getBankAccountChangeActivity(fin(), { changeId }))
    expect(returned.isProposer).toBe(true)
    expect(returned.history.find((h) => h.type === 'approval_task.decided')).toMatchObject({ decision: 'RETURN', note: 'แนบหนังสือธนาคารฉบับเต็ม' })

    const version = await versionOf(changeId)
    expect(await cancelChangeFor(fin(), { changeId, version, reason: 'no' }, uuid())).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: 'reason', reason: 'REASON_SHORT' })
    expect(await cancelChangeFor(fin(), { changeId, version, reason: 'บัญชี 9090909091 ไม่ใช้แล้ว' }, uuid())).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', field: 'reason', reason: 'NOTE_HAS_ACCOUNT_NO' })
    expect(await cancelChangeFor(ctxOf('dm_fin'), { changeId, version, reason: 'ยกเลิกแทน' }, uuid())).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    done(await cancelChangeFor(fin(), { changeId, version, reason: 'ธนาคารยังไม่เปิดบัญชีให้' }, uuid()))
    const cancelled = ok(await getBankAccountChangeActivity(fin(), { changeId }))
    expect(cancelled.history.at(-1)).toMatchObject({ type: 'bank_account_change.cancelled', note: 'ธนาคารยังไม่เปิดบัญชีให้', actor: { id: ap.org.member.fin_officer } })
    expect(await cancelChangeFor(fin(), { changeId, version: await versionOf(changeId), reason: 'ยกเลิกซ้ำ' }, uuid())).toMatchObject({ ok: false, code: 'INVALID_STATE_TRANSITION' })
  })
})

describe('[FR-PAY-102/AC8] the supplier’s card "บัญชีรับเงิน"', () => {
  it('FINANCE sees the account masked, may open it whole (logged) and propose a change; PROCUREMENT reads it only; others see no card', async () => {
    const s = await supplier()
    const card = ok(await getSupplierBankCard(fin(), { supplierId: s.id }))
    expect(card).toMatchObject({ account: { id: s.account!.id, bankName: 'ธนาคารไทยพาณิชย์', accountNoMasked: `••••••${s.accountNo.slice(-4)}`, status: 'ACTIVE' }, pending: null, canReveal: true, canPropose: true })
    expect(JSON.stringify(card)).not.toContain(s.accountNo)
    const logged = await prisma.sensitiveAccessLog.count({ where: { subjectId: s.account!.id } })
    expect(await revealAccountFor(fin(), { bankAccountId: s.account!.id })).toEqual({ ok: true, accountNo: s.accountNo, targetAccountNo: null })
    expect(await prisma.sensitiveAccessLog.count({ where: { subjectId: s.account!.id } })).toBe(logged + 1)

    for (const code of ['proc_officer', 'auditor']) {
      expect(ok(await getSupplierBankCard(ctxOf(code), { supplierId: s.id }))).toMatchObject({ account: { id: s.account!.id }, canReveal: false, canPropose: false })
      expect(await revealAccountFor(ctxOf(code), { bankAccountId: s.account!.id })).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    }
    expect(ok(await getSupplierBankCard(ctxOf('req_con'), { supplierId: s.id }))).toBeNull()
    expect(ok(await getSupplierBankCard(fin(), { supplierId: randomUUID() }))).toBeNull()
    expect(await revealAccountFor(fin(), { bankAccountId: 'nope' })).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: 'bankAccountId' })

    // a request open for the supplier shows on the card
    const { changeId } = done(await createChangeFor(fin(), { kind: 'CLOSE', ownerKind: 'SUPPLIER', supplierId: s.id, targetBankAccountId: s.account!.id, reason: 'ผู้ขายเลิกกิจการ' }, uuid()))
    expect(ok(await getSupplierBankCard(ctxOf('proc_officer'), { supplierId: s.id }))).toMatchObject({ pending: { id: changeId, number: null, kind: 'CLOSE', status: 'DRAFT' } })

    // a supplier without an account: the card says so, and FINANCE may propose one
    const bare = await supplier({ account: false })
    expect(ok(await getSupplierBankCard(fin(), { supplierId: bare.id }))).toMatchObject({ account: null, pending: null, canReveal: false, canPropose: true })
  })
})
