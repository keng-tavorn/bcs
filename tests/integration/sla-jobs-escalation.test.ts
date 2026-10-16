import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { ManualClock } from '@/lib/clock'
import { systemCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { approvalTaskSlaHandler, type TimerStep } from '@/server/jobs/approval-task-sla'
import { renderNotification } from '@/server/notifications/templates'
import { runCommand } from '@/server/services/_pipeline'
import { decideTask, provideInfo, requestInfo } from '@/server/services/approvals/decide'
import { createDraft, submitRequest } from '../support/requests'
import { escalateTask, markTaskOverdue, planTaskSla, remindTaskSla } from '@/server/services/sla'
import { escalateTaskCommand } from '@/server/services/sla/task-sla'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { createTwoStepOrg } from '../support/two-step-doa'

// Escalation past escalateAt (spec BR-SLA-04, FR-NOTI-003 AC2, S5-08) on the §7.4 fixture organization: the approver
// of the next amount band joins the step as co-assignee — on any step of the route (NEW-47) — whoever decides first
// decides and the step's other open task is cancelled, the decision keeps the route's own DOA reference, and with no
// band above ORG_ADMIN and the requester are told. A task never goes to lower authority. Times: a request submitted
// Monday 5 Oct 2026 09:00 Thai time is due 17:00 and escalated Tuesday 16:00 (8 business hours later,
// escalationPolicy.escalateAfterBusinessHours).

const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const at = (iso: string) => new Date(iso)
const MON_0900 = at('2026-10-05T02:00:00Z')
/** escalateAt of an 8-hour task assigned at MON_0900 */
const TUE_1600 = at('2026-10-06T09:00:00Z')

let org: DoaOrg
beforeAll(async () => {
  setDefaultOutboxSender(null)
  org = await createDoaOrg()
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: at('2026-01-01T00:00:00Z') } })
})

/** `chargedTo`: the budget line of that department pays (BR-DOA-05), through a budget grant to the requester (FR-BUD-004) */
async function submitted(target: DoaOrg, requester: string, grossBaht: string, when: Date, options: { chargedTo?: string } = {}) {
  let budgetLineId: string | undefined
  if (options.chargedTo) {
    const line = await prisma.budgetLine.findFirstOrThrow({ where: { organizationId: target.organizationId, departmentId: target.department[options.chargedTo]! } })
    await prisma.budgetGrant.create({ data: { organizationId: target.organizationId, budgetLineId: line.id, granteeMemberId: target.member[requester]!, validFrom: at('2026-01-01T00:00:00Z'), grantedById: target.member.admin! } })
    budgetLineId = line.id
  }
  const draft = await createDraft(
    target.ctxOf(requester, when),
    {
      requestTypeCode: 'BUY_GOODS',
      title: 'วัสดุก่อสร้าง',
      priceIncludesVat: true,
      ...(budgetLineId ? { budgetLineId, chargedDepartmentId: target.department[options.chargedTo!]! } : {}),
      lines: [{ description: 'ปูนซีเมนต์', quantity: '1', uom: 'งาน', unitPrice: grossBaht }],
    },
    key(),
  )
  if (!draft.ok) throw new Error(`draft failed: ${JSON.stringify(draft.error)}`)
  const requestId = draft.data.requestId
  for (let i = 0; i < 3; i++) {
    const file = await prisma.fileObject.create({ data: { organizationId: target.organizationId, storageKey: `test/${randomUUID()}.pdf`, fileName: 'q.pdf', mimeType: 'application/pdf', sizeBytes: 1, status: 'AVAILABLE', uploadedById: target.member[requester]! } })
    await prisma.fileLink.create({ data: { organizationId: target.organizationId, fileId: file.id, subjectType: 'Request', subjectId: requestId, kind: 'QUOTATION' } })
  }
  const sent = await submitRequest(target.ctxOf(requester, when), { requestId }, key())
  if (!sent.ok) throw new Error(`submit failed: ${JSON.stringify(sent.error)}`)
  const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: requestId } } }, include: { step: { include: { route: true } } } })
  return { requestId, task }
}

/** An organization of its own (a test that changes who holds a position must not touch the others) */
async function freshOrg(): Promise<DoaOrg> {
  const own = await createDoaOrg()
  await prisma.roleAssignment.create({ data: { organizationId: own.organizationId, memberId: own.member.admin!, role: 'ORG_ADMIN', grantedAt: at('2026-01-01T00:00:00Z') } })
  return own
}

/** A fake Inngest step: run() runs at once, the sleeps move the clock forward */
function fakeStep(clock: ManualClock) {
  const runs: string[] = []
  const step: TimerStep = {
    run: async (id, fn) => {
      runs.push(id)
      return fn()
    },
    sleepUntil: async (_id, until) => {
      if (new Date(until).getTime() > clock.now().getTime()) clock.set(until)
    },
    sleep: async (_id, ms) => clock.advance(ms),
  }
  return { step, runs }
}

const tasksOfStep = (stepId: string) => prisma.approvalTask.findMany({ where: { stepId }, orderBy: { createdAt: 'asc' } })
const escalatedEvents = (taskId: string) => prisma.event.findMany({ where: { organizationId: org.organizationId, type: 'approval_task.escalated', aggregateId: taskId } })
const cancelledOf = (taskId: string) => prisma.event.findMany({ where: { type: 'approval_task.cancelled', aggregateId: taskId }, orderBy: { seq: 'asc' } })
const toldOf = async (subjectId: string) =>
  (await prisma.notification.findMany({ where: { templateKey: 'task.escalated', subjectId }, orderBy: { dedupeKey: 'asc' } })).map((n) => ({ to: n.recipientMemberId, ...(n.data as { role: string; taskId: string; outcome: string }) }))

describe('[FR-NOTI-003/AC2] past escalateAt the approver of the next band joins as co-assignee (BR-SLA-04)', () => {
  it('adds the VP of OPS to a DM task of PR-01 with the DOA reference kept, records approval_task.escalated and tells all three', async () => {
    const { requestId, task } = await submitted(org, 'req_con', '10000.00', MON_0900)
    expect(task).toMatchObject({ assigneeMemberId: org.member.dm_con, resolvedFrom: 'POSITION:DM@CON' })
    expect(await escalateTask(org.organizationId, task.id, at('2026-10-06T08:59:00Z'))).toMatchObject({ done: false, reason: 'NOT_DUE' })
    const escalated = await escalateTask(org.organizationId, task.id, TUE_1600)
    expect(escalated).toMatchObject({ done: true, outcome: 'CO_ASSIGNED' })
    const [original, co] = await tasksOfStep(task.stepId)
    expect(original).toMatchObject({ id: task.id, status: 'OPEN', assigneeMemberId: org.member.dm_con, escalatedAt: TUE_1600, escalateAt: TUE_1600 })
    expect(co).toMatchObject({ id: escalated.coAssigneeTaskId, status: 'OPEN', assigneeMemberId: org.member.vp_ops, principalMemberId: null, resolvedFrom: 'POSITION:VP@OPS', escalatedAt: TUE_1600, dueAt: task.dueAt })
    const [event] = await escalatedEvents(task.id)
    // The route's own DOA reference, on the event's columns and in its data
    expect(event).toMatchObject({ actorType: 'SYSTEM', channel: 'SYSTEM', doaVersionId: task.step.route.doaVersionId, doaRuleCode: 'PR-01' })
    expect(event!.data).toEqual({
      subjectType: 'REQUEST',
      subjectId: requestId,
      stepId: task.stepId,
      outcome: 'CO_ASSIGNED',
      reason: null,
      coAssigneeTaskId: co!.id,
      coAssigneeMemberId: org.member.vp_ops,
      coAssigneePrincipalMemberId: null,
      resolvedFrom: 'POSITION:VP@OPS',
      doaVersionId: task.step.route.doaVersionId,
      doaRuleCode: 'PR-01',
      nextRuleCode: 'PR-02',
    })
    // §10.1: the new co-assignee (their own task), the assignee and the requester
    expect(await toldOf(requestId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ to: org.member.vp_ops, role: 'CO_ASSIGNEE', taskId: co!.id, outcome: 'CO_ASSIGNED' }),
        expect.objectContaining({ to: org.member.dm_con, role: 'ASSIGNEE', taskId: task.id }),
        expect.objectContaining({ to: org.member.req_con, role: 'REQUESTER' }),
      ]),
    )
    expect(await toldOf(requestId)).toHaveLength(3)
    // In the reader's language, with the link to the co-assignee's own task (BR-NOTI-02, BR-NOTI-03)
    const coNote = await prisma.notification.findFirstOrThrow({ where: { templateKey: 'task.escalated', subjectId: requestId, recipientMemberId: org.member.vp_ops } })
    const number = (coNote.data as { number: string }).number
    expect(number).toMatch(/^PR-2569-\d{5}$/)
    expect(renderNotification(coNote, 'th')).toEqual({ title: `ส่งต่อถึงคุณ: ${number} เลยกำหนด โปรดพิจารณา`, body: 'ผู้อนุมัติเดิมยังตัดสินได้ ผู้ที่ตัดสินก่อนเป็นผู้ตัดสิน', href: `/tasks/${co!.id}` })
    expect(renderNotification(coNote, 'en')).toMatchObject({ title: `Escalated to you: ${number} is overdue, please decide`, href: `/tasks/${co!.id}` })
    const requesterNote = await prisma.notification.findFirstOrThrow({ where: { templateKey: 'task.escalated', subjectId: requestId, recipientMemberId: org.member.req_con } })
    expect(renderNotification(requesterNote, 'th')).toMatchObject({ href: `/requests/${requestId}` })
    // The co-assignee's task is assigned in its own right: its own event (BR-TOK-01 gives it its e-mail decision link)
    const assigned = await prisma.event.findFirstOrThrow({ where: { type: 'approval_task.assigned', aggregateId: co!.id } })
    expect(assigned.data).toEqual({ subjectType: 'REQUEST', subjectId: requestId, routeId: task.step.routeId, stepNo: 1, assigneeMemberId: org.member.vp_ops, principalMemberId: null, resolvedFrom: 'POSITION:VP@OPS', dueAt: task.dueAt!.toISOString() })
    expect(await prisma.actionToken.findFirstOrThrow({ where: { taskId: co!.id } })).toMatchObject({ memberId: org.member.vp_ops, channel: 'EMAIL', revokedAt: null, usedAt: null })
    // A retry repeats nothing
    expect(await escalateTask(org.organizationId, task.id, at('2026-10-06T09:05:00Z'))).toMatchObject({ done: true, outcome: 'CO_ASSIGNED', coAssigneeTaskId: co!.id })
    expect(await tasksOfStep(task.stepId)).toHaveLength(2)
    expect(await escalatedEvents(task.id)).toHaveLength(1)
    expect(await prisma.actionToken.count({ where: { taskId: co!.id } })).toBe(1)

    // Whoever decides first decides: the co-assignee approves under PR-01, the assignee's task is cancelled
    expect(await decideTask(org.ctxOf('vp_ops', at('2026-10-06T09:30:00Z')), { taskId: co!.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: true, data: { documentStatus: 'APPROVED' } })
    const decided = await prisma.event.findFirstOrThrow({ where: { type: 'approval_task.decided', aggregateId: co!.id } })
    expect(decided).toMatchObject({ doaVersionId: task.step.route.doaVersionId, doaRuleCode: 'PR-01' })
    expect(decided.data).toMatchObject({ actorMemberId: org.member.vp_ops, doaRuleCode: 'PR-01' })
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'CANCELLED' })
    // …by the decision of its step, before the route closed (NEW-47): one cancellation, why CO_ASSIGNEE_DECIDED
    expect((await cancelledOf(task.id)).map((e) => e.data)).toEqual([{ subjectId: requestId, why: 'CO_ASSIGNEE_DECIDED' }])
    expect(await decideTask(org.ctxOf('dm_con', at('2026-10-06T09:40:00Z')), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({
      ok: false,
      error: { code: 'INVALID_STATE_TRANSITION', details: { from: 'CANCELLED', name: 'ผู้ใช้ vp_ops', time: '2026-10-06T09:30:00.000Z' } },
    })
  })

  it('the first approver may still decide first: the co-assignee task is cancelled with its links and refused', async () => {
    const { requestId, task } = await submitted(org, 'req_con', '11000.00', MON_0900)
    const { coAssigneeTaskId } = await escalateTask(org.organizationId, task.id, TUE_1600)
    const version = (await prisma.approvalTask.findUniqueOrThrow({ where: { id: coAssigneeTaskId! } })).version
    expect(await decideTask(org.ctxOf('dm_con', at('2026-10-06T09:30:00Z')), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: true, data: { documentStatus: 'APPROVED' } })
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: coAssigneeTaskId! } })).toMatchObject({ status: 'CANCELLED', decision: null, decidedAt: null, version: version + 1 })
    expect((await cancelledOf(coAssigneeTaskId!)).map((e) => e.data)).toEqual([{ subjectId: requestId, why: 'CO_ASSIGNEE_DECIDED' }])
    // BR-TOK-01: the co-assignee's decision link dies with their task
    expect(await prisma.actionToken.findFirstOrThrow({ where: { taskId: coAssigneeTaskId! } })).toMatchObject({ revokedAt: at('2026-10-06T09:30:00Z') })
    // FR-DOA-004 AC2: refused with who decided the step and when
    expect(await decideTask(org.ctxOf('vp_ops', at('2026-10-06T09:40:00Z')), { taskId: coAssigneeTaskId!, decision: 'APPROVE' }, key())).toMatchObject({
      ok: false,
      error: { code: 'INVALID_STATE_TRANSITION', details: { from: 'CANCELLED', name: 'ผู้ใช้ dm_con', time: '2026-10-06T09:30:00.000Z' } },
    })
    expect(await prisma.request.findUniqueOrThrow({ where: { id: requestId } })).toMatchObject({ status: 'APPROVED' })
  })

  it('the co-assignee task is born overdue and escalated: its own SLA run sends nothing again', async () => {
    const { requestId, task } = await submitted(org, 'req_con', '11500.00', MON_0900)
    expect(await markTaskOverdue(org.organizationId, task.id, at('2026-10-05T10:00:00Z'))).toMatchObject({ done: true })
    const { coAssigneeTaskId } = await escalateTask(org.organizationId, task.id, TUE_1600)
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: coAssigneeTaskId! } })).toMatchObject({ overdueAt: at('2026-10-05T10:00:00Z'), escalateAt: TUE_1600, escalatedAt: TUE_1600, remindAt: null })
    const before = await prisma.notification.count({ where: { subjectId: requestId } })
    // approval_task.assigned of the co-assignee task starts a run of its own at once
    const clock = new ManualClock(TUE_1600)
    const { step, runs } = fakeStep(clock)
    const run = await approvalTaskSlaHandler(clock)({ data: { organizationId: org.organizationId, aggregateId: coAssigneeTaskId! } }, step)
    expect(run).toEqual({ taskId: coAssigneeTaskId, reminded: false, overdue: true, escalated: null, stopped: 'ALREADY_ESCALATED' })
    expect(runs).toEqual(['plan', 'overdue', 'escalate'])
    expect(await prisma.notification.count({ where: { subjectId: requestId } })).toBe(before)
    expect(await prisma.event.count({ where: { aggregateId: coAssigneeTaskId!, type: { in: ['approval_task.overdue', 'approval_task.escalated'] } } })).toBe(0)
    expect(await tasksOfStep(task.stepId)).toHaveLength(2)
  })

  it('never to lower authority: a VP task of PR-02 goes up to the CEO of PR-03', async () => {
    const { requestId, task } = await submitted(org, 'req_con', '50000.00', MON_0900)
    expect(task).toMatchObject({ assigneeMemberId: org.member.vp_ops })
    const escalated = await escalateTask(org.organizationId, task.id, TUE_1600)
    expect(escalated).toMatchObject({ done: true, outcome: 'CO_ASSIGNED' })
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: escalated.coAssigneeTaskId! } })).toMatchObject({ assigneeMemberId: org.member.ceo, resolvedFrom: 'POSITION:CEO@HQ' })
    expect((await escalatedEvents(task.id))[0]!.data).toMatchObject({ doaRuleCode: 'PR-02', nextRuleCode: 'PR-03' })
    expect(await toldOf(requestId)).toHaveLength(3)
  })

  it('with no band above PR-03 nobody is added: ORG_ADMIN and the requester are told', async () => {
    // 16 business hours: due Tuesday 16:00, escalated Wednesday 15:00
    const { requestId, task } = await submitted(org, 'req_con', '150000.00', MON_0900)
    expect(task).toMatchObject({ assigneeMemberId: org.member.ceo, dueAt: at('2026-10-06T09:00:00Z') })
    expect(await markTaskOverdue(org.organizationId, task.id, at('2026-10-06T09:00:00Z'))).toEqual({ done: true, escalateAt: '2026-10-07T08:00:00.000Z' })
    // the overdue notice has no next band to acknowledge it
    expect((await prisma.event.findFirstOrThrow({ where: { type: 'approval_task.overdue', aggregateId: task.id } })).data).toMatchObject({ nextBandMemberId: null })
    expect(await escalateTask(org.organizationId, task.id, at('2026-10-07T08:00:00Z'))).toMatchObject({ done: true, outcome: 'NO_NEXT_BAND', coAssigneeTaskId: null })
    expect(await tasksOfStep(task.stepId)).toHaveLength(1)
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'OPEN', escalatedAt: at('2026-10-07T08:00:00Z') })
    expect((await escalatedEvents(task.id))[0]!.data).toMatchObject({ outcome: 'NO_NEXT_BAND', reason: 'NO_HIGHER_BAND', coAssigneeTaskId: null, coAssigneeMemberId: null, doaRuleCode: 'PR-03', nextRuleCode: null })
    const told = await toldOf(requestId)
    expect(told).toEqual(
      expect.arrayContaining([expect.objectContaining({ to: org.member.admin, role: 'ADMIN', outcome: 'NO_NEXT_BAND' }), expect.objectContaining({ to: org.member.req_con, role: 'REQUESTER', outcome: 'NO_NEXT_BAND' })]),
    )
    expect(told).toHaveLength(2)
  })

  it('passes over a next band whose approver is tied to the document (BR-DOA-06): the VP who asked → the CEO', async () => {
    // vp_ops asks for 10,000 charged to CON: PR-01 goes to dm_con; PR-02 would be vp_ops, the requester, so PR-03
    const { task } = await submitted(org, 'vp_ops', '10000.00', MON_0900, { chargedTo: 'CON' })
    expect(task).toMatchObject({ assigneeMemberId: org.member.dm_con })
    const escalated = await escalateTask(org.organizationId, task.id, TUE_1600)
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: escalated.coAssigneeTaskId! } })).toMatchObject({ assigneeMemberId: org.member.ceo })
    expect((await escalatedEvents(task.id))[0]!.data).toMatchObject({ doaRuleCode: 'PR-01', nextRuleCode: 'PR-03' })
  })

  it('escalates a step once: neither another run nor the co-assignee task escalates it again', async () => {
    const { task } = await submitted(org, 'req_con', '12000.00', MON_0900)
    const first = await escalateTask(org.organizationId, task.id, TUE_1600)
    const again = (taskId: string) => runCommand(systemCtx(org.organizationId, at('2026-10-07T09:00:00Z'), 'approval-task-sla'), escalateTaskCommand, { taskId }, key())
    expect(await again(task.id)).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION', details: { reason: 'ALREADY_ESCALATED' } } })
    expect(await again(first.coAssigneeTaskId!)).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION', details: { reason: 'ALREADY_ESCALATED' } } })
    expect(await tasksOfStep(task.stepId)).toHaveLength(2)
  })

  it('a vacant next band adds nobody: the administrators hear that the position is empty, not that no band exists', async () => {
    const own = await freshOrg()
    // Nobody holds VP of OPS from 1 Oct (PR-02 for a request of CON)
    await prisma.positionAssignment.updateMany({ where: { organizationId: own.organizationId, memberId: own.member.vp_ops! }, data: { validTo: at('2026-10-01T00:00:00Z') } })
    const { requestId, task } = await submitted(own, 'req_con', '10000.00', MON_0900)
    expect(await markTaskOverdue(own.organizationId, task.id, at('2026-10-05T10:00:00Z'))).toMatchObject({ done: true })
    // no one to acknowledge it either
    expect(await prisma.notification.count({ where: { templateKey: 'task.overdue', subjectId: requestId, data: { path: ['role'], equals: 'ACK' } } })).toBe(0)
    expect(await escalateTask(own.organizationId, task.id, TUE_1600)).toMatchObject({ done: true, outcome: 'NO_NEXT_BAND' })
    expect((await prisma.event.findFirstOrThrow({ where: { type: 'approval_task.escalated', aggregateId: task.id } })).data).toMatchObject({ reason: 'APPROVER_NOT_FOUND', nextRuleCode: 'PR-02' })
    const adminNote = await prisma.notification.findFirstOrThrow({ where: { templateKey: 'task.escalated', subjectId: requestId, recipientMemberId: own.member.admin } })
    expect(adminNote.data).toMatchObject({ role: 'ADMIN', outcome: 'NO_NEXT_BAND', reason: 'APPROVER_NOT_FOUND' })
    const number = (adminNote.data as { number: string }).number
    // What the administrator can do in this build: appoint the vacant position through an authority change, and follow
    // up — nothing moves a task by hand, and the step does not escalate again (ADR-048 item 4)
    expect(renderNotification(adminNote, 'th')).toEqual({
      title: `${number} เลยกำหนด แต่ตำแหน่งผู้อนุมัติระดับถัดไปไม่มีผู้ดำรงตำแหน่ง`,
      body: 'โปรดแต่งตั้งผู้ดำรงตำแหน่งที่ว่างได้ที่หน้าเปลี่ยนโครงสร้างอำนาจ งานนี้จะไม่ถูกส่งต่ออีก โปรดติดตามกับผู้อนุมัติ',
      href: `/requests/${requestId}`,
    })
    expect(renderNotification(adminNote, 'en')).toMatchObject({ title: `${number} is overdue, but no one holds the position of the next approval level` })
  })

  it('the next band holder on leave: their delegate gets the co-assignee task on their behalf (BR-DLG-04)', async () => {
    // vp_ops delegates to dm_proc from 19 to 23 Oct; a request of Monday 19 Oct escalates on Tuesday 20 Oct
    await prisma.delegation.create({
      data: { organizationId: org.organizationId, delegatorMemberId: org.member.vp_ops!, delegateMemberId: org.member.dm_proc!, startsAt: at('2026-10-19T00:00:00Z'), endsAt: at('2026-10-23T00:00:00Z'), documentTypes: [], reason: 'ลาพักร้อน', status: 'ACTIVE', createdVia: 'SELF' },
    })
    const { task } = await submitted(org, 'req_con', '13000.00', at('2026-10-19T02:00:00Z'))
    const escalated = await escalateTask(org.organizationId, task.id, at('2026-10-20T09:00:00Z'))
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: escalated.coAssigneeTaskId! } })).toMatchObject({ assigneeMemberId: org.member.dm_proc, principalMemberId: org.member.vp_ops, resolvedFrom: 'POSITION:VP@OPS' })
    expect((await escalatedEvents(task.id))[0]!.data).toMatchObject({ coAssigneeMemberId: org.member.dm_proc, coAssigneePrincipalMemberId: org.member.vp_ops })
  })
})

describe('[FR-NOTI-003/AC2] a step with steps after it gets its co-assignee too, and its first decision decides it (BR-SLA-04, NEW-47)', () => {
  // DOA-TWO-STEP (tests/support/two-step-doa.ts): PR-01 is the DM of CON, then the VP of OPS; the band above (PR-02) ends
  // with the COO, who joins step 1 when it escalates. Step 1 of a request sent Monday 09:00 is due 17:00 and escalated
  // Tuesday 16:00; a decision on Tuesday at 16:30 starts step 2, due 8 business hours later (Wednesday 15:30) and
  // reminded half way (Wednesday 11:30), escalated 8 business hours after that (Thursday 14:30).
  const DECIDED = at('2026-10-06T09:30:00Z')
  const LATE = at('2026-10-06T09:40:00Z')
  const stepsOf = (routeId: string) => prisma.approvalStep.findMany({ where: { routeId }, orderBy: { stepNo: 'asc' } })
  const tasksOfRoute = (routeId: string, stepNo: number) => prisma.approvalTask.findMany({ where: { step: { routeId, stepNo } }, orderBy: { createdAt: 'asc' } })

  it('step 1 of DM then VP: the COO joins it and decides first; the DM is cancelled and refused, and step 2 starts with its own task and timers', async () => {
    const own = await createTwoStepOrg()
    const { requestId, task } = await submitted(own, 'req_con', '10000.00', MON_0900)
    expect(task).toMatchObject({ assigneeMemberId: own.member.dm_con, resolvedFrom: 'POSITION:DM@CON' })
    expect((await stepsOf(task.step.routeId)).map((s) => s.status)).toEqual(['ACTIVE', 'WAITING'])
    // At dueAt the band above hears of it, and that escalation follows: a step with steps after it escalates too
    expect(await markTaskOverdue(own.organizationId, task.id, at('2026-10-05T10:00:00Z'))).toMatchObject({ done: true })
    const ack = await prisma.notification.findFirstOrThrow({ where: { templateKey: 'task.overdue', subjectId: requestId, recipientMemberId: own.member.coo } })
    expect(ack.data).toMatchObject({ role: 'ACK', willEscalate: true })
    expect(renderNotification(ack, 'th').body).toBe('ถ้ายังไม่มีผู้ตัดสิน งานนี้จะส่งต่อให้ผู้อนุมัติระดับถัดไปร่วมพิจารณา')

    const escalated = await escalateTask(own.organizationId, task.id, TUE_1600)
    expect(escalated).toMatchObject({ done: true, outcome: 'CO_ASSIGNED' })
    const [, co] = await tasksOfStep(task.stepId)
    expect(co).toMatchObject({ id: escalated.coAssigneeTaskId, status: 'OPEN', assigneeMemberId: own.member.coo, resolvedFrom: 'POSITION:COO@HQ', escalatedAt: TUE_1600 })
    expect((await prisma.event.findFirstOrThrow({ where: { type: 'approval_task.escalated', aggregateId: task.id } })).data).toMatchObject({
      outcome: 'CO_ASSIGNED',
      reason: null,
      coAssigneeMemberId: own.member.coo,
      doaRuleCode: 'PR-01',
      nextRuleCode: 'PR-02',
    })
    expect((await toldOf(requestId)).map((t) => [t.to, t.role])).toEqual(
      expect.arrayContaining([
        [own.member.coo, 'CO_ASSIGNEE'],
        [own.member.dm_con, 'ASSIGNEE'],
        [own.member.req_con, 'REQUESTER'],
      ]),
    )
    const version = (await prisma.approvalTask.findUniqueOrThrow({ where: { id: task.id } })).version

    // The COO decides first: step 1 is done, and the DM's task is cancelled with its link, its timers stopped
    expect(await decideTask(own.ctxOf('coo', DECIDED), { taskId: co!.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: true, data: { documentStatus: 'PENDING_APPROVAL' } })
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'CANCELLED', decision: null, decidedAt: null, version: version + 1 })
    expect((await cancelledOf(task.id)).map((e) => e.data)).toEqual([{ subjectId: requestId, why: 'CO_ASSIGNEE_DECIDED' }])
    expect((await prisma.actionToken.findMany({ where: { taskId: task.id } })).map((t) => t.revokedAt)).toEqual([DECIDED])
    // approval-task-sla is cancelled by approval_task.cancelled of the same task (cancelOn), sent through the outbox,
    // and a run still sleeping finds no timers left (FR-NOTI-003 AC3)
    expect(await prisma.outbox.count({ where: { organizationId: own.organizationId, eventName: 'bcs/approval_task.cancelled', payload: { path: ['aggregateId'], equals: task.id } } })).toBe(1)
    expect(await planTaskSla(own.organizationId, task.id, DECIDED)).toMatchObject({ open: false, status: 'CANCELLED' })
    expect(await remindTaskSla(own.organizationId, task.id, LATE)).toMatchObject({ done: false, reason: 'CLOSED' })

    // A late decision by the DM — approve, return, reject or a question — is refused with who decided the step and when
    const refused = { ok: false, error: { code: 'INVALID_STATE_TRANSITION', details: { from: 'CANCELLED', name: 'ผู้ใช้ coo', time: DECIDED.toISOString() } } }
    expect(await decideTask(own.ctxOf('dm_con', LATE), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject(refused)
    expect(await decideTask(own.ctxOf('dm_con', LATE), { taskId: task.id, decision: 'RETURN', reason: 'ขอใบเสนอราคาใหม่' }, key())).toMatchObject(refused)
    expect(await decideTask(own.ctxOf('dm_con', LATE), { taskId: task.id, decision: 'REJECT', reason: 'ไม่จำเป็น' }, key())).toMatchObject(refused)
    expect(await requestInfo(own.ctxOf('dm_con', LATE), { taskId: task.id, question: 'ขอรายละเอียดเพิ่ม' }, key())).toMatchObject(refused)
    expect(await prisma.event.count({ where: { type: 'approval_task.decided', aggregateId: task.id } })).toBe(0)

    // Step 2 starts as any step does: the VP's own task, due from the decision, with a reminder and nothing escalated
    expect((await stepsOf(task.step.routeId)).map((s) => s.status)).toEqual(['DONE', 'ACTIVE'])
    const step2 = await tasksOfRoute(task.step.routeId, 2)
    expect(step2).toHaveLength(1)
    expect(step2[0]).toMatchObject({ status: 'OPEN', assigneeMemberId: own.member.vp_ops, assignedAt: DECIDED, remindAt: at('2026-10-07T04:30:00Z'), dueAt: at('2026-10-07T08:30:00Z'), overdueAt: null, escalatedAt: null })
    expect((await prisma.event.findFirstOrThrow({ where: { type: 'approval_task.assigned', aggregateId: step2[0]!.id } })).data).toMatchObject({ stepNo: 2, assigneeMemberId: own.member.vp_ops })
    expect(await planTaskSla(own.organizationId, step2[0]!.id, DECIDED)).toEqual({
      taskId: step2[0]!.id,
      status: 'OPEN',
      open: true,
      remindAt: '2026-10-07T04:30:00.000Z',
      dueAt: '2026-10-07T08:30:00.000Z',
      escalateAt: '2026-10-08T07:30:00.000Z',
    })
    // …and it is escalated by its own timer, once per step. The band above ends with the COO, who decided step 1: one
    // person must not approve two steps of the route (NEW-47), so the COO is passed over upwards and the CEO joins
    expect(await escalateTask(own.organizationId, step2[0]!.id, at('2026-10-08T07:29:00Z'))).toMatchObject({ done: false, reason: 'NOT_DUE' })
    expect(await escalateTask(own.organizationId, step2[0]!.id, at('2026-10-08T07:30:00Z'))).toMatchObject({ done: true, outcome: 'CO_ASSIGNED' })
    expect((await tasksOfRoute(task.step.routeId, 2)).map((t) => t.assigneeMemberId)).toEqual([own.member.vp_ops, own.member.ceo])
    expect((await prisma.event.findFirstOrThrow({ where: { type: 'approval_task.escalated', aggregateId: step2[0]!.id } })).data).toMatchObject({
      outcome: 'CO_ASSIGNED',
      coAssigneeMemberId: own.member.ceo,
      doaRuleCode: 'PR-01',
      nextRuleCode: 'PR-03',
    })
    expect(await prisma.request.findUniqueOrThrow({ where: { id: requestId } })).toMatchObject({ status: 'PENDING_APPROVAL' })
  })

  it('the band above ends with the approver of step 2: the VP is passed over for the CEO at step 1, and step 2 finds nobody left above', async () => {
    // PR-01 is the DM then the VP; PR-02 keeps its one step, the VP — who holds step 2 of this very route already
    const own = await createTwoStepOrg({ secondSteps: ['PR-01'] })
    const { requestId, task } = await submitted(own, 'req_con', '10000.00', MON_0900)
    expect(await markTaskOverdue(own.organizationId, task.id, at('2026-10-05T10:00:00Z'))).toMatchObject({ done: true })
    // the acknowledgement goes to whoever would be added: the CEO, not the VP
    expect((await prisma.event.findFirstOrThrow({ where: { type: 'approval_task.overdue', aggregateId: task.id } })).data).toMatchObject({ nextBandMemberId: own.member.ceo })
    const escalated = await escalateTask(own.organizationId, task.id, TUE_1600)
    expect(escalated).toMatchObject({ done: true, outcome: 'CO_ASSIGNED' })
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: escalated.coAssigneeTaskId! } })).toMatchObject({ assigneeMemberId: own.member.ceo, resolvedFrom: 'POSITION:CEO@HQ' })
    expect((await prisma.event.findFirstOrThrow({ where: { type: 'approval_task.escalated', aggregateId: task.id } })).data).toMatchObject({ doaRuleCode: 'PR-01', nextRuleCode: 'PR-03', coAssigneeMemberId: own.member.ceo })

    // The CEO decides step 1; step 2 goes to the VP as the route says
    expect(await decideTask(own.ctxOf('ceo', DECIDED), { taskId: escalated.coAssigneeTaskId!, decision: 'APPROVE' }, key())).toMatchObject({ ok: true, data: { documentStatus: 'PENDING_APPROVAL' } })
    const [step2] = await tasksOfRoute(task.step.routeId, 2)
    expect(step2).toMatchObject({ status: 'OPEN', assigneeMemberId: own.member.vp_ops })
    // Step 2 past its escalation time: the VP decides it already and the CEO decided step 1 — nobody may be added, so
    // ORG_ADMIN and the requester are told, as when there is no band above (BR-SLA-04)
    const plan = await planTaskSla(own.organizationId, step2!.id, DECIDED)
    expect(await escalateTask(own.organizationId, step2!.id, new Date(plan.escalateAt!))).toMatchObject({ done: true, outcome: 'NO_NEXT_BAND', coAssigneeTaskId: null })
    expect(await tasksOfRoute(task.step.routeId, 2)).toHaveLength(1)
    expect((await prisma.event.findFirstOrThrow({ where: { type: 'approval_task.escalated', aggregateId: step2!.id } })).data).toMatchObject({ outcome: 'NO_NEXT_BAND', reason: 'NO_HIGHER_BAND', coAssigneeMemberId: null })
    const told = (await toldOf(requestId)).filter((t) => t.taskId === step2!.id)
    expect(told.map((t) => [t.to, t.role]).sort()).toEqual(
      [
        [own.member.admin, 'ADMIN'],
        [own.member.req_con, 'REQUESTER'],
      ].sort(),
    )
  })

  it('the DM decides step 1 first: the COO’s task is cancelled with its link, it cannot approve past step 2, and step 2 goes to the VP', async () => {
    const own = await createTwoStepOrg()
    const { requestId, task } = await submitted(own, 'req_con', '11000.00', MON_0900)
    const { coAssigneeTaskId } = await escalateTask(own.organizationId, task.id, TUE_1600)
    expect(await decideTask(own.ctxOf('dm_con', DECIDED), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: true, data: { documentStatus: 'PENDING_APPROVAL' } })
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: coAssigneeTaskId! } })).toMatchObject({ status: 'CANCELLED', decidedAt: null })
    expect((await cancelledOf(coAssigneeTaskId!)).map((e) => e.data)).toEqual([{ subjectId: requestId, why: 'CO_ASSIGNEE_DECIDED' }])
    expect(await prisma.actionToken.findFirstOrThrow({ where: { taskId: coAssigneeTaskId! } })).toMatchObject({ revokedAt: DECIDED })
    // The second task of step 1 can no longer act on the document: it would have approved it past the VP's step
    expect(await decideTask(own.ctxOf('coo', LATE), { taskId: coAssigneeTaskId!, decision: 'APPROVE' }, key())).toMatchObject({
      ok: false,
      error: { code: 'INVALID_STATE_TRANSITION', details: { from: 'CANCELLED', name: 'ผู้ใช้ dm_con', time: DECIDED.toISOString() } },
    })
    const open = await prisma.approvalTask.findMany({ where: { step: { routeId: task.step.routeId }, status: { in: ['OPEN', 'INFO_REQUESTED'] } }, include: { step: true } })
    expect(open.map((t) => [t.step.stepNo, t.assigneeMemberId])).toEqual([[2, own.member.vp_ops]])
    expect(await prisma.request.findUniqueOrThrow({ where: { id: requestId } })).toMatchObject({ status: 'PENDING_APPROVAL' })
  })

  it('a return by the co-assignee decides step 1 too: the DM’s task is cancelled once, step 2 never starts and the request goes back', async () => {
    const own = await createTwoStepOrg()
    const { requestId, task } = await submitted(own, 'req_con', '12000.00', MON_0900)
    const { coAssigneeTaskId } = await escalateTask(own.organizationId, task.id, TUE_1600)
    expect(await decideTask(own.ctxOf('coo', DECIDED), { taskId: coAssigneeTaskId!, decision: 'RETURN', reason: 'ขอใบเสนอราคาเพิ่ม' }, key())).toMatchObject({ ok: true, data: { documentStatus: 'RETURNED' } })
    expect((await cancelledOf(task.id)).map((e) => e.data)).toEqual([{ subjectId: requestId, why: 'CO_ASSIGNEE_DECIDED' }])
    expect((await stepsOf(task.step.routeId)).map((s) => s.status)).toEqual(['DONE', 'CANCELLED'])
    expect(await tasksOfRoute(task.step.routeId, 2)).toEqual([])
    expect(await prisma.approvalRoute.findUniqueOrThrow({ where: { id: task.step.routeId } })).toMatchObject({ status: 'CANCELLED' })
    expect(await decideTask(own.ctxOf('dm_con', LATE), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION', details: { name: 'ผู้ใช้ coo' } } })
  })

  it('a co-assignee waiting for the requester’s answer is cancelled when the first assignee decides; the answer then finds the task closed', async () => {
    const own = await createTwoStepOrg()
    const { requestId, task } = await submitted(own, 'req_con', '13000.00', MON_0900)
    const { coAssigneeTaskId } = await escalateTask(own.organizationId, task.id, TUE_1600)
    expect(await requestInfo(own.ctxOf('coo', at('2026-10-06T09:10:00Z')), { taskId: coAssigneeTaskId!, question: 'ขอรายละเอียดผู้ขาย' }, key())).toMatchObject({ ok: true })
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: coAssigneeTaskId! } })).toMatchObject({ status: 'INFO_REQUESTED' })
    expect(await decideTask(own.ctxOf('dm_con', DECIDED), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: true })
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: coAssigneeTaskId! } })).toMatchObject({ status: 'CANCELLED' })
    expect((await cancelledOf(coAssigneeTaskId!)).map((e) => e.data)).toEqual([{ subjectId: requestId, why: 'CO_ASSIGNEE_DECIDED' }])
    const info = await prisma.infoRequest.findFirstOrThrow({ where: { taskId: coAssigneeTaskId! } })
    expect(await provideInfo(own.ctxOf('req_con', LATE), { infoRequestId: info.id, answer: 'แนบแล้ว' }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION', details: { from: 'CANCELLED' } } })
  })

  it('[INV-PLT-03] the two approvers of an escalated step deciding at the same moment decide it once: the other waits, is refused and its task cancelled', async () => {
    const { requestId, task } = await submitted(org, 'req_con', '12500.00', MON_0900)
    const { coAssigneeTaskId } = await escalateTask(org.organizationId, task.id, TUE_1600)
    // Both lock the step's two tasks in id order before anything else (lockForDecision): the second waits for the first
    // and then finds its task cancelled. No deadlock to retry: with retries turned off, a deadlock would end INTERNAL.
    const once = () => ({ ...key(), maxRetries: 0 })
    const [first, second] = await Promise.all([
      decideTask(org.ctxOf('dm_con', DECIDED), { taskId: task.id, decision: 'APPROVE' }, once()),
      decideTask(org.ctxOf('vp_ops', DECIDED), { taskId: coAssigneeTaskId!, decision: 'REJECT', reason: 'ไม่จำเป็นต้องซื้อ' }, once()),
    ])
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1)
    const [winner, loser] = first.ok ? ['dm_con', second] : ['vp_ops', first]
    expect(loser).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION', details: { from: 'CANCELLED', name: `ผู้ใช้ ${winner}`, time: DECIDED.toISOString() } } })
    expect(await prisma.event.count({ where: { type: 'approval_task.decided', aggregateId: { in: [task.id, coAssigneeTaskId!] } } })).toBe(1)
    expect((await tasksOfStep(task.stepId)).map((t) => t.status)).toEqual(first.ok ? ['APPROVED', 'CANCELLED'] : ['CANCELLED', 'REJECTED'])
    expect(await prisma.request.findUniqueOrThrow({ where: { id: requestId } })).toMatchObject({ status: first.ok ? 'APPROVED' : 'REJECTED' })
  })
})

describe('[FR-NOTI-003/AC1] a step escalated already: a new due time brings the assignee’s overdue notice, not another acknowledgement', () => {
  it('the assignee asks the requester after the escalation; when the answer’s due time passes only the assignee is told', async () => {
    const { requestId, task } = await submitted(org, 'req_con', '14000.00', MON_0900)
    const { coAssigneeTaskId } = await escalateTask(org.organizationId, task.id, TUE_1600)
    expect(await requestInfo(org.ctxOf('dm_con', at('2026-10-06T09:30:00Z')), { taskId: task.id, question: 'ขอใบเสนอราคาเพิ่ม' }, key())).toMatchObject({ ok: true })
    const info = await prisma.infoRequest.findFirstOrThrow({ where: { taskId: task.id } })
    // Answered Wednesday 09:00 with no business time left: due at once
    expect(await provideInfo(org.ctxOf('req_con', at('2026-10-07T02:00:00Z')), { infoRequestId: info.id, answer: 'แนบแล้ว' }, key())).toMatchObject({ ok: true })
    expect(await markTaskOverdue(org.organizationId, task.id, at('2026-10-07T02:00:00Z'))).toMatchObject({ done: true })
    const told = await prisma.notification.findMany({ where: { templateKey: 'task.overdue', subjectId: requestId } })
    expect(told.map((n) => [n.recipientMemberId, (n.data as { role: string }).role])).toEqual([[org.member.dm_con, 'ASSIGNEE']])
    expect((await prisma.event.findFirstOrThrow({ where: { type: 'approval_task.overdue', aggregateId: task.id } })).data).toMatchObject({ nextBandMemberId: null })
    // The co-assignee still decides alongside
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: coAssigneeTaskId! } })).toMatchObject({ status: 'OPEN' })
  })
})
