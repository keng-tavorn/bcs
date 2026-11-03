import { randomUUID } from 'node:crypto'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { agreementDay } from '@/core/pricing/agreement'
import { setAiClientForTests, type AiClient, type AiRequest } from '@/integrations/ai'
import { EVAL_GATES, PROMPT_VERSIONS } from '@/lib/ai-config'
import { MS_PER_DAY } from '@/lib/constants'
import { prisma } from '@/server/db/client'
import { explainSaving, runMonthlyGrant, savingsNoteAvailable, savingsNotesOf, setAiRuntimeForTests, updateAgentSetting, type AiRuntime } from '@/server/services/ai'
import { savingsOpportunities, type SavingsItemDto } from '@/server/services/assistants/savings'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { p2p } from '../support/p2p'
import { createDraft, submitRequest } from '../support/requests'

// NEW-123 (FR-VIS-008 · ADR-081 · spec §7.21): the savings assistant against Postgres, through the real services. One
// organization holds one saving of each kind — a drill asked for above the median of three POs, a helmet off its agreed
// price, cement waiting in the pool from two departments at two prices, and gloves whose agreed price ends in ten days
// after a PO bought at it — and only who reads every PO and request sees them.

const NOW = new Date('2026-10-20T03:00:00Z')
const FIXTURE: AiRuntime = { enabled: true, mode: 'fixture', appEnv: 'local', modelEnv: {}, gates: [] }
const DRILL = 'สว่านไฟฟ้า 18V (ประหยัด)'
const CEMENT = 'ปูนซีเมนต์ถุง 50 กก. (ประหยัด)'

let org: DoaOrg
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}
const as = (code: string) => org.ctxOf(code, NOW)
const lineOf = async (dept: string) => (await prisma.budgetLine.findFirstOrThrow({ where: { organizationId: org.organizationId, code: `${dept}-OPEX-2569` }, select: { id: true } })).id
const supplier = async (code: string, nameTh: string) => (await prisma.supplier.create({ data: { organizationId: org.organizationId, code, nameTh, isForeign: true } })).id
const byKind = (items: readonly SavingsItemDto[], kind: SavingsItemDto['kind']) => items.filter((i) => i.kind === kind)

let drillRequest: string
let helmetRequest: string
let gloveAgreement: string

beforeAll(async () => {
  org = await createDoaOrg()
  const { organizationId } = org
  for (const [code, role] of [
    ['fin_officer', 'FINANCE'],
    ['auditor', 'AUDITOR'],
    ['coo', 'EXECUTIVE'],
    ['admin', 'ORG_ADMIN'],
  ] as const) {
    await prisma.roleAssignment.create({ data: { organizationId, memberId: org.member[code]!, role, grantedAt: NOW } })
  }
  const tools = await supplier('S-TOOLS', 'ผู้ขายเครื่องมือ')

  // three POs of the drill, approved on three days: 2,400.00 · 2,380.00 · 2,450.00 (median 2,400.00, BR-PRC-02)
  for (const [day, price] of [
    ['2026-10-07T03:00:00Z', '2400.00'],
    ['2026-10-08T03:00:00Z', '2380.00'],
    ['2026-10-09T03:00:00Z', '2450.00'],
  ] as const) {
    const kit = p2p(org, new Date(day))
    const request = await kit.approvedRequest(await kit.fundedLine(100_000n), [{ quantity: '1', unitPrice: price, description: DRILL }])
    await kit.approvedPo(
      request.lines.map((l) => l.id),
      tools,
    )
  }

  // gloves bought at their agreed price, which ends ten days from now
  const gloveSupplier = await supplier('S-GLOVE', 'ผู้ขายถุงมือ')
  const gloves = await prisma.catalogItem.create({ data: { organizationId, code: 'CAT-GLOVE-SAV', nameTh: 'ถุงมือผ้า', uom: 'คู่', categoryCode: 'PPE' } })
  const today = new Date(`${agreementDay(NOW)}T00:00:00Z`)
  gloveAgreement = (
    await prisma.priceAgreement.create({
      data: { organizationId, catalogItemId: gloves.id, supplierId: gloveSupplier, unitPriceSatang: 2_500n, validFrom: new Date('2026-01-01T00:00:00Z'), validTo: new Date(today.getTime() + 10 * MS_PER_DAY) },
    })
  ).id
  const bought = p2p(org, new Date('2026-10-10T03:00:00Z'))
  const gloveDraft = ok(
    await createDraft(
      org.ctxOf('req_con', new Date('2026-10-10T03:00:00Z')),
      { requestTypeCode: 'BUY_GOODS', title: 'ถุงมือ', budgetLineId: await lineOf('CON'), suggestedSupplierId: gloveSupplier, lines: [{ description: 'ถุงมือผ้า', quantity: '20', uom: 'คู่', unitPrice: '25.00', catalogItemId: gloves.id }] },
      key(),
    ),
  )
  ok(await submitRequest(org.ctxOf('req_con', new Date('2026-10-10T03:00:00Z')), { requestId: gloveDraft.requestId }, key()))
  await bought.approveAll(gloveDraft.requestId)
  const gloveLines = await prisma.requestLine.findMany({ where: { requestId: gloveDraft.requestId }, select: { id: true, priceAgreementId: true } })
  expect(gloveLines.map((l) => l.priceAgreementId)).toEqual([gloveAgreement])
  await bought.approvedPo(
    gloveLines.map((l) => l.id),
    gloveSupplier,
  )

  // the drill at 2,700.00 × 2, waiting for approval: 12.50% above the median
  const drill = ok(await createDraft(as('req_con'), { requestTypeCode: 'BUY_GOODS', title: 'เครื่องมือช่าง', budgetLineId: await lineOf('CON'), lines: [{ description: DRILL, quantity: '2', uom: 'ชิ้น', unitPrice: '2700.00' }] }, key()))
  ok(await submitRequest(as('req_con'), { requestId: drill.requestId }, key()))
  drillRequest = drill.requestId

  // a helmet at 185.00 × 10 from a supplier without its agreed price of 175.00
  const helmet = await prisma.catalogItem.create({ data: { organizationId, code: 'CAT-HELMET-SAV', nameTh: 'หมวกนิรภัย', uom: 'ใบ', categoryCode: 'PPE' } })
  const helmetAgreed = await supplier('S-HELMET-A', 'ผู้ขายหมวกตามสัญญา')
  const helmetOther = await supplier('S-HELMET-B', 'ผู้ขายหมวกรายอื่น')
  await prisma.priceAgreement.create({ data: { organizationId, catalogItemId: helmet.id, supplierId: helmetAgreed, unitPriceSatang: 17_500n, validFrom: new Date('2026-01-01T00:00:00Z'), validTo: new Date('2027-01-01T00:00:00Z') } })
  const helmetDraft = ok(
    await createDraft(
      as('req_con'),
      {
        requestTypeCode: 'BUY_GOODS',
        title: 'หมวกนิรภัย',
        budgetLineId: await lineOf('CON'),
        suggestedSupplierId: helmetOther,
        offAgreementReason: 'ผู้ขายตามสัญญาส่งไม่ทัน',
        lines: [{ description: 'หมวกนิรภัย', quantity: '10', uom: 'ใบ', unitPrice: '185.00', catalogItemId: helmet.id }],
      },
      key(),
    ),
  )
  ok(await submitRequest(as('req_con'), { requestId: helmetDraft.requestId }, key()))
  helmetRequest = helmetDraft.requestId

  // cement approved and waiting in the pool: construction 10 × 120.00, finance 5 × 100.00
  const kit = p2p(org, NOW)
  await kit.approvedRequest(await lineOf('CON'), [{ quantity: '10', unitPrice: '120.00', description: CEMENT }])
  const finance = ok(await createDraft(as('admin2'), { requestTypeCode: 'BUY_GOODS', title: 'ปูนซ่อมอาคาร', budgetLineId: await lineOf('FIN'), lines: [{ description: CEMENT, quantity: '5', uom: 'ชิ้น', unitPrice: '100.00' }] }, key()))
  ok(await submitRequest(as('admin2'), { requestId: finance.requestId }, key()))
  await kit.approveAll(finance.requestId)
}, 600_000)

describe('[FR-VIS-008/AC1] the savings of the organization, each amount from findSavings', () => {
  it('finds one of each kind, the largest saving first, and the total counts each line once', async () => {
    const data = ok(await savingsOpportunities(as('proc_officer')))
    expect(data.items.map((i) => [i.kind, i.savingSatang])).toEqual([
      ['PRICE_ABOVE_HISTORY', '60000'],
      ['SAME_ITEM_DEPARTMENTS', '20000'],
      ['OFF_AGREEMENT', '10000'],
      ['AGREEMENT_EXPIRING', null],
    ])
    expect(data.totalSatang).toBe('90000')
    expect(data.counts).toEqual({ PRICE_ABOVE_HISTORY: 1, OFF_AGREEMENT: 1, SAME_ITEM_DEPARTMENTS: 1, AGREEMENT_EXPIRING: 1 })
  })

  it('shows the POs the median comes from, the latest first, and the request waiting for approval', async () => {
    const [drill] = byKind(ok(await savingsOpportunities(as('proc_officer'))).items, 'PRICE_ABOVE_HISTORY')
    if (drill?.kind !== 'PRICE_ABOVE_HISTORY') throw new Error('no drill')
    expect(drill.line.request).toMatchObject({ id: drillRequest, stage: 'PENDING_APPROVAL' })
    expect(drill.line).toMatchObject({ description: DRILL, quantity: '2', unitPriceSatang: '270000' })
    expect([drill.referenceSatang, drill.minSatang, drill.maxSatang, drill.count, drill.deviationBp]).toEqual(['240000', '238000', '245000', 3, 1250])
    expect(drill.purchases.map((p) => [p.unitPriceSatang, p.approvedAt.slice(0, 10)])).toEqual([
      ['245000', '2026-10-09'],
      ['238000', '2026-10-08'],
      ['240000', '2026-10-07'],
    ])
    expect(drill.purchases.every((p) => /^PO-/.test(p.poNumber) && p.supplier.th === 'ผู้ขายเครื่องมือ')).toBe(true)
  })

  it('compares the helmet with the lowest agreed price in effect, with the requester’s reason', async () => {
    const [helmet] = byKind(ok(await savingsOpportunities(as('proc_officer'))).items, 'OFF_AGREEMENT')
    if (helmet?.kind !== 'OFF_AGREEMENT') throw new Error('no helmet')
    expect(helmet.line.request.id).toBe(helmetRequest)
    expect(helmet.line.supplier?.th).toBe('ผู้ขายหมวกรายอื่น')
    expect([helmet.agreedSatang, helmet.offAgreementReason, helmet.item.th]).toEqual(['17500', 'ผู้ขายตามสัญญาส่งไม่ทัน', 'หมวกนิรภัย'])
    expect(helmet.agreements.map((a) => [a.supplier.th, a.unitPriceSatang])).toEqual([['ผู้ขายหมวกตามสัญญา', '17500']])
  })

  it('groups the cement of two departments in the pool at the lowest price', async () => {
    const [cement] = byKind(ok(await savingsOpportunities(as('proc_officer'))).items, 'SAME_ITEM_DEPARTMENTS')
    if (cement?.kind !== 'SAME_ITEM_DEPARTMENTS') throw new Error('no cement')
    expect([cement.description, cement.departments, cement.lowestSatang]).toEqual([CEMENT, 2, '10000'])
    expect(cement.lines.map((l) => [l.request.department.th, l.quantity, l.unitPriceSatang, l.savingSatang, l.lowest, l.request.stage]).sort()).toEqual([
      ['ฝ่ายก่อสร้าง', '10', '12000', '20000', false, 'POOL'],
      ['ฝ่ายบัญชีและการเงิน', '5', '10000', '0', true, 'POOL'],
    ])
  })

  it('lists the gloves’ agreed price ending in ten days with what was bought at it', async () => {
    const [gloves] = byKind(ok(await savingsOpportunities(as('proc_officer'))).items, 'AGREEMENT_EXPIRING')
    if (gloves?.kind !== 'AGREEMENT_EXPIRING') throw new Error('no gloves')
    expect([gloves.agreement.id, gloves.daysLeft, gloves.spentSatang, gloves.count, gloves.item.th, gloves.agreement.supplier.th]).toEqual([gloveAgreement, 10, '50000', 1, 'ถุงมือผ้า', 'ผู้ขายถุงมือ'])
    expect(gloves.purchases.map((p) => [p.quantity, p.unitPriceSatang, p.netSatang])).toEqual([['20', '2500', '50000']])
  })

  it('counts only what a PO line kept at the agreed price: a cancelled part was not bought (BR-SAV-04)', async () => {
    // the PO line closed short by 8 pairs, as a cancellation leaves it (the PO's own commands are not what is tested)
    const line = await prisma.poLine.findFirstOrThrow({ where: { organizationId: org.organizationId, sources: { some: { requestLine: { priceAgreementId: gloveAgreement } } } }, select: { id: true } })
    await prisma.poLine.update({ where: { id: line.id }, data: { cancelledQuantity: '8' } })
    try {
      const [gloves] = byKind(ok(await savingsOpportunities(as('proc_officer'))).items, 'AGREEMENT_EXPIRING')
      if (gloves?.kind !== 'AGREEMENT_EXPIRING') throw new Error('no gloves')
      expect([gloves.spentSatang, gloves.count]).toEqual(['30000', 1])
    } finally {
      await prisma.poLine.update({ where: { id: line.id }, data: { cancelledQuantity: '0' } })
    }
  })

  it('reads only: nothing is written, no AI is asked', async () => {
    const before = await Promise.all([prisma.event.count({ where: { organizationId: org.organizationId } }), prisma.agentAction.count({ where: { organizationId: org.organizationId } })])
    ok(await savingsOpportunities(as('proc_officer')))
    expect(await Promise.all([prisma.event.count({ where: { organizationId: org.organizationId } }), prisma.agentAction.count({ where: { organizationId: org.organizationId } })])).toEqual(before)
  })
})

describe('[FR-VIS-008/AC2] who reads every PO and request sees the savings; nobody else', () => {
  it.each(['proc_officer', 'fin_officer', 'auditor', 'coo'])('%s sees the same savings', async (code) => {
    const data = ok(await savingsOpportunities(as(code)))
    expect([data.totalSatang, data.items.length]).toEqual(['90000', 4])
  })

  it.each([
    // ORG_ADMIN reads every request but not every PO; a department head and the requester only their own
    ['admin', 'ORG_ADMIN'],
    ['dm_con', 'department head'],
    ['req_con', 'requester'],
  ])('%s (%s) is refused', async (code) => {
    const r = await savingsOpportunities(as(code))
    expect(r.ok ? 'OK' : r.error.code).toBe('FORBIDDEN')
  })

  it('the system and the BCS team are refused', async () => {
    const system = await savingsOpportunities({ ...as('proc_officer'), actor: { type: 'SYSTEM' } })
    expect(system.ok ? 'OK' : system.error.code).toBe('FORBIDDEN')
    // PLATFORM_ADMIN never reads a customer's business data (NG-12)
    const platform = await savingsOpportunities({ ...as('proc_officer'), actor: { type: 'PLATFORM_ADMIN', platformAdminId: randomUUID() } })
    expect(platform.ok ? 'OK' : platform.error.code).toBe('FORBIDDEN')
  })
})

// ---------- the assistant's words (FR-VIS-008 AC3) ----------

/** Answers every write with `sentences`; records what was sent */
function writing(sentences: string[]) {
  const sent: Array<AiRequest<unknown>> = []
  const client: AiClient = {
    mode: 'fixture',
    extract: async () => {
      throw new Error('not used')
    },
    write: async (request) => {
      sent.push(request as AiRequest<unknown>)
      return { ok: true, promptVersion: PROMPT_VERSIONS[request.purpose], model: request.model, output: request.schema.parse({ sentences }), usage: { input: 600, output: 80, cacheRead: 0, cacheWrite: 0 }, latencyMs: 250 }
    },
  }
  setAiClientForTests(client)
  return sent
}
const drillKey = async (code = 'proc_officer') => byKind(ok(await savingsOpportunities(as(code))).items, 'PRICE_ABOVE_HISTORY')[0]!.key
const actionsOf = () => prisma.agentAction.count({ where: { organizationId: org.organizationId, purpose: 'SAVINGS_NOTE' } })

describe('[FR-VIS-008/AC3] the assistant words a saving the code found, never decides', () => {
  beforeAll(async () => {
    await prisma.orgModule.create({ data: { organizationId: org.organizationId, module: 'AI', enabled: true, enabledAt: new Date('2026-01-01T00:00:00+07:00'), contractRef: 'TEST-NEW132', reason: 'ทดสอบผู้ช่วยหาเงินประหยัด' } })
    setAiRuntimeForTests(FIXTURE)
    expect((await updateAgentSetting(as('admin'), { agent: 'INSIGHT', enabled: true }, key())).ok).toBe(true)
    expect((await runMonthlyGrant(org.organizationId, NOW)).ok).toBe(true)
  })
  afterEach(() => {
    setAiRuntimeForTests(FIXTURE)
    setAiClientForTests(null)
  })

  it('fills the placeholders with the code’s facts, records an L0 call with its credits, and shows it again on the page', async () => {
    const sent = writing(['คำขอ {{v:request}} ขอราคา {{v:price}} บาท สูงกว่าค่ากลาง {{v:reference}} บาท อยู่ {{v:deviation}}', 'ถ้าซื้อที่ค่ากลางจะถูกลง {{v:saving}} บาท'])
    const k = await drillKey()
    const note = ok(await explainSaving(as('proc_officer'), { key: k }, key()))
    expect(note.status).toBe('READY')
    expect(note.sentences[0]).toMatch(/^คำขอ PR-\S+ ขอราคา 2,700\.00 บาท สูงกว่าค่ากลาง 2,400\.00 บาท อยู่ 12\.5%$/)
    expect(note.sentences[1]).toBe('ถ้าซื้อที่ค่ากลางจะถูกลง 600.00 บาท')
    // the model reads the code's figures and is asked for words only
    expect(sent).toHaveLength(1)
    expect(sent[0]!.purpose).toBe('SAVINGS_NOTE')
    expect(sent[0]!.text).toContain('saving = 600.00')
    expect(sent[0]!.text).toContain('reference = 2,400.00')
    const row = await prisma.agentAction.findUniqueOrThrow({ where: { id: note.agentActionId }, select: { agent: true, purpose: true, level: true, status: true, requestedById: true, costCredits: true } })
    expect(row).toMatchObject({ agent: 'INSIGHT', purpose: 'SAVINGS_NOTE', level: 'L0', status: 'DRAFT', requestedById: org.member.proc_officer })
    expect(row.costCredits).toBeGreaterThan(0)
    // the page reads the member's own explanation again, with today's values
    const items = ok(await savingsOpportunities(as('proc_officer'))).items
    expect((await savingsNotesOf(as('proc_officer'), items)).get(k)?.sentences).toEqual(note.sentences)
    // another member reading the same savings has none of it
    expect((await savingsNotesOf(as('fin_officer'), items)).has(k)).toBe(false)
  })

  it.each([
    ['DECISION_ADVICE', ['ควรอนุมัติคำขอ {{v:request}} เพราะถูกลง {{v:saving}} บาท']],
    ['DIGIT_OUTSIDE_PLACEHOLDER', ['ซื้อที่ค่ากลางจะถูกลง 600 บาท']],
    ['UNKNOWN_VALUE', ['ผู้ขายรายนี้ดีกว่า {{v:betterSupplier}}']],
  ])('throws away a text that fails BR-AI-27 (%s): nothing shown, the figures stay', async (reason, sentences) => {
    writing(sentences)
    const k = await drillKey()
    const note = ok(await explainSaving(as('fin_officer'), { key: k }, key()))
    expect([note.status, note.sentences]).toEqual(['FAILED', []])
    const row = await prisma.agentAction.findUniqueOrThrow({ where: { id: note.agentActionId }, select: { status: true, errorCode: true } })
    expect(row).toEqual({ status: 'FAILED', errorCode: `AI_TEXT_${reason}` })
    const items = ok(await savingsOpportunities(as('fin_officer'))).items
    expect((await savingsNotesOf(as('fin_officer'), items)).has(k)).toBe(false)
    expect(items.find((i) => i.key === k)?.savingSatang).toBe('60000')
  })

  it('who may not read the savings cannot have one explained: refused before any call or credits', async () => {
    const sent = writing(['ถูกลง {{v:saving}} บาท'])
    const k = await drillKey()
    const before = await actionsOf()
    for (const code of ['admin', 'req_con', 'dm_con']) {
      const r = await explainSaving(as(code), { key: k }, key())
      expect(r.ok ? 'OK' : r.error.code).toBe('FORBIDDEN')
    }
    const missing = await explainSaving(as('proc_officer'), { key: 'PRICE_ABOVE_HISTORY:not-a-line' }, key())
    expect(missing.ok ? 'OK' : missing.error.code).toBe('NOT_FOUND')
    expect([sent.length, await actionsOf()]).toEqual([0, before])
  })

  it('with the Insight agent off: no button, no explanation written before, no call; the savings stay', async () => {
    const k = await drillKey()
    expect(await savingsNoteAvailable(as('proc_officer'))).toBe(true)
    expect((await updateAgentSetting(as('admin'), { agent: 'INSIGHT', enabled: false }, key())).ok).toBe(true)
    try {
      const sent = writing(['ถูกลง {{v:saving}} บาท'])
      const before = await actionsOf()
      expect(await savingsNoteAvailable(as('proc_officer'))).toBe(false)
      const items = ok(await savingsOpportunities(as('proc_officer'))).items
      expect(items).toHaveLength(4)
      expect((await savingsNotesOf(as('proc_officer'), items)).size).toBe(0)
      const r = await explainSaving(as('proc_officer'), { key: k }, key())
      expect(r.ok ? 'OK' : r.error.code).toBe('AI_AGENT_DISABLED')
      expect([sent.length, await actionsOf()]).toEqual([0, before])
    } finally {
      expect((await updateAgentSetting(as('admin'), { agent: 'INSIGHT', enabled: true }, key())).ok).toBe(true)
    }
  })

  it('with AI off for the whole system, or live without an evaluation of this purpose, there is no button', async () => {
    setAiRuntimeForTests({ ...FIXTURE, enabled: false })
    expect(await savingsNoteAvailable(as('proc_officer'))).toBe(false)
    const items = ok(await savingsOpportunities(as('proc_officer'))).items
    expect(items).toHaveLength(4)
    // the explanation the first test wrote is gone with AI off, the figures stay
    expect((await savingsNotesOf(as('proc_officer'), items)).size).toBe(0)
    setAiRuntimeForTests({ enabled: true, mode: 'live', appEnv: 'staging', modelEnv: {}, gates: EVAL_GATES.filter((g) => g.purpose !== 'SAVINGS_NOTE') })
    expect(await savingsNoteAvailable(as('proc_officer'))).toBe(false)
  })
})
