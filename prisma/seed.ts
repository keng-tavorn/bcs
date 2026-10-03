// pnpm db:seed (spec §5.4, Appendix A): the demo organization and its users from
// docs/inputs/BCS_inputs_v1_demo.xlsx (run pnpm inputs:check first). Safe to run again: nothing is duplicated.
// Demo users with passwords exist only in local and staging (Appendix A); production is refused.
import { systemClock } from '@/lib/clock'
import { PASSWORD_MIN_LENGTH } from '@/lib/constants'
import { getEnv } from '@/lib/env'
import { prisma } from '@/server/db/client'
import { loadOrgSettingsYaml, parseDemoOrgInput, seedDemoOrganization } from '@/server/seed/demo-org'
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
  const input = parseDemoOrgInput(await loadInputWorkbook(), loadOrgSettingsYaml())
  const report = await seedDemoOrganization(input, { password, ...(totpKey ? { totpKey } : {}), now: systemClock.now() })
  console.log(
    `db:seed เสร็จ: องค์กร ${input.org.code} (${report.organizationCreated ? 'สร้างใหม่' : 'มีอยู่แล้ว'}) · ` +
      `สมาชิกใหม่ ${report.members.created} มีอยู่แล้ว ${report.members.existing} · บทบาทใหม่ ${report.rolesGranted} · ` +
      (totpKey ? `ตั้ง 2FA ใหม่ ${report.twoFactorEnabled}` : 'ไม่มี SEED_TOTP_KEY: ผู้ใช้ที่ต้องใช้ 2FA จะตั้งแอปยืนยันตัวตนตอนเข้าระบบครั้งแรก'),
  )
} catch (error) {
  stop(error instanceof Error ? error.message : String(error))
} finally {
  await prisma.$disconnect()
}
