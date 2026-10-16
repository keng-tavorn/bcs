import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { backtestDraft, completeBacktestRun, getBacktestRun } from '@/server/services/backtest'
import { createDraft, submitRequest } from '../support/requests'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// S6-07 (FR-DOA-103 · BR-WF-13 · ADR-111): the 90-day backtest of a DOA draft against Postgres, on the §7.4 fixture
// (version 1 in effect; a draft of version 2 moves the DM band of purchase requests up to 30,000.00 VAT included).
// A request of 25,000.00 before VAT (26,750.00 with it) went to the VP under version 1 and would go to the DM of CON
// under the draft (GC-WF-42 on real documents); one of 5,000.00 does not move. Read by who may try a DOA and by the
// draft's approver; with more than 500 documents in the window the job fills a run instead.

const NOW = new Date('2026-10-06T03:00:00Z')
const LATER = new Date('2026-10-07T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}

let org: DoaOrg
let draftId: string
let moved: string
let stayed: string

async function sent(net: string, title: string) {
  const draft = ok(await createDraft(org.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', title, lines: [{ description: title, quantity: '1', uom: 'ชุด', unitPrice: net }] }, key()))
  ok(await submitRequest(org.ctxOf('req_con', NOW), { requestId: draft.requestId }, key()))
  return draft.requestId
}

beforeAll(async () => {
  setDefaultOutboxSender(null)
  org = await createDoaOrg({ fixtures: { org: 'fixtures/org-s6.yaml', versions: 'fixtures/doa-versions.yaml' } })
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
  moved = await sent('25000.00', 'เครื่องตัดคอนกรีต')
  stayed = await sent('5000.00', 'ถุงมือ')
  // The draft: version 1's rules with the DM band up to 30,000.00 and the VP band from there (as fixture version 2)
  const v1 = await prisma.doaVersion.findFirstOrThrow({ where: { organizationId: org.organizationId, versionNo: 1 }, include: { rules: true } })
  const { id: _i, rules, createdAt: _c, updatedAt: _u, ...rest } = v1
  const draft = await prisma.doaVersion.create({ data: { ...rest, escalationPolicy: rest.escalationPolicy as object, sodPolicy: rest.sodPolicy as object, versionNo: 2, status: 'DRAFT', effectiveFrom: new Date('2026-10-31T17:00:00Z'), publishedAt: null } as never })
  for (const r of rules) {
    const when = r.code === 'PR-01' ? { amount: { gt: '0', lte: '3000000' } } : r.code === 'PR-02' ? { amount: { gt: '3000000', lte: '10000000' } } : r.when
    await prisma.doaRule.create({ data: { organizationId: org.organizationId, doaVersionId: draft.id, code: r.code, documentType: r.documentType, priority: r.priority, when: when as object, steps: r.steps as object } })
  }
  draftId = draft.id
})

describe('[FR-DOA-103/AC1] the backtest of a DOA draft routes the last 90 days again with the real engine', () => {
  it('the request of 25,000.00 moves from the VP to the DM of CON; the one of 5,000.00 stays; the load per person says so', async () => {
    const view = ok(await backtestDraft(org.ctxOf('admin', LATER), { kind: 'DOA_VERSION', versionId: draftId }, key()))
    if (view.status !== 'DONE') throw new Error(view.status)
    const row = (id: string) => view.result.rows.find((r) => r.ref === id)!
    expect(row(moved)).toMatchObject({ current: { rule: 'PR-02', approvers: [org.member.vp_ops] }, draft: { rule: 'PR-01', approvers: [org.member.dm_con] }, changed: true })
    expect(row(stayed)).toMatchObject({ current: { rule: 'PR-01', approvers: [org.member.dm_con] }, changed: false })
    expect(view.result.summary).toEqual({ total: 2, changed: 1, load: Object.fromEntries([[org.member.dm_con!, 1], [org.member.vp_ops!, -1]].sort(([a], [b]) => String(a).localeCompare(String(b)))) })
    expect(view.documents.find((d) => d.ref === moved)).toMatchObject({ subjectType: 'REQUEST', label: expect.stringContaining('เครื่องตัดคอนกรีต') })
    // Nothing of the documents changed: a backtest writes no business data
    expect(await prisma.approvalRoute.count({ where: { subjectId: moved } })).toBe(1)
  })

  it('a member who may not try a DOA is refused; the draft\'s approver of DOA_CHANGE may read it (BR-DOA-14)', async () => {
    expect(await backtestDraft(org.ctxOf('req_con', LATER), { kind: 'DOA_VERSION', versionId: draftId }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await backtestDraft(org.ctxOf('ceo', LATER), { kind: 'DOA_VERSION', versionId: draftId }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    // The draft is sent: the CEO holds its task and may read the backtest
    const v1 = await prisma.doaVersion.findFirstOrThrow({ where: { organizationId: org.organizationId, versionNo: 1 } })
    const route = await prisma.approvalRoute.create({
      data: { organizationId: org.organizationId, subjectType: 'DOA_VERSION', subjectId: draftId, routeNo: 1, doaVersionId: v1.id, ruleCode: 'DOA-CHG-01', amountBasis: 'GROSS', explanationTh: 'ส่งเพื่อทดสอบ' },
    })
    const step = await prisma.approvalStep.create({ data: { organizationId: org.organizationId, routeId: route.id, stepNo: 1, slaBusinessMinutes: 960, status: 'ACTIVE' } })
    await prisma.approvalTask.create({ data: { organizationId: org.organizationId, stepId: step.id, assigneeMemberId: org.member.ceo!, resolvedFrom: 'POSITION:CEO@HQ', assignedAt: LATER } })
    expect(ok(await backtestDraft(org.ctxOf('ceo', LATER), { kind: 'DOA_VERSION', versionId: draftId }, key()))).toMatchObject({ status: 'DONE' })
  })
})

describe('[FR-DOA-103/AC3] more than 500 documents in the window: a run the job fills', () => {
  it('asked, it is PENDING with a backtest.requested; the job writes it DONE once, read again with the same rights', async () => {
    const v1 = await prisma.doaVersion.findFirstOrThrow({ where: { organizationId: org.organizationId, versionNo: 1 } })
    // 500 more sendings in the window (documents the backtest cannot read again are left out of its rows)
    await prisma.approvalRoute.createMany({
      data: Array.from({ length: 500 }, (_, i) => ({ organizationId: org.organizationId, subjectType: 'BUDGET_TRANSFER' as const, subjectId: randomUUID(), routeNo: 1, doaVersionId: v1.id, ruleCode: 'PR-01', amountBasis: 'GROSS' as const, explanationTh: `เอกสารทดสอบ ${i}`, createdAt: new Date(NOW.getTime() - i * 60_000) })),
    })
    const view = ok(await backtestDraft(org.ctxOf('admin', LATER), { kind: 'DOA_VERSION', versionId: draftId }, key()))
    if (view.status !== 'PENDING') throw new Error(view.status)
    expect(view.documentCount).toBe(502)
    expect(await prisma.event.count({ where: { type: 'backtest.requested', aggregateId: view.runId } })).toBe(1)
    expect(await getBacktestRun(org.ctxOf('admin', LATER), view.runId)).toMatchObject({ status: 'PENDING' })

    expect(await completeBacktestRun(org.organizationId, view.runId, LATER)).toEqual({ status: 'DONE' })
    expect(await completeBacktestRun(org.organizationId, view.runId, LATER)).toEqual({ status: 'DONE' })
    const done = await getBacktestRun(org.ctxOf('admin', LATER), view.runId)
    if (done?.status !== 'DONE') throw new Error(String(done?.status))
    expect(done.result.summary).toMatchObject({ total: 2, changed: 1 })
    expect(await prisma.event.count({ where: { type: 'backtest.completed', aggregateId: view.runId } })).toBe(1)
    expect(await getBacktestRun(org.ctxOf('req_con', LATER), view.runId)).toBeNull()
  })
})
