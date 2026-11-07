import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { portalAuthorize } from '@/server/portal/authz'
import { getPortalApplication, getPortalHelp, listPortalTodos } from '@/server/portal/queries'
import { portalCtx } from '@/server/portal/session'
import { closeOwnContact, deactivateSupplierContact, setOwnContactLocale, updateSupplierContact } from '@/server/services/suppliers/contacts'
import { inviteSupplier } from '@/server/services/suppliers/applications'
import type { DoaOrg } from '../support/doa-org'
import { createP2Org } from '../support/p2-org'

// S7-08 (docs/sub-specs/S7.md "คำสั่งของขั้น" · "/portal/profile" "/portal/home" "/portal/apply"): what a contact changes of
// their own account on the portal — the language only, and closing it unless they are the primary contact — never
// another contact's; the application as the form reads it (the account number's last four only, the warnings without
// the suppliers they resemble); the home's to-do list of a registered supplier; whom to ask.

const NOW = new Date('2026-11-07T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
let org: DoaOrg

function taxId(): string {
  const digits = Array.from({ length: 12 }, (_, i) => (i === 0 ? 0 : Math.floor(Math.random() * 10)))
  const sum = digits.reduce((s, d, i) => s + d * (13 - i), 0)
  return digits.join('') + String((11 - (sum % 11)) % 10)
}

beforeAll(async () => {
  setDefaultOutboxSender(null)
  org = await createP2Org()
  await prisma.supplierDocumentType.createMany({
    data: [
      { organizationId: org.organizationId, code: 'COMPANY_CERT', nameTh: 'หนังสือรับรองบริษัท', nameEn: 'Company certificate', appliesTo: ['JURISTIC'], required: true, validityDays: 180, reminderDaysBefore: 30 },
      { organizationId: org.organizationId, code: 'VAT_CERT', nameTh: 'ภ.พ.20', nameEn: 'VAT registration', appliesTo: ['JURISTIC'], required: true },
    ],
  })
})

async function supplierWithContacts() {
  const supplier = await prisma.supplier.create({ data: { organizationId: org.organizationId, code: `PP-${randomUUID().slice(0, 6)}`, nameTh: 'บริษัท โปรไฟล์ จำกัด', taxId: taxId(), branchCode: '00000', portalEnabled: true } })
  const contact = (primary: boolean) =>
    prisma.supplierContact.create({ data: { organizationId: org.organizationId, supplierId: supplier.id, nameTh: primary ? 'หลัก' : 'รอง', email: `pp-${randomUUID().slice(0, 8)}@supplier.test`, isPrimary: primary, privacyNoticeVersion: '2026-11-01' } })
  return { supplier, primary: await contact(true), other: await contact(false) }
}

describe('[S7-08] a contact changes their own account on the portal', () => {
  it('the language only: SupplierContact.locale changes; any other field, or another contact, is FORBIDDEN', async () => {
    const s = await supplierWithContacts()
    const ctx = portalCtx(org.organizationId, s.other, NOW)
    expect(portalAuthorize(ctx, 'portal.contact.self').ok).toBe(true)
    expect(await setOwnContactLocale(ctx, { locale: 'en' }, key())).toMatchObject({ ok: true })
    expect((await prisma.supplierContact.findUniqueOrThrow({ where: { id: s.other.id } })).locale).toBe('en')
    expect(await prisma.event.count({ where: { type: 'supplier_contact.updated', aggregateId: s.other.id } })).toBe(1)
    // the same language again changes nothing and writes nothing
    expect(await setOwnContactLocale(ctx, { locale: 'en' }, key())).toMatchObject({ ok: true })
    expect(await prisma.event.count({ where: { type: 'supplier_contact.updated', aggregateId: s.other.id } })).toBe(1)
    const v = (await prisma.supplierContact.findUniqueOrThrow({ where: { id: s.other.id } })).version
    expect(await updateSupplierContact(ctx, { contactId: s.other.id, expectedVersion: v, nameTh: 'ชื่อใหม่' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await updateSupplierContact(ctx, { contactId: s.other.id, expectedVersion: v, email: 'x@supplier.test' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    const pv = (await prisma.supplierContact.findUniqueOrThrow({ where: { id: s.primary.id } })).version
    expect(await updateSupplierContact(ctx, { contactId: s.primary.id, expectedVersion: pv, locale: 'en' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })

  it('closing: a non-primary contact closes their own account and their sessions end; the primary contact cannot (PRIMARY_CONTACT); another contact\'s is FORBIDDEN', async () => {
    const s = await supplierWithContacts()
    await prisma.portalSession.create({ data: { organizationId: org.organizationId, contactId: s.other.id, sessionHash: randomUUID().replace(/-/g, '').padEnd(64, '0'), csrfTokenHash: randomUUID().replace(/-/g, '').padEnd(64, '1'), lastSeenAt: NOW, expiresAt: new Date('2026-11-07T15:00:00Z'), userAgentHash: 'a'.repeat(64), ipHash: 'b'.repeat(64) } })
    const primary = portalCtx(org.organizationId, s.primary, NOW)
    expect(await closeOwnContact(primary, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'PRIMARY_CONTACT' } } })
    const ov = (await prisma.supplierContact.findUniqueOrThrow({ where: { id: s.other.id } })).version
    expect(await deactivateSupplierContact(primary, { contactId: s.other.id, expectedVersion: ov }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    const other = portalCtx(org.organizationId, s.other, NOW)
    expect(await closeOwnContact(other, key())).toMatchObject({ ok: true, data: { sessionsRevoked: 1 } })
    expect((await prisma.supplierContact.findUniqueOrThrow({ where: { id: s.other.id } })).status).toBe('DEACTIVATED')
    expect(await prisma.portalSession.count({ where: { contactId: s.other.id, revokedAt: null } })).toBe(0)
  })

  it('a member still needs supplier.contact.manage (fin_officer has none)', async () => {
    const s = await supplierWithContacts()
    expect(await updateSupplierContact(org.ctxOf('fin_officer', NOW), { contactId: s.other.id, expectedVersion: 0, locale: 'en' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})

describe('[S7-08] what the portal pages read', () => {
  it('the application as the form reads it: the last four of the account only, warnings by code without the suppliers they resemble, what is missing', async () => {
    const id = taxId()
    // a registered supplier of the same tax id in another branch: the application warns SAME_TAXID_OTHER_BRANCH
    const other = await prisma.supplier.create({ data: { organizationId: org.organizationId, code: `SEEN-${randomUUID().slice(0, 4)}`, nameTh: 'บริษัท ที่มีอยู่แล้ว จำกัด', taxId: id, branchCode: '00000' } })
    const r = await inviteSupplier(org.ctxOf('proc_officer', NOW), { kind: 'NEW', nameTh: 'บริษัท ใหม่ สาขาสอง จำกัด', taxId: id, branchCode: '00002', payeeType: 'JURISTIC', contact: { nameTh: 'ผู้ติดต่อ', email: `pa-${randomUUID().slice(0, 8)}@supplier.test` }, duplicateReasons: { SAME_TAXID_OTHER_BRANCH: 'สาขาใหม่ของบริษัทเดิม' } }, key())
    if (!r.ok) throw new Error(JSON.stringify(r.error))
    await prisma.supplierApplication.update({ where: { id: r.data.applicationId }, data: { bankCode: '004', accountNoEnc: 'sealed', accountNoLast4: '7890' } })
    const contact = await prisma.supplierContact.findUniqueOrThrow({ where: { id: r.data.contactId } })
    const view = await getPortalApplication(portalCtx(org.organizationId, contact, NOW))
    expect(view).toMatchObject({ editable: true, fields: { accountNoLast4: '7890', bankCode: '004' }, warnings: [{ code: 'SAME_TAXID_OTHER_BRANCH', reason: 'สาขาใหม่ของบริษัทเดิม' }] })
    expect(view!.missing).toEqual(['address', 'document:COMPANY_CERT', 'document:VAT_CERT'])
    expect(view!.documents.map((d) => [d.code, d.state, d.expiresRequired])).toEqual([
      ['COMPANY_CERT', 'NONE', false],
      ['VAT_CERT', 'NONE', true],
    ])
    const seen = JSON.stringify(view)
    expect(seen).not.toContain(other.code)
    expect(seen).not.toContain('sealed')
    // the inviter is whom the help page names
    expect(await getPortalHelp(portalCtx(org.organizationId, contact, NOW))).toMatchObject({ inviter: { name: expect.any(String), email: expect.stringContaining('@') } })
    // a registered supplier's contact has no application form
    const s = await supplierWithContacts()
    expect(await getPortalApplication(portalCtx(org.organizationId, s.primary, NOW))).toBeNull()
  })

  it('the home of a registered supplier: each required document missing, or about to expire, is a thing to do', async () => {
    const s = await supplierWithContacts()
    await prisma.supplier.update({ where: { id: s.supplier.id }, data: { payeeType: 'JURISTIC' } })
    const f = await prisma.fileObject.create({ data: { organizationId: org.organizationId, storageKey: `test/${randomUUID()}.pdf`, fileName: 'c.pdf', mimeType: 'application/pdf', sizeBytes: 1, status: 'AVAILABLE', scanStatus: 'CLEAN' } })
    await prisma.supplierDocument.create({ data: { organizationId: org.organizationId, supplierId: s.supplier.id, documentTypeCode: 'COMPANY_CERT', fileId: f.id, issuedOn: new Date('2026-05-20'), expiresOn: new Date('2026-11-16'), status: 'VERIFIED', verifiedById: org.member.proc_officer!, verifiedAt: NOW } })
    const todos = await listPortalTodos(portalCtx(org.organizationId, s.primary, NOW))
    expect(todos).toEqual([
      { kind: 'DOCUMENT_EXPIRING', page: '/documents', values: { typeTh: 'หนังสือรับรองบริษัท', typeEn: 'Company certificate', date: '2026-11-16' } },
      { kind: 'DOCUMENT_MISSING', page: '/documents', values: { typeTh: 'ภ.พ.20', typeEn: 'VAT registration' } },
    ])
  })
})
