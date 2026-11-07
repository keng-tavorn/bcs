import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { EICAR_TEST_STRING } from '@/integrations/scanner'
import { prisma } from '@/server/db/client'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { portalCtx } from '@/server/portal/session'
import {
  deactivateSupplierDocumentType,
  rejectSupplierDocument,
  requestSupplierDocumentDownload,
  runDocumentExpiry,
  scanFile,
  sniffSupplierFile,
  supplierDocumentScanned,
  supplierDocumentStatus,
  uploadSupplierDocument,
  upsertSupplierDocumentType,
  verifySupplierDocument,
} from '@/server/services/suppliers/documents'
import type { DoaOrg } from '../support/doa-org'
import { createP2Org } from '../support/p2-org'

// S7-06 (ADR-185 · BR-SDOC ข้อ 01 ถึง ข้อ 06 · BR-PORTAL ข้อ 07 · FR-SUP-102 AC4 ถึง AC7 · INV-SUP-03): a supplier's
// documents through the real bucket (RustFS) and the stub scanner — upload by the bytes, the central scan, verify once
// with supersede by type and scope, reject, downloads that log a sensitive file, the daily expiry on an injected date.

const NOW = new Date('2026-11-03T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const PDF = (text = 'hello') => new TextEncoder().encode(`%PDF-1.7\n${text}\n%%EOF`)
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

let org: DoaOrg
let supplierId: string
let contact: { id: string; supplierId: string | null; applicationId: string | null }
const as = (code: string, now = NOW) => org.ctxOf(code, now)

beforeAll(async () => {
  setDefaultOutboxSender(null)
  org = await createP2Org()
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.fin_officer!, role: 'FINANCE', grantedAt: NOW } })
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.dm_con!, role: 'AUDITOR', grantedAt: NOW } })
  for (const type of [
    { code: 'COMPANY_CERT', nameTh: 'หนังสือรับรองบริษัท', nameEn: 'Company certificate', appliesTo: ['JURISTIC' as const], required: true, validityDays: 180, reminderDaysBefore: 30, sensitive: false, singleInstance: true },
    { code: 'ISO_CERT', nameTh: 'ใบรับรอง ISO', nameEn: 'ISO certificate', appliesTo: ['JURISTIC' as const], required: false, validityDays: null, reminderDaysBefore: 30, sensitive: false, singleInstance: false },
    { code: 'ID_CARD', nameTh: 'บัตรประชาชน', nameEn: 'ID card', appliesTo: ['INDIVIDUAL' as const, 'JURISTIC' as const], required: false, validityDays: 3650, reminderDaysBefore: 30, sensitive: true, singleInstance: true },
  ]) {
    const r = await upsertSupplierDocumentType(as('admin'), type, key())
    if (!r.ok) throw new Error(JSON.stringify(r.error))
  }
  supplierId = (await prisma.supplier.create({ data: { organizationId: org.organizationId, code: 'SD-01', nameTh: 'บริษัท เอกสาร จำกัด', taxId: '0105555000011', email: 'register.sd@supplier.test' } })).id
  contact = await prisma.supplierContact.create({ data: { organizationId: org.organizationId, supplierId, nameTh: 'ผู้ติดต่อเอกสาร', email: `sd-${randomUUID().slice(0, 6)}@supplier.test`, isPrimary: true, privacyNoticeVersion: '2026-11-01' } })
})

const portal = (now = NOW) => portalCtx(org.organizationId, contact, now)

async function uploaded(input: Partial<Parameters<typeof uploadSupplierDocument>[1]> = {}, ctx = portal()) {
  const r = await uploadSupplierDocument(ctx, { supplierId, documentTypeCode: 'COMPANY_CERT', issuedOn: '2026-11-03', fileName: 'cert.pdf', bytes: PDF(randomUUID()), ...input }, key())
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}
const version = async (id: string) => (await prisma.supplierDocument.findUniqueOrThrow({ where: { id } })).version
async function scannedClean(fileId: string) {
  expect(await scanFile(org.organizationId, fileId, NOW)).toBe('CLEAN')
  expect(await supplierDocumentScanned(org.organizationId, fileId, 'CLEAN', NOW)).toBe('SCANNED')
}

describe('[FR-SUP-102/AC4] the supplier uploads a document under its type', () => {
  it('a PDF by its bytes: PENDING with expiresOn of the type (180 days), its file PENDING the scan, the events the contact\'s', async () => {
    const d = await uploaded()
    expect(await prisma.supplierDocument.findUniqueOrThrow({ where: { id: d.documentId } })).toMatchObject({ status: 'PENDING', expiresOn: new Date('2027-05-01'), uploadedByContactId: contact.id })
    expect(await prisma.fileObject.findUniqueOrThrow({ where: { id: d.fileId } })).toMatchObject({ scanStatus: 'PENDING', mimeType: 'application/pdf', uploadedById: null })
    expect(await prisma.fileLink.count({ where: { fileId: d.fileId, kind: 'SUPPLIER_DOC' } })).toBe(1)
    expect(await prisma.event.findFirst({ where: { aggregateId: d.documentId, type: 'supplier_document.uploaded' } })).toMatchObject({ actorType: 'SUPPLIER', actorSupplierContactId: contact.id, channel: 'PORTAL' })
  })

  it('refuses what is not PDF JPEG PNG WebP by its bytes, an empty file, a type for another payee, dates out of order, and another supplier\'s documents', async () => {
    expect(sniffSupplierFile(PNG)).toBe('image/png')
    expect(sniffSupplierFile(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp')
    expect(await uploadSupplierDocument(portal(), { supplierId, documentTypeCode: 'COMPANY_CERT', issuedOn: '2026-11-03', fileName: 'x.exe', bytes: new TextEncoder().encode('MZ\x90\x00') }, key())).toMatchObject({ ok: false, error: { details: { reason: 'TYPE_NOT_ALLOWED' } } })
    expect(await uploadSupplierDocument(portal(), { supplierId, documentTypeCode: 'COMPANY_CERT', issuedOn: '2026-11-03', fileName: 'x.pdf', bytes: new Uint8Array() }, key())).toMatchObject({ ok: false, error: { details: { reason: 'EMPTY' } } })
    expect(await uploadSupplierDocument(portal(), { supplierId, documentTypeCode: 'ISO_CERT', issuedOn: '2026-11-03', fileName: 'iso.pdf', bytes: PDF() }, key())).toMatchObject({ ok: false, error: { details: { reason: 'EXPIRY_REQUIRED' } } })
    expect(await uploadSupplierDocument(portal(), { supplierId, documentTypeCode: 'COMPANY_CERT', issuedOn: '2026-12-01', fileName: 'c.pdf', bytes: PDF() }, key())).toMatchObject({ ok: false, error: { details: { reason: 'ISSUED_IN_FUTURE' } } })
    const other = await prisma.supplier.create({ data: { organizationId: org.organizationId, code: 'SD-02', nameTh: 'ผู้ขายอื่น', taxId: null, isForeign: true } })
    expect(await uploadSupplierDocument(portal(), { supplierId: other.id, documentTypeCode: 'COMPANY_CERT', issuedOn: '2026-11-03', fileName: 'c.pdf', bytes: PDF() }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })

  it('[BR-PORTAL-08] a contact with an older privacy notice uploads nothing', async () => {
    await prisma.supplierContact.update({ where: { id: contact.id }, data: { privacyNoticeVersion: null } })
    try {
      expect(await uploadSupplierDocument(portal(), { supplierId, documentTypeCode: 'COMPANY_CERT', issuedOn: '2026-11-03', fileName: 'c.pdf', bytes: PDF() }, key())).toMatchObject({ ok: false, error: { code: 'PRIVACY_NOTICE_OUTDATED' } })
    } finally {
      await prisma.supplierContact.update({ where: { id: contact.id }, data: { privacyNoticeVersion: '2026-11-01' } })
    }
  })

  it('[BR-PORTAL-07] a file with the EICAR test string is INFECTED: the document REJECTED, the supplier told, no one downloads it', async () => {
    const d = await uploaded({ bytes: new TextEncoder().encode(`%PDF-1.4\n${EICAR_TEST_STRING}\n`) })
    expect(await scanFile(org.organizationId, d.fileId, NOW)).toBe('INFECTED')
    expect(await scanFile(org.organizationId, d.fileId, NOW)).toBe('SKIPPED')
    expect(await prisma.event.findFirst({ where: { aggregateId: d.fileId, type: 'file.scanned' } })).toMatchObject({ data: { result: 'INFECTED', linkKinds: ['SUPPLIER_DOC'], scanner: 'stub' } })
    expect(await supplierDocumentScanned(org.organizationId, d.fileId, 'INFECTED', NOW)).toBe('REJECTED')
    expect(await prisma.supplierDocument.findUniqueOrThrow({ where: { id: d.documentId } })).toMatchObject({ status: 'REJECTED', rejectReason: 'FILE_INFECTED' })
    expect(await prisma.supplierNotice.count({ where: { subjectId: d.documentId, templateKey: 'supplier.document_rejected' } })).toBe(1)
    expect(await requestSupplierDocumentDownload(as('proc_officer'), { documentId: d.documentId }, key())).toMatchObject({ ok: false, error: { code: 'FILE_INFECTED' } })
  })
})

describe('[FR-SUP-102/AC5] PROCUREMENT verifies a document once; a new copy supersedes the old', () => {
  it('a file not yet scanned is FILE_NOT_SCANNED; clean, it is VERIFIED by its verifier (INV-SUP-03); FINANCE and the contact may not verify', async () => {
    const d = await uploaded()
    expect(await verifySupplierDocument(as('proc_officer'), { documentId: d.documentId, expectedVersion: await version(d.documentId) }, key())).toMatchObject({ ok: false, error: { code: 'FILE_NOT_SCANNED' } })
    await scannedClean(d.fileId)
    expect(await verifySupplierDocument(as('fin_officer'), { documentId: d.documentId, expectedVersion: await version(d.documentId) }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await verifySupplierDocument(portal(), { documentId: d.documentId, expectedVersion: await version(d.documentId) }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await verifySupplierDocument(as('proc_officer'), { documentId: d.documentId, expectedVersion: await version(d.documentId), docNumber: '0105555000011-1' }, key())).toMatchObject({ ok: true })
    expect(await prisma.supplierDocument.findUniqueOrThrow({ where: { id: d.documentId } })).toMatchObject({ status: 'VERIFIED', verifiedById: org.member.proc_officer, docNumber: '0105555000011-1' })
    // INV-SUP-03: every VERIFIED row has its verifier and a CLEAN file
    const bad = await prisma.supplierDocument.count({ where: { organizationId: org.organizationId, status: 'VERIFIED', OR: [{ verifiedById: null }, { file: { scanStatus: { not: 'CLEAN' } } }] } })
    expect(bad).toBe(0)
  })

  it('a single-instance type: the new copy supersedes the verified one; ISO of two scopes stay verified side by side, the same scope written otherwise supersedes', async () => {
    const first = await prisma.supplierDocument.findFirstOrThrow({ where: { supplierId, documentTypeCode: 'COMPANY_CERT', status: 'VERIFIED' } })
    const second = await uploaded()
    await scannedClean(second.fileId)
    expect(await verifySupplierDocument(as('proc_officer'), { documentId: second.documentId, expectedVersion: await version(second.documentId) }, key())).toMatchObject({ ok: true, data: { supersedes: [first.id] } })
    expect(await prisma.supplierDocument.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ status: 'SUPERSEDED', supersededById: second.documentId })
    const iso = async (scope: string) => {
      const d = await uploaded({ documentTypeCode: 'ISO_CERT', scope, issuedOn: '2026-01-01', expiresOn: '2028-12-31' })
      await scannedClean(d.fileId)
      const v = await verifySupplierDocument(as('proc_officer'), { documentId: d.documentId, expectedVersion: await version(d.documentId) }, key())
      if (!v.ok) throw new Error(JSON.stringify(v.error))
      return { id: d.documentId, supersedes: v.data.supersedes }
    }
    const a = await iso('ISO 9001')
    const b = await iso('ISO 14001')
    expect(b.supersedes).toEqual([])
    const c = await iso('iso  9001 ')
    expect(c.supersedes).toEqual([a.id])
    expect((await prisma.supplierDocument.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('VERIFIED')
  })

  it('reject needs a reason; the supplier hears it', async () => {
    const d = await uploaded()
    await scannedClean(d.fileId)
    expect(await rejectSupplierDocument(as('proc_officer'), { documentId: d.documentId, expectedVersion: await version(d.documentId), reason: 'ภาพไม่ชัด อ่านเลขไม่ได้' }, key())).toMatchObject({ ok: true })
    expect(await prisma.supplierNotice.findFirstOrThrow({ where: { subjectId: d.documentId, templateKey: 'supplier.document_rejected' } })).toMatchObject({ contactId: contact.id })
  })
})

describe('[FR-SUP-102/AC6] reminders before expiry and the expiry itself, on the date of Bangkok', () => {
  it('reminds once on remindOn (e-mail + PROCUREMENT digest), expires the day after expiresOn; a second run does nothing', async () => {
    const d = await uploaded({ issuedOn: '2026-05-08' }) // 180 days → expiresOn 2026-11-03, remindOn 2026-10-04
    await scannedClean(d.fileId)
    await verifySupplierDocument(as('proc_officer'), { documentId: d.documentId, expectedVersion: await version(d.documentId) }, key())
    const r1 = await runDocumentExpiry(org.organizationId, new Date('2026-11-03T00:30:00Z'))
    expect(r1.reminded).toBeGreaterThanOrEqual(1)
    expect(await prisma.supplierNotice.count({ where: { subjectId: d.documentId, templateKey: 'supplier.document_expiring' } })).toBe(1)
    expect(await prisma.notification.count({ where: { organizationId: org.organizationId, templateKey: 'supplier.documents_expiring_digest', subjectId: d.documentId } })).toBeGreaterThanOrEqual(1)
    await runDocumentExpiry(org.organizationId, new Date('2026-11-03T05:00:00Z'))
    expect(await prisma.supplierNotice.count({ where: { subjectId: d.documentId, templateKey: 'supplier.document_expiring' } })).toBe(1)
    // 23:59:59 of the 3rd in Bangkok it is still in force; at 00:00 of the 4th it has expired
    await runDocumentExpiry(org.organizationId, new Date('2026-11-03T16:59:59Z'))
    expect((await prisma.supplierDocument.findUniqueOrThrow({ where: { id: d.documentId } })).status).toBe('VERIFIED')
    await runDocumentExpiry(org.organizationId, new Date('2026-11-03T17:00:00Z'))
    expect((await prisma.supplierDocument.findUniqueOrThrow({ where: { id: d.documentId } })).status).toBe('EXPIRED')
  })

  it('[BR-SDOC-06] the supplier\'s documents by type: OK, EXPIRING, MISSING from the date, for screens and for the contact', async () => {
    // a supplier of its own, its certificate uploaded by PROCUREMENT for it and verified: in force, then due a reminder
    const own = await prisma.supplier.create({ data: { organizationId: org.organizationId, code: 'SD-04', nameTh: 'บริษัท สถานะ จำกัด', taxId: null, isForeign: true } })
    const d = await uploaded({ supplierId: own.id }, as('proc_officer'))
    await scannedClean(d.fileId)
    await verifySupplierDocument(as('proc_officer'), { documentId: d.documentId, expectedVersion: await version(d.documentId) }, key())
    const r = await supplierDocumentStatus(as('proc_officer', new Date('2026-11-05T03:00:00Z')), own.id)
    if (!r.ok) throw new Error(JSON.stringify(r.error))
    expect(r.data.rows.find((x) => x.documentTypeCode === 'COMPANY_CERT')).toMatchObject({ required: true, state: 'OK', expiresOn: '2027-05-01' })
    expect(r.data.requiredDocumentsOk).toBe(true)
    const later = await supplierDocumentStatus(as('proc_officer', new Date('2027-04-01T03:00:00Z')), own.id)
    expect(later).toMatchObject({ ok: true, data: { rows: [{ documentTypeCode: 'COMPANY_CERT', state: 'EXPIRING' }], requiredDocumentsOk: true } })
    const other = await prisma.supplier.create({ data: { organizationId: org.organizationId, code: 'SD-03', nameTh: 'ผู้ขายไม่มีเอกสาร', taxId: null, isForeign: true } })
    const none = await supplierDocumentStatus(as('proc_officer'), other.id)
    expect(none).toMatchObject({ ok: true, data: { rows: [{ documentTypeCode: 'COMPANY_CERT', state: 'MISSING' }], requiredDocumentsOk: false } })
    expect(await supplierDocumentStatus(portal(), other.id)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await supplierDocumentStatus(portal(), supplierId)).toMatchObject({ ok: true })
  })
})

describe('[FR-SUP-102/AC7] a sensitive document: logged at every download, AUDITOR sees no file', () => {
  it('PROCUREMENT downloads with a log row; AUDITOR is refused the file; the URL lives at most five minutes', async () => {
    const d = await uploaded({ documentTypeCode: 'ID_CARD' })
    await scannedClean(d.fileId)
    const r = await requestSupplierDocumentDownload(as('proc_officer'), { documentId: d.documentId, purpose: 'ตรวจตัวตนผู้ขาย' }, key())
    expect(r).toMatchObject({ ok: true, data: { expiresInSeconds: 300 } })
    expect(await prisma.sensitiveAccessLog.count({ where: { subjectType: 'SupplierDocument', subjectId: d.documentId, memberId: org.member.proc_officer } })).toBe(1)
    expect(await requestSupplierDocumentDownload(as('dm_con'), { documentId: d.documentId }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await requestSupplierDocumentDownload(as('req_con'), { documentId: d.documentId }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await prisma.event.count({ where: { aggregateId: d.fileId, type: 'file.downloaded' } })).toBe(1)
  })
})

describe('[BR-SDOC-01] document types are ORG_ADMIN\'s', () => {
  it('PROCUREMENT may not change them; a type closed is not offered for upload', async () => {
    expect(await upsertSupplierDocumentType(as('proc_officer'), { code: 'X_TYPE', nameTh: 'x', nameEn: 'x', appliesTo: ['JURISTIC'], required: false, validityDays: 30, reminderDaysBefore: 5 }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await upsertSupplierDocumentType(as('admin'), { code: 'TEMP_TYPE', nameTh: 'ชั่วคราว', nameEn: 'Temporary', appliesTo: ['JURISTIC'], required: false, validityDays: 30, reminderDaysBefore: 5 }, key())).toMatchObject({ ok: true })
    expect(await deactivateSupplierDocumentType(as('admin'), { code: 'TEMP_TYPE' }, key())).toMatchObject({ ok: true })
    expect(await uploadSupplierDocument(portal(), { supplierId, documentTypeCode: 'TEMP_TYPE', issuedOn: '2026-11-03', fileName: 't.pdf', bytes: PDF() }, key())).toMatchObject({ ok: false, error: { details: { reason: 'TYPE' } } })
  })
})
