import { randomUUID } from 'node:crypto'
import { PORTAL_PRIVACY_NOTICE_VERSION } from '@/lib/portal-limits'
import { deriveSeedBackupCodes, deriveSeedTotpSecret } from '@/lib/totp'
import { enableTotpWithSecret, upsertUserWithPassword } from '@/server/auth/provision'
import { prisma } from '@/server/db/client'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { portalCtx } from '@/server/portal/session'
import { answerRiskAssessment, openRiskAssessment, runRiskReviewDaily, submitRiskAssessment } from '@/server/services/risk'
import { E2E_DB } from '../support/e2e-env'
import { createP2Org } from '../support/p2-org'

// Run by tests/e2e/risk-file.spec.ts against the e2e database only (S11-10 · FR-RSK-204 AC1 · BR-RSK-14): an organization of
// its own with SUPPLIER and RISK on (AI off), its tiers, policy and a published questionnaire, proc_officer able to sign
// in (proc_officer.<tag>@p2.bcs.local), a supplier assessed HIGH eleven months ago — the day's risk-review-daily makes it
// EXPIRING and opens its reassessment — with an override approved for it, and a second supplier never assessed.
// Mode: setup <tag>. Prints one JSON line. The demo organization is never touched.
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the risk file scene runs in the e2e database only')
setDefaultOutboxSender(null)
const [mode, tag] = process.argv.slice(2)
if (mode !== 'setup' || !tag || !/^[a-z0-9]+$/.test(tag)) throw new Error('setup <tag>')

const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}
const NOW = new Date()
const AGO = new Date(NOW.getTime() - 335 * 24 * 60 * 60 * 1000)

const org = await createP2Org({ modules: ['SUPPLIER'] })
const id = org.organizationId
await prisma.organization.update({ where: { id }, data: { displayName: `ทดสอบแฟ้มความเสี่ยง ${tag}` } })
await prisma.orgModule.create({ data: { organizationId: id, module: 'RISK', enabled: true, enabledAt: new Date('2025-01-01T00:00:00+07:00'), contractRef: 'TEST-P2', reason: 'องค์กรทดสอบระยะ 2' } })
for (const t of [
  { code: 'LOW' as const, nameTh: 'ต่ำ', nameEn: 'Low', minPoints: 0, reviewMonths: 36, blocksPo: false, requiresExplicitAnswers: false },
  { code: 'MEDIUM' as const, nameTh: 'กลาง', nameEn: 'Medium', minPoints: 20, reviewMonths: 24, blocksPo: false, requiresExplicitAnswers: false },
  { code: 'HIGH' as const, nameTh: 'สูง', nameEn: 'High', minPoints: 40, reviewMonths: 12, blocksPo: true, requiresExplicitAnswers: true },
]) {
  await prisma.riskTier.create({ data: { organizationId: id, ...t, reminderDaysBefore: 30, updatedById: org.member.admin!, confirmedById: org.member.admin2!, confirmedAt: AGO } })
}
await prisma.riskPolicy.create({
  data: { organizationId: id, screeningTierMap: { processesPersonalData: 'HIGH', accessesSystems: 'MEDIUM', accessesPremises: 'MEDIUM' }, highRiskCategories: ['PROF'], registryFlagBlocks: true, mediumOverdueBlocks: false, overrideChatButton: false, updatedById: org.member.admin!, confirmedById: org.member.admin2!, confirmedAt: AGO },
})
const q = await prisma.riskQuestionnaire.create({ data: { organizationId: id, code: 'RQ-E2E', versionNo: 1, status: 'PUBLISHED', effectiveFrom: new Date('2025-01-01T00:00:00+07:00'), submittedById: org.member.admin!, submittedAt: AGO, publishedById: org.member.admin2!, publishedAt: AGO, checksum: 'e2e' } })
const yn = (no: number) => [
  { code: 'Y', labelTh: 'มี', labelEn: 'Yes', points: 0 },
  { code: 'N', labelTh: 'ไม่มี', labelEn: 'No', points: no },
]
for (const question of [
  { code: 'RQ-GEN-01', domain: 'GENERAL' as const, textTh: 'บริษัทมีนโยบายต่อต้านการทุจริตเป็นลายลักษณ์อักษรหรือไม่', textEn: 'Does the company have a written anti-corruption policy?', options: yn(6), sortOrder: 10 },
  { code: 'RQ-PRV-01', domain: 'PRIVACY' as const, textTh: 'บริษัทแต่งตั้งเจ้าหน้าที่คุ้มครองข้อมูลส่วนบุคคลแล้วหรือไม่', textEn: 'Has the company appointed a data protection officer?', options: yn(12), appliesWhen: { field: 'processesPersonalData', op: 'eq', value: 'Y' }, sortOrder: 20 },
]) {
  await prisma.riskQuestion.create({ data: { organizationId: id, questionnaireId: q.id, ...question } })
}

const password = process.env.SEED_DEV_PASSWORD
const totpKey = process.env.SEED_TOTP_KEY
if (!password || !totpKey) throw new Error('SEED_DEV_PASSWORD and SEED_TOTP_KEY are needed')
const local = `proc_officer.${tag}`
const userId = await upsertUserWithPassword({ email: `${local}@p2.bcs.local`, name: 'ผู้ใช้ proc_officer', password })
await enableTotpWithSecret(userId, deriveSeedTotpSecret(totpKey, local), deriveSeedBackupCodes(totpKey, local))
await prisma.member.update({ where: { id: org.member.proc_officer! }, data: { email: `${local}@p2.bcs.local`, userId } })

// the supplier assessed HIGH eleven months ago, answered by its contact on the portal
const assessed = await prisma.supplier.create({ data: { organizationId: id, code: `RF-${tag.slice(0, 4).toUpperCase()}`, nameTh: `บริษัท รักษาความปลอดภัยทดสอบ ${tag} จำกัด`, isForeign: true, portalEnabled: true, email: `rf.${tag}@supplier.test` } })
const contact = await prisma.supplierContact.create({ data: { organizationId: id, supplierId: assessed.id, nameTh: 'คุณผู้ติดต่อ', email: `rf-c.${tag}@supplier.test`, isPrimary: true, privacyNoticeVersion: PORTAL_PRIVACY_NOTICE_VERSION } })
const opened = ok(await openRiskAssessment(org.ctxOf('proc_officer', AGO), { supplierId: assessed.id, screening: { processesPersonalData: 'Y', accessesSystems: 'N', accessesPremises: 'N' }, categoryCodes: ['SEC'] }, key()))
const version = async () => (await prisma.riskAssessment.findUniqueOrThrow({ where: { id: opened.assessmentId } })).version
ok(await answerRiskAssessment(portalCtx(id, contact, AGO), { assessmentId: opened.assessmentId, expectedVersion: await version(), answers: [{ questionCode: 'RQ-GEN-01', optionCode: 'Y' }, { questionCode: 'RQ-PRV-01', optionCode: 'N' }] }, key()))
ok(await submitRiskAssessment(portalCtx(id, contact, AGO), { assessmentId: opened.assessmentId, expectedVersion: await version() }, key()))
await prisma.riskOverride.create({
  data: { organizationId: id, number: `RO-E2E-${tag.slice(0, 5)}`, supplierId: assessed.id, reason: 'งานด่วนก่อนประเมินเสร็จ', capGrossSatang: 12_000_000n, expiresOn: new Date(NOW.getTime() + 5 * 24 * 60 * 60 * 1000), requestedById: org.member.proc_officer!, submittedAt: AGO, decidedAt: AGO, status: 'APPROVED' },
})
await runRiskReviewDaily(id, NOW, { sender: null })

// a supplier never assessed: its file offers "เปิดแบบประเมิน"
const fresh = await prisma.supplier.create({ data: { organizationId: id, code: `RN-${tag.slice(0, 4).toUpperCase()}`, nameTh: `บริษัท ที่ปรึกษาทดสอบ ${tag} จำกัด`, isForeign: true, portalEnabled: true, email: `rn.${tag}@supplier.test` } })

console.log(JSON.stringify({ tag, assessedId: assessed.id, assessedCode: assessed.code, freshId: fresh.id, freshCode: fresh.code }))
await prisma.$disconnect()
