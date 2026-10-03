import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { decideTask, provideInfo, requestInfo } from '@/server/services/approvals/decide'
import { cancelRequest, createDraft, editRequest, resubmitRequest, submitRequest } from '@/server/services/requests'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// S2-10 request flow (spec §6.4, FR-INT-007, FR-INT-009, FR-DOA-004, FR-DOA-005) on an organization built from the
// §7.4 fixtures. Monday 5 Oct 2026 10:00 Thai time: DOA-DEMO version 1 is in effect; 13 and 23 Oct are holidays.

const NOW = new Date('2026-10-05T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })

let org: DoaOrg
beforeAll(async () => {
  org = await createDoaOrg()
})

/** A draft of one line that includes VAT, so the gross amount is exactly `grossBaht`. */
async function draft(requester: string, grossBaht: string, title = 'วัสดุก่อสร้าง') {
  const r = await createDraft(
    org.ctxOf(requester, NOW),
    { requestTypeCode: 'BUY_GOODS', title, priceIncludesVat: true, lines: [{ description: 'ปูนซีเมนต์', quantity: '1', uom: 'งาน', unitPrice: grossBaht }] },
    key(),
  )
  if (!r.ok) throw new Error(`draft failed: ${r.error.code}`)
  return r.data.requestId
}

async function openTask(requestId: string) {
  return prisma.approvalTask.findFirstOrThrow({ where: { status: { in: ['OPEN', 'INFO_REQUESTED'] }, step: { route: { subjectType: 'REQUEST', subjectId: requestId } } } })
}

describe('[FR-INT-007/AC1] submitting is one transaction: form, totals, route, number, first task and events', () => {
  it('routes a 45,000 baht request of CON to the VP of OPS (PR-02) and numbers it', async () => {
    const id = await draft('req_con', '45000.00')
    const submitted = await submitRequest(org.ctxOf('req_con', NOW), { requestId: id }, key())
    expect(submitted).toMatchObject({ ok: true, data: { number: 'PR-2569-00001', assigneeMemberId: org.member.vp_ops } })
    const request = await prisma.request.findUniqueOrThrow({ where: { id } })
    // BR-VAT-03: the line includes VAT; VAT = round(45,000 × 700 / 10,700)
    expect(request).toMatchObject({ status: 'PENDING_APPROVAL', grossSatang: 4_500_000n, vatSatang: 294_393n, netSatang: 4_205_607n, vatRateBp: 700 })
    const route = await prisma.approvalRoute.findFirstOrThrow({ where: { subjectId: id } })
    expect(route).toMatchObject({ ruleCode: 'PR-02', escalatedFromRuleCode: null, amountSatang: 4_500_000n, status: 'ACTIVE' })
    expect(route.explanationTh).toContain('PR-02')
    const task = await openTask(id)
    // BR-SLA-01: 8 business hours from Monday 10:00 = 7.5 hours on Monday (to 17:30) and 0.5 on Tuesday → 09:00
    expect(task).toMatchObject({ assigneeMemberId: org.member.vp_ops, resolvedFrom: 'POSITION:VP@OPS', dueAt: new Date('2026-10-06T02:00:00Z') })
    const events = await prisma.event.findMany({ where: { organizationId: org.organizationId, aggregateId: { in: [id, task.id] } }, orderBy: { seq: 'asc' } })
    expect(events.map((e) => e.type)).toEqual(['request.drafted', 'request.submitted', 'approval_task.assigned'])
    expect(await prisma.notification.count({ where: { recipientMemberId: org.member.vp_ops, templateKey: 'task.assigned', subjectId: id } })).toBe(1)
  })

  it('writes nothing when a step fails: no number is used, no route, the request stays a draft', async () => {
    const id = await draft('req_con', '30000.00')
    // Nobody holds VP of OPS for a moment: the route cannot find an approver
    await prisma.positionAssignment.updateMany({ where: { organizationId: org.organizationId, memberId: org.member.vp_ops }, data: { validTo: new Date('2026-10-01T00:00:00Z') } })
    try {
      const failed = await submitRequest(org.ctxOf('req_con', NOW), { requestId: id }, key())
      expect(failed).toMatchObject({ ok: false, error: { code: 'APPROVER_NOT_FOUND' } })
      expect(await prisma.request.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'DRAFT', number: null })
      expect(await prisma.approvalRoute.count({ where: { subjectId: id } })).toBe(0)
    } finally {
      await prisma.positionAssignment.updateMany({ where: { organizationId: org.organizationId, memberId: org.member.vp_ops }, data: { validTo: null } })
    }
    const next = await submitRequest(org.ctxOf('req_con', NOW), { requestId: id }, key())
    expect(next.ok && next.data.number).toMatch(/^PR-2569-\d{5}$/)
    const numbers = (await prisma.request.findMany({ where: { organizationId: org.organizationId, number: { not: null } }, select: { number: true } })).map((r) => r.number!).sort()
    // Consecutive: the failed attempt took no number
    expect(numbers).toEqual(numbers.map((_, i) => `PR-2569-${String(i + 1).padStart(5, '0')}`))
  })

  it('[FR-INT-007/AC3] a new-supplier request goes to the procurement queue without a DOA route (OQ-23)', async () => {
    const created = await createDraft(org.ctxOf('req_con', NOW), { requestTypeCode: 'NEW_SUPPLIER', title: 'เพิ่มผู้ขายวัสดุ', formData: { supplierName: 'บริษัท ตัวอย่าง จำกัด' } }, key())
    if (!created.ok) throw new Error('draft failed')
    const id = created.data.requestId
    expect(await submitRequest(org.ctxOf('req_con', NOW), { requestId: id }, key())).toMatchObject({ ok: true, data: { number: 'RQ-2569-00001' } })
    expect(await prisma.request.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'SUBMITTED', number: 'RQ-2569-00001' })
    expect(await prisma.approvalRoute.count({ where: { subjectId: id } })).toBe(0)
    expect(await prisma.notification.count({ where: { recipientMemberId: org.member.proc_officer, templateKey: 'supplier_request.submitted', subjectId: id } })).toBe(1)
    const missing = await createDraft(org.ctxOf('req_con', NOW), { requestTypeCode: 'NEW_SUPPLIER', title: 'ไม่ระบุชื่อ' }, key())
    if (!missing.ok) throw new Error('draft failed')
    expect(await submitRequest(org.ctxOf('req_con', NOW), { requestId: missing.data.requestId }, key())).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', details: { field: 'formData.supplierName' } },
    })
  })

  it('only the requester submits their request (OWN)', async () => {
    const id = await draft('req_con', '1000.00')
    expect(await submitRequest(org.ctxOf('proc_officer', NOW), { requestId: id }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})

describe('[FR-DOA-004/AC1] [FR-DOA-004/AC3] [FR-DOA-005/AC1] the assignee approves; the decision names the DOA version and rule', () => {
  it('approves the last step: the request is APPROVED and the requester is told', async () => {
    const id = await draft('req_con', '45000.00')
    await submitRequest(org.ctxOf('req_con', NOW), { requestId: id }, key())
    const task = await openTask(id)
    const approved = await decideTask(org.ctxOf('vp_ops', NOW), { taskId: task.id, decision: 'APPROVE' }, key())
    expect(approved).toMatchObject({ ok: true, data: { documentStatus: 'APPROVED' } })
    expect(await prisma.request.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'APPROVED', approvedAt: NOW })
    const decided = await prisma.event.findFirstOrThrow({ where: { aggregateId: task.id, type: 'approval_task.decided' } })
    const version = await prisma.doaVersion.findFirstOrThrow({ where: { organizationId: org.organizationId, versionNo: 1 } })
    expect(decided.data).toEqual({
      decision: 'APPROVE',
      subjectType: 'REQUEST',
      subjectId: id,
      doaVersionId: version.id,
      doaRuleCode: 'PR-02',
      channel: 'WEB',
      actorMemberId: org.member.vp_ops,
      onBehalfOfMemberId: null,
      reasonCommentId: null,
    })
    expect(await prisma.notification.count({ where: { recipientMemberId: org.member.req_con, templateKey: 'request.approved', subjectId: id } })).toBe(1)
  })
})

describe('[FR-DOA-004/AC2] deciding checks the task and the people again', () => {
  it('a decided task cannot be decided again: INVALID_STATE_TRANSITION with who and when', async () => {
    const id = await draft('req_con', '45000.00')
    await submitRequest(org.ctxOf('req_con', NOW), { requestId: id }, key())
    const task = await openTask(id)
    await decideTask(org.ctxOf('vp_ops', NOW), { taskId: task.id, decision: 'APPROVE' }, key())
    const again = await decideTask(org.ctxOf('vp_ops', NOW), { taskId: task.id, decision: 'APPROVE' }, key())
    expect(again).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION', details: { name: 'ผู้ใช้ vp_ops', time: NOW.toISOString() } } })
  })

  it('only the assignee decides; a requester never decides their own request (BR-SOD-01)', async () => {
    const id = await draft('req_con', '45000.00')
    await submitRequest(org.ctxOf('req_con', NOW), { requestId: id }, key())
    const task = await openTask(id)
    expect(await decideTask(org.ctxOf('vp_sup', NOW), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    // Even when the task somehow points at the requester, the decision is refused and the attempt is recorded
    await prisma.approvalTask.update({ where: { id: task.id }, data: { assigneeMemberId: org.member.req_con } })
    expect(await decideTask(org.ctxOf('req_con', NOW), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'SOD_VIOLATION', details: { rule: 'BR-SOD-01' } } })
    expect(await prisma.event.count({ where: { organizationId: org.organizationId, type: 'security.sod_blocked', aggregateId: id } })).toBe(1)
    expect(await prisma.request.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'PENDING_APPROVAL' })
  })

  it('return and reject need a reason, kept in a Comment and referenced by the event', async () => {
    const id = await draft('req_con', '45000.00')
    await submitRequest(org.ctxOf('req_con', NOW), { requestId: id }, key())
    const task = await openTask(id)
    expect(await decideTask(org.ctxOf('vp_ops', NOW), { taskId: task.id, decision: 'REJECT' }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'reason' } } })
    expect(await decideTask(org.ctxOf('vp_ops', NOW), { taskId: task.id, decision: 'REJECT', reason: 'ซ้ำกับคำขอเดิม' }, key())).toMatchObject({ ok: true, data: { documentStatus: 'REJECTED' } })
    const rejected = await prisma.event.findFirstOrThrow({ where: { aggregateId: id, type: 'request.rejected' } })
    const comment = await prisma.comment.findUniqueOrThrow({ where: { id: (rejected.data as { reasonCommentId: string }).reasonCommentId } })
    expect(comment.body).toBe('ซ้ำกับคำขอเดิม')
  })
})

describe('[FR-INT-009/AC2] a returned request is edited and resubmitted on a new route (BR-DOA-09)', () => {
  it('cancels the old route, keeps the number, and routes the new amount', async () => {
    const id = await draft('req_con', '45000.00')
    const first = await submitRequest(org.ctxOf('req_con', NOW), { requestId: id }, key())
    const task = await openTask(id)
    await decideTask(org.ctxOf('vp_ops', NOW), { taskId: task.id, decision: 'RETURN', reason: 'แยกรายการให้ชัดเจน' }, key())
    expect(await prisma.request.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'RETURNED' })
    await editRequest(org.ctxOf('req_con', NOW), { requestId: id, title: 'วัสดุก่อสร้าง (แก้)', priceIncludesVat: true, lines: [{ description: 'ปูนซีเมนต์', quantity: '1', uom: 'งาน', unitPrice: '15000.00' }] }, key())
    const again = await resubmitRequest(org.ctxOf('req_con', NOW), { requestId: id }, key())
    expect(again).toMatchObject({ ok: true, data: { assigneeMemberId: org.member.dm_con } })
    const routes = await prisma.approvalRoute.findMany({ where: { subjectId: id }, orderBy: { routeNo: 'asc' } })
    expect(routes.map((r) => [r.routeNo, r.ruleCode, r.status])).toEqual([
      [1, 'PR-02', 'CANCELLED'],
      [2, 'PR-01', 'ACTIVE'],
    ])
    expect((await prisma.request.findUniqueOrThrow({ where: { id } })).number).toBe(first.ok ? first.data.number : null)
  })
})

describe('[FR-INT-009/AC1] the requester cancels; open tasks end with it', () => {
  it('cancels a pending request; nobody else may', async () => {
    const id = await draft('req_con', '45000.00')
    await submitRequest(org.ctxOf('req_con', NOW), { requestId: id }, key())
    const task = await openTask(id)
    expect(await cancelRequest(org.ctxOf('receiver_con', NOW), { requestId: id }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await cancelRequest(org.ctxOf('req_con', NOW), { requestId: id, reason: 'ไม่ต้องใช้แล้ว' }, key())).toMatchObject({ ok: true })
    expect(await prisma.request.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'CANCELLED', cancelledAt: NOW })
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'CANCELLED' })
    expect(await cancelRequest(org.ctxOf('req_con', NOW), { requestId: id }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION' } })
  })
})

describe('[FR-INT-009/AC3] asking for information pauses the SLA; the answer gives the task back with the time left', () => {
  it('counts on from the time that was left (GC-SLA-06)', async () => {
    const id = await draft('req_con', '45000.00')
    await submitRequest(org.ctxOf('req_con', NOW), { requestId: id }, key())
    const task = await openTask(id)
    // Asked at Monday 14:00 Thai time: 4 business hours used, 4 left
    const asked = await requestInfo(org.ctxOf('vp_ops', new Date('2026-10-05T07:00:00Z')), { taskId: task.id, question: 'ขอใบเสนอราคาประกอบ' }, key())
    expect(asked.ok).toBe(true)
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'INFO_REQUESTED', remainingBusinessMinutes: 240 })
    expect(await prisma.notification.count({ where: { recipientMemberId: org.member.req_con, templateKey: 'request.info_requested', subjectId: id } })).toBe(1)
    // Answered Wednesday 09:00: due 4 business hours later, Wednesday 13:00
    const answered = await provideInfo(org.ctxOf('req_con', new Date('2026-10-07T02:00:00Z')), { infoRequestId: asked.ok ? asked.data.infoRequestId : '', answer: 'แนบแล้ว 1 ใบ' }, key())
    expect(answered.ok).toBe(true)
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'OPEN', dueAt: new Date('2026-10-07T06:00:00Z'), remainingBusinessMinutes: null })
    expect(await prisma.request.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'PENDING_APPROVAL' })
  })
})

describe('[FR-DOA-003/AC1] a department manager requesting for their own department goes to the next band (BR-DOA-06)', () => {
  it('escalates 15,000 baht of dm_con from PR-01 (DM, themselves) to PR-02 (VP)', async () => {
    const id = await draft('dm_con', '15000.00')
    const submitted = await submitRequest(org.ctxOf('dm_con', NOW), { requestId: id }, key())
    expect(submitted).toMatchObject({ ok: true, data: { assigneeMemberId: org.member.vp_ops } })
    expect(await prisma.approvalRoute.findFirstOrThrow({ where: { subjectId: id } })).toMatchObject({ ruleCode: 'PR-02', escalatedFromRuleCode: 'PR-01' })
  })
})

describe('[FR-DOA-006/AC1] a delegate gets new tasks of the delegator while the delegation runs', () => {
  it('sends a 10,000 baht request of CON to asst_con on behalf of dm_con', async () => {
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
    const id = await draft('req_con', '10000.00')
    await submitRequest(org.ctxOf('req_con', NOW), { requestId: id }, key())
    const task = await openTask(id)
    expect(task).toMatchObject({ assigneeMemberId: org.member.asst_con, principalMemberId: org.member.dm_con })
    await decideTask(org.ctxOf('asst_con', NOW), { taskId: task.id, decision: 'APPROVE' }, key())
    const decided = await prisma.event.findFirstOrThrow({ where: { aggregateId: task.id, type: 'approval_task.decided' } })
    expect(decided.data).toMatchObject({ actorMemberId: org.member.asst_con, onBehalfOfMemberId: org.member.dm_con, doaRuleCode: 'PR-01' })
  })

  it('the delegator may still decide a task their delegate holds; whoever acts first decides (BR-DLG-04)', async () => {
    const id = await draft('req_con', '9000.00')
    await submitRequest(org.ctxOf('req_con', NOW), { requestId: id }, key())
    const task = await openTask(id)
    expect(task).toMatchObject({ assigneeMemberId: org.member.asst_con, principalMemberId: org.member.dm_con })
    expect(await decideTask(org.ctxOf('dm_con', NOW), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: true, data: { documentStatus: 'APPROVED' } })
    expect(await decideTask(org.ctxOf('asst_con', NOW), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION' } })
  })
})
