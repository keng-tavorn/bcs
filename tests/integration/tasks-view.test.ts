import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { canViewRequest, taskRight } from '@/app/(workspace)/_tracking/access'
import { memberPrincipal } from '@/server/authz'
import { prisma } from '@/server/db/client'
import { getRequestAccess, getRequestView, listMyRequests } from '@/server/queries/requests'
import { getTaskAccess, getTaskView, listMyTasks } from '@/server/queries/tasks'
import { decideTask, provideInfo, requestInfo } from '@/server/services/approvals/decide'
import { importDoaDraft, submitDoaVersion } from '@/server/services/doa'
import { proposeOrgChange } from '@/server/services/org-authority'
import { cancelRequest, createDraft, editRequest, resubmitRequest, submitRequest } from '@/server/services/requests'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// S2-12: the read side of the inbox, the decision page and the request view (FR-INT-008, FR-DOA-003 AC2, FR-DOA-004,
// FR-DOA-005 AC2, FR-PLT-003 AC3) on an organization built from the §7.4 fixtures, and the read permissions the pages
// check with src/server/authz before they read (request.view, approval.decide). Monday 5 Oct 2026 10:00 Thai time;
// business hours Mon–Fri 08:30–17:30.

const NOW = new Date('2026-10-05T03:00:00Z')
const MON_1300 = new Date('2026-10-05T06:00:00Z')
const TUE_1000 = new Date('2026-10-06T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const FIXTURE = readFileSync(path.resolve(import.meta.dirname, '../golden/fixtures/doa-versions.yaml'), 'utf8')

let org: DoaOrg
beforeAll(async () => {
  org = await createDoaOrg()
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
})

const name = (code: string) => ({ th: `ผู้ใช้ ${code}`, en: null })

async function submitted(requester: string, grossBaht: string, title = 'วัสดุก่อสร้าง') {
  const draft = await createDraft(
    org.ctxOf(requester, NOW),
    { requestTypeCode: 'BUY_GOODS', title, priceIncludesVat: true, lines: [{ description: 'ปูนซีเมนต์', quantity: '1', uom: 'งาน', unitPrice: grossBaht }] },
    key(),
  )
  if (!draft.ok) throw new Error(`draft failed: ${draft.error.code}`)
  const sent = await submitRequest(org.ctxOf(requester, NOW), { requestId: draft.data.requestId }, key())
  if (!sent.ok) throw new Error(`submit failed: ${sent.error.code}`)
  return { requestId: draft.data.requestId, number: sent.data.number }
}

async function openTask(requestId: string) {
  return prisma.approvalTask.findFirstOrThrow({ where: { status: { in: ['OPEN', 'INFO_REQUESTED'] }, step: { route: { subjectType: 'REQUEST', subjectId: requestId } } } })
}

describe('[FR-INT-008/AC1] the timeline shows the current step, who it waits for, the business hours waited and the steps left', () => {
  it('names the VP of OPS with their position, counts business hours and marks the task overdue after its due time', async () => {
    const { requestId, number } = await submitted('req_con', '45000.00')
    const view = await getRequestView(org.ctxOf('req_con', MON_1300), requestId)
    expect(view).not.toBeNull()
    // Monday 10:00 to 13:00 = 180 business minutes; due Tuesday 09:00 (8 business hours, BR-SLA-01)
    expect(view!.stage).toMatchObject({
      kind: 'APPROVER',
      assignee: { id: org.member.vp_ops, name: name('vp_ops') },
      role: { kind: 'POSITION', positionCode: 'VP', department: { th: 'สายปฏิบัติการ', en: null }, orgWide: false },
      waitingMinutes: 180,
      dueAt: new Date('2026-10-06T02:00:00Z'),
      overdue: false,
      stepNo: 1,
      stepCount: 1,
    })
    expect(view!.track.map((t) => [t.state, t.what])).toEqual([
      ['done', 'CREATED'],
      ['done', 'SUBMITTED'],
      ['current', 'WAIT_APPROVAL'],
      ['upcoming', 'NEXT_PROCUREMENT'],
    ])
    expect(view!.track[1]).toMatchObject({ actor: { id: org.member.req_con }, channel: 'WEB', number, at: NOW })
    expect(view!.track[2]).toMatchObject({ actor: { id: org.member.vp_ops }, role: { kind: 'POSITION', positionCode: 'VP' }, waitingMinutes: 180 })
    // Tuesday 10:00: 7.5 hours on Monday and 1.5 on Tuesday; past the due time
    const later = await getRequestView(org.ctxOf('req_con', TUE_1000), requestId)
    expect(later!.stage).toMatchObject({ kind: 'APPROVER', waitingMinutes: 540, overdue: true })
  })

  it('shows the money before VAT, the VAT and the budget the request reserved', async () => {
    const { requestId } = await submitted('req_con', '45000.00')
    const view = await getRequestView(org.ctxOf('req_con', NOW), requestId)
    // BR-VAT-03: the line includes VAT; VAT = round(45,000 × 700 / 10,700); the budget basis of the demo is NET
    expect(view!.totals).toEqual({ netSatang: 4_205_607n, vatSatang: 294_393n, grossSatang: 4_500_000n, vatRateBp: 700, priceIncludesVat: true })
    expect(view!.budget).toMatchObject({ code: 'CON-OPEX-2569', status: 'OPEN', reservedSatang: 4_205_607n, committedSatang: 0n })
    expect(view!.lines).toEqual([{ lineNo: 1, description: 'ปูนซีเมนต์', quantity: '1', uom: 'งาน', unitPriceSatang: 4_500_000n, netSatang: 4_500_000n, vatable: true, serviceEndDate: null }])
    expect(view!.actions).toEqual({ canEdit: false, canResubmit: false, canCancel: true })
  })
})

describe('[FR-DOA-003/AC2] after submitting, the requester sees the actual route with its rule and why', () => {
  it('shows DOA-DEMO version 1 rule PR-02, its band and the approver of each step', async () => {
    const { requestId } = await submitted('req_con', '45000.00')
    const view = await getRequestView(org.ctxOf('req_con', NOW), requestId)
    const version = await prisma.doaVersion.findFirstOrThrow({ where: { organizationId: org.organizationId, versionNo: 1 } })
    expect(view!.route).toMatchObject({
      routeNo: 1,
      status: 'ACTIVE',
      doa: { versionId: version.id, code: 'DOA-DEMO', versionNo: 1, ruleCode: 'PR-02' },
      escalatedFromRuleCode: null,
      amountBasis: 'GROSS',
      basisSatang: 4_500_000n,
      band: { lowerSatang: 2_000_000n, upperSatang: 10_000_000n },
      steps: [{ stepNo: 1, status: 'ACTIVE', approver: { id: org.member.vp_ops }, role: { kind: 'POSITION', positionCode: 'VP' }, decision: null }],
    })
    expect(view!.route!.explanationTh).toContain('DOA-DEMO ฉบับ 1 ข้อ PR-02')
  })

  it('explains an escalation: a department manager asking for their own department goes to the next band (BR-DOA-06)', async () => {
    const { requestId } = await submitted('dm_con', '15000.00')
    const view = await getRequestView(org.ctxOf('dm_con', NOW), requestId)
    expect(view!.route).toMatchObject({ doa: { ruleCode: 'PR-02' }, escalatedFromRuleCode: 'PR-01', band: { lowerSatang: 0n, upperSatang: 2_000_000n }, steps: [{ approver: { id: org.member.vp_ops } }] })
    expect(view!.route!.explanationTh).toContain('PR-01')
  })
})

describe('[FR-DOA-005/AC2] [FR-PLT-003/AC3] a decision names who, what, which channel, when and the DOA version and rule', () => {
  it('shows "approved under DOA-DEMO version 1 rule PR-02" and the approval stamp on the timeline', async () => {
    const { requestId } = await submitted('req_con', '45000.00')
    const task = await openTask(requestId)
    expect(await decideTask(org.ctxOf('vp_ops', MON_1300, 'LIFF'), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: true })
    const view = await getRequestView(org.ctxOf('req_con', MON_1300), requestId)
    const version = await prisma.doaVersion.findFirstOrThrow({ where: { organizationId: org.organizationId, versionNo: 1 } })
    expect(view!.status).toBe('APPROVED')
    expect(view!.approvedUnder).toEqual({ versionId: version.id, code: 'DOA-DEMO', versionNo: 1, ruleCode: 'PR-02' })
    const stamp = view!.track.find((t) => t.what === 'APPROVED')
    expect(stamp).toMatchObject({
      state: 'done',
      actor: { id: org.member.vp_ops, name: name('vp_ops') },
      role: { kind: 'POSITION', positionCode: 'VP' },
      channel: 'LIFF',
      at: MON_1300,
      doa: { versionId: version.id, code: 'DOA-DEMO', versionNo: 1, ruleCode: 'PR-02' },
      onBehalfOf: null,
    })
    expect(view!.stage).toMatchObject({ kind: 'PROCUREMENT', since: MON_1300 })
    expect(view!.track.at(-1)).toMatchObject({ state: 'current', what: 'WAIT_PROCUREMENT' })
  })
})

describe('[FR-DOA-004/AC2] a decided task shows who decided it and when', () => {
  it('keeps the decision on the task and refuses a second one with the same who and when', async () => {
    const { requestId } = await submitted('req_con', '45000.00')
    const task = await openTask(requestId)
    await decideTask(org.ctxOf('vp_ops', NOW), { taskId: task.id, decision: 'APPROVE' }, key())
    const view = await getTaskView(org.ctxOf('vp_ops', MON_1300), task.id)
    expect(view).toMatchObject({ status: 'APPROVED', decision: 'APPROVE', decidedAt: NOW, decidedBy: { id: org.member.vp_ops, name: name('vp_ops') }, decidedChannel: 'WEB', waitingMinutes: null })
    const again = await decideTask(org.ctxOf('vp_ops', MON_1300), { taskId: task.id, decision: 'APPROVE' }, key())
    expect(again).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION', details: { name: 'ผู้ใช้ vp_ops', time: NOW.toISOString() } } })
  })
})

describe('[FR-INT-009/AC3] [FR-INT-009/AC2] [FR-INT-009/AC1] questions, returns, resubmits and cancels show where the request is', () => {
  it('waits for the requester while a question is open, then goes back to the approver', async () => {
    const { requestId } = await submitted('req_con', '45000.00')
    const task = await openTask(requestId)
    const asked = await requestInfo(org.ctxOf('vp_ops', MON_1300), { taskId: task.id, question: 'ขอใบเสนอราคาประกอบ' }, key())
    if (!asked.ok) throw new Error('ask failed')
    const waiting = await getRequestView(org.ctxOf('req_con', MON_1300), requestId)
    expect(waiting!.stage).toMatchObject({ kind: 'ANSWER', taskId: task.id, infoRequestId: asked.data.infoRequestId, question: 'ขอใบเสนอราคาประกอบ', askedBy: { id: org.member.vp_ops } })
    expect(waiting!.openInfoRequest).toMatchObject({ id: asked.data.infoRequestId, question: 'ขอใบเสนอราคาประกอบ', answer: null })
    expect(waiting!.track.find((t) => t.what === 'INFO_REQUESTED')).toMatchObject({ actor: { id: org.member.vp_ops }, note: 'ขอใบเสนอราคาประกอบ' })
    expect(waiting!.track.find((t) => t.state === 'current')).toMatchObject({ what: 'WAIT_ANSWER', actor: { id: org.member.req_con }, note: 'ขอใบเสนอราคาประกอบ' })
    const taskView = await getTaskView(org.ctxOf('vp_ops', MON_1300), task.id)
    expect(taskView).toMatchObject({ status: 'INFO_REQUESTED', openQuestion: { id: asked.data.infoRequestId, question: 'ขอใบเสนอราคาประกอบ' } })

    await provideInfo(org.ctxOf('req_con', TUE_1000), { infoRequestId: asked.data.infoRequestId, answer: 'แนบใบเสนอราคาแล้ว 1 ใบ' }, key())
    const answered = await getRequestView(org.ctxOf('req_con', TUE_1000), requestId)
    expect(answered!.stage).toMatchObject({ kind: 'APPROVER', assignee: { id: org.member.vp_ops } })
    expect(answered!.openInfoRequest).toBeNull()
    expect(answered!.track.find((t) => t.what === 'INFO_PROVIDED')).toMatchObject({ actor: { id: org.member.req_con }, note: 'แนบใบเสนอราคาแล้ว 1 ใบ', channel: 'WEB' })
  })

  it('shows the reason of a return and what the requester can do, then the new route and the cancellation', async () => {
    const { requestId } = await submitted('req_con', '45000.00')
    const task = await openTask(requestId)
    await decideTask(org.ctxOf('vp_ops', MON_1300), { taskId: task.id, decision: 'RETURN', reason: 'แยกรายการให้ชัดเจน' }, key())
    const returned = await getRequestView(org.ctxOf('req_con', MON_1300), requestId)
    expect(returned).toMatchObject({ status: 'RETURNED', returnReason: 'แยกรายการให้ชัดเจน', stage: { kind: 'REQUESTER_EDIT', since: MON_1300 }, actions: { canEdit: true, canResubmit: true, canCancel: true } })
    expect(returned!.track.find((t) => t.what === 'RETURNED')).toMatchObject({ actor: { id: org.member.vp_ops }, note: 'แยกรายการให้ชัดเจน', doa: { ruleCode: 'PR-02' } })

    await editRequest(
      org.ctxOf('req_con', TUE_1000),
      { requestId, title: 'วัสดุก่อสร้าง (แก้)', priceIncludesVat: true, lines: [{ description: 'ปูนซีเมนต์', quantity: '1', uom: 'งาน', unitPrice: '15000.00' }] },
      key(),
    )
    expect(await resubmitRequest(org.ctxOf('req_con', TUE_1000), { requestId }, key())).toMatchObject({ ok: true })
    const again = await getRequestView(org.ctxOf('req_con', TUE_1000), requestId)
    // BR-DOA-09: a new route with the rule of the new amount; the timeline keeps the first round and the requester's edit
    expect(again!.route).toMatchObject({ routeNo: 2, doa: { ruleCode: 'PR-01' }, steps: [{ approver: { id: org.member.dm_con } }] })
    expect(again!.track.filter((t) => t.state === 'done').map((t) => t.what)).toEqual(['CREATED', 'SUBMITTED', 'RETURNED', 'EDITED', 'RESUBMITTED'])

    expect(await cancelRequest(org.ctxOf('req_con', TUE_1000), { requestId, reason: 'ไม่ต้องใช้แล้ว' }, key())).toMatchObject({ ok: true })
    const cancelled = await getRequestView(org.ctxOf('req_con', TUE_1000), requestId)
    expect(cancelled).toMatchObject({ status: 'CANCELLED', cancelReason: 'ไม่ต้องใช้แล้ว', stage: { kind: 'CLOSED' }, actions: { canEdit: false, canResubmit: false, canCancel: false } })
    expect(cancelled!.track.at(-1)).toMatchObject({ state: 'done', what: 'CANCELLED', note: 'ไม่ต้องใช้แล้ว', actor: { id: org.member.req_con } })
    expect(cancelled!.budget!.reservedSatang).toBe(0n)
  })
})

describe('[FR-INT-008/AC1] a new-supplier request waits in the procurement queue, without amounts or a DOA route (OQ-23)', () => {
  it('shows the queue as the current step, the form fields, and no totals or route', async () => {
    const created = await createDraft(org.ctxOf('req_con', NOW), { requestTypeCode: 'NEW_SUPPLIER', title: 'เพิ่มผู้ขายวัสดุ', formData: { supplierName: 'บริษัท ตัวอย่าง จำกัด' } }, { idempotencyKey: randomUUID(), sender: null })
    if (!created.ok) throw new Error('draft failed')
    const id = created.data.requestId
    const sent = await submitRequest(org.ctxOf('req_con', NOW), { requestId: id }, { idempotencyKey: randomUUID(), sender: null })
    expect(sent.ok).toBe(true)
    const view = await getRequestView(org.ctxOf('req_con', MON_1300), id)
    expect(view).toMatchObject({ status: 'SUBMITTED', documentType: 'SUPPLIER_REQUEST', totals: null, route: null, budget: null, stage: { kind: 'QUEUE', since: NOW, waitingMinutes: 180 } })
    expect(view!.fields).toEqual([{ id: 'supplierName', label: null, value: { kind: 'TEXT', text: 'บริษัท ตัวอย่าง จำกัด' } }])
    expect(view!.track.map((t) => [t.state, t.what])).toEqual([
      ['done', 'CREATED'],
      ['done', 'SUBMITTED'],
      ['current', 'WAIT_QUEUE'],
    ])
    // The cancel command moves a supplier request on its own machine (§6.4: SUBMITTED → CANCELLED), so it is offered
    expect(view!.actions).toEqual({ canEdit: false, canResubmit: false, canCancel: true })
    const row = (await listMyRequests(org.ctxOf('req_con', MON_1300))).rows.find((r) => r.id === id)
    expect(row).toMatchObject({ grossSatang: null, stage: { kind: 'QUEUE' } })
  })
})

describe('[FR-INT-008/AC3] "my requests" filters by status and finds a request by its number', () => {
  it('lists only the member’s own and followed requests, by status and by part of the number', async () => {
    const pending = await submitted('receiver_con', '30000.00', 'ถุงมือนิรภัย')
    const other = await submitted('receiver_con', '31000.00', 'รองเท้านิรภัย')
    const task = await openTask(other.requestId)
    await decideTask(org.ctxOf('vp_ops', NOW), { taskId: task.id, decision: 'RETURN', reason: 'ระบุขนาด' }, key())

    const all = await listMyRequests(org.ctxOf('receiver_con', MON_1300))
    expect(all.total).toBe(2)
    expect(all.rows.map((r) => r.number).sort()).toEqual([pending.number, other.number].sort())
    expect(all.rows.find((r) => r.id === pending.requestId)).toMatchObject({ status: 'PENDING_APPROVAL', relation: 'REQUESTER', grossSatang: 3_000_000n, stage: { kind: 'APPROVER', assignee: { id: org.member.vp_ops }, waitingMinutes: 180 } })

    const returned = await listMyRequests(org.ctxOf('receiver_con', MON_1300), { status: 'RETURNED' })
    expect(returned).toMatchObject({ total: 2, matched: 1, rows: [{ id: other.requestId, stage: { kind: 'REQUESTER_EDIT' } }] })
    const byNumber = await listMyRequests(org.ctxOf('receiver_con', MON_1300), { q: pending.number.slice(-5).toLowerCase() })
    expect(byNumber.rows.map((r) => r.id)).toEqual([pending.requestId])
    const none = await listMyRequests(org.ctxOf('receiver_con', MON_1300), { q: 'PR-2569-99999' })
    expect(none).toMatchObject({ total: 2, matched: 0, rows: [] })
    // An unknown status is ignored rather than trusted
    expect((await listMyRequests(org.ctxOf('receiver_con', MON_1300), { status: 'NOT_A_STATUS' })).matched).toBe(2)

    // Somebody else's requests never show; a follower sees the request they follow (FR-INT-008 AC2)
    expect((await listMyRequests(org.ctxOf('asst_con', MON_1300))).rows.map((r) => r.id)).not.toContain(pending.requestId)
    await prisma.requestFollower.create({ data: { organizationId: org.organizationId, requestId: pending.requestId, memberId: org.member.asst_con! } })
    expect((await listMyRequests(org.ctxOf('asst_con', MON_1300))).rows.find((r) => r.id === pending.requestId)).toMatchObject({ relation: 'FOLLOWER', stage: { kind: 'APPROVER' } })
  })
})

describe('[FR-INT-008/AC2] only those who may view a request see it (request.view, checked before reading)', () => {
  it('lets the requester, followers, approvers and organization-wide roles in, and nobody else', async () => {
    const { requestId } = await submitted('req_con', '45000.00')
    const access = await getRequestAccess(org.ctxOf('req_con', NOW), requestId)
    expect(access).toMatchObject({ requesterMemberId: org.member.req_con, taskMemberIds: [org.member.vp_ops], followerMemberIds: [] })
    const can = (code: string, roles: Parameters<typeof memberPrincipal>[1] = []) => canViewRequest(memberPrincipal(org.member[code]!, roles), access!)
    expect(can('req_con')).toBe(true)
    expect(can('vp_ops')).toBe(true)
    expect(can('proc_officer', ['PROCUREMENT'])).toBe(true)
    expect(can('auditor', ['AUDITOR'])).toBe(true)
    // Denied: another member of the same department, another approver, a receiver
    expect(can('asst_con')).toBe(false)
    expect(can('vp_sup')).toBe(false)
    expect(can('receiver_con', ['RECEIVER'])).toBe(false)
    expect(await getRequestAccess(org.ctxOf('req_con', NOW), 'not-a-uuid')).toBeNull()
    expect(await getRequestAccess(org.ctxOf('req_con', NOW), randomUUID())).toBeNull()
  })
})

describe('[FR-DOA-004/AC1] the approver’s inbox and who may decide a task', () => {
  it('lists open tasks oldest due first with the business time waited; only deciders get the decision page', async () => {
    const first = await submitted('fin_officer', '45000.00', 'กระดาษพิมพ์')
    const second = await submitted('fin_officer', '50000.00', 'หมึกพิมพ์')
    const inbox = await listMyTasks(org.ctxOf('vp_sup', MON_1300))
    const mine = inbox.items.filter((i) => i.subject.kind === 'REQUEST' && [first.requestId, second.requestId].includes(i.subject.requestId))
    expect(mine.map((i) => (i.subject.kind === 'REQUEST' ? i.subject.number : null))).toEqual([first.number, second.number])
    expect(mine[0]).toMatchObject({ status: 'OPEN', subjectType: 'REQUEST', waitingMinutes: 180, overdue: false, holding: null, stepUp: false, subject: { kind: 'REQUEST', title: 'กระดาษพิมพ์', grossSatang: 4_500_000n, requester: { id: org.member.fin_officer } } })
    expect(inbox.total).toBeGreaterThanOrEqual(2)
    // Nobody else's inbox has them
    expect((await listMyTasks(org.ctxOf('vp_ops', MON_1300))).items.map((i) => i.subjectId)).not.toContain(first.requestId)

    const task = await openTask(first.requestId)
    const access = await getTaskAccess(org.ctxOf('vp_sup', NOW), task.id)
    expect(access).toMatchObject({ status: 'OPEN', subjectType: 'REQUEST', subjectId: first.requestId, assigneeMemberId: org.member.vp_sup, principalMemberId: null })
    expect(taskRight(memberPrincipal(org.member.vp_sup!, []), access!)).toBe('DECIDE')
    // Denied: the requester, another approver, an organization admin (authority comes from the DOA, never a role)
    expect(taskRight(memberPrincipal(org.member.fin_officer!, ['FINANCE']), access!)).toBe('NONE')
    expect(taskRight(memberPrincipal(org.member.vp_ops!, []), access!)).toBe('NONE')
    expect(taskRight(memberPrincipal(org.member.admin!, ['ORG_ADMIN']), access!)).toBe('NONE')

    // After the decision the approver may still look back at it, but no longer decide it
    await decideTask(org.ctxOf('vp_sup', MON_1300), { taskId: task.id, decision: 'APPROVE' }, key())
    const decided = await getTaskAccess(org.ctxOf('vp_sup', MON_1300), task.id)
    expect(taskRight(memberPrincipal(org.member.vp_sup!, []), decided!)).toBe('VIEW')
    expect(taskRight(memberPrincipal(org.member.vp_ops!, []), decided!)).toBe('NONE')
    expect((await listMyTasks(org.ctxOf('vp_sup', MON_1300))).items.map((i) => i.id)).not.toContain(task.id)
  })
})

describe('[FR-DOA-010/AC2] [FR-DOA-002/AC2] a policy task shows what is being approved and asks for a step-up', () => {
  it('describes an appointment with names, the effective time, the reason and its impact', async () => {
    const proposed = await proposeOrgChange(
      org.ctxOf('admin', NOW),
      { kind: 'POSITION_ASSIGN', payload: { positionCode: 'VP', departmentId: org.department.OPS!, memberId: org.member.dm_proc! }, effectiveFrom: '2026-11-02T01:00:00Z', reason: 'แต่งตั้งตามคำสั่งบริษัท' },
      key(),
    )
    if (!proposed.ok) throw new Error(`propose failed: ${proposed.error.code}`)
    const inbox = await listMyTasks(org.ctxOf('ceo', MON_1300))
    const item = inbox.items.find((i) => i.subjectId === proposed.data.changeId)
    expect(item).toMatchObject({ subjectType: 'ORG_AUTHORITY_CHANGE', stepUp: true, subject: { kind: 'ORG_AUTHORITY_CHANGE', changeKind: 'POSITION_ASSIGN', effectiveFrom: new Date('2026-11-02T01:00:00Z') } })
    const view = await getTaskView(org.ctxOf('ceo', MON_1300), item!.id)
    expect(view).toMatchObject({
      status: 'OPEN',
      stepUp: true,
      role: { kind: 'POSITION', positionCode: 'CEO', orgWide: true },
      route: { doa: { code: 'DOA-DEMO', versionNo: 1, ruleCode: 'ORG-CHG-01' } },
      policy: {
        kind: 'ORG_AUTHORITY_CHANGE',
        changeKind: 'POSITION_ASSIGN',
        status: 'PENDING_APPROVAL',
        reason: 'แต่งตั้งตามคำสั่งบริษัท',
        submittedBy: { id: org.member.admin },
        details: { kind: 'POSITION_ASSIGN', position: { code: 'VP', name: { th: 'VP', en: null } }, department: { code: 'OPS', name: { th: 'สายปฏิบัติการ', en: null } }, member: { id: org.member.dm_proc } },
        impact: { gains: [{ id: org.member.dm_proc }], loses: [{ id: org.member.vp_ops }] },
      },
    })
    expect(view!.track.map((t) => t.what)).toEqual(['SUBMITTED'])
    expect(view!.track[0]).toMatchObject({ actor: { id: org.member.admin } })
  })

  it('describes a DOA version with the version it replaces and the tasks still running under it (BR-DOA-13)', async () => {
    const yaml = `versions:\n${FIXTURE.slice(FIXTURE.indexOf('  - code: DOA-DEMO\n    version: 2')).replace('version: 2', 'version: 31')}`
    const imported = await importDoaDraft(org.ctxOf('admin', NOW), { yaml }, key())
    if (!imported.ok) throw new Error(`import failed: ${imported.error.code}`)
    const versionId = imported.data.versionIds[0]!
    const sent = await submitDoaVersion(org.ctxOf('admin', NOW), { versionId }, key())
    if (!sent.ok) throw new Error(`submit failed: ${sent.error.code}`)
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectType: 'DOA_VERSION', subjectId: versionId } } } })
    const view = await getTaskView(org.ctxOf('ceo', MON_1300), task.id)
    const open = await prisma.approvalTask.count({ where: { organizationId: org.organizationId, status: { in: ['OPEN', 'INFO_REQUESTED'] }, step: { route: { status: 'ACTIVE', subjectType: { not: 'DOA_VERSION' }, doaVersion: { versionNo: 1 } } } } })
    expect(view).toMatchObject({ stepUp: true, policy: { kind: 'DOA_VERSION', versionId, code: 'DOA-DEMO', versionNo: 31, status: 'PENDING_APPROVAL', submittedBy: { id: org.member.admin }, current: { code: 'DOA-DEMO', versionNo: 1 }, openTasksUnderCurrent: open, holders: [] } })
    const policy = view!.policy!
    expect(policy.kind === 'DOA_VERSION' ? policy.ruleCount : 0).toBeGreaterThan(0)
  })
})

describe('[FR-PLT-003/AC3] [FR-DOA-004/AC1] a delegate’s decision names whom they acted for', () => {
  it('shows the delegate as holding the task for the delegator, in both inboxes and on the stamp', async () => {
    await prisma.delegation.create({
      data: {
        organizationId: org.organizationId,
        delegatorMemberId: org.member.dm_con!,
        delegateMemberId: org.member.asst_con!,
        startsAt: new Date('2026-10-05T00:00:00Z'),
        endsAt: new Date('2026-10-09T10:00:00Z'),
        documentTypes: [],
        reason: 'ลาพักร้อน',
        status: 'ACTIVE',
        createdVia: 'SELF',
      },
    })
    const { requestId } = await submitted('req_con', '10000.00')
    const task = await openTask(requestId)
    expect((await listMyTasks(org.ctxOf('asst_con', NOW))).items.find((i) => i.id === task.id)).toMatchObject({ holding: { kind: 'FOR', member: { id: org.member.dm_con } } })
    expect((await listMyTasks(org.ctxOf('dm_con', NOW))).items.find((i) => i.id === task.id)).toMatchObject({ holding: { kind: 'BY', member: { id: org.member.asst_con } } })
    const access = await getTaskAccess(org.ctxOf('asst_con', NOW), task.id)
    expect(taskRight(memberPrincipal(org.member.asst_con!, []), access!)).toBe('DECIDE')
    expect(taskRight(memberPrincipal(org.member.dm_con!, []), access!)).toBe('DECIDE')
    expect(taskRight(memberPrincipal(org.member.req_con!, []), access!)).toBe('NONE')

    await decideTask(org.ctxOf('asst_con', MON_1300), { taskId: task.id, decision: 'APPROVE' }, key())
    const view = await getRequestView(org.ctxOf('req_con', MON_1300), requestId)
    expect(view!.track.find((t) => t.what === 'APPROVED')).toMatchObject({ actor: { id: org.member.asst_con }, onBehalfOf: { id: org.member.dm_con }, role: { kind: 'POSITION', positionCode: 'DM' }, doa: { ruleCode: 'PR-01' } })
  })
})
