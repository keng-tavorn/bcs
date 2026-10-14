import { randomUUID } from 'node:crypto'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { setAiClientForTests, type AiClient } from '@/integrations/ai'
import { PROMPT_VERSIONS } from '@/lib/ai-config'
import { prisma } from '@/server/db/client'
import { aiApprovalBriefRun } from '@/server/jobs/ai-approval-brief'
import { approvalBriefOf, briefFacts, runBrief, runMonthlyGrant, setAiRuntimeForTests, updateAgentSetting, type AiRuntime } from '@/server/services/ai'
import { createDraft, submitRequest } from '../support/requests'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { p2p } from '../support/p2p'

// S13-09 (FR-AI-301 AC1–AC6, BR-AI-20, BR-AI-27): the Approval Brief of a task on an approval step. Facts are built by
// code for whoever reads, under their rights; the AI writes placeholders only, once per task; a reader sees its
// sentences only when their facts hold every key the AI was given. The model's answers are handed in by the test.

const NOW = new Date('2026-10-05T03:00:00Z')
const FIXTURE: AiRuntime = { enabled: true, mode: 'fixture', appEnv: 'local', modelEnv: {}, gates: [] }
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const step = { run: <T>(_id: string, fn: () => Promise<T>) => fn() }

let org: DoaOrg
let calls = 0

beforeAll(async () => {
  org = await createDoaOrg()
  await prisma.orgModule.create({ data: { organizationId: org.organizationId, module: 'AI', enabled: true, enabledAt: new Date('2026-01-01T00:00:00+07:00'), contractRef: 'TEST-S13', reason: 'ทดสอบ Brief' } })
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
  setAiRuntimeForTests(FIXTURE)
  expect((await updateAgentSetting(org.ctxOf('admin', NOW), { agent: 'APPROVAL_BRIEF', enabled: true }, key())).ok).toBe(true)
  expect((await runMonthlyGrant(org.organizationId, NOW)).ok).toBe(true)
})

afterEach(() => {
  setAiRuntimeForTests(FIXTURE)
  setAiClientForTests(null)
})

function writing(sentences: string[]) {
  const client: AiClient = {
    mode: 'fixture',
    extract: async () => {
      throw new Error('not used')
    },
    write: async (request) => {
      calls++
      return { ok: true, promptVersion: PROMPT_VERSIONS[request.purpose], model: request.model, output: request.schema.parse({ sentences }), usage: { input: 900, output: 120, cacheRead: 0, cacheWrite: 0 }, latencyMs: 400 }
    },
  }
  setAiClientForTests(client)
}

const codeOf = (memberId: string) => Object.entries(org.member).find(([, id]) => id === memberId)![0]

/** A request sent for approval with a funded line: its open task */
async function openTask(total = '45000.00') {
  const flow = p2p(org, NOW)
  const budgetLineId = await flow.fundedLine(1_000_000n)
  const draft = await createDraft(org.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', title: 'วัสดุ', budgetLineId, priceIncludesVat: true, lines: [{ description: 'ปูนซีเมนต์', quantity: '1', uom: 'งาน', unitPrice: total }] }, key())
  if (!draft.ok) throw new Error(JSON.stringify(draft.error))
  const sent = await submitRequest(org.ctxOf('req_con', NOW), { requestId: draft.data.requestId }, key())
  if (!sent.ok) throw new Error(JSON.stringify(sent.error))
  const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: draft.data.requestId } } } })
  return { task, requestId: draft.data.requestId, assignee: codeOf(task.assigneeMemberId) }
}

const briefOf = (taskId: string) => prisma.agentAction.findFirst({ where: { purpose: 'BRIEF', subjectType: 'APPROVAL_TASK', subjectId: taskId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })

describe('[FR-AI-301/AC1] [FR-AI-301/AC2] [FR-AI-301/AC3] the Brief is written once from facts, with placeholders only', () => {
  it('[FR-AI-301/AC1] the job writes the Brief for the assignee; the decider reads it with their own values, never a button', async () => {
    const { task, assignee } = await openTask()
    writing(['คำขอนี้ยอด {{v:amount}} บาท ตามข้อ {{v:doaRule}}', 'ยังไม่มีราคาอ้างอิงของรายการนี้'])
    const assigned = await prisma.event.findFirstOrThrow({ where: { aggregateId: task.id, type: 'approval_task.assigned' } })
    expect(await aiApprovalBriefRun({ data: { organizationId: org.organizationId, aggregateId: task.id, data: assigned.data } }, step)).toBe('DRAFT')
    // A second run of the same task writes nothing more
    const before = calls
    expect(await runBrief(org.organizationId, task.id, NOW)).toBe('SKIPPED')
    expect(calls).toBe(before)
    const action = await briefOf(task.id)
    expect(action).toMatchObject({ status: 'DRAFT', agent: 'APPROVAL_BRIEF', level: 'L0', requestedById: null })
    expect((action!.output as { factKeys: string[] }).factKeys).toEqual(expect.arrayContaining(['amount', 'doaRule', 'priceReference']))

    const brief = await approvalBriefOf(org.ctxOf(assignee, NOW), task.id)
    if (!brief.ok) throw new Error(JSON.stringify(brief.error))
    expect(brief.data.status).toBe('READY')
    expect(brief.data.sentences).toEqual(['คำขอนี้ยอด 45,000.00 บาท ตามข้อ ' + brief.data.facts.find((f) => f.key === 'doaRule')!.text, 'ยังไม่มีราคาอ้างอิงของรายการนี้'])
    // [FR-AI-301/AC6] no reference price service yet: the fact says so, never a guess
    expect(brief.data.facts).toEqual(expect.arrayContaining([{ key: 'priceReference', text: 'NONE' }, { key: 'amount', text: '45,000.00' }]))
    // [FR-AI-301/AC3] the Brief decides nothing: the task is still open, and nobody else reads it
    expect((await prisma.approvalTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('OPEN')
    expect(await approvalBriefOf(org.ctxOf('req_con', NOW), task.id)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })

  it('[FR-AI-301/AC2] a sentence with a digit of its own is thrown away whole: facts only', async () => {
    const { task, assignee } = await openTask()
    writing(['คำขอนี้ยอด 45,000 บาท'])
    expect(await runBrief(org.organizationId, task.id, NOW)).toBe('FAILED')
    expect(await briefOf(task.id)).toMatchObject({ status: 'FAILED', errorCode: 'AI_TEXT_DIGIT_OUTSIDE_PLACEHOLDER' })
    expect(await approvalBriefOf(org.ctxOf(assignee, NOW), task.id)).toMatchObject({ ok: true, data: { status: 'FAILED', sentences: null } })
    writing(['ราคาเหมาะสม ควรอนุมัติ'])
    const other = await openTask()
    expect(await runBrief(org.organizationId, other.task.id, NOW)).toBe('FAILED')
    expect(await briefOf(other.task.id)).toMatchObject({ errorCode: 'AI_TEXT_DECISION_ADVICE' })
  })
})

describe('[FR-AI-301/AC5] facts under the reader’s rights; the sentences only when every fact the AI was given is theirs', () => {
  it('[FR-AI-301/AC5] a member acting for the assignee without budget.view sees no balance, and so no sentences, even when they do not name it', async () => {
    const { task, assignee } = await openTask()
    writing(['คำขอนี้อยู่ในวงเงินของข้อ {{v:doaRule}}'])
    expect(await runBrief(org.organizationId, task.id, NOW)).toBe('DRAFT')
    const assigneeView = await approvalBriefOf(org.ctxOf(assignee, NOW), task.id)
    if (!assigneeView.ok) throw new Error('assignee')
    const hasBudget = assigneeView.data.facts.some((f) => f.key === 'budgetRemaining')
    // The task held for the assignee by a plain member (a delegate: BR-DLG-04)
    await prisma.approvalTask.update({ where: { id: task.id }, data: { principalMemberId: org.member.receiver_con! } })
    const acting = await approvalBriefOf(org.ctxOf('receiver_con', NOW), task.id)
    if (!acting.ok) throw new Error(JSON.stringify(acting.error))
    expect(acting.data.facts.map((f) => f.key)).not.toContain('budgetRemaining')
    expect(acting.data).toMatchObject({ status: 'READY', sentences: hasBudget ? null : ['คำขอนี้อยู่ในวงเงินของข้อ ' + acting.data.facts.find((f) => f.key === 'doaRule')!.text] })
    expect(hasBudget).toBe(true)
  })

  it('[FR-AI-301/AC5] the supplier’s POs count only those the reader may view (po.view)', async () => {
    const flow = p2p(org, NOW)
    const supplier = await prisma.supplier.create({ data: { organizationId: org.organizationId, code: `S-${randomUUID().slice(0, 6)}`, nameTh: 'ผู้ขายประวัติ', taxId: '0999999000012' } })
    const request = await flow.approvedRequest(await flow.fundedLine(1_000_000n), [{ quantity: '2', unitPrice: '500.00' }])
    const po = await flow.approvedPo(request.lines.map((l) => l.id), supplier.id)
    await prisma.purchaseOrder.update({ where: { id: po.id }, data: { status: 'SENT', sentAt: NOW } })
    const { task } = await openTask()
    await prisma.request.update({ where: { id: (await prisma.approvalRoute.findFirstOrThrow({ where: { steps: { some: { tasks: { some: { id: task.id } } } } } })).subjectId }, data: { suggestedSupplierId: supplier.id } })
    const loaded = { id: task.id, status: 'OPEN', assigneeMemberId: task.assigneeMemberId, principalMemberId: null, dueAt: task.dueAt, route: await prisma.approvalRoute.findFirstOrThrow({ where: { steps: { some: { tasks: { some: { id: task.id } } } } }, select: { subjectType: true, subjectId: true, amountBasis: true, amountSatang: true, ruleCode: true } }) }
    const procurement = await briefFacts(org.ctxOf('proc_officer', NOW), loaded)
    expect(procurement.supplierPoCount).toEqual({ kind: 'integer', value: 1 })
    const plain = await briefFacts(org.ctxOf('receiver_con', NOW), loaded)
    expect(plain).not.toHaveProperty('supplierPoCount')
    expect(plain).not.toHaveProperty('supplierLastPoAmount')
  })

  it('[FR-AI-301/AC5] a reassigned task expires the Brief it replaced and gets its own', async () => {
    const { task } = await openTask()
    writing(['คำขอนี้ตามข้อ {{v:doaRule}}'])
    expect(await runBrief(org.organizationId, task.id, NOW)).toBe('DRAFT')
    const first = await briefOf(task.id)
    expect(await runBrief(org.organizationId, task.id, NOW, task.id)).toBe('DRAFT')
    expect(await prisma.agentAction.findUniqueOrThrow({ where: { id: first!.id } })).toMatchObject({ status: 'EXPIRED', expireReason: 'SUPERSEDED' })
    const second = await briefOf(task.id)
    expect(second).toMatchObject({ status: 'DRAFT' })
    expect(second!.id).not.toBe(first!.id)
  })
})

describe('[FR-AI-301/AC1] [FR-AI-301/AC4] no Brief, no credits, nothing on LINE where it does not belong', () => {
  it('[FR-AI-301/AC1] with the Brief agent off no action is written and nothing is charged', async () => {
    const { task } = await openTask()
    expect((await updateAgentSetting(org.ctxOf('admin', NOW), { agent: 'APPROVAL_BRIEF', enabled: false }, key())).ok).toBe(true)
    try {
      const uses = await prisma.aiCreditLedger.count({ where: { organizationId: org.organizationId, kind: 'USE' } })
      expect(await runBrief(org.organizationId, task.id, NOW)).toBe('SKIPPED')
      expect(await briefOf(task.id)).toBeNull()
      expect(await prisma.aiCreditLedger.count({ where: { organizationId: org.organizationId, kind: 'USE' } })).toBe(uses)
    } finally {
      expect((await updateAgentSetting(org.ctxOf('admin', NOW), { agent: 'APPROVAL_BRIEF', enabled: true }, key())).ok).toBe(true)
    }
  })

  it('[FR-AI-301/AC4] the notifications of the task carry no sentence of the AI', async () => {
    const { task } = await openTask()
    writing(['สรุปพิเศษสำหรับทดสอบ {{v:doaRule}}'])
    expect(await runBrief(org.organizationId, task.id, NOW)).toBe('DRAFT')
    const notes = await prisma.notification.findMany({ where: { organizationId: org.organizationId, recipientMemberId: task.assigneeMemberId } })
    expect(notes.length).toBeGreaterThan(0)
    expect(JSON.stringify(notes)).not.toContain('สรุปพิเศษสำหรับทดสอบ')
  })
})
