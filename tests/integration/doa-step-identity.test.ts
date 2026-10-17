import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import type { DoaRuleSnapshot } from '@/core/doa'
import { systemCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { ruleJson } from '@/server/doa/snapshot'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { decideTask } from '@/server/services/approvals/decide'
import { createDelegation } from '@/server/services/delegations'
import { applyDueChange, previewOrgChange } from '@/server/services/org-authority'
import { startDelegationWindow } from '@/server/services/sla'
import { createDraft, submitRequest } from '../support/requests'
import { versionSnapshots } from '../golden/doa-fixtures'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { pinStepUp } from '../support/pin'

// ADR-073 pre-review of phase 1, against Postgres (BR-WF-14, BR-WF-06, BR-DOA-07, BR-WF-02). A stored DOA step keeps
// its place in the rule (doaStepNo = RouteStep.ruleStepNo), so the step that starts later is that step of the route's
// own rule even when the holders of the submit merged two steps into one and those of today do not — before, the
// COO's step went to the VP and the request was approved without the COO — and a department move re-resolves a task
// from its own step, not another. And one member decides one slot of a step: a delegation that starts does not hand a
// slot to someone who decided another slot, and a decision of a second slot by the same person is refused.
//
// The S6 fixture (org-s6.yaml): purchase requests of 20,000–100,000 VAT included go to the DM of the charged
// department, then its VP, then the COO; above 100,000 to a committee of COO and CFO, both needed.

const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}
const day = (d: number, hour: number) => new Date(Date.UTC(2026, 9, d, hour))

let org: DoaOrg
const codeOf = (memberId: string) => Object.entries(org.member).find(([, id]) => id === memberId)?.[0]

beforeAll(async () => {
  setDefaultOutboxSender(null)
  org = await createDoaOrg({ fixtures: { org: 'fixtures/org-s6.yaml', versions: 'fixtures/doa-versions.yaml' } })
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: day(1, 0) } })
  const version = await prisma.doaVersion.findFirstOrThrow({ where: { organizationId: org.organizationId, versionNo: 1 } })
  const base = versionSnapshots('fixtures/doa-versions.yaml')[0]!.rules
  const three: DoaRuleSnapshot = {
    ...base.find((r) => r.code === 'PR-02')!,
    steps: [
      { approver: { kind: 'POSITION_OF_DEPARTMENT', position: 'DM' }, slaBusinessMinutes: 480, mode: 'SEQUENTIAL' },
      { approver: { kind: 'POSITION_OF_DEPARTMENT', position: 'VP' }, slaBusinessMinutes: 480, mode: 'SEQUENTIAL' },
      { approver: { kind: 'POSITION_OF_ORG', position: 'COO' }, slaBusinessMinutes: 480, mode: 'SEQUENTIAL' },
    ],
  }
  const committee: DoaRuleSnapshot = {
    ...base.find((r) => r.code === 'PR-03')!,
    steps: [{ approvers: [{ kind: 'POSITION_OF_ORG', position: 'COO' }, { kind: 'POSITION_OF_ORG', position: 'CFO' }], slaBusinessMinutes: 480, mode: 'PARALLEL', quorum: 'ALL' }],
  }
  await prisma.doaRule.updateMany({ where: { doaVersionId: version.id, code: 'PR-02' }, data: { steps: ruleJson(three).steps } })
  await prisma.doaRule.updateMany({ where: { doaVersionId: version.id, code: 'PR-03' }, data: { steps: ruleJson(committee).steps } })
})

async function sent(at: Date, unitPrice: string) {
  const draft = ok(await createDraft(org.ctxOf('req_con', at), { requestTypeCode: 'BUY_GOODS', title: 'เครื่องตัดคอนกรีต', lines: [{ description: 'เครื่องตัดคอนกรีต', quantity: '1', uom: 'เครื่อง', unitPrice }] }, key()))
  // the quotations ATT-QUOTES asks above 100,000
  for (let i = 0; i < 3; i++) {
    const file = await prisma.fileObject.create({ data: { organizationId: org.organizationId, storageKey: `test/${randomUUID()}.pdf`, fileName: 'q.pdf', mimeType: 'application/pdf', sizeBytes: 1, status: 'AVAILABLE', uploadedById: org.member.req_con! } })
    await prisma.fileLink.create({ data: { organizationId: org.organizationId, fileId: file.id, subjectType: 'Request', subjectId: draft.requestId, kind: 'QUOTATION' } })
  }
  ok(await submitRequest(org.ctxOf('req_con', at), { requestId: draft.requestId }, key()))
  return draft.requestId
}
const openTasks = (subjectId: string) => prisma.approvalTask.findMany({ where: { status: 'OPEN', step: { route: { subjectId } } }, include: { step: { select: { stepNo: true, doaStepNo: true } } }, orderBy: { slotNo: 'asc' } })

/** VP of OPS (the VP of the construction department) is `to` from `at` */
async function vpOfOps(to: string, at: Date) {
  const vp = await prisma.position.findFirstOrThrow({ where: { organizationId: org.organizationId, code: 'VP' } })
  await prisma.positionAssignment.updateMany({ where: { organizationId: org.organizationId, positionId: vp.id, departmentId: org.department.OPS!, validTo: null }, data: { validTo: at } })
  await prisma.positionAssignment.create({ data: { organizationId: org.organizationId, positionId: vp.id, departmentId: org.department.OPS!, memberId: org.member[to]!, validFrom: at } })
}

describe('[BR-WF-14] [BR-WF-06] a waiting step is the same step of the route\'s rule however the holders merge', () => {
  it('the DM held the VP too at the submit (one step kept); the VP is someone else when step 2 starts: it goes to the COO', async () => {
    await vpOfOps('dm_con', day(6, 1))
    const requestId = await sent(day(6, 3), '46000.00')
    const steps = await prisma.approvalStep.findMany({ where: { route: { subjectId: requestId } }, orderBy: { stepNo: 'asc' } })
    // BR-DOA-07 kept the later of DM and VP: the route is the VP's step (held by the DM), then the COO's
    expect(steps.map((s) => [s.stepNo, s.doaStepNo])).toEqual([
      [1, 2],
      [2, 3],
    ])
    const [first] = await openTasks(requestId)
    expect(codeOf(first!.assigneeMemberId)).toBe('dm_con')
    await vpOfOps('vp_ops', day(6, 5))
    ok(await decideTask(org.ctxOf('dm_con', day(6, 7)), { taskId: first!.id, decision: 'APPROVE' }, key()))
    const [next] = await openTasks(requestId)
    expect([next!.step.stepNo, codeOf(next!.assigneeMemberId), next!.resolvedFrom]).toEqual([2, 'coo', 'POSITION:COO@HQ'])
    ok(await decideTask(org.ctxOf('coo', day(6, 8)), { taskId: next!.id, decision: 'APPROVE' }, key()))
    expect((await prisma.request.findUniqueOrThrow({ where: { id: requestId } })).status).toBe('APPROVED')
  })
})

describe('[BR-WF-02] one member decides one slot of a step', () => {
  it('a delegation to the member who decided the other slot does not move the slot; a decision of a second slot is refused', async () => {
    const requestId = await sent(day(8, 3), '150000.00')
    const [coo, cfo] = await openTasks(requestId)
    expect([codeOf(coo!.assigneeMemberId), codeOf(cfo!.assigneeMemberId)]).toEqual(['coo', 'cfo'])
    await pinStepUp(org.organizationId, coo!.assigneeMemberId, 'REQUEST', requestId)
    ok(await decideTask(org.ctxOf('coo', day(8, 4)), { taskId: coo!.id, decision: 'APPROVE' }, key()))

    const delegation = ok(await createDelegation(org.ctxOf('cfo', day(8, 4)), { delegateMemberId: org.member.coo!, startsAt: day(8, 6).toISOString(), endsAt: day(9, 6).toISOString(), reason: 'ลาพักร้อน' }, key()))
    expect(await startDelegationWindow(org.organizationId, delegation.delegationId, day(8, 6))).toEqual({ done: true, movedTasks: 0 })
    expect((await openTasks(requestId)).map((t) => codeOf(t.assigneeMemberId))).toEqual(['cfo'])

    // whatever moved it there, the COO deciding the CFO's slot too is refused and nothing changes
    await prisma.approvalTask.update({ where: { id: cfo!.id }, data: { assigneeMemberId: org.member.coo! } })
    await pinStepUp(org.organizationId, org.member.coo!, 'REQUEST', requestId)
    expect(await decideTask(org.ctxOf('coo', day(8, 7)), { taskId: cfo!.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'SOD_VIOLATION', details: { rule: 'BR-WF-02' } } })
    expect((await prisma.approvalTask.findUniqueOrThrow({ where: { id: cfo!.id } })).status).toBe('OPEN')
    expect((await prisma.request.findUniqueOrThrow({ where: { id: requestId } })).status).toBe('PENDING_APPROVAL')
  })
})

describe('[FR-WF-104/AC2] a department move re-resolves an open task from its own step of the rule', () => {
  it('the COO\'s task of a route whose DM and VP merged stays with the COO when the department moves', async () => {
    await vpOfOps('dm_con', day(10, 1))
    const requestId = await sent(day(10, 3), '46000.00')
    const [first] = await openTasks(requestId)
    ok(await decideTask(org.ctxOf('dm_con', day(10, 4)), { taskId: first!.id, decision: 'APPROVE' }, key()))
    const [cooTask] = await openTasks(requestId)
    expect([cooTask!.step.doaStepNo, codeOf(cooTask!.assigneeMemberId)]).toEqual([3, 'coo'])

    const at = day(10, 6)
    const move = { kind: 'DEPARTMENT_REPARENT' as const, payload: { departmentId: org.department.CON!, newParentId: org.department.SUP! }, effectiveFrom: at.toISOString(), reason: 'ย้ายฝ่ายก่อสร้างไปสายสนับสนุน', acknowledgedWarnings: [] }
    ok(await previewOrgChange(org.ctxOf('admin', at), move, key()))
    const change = await prisma.orgAuthorityChange.create({
      data: { organizationId: org.organizationId, kind: 'DEPARTMENT_REPARENT', payload: move.payload, reason: move.reason, effectiveFrom: at, submittedById: org.member.admin!, status: 'SCHEDULED', submittedAt: at, approvedAt: at },
    })
    ok(await applyDueChange(systemCtx(org.organizationId, at, 'org-authority-apply'), { changeId: change.id }, key()))
    const [still] = await openTasks(requestId)
    expect([still!.id, codeOf(still!.assigneeMemberId)]).toEqual([cooTask!.id, 'coo'])
  })
})
