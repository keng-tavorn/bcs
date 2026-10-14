import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import type { CommitteeStepSpec, DoaRuleSnapshot } from '@/core/doa'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { ruleJson } from '@/server/doa/snapshot'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { decideByActionLink } from '@/server/services/approvals/action-link'
import { decideTask } from '@/server/services/approvals/decide'
import { decideByLinePostback } from '@/server/services/approvals/line-postback'
import { submitDoaVersion } from '@/server/services/doa'
import { draftDoaCopy, getDoaEditor } from '@/server/services/doa/editor'
import { saveLineChannelSettings } from '@/server/services/line-channel'
import { assignSupplier, consolidateNow } from '@/server/services/procurement'
import { submitPo } from '@/server/services/purchase-orders'
import { postGoodsReceipt } from '@/server/services/receiving'
import { collectKpis } from '@/server/services/reports/kpi'
import { createDraft, resubmitRequest, submitRequest } from '../support/requests'
import { emailLinkSecret } from '@/server/tokens/action-tokens'
import { newLineUserId } from '../../scripts/line-simulate'
import { versionSnapshots } from '../golden/doa-fixtures'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { TEST_ACCESS_TOKEN, TEST_CHANNEL_SECRET, withFakeLine } from '../support/fake-line'
import { pinStepUp } from '../support/pin'

// S6-02 (FR-WF-102 · BR-WF-01 · INV-WF-02 · INV-WF-03): a committee step decided slot by slot through every decide
// flow — requests, purchase orders, receiving variances and policy (a DOA version) — on the web, from the LINE button
// and from the e-mail link. The organization is the committee fixture (org-s6.yaml, doa-committee.yaml: purchase
// requests above 100,000.00 go to PC1 PC2 PC3 by majority) with three more committees stored the way the seed stores
// rules: purchase orders by COO and CFO (ALL), variances by the DM or the VP of the department (ANY) and DOA changes by
// two of CEO COO CFO (COUNT 2). No step-up below the threshold of the test version (none), except for DOA changes
// (BR-DOA-15). Real Postgres.

const NOW = new Date('2026-10-06T02:00:00Z')
const LATER = new Date('2026-10-06T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}
const PROVIDER = '1650000101'
const CHANNEL = { providerId: PROVIDER, messagingChannelId: '1650000102', channelSecret: TEST_CHANNEL_SECRET, channelAccessToken: TEST_ACCESS_TOKEN, liffId: '1650000103-AbCdEfGh', liffChannelId: '1650000103' }

withFakeLine()
let org: DoaOrg
let supplierId: string
const codeOf = (memberId: string) => Object.entries(org.member).find(([, id]) => id === memberId)![0]

const committee = (approvers: CommitteeStepSpec['approvers'], quorum: CommitteeStepSpec['quorum'], quorumCount?: number): CommitteeStepSpec => ({
  approvers,
  slaBusinessMinutes: 480,
  mode: 'PARALLEL',
  quorum,
  ...(quorumCount ? { quorumCount } : {}),
})
const ORG_POSITION = (position: string) => ({ kind: 'POSITION_OF_ORG' as const, position })
const DEPT_POSITION = (position: string) => ({ kind: 'POSITION_OF_DEPARTMENT' as const, position })

beforeAll(async () => {
  setDefaultOutboxSender(null)
  org = await createDoaOrg({ fixtures: { org: 'fixtures/org-s6.yaml', versions: 'fixtures/doa-committee.yaml' } })
  const version = await prisma.doaVersion.findFirstOrThrow({ where: { organizationId: org.organizationId, code: 'DOA-WF' } })
  await prisma.doaVersion.update({ where: { id: version.id }, data: { stepUpThresholdSatang: null } })
  const replace: Record<string, CommitteeStepSpec> = {
    'PO-01': committee([ORG_POSITION('COO'), ORG_POSITION('CFO')], 'ALL'),
    'GRV-01': committee([DEPT_POSITION('DM'), DEPT_POSITION('VP')], 'ANY'),
    'DOA-CHG-01': committee([ORG_POSITION('CEO'), ORG_POSITION('COO'), ORG_POSITION('CFO')], 'COUNT', 2),
  }
  const base = versionSnapshots('fixtures/doa-committee.yaml')[0]!
  for (const [code, step] of Object.entries(replace)) {
    const rule: DoaRuleSnapshot = { ...base.rules.find((r) => r.code === code)!, steps: [step] }
    await prisma.doaRule.updateMany({ where: { doaVersionId: version.id, code }, data: { steps: ruleJson(rule).steps } })
  }
  supplierId = (await prisma.supplier.create({ data: { organizationId: org.organizationId, code: 'S1', nameTh: 'ผู้ขายหนึ่ง', taxId: '0999999000012' } })).id
  for (const [memberId, role] of [
    [org.member.admin!, 'ORG_ADMIN'],
    [org.member.receiver_con!, 'RECEIVER'],
  ] as const) {
    await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId, role, ...(role === 'RECEIVER' ? { scopeDepartmentId: org.department.CON! } : {}), grantedAt: NOW } })
  }
  await saveLineChannelSettings(org.ctxOf('admin', NOW), { ...CHANNEL, active: true }, key())
  for (const code of ['coo', 'dm_fin', 'dm_proc']) {
    await prisma.channelIdentity.create({ data: { organizationId: org.organizationId, memberId: org.member[code]!, channel: 'LINE', providerKey: PROVIDER, externalUserId: newLineUserId(), linkedAt: NOW } })
  }
})

/** A request of 150,000.00 before VAT with the quotations ATT-QUOTES asks: the committee of PR-02 decides it */
async function submittedRequest(net = '150000.00') {
  const draft = ok(await createDraft(org.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', title: 'เครื่องผสมคอนกรีต', lines: [{ description: 'เครื่องผสมคอนกรีต', quantity: '1', uom: 'เครื่อง', unitPrice: net }] }, key()))
  for (let i = 0; i < 3; i++) {
    const file = await prisma.fileObject.create({ data: { organizationId: org.organizationId, storageKey: `test/${randomUUID()}.pdf`, fileName: 'q.pdf', mimeType: 'application/pdf', sizeBytes: 1, status: 'AVAILABLE', uploadedById: org.member.req_con! } })
    await prisma.fileLink.create({ data: { organizationId: org.organizationId, fileId: file.id, subjectType: 'Request', subjectId: draft.requestId, kind: 'QUOTATION' } })
  }
  ok(await submitRequest(org.ctxOf('req_con', NOW), { requestId: draft.requestId }, key()))
  return draft.requestId
}

/** The tasks of the subject's latest route by slot, and its steps */
async function tasksOf(subjectId: string) {
  const route = await prisma.approvalRoute.findFirstOrThrow({ where: { subjectId }, orderBy: { routeNo: 'desc' }, include: { steps: { orderBy: { stepNo: 'asc' } } } })
  const tasks = await prisma.approvalTask.findMany({ where: { step: { routeId: route.id } }, orderBy: [{ slotNo: 'asc' }, { id: 'asc' }] })
  return { route, tasks }
}
const decide = (taskId: string, memberId: string, decision: 'APPROVE' | 'REJECT' | 'RETURN', at = LATER) =>
  decideTask(org.ctxOf(codeOf(memberId), at), { taskId, decision, ...(decision === 'APPROVE' ? {} : { reason: 'ขอทบทวนสเปก' }) }, key())

describe('[FR-WF-102/AC1] a committee step of a request: every slot at once, decided by its quorum (BR-WF-01)', () => {
  it('three tasks start together; two approvals of three approve the request and close the third', async () => {
    const requestId = await submittedRequest()
    const { route, tasks } = await tasksOf(requestId)
    expect(route.ruleCode).toBe('PR-02')
    expect(route.steps.map((s) => [s.stepNo, s.kind, s.doaStepNo, s.mode, s.quorum, s.quorumCount, s.status])).toEqual([[1, 'APPROVAL', 1, 'PARALLEL', 'COUNT', 2, 'ACTIVE']])
    expect(tasks.map((t) => [t.slotNo, codeOf(t.assigneeMemberId), t.resolvedFrom, t.status])).toEqual([
      [1, 'coo', 'POSITION:PC1@HQ', 'OPEN'],
      [2, 'dm_fin', 'POSITION:PC2@HQ', 'OPEN'],
      [3, 'dm_proc', 'POSITION:PC3@HQ', 'OPEN'],
    ])
    // Each slot's assignment is its own event with its slot
    const assigned = await prisma.event.findMany({ where: { type: 'approval_task.assigned', aggregateId: { in: tasks.map((t) => t.id) } }, orderBy: { seq: 'asc' } })
    expect(assigned.map((e) => (e.data as { slotNo?: number }).slotNo)).toEqual([1, 2, 3])

    expect(ok(await decide(tasks[0]!.id, tasks[0]!.assigneeMemberId, 'APPROVE'))).toMatchObject({ documentStatus: 'PENDING_APPROVAL' })
    expect((await tasksOf(requestId)).tasks.map((t) => t.status)).toEqual(['APPROVED', 'OPEN', 'OPEN'])
    expect(ok(await decide(tasks[2]!.id, tasks[2]!.assigneeMemberId, 'APPROVE'))).toMatchObject({ documentStatus: 'APPROVED' })

    const after = await tasksOf(requestId)
    expect(after.tasks.map((t) => t.status)).toEqual(['APPROVED', 'CANCELLED', 'APPROVED'])
    expect(after.route.steps[0]!.status).toBe('DONE')
    expect(await prisma.event.findFirstOrThrow({ where: { type: 'approval_task.cancelled', aggregateId: tasks[1]!.id } })).toMatchObject({ data: { why: 'STEP_DECIDED' } })
    expect(await prisma.event.findFirstOrThrow({ where: { type: 'approval_step.completed', aggregateId: route.steps[0]!.id } })).toMatchObject({
      data: { subjectType: 'REQUEST', subjectId: requestId, stepNo: 1, kind: 'APPROVAL', outcome: 'APPROVED', quorum: 'COUNT', quorumCount: 2, slots: ['APPROVE', null, 'APPROVE'] },
    })
    // The decisions name their slot (INV-DOA-01 still holds: the route's DOA version and rule)
    const decided = await prisma.event.findMany({ where: { type: 'approval_task.decided', aggregateId: { in: tasks.map((t) => t.id) } }, orderBy: { seq: 'asc' } })
    expect(decided.map((e) => [e.doaRuleCode, (e.data as { slotNo?: number }).slotNo])).toEqual([
      ['PR-02', 1],
      ['PR-02', 3],
    ])
    expect(await prisma.request.findUniqueOrThrow({ where: { id: requestId } })).toMatchObject({ status: 'APPROVED' })
  })

  it('[INV-WF-03] three members decide at the same moment: one result, two decisions, nothing left open', async () => {
    for (let round = 0; round < 3; round++) {
      const requestId = await submittedRequest()
      const { route, tasks } = await tasksOf(requestId)
      const results = await Promise.all(tasks.map((t) => decide(t.id, t.assigneeMemberId, 'APPROVE')))
      expect(results.filter((r) => r.ok)).toHaveLength(2)
      expect(results.find((r) => !r.ok)).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION' } })
      const after = await tasksOf(requestId)
      expect(after.tasks.filter((t) => t.status === 'OPEN' || t.status === 'INFO_REQUESTED')).toEqual([])
      expect(after.tasks.filter((t) => t.status === 'APPROVED')).toHaveLength(2)
      expect(after.route.steps[0]!.status).toBe('DONE')
      expect(await prisma.event.count({ where: { type: 'approval_step.completed', aggregateId: route.steps[0]!.id } })).toBe(1)
      expect(await prisma.request.findUniqueOrThrow({ where: { id: requestId } })).toMatchObject({ status: 'APPROVED' })
    }
  })

  it('a return by any member returns the request at once; the resubmit asks every member again', async () => {
    const requestId = await submittedRequest()
    const { tasks } = await tasksOf(requestId)
    ok(await decide(tasks[0]!.id, tasks[0]!.assigneeMemberId, 'APPROVE'))
    expect(ok(await decide(tasks[1]!.id, tasks[1]!.assigneeMemberId, 'RETURN'))).toMatchObject({ documentStatus: 'RETURNED' })
    expect((await tasksOf(requestId)).tasks.map((t) => t.status)).toEqual(['APPROVED', 'RETURNED', 'CANCELLED'])
    ok(await resubmitRequest(org.ctxOf('req_con', LATER), { requestId }, key()))
    const again = await tasksOf(requestId)
    expect(again.route.routeNo).toBe(2)
    expect(again.tasks.map((t) => [t.slotNo, t.status])).toEqual([
      [1, 'OPEN'],
      [2, 'OPEN'],
      [3, 'OPEN'],
    ])
  })

  it('two rejections of three reject it: the majority can no longer approve', async () => {
    const requestId = await submittedRequest()
    const { tasks } = await tasksOf(requestId)
    expect(ok(await decide(tasks[0]!.id, tasks[0]!.assigneeMemberId, 'REJECT'))).toMatchObject({ documentStatus: 'PENDING_APPROVAL' })
    expect(ok(await decide(tasks[1]!.id, tasks[1]!.assigneeMemberId, 'REJECT'))).toMatchObject({ documentStatus: 'REJECTED' })
    expect((await tasksOf(requestId)).tasks.map((t) => t.status)).toEqual(['REJECTED', 'REJECTED', 'CANCELLED'])
  })

  it('the LINE button and the e-mail link each decide their own slot', async () => {
    const requestId = await submittedRequest()
    const { tasks } = await tasksOf(requestId)
    const lineToken = await prisma.actionToken.findFirstOrThrow({ where: { taskId: tasks[0]!.id, channel: 'LINE' } })
    const lineCtx = makeCtx({ organizationId: org.organizationId, actor: { type: 'USER', memberId: org.member.coo! }, channel: 'LINE_CHAT', now: LATER })
    expect(await decideByLinePostback(lineCtx, { tokenId: lineToken.id }, key())).toMatchObject({ ok: true })
    expect(await prisma.request.findUniqueOrThrow({ where: { id: requestId } })).toMatchObject({ status: 'PENDING_APPROVAL' })
    const emailToken = await prisma.actionToken.findFirstOrThrow({ where: { taskId: tasks[1]!.id, channel: 'EMAIL' } })
    expect(await decideByActionLink(org.ctxOf('dm_fin', LATER, 'EMAIL'), { link: `${emailToken.id}.${emailLinkSecret(emailToken.id)}`, decision: 'APPROVE' }, key())).toMatchObject({ ok: true })
    expect(await prisma.request.findUniqueOrThrow({ where: { id: requestId } })).toMatchObject({ status: 'APPROVED' })
    // The third member's button closed with the step: it says who decided the step and when
    const third = await prisma.actionToken.findFirstOrThrow({ where: { taskId: tasks[2]!.id, channel: 'LINE' } })
    const thirdCtx = makeCtx({ organizationId: org.organizationId, actor: { type: 'USER', memberId: org.member.dm_proc! }, channel: 'LINE_CHAT', now: LATER })
    expect(await decideByLinePostback(thirdCtx, { tokenId: third.id }, key())).toMatchObject({ ok: false, error: { code: 'TOKEN_USED' } })
  })

  it('[FR-WF-102/AC1] G-2 counts every committee member who decided as deciding by the DOA', async () => {
    const period = { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-11-01T00:00:00Z'), now: LATER }
    const { items } = await forTenant(org.organizationId).$transaction((tx) => collectKpis(tx, org.organizationId, period, null))
    const decisions = items.decisions.filter((d) => d.subjectType === 'REQUEST' && d.doaRuleCode === 'PR-02')
    expect(decisions.length).toBeGreaterThan(3)
    expect(decisions.every((d) => d.misrouted === false)).toBe(true)
  })
})

describe('[FR-WF-102/AC1] committee steps of purchase orders, variances and DOA versions', () => {
  /** An approved request below the committee band (PR-01, the DM) on a PO of S1, sent for approval */
  async function submittedPo(quantity = '10', unitPrice = '1000.00') {
    const requestId = await submittedRequest('10000.00')
    const { tasks } = await tasksOf(requestId)
    ok(await decide(tasks[0]!.id, tasks[0]!.assigneeMemberId, 'APPROVE'))
    const site = await prisma.deliverySite.create({ data: { organizationId: org.organizationId, code: `SITE-${randomUUID().slice(0, 8)}`, nameTh: 'ไซต์' } })
    await prisma.request.update({ where: { id: requestId }, data: { deliverySiteId: site.id } })
    await prisma.requestLine.updateMany({ where: { requestId }, data: { quantity, unitPriceSatang: BigInt(Math.round(Number(unitPrice) * 100)) } })
    const requestLine = await prisma.requestLine.findFirstOrThrow({ where: { requestId } })
    const proc = org.ctxOf('proc_officer', NOW)
    ok(await assignSupplier(proc, { requestLineIds: [requestLine.id], supplierId }, key()))
    const run = ok(await consolidateNow(proc, key()))
    const po = await prisma.purchaseOrder.findFirstOrThrow({ where: { id: { in: [...run.purchaseOrderIds] }, deliverySiteId: site.id }, include: { lines: true } })
    ok(await submitPo(proc, { poId: po.id }, key()))
    return po
  }

  it('a purchase order of an ALL committee waits for both members', async () => {
    const po = await submittedPo()
    const { route, tasks } = await tasksOf(po.id)
    expect(route.ruleCode).toBe('PO-01')
    expect(tasks.map((t) => codeOf(t.assigneeMemberId))).toEqual(['coo', 'cfo'])
    expect(ok(await decide(tasks[0]!.id, tasks[0]!.assigneeMemberId, 'APPROVE'))).toMatchObject({ documentStatus: 'PENDING_APPROVAL' })
    expect(ok(await decide(tasks[1]!.id, tasks[1]!.assigneeMemberId, 'APPROVE'))).toMatchObject({ documentStatus: 'APPROVED' })
  })

  it('a receiving variance of an ANY committee is decided by the first member; the other task closes', async () => {
    const po = await submittedPo()
    for (const t of (await tasksOf(po.id)).tasks) ok(await decide(t.id, t.assigneeMemberId, 'APPROVE'))
    await prisma.purchaseOrder.update({ where: { id: po.id }, data: { status: 'SENT', sentAt: NOW } })
    const gr = ok(await postGoodsReceipt(org.ctxOf('receiver_con', LATER), { poId: po.id, lines: [{ poLineId: po.lines[0]!.id, received: '11', excessDisposition: 'ACCEPT_EXCESS' }] }, key()))
    const varianceId = gr.varianceIds[0]!
    const { route, tasks } = await tasksOf(varianceId)
    expect(route.ruleCode).toBe('GRV-01')
    expect(tasks.map((t) => codeOf(t.assigneeMemberId))).toEqual(['dm_con', 'vp_ops'])
    expect(ok(await decide(tasks[1]!.id, tasks[1]!.assigneeMemberId, 'APPROVE'))).toMatchObject({ documentStatus: 'APPROVED' })
    expect((await tasksOf(varianceId)).tasks.map((t) => t.status)).toEqual(['CANCELLED', 'APPROVED'])
  })

  it('a DOA version of a COUNT 2 committee is published by the second approval, each with the PIN (BR-DOA-15)', async () => {
    const source = await prisma.doaVersion.findFirstOrThrow({ where: { organizationId: org.organizationId, code: 'DOA-WF' } })
    const view = ok(await getDoaEditor(org.ctxOf('admin', NOW), source.id))
    const input = {
      sourceVersionId: view.source.id,
      effectiveDate: view.defaultEffectiveDate,
      changeReason: 'ขยายวงเงิน DM เป็น 120,000 บาท',
      policy: { ...view.policy },
      rules: view.rules.map((r) => ({
        code: r.code,
        documentType: r.documentType,
        band: r.code === 'PR-01' ? { ...r.band!, upper: '12000000' } : r.code === 'PR-02' ? { ...r.band!, lower: '12000000' } : r.band ? { ...r.band } : null,
        steps: r.steps.map((s) => ({ approver: { ...s.approver }, slaMinutes: s.slaMinutes, ...(s.committee ? { committee: { approvers: s.committee.approvers.map((a) => ({ ...a })), quorum: s.committee.quorum, quorumCount: s.committee.quorumCount } } : {}) })),
      })),
    }
    const saved = ok(await draftDoaCopy(org.ctxOf('admin', NOW), input, key()))
    ok(await submitDoaVersion(org.ctxOf('admin', NOW), { versionId: saved.versionId, boundaryTableConfirmed: true }, key()))
    const { tasks } = await tasksOf(saved.versionId)
    expect(tasks.map((t) => codeOf(t.assigneeMemberId))).toEqual(['ceo', 'coo', 'cfo'])
    const approve = async (i: number) => {
      const t = tasks[i]!
      await pinStepUp(org.organizationId, t.assigneeMemberId, 'DOA_VERSION', saved.versionId)
      return decideTask(org.ctxOf(codeOf(t.assigneeMemberId), LATER), { taskId: t.id, decision: 'APPROVE', boundaryTableConfirmed: true }, key())
    }
    expect(ok(await approve(0))).toMatchObject({ documentStatus: 'PENDING_APPROVAL' })
    expect(await prisma.doaVersion.findUniqueOrThrow({ where: { id: saved.versionId } })).toMatchObject({ status: 'PENDING_APPROVAL' })
    expect(ok(await approve(2))).toMatchObject({ documentStatus: 'PUBLISHED' })
    // The draft kept the committees it was copied with
    const rule = await prisma.doaRule.findFirstOrThrow({ where: { doaVersionId: saved.versionId, code: 'DOA-CHG-01' } })
    expect(rule.steps).toEqual([{ approvers: [ORG_POSITION('CEO'), ORG_POSITION('COO'), ORG_POSITION('CFO')], slaBusinessMinutes: 480, mode: 'PARALLEL', quorum: 'COUNT', quorumCount: 2 }])
  })
})

describe('[INV-WF-02] a member holds at most one slot of a step', () => {
  it('a member who holds two seats and the delegate of a third get one task each', async () => {
    const pc3 = await prisma.position.findFirstOrThrow({ where: { organizationId: org.organizationId, code: 'PC3' } })
    const held = await prisma.positionAssignment.findFirstOrThrow({ where: { positionId: pc3.id } })
    await prisma.positionAssignment.update({ where: { id: held.id }, data: { memberId: org.member.coo! } })
    try {
      const requestId = await submittedRequest()
      const { tasks } = await tasksOf(requestId)
      expect(tasks.map((t) => [t.slotNo, codeOf(t.assigneeMemberId), t.resolvedFrom])).toEqual([
        [1, 'coo', 'POSITION:PC1@HQ'],
        [2, 'dm_fin', 'POSITION:PC2@HQ'],
      ])
      const open = await prisma.approvalTask.groupBy({ by: ['assigneeMemberId'], where: { stepId: tasks[0]!.stepId, status: 'OPEN' }, _count: true })
      expect(open.every((g) => g._count === 1)).toBe(true)
    } finally {
      await prisma.positionAssignment.update({ where: { id: held.id }, data: { memberId: org.member.dm_proc! } })
    }
  })
})
