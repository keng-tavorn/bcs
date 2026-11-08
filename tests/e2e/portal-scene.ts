import { createHash, randomUUID } from 'node:crypto'
import { prisma } from '@/server/db/client'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { inviteSupplier } from '@/server/services/suppliers/applications'
import { E2E_DB } from '../support/e2e-env'
import { createP2Org } from '../support/p2-org'
import { apOrg, receive, sentPo } from '../support/ap'
import { makeCtx } from '@/server/context'
import { confirmInvoiceCoding, submitInvoice } from '@/server/services/ap'
import { listApInvoices } from '@/server/services/ap/view-list'

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
} else if (what === 'invoice') {
  // S7-12 (scene 6): an organization with PAY and SUPPLIER, a PO of its supplier sent and received in full, a signed-in contact
  const ap = await apOrg()
  const organizationId = ap.org.organizationId
  const now = new Date()
  await prisma.orgModule.create({ data: { organizationId, module: 'SUPPLIER', enabled: true, enabledAt: now, contractRef: 'TEST-P2', reason: 'พอร์ทัลผู้ขาย' } })
  await prisma.supplier.update({ where: { id: ap.supplierId }, data: { portalEnabled: true } })
  const po = await sentPo(ap, [{ quantity: '4', unitPrice: '25000.00', description: 'เหล็กข้ออ้อย DB16' }])
  await receive(ap, po, { 0: '4' })
  const contact = await prisma.supplierContact.create({ data: { organizationId, supplierId: ap.supplierId, nameTh: 'คุณวิไล บัญชีผู้ขาย', email: `inv-${randomUUID().slice(0, 8)}@supplier.test`, isPrimary: true, privacyNoticeVersion: '2026-11-01', firstSignedInAt: now } })
  const sid = randomUUID() + randomUUID()
  const csrf = randomUUID()
  const sha = (v: string) => createHash('sha256').update(v).digest('hex')
  await prisma.portalSession.create({ data: { organizationId, contactId: contact.id, sessionHash: sha(sid), csrfTokenHash: sha(csrf), lastSeenAt: now, expiresAt: new Date(now.getTime() + 3_600_000), userAgentHash: sha('e2e'), ipHash: sha('e2e') } })
  const code = (await prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { code: true } })).code.toLowerCase()
  console.log(JSON.stringify({ org: code, organizationId, poId: po.id, number: po.number, sid, csrf }))
} else if (what === 'invoice-finance') {
  // FINANCE finds the draft among the portal's, codes every line, submits it (matched: ready to pay); then a run pays the
  // supplier and its 50 ทวิ is filed — what the supplier's payments page reads
  const [organizationId, poId] = arg!.split(':')
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { id: true } })
  const fin = await prisma.member.findFirstOrThrow({ where: { organizationId: org.id, roleAssignments: { some: { role: 'FINANCE', revokedAt: null } } }, orderBy: { email: 'asc' } })
  const ctx = makeCtx({ organizationId: org.id, actor: { type: 'USER', memberId: fin.id }, channel: 'WEB', now: new Date() })
  const listed = await listApInvoices(ctx, { tab: 'draft', channel: 'PORTAL' })
  if (!listed.ok) throw new Error(JSON.stringify(listed.error))
  const row = listed.data.rows.find((r) => r.po.id === poId)
  if (!row) throw new Error('the portal draft is not in FINANCE’s list')
  const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: row.id }, include: { lines: { include: { poLine: { include: { budgetLine: true } } } } } })
  const opts = () => ({ idempotencyKey: randomUUID(), sender: null })
  const coded = await confirmInvoiceCoding(ctx, { invoiceId: invoice.id, version: invoice.version, lines: invoice.lines.map((l) => ({ invoiceLineId: l.id, accountCode: l.poLine.budgetLine.accountCode ?? '510101', costCenterId: l.poLine.budgetLine.costCenterId })) }, opts())
  if (!coded.ok) throw new Error(JSON.stringify(coded.error))
  const submitted = await submitInvoice(ctx, { invoiceId: invoice.id, version: coded.data.version }, opts())
  if (!submitted.ok) throw new Error(JSON.stringify(submitted.error))
  // a run paid on the due date, to an account ending 6789, with its 50 ทวิ (read by /portal/<org>/payments)
  const payer = await prisma.bankAccount.create({ data: { organizationId: org.id, ownerKind: 'ORGANIZATION', code: 'CB-E2E', bankCode: '004', accountNo: '1000000040', accountName: 'องค์กร', accountType: 'CURRENT', fileTemplateCode: 'BCS-NEUTRAL-1', activatedAt: new Date() } })
  const run = await prisma.paymentRun.create({ data: { organizationId: org.id, number: 'PAY-2569-00001', status: 'COMPLETED', payDate: new Date('2026-11-13T00:00:00Z'), payerBankAccountId: payer.id, fileTemplateCode: 'BCS-NEUTRAL-1', preparedById: fin.id } })
  await prisma.paymentRunItem.create({ data: { organizationId: org.id, paymentRunId: run.id, supplierId: invoice.supplierId, seq: 1, payeeBankCode: '014', payeeAccountNo: '2123456789', payeeAccountName: 'ผู้ขายหนึ่ง', payableSatang: 10058000n, transferSatang: 10058000n, status: 'PAID', paidOn: new Date('2026-11-13T00:00:00Z'), bankReference: 'E2E-REF-HIDDEN', resultRecordedAt: new Date() } })
  console.log(JSON.stringify({ invoiceId: invoice.id, status: submitted.data.status }))
} else throw new Error(`unknown portal scene ${what}`)
await prisma.$disconnect()
