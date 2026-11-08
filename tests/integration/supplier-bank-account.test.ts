import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { PORTAL_PRIVACY_NOTICE_VERSION } from '@/lib/portal-limits'
import type { Ctx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { portalCtx } from '@/server/portal/session'
import { decideTask } from '@/server/services/approvals/decide'
import { SUBJECT_ADAPTERS } from '@/server/services/approvals/subjects'
import { claimBankAccountChange, createBankAccountChange, draftBankAccountChangeInTx, submitBankAccountChange, updateBankAccountChange } from '@/server/services/bank-accounts'
import { applicationSignedIn, inviteSupplier, updateApplication } from '@/server/services/suppliers/applications'
import { proposeBankAccountChange } from '@/server/services/suppliers/bank-proposal'
import { forTenant } from '@/server/db/tenant'
import type { DoaOrg } from '../support/doa-org'
import { createP2Org } from '../support/p2-org'
import { stepUpForTask } from '../support/pin'

// S7-10 (FR-SUP-103 AC1–AC5 · ADR-190 · BR-SOD-12 · BR-SUP ข้อ 16 ข้อ 17 · INV-SUP ข้อ 04): the primary contact of an ACTIVE
// supplier proposes its account on the portal — a DRAFT of source PORTAL with no member who sent it, its proof attached,
// FINANCE told — never a new contact before the hold, never a contact who is not primary; FINANCE claims it (first claim
// wins), records the call and sends it; the claimer and the call recorder never approve it (BR-SOD-12); the CFO approves
// with the PIN (BA-01) and the account comes into force. An approved application's account becomes such a DRAFT in the
// approval's transaction. With SUPPLIER on and PAY off the same way works for changes from the portal only.

const NOW = new Date('2026-11-09T03:00:00Z')
const OLD = new Date('2026-10-01T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const PDF = new TextEncoder().encode('%PDF-1.7\nหน้าสมุดบัญชี\n%%EOF')
const proposal = { bankCode: '004', accountNo: '123-4-56789-0', accountName: 'บริษัท บัญชีพอร์ทัล จำกัด', branchName: 'สาขาสีลม', reason: 'บัญชีรับเงินของบริษัท', fileName: 'หน้าสมุดบัญชี.pdf', bytes: PDF }

async function orgWith(modules: Array<'PAY' | 'AI' | 'BCS_GO' | 'SUPPLIER'>) {
  const org = await createP2Org({ modules })
  await prisma.roleAssignment.createMany({
    data: [
      { organizationId: org.organizationId, memberId: org.member.fin_officer!, role: 'FINANCE', grantedAt: OLD },
      { organizationId: org.organizationId, memberId: org.member.dm_fin!, role: 'FINANCE', grantedAt: OLD },
    ],
  })
  return org
}

async function supplierWith(org: DoaOrg, contact: { primary?: boolean; firstSignedInAt?: Date | null } = {}) {
  const n = randomUUID().slice(0, 8)
  const s = await prisma.supplier.create({ data: { organizationId: org.organizationId, code: `PB-${n}`, nameTh: `ผู้ขาย ${n}`, taxId: `09${Array.from({ length: 11 }, () => Math.floor(Math.random() * 10)).join('')}`, email: `pb-${n}@supplier.test`, portalEnabled: true } })
  const c = await prisma.supplierContact.create({
    data: { organizationId: org.organizationId, supplierId: s.id, nameTh: 'ผู้ติดต่อ', email: `pbc-${n}@supplier.test`, isPrimary: contact.primary ?? true, firstSignedInAt: contact.firstSignedInAt === undefined ? OLD : contact.firstSignedInAt, privacyNoticeVersion: PORTAL_PRIVACY_NOTICE_VERSION },
  })
  return { supplier: s, contact: c, ctx: portalCtx(org.organizationId, c, NOW) as Ctx }
}

/** The central scan called the change's proofs clean (job file-scan) */
async function scanned(changeId: string, result: 'CLEAN' | 'INFECTED' = 'CLEAN') {
  const links = await prisma.fileLink.findMany({ where: { subjectType: 'BankAccountChange', subjectId: changeId, kind: 'BANK_PROOF' }, select: { fileId: true } })
  await prisma.fileObject.updateMany({ where: { id: { in: links.map((l) => l.fileId) } }, data: { scanStatus: result } })
}

const version = async (id: string) => (await prisma.bankAccountChange.findUniqueOrThrow({ where: { id } })).version

beforeAll(() => setDefaultOutboxSender(null))

describe('[FR-SUP-103/AC1] the supplier proposes its account on the portal', () => {
  it('a DRAFT of source PORTAL, no member who sent it, the contact as proposer, its proof attached, FINANCE told; one open at a time', async () => {
    const org = await orgWith(['PAY', 'SUPPLIER'])
    const s = await supplierWith(org)
    const r = await proposeBankAccountChange(s.ctx, proposal, key())
    if (!r.ok) throw new Error(JSON.stringify(r.error))
    const change = await prisma.bankAccountChange.findUniqueOrThrow({ where: { id: r.data.changeId } })
    expect(change).toMatchObject({ status: 'DRAFT', kind: 'ADD', source: 'PORTAL', submittedById: null, proposedByContactId: s.contact.id, accountNo: '1234567890' })
    expect(await prisma.fileLink.count({ where: { subjectType: 'BankAccountChange', subjectId: change.id, kind: 'BANK_PROOF' } })).toBe(1)
    expect(await prisma.bankAccount.count({ where: { supplierId: s.supplier.id } })).toBe(0)
    const told = await prisma.notification.findMany({ where: { subjectId: change.id, templateKey: 'supplier.bank_change_from_portal' } })
    expect(new Set(told.map((n) => n.recipientMemberId))).toEqual(new Set([org.member.fin_officer, org.member.dm_fin]))
    expect(await proposeBankAccountChange(s.ctx, proposal, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'CHANGE_OPEN' } } })
  })

  it('refused: a contact who is not primary (FORBIDDEN), a new contact within the hold (NEW_CONTACT_HOLD), another supplier (FORBIDDEN), a closure', async () => {
    const org = await orgWith(['PAY', 'SUPPLIER'])
    const notPrimary = await supplierWith(org, { primary: false })
    expect(await proposeBankAccountChange(notPrimary.ctx, proposal, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    // signed in Friday 6 Nov 10:00: two business days end Tuesday 10 Nov 10:00
    const fresh = await supplierWith(org, { firstSignedInAt: new Date('2026-11-06T03:00:00Z') })
    expect(await proposeBankAccountChange(fresh.ctx, proposal, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'NEW_CONTACT_HOLD' } } })
    const other = await supplierWith(org)
    expect(await createBankAccountChange(fresh.ctx, { kind: 'ADD', ownerKind: 'SUPPLIER', supplierId: other.supplier.id, bankCode: '004', accountNo: '1234567890', accountName: 'x', reason: 'บัญชีใหม่ของบริษัท' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await createBankAccountChange(other.ctx, { kind: 'CLOSE', ownerKind: 'SUPPLIER', supplierId: other.supplier.id, targetBankAccountId: randomUUID(), reason: 'ปิดบัญชีเดิม' }, key())).toMatchObject({ ok: false })
    // the current privacy notice first (BR-PORTAL ข้อ 08)
    const unread = await supplierWith(org)
    await prisma.supplierContact.update({ where: { id: unread.contact.id }, data: { privacyNoticeVersion: null } })
    expect(await proposeBankAccountChange(unread.ctx, proposal, key())).toMatchObject({ ok: false, error: { code: 'PRIVACY_NOTICE_OUTDATED' } })
    // a proof's object must be this organization's bank proof
    expect(await createBankAccountChange(other.ctx, { kind: 'ADD', ownerKind: 'SUPPLIER', supplierId: other.supplier.id, bankCode: '004', accountNo: '1234567890', accountName: 'x', reason: 'บัญชีใหม่ของบริษัท', proofFile: { storageKey: 'another-org/bank-proofs/x.pdf', fileName: 'f.pdf', mimeType: 'application/pdf', sizeBytes: 1, sha256: '0'.repeat(64) } }, key())).toMatchObject({ ok: false, error: { details: { reason: 'FILE' } } })
    // a member never sends a proof inside create (that is attachProof)
    expect(await createBankAccountChange(org.ctxOf('fin_officer', NOW), { kind: 'ADD', ownerKind: 'SUPPLIER', supplierId: other.supplier.id, bankCode: '004', accountNo: '1234567890', accountName: 'x', reason: 'บัญชีใหม่ของบริษัท', proofFile: { storageKey: 'k', fileName: 'f.pdf', mimeType: 'application/pdf', sizeBytes: 1, sha256: '0'.repeat(64) } }, key())).toMatchObject({ ok: false, error: { details: { reason: 'PORTAL_ONLY' } } })
  })
})

describe('[FR-SUP-103/AC2] [FR-SUP-103/AC3] [FR-SUP-103/AC4] FINANCE claims, calls, sends; the claimer never approves; the CFO approves', () => {
  it('submit before a claim is NOT_CLAIMED; the first claim wins; the call records who made it; BR-SOD-12 names the claimer; approved with the PIN the account is in force', async () => {
    const org = await orgWith(['PAY', 'SUPPLIER'])
    const s = await supplierWith(org)
    const proposed = await proposeBankAccountChange(s.ctx, proposal, key())
    if (!proposed.ok) throw new Error(JSON.stringify(proposed.error))
    const changeId = proposed.data.changeId
    const fin = org.ctxOf('fin_officer', NOW)
    expect(await submitBankAccountChange(fin, { changeId, version: await version(changeId) }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'NOT_CLAIMED' } } })
    expect(await updateBankAccountChange(fin, { changeId, version: await version(changeId), callVerificationNote: 'โทรเบอร์ในทะเบียนแล้ว คุณสมชายยืนยัน' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await claimBankAccountChange(fin, { changeId, version: await version(changeId) }, key())).toMatchObject({ ok: true })
    expect(await claimBankAccountChange(org.ctxOf('dm_fin', NOW), { changeId, version: await version(changeId) }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION' } })
    expect(await claimBankAccountChange(org.ctxOf('req_con', NOW), { changeId, version: await version(changeId) }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await prisma.event.count({ where: { type: 'bank_account_change.claimed', aggregateId: changeId } })).toBe(1)
    expect(await updateBankAccountChange(fin, { changeId, version: await version(changeId), callVerificationNote: 'โทรเบอร์ในทะเบียนแล้ว คุณสมชายยืนยัน' }, key())).toMatchObject({ ok: true })
    const claimed = await prisma.bankAccountChange.findUniqueOrThrow({ where: { id: changeId } })
    expect(claimed).toMatchObject({ submittedById: org.member.fin_officer, callVerifiedById: org.member.fin_officer })
    expect(claimed.claimedAt).not.toBeNull()
    // the proof waits for the central scan (BR-PORTAL ข้อ 07): not sent before it is clean
    expect(await submitBankAccountChange(fin, { changeId, version: await version(changeId) }, key())).toMatchObject({ ok: false, error: { code: 'FILE_NOT_SCANNED' } })
    await scanned(changeId)
    expect(await submitBankAccountChange(fin, { changeId, version: await version(changeId) }, key())).toMatchObject({ ok: true })

    // BR-SOD-12: the adapter names the claimer and the call recorder as conflicts of their own rule
    const facts = await forTenant(org.organizationId).$transaction((tx) => SUBJECT_ADAPTERS.BANK_ACCOUNT_CHANGE.facts(tx, changeId))
    expect(SUBJECT_ADAPTERS.BANK_ACCOUNT_CHANGE.sodContext(facts)).toEqual({ requesterMemberIds: [], extra: [{ rule: 'BR-SOD-12', memberIds: [org.member.fin_officer] }] })

    // BR-SOD-12 at the decision: were the claimer holding the task, the decision is refused by that rule
    const held = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectType: 'BANK_ACCOUNT_CHANGE', subjectId: changeId } } } })
    await prisma.approvalTask.update({ where: { id: held.id }, data: { assigneeMemberId: org.member.fin_officer! } })
    await stepUpForTask(held.id, org.member.fin_officer!)
    expect(await decideTask(org.ctxOf('fin_officer', NOW), { taskId: held.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'SOD_VIOLATION', details: { rule: 'BR-SOD-12' } } })
    await prisma.approvalTask.update({ where: { id: held.id }, data: { assigneeMemberId: org.member.cfo! } })

    // BA-01: the CFO approves with the PIN; the account is in force, the supplier told at the address in the register
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectType: 'BANK_ACCOUNT_CHANGE', subjectId: changeId } } } })
    expect(task.assigneeMemberId).toBe(org.member.cfo)
    await stepUpForTask(task.id, task.assigneeMemberId)
    expect(await decideTask(org.ctxOf('cfo', NOW), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: true })
    expect(await prisma.bankAccount.findMany({ where: { supplierId: s.supplier.id, status: 'ACTIVE' }, select: { accountNo: true, sourceChangeId: true } })).toEqual([{ accountNo: '1234567890', sourceChangeId: changeId }])
    expect(await prisma.supplierNotice.count({ where: { supplierId: s.supplier.id, templateKey: 'bank_account.notice' } })).toBe(1)
  })
})

describe('[FR-SUP-103/AC5] an approved application drafts its account; without PAY the portal way still works', () => {
  it('draftBankAccountChangeInTx: a DRAFT ADD of source PORTAL for FINANCE to claim, never a BankAccount', async () => {
    const org = await orgWith(['PAY', 'SUPPLIER'])
    const s = await supplierWith(org)
    const drafted = await forTenant(org.organizationId).$transaction((tx) =>
      draftBankAccountChangeInTx(tx, org.ctxOf('cfo', NOW), { supplierId: s.supplier.id, contactId: s.contact.id, bankCode: '014', accountNo: '987-6-54321-0', accountName: 'บริษัท ใบสมัคร จำกัด', branchName: null, reason: 'บัญชีจากใบสมัครผู้ขาย SUP-2569-00001' }),
    )
    if (!drafted.ok) throw new Error(JSON.stringify(drafted.error))
    expect(await prisma.bankAccountChange.findUniqueOrThrow({ where: { id: drafted.changeId } })).toMatchObject({ status: 'DRAFT', kind: 'ADD', source: 'PORTAL', submittedById: null, proposedByContactId: s.contact.id, accountNo: '9876543210' })
    expect(drafted.notifications.map((n) => n.templateKey)).toEqual(['supplier.bank_change_from_portal', 'supplier.bank_change_from_portal'])
    expect(await prisma.bankAccount.count({ where: { supplierId: s.supplier.id } })).toBe(0)
  })

  it('an application whose bank changes alone keeps an account that fits it, or is asked to type the account again', async () => {
    const org = await orgWith(['PAY', 'SUPPLIER'])
    const digits = Array.from({ length: 12 }, (_, i) => (i === 0 ? 0 : Math.floor(Math.random() * 10)))
    const tax = digits.join('') + String((11 - (digits.reduce((s, d, i) => s + d * (13 - i), 0) % 11)) % 10)
    const r = await inviteSupplier(org.ctxOf('proc_officer', NOW), { kind: 'NEW', nameTh: `บริษัท บัญชีใบสมัคร ${randomUUID().slice(0, 6)} จำกัด`, taxId: tax, contact: { nameTh: 'ผู้ติดต่อ', email: `ba-${randomUUID().slice(0, 8)}@supplier.test` } }, key())
    if (!r.ok) throw new Error(JSON.stringify(r.error))
    const contact = await prisma.supplierContact.findUniqueOrThrow({ where: { id: r.data.contactId } })
    await forTenant(org.organizationId).$transaction((tx) => applicationSignedIn(tx, portalCtx(org.organizationId, contact, NOW), contact))
    const ctx = portalCtx(org.organizationId, contact, NOW)
    const v = async () => (await prisma.supplierApplication.findUniqueOrThrow({ where: { id: r.data.applicationId } })).version
    expect(await updateApplication(ctx, { applicationId: r.data.applicationId, expectedVersion: await v(), fields: { bankCode: '004', accountNo: '123-4-56789-0' } }, key())).toMatchObject({ ok: true })
    expect(await updateApplication(ctx, { applicationId: r.data.applicationId, expectedVersion: await v(), fields: { bankCode: '014' } }, key())).toMatchObject({ ok: true })
    expect(await updateApplication(ctx, { applicationId: r.data.applicationId, expectedVersion: await v(), fields: { bankCode: '999' } }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'ACCOUNT_BANK' } } })
  })

  it('[BR-SUP-16] SUPPLIER on and PAY off: a change from the portal is claimed, sent and approved; an internal one is MODULE_DISABLED', async () => {
    const org = await orgWith(['SUPPLIER'])
    const s = await supplierWith(org)
    const r = await proposeBankAccountChange(s.ctx, proposal, key())
    if (!r.ok) throw new Error(JSON.stringify(r.error))
    const changeId = r.data.changeId
    const fin = org.ctxOf('fin_officer', NOW)
    expect(await claimBankAccountChange(fin, { changeId, version: await version(changeId) }, key())).toMatchObject({ ok: true })
    await scanned(changeId)
    expect(await submitBankAccountChange(fin, { changeId, version: await version(changeId) }, key())).toMatchObject({ ok: true })
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectType: 'BANK_ACCOUNT_CHANGE', subjectId: changeId } } } })
    await stepUpForTask(task.id, task.assigneeMemberId)
    expect(await decideTask(org.ctxOf('cfo', NOW), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: true })
    expect(await prisma.bankAccount.count({ where: { supplierId: s.supplier.id, status: 'ACTIVE' } })).toBe(1)
    const other = await supplierWith(org)
    expect(await createBankAccountChange(fin, { kind: 'ADD', ownerKind: 'SUPPLIER', supplierId: other.supplier.id, bankCode: '004', accountNo: '1234567890', accountName: 'x', reason: 'บัญชีใหม่ของบริษัท' }, key())).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
  })
})

describe('[INV-SUP-04] every account of a supplier came from an approved change', () => {
  it('no BankAccount of a supplier without sourceChangeId in the organizations of this file', async () => {
    expect(await prisma.bankAccount.count({ where: { ownerKind: 'SUPPLIER', sourceChangeId: null, organization: { code: { startsWith: 'd-' } }, supplier: { code: { startsWith: 'PB-' } } } })).toBe(0)
  })
})
