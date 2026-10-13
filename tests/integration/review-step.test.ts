import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { fund } from '@/core/budget'
import { applyBudget } from '@/server/budget/ledger'
import { makeCtx, systemCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { appendEvents } from '@/server/events/append'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { getRequestView } from '@/server/queries/requests'
import { decideTask } from '@/server/services/approvals/decide'
import { assignNextStep } from '@/server/services/approvals/next-step'
import { collectKpis } from '@/server/services/reports/kpi'
import { createDraft, resubmitRequest, submitRequest } from '@/server/services/requests'
import { escalateTask } from '@/server/services/sla/task-sla'
import { loadSeedForms } from '@/server/seed/forms'
import { seedWorkflow } from '@/server/seed/workflow'
import { workflowFixture } from '../golden/workflow-fixtures'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { pinStepUp } from '../support/pin'

// S6-05 (FR-WF-101 · BR-WF-06 to BR-WF-10 · BR-WF-15 · INV-WF-04): the REVIEW step of a purchase request against
// Postgres. The organization is the S6 fixture (org-s6.yaml) under the §7.4 DOA (doa-versions.yaml: above 100,000.00
// VAT included the CEO approves) with the reviewers of workflow-versions.yaml, seeded as the phase-1 seed stores them:
// a contract work above 1,000,000.00 goes to the DM of LEG, QSE and FIN at once (RV-03 to RV-05, ALL). The requester
// of CON stands for pm_p07 of the phase-1 scene (Request_History pattern OVERDUE): 2,470,000.00 before VAT, 2,642,900.00
// with it.

const NOW = new Date('2026-10-06T02:00:00Z')
const LATER = new Date('2026-10-06T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}

let org: DoaOrg
let workflowVersionId: string
const codeOf = (memberId: string) => Object.entries(org.member).find(([, id]) => id === memberId)![0]

beforeAll(async () => {
  setDefaultOutboxSender(null)
  org = await createDoaOrg({ fixtures: { org: 'fixtures/org-s6.yaml', versions: 'fixtures/doa-versions.yaml' } })
  const organizationId = org.organizationId
  // The contract work type with the form the demo seeds (prisma/seed/forms.yaml)
  const type = await prisma.requestType.create({ data: { organizationId, code: 'CONTRACT_WORK', nameTh: 'จ้างเหมา', documentType: 'PURCHASE_REQUEST' } })
  const form = await prisma.formVersion.create({ data: { organizationId, requestTypeId: type.id, versionNo: 1, schema: loadSeedForms().get('CONTRACT_WORK')! as object, status: 'PUBLISHED', publishedAt: NOW } })
  await prisma.requestType.update({ where: { id: type.id }, data: { currentFormVersionId: form.id } })
  for (const [code, role] of [
    ['admin', 'ORG_ADMIN'],
    ['auditor', 'AUDITOR'],
  ] as const) {
    await prisma.roleAssignment.create({ data: { organizationId, memberId: org.member[code]!, role, grantedAt: NOW } })
  }
  // Every contract work here holds 2,470,000.00 of CON's line: 100,000,000.00 more on top of the fixture's 10,000,000.00
  const line = await prisma.budgetLine.findFirstOrThrow({ where: { organizationId, departmentId: org.department.CON! } })
  const importId = randomUUID()
  await forTenant(organizationId).$transaction(async (tx) => {
    const ctx = systemCtx(organizationId, NOW, 'seed')
    const funded = await applyBudget(tx, ctx, [{ budgetLineId: line.id, document: { type: 'IMPORT' as const, id: importId }, run: (s) => fund(s, 10_000_000_000n, importId) }])
    if (!funded.ok) throw new Error(funded.error.code)
    await appendEvents(tx, ctx, funded.events)
  })
  const fixture = workflowFixture(['fixtures/workflow-versions.yaml']).versions[0]!
  expect(await seedWorkflow(organizationId, { code: fixture.code, rules: fixture.rules.map((r) => ({ ...r, descriptionTh: null })) }, NOW)).toEqual({ created: true, rules: 9 })
  workflowVersionId = (await prisma.workflowVersion.findFirstOrThrow({ where: { organizationId, code: fixture.code } })).id
})

/** pm_p07's contract work of 2,470,000.00 before VAT with the three quotations ATT-QUOTES asks */
async function contractWork(at = NOW, net = '2470000.00') {
  const draft = ok(
    await createDraft(
      org.ctxOf('req_con', at),
      { requestTypeCode: 'CONTRACT_WORK', title: 'งานเหมาก่อสร้างอาคารเก็บของ', formData: { scopeOfWork: 'ก่อสร้างอาคารเก็บของ 1 หลัง', milestones: '3 งวด', site: 'ไซต์ P07' }, lines: [{ description: 'งานเหมาก่อสร้าง', quantity: '1', uom: 'งาน', unitPrice: net }] },
      key(),
    ),
  )
  for (let i = 0; i < 3; i++) {
    const file = await prisma.fileObject.create({ data: { organizationId: org.organizationId, storageKey: `test/${randomUUID()}.pdf`, fileName: 'q.pdf', mimeType: 'application/pdf', sizeBytes: 1, status: 'AVAILABLE', uploadedById: org.member.req_con! } })
    await prisma.fileLink.create({ data: { organizationId: org.organizationId, fileId: file.id, subjectType: 'Request', subjectId: draft.requestId, kind: 'QUOTATION' } })
  }
  return draft.requestId
}

/** The latest route of the request with its steps, and its tasks by step and slot */
async function routeOf(requestId: string) {
  const route = await prisma.approvalRoute.findFirstOrThrow({ where: { subjectId: requestId }, orderBy: { routeNo: 'desc' }, include: { steps: { orderBy: { stepNo: 'asc' } } } })
  const tasks = await prisma.approvalTask.findMany({ where: { step: { routeId: route.id } }, include: { step: { select: { stepNo: true } } }, orderBy: [{ assignedAt: 'asc' }, { slotNo: 'asc' }, { id: 'asc' }] })
  return { route, tasks }
}
const decide = (taskId: string, code: string, decision: 'APPROVE' | 'REJECT' | 'RETURN', at = LATER, reason = 'ขาดร่างสัญญาที่ฝ่ายกฎหมายตรวจแล้ว', channel: 'WEB' | 'LIFF' = 'WEB') =>
  decideTask(org.ctxOf(code, at, channel), { taskId, decision, ...(decision === 'APPROVE' ? {} : { reason }) }, key())
const openOf = (tasks: Awaited<ReturnType<typeof routeOf>>['tasks']) => tasks.filter((t) => t.status === 'OPEN').map((t) => [t.step.stepNo, t.slotNo, codeOf(t.assigneeMemberId)])

describe('[FR-WF-101/AC1] [FR-WF-101/AC2] the reviewers of pm_p07\'s contract work at once, then the CEO (BR-WF-06)', () => {
  it('dm_leg dm_qse dm_fin get their tasks with the submit; the CEO only after all three passed, found by doaStepNo', async () => {
    const requestId = await contractWork()
    const sent = ok(await submitRequest(org.ctxOf('req_con', NOW), { requestId }, key()))
    expect(codeOf(sent.assigneeMemberId)).toBe('dm_leg')
    const { route, tasks } = await routeOf(requestId)
    expect([route.ruleCode, route.workflowVersionId]).toEqual(['PR-03', workflowVersionId])
    expect(route.steps.map((s) => [s.stepNo, s.kind, s.doaStepNo, s.status, s.slaBusinessMinutes])).toEqual([
      [1, 'REVIEW', null, 'ACTIVE', 960],
      [2, 'APPROVAL', 1, 'WAITING', 960],
    ])
    expect(route.steps[0]!.reviewGroups).toEqual([
      { ruleCodes: ['RV-03'], quorum: 'ALL', quorumCount: null, slotNos: [1] },
      { ruleCodes: ['RV-04'], quorum: 'ALL', quorumCount: null, slotNos: [2] },
      { ruleCodes: ['RV-05'], quorum: 'ALL', quorumCount: null, slotNos: [3] },
    ])
    expect(tasks.map((t) => [t.slotNo, codeOf(t.assigneeMemberId), t.resolvedFrom, t.workflowRuleCodes, t.status])).toEqual([
      [1, 'dm_leg', 'POSITION:DM@LEG', ['RV-03'], 'OPEN'],
      [2, 'dm_qse', 'POSITION:DM@QSE', ['RV-04'], 'OPEN'],
      [3, 'dm_fin', 'POSITION:DM@FIN', ['RV-05'], 'OPEN'],
    ])
    // The three tasks come with the submit, in the one command that sent it (INV-WF-04 on each)
    const assigned = await prisma.event.findMany({ where: { type: 'approval_task.assigned', aggregateId: { in: tasks.map((t) => t.id) } }, orderBy: { seq: 'asc' } })
    const submitted = await prisma.event.findFirstOrThrow({ where: { type: 'request.submitted', aggregateId: requestId } })
    expect(new Set(assigned.map((e) => e.requestId))).toEqual(new Set([submitted.requestId]))
    expect(assigned.map((e) => e.data)).toEqual(tasks.map((t) => expect.objectContaining({ stepNo: 1, slotNo: t.slotNo, workflowVersionId, workflowRuleCodes: t.workflowRuleCodes })))
    expect(await prisma.notification.count({ where: { templateKey: 'task.review_assigned', subjectId: requestId } })).toBe(3)

    // Two pass: the CEO still has nothing; no step-up for a reviewer (BR-WF-09)
    expect(ok(await decide(tasks[0]!.id, 'dm_leg', 'APPROVE'))).toMatchObject({ documentStatus: 'PENDING_APPROVAL' })
    expect(ok(await decide(tasks[1]!.id, 'dm_qse', 'APPROVE', LATER, '', 'LIFF'))).toMatchObject({ documentStatus: 'PENDING_APPROVAL' })
    expect(openOf((await routeOf(requestId)).tasks)).toEqual([[1, 3, 'dm_fin']])
    // The third passes: the step is done and the CEO's task of DOA step 1 (route step 2) starts
    expect(ok(await decide(tasks[2]!.id, 'dm_fin', 'APPROVE'))).toMatchObject({ documentStatus: 'PENDING_APPROVAL' })
    const after = await routeOf(requestId)
    expect(after.route.steps.map((s) => s.status)).toEqual(['DONE', 'ACTIVE'])
    expect(openOf(after.tasks)).toEqual([[2, 1, 'ceo']])
    expect(await prisma.event.findFirstOrThrow({ where: { type: 'approval_step.completed', aggregateId: route.steps[0]!.id } })).toMatchObject({ data: { kind: 'REVIEW', outcome: 'APPROVED', slots: ['APPROVE', 'APPROVE', 'APPROVE'] } })
    expect(await prisma.notification.findFirstOrThrow({ where: { templateKey: 'request.reviews_done', subjectId: requestId } })).toMatchObject({ recipientMemberId: org.member.req_con, urgency: 'DIGEST' })
    // The reviewers' decisions name the route's DOA reference and their workflow version and rules (INV-WF-04)
    const decided = await prisma.event.findMany({ where: { type: 'approval_task.decided', aggregateId: { in: tasks.map((t) => t.id) } }, orderBy: { seq: 'asc' } })
    expect(decided.map((e) => [e.doaRuleCode, e.data])).toEqual(
      tasks.map((t) => ['PR-03', expect.objectContaining({ doaRuleCode: 'PR-03', slotNo: t.slotNo, workflowVersionId, workflowRuleCodes: t.workflowRuleCodes })]),
    )

    // The CEO decides with the PIN, as before the reviewers (stepUpThreshold 100,000.00)
    const ceoTask = after.tasks.find((t) => t.step.stepNo === 2)!
    expect(await decide(ceoTask.id, 'ceo', 'APPROVE')).toMatchObject({ ok: false, error: { code: 'STEP_UP_REQUIRED' } })
    await pinStepUp(org.organizationId, org.member.ceo!, 'REQUEST', requestId)
    expect(ok(await decide(ceoTask.id, 'ceo', 'APPROVE'))).toMatchObject({ documentStatus: 'APPROVED' })
  })

  it('OQ-111: the DOA step is the engine\'s step of its doaStepNo whether the holders are read at the route\'s time (way ข) or later (way ก)', async () => {
    for (const holdersAt of [null, LATER]) {
      const requestId = await contractWork()
      ok(await submitRequest(org.ctxOf('req_con', NOW), { requestId }, key()))
      const { route } = await routeOf(requestId)
      const request = await prisma.request.findUniqueOrThrow({ where: { id: requestId } })
      // The step after the REVIEW step is route step 2; the engine has only DOA step 1 for it
      const next = await forTenant(org.organizationId).$transaction((tx) =>
        assignNextStep(
          tx,
          makeCtx({ organizationId: org.organizationId, actor: { type: 'SYSTEM', job: 'test' }, channel: 'SYSTEM', now: LATER }),
          route,
          { type: 'REQUEST', id: requestId, label: request.number! },
          { documentType: 'PURCHASE_REQUEST', amount: { netSatang: request.netSatang, vatSatang: request.vatSatang }, requesterMemberId: request.requesterMemberId, chargedDepartmentId: request.chargedDepartmentId, conflictMemberIds: [request.requesterMemberId], at: route.createdAt },
          ...(holdersAt ? [holdersAt] : []),
        ),
      )
      expect(next).toMatchObject({ ok: true, assigned: true })
      expect(openOf((await routeOf(requestId)).tasks).filter(([step]) => step === 2)).toEqual([[2, 1, 'ceo']])
    }
  })

  it('a return by any reviewer ends the route RETURNED and closes the others; the resubmit asks every slot again', async () => {
    const requestId = await contractWork()
    ok(await submitRequest(org.ctxOf('req_con', NOW), { requestId }, key()))
    const { tasks } = await routeOf(requestId)
    ok(await decide(tasks[0]!.id, 'dm_leg', 'APPROVE'))
    expect(ok(await decide(tasks[1]!.id, 'dm_qse', 'RETURN', LATER, 'ขาดแผนความปลอดภัยของไซต์'))).toMatchObject({ documentStatus: 'RETURNED' })
    expect((await routeOf(requestId)).tasks.map((t) => t.status)).toEqual(['APPROVED', 'RETURNED', 'CANCELLED'])
    expect(await prisma.event.findFirstOrThrow({ where: { type: 'approval_task.cancelled', aggregateId: tasks[2]!.id } })).toMatchObject({ data: { why: 'STEP_DECIDED' } })
    expect(await prisma.approvalTask.count({ where: { step: { route: { subjectId: requestId } }, assigneeMemberId: org.member.ceo } })).toBe(0)

    ok(await resubmitRequest(org.ctxOf('req_con', LATER), { requestId }, key()))
    const again = await routeOf(requestId)
    expect(again.route.routeNo).toBe(2)
    expect(openOf(again.tasks)).toEqual([
      [1, 1, 'dm_leg'],
      [1, 2, 'dm_qse'],
      [1, 3, 'dm_fin'],
    ])
  })
})

describe('[FR-WF-101/AC3] review.decide and the reasons of each slot (BR-WF-09)', () => {
  it('only the reviewer of the slot decides it; a reviewer cannot reject', async () => {
    const requestId = await contractWork()
    ok(await submitRequest(org.ctxOf('req_con', NOW), { requestId }, key()))
    const { tasks } = await routeOf(requestId)
    // The reviewer of slot 1 on the task of slot 2, the CEO before their step, ORG_ADMIN, the requester: refused
    for (const code of ['dm_leg', 'ceo', 'admin', 'req_con']) expect(await decide(tasks[1]!.id, code, 'APPROVE'), code).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await decide(tasks[1]!.id, 'dm_qse', 'REJECT')).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'REVIEW_CANNOT_REJECT' } } })
    expect((await routeOf(requestId)).tasks.map((t) => t.status)).toEqual(['OPEN', 'OPEN', 'OPEN'])
  })

  it('the requester, the DOA approver, the reviewer of the slot and AUDITOR read a reviewer\'s reason; a reviewer of another slot sees the decision only', async () => {
    const requestId = await contractWork()
    ok(await submitRequest(org.ctxOf('req_con', NOW), { requestId }, key()))
    const first = await routeOf(requestId)
    const reason = 'ขาดร่างสัญญาที่ฝ่ายกฎหมายตรวจแล้ว'
    ok(await decide(first.tasks[0]!.id, 'dm_leg', 'RETURN', LATER, reason))
    ok(await resubmitRequest(org.ctxOf('req_con', LATER), { requestId }, key()))
    for (const t of (await routeOf(requestId)).tasks) ok(await decide(t.id, codeOf(t.assigneeMemberId), 'APPROVE'))
    expect(openOf((await routeOf(requestId)).tasks)).toEqual([[2, 1, 'ceo']])

    const noteSeenBy = async (code: string) => {
      const view = await getRequestView(org.ctxOf(code, LATER), requestId)
      return view!.track.find((e) => e.what === 'RETURNED')?.note ?? null
    }
    for (const code of ['req_con', 'ceo', 'dm_leg', 'auditor']) expect(await noteSeenBy(code), code).toBe(reason)
    for (const code of ['dm_qse', 'dm_fin']) expect(await noteSeenBy(code), code).toBeNull()
    // The decision itself is seen by everyone who may open the request
    const seen = await getRequestView(org.ctxOf('dm_qse', LATER), requestId)
    expect(seen!.track.filter((e) => e.what === 'RETURNED')).toHaveLength(1)
  })
})

describe('[FR-WF-101/AC4] no reviewer nor fallback: the request is not sent and ORG_ADMIN is told (BR-WF-08)', () => {
  it('REVIEWER_NOT_FOUND names the rule; admin.doa_gap reaches ORG_ADMIN', async () => {
    const VACANT_FROM = new Date('2026-10-07T00:00:00Z')
    const AFTER = new Date('2026-10-07T03:00:00Z')
    // DM of LEG and VP of SUP (the fallback of RV-03) both leave their posts
    const vacated = await prisma.positionAssignment.findMany({ where: { organizationId: org.organizationId, memberId: { in: [org.member.dm_leg!, org.member.vp_sup!] }, validTo: null } })
    await prisma.positionAssignment.updateMany({ where: { id: { in: vacated.map((p) => p.id) } }, data: { validTo: VACANT_FROM } })
    try {
      const requestId = await contractWork(AFTER)
      const refused = await submitRequest(org.ctxOf('req_con', AFTER), { requestId }, key())
      expect(refused).toMatchObject({ ok: false, error: { code: 'REVIEWER_NOT_FOUND', details: { rule: 'RV-03', position: 'DM', department: 'LEG', adminsNotified: 1 } } })
      expect(await prisma.request.findUniqueOrThrow({ where: { id: requestId } })).toMatchObject({ status: 'DRAFT' })
      expect(await prisma.notification.findFirstOrThrow({ where: { templateKey: 'admin.doa_gap', subjectId: requestId } })).toMatchObject({
        recipientMemberId: org.member.admin,
        data: expect.objectContaining({ code: 'REVIEWER_NOT_FOUND', ruleCode: 'RV-03', position: 'DM', departments: ['LEG'] }),
      })
    } finally {
      await prisma.positionAssignment.updateMany({ where: { id: { in: vacated.map((p) => p.id) } }, data: { validTo: null } })
    }
  })
})

describe('[FR-WF-101/AC1] a request no reviewer rule matches routes as before', () => {
  it('a purchase of 5,000.00 has the DOA step alone, with no workflow version', async () => {
    const draft = ok(await createDraft(org.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', title: 'ถุงมือ', lines: [{ description: 'ถุงมือ', quantity: '10', uom: 'คู่', unitPrice: '500.00' }] }, key()))
    ok(await submitRequest(org.ctxOf('req_con', NOW), { requestId: draft.requestId }, key()))
    const { route, tasks } = await routeOf(draft.requestId)
    expect([route.ruleCode, route.workflowVersionId]).toEqual(['PR-01', null])
    expect(route.steps.map((s) => [s.stepNo, s.kind, s.doaStepNo, s.status, s.reviewGroups])).toEqual([[1, 'APPROVAL', 1, 'ACTIVE', null]])
    expect(tasks.map((t) => [t.slotNo, codeOf(t.assigneeMemberId), t.workflowRuleCodes])).toEqual([[1, 'dm_con', []]])
  })
})

describe('[FR-WF-101/AC5] KPI with reviewers: G-2 checks them with the workflow engine, G-5 counts approval steps only (OQ-101)', () => {
  it('three reviewers (one on LIFF) and the CEO on the web: no misrouting in four checked; G-5 is 0 of 1', async () => {
    const at = (h: number) => new Date(`2026-10-09T0${h}:00:00Z`)
    const requestId = await contractWork(at(2))
    ok(await submitRequest(org.ctxOf('req_con', at(2)), { requestId }, key()))
    const { tasks } = await routeOf(requestId)
    ok(await decide(tasks[0]!.id, 'dm_leg', 'APPROVE', at(3), '', 'LIFF'))
    ok(await decide(tasks[1]!.id, 'dm_qse', 'APPROVE', at(3)))
    ok(await decide(tasks[2]!.id, 'dm_fin', 'APPROVE', at(3)))
    const ceoTask = (await routeOf(requestId)).tasks.find((t) => t.step.stepNo === 2)!
    await pinStepUp(org.organizationId, org.member.ceo!, 'REQUEST', requestId)
    ok(await decide(ceoTask.id, 'ceo', 'APPROVE', at(4)))

    const { result, items } = await forTenant(org.organizationId).$transaction((tx) => collectKpis(tx, org.organizationId, { from: at(3), to: at(5), now: at(5) }, null))
    expect(result.g2).toEqual({ misrouted: 0, checked: 4, withDoaReference: { numerator: 4, denominator: 4 } })
    expect(items.decisions.map((d) => [codeOf(d.actorMemberId), d.review, d.misrouted])).toEqual([
      ['dm_leg', true, false],
      ['dm_qse', true, false],
      ['dm_fin', true, false],
      ['ceo', false, false],
    ])
    // dm_leg's LIFF decision is a review: G-5 counts the CEO's web decision alone
    expect(result.g5).toEqual({ total: { numerator: 0, denominator: 1 }, bySubject: { PURCHASE_REQUEST: { numerator: 0, denominator: 1 } } })
  })
})

describe('[FR-WF-101/AC2] the SLA of a REVIEW step (BR-WF-15)', () => {
  it('past escalateAt a reviewer\'s task gets no co-assignee', async () => {
    const requestId = await contractWork()
    ok(await submitRequest(org.ctxOf('req_con', NOW), { requestId }, key()))
    const { tasks } = await routeOf(requestId)
    expect(await escalateTask(org.organizationId, tasks[0]!.id, new Date('2026-11-30T03:00:00Z'))).toMatchObject({ done: true, outcome: 'NO_NEXT_BAND', coAssigneeTaskId: null })
    expect(await prisma.approvalTask.count({ where: { step: { route: { subjectId: requestId } } } })).toBe(3)
    expect(await prisma.event.findFirstOrThrow({ where: { type: 'approval_task.escalated', aggregateId: tasks[0]!.id } })).toMatchObject({ data: expect.objectContaining({ reason: 'SLOTTED_STEP' }) })
  })
})
