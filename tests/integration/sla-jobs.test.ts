import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { ManualClock } from '@/lib/clock'
import { prisma } from '@/server/db/client'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { approvalTaskResume, approvalTaskResumeHandler } from '@/server/jobs/approval-task-resume'
import { approvalTaskSla, approvalTaskSlaHandler, type TimerStep } from '@/server/jobs/approval-task-sla'
import { renderNotification } from '@/server/notifications/templates'
import { runCommand } from '@/server/services/_pipeline'
import { decideTask, provideInfo, requestInfo } from '@/server/services/approvals/decide'
import { cancelRequest, createDraft, submitRequest } from '@/server/services/requests'
import { escalateTask, markTaskOverdue, planTaskSla, remindTaskSla, resumeTaskSla } from '@/server/services/sla'
import { escalateTaskCommand, markTaskOverdueCommand, remindTaskSlaCommand } from '@/server/services/sla/task-sla'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// The SLA job of an approval task (spec §4.6 approval-task-sla and approval-task-resume, §7.8 BR-SLA-02 to BR-SLA-04,
// FR-NOTI-003, FR-INT-009 AC3) on the §7.4 fixture organization: DOA-DEMO version 1 (PR-01 DM ≤ 20,000 · PR-02 VP
// ≤ 100,000 · PR-03 CEO above, 8 business hours each but PR-03 16), escalationPolicy { remindPct 0.5,
// escalateAfterBusinessHours 8 }, business hours Mon–Fri 08:30–17:30 Asia/Bangkok, holidays 13 and 23 Oct 2026.
// The handlers are called directly with a fake clock; the job wrappers are driven with a fake step whose sleeps move
// that clock.

const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const at = (iso: string) => new Date(iso)
/** Monday 5 Oct 2026, 09:00 Thai time */
const MON_0900 = at('2026-10-05T02:00:00Z')

let org: DoaOrg
beforeAll(async () => {
  setDefaultOutboxSender(null)
  org = await createDoaOrg()
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: at('2026-01-01T00:00:00Z') } })
})

/** A submitted request of one line whose price includes VAT, so its gross is exactly `grossBaht`, and its open task */
async function submitted(requester: string, grossBaht: string, when: Date, options: { chargedTo?: string } = {}) {
  const draft = await createDraft(
    org.ctxOf(requester, when),
    {
      requestTypeCode: 'BUY_GOODS',
      title: 'วัสดุก่อสร้าง',
      priceIncludesVat: true,
      ...(options.chargedTo ? { chargedDepartmentId: org.department[options.chargedTo]! } : {}),
      lines: [{ description: 'ปูนซีเมนต์ 50 ถุง', quantity: '1', uom: 'งาน', unitPrice: grossBaht }],
    },
    key(),
  )
  if (!draft.ok) throw new Error(`draft failed: ${JSON.stringify(draft.error)}`)
  const requestId = draft.data.requestId
  // ATT-QUOTES: above 100,000 the form needs three quotations
  for (let i = 0; i < 3; i++) {
    const file = await prisma.fileObject.create({ data: { organizationId: org.organizationId, storageKey: `test/${randomUUID()}.pdf`, fileName: 'q.pdf', mimeType: 'application/pdf', sizeBytes: 1, status: 'AVAILABLE', uploadedById: org.member[requester]! } })
    await prisma.fileLink.create({ data: { organizationId: org.organizationId, fileId: file.id, subjectType: 'Request', subjectId: requestId, kind: 'QUOTATION' } })
  }
  const sent = await submitRequest(org.ctxOf(requester, when), { requestId }, key())
  if (!sent.ok) throw new Error(`submit failed: ${JSON.stringify(sent.error)}`)
  const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: requestId } } } })
  return { requestId, task, number: sent.data.number }
}

const eventsOf = (type: string, aggregateId: string) => prisma.event.findMany({ where: { organizationId: org.organizationId, type, aggregateId }, orderBy: { seq: 'asc' } })
const notesOf = (templateKey: string, subjectId: string) => prisma.notification.findMany({ where: { organizationId: org.organizationId, templateKey, subjectId }, orderBy: { dedupeKey: 'asc' } })
const taskOf = (id: string) => prisma.approvalTask.findUniqueOrThrow({ where: { id } })

/** A fake Inngest step: run() runs at once, sleepUntil() and sleep() move the clock forward; `beforeSleep` lets a test act in between */
function fakeStep(clock: ManualClock, beforeSleep?: (id: string) => Promise<void>) {
  const sleeps: string[] = []
  const runs: string[] = []
  const step: TimerStep = {
    run: async (id, fn) => {
      runs.push(id)
      return fn()
    },
    sleepUntil: async (id, until) => {
      sleeps.push(`${id} ${until}`)
      if (beforeSleep) await beforeSleep(id)
      if (new Date(until).getTime() > clock.now().getTime()) clock.set(until)
    },
    sleep: async (id, ms) => {
      sleeps.push(`${id} ${ms}`)
      clock.advance(ms)
    },
  }
  return { step, sleeps, runs }
}

describe('[FR-NOTI-003/AC1] the assignee is reminded half way through the SLA and told when it is due', () => {
  it('plans remindAt at 50% (GC-SLA-07), dueAt and escalateAt in business time, from the stored task', async () => {
    // Monday 08:30 Thai time: due 16:30, reminded at 12:30 (GC-SLA-07: 2026-10-05T05:30:00Z), escalated 8 business
    // hours after the due time: 16:30 → 17:30 is 1 hour, then Tuesday 08:30 + 7 hours = 15:30
    const { task } = await submitted('req_con', '10000.00', at('2026-10-05T01:30:00Z'))
    expect(task).toMatchObject({ assigneeMemberId: org.member.dm_con, dueAt: at('2026-10-05T09:30:00Z'), remindAt: at('2026-10-05T05:30:00Z') })
    expect(await planTaskSla(org.organizationId, task.id, at('2026-10-05T01:30:00Z'))).toEqual({
      taskId: task.id,
      status: 'OPEN',
      open: true,
      remindAt: '2026-10-05T05:30:00.000Z',
      dueAt: '2026-10-05T09:30:00.000Z',
      escalateAt: '2026-10-06T08:30:00.000Z',
    })
  })

  it('reminds once at remindAt, never before; then marks the task overdue at dueAt and tells the assignee and the next band', async () => {
    const { requestId, task, number } = await submitted('req_con', '10000.00', MON_0900)
    // due 17:00, reminded 13:00 Thai time; a run that comes a minute early is told how long is left
    expect(await remindTaskSla(org.organizationId, task.id, at('2026-10-05T05:59:00Z'))).toEqual({ done: false, code: 'VALIDATION_FAILED', reason: 'NOT_DUE', notBefore: '2026-10-05T06:00:00.000Z', waitMs: 60_000 })
    expect(await eventsOf('approval_task.reminded', task.id)).toHaveLength(0)
    expect(await remindTaskSla(org.organizationId, task.id, at('2026-10-05T06:00:00Z'))).toEqual({ done: true })
    // A retry of the step (Inngest runs it again) repeats nothing
    expect(await remindTaskSla(org.organizationId, task.id, at('2026-10-05T06:30:00Z'))).toEqual({ done: true })
    const reminded = await eventsOf('approval_task.reminded', task.id)
    expect(reminded).toHaveLength(1)
    expect(reminded[0]).toMatchObject({ actorType: 'SYSTEM', channel: 'SYSTEM', data: { subjectType: 'REQUEST', subjectId: requestId, via: 'SLA' } })
    const reminders = await notesOf('task.reminder', requestId)
    expect(reminders).toHaveLength(1)
    expect(reminders[0]).toMatchObject({ recipientMemberId: org.member.dm_con, urgency: 'IMMEDIATE', data: { number, taskId: task.id, dueAt: '2026-10-05T10:00:00.000Z' } })

    expect(await markTaskOverdue(org.organizationId, task.id, at('2026-10-05T09:59:00Z'))).toMatchObject({ done: false, reason: 'NOT_DUE', notBefore: '2026-10-05T10:00:00.000Z', waitMs: 60_000, escalateAt: null })
    const overdue = await markTaskOverdue(org.organizationId, task.id, at('2026-10-05T10:00:00Z'))
    // escalated 8 business hours later: 17:00 → 17:30, then Tuesday 08:30 + 7.5 hours = 16:00
    expect(overdue).toEqual({ done: true, escalateAt: '2026-10-06T09:00:00.000Z' })
    expect(await taskOf(task.id)).toMatchObject({ status: 'OPEN', overdueAt: at('2026-10-05T10:00:00Z'), escalateAt: at('2026-10-06T09:00:00Z') })
    // again for the same due time: nothing new, and the timer goes on to escalateAt
    expect(await markTaskOverdue(org.organizationId, task.id, at('2026-10-05T10:05:00Z'))).toEqual({ done: true, escalateAt: '2026-10-06T09:00:00.000Z' })
    const marked = await eventsOf('approval_task.overdue', task.id)
    expect(marked).toHaveLength(1)
    expect(marked[0]!.data).toEqual({ subjectType: 'REQUEST', subjectId: requestId, dueAt: '2026-10-05T10:00:00.000Z', escalateAt: '2026-10-06T09:00:00.000Z', nextBandMemberId: org.member.vp_ops })
    // BR-SLA-04: the assignee, and the approver of the next band (PR-02, VP of OPS) for acknowledgement
    const told = await notesOf('task.overdue', requestId)
    expect(told.map((n) => [n.recipientMemberId, (n.data as { role: string }).role])).toEqual(
      expect.arrayContaining([
        [org.member.dm_con, 'ASSIGNEE'],
        [org.member.vp_ops, 'ACK'],
      ]),
    )
    expect(told).toHaveLength(2)
    // In the reader's language with the link back (BR-NOTI-02, BR-NOTI-03): the assignee to the task, the next band to the request
    const own = told.find((n) => n.recipientMemberId === org.member.dm_con)!
    const ack = told.find((n) => n.recipientMemberId === org.member.vp_ops)!
    expect(renderNotification(own, 'th')).toEqual({ title: `เลยกำหนด: ${number} รอคุณพิจารณา`, body: 'โปรดพิจารณาโดยเร็ว', href: `/tasks/${task.id}` })
    expect(renderNotification(own, 'en')).toMatchObject({ title: `Overdue: ${number} is waiting for your decision` })
    // PR-01 has one step and the step was not escalated: escalation follows unless someone decides, and the notice says so
    expect(ack.data).toMatchObject({ role: 'ACK', willEscalate: true })
    expect(renderNotification(ack, 'th')).toEqual({ title: `แจ้งเพื่อทราบ: ${number} เลยกำหนดพิจารณาแล้ว`, body: 'ถ้ายังไม่มีผู้ตัดสิน งานนี้จะส่งต่อให้ผู้อนุมัติระดับถัดไปร่วมพิจารณา', href: `/requests/${requestId}` })
    expect(renderNotification(ack, 'en')).toMatchObject({ body: 'If nobody decides it, it will be escalated to the next approval level' })
    expect(renderNotification(reminders[0]!, 'th')).toMatchObject({ title: `เตือน: ${number} รอคุณตัดสิน`, href: `/tasks/${task.id}` })
    // BR-NOTI-01: ids, the number, the title and times only — no items, prices or files
    for (const n of [...reminders, ...told]) {
      expect(Object.keys(n.data as object).every((k) => ['subjectType', 'subjectId', 'number', 'title', 'taskId', 'dueAt', 'role', 'willEscalate'].includes(k)), JSON.stringify(n.data)).toBe(true)
      expect(JSON.stringify(n.data)).not.toContain('ปูนซีเมนต์')
    }
  })

  it('reminds no task whose reminder time passed before it reached its holder, and nothing at or after the due time', async () => {
    const { task } = await submitted('req_con', '9000.00', MON_0900)
    expect(await remindTaskSla(org.organizationId, task.id, at('2026-10-05T10:00:00Z'))).toMatchObject({ done: false, reason: 'PAST_DUE' })
    expect(await eventsOf('approval_task.reminded', task.id)).toHaveLength(0)
  })

  it('runs as one Inngest function per assigned or moved task, cancelled when the task closes, moves or pauses', () => {
    expect(approvalTaskSla.opts).toMatchObject({
      id: 'approval-task-sla',
      triggers: [{ event: 'bcs/approval_task.assigned' }, { event: 'bcs/approval_task.reassigned' }],
      cancelOn: [
        { event: 'bcs/approval_task.decided', if: 'async.data.aggregateId == event.data.aggregateId' },
        { event: 'bcs/approval_task.cancelled', if: 'async.data.aggregateId == event.data.aggregateId' },
        { event: 'bcs/approval_task.reassigned', if: 'async.data.data.fromTaskId == event.data.aggregateId' },
        { event: 'bcs/request.info_requested', if: 'async.data.data.taskId == event.data.aggregateId' },
      ],
    })
  })

  it('the job sleeps until remindAt, dueAt and escalateAt in turn and runs each handler at that time', async () => {
    const { task } = await submitted('req_con', '8000.00', MON_0900)
    const clock = new ManualClock(MON_0900)
    const { step, sleeps, runs } = fakeStep(clock)
    const run = await approvalTaskSlaHandler(clock)({ data: { organizationId: org.organizationId, aggregateId: task.id } }, step)
    expect(sleeps).toEqual(['until-remind 2026-10-05T06:00:00.000Z', 'until-due 2026-10-05T10:00:00.000Z', 'until-escalate 2026-10-06T09:00:00.000Z'])
    expect(runs).toEqual(['plan', 'remind', 'overdue', 'escalate'])
    expect(run).toEqual({ taskId: task.id, reminded: true, overdue: true, escalated: 'CO_ASSIGNED', stopped: null })
    expect(await eventsOf('approval_task.reminded', task.id)).toHaveLength(1)
    expect(await eventsOf('approval_task.overdue', task.id)).toHaveLength(1)
    expect(await eventsOf('approval_task.escalated', task.id)).toHaveLength(1)
  })
})

describe('[FR-NOTI-003/AC3] a task that is decided, cancelled or waiting for the requester is not reminded', () => {
  it('a decided task gets no reminder, overdue notice or escalation: every handler reads the task first', async () => {
    const { requestId, task } = await submitted('req_con', '7000.00', MON_0900)
    expect(await decideTask(org.ctxOf('dm_con', at('2026-10-05T03:00:00Z')), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: true })
    expect(await planTaskSla(org.organizationId, task.id, at('2026-10-05T03:00:00Z'))).toMatchObject({ open: false, status: 'APPROVED', remindAt: null, dueAt: null })
    expect(await remindTaskSla(org.organizationId, task.id, at('2026-10-05T06:00:00Z'))).toMatchObject({ done: false, code: 'INVALID_STATE_TRANSITION', reason: 'CLOSED' })
    expect(await markTaskOverdue(org.organizationId, task.id, at('2026-10-05T10:00:00Z'))).toMatchObject({ done: false, reason: 'CLOSED', escalateAt: null })
    expect(await escalateTask(org.organizationId, task.id, at('2026-10-06T09:00:00Z'))).toMatchObject({ done: false, reason: 'CLOSED', outcome: null })
    for (const type of ['approval_task.reminded', 'approval_task.overdue', 'approval_task.escalated']) expect(await eventsOf(type, task.id)).toHaveLength(0)
    for (const template of ['task.reminder', 'task.overdue', 'task.escalated']) expect(await notesOf(template, requestId)).toHaveLength(0)
  })

  it('a task of a cancelled request is left alone, and the job stops at its plan', async () => {
    const { requestId, task } = await submitted('req_con', '6000.00', MON_0900)
    expect(await cancelRequest(org.ctxOf('req_con', at('2026-10-05T03:00:00Z')), { requestId, reason: 'ไม่ต้องใช้แล้ว' }, key())).toMatchObject({ ok: true })
    const clock = new ManualClock(at('2026-10-05T03:00:00Z'))
    const { step, sleeps, runs } = fakeStep(clock)
    expect(await approvalTaskSlaHandler(clock)({ data: { organizationId: org.organizationId, aggregateId: task.id } }, step)).toEqual({ taskId: task.id, reminded: false, overdue: false, escalated: null, stopped: 'CANCELLED' })
    expect(sleeps).toEqual([])
    expect(runs).toEqual(['plan'])
    expect(await remindTaskSla(org.organizationId, task.id, at('2026-10-05T06:00:00Z'))).toMatchObject({ done: false, reason: 'CLOSED' })
  })

  it('while the approver waits for the requester the SLA is paused: no reminder, overdue notice or escalation', async () => {
    const { requestId, task } = await submitted('req_con', '5000.00', MON_0900)
    expect(await requestInfo(org.ctxOf('dm_con', at('2026-10-05T03:00:00Z')), { taskId: task.id, question: 'ขอใบเสนอราคาเพิ่ม' }, key())).toMatchObject({ ok: true })
    expect(await planTaskSla(org.organizationId, task.id, at('2026-10-05T03:00:00Z'))).toMatchObject({ open: false, status: 'INFO_REQUESTED' })
    expect(await remindTaskSla(org.organizationId, task.id, at('2026-10-05T06:00:00Z'))).toMatchObject({ done: false, reason: 'PAUSED' })
    expect(await markTaskOverdue(org.organizationId, task.id, at('2026-10-05T10:00:00Z'))).toMatchObject({ done: false, reason: 'PAUSED', escalateAt: null })
    expect(await escalateTask(org.organizationId, task.id, at('2026-10-06T09:00:00Z'))).toMatchObject({ done: false, reason: 'PAUSED' })
    for (const template of ['task.reminder', 'task.overdue', 'task.escalated']) expect(await notesOf(template, requestId)).toHaveLength(0)
  })

  it('the job stops when the task is decided while it sleeps: nothing is sent after the decision', async () => {
    const { requestId, task } = await submitted('req_con', '4000.00', MON_0900)
    const clock = new ManualClock(MON_0900)
    const { step, runs } = fakeStep(clock, async (id) => {
      if (id === 'until-due') await decideTask(org.ctxOf('dm_con', clock.now()), { taskId: task.id, decision: 'APPROVE' }, key())
    })
    const run = await approvalTaskSlaHandler(clock)({ data: { organizationId: org.organizationId, aggregateId: task.id } }, step)
    expect(run).toEqual({ taskId: task.id, reminded: true, overdue: false, escalated: null, stopped: 'CLOSED' })
    expect(runs).toEqual(['plan', 'remind', 'overdue'])
    expect(await notesOf('task.overdue', requestId)).toHaveLength(0)
  })

  it('only the SLA job runs these commands: a member is refused', async () => {
    const { task } = await submitted('req_con', '3000.00', MON_0900)
    const member = org.ctxOf('dm_con', at('2026-10-06T10:00:00Z'))
    expect(await runCommand(member, remindTaskSlaCommand, { taskId: task.id }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await runCommand(member, markTaskOverdueCommand, { taskId: task.id, dueAt: task.dueAt!.toISOString() }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await runCommand(member, escalateTaskCommand, { taskId: task.id }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    for (const type of ['approval_task.reminded', 'approval_task.overdue', 'approval_task.escalated']) expect(await eventsOf(type, task.id)).toHaveLength(0)
  })
})

describe('[FR-INT-009/AC3] after the requester answers, the SLA counts on from the time that was left (BR-SLA-03)', () => {
  it('plans again from the answer: GC-SLA-06 due time, the reminder moved by the time left, and no stale overdue', async () => {
    // GC-SLA-06: assigned Monday 08:30, paused 11:30 (3 business hours used), answered Wednesday 10:00 → due 15:00
    const { task } = await submitted('req_con', '2500.00', at('2026-10-05T01:30:00Z'))
    expect(await requestInfo(org.ctxOf('dm_con', at('2026-10-05T04:30:00Z')), { taskId: task.id, question: 'ขอสเปกเพิ่ม' }, key())).toMatchObject({ ok: true })
    // the old due time passes while the question waits: nothing happens
    expect(await markTaskOverdue(org.organizationId, task.id, at('2026-10-05T09:30:00Z'))).toMatchObject({ done: false, reason: 'PAUSED' })
    const info = await prisma.infoRequest.findFirstOrThrow({ where: { taskId: task.id } })
    expect(await provideInfo(org.ctxOf('req_con', at('2026-10-07T03:00:00Z')), { infoRequestId: info.id, answer: 'แนบแล้ว' }, key())).toMatchObject({ ok: true })
    // 3 of the 4 hours before the reminder were used, so it comes 1 business hour after the answer (Wednesday 11:00);
    // the escalation follows the new due time by 8 business hours (Wednesday 15:00 → Thursday 14:00)
    expect(await resumeTaskSla(org.organizationId, task.id, at('2026-10-07T03:00:00Z'))).toEqual({
      taskId: task.id,
      status: 'OPEN',
      open: true,
      remindAt: '2026-10-07T04:00:00.000Z',
      dueAt: '2026-10-07T08:00:00.000Z',
      escalateAt: '2026-10-08T07:00:00.000Z',
    })
    // A run that slept until the old times is refused: the task is not due on the new count
    expect(await markTaskOverdue(org.organizationId, task.id, at('2026-10-07T07:59:00Z'))).toMatchObject({ done: false, reason: 'NOT_DUE' })
    expect(await remindTaskSla(org.organizationId, task.id, at('2026-10-07T03:30:00Z'))).toMatchObject({ done: false, reason: 'NOT_DUE' })
    expect(await remindTaskSla(org.organizationId, task.id, at('2026-10-07T04:00:00Z'))).toEqual({ done: true })
    expect(await markTaskOverdue(org.organizationId, task.id, at('2026-10-07T08:00:00Z'))).toEqual({ done: true, escalateAt: '2026-10-08T07:00:00.000Z' })
    expect((await eventsOf('approval_task.overdue', task.id))[0]!.data).toMatchObject({ dueAt: '2026-10-07T08:00:00.000Z' })
  })

  it('a reminder sent before the question is not sent again after the answer', async () => {
    const { task } = await submitted('req_con', '2400.00', at('2026-10-05T01:30:00Z'))
    expect(await remindTaskSla(org.organizationId, task.id, at('2026-10-05T05:30:00Z'))).toEqual({ done: true })
    expect(await requestInfo(org.ctxOf('dm_con', at('2026-10-05T06:30:00Z')), { taskId: task.id, question: 'ขอรายละเอียด' }, key())).toMatchObject({ ok: true })
    const info = await prisma.infoRequest.findFirstOrThrow({ where: { taskId: task.id } })
    expect(await provideInfo(org.ctxOf('req_con', at('2026-10-06T02:00:00Z')), { infoRequestId: info.id, answer: 'ตามแนบ' }, key())).toMatchObject({ ok: true })
    expect(await resumeTaskSla(org.organizationId, task.id, at('2026-10-06T02:00:00Z'))).toMatchObject({ open: true, remindAt: null })
    expect(await eventsOf('approval_task.reminded', task.id)).toHaveLength(1)
  })

  it('the resume job plans from the answer and runs the timers; it is cancelled like the SLA job', async () => {
    expect(approvalTaskResume.opts).toMatchObject({
      id: 'approval-task-resume',
      triggers: [{ event: 'bcs/request.info_provided' }],
      cancelOn: [
        { event: 'bcs/approval_task.decided', if: 'async.data.aggregateId == event.data.data.taskId' },
        { event: 'bcs/approval_task.cancelled', if: 'async.data.aggregateId == event.data.data.taskId' },
        { event: 'bcs/approval_task.reassigned', if: 'async.data.data.fromTaskId == event.data.data.taskId' },
        { event: 'bcs/request.info_requested', if: 'async.data.data.taskId == event.data.data.taskId' },
      ],
    })
    const { requestId, task } = await submitted('req_con', '2300.00', at('2026-10-05T01:30:00Z'))
    expect(await requestInfo(org.ctxOf('dm_con', at('2026-10-05T04:30:00Z')), { taskId: task.id, question: 'ขอสเปก' }, key())).toMatchObject({ ok: true })
    const info = await prisma.infoRequest.findFirstOrThrow({ where: { taskId: task.id } })
    const answered = at('2026-10-07T03:00:00Z')
    expect(await provideInfo(org.ctxOf('req_con', answered), { infoRequestId: info.id, answer: 'แนบแล้ว' }, key())).toMatchObject({ ok: true })
    const clock = new ManualClock(answered)
    const { step, sleeps } = fakeStep(clock)
    const run = await approvalTaskResumeHandler(clock)({ data: { organizationId: org.organizationId, data: { taskId: task.id, infoRequestId: info.id }, aggregateId: requestId } }, step)
    expect(sleeps).toEqual(['until-remind 2026-10-07T04:00:00.000Z', 'until-due 2026-10-07T08:00:00.000Z', 'until-escalate 2026-10-08T07:00:00.000Z'])
    expect(run).toMatchObject({ reminded: true, overdue: true, escalated: 'CO_ASSIGNED' })
  })
})
