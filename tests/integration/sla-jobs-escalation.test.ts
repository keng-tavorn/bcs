import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { ManualClock } from '@/lib/clock'
import { toJsonSafe } from '@/lib/json'
import { systemCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { ruleJson } from '@/server/doa/snapshot'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { approvalTaskSlaHandler, type TimerStep } from '@/server/jobs/approval-task-sla'
import { renderNotification } from '@/server/notifications/templates'
import { runCommand } from '@/server/services/_pipeline'
import { decideTask, provideInfo, requestInfo } from '@/server/services/approvals/decide'
import { createDraft, submitRequest } from '@/server/services/requests'
import { escalateTask, markTaskOverdue } from '@/server/services/sla'
import { escalateTaskCommand } from '@/server/services/sla/task-sla'
import { versionSnapshots } from '../golden/doa-fixtures'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// Escalation past escalateAt (spec BR-SLA-04, FR-NOTI-003 AC2, S5-08) on the §7.4 fixture organization: the approver
// of the next amount band joins the step as co-assignee, whoever decides first decides, the decision keeps the route's
// own DOA reference, and with no band above ORG_ADMIN and the requester are told. A task never goes to lower
// authority. Times: a request submitted Monday 5 Oct 2026 09:00 Thai time is due 17:00 and escalated Tuesday 16:00
// (8 business hours later, escalationPolicy.escalateAfterBusinessHours).

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
    expect(await decideTask(org.ctxOf('dm_con', at('2026-10-06T09:40:00Z')), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION' } })
  })

  it('the first approver may still decide first: the co-assignee task is cancelled with the route', async () => {
    const { requestId, task } = await submitted(org, 'req_con', '11000.00', MON_0900)
    const { coAssigneeTaskId } = await escalateTask(org.organizationId, task.id, TUE_1600)
    expect(await decideTask(org.ctxOf('dm_con', at('2026-10-06T09:30:00Z')), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: true, data: { documentStatus: 'APPROVED' } })
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: coAssigneeTaskId! } })).toMatchObject({ status: 'CANCELLED' })
    // BR-TOK-01: the co-assignee's decision link dies with their task
    expect(await prisma.actionToken.findFirstOrThrow({ where: { taskId: coAssigneeTaskId! } })).toMatchObject({ revokedAt: at('2026-10-06T09:30:00Z') })
    expect(await decideTask(org.ctxOf('vp_ops', at('2026-10-06T09:40:00Z')), { taskId: coAssigneeTaskId!, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION' } })
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
    expect(renderNotification(adminNote, 'th')).toEqual({ title: `${number} เลยกำหนด แต่ตำแหน่งผู้อนุมัติระดับถัดไปไม่มีผู้ดำรงตำแหน่ง`, body: 'โปรดแต่งตั้งผู้ดำรงตำแหน่ง หรือย้ายงานให้ผู้มีอำนาจเท่ากันหรือสูงกว่า', href: `/requests/${requestId}` })
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

describe('[FR-NOTI-003/AC2] a step that is not the last of its route gets no co-assignee', () => {
  it('a DM step followed by a VP step: ORG_ADMIN and the requester are told instead, and the route is unchanged', async () => {
    // A version whose PR-01 has two steps (DM then VP): a second task on step 1 would stay open after step 1 moves on
    const own = await createDoaOrg({ doa: false })
    await prisma.roleAssignment.create({ data: { organizationId: own.organizationId, memberId: own.member.admin!, role: 'ORG_ADMIN', grantedAt: at('2026-01-01T00:00:00Z') } })
    const v1 = versionSnapshots().find((v) => v.versionNo === 1)!
    const version = await prisma.doaVersion.create({
      data: {
        organizationId: own.organizationId,
        code: 'DOA-TWO-STEP',
        versionNo: 1,
        status: 'PUBLISHED',
        effectiveFrom: v1.effectiveFrom,
        amountBasis: 'GROSS',
        selfApprovalPolicy: 'ESCALATE_NEXT_BAND',
        collapseDuplicateApprovers: true,
        escalationPolicy: { remindPct: 0.5, escalateAfterBusinessHours: 8 },
        sodPolicy: { approverMayReceive: false, requesterMayReceive: true },
        publishedAt: v1.effectiveFrom,
      },
    })
    for (const rule of v1.rules) {
      const json = ruleJson(rule)
      const steps = rule.code === 'PR-01' ? [...json.steps, { approver: { kind: 'POSITION_OF_DEPARTMENT', position: 'VP' }, slaBusinessMinutes: 480, mode: 'SEQUENTIAL' }] : json.steps
      await prisma.doaRule.create({ data: { organizationId: own.organizationId, doaVersionId: version.id, code: rule.code, documentType: json.documentType, priority: rule.priority, when: toJsonSafe(json.when) as object, steps } })
    }
    const { requestId, task } = await submitted(own, 'req_con', '10000.00', MON_0900)
    expect(await prisma.approvalStep.count({ where: { routeId: task.step.routeId } })).toBe(2)
    // At dueAt the next band (PR-02, VP of OPS) still hears of it, but is promised no escalation that will not come
    expect(await markTaskOverdue(own.organizationId, task.id, at('2026-10-05T10:00:00Z'))).toMatchObject({ done: true })
    const ack = await prisma.notification.findFirstOrThrow({ where: { templateKey: 'task.overdue', subjectId: requestId, recipientMemberId: own.member.vp_ops } })
    expect(ack.data).toMatchObject({ role: 'ACK', willEscalate: false })
    expect(renderNotification(ack, 'th').body).toBeNull()
    expect(await escalateTask(own.organizationId, task.id, TUE_1600)).toMatchObject({ done: true, outcome: 'NO_NEXT_BAND', coAssigneeTaskId: null })
    expect(await tasksOfStep(task.stepId)).toHaveLength(1)
    expect((await prisma.event.findFirstOrThrow({ where: { type: 'approval_task.escalated', aggregateId: task.id } })).data).toMatchObject({ reason: 'NOT_LAST_STEP' })
    expect((await toldOf(requestId)).map((t) => t.role).sort()).toEqual(['ADMIN', 'REQUESTER'])
    // The administrators hear why nobody was added, not that there is no band above
    const adminNote = await prisma.notification.findFirstOrThrow({ where: { templateKey: 'task.escalated', subjectId: requestId, recipientMemberId: own.member.admin } })
    const number = (adminNote.data as { number: string }).number
    expect(renderNotification(adminNote, 'th')).toMatchObject({ title: `${number} เลยกำหนดที่ขั้นที่ยังมีขั้นถัดไป ระบบจึงยังไม่เพิ่มผู้อนุมัติร่วม` })
    expect(renderNotification(adminNote, 'en')).toMatchObject({ title: `${number} is overdue at a step with more steps after it, so no co-approver was added` })
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
