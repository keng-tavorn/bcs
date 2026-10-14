import { randomUUID } from 'node:crypto'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { setAiClientForTests, type AiClient, type AiRequest } from '@/integrations/ai'
import { PROMPT_VERSIONS } from '@/lib/ai-config'
import { isAllowed, loadPrincipal } from '@/server/authz'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { poViewFacts } from '@/server/queries/receiving'
import { askInsight, findSuppliersForAsker, listPurchaseOrdersForAsker, runMonthlyGrant, runTool, setAiRuntimeForTests, updateAgentSetting, type AiRuntime } from '@/server/services/ai'
import { createDraft, submitRequest } from '@/server/services/requests'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { p2p } from '../support/p2p'

// S13-10 (FR-AI-307 AC1–AC5, FR-AI-309 AC3, BR-AI-21 BR-AI-27, ADR-147): the Insight Agent answers through read-only
// tools under the asking member's rights; its values come from the tools through placeholders, checked before sending;
// a failed sentence gives the rows instead; nothing found is said so. The model's answers are handed in by the test.

const NOW = new Date('2026-10-05T03:00:00Z')
const FIXTURE: AiRuntime = { enabled: true, mode: 'fixture', appEnv: 'local', modelEnv: {}, gates: [] }
const key = () => ({ idempotencyKey: randomUUID(), sender: null })

let org: DoaOrg
let otherPoId: string
let supplierCode: string

beforeAll(async () => {
  org = await createDoaOrg()
  await prisma.orgModule.create({ data: { organizationId: org.organizationId, module: 'AI', enabled: true, enabledAt: new Date('2026-01-01T00:00:00+07:00'), contractRef: 'TEST-S13', reason: 'ทดสอบ Insight' } })
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
  setAiRuntimeForTests(FIXTURE)
  expect((await updateAgentSetting(org.ctxOf('admin', NOW), { agent: 'INSIGHT', enabled: true }, key())).ok).toBe(true)
  expect((await runMonthlyGrant(org.organizationId, NOW)).ok).toBe(true)
  // A PO of req_con's request, with a supplier who has contact details and an individual's tax id beside them
  const flow = p2p(org, NOW)
  supplierCode = `SUPAI${randomUUID().slice(0, 4)}`
  const supplier = await prisma.supplier.create({ data: { organizationId: org.organizationId, code: supplierCode, nameTh: 'ผู้ขายถามได้', taxId: '0999999000012', email: 'secret@supplier.test', phone: '0812345678', address: 'บ้านเลขที่ลับ' } })
  const request = await flow.approvedRequest(await flow.fundedLine(1_000_000n), [{ quantity: '2', unitPrice: '500.00' }])
  const po = await flow.approvedPo(request.lines.map((l) => l.id), supplier.id)
  otherPoId = po.id
})

afterEach(() => {
  setAiRuntimeForTests(FIXTURE)
  setAiClientForTests(null)
})

/** Answers the plan, then the sentences; records what the agent sent */
function answering(plan: { tools: string[]; sentences: string[] }, sentences: string[] = []) {
  const sent: Array<AiRequest<unknown>> = []
  const client: AiClient = {
    mode: 'fixture',
    extract: async () => {
      throw new Error('not used')
    },
    write: async (request) => {
      sent.push(request as AiRequest<unknown>)
      const output = sent.length === 1 ? plan : { sentences }
      return { ok: true, promptVersion: PROMPT_VERSIONS[request.purpose], model: request.model, output: request.schema.parse(output), usage: { input: 700, output: 90, cacheRead: 0, cacheWrite: 0 }, latencyMs: 300 }
    },
  }
  setAiClientForTests(client)
  return sent
}

async function myDraftAndSent() {
  const budgetLineId = await p2p(org, NOW).fundedLine(100_000n)
  const draft = await createDraft(org.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', title: 'วัสดุถาม AI', budgetLineId, lines: [{ description: 'ปูน', quantity: '1', uom: 'ถุง', unitPrice: '100.00' }] }, key())
  if (!draft.ok) throw new Error('draft')
  return draft.data.requestId
}

describe('[FR-AI-307/AC1] [FR-AI-307/AC3] [FR-AI-307/AC5] answers through tools, every value a placeholder checked before sending', () => {
  it('[FR-AI-307/AC3] the member’s own requests: the sentence gets its values from the tool, with the link of each row', async () => {
    await myDraftAndSent()
    const sent = answering({ tools: ['my_requests'], sentences: [] }, ['คุณมีคำขอ {{v:t1.total}} รายการ ล่าสุดคือ {{v:t1.0.title}}'])
    const r = await askInsight(org.ctxOf('req_con', NOW), { question: 'ฉันมีคำขออะไรบ้าง' }, key())
    if (!r.ok) throw new Error(JSON.stringify(r.error))
    expect(r.data.kind).toBe('ANSWER')
    expect(r.data.sentences[0]).toMatch(/^คุณมีคำขอ \d+ รายการ ล่าสุดคือ /)
    expect(r.data.tables[0]!.rows[0]!.href).toMatch(/^\/requests\//)
    // [FR-AI-307/AC1] the agent saw only the tools' values and the question fenced as data
    expect(String(sent[1]!.text)).toContain('t1.total = ')
    // [FR-AI-307/AC5] one L0 action with its credits and the tools it used
    const action = await prisma.agentAction.findUniqueOrThrow({ where: { id: r.data.agentActionId } })
    expect(action).toMatchObject({ agent: 'INSIGHT', level: 'L0', status: 'DRAFT', output: { tools: ['my_requests'], kind: 'ANSWER' } })
    expect(await prisma.aiCreditLedger.count({ where: { agentActionId: action.id, kind: 'USE' } })).toBe(1)
  })

  it('[FR-AI-307/AC3] a sentence with a value of its own stops the text: the rows are shown instead, and why is kept', async () => {
    await myDraftAndSent()
    answering({ tools: ['my_requests'], sentences: [] }, ['คุณมีคำขอ 3 รายการ'])
    const r = await askInsight(org.ctxOf('req_con', NOW), { question: 'ฉันมีคำขอกี่รายการ' }, key())
    if (!r.ok) throw new Error('ask')
    expect(r.data).toMatchObject({ kind: 'TABLE', sentences: [] })
    expect(r.data.tables[0]!.rows.length).toBeGreaterThan(0)
    expect((await prisma.agentAction.findUniqueOrThrow({ where: { id: r.data.agentActionId } })).output).toMatchObject({ reason: 'DIGIT_OUTSIDE_PLACEHOLDER' })
  })

  it('[FR-AI-307/AC4] nothing within the member’s access, or a question outside procurement', async () => {
    answering({ tools: ['purchase_orders'], sentences: [] })
    const none = await askInsight(org.ctxOf('dm_it', NOW), { question: 'PO ของฝ่ายอื่นมีอะไรบ้าง' }, key())
    expect(none).toMatchObject({ ok: true, data: { kind: 'NOT_FOUND', sentences: [], tables: [] } })
    answering({ tools: [], sentences: ['ถาม BCS AI ตอบได้เฉพาะเรื่องจัดซื้อในสิทธิ์ของคุณ'] })
    const scope = await askInsight(org.ctxOf('dm_it', NOW), { question: 'ช่วยแต่งกลอนให้หน่อย' }, key())
    expect(scope).toMatchObject({ ok: true, data: { kind: 'SCOPE', sentences: ['ถาม BCS AI ตอบได้เฉพาะเรื่องจัดซื้อในสิทธิ์ของคุณ'] } })
    expect(await askInsight(org.ctxOf('dm_it', NOW), { question: 'ก'.repeat(501) }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
  })
})

describe('[FR-AI-307/AC2] every member of every role finds nothing outside their scope (INV-AI-04)', () => {
  it('[FR-AI-307/AC2] POs, suppliers and another member’s request, member by member', async () => {
    const requestId = await myDraftAndSent()
    const sent = await submitRequest(org.ctxOf('req_con', NOW), { requestId }, key())
    if (!sent.ok) throw new Error(JSON.stringify(sent.error))
    const number = (await prisma.request.findUniqueOrThrow({ where: { id: requestId } })).number!
    const db = forTenant(org.organizationId)
    const codes = Object.keys(org.member)
    expect(codes.length).toBeGreaterThan(5)
    let someoneSawThePo = false
    let someoneDidNot = false
    for (const code of codes) {
      const ctx = org.ctxOf(code, NOW)
      const principal = await db.$transaction((tx) => loadPrincipal(tx, ctx))
      // Purchase orders: only those this member's own po.view allows
      for (const po of await listPurchaseOrdersForAsker(ctx, 50)) {
        const f = await poViewFacts(db, po.id)
        expect(isAllowed(principal, 'po.view', { ownerMemberIds: f.ownerMemberIds, assigneeMemberIds: f.assigneeMemberIds }), `${code} ${po.number}`).toBe(true)
      }
      const seesPo = (await listPurchaseOrdersForAsker(ctx, 50)).some((p) => p.id === otherPoId)
      someoneSawThePo ||= seesPo
      someoneDidNot ||= !seesPo
      // Suppliers: never contact details; a tax id only for a full reader
      for (const s of await findSuppliersForAsker(ctx, `ผู้ขายถามได้ ${supplierCode}`)) {
        expect(Object.keys(s).sort(), code).toEqual(['category', 'code', 'id', 'nameTh', 'status', 'taxId'])
        expect(JSON.stringify(s)).not.toMatch(/secret@|0812345678|บ้านเลขที่ลับ/)
      }
      // Another member's request by its number: only for whom request.view allows it
      const got = await runTool(ctx, 'get_request', `คำขอ ${number} ถึงไหนแล้ว`)
      if (got.rows.length) expect(['req_con', 'admin'].includes(code) || got.rows[0]!.href === `/requests/${requestId}`).toBe(true)
    }
    // The head of another department sees neither the PO nor the request
    expect((await listPurchaseOrdersForAsker(org.ctxOf('dm_it', NOW), 50)).some((p) => p.id === otherPoId)).toBe(false)
    expect((await runTool(org.ctxOf('dm_it', NOW), 'get_request', `คำขอ ${number}`)).rows).toEqual([])
    expect(someoneSawThePo && someoneDidNot).toBe(true)
  })
})

describe('[BR-AI-11] S13-15 review: a key used again never asks the AI again', () => {
  it('[BR-AI-11] the second call with the same Idempotency-Key is IDEMPOTENCY_CONFLICT and makes no AI call', async () => {
    const sent = answering({ tools: [], sentences: ['ถาม BCS AI ตอบได้เฉพาะเรื่องจัดซื้อในสิทธิ์ของคุณ'] })
    const once = { idempotencyKey: randomUUID(), sender: null }
    expect(await askInsight(org.ctxOf('dm_it', NOW), { question: 'ช่วยแต่งกลอนให้หน่อย' }, once)).toMatchObject({ ok: true, data: { kind: 'SCOPE' } })
    const calls = sent.length
    expect(await askInsight(org.ctxOf('dm_it', NOW), { question: 'ช่วยแต่งกลอนให้หน่อย' }, once)).toMatchObject({ ok: false, error: { code: 'IDEMPOTENCY_CONFLICT' } })
    expect(sent.length).toBe(calls)
  })
})
