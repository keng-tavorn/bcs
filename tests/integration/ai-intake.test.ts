import { randomUUID } from 'node:crypto'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { setAiClientForTests, type AiClient, type AiRequest } from '@/integrations/ai'
import { putObject } from '@/integrations/storage'
import { PROMPT_VERSIONS } from '@/lib/ai-config'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { aiAgentRunRun } from '@/server/jobs/ai-agent-run'
import { intakeFromMessage, isAgentAvailable, runIntake, runMonthlyGrant, setAiRuntimeForTests, startIntake, updateAgentSetting, type AiRuntime } from '@/server/services/ai'
import { createDraft, submitRequest } from '@/server/services/requests'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// S13-08 (FR-AI-302 AC1–AC5, FR-AI-303 AC9, BR-AI-19, docs/sub-specs/S13.md "interface"): the Intake Agent turns what a
// requester wrote (and a file they attached) into values of their own request, proposed by path and confirmed before the
// request can be sent; the chat path of S17 runs in its caller's job, keeps no text and answers a repeated key with the
// same action. The model's answers are handed in by the test; the client records what it was sent.

const NOW = new Date('2026-10-05T03:00:00Z')
const FIXTURE: AiRuntime = { enabled: true, mode: 'fixture', appEnv: 'local', modelEnv: {}, gates: [] }
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const step = { run: <T>(_id: string, fn: () => Promise<T>) => fn() }

let org: DoaOrg
const sent: Array<AiRequest<unknown>> = []
let next: unknown = null

beforeAll(async () => {
  org = await createDoaOrg()
  await prisma.orgModule.create({ data: { organizationId: org.organizationId, module: 'AI', enabled: true, enabledAt: new Date('2026-01-01T00:00:00+07:00'), contractRef: 'TEST-S13', reason: 'ทดสอบ Intake' } })
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
  setAiRuntimeForTests(FIXTURE)
  expect((await updateAgentSetting(org.ctxOf('admin', NOW), { agent: 'INTAKE', enabled: true }, key())).ok).toBe(true)
  expect((await runMonthlyGrant(org.organizationId, NOW)).ok).toBe(true)
})

afterEach(() => {
  setAiRuntimeForTests(FIXTURE)
  setAiClientForTests(null)
})

function answering(output: unknown) {
  next = output
  const client: AiClient = {
    mode: 'fixture',
    extract: async (request) => {
      sent.push(request as AiRequest<unknown>)
      return { ok: true, promptVersion: PROMPT_VERSIONS[request.purpose], model: request.model, output: request.schema.parse(next), usage: { input: 1800, output: 400, cacheRead: 0, cacheWrite: 0 }, latencyMs: 700 }
    },
    write: async () => {
      throw new Error('not used')
    },
  }
  setAiClientForTests(client)
}

function draftOf(over: Record<string, unknown> = {}) {
  return {
    requestTypeCode: 'BUY_GOODS',
    title: 'ปูนสำหรับไซต์ A',
    siteCode: null,
    neededBy: null,
    lines: [{ description: 'ปูนซีเมนต์ 50 กก.', itemCode: null, qty: '20', unit: 'ถุง', unitPrice: '150' }],
    supplier: { name: null, taxId: null, branch: null },
    confidence: [
      { field: 'title', value: 95 },
      { field: 'lines.0.description', value: 96 },
      { field: 'lines.0.unit', value: 60 },
    ],
    ...over,
  }
}

const action = (id: string) => prisma.agentAction.findUniqueOrThrow({ where: { id } })

describe('[FR-AI-302/AC1] step 0 fills the request; every value is confirmed before it is sent', () => {
  it('[FR-AI-302/AC1] reads in the background and proposes the title, the line and the site; the draft waits for the requester', async () => {
    const site = await prisma.deliverySite.create({ data: { organizationId: org.organizationId, code: `SITE-${randomUUID().slice(0, 6)}`, nameTh: 'ไซต์ทดสอบ AI', address: 'ถนนทดสอบ' } })
    answering(draftOf({ siteCode: site.code }))
    const started = await startIntake(org.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', text: 'ขอปูน 20 ถุง ถุงละ 150 บาท ส่งไซต์ทดสอบ AI' }, key())
    if (!started.ok) throw new Error(JSON.stringify(started.error))
    const { agentActionId } = started.data
    expect(await action(agentActionId)).toMatchObject({ status: 'PENDING', agent: 'INTAKE', inputText: 'ขอปูน 20 ถุง ถุงละ 150 บาท ส่งไซต์ทดสอบ AI' })
    const requested = await prisma.event.findFirstOrThrow({ where: { aggregateId: agentActionId, type: 'agent_action.requested' } })
    expect(await aiAgentRunRun({ data: { organizationId: org.organizationId, aggregateId: agentActionId, data: requested.data } }, step)).toBe('DRAFT')
    // The agent chose only from the organization's types and sites; the requester's words came fenced as data
    expect(String(sent.at(-1)!.text)).toContain('BUY_GOODS')
    expect(String(sent.at(-1)!.text)).toContain(site.code)

    const done = await action(agentActionId)
    expect(done.review).toEqual({
      proposed: { title: 'ปูนสำหรับไซต์ A', 'lines.0.description': 'ปูนซีเมนต์ 50 กก.', 'lines.0.quantity': '20', 'lines.0.uom': 'ถุง', 'lines.0.unitPrice': '150.00', deliverySiteId: site.id },
      // Quantities and money one by one; the unit was read with too little confidence; the site with none given
      requiredPaths: ['deliverySiteId', 'lines.0.quantity', 'lines.0.unitPrice', 'lines.0.uom'],
      confirmedPaths: [],
    })
    // [FR-AI-302/AC3] Never a screening answer, a budget line, an approver or an attachment
    expect(Object.keys(done.review as object as { proposed: object })).not.toContain('budgetLineId')
    expect(done.output).toMatchObject({ suggestedType: null, channel: { channel: 'STANDARD', requiredRules: [] } })

    const draft = await createDraft(
      org.ctxOf('req_con', NOW),
      { requestTypeCode: 'BUY_GOODS', title: 'ปูนสำหรับไซต์ A', deliverySiteId: site.id, lines: [{ description: 'ปูนซีเมนต์ 50 กก.', quantity: '20', uom: 'ถุง', unitPrice: '150.00' }], aiAssist: { agentActionId, confirmedPaths: ['title', 'lines.0.description'] } },
      key(),
    )
    if (!draft.ok) throw new Error(JSON.stringify(draft.error))
    expect(await submitRequest(org.ctxOf('req_con', NOW), { requestId: draft.data.requestId }, key())).toMatchObject({ ok: false, error: { code: 'AI_REVIEW_PENDING', details: { count: 4 } } })
  })

  it('[FR-AI-302/AC2] a better type the requester may create is suggested, never one that is off; nothing written alone is refused', async () => {
    answering(draftOf({ requestTypeCode: 'HIRE_SERVICE' }))
    const hire = await prisma.requestType.findFirst({ where: { organizationId: org.organizationId, code: 'HIRE_SERVICE', active: true } })
    const started = await startIntake(org.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', text: 'จ้างช่างซ่อมหลังคา' }, key())
    if (!started.ok) throw new Error(JSON.stringify(started.error))
    expect(await runIntake(org.organizationId, started.data.agentActionId, NOW)).toBe('DRAFT')
    expect((await action(started.data.agentActionId)).output).toMatchObject({ suggestedType: hire ? 'HIRE_SERVICE' : null })
    answering(draftOf({ requestTypeCode: 'NO_SUCH_TYPE' }))
    const unknown = await startIntake(org.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', text: 'ของบางอย่าง' }, key())
    if (!unknown.ok) throw new Error('start')
    await runIntake(org.organizationId, unknown.data.agentActionId, NOW)
    expect((await action(unknown.data.agentActionId)).output).toMatchObject({ suggestedType: null })
    expect(await startIntake(org.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', text: '  ' }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'EMPTY' } } })
  })

  it('[FR-AI-302/AC4] the supplier of the register by tax id and branch or by its exact name; otherwise its name as text, nothing created', async () => {
    const taxId = '0999999000012'
    const supplier = await prisma.supplier.create({ data: { organizationId: org.organizationId, code: `S-${randomUUID().slice(0, 6)}`, nameTh: 'บริษัท ปูนดีทดสอบ จำกัด', taxId, branchCode: '00000' } })
    for (const [who, expected] of [
      [{ name: null, taxId, branch: '00000' }, supplier.id],
      [{ name: 'บริษัท  ปูนดีทดสอบ จำกัด', taxId: null, branch: null }, supplier.id],
      [{ name: 'ร้านใหม่ไม่อยู่ในทะเบียน', taxId: null, branch: null }, null],
    ] as const) {
      answering(draftOf({ supplier: who }))
      const before = await prisma.supplier.count({ where: { organizationId: org.organizationId } })
      const started = await startIntake(org.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', text: 'ขอปูน' }, key())
      if (!started.ok) throw new Error('start')
      await runIntake(org.organizationId, started.data.agentActionId, NOW)
      const done = await action(started.data.agentActionId)
      expect((done.review as { proposed: Record<string, string> }).proposed.suggestedSupplierId ?? null).toBe(expected)
      if (!expected) expect(done.output).toMatchObject({ supplierText: 'ร้านใหม่ไม่อยู่ในทะเบียน' })
      expect(await prisma.supplier.count({ where: { organizationId: org.organizationId } })).toBe(before)
    }
  })
})

describe('[FR-AI-302/AC5] [FR-AI-303/AC9] the chat path of S17: in the caller’s job, no text kept, one action per key', () => {
  it('[FR-AI-302/AC5] reads at once, keeps no text, creates no request; the same key returns the same action without a call', async () => {
    const photo = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new TextEncoder().encode(`photo-${randomUUID()}`)])
    const storageKey = `test/ai/${randomUUID()}`
    await putObject(storageKey, photo, 'image/jpeg')
    const file = await prisma.fileObject.create({ data: { organizationId: org.organizationId, storageKey, fileName: 'line.jpg', mimeType: 'image/jpeg', sizeBytes: photo.length, status: 'AVAILABLE', uploadedById: org.member.req_con! } })
    answering(draftOf())
    const chat = makeCtx({ organizationId: org.organizationId, actor: { type: 'USER', memberId: org.member.req_con! }, channel: 'LINE_CHAT', now: NOW })
    const requestsBefore = await prisma.request.count({ where: { organizationId: org.organizationId } })
    const chatIntakeId = randomUUID()
    const idempotencyKey = `chat_intake:${chatIntakeId}:1`
    const first = await intakeFromMessage(chat, { chatIntakeId, text: 'ขอปูน 20 ถุง เลขบัญชี 123-4-56789-0', fileIds: [file.id], idempotencyKey }, key())
    if (!first.ok) throw new Error(JSON.stringify(first.error))
    expect(first.data.status).toBe('DRAFT')
    // [FR-AI-303/AC9] the photo was read in the same call, as a file from the web would be
    expect(sent.at(-1)!.files?.map((f) => f.mediaType)).toEqual(['image/jpeg'])
    const row = await action(first.data.agentActionId)
    expect(row).toMatchObject({ agent: 'INTAKE', subjectType: 'CHAT_INTAKE', subjectId: chatIntakeId, channel: 'LINE_CHAT', requestedById: org.member.req_con, inputText: null, idempotencyKey })
    expect(await prisma.request.count({ where: { organizationId: org.organizationId } })).toBe(requestsBefore)
    const uses = await prisma.aiCreditLedger.count({ where: { organizationId: org.organizationId, kind: 'USE' } })
    const calls = sent.length

    const again = await intakeFromMessage(chat, { chatIntakeId, text: 'ขอปูน 20 ถุง', fileIds: [file.id], idempotencyKey }, key())
    expect(again).toMatchObject({ ok: true, data: { agentActionId: first.data.agentActionId, status: 'DRAFT' } })
    expect(sent.length).toBe(calls)
    expect(await prisma.aiCreditLedger.count({ where: { organizationId: org.organizationId, kind: 'USE' } })).toBe(uses)
    // The job never runs a chat intake (its text is gone)
    expect(await runIntake(org.organizationId, first.data.agentActionId, NOW)).toBe('SKIPPED')
  })

  it('[FR-AI-302/AC5] the draft made from the chat cannot be sent until the requester confirmed it', async () => {
    answering(draftOf())
    const chat = makeCtx({ organizationId: org.organizationId, actor: { type: 'USER', memberId: org.member.req_con! }, channel: 'LINE_CHAT', now: NOW })
    const r = await intakeFromMessage(chat, { chatIntakeId: randomUUID(), text: 'ขอปูน 20 ถุง' }, key())
    if (!r.ok) throw new Error('intake')
    const done = await action(r.data.agentActionId)
    expect((done.review as { proposed: Record<string, string> }).proposed).toMatchObject({ requestTypeCode: 'BUY_GOODS' })
    const draft = await createDraft(org.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', title: 'ปูนสำหรับไซต์ A', lines: [{ description: 'ปูนซีเมนต์ 50 กก.', quantity: '20', uom: 'ถุง', unitPrice: '150.00' }], aiAssist: { agentActionId: r.data.agentActionId, confirmedPaths: [] } }, key())
    if (!draft.ok) throw new Error(JSON.stringify(draft.error))
    expect(await submitRequest(org.ctxOf('req_con', NOW), { requestId: draft.data.requestId }, key())).toMatchObject({ ok: false, error: { code: 'AI_REVIEW_PENDING' } })
  })

  it('[FR-AI-302/AC5] with Intake off it is not available, so S17 uses the LIFF form', async () => {
    expect((await updateAgentSetting(org.ctxOf('admin', NOW), { agent: 'INTAKE', enabled: false }, key())).ok).toBe(true)
    try {
      expect(await isAgentAvailable(org.ctxOf('req_con', NOW), 'INTAKE')).toEqual({ available: false, reason: 'AI_AGENT_DISABLED' })
      const chat = makeCtx({ organizationId: org.organizationId, actor: { type: 'USER', memberId: org.member.req_con! }, channel: 'LINE_CHAT', now: NOW })
      expect(await intakeFromMessage(chat, { chatIntakeId: randomUUID(), text: 'ขอปูน' }, key())).toMatchObject({ ok: false, error: { code: 'AI_AGENT_DISABLED' } })
    } finally {
      expect((await updateAgentSetting(org.ctxOf('admin', NOW), { agent: 'INTAKE', enabled: true }, key())).ok).toBe(true)
    }
  })
})

describe('[BR-AI-16] S13-15 review: a line left out does not move the confidence of the others', () => {
  it('[BR-AI-16] each line kept reads its confidence where the model gave it', async () => {
    answering(
      draftOf({
        lines: [
          { description: null, itemCode: null, qty: null, unit: 'ชิ้น', unitPrice: null },
          { description: 'ทรายหยาบ', itemCode: null, qty: '5', unit: 'คิว', unitPrice: '300' },
        ],
        confidence: [
          { field: 'title', value: 95 },
          { field: 'lines.0.unit', value: 10 },
          { field: 'lines.1.description', value: 96 },
          { field: 'lines.1.unit', value: 97 },
        ],
      }),
    )
    const started = await startIntake(org.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', text: 'ขอทรายหยาบ 5 คิว' }, key())
    if (!started.ok) throw new Error(JSON.stringify(started.error))
    expect(await runIntake(org.organizationId, started.data.agentActionId, NOW)).toBe('DRAFT')
    const review = (await action(started.data.agentActionId)).review as { proposed: Record<string, string>; requiredPaths: string[] }
    expect(review.proposed).toMatchObject({ 'lines.0.description': 'ทรายหยาบ', 'lines.0.uom': 'คิว' })
    // The sure description and unit of the model's line 1 are not waiting; quantity and price always are
    expect(review.requiredPaths).toEqual(['lines.0.quantity', 'lines.0.unitPrice'])
  })
})
