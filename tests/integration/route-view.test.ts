import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { fund } from '@/core/budget'
import type { CommitteeStepSpec, DoaRuleSnapshot } from '@/core/doa'
import { applyBudget } from '@/server/budget/ledger'
import { systemCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { ruleJson } from '@/server/doa/snapshot'
import { appendEvents } from '@/server/events/append'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { getRouteView } from '@/server/queries/route-view'
import { decideTask } from '@/server/services/approvals/decide'
import { createDraft, submitRequest } from '../support/requests'
import { loadSeedForms } from '@/server/seed/forms'
import { seedWorkflow } from '@/server/seed/workflow'
import { versionSnapshots } from '../golden/doa-fixtures'
import { workflowFixture } from '../golden/workflow-fixtures'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { pinStepUp } from '../support/pin'

// S6-06 (spec docs/sub-specs/S6.md "ให้ขั้นอื่น": getRouteView for S13 and S17): the three kinds of step and who decided
// each slot. The S6 fixture organization (org-s6.yaml) under the §7.4 DOA whose band above 100,000.00 is a committee of
// the CEO and the COO (ALL) here, with the reviewers of workflow-versions.yaml: a contract work above 1,000,000.00 has a
// REVIEW step (the DM of LEG, QSE and FIN) then the COMMITTEE step; a purchase of 5,000.00 one APPROVAL step. The DM of
// FIN is away: their delegate takes slot 3 and decides it for them.

const NOW = new Date('2026-10-06T02:00:00Z')
const LATER = new Date('2026-10-06T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}

let org: DoaOrg
const codeOf = (memberId: string | undefined) => Object.entries(org.member).find(([, id]) => id === memberId)?.[0] ?? null

beforeAll(async () => {
  setDefaultOutboxSender(null)
  org = await createDoaOrg({ fixtures: { org: 'fixtures/org-s6.yaml', versions: 'fixtures/doa-versions.yaml' } })
  const organizationId = org.organizationId
  const type = await prisma.requestType.create({ data: { organizationId, code: 'CONTRACT_WORK', nameTh: 'จ้างเหมา', documentType: 'PURCHASE_REQUEST' } })
  const form = await prisma.formVersion.create({ data: { organizationId, requestTypeId: type.id, versionNo: 1, schema: loadSeedForms().get('CONTRACT_WORK')! as object, status: 'PUBLISHED', publishedAt: NOW } })
  await prisma.requestType.update({ where: { id: type.id }, data: { currentFormVersionId: form.id } })
  await prisma.roleAssignment.create({ data: { organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
  const line = await prisma.budgetLine.findFirstOrThrow({ where: { organizationId, departmentId: org.department.CON! } })
  const importId = randomUUID()
  await forTenant(organizationId).$transaction(async (tx) => {
    const ctx = systemCtx(organizationId, NOW, 'seed')
    const funded = await applyBudget(tx, ctx, [{ budgetLineId: line.id, document: { type: 'IMPORT' as const, id: importId }, run: (s) => fund(s, 10_000_000_000n, importId) }])
    if (!funded.ok) throw new Error(funded.error.code)
    await appendEvents(tx, ctx, funded.events)
  })
  // PR-03 becomes a committee of the CEO and the COO, both to approve
  const version = await prisma.doaVersion.findFirstOrThrow({ where: { organizationId, versionNo: 1 } })
  const committee: CommitteeStepSpec = { approvers: [{ kind: 'POSITION_OF_ORG', position: 'CEO' }, { kind: 'POSITION_OF_ORG', position: 'COO' }], slaBusinessMinutes: 960, mode: 'PARALLEL', quorum: 'ALL' }
  const rule: DoaRuleSnapshot = { ...versionSnapshots('fixtures/doa-versions.yaml')[0]!.rules.find((r) => r.code === 'PR-03')!, steps: [committee] }
  await prisma.doaRule.updateMany({ where: { doaVersionId: version.id, code: 'PR-03' }, data: { steps: ruleJson(rule).steps } })
  const fixture = workflowFixture(['fixtures/workflow-versions.yaml']).versions[0]!
  await seedWorkflow(organizationId, { code: fixture.code, rules: fixture.rules.map((r) => ({ ...r, descriptionTh: null })) }, NOW)
  await prisma.delegation.create({
    data: { organizationId, delegatorMemberId: org.member.dm_fin!, delegateMemberId: org.member.fin_officer!, startsAt: new Date('2026-10-05T00:00:00Z'), endsAt: new Date('2026-10-09T10:00:00Z'), documentTypes: [], reason: 'ลาพักร้อน', status: 'ACTIVE', createdVia: 'SELF' },
  })
})

async function sent(requestTypeCode: string, unitPrice: string, formData: Record<string, string> = {}) {
  const draft = ok(await createDraft(org.ctxOf('req_con', NOW), { requestTypeCode, title: 'งานทดสอบเส้นทาง', formData, lines: [{ description: 'รายการ', quantity: '1', uom: 'งาน', unitPrice }] }, key()))
  for (let i = 0; i < 3; i++) {
    const file = await prisma.fileObject.create({ data: { organizationId: org.organizationId, storageKey: `test/${randomUUID()}.pdf`, fileName: 'q.pdf', mimeType: 'application/pdf', sizeBytes: 1, status: 'AVAILABLE', uploadedById: org.member.req_con! } })
    await prisma.fileLink.create({ data: { organizationId: org.organizationId, fileId: file.id, subjectType: 'Request', subjectId: draft.requestId, kind: 'QUOTATION' } })
  }
  const result = ok(await submitRequest(org.ctxOf('req_con', NOW), { requestId: draft.requestId }, key()))
  return { requestId: draft.requestId, routeId: result.routeId }
}
const CONTRACT = { scopeOfWork: 'ก่อสร้าง', milestones: '3 งวด', site: 'ไซต์ P07' }
const slotsOf = (step: { slots: readonly { slotNo: number; ruleCodes: readonly string[]; status: string; holders: readonly { approver: { id: string } | null; onBehalfOf: { id: string } | null }[] }[] }) =>
  step.slots.map((s) => [s.slotNo, s.ruleCodes, s.status, s.holders.map((h) => [codeOf(h.approver?.id), codeOf(h.onBehalfOf?.id)])])

describe('[FR-WF-101/AC1] [FR-WF-102/AC1] getRouteView: the kind of each step and the decider of each slot', () => {
  it('a contract work has a REVIEW step then a COMMITTEE step; a delegate decides slot 3 for the DM of FIN', async () => {
    const { requestId, routeId } = await sent('CONTRACT_WORK', '2470000.00', CONTRACT)
    const before = (await getRouteView(org.ctxOf('req_con', NOW), routeId))!
    expect([before.subjectType, before.subjectId, before.doa.ruleCode, before.workflowVersion?.code]).toEqual(['REQUEST', requestId, 'PR-03', 'WF-DEMO'])
    expect(before.steps.map((s) => [s.stepNo, s.doaStepNo, s.stepType, s.mode, s.quorum, s.status, s.outcome])).toEqual([
      [1, null, 'REVIEW', 'PARALLEL', 'ALL', 'ACTIVE', 'OPEN'],
      [2, 1, 'COMMITTEE', 'PARALLEL', 'ALL', 'WAITING', 'OPEN'],
    ])
    expect(before.steps[0]!.groups.map((g) => [g.ruleCodes, g.quorum, g.slotNos])).toEqual([
      [['RV-03'], 'ALL', [1]],
      [['RV-04'], 'ALL', [2]],
      [['RV-05'], 'ALL', [3]],
    ])
    expect(slotsOf(before.steps[0]!)).toEqual([
      [1, ['RV-03'], 'OPEN', [['dm_leg', null]]],
      [2, ['RV-04'], 'OPEN', [['dm_qse', null]]],
      [3, ['RV-05'], 'OPEN', [['fin_officer', 'dm_fin']]],
    ])
    expect(before.steps[1]!.slots).toEqual([])

    for (const slot of before.steps[0]!.slots) {
      const holder = slot.holders[0]!
      ok(await decideTask(org.ctxOf(codeOf(holder.approver!.id)!, LATER), { taskId: holder.taskId, decision: 'APPROVE' }, key()))
    }
    const after = (await getRouteView(org.ctxOf('req_con', LATER), routeId))!
    expect(after.steps[0]!.slots.map((s) => [s.slotNo, s.status, codeOf(s.decidedBy?.id), codeOf(s.decidedOnBehalfOf?.id), s.decidedAt])).toEqual([
      [1, 'APPROVE', 'dm_leg', null, LATER],
      [2, 'APPROVE', 'dm_qse', null, LATER],
      [3, 'APPROVE', 'fin_officer', 'dm_fin', LATER],
    ])
    expect(after.steps.map((s) => [s.status, s.outcome])).toEqual([
      ['DONE', 'APPROVED'],
      ['ACTIVE', 'OPEN'],
    ])
    expect(slotsOf(after.steps[1]!)).toEqual([
      [1, ['PR-03'], 'OPEN', [['ceo', null]]],
      [2, ['PR-03'], 'OPEN', [['coo', null]]],
    ])
    // One of the two approves: the committee waits for the other (ALL)
    await pinStepUp(org.organizationId, org.member.ceo!, 'REQUEST', requestId)
    ok(await decideTask(org.ctxOf('ceo', LATER), { taskId: after.steps[1]!.slots[0]!.holders[0]!.taskId, decision: 'APPROVE' }, key()))
    const committee = (await getRouteView(org.ctxOf('req_con', LATER), routeId))!.steps[1]!
    expect([committee.outcome, committee.slots.map((s) => s.status)]).toEqual(['OPEN', ['APPROVE', 'OPEN']])
  })

  it('a purchase of 5,000.00 has one APPROVAL step of one slot', async () => {
    const { routeId } = await sent('BUY_GOODS', '5000.00')
    const view = (await getRouteView(org.ctxOf('req_con', NOW), routeId))!
    expect(view.workflowVersion).toBeNull()
    expect(view.steps.map((s) => [s.stepNo, s.doaStepNo, s.stepType, s.mode, s.groups, s.outcome])).toEqual([[1, 1, 'APPROVAL', 'SEQUENTIAL', [], 'OPEN']])
    expect(slotsOf(view.steps[0]!)).toEqual([[1, ['PR-01'], 'OPEN', [['dm_con', null]]]])
  })

  it('a reviewer\'s reason: the requester reads it, a reviewer of another slot does not (BR-WF-09)', async () => {
    const { routeId } = await sent('CONTRACT_WORK', '1500000.00', CONTRACT)
    const view = (await getRouteView(org.ctxOf('req_con', NOW), routeId))!
    ok(await decideTask(org.ctxOf('dm_leg', LATER), { taskId: view.steps[0]!.slots[0]!.holders[0]!.taskId, decision: 'RETURN', reason: 'ขาดร่างสัญญา' }, key()))
    const reasonFor = async (code: string) => (await getRouteView(org.ctxOf(code, LATER), routeId))!.steps[0]!.slots[0]!.reason
    expect(await reasonFor('req_con')).toBe('ขาดร่างสัญญา')
    expect(await reasonFor('dm_leg')).toBe('ขาดร่างสัญญา')
    expect(await reasonFor('dm_qse')).toBeNull()
    expect((await getRouteView(org.ctxOf('dm_qse', LATER), routeId))!.steps[0]!.slots[0]!.status).toBe('RETURN')
    expect(await getRouteView(org.ctxOf('req_con', LATER), randomUUID())).toBeNull()
  })
})
