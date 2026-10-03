import { upsertUserWithPassword } from '@/server/auth/provision'
import { prisma } from '@/server/db/client'
import { E2E_DB } from '../support/e2e-env'

// Run by tests/e2e/notifications.spec.ts against the e2e database only: a plain member (requester, no role, no position)
// of the demo organization that no other test has touched — a new one per run and viewport, named by SCENE_MEMBER_CODE
// — so "no notifications yet" holds whatever other specs did to the shared demo users. Signs in with SEED_DEV_PASSWORD.
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the fresh member scene runs in the e2e database only')
const code = process.env.SCENE_MEMBER_CODE ?? ''
if (!/^e2e-[a-z0-9-]{3,40}$/.test(code)) throw new Error('SCENE_MEMBER_CODE must look like e2e-<letters, digits, ->')
const password = process.env.SEED_DEV_PASSWORD
if (!password) throw new Error('SEED_DEV_PASSWORD is needed')

const org = await prisma.organization.findFirstOrThrow({ where: { code: 'DEMO' }, select: { id: true } })
const department = await prisma.department.findFirstOrThrow({ where: { organizationId: org.id, code: 'CON' }, select: { id: true } })
const email = `${code}@demo.bcs.local`
const userId = await upsertUserWithPassword({ email, name: 'ผู้ใช้ทดสอบ กระดิ่งว่าง', password })
await prisma.member.upsert({
  where: { organizationId_email: { organizationId: org.id, email } },
  create: { organizationId: org.id, userId, email, displayNameTh: 'ผู้ใช้ทดสอบ กระดิ่งว่าง', employeeCode: code, status: 'ACTIVE', primaryDepartmentId: department.id },
  update: {},
})
console.log(JSON.stringify({ email }))
await prisma.$disconnect()
