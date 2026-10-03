// pnpm db:seed (spec §5.4, Appendix A): the VAT rates of §7.1 (prisma/seed/tax-rates.yaml), then the demo organization,
// its users, departments, positions, DOA version 1, request types with their forms (prisma/seed/forms.yaml), holidays
// the budget, suppliers and delivery sites from docs/inputs/BCS_inputs_v1_demo.xlsx (run pnpm inputs:check first). Safe to
// run again: nothing is duplicated.
// Demo users with passwords exist only in local and staging (Appendix A); production is refused.
import { systemClock } from '@/lib/clock'
import { PASSWORD_MIN_LENGTH } from '@/lib/constants'
import { getEnv } from '@/lib/env'
import { prisma } from '@/server/db/client'
import { loadOrgSettingsYaml, parseDemoOrgInput, seedDemoOrganization } from '@/server/seed/demo-org'
import { parseOrgStructureInput, seedOrgStructure } from '@/server/seed/org-structure'
import { seedBudget } from '@/server/seed/budget'
import { parseBudget, parseSites, parseSuppliers } from '@/server/seed/sheets'
import { seedSuppliers } from '@/server/seed/suppliers'
import { seedTaxRates } from '@/server/seed/tax-rates'
import { loadInputWorkbook } from '@/server/seed/workbook'

const SEED_ENVS = new Set(['local', 'staging'])

function stop(message: string): never {
  console.error(`db:seed หยุด: ${message}`)
  process.exit(1)
}

const env = getEnv()
if (!SEED_ENVS.has(env.APP_ENV)) stop(`ข้อมูลตัวอย่างสร้างได้เฉพาะ APP_ENV=local หรือ staging (ตอนนี้ ${env.APP_ENV})`)
const password = env.SEED_DEV_PASSWORD
if (!password || password.length < PASSWORD_MIN_LENGTH) stop(`ใส่ SEED_DEV_PASSWORD ใน .env ยาวอย่างน้อย ${PASSWORD_MIN_LENGTH} ตัวอักษร`)
// Optional: without it, members who need 2FA set up their authenticator at first sign-in (FR-AUTH-002 AC1)
const totpKey = env.SEED_TOTP_KEY

try {
  const taxRates = await seedTaxRates()
  const workbook = await loadInputWorkbook()
  const input = parseDemoOrgInput(workbook, loadOrgSettingsYaml())
  const report = await seedDemoOrganization(input, { password, ...(totpKey ? { totpKey } : {}), now: systemClock.now() })
  const structure = await seedOrgStructure(report.organizationId, input.users, parseOrgStructureInput(workbook), systemClock.now())
  const budget = await seedBudget(report.organizationId, parseBudget(workbook), systemClock.now())
  const suppliers = await seedSuppliers(report.organizationId, { suppliers: parseSuppliers(workbook), sites: parseSites(workbook) }, systemClock.now())
  console.log(
    `db:seed เสร็จ: อัตรา VAT ใหม่ ${taxRates} ช่วง · องค์กร ${input.org.code} (${report.organizationCreated ? 'สร้างใหม่' : 'มีอยู่แล้ว'}) · ` +
      `สมาชิกใหม่ ${report.members.created} มีอยู่แล้ว ${report.members.existing} · บทบาทใหม่ ${report.rolesGranted} · ` +
      (totpKey ? `ตั้ง 2FA ใหม่ ${report.twoFactorEnabled}` : 'ไม่มี SEED_TOTP_KEY: ผู้ใช้ที่ต้องใช้ 2FA จะตั้งแอปยืนยันตัวตนตอนเข้าระบบครั้งแรก') +
      ` · แผนกใหม่ ${structure.departments} · ตำแหน่งใหม่ ${structure.positions} · ผู้ดำรงตำแหน่งใหม่ ${structure.assignments}` +
      ` · DOA ใหม่ ${structure.doaVersions} ฉบับ · ประเภทคำขอใหม่ ${structure.requestTypes} · ฟอร์มใหม่ ${structure.forms} · วันหยุดใหม่ ${structure.holidays}` +
      ` · ปีงบใหม่ ${budget.fiscalYears} · cost center ใหม่ ${budget.costCenters} · บรรทัดงบใหม่ ${budget.lines}` +
      ` · ผู้ขายใหม่ ${suppliers.suppliers} · สถานที่ส่งใหม่ ${suppliers.sites}`,
  )
} catch (error) {
  stop(error instanceof Error ? error.message : String(error))
} finally {
  await prisma.$disconnect()
}
