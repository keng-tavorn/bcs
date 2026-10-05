import { randomUUID } from 'node:crypto'
import { systemClock } from '@/lib/clock'
import { MS_PER_HOUR } from '@/lib/constants'
import { upsertUserWithPassword } from '@/server/auth/provision'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { createDelegation, revokeDelegation } from '@/server/services/delegations'
import { endDelegationWindow } from '@/server/services/sla/delegation-window'
import { E2E_DB } from '../support/e2e-env'

// Run by tests/e2e/liff-delegation.spec.ts (S5-06, FR-DOA-006 AC2 in LIFF, demo scene 11) against the e2e database only:
// builds what the LIFF delegation test needs through the services and reads back what the page did. The delegator is
// dm_con (the demo's DM of construction, who names an acting approver in LIFF in scene 11); the delegate is a fresh member
// of the construction department that no other test touches, so the delegations of a run never meet. Prints JSON on the
// last line.
//   setup <tag>       a fresh delegate e2e-ldg-<tag>, and a delegation dm_con gave them that already ended (made for a
//                     period two hours ago through the delegation service, then ended by the delegation-window job's
//                     command, as on the day) — an ended delegation offers no cancel
//   state <tag>       dm_con's delegations to that delegate: status, the channel of their delegation.created and
//                     delegation.revoked Events
//   cleanup <tag>     dm_con cancels whatever delegation to that delegate still runs or is still to come (a test that
//                     stopped half-way leaves nothing behind for the other specs of the run)
//   plain <tag>       a fresh member who holds no position (nothing to hand over)
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the LIFF delegation scene runs in the e2e database only')

const [command, tag = ''] = process.argv.slice(2)
if (!/^[a-z0-9-]{3,40}$/.test(tag)) throw new Error('the scene needs a tag of lower-case letters, digits and -')
const password = process.env.SEED_DEV_PASSWORD
if (!password) throw new Error('SEED_DEV_PASSWORD is needed')

const DELEGATOR = 'dm_con'
const org = await prisma.organization.findFirstOrThrow({ where: { code: 'DEMO' }, select: { id: true } })
const ctxOf = (memberId: string, now = systemClock.now()) => makeCtx({ organizationId: org.id, actor: { type: 'USER', memberId }, channel: 'WEB', now })
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const delegator = await prisma.member.findUniqueOrThrow({ where: { organizationId_employeeCode: { organizationId: org.id, employeeCode: DELEGATOR } }, select: { id: true, displayNameTh: true } })

/** A fresh member of the construction department (a plain requester: no role, no position) */
async function freshMember(code: string, nameTh: string): Promise<{ id: string; nameTh: string; code: string }> {
  const email = `${code}@demo.bcs.local`
  const department = await prisma.department.findFirstOrThrow({ where: { organizationId: org.id, code: 'CON' }, select: { id: true } })
  const userId = await upsertUserWithPassword({ email, name: nameTh, password: password! })
  const member = await prisma.member.upsert({
    where: { organizationId_email: { organizationId: org.id, email } },
    create: { organizationId: org.id, userId, email, displayNameTh: nameTh, employeeCode: code, status: 'ACTIVE', primaryDepartmentId: department.id },
    update: {},
    select: { id: true },
  })
  return { id: member.id, nameTh, code }
}

const delegateCode = `e2e-ldg-${tag}`
const delegateOf = async () => (await prisma.member.findUniqueOrThrow({ where: { organizationId_employeeCode: { organizationId: org.id, employeeCode: delegateCode } }, select: { id: true } })).id

let result: unknown
switch (command) {
  case 'setup': {
    const delegate = await freshMember(delegateCode, `ทดสอบ รักษาการ ${tag}`)
    // A period that is over: it never routed anything (inEffect is false outside it) and the job's command ends it
    const now = systemClock.now()
    const startsAt = new Date(now.getTime() - 3 * MS_PER_HOUR)
    const endsAt = new Date(now.getTime() - 2 * MS_PER_HOUR)
    const made = await createDelegation(ctxOf(delegator.id, now), { delegateMemberId: delegate.id, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), reason: 'ประชุมนอกสถานที่ที่ผ่านมาแล้ว' }, key())
    if (!made.ok) throw new Error(`the ended delegation was not made: ${made.error.code} ${JSON.stringify(made.error.details ?? {})}`)
    const ended = await endDelegationWindow(org.id, made.data.delegationId, systemClock.now())
    if (!ended.done) throw new Error(`the delegation did not end: ${JSON.stringify(ended)}`)
    result = { delegator: { code: DELEGATOR, nameTh: delegator.displayNameTh }, delegate, endedId: made.data.delegationId }
    break
  }
  case 'state': {
    const rows = await prisma.delegation.findMany({ where: { organizationId: org.id, delegatorMemberId: delegator.id, delegateMemberId: await delegateOf() }, orderBy: { createdAt: 'asc' }, select: { id: true, status: true, createdVia: true } })
    const events = await prisma.event.findMany({
      where: { organizationId: org.id, aggregateType: 'Delegation', aggregateId: { in: rows.map((r) => r.id) }, type: { in: ['delegation.created', 'delegation.revoked'] } },
      select: { aggregateId: true, type: true, channel: true },
    })
    result = { delegations: rows.map((r) => ({ ...r, events: events.filter((e) => e.aggregateId === r.id).map((e) => ({ type: e.type, channel: e.channel })) })) }
    break
  }
  case 'cleanup': {
    const live = await prisma.delegation.findMany({ where: { organizationId: org.id, delegatorMemberId: delegator.id, delegateMemberId: await delegateOf(), status: { in: ['SCHEDULED', 'ACTIVE'] } }, select: { id: true, endsAt: true } })
    let revoked = 0
    for (const d of live) {
      if (d.endsAt.getTime() <= systemClock.now().getTime()) continue
      const r = await revokeDelegation(ctxOf(delegator.id), { delegationId: d.id }, key())
      if (!r.ok) throw new Error(`not revoked: ${r.error.code}`)
      revoked += 1
    }
    result = { revoked }
    break
  }
  case 'plain':
    result = { member: await freshMember(`e2e-ldg-${tag}`, `ทดสอบ ไม่มีตำแหน่ง ${tag}`) }
    break
  default:
    throw new Error(`unknown LIFF delegation scene command ${command ?? '(none)'}`)
}
console.log(JSON.stringify(result))
await prisma.$disconnect()
