import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { makeCtx, type Ctx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { decideTask, requestInfo } from '@/server/services/approvals/decide'
import { applicationSignedIn, cancelApplication, inviteSupplier, reinviteSupplier, returnApplication, submitApplication, updateApplication, verifyAndRoute } from '@/server/services/suppliers/applications'
import { portalCtx } from '@/server/portal/session'
import type { DoaOrg } from '../support/doa-org'
import { createP2Org } from '../support/p2-org'
import { PORTAL_PRIVACY_NOTICE_VERSION } from '@/lib/portal-limits'

// S7-05 (ADR-181 · BR-SUP ข้อ 08 ถึง ข้อ 11 · BR-SOD-11 · FR-SUP-101 AC1 AC3 AC4 · FR-SUP-102 AC1 ถึง AC3 · FR-SUP-104 AC2
// ถึง AC5): a supplier invited, its application filled in by its contact on the portal or by procurement for it,
// submitted, checked and routed under SUPPLIER_APPROVAL (SA-01 → dm_proc), and approved into one supplier with its
// contacts and documents; the conflicted people of the route are refused; the registries are the stub's.

const NOW = new Date('2026-11-02T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })

let org: DoaOrg
const as = (code: string) => org.ctxOf(code, NOW)

/** A taxpayer id with its check digit (BR-TAXID-01) */
function taxId(): string {
  const digits = Array.from({ length: 12 }, (_, i) => (i === 0 ? 0 : Math.floor(Math.random() * 10)))
  const sum = digits.reduce((s, d, i) => s + d * (13 - i), 0)
  return digits.join('') + String((11 - (sum % 11)) % 10)
}

async function file(memberCode = 'proc_officer') {
  return prisma.fileObject.create({ data: { organizationId: org.organizationId, storageKey: `test/${randomUUID()}.pdf`, fileName: 'doc.pdf', mimeType: 'application/pdf', sizeBytes: 1, status: 'AVAILABLE', uploadedById: org.member[memberCode]! } })
}

/** A document of the application, PENDING or VERIFIED by `verifier` (S7-06 writes them through its commands) */
async function document(applicationId: string, type: string, verifier?: string) {
  const f = await file()
  return prisma.supplierDocument.create({
    data: {
      organizationId: org.organizationId,
      applicationId,
      documentTypeCode: type,
      fileId: f.id,
      issuedOn: new Date('2026-10-01'),
      expiresOn: new Date('2027-03-29'),
      ...(verifier ? { status: 'VERIFIED', verifiedById: org.member[verifier]!, verifiedAt: NOW } : {}),
    },
  })
}

beforeAll(async () => {
  setDefaultOutboxSender(null)
  org = await createP2Org()
  // a second procurement person: who sends applications on their route, verifies documents and so on
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.asst_con!, role: 'PROCUREMENT', grantedAt: NOW } })
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.dm_proc!, role: 'PROCUREMENT', grantedAt: NOW } })
  await prisma.supplierDocumentType.createMany({
    data: [
      { organizationId: org.organizationId, code: 'COMPANY_CERT', nameTh: 'หนังสือรับรองบริษัท', nameEn: 'Company certificate', appliesTo: ['JURISTIC'], required: true, validityDays: 180 },
      { organizationId: org.organizationId, code: 'ID_CARD', nameTh: 'บัตรประชาชน', nameEn: 'ID card', appliesTo: ['INDIVIDUAL'], required: true, sensitive: true },
      { organizationId: org.organizationId, code: 'INCORPORATION_FOREIGN', nameTh: 'หนังสือจดทะเบียนต่างประเทศ', nameEn: 'Foreign incorporation', appliesTo: ['FOREIGN'], required: true },
    ],
  })
})

/** Invites a new supplier; its contact signs in once (INVITED → DRAFT) */
async function invited(overrides: Record<string, unknown> = {}, inviter = 'proc_officer') {
  const r = await inviteSupplier(
    as(inviter),
    { kind: 'NEW', nameTh: `บริษัท ทดสอบ ${randomUUID().slice(0, 6)} จำกัด`, taxId: taxId(), branchCode: '00000', payeeType: 'JURISTIC', contact: { nameTh: 'ผู้ติดต่อ', email: `inv-${randomUUID().slice(0, 8)}@supplier.test` }, ...overrides } as Parameters<typeof inviteSupplier>[1],
    key(),
  )
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  const contact = await prisma.supplierContact.findUniqueOrThrow({ where: { id: r.data.contactId } })
  return { applicationId: r.data.applicationId, contact }
}

const contactCtx = (contact: { id: string; applicationId: string | null; supplierId: string | null }): Ctx => portalCtx(org.organizationId, contact, NOW)
const version = async (id: string) => (await prisma.supplierApplication.findUniqueOrThrow({ where: { id } })).version

async function signedIn(contact: { id: string; applicationId: string | null; supplierId: string | null }) {
  await forTenant(org.organizationId).$transaction((tx) => applicationSignedIn(tx, contactCtx(contact), contact))
  await prisma.supplierContact.update({ where: { id: contact.id }, data: { privacyNoticeVersion: PORTAL_PRIVACY_NOTICE_VERSION } })
}

/** Filled in by its contact, its company certificate uploaded, submitted */
async function submitted(inviter = 'proc_officer') {
  const a = await invited({}, inviter)
  await signedIn(a.contact)
  const ctx = contactCtx(a.contact)
  const u = await updateApplication(ctx, { applicationId: a.applicationId, expectedVersion: await version(a.applicationId), fields: { address: '1 ถนนพระราม 4 กรุงเทพฯ', isVatRegistered: true } }, key())
  if (!u.ok) throw new Error(JSON.stringify(u.error))
  await document(a.applicationId, 'COMPANY_CERT')
  const s = await submitApplication(ctx, { applicationId: a.applicationId, expectedVersion: await version(a.applicationId) }, key())
  if (!s.ok) throw new Error(JSON.stringify(s.error))
  return { ...a, number: s.data.number }
}

/**
 * Submitted, its documents verified by `verifier`, sent on its route by `router`. The registry stub knows the tax ids of
 * the seed only, so a random one is confirmed by hand with a proof file the router uploaded (BR-SUP-03)
 */
async function routed(options: { inviter?: string; verifier?: string; router?: string } = {}) {
  const a = await submitted(options.inviter)
  const router = options.router ?? 'asst_con'
  await prisma.supplierDocument.updateMany({ where: { applicationId: a.applicationId }, data: { status: 'VERIFIED', verifiedById: org.member[options.verifier ?? 'asst_con']!, verifiedAt: NOW } })
  const proof = await file(router)
  const r = await verifyAndRoute(as(router), { applicationId: a.applicationId, expectedVersion: await version(a.applicationId), registryProofFileId: proof.id }, key())
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  const task = await prisma.approvalTask.findFirstOrThrow({ where: { step: { routeId: r.data.routeId } }, orderBy: { createdAt: 'asc' } })
  return { ...a, routeId: r.data.routeId, task }
}

describe('[FR-SUP-101/AC1] PROCUREMENT invites a supplier', () => {
  it('a new supplier: INVITED, a contact, a one-time link e-mailed, the expiry from the settings; FORBIDDEN without supplier.invite', async () => {
    const a = await invited()
    const app = await prisma.supplierApplication.findUniqueOrThrow({ where: { id: a.applicationId } })
    expect(app).toMatchObject({ status: 'INVITED', kind: 'NEW', invitedById: org.member.proc_officer, number: null })
    expect(app.expiresAt.getTime() - NOW.getTime()).toBe(30 * 24 * 3_600_000)
    expect(await prisma.portalInviteLink.count({ where: { applicationId: a.applicationId, purpose: 'INVITATION', usedAt: null } })).toBe(1)
    expect(await prisma.supplierNotice.count({ where: { applicationId: a.applicationId, templateKey: 'supplier.invitation', supplierId: null, contactId: a.contact.id } })).toBe(1)
    expect(await inviteSupplier(as('fin_officer'), { kind: 'NEW', nameTh: 'x', taxId: taxId(), contact: { nameTh: 'x', email: 'x@supplier.test' } } as Parameters<typeof inviteSupplier>[1], key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })

  it('[FR-SUP-102/AC2] a registered tax id and branch is DUPLICATE_SUPPLIER; another branch warns and needs its reason; the reason is kept', async () => {
    const id = taxId()
    await prisma.supplier.create({ data: { organizationId: org.organizationId, code: `DUP-${randomUUID().slice(0, 4)}`, nameTh: 'บริษัท เดิม จำกัด', taxId: id, branchCode: '00000' } })
    expect(await inviteSupplier(as('proc_officer'), { kind: 'NEW', nameTh: 'บริษัท ใหม่ จำกัด', taxId: id, contact: { nameTh: 'x', email: `d-${randomUUID().slice(0, 6)}@supplier.test` } } as Parameters<typeof inviteSupplier>[1], key())).toMatchObject({ ok: false, error: { code: 'DUPLICATE_SUPPLIER', details: { reason: 'DUPLICATE_TAXID' } } })
    const other = { kind: 'NEW', nameTh: 'บริษัท สาขาใหม่ จำกัด', taxId: id, branchCode: '00002', contact: { nameTh: 'x', email: `d-${randomUUID().slice(0, 6)}@supplier.test` } }
    expect(await inviteSupplier(as('proc_officer'), other as Parameters<typeof inviteSupplier>[1], key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'DUPLICATE_REASON_REQUIRED', warnings: [{ code: 'SAME_TAXID_OTHER_BRANCH' }] } } })
    const r = await inviteSupplier(as('proc_officer'), { ...other, duplicateReasons: { SAME_TAXID_OTHER_BRANCH: 'สาขาใหม่ที่ชลบุรี' } } as Parameters<typeof inviteSupplier>[1], key())
    if (!r.ok) throw new Error(JSON.stringify(r.error))
    expect((await prisma.supplierApplication.findUniqueOrThrow({ where: { id: r.data.applicationId } })).duplicateWarnings).toMatchObject([{ code: 'SAME_TAXID_OTHER_BRANCH', reason: 'สาขาใหม่ที่ชลบุรี' }])
    expect(await inviteSupplier(as('proc_officer'), { kind: 'NEW', nameTh: 'x', taxId: '0999998010015', contact: { nameTh: 'x', email: `d-${randomUUID().slice(0, 6)}@supplier.test` } } as Parameters<typeof inviteSupplier>[1], key())).toMatchObject({ ok: false, error: { details: { reason: 'TAXID_CHECKSUM' } } })
  })

  it('a registered supplier invited into the portal: EXISTING, its register address and primary contact told, approved at the first sign-in as one more contact', async () => {
    const supplier = await prisma.supplier.create({ data: { organizationId: org.organizationId, code: `EX-${randomUUID().slice(0, 4)}`, nameTh: 'บริษัท มีอยู่แล้ว จำกัด', taxId: taxId(), branchCode: '00000', email: 'register.ex@supplier.test' } })
    const primary = await prisma.supplierContact.create({ data: { organizationId: org.organizationId, supplierId: supplier.id, nameTh: 'ผู้ติดต่อหลักเดิม', email: `pri-${randomUUID().slice(0, 6)}@supplier.test`, isPrimary: true } })
    const r = await inviteSupplier(as('proc_officer'), { kind: 'EXISTING', supplierId: supplier.id, contact: { nameTh: 'คนเดิม', email: `ex-${randomUUID().slice(0, 6)}@supplier.test` } }, key())
    if (!r.ok) throw new Error(JSON.stringify(r.error))
    const contact = await prisma.supplierContact.findUniqueOrThrow({ where: { id: r.data.contactId } })
    // BR-SUP-17: the register and the primary contact hear of the new person, never the new address
    expect((await prisma.supplierNotice.findMany({ where: { subjectId: contact.id, templateKey: 'supplier.contact_added' } })).map((n) => n.toEmail).sort()).toEqual([primary.email, 'register.ex@supplier.test'].sort())
    await signedIn(contact)
    expect(await prisma.supplierApplication.findUniqueOrThrow({ where: { id: r.data.applicationId } })).toMatchObject({ status: 'APPROVED', approvedSupplierId: supplier.id, number: null })
    // one primary contact stays: the invited person joins as another
    expect(await prisma.supplierContact.findUniqueOrThrow({ where: { id: contact.id } })).toMatchObject({ supplierId: supplier.id, isPrimary: false })
    expect(await prisma.supplierContact.findUniqueOrThrow({ where: { id: primary.id } })).toMatchObject({ isPrimary: true })
    expect((await prisma.supplier.findUniqueOrThrow({ where: { id: supplier.id } })).portalEnabled).toBe(true)
  })

  it('reinvite revokes the old link and sends a new one; cancel closes the application and its contact\'s access', async () => {
    const a = await invited()
    const before = await prisma.portalInviteLink.findFirstOrThrow({ where: { applicationId: a.applicationId } })
    expect(await reinviteSupplier(as('proc_officer'), { applicationId: a.applicationId, expectedVersion: await version(a.applicationId) }, key())).toMatchObject({ ok: true })
    expect((await prisma.portalInviteLink.findUniqueOrThrow({ where: { id: before.id } })).revokedAt).not.toBeNull()
    expect(await prisma.portalInviteLink.count({ where: { applicationId: a.applicationId, revokedAt: null } })).toBe(1)
    await prisma.portalSession.create({ data: { organizationId: org.organizationId, contactId: a.contact.id, sessionHash: randomUUID().replace(/-/g, '').padEnd(64, 'a'), csrfTokenHash: 'b'.repeat(64), lastSeenAt: NOW, expiresAt: new Date('2099-01-01'), userAgentHash: 'c'.repeat(64), ipHash: 'd'.repeat(64) } })
    expect(await cancelApplication(as('proc_officer'), { applicationId: a.applicationId, expectedVersion: await version(a.applicationId), reason: 'ผู้ขายไม่สนใจแล้ว' }, key())).toMatchObject({ ok: true })
    expect((await prisma.supplierApplication.findUniqueOrThrow({ where: { id: a.applicationId } })).status).toBe('CANCELLED')
    expect(await prisma.portalSession.count({ where: { contactId: a.contact.id, revokedAt: null } })).toBe(0)
  })
})

describe('[FR-SUP-101/AC3] [FR-SUP-102/AC3] the contact fills the application in (its bank account sealed) and submits it', () => {
  it('first sign-in → DRAFT; updates by the contact only on its own application; incomplete → APPLICATION_INCOMPLETE with the list; submit numbers it SUP-2569-…; a resend replays', async () => {
    const a = await invited()
    await signedIn(a.contact)
    expect((await prisma.supplierApplication.findUniqueOrThrow({ where: { id: a.applicationId } })).status).toBe('DRAFT')
    const ctx = contactCtx(a.contact)
    const other = await invited()
    expect(await updateApplication(ctx, { applicationId: other.applicationId, expectedVersion: await version(other.applicationId), fields: { address: 'x' } }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await submitApplication(ctx, { applicationId: a.applicationId, expectedVersion: await version(a.applicationId) }, key())).toMatchObject({ ok: false, error: { code: 'APPLICATION_INCOMPLETE', details: { missing: ['address', 'document:COMPANY_CERT'] } } })
    expect(await updateApplication(ctx, { applicationId: a.applicationId, expectedVersion: await version(a.applicationId), fields: { address: '9 ถนนสุขุมวิท', bankCode: '014', accountNo: '123-4-56789-0' } }, key())).toMatchObject({ ok: true })
    const stored = await prisma.supplierApplication.findUniqueOrThrow({ where: { id: a.applicationId } })
    expect(stored.accountNoLast4).toBe('7890')
    expect(stored.accountNoEnc).not.toContain('1234567890')
    expect(stored.fieldSources).toMatchObject({ address: 'MANUAL', accountNo: 'MANUAL' })
    await document(a.applicationId, 'COMPANY_CERT')
    const k = key()
    const input = { applicationId: a.applicationId, expectedVersion: await version(a.applicationId) }
    const s = await submitApplication(ctx, input, k)
    expect(s).toMatchObject({ ok: true, data: { number: expect.stringMatching(/^SUP-2569-\d{5}$/) } })
    expect(await submitApplication(ctx, input, k)).toEqual(s)
    const events = await prisma.event.findMany({ where: { aggregateId: a.applicationId, type: { in: ['supplier_application.updated', 'supplier_application.submitted'] } } })
    for (const e of events) expect(e).toMatchObject({ actorType: 'SUPPLIER', actorSupplierContactId: a.contact.id, channel: 'PORTAL', actorMemberId: null })
  })

  it('an older privacy notice refuses the submit (PRIVACY_NOTICE_OUTDATED)', async () => {
    const a = await invited()
    await signedIn(a.contact)
    await prisma.supplierContact.update({ where: { id: a.contact.id }, data: { privacyNoticeVersion: null } })
    expect(await submitApplication(contactCtx(a.contact), { applicationId: a.applicationId, expectedVersion: await version(a.applicationId) }, key())).toMatchObject({ ok: false, error: { code: 'PRIVACY_NOTICE_OUTDATED' } })
  })
})

describe('[FR-SUP-101/AC4] procurement fills it in for the supplier', () => {
  it('fillOnBehalf sets the filler and ON_BEHALF sources, the submit e-mails the contact a copy without the account number; FINANCE may not', async () => {
    const a = await invited()
    expect(await updateApplication(as('fin_officer'), { applicationId: a.applicationId, expectedVersion: await version(a.applicationId), fields: { address: 'x' } }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await updateApplication(as('asst_con'), { applicationId: a.applicationId, expectedVersion: await version(a.applicationId), fields: { address: '5 ถนนสีลม', bankCode: '014', accountNo: '1234567890' } }, key())).toMatchObject({ ok: true })
    expect(await prisma.supplierApplication.findUniqueOrThrow({ where: { id: a.applicationId } })).toMatchObject({ status: 'DRAFT', filledOnBehalfById: org.member.asst_con, fieldSources: { address: 'ON_BEHALF' } })
    await document(a.applicationId, 'COMPANY_CERT')
    expect(await submitApplication(as('asst_con'), { applicationId: a.applicationId, expectedVersion: await version(a.applicationId) }, key())).toMatchObject({ ok: true })
    const copy = await prisma.supplierNotice.findFirstOrThrow({ where: { applicationId: a.applicationId, templateKey: 'supplier.application_copy' } })
    expect(copy.contactId).toBe(a.contact.id)
    expect(JSON.stringify(copy.data)).not.toContain('1234567890')
    expect(JSON.stringify(copy.data)).toContain('7890')
  })
})

describe('[FR-SUP-102/AC1] the tax step and a foreign supplier', () => {
  it('a foreign application has no tax id, skips the registries, needs INCORPORATION_FOREIGN, and becomes a foreign supplier', async () => {
    const a = await invited({ nameTh: 'ACME Trading Pte. Ltd.', taxId: null, payeeType: 'FOREIGN' })
    await signedIn(a.contact)
    const ctx = contactCtx(a.contact)
    await updateApplication(ctx, { applicationId: a.applicationId, expectedVersion: await version(a.applicationId), fields: { address: 'Singapore', taxId: '0105555000011' } }, key())
    expect((await prisma.supplierApplication.findUniqueOrThrow({ where: { id: a.applicationId } })).taxId).toBeNull()
    expect(await submitApplication(ctx, { applicationId: a.applicationId, expectedVersion: await version(a.applicationId) }, key())).toMatchObject({ ok: false, error: { details: { missing: ['document:INCORPORATION_FOREIGN'] } } })
    await document(a.applicationId, 'INCORPORATION_FOREIGN', 'asst_con')
    expect(await submitApplication(ctx, { applicationId: a.applicationId, expectedVersion: await version(a.applicationId) }, key())).toMatchObject({ ok: true })
    const r = await verifyAndRoute(as('asst_con'), { applicationId: a.applicationId, expectedVersion: await version(a.applicationId) }, key())
    if (!r.ok) throw new Error(JSON.stringify(r.error))
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { step: { routeId: r.data.routeId } } })
    expect(await decideTask(as('dm_proc'), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: true })
    const app = await prisma.supplierApplication.findUniqueOrThrow({ where: { id: a.applicationId } })
    expect(await prisma.supplier.findUniqueOrThrow({ where: { id: app.approvedSupplierId! } })).toMatchObject({ isForeign: true, taxId: null, payeeType: 'FOREIGN', registryFlag: 'NONE' })
  })
})

describe('[FR-SUP-104/AC2] procurement checks and sends it on its SUPPLIER_APPROVAL route', () => {
  it('unverified required documents → SUPPLIER_DOCUMENT_UNVERIFIED; verified → a route under SA-01 to dm_proc with the conflicted people', async () => {
    const a = await submitted()
    expect(await verifyAndRoute(as('asst_con'), { applicationId: a.applicationId, expectedVersion: await version(a.applicationId) }, key())).toMatchObject({ ok: false, error: { code: 'SUPPLIER_DOCUMENT_UNVERIFIED', details: { types: ['COMPANY_CERT'] } } })
    const r = await routed()
    const route = await prisma.approvalRoute.findUniqueOrThrow({ where: { id: r.routeId } })
    expect(route).toMatchObject({ subjectType: 'SUPPLIER_APPLICATION', ruleCode: 'SA-01', amountSatang: null })
    expect(r.task.assigneeMemberId).toBe(org.member.dm_proc)
    expect(await prisma.supplierApplication.findUniqueOrThrow({ where: { id: r.applicationId } })).toMatchObject({ status: 'PENDING_APPROVAL', routedById: org.member.asst_con, registrySource: 'MANUAL' })
  })

  it('not found at the registries without proof → REGISTRY_PROOF_REQUIRED; found (the stub\'s 0999999000098) needs none and the supplier starts unflagged', async () => {
    const a = await submitted()
    await prisma.supplierDocument.updateMany({ where: { applicationId: a.applicationId }, data: { status: 'VERIFIED', verifiedById: org.member.asst_con!, verifiedAt: NOW } })
    expect(await verifyAndRoute(as('asst_con'), { applicationId: a.applicationId, expectedVersion: await version(a.applicationId) }, key())).toMatchObject({ ok: false, error: { details: { reason: 'REGISTRY_PROOF_REQUIRED' } } })
    await prisma.supplierApplication.update({ where: { id: a.applicationId }, data: { taxId: '0999999000098' } })
    const r = await verifyAndRoute(as('asst_con'), { applicationId: a.applicationId, expectedVersion: await version(a.applicationId) }, key())
    if (!r.ok) throw new Error(JSON.stringify(r.error))
    expect(await prisma.supplierApplication.findUniqueOrThrow({ where: { id: a.applicationId } })).toMatchObject({ registrySource: 'STUB' })
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { step: { routeId: r.data.routeId } } })
    expect(await decideTask(as('dm_proc'), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: true })
    expect(await prisma.supplier.findFirstOrThrow({ where: { applicationId: a.applicationId } })).toMatchObject({ registryFlag: 'NONE', taxId: '0999999000098' })
  })

  it('the procurement manager who sent it on its route or verified its documents leaves no one above: NO_HIGHER_AUTHORITY', async () => {
    const a = await submitted()
    await prisma.supplierDocument.updateMany({ where: { applicationId: a.applicationId }, data: { status: 'VERIFIED', verifiedById: org.member.asst_con!, verifiedAt: NOW } })
    expect(await verifyAndRoute(as('dm_proc'), { applicationId: a.applicationId, expectedVersion: await version(a.applicationId), registryProofFileId: (await file('dm_proc')).id }, key())).toMatchObject({ ok: false, error: { code: 'NO_HIGHER_AUTHORITY' } })
    const b = await submitted()
    await prisma.supplierDocument.updateMany({ where: { applicationId: b.applicationId }, data: { status: 'VERIFIED', verifiedById: org.member.dm_proc!, verifiedAt: NOW } })
    expect(await verifyAndRoute(as('asst_con'), { applicationId: b.applicationId, expectedVersion: await version(b.applicationId), registryProofFileId: (await file('asst_con')).id }, key())).toMatchObject({ ok: false, error: { code: 'NO_HIGHER_AUTHORITY' } })
  })

  it('return sends it back to the supplier with the reason', async () => {
    const a = await submitted()
    expect(await returnApplication(as('asst_con'), { applicationId: a.applicationId, expectedVersion: await version(a.applicationId), reason: 'แนบหนังสือรับรองฉบับใหม่' }, key())).toMatchObject({ ok: true })
    expect(await prisma.supplierApplication.findUniqueOrThrow({ where: { id: a.applicationId } })).toMatchObject({ status: 'RETURNED', returnReason: 'แนบหนังสือรับรองฉบับใหม่' })
    expect(await prisma.supplierNotice.count({ where: { applicationId: a.applicationId, templateKey: 'supplier.application_returned' } })).toBe(1)
  })
})

describe('[FR-SUP-104/AC3] approval creates the supplier in the decision\'s own transaction', () => {
  it('a NEW supplier: ACTIVE, from the application, its contacts and documents moved to it, the portal open, supplier.created via APPLICATION', async () => {
    const r = await routed()
    expect(await decideTask(as('dm_proc'), { taskId: r.task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: true })
    const app = await prisma.supplierApplication.findUniqueOrThrow({ where: { id: r.applicationId } })
    expect(app).toMatchObject({ status: 'APPROVED', supplierId: app.approvedSupplierId })
    const supplier = await prisma.supplier.findUniqueOrThrow({ where: { id: app.approvedSupplierId! } })
    // confirmed by hand with proof (not found at the registries) → the supplier starts flagged NOT_FOUND (BR-SUP ข้อ 11)
    expect(supplier).toMatchObject({ status: 'ACTIVE', nameTh: app.nameTh, taxId: app.taxId, applicationId: app.id, portalEnabled: true, registryFlag: 'NOT_FOUND' })
    expect(await prisma.supplierContact.count({ where: { applicationId: app.id, supplierId: supplier.id } })).toBe(1)
    expect(await prisma.supplierDocument.count({ where: { applicationId: app.id, supplierId: supplier.id } })).toBe(1)
    const created = await prisma.event.findFirstOrThrow({ where: { aggregateId: supplier.id, type: 'supplier.created' } })
    expect(created).toMatchObject({ schemaVersion: 2, data: { via: 'APPLICATION', applicationId: app.id, registryFlag: 'NOT_FOUND' } })
    expect(await prisma.supplierNotice.count({ where: { applicationId: app.id, templateKey: 'supplier.application_approved' } })).toBe(1)
  })

  it('[INV-SUP-02] two approvals at once make one supplier', async () => {
    const r = await routed()
    // the same task decided twice in parallel: one wins, the other finds the task decided or the application approved
    const results = await Promise.all([decideTask(as('dm_proc'), { taskId: r.task.id, decision: 'APPROVE' }, key()), decideTask(as('dm_proc'), { taskId: r.task.id, decision: 'APPROVE' }, key())])
    expect(results.filter((x) => x.ok)).toHaveLength(1)
    expect(await prisma.supplier.count({ where: { applicationId: r.applicationId } })).toBe(1)
  })

  it('a rejection closes the application and its contact\'s access; the supplier e-mail says why', async () => {
    const r = await routed()
    expect(await decideTask(as('dm_proc'), { taskId: r.task.id, decision: 'REJECT', reason: 'เอกสารไม่ตรงกับทะเบียน' }, key())).toMatchObject({ ok: true })
    expect(await prisma.supplierApplication.findUniqueOrThrow({ where: { id: r.applicationId } })).toMatchObject({ status: 'REJECTED', rejectReason: 'เอกสารไม่ตรงกับทะเบียน' })
    expect(await prisma.supplier.count({ where: { applicationId: r.applicationId } })).toBe(0)
  })
})

describe('[FR-SUP-104/AC4] the conflicted people of the application never approve it (BR-SOD-11)', () => {
  it('the inviter who is the approver: SOD_VIOLATION with security.sod_blocked', async () => {
    const r = await routed()
    // the approver is dm_proc: the inviter becomes dm_proc too, as if it had invited — checked at deciding
    await prisma.supplierApplication.update({ where: { id: r.applicationId }, data: { invitedById: org.member.dm_proc! } })
    const refused = await decideTask(as('dm_proc'), { taskId: r.task.id, decision: 'APPROVE' }, key())
    expect(refused).toMatchObject({ ok: false, error: { code: 'SOD_VIOLATION' } })
    expect(await prisma.event.findFirst({ where: { organizationId: org.organizationId, type: 'security.sod_blocked', aggregateId: r.applicationId } })).toMatchObject({ data: { rule: 'BR-SOD-11', subjectType: 'SUPPLIER_APPLICATION' } })
  })
})

describe('[FR-SUP-104/AC5] channels and questions', () => {
  it('approval.requestInfo on an application task is VALIDATION_FAILED reason SUBJECT (a return instead)', async () => {
    const r = await routed()
    expect(await requestInfo(as('dm_proc'), { taskId: r.task.id, question: 'ขอเอกสารเพิ่ม' }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'SUBJECT' } } })
  })

  it('SUPPLIER off: every command of the application is MODULE_DISABLED', async () => {
    const off = await createP2Org({ modules: ['PAY'] })
    const ctx = makeCtx({ organizationId: off.organizationId, actor: { type: 'USER', memberId: off.member.proc_officer! }, channel: 'WEB', now: NOW })
    expect(await inviteSupplier(ctx, { kind: 'NEW', nameTh: 'x', taxId: taxId(), contact: { nameTh: 'x', email: 'off@supplier.test' } } as Parameters<typeof inviteSupplier>[1], key())).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
  })
})
