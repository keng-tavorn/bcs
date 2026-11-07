import { createHash, randomUUID } from 'node:crypto'
import { prisma } from '@/server/db/client'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { inviteSupplier } from '@/server/services/suppliers/applications'
import { E2E_DB } from '../support/e2e-env'
import { createP2Org } from '../support/p2-org'
import { apOrg, sentPo } from '../support/ap'

// Run by tests/e2e/portal-apply.spec.ts against the e2e database only (S7-08): `invite` makes an organization of its own
// with SUPPLIER on (the phase-2 fixtures), its document types, and an invitation of a new supplier; prints the org code
// and the invitation's link as the e-mail has it (the notice is not sent in e2e, so its link is still in it). `code`
// prints the newest sign-in code e-mailed to the contact. `po` (S7-11) makes an organization with PAY and SUPPLIER, a
// sent PO of its supplier and a signed-in contact (a session of the portal set as cookies by the spec); `po-told <poId>`
// prints who was told of the acknowledgement and of the new date.
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the portal scene runs in the e2e database only')
setDefaultOutboxSender(null)
const [what, arg] = process.argv.slice(2)

if (what === 'invite') {
  // AI off (EG-1): the organization has PAY and SUPPLIER only
  const org = await createP2Org({ modules: ['PAY', 'SUPPLIER'] })
  const at = new Date()
  await prisma.supplierDocumentType.createMany({
    data: [
      { organizationId: org.organizationId, code: 'COMPANY_CERT', nameTh: 'หนังสือรับรองบริษัท', nameEn: 'Company certificate', appliesTo: ['JURISTIC'], required: true, validityDays: 180 },
      { organizationId: org.organizationId, code: 'VAT_CERT', nameTh: 'ภ.พ.20', nameEn: 'VAT registration', appliesTo: ['JURISTIC'], required: true },
    ],
  })
  const code = (await prisma.organization.findUniqueOrThrow({ where: { id: org.organizationId }, select: { code: true } })).code.toLowerCase()
  const email = `portal-${randomUUID().slice(0, 8)}@supplier.test`
  const r = await inviteSupplier(org.ctxOf('proc_officer', at), { kind: 'NEW', nameTh: 'บริษัท พอร์ทัลทดสอบ จำกัด', taxId: arg!, branchCode: '00000', payeeType: 'JURISTIC', contact: { nameTh: 'คุณสมใจ ผู้ติดต่อ', email } }, { idempotencyKey: randomUUID(), sender: null })
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  const notice = await prisma.supplierNotice.findFirstOrThrow({ where: { applicationId: r.data.applicationId, templateKey: 'supplier.invitation' } })
  console.log(JSON.stringify({ org: code, url: (notice.data as { url: string }).url, contactId: r.data.contactId, applicationId: r.data.applicationId }))
} else if (what === 'code') {
  const notice = await prisma.supplierNotice.findFirstOrThrow({ where: { contactId: arg!, templateKey: 'supplier.otp' }, orderBy: { createdAt: 'desc' } })
  console.log(JSON.stringify({ code: (notice.data as { code: string }).code }))
} else if (what === 'po') {
  const ap = await apOrg()
  const organizationId = ap.org.organizationId
  const now = new Date()
  await prisma.orgModule.create({ data: { organizationId, module: 'SUPPLIER', enabled: true, enabledAt: now, contractRef: 'TEST-P2', reason: 'พอร์ทัลผู้ขาย' } })
  await prisma.supplier.update({ where: { id: ap.supplierId }, data: { portalEnabled: true } })
  const po = await sentPo(ap, [{ quantity: '20', unitPrice: '350.00', description: 'ปูนซีเมนต์ถุง 50 กก.' }])
  await prisma.purchaseOrder.update({ where: { id: po.id }, data: { sentAt: now } })
  const contact = await prisma.supplierContact.create({ data: { organizationId, supplierId: ap.supplierId, nameTh: 'คุณมานะ ผู้ติดต่อ', email: `po-${randomUUID().slice(0, 8)}@supplier.test`, isPrimary: true, privacyNoticeVersion: '2026-11-01', firstSignedInAt: now } })
  const sid = randomUUID() + randomUUID()
  const csrf = randomUUID()
  const sha = (v: string) => createHash('sha256').update(v).digest('hex')
  await prisma.portalSession.create({ data: { organizationId, contactId: contact.id, sessionHash: sha(sid), csrfTokenHash: sha(csrf), lastSeenAt: now, expiresAt: new Date(now.getTime() + 3_600_000), userAgentHash: sha('e2e'), ipHash: sha('e2e') } })
  const code = (await prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { code: true } })).code.toLowerCase()
  console.log(JSON.stringify({ org: code, poId: po.id, number: po.number, sid, csrf, requester: ap.org.member.req_con, receiver: ap.org.member.receiver_con, buyer: po.createdById }))
} else if (what === 'po-told') {
  const told = await prisma.notification.findMany({ where: { subjectId: arg!, templateKey: { in: ['po.acknowledged', 'po.delivery_changed'] } }, select: { templateKey: true, recipientMemberId: true, urgency: true } })
  const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: arg! }, select: { supplierAckStatus: true } })
  console.log(JSON.stringify({ status: po.supplierAckStatus, told }))
} else throw new Error(`unknown portal scene ${what}`)
await prisma.$disconnect()
