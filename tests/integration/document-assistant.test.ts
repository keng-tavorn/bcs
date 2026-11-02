import { randomUUID } from 'node:crypto'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { setAiClientForTests, type AiClient } from '@/integrations/ai'
import { PROMPT_VERSIONS } from '@/lib/ai-config'
import { prisma } from '@/server/db/client'
import { approvalBriefOf, askInsight, giveAgentFeedback, runBrief, runMonthlyGrant, runTool, setAiRuntimeForTests, updateAgentSetting, type AiRuntime } from '@/server/services/ai'
import { apOrg, codedDraft, receive, sentPo, submit, type ApOrg } from '../support/ap'
import { createDraft, submitRequest } from '../support/requests'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { p2p } from '../support/p2p'

// NEW-122 (ADR-079 · FR-INT-012 AC8): the AI's parts of the panel "จากผู้ช่วย". The one who decides a task says whether
// its Approval Brief helped, in an Event of their own; nobody else may. "ถามเรื่องนี้" and "สรุปให้" send the document's
// number to the Insight Agent, whose read-only tools find the request, the PO or the invoice by it under the asker's
// rights — someone who may not see it is told nothing was found — and every figure of the answer comes from a tool
// (BR-AI-27). The model's answers are handed in by the test.

const NOW = new Date('2026-10-05T03:00:00Z')
const FIXTURE: AiRuntime = { enabled: true, mode: 'fixture', appEnv: 'local', modelEnv: {}, gates: [] }
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const data = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}
const codeOf = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? null : r.error!.code)

let org: DoaOrg

beforeAll(async () => {
  org = await createDoaOrg()
  await prisma.orgModule.create({ data: { organizationId: org.organizationId, module: 'AI', enabled: true, enabledAt: new Date('2026-01-01T00:00:00+07:00'), contractRef: 'TEST-NEW-122', reason: 'ทดสอบแผงจากผู้ช่วย' } })
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
  setAiRuntimeForTests(FIXTURE)
  for (const agent of ['APPROVAL_BRIEF', 'INSIGHT'] as const) expect((await updateAgentSetting(org.ctxOf('admin', NOW), { agent, enabled: true }, key())).ok).toBe(true)
  expect((await runMonthlyGrant(org.organizationId, NOW)).ok).toBe(true)
})

afterEach(() => {
  setAiRuntimeForTests(FIXTURE)
  setAiClientForTests(null)
})

/** Every call answers with the next of these outputs (a plan, then sentences) */
function answering(...outputs: unknown[]) {
  let n = 0
  const client: AiClient = {
    mode: 'fixture',
    extract: async () => {
      throw new Error('not used')
    },
    write: async (request) => {
      const output = outputs[Math.min(n++, outputs.length - 1)]
      return { ok: true, promptVersion: PROMPT_VERSIONS[request.purpose], model: request.model, output: request.schema.parse(output), usage: { input: 700, output: 90, cacheRead: 0, cacheWrite: 0 }, latencyMs: 300 }
    },
  }
  setAiClientForTests(client)
}

const codeOfMember = (memberId: string) => Object.entries(org.member).find(([, id]) => id === memberId)![0]

/** A request of req_con sent for approval with a funded line: its open task and number */
async function openTask() {
  const budgetLineId = await p2p(org, NOW).fundedLine(1_000_000n)
  const draft = data(await createDraft(org.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', title: 'วัสดุแผงผู้ช่วย', budgetLineId, priceIncludesVat: true, lines: [{ description: 'ปูนซีเมนต์', quantity: '1', uom: 'งาน', unitPrice: '45000.00' }] }, key()))
  data(await submitRequest(org.ctxOf('req_con', NOW), { requestId: draft.requestId }, key()))
  const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: draft.requestId } } } })
  const request = await prisma.request.findUniqueOrThrow({ where: { id: draft.requestId }, select: { number: true } })
  return { task, requestId: draft.requestId, number: request.number!, assignee: codeOfMember(task.assigneeMemberId) }
}

describe('[FR-INT-012/AC8] "ช่วยได้" and "ไม่ช่วย" on the Approval Brief of the panel', () => {
  it('[FR-INT-012/AC8] the one who decides says so in their own Event and reads it back; the requester may not', async () => {
    const { task, assignee } = await openTask()
    answering({ sentences: ['คำขอนี้ยอด {{v:amount}} บาท ตามข้อ {{v:doaRule}}'] })
    expect(await runBrief(org.organizationId, task.id, NOW)).toBe('DRAFT')
    const decider = org.ctxOf(assignee, NOW)
    const read = data(await approvalBriefOf(decider, task.id))
    expect(read.sentences).not.toBeNull()
    expect(read).toMatchObject({ feedback: null })
    const agentActionId = read.agentActionId!
    expect(agentActionId).toBeTruthy()

    // The requester does not read this Brief: refused, nothing written
    expect(codeOf(await giveAgentFeedback(org.ctxOf('req_con', NOW), { agentActionId, feedback: 'NOT_HELPFUL' }, key()))).toBe('FORBIDDEN')
    expect(await prisma.event.count({ where: { aggregateId: agentActionId, type: 'agent_action.feedback_given' } })).toBe(0)

    expect((await giveAgentFeedback(decider, { agentActionId, feedback: 'HELPFUL' }, key())).ok).toBe(true)
    const event = await prisma.event.findFirstOrThrow({ where: { aggregateId: agentActionId, type: 'agent_action.feedback_given' } })
    expect(event).toMatchObject({ actorType: 'USER', actorMemberId: task.assigneeMemberId, data: { feedback: 'HELPFUL' } })
    expect(data(await approvalBriefOf(decider, task.id)).feedback).toBe('HELPFUL')

    // A second press changes it: the latest of their own Events, and the row keeps the latest
    expect((await giveAgentFeedback(decider, { agentActionId, feedback: 'NOT_HELPFUL' }, key())).ok).toBe(true)
    expect(data(await approvalBriefOf(decider, task.id)).feedback).toBe('NOT_HELPFUL')
    expect(await prisma.agentAction.findUniqueOrThrow({ where: { id: agentActionId } })).toMatchObject({ status: 'DRAFT', feedback: 'NOT_HELPFUL' })
    // Feedback decides nothing: the task is still open
    expect((await prisma.approvalTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('OPEN')
  })

  it('[FR-INT-012/AC7] with the AI module or the Brief agent off, a Brief written before is not shown either', async () => {
    const { task, assignee } = await openTask()
    answering({ sentences: ['คำขอนี้ยอด {{v:amount}} บาท'] })
    expect(await runBrief(org.organizationId, task.id, NOW)).toBe('DRAFT')
    const decider = org.ctxOf(assignee, NOW)
    expect(data(await approvalBriefOf(decider, task.id)).status).toBe('READY')
    await prisma.orgModule.updateMany({ where: { organizationId: org.organizationId, module: 'AI' }, data: { enabled: false } })
    try {
      expect(data(await approvalBriefOf(decider, task.id))).toMatchObject({ status: 'NONE', sentences: null, agentActionId: null })
    } finally {
      await prisma.orgModule.updateMany({ where: { organizationId: org.organizationId, module: 'AI' }, data: { enabled: true } })
    }
    expect((await updateAgentSetting(org.ctxOf('admin', NOW), { agent: 'APPROVAL_BRIEF', enabled: false }, key())).ok).toBe(true)
    try {
      expect(data(await approvalBriefOf(decider, task.id)).status).toBe('NONE')
    } finally {
      expect((await updateAgentSetting(org.ctxOf('admin', NOW), { agent: 'APPROVAL_BRIEF', enabled: true }, key())).ok).toBe(true)
    }
    expect(data(await approvalBriefOf(decider, task.id)).status).toBe('READY')
  })

  it('[FR-INT-012/AC8] no Brief to say anything of while it is written or when its text failed the checks', async () => {
    const { task, assignee } = await openTask()
    // A sentence with a figure of its own fails BR-AI-27: the reader gets the facts alone and no buttons
    answering({ sentences: ['คำขอนี้ยอด 45,000.00 บาท'] })
    expect(await runBrief(org.organizationId, task.id, NOW)).toBe('FAILED')
    expect(data(await approvalBriefOf(org.ctxOf(assignee, NOW), task.id))).toMatchObject({ status: 'FAILED', sentences: null, agentActionId: null, feedback: null })
  })
})

describe('[FR-INT-012/AC8] "ถามเรื่องนี้" and "สรุปให้": the document by its number, under the asker’s rights', () => {
  it('[FR-INT-012/AC8] a request: every figure of the answer from the tool, the link of its row; someone who may not see it is told nothing was found', async () => {
    const { requestId, number } = await openTask()
    answering({ tools: ['get_request'], sentences: [] }, { sentences: ['คำขอ {{v:t1.0.number}} ยอดรวม {{v:t1.0.gross}} บาท สถานะ {{v:t1.0.status}}'] })
    const r = data(await askInsight(org.ctxOf('req_con', NOW), { question: `สรุปคำขอ ${number}` }, key()))
    expect(r.kind).toBe('ANSWER')
    expect(r.sentences[0]).toContain(number)
    expect(r.sentences[0]).toMatch(/ยอดรวม 45,000\.00 บาท/)
    expect(r.tables[0]!.rows[0]!.href).toBe(`/requests/${requestId}`)

    answering({ tools: ['get_request'], sentences: [] }, { sentences: ['คำขอ {{v:t1.0.number}}'] })
    const outside = data(await askInsight(org.ctxOf('dm_it', NOW), { question: `สรุปคำขอ ${number}` }, key()))
    expect(outside).toMatchObject({ kind: 'NOT_FOUND', sentences: [], tables: [] })

    // A sentence that types a figure itself is stopped before sending (BR-AI-27): the rows instead
    answering({ tools: ['get_request'], sentences: [] }, { sentences: ['คำขอนี้ยอด 45,000.00 บาท'] })
    const typed = data(await askInsight(org.ctxOf('req_con', NOW), { question: `สรุปคำขอ ${number}` }, key()))
    expect(typed).toMatchObject({ kind: 'TABLE', sentences: [] })
    expect(typed.tables[0]!.rows[0]!.href).toBe(`/requests/${requestId}`)
  })

  it('[FR-INT-012/AC8] a PO: search_documents finds it by the number in the question for whoever may view it, nobody else', async () => {
    const flow = p2p(org, NOW)
    const request = await flow.approvedRequest(await flow.fundedLine(1_000_000n), [{ quantity: '2', unitPrice: '500.00' }])
    const supplier = await prisma.supplier.create({ data: { organizationId: org.organizationId, code: `SUPDA${randomUUID().slice(0, 4)}`, nameTh: 'ผู้ขายแผงผู้ช่วย', taxId: '0999999000012' } })
    const po = await flow.approvedPo(request.lines.map((l) => l.id), supplier.id)
    const number = (await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id }, select: { number: true } })).number!
    const mine = await runTool(org.ctxOf('req_con', NOW), 'search_documents', `สรุปใบสั่งซื้อ ${number}`)
    expect(mine.rows.map((r) => r.href)).toContain(`/procurement/pos/${po.id}`)
    const outside = await runTool(org.ctxOf('dm_it', NOW), 'search_documents', `สรุปใบสั่งซื้อ ${number}`)
    expect(outside.rows.map((r) => r.href)).not.toContain(`/procurement/pos/${po.id}`)
  })
})

describe('[FR-INT-012/AC8] an invoice by its number', () => {
  let ap: ApOrg
  let invoiceId: string
  let number: string

  beforeAll(async () => {
    ap = await apOrg({ modules: ['PAY', 'AI'] })
    const po = await sentPo(ap, [{ quantity: '10', unitPrice: '100.00' }])
    await receive(ap, po, { 0: '10' })
    const draft = await codedDraft(ap, po, { no: `INV-DA-${randomUUID().slice(0, 6)}`, vat: '70.00', lines: [{ line: 0, quantity: '10', unitPrice: '100.00' }] })
    expect((await submit(ap, draft)).ok).toBe(true)
    invoiceId = draft.invoiceId
    number = (await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { number: true } })).number!
  })

  it('[FR-INT-012/AC8] FINANCE gets the invoice with its gross from code; a member who does not read invoices gets nothing; PAY off, nobody', async () => {
    const at = new Date('2026-10-12T03:00:00Z')
    const finance = await runTool(ap.org.ctxOf('fin_officer', at), 'search_documents', `สรุปใบแจ้งหนี้ ${number}`)
    const row = finance.rows.find((r) => r.href === `/finance/invoices/${invoiceId}`)
    expect(row?.values).toMatchObject({ number: { kind: 'ref', value: number }, gross: { kind: 'money', value: '1070.00' } })

    const outside = await runTool(ap.org.ctxOf('dm_con', at), 'search_documents', `สรุปใบแจ้งหนี้ ${number}`)
    expect(outside.rows.map((r) => r.href)).not.toContain(`/finance/invoices/${invoiceId}`)

    await prisma.orgModule.updateMany({ where: { organizationId: ap.org.organizationId, module: 'PAY' }, data: { enabled: false } })
    try {
      const off = await runTool(ap.org.ctxOf('fin_officer', at), 'search_documents', `สรุปใบแจ้งหนี้ ${number}`)
      expect(off.rows.map((r) => r.href)).not.toContain(`/finance/invoices/${invoiceId}`)
    } finally {
      await prisma.orgModule.updateMany({ where: { organizationId: ap.org.organizationId, module: 'PAY' }, data: { enabled: true } })
    }
  })
})
