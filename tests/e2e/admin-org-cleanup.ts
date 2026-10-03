import { randomUUID } from 'node:crypto'
import { deriveSeedTotpSecret, totp } from '@/lib/totp'
import { grantStepUp } from '@/server/auth/step-up'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { decideTask } from '@/server/services/approvals/decide'
import { E2E_DB } from '../support/e2e-env'

// Run by the unit c e2e specs (tests/e2e/admin-org.spec.ts, tests/e2e/admin-doa.spec.ts) against the e2e database only:
// the policy changes a test sent for approval — found by their exact reasons, in the demo organization — are rejected
// by their approver the way the web does it, with a step-up (BR-DOA-15) and a reason. So no spec leaves tasks waiting
// for the CEO for the specs that run after it in the shared database. The reasons arrive as one argument, base64 of a
// JSON list (Thai text passes through any shell that way). Prints what it rejected as JSON.
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the cleanup runs in the e2e database only')
const totpKey = process.env.SEED_TOTP_KEY
if (!totpKey) throw new Error('SEED_TOTP_KEY is needed')
const reasons = JSON.parse(Buffer.from(process.argv[2] ?? '', 'base64').toString('utf8') || '[]') as string[]
if (!Array.isArray(reasons) || reasons.length === 0) throw new Error('name the reasons of the changes to reject')

const demo = await prisma.organization.findUniqueOrThrow({ where: { code: 'DEMO' }, select: { id: true } })
const changes = await prisma.orgAuthorityChange.findMany({ where: { organizationId: demo.id, status: 'PENDING_APPROVAL', reason: { in: reasons } }, select: { id: true } })
const versions = await prisma.doaVersion.findMany({ where: { organizationId: demo.id, status: 'PENDING_APPROVAL', changeReason: { in: reasons } }, select: { id: true } })
const subjects = [...changes.map((c) => ({ type: 'ORG_AUTHORITY_CHANGE', id: c.id })), ...versions.map((v) => ({ type: 'DOA_VERSION', id: v.id }))]

const rejected: string[] = []
for (const subject of subjects) {
  const task = await prisma.approvalTask.findFirst({
    where: { organizationId: demo.id, status: 'OPEN', step: { route: { subjectType: subject.type as 'ORG_AUTHORITY_CHANGE' | 'DOA_VERSION', subjectId: subject.id } } },
    select: { id: true, assignee: { select: { id: true, employeeCode: true } } },
  })
  if (!task?.assignee.employeeCode) continue
  const code = totp(deriveSeedTotpSecret(totpKey, task.assignee.employeeCode))
  const stepUp = await grantStepUp({ organizationId: demo.id, memberId: task.assignee.id, subjectType: subject.type, subjectId: subject.id, code }, new Date())
  if (!stepUp.ok) throw new Error(`step-up refused for ${subject.type} ${subject.id}: ${stepUp.reason}`)
  const ctx = makeCtx({ organizationId: demo.id, actor: { type: 'USER', memberId: task.assignee.id }, channel: 'WEB', now: new Date() })
  const decided = await decideTask(ctx, { taskId: task.id, decision: 'REJECT', reason: 'ล้างข้อมูลทดสอบอัตโนมัติหลังจบการทดสอบ' }, { idempotencyKey: randomUUID(), sender: null })
  if (!decided.ok) throw new Error(`reject failed for ${subject.type} ${subject.id}: ${JSON.stringify(decided.error)}`)
  rejected.push(`${subject.type}:${subject.id}`)
}
console.log(JSON.stringify({ rejected }))
await prisma.$disconnect()
