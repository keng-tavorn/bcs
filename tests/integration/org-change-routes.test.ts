import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import type { DoaRuleSnapshot } from '@/core/doa'
import { systemCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { ruleJson } from '@/server/doa/snapshot'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { getRequestView } from '@/server/queries/requests'
import { decideTask } from '@/server/services/approvals/decide'
import { applyDueChange, previewOrgChange } from '@/server/services/org-authority'
import { createDraft, submitRequest } from '../support/requests'
import { versionSnapshots } from '../golden/doa-fixtures'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// S6-08 (FR-WF-104 · BR-WF-14 · OQ-111 way ก): the approval line follows the organization as it changes, against
// Postgres. On the S6 fixture (org-s6.yaml) under the §7.4 DOA whose band of 20,000–100,000 VAT included is a line of
// two steps here — the DM of the charged department, then its VP — a request of 50,000.00 waits at step 1 while the VP
// of OPS changes: step 2 goes to the holder of the day it starts, under the same version and rule; a new holder who is
// the requester never gets it. A department moved under another branch (DEPARTMENT_REPARENT) takes its open tasks along.

const NOW = new Date('2026-10-06T03:00:00Z')
const CHANGE = new Date('2026-10-06T05:00:00Z')
const LATER = new Date('2026-10-06T07:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}

let org: DoaOrg
const codeOf = (memberId: string) => Object.entries(org.member).find(([, id]) => id === memberId)?.[0]

beforeAll(async () => {
  setDefaultOutboxSender(null)
  org = await createDoaOrg({ fixtures: { org: 'fixtures/org-s6.yaml', versions: 'fixtures/doa-versions.yaml' } })
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
  // PR-02 becomes two steps: the DM, then the VP of the charged department
  const version = await prisma.doaVersion.findFirstOrThrow({ where: { organizationId: org.organizationId, versionNo: 1 } })
  const base = versionSnapshots('fixtures/doa-versions.yaml')[0]!.rules.find((r) => r.code === 'PR-02')!
  const rule: DoaRuleSnapshot = {
    ...base,
    steps: [
      { approver: { kind: 'POSITION_OF_DEPARTMENT', position: 'DM' }, slaBusinessMinutes: 480, mode: 'SEQUENTIAL' },
      { approver: { kind: 'POSITION_OF_DEPARTMENT', position: 'VP' }, slaBusinessMinutes: 480, mode: 'SEQUENTIAL' },
    ],
  }
  await prisma.doaRule.updateMany({ where: { doaVersionId: version.id, code: 'PR-02' }, data: { steps: ruleJson(rule).steps } })
})

async function sent(requester = 'req_con') {
  const draft = ok(await createDraft(org.ctxOf(requester, NOW), { requestTypeCode: 'BUY_GOODS', title: 'เครื่องตัดคอนกรีต', lines: [{ description: 'เครื่องตัดคอนกรีต', quantity: '1', uom: 'เครื่อง', unitPrice: '46000.00' }] }, key()))
  ok(await submitRequest(org.ctxOf(requester, NOW), { requestId: draft.requestId }, key()))
  return draft.requestId
}
const openTasks = (subjectId: string) => prisma.approvalTask.findMany({ where: { status: 'OPEN', step: { route: { subjectId } } }, include: { step: { select: { stepNo: true } } } })

/** The VP of OPS changes at `at`: the holder ends, `to` holds it from then */
async function replaceVpOps(to: string, at: Date) {
  const vp = await prisma.position.findFirstOrThrow({ where: { organizationId: org.organizationId, code: 'VP' } })
  await prisma.positionAssignment.updateMany({ where: { organizationId: org.organizationId, positionId: vp.id, departmentId: org.department.OPS!, validTo: null }, data: { validTo: at } })
  await prisma.positionAssignment.create({ data: { organizationId: org.organizationId, positionId: vp.id, departmentId: org.department.OPS!, memberId: org.member[to]!, validFrom: at } })
}

describe('[FR-WF-104/AC1] a waiting step takes the holder of the day it starts, under the route\'s version and rule', () => {
  it('the VP of OPS changes while the request waits at step 1: step 2 goes to the new VP, and the request page says why', async () => {
    const requestId = await sent()
    const [dm] = await openTasks(requestId)
    expect([dm!.step.stepNo, codeOf(dm!.assigneeMemberId)]).toEqual([1, 'dm_con'])
    await replaceVpOps('fin_officer', CHANGE)
    ok(await decideTask(org.ctxOf('dm_con', LATER), { taskId: dm!.id, decision: 'APPROVE' }, key()))
    const [vp] = await openTasks(requestId)
    expect([vp!.step.stepNo, codeOf(vp!.assigneeMemberId), vp!.resolvedFrom]).toEqual([2, 'fin_officer', 'POSITION:VP@OPS'])
    // The same version and rule; the event names whom the route would have given the step at the submit
    const route = await prisma.approvalRoute.findFirstOrThrow({ where: { subjectId: requestId } })
    expect(route.ruleCode).toBe('PR-02')
    expect(await prisma.event.findFirstOrThrow({ where: { type: 'approval_task.assigned', aggregateId: vp!.id } })).toMatchObject({ data: { holderChangedFrom: org.member.vp_ops } })
    const view = await getRequestView(org.ctxOf('req_con', LATER), requestId)
    expect(view!.route!.steps.map((s) => [s.stepNo, s.holderChanged ?? false])).toEqual([
      [1, false],
      [2, true],
    ])
  })

  it('a new holder who is the requester never gets the step: the route escalates as at the submit (BR-DOA-06)', async () => {
    const requestId = await sent('asst_con')
    const [dm] = await openTasks(requestId)
    await replaceVpOps('asst_con', new Date(CHANGE.getTime() + 30 * 60_000))
    ok(await decideTask(org.ctxOf('dm_con', LATER), { taskId: dm!.id, decision: 'APPROVE' }, key()))
    const next = await openTasks(requestId)
    expect(next.map((t) => codeOf(t.assigneeMemberId))).not.toContain('asst_con')
    expect(next.map((t) => [t.step.stepNo, codeOf(t.assigneeMemberId)])).toEqual([[2, 'ceo']])
  })
})

describe('[FR-WF-104/AC2] [FR-WF-104/AC3] a department moved under another branch takes its open tasks along', () => {
  it('the preview counts the task that will move; applied, the VP of SUP gets it with the same DOA reference, both told', async () => {
    // A fresh VP of OPS for this case, and a request now waiting at the VP of OPS
    await replaceVpOps('vp_ops', new Date(CHANGE.getTime() + 60 * 60_000))
    const requestId = await sent()
    const [dm] = await openTasks(requestId)
    ok(await decideTask(org.ctxOf('dm_con', LATER), { taskId: dm!.id, decision: 'APPROVE' }, key()))
    const [atVp] = await openTasks(requestId)
    expect(codeOf(atVp!.assigneeMemberId)).toBe('vp_ops')

    const move = { kind: 'DEPARTMENT_REPARENT' as const, payload: { departmentId: org.department.CON!, newParentId: org.department.SUP! }, effectiveFrom: LATER.toISOString(), reason: 'ย้ายฝ่ายก่อสร้างไปสายสนับสนุน', acknowledgedWarnings: [] }
    const preview = ok(await previewOrgChange(org.ctxOf('admin', LATER), move, key()))
    expect(preview.openTasks).toBeGreaterThanOrEqual(1)

    const change = await prisma.orgAuthorityChange.create({
      data: { organizationId: org.organizationId, kind: 'DEPARTMENT_REPARENT', payload: move.payload, reason: move.reason, effectiveFrom: LATER, submittedById: org.member.admin!, status: 'SCHEDULED', submittedAt: LATER, approvedAt: LATER },
    })
    ok(await applyDueChange(systemCtx(org.organizationId, LATER, 'org-authority-apply'), { changeId: change.id }, key()))
    const after = await openTasks(requestId)
    expect(after.map((t) => [codeOf(t.assigneeMemberId), t.resolvedFrom])).toEqual([['vp_sup', 'POSITION:VP@SUP']])
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: atVp!.id } })).toMatchObject({ status: 'REASSIGNED' })
    expect(await prisma.event.findFirstOrThrow({ where: { type: 'approval_task.reassigned', aggregateId: after[0]!.id } })).toMatchObject({ data: { fromMemberId: org.member.vp_ops, toMemberId: org.member.vp_sup, why: 'ORG_AUTHORITY_CHANGE', changeId: change.id } })
    const told = await prisma.notification.findMany({ where: { templateKey: 'doa.authority_changed', subjectId: change.id }, select: { recipientMemberId: true } })
    expect(told.map((n) => n.recipientMemberId)).toEqual(expect.arrayContaining([org.member.vp_ops, org.member.vp_sup]))
    // The route keeps its DOA reference
    expect(await prisma.approvalRoute.findFirstOrThrow({ where: { subjectId: requestId } })).toMatchObject({ ruleCode: 'PR-02' })
  })
})
