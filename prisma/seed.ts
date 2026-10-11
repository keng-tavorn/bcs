// pnpm db:seed (spec §5.4, Appendix A): the VAT rates of §7.1 (prisma/seed/tax-rates.yaml), then the demo organization,
// its users, departments, positions, DOA version 1, request types with their forms (prisma/seed/forms.yaml), holidays
// the budget, suppliers and delivery sites from docs/inputs/BCS_inputs_v1_demo.xlsx (run pnpm inputs:check first), and
// the requests of the past of sheet Demo_History through the real services (D-01; SEED_DEMO_HISTORY=0 leaves them out,
// as the e2e database of the screens does). Safe to run again: nothing is duplicated.
// Demo users with passwords exist only in local and staging (Appendix A); production is refused. The demo approvers get
// the transaction PIN SEED_DEV_PIN when it is set (FR-AUTH-005, ADR-047 item 9); without it nobody gets a PIN, and the
// history steps up with a one-time PIN it takes back.
// SEED_INPUTS=p1 (P1-02, `pnpm db:reset:p1`) reads the synthetic workbook of phase 1 instead, docs/inputs/BCS_inputs_p1.xlsx:
// organization SIMEC, its budget of two fiscal years and the 240 requests of sheet Request_History. Unset, the demo workbook.
import { systemClock } from '@/lib/clock'
import { PASSWORD_MIN_LENGTH } from '@/lib/constants'
import { getEnv } from '@/lib/env'
import { prisma } from '@/server/db/client'
import type { SeedPinsReport } from '@/server/seed/pins'
import { INPUT_WORKBOOKS, inputProfileOf, type InputProfile } from '@/server/seed/workbook'
import { DemoHistoryIncompleteError, DemoHistoryNetError, DemoHistoryNoBudgetLineError, DemoHistoryOutOfYearError, DemoHistoryPinError, DemoHistoryStorageError } from '@/server/services/demo-history'
import { seedDemoBase, seedDemoHistoryFromInputs } from '@/server/services/demo-seed'
import { describeLineSeed } from '@/server/services/line-channel'
import { ensureBucket } from '../scripts/storage-init'

const SEED_ENVS = new Set(['local', 'staging'])

function stop(message: string): never {
  console.error(`db:seed หยุด: ${message}`)
  process.exit(1)
}

/**
 * The PIN line of the report: who holds SEED_DEV_PIN, by count, and by employee code who does not (they kept another PIN,
 * or it is locked); without SEED_DEV_PIN, that the approvers set their own. Never the PIN.
 */
function pinReport(pins: SeedPinsReport | null, pinless: readonly string[], historyMade: boolean): string {
  if (!pins) {
    return (
      'ไม่มี SEED_DEV_PIN: seed ไม่ได้ให้ PIN ใคร ผู้อนุมัติตั้ง PIN ของตัวเองที่หน้า /settings/pin ก่อนอนุมัติยอดสูงหรือการเปลี่ยนนโยบาย' +
      (historyMade ? ' · ประวัติ demo ยืนยันด้วย PIN ใช้ครั้งเดียวที่ seed ลบออกแล้ว' : '')
    )
  }
  const counts = `ตั้ง PIN ใหม่ ${pins.set} คน · มีอยู่แล้ว ${pins.kept} คน · `
  if (pinless.length === 0) return `${counts}ผู้อนุมัติตัวอย่างทุกคนใช้ PIN จาก SEED_DEV_PIN อนุมัติยอดสูงและการเปลี่ยนนโยบายได้ทันที`
  return (
    `${counts}ผู้อนุมัติ ${pinless.join(', ')} ไม่ได้ใช้ PIN จาก SEED_DEV_PIN (มี PIN อื่นอยู่แล้วหรือ PIN ถูกล็อก) ให้ใช้ PIN ของตัวเอง หรือตั้งใหม่ที่หน้า /settings/pin · ` +
    'ผู้อนุมัติคนอื่นใช้ PIN จาก SEED_DEV_PIN ได้ทันที'
  )
}

const env = getEnv()
if (!SEED_ENVS.has(env.APP_ENV)) stop(`ข้อมูลตัวอย่างสร้างได้เฉพาะ APP_ENV=local หรือ staging (ตอนนี้ ${env.APP_ENV})`)
const password = env.SEED_DEV_PASSWORD
if (!password || password.length < PASSWORD_MIN_LENGTH) stop(`ใส่ SEED_DEV_PASSWORD ใน .env ยาวอย่างน้อย ${PASSWORD_MIN_LENGTH} ตัวอักษร`)
// Optional: without it, members who need 2FA set up their authenticator at first sign-in (FR-AUTH-002 AC1)
const totpKey = env.SEED_TOTP_KEY
let profile: InputProfile = 'demo'
try {
  profile = inputProfileOf(process.env.SEED_INPUTS)
} catch {
  stop(`SEED_INPUTS ต้องว่างหรือเป็นค่าใดค่าหนึ่งของ ${Object.keys(INPUT_WORKBOOKS).join(' ')} (ตอนนี้ ${process.env.SEED_INPUTS})`)
}
const startedAt = performance.now()
/** Seconds since the seed started, one decimal (P1-02 measures the seed for db:reset on this machine) */
const seconds = () => ((performance.now() - startedAt) / 1000).toFixed(1)

try {
  console.log(`db:seed อ่าน ${INPUT_WORKBOOKS[profile]}`)
  const { orgCode, taxRates, report, structure, budget, suppliers, lineChannel, pins, pinless, organizationId } = await seedDemoBase(env, password, systemClock, profile)
  const baseSeconds = seconds()
  // On this machine the seed makes the local bucket itself (scripts/storage-init.ts); elsewhere the bucket is set up by people (P0-06)
  if (process.env.SEED_DEMO_HISTORY !== '0' && env.APP_ENV === 'local') await ensureBucket()
  const history = process.env.SEED_DEMO_HISTORY === '0' ? null : await seedDemoHistoryFromInputs(organizationId, env, systemClock, profile)
  console.log(
    `db:seed เสร็จใน ${seconds()} วินาที (ข้อมูลตั้งต้น ${baseSeconds} วินาที): อัตรา VAT ใหม่ ${taxRates} ช่วง · องค์กร ${orgCode} (${report.organizationCreated ? 'สร้างใหม่' : 'มีอยู่แล้ว'}) · ` +
      `สมาชิกใหม่ ${report.members.created} มีอยู่แล้ว ${report.members.existing} · บทบาทใหม่ ${report.rolesGranted} · ` +
      (totpKey ? `ตั้ง 2FA ใหม่ ${report.twoFactorEnabled}` : 'ไม่มี SEED_TOTP_KEY: ผู้ใช้ที่ต้องใช้ 2FA จะตั้งแอปยืนยันตัวตนตอนเข้าระบบครั้งแรก') +
      ` · แผนกใหม่ ${structure.departments} · ตำแหน่งใหม่ ${structure.positions} · ผู้ดำรงตำแหน่งใหม่ ${structure.assignments}` +
      ` · DOA ใหม่ ${structure.doaVersions} ฉบับ · ประเภทคำขอใหม่ ${structure.requestTypes} · ฟอร์มใหม่ ${structure.forms} · วันหยุดใหม่ ${structure.holidays}` +
      ` · ปีงบใหม่ ${budget.fiscalYears} · cost center ใหม่ ${budget.costCenters} · บรรทัดงบใหม่ ${budget.lines}` +
      ` · ผู้ขายใหม่ ${suppliers.suppliers} · สถานที่ส่งใหม่ ${suppliers.sites}` +
      (history === null ? ' · ไม่สร้างประวัติ demo (SEED_DEMO_HISTORY=0)' : history.seeded ? ` · ประวัติ demo ${Object.entries(history.byStatus).map(([s, n]) => `${s} ${n}`).join(' ')}` : ' · ประวัติ demo มีอยู่แล้ว'),
  )
  console.log(`db:seed LINE: ${describeLineSeed(lineChannel)}`)
  console.log(`db:seed PIN: ${pinReport(pins, pinless, history?.seeded === true)}`)
} catch (error) {
  if (error instanceof DemoHistoryOutOfYearError) {
    stop(
      `ข้อมูลตัวอย่างใช้ปีงบ ${error.fiscalYear} (${error.startsOn} ถึง ${error.endsOn}) แต่ประวัติ demo แถว ${error.ref} ต้องใช้วันที่ ${error.day} ซึ่งอยู่นอกปีงบนั้น จึงไม่ได้สร้างประวัติ demo · ` +
        `แก้ชีต Budget Holidays และ Demo_History ในไฟล์ inputs ให้เป็นปีปัจจุบัน (ช่วงต้นปีงบให้ daysAgo ของทุกแถวไม่ย้อนไปก่อนวันเริ่มปีงบ) แล้วรัน pnpm inputs:check และ pnpm db:reset · หรือ seed โดยไม่มีประวัติด้วย SEED_DEMO_HISTORY=0`,
    )
  }
  if (error instanceof DemoHistoryNoBudgetLineError) {
    stop(
      `ประวัติแถว ${error.ref} ส่งคำขอวันที่ ${error.day} แต่ชีต Budget ไม่มีบรรทัดงบของกุญแจ ${error.budgetKey} ในปีงบของวันนั้น จึงยังไม่ได้สร้างประวัติ · ` +
        `ไฟล์ระยะ 1 มีงบสองปีงบ และประวัติย้อนหลัง 150 วัน วันที่รัน seed ต้องให้ทุกแถวอยู่ในปีงบที่มีในชีต Budget · แก้ scripts/inputs_p1/ แล้วสร้างไฟล์ใหม่ หรือ seed โดยไม่มีประวัติด้วย SEED_DEMO_HISTORY=0`,
    )
  }
  if (error instanceof DemoHistoryNetError) {
    stop(
      `ประวัติ demo แถว ${error.ref} มียอดก่อน VAT ${error.net} บาทที่มีสตางค์ ใบเสนอราคาเปรียบเทียบ ${error.percent}% ของยอดนี้จึงไม่ลงตัวที่สตางค์ และระบบไม่ปัดเศษ (BR-MONEY-02) จึงยังไม่ได้สร้างประวัติ demo · ` +
        `แก้ช่อง net ของแถวนี้ในชีต Demo_History ให้เป็นบาทเต็ม แล้วรัน pnpm inputs:check และ pnpm db:reset`,
    )
  }
  if (error instanceof DemoHistoryStorageError) {
    stop(
      `ที่เก็บไฟล์ (bucket ${process.env.S3_BUCKET ?? ''}) ยังไม่ตอบ ประวัติ demo ต้องเก็บใบเสนอราคาและ PDF ของ PO จึงยังไม่ได้สร้าง · ` +
        `บนเครื่องเปิด Docker Desktop แล้วรัน docker compose up -d และ seed ใหม่ · บน staging ตั้งที่เก็บไฟล์ตามคู่มือ docs/runbooks/p0-06-storage-staging.md ก่อน`,
    )
  }
  if (error instanceof DemoHistoryPinError) {
    stop(
      `ผู้อนุมัติตัวอย่าง ${error.codes.join(', ')} มี PIN อื่นอยู่แล้ว (ตั้งเองหรือจาก seed รอบก่อน) หรือ PIN ถูกล็อก ประวัติ demo ต้องยืนยัน PIN ของผู้อนุมัติ จึงยังไม่ได้สร้าง · ` +
        `บนเครื่องรัน pnpm db:reset · หรือตั้ง SEED_DEV_PIN ใน .env ให้ตรงกับ PIN ที่ผู้อนุมัติเหล่านี้ใช้แล้ว seed ใหม่ · หรือ seed โดยไม่มีประวัติด้วย SEED_DEMO_HISTORY=0`,
    )
  }
  if (error instanceof DemoHistoryIncompleteError) {
    stop(`ประวัติ demo จาก seed รอบก่อนสร้างไม่ครบ (แถวสุดท้าย ${error.lastRef} ยังไม่เสร็จ) ตัวเลขบนกระดานและ dashboard จะไม่ตรงกับฉาก demo · บนเครื่องรัน pnpm db:reset เพื่อล้างแล้วสร้างใหม่ทั้งหมด`)
  }
  stop(error instanceof Error ? error.message : String(error))
} finally {
  await prisma.$disconnect()
}
