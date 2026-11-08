import { randomUUID } from 'node:crypto'
import { prisma } from '@/server/db/client'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { openRiskAssessment } from '@/server/services/risk'
import { PORTAL_PRIVACY_NOTICE_VERSION } from '@/lib/portal-limits'
import { createP2Org } from '../support/p2-org'
import { E2E_DB } from '../support/e2e-env'

// Run by tests/e2e/risk-portal.spec.ts against the e2e database only (S11-05 · FR-RSK-201 AC5 · BR-RSK-17):
//   open <tag>        an organization of its own with SUPPLIER and RISK on (AI off), its tiers, policy and a published
//                     questionnaire of three questions, a supplier on the portal with its primary contact, and an
//                     assessment PROCUREMENT opened; prints the org code, the assessment and the link the e-mail carries
//   otp <contactId>   the six-digit code of the contact's latest sign-in e-mail (read from its notice, as Mailpit would)
// Prints one JSON line. The demo organization is never touched.
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the risk portal scene runs in the e2e database only')
const [mode, arg] = process.argv.slice(2)
setDefaultOutboxSender(null)
const NOW = new Date()

async function open(tag: string) {
  const org = await createP2Org({ modules: ['SUPPLIER'] })
  const id = org.organizationId
  const code = `ZE2E-RISK-${tag.toUpperCase()}`
  await prisma.organization.update({ where: { id }, data: { code } })
  await prisma.orgModule.create({ data: { organizationId: id, module: 'RISK', enabled: true, enabledAt: new Date('2026-01-01T00:00:00+07:00'), contractRef: 'TEST-P2', reason: 'องค์กรทดสอบระยะ 2' } })
  for (const t of [
    { code: 'LOW' as const, nameTh: 'ต่ำ', nameEn: 'Low', minPoints: 0, reviewMonths: 36, blocksPo: false, requiresExplicitAnswers: false },
    { code: 'MEDIUM' as const, nameTh: 'กลาง', nameEn: 'Medium', minPoints: 20, reviewMonths: 24, blocksPo: false, requiresExplicitAnswers: false },
    { code: 'HIGH' as const, nameTh: 'สูง', nameEn: 'High', minPoints: 40, reviewMonths: 12, blocksPo: true, requiresExplicitAnswers: true },
  ]) {
    await prisma.riskTier.create({ data: { organizationId: id, ...t, reminderDaysBefore: 30, updatedById: org.member.admin!, confirmedById: org.member.admin2!, confirmedAt: NOW } })
  }
  await prisma.riskPolicy.create({
    data: { organizationId: id, screeningTierMap: { processesPersonalData: 'HIGH', accessesSystems: 'MEDIUM', accessesPremises: 'MEDIUM' }, highRiskCategories: ['PROF'], registryFlagBlocks: true, mediumOverdueBlocks: false, overrideChatButton: false, updatedById: org.member.admin!, confirmedById: org.member.admin2!, confirmedAt: NOW },
  })
  const q = await prisma.riskQuestionnaire.create({ data: { organizationId: id, code: 'RQ-E2E', versionNo: 1, status: 'PUBLISHED', effectiveFrom: new Date('2026-01-01T00:00:00+07:00'), submittedById: org.member.admin!, submittedAt: NOW, publishedById: org.member.admin2!, publishedAt: NOW, checksum: 'e2e' } })
  const yn = (no: number) => [
    { code: 'Y', labelTh: 'มี', labelEn: 'Yes', points: 0 },
    { code: 'N', labelTh: 'ไม่มี', labelEn: 'No', points: no },
  ]
  const questions = [
    { code: 'RQ-GEN-01', domain: 'GENERAL' as const, textTh: 'บริษัทมีนโยบายต่อต้านการทุจริตเป็นลายลักษณ์อักษรหรือไม่', textEn: 'Does the company have a written anti-corruption policy?', options: yn(6), sortOrder: 10 },
    { code: 'RQ-IS-01', domain: 'INFOSEC' as const, textTh: 'บริษัทมีมาตรการควบคุมการเข้าถึงระบบของลูกค้าหรือไม่', textEn: 'Does the company control access to customer systems?', options: yn(12), appliesWhen: { field: 'accessesSystems', op: 'eq', value: 'Y' }, sortOrder: 20 },
    { code: 'RQ-PRV-01', domain: 'PRIVACY' as const, textTh: 'บริษัทแต่งตั้งเจ้าหน้าที่คุ้มครองข้อมูลส่วนบุคคลแล้วหรือไม่', textEn: 'Has the company appointed a data protection officer?', options: yn(12), appliesWhen: { field: 'processesPersonalData', op: 'eq', value: 'Y' }, sortOrder: 30 },
  ]
  for (const question of questions) await prisma.riskQuestion.create({ data: { organizationId: id, questionnaireId: q.id, ...question } })
  const supplier = await prisma.supplier.create({ data: { organizationId: id, code: `RSK-${tag.toUpperCase()}`, nameTh: 'บริษัท ซอฟต์แวร์ทดสอบ จำกัด', isForeign: true, portalEnabled: true, email: `register.${tag}@supplier.test` } })
  const contact = await prisma.supplierContact.create({ data: { organizationId: id, supplierId: supplier.id, nameTh: 'คุณผู้ติดต่อ', email: `risk.${tag}@supplier.test`, isPrimary: true, privacyNoticeVersion: PORTAL_PRIVACY_NOTICE_VERSION } })
  const opened = await openRiskAssessment(org.ctxOf('proc_officer', NOW), { supplierId: supplier.id, screening: { processesPersonalData: 'Y', accessesSystems: 'Y', accessesPremises: 'N' } }, { idempotencyKey: randomUUID(), sender: null })
  if (!opened.ok) throw new Error(JSON.stringify(opened.error))
  const notice = await prisma.supplierNotice.findFirstOrThrow({ where: { organizationId: id, subjectId: opened.data.assessmentId, templateKey: 'supplier.risk_questionnaire' } })
  const url = (notice.data as { url?: string }).url
  if (!url) throw new Error('the questionnaire e-mail has no link')
  return { orgCode: code, assessmentId: opened.data.assessmentId, contactId: contact.id, path: new URL(url).pathname }
}

async function otp(contactId: string) {
  const notice = await prisma.supplierNotice.findFirstOrThrow({ where: { contactId, templateKey: 'supplier.otp' }, orderBy: { createdAt: 'desc' } })
  const code = (notice.data as { code?: string }).code
  if (!code) throw new Error('the code was sent and dropped already')
  return { code }
}

const out = mode === 'open' && arg ? await open(arg) : mode === 'otp' && arg ? await otp(arg) : null
if (!out) throw new Error('usage: risk-portal-scene.ts open <tag> | otp <contactId>')
console.log(JSON.stringify(out))
await prisma.$disconnect()
