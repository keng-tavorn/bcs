// pnpm db:seed (spec §5.4, Appendix A): the VAT rates of §7.1 (prisma/seed/tax-rates.yaml), then the demo organization,
// its users, departments, positions, DOA version 1, request types with their forms (prisma/seed/forms.yaml), holidays
// the budget, suppliers and delivery sites from docs/inputs/BCS_inputs_v1_demo.xlsx (run pnpm inputs:check first), and
// the requests of the past of sheet Demo_History through the real services (D-01; SEED_DEMO_HISTORY=0 leaves them out,
// as the e2e database of the screens does). Safe to run again: nothing is duplicated.
// Demo users with passwords exist only in local and staging (Appendix A); production is refused.
import { systemClock } from '@/lib/clock'
import { PASSWORD_MIN_LENGTH } from '@/lib/constants'
import { getEnv } from '@/lib/env'
import { prisma } from '@/server/db/client'
import { loadOrgSettingsYaml, parseDemoOrgInput, seedDemoOrganization } from '@/server/seed/demo-org'
import { parseOrgStructureInput, seedOrgStructure } from '@/server/seed/org-structure'
import { seedBudget } from '@/server/seed/budget'
import { parseBudget, parseDemoHistory, parseSites, parseSuppliers } from '@/server/seed/sheets'
import { seedSuppliers } from '@/server/seed/suppliers'
import { seedTaxRates } from '@/server/seed/tax-rates'
import { DemoHistoryIncompleteError, DemoHistoryOutOfYearError, DemoHistoryStorageError, seedDemoHistory } from '@/server/services/demo-history'
import { ensureBucket } from '../scripts/storage-init'
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
  // On this machine the seed makes the local bucket itself (scripts/storage-init.ts); elsewhere the bucket is set up by people (P0-06)
  if (process.env.SEED_DEMO_HISTORY !== '0' && env.APP_ENV === 'local') await ensureBucket()
  const history = process.env.SEED_DEMO_HISTORY === '0' ? null : await seedDemoHistory(report.organizationId, parseDemoHistory(workbook), systemClock.now())
  console.log(
    `db:seed เสร็จ: อัตรา VAT ใหม่ ${taxRates} ช่วง · องค์กร ${input.org.code} (${report.organizationCreated ? 'สร้างใหม่' : 'มีอยู่แล้ว'}) · ` +
      `สมาชิกใหม่ ${report.members.created} มีอยู่แล้ว ${report.members.existing} · บทบาทใหม่ ${report.rolesGranted} · ` +
      (totpKey ? `ตั้ง 2FA ใหม่ ${report.twoFactorEnabled}` : 'ไม่มี SEED_TOTP_KEY: ผู้ใช้ที่ต้องใช้ 2FA จะตั้งแอปยืนยันตัวตนตอนเข้าระบบครั้งแรก') +
      ` · แผนกใหม่ ${structure.departments} · ตำแหน่งใหม่ ${structure.positions} · ผู้ดำรงตำแหน่งใหม่ ${structure.assignments}` +
      ` · DOA ใหม่ ${structure.doaVersions} ฉบับ · ประเภทคำขอใหม่ ${structure.requestTypes} · ฟอร์มใหม่ ${structure.forms} · วันหยุดใหม่ ${structure.holidays}` +
      ` · ปีงบใหม่ ${budget.fiscalYears} · cost center ใหม่ ${budget.costCenters} · บรรทัดงบใหม่ ${budget.lines}` +
      ` · ผู้ขายใหม่ ${suppliers.suppliers} · สถานที่ส่งใหม่ ${suppliers.sites}` +
      (history === null ? ' · ไม่สร้างประวัติ demo (SEED_DEMO_HISTORY=0)' : history.seeded ? ` · ประวัติ demo ${Object.entries(history.byStatus).map(([s, n]) => `${s} ${n}`).join(' ')}` : ' · ประวัติ demo มีอยู่แล้ว'),
  )
} catch (error) {
  if (error instanceof DemoHistoryOutOfYearError) {
    stop(
      `ข้อมูลตัวอย่างใช้ปีงบ ${error.fiscalYear} (${error.startsOn} ถึง ${error.endsOn}) แต่ประวัติ demo แถว ${error.ref} ต้องใช้วันที่ ${error.day} ซึ่งอยู่นอกปีงบนั้น จึงไม่ได้สร้างประวัติ demo · ` +
        `แก้ชีต Budget Holidays และ Demo_History ในไฟล์ inputs ให้เป็นปีปัจจุบัน (ช่วงต้นปีงบให้ daysAgo ของทุกแถวไม่ย้อนไปก่อนวันเริ่มปีงบ) แล้วรัน pnpm inputs:check และ pnpm db:reset · หรือ seed โดยไม่มีประวัติด้วย SEED_DEMO_HISTORY=0`,
    )
  }
  if (error instanceof DemoHistoryStorageError) {
    stop(
      `ที่เก็บไฟล์ (bucket ${process.env.S3_BUCKET ?? ''}) ยังไม่ตอบ ประวัติ demo ต้องเก็บใบเสนอราคาและ PDF ของ PO จึงยังไม่ได้สร้าง · ` +
        `บนเครื่องเปิด Docker Desktop แล้วรัน docker compose up -d และ seed ใหม่ · บน staging ตั้งที่เก็บไฟล์ตามคู่มือ docs/runbooks/p0-06-storage-staging.md ก่อน`,
    )
  }
  if (error instanceof DemoHistoryIncompleteError) {
    stop(`ประวัติ demo จาก seed รอบก่อนสร้างไม่ครบ (แถวสุดท้าย ${error.lastRef} ยังไม่เสร็จ) ตัวเลขบนกระดานและ dashboard จะไม่ตรงกับฉาก demo · บนเครื่องรัน pnpm db:reset เพื่อล้างแล้วสร้างใหม่ทั้งหมด`)
  }
  stop(error instanceof Error ? error.message : String(error))
} finally {
  await prisma.$disconnect()
}
