import { randomUUID } from 'node:crypto'
import { systemClock } from '@/lib/clock'
import { deriveSeedTotpSecret } from '@/lib/totp'
import { enableTotpWithSecret, upsertUserWithPassword } from '@/server/auth/provision'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { grantRole } from '@/server/services/members/roles'
import { E2E_DB } from '../support/e2e-env'

// Run by tests/e2e/auth-prehydration.spec.ts against the e2e database only: a fresh member of the demo organization
// (employee code e2e-pre-<tag>, a member of CON no other test touches) who signs in with SEED_DEV_PASSWORD, and prints
// { email } as JSON on the last line.
//   setup <tag>   holds a role (AUDITOR, granted by the organization's administrator through the service) and has no
//                 authenticator app yet: the workspace shows them the authenticator setup before any work (FR-AUTH-002 AC1)
//   totp <tag>    no role, an authenticator app with the secret derived from SEED_TOTP_KEY: the sign-in asks for its code
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the sign-in scene runs in the e2e database only')

const [command, tag = ''] = process.argv.slice(2)
if (command !== 'setup' && command !== 'totp') throw new Error(`unknown command ${command ?? ''}: setup or totp`)
if (!/^[a-z0-9-]{3,40}$/.test(tag)) throw new Error('the scene needs a tag of lower-case letters, digits and -')
const password = process.env.SEED_DEV_PASSWORD
const totpKey = process.env.SEED_TOTP_KEY
if (!password || !totpKey) throw new Error('SEED_DEV_PASSWORD and SEED_TOTP_KEY are needed')

const org = await prisma.organization.findFirstOrThrow({ where: { code: 'DEMO' }, select: { id: true } })
const department = await prisma.department.findFirstOrThrow({ where: { organizationId: org.id, code: 'CON' }, select: { id: true } })
const employeeCode = `e2e-pre-${tag}`
const email = `${employeeCode}@demo.bcs.local`
const nameTh = `ทดสอบ ก่อนสคริปต์ ${tag}`
const userId = await upsertUserWithPassword({ email, name: nameTh, password })
const member = await prisma.member.create({
  data: { organizationId: org.id, userId, email, displayNameTh: nameTh, employeeCode, status: 'ACTIVE', primaryDepartmentId: department.id },
  select: { id: true },
})

if (command === 'setup') {
  const admin = await prisma.member.findFirstOrThrow({ where: { organizationId: org.id, employeeCode: 'admin' }, select: { id: true } })
  const ctx = makeCtx({ organizationId: org.id, actor: { type: 'USER', memberId: admin.id }, channel: 'WEB', now: systemClock.now() })
  const granted = await grantRole(ctx, { memberId: member.id, role: 'AUDITOR' }, { idempotencyKey: randomUUID(), sender: null })
  if (!granted.ok) throw new Error(`the role was not granted: ${granted.error.code}`)
} else {
  await enableTotpWithSecret(userId, deriveSeedTotpSecret(totpKey, employeeCode), [])
}

console.log(JSON.stringify({ email, employeeCode }))
await prisma.$disconnect()
