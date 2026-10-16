import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { createDelegation } from '@/server/services/delegations'
import { deactivateMember } from '@/server/services/members'
import { createDraft, submitRequest } from '../support/requests'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { p2p } from '../support/p2p'

// FR-AUTH-003 AC2 (BR-AUTH-06): deactivating a member revokes, in one transaction, their sessions, action tokens and
// delegations — each delegation with its event and a word to the other side — and ORG_ADMIN is told when approval
// tasks still wait on them (§10.1 admin.reassign_needed). The LINE link joins in S5.

const NOW = new Date('2026-10-06T02:00:00Z')
const HOUR = 3600 * 1000
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}

let org: DoaOrg
let budgetLineId: string

beforeAll(async () => {
  org = await createDoaOrg()
  budgetLineId = await p2p(org, NOW).fundedLine(1_000_000n)
  await prisma.roleAssignment.createMany({
    data: ['admin', 'admin2'].map((code) => ({ organizationId: org.organizationId, memberId: org.member[code]!, role: 'ORG_ADMIN' as const, grantedAt: NOW })),
  })
})

describe('[FR-AUTH-003/AC2] deactivation revokes tokens and delegations and tells ORG_ADMIN about open tasks', () => {
  it('revokes the delegation with its event, tells the delegate, and tells every other ORG_ADMIN of the open task', async () => {
    const delegation = ok(await createDelegation(org.ctxOf('dm_con', NOW), { delegateMemberId: org.member.asst_con!, startsAt: new Date(NOW.getTime() + HOUR).toISOString(), endsAt: new Date(NOW.getTime() + 48 * HOUR).toISOString(), reason: 'ลาพักร้อน' }, key()))
    const draft = ok(await createDraft(org.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', title: 'ปากกา', budgetLineId, lines: [{ description: 'ปากกา', quantity: '10', uom: 'ด้าม', unitPrice: '15.00' }] }, key()))
    ok(await submitRequest(org.ctxOf('req_con', NOW), { requestId: draft.requestId }, key()))
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: draft.requestId } } } })
    expect(task.assigneeMemberId).toBe(org.member.dm_con)

    try {
      const result = ok(await deactivateMember(org.ctxOf('admin', NOW), { memberId: org.member.dm_con!, reason: 'ลาออก' }, key()))
      expect(result.revoked).toMatchObject({ sessions: 0, invitations: 0, delegations: 1, actionTokens: expect.any(Number) })
      expect(result.revoked.actionTokens).toBeGreaterThanOrEqual(1)
      expect(result.openTasks).toBe(1)

      expect(await prisma.delegation.findUniqueOrThrow({ where: { id: delegation.delegationId } })).toMatchObject({ status: 'REVOKED', revokedAt: NOW })
      expect(await prisma.event.findFirst({ where: { type: 'delegation.revoked', aggregateId: delegation.delegationId }, select: { data: true } })).toEqual({ data: { from: 'SCHEDULED' } })
      expect(await prisma.notification.count({ where: { templateKey: 'delegation.revoked', recipientMemberId: org.member.asst_con, subjectId: delegation.delegationId } })).toBe(1)
      expect(await prisma.actionToken.count({ where: { memberId: org.member.dm_con, usedAt: null, revokedAt: null } })).toBe(0)

      const told = await prisma.notification.findMany({ where: { templateKey: 'admin.reassign_needed', subjectId: org.member.dm_con }, select: { recipientMemberId: true, urgency: true, data: true } })
      // the admin who deactivated and the other one; never the member themself
      expect(told.map((n) => n.recipientMemberId).sort()).toEqual([org.member.admin!, org.member.admin2!].sort())
      expect(told[0]).toMatchObject({ urgency: 'IMMEDIATE', data: { openTasks: 1 } })
    } finally {
      await prisma.member.update({ where: { id: org.member.dm_con! }, data: { status: 'ACTIVE' } })
    }
  })

  it('a member with no open task and no delegation: nothing to tell', async () => {
    const result = ok(await deactivateMember(org.ctxOf('admin', NOW), { memberId: org.member.auditor!, reason: 'ย้ายบริษัท' }, key()))
    expect(result).toMatchObject({ openTasks: 0, revoked: { delegations: 0, actionTokens: 0 } })
    expect(await prisma.notification.count({ where: { templateKey: 'admin.reassign_needed', subjectId: org.member.auditor } })).toBe(0)
  })
})
