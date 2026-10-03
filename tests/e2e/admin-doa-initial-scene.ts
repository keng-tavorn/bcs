import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { toJsonSafe } from '@/lib/json'
import { OrgSettingsSchema } from '@/lib/org-settings'
import { deriveSeedTotpSecret } from '@/lib/totp'
import { enableTotpWithSecret, upsertUserWithPassword } from '@/server/auth/provision'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { loadOrgSettingsYaml } from '@/server/seed/demo-org'
import { importDoaDraft } from '@/server/services/doa'
import { E2E_DB } from '../support/e2e-env'

// Run by tests/e2e/admin-doa-initial.spec.ts against the e2e database only (S2-13, FR-DOA-002 AC3): an organization
// that has no DOA yet, so its first version goes as the initial package to the contract signatory (BR-DOA-19). The
// seeded demo organization has a DOA in effect, so this scene builds a second one per run and project, with codes no
// other spec uses: it sorts after DEMO in the platform list, and its member codes are not the demo's. The version is
// imported through the service, as the admin would; the admin signs in with SEED_DEV_PASSWORD and the TOTP derived
// from SEED_TOTP_KEY and the printed code. Prints the admin's sign-in, the draft and the signatory as JSON.
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the initial package scene runs in the e2e database only')
const password = process.env.SEED_DEV_PASSWORD
const totpKey = process.env.SEED_TOTP_KEY
if (!password || !totpKey) throw new Error('SEED_DEV_PASSWORD and SEED_TOTP_KEY are needed')

const project = process.argv[2] === 'mobile' ? 'm' : 'd'
const run = randomUUID().slice(0, 6)
const prefix = `pkg${project}${run}`
const now = new Date()

const settings = OrgSettingsSchema.parse(parseYaml(loadOrgSettingsYaml()))
const org = await prisma.organization.create({
  data: { code: `ZE2E-PKG-${project.toUpperCase()}-${run.toUpperCase()}`, legalNameTh: 'บริษัท ทดสอบชุดตั้งต้น จำกัด', displayName: 'ทดสอบชุดตั้งต้น', taxId: '0999999000055', timezone: 'Asia/Bangkok', settings: toJsonSafe(settings) as object },
})
const organizationId = org.id
await prisma.orgModule.create({ data: { organizationId, module: 'CORE', enabled: true, enabledAt: now, contractRef: 'E2E', reason: 'ระบบหลักขององค์กรทดสอบ' } })

const department: Record<string, string> = {}
for (const [code, nameTh, parent] of [
  ['HQ', 'สำนักงานใหญ่', null],
  ['OPS', 'สายปฏิบัติการ', 'HQ'],
  ['CON', 'ฝ่ายก่อสร้าง', 'OPS'],
  ['SUP', 'สายสนับสนุน', 'HQ'],
  ['IT', 'ฝ่ายไอที', 'SUP'],
] as const) {
  department[code] = (await prisma.department.create({ data: { organizationId, code, nameTh, parentId: parent ? department[parent]! : null, kind: parent ? 'DEPARTMENT' : 'COMPANY' } })).id
}

const member: Record<string, string> = {}
for (const [code, nameTh, home] of [
  ['admin', 'อรุณ ดูแลระบบ', 'IT'],
  ['ceo', 'ประเสริฐ ผู้ลงนาม', 'HQ'],
  ['coo', 'สมใจ ปฏิบัติการ', 'HQ'],
  ['vp_ops', 'วิชัย สายปฏิบัติ', 'OPS'],
  ['vp_sup', 'วรรณา สายสนับสนุน', 'SUP'],
  ['dm_con', 'ดนัย ก่อสร้าง', 'CON'],
  ['dm_it', 'ไอยรา ระบบงาน', 'IT'],
  ['req_con', 'รัตนา หน้างาน', 'CON'],
] as const) {
  member[code] = (await prisma.member.create({ data: { organizationId, displayNameTh: nameTh, email: `${prefix}-${code}@e2e.bcs.local`, employeeCode: `${prefix}_${code}`, status: 'ACTIVE', primaryDepartmentId: department[home]! } })).id
}

// The organization admin signs in with a password and an authenticator (FR-AUTH-002 AC1: a role)
const adminCode = `${prefix}_admin`
const adminEmail = `${prefix}-admin@e2e.bcs.local`
const userId = await upsertUserWithPassword({ email: adminEmail, name: 'อรุณ ดูแลระบบ', password })
await enableTotpWithSecret(userId, deriveSeedTotpSecret(totpKey, adminCode), [])
await prisma.member.update({ where: { id: member.admin! }, data: { userId } })
await prisma.roleAssignment.create({ data: { organizationId, memberId: member.admin!, role: 'ORG_ADMIN', grantedAt: now } })

// The positions the first version names, and who holds them today; the BCS team verified the contract signatory
const position: Record<string, string> = {}
for (const [code, nameTh, scope] of [
  ['CEO', 'ประธานเจ้าหน้าที่บริหาร', 'ORG'],
  ['COO', 'ประธานเจ้าหน้าที่ฝ่ายปฏิบัติการ', 'ORG'],
  ['VP', 'รองประธานสายงาน', 'DEPARTMENT'],
  ['DM', 'ผู้จัดการฝ่าย', 'DEPARTMENT'],
] as const) {
  position[code] = (await prisma.position.create({ data: { organizationId, code, nameTh, scope } })).id
}
for (const [code, dept, who] of [
  ['CEO', 'HQ', 'ceo'],
  ['COO', 'HQ', 'coo'],
  ['VP', 'OPS', 'vp_ops'],
  ['VP', 'SUP', 'vp_sup'],
  ['DM', 'CON', 'dm_con'],
  ['DM', 'IT', 'dm_it'],
] as const) {
  await prisma.positionAssignment.create({ data: { organizationId, positionId: position[code]!, departmentId: department[dept]!, memberId: member[who]!, validFrom: new Date('2026-01-01T00:00:00+07:00') } })
}
await prisma.organization.update({ where: { id: organizationId }, data: { contractSignatoryMemberId: member.ceo!, contractSignatoryVerifiedAt: now } })

// Version 1 of the §7.4 fixture, starting on 1 January 2027, imported by the admin as a draft
const fixture = readFileSync(path.resolve(import.meta.dirname, '../golden/fixtures/doa-versions.yaml'), 'utf8')
const version1 = fixture.slice(0, fixture.indexOf('  - code: DOA-DEMO\n    version: 2')).replace('"2026-10-01T00:00:00+07:00"', '"2027-01-01T00:00:00+07:00"')
const ctx = makeCtx({ organizationId, actor: { type: 'USER', memberId: member.admin! }, channel: 'WEB', now })
const imported = await importDoaDraft(ctx, { yaml: version1, changeReason: 'DOA ฉบับแรกขององค์กรตามสัญญา' }, { idempotencyKey: randomUUID(), sender: null })
if (!imported.ok) throw new Error(`import failed: ${JSON.stringify(imported.error)}`)

console.log(JSON.stringify({ email: adminEmail, code: adminCode, versionId: imported.data.versionIds[0], signatory: 'ประเสริฐ ผู้ลงนาม' }))
await prisma.$disconnect()
