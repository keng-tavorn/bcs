import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { setEmailProvider, type EmailMessage } from '@/integrations/email-provider'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { enqueueSupplierNotice, registerSupplierTemplate, sendSupplierNotice, supplierMail } from '@/server/notifications/supplier-notices'
import { portalAuthorize } from '@/server/portal/authz'
import { PORTAL_MODEL_NAMES } from '@/server/portal/db'
import { requireCurrentPrivacyNotice } from '@/server/portal/privacy'
import { portalCtx } from '@/server/portal/session'
import { createSupplierContact, deactivateSupplierContact, revokeSupplierContactSessions, updateSupplierContact } from '@/server/services/suppliers/contacts'
import type { DoaOrg } from '../support/doa-org'
import { createP2Org } from '../support/p2-org'

// S7-04 (BR-SUP ข้อ 17 · BR-PORTAL ข้อ 03 ข้อ 05 ข้อ 08 · BR-NOTI ข้อ 09): the contacts of a supplier and who hears of
// them, sessions revoked with a contact, the portal's action table, the privacy notice, and a supplier e-mail to the
// contact of an application that is not a supplier yet, in the contact's language.

const NOW = new Date('2026-11-07T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const hex = () => randomUUID().replace(/-/g, '').padEnd(64, '0')
const mails: EmailMessage[] = []

let org: DoaOrg
let supplierId: string
beforeAll(async () => {
  setEmailProvider({
    async send(m) {
      mails.push(m)
      return { messageId: randomUUID() }
    },
  })
  org = await createP2Org()
  supplierId = (await prisma.supplier.create({ data: { organizationId: org.organizationId, code: 'SC-01', nameTh: 'บริษัท ผู้ติดต่อ จำกัด', taxId: null, isForeign: true, email: 'register@supplier.test' } })).id
})
afterAll(() => setEmailProvider(null))

const proc = () => org.ctxOf('proc_officer', NOW)
const notices = (subjectId: string) => prisma.supplierNotice.findMany({ where: { subjectId, templateKey: 'supplier.contact_added' }, orderBy: { createdAt: 'asc' } })

describe('[BR-SUP-17] a contact added or re-addressed is told to the register and the primary contact before it', () => {
  it('the first contact: the register hears, with the name of the member who added it', async () => {
    const r = await createSupplierContact(proc(), { supplierId, nameTh: 'คนแรก', email: 'First@Supplier.test', isPrimary: true }, key())
    if (!r.ok) throw new Error(JSON.stringify(r.error))
    const contact = await prisma.supplierContact.findUniqueOrThrow({ where: { id: r.data.contactId } })
    expect(contact.email).toBe('first@supplier.test')
    const sent = await notices(contact.id)
    expect(sent.map((n) => n.toEmail)).toEqual(['register@supplier.test'])
    expect(sent[0]!.data).toMatchObject({ contactName: 'คนแรก', changed: 'ADDED', addedByTh: expect.any(String) })
  })

  it('a second contact, made primary: the register and the primary before it hear, never the new address; the old primary steps down', async () => {
    const first = await prisma.supplierContact.findFirstOrThrow({ where: { supplierId, isPrimary: true } })
    const r = await createSupplierContact(proc(), { supplierId, nameTh: 'คนที่สอง', email: 'second@supplier.test', isPrimary: true }, key())
    if (!r.ok) throw new Error(JSON.stringify(r.error))
    expect((await notices(r.data.contactId)).map((n) => n.toEmail).sort()).toEqual(['first@supplier.test', 'register@supplier.test'])
    expect((await prisma.supplierContact.findUniqueOrThrow({ where: { id: first.id } })).isPrimary).toBe(false)
  })

  it('an e-mail an active contact holds is refused; a changed e-mail is told and ends the sessions of the old one', async () => {
    expect(await createSupplierContact(proc(), { supplierId, nameTh: 'ซ้ำ', email: 'second@supplier.test' }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'EMAIL_TAKEN' } } })
    const second = await prisma.supplierContact.findFirstOrThrow({ where: { email: 'second@supplier.test' } })
    await prisma.portalSession.create({ data: { organizationId: org.organizationId, contactId: second.id, sessionHash: hex(), csrfTokenHash: hex(), lastSeenAt: NOW, expiresAt: new Date('2099-01-01'), userAgentHash: hex(), ipHash: hex() } })
    const r = await updateSupplierContact(proc(), { contactId: second.id, expectedVersion: second.version, email: 'second.new@supplier.test' }, key())
    expect(r).toMatchObject({ ok: true })
    expect(await prisma.portalSession.count({ where: { contactId: second.id, revokedAt: null } })).toBe(0)
    expect((await notices(second.id)).filter((n) => (n.data as { changed: string }).changed === 'EMAIL').map((n) => n.toEmail)).toEqual(['register@supplier.test'])
    expect(await updateSupplierContact(proc(), { contactId: second.id, expectedVersion: second.version, nameTh: 'เก่า' }, key())).toMatchObject({ ok: false, error: { code: 'CONFLICT_VERSION' } })
  })
})

describe('[BR-PORTAL-03] deactivating a contact or revoking its access ends every session in the same transaction', () => {
  it('deactivate: status DEACTIVATED, both sessions revoked with their events; revoke with none left is refused', async () => {
    const c = await createSupplierContact(proc(), { supplierId, nameTh: 'ชั่วคราว', email: `tmp-${randomUUID().slice(0, 6)}@supplier.test` }, key())
    if (!c.ok) throw new Error(JSON.stringify(c.error))
    for (let i = 0; i < 2; i++) await prisma.portalSession.create({ data: { organizationId: org.organizationId, contactId: c.data.contactId, sessionHash: hex(), csrfTokenHash: hex(), lastSeenAt: NOW, expiresAt: new Date('2099-01-01'), userAgentHash: hex(), ipHash: hex() } })
    expect(await revokeSupplierContactSessions(proc(), { contactId: c.data.contactId }, key())).toMatchObject({ ok: true, data: { sessionsRevoked: 2 } })
    expect(await revokeSupplierContactSessions(proc(), { contactId: c.data.contactId }, key())).toMatchObject({ ok: false, error: { details: { reason: 'NO_SESSION' } } })
    await prisma.portalSession.create({ data: { organizationId: org.organizationId, contactId: c.data.contactId, sessionHash: hex(), csrfTokenHash: hex(), lastSeenAt: NOW, expiresAt: new Date('2099-01-01'), userAgentHash: hex(), ipHash: hex() } })
    const version = (await prisma.supplierContact.findUniqueOrThrow({ where: { id: c.data.contactId } })).version
    expect(await deactivateSupplierContact(proc(), { contactId: c.data.contactId, expectedVersion: version }, key())).toMatchObject({ ok: true, data: { sessionsRevoked: 1 } })
    expect(await prisma.event.count({ where: { aggregateId: c.data.contactId, type: 'portal_session.revoked' } })).toBe(3)
    // a deactivated contact frees its address
    expect(await createSupplierContact(proc(), { supplierId, nameTh: 'ใหม่', email: (await prisma.supplierContact.findUniqueOrThrow({ where: { id: c.data.contactId } })).email }, key())).toMatchObject({ ok: true })
  })
})

describe('[FR-SUP-101/AC7] supplier.contact.manage is PROCUREMENT\'s, and the module must be on', () => {
  it('a member without it is FORBIDDEN; with SUPPLIER off every command is MODULE_DISABLED', async () => {
    expect(await createSupplierContact(org.ctxOf('fin_officer', NOW), { supplierId, nameTh: 'x', email: 'x@supplier.test' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    const off = await createP2Org({ modules: ['PAY'] })
    const s = await prisma.supplier.create({ data: { organizationId: off.organizationId, code: 'SC-OFF', nameTh: 'ปิด', taxId: null, isForeign: true } })
    expect(await createSupplierContact(off.ctxOf('proc_officer', NOW), { supplierId: s.id, nameTh: 'x', email: 'x@supplier.test' }, key())).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
  })

  it('the portal\'s action table: unknown actions and actors outside the portal are refused; rules read the facts given', async () => {
    const contact = { id: randomUUID(), supplierId: randomUUID(), applicationId: null }
    const ctx = portalCtx(org.organizationId, contact, NOW)
    expect(portalAuthorize(ctx, 'portal.po.acknowledge', { supplierStatus: 'ACTIVE' })).toMatchObject({ ok: true })
    expect(portalAuthorize(ctx, 'portal.po.acknowledge', { supplierStatus: 'INACTIVE' })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(portalAuthorize(ctx, 'portal.application.edit', { applicationStatus: 'DRAFT' })).toMatchObject({ ok: false })
    expect(portalAuthorize(ctx, 'portal.invoice.submit', { supplierStatus: 'ACTIVE', payModule: true, portalInvoice: false })).toMatchObject({ ok: false })
    expect(portalAuthorize(ctx, 'portal.nothing')).toMatchObject({ ok: false })
    expect(portalAuthorize(proc(), 'portal.document.view')).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    const applicant = portalCtx(org.organizationId, { id: randomUUID(), supplierId: null, applicationId: randomUUID() }, NOW)
    expect(portalAuthorize(applicant, 'portal.application.edit', { applicationStatus: 'RETURNED' })).toMatchObject({ ok: true })
    expect(portalAuthorize(applicant, 'portal.application.edit', { applicationStatus: 'SUBMITTED' })).toMatchObject({ ok: false })
    expect([...PORTAL_MODEL_NAMES]).toEqual(expect.arrayContaining(['supplierContact', 'supplierApplication', 'supplierDocument', 'purchaseOrder']))
  })

  it('[BR-PORTAL-08] the privacy notice: an older version is PRIVACY_NOTICE_OUTDATED, the current one passes', () => {
    expect(requireCurrentPrivacyNotice({ privacyNoticeVersion: null })).toMatchObject({ ok: false, error: { code: 'PRIVACY_NOTICE_OUTDATED' } })
    expect(requireCurrentPrivacyNotice({ privacyNoticeVersion: '2025-01-01' })).toMatchObject({ ok: false })
    expect(requireCurrentPrivacyNotice({ privacyNoticeVersion: '2026-11-01' })).toMatchObject({ ok: true })
  })
})

describe('[BR-NOTI-09] a supplier e-mail reaches the contact of an application that is not a supplier yet, in their language', () => {
  it('no supplierId: the contact\'s address, the application\'s name, the contact\'s locale', async () => {
    registerSupplierTemplate('test.s7_application', (_d, c) => supplierMail(`${c.locale}:${c.supplierName}`, [c.supplierName], [c.locale]))
    const member = org.member.proc_officer!
    const application = await prisma.supplierApplication.create({ data: { organizationId: org.organizationId, kind: 'NEW', invitedById: member, invitedAt: NOW, lastActivityAt: NOW, expiresAt: new Date('2026-12-07T03:00:00Z'), nameTh: 'ห้างผู้สมัครใหม่' } })
    const contact = await prisma.supplierContact.create({ data: { organizationId: org.organizationId, applicationId: application.id, nameTh: 'ผู้สมัคร', email: `app-${randomUUID().slice(0, 6)}@supplier.test`, locale: 'en' } })
    const enqueued = await forTenant(org.organizationId).$transaction((tx) =>
      enqueueSupplierNotice(tx, proc(), { templateKey: 'test.s7_application', applicationId: application.id, contactId: contact.id, subjectType: 'SupplierApplication', subjectId: application.id, dedupeKey: `t:${application.id}`, data: {} }),
    )
    const notice = await prisma.supplierNotice.findUniqueOrThrow({ where: { id: enqueued.noticeId! } })
    expect(notice).toMatchObject({ supplierId: null, applicationId: application.id, contactId: contact.id, toEmail: contact.email, status: 'PENDING' })
    expect(await sendSupplierNotice(org.organizationId, notice.id, NOW)).toBe('SENT')
    expect(mails.at(-1)).toMatchObject({ to: contact.email, subject: 'en:ห้างผู้สมัครใหม่' })
  })
})
