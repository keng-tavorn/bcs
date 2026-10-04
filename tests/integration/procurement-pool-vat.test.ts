import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { consolidatePool } from '@/app/(workspace)/procurement/pool/commands'
import { prisma } from '@/server/db/client'
import { decideTask } from '@/server/services/approvals/decide'
import { assignSupplier, consolidateNow, listPool, runScheduledConsolidation } from '@/server/services/procurement'
import { createDraft, submitRequest } from '@/server/services/requests'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// NEW-50 (spec BR-MONEY-02, BR-CONS-01, BR-CONS-02, BR-BUD-05, FR-P2P-001, FR-P2P-002): a request whose prices include
// VAT has no unit price before VAT without a rounding BR-MONEY-02 does not allow — 3 × 100.00 including VAT 7% would
// become a draft PO of 300.01 against the 300.00 approved. Until the user decides how such a request becomes PO lines,
// no round (by hand, on the cron, or at once for an urgent request) puts its lines on a draft: they stay in the pool,
// at the request's own prices, saying why. A request priced before VAT is drafted as before, at exactly its own unit
// price, also when a request priced with VAT shares its supplier, site and kind. Real Postgres, real services.

const NOW = new Date('2026-10-05T03:00:00Z') // Monday 10:00 in Bangkok
const key = () => ({ idempotencyKey: randomUUID(), sender: null })

let org: DoaOrg
let budgetLineId: string
const supplier: Record<string, string> = {}
const site: Record<string, string> = {}
const codeOf = (memberId: string) => Object.entries(org.member).find(([, id]) => id === memberId)![0]
const proc = () => org.ctxOf('proc_officer', NOW)
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}

beforeAll(async () => {
  org = await createDoaOrg()
  budgetLineId = (await prisma.budgetLine.findFirstOrThrow({ where: { organizationId: org.organizationId, code: 'CON-OPEX-2569' } })).id
  for (const [code, taxId] of [
    ['S1', '0999999000012'],
    ['S2', '0999999000021'],
  ] as const) {
    supplier[code] = (await prisma.supplier.create({ data: { organizationId: org.organizationId, code, nameTh: `ผู้ขาย ${code}`, taxId } })).id
  }
  for (const code of ['SITE-A', 'SITE-B']) site[code] = (await prisma.deliverySite.create({ data: { organizationId: org.organizationId, code, nameTh: code } })).id
})

/** An approved request of CON (its DM approves small amounts), priced before VAT unless `includesVat` */
async function approvedRequest(options: { site: string; includesVat?: boolean; urgent?: boolean; lines: Array<{ quantity: string; unitPrice: string }> }) {
  const draft = ok(
    await createDraft(
      org.ctxOf('req_con', NOW),
      {
        requestTypeCode: 'BUY_GOODS',
        title: 'วัสดุไซต์',
        budgetLineId,
        priceIncludesVat: options.includesVat ?? false,
        urgency: options.urgent ? 'URGENT' : 'NORMAL',
        lines: options.lines.map((l, i) => ({ description: `ของ ${i + 1}`, quantity: l.quantity, uom: 'ชิ้น', unitPrice: l.unitPrice })),
      },
      key(),
    ),
  )
  // The form screen sets the site (S4-02 prefill); the pool only reads it
  await prisma.request.update({ where: { id: draft.requestId }, data: { deliverySiteId: site[options.site]! } })
  ok(await submitRequest(org.ctxOf('req_con', NOW), { requestId: draft.requestId }, key()))
  for (let i = 0; i < 4; i++) {
    const task = await prisma.approvalTask.findFirst({ where: { status: 'OPEN', step: { route: { subjectId: draft.requestId } } } })
    if (!task) break
    ok(await decideTask(org.ctxOf(codeOf(task.assigneeMemberId), NOW), { taskId: task.id, decision: 'APPROVE' }, key()))
  }
  const request = await prisma.request.findUniqueOrThrow({ where: { id: draft.requestId }, include: { lines: { orderBy: { lineNo: 'asc' } } } })
  expect(request.status).toBe('APPROVED')
  return { id: request.id, number: request.number!, lineIds: request.lines.map((l) => l.id), request }
}

/** PO lines that order any of these request lines (in any PO, whatever its status) */
const orderedLines = (requestLineIds: readonly string[]) => prisma.poLineSource.count({ where: { requestLineId: { in: [...requestLineIds] } } })

// The request of the example: 3 × 100.00 including VAT 7%, approved at 300.00 (amount before VAT 280.37, VAT 19.63)
let example: Awaited<ReturnType<typeof approvedRequest>>

describe('[FR-P2P-001/AC1] [FR-P2P-001/AC3] the pool shows a request priced with VAT at its own prices, and why no round drafts it', () => {
  it('lists the line at the unit price and amount the request states, VAT included and marked so, needing a supplier and blocked for NEW-50', async () => {
    example = await approvedRequest({ site: 'SITE-A', includesVat: true, lines: [{ quantity: '3', unitPrice: '100.00' }] })
    expect([example.request.priceIncludesVat, example.request.grossSatang, example.request.vatSatang, example.request.netSatang]).toEqual([true, 30_000n, 1_963n, 28_037n])
    const row = ok(await listPool(proc())).find((p) => p.requestLineId === example.lineIds[0])
    // Nothing converted, so nothing rounded: 3 × 100.00 = 300.00, the price as approved
    expect(row).toMatchObject({ requestNo: example.number, quantity: '3', unitPriceSatang: 10_000n, amountSatang: 30_000n, priceIncludesVat: true, draftBlock: 'PRICE_INCLUDES_VAT', needsSupplier: true })
  })
})

describe('[FR-P2P-002/AC1] [FR-P2P-002/AC3] a round by hand drafts no PO from a request priced with VAT; it stays in the pool', () => {
  it('takes its supplier, then the round leaves the line where it is: no draft, no source line, the request still APPROVED', async () => {
    expect(ok(await assignSupplier(proc(), { requestLineIds: example.lineIds, supplierId: supplier.S1! }, key()))).toEqual({ assigned: 1, purchaseOrderIds: [] })
    const run = ok(await consolidateNow(proc(), key()))
    expect(run.purchaseOrderIds).toEqual([])
    expect(await orderedLines(example.lineIds)).toBe(0)
    expect(await prisma.purchaseOrder.count({ where: { organizationId: org.organizationId } })).toBe(0)
    // The round is still recorded, with what it made: nothing
    expect(await prisma.consolidationRun.findUniqueOrThrow({ where: { id: run.runId } })).toMatchObject({ trigger: 'MANUAL', status: 'COMPLETED', createdPoIds: [] })
    expect(await prisma.event.findFirstOrThrow({ where: { aggregateId: run.runId } })).toMatchObject({ type: 'consolidation_run.completed', data: { purchaseOrderIds: [], lineCount: 0 } })
    const row = ok(await listPool(proc())).find((p) => p.requestLineId === example.lineIds[0])
    expect(row).toMatchObject({ quantity: '3', supplier: { code: 'S1' }, needsSupplier: false, draftBlock: 'PRICE_INCLUDES_VAT', amountSatang: 30_000n })
    expect((await prisma.request.findUniqueOrThrow({ where: { id: example.id } })).status).toBe('APPROVED')
  })
})

describe('[FR-P2P-002/AC1] a group of one supplier, site and kind drafts only its lines priced before VAT (BR-CONS-01)', () => {
  it('drafts the before-VAT request at exactly its own unit price, and leaves both lines of the request priced with VAT in the pool', async () => {
    const before = await approvedRequest({ site: 'SITE-B', lines: [{ quantity: '2.5', unitPrice: '10.01' }] })
    const withVat = await approvedRequest({ site: 'SITE-B', includesVat: true, lines: [{ quantity: '3', unitPrice: '100.00' }, { quantity: '1', unitPrice: '50.00' }] })
    ok(await assignSupplier(proc(), { requestLineIds: [...withVat.lineIds, ...before.lineIds], supplierId: supplier.S2! }, key()))

    const run = ok(await consolidateNow(proc(), key()))
    expect(run.purchaseOrderIds).toHaveLength(1)
    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: run.purchaseOrderIds[0]! }, include: { lines: { orderBy: { lineNo: 'asc' }, include: { sources: true } } } })
    expect(po).toMatchObject({ status: 'DRAFT', supplierId: supplier.S2, deliverySiteId: site['SITE-B'], kind: 'GOODS', priceIncludesVat: false })
    // The request's price as it is, the line amount rounded once (BR-MONEY-02 (1): 2.5 × 10.01 = 25.025 → 25.03)
    expect(po.lines.map((l) => [l.quantity.toString(), l.unitPriceSatang, l.netSatang])).toEqual([['2.5', 1_001n, 2_503n]])
    expect(po.lines[0]!.sources.map((s) => [s.requestLineId, s.quantity.toString(), s.releasableSatang])).toEqual([[before.lineIds[0], '2.5', 2_503n]])
    expect([po.netSatang, po.vatSatang, po.grossSatang]).toEqual([2_503n, 175n, 2_678n])
    expect(await prisma.event.findFirstOrThrow({ where: { aggregateId: run.runId } })).toMatchObject({ data: { lineCount: 1 } })

    // The request priced with VAT: every line still in the pool, none on a PO
    expect(await orderedLines(withVat.lineIds)).toBe(0)
    const pool = ok(await listPool(proc(), { deliverySiteId: site['SITE-B'] }))
    expect(pool.map((p) => [p.requestLineId, p.supplier?.code, p.draftBlock, p.amountSatang])).toEqual([
      [withVat.lineIds[0], 'S2', 'PRICE_INCLUDES_VAT', 30_000n],
      [withVat.lineIds[1], 'S2', 'PRICE_INCLUDES_VAT', 5_000n],
    ])
    expect(pool.some((p) => p.requestLineId === before.lineIds[0])).toBe(false)
  })
})

describe('[FR-P2P-002/AC1] an urgent request priced with VAT gets no draft at once when its supplier is chosen (BR-CONS-02)', () => {
  it('takes the supplier and drafts nothing; the line waits in the pool, urgent and blocked', async () => {
    const urgent = await approvedRequest({ site: 'SITE-A', urgent: true, includesVat: true, lines: [{ quantity: '1', unitPrice: '107.00' }] })
    const urgentRuns = () => prisma.consolidationRun.count({ where: { organizationId: org.organizationId, trigger: 'URGENT' } })
    const runsBefore = await urgentRuns()
    expect(ok(await assignSupplier(proc(), { requestLineIds: urgent.lineIds, supplierId: supplier.S1! }, key()))).toEqual({ assigned: 1, purchaseOrderIds: [] })
    expect(await orderedLines(urgent.lineIds)).toBe(0)
    expect(ok(await listPool(proc())).find((p) => p.requestLineId === urgent.lineIds[0])).toMatchObject({ urgency: 'URGENT', supplier: { code: 'S1' }, draftBlock: 'PRICE_INCLUDES_VAT' })
    // nothing could be drafted, so no urgent round is recorded either
    expect(await urgentRuns()).toBe(runsBefore)
  })
})

describe('[FR-P2P-002/AC2] the round on the organization cron leaves a request priced with VAT in the pool as well', () => {
  it('runs the 10:00 round, drafts nothing from the requests priced with VAT, and they stay', async () => {
    const result = await runScheduledConsolidation(org.organizationId, new Date('2026-10-05T03:04:00Z'))
    expect(result).toEqual({ ran: true, scheduledFor: '2026-10-05T03:00:00.000Z', purchaseOrderIds: [] })
    const blocked = ok(await listPool(proc())).filter((p) => p.draftBlock === 'PRICE_INCLUDES_VAT')
    expect(blocked.length).toBe(4)
    expect(await orderedLines(blocked.map((p) => p.requestLineId))).toBe(0)
  })
})

describe('[FR-P2P-002/AC3] "รวมเป็นร่าง PO ตอนนี้" counts the lines priced with VAT apart, with their supplier or without', () => {
  it('a line priced with VAT and no supplier counts with them: choosing its supplier would not get it drafted', async () => {
    const noSupplier = await approvedRequest({ site: 'SITE-A', includesVat: true, lines: [{ quantity: '2', unitPrice: '53.50' }] })
    // Four lines with a supplier and this one, all priced with VAT; none needs a supplier to be drafted
    expect(await consolidatePool(proc(), randomUUID())).toEqual({ ok: true, drafts: [], left: 0, waiting: 0, blocked: 5 })
    expect(ok(await listPool(proc())).find((p) => p.requestLineId === noSupplier.lineIds[0])).toMatchObject({ needsSupplier: true, draftBlock: 'PRICE_INCLUDES_VAT' })
  })

  it('a line priced before VAT that waits for its supplier is the one counted as needing a supplier', async () => {
    const plain = await approvedRequest({ site: 'SITE-A', lines: [{ quantity: '1', unitPrice: '10.00' }] })
    expect(await consolidatePool(proc(), randomUUID())).toEqual({ ok: true, drafts: [], left: 1, waiting: 0, blocked: 5 })
    expect(ok(await listPool(proc())).find((p) => p.requestLineId === plain.lineIds[0])).toMatchObject({ needsSupplier: true, draftBlock: null })
  })
})
