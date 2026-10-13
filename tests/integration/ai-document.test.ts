import { randomUUID } from 'node:crypto'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createFixtureClient, fixtureKey, setAiClientForTests, type AiClient, type FixtureAnswer } from '@/integrations/ai'
import { putObject } from '@/integrations/storage'
import { prisma } from '@/server/db/client'
import { aiAgentRunRun } from '@/server/jobs/ai-agent-run'
import { readDocument, runDocumentRead, runMonthlyGrant, setAiRuntimeForTests, updateAgentSetting, type AiRuntime } from '@/server/services/ai'
import { postGoodsReceipt } from '@/server/services/receiving'
import { createDraft, editRequest, submitRequest } from '@/server/services/requests'
import { getRequestForEdit } from '@/server/services/requests/form-view'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { etaxXml, pdfWithEmbedded } from '../support/etax-files'
import { p2p } from '../support/p2p'

// S13-07 (FR-AI-303 AC1–AC5 AC8, docs/sub-specs/S13.md BR-AI-12 to BR-AI-17 BR-AI-25): the Document Agent reads a
// quotation for a request and a delivery note for a PO in fixture mode, with answers the tests hand in. readDocument
// refuses before any AI call what it must (an e-Tax file: no AgentAction, no credits); the job records a DRAFT whose
// review proposes form values by path; the person's own command takes them in and nothing goes on before they confirm.

const NOW = new Date('2026-10-05T03:00:00Z')
const SONNET = 'claude-sonnet-5-5'
const SELLER_TAX_ID = '0999999000012'
const FIXTURE: AiRuntime = { enabled: true, mode: 'fixture', appEnv: 'local', modelEnv: {}, gates: [] }
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const PNG = (seed: string) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode(`${seed}-${randomUUID()}`)])

let org: DoaOrg
let orgTaxId: string
const answers = new Map<string, FixtureAnswer>()
let calls = 0

beforeAll(async () => {
  org = await createDoaOrg()
  await prisma.orgModule.create({ data: { organizationId: org.organizationId, module: 'AI', enabled: true, enabledAt: new Date('2026-01-01T00:00:00+07:00'), contractRef: 'TEST-S13', reason: 'ทดสอบผู้อ่านเอกสาร' } })
  await prisma.roleAssignment.createMany({
    data: [
      { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW },
      { organizationId: org.organizationId, memberId: org.member.receiver_con!, role: 'RECEIVER', scopeDepartmentId: org.department.CON!, grantedAt: NOW },
    ],
  })
  orgTaxId = (await prisma.organization.findUniqueOrThrow({ where: { id: org.organizationId }, select: { taxId: true } })).taxId
  setAiRuntimeForTests(FIXTURE)
  expect((await updateAgentSetting(org.ctxOf('admin', NOW), { agent: 'DOCUMENT', enabled: true }, key())).ok).toBe(true)
  expect((await runMonthlyGrant(org.organizationId, NOW)).ok).toBe(true)
})

afterEach(() => {
  setAiRuntimeForTests(FIXTURE)
  setAiClientForTests(null)
})

/** A client that answers from `answers` and counts its calls */
function useClient() {
  const inner = createFixtureClient({ answers, dir: '/nonexistent' })
  const counting: AiClient = { mode: 'fixture', extract: (r) => (calls++, inner.extract(r)), write: (r) => (calls++, inner.write(r)) }
  setAiClientForTests(counting)
}

async function upload(bytes: Uint8Array, mimeType: string, by = 'req_con') {
  const storageKey = `test/ai/${randomUUID()}`
  await putObject(storageKey, bytes, mimeType)
  const file = await prisma.fileObject.create({ data: { organizationId: org.organizationId, storageKey, fileName: 'doc', mimeType, sizeBytes: bytes.length, status: 'AVAILABLE', uploadedById: org.member[by]! } })
  return file.id
}

function reading(over: Record<string, unknown> = {}) {
  return {
    docType: 'QUOTATION',
    docNo: 'QT-6901',
    docDate: '2026-10-04',
    currency: 'THB',
    priceIncludesVat: false,
    seller: { name: 'ร้านวัสดุทดสอบ', taxId: SELLER_TAX_ID, branch: '00000' },
    buyer: { taxId: orgTaxId },
    lines: [{ description: 'ปูนซีเมนต์', qty: '10', unit: 'ถุง', unitPrice: '150.00', amount: '1500.00' }],
    discountTotal: null,
    net: '1500.00',
    vat: '105.00',
    gross: '1605.00',
    confidence: [
      { field: 'seller.name', value: 98 },
      { field: 'seller.taxId', value: 99 },
      { field: 'seller.branch', value: 97 },
      { field: 'net', value: 99 },
      { field: 'priceIncludesVat', value: 95 },
    ],
    ...over,
  }
}

function answer(purpose: 'QUOTATION_READ' | 'DELIVERY_NOTE_READ', bytes: Uint8Array, mediaType: 'image/png' | 'application/pdf', output: unknown) {
  answers.set(fixtureKey({ purpose, files: [{ bytes, mediaType }] }), { promptVersion: `${purpose}@1`, model: SONNET, output, usage: { input: 3000, output: 600 } })
}

const action = (id: string) => prisma.agentAction.findUniqueOrThrow({ where: { id } })
const useRows = (id: string) => prisma.aiCreditLedger.count({ where: { agentActionId: id, kind: 'USE' } })

describe('[FR-AI-303/AC1] [FR-AI-303/AC2] [FR-AI-303/AC3] a quotation read for a request fills its quotation, confirmed by the requester', () => {
  it('[FR-AI-303/AC1] reads in the background, checks every amount and proposes the quotation of the register', async () => {
    useClient()
    const supplier = await prisma.supplier.create({ data: { organizationId: org.organizationId, code: `S-${randomUUID().slice(0, 6)}`, nameTh: 'บริษัท วัสดุทดสอบ จำกัด', taxId: SELLER_TAX_ID } })
    const draft = await createDraft(org.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', title: 'ปูน', lines: [{ description: 'ปูนซีเมนต์', quantity: '10', uom: 'ถุง', unitPrice: '150.00' }] }, key())
    if (!draft.ok) throw new Error(JSON.stringify(draft.error))
    const bytes = PNG('quote')
    const fileId = await upload(bytes, 'image/png')
    answer('QUOTATION_READ', bytes, 'image/png', reading())

    const started = await readDocument(org.ctxOf('req_con', NOW), { fileId, purpose: 'QUOTATION', subject: { type: 'REQUEST', id: draft.data.requestId } }, key())
    if (!started.ok) throw new Error(JSON.stringify(started.error))
    const { agentActionId } = started.data
    expect(await action(agentActionId)).toMatchObject({ status: 'PENDING', purpose: 'QUOTATION_READ', subjectType: 'REQUEST', subjectId: draft.data.requestId, inputRefs: { fileId } })
    // The job hands the event's action to the agent; a second run of the same action does nothing
    const requested = await prisma.event.findFirstOrThrow({ where: { aggregateId: agentActionId, type: 'agent_action.requested' } })
    const step = { run: <T>(_id: string, fn: () => Promise<T>) => fn() }
    expect(await aiAgentRunRun({ data: { organizationId: org.organizationId, aggregateId: agentActionId, data: requested.data } }, step)).toBe('DRAFT')
    expect(await runDocumentRead(org.organizationId, agentActionId, NOW)).toBe('SKIPPED')

    const done = await action(agentActionId)
    const at = `quotations.${fileId}`
    expect(done).toMatchObject({ status: 'DRAFT', model: SONNET, verification: { status: 'PASS', fail: [], computed: { net: '1500.00', vat: '105.00', gross: '1605.00' } } })
    expect(done.review).toEqual({
      proposed: { [`${at}.supplierName`]: 'บริษัท วัสดุทดสอบ จำกัด', [`${at}.supplierId`]: supplier.id, [`${at}.amount`]: '1500.00', [`${at}.includesVat`]: 'false' },
      // Money and the supplier always one by one (OQ-147); the name and the VAT flag were read with confidence
      requiredPaths: [`${at}.amount`, `${at}.supplierId`],
      confirmedPaths: [],
    })
    expect(done.fieldConfidence).toMatchObject({ net: 9900, 'seller.taxId': 9900, 'lines.0.qty': 0 })
    expect(await useRows(agentActionId)).toBe(1)

    // [FR-AI-303/AC3] request.edit takes the quotation with its supplierId and fileId; submit refuses while two wait
    const quotation = { supplierName: 'บริษัท วัสดุทดสอบ จำกัด', supplierId: supplier.id, amount: '1500.00', includesVat: false, fileId, selected: true }
    const edited = await editRequest(org.ctxOf('req_con', NOW), { requestId: draft.data.requestId, quotations: [quotation], aiAssist: { agentActionId, confirmedPaths: [`${at}.supplierName`, `${at}.includesVat`] } }, key())
    expect(edited.ok, JSON.stringify(edited)).toBe(true)
    expect(await prisma.requestQuotation.findFirstOrThrow({ where: { requestId: draft.data.requestId } })).toMatchObject({ supplierId: supplier.id, fileId, amountSatang: 150000n, includesVat: false })
    const refused = await submitRequest(org.ctxOf('req_con', NOW), { requestId: draft.data.requestId }, key())
    expect(refused).toMatchObject({ ok: false, error: { code: 'AI_REVIEW_PENDING', details: { count: 2 } } })
    // The draft opened again brings the AI reading back with its quotation, so the requester can finish confirming
    const reopened = await getRequestForEdit(org.ctxOf('req_con', NOW), draft.data.requestId, 'th')
    if (!reopened.ok) throw new Error(JSON.stringify(reopened.error))
    expect(reopened.data.draft!.quotations[0]).toMatchObject({ supplierId: supplier.id, ai: { agentActionId, fileId, confirmedPaths: [`${at}.includesVat`, `${at}.supplierName`] } })
    const confirmed = await editRequest(org.ctxOf('req_con', NOW), { requestId: draft.data.requestId, aiAssist: { agentActionId, confirmedPaths: [`${at}.amount`, `${at}.supplierId`] } }, key())
    expect(confirmed.ok, JSON.stringify(confirmed)).toBe(true)
    expect(await action(agentActionId)).toMatchObject({ status: 'ACCEPTED', decidedById: org.member.req_con })
  })

  it('[FR-AI-303/AC2] [BR-AI-25] a seller not in the register and totals that do not add up: the name as read, no amount, flagged', async () => {
    useClient()
    const bytes = PNG('unregistered')
    const fileId = await upload(bytes, 'image/png')
    answer('QUOTATION_READ', bytes, 'image/png', reading({ seller: { name: 'ร้านใหม่', taxId: '0105512345677', branch: '00000' }, net: '1400.00', vat: '98.00', gross: '1498.00' }))
    const started = await readDocument(org.ctxOf('req_con', NOW), { fileId, purpose: 'QUOTATION' }, key())
    if (!started.ok) throw new Error(JSON.stringify(started.error))
    expect(await runDocumentRead(org.organizationId, started.data.agentActionId, NOW)).toBe('DRAFT')
    const done = await action(started.data.agentActionId)
    expect(done.verification).toMatchObject({ status: 'FAIL', fail: expect.arrayContaining(['NET_TOTAL']) })
    expect(done.output).toMatchObject({ mapping: { quotation: { supplierId: null, supplierName: 'ร้านใหม่', amount: null }, flags: ['SUPPLIER_NOT_REGISTERED', 'AMOUNT_UNVERIFIED'] } })
    expect(done.review).toMatchObject({ proposed: { [`quotations.${fileId}.supplierName`]: 'ร้านใหม่', [`quotations.${fileId}.includesVat`]: 'false' } })
  })

  it('[FR-AI-303/AC1] an answer that never came, or another model, fails the action with its reason and the form stays as it is', async () => {
    useClient()
    const fileId = await upload(PNG('nothing recorded'), 'image/png')
    const started = await readDocument(org.ctxOf('req_con', NOW), { fileId, purpose: 'QUOTATION' }, key())
    if (!started.ok) throw new Error(JSON.stringify(started.error))
    expect(await runDocumentRead(org.organizationId, started.data.agentActionId, NOW)).toBe('FAILED')
    expect(await action(started.data.agentActionId)).toMatchObject({ status: 'FAILED', errorCode: 'FIXTURE_MISSING', review: null })
    expect(await useRows(started.data.agentActionId)).toBe(0)
  })
})

describe('[FR-AI-303/AC4] a delivery note read on the receiving page fills the received quantities of its PO', () => {
  it('[FR-AI-303/AC4] proposes each PO line it names; gr.post refuses until every line is confirmed', async () => {
    useClient()
    const flow = p2p(org, NOW)
    const supplier = await prisma.supplier.create({ data: { organizationId: org.organizationId, code: `S-${randomUUID().slice(0, 6)}`, nameTh: 'ผู้ขายของใบส่งของ', taxId: SELLER_TAX_ID, branchCode: '00001' } })
    const request = await flow.approvedRequest(await flow.fundedLine(1_000_000n), [
      { quantity: '18', unitPrice: '100.00', description: 'ท่อ PPR 1 นิ้ว' },
      { quantity: '40', unitPrice: '10.00', description: 'ข้อต่อ PPR 1 นิ้ว' },
    ])
    const po = await flow.approvedPo(request.lines.map((l) => l.id), supplier.id)
    await prisma.purchaseOrder.update({ where: { id: po.id }, data: { status: 'SENT', sentAt: NOW } })
    const [pipe, joint] = po.lines
    const bytes = PNG('delivery note')
    const fileId = await upload(bytes, 'image/png', 'receiver_con')
    answer(
      'DELIVERY_NOTE_READ',
      bytes,
      'image/png',
      reading({
        docType: 'DELIVERY_NOTE',
        seller: { name: 'ผู้ขายของใบส่งของ', taxId: SELLER_TAX_ID, branch: '00001' },
        lines: [
          { description: 'ท่อ PPR 1 นิ้ว', qty: '10', unit: 'ชิ้น', unitPrice: null, amount: null },
          { description: 'ข้อต่อ PPR 1 นิ้ว', qty: '25', unit: 'ชิ้น', unitPrice: null, amount: null },
          { description: 'หินคลุก', qty: '4', unit: 'ลบ.ม.', unitPrice: null, amount: null },
        ],
        net: null,
        vat: null,
        gross: null,
      }),
    )
    // Only a receiver who may post this PO reads a delivery note for it
    const stranger = await readDocument(org.ctxOf('req_con', NOW), { fileId, purpose: 'DELIVERY_NOTE', subject: { type: 'PURCHASE_ORDER', id: po.id } }, key())
    expect(stranger.ok).toBe(false)
    const started = await readDocument(org.ctxOf('receiver_con', NOW), { fileId, purpose: 'DELIVERY_NOTE', subject: { type: 'PURCHASE_ORDER', id: po.id } }, key())
    if (!started.ok) throw new Error(JSON.stringify(started.error))
    expect(await runDocumentRead(org.organizationId, started.data.agentActionId, NOW)).toBe('DRAFT')
    const done = await action(started.data.agentActionId)
    const paths = [`lines.${pipe!.id}.received`, `lines.${joint!.id}.received`]
    expect(done.review).toEqual({ proposed: { [paths[0]!]: '10', [paths[1]!]: '25' }, requiredPaths: [...paths].sort(), confirmedPaths: [] })
    // The PO's supplier is the one checked, not the one read (BR-AI-15); a line of no PO line is left to the receiver
    expect(done.verification).toMatchObject({ skip: expect.arrayContaining(['LINE_AMOUNT', 'NET_TOTAL']), fail: [] })
    expect(done.output).toMatchObject({ mapping: { flags: [{ code: 'PO_LINE_UNKNOWN', dnLine: 2 }] } })

    const lines = [
      { poLineId: pipe!.id, received: '10' },
      { poLineId: joint!.id, received: '25' },
    ]
    const waiting = await postGoodsReceipt(org.ctxOf('receiver_con', NOW), { poId: po.id, lines, aiAssist: { agentActionId: started.data.agentActionId, confirmedPaths: [paths[0]!] } }, key())
    expect(waiting).toMatchObject({ ok: false, error: { code: 'AI_REVIEW_PENDING', details: { count: 1 } } })
    const posted = await postGoodsReceipt(org.ctxOf('receiver_con', NOW), { poId: po.id, lines, aiAssist: { agentActionId: started.data.agentActionId, confirmedPaths: paths } }, key())
    if (!posted.ok) throw new Error(JSON.stringify(posted.error))
    expect(await action(started.data.agentActionId)).toMatchObject({ status: 'ACCEPTED', subjectType: 'GOODS_RECEIPT', subjectId: posted.data.grId })
  })

  it('[FR-AI-303/AC4] a delivery note is read for a purchase order only', async () => {
    const fileId = await upload(PNG('dn'), 'image/png', 'receiver_con')
    const r = await readDocument(org.ctxOf('receiver_con', NOW), { fileId, purpose: 'DELIVERY_NOTE' }, key())
    expect(r).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'subject' } } })
  })
})

describe('[FR-AI-303/AC5] [BR-AI-12] files the AI does not read are refused before any call', () => {
  it('[FR-AI-303/AC5] an e-Tax invoice: AI_FILE_UNSUPPORTED reason ETAX, no AI call, no AgentAction, no credits', async () => {
    useClient()
    calls = 0
    const before = await prisma.agentAction.count({ where: { organizationId: org.organizationId } })
    const usesBefore = await prisma.aiCreditLedger.count({ where: { organizationId: org.organizationId, kind: 'USE' } })
    const fileId = await upload(pdfWithEmbedded([{ name: 'ETDA-invoice.xml', content: etaxXml() }]), 'application/pdf')
    const r = await readDocument(org.ctxOf('req_con', NOW), { fileId, purpose: 'QUOTATION' }, key())
    expect(r).toMatchObject({ ok: false, error: { code: 'AI_FILE_UNSUPPORTED', details: { reason: 'ETAX' } } })
    expect(calls).toBe(0)
    expect(await prisma.agentAction.count({ where: { organizationId: org.organizationId } })).toBe(before)
    expect(await prisma.aiCreditLedger.count({ where: { organizationId: org.organizationId, kind: 'USE' } })).toBe(usesBefore)
  })

  it('[BR-AI-12] another member\'s file, a type the AI does not read, bytes that are not what they say', async () => {
    const others = await upload(PNG('not yours'), 'image/png', 'receiver_con')
    expect(await readDocument(org.ctxOf('req_con', NOW), { fileId: others, purpose: 'QUOTATION' }, key())).toMatchObject({ ok: false, error: { code: 'AI_FILE_UNSUPPORTED', details: { reason: 'NOT_AVAILABLE' } } })
    const sheet = await upload(new TextEncoder().encode('a,b\n1,2'), 'text/csv')
    expect(await readDocument(org.ctxOf('req_con', NOW), { fileId: sheet, purpose: 'QUOTATION' }, key())).toMatchObject({ ok: false, error: { code: 'AI_FILE_UNSUPPORTED', details: { reason: 'TYPE' } } })
    const fake = await upload(new TextEncoder().encode('not a png at all'), 'image/png')
    expect(await readDocument(org.ctxOf('req_con', NOW), { fileId: fake, purpose: 'QUOTATION' }, key())).toMatchObject({ ok: false, error: { code: 'AI_FILE_UNSUPPORTED', details: { reason: 'CONTENT_MISMATCH' } } })
  })

  it('[BR-AI-12] a quotation is read only for the requester\'s own draft', async () => {
    const draft = await createDraft(org.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', title: 'ของ', lines: [{ description: 'ของ', quantity: '1', uom: 'ชิ้น', unitPrice: '10.00' }] }, key())
    if (!draft.ok) throw new Error('draft')
    const fileId = await upload(PNG('quote of another'), 'image/png', 'receiver_con')
    const r = await readDocument(org.ctxOf('receiver_con', NOW), { fileId, purpose: 'QUOTATION', subject: { type: 'REQUEST', id: draft.data.requestId } }, key())
    expect(r).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})

describe('[FR-AI-303/AC8] with AI switched off the read is refused by the gate that is closed', () => {
  it('[FR-AI-303/AC8] the system, then the agent: each answers its own code and nothing is recorded', async () => {
    const fileId = await upload(PNG('off'), 'image/png')
    setAiRuntimeForTests({ ...FIXTURE, enabled: false })
    expect(await readDocument(org.ctxOf('req_con', NOW), { fileId, purpose: 'QUOTATION' }, key())).toMatchObject({ ok: false, error: { code: 'AI_AGENT_DISABLED', details: { reason: 'AI_OFF' } } })
    setAiRuntimeForTests(FIXTURE)
    expect((await updateAgentSetting(org.ctxOf('admin', NOW), { agent: 'DOCUMENT', enabled: false }, key())).ok).toBe(true)
    try {
      expect(await readDocument(org.ctxOf('req_con', NOW), { fileId, purpose: 'QUOTATION' }, key())).toMatchObject({ ok: false, error: { code: 'AI_AGENT_DISABLED', details: { reason: 'AGENT_OFF' } } })
    } finally {
      expect((await updateAgentSetting(org.ctxOf('admin', NOW), { agent: 'DOCUMENT', enabled: true }, key())).ok).toBe(true)
    }
  })

  it('[FR-AI-303/AC8] the job ignores an event that is not a Document read', async () => {
    const step = { run: <T>(_id: string, fn: () => Promise<T>) => fn() }
    expect(await aiAgentRunRun({ data: { organizationId: org.organizationId, aggregateId: randomUUID(), data: { purpose: 'QUESTION' } } }, step)).toBe('IGNORED')
    expect(await aiAgentRunRun({ data: { nothing: true } }, step)).toBe('IGNORED')
  })
})
