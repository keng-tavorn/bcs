import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { agreementDay } from '@/core/pricing/agreement'
import { MS_PER_DAY } from '@/lib/constants'
import { prisma } from '@/server/db/client'
import { savingsOpportunities, type SavingsItemDto } from '@/server/services/assistants/savings'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { p2p } from '../support/p2p'
import { createDraft, submitRequest } from '../support/requests'

// NEW-123 (FR-VIS-008 · ADR-081 · spec §7.21): the savings assistant against Postgres, through the real services. One
// organization holds one saving of each kind — a drill asked for above the median of three POs, a helmet off its agreed
// price, cement waiting in the pool from two departments at two prices, and gloves whose agreed price ends in ten days
// after a PO bought at it — and only who reads every PO and request sees them.

const NOW = new Date('2026-10-20T03:00:00Z')
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
  })
})

