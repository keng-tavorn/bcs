import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { decideTask } from '@/server/services/approvals/decide'
import { assignSupplier, consolidateNow, listPool, runScheduledConsolidation } from '@/server/services/procurement'
import { createDraft, submitRequest } from '@/server/services/requests'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// S4-03 (spec §7.10, FR-P2P-001, FR-P2P-002, BR-CONS-01 to BR-CONS-05): approved request lines wait in the pool;
// PROCUREMENT chooses their supplier, several at once; the round — on the organization's cron, by hand, or at once for
// an urgent request — turns the lines with a supplier into draft POs, one per (supplier, site, goods or service), in
// request-number order, each PO line keeping its source line and what it gives back at approval (BR-BUD-05).

const NOW = new Date('2026-10-05T03:00:00Z') // Monday 10:00 in Bangkok
const key = () => ({ idempotencyKey: randomUUID(), sender: null })

let org: DoaOrg
let budgetLineId: string
const supplier: Record<string, string> = {}
const site: Record<string, string> = {}
const codeOf = (memberId: string) => Object.entries(org.member).find(([, id]) => id === memberId)![0]

beforeAll(async () => {
  org = await createDoaOrg()
  budgetLineId = (await prisma.budgetLine.findFirstOrThrow({ where: { organizationId: org.organizationId, code: 'CON-OPEX-2569' } })).id
  for (const [code, taxId] of [
    ['S1', '0999999000012'],
    ['S2', '0999999000021'],
    ['S9', '0999999000039'],
  ] as const) {
    supplier[code] = (await prisma.supplier.create({ data: { organizationId: org.organizationId, code, nameTh: `ผู้ขาย ${code}`, taxId, status: code === 'S9' ? 'INACTIVE' : 'ACTIVE' } })).id
  }
  for (const code of ['SITE-A', 'SITE-B']) site[code] = (await prisma.deliverySite.create({ data: { organizationId: org.organizationId, code, nameTh: code } })).id
})

/** An approved request of CON (approved by its DM: small amounts), with its site, urgency and line kinds */
async function approvedRequest(options: { site?: string; urgent?: boolean; lines?: Array<{ quantity: string; unitPrice: string; kind?: 'GOODS' | 'SERVICE' }> } = {}) {
  const lines = options.lines ?? [{ quantity: '10', unitPrice: '100.00' }]
  const draft = await createDraft(
    org.ctxOf('req_con', NOW),
    { requestTypeCode: 'BUY_GOODS', title: 'วัสดุไซต์', budgetLineId, urgency: options.urgent ? 'URGENT' : 'NORMAL', lines: lines.map((l, i) => ({ description: `ของ ${i + 1}`, quantity: l.quantity, uom: 'ชิ้น', unitPrice: l.unitPrice })) },
    key(),
  )
  if (!draft.ok) throw new Error(JSON.stringify(draft.error))
  const requestId = draft.data.requestId
  // The form screen sets these (S4-02 prefill); the pool only reads them
  await prisma.request.update({ where: { id: requestId }, data: { deliverySiteId: options.site ? site[options.site]! : null } })
  for (const [i, l] of lines.entries()) if (l.kind) await prisma.requestLine.updateMany({ where: { requestId, lineNo: i + 1 }, data: { kind: l.kind } })
  const sent = await submitRequest(org.ctxOf('req_con', NOW), { requestId }, key())
  if (!sent.ok) throw new Error(JSON.stringify(sent.error))
  for (let i = 0; i < 4; i++) {
    const task = await prisma.approvalTask.findFirst({ where: { status: 'OPEN', step: { route: { subjectId: requestId } } } })
    if (!task) break
    const decided = await decideTask(org.ctxOf(codeOf(task.assigneeMemberId), NOW), { taskId: task.id, decision: 'APPROVE' }, key())
    if (!decided.ok) throw new Error(JSON.stringify(decided.error))
  }
  const request = await prisma.request.findUniqueOrThrow({ where: { id: requestId }, include: { lines: { orderBy: { lineNo: 'asc' } } } })
  expect(request.status).toBe('APPROVED')
  return { id: requestId, number: request.number!, lineIds: request.lines.map((l) => l.id) }
}

const proc = () => org.ctxOf('proc_officer', NOW)
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}
const poOf = (poId: string) => prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId }, include: { lines: { orderBy: { lineNo: 'asc' }, include: { sources: true } } } })

describe('[FR-P2P-001/AC1] [FR-P2P-001/AC3] PROCUREMENT sees the approved lines nobody has ordered, filtered, and those that need a supplier', () => {
  it('lists the lines with what is left, the site, urgency and age, and marks the lines without a supplier', async () => {
    const r = await approvedRequest({ site: 'SITE-A', urgent: false })
    const pool = ok(await listPool(proc()))
    const row = pool.find((p) => p.requestLineId === r.lineIds[0])!
    expect(row).toMatchObject({ requestNo: r.number, quantity: '10', uom: 'ชิ้น', unitPriceSatang: 10_000n, amountSatang: 100_000n, priceIncludesVat: false, needsSupplier: true, draftBlock: null, supplier: null, deliverySite: { code: 'SITE-A' }, urgency: 'NORMAL', ageDays: 0 })
    expect(ok(await listPool(proc(), { supplierId: 'NONE' })).some((p) => p.requestLineId === r.lineIds[0])).toBe(true)
    expect(ok(await listPool(proc(), { deliverySiteId: site['SITE-B'] })).some((p) => p.requestLineId === r.lineIds[0])).toBe(false)
    expect(ok(await listPool(proc(), { urgency: 'URGENT' })).some((p) => p.requestLineId === r.lineIds[0])).toBe(false)
    expect(ok(await listPool(proc(), { minAgeDays: 1 })).some((p) => p.requestLineId === r.lineIds[0])).toBe(false)
    expect(ok(await listPool(org.ctxOf('proc_officer', new Date('2026-10-08T03:00:00Z')), { minAgeDays: 3 })).some((p) => p.requestLineId === r.lineIds[0])).toBe(true)
  })

  it('only PROCUREMENT sees the pool (procurement.pool.view)', async () => {
    for (const who of ['req_con', 'dm_con', 'fin_officer']) expect(await listPool(org.ctxOf(who, NOW)), who).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})

describe('[FR-P2P-001/AC2] PROCUREMENT chooses the supplier of several lines at once', () => {
  it('sets the supplier of lines of two requests in one go, one event per request', async () => {
    const a = await approvedRequest({ site: 'SITE-B', lines: [{ quantity: '1', unitPrice: '50.00' }, { quantity: '2', unitPrice: '60.00' }] })
    const b = await approvedRequest({ site: 'SITE-B' })
    expect(ok(await assignSupplier(proc(), { requestLineIds: [...a.lineIds, ...b.lineIds], supplierId: supplier.S2! }, key()))).toEqual({ assigned: 3, purchaseOrderIds: [] })
    expect(await prisma.requestLine.findMany({ where: { id: { in: [...a.lineIds, ...b.lineIds] } }, select: { supplierId: true } })).toEqual([{ supplierId: supplier.S2 }, { supplierId: supplier.S2 }, { supplierId: supplier.S2 }])
    const events = await prisma.event.findMany({ where: { type: 'request.supplier_assigned', aggregateId: { in: [a.id, b.id] } } })
    expect(events.map((e) => (e.data as { requestLineIds: string[] }).requestLineIds.length).sort()).toEqual([1, 2])
    expect(ok(await listPool(proc(), { supplierId: supplier.S2! })).filter((p) => [...a.lineIds, ...b.lineIds].includes(p.requestLineId))).toHaveLength(3)
    // taken back
    expect(ok(await assignSupplier(proc(), { requestLineIds: b.lineIds, supplierId: null }, key()))).toMatchObject({ assigned: 1 })
  })

  it('refuses an inactive or unknown supplier, a line not in the pool, nothing to change, and anyone but PROCUREMENT', async () => {
    const r = await approvedRequest()
    expect(await assignSupplier(proc(), { requestLineIds: r.lineIds, supplierId: supplier.S9! }, key())).toMatchObject({ ok: false, error: { details: { reason: 'SUPPLIER_INACTIVE' } } })
    expect(await assignSupplier(proc(), { requestLineIds: r.lineIds, supplierId: randomUUID() }, key())).toMatchObject({ ok: false, error: { details: { reason: 'SUPPLIER' } } })
    expect(await assignSupplier(proc(), { requestLineIds: r.lineIds, supplierId: null }, key())).toMatchObject({ ok: false, error: { details: { reason: 'NO_CHANGE' } } })
    for (const who of ['req_con', 'dm_con', 'fin_officer']) {
      expect(await assignSupplier(org.ctxOf(who, NOW), { requestLineIds: r.lineIds, supplierId: supplier.S1! }, key()), who).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    }
    const draft = ok(await createDraft(org.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', title: 'ร่าง', budgetLineId, lines: [{ description: 'x', quantity: '1', uom: 'ชิ้น', unitPrice: '1.00' }] }, key()))
    const draftLine = await prisma.requestLine.findFirstOrThrow({ where: { requestId: draft.requestId } })
    expect(await assignSupplier(proc(), { requestLineIds: [draftLine.id], supplierId: supplier.S1! }, key())).toMatchObject({ ok: false, error: { details: { reason: 'LINE_NOT_IN_POOL' } } })
  })
})

describe('[FR-P2P-002/AC1] [FR-P2P-002/AC3] the round groups lines into draft POs (GC-CONS-01 to GC-CONS-05 through the service)', () => {
  it('drafts one PO per (supplier, site, kind), in request-number order, keeps the source lines, and leaves lines without a supplier', async () => {
    // Clear what earlier tests left with a supplier so this round sees only these requests
    await prisma.requestLine.updateMany({ where: { request: { organizationId: org.organizationId } }, data: { supplierId: null } })
    const r1 = await approvedRequest({ site: 'SITE-A', lines: [{ quantity: '2.5', unitPrice: '10.01' }] })
    const r2 = await approvedRequest({ site: 'SITE-A', lines: [{ quantity: '3', unitPrice: '200.00' }, { quantity: '1', unitPrice: '500.00', kind: 'SERVICE' }] })
    const r3 = await approvedRequest({ site: 'SITE-B', lines: [{ quantity: '4', unitPrice: '25.00' }] })
    const waiting = await approvedRequest({ site: 'SITE-A' })
    ok(await assignSupplier(proc(), { requestLineIds: [...r2.lineIds, ...r1.lineIds, ...r3.lineIds], supplierId: supplier.S1! }, key()))

    const run = ok(await consolidateNow(proc(), key()))
    expect(run.purchaseOrderIds).toHaveLength(3)
    const [goodsA, serviceA, goodsB] = await Promise.all(run.purchaseOrderIds.map(poOf))
    // goods to SITE-A: r1 line 1 then r2 line 1 (request-number order), all that is left at the request's price
    expect(goodsA).toMatchObject({ status: 'DRAFT', number: null, supplierId: supplier.S1, deliverySiteId: site['SITE-A'], kind: 'GOODS', urgency: 'NORMAL', createdById: org.member.proc_officer, consolidationRunId: run.runId })
    expect(goodsA!.lines.map((l) => [l.quantity.toString(), l.unitPriceSatang, l.netSatang, l.budgetLineId])).toEqual([
      ['2.5', 1_001n, 2_503n, budgetLineId],
      ['3', 20_000n, 60_000n, budgetLineId],
    ])
    expect(goodsA!.lines.map((l) => l.sources.map((s) => [s.requestLineId, s.quantity.toString(), s.releasableSatang]))).toEqual([
      [[r1.lineIds[0], '2.5', 2_503n]],
      [[r2.lineIds[0], '3', 60_000n]],
    ])
    // totals from core: VAT 7% once on the document (BR-VAT-02)
    expect([goodsA!.netSatang, goodsA!.vatSatang, goodsA!.grossSatang, goodsA!.vatRateBp]).toEqual([62_503n, 4_375n, 66_878n, 700])
    expect(serviceA).toMatchObject({ kind: 'SERVICE', deliverySiteId: site['SITE-A'] })
    expect(serviceA!.lines.map((l) => l.sources[0]!.requestLineId)).toEqual([r2.lineIds[1]])
    expect(goodsB).toMatchObject({ kind: 'GOODS', deliverySiteId: site['SITE-B'] })
    // BR-CONS-03: the line without a supplier stays in the pool, marked
    expect(ok(await listPool(proc())).find((p) => p.requestLineId === waiting.lineIds[0])).toMatchObject({ needsSupplier: true })
    expect(await prisma.poLineSource.count({ where: { requestLineId: waiting.lineIds[0] } })).toBe(0)

    // the round is recorded, with an event, and each draft has its own
    expect(await prisma.consolidationRun.findUniqueOrThrow({ where: { id: run.runId } })).toMatchObject({ trigger: 'MANUAL', status: 'COMPLETED', createdPoIds: run.purchaseOrderIds, triggeredById: org.member.proc_officer })
    expect(await prisma.event.findFirstOrThrow({ where: { aggregateId: run.runId } })).toMatchObject({ type: 'consolidation_run.completed', data: { trigger: 'MANUAL', lineCount: 4 } })
    expect(await prisma.event.count({ where: { type: 'po.drafted', aggregateId: { in: run.purchaseOrderIds } } })).toBe(3)

    // lines on a draft are not in the pool and are not drafted twice
    expect(ok(await listPool(proc())).some((p) => r1.lineIds.includes(p.requestLineId))).toBe(false)
    expect(ok(await consolidateNow(proc(), key())).purchaseOrderIds).toEqual([])
    expect(await assignSupplier(proc(), { requestLineIds: r1.lineIds, supplierId: supplier.S2! }, key())).toMatchObject({ ok: false, error: { details: { reason: 'LINE_NOT_IN_POOL' } } })
  })

  it('only PROCUREMENT runs a round by hand', async () => {
    for (const who of ['req_con', 'dm_con', 'ceo']) expect(await consolidateNow(org.ctxOf(who, NOW), key()), who).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})

describe('[GC-CONS-03] an urgent request does not wait for the round (BR-CONS-02)', () => {
  it('drafts its own PO as soon as its lines get a supplier; normal lines of the same supplier and site wait', async () => {
    await prisma.requestLine.updateMany({ where: { request: { organizationId: org.organizationId }, poSources: { none: {} } }, data: { supplierId: null } })
    const urgent = await approvedRequest({ site: 'SITE-B', urgent: true })
    const normal = await approvedRequest({ site: 'SITE-B' })
    const assigned = ok(await assignSupplier(proc(), { requestLineIds: [...normal.lineIds, ...urgent.lineIds], supplierId: supplier.S2! }, key()))
    expect(assigned.purchaseOrderIds).toHaveLength(1)
    const po = await poOf(assigned.purchaseOrderIds[0]!)
    expect(po).toMatchObject({ urgency: 'URGENT', createdById: org.member.proc_officer })
    expect(po.lines.map((l) => l.sources[0]!.requestLineId)).toEqual(urgent.lineIds)
    expect(await prisma.consolidationRun.findUniqueOrThrow({ where: { id: po.consolidationRunId! } })).toMatchObject({ trigger: 'URGENT' })
    expect(ok(await listPool(proc())).some((p) => p.requestLineId === normal.lineIds[0])).toBe(true)
  })
})

describe('[FR-P2P-002/AC2] the round runs on the organization cron and is recorded once per slot', () => {
  it('runs the 10:00 round once on a business day, skips weekends and holidays, and catches up a missed slot once', async () => {
    const at = (iso: string) => new Date(iso)
    // Monday 5 Oct 2026, 10:04 Bangkok
    const first = await runScheduledConsolidation(org.organizationId, at('2026-10-05T03:04:00Z'))
    expect(first).toMatchObject({ ran: true, scheduledFor: '2026-10-05T03:00:00.000Z' })
    expect(await runScheduledConsolidation(org.organizationId, at('2026-10-05T03:09:00Z'))).toEqual({ ran: false, reason: 'NO_ROUND_DUE' })
    expect(await prisma.consolidationRun.count({ where: { organizationId: org.organizationId, trigger: 'SCHEDULED' } })).toBe(1)
    // 15:00 the same day, found at 16:20 after a pause: run once for 15:00
    expect(await runScheduledConsolidation(org.organizationId, at('2026-10-05T09:20:00Z'))).toMatchObject({ ran: true, scheduledFor: '2026-10-05T08:00:00.000Z' })
    // Saturday 10:30: the Friday 15:00 round nobody ran (within a day) runs once; Saturday itself has no round
    expect(await runScheduledConsolidation(org.organizationId, at('2026-10-10T03:30:00Z'))).toMatchObject({ ran: true, scheduledFor: '2026-10-09T08:00:00.000Z' })
    expect(await runScheduledConsolidation(org.organizationId, at('2026-10-10T08:30:00Z'))).toEqual({ ran: false, reason: 'NO_ROUND_DUE' })
    // Tuesday 13 Oct is a holiday of the calendar
    expect(await runScheduledConsolidation(org.organizationId, at('2026-10-13T03:01:00Z'))).toEqual({ ran: false, reason: 'HOLIDAY' })
    const runs = await prisma.consolidationRun.findMany({ where: { organizationId: org.organizationId, trigger: 'SCHEDULED' }, orderBy: { scheduledFor: 'asc' } })
    expect(runs.map((r) => [r.scheduledFor?.toISOString(), r.triggeredById])).toEqual([
      ['2026-10-05T03:00:00.000Z', null],
      ['2026-10-05T08:00:00.000Z', null],
      ['2026-10-09T08:00:00.000Z', null],
    ])
    expect(await prisma.event.count({ where: { type: 'consolidation_run.completed', aggregateId: { in: runs.map((r) => r.id) } } })).toBe(3)
  })
})
