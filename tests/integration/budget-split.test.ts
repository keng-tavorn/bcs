import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { fund } from '@/core/budget'
import { satangToAmount } from '@/core/money/dto'
import { applyBudget } from '@/server/budget/ledger'
import { systemCtx } from '@/server/context'
import { appendEvents } from '@/server/events/append'
import { vatFromNet } from '@/core/money/math'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { recordInvoice } from '@/server/services/invoices'
import { computeKpis } from '@/server/services/reports/kpi'
import { createP1Org } from '../support/p1-org'
import type { DoaOrg } from '../support/doa-org'
import { p2p } from '../support/p2p'
import { createDraft, editRequest, submitRequest } from '../support/requests'

// S6-17 (FR-BUD-102 · BR-BUD-16 · ADR-106 · OQ-106): a request split over budget lines against Postgres. req_con's
// request has a line of 50,000.00 on a CON line and one of 70,000.00 on an IT line granted to them: the submit reserves
// both lines at once, the DOA reads the total (120,000.00 → PR-03 to the ceo) and the request is charged to IT, which has
// the most; the event names both lines and G-4 reads them. The PO made from it keeps each line on its budget line, so
// the PO holds and the invoice spends on the right line. A line the requester may not use is refused by its line, and a
// budget line without enough reserves nothing anywhere.

const NOW = new Date('2026-10-06T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}

let org: DoaOrg
let con: string
let itLine: string
const balance = (id: string) => prisma.budgetLineBalance.findUniqueOrThrow({ where: { budgetLineId: id } })

async function fundedItLine(baht: bigint): Promise<string> {
  const fy = await prisma.fiscalYear.findFirstOrThrow({ where: { organizationId: org.organizationId, code: 'FY2569' } })
  const cc = await prisma.costCenter.findFirstOrThrow({ where: { organizationId: org.organizationId, code: 'CC-CON' } })
  const line = await prisma.budgetLine.create({ data: { organizationId: org.organizationId, fiscalYearId: fy.id, departmentId: org.department.IT!, costCenterId: cc.id, code: `IT-${randomUUID().slice(0, 8)}`, nameTh: 'งบไอที', plannedSatang: 0n } })
  await prisma.budgetLineBalance.create({ data: { organizationId: org.organizationId, budgetLineId: line.id } })
  const ctx = systemCtx(org.organizationId, NOW, 'seed')
  const importId = randomUUID()
  await forTenant(org.organizationId).$transaction(async (tx) => {
    const r = await applyBudget(tx, ctx, [{ budgetLineId: line.id, document: { type: 'IMPORT', id: importId }, run: (st) => fund(st, baht * 100n, importId) }])
    if (!r.ok) throw new Error('fund failed')
    await appendEvents(tx, ctx, r.events)
  })
  return line.id
}

async function quotes(requestId: string) {
  for (let i = 0; i < 3; i++) {
    const file = await prisma.fileObject.create({ data: { organizationId: org.organizationId, storageKey: `test/${randomUUID()}.pdf`, fileName: 'q.pdf', mimeType: 'application/pdf', sizeBytes: 1, status: 'AVAILABLE', uploadedById: org.member.req_con! } })
    await prisma.fileLink.create({ data: { organizationId: org.organizationId, fileId: file.id, subjectType: 'Request', subjectId: requestId, kind: 'QUOTATION' } })
  }
}

async function splitDraft(itLineId: string, itAmount = '70000.00') {
  return ok(
    await createDraft(
      org.ctxOf('req_con', NOW),
      {
        requestTypeCode: 'BUY_GOODS',
        title: 'อุปกรณ์สำนักงานโครงการ',
        budgetLineId: con,
        lines: [
          { description: 'โต๊ะประชุม', quantity: '1', uom: 'ชุด', unitPrice: '50000.00' },
          { description: 'เครื่องคอมพิวเตอร์', quantity: '1', uom: 'ชุด', unitPrice: itAmount, budgetLineId: itLineId },
        ],
      },
      key(),
    ),
  ).requestId
}

beforeAll(async () => {
  // PAY off: the invoice is recorded as in phase 0 (invoiceConfirmation.record); matching has its own tests in lane 2
  org = await createP1Org({ modules: [] })
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.fin_officer!, role: 'FINANCE', grantedAt: NOW } })
  con = await p2p(org, NOW).fundedLine(100_000n)
  itLine = await fundedItLine(100_000n)
  await prisma.budgetGrant.create({ data: { organizationId: org.organizationId, budgetLineId: itLine, granteeMemberId: org.member.req_con!, validFrom: new Date('2026-01-01T00:00:00Z'), grantedById: org.member.admin! } })
})

describe('[FR-BUD-102/AC1] [FR-BUD-102/AC2] [FR-BUD-102/AC3] a request split over two budget lines', () => {
  it('reserves both lines, routes on the total, is charged to IT, and its PO and invoice hold and spend on each line', async () => {
    const requestId = await splitDraft(itLine)
    await quotes(requestId)
    ok(await submitRequest(org.ctxOf('req_con', NOW), { requestId }, key()))
    expect(await balance(con)).toMatchObject({ availableSatang: 5_000_000n, reservedSatang: 5_000_000n })
    expect(await balance(itLine)).toMatchObject({ availableSatang: 3_000_000n, reservedSatang: 7_000_000n })
    const request = await prisma.request.findUniqueOrThrow({ where: { id: requestId } })
    // GC-BUD-27: IT has the most, so IT pays; the DOA reads the whole request
    expect(request).toMatchObject({ chargedDepartmentId: org.department.IT, budgetLineId: con, netSatang: 12_000_000n })
    const route = await prisma.approvalRoute.findFirstOrThrow({ where: { subjectType: 'REQUEST', subjectId: requestId } })
    expect(route.ruleCode).toBe('PR-03')
    const submitted = await prisma.event.findFirstOrThrow({ where: { type: 'request.submitted', aggregateId: requestId } })
    expect(submitted.data).toMatchObject({
      budgetCheck: { budgetLineId: con, availableSatang: '10000000', reservedSatang: '5000000' },
      budgetChecks: [
        { budgetLineId: con, availableSatang: '10000000', reservedSatang: '5000000' },
        { budgetLineId: itLine, availableSatang: '10000000', reservedSatang: '7000000' },
      ],
    })
    const kpi = await forTenant(org.organizationId).$transaction((tx) => computeKpis(tx, org.organizationId, { from: new Date(NOW.getTime() - 60_000), to: new Date(NOW.getTime() + 60_000), now: NOW }, null))
    expect(kpi.g4.tasksOnFailedBudgetCheck).toBe(0)

    // Approved and ordered: one PO line per request line, each on its own budget line (never merged across lines)
    const flow = p2p(org, NOW)
    await flow.approveAll(requestId)
    const lines = await prisma.requestLine.findMany({ where: { requestId }, orderBy: { lineNo: 'asc' } })
    const supplier = await prisma.supplier.create({ data: { organizationId: org.organizationId, code: `S-${randomUUID().slice(0, 6)}`, nameTh: 'ผู้ขายอุปกรณ์', taxId: '0999999000012' } })
    const po = await flow.approvedPo(lines.map((l) => l.id), supplier.id)
    expect(po.lines.map((l) => [l.budgetLineId, l.netSatang])).toEqual([
      [con, 5_000_000n],
      [itLine, 7_000_000n],
    ])
    expect(await balance(con)).toMatchObject({ reservedSatang: 0n, committedSatang: 5_000_000n })
    expect(await balance(itLine)).toMatchObject({ reservedSatang: 0n, committedSatang: 7_000_000n })
    // The last invoice spends on each line what its PO line held
    await prisma.purchaseOrder.update({ where: { id: po.id }, data: { status: 'SENT', sentAt: NOW } })
    ok(await recordInvoice(org.ctxOf('fin_officer', NOW), { poId: po.id, invoiceNo: 'INV-SPLIT-1', invoiceDate: '2026-10-06', net: '120000.00', vat: satangToAmount(vatFromNet(12_000_000n, 700).vat), isFinal: true }, key()))
    expect(await balance(con)).toMatchObject({ committedSatang: 0n, actualSatang: 5_000_000n })
    expect(await balance(itLine)).toMatchObject({ committedSatang: 0n, actualSatang: 7_000_000n })
  })

  it('a line on a budget line the requester may not use is refused by that line, and nothing is reserved', async () => {
    const other = await fundedItLine(100_000n)
    const requestId = await splitDraft(other)
    await quotes(requestId)
    expect(await submitRequest(org.ctxOf('req_con', NOW), { requestId }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', details: { field: 'lines.1.budgetLineId', reason: 'BUDGET_LINE_NOT_ALLOWED' } } })
    expect(await balance(other)).toMatchObject({ reservedSatang: 0n })
  })

  it('one budget line without enough: no line is reserved anywhere (all or nothing)', async () => {
    const before = await balance(con)
    const requestId = await splitDraft(itLine, '30000.01')
    await quotes(requestId)
    expect(await submitRequest(org.ctxOf('req_con', NOW), { requestId }, key())).toMatchObject({ ok: false, error: { code: 'BUDGET_INSUFFICIENT' } })
    expect(await balance(con)).toMatchObject({ availableSatang: before.availableSatang, reservedSatang: before.reservedSatang })
    expect(await prisma.budgetAllocation.count({ where: { sourceType: 'REQUEST_LINE', sourceId: { in: (await prisma.requestLine.findMany({ where: { requestId } })).map((l) => l.id) } } })).toBe(0)
  })

  it('a save that leaves the line’s budget line out keeps it; null gives the line back to the request’s', async () => {
    const requestId = await splitDraft(itLine)
    const lines = await prisma.requestLine.findMany({ where: { requestId }, orderBy: { lineNo: 'asc' } })
    ok(await editRequest(org.ctxOf('req_con', NOW), { requestId, lines: lines.map((l) => ({ id: l.id, description: l.description, quantity: l.quantity.toString(), uom: l.uom, unitPrice: satangToAmount(l.unitPriceSatang) })) }, key()))
    expect((await prisma.requestLine.findMany({ where: { requestId }, orderBy: { lineNo: 'asc' } })).map((l) => l.budgetLineId)).toEqual([null, itLine])
    ok(await editRequest(org.ctxOf('req_con', NOW), { requestId, lines: lines.map((l) => ({ id: l.id, description: l.description, quantity: l.quantity.toString(), uom: l.uom, unitPrice: satangToAmount(l.unitPriceSatang), budgetLineId: null })) }, key()))
    expect((await prisma.requestLine.findMany({ where: { requestId }, orderBy: { lineNo: 'asc' } })).map((l) => l.budgetLineId)).toEqual([null, null])
  })
})
