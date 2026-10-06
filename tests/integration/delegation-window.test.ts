import { randomUUID } from 'node:crypto'
import { StepError } from 'inngest'
import { beforeAll, describe, expect, it } from 'vitest'
import { ManualClock } from '@/lib/clock'
import { prisma } from '@/server/db/client'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import type { TimerStep } from '@/server/jobs/approval-task-sla'
import { delegationRevoked, delegationWindow, delegationWindowHandler } from '@/server/jobs/delegation-window'
import { renderNotification } from '@/server/notifications/templates'
import { runCommand } from '@/server/services/_pipeline'
import { provideInfo, requestInfo } from '@/server/services/approvals/decide'
import { createDelegation, revokeDelegation } from '@/server/services/delegations'
import { deactivateMember } from '@/server/services/members'
import { createDraft, submitRequest } from '@/server/services/requests'
import { endDelegationWindow, returnRevokedDelegationTasks, startDelegationWindow } from '@/server/services/sla'
import { endDelegationWindowCommand, returnRevokedTasksCommand, startDelegationWindowCommand } from '@/server/services/sla/delegation-window'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// The delegation period (spec §4.6 delegation-window, §6.4 ApprovalTask, BR-DLG-01 to BR-DLG-05, FR-DOA-006 AC3) on
// the §7.4 fixture organization: dm_con (DM of CON) delegates to asst_con. At startsAt the open tasks dm_con holds
// move to asst_con, who acts for dm_con; at endsAt what asst_con still holds for dm_con moves back; both are told.
// Every test has an organization of its own, so no task of another test is open with dm_con.

const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const at = (iso: string) => new Date(iso)

beforeAll(() => setDefaultOutboxSender(null))

async function freshOrg(): Promise<DoaOrg> {
  const org = await createDoaOrg()
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: at('2026-01-01T00:00:00Z') } })
  return org
}

async function submitted(org: DoaOrg, requester: string, grossBaht: string, when: Date) {
  const draft = await createDraft(org.ctxOf(requester, when), { requestTypeCode: 'BUY_GOODS', title: 'วัสดุสำนักงาน', priceIncludesVat: true, lines: [{ description: 'กระดาษ', quantity: '1', uom: 'งาน', unitPrice: grossBaht }] }, key())
  if (!draft.ok) throw new Error(`draft failed: ${JSON.stringify(draft.error)}`)
  const sent = await submitRequest(org.ctxOf(requester, when), { requestId: draft.data.requestId }, key())
  if (!sent.ok) throw new Error(`submit failed: ${JSON.stringify(sent.error)}`)
  const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: draft.data.requestId } } } })
  return { requestId: draft.data.requestId, task }
}

async function delegated(org: DoaOrg, delegator: string, delegate: string, startsAt: string, endsAt: string, when: Date, extra: { maxAmount?: string } = {}) {
  const r = await createDelegation(org.ctxOf(delegator, when), { delegateMemberId: org.member[delegate]!, startsAt, endsAt, reason: 'ลาพักร้อน', ...extra }, key())
  if (!r.ok) throw new Error(`delegation failed: ${JSON.stringify(r.error)}`)
  return r.data.delegationId
}

/** The open task of a request now (after moves the task id changes) */
const openTaskOf = (requestId: string) => prisma.approvalTask.findFirstOrThrow({ where: { status: { in: ['OPEN', 'INFO_REQUESTED'] }, step: { route: { subjectId: requestId } } } })
const eventsOf = (org: DoaOrg, type: string, aggregateId: string) => prisma.event.findMany({ where: { organizationId: org.organizationId, type, aggregateId } })
const windowNotices = async (delegationId: string) =>
  (await prisma.notification.findMany({ where: { templateKey: 'delegation.window', subjectId: delegationId }, orderBy: { dedupeKey: 'asc' } })).map((n) => ({ to: n.recipientMemberId, ...(n.data as { phase: string; role: string; movedTasks: number }) }))

describe('[FR-DOA-006/AC3] when the period starts and ends the open tasks move by themselves and both sides are told', () => {
  it('moves the delegator’s open task to the delegate at startsAt and every task they still hold back at endsAt', async () => {
    const org = await freshOrg()
    const monday = at('2026-10-05T02:00:00Z')
    const first = await submitted(org, 'req_con', '10000.00', monday)
    expect(first.task).toMatchObject({ assigneeMemberId: org.member.dm_con, principalMemberId: null })
    // Tuesday 6 Oct 00:00 to Friday 9 Oct 00:00 Thai time, set on Monday
    const id = await delegated(org, 'dm_con', 'asst_con', '2026-10-06T00:00:00+07:00', '2026-10-09T00:00:00+07:00', monday)
    expect(await startDelegationWindow(org.organizationId, id, monday)).toMatchObject({ done: false, reason: 'NOT_DUE' })

    expect(await startDelegationWindow(org.organizationId, id, at('2026-10-05T17:00:00Z'))).toEqual({ done: true, movedTasks: 1 })
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: first.task.id } })).toMatchObject({ status: 'REASSIGNED' })
    const moved = await openTaskOf(first.requestId)
    // §6.4: a new task of the same step, DOA source and times, held by the delegate for the delegator (BR-DLG-04)
    expect(moved).toMatchObject({
      stepId: first.task.stepId,
      assigneeMemberId: org.member.asst_con,
      principalMemberId: org.member.dm_con,
      resolvedFrom: 'POSITION:DM@CON',
      status: 'OPEN',
      dueAt: first.task.dueAt,
      remindAt: first.task.remindAt,
      assignedAt: at('2026-10-05T17:00:00Z'),
      reassignedFromTaskId: first.task.id,
    })
    expect((await eventsOf(org, 'approval_task.reassigned', moved.id))[0]!.data).toEqual({ fromTaskId: first.task.id, fromMemberId: org.member.dm_con, toMemberId: org.member.asst_con, why: 'DELEGATION', changeId: null })
    expect((await eventsOf(org, 'delegation.started', id))[0]).toMatchObject({ actorType: 'SYSTEM', channel: 'SYSTEM', data: { movedTasks: 1 } })
    expect(await windowNotices(id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ to: org.member.dm_con, phase: 'STARTED', role: 'DELEGATOR', movedTasks: 1 }),
        expect.objectContaining({ to: org.member.asst_con, phase: 'STARTED', role: 'DELEGATE', movedTasks: 1 }),
      ]),
    )
    const toDelegate = await prisma.notification.findFirstOrThrow({ where: { templateKey: 'delegation.window', subjectId: id, recipientMemberId: org.member.asst_con } })
    expect(renderNotification(toDelegate, 'th')).toMatchObject({ title: 'เริ่มรักษาการแทนแล้ว รับงานค้าง 1 งาน', href: '/tasks' })
    expect(renderNotification(toDelegate, 'en')).toMatchObject({ title: 'Your acting period has started: 1 open task moved to you' })
    // §6.4: the stored status follows the period
    expect(await prisma.delegation.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'ACTIVE' })
    // BR-TOK-01: the old task's link is revoked and the delegate gets one of their own
    expect(await prisma.actionToken.findFirstOrThrow({ where: { taskId: first.task.id } })).toMatchObject({ revokedAt: at('2026-10-05T17:00:00Z') })
    expect(await prisma.actionToken.findFirstOrThrow({ where: { taskId: moved.id } })).toMatchObject({ memberId: org.member.asst_con, revokedAt: null })
    // a retry repeats nothing
    expect(await startDelegationWindow(org.organizationId, id, at('2026-10-05T17:01:00Z'))).toEqual({ done: true, movedTasks: 1 })
    expect(await eventsOf(org, 'delegation.started', id)).toHaveLength(1)

    // During the period new tasks of dm_con go to asst_con when they are made (S2 routing, BR-DLG-04)
    const second = await submitted(org, 'req_con', '9000.00', at('2026-10-07T02:00:00Z'))
    expect(second.task).toMatchObject({ assigneeMemberId: org.member.asst_con, principalMemberId: org.member.dm_con })

    expect(await endDelegationWindow(org.organizationId, id, at('2026-10-08T16:59:00Z'))).toMatchObject({ done: false, reason: 'NOT_DUE' })
    expect(await endDelegationWindow(org.organizationId, id, at('2026-10-08T17:00:00Z'))).toEqual({ done: true, movedTasks: 2 })
    for (const requestId of [first.requestId, second.requestId]) {
      expect(await openTaskOf(requestId)).toMatchObject({ assigneeMemberId: org.member.dm_con, principalMemberId: null, status: 'OPEN', assignedAt: at('2026-10-08T17:00:00Z') })
    }
    expect((await eventsOf(org, 'delegation.ended', id))[0]!.data).toEqual({ movedTasks: 2 })
    expect((await windowNotices(id)).filter((n) => n.phase === 'ENDED').map((n) => [n.to, n.role, n.movedTasks])).toEqual(
      expect.arrayContaining([
        [org.member.dm_con, 'DELEGATOR', 2],
        [org.member.asst_con, 'DELEGATE', 2],
      ]),
    )
    expect(await endDelegationWindow(org.organizationId, id, at('2026-10-08T17:05:00Z'))).toEqual({ done: true, movedTasks: 2 })
    expect(await eventsOf(org, 'delegation.ended', id)).toHaveLength(1)
    const toDelegator = await prisma.notification.findFirstOrThrow({ where: { templateKey: 'delegation.window', subjectId: id, recipientMemberId: org.member.dm_con, data: { path: ['phase'], equals: 'ENDED' } } })
    expect(renderNotification(toDelegator, 'en')).toMatchObject({ title: 'Your delegation has ended: 2 open tasks came back to you', href: '/tasks' })
  })

  it('the stored status follows the period (SCHEDULED → ACTIVE → ENDED); an ended delegation can no longer be revoked', async () => {
    const org = await freshOrg()
    const monday = at('2026-10-05T02:00:00Z')
    const id = await delegated(org, 'dm_con', 'asst_con', '2026-10-06T00:00:00+07:00', '2026-10-08T00:00:00+07:00', monday)
    const status = async () => (await prisma.delegation.findUniqueOrThrow({ where: { id } })).status
    expect(await status()).toBe('SCHEDULED')
    expect(await startDelegationWindow(org.organizationId, id, at('2026-10-05T17:00:00Z'))).toEqual({ done: true, movedTasks: 0 })
    expect(await status()).toBe('ACTIVE')
    expect(await endDelegationWindow(org.organizationId, id, at('2026-10-07T17:00:00Z'))).toEqual({ done: true, movedTasks: 0 })
    expect(await status()).toBe('ENDED')
    // Revoking it now would announce a cancellation of something that is over
    expect(await revokeDelegation(org.ctxOf('dm_con', at('2026-10-07T18:00:00Z')), { delegationId: id }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION' } })
    // Deactivating the delegate later leaves it alone: no revocation, no notice to the delegator
    expect(await deactivateMember(org.ctxOf('admin', at('2026-10-08T03:00:00Z')), { memberId: org.member.asst_con!, reason: 'ลาออก' }, key())).toMatchObject({ ok: true, data: { revoked: { delegations: 0 } } })
    expect(await eventsOf(org, 'delegation.revoked', id)).toHaveLength(0)
    expect(await status()).toBe('ENDED')

    // A start never handled: the end goes through ACTIVE to ENDED
    const late = await delegated(org, 'dm_con', 'dm_proc', '2026-10-12T00:00:00+07:00', '2026-10-14T00:00:00+07:00', monday)
    expect(await endDelegationWindow(org.organizationId, late, at('2026-10-13T17:00:00Z'))).toEqual({ done: true, movedTasks: 0 })
    expect(await prisma.delegation.findUniqueOrThrow({ where: { id: late } })).toMatchObject({ status: 'ENDED' })
    expect(await startDelegationWindow(org.organizationId, late, at('2026-10-13T17:01:00Z'))).toMatchObject({ done: false, reason: 'ENDED' })
  })

  it('a delegator deactivated during the period gets nothing back: the tasks stay with the active delegate for ORG_ADMIN to reassign (BR-AUTH-06)', async () => {
    const org = await freshOrg()
    const monday = at('2026-11-23T02:00:00Z')
    const one = await submitted(org, 'req_con', '8000.00', monday)
    const id = await delegated(org, 'dm_con', 'asst_con', '2026-11-24T00:00:00+07:00', '2026-11-27T00:00:00+07:00', monday)
    expect(await startDelegationWindow(org.organizationId, id, at('2026-11-23T17:00:00Z'))).toEqual({ done: true, movedTasks: 1 })
    const held = await openTaskOf(one.requestId)
    expect(held).toMatchObject({ assigneeMemberId: org.member.asst_con, principalMemberId: org.member.dm_con })
    // Deactivation revokes the delegation in its transaction and tells ORG_ADMIN about the task held on dm_con's behalf
    const tuesday = at('2026-11-24T03:00:00Z')
    expect(await deactivateMember(org.ctxOf('admin', tuesday), { memberId: org.member.dm_con!, reason: 'ลาออก' }, key())).toMatchObject({ ok: true, data: { openTasks: 1, revoked: { delegations: 1 } } })
    expect(await prisma.notification.findFirstOrThrow({ where: { templateKey: 'admin.reassign_needed', recipientMemberId: org.member.admin } })).toMatchObject({ data: { memberId: org.member.dm_con, openTasks: 1 } })
    // delegation-revoked moves nothing to the deactivated member and issues them no token
    expect(await returnRevokedDelegationTasks(org.organizationId, id, tuesday)).toMatchObject({ done: false, code: 'INVALID_STATE_TRANSITION', reason: 'DELEGATOR_INACTIVE' })
    expect(await openTaskOf(one.requestId)).toMatchObject({ id: held.id, assigneeMemberId: org.member.asst_con, principalMemberId: org.member.dm_con, status: 'OPEN' })
    expect(await prisma.actionToken.count({ where: { memberId: org.member.dm_con, revokedAt: null, usedAt: null } })).toBe(0)
    expect(await prisma.notification.count({ where: { templateKey: 'delegation.window', subjectId: id, recipientMemberId: org.member.dm_con, data: { path: ['phase'], equals: 'REVOKED' } } })).toBe(0)
    expect(await eventsOf(org, 'approval_task.reassigned', held.id)).toHaveLength(1)
    // The delegate can still decide it until ORG_ADMIN reassigns it
    expect(await prisma.actionToken.count({ where: { taskId: held.id, memberId: org.member.asst_con, revokedAt: null } })).toBe(1)
  })

  it('at the end, a task whose delegator is no longer ACTIVE stays with the delegate, who is told, and ORG_ADMIN is told to reassign it', async () => {
    const org = await freshOrg()
    const monday = at('2026-11-30T02:00:00Z')
    const one = await submitted(org, 'req_con', '8000.00', monday)
    const id = await delegated(org, 'dm_con', 'asst_con', '2026-12-01T00:00:00+07:00', '2026-12-03T00:00:00+07:00', monday)
    expect(await startDelegationWindow(org.organizationId, id, at('2026-11-30T17:00:00Z'))).toEqual({ done: true, movedTasks: 1 })
    // dm_con is no longer ACTIVE although the delegation was not revoked (the deactivation command would revoke it)
    await prisma.member.update({ where: { id: org.member.dm_con! }, data: { status: 'DEACTIVATED' } })
    expect(await endDelegationWindow(org.organizationId, id, at('2026-12-02T17:00:00Z'))).toEqual({ done: true, movedTasks: 0 })
    expect(await openTaskOf(one.requestId)).toMatchObject({ assigneeMemberId: org.member.asst_con, principalMemberId: org.member.dm_con })
    expect(await prisma.actionToken.count({ where: { memberId: org.member.dm_con, revokedAt: null, usedAt: null, task: { status: 'OPEN' } } })).toBe(0)
    const reassign = await prisma.notification.findFirstOrThrow({ where: { templateKey: 'admin.reassign_needed', recipientMemberId: org.member.admin } })
    expect(reassign).toMatchObject({ subjectType: 'MEMBER', subjectId: org.member.dm_con, data: { memberId: org.member.dm_con, openTasks: 1 } })
    // only the delegate hears of the end, with the task they keep
    const ended = (await windowNotices(id)).filter((n) => n.phase === 'ENDED')
    expect(ended.map((n) => [n.to, n.role, n.movedTasks])).toEqual([[org.member.asst_con, 'DELEGATE', 0]])
    const toDelegate = await prisma.notification.findFirstOrThrow({ where: { templateKey: 'delegation.window', subjectId: id, recipientMemberId: org.member.asst_con, data: { path: ['phase'], equals: 'ENDED' } } })
    // No command moves a task by hand: a new holder of the delegator's position takes it (BR-DOA-17, NEW-28)
    expect(renderNotification(toDelegate, 'th')).toEqual({
      title: 'สิ้นสุดการรักษาการแทนแล้ว งานค้าง 0 งานกลับไปที่ผู้มอบ',
      body: 'งานค้าง 1 งานยังอยู่กับคุณ จนกว่าจะมีผู้ดำรงตำแหน่งคนใหม่ที่แต่งตั้งผ่านหน้าเปลี่ยนโครงสร้างอำนาจ',
      href: '/tasks',
    })
    expect(renderNotification(toDelegate, 'en').body).toBe('1 open task stays with you until a new holder of the position is appointed through the Authority changes page')
  })

  it('a delegate deactivated during the period gives the tasks back to the active delegator at once, who is told', async () => {
    const org = await freshOrg()
    const monday = at('2026-11-23T02:00:00Z')
    const one = await submitted(org, 'req_con', '8000.00', monday)
    const id = await delegated(org, 'dm_con', 'asst_con', '2026-11-24T00:00:00+07:00', '2026-11-27T00:00:00+07:00', monday)
    expect(await startDelegationWindow(org.organizationId, id, at('2026-11-23T17:00:00Z'))).toEqual({ done: true, movedTasks: 1 })
    const tuesday = at('2026-11-24T03:00:00Z')
    expect(await deactivateMember(org.ctxOf('admin', tuesday), { memberId: org.member.asst_con!, reason: 'ลาออก' }, key())).toMatchObject({ ok: true, data: { revoked: { delegations: 1 } } })
    expect(await returnRevokedDelegationTasks(org.organizationId, id, tuesday)).toEqual({ done: true, movedTasks: 1 })
    const back = await openTaskOf(one.requestId)
    expect(back).toMatchObject({ assigneeMemberId: org.member.dm_con, principalMemberId: null, status: 'OPEN' })
    expect(await prisma.actionToken.findFirstOrThrow({ where: { taskId: back.id } })).toMatchObject({ memberId: org.member.dm_con, revokedAt: null })
    expect((await windowNotices(id)).filter((n) => n.phase === 'REVOKED').map((n) => [n.to, n.role, n.movedTasks])).toEqual([[org.member.dm_con, 'DELEGATOR', 1]])
  })

  it('keeps what the delegation does not cover, or what the delegate is tied to (BR-DLG-01, BR-DLG-05), and moves a question with its task', async () => {
    const org = await freshOrg()
    const monday = at('2026-10-26T02:00:00Z')
    const byDelegate = await submitted(org, 'asst_con', '7000.00', monday)
    const aboveCap = await submitted(org, 'req_con', '15000.00', monday)
    const asked = await submitted(org, 'req_con', '6000.00', monday)
    const plain = await submitted(org, 'req_con', '5000.00', monday)
    expect(await requestInfo(org.ctxOf('dm_con', at('2026-10-26T03:00:00Z')), { taskId: asked.task.id, question: 'ขอใบเสนอราคา' }, key())).toMatchObject({ ok: true })
    const id = await delegated(org, 'dm_con', 'asst_con', '2026-10-27T00:00:00+07:00', '2026-10-29T00:00:00+07:00', monday, { maxAmount: '10000.00' })

    expect(await startDelegationWindow(org.organizationId, id, at('2026-10-26T17:00:00Z'))).toEqual({ done: true, movedTasks: 2 })
    // BR-DLG-05: the delegate asked for it, so the delegator keeps it and ORG_ADMIN is told
    expect(await openTaskOf(byDelegate.requestId)).toMatchObject({ id: byDelegate.task.id, assigneeMemberId: org.member.dm_con, principalMemberId: null })
    expect(await prisma.notification.count({ where: { templateKey: 'approval_task.delegate_conflict', recipientMemberId: org.member.admin, subjectId: byDelegate.requestId } })).toBe(1)
    // BR-DLG-01: 15,000 is above the 10,000 the delegation covers
    expect(await openTaskOf(aboveCap.requestId)).toMatchObject({ id: aboveCap.task.id, assigneeMemberId: org.member.dm_con })
    expect(await openTaskOf(plain.requestId)).toMatchObject({ assigneeMemberId: org.member.asst_con, principalMemberId: org.member.dm_con })
    // The question waiting for the requester follows the task (as NEW-28 moves it for a new position holder)
    const movedAsked = await openTaskOf(asked.requestId)
    expect(movedAsked).toMatchObject({ assigneeMemberId: org.member.asst_con, status: 'INFO_REQUESTED', remainingBusinessMinutes: asked.task.dueAt ? expect.any(Number) : null })
    const info = await prisma.infoRequest.findFirstOrThrow({ where: { requestId: asked.requestId } })
    expect(info.taskId).toBe(movedAsked.id)
    expect(await provideInfo(org.ctxOf('req_con', at('2026-10-27T02:00:00Z')), { infoRequestId: info.id, answer: 'แนบแล้ว' }, key())).toMatchObject({ ok: true, data: { taskId: movedAsked.id } })
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: movedAsked.id } })).toMatchObject({ status: 'OPEN', assigneeMemberId: org.member.asst_con })
  })

  it('never passes on a task the delegator holds as someone else’s delegate (BR-DLG-02)', async () => {
    const org = await freshOrg()
    const monday = at('2026-11-16T02:00:00Z')
    await delegated(org, 'dm_fin', 'dm_con', '2026-11-16T00:00:00+07:00', '2026-11-21T00:00:00+07:00', at('2026-11-15T10:00:00Z'))
    const ofFinance = await submitted(org, 'fin_officer', '5000.00', monday)
    expect(ofFinance.task).toMatchObject({ assigneeMemberId: org.member.dm_con, principalMemberId: org.member.dm_fin })
    const id = await delegated(org, 'dm_con', 'asst_con', '2026-11-17T00:00:00+07:00', '2026-11-19T00:00:00+07:00', monday)
    expect(await startDelegationWindow(org.organizationId, id, at('2026-11-16T17:00:00Z'))).toEqual({ done: true, movedTasks: 0 })
    expect(await openTaskOf(ofFinance.requestId)).toMatchObject({ id: ofFinance.task.id, assigneeMemberId: org.member.dm_con, principalMemberId: org.member.dm_fin })
    // both sides still hear that the period started
    expect((await windowNotices(id)).map((n) => [n.role, n.movedTasks])).toEqual(
      expect.arrayContaining([
        ['DELEGATOR', 0],
        ['DELEGATE', 0],
      ]),
    )
  })

  it('a period that starts when another ends keeps the tasks with whoever acts next, whichever job runs first', async () => {
    const org = await freshOrg()
    const monday = at('2026-11-09T02:00:00Z')
    const one = await submitted(org, 'req_con', '8000.00', monday)
    const first = await delegated(org, 'dm_con', 'asst_con', '2026-11-10T00:00:00+07:00', '2026-11-12T00:00:00+07:00', monday)
    const second = await delegated(org, 'dm_con', 'asst_con', '2026-11-12T00:00:00+07:00', '2026-11-14T00:00:00+07:00', monday)
    const third = await delegated(org, 'dm_con', 'receiver_con', '2026-11-14T00:00:00+07:00', '2026-11-16T00:00:00+07:00', monday)
    expect(await startDelegationWindow(org.organizationId, first, at('2026-11-09T17:00:00Z'))).toEqual({ done: true, movedTasks: 1 })
    // Wednesday 00:00: the second period starts before the first one's end is handled; the task stays with asst_con
    expect(await startDelegationWindow(org.organizationId, second, at('2026-11-11T17:00:00Z'))).toEqual({ done: true, movedTasks: 0 })
    expect(await endDelegationWindow(org.organizationId, first, at('2026-11-11T17:00:00Z'))).toEqual({ done: true, movedTasks: 0 })
    expect(await openTaskOf(one.requestId)).toMatchObject({ assigneeMemberId: org.member.asst_con, principalMemberId: org.member.dm_con })
    // Friday 00:00: the end of the second is handled first; the task goes straight to the delegate of the third
    expect(await endDelegationWindow(org.organizationId, second, at('2026-11-13T17:00:00Z'))).toEqual({ done: true, movedTasks: 1 })
    expect(await openTaskOf(one.requestId)).toMatchObject({ assigneeMemberId: org.member.receiver_con, principalMemberId: org.member.dm_con })
    expect(await startDelegationWindow(org.organizationId, third, at('2026-11-13T17:00:00Z'))).toEqual({ done: true, movedTasks: 0 })
    expect(await endDelegationWindow(org.organizationId, third, at('2026-11-15T17:00:00Z'))).toEqual({ done: true, movedTasks: 1 })
    expect(await openTaskOf(one.requestId)).toMatchObject({ assigneeMemberId: org.member.dm_con, principalMemberId: null })
  })

  it('a revoked period ends at once: the tasks go back and the delegator is told; its end then does nothing', async () => {
    const org = await freshOrg()
    const monday = at('2026-11-02T02:00:00Z')
    const one = await submitted(org, 'req_con', '8000.00', monday)
    const id = await delegated(org, 'dm_con', 'asst_con', '2026-11-03T00:00:00+07:00', '2026-11-06T00:00:00+07:00', monday)
    expect(await returnRevokedDelegationTasks(org.organizationId, id, monday)).toMatchObject({ done: false, code: 'INVALID_STATE_TRANSITION' })
    expect(await startDelegationWindow(org.organizationId, id, at('2026-11-02T17:00:00Z'))).toEqual({ done: true, movedTasks: 1 })
    const wednesday = at('2026-11-04T02:00:00Z')
    expect(await revokeDelegation(org.ctxOf('dm_con', wednesday), { delegationId: id }, key())).toMatchObject({ ok: true })
    expect(await returnRevokedDelegationTasks(org.organizationId, id, wednesday)).toEqual({ done: true, movedTasks: 1 })
    expect(await openTaskOf(one.requestId)).toMatchObject({ assigneeMemberId: org.member.dm_con, principalMemberId: null })
    expect((await windowNotices(id)).filter((n) => n.phase === 'REVOKED').map((n) => [n.to, n.role, n.movedTasks])).toEqual([[org.member.dm_con, 'DELEGATOR', 1]])
    expect(await returnRevokedDelegationTasks(org.organizationId, id, at('2026-11-04T02:05:00Z'))).toEqual({ done: true, movedTasks: 1 })
    expect(await endDelegationWindow(org.organizationId, id, at('2026-11-05T17:00:00Z'))).toMatchObject({ done: false, reason: 'REVOKED' })
  })

  it('only the delegation-window job moves tasks: a member is refused', async () => {
    const org = await freshOrg()
    const monday = at('2026-10-05T02:00:00Z')
    const one = await submitted(org, 'req_con', '8000.00', monday)
    const id = await delegated(org, 'dm_con', 'asst_con', '2026-10-05T00:00:00+07:00', '2026-10-09T00:00:00+07:00', monday)
    for (const command of [startDelegationWindowCommand, endDelegationWindowCommand, returnRevokedTasksCommand]) {
      for (const who of ['dm_con', 'asst_con', 'admin']) {
        expect(await runCommand(org.ctxOf(who, at('2026-10-09T03:00:00Z')), command, { delegationId: id }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
      }
    }
    expect(await openTaskOf(one.requestId)).toMatchObject({ id: one.task.id, assigneeMemberId: org.member.dm_con })
    expect(await eventsOf(org, 'delegation.started', id)).toHaveLength(0)
  })

  it('the job sleeps until startsAt, starts, sleeps until endsAt, ends; a revocation cancels it and gives the tasks back', async () => {
    expect(delegationWindow.opts).toMatchObject({
      id: 'delegation-window',
      triggers: [{ event: 'bcs/delegation.created' }],
      cancelOn: [{ event: 'bcs/delegation.revoked', if: 'async.data.aggregateId == event.data.aggregateId' }],
    })
    expect(delegationRevoked.opts).toMatchObject({ id: 'delegation-revoked', triggers: [{ event: 'bcs/delegation.revoked' }] })
    const org = await freshOrg()
    const monday = at('2026-10-05T02:00:00Z')
    const one = await submitted(org, 'req_con', '8000.00', monday)
    // A period that has started already when it is set: the job's start comes at once
    const id = await delegated(org, 'dm_con', 'asst_con', '2026-10-05T00:00:00+07:00', '2026-10-07T00:00:00+07:00', at('2026-10-05T03:00:00Z'))
    const created = await prisma.event.findFirstOrThrow({ where: { type: 'delegation.created', aggregateId: id } })
    const clock = new ManualClock(at('2026-10-05T03:00:00Z'))
    const sleeps: string[] = []
    const step: TimerStep = {
      run: async (_id, fn) => fn(),
      sleepUntil: async (name, until) => {
        sleeps.push(`${name} ${until}`)
        if (new Date(until).getTime() > clock.now().getTime()) clock.set(until)
      },
      sleep: async (name, ms) => {
        sleeps.push(`${name} ${ms}`)
        clock.advance(ms)
      },
    }
    const run = await delegationWindowHandler(clock)({ data: { organizationId: org.organizationId, aggregateId: id, data: created.data } }, step)
    expect(sleeps).toEqual(['until-start 2026-10-04T17:00:00.000Z', 'until-end 2026-10-06T17:00:00.000Z'])
    expect(run).toEqual({ delegationId: id, started: { done: true, movedTasks: 1 }, ended: { done: true, movedTasks: 1 } })
    expect(await openTaskOf(one.requestId)).toMatchObject({ assigneeMemberId: org.member.dm_con, principalMemberId: null })
  })

  it('a run that wakes early by the application’s clock waits the time left; a start that fails after its retries still leaves the end to run', async () => {
    const org = await freshOrg()
    const monday = at('2026-10-05T02:00:00Z')
    const one = await submitted(org, 'req_con', '8000.00', monday)
    const id = await delegated(org, 'dm_con', 'asst_con', '2026-10-06T00:00:00+07:00', '2026-10-08T00:00:00+07:00', monday)
    const created = await prisma.event.findFirstOrThrow({ where: { type: 'delegation.created', aggregateId: id } })
    // Inngest's clock 3 seconds ahead of the application's
    const clock = new ManualClock(monday)
    const sleeps: string[] = []
    const runs: string[] = []
    const early: TimerStep = {
      run: async (name, fn) => {
        runs.push(name)
        return fn()
      },
      sleepUntil: async (name, until) => {
        sleeps.push(`${name} ${until}`)
        clock.set(new Date(new Date(until).getTime() - 3_000))
      },
      sleep: async (name, ms) => {
        sleeps.push(`${name} ${ms}`)
        clock.advance(ms)
      },
    }
    const run = await delegationWindowHandler(clock)({ data: { organizationId: org.organizationId, aggregateId: id, data: created.data } }, early)
    expect(run).toEqual({ delegationId: id, started: { done: true, movedTasks: 1 }, ended: { done: true, movedTasks: 1 } })
    expect(runs).toEqual(['start', 'start-1', 'end', 'end-1'])
    expect(sleeps).toEqual(['until-start 2026-10-05T17:00:00.000Z', 'wait-start-1 3000', 'until-end 2026-10-07T17:00:00.000Z', 'wait-end-1 3000'])
    expect(await openTaskOf(one.requestId)).toMatchObject({ assigneeMemberId: org.member.dm_con, principalMemberId: null, assignedAt: at('2026-10-07T17:00:00Z') })

    // A start whose step failed after Inngest's retries (StepError): the tasks routing gave the delegate meanwhile
    // still go back at the end
    const other = await freshOrg()
    const second = await delegated(other, 'dm_con', 'asst_con', '2026-10-06T00:00:00+07:00', '2026-10-08T00:00:00+07:00', monday)
    const during = await submitted(other, 'req_con', '7000.00', at('2026-10-06T02:00:00Z'))
    expect(during.task).toMatchObject({ assigneeMemberId: other.member.asst_con, principalMemberId: other.member.dm_con })
    const createdSecond = await prisma.event.findFirstOrThrow({ where: { type: 'delegation.created', aggregateId: second } })
    const clock2 = new ManualClock(monday)
    const failing: TimerStep = {
      run: async (name, fn) => {
        if (name === 'start') throw new StepError(name, new Error('still busy after the retries'))
        return fn()
      },
      sleepUntil: async (_name, until) => clock2.set(until),
      sleep: async (_name, ms) => clock2.advance(ms),
    }
    const failed = await delegationWindowHandler(clock2)({ data: { organizationId: other.organizationId, aggregateId: second, data: createdSecond.data } }, failing)
    expect(failed).toEqual({ delegationId: second, started: { done: false, code: 'INTERNAL', reason: 'STEP_FAILED', notBefore: null, waitMs: null }, ended: { done: true, movedTasks: 1 } })
    expect(await openTaskOf(during.requestId)).toMatchObject({ assigneeMemberId: other.member.dm_con, principalMemberId: null })
    expect(await prisma.delegation.findUniqueOrThrow({ where: { id: second } })).toMatchObject({ status: 'ENDED' })
  })
})
