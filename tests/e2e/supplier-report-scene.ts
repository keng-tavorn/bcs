import { randomUUID } from 'node:crypto'
import { deriveSeedBackupCodes, deriveSeedTotpSecret } from '@/lib/totp'
import { enableTotpWithSecret, upsertUserWithPassword } from '@/server/auth/provision'
import { prisma } from '@/server/db/client'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { inviteSupplier } from '@/server/services/suppliers/applications'
import { E2E_DB } from '../support/e2e-env'
import { createP2Org } from '../support/p2-org'

// Run by tests/e2e/supplier-report.spec.ts against the e2e database only (S7-16 · G-7): an organization of its own with
// SUPPLIER (phase-2 fixtures, AI off), the golden's calendar (13 and 23 October off), proc_officer able to sign in
// (e-mail proc_officer.<tag>@p2.bcs.local · PROCUREMENT reads the whole organization), three applications approved in
// October as GC-SUP-30's first three (2.1 · 8.8 on behalf · 3.6 business days) and one waiting past its escalation, and a
// supplier whose required document expired. Mode: setup <tag>
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the supplier report scene runs in the e2e database only')
setDefaultOutboxSender(null)
const [mode, tag] = process.argv.slice(2)
if (mode !== 'setup' || !tag || !/^[a-z0-9]+$/.test(tag)) throw new Error('setup <tag>')

const key = () => ({ idempotencyKey: randomUUID(), sender: null })
function taxId(): string {
  const digits = Array.from({ length: 12 }, (_, i) => (i === 0 ? 0 : Math.floor(Math.random() * 10)))
  const sum = digits.reduce((s, d, i) => s + d * (13 - i), 0)
  return digits.join('') + String((11 - (sum % 11)) % 10)
}

const org = await createP2Org({ modules: ['PAY', 'SUPPLIER'] })
const at = new Date()
await prisma.organization.update({ where: { id: org.organizationId }, data: { displayName: `ทดสอบรายงานผู้ขาย ${tag}` } })
await prisma.orgModule.create({ data: { organizationId: org.organizationId, module: 'CORE', enabled: true, enabledAt: at, contractRef: 'TEST-P2', reason: 'องค์กรทดสอบระยะ 2' } })
await prisma.holiday.createMany({ data: ['2026-10-13', '2026-10-23'].map((d) => ({ organizationId: org.organizationId, date: new Date(`${d}T00:00:00Z`), nameTh: 'วันหยุดทดสอบ' })), skipDuplicates: true })
const password = process.env.SEED_DEV_PASSWORD
const totpKey = process.env.SEED_TOTP_KEY
if (!password || !totpKey) throw new Error('SEED_DEV_PASSWORD and SEED_TOTP_KEY are needed')
const local = `proc_officer.${tag}`
const userId = await upsertUserWithPassword({ email: `${local}@p2.bcs.local`, name: 'ผู้ใช้ proc_officer', password })
await enableTotpWithSecret(userId, deriveSeedTotpSecret(totpKey, local), deriveSeedBackupCodes(totpKey, local))
await prisma.member.update({ where: { id: org.member.proc_officer! }, data: { email: `${local}@p2.bcs.local`, userId } })

const names = ['นครปฐมวัสดุก่อสร้าง', 'ศรีสะเกษการโยธา', 'ลพบุรีเซฟตี้ซัพพลาย', 'สุพรรณบุรีขนส่ง']
const plays = [
  { invitedAt: '2026-10-05T02:00:00Z', status: 'APPROVED', decidedAt: '2026-10-07T03:00:00Z' },
  { invitedAt: '2026-10-05T02:00:00Z', status: 'APPROVED', decidedAt: '2026-10-16T09:00:00Z', onBehalf: true },
  { invitedAt: '2026-10-09T03:00:00Z', status: 'APPROVED', decidedAt: '2026-10-15T08:30:00Z' },
  { invitedAt: '2026-10-01T02:00:00Z', status: 'DRAFT', escalatedAt: '2026-10-15T02:00:00Z' },
] as const
for (const [i, p] of plays.entries()) {
  const r = await inviteSupplier(org.ctxOf('proc_officer', new Date(p.invitedAt)), { kind: 'NEW', nameTh: `บริษัท ${names[i]} ${tag} จำกัด`, taxId: taxId(), branchCode: '00000', payeeType: 'JURISTIC', contact: { nameTh: 'ผู้ติดต่อ', email: `g7-${tag}-${i}@supplier.test` } }, key())
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  await prisma.supplierApplication.update({
    where: { id: r.data.applicationId },
    data: {
      status: p.status,
      invitedAt: new Date(p.invitedAt),
      ...('decidedAt' in p ? { decidedAt: new Date(p.decidedAt), number: `SUP-2569-${tag.slice(0, 3)}${i}` } : {}),
      ...('onBehalf' in p ? { filledOnBehalfById: org.member.proc_officer } : {}),
      ...('escalatedAt' in p ? { escalatedAt: new Date(p.escalatedAt) } : {}),
    },
  })
}

// a registered supplier whose required document expired (BR-SDOC-02)
await prisma.supplierDocumentType.create({ data: { organizationId: org.organizationId, code: 'COMPANY_CERT', nameTh: 'หนังสือรับรองบริษัท', nameEn: 'Company certificate', appliesTo: ['JURISTIC'], required: true, validityDays: 180 } })
const supplier = await prisma.supplier.create({ data: { organizationId: org.organizationId, code: `G7-${tag.slice(0, 4).toUpperCase()}`, nameTh: `บริษัท เอกสารหมดอายุ ${tag} จำกัด`, taxId: taxId(), branchCode: '00000', category: 'วัสดุก่อสร้างทั่วไป' } })
const file = await prisma.fileObject.create({ data: { organizationId: org.organizationId, storageKey: `e2e/${randomUUID()}.pdf`, fileName: 'หนังสือรับรอง.pdf', mimeType: 'application/pdf', sizeBytes: 1, status: 'AVAILABLE', scanStatus: 'CLEAN' } })
await prisma.supplierDocument.create({ data: { organizationId: org.organizationId, supplierId: supplier.id, documentTypeCode: 'COMPANY_CERT', fileId: file.id, issuedOn: new Date('2026-01-05'), expiresOn: new Date('2026-07-03'), status: 'EXPIRED', verifiedById: org.member.proc_officer!, verifiedAt: new Date('2026-01-06T03:00:00Z') } })

console.log(JSON.stringify({ tag }))
await prisma.$disconnect()
