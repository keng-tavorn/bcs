import { randomUUID } from 'node:crypto'
import { prisma } from '@/server/db/client'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { inviteSupplier } from '@/server/services/suppliers/applications'
import { E2E_DB } from '../support/e2e-env'
import { createP2Org } from '../support/p2-org'

// Run by tests/e2e/portal-apply.spec.ts against the e2e database only (S7-08): `invite` makes an organization of its own
// with SUPPLIER on (the phase-2 fixtures), its document types, and an invitation of a new supplier; prints the org code
// and the invitation's link as the e-mail has it (the notice is not sent in e2e, so its link is still in it). `code`
// prints the newest sign-in code e-mailed to the contact.
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
} else throw new Error(`unknown portal scene ${what}`)
await prisma.$disconnect()
