import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { getRequestView, listMyRequests } from '@/server/queries/requests'
import { decideTask, requestInfo } from '@/server/services/approvals/decide'
import { createDraft, submitRequest } from '@/server/services/requests'
import { escalateTask } from '@/server/services/sla'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { createTwoStepOrg } from '../support/two-step-doa'

// NEW-46 (FR-INT-008 AC1, BR-SLA-04): the request page of an escalated step names everyone who may decide it — the
// first assignee and the approver of the band above added as co-assignee — in "รอใคร" (the stage), the route and the
// timeline alike; once one of them decides, the route names who really decided and nobody waits on that step any more.
// DOA-TWO-STEP (tests/support/two-step-doa.ts): PR-01 is the DM of CON then the VP of OPS, and the COO joins step 1 when
// it escalates. A request sent Monday 5 Oct 2026 09:00 Thai time escalates Tuesday 16:00.

const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const at = (iso: string) => new Date(iso)
const MON_0900 = at('2026-10-05T02:00:00Z')
const TUE_1600 = at('2026-10-06T09:00:00Z')
const TUE_1610 = at('2026-10-06T09:10:00Z')
const TUE_1630 = at('2026-10-06T09:30:00Z')
const TUE_1640 = at('2026-10-06T09:40:00Z')

let twoStep: DoaOrg
let oneStep: DoaOrg
beforeAll(async () => {
  setDefaultOutboxSender(null)
  twoStep = await createTwoStepOrg()
  oneStep = await createDoaOrg()
  await prisma.roleAssignment.create({ data: { organizationId: oneStep.organizationId, memberId: oneStep.member.admin!, role: 'ORG_ADMIN', grantedAt: at('2026-01-01T00:00:00Z') } })
})

/** A request of `grossBaht` sent at Monday 09:00 and escalated at Tuesday 16:00: its first task and the co-assignee's */
async function escalated(org: DoaOrg, grossBaht: string) {
  const draft = await createDraft(org.ctxOf('req_con', MON_0900), { requestTypeCode: 'BUY_GOODS', title: 'วัสดุก่อสร้าง', priceIncludesVat: true, lines: [{ description: 'ปูนซีเมนต์', quantity: '1', uom: 'งาน', unitPrice: grossBaht }] }, key())
  if (!draft.ok) throw new Error(`draft failed: ${JSON.stringify(draft.error)}`)
  const requestId = draft.data.requestId
  const sent = await submitRequest(org.ctxOf('req_con', MON_0900), { requestId }, key())
  if (!sent.ok) throw new Error(`submit failed: ${JSON.stringify(sent.error)}`)
  const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: requestId } } } })
  const up = await escalateTask(org.organizationId, task.id, TUE_1600)
  if (!up.coAssigneeTaskId) throw new Error(`not escalated: ${JSON.stringify(up)}`)
  return { requestId, task, coTaskId: up.coAssigneeTaskId }
}

const waitingNow = (track: ReadonlyArray<{ state: string; what: string; actor: { id: string } | null; stepNo: number | null }>) =>
  track.filter((t) => t.state === 'current').map((t) => [t.what, t.actor?.id ?? null, t.stepNo])

describe('[FR-INT-008/AC1] an escalated step: "waiting for", the route and the timeline name the same people (NEW-46)', () => {
  it('before any decision both the DM and the co-assignee wait — in the stage, on the route’s step and in the timeline', async () => {
    const m = twoStep.member
    const { requestId, task, coTaskId } = await escalated(twoStep, '10000.00')
    const view = await getRequestView(twoStep.ctxOf('req_con', TUE_1610), requestId)
    expect(view!.stage).toMatchObject({ kind: 'APPROVER', taskId: task.id, assignee: { id: m.dm_con }, role: { kind: 'POSITION', positionCode: 'DM' }, overdue: true, stepNo: 1, stepCount: 2 })
    const stage = view!.stage as Extract<NonNullable<typeof view>['stage'], { kind: 'APPROVER' }>
    expect(stage.approvers!.map((a) => [a.taskId, a.assignee.id])).toEqual([
      [task.id, m.dm_con],
      [coTaskId, m.coo],
    ])
    // The co-assignee joined at the escalation, past the step's due time: overdue from the start
    expect(stage.approvers![1]).toMatchObject({ role: { kind: 'POSITION', positionCode: 'COO' }, onBehalfOf: null, since: TUE_1600, dueAt: task.dueAt, overdue: true, waitingMinutes: 10 })
    // The route's step 1 waits for both, flagged as escalated (BR-SLA-04); step 2 waits for its turn
    expect(view!.route!.steps).toMatchObject([
      {
        stepNo: 1,
        status: 'ACTIVE',
        approver: { id: m.dm_con },
        decision: null,
        taskStatus: 'OPEN',
        open: [
          { taskId: task.id, approver: { id: m.dm_con }, role: { positionCode: 'DM' }, status: 'OPEN' },
          { taskId: coTaskId, approver: { id: m.coo }, role: { positionCode: 'COO' }, status: 'OPEN' },
        ],
        escalation: 'CO_ASSIGNED',
      },
      { stepNo: 2, status: 'WAITING', approver: null, open: [], expected: { kind: 'POSITION', positionCode: 'VP' }, escalation: null },
    ])
    // Two current entries in the timeline, one per approver, before the steps still to come
    expect(waitingNow(view!.track)).toEqual([
      ['WAIT_APPROVAL', m.dm_con, 1],
      ['WAIT_APPROVAL', m.coo, 1],
    ])
    expect(view!.track.slice(-2).map((t) => [t.state, t.what])).toEqual([
      ['upcoming', 'NEXT_APPROVAL'],
      ['upcoming', 'NEXT_PROCUREMENT'],
    ])
    expect(new Set(view!.track.map((t) => t.key)).size).toBe(view!.track.length)
    // "My requests" says the same
    const mine = await listMyRequests(twoStep.ctxOf('req_con', TUE_1610), {})
    const row = mine.rows.find((r) => r.id === requestId)!
    expect(row.stage.kind === 'APPROVER' ? row.stage.approvers!.map((a) => a.assignee.id) : null).toEqual([m.dm_con, m.coo])
  })

  it('after the co-assignee decides, the route names the co-assignee and nobody waits on step 1; step 2 waits for its own approver', async () => {
    const m = twoStep.member
    const { requestId, task, coTaskId } = await escalated(twoStep, '11000.00')
    expect(await decideTask(twoStep.ctxOf('coo', TUE_1630), { taskId: coTaskId, decision: 'APPROVE' }, key())).toMatchObject({ ok: true })
    const view = await getRequestView(twoStep.ctxOf('req_con', TUE_1640), requestId)
    expect(view!.route!.steps[0]).toMatchObject({ stepNo: 1, status: 'DONE', approver: { id: m.coo }, role: { positionCode: 'COO' }, decision: 'APPROVE', decidedAt: TUE_1630, taskStatus: 'APPROVED', open: [], escalation: 'CO_ASSIGNED' })
    expect(view!.route!.steps[1]).toMatchObject({ stepNo: 2, status: 'ACTIVE', approver: { id: m.vp_ops }, open: [{ approver: { id: m.vp_ops }, status: 'OPEN' }], escalation: null })
    expect(view!.stage).toMatchObject({ kind: 'APPROVER', assignee: { id: m.vp_ops }, stepNo: 2, since: TUE_1630 })
    expect((view!.stage as { approvers?: ReadonlyArray<{ assignee: { id: string } }> }).approvers!.map((a) => a.assignee.id)).toEqual([m.vp_ops])
    // Nobody waits on step 1: the timeline's only current entry is step 2's
    expect(waitingNow(view!.track)).toEqual([['WAIT_APPROVAL', m.vp_ops, 2]])
    // The stamp names who decided step 1, under the route's own rule, with the escalated flag (BR-SLA-04)
    expect(view!.track.filter((t) => t.what === 'APPROVED').map((t) => [t.actor?.id, t.doa?.ruleCode, t.escalated])).toEqual([[m.coo, 'PR-01', true]])
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'CANCELLED' })
  })

  it('when the first assignee decides first, the route names them, not the co-assignee whose task their decision cancelled', async () => {
    const m = oneStep.member
    const { requestId, task, coTaskId } = await escalated(oneStep, '12000.00')
    expect(task.assigneeMemberId).toBe(m.dm_con)
    expect(await decideTask(oneStep.ctxOf('dm_con', TUE_1630), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: true, data: { documentStatus: 'APPROVED' } })
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: coTaskId } })).toMatchObject({ status: 'CANCELLED' })
    const view = await getRequestView(oneStep.ctxOf('req_con', TUE_1640), requestId)
    expect(view!.route!.steps).toMatchObject([{ stepNo: 1, status: 'DONE', approver: { id: m.dm_con }, role: { positionCode: 'DM' }, decision: 'APPROVE', taskStatus: 'APPROVED', open: [], escalation: 'CO_ASSIGNED' }])
    expect(view!.stage).toMatchObject({ kind: 'PROCUREMENT', since: TUE_1630 })
    expect(waitingNow(view!.track)).toEqual([['WAIT_PROCUREMENT', null, null]])
    // The flag is the step's, whoever of the two decided it
    expect(view!.track.filter((t) => t.what === 'APPROVED').map((t) => [t.actor?.id, t.escalated])).toEqual([[m.dm_con, true]])
  })

  it('a question of the co-assignee needs no answer once the first assignee decides: the page says so, and asks for nothing', async () => {
    const m = twoStep.member
    const { requestId, task, coTaskId } = await escalated(twoStep, '13500.00')
    expect(await requestInfo(twoStep.ctxOf('coo', TUE_1610), { taskId: coTaskId, question: 'ขอใบเสนอราคาอีกหนึ่งราย' }, key())).toMatchObject({ ok: true })
    expect(await decideTask(twoStep.ctxOf('dm_con', TUE_1630), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: true })
    const view = await getRequestView(twoStep.ctxOf('req_con', TUE_1640), requestId)
    expect(view!.infoRequests).toMatchObject([{ taskId: coTaskId, question: 'ขอใบเสนอราคาอีกหนึ่งราย', answer: null, noLongerNeeded: 'STEP_DECIDED' }])
    expect(view!.openInfoRequest).toBeNull()
    // Step 2 waits for the VP; nobody waits for the requester
    expect(view!.stage).toMatchObject({ kind: 'APPROVER', assignee: { id: m.vp_ops }, stepNo: 2 })
    expect(waitingNow(view!.track)).toEqual([['WAIT_APPROVAL', m.vp_ops, 2]])
  })

  it('a step past its escalation time with nobody above to add is marked NO_NEXT_BAND: no co-assignee, no flag on its decision', async () => {
    const m = oneStep.member
    // PR-03 (the CEO) has no band above it: ORG_ADMIN and the requester are told instead (BR-SLA-04)
    const draft = await createDraft(oneStep.ctxOf('req_con', MON_0900), { requestTypeCode: 'BUY_GOODS', title: 'เครื่องจักร', priceIncludesVat: true, lines: [{ description: 'รถขุด', quantity: '1', uom: 'คัน', unitPrice: '150000.00' }] }, key())
    if (!draft.ok) throw new Error(JSON.stringify(draft.error))
    for (let i = 0; i < 3; i++) {
      const file = await prisma.fileObject.create({ data: { organizationId: oneStep.organizationId, storageKey: `test/${randomUUID()}.pdf`, fileName: 'q.pdf', mimeType: 'application/pdf', sizeBytes: 1, status: 'AVAILABLE', uploadedById: m.req_con! } })
      await prisma.fileLink.create({ data: { organizationId: oneStep.organizationId, fileId: file.id, subjectType: 'Request', subjectId: draft.data.requestId, kind: 'QUOTATION' } })
    }
    expect(await submitRequest(oneStep.ctxOf('req_con', MON_0900), { requestId: draft.data.requestId }, key())).toMatchObject({ ok: true })
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: draft.data.requestId } } } })
    expect(task.assigneeMemberId).toBe(m.ceo)
    // 16 business hours: escalated Wednesday 15:00
    expect(await escalateTask(oneStep.organizationId, task.id, at('2026-10-07T08:00:00Z'))).toMatchObject({ done: true, outcome: 'NO_NEXT_BAND' })
    const view = await getRequestView(oneStep.ctxOf('req_con', at('2026-10-07T08:10:00Z')), draft.data.requestId)
    expect(view!.route!.steps).toMatchObject([{ stepNo: 1, status: 'ACTIVE', approver: { id: m.ceo }, open: [{ taskId: task.id }], escalation: 'NO_NEXT_BAND' }])
  })

  it('a question of the co-assignee waits for the requester’s answer first, while the first assignee may still decide', async () => {
    const m = twoStep.member
    const { requestId, task, coTaskId } = await escalated(twoStep, '13000.00')
    expect(await requestInfo(twoStep.ctxOf('coo', TUE_1610), { taskId: coTaskId, question: 'ขอใบเสนอราคาอีกหนึ่งราย' }, key())).toMatchObject({ ok: true })
    const view = await getRequestView(twoStep.ctxOf('req_con', TUE_1630), requestId)
    // The requester sees the question to answer, although the DM's task came first
    expect(view!.stage).toMatchObject({ kind: 'ANSWER', taskId: coTaskId, question: 'ขอใบเสนอราคาอีกหนึ่งราย', askedBy: { id: m.coo }, since: TUE_1610 })
    expect((view!.stage as { approvers?: ReadonlyArray<{ assignee: { id: string } }> }).approvers!.map((a) => a.assignee.id)).toEqual([m.dm_con])
    expect(view!.openInfoRequest).toMatchObject({ taskId: coTaskId, question: 'ขอใบเสนอราคาอีกหนึ่งราย' })
    expect(view!.route!.steps[0]!.open!.map((o) => [o.taskId, o.status])).toEqual([
      [task.id, 'OPEN'],
      [coTaskId, 'INFO_REQUESTED'],
    ])
    expect(waitingNow(view!.track)).toEqual([
      ['WAIT_ANSWER', m.req_con, null],
      ['WAIT_APPROVAL', m.dm_con, 1],
    ])
  })
})
