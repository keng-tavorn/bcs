import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { FOLLOW_UP_QUIET_MS, MS_PER_DAY, MS_PER_HOUR } from '@/lib/constants'
import { makeCtx, systemCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { appendEvents } from '@/server/events/append'
import { deliverNotification, TASK_CLOSED } from '@/server/notifications/deliver'
import { renderNotification } from '@/server/notifications/templates'
import { listFollowUps, sendFollowUp, type FollowUpDto } from '@/server/services/assistants/follow-up'
import { remindTask } from '@/server/services/board'
import { assignSupplier, consolidateNow } from '@/server/services/procurement'
import { submitPo } from '@/server/services/purchase-orders'
import { manageFollowers } from '@/server/services/requests/followers'
import { AP_NOW, key, ok } from '../support/ap'
import type { DoaOrg } from '../support/doa-org'
import { createP1Org } from '../support/p1-org'
import { p2p } from '../support/p2p'
import { createDraft, submitRequest } from '../support/requests'

// NEW-124 (ADR-082 · FR-VIS-001 AC4 to AC6): the follow-up assistant against Postgres. The requester's printer waits an
// hour past its approver's due time, while that approver set an acting delegate for requests from yesterday (the task
// came before, so it stayed with them); a second request, sent after, went to the delegate on the approver's behalf; a PO
// the buyer sent waits for its approver, who the SLA job reminded half an hour ago. Each member lists only what they
// follow, a nudge goes only to the holder and names who pressed send, once a task a day and not right after the holder
// was told.

const NOW = AP_NOW // 10:00 in Bangkok
const NEXT_MIDNIGHT = '2026-10-12T17:00:00.000Z'
const hours = (h: number) => new Date(NOW.getTime() + h * MS_PER_HOUR)

let org: DoaOrg
let printer: { requestId: string; number: string; taskId: string; approver: string }
let acting: { requestId: string; taskId: string; delegate: string }
let po: { poId: string; taskId: string }
let delegationEndsAt: Date

const as = (code: string, at = NOW) => org.ctxOf(code, at)
const codeOf = (memberId: string) => Object.entries(org.member).find(([, id]) => id === memberId)![0]
const list = async (code: string, at = NOW): Promise<readonly FollowUpDto[]> => ok(await listFollowUps(as(code, at))).items
const nudge = (code: string, taskId: string, at = NOW, via: 'LINE' | 'EMAIL' = 'LINE', options = key()) => sendFollowUp(as(code, at), { taskId, via, text: 'ขอติดตามงานนี้ด้วย ขอบคุณ' }, options)
const followUps = (taskId: string) => prisma.event.findMany({ where: { type: 'approval_task.followed_up', aggregateId: taskId }, orderBy: { seq: 'asc' } })

async function sentRequest(title: string, line: string) {
  const draft = ok(await createDraft(as('req_con'), { requestTypeCode: 'BUY_GOODS', title, budgetLineId: line, lines: [{ description: title, quantity: '1', uom: 'เครื่อง', unitPrice: '5000.00' }] }, key()))
  ok(await submitRequest(as('req_con'), { requestId: draft.requestId }, key()))
  const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: draft.requestId } } } })
  return { requestId: draft.requestId, task }
}

beforeAll(async () => {
  org = await createP1Org()
  const { organizationId } = org
  const flow = p2p(org, NOW)
  // an ORG_ADMIN reads every request, so may follow one
  await prisma.roleAssignment.create({ data: { organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })

  // the buyer's PO of an approved request, sent for approval and not yet decided
  const supplierId = (await prisma.supplier.create({ data: { organizationId, code: 'S-FU', nameTh: 'ผู้ขายติดตาม', email: 'fu@test.bcs.local', isForeign: true } })).id
  const approved = await flow.approvedRequest(await flow.fundedLine(100_000n), [{ quantity: '2', unitPrice: '1000.00', description: 'โต๊ะ' }])
  const site = await prisma.deliverySite.create({ data: { organizationId, code: `SITE-${randomUUID().slice(0, 8)}`, nameTh: 'ไซต์ติดตาม', address: 'ถนนทดสอบ' } })
  await prisma.request.update({ where: { id: approved.id }, data: { deliverySiteId: site.id } })
  ok(await assignSupplier(as('proc_officer'), { requestLineIds: approved.lines.map((l) => l.id), supplierId }, key()))
  const run = ok(await consolidateNow(as('proc_officer'), key()))
  const poRow = await prisma.purchaseOrder.findFirstOrThrow({ where: { id: { in: [...run.purchaseOrderIds] }, deliverySiteId: site.id } })
  ok(await submitPo(as('proc_officer'), { poId: poRow.id }, key()))
  const poTask = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: poRow.id } } } })
  await prisma.approvalTask.update({ where: { id: poTask.id }, data: { assignedAt: hours(-24), dueAt: hours(3) } })
  // the SLA job reminded its approver half an hour ago (the event its command writes, BR-SLA-02)
  await forTenant(organizationId).$transaction((tx) =>
    appendEvents(tx, systemCtx(organizationId, hours(-0.5), 'approval-task-sla'), [{ type: 'approval_task.reminded', aggregateType: 'ApprovalTask', aggregateId: poTask.id, data: { subjectType: 'PURCHASE_ORDER', subjectId: poRow.id, via: 'SLA' } }]),
  )
  po = { poId: poRow.id, taskId: poTask.id }

  // the printer: given to its approver three days ago, due three hours ago, marked overdue then, escalating in four hours
  const line = await flow.fundedLine(100_000n)
  const first = await sentRequest('เครื่องพิมพ์', line)
  await prisma.approvalTask.update({ where: { id: first.task.id }, data: { assignedAt: hours(-72), dueAt: hours(-3), overdueAt: hours(-3), escalateAt: hours(4) } })
  const request = await prisma.request.findUniqueOrThrow({ where: { id: first.requestId }, select: { number: true } })
  printer = { requestId: first.requestId, number: request.number!, taskId: first.task.id, approver: codeOf(first.task.assigneeMemberId) }
  // the admin follows it, and so does its approver
  ok(await manageFollowers(as('req_con'), { requestId: printer.requestId, memberId: org.member.admin!, follow: true }, key()))
  ok(await manageFollowers(as('req_con'), { requestId: printer.requestId, memberId: first.task.assigneeMemberId, follow: true }, key()))

  // the approver's acting delegate for requests, from yesterday for five days (why they are away is never shown)
  const delegate = Object.keys(org.member).find((c) => !['req_con', 'admin', 'proc_officer', printer.approver].includes(c) && c.startsWith('dm_'))!
  delegationEndsAt = new Date(NOW.getTime() + 5 * MS_PER_DAY)
  await prisma.delegation.create({
    data: { organizationId, delegatorMemberId: first.task.assigneeMemberId, delegateMemberId: org.member[delegate]!, startsAt: hours(-24), endsAt: delegationEndsAt, documentTypes: ['PURCHASE_REQUEST'], reason: 'ลาพักร้อน', status: 'ACTIVE', createdVia: 'SELF' },
  })
  // a second request after it started: routed to the delegate on the approver's behalf (BR-DLG-04), due in five hours
  const second = await sentRequest('จอภาพ', line)
  expect(second.task.assigneeMemberId).toBe(org.member[delegate])
  expect(second.task.principalMemberId).toBe(first.task.assigneeMemberId)
  await prisma.approvalTask.update({ where: { id: second.task.id }, data: { assignedAt: hours(-24), dueAt: hours(5) } })
  acting = { requestId: second.requestId, taskId: second.task.id, delegate }
}, 600_000)

describe('[FR-VIS-001/AC4] what waits past or near its due time, and why', () => {
  it('the requester reads both requests with who has them, the acting delegate, and what the SLA did', async () => {
    const items = await list('req_con')
    expect(items.map((i) => i.taskId)).toEqual([printer.taskId, acting.taskId])
    const [first, second] = items
    expect(first).toMatchObject({
      document: { type: 'REQUEST', id: printer.requestId, number: printer.number, title: 'เครื่องพิมพ์', href: `/requests/${printer.requestId}` },
      relation: 'REQUESTER',
      assignee: { id: org.member[printer.approver] },
      onBehalfOf: null,
      // set an acting delegate for requests, yet this task came before and stayed with them
      holderAwayUntil: delegationEndsAt,
      overdue: true,
      overdueAt: hours(-3),
      escalatesAt: hours(4),
      escalatedAt: null,
      slaRemindedAt: null,
      today: null,
      hold: null,
    })
    expect(second).toMatchObject({ relation: 'REQUESTER', assignee: { id: org.member[acting.delegate] }, onBehalfOf: { id: org.member[printer.approver], until: delegationEndsAt }, holderAwayUntil: null, overdue: false })
    // the reason of the delegation is never read into the list
    expect(JSON.stringify(items)).not.toContain('ลาพักร้อน')
  })

  it('a follower reads the request they follow; the buyer the PO they sent, with the SLA’s reminder', async () => {
    expect((await list('admin')).map((i) => [i.taskId, i.relation])).toEqual([[printer.taskId, 'FOLLOWER']])
    const [mine] = await list('proc_officer')
    expect(mine).toMatchObject({ taskId: po.taskId, relation: 'BUYER', document: { type: 'PURCHASE_ORDER', id: po.poId, href: `/procurement/pos/${po.poId}` }, slaRemindedAt: hours(-0.5) })
    // the holder was told half an hour ago: a nudge waits the quiet time
    expect(mine!.hold).toEqual({ reason: 'TOLD_RECENTLY', nextAt: new Date(hours(-0.5).getTime() + FOLLOW_UP_QUIET_MS) })
  })

  it('who does not follow the document reads nothing of it, and the holder never their own task', async () => {
    expect(await list('fin_officer')).toEqual([])
    // the approver follows the printer, which is theirs to decide; the second request is held for them
    expect(await list(printer.approver)).toEqual([])
    // one document's panel asks for that document only
    expect(ok(await listFollowUps(as('req_con'), { subjectId: acting.requestId })).items.map((i) => i.taskId)).toEqual([acting.taskId])
    expect(ok(await listFollowUps(as('req_con'), { subjectId: 'not-an-id' })).items).toEqual([])
  })

  it('a task further than a day from its due time is not listed', async () => {
    expect((await list('req_con', hours(-24))).map((i) => i.taskId)).toEqual([printer.taskId])
  })
})

describe('[FR-VIS-001/AC5] a nudge goes to the holder only, named by who pressed send', () => {
  it('the requester nudges the printer’s approver by LINE: one notice to the holder, an event without the words', async () => {
    const options = key()
    expect(ok(await nudge('req_con', printer.taskId, NOW, 'LINE', options))).toEqual({ taskId: printer.taskId, recipientMemberId: org.member[printer.approver], via: 'LINE' })
    // the same press again sends nothing more
    expect(ok(await nudge('req_con', printer.taskId, NOW, 'LINE', options))).toMatchObject({ taskId: printer.taskId })

    const events = await followUps(printer.taskId)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ actorType: 'USER', actorMemberId: org.member.req_con, aggregateType: 'ApprovalTask' })
    expect(events[0]!.data).toEqual({ subjectType: 'REQUEST', subjectId: printer.requestId, recipientMemberId: org.member[printer.approver], via: 'LINE', relation: 'REQUESTER', overdue: true })

    const notices = await prisma.notification.findMany({ where: { organizationId: org.organizationId, templateKey: { startsWith: 'task.follow_up' } } })
    expect(notices.map((n) => [n.recipientMemberId, n.templateKey])).toEqual([[org.member[printer.approver], 'task.follow_up']])
    const notice = notices[0]!
    expect(renderNotification(notice, 'th')).toEqual({ title: `มีข้อความติดตามงานอนุมัติคำขอ ${printer.number}`, body: 'เปิด BCS เพื่ออ่านข้อความและพิจารณา', href: `/tasks/${printer.taskId}` })
    expect(renderNotification(notice, 'th', 'IN_APP').body).toBe('ขอติดตามงานนี้ด้วย ขอบคุณ')
  })

  it('who does not follow the document, the holder, an agent and a job may not nudge', async () => {
    expect(await nudge('fin_officer', acting.taskId)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', details: { reason: 'NOT_FOLLOWER' } } })
    // the approver follows the printer, which is theirs to decide
    expect(await nudge(printer.approver, printer.taskId, hours(30))).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', details: { reason: 'OWN_TASK' } } })
    const agent = makeCtx({ organizationId: org.organizationId, actor: { type: 'AI_AGENT', agentId: 'insight' }, channel: 'WEB', now: NOW })
    expect(await sendFollowUp(agent, { taskId: acting.taskId, via: 'LINE', text: 'ติดตาม' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await sendFollowUp(systemCtx(org.organizationId, NOW, 'job'), { taskId: acting.taskId, via: 'LINE', text: 'ติดตาม' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    // a task more than a day from its due time is not nudged, and a nudge has words
    expect(await nudge('req_con', acting.taskId, hours(-24))).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'NOT_DUE_SOON' } } })
    expect(await sendFollowUp(as('req_con'), { taskId: acting.taskId, via: 'LINE', text: '   ' }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(await followUps(acting.taskId)).toHaveLength(0)
  })
})

describe('[FR-VIS-001/AC6] once a task a day, and not right after the holder was told', () => {
  it('a follower may not nudge the printer again today; tomorrow they may, by e-mail', async () => {
    expect(await nudge('admin', printer.taskId, hours(1))).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED', details: { reason: 'SENT_TODAY', nextAt: NEXT_MIDNIGHT } } })
    const [row] = await list('admin', hours(1))
    expect(row).toMatchObject({ today: { count: 1, lastById: org.member.req_con }, hold: { reason: 'SENT_TODAY', nextAt: new Date(NEXT_MIDNIGHT) } })

    expect(ok(await nudge('admin', printer.taskId, new Date(NEXT_MIDNIGHT), 'EMAIL'))).toMatchObject({ via: 'EMAIL' })
    expect((await followUps(printer.taskId)).map((e) => e.actorMemberId)).toEqual([org.member.req_con, org.member.admin])
    const email = await prisma.notification.findFirstOrThrow({ where: { organizationId: org.organizationId, templateKey: 'task.follow_up_email' } })
    expect(email.recipientMemberId).toBe(org.member[printer.approver])
  })

  it('not within the quiet time after the SLA job or the board told the holder', async () => {
    expect(await nudge('proc_officer', po.taskId)).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED', details: { reason: 'TOLD_RECENTLY', nextAt: hours(1.5).toISOString() } } })
    // the requester reminds the delegate from the board (FR-VIS-001 AC2), then drafts a nudge an hour later
    ok(await remindTask(as('req_con'), { taskId: acting.taskId }, key()))
    expect(await nudge('req_con', acting.taskId, hours(1))).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED', details: { reason: 'TOLD_RECENTLY', nextAt: hours(2).toISOString() } } })
    expect(ok(await nudge('req_con', acting.taskId, hours(2)))).toEqual({ taskId: acting.taskId, recipientMemberId: org.member[acting.delegate], via: 'LINE' })
  })
})

describe('[FR-VIS-001/AC5] a nudge waits for its task (FR-NOTI-003 AC3)', () => {
  it('is not sent once the task was decided', async () => {
    const email = await prisma.notification.findFirstOrThrow({ where: { organizationId: org.organizationId, templateKey: 'task.follow_up_email', status: 'PENDING' } })
    await p2p(org, NOW).approveAll(printer.requestId)
    expect(await deliverNotification(org.organizationId, email.id, new Date(NEXT_MIDNIGHT))).toEqual({ status: 'SKIPPED', why: TASK_CLOSED })
    // nor may a decided task be nudged
    expect(await nudge('req_con', printer.taskId, hours(48))).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION' } })
  })
})
