import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { MS_PER_MINUTE } from '@/lib/constants'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import { forTenant } from '@/server/db/tenant'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { decideByActionLink } from '@/server/services/approvals/action-link'
import { decideTask } from '@/server/services/approvals/decide'
import { decideByLinePostback } from '@/server/services/approvals/line-postback'
import { createDelegation } from '@/server/services/delegations'
import { saveLineChannelSettings } from '@/server/services/line-channel'
import { createDraft, submitRequest } from '@/server/services/requests'
import { escalateTask, startDelegationWindow } from '@/server/services/sla'
import { emailLinkSecret } from '@/server/tokens/action-tokens'
import { newLineUserId } from '../../scripts/line-simulate'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { TEST_ACCESS_TOKEN, TEST_CHANNEL_SECRET, withFakeLine } from '../support/fake-line'

// Whoever decides first decides an escalated step (BR-SLA-04, NEW-47) without a deadlock (INV-PLT-03): every path that
// acts on a task — the workspace (decideTask), the LINE button (decideByLinePostback) and the e-mail link
// (decideByActionLink) — first locks the task with the other open tasks of its step in one ascending-id lock
// (lockForDecision, src/server/services/approvals/step-complete.ts). The races run with runCommand's retries turned
// off (maxRetries 0): a deadlock would come back INTERNAL instead of being retried out of sight. A task moved by a
// delegation — before the decision or while it waits — is cancelled where it went, and the late decision on the task
// it moved from names who decided (FR-DOA-004 AC2). A request of 10,000 to the DM of CON (PR-01), sent Monday 5 Oct
// 2026 09:00 Thai time, escalates Tuesday 16:00: the VP of OPS joins as co-assignee.

const key = () => ({ idempotencyKey: randomUUID(), sender: null })
/** No retry of a deadlock: the race must not make one */
const once = () => ({ ...key(), maxRetries: 0 })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}
const at = (iso: string) => new Date(iso)
const MON_0900 = at('2026-10-05T02:00:00Z')
const TUE_1600 = at('2026-10-06T09:00:00Z')
const DECIDED = at('2026-10-06T09:30:00Z')
const LATE = at('2026-10-06T09:40:00Z')
const PROVIDER = '1650000101'
const CHANNEL = { providerId: PROVIDER, messagingChannelId: '1650000102', channelSecret: TEST_CHANNEL_SECRET, channelAccessToken: TEST_ACCESS_TOKEN, liffId: '1650000103-AbCdEfGh', liffChannelId: '1650000103' }

withFakeLine()

let org: DoaOrg
beforeAll(async () => {
  setDefaultOutboxSender(null)
  org = await withAdmin(await createDoaOrg())
  // The VP of OPS reads their cards in LINE: their co-assignee task gets a LINE button as well as the e-mail link
  ok(await saveLineChannelSettings(org.ctxOf('admin', MON_0900), { ...CHANNEL, active: true }, key()))
  await prisma.channelIdentity.create({ data: { organizationId: org.organizationId, memberId: org.member.vp_ops!, channel: 'LINE', providerKey: PROVIDER, externalUserId: newLineUserId(), linkedAt: MON_0900 } })
})

async function withAdmin(own: DoaOrg): Promise<DoaOrg> {
  await prisma.roleAssignment.create({ data: { organizationId: own.organizationId, memberId: own.member.admin!, role: 'ORG_ADMIN', grantedAt: at('2026-01-01T00:00:00Z') } })
  return own
}

/** A request of CON past its escalation time: the DM's task, and the co-assignee task of the VP of OPS */
async function escalated(target: DoaOrg, grossBaht: string) {
  const draft = ok(
    await createDraft(target.ctxOf('req_con', MON_0900), { requestTypeCode: 'BUY_GOODS', title: 'วัสดุก่อสร้าง', priceIncludesVat: true, lines: [{ description: 'ปูนซีเมนต์', quantity: '1', uom: 'งาน', unitPrice: grossBaht }] }, key()),
  )
  for (let i = 0; i < 3; i++) {
    const file = await prisma.fileObject.create({ data: { organizationId: target.organizationId, storageKey: `test/${randomUUID()}.pdf`, fileName: 'q.pdf', mimeType: 'application/pdf', sizeBytes: 1, status: 'AVAILABLE', uploadedById: target.member.req_con! } })
    await prisma.fileLink.create({ data: { organizationId: target.organizationId, fileId: file.id, subjectType: 'Request', subjectId: draft.requestId, kind: 'QUOTATION' } })
  }
  ok(await submitRequest(target.ctxOf('req_con', MON_0900), { requestId: draft.requestId }, key()))
  const first = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: draft.requestId } } } })
  const up = await escalateTask(target.organizationId, first.id, TUE_1600)
  if (!up.done || !up.coAssigneeTaskId) throw new Error(`not escalated: ${JSON.stringify(up)}`)
  const co = await prisma.approvalTask.findUniqueOrThrow({ where: { id: up.coAssigneeTaskId } })
  expect(co.assigneeMemberId).toBe(target.member.vp_ops)
  return { requestId: draft.requestId, first, co }
}

const decidedOn = (taskIds: string[]) => prisma.event.count({ where: { type: 'approval_task.decided', aggregateId: { in: taskIds } } })
const openOn = (stepId: string) => prisma.approvalTask.count({ where: { stepId, status: { in: ['OPEN', 'INFO_REQUESTED'] } } })
const cancelledWhy = async (taskId: string) => (await prisma.event.findMany({ where: { type: 'approval_task.cancelled', aggregateId: taskId }, orderBy: { seq: 'asc' } })).map((e) => (e.data as { why: string }).why)

describe('[FR-NOTI-003/AC2] [INV-PLT-03] the two approvers of an escalated step act at the same moment from any channel: one decision, no deadlock', () => {
  it('the workspace and the web again, three times: the second waits for the first and is refused with who decided', async () => {
    for (let round = 0; round < 3; round++) {
      const { first, co } = await escalated(org, `${10_100n + BigInt(round)}.00`)
      const [dm, vp] = await Promise.all([
        decideTask(org.ctxOf('dm_con', DECIDED), { taskId: first.id, decision: 'APPROVE' }, once()),
        decideTask(org.ctxOf('vp_ops', DECIDED), { taskId: co.id, decision: 'APPROVE' }, once()),
      ])
      expect([dm.ok, vp.ok].filter(Boolean)).toHaveLength(1)
      const [winner, loser, lost] = dm.ok ? ['dm_con', vp, co] : ['vp_ops', dm, first]
      expect(loser).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION', details: { from: 'CANCELLED', name: `ผู้ใช้ ${winner}`, time: DECIDED.toISOString() } } })
      expect(await cancelledWhy(lost.id)).toEqual(['CO_ASSIGNEE_DECIDED'])
      expect(await decidedOn([first.id, co.id])).toBe(1)
      expect(await openOn(first.stepId)).toBe(0)
    }
  })

  it('the VP taps the LINE button of their co-assignee card while the DM approves in the workspace', async () => {
    for (let round = 0; round < 3; round++) {
      const { first, co } = await escalated(org, `${10_200n + BigInt(round)}.00`)
      const button = await prisma.actionToken.findFirstOrThrow({ where: { taskId: co.id, channel: 'LINE' } })
      const tapCtx = makeCtx({ organizationId: org.organizationId, actor: { type: 'USER', memberId: org.member.vp_ops! }, channel: 'LINE_CHAT', now: DECIDED })
      const [web, tap] = await Promise.all([decideTask(org.ctxOf('dm_con', DECIDED), { taskId: first.id, decision: 'APPROVE' }, once()), decideByLinePostback(tapCtx, { tokenId: button.id }, once())])
      expect([web.ok, tap.ok].filter(Boolean)).toHaveLength(1)
      if (web.ok) {
        // §9.3: the button's work was done by the other approver of the step — who and when
        expect(tap).toMatchObject({ ok: false, error: { code: 'TOKEN_USED', details: { taskId: co.id, name: 'ผู้ใช้ dm_con', time: DECIDED.toISOString() } } })
        expect(await cancelledWhy(co.id)).toEqual(['CO_ASSIGNEE_DECIDED'])
      } else {
        expect(web).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION', details: { from: 'CANCELLED', name: 'ผู้ใช้ vp_ops', time: DECIDED.toISOString() } } })
        expect(await cancelledWhy(first.id)).toEqual(['CO_ASSIGNEE_DECIDED'])
      }
      expect(await decidedOn([first.id, co.id])).toBe(1)
      expect(await openOn(first.stepId)).toBe(0)
    }
  })

  it('the VP posts the e-mail link of their co-assignee task while the DM approves in the workspace', async () => {
    for (let round = 0; round < 3; round++) {
      const { first, co } = await escalated(org, `${10_300n + BigInt(round)}.00`)
      const token = await prisma.actionToken.findFirstOrThrow({ where: { taskId: co.id, channel: 'EMAIL' } })
      const link = `${token.id}.${emailLinkSecret(token.id)}`
      const [web, mail] = await Promise.all([
        decideTask(org.ctxOf('dm_con', DECIDED), { taskId: first.id, decision: 'APPROVE' }, once()),
        decideByActionLink(org.ctxOf('vp_ops', DECIDED, 'EMAIL'), { link, decision: 'APPROVE' }, once()),
      ])
      expect([web.ok, mail.ok].filter(Boolean)).toHaveLength(1)
      if (web.ok) expect(mail).toMatchObject({ ok: false, error: { code: 'TOKEN_USED', details: { name: 'ผู้ใช้ dm_con', time: DECIDED.toISOString() } } })
      else expect(web).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION', details: { from: 'CANCELLED', name: 'ผู้ใช้ vp_ops' } } })
      expect(await decidedOn([first.id, co.id])).toBe(1)
      expect(await openOn(first.stepId)).toBe(0)
    }
  })
})

describe('[FR-DOA-004/AC2] a link of a task its step’s decision cancelled says who decided, as the LINE button does (BR-SLA-04)', () => {
  it('the DM decided first: the VP’s e-mail link of the co-assignee task answers TOKEN_USED with the DM and the time', async () => {
    const { first, co } = await escalated(org, '10400.00')
    const token = await prisma.actionToken.findFirstOrThrow({ where: { taskId: co.id, channel: 'EMAIL' } })
    ok(await decideTask(org.ctxOf('dm_con', DECIDED), { taskId: first.id, decision: 'APPROVE' }, key()))
    expect(await prisma.actionToken.findUniqueOrThrow({ where: { id: token.id } })).toMatchObject({ revokedAt: DECIDED, usedAt: null })
    expect(await decideByActionLink(org.ctxOf('vp_ops', LATE, 'EMAIL'), { link: `${token.id}.${emailLinkSecret(token.id)}`, decision: 'APPROVE' }, key())).toEqual({
      ok: false,
      error: { code: 'TOKEN_USED', message: 'the task was decided already', details: { name: 'ผู้ใช้ dm_con', nameEn: expect.any(String), time: DECIDED.toISOString() } },
    })
    // A link revoked with nothing decided on its step still says it was revoked
    const cancelled = await escalated(org, '10410.00')
    const other = await prisma.actionToken.findFirstOrThrow({ where: { taskId: cancelled.co.id, channel: 'EMAIL' } })
    await prisma.actionToken.update({ where: { id: other.id }, data: { revokedAt: DECIDED } })
    expect(await decideByActionLink(org.ctxOf('vp_ops', LATE, 'EMAIL'), { link: `${other.id}.${emailLinkSecret(other.id)}`, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'TOKEN_INVALID' } })
  })
})

describe('[FR-NOTI-003/AC2] a co-assignee task moved to a delegate is the step’s task where it went: the first decision cancels it there (BR-DLG-04)', () => {
  /** The VP of OPS goes on leave from `startsAt`: their open tasks move to dm_proc, who acts for them */
  async function vpOnLeave(target: DoaOrg, startsAt: Date) {
    return ok(
      await createDelegation(target.ctxOf('vp_ops', TUE_1600), { delegateMemberId: target.member.dm_proc!, startsAt: startsAt.toISOString(), endsAt: '2026-10-10T00:00:00+07:00', reason: 'ลาพักร้อน' }, key()),
    ).delegationId
  }

  it('moved before anyone decides: the DM decides, the delegate’s task is cancelled with its links, the moved-from task is left as it is', async () => {
    const own = await withAdmin(await createDoaOrg())
    const { first, co } = await escalated(own, '10500.00')
    const startsAt = new Date(TUE_1600.getTime() + 5 * MS_PER_MINUTE)
    expect(await startDelegationWindow(own.organizationId, await vpOnLeave(own, startsAt), startsAt)).toEqual({ done: true, movedTasks: 1 })
    const moved = await prisma.approvalTask.findFirstOrThrow({ where: { reassignedFromTaskId: co.id } })
    expect(moved).toMatchObject({ status: 'OPEN', stepId: first.stepId, assigneeMemberId: own.member.dm_proc, principalMemberId: own.member.vp_ops, escalatedAt: TUE_1600 })

    ok(await decideTask(own.ctxOf('dm_con', DECIDED), { taskId: first.id, decision: 'APPROVE' }, key()))
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: moved.id } })).toMatchObject({ status: 'CANCELLED', decidedAt: null, version: moved.version + 1 })
    expect(await cancelledWhy(moved.id)).toEqual(['CO_ASSIGNEE_DECIDED'])
    expect((await prisma.actionToken.findMany({ where: { taskId: moved.id } })).map((t) => t.revokedAt)).toEqual([DECIDED])
    // The task it moved from was closed by the move (REASSIGNED), not by the decision
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: co.id } })).toMatchObject({ status: 'REASSIGNED' })
    expect(await cancelledWhy(co.id)).toEqual([])
    expect(await openOn(first.stepId)).toBe(0)
    // The delegate's late decision, and the VP's on the task it moved from, name the DM
    const refusedFrom = (from: string) => ({ ok: false, error: { code: 'INVALID_STATE_TRANSITION', details: { from, name: 'ผู้ใช้ dm_con', time: DECIDED.toISOString() } } })
    expect(await decideTask(own.ctxOf('dm_proc', LATE), { taskId: moved.id, decision: 'APPROVE' }, key())).toMatchObject(refusedFrom('CANCELLED'))
    expect(await decideTask(own.ctxOf('vp_ops', LATE), { taskId: co.id, decision: 'APPROVE' }, key())).toMatchObject(refusedFrom('REASSIGNED'))
  })

  it('the delegate decides first: the DM’s task is cancelled, and the VP’s late decision on the task that moved is refused with the delegate’s name', async () => {
    const own = await withAdmin(await createDoaOrg())
    const { requestId, first, co } = await escalated(own, '10600.00')
    const startsAt = new Date(TUE_1600.getTime() + 5 * MS_PER_MINUTE)
    expect(await startDelegationWindow(own.organizationId, await vpOnLeave(own, startsAt), startsAt)).toEqual({ done: true, movedTasks: 1 })
    const moved = await prisma.approvalTask.findFirstOrThrow({ where: { reassignedFromTaskId: co.id } })

    expect(await decideTask(own.ctxOf('dm_proc', DECIDED), { taskId: moved.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: true, data: { documentStatus: 'APPROVED' } })
    expect(await cancelledWhy(first.id)).toEqual(['CO_ASSIGNEE_DECIDED'])
    // FR-DOA-004 AC2 through the REASSIGNED task: who decided its step — the delegate — and when
    expect(await decideTask(own.ctxOf('vp_ops', LATE), { taskId: co.id, decision: 'REJECT', reason: 'ไม่จำเป็นต้องซื้อ' }, key())).toMatchObject({
      ok: false,
      error: { code: 'INVALID_STATE_TRANSITION', details: { from: 'REASSIGNED', name: 'ผู้ใช้ dm_proc', time: DECIDED.toISOString() } },
    })
    expect(await decideTask(own.ctxOf('dm_con', LATE), { taskId: first.id, decision: 'APPROVE' }, key())).toMatchObject({
      ok: false,
      error: { code: 'INVALID_STATE_TRANSITION', details: { from: 'CANCELLED', name: 'ผู้ใช้ dm_proc', time: DECIDED.toISOString() } },
    })
    expect(await decidedOn([first.id, co.id, moved.id])).toBe(1)
    expect(await prisma.request.findUniqueOrThrow({ where: { id: requestId } })).toMatchObject({ status: 'APPROVED' })
  })

  it('moved while the DM’s decision waits for the step’s lock: the task it moved to is found under the lock and cancelled', async () => {
    const own = await withAdmin(await createDoaOrg())
    const { first, co } = await escalated(own, '10700.00')
    const startsAt = new Date(TUE_1600.getTime() + 5 * MS_PER_MINUTE)
    const delegationId = await vpOnLeave(own, startsAt)

    // Another transaction holds the DM's task. The decision reads the step's open tasks (the DM's and the VP's), then
    // waits for that lock; meanwhile the delegation starts and moves the VP's task (committed), and only then is the
    // lock let go. The decision then holds a task that moved, and finds the one it moved to in its next round.
    let release!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    let lockedBy!: (pid: number) => void
    const holding = new Promise<number>((resolve) => (lockedBy = resolve))
    const holder = forTenant(own.organizationId).$transaction(
      async (tx) => {
        await lockRowsForUpdate(tx, 'ApprovalTask', own.organizationId, [first.id])
        const [me] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
        lockedBy(me!.pid)
        await released
      },
      { maxWait: 5_000, timeout: 30_000 },
    )
    let deciding: ReturnType<typeof decideTask> | null = null
    let settled = false
    try {
      const pid = await holding
      deciding = decideTask(own.ctxOf('dm_con', DECIDED), { taskId: first.id, decision: 'APPROVE' }, once())
      void deciding.then(() => (settled = true))
      await waitUntilBlockedBy(pid)
      expect(await startDelegationWindow(own.organizationId, delegationId, startsAt)).toEqual({ done: true, movedTasks: 1 })
      // the move committed while the decision still waited for the lock
      expect(settled).toBe(false)
    } finally {
      release()
      await holder
    }
    expect(await deciding).toMatchObject({ ok: true, data: { documentStatus: 'APPROVED' } })
    const moved = await prisma.approvalTask.findFirstOrThrow({ where: { reassignedFromTaskId: co.id } })
    expect(moved).toMatchObject({ status: 'CANCELLED', assigneeMemberId: own.member.dm_proc, principalMemberId: own.member.vp_ops })
    expect(await cancelledWhy(moved.id)).toEqual(['CO_ASSIGNEE_DECIDED'])
    expect(await prisma.actionToken.count({ where: { taskId: moved.id, revokedAt: null } })).toBe(0)
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: co.id } })).toMatchObject({ status: 'REASSIGNED' })
    expect(await cancelledWhy(co.id)).toEqual([])
    expect(await openOn(first.stepId)).toBe(0)
  })
})

/** Resolves once another connection of this database waits for a lock that the backend `pid` holds */
async function waitUntilBlockedBy(pid: number, timeoutMs = 5_000): Promise<void> {
  const until = performance.now() + timeoutMs
  while (performance.now() < until) {
    const [row] = await prisma.$queryRaw<Array<{ waiting: number }>>`
      SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`
    if ((row?.waiting ?? 0) > 0) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('the decision never waited for the task the test holds')
}
