import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { canViewRequest, taskRight } from '@/app/(workspace)/_tracking/access'
import { answerQuestion, askRequester, cancelOwnRequest, decidePolicy, decideRequestTask, resubmitOwnRequest } from '@/app/(workspace)/_tracking/commands'
import { memberPrincipal } from '@/server/authz'
import { prisma } from '@/server/db/client'
import { getRequestAccess, getRequestView, listMyRequests } from '@/server/queries/requests'
import { getTaskAccess, getTaskView, listMyTasks } from '@/server/queries/tasks'
import { decideTask, provideInfo, requestInfo } from '@/server/services/approvals/decide'
import { importDoaDraft, submitDoaVersion } from '@/server/services/doa'
import { diffVersions } from '@/server/services/doa/diff'
import { proposeOrgChange } from '@/server/services/org-authority'
import { cancelRequest, createDraft, editRequest, resubmitRequest, submitRequest } from '@/server/services/requests'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// S2-12, the browser side of the decision page and the request page: the commands behind their buttons
// (src/app/(workspace)/_tracking/commands.ts) refuse whoever the service refuses — and the request page's cancel refuses
// everybody but the requester — without changing anything; the business time waited leaves out the time a question
// waited for its answer (BR-SLA-03); a follower sees what the requester sees (FR-INT-008 AC2); the requester's edit after
// a return is on the timeline; a DOA version waiting for approval shows its rules and what differs from the version in
// effect. Real Postgres (BCS_TEST_DB), an organization from the §7.4 fixtures. Monday 5 Oct 2026 10:00 Thai time;
// business hours Mon–Fri 08:30–17:30.

const NOW = new Date('2026-10-05T03:00:00Z')
const MON_1300 = new Date('2026-10-05T06:00:00Z')
const TUE_1000 = new Date('2026-10-06T03:00:00Z')
const TUE_1100 = new Date('2026-10-06T04:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const FIXTURE = readFileSync(path.resolve(import.meta.dirname, '../golden/fixtures/doa-versions.yaml'), 'utf8')

let org: DoaOrg
beforeAll(async () => {
  org = await createDoaOrg()
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
  // An English name, so a screen in English names the approver in English
  await prisma.member.update({ where: { id: org.member.vp_ops! }, data: { displayNameEn: 'Weera Operations' } })
})

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

const requestRow = (id: string) => prisma.request.findUniqueOrThrow({ where: { id }, select: { status: true, version: true, currentRouteId: true, cancelledAt: true } })
const reservedOn = async (requestId: string) => {
  const lines = await prisma.requestLine.findMany({ where: { requestId }, select: { id: true } })
  const held = await prisma.budgetAllocation.findMany({ where: { sourceType: 'REQUEST_LINE', sourceId: { in: lines.map((l) => l.id) } }, select: { reservedSatang: true } })
  return held.reduce((sum, a) => sum + a.reservedSatang, 0n)
}

describe('[FR-INT-008/AC1] [FR-INT-009/AC3] the business time waited leaves out the time a question waited for its answer (BR-SLA-03)', () => {
  it('counts 240 business minutes on the request, in the inbox and on the decision page after a question and its answer', async () => {
    const { requestId } = await submitted('req_con', '45000.00')
    const task = await openTask(requestId)
    // Monday 13:00 the approver asks; the time it took until then (180 minutes) stays while the question waits
    expect(await requestInfo(org.ctxOf('vp_ops', MON_1300), { taskId: task.id, question: 'ขอใบเสนอราคาเพิ่ม' }, key())).toMatchObject({ ok: true })
    const paused = (await listMyTasks(org.ctxOf('vp_ops', TUE_1000))).items.find((i) => i.id === task.id)
    expect(paused).toMatchObject({ status: 'INFO_REQUESTED', waitingMinutes: 180, overdue: false })

    // Tuesday 10:00 the requester answers; at 11:00 the task has used 180 + 60 minutes of its 8 business hours
    expect(await provideInfo(org.ctxOf('req_con', TUE_1000), { infoRequestId: (await prisma.infoRequest.findFirstOrThrow({ where: { taskId: task.id } })).id, answer: 'แนบแล้ว' }, key())).toMatchObject({ ok: true })
    const dueAt = new Date('2026-10-06T08:00:00Z') // Tuesday 15:00: the 300 minutes left when it paused, from the answer
    const view = await getRequestView(org.ctxOf('req_con', TUE_1100), requestId)
    expect(view!.stage).toMatchObject({ kind: 'APPROVER', waitingMinutes: 240, dueAt, overdue: false })
    expect(view!.track.find((t) => t.state === 'current')).toMatchObject({ what: 'WAIT_APPROVAL', waitingMinutes: 240, overdue: false })
    expect((await listMyTasks(org.ctxOf('vp_ops', TUE_1100))).items.find((i) => i.id === task.id)).toMatchObject({ status: 'OPEN', waitingMinutes: 240, dueAt, overdue: false })
    expect(await getTaskView(org.ctxOf('vp_ops', TUE_1100), task.id)).toMatchObject({ status: 'OPEN', waitingMinutes: 240, dueAt, overdue: false, openQuestion: null })
  })
})

describe('[FR-INT-008/AC2] a follower sees the same status and current step as the requester', () => {
  it('lets the follower open the request, with the same stage and steps left, and lists it as followed', async () => {
    const { requestId } = await submitted('req_con', '30000.00', 'ถุงมือนิรภัย')
    await prisma.requestFollower.create({ data: { organizationId: org.organizationId, requestId, memberId: org.member.asst_con! } })
    const access = await getRequestAccess(org.ctxOf('asst_con', MON_1300), requestId)
    expect(access!.followerMemberIds).toEqual([org.member.asst_con])
    expect(canViewRequest(memberPrincipal(org.member.asst_con!, []), access!)).toBe(true)
    // Denied: another member of the same department who does not follow it
    expect(canViewRequest(memberPrincipal(org.member.receiver_con!, ['RECEIVER']), access!)).toBe(false)

    const follower = await getRequestView(org.ctxOf('asst_con', MON_1300), requestId)
    const requester = await getRequestView(org.ctxOf('req_con', MON_1300), requestId)
    expect(follower!.status).toBe('PENDING_APPROVAL')
    expect(follower!.status).toBe(requester!.status)
    expect(follower!.stage).toEqual(requester!.stage)
    expect(follower!.stage).toMatchObject({ kind: 'APPROVER', assignee: { id: org.member.vp_ops }, waitingMinutes: 180 })
    expect(follower!.track.filter((t) => t.state !== 'done')).toEqual(requester!.track.filter((t) => t.state !== 'done'))
    const row = (await listMyRequests(org.ctxOf('asst_con', MON_1300))).rows.find((r) => r.id === requestId)
    expect(row).toMatchObject({ relation: 'FOLLOWER', status: 'PENDING_APPROVAL', stage: requester!.stage })
  })
})

describe('[FR-DOA-004/AC1] asking for information is for the task’s approver, on request tasks only', () => {
  it('refuses a member who is not the approver and asks nothing', async () => {
    const { requestId } = await submitted('req_con', '45000.00')
    const task = await openTask(requestId)
    expect(await requestInfo(org.ctxOf('vp_sup', MON_1300), { taskId: task.id, question: 'ขอรายละเอียด' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await askRequester(org.ctxOf('req_con', MON_1300), { taskId: task.id, question: 'ขอรายละเอียด' }, randomUUID())).toEqual({ ok: false, code: 'FORBIDDEN' })
    expect(await prisma.infoRequest.count({ where: { taskId: task.id } })).toBe(0)
    expect((await prisma.approvalTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('OPEN')
    // The approver may
    expect(await askRequester(org.ctxOf('vp_ops', MON_1300), { taskId: task.id, question: 'ขอรายละเอียด' }, randomUUID())).toEqual({ ok: true })
  })

  it('never asks on a policy task: those are approved or rejected only (BR-DOA-15)', async () => {
    const proposed = await proposeOrgChange(
      org.ctxOf('admin', NOW),
      { kind: 'POSITION_ASSIGN', payload: { positionCode: 'DM', departmentId: org.department.IT!, memberId: org.member.admin2! }, effectiveFrom: '2026-12-01T01:00:00Z', reason: 'แต่งตั้งตามคำสั่งบริษัท' },
      key(),
    )
    if (!proposed.ok) throw new Error(`propose failed: ${proposed.error.code}`)
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectType: 'ORG_AUTHORITY_CHANGE', subjectId: proposed.data.changeId } } } })
    expect(await askRequester(org.ctxOf('ceo', MON_1300), { taskId: task.id, question: 'ขอเหตุผลเพิ่ม' }, randomUUID())).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: 'taskId', reason: 'SUBJECT' })
    expect(await prisma.infoRequest.count({ where: { taskId: task.id } })).toBe(0)
    expect((await prisma.approvalTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('OPEN')
  })
})

describe('[FR-DOA-010/AC2] [FR-DOA-002/AC2] a policy decision spends no code unless the member decides the task', () => {
  it('refuses an organization admin before asking for a step-up, and leaves the task open', async () => {
    const proposed = await proposeOrgChange(
      org.ctxOf('admin', NOW),
      { kind: 'POSITION_ASSIGN', payload: { positionCode: 'DM', departmentId: org.department.FIN!, memberId: org.member.fin_officer! }, effectiveFrom: '2026-12-01T01:00:00Z', reason: 'แต่งตั้งตามคำสั่งบริษัท' },
      key(),
    )
    if (!proposed.ok) throw new Error(`propose failed: ${proposed.error.code}`)
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectType: 'ORG_AUTHORITY_CHANGE', subjectId: proposed.data.changeId } } } })
    const asAdmin = memberPrincipal(org.member.admin!, ['ORG_ADMIN'])
    expect(await decidePolicy(org.ctxOf('admin', MON_1300), asAdmin, { taskId: task.id, decision: 'APPROVE', code: '123456' }, randomUUID(), 'th', MON_1300)).toEqual({ ok: false, code: 'FORBIDDEN' })
    // A malformed code or a rejection without a reason is told before anything is checked
    const asCeo = memberPrincipal(org.member.ceo!, ['EXECUTIVE'])
    expect(await decidePolicy(org.ctxOf('ceo', MON_1300), asCeo, { taskId: task.id, decision: 'APPROVE', code: '12ab' }, randomUUID(), 'th', MON_1300)).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: 'code' })
    expect(await decidePolicy(org.ctxOf('ceo', MON_1300), asCeo, { taskId: task.id, decision: 'REJECT', code: '123456' }, randomUUID(), 'th', MON_1300)).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: 'reason' })
    expect(await prisma.stepUpGrant.count({ where: { organizationId: org.organizationId } })).toBe(0)
    expect((await prisma.approvalTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('OPEN')
  })
})

describe('[FR-INT-009/AC3] only the requester answers the approver’s question', () => {
  it('refuses another member and the approver; the task keeps waiting for the answer', async () => {
    const { requestId } = await submitted('req_con', '45000.00')
    const task = await openTask(requestId)
    const asked = await requestInfo(org.ctxOf('vp_ops', MON_1300), { taskId: task.id, question: 'ขอใบเสนอราคา' }, key())
    if (!asked.ok) throw new Error('ask failed')
    const infoRequestId = asked.data.infoRequestId
    expect(await provideInfo(org.ctxOf('asst_con', TUE_1000), { infoRequestId, answer: 'แนบแล้ว' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await answerQuestion(org.ctxOf('vp_ops', TUE_1000), { infoRequestId, answer: 'ตอบเอง' }, randomUUID())).toEqual({ ok: false, code: 'FORBIDDEN' })
    expect((await prisma.approvalTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('INFO_REQUESTED')
    expect(await prisma.infoRequest.findUniqueOrThrow({ where: { id: infoRequestId } })).toMatchObject({ answer: null, answeredAt: null })
    // An empty answer is refused before the service; the requester's answer goes through
    expect(await answerQuestion(org.ctxOf('req_con', TUE_1000), { infoRequestId, answer: '   ' }, randomUUID())).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: 'answer' })
    expect(await answerQuestion(org.ctxOf('req_con', TUE_1000), { infoRequestId, answer: 'แนบแล้ว' }, randomUUID())).toEqual({ ok: true })
  })
})

describe('[FR-INT-009/AC2] only the requester sends a returned request again', () => {
  it('refuses another member and procurement, and leaves the request returned', async () => {
    const { requestId } = await submitted('req_con', '45000.00')
    const task = await openTask(requestId)
    await decideTask(org.ctxOf('vp_ops', MON_1300), { taskId: task.id, decision: 'RETURN', reason: 'แยกรายการ' }, key())
    const before = await requestRow(requestId)
    expect(await resubmitRequest(org.ctxOf('asst_con', TUE_1000), { requestId }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await resubmitOwnRequest(org.ctxOf('proc_officer', TUE_1000), requestId, randomUUID())).toEqual({ ok: false, code: 'FORBIDDEN' })
    expect(await requestRow(requestId)).toEqual(before)
    expect(before.status).toBe('RETURNED')
    expect(await resubmitOwnRequest(org.ctxOf('req_con', TUE_1000), requestId, randomUUID())).toEqual({ ok: true })
    expect((await requestRow(requestId)).status).toBe('PENDING_APPROVAL')
  })
})

describe('[FR-INT-009/AC1] only the requester cancels from the request page, and the budget goes back at once', () => {
  it('refuses another member and procurement without touching the request or its budget, then cancels for the requester', async () => {
    const { requestId } = await submitted('req_con', '45000.00')
    const before = await requestRow(requestId)
    const reserved = await reservedOn(requestId)
    expect(reserved).toBeGreaterThan(0n)

    expect(await cancelRequest(org.ctxOf('asst_con', MON_1300), { requestId, reason: 'ไม่ต้องใช้แล้ว' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    // §2.4: procurement cancels only an approved request that is not ordered yet — never a request still being approved
    expect(await cancelOwnRequest(org.ctxOf('proc_officer', MON_1300), { requestId, reason: 'ซ้ำกับคำขออื่น' }, randomUUID())).toEqual({ ok: false, code: 'FORBIDDEN' })
    expect(await cancelOwnRequest(org.ctxOf('vp_ops', MON_1300), { requestId, reason: 'ซ้ำกับคำขออื่น' }, randomUUID())).toEqual({ ok: false, code: 'FORBIDDEN' })
    expect(await requestRow(requestId)).toEqual(before)
    expect(await reservedOn(requestId)).toBe(reserved)
    expect((await openTask(requestId)).status).toBe('OPEN')

    // The page asks for a reason; a malformed call is refused, never a crash
    expect(await cancelOwnRequest(org.ctxOf('req_con', MON_1300), { requestId, reason: '  ก ' }, randomUUID())).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: 'reason' })
    expect(await cancelOwnRequest(org.ctxOf('req_con', MON_1300), null, randomUUID())).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: 'requestId' })
    expect(await cancelOwnRequest(org.ctxOf('req_con', MON_1300), { requestId, reason: 'ไม่ต้องใช้แล้ว' }, 'not-a-key')).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: 'idempotencyKey' })
    expect(await requestRow(requestId)).toEqual(before)

    expect(await cancelOwnRequest(org.ctxOf('req_con', MON_1300), { requestId, reason: 'ไม่ต้องใช้แล้ว' }, randomUUID())).toEqual({ ok: true })
    expect((await requestRow(requestId)).status).toBe('CANCELLED')
    expect(await reservedOn(requestId)).toBe(0n)
  })
})

describe('[FR-DOA-004/AC2] a second decision names who decided it and when, in the reader’s language', () => {
  it('answers in English with the English name, in Thai with the Thai one; malformed input is refused', async () => {
    const { requestId } = await submitted('req_con', '45000.00')
    const task = await openTask(requestId)
    expect(await decideRequestTask(org.ctxOf('vp_ops', NOW), { taskId: task.id, decision: 'APPROVE' }, randomUUID(), 'th')).toEqual({ ok: true, documentStatus: 'APPROVED' })
    expect(await decideRequestTask(org.ctxOf('vp_ops', MON_1300), { taskId: task.id, decision: 'APPROVE' }, randomUUID(), 'en')).toMatchObject({
      ok: false,
      code: 'INVALID_STATE_TRANSITION',
      name: 'Weera Operations',
      time: NOW.toISOString(),
    })
    expect(await decideRequestTask(org.ctxOf('vp_ops', MON_1300), { taskId: task.id, decision: 'APPROVE' }, randomUUID(), 'th')).toMatchObject({ code: 'INVALID_STATE_TRANSITION', name: 'ผู้ใช้ vp_ops' })
    expect(await decideRequestTask(org.ctxOf('vp_ops', MON_1300), { taskId: 'not-a-task', decision: 'APPROVE' }, randomUUID(), 'th')).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: 'decision' })
    expect(await decideRequestTask(org.ctxOf('vp_ops', MON_1300), undefined, randomUUID(), 'th')).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: 'decision' })
    expect(await askRequester(org.ctxOf('vp_ops', MON_1300), { taskId: 42 }, randomUUID())).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: 'question' })
    expect(await answerQuestion(org.ctxOf('req_con', MON_1300), 'x', randomUUID())).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: 'answer' })
    expect(await resubmitOwnRequest(org.ctxOf('req_con', MON_1300), { id: requestId }, randomUUID())).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: 'requestId' })
  })
})

describe('[FR-PLT-003/AC3] the requester’s edit after a return is a step of the timeline', () => {
  it('shows consecutive saves after a return as one edit, at the last save, between the return and the resubmit', async () => {
    const { requestId } = await submitted('req_con', '45000.00')
    const task = await openTask(requestId)
    await decideTask(org.ctxOf('vp_ops', MON_1300), { taskId: task.id, decision: 'RETURN', reason: 'แยกรายการ' }, key())
    const lines = [{ description: 'ปูนซีเมนต์', quantity: '1', uom: 'งาน', unitPrice: '40000.00' }]
    expect(await editRequest(org.ctxOf('req_con', TUE_1000), { requestId, title: 'วัสดุก่อสร้าง (แก้)', priceIncludesVat: true, lines }, key())).toMatchObject({ ok: true })
    expect(await editRequest(org.ctxOf('req_con', TUE_1100), { requestId, title: 'วัสดุก่อสร้าง (แก้ครั้งที่สอง)', priceIncludesVat: true, lines }, key())).toMatchObject({ ok: true })
    expect(await resubmitRequest(org.ctxOf('req_con', TUE_1100), { requestId }, key())).toMatchObject({ ok: true })
    const view = await getRequestView(org.ctxOf('req_con', TUE_1100), requestId)
    expect(view!.track.filter((t) => t.state === 'done').map((t) => t.what)).toEqual(['CREATED', 'SUBMITTED', 'RETURNED', 'EDITED', 'RESUBMITTED'])
    expect(view!.track.find((t) => t.what === 'EDITED')).toMatchObject({ actor: { id: org.member.req_con }, at: TUE_1100, channel: 'WEB' })
  })
})

describe('[FR-DOA-002/AC2] [FR-DOA-010/AC2] a DOA version waiting for approval shows its rules and what differs from the version in effect', () => {
  it('reads every rule and the policy of both versions, and the history’s comparison names the bands that move', async () => {
    const yaml = `versions:\n${FIXTURE.slice(FIXTURE.indexOf('  - code: DOA-DEMO\n    version: 2')).replace('version: 2', 'version: 41')}`
    const imported = await importDoaDraft(org.ctxOf('admin', NOW), { yaml, changeReason: 'ขยายวงเงิน DM เป็น 30,000 บาท' }, key())
    if (!imported.ok) throw new Error(`import failed: ${imported.error.code}`)
    const versionId = imported.data.versionIds[0]!
    const sent = await submitDoaVersion(org.ctxOf('admin', NOW), { versionId, boundaryTableConfirmed: true }, key())
    if (!sent.ok) throw new Error(`submit failed: ${sent.error.code}`)
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectType: 'DOA_VERSION', subjectId: versionId } } } })
    // Only the approver of DOA-CHG-01 reads it from the decision page; the admin who sent it may not decide it (GC-SOD-04)
    const access = await getTaskAccess(org.ctxOf('ceo', MON_1300), task.id)
    expect(taskRight(memberPrincipal(org.member.ceo!, ['EXECUTIVE']), access!)).toBe('DECIDE')
    expect(taskRight(memberPrincipal(org.member.admin!, ['ORG_ADMIN']), access!)).toBe('NONE')

    const view = await getTaskView(org.ctxOf('ceo', MON_1300), task.id)
    const policy = view!.policy
    if (policy?.kind !== 'DOA_VERSION') throw new Error('not a DOA version task')
    expect(policy.content).toMatchObject({ code: 'DOA-DEMO', versionNo: 41, amountBasis: 'GROSS', stepUpThresholdSatang: 10_000_000n, sodPolicy: { approverMayReceive: false, requesterMayReceive: true } })
    expect(policy.content!.rules.map((r) => r.code)).toEqual(['PR-01', 'PR-02', 'PR-03', 'PO-01', 'PO-02', 'GRV-01', 'DOA-CHG-01', 'ORG-CHG-01'])
    expect(policy.content!.rules[0]).toEqual({
      code: 'PR-01',
      documentType: 'PURCHASE_REQUEST',
      priority: 100,
      when: { amount: { gt: 0n, lte: 3_000_000n } },
      steps: [{ approver: { kind: 'POSITION_OF_DEPARTMENT', position: 'DM' }, slaBusinessMinutes: 480, mode: 'SEQUENTIAL' }],
    })
    // Compared with the version in effect, which it would replace
    expect(policy.baseline).toMatchObject({ code: 'DOA-DEMO', versionNo: 1, relation: 'IN_EFFECT' })
    expect(policy.baselineContent).toMatchObject({ code: 'DOA-DEMO', versionNo: 1 })
    expect([...policy.positionNames.keys()].sort()).toEqual(['CEO', 'COO', 'DM', 'VP'])
    const diff = diffVersions(policy.baselineContent!, policy.content!)
    expect(diff).toEqual({ policy: [], added: [], removed: [], changed: [{ code: 'PR-01', fields: ['band'] }, { code: 'PR-02', fields: ['band'] }] })
    expect(policy.changeReason).toBe('ขยายวงเงิน DM เป็น 30,000 บาท')
  })
})

describe('[FR-INT-008/AC3] "my requests" says when the list stops before every match', () => {
  it('returns the newest ones up to the limit and counts every match', async () => {
    const list = await listMyRequests(org.ctxOf('req_con', MON_1300), { limit: 1 })
    expect(list.rows).toHaveLength(1)
    expect(list.matched).toBeGreaterThan(1)
  })
})
