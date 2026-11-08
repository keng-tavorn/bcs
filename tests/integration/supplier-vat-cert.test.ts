import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { PORTAL_PRIVACY_NOTICE_VERSION } from '@/lib/portal-limits'
import type { Ctx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { portalCtx } from '@/server/portal/session'
import { applicationSignedIn, inviteSupplier, missingItems, submitApplication, updateApplication } from '@/server/services/suppliers/applications'
import { supplierDocumentStatusInTx } from '@/server/services/suppliers/documents'
import { createP2Org } from '../support/p2-org'
import type { DoaOrg } from '../support/doa-org'

// S7-28 (BR-SDOC-01 · found in S7-13): the VAT certificate (ภ.พ.20) is required only of a payee registered for VAT — an
// application of an individual or a small partnership outside VAT is sent without one, one inside VAT still needs it;
// the documents status of a registered supplier (BR-SDOC-06) reads the same rule.

const NOW = new Date('2026-11-09T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
let org: DoaOrg

function taxId(): string {
  const digits = Array.from({ length: 12 }, (_, i) => (i === 0 ? 3 : Math.floor(Math.random() * 10)))
  const sum = digits.reduce((s, d, i) => s + d * (13 - i), 0)
  return digits.join('') + String((11 - (sum % 11)) % 10)
}

beforeAll(async () => {
  setDefaultOutboxSender(null)
  org = await createP2Org()
  await prisma.supplierDocumentType.createMany({
    data: [
      { organizationId: org.organizationId, code: 'ID_CARD', nameTh: 'บัตรประชาชน', nameEn: 'ID card', appliesTo: ['INDIVIDUAL'], required: true, sensitive: true },
      { organizationId: org.organizationId, code: 'VAT_CERT', nameTh: 'ภ.พ.20', nameEn: 'VAT registration', appliesTo: ['JURISTIC', 'INDIVIDUAL'], required: true, validityDays: 3650 },
    ],
  })
})

async function filledApplication(isVatRegistered: boolean) {
  const r = await inviteSupplier(org.ctxOf('proc_officer', NOW), { kind: 'NEW', nameTh: `นายทดสอบ ${randomUUID().slice(0, 6)}`, taxId: taxId(), branchCode: '00000', payeeType: 'INDIVIDUAL', contact: { nameTh: 'ผู้ติดต่อ', email: `vat-${randomUUID().slice(0, 8)}@supplier.test` } }, key())
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  const contact = await prisma.supplierContact.findUniqueOrThrow({ where: { id: r.data.contactId } })
  const ctx: Ctx = portalCtx(org.organizationId, contact, NOW)
  await forTenant(org.organizationId).$transaction((tx) => applicationSignedIn(tx, ctx, contact))
  await prisma.supplierContact.update({ where: { id: contact.id }, data: { privacyNoticeVersion: PORTAL_PRIVACY_NOTICE_VERSION } })
  const v = (await prisma.supplierApplication.findUniqueOrThrow({ where: { id: r.data.applicationId } })).version
  const u = await updateApplication(ctx, { applicationId: r.data.applicationId, expectedVersion: v, fields: { address: '1 ถนนทดสอบ', isVatRegistered } }, key())
  if (!u.ok) throw new Error(JSON.stringify(u.error))
  const file = await prisma.fileObject.create({ data: { organizationId: org.organizationId, storageKey: `test/${randomUUID()}.pdf`, fileName: 'id.pdf', mimeType: 'application/pdf', sizeBytes: 1, status: 'AVAILABLE', scanStatus: 'CLEAN' } })
  await prisma.supplierDocument.create({ data: { organizationId: org.organizationId, applicationId: r.data.applicationId, documentTypeCode: 'ID_CARD', fileId: file.id, issuedOn: new Date('2026-01-01'), expiresOn: new Date('2030-01-01') } })
  return { applicationId: r.data.applicationId, ctx }
}

describe('[FR-SUP-102/AC4] S7-28 the VAT certificate only of a payee registered for VAT', () => {
  it('an individual outside VAT sends the application without ภ.พ.20; one inside VAT is told it is missing', async () => {
    const outside = await filledApplication(false)
    const v1 = (await prisma.supplierApplication.findUniqueOrThrow({ where: { id: outside.applicationId } })).version
    expect(await submitApplication(outside.ctx, { applicationId: outside.applicationId, expectedVersion: v1 }, key())).toMatchObject({ ok: true })
    const inside = await filledApplication(true)
    const app = await prisma.supplierApplication.findUniqueOrThrow({ where: { id: inside.applicationId } })
    expect(await forTenant(org.organizationId).$transaction((tx) => missingItems(tx, app))).toEqual(['document:VAT_CERT'])
    expect(await submitApplication(inside.ctx, { applicationId: inside.applicationId, expectedVersion: app.version }, key())).toMatchObject({ ok: false })
  })

  it('the documents status of a registered supplier outside VAT asks for no ภ.พ.20', async () => {
    const supplier = await prisma.supplier.create({ data: { organizationId: org.organizationId, code: `V-${randomUUID().slice(0, 5)}`, nameTh: 'นายไม่จด VAT', taxId: taxId(), payeeType: 'INDIVIDUAL', isVatRegistered: false } })
    const status = await forTenant(org.organizationId).$transaction((tx) => supplierDocumentStatusInTx(tx, org.organizationId, supplier.id, NOW))
    expect(status.rows.filter((r) => r.required).map((r) => r.documentTypeCode)).toEqual(['ID_CARD'])
  })
})
