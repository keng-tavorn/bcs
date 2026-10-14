import { randomUUID } from 'node:crypto'
import ExcelJS from 'exceljs'
import { beforeAll, describe, expect, it } from 'vitest'
import { release, reserve, type BudgetResult, type LineState } from '@/core/budget'
import { amountToSatang, satangToAmount } from '@/core/money/dto'
import { vatFromNet } from '@/core/money/math'
import { applyBudget } from '@/server/budget/ledger'
import { systemCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { appendEvents } from '@/server/events/append'
import { budgetDashboard, type BudgetDashboardDto, type BudgetFiguresDto } from '@/server/services/budget/dashboard'
import { BUDGET_EXPORT_COLUMNS, budgetDashboardWorkbook, budgetExportRows, type BudgetExportTexts } from '@/server/services/budget/export'
import { BUDGET_MOVEMENT_LIMIT, budgetLineDetail, type BudgetLineDetailDto } from '@/server/services/budget/line-detail'
import { budgetScopeDetail } from '@/server/services/budget/scope-detail'
import { recordInvoice } from '@/server/services/invoices'
import { assignSupplier, consolidateNow } from '@/server/services/procurement'
import { editDraftPo, submitPo } from '@/server/services/purchase-orders'
import { decideTask } from '@/server/services/approvals/decide'
import { cancelRequest, createDraft, editRequest, submitRequest } from '../support/requests'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { p2p } from '../support/p2p'

// FR-BUD-005 (spec §11.2): the budget dashboard per budget line, per department and in all — planned, available,
// reserved, committed and actual, the shares used and held and the low warning — matching the ledger to the satang
// (AC1); the documents behind each amount from BudgetAllocation, with the line's ledger movements (AC2); the figures of
// a movement visible the moment it is committed (AC3); the Excel file of what the page shows. Every document is made
// through the services: requests approved, a PO approved and invoiced, a PO waiting with a price above its request.

const NOW = new Date('2026-10-05T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}
const satang = (m: { amount: string }) => amountToSatang(m.amount)

let org: DoaOrg
let flow: ReturnType<typeof p2p>
let supplierId: string
/** 100,000.00 planned: one request still reserving 8,000.00, one PO holding 13,000.00 with 5,000.00 invoiced */
let mainLine: string
let reservedRequest: { id: string; number: string | null }
let po: { id: string; number: string | null }

beforeAll(async () => {
  org = await createDoaOrg()
  flow = p2p(org, NOW)
  const organizationId = org.organizationId
  supplierId = (await prisma.supplier.create({ data: { organizationId, code: 'S1', nameTh: 'ผู้ขายหนึ่ง', taxId: '0999999000012' } })).id
  await prisma.roleAssignment.createMany({
    data: [
      { organizationId, memberId: org.member.fin_officer!, role: 'FINANCE', grantedAt: NOW },
      { organizationId, memberId: org.member.auditor!, role: 'AUDITOR', grantedAt: NOW },
      { organizationId, memberId: org.member.ceo!, role: 'EXECUTIVE', grantedAt: NOW },
      // A budget administrator who is not FINANCE: may see every line, but not open requests or POs (§2.4)
      { organizationId, memberId: org.member.admin2!, role: 'BUDGET_ADMIN', grantedAt: NOW },
    ],
  })

  mainLine = await flow.fundedLine(100_000n)
  const a = await flow.approvedRequest(mainLine, [{ quantity: '2', unitPrice: '4000.00' }])
  reservedRequest = { id: a.id, number: a.number }
  const b = await flow.approvedRequest(mainLine, [
    { quantity: '1', unitPrice: '15000.00' },
    { quantity: '3', unitPrice: '1000.00' },
  ])
  const approved = await flow.approvedPo(
    b.lines.map((l) => l.id),
    supplierId,
  )
  po = { id: approved.id, number: approved.number }
  // Sent to the supplier (the sending itself is tested in po-send.test.ts), then one invoice of 5,000.00 before VAT
  await prisma.purchaseOrder.update({ where: { id: po.id }, data: { status: 'SENT', sentAt: NOW } })
  ok(await recordInvoice(org.ctxOf('fin_officer', NOW), { poId: po.id, invoiceNo: 'INV-BUD-1', invoiceDate: '2026-10-05', net: '5000.00', vat: satangToAmount(vatFromNet(500_000n, 700).vat) }, key()))
}, 120_000)

/** What the ledger says each bucket of these lines holds: the sum of every movement into it minus every movement out */
async function ledgerOf(lineIds: readonly string[]) {
  const entries = await prisma.budgetLedgerEntry.findMany({ where: { organizationId: org.organizationId, budgetLineId: { in: [...lineIds] } }, select: { fromBucket: true, toBucket: true, amountSatang: true } })
  const bucket = (b: string) => entries.reduce((sum, e) => sum + (e.toBucket === b ? e.amountSatang : 0n) - (e.fromBucket === b ? e.amountSatang : 0n), 0n)
  const imported = entries.filter((e) => e.fromBucket === 'OUTSIDE').reduce((sum, e) => sum + e.amountSatang, 0n)
  return { planned: imported, available: bucket('AVAILABLE'), reserved: bucket('RESERVED'), committed: bucket('COMMITTED'), actual: bucket('ACTUAL') }
}

const shown = (f: BudgetFiguresDto) => ({ planned: satang(f.planned), available: satang(f.available), reserved: satang(f.reserved), committed: satang(f.committed), actual: satang(f.actual) })
/** The figures alone, without what names the line or department they belong to */
const figuresOf = ({ planned, available, reserved, committed, actual, usedBp, heldBp, availableBp, low }: BudgetFiguresDto): BudgetFiguresDto => ({ planned, available, reserved, committed, actual, usedBp, heldBp, availableBp, low })
const sumOf = (docs: ReadonlyArray<{ amount: { amount: string } }>) => docs.reduce((total, d) => total + satang(d.amount), 0n)

/** Movements written straight through the ledger, as the services would, for a document that is not built here */
async function throughLedger(operations: ReadonlyArray<{ budgetLineId: string; run: (s: LineState) => BudgetResult }>) {
  const ctx = systemCtx(org.organizationId, NOW, 'seed')
  const requestId = randomUUID()
  await forTenant(org.organizationId).$transaction(async (tx) => {
    const r = await applyBudget(tx, ctx, operations.map((o) => ({ ...o, document: { type: 'REQUEST' as const, id: requestId } })))
    if (!r.ok) throw new Error(r.error.code)
    await appendEvents(tx, ctx, r.events)
  })
}

describe('[FR-BUD-005/AC1] the dashboard shows each line, each department and the total as the ledger has them, to the satang', () => {
  let dashboard: BudgetDashboardDto
  beforeAll(async () => {
    dashboard = ok(await budgetDashboard(org.ctxOf('fin_officer', NOW)))
  })

  it('shows the line with documents in every bucket with its amounts, shares and no warning', () => {
    const line = dashboard.lines.find((l) => l.id === mainLine)!
    expect({ ...line, ...shown(line) }).toMatchObject({
      planned: 10_000_000n,
      reserved: 800_000n,
      committed: 1_300_000n,
      actual: 500_000n,
      available: 7_400_000n,
      // used = (13,000 + 5,000) ÷ 100,000 · held = (8,000 + 13,000 + 5,000) ÷ 100,000 · left = 74,000 ÷ 100,000
      usedBp: 1_800,
      heldBp: 2_600,
      availableBp: 7_400,
      low: false,
    })
  })

  it('matches the ledger on every line, every department and in all', async () => {
    expect(dashboard.scope).toBe('ORG')
    for (const line of dashboard.lines) expect(shown(line), line.code).toEqual(await ledgerOf([line.id]))
    for (const department of dashboard.departments) {
      expect(shown(department), department.code).toEqual(await ledgerOf(dashboard.lines.filter((l) => l.departmentId === department.id).map((l) => l.id)))
    }
    expect(shown(dashboard.total)).toEqual(await ledgerOf(dashboard.lines.map((l) => l.id)))
    // Every line of the fiscal year is there, and no other
    const lines = await prisma.budgetLine.findMany({ where: { organizationId: org.organizationId, fiscalYear: { code: 'FY2569' } }, select: { id: true } })
    expect(dashboard.lines.map((l) => l.id).sort()).toEqual(lines.map((l) => l.id).sort())
  })

  it('says when the figures were read, and lets only BUDGET_ADMIN on to the import and the grants', async () => {
    expect(dashboard.asOf).toBe(NOW.toISOString())
    expect(dashboard.can).toEqual({ import: false, manageGrants: false })
    expect(ok(await budgetDashboard(org.ctxOf('admin2', NOW))).can).toEqual({ import: true, manageGrants: true })
  })
})

describe('[FR-BUD-005/AC1] the low warning starts below digest.budgetLowPct of the planned amount', () => {
  it('flags a line with 5 % left, not one with exactly 10 % left (the demo threshold)', async () => {
    const low = await flow.fundedLine(10_000n)
    await flow.approvedRequest(low, [{ quantity: '1', unitPrice: '9500.00' }])
    const edge = await flow.fundedLine(10_000n)
    await flow.approvedRequest(edge, [{ quantity: '1', unitPrice: '9000.00' }])
    const dashboard = ok(await budgetDashboard(org.ctxOf('fin_officer', NOW)))
    expect(dashboard.lowPct).toBe(10)
    expect(dashboard.lines.find((l) => l.id === low)).toMatchObject({ low: true, availableBp: 500, available: { amount: '500.00' } })
    expect(dashboard.lines.find((l) => l.id === edge)).toMatchObject({ low: false, availableBp: 1_000, available: { amount: '1000.00' } })
  })

  it('rounds the share left down, so a line below the threshold never reads as at it (9.996 % left reads 9.99 %)', async () => {
    const line = await flow.fundedLine(10_000n)
    await flow.approvedRequest(line, [{ quantity: '1', unitPrice: '9000.40' }])
    const dashboard = ok(await budgetDashboard(org.ctxOf('fin_officer', NOW)))
    expect(dashboard.lines.find((l) => l.id === line)).toMatchObject({ low: true, availableBp: 999, available: { amount: '999.60' } })
  })

  it('flags a department, and the total of a head’s departments, when their lines added up run low', async () => {
    // PROC's only line of 10,000,000.00 held down to 50,000.00 (0.5 % left), then given back
    const procLine = (await prisma.budgetLine.findFirstOrThrow({ where: { organizationId: org.organizationId, code: 'PROC-OPEX-2569' } })).id
    const requestLineId = randomUUID()
    await throughLedger([{ budgetLineId: procLine, run: (s) => reserve(s, [{ requestLineId, amount: 995_000_000n }]) }])
    try {
      const dashboard = ok(await budgetDashboard(org.ctxOf('fin_officer', NOW)))
      expect(dashboard.departments.find((d) => d.code === 'PROC')).toMatchObject({ low: true, availableBp: 50, available: { amount: '50000.00' } })
      expect(dashboard.departments.find((d) => d.code === 'CON')).toMatchObject({ low: false })
      expect(ok(await budgetScopeDetail(org.ctxOf('fin_officer', NOW), { departmentId: org.department.PROC! })).figures).toMatchObject({ low: true, availableBp: 50 })
      const head = ok(await budgetDashboard(org.ctxOf('dm_proc', NOW)))
      expect(head).toMatchObject({ scope: 'DEPT', total: { low: true } })
    } finally {
      await throughLedger([{ budgetLineId: procLine, run: (s) => release(s, [requestLineId]) }])
    }
  })
})

describe('[FR-BUD-005/AC1] who sees which lines (budget.view)', () => {
  it('an organization role sees every line; a department head the lines of the departments they head', async () => {
    for (const code of ['ceo', 'auditor', 'admin2']) expect(ok(await budgetDashboard(org.ctxOf(code, NOW))).scope, code).toBe('ORG')
    const con = ok(await budgetDashboard(org.ctxOf('dm_con', NOW)))
    expect(con.scope).toBe('DEPT')
    expect(new Set(con.lines.map((l) => l.departmentId))).toEqual(new Set([org.department.CON]))
    expect(con.lines.map((l) => l.id)).toContain(mainLine)
    // The VP heads the division and the departments under it
    const ops = ok(await budgetDashboard(org.ctxOf('vp_ops', NOW)))
    expect(new Set(ops.departments.map((d) => d.code))).toEqual(new Set(['OPS', 'CON', 'PROC']))
    expect(ok(await budgetDashboard(org.ctxOf('dm_it', NOW))).lines.map((l) => l.id)).not.toContain(mainLine)
  })

  it('refuses a requester, and a fiscal year the organization does not have', async () => {
    expect(await budgetDashboard(org.ctxOf('req_con', NOW))).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await budgetDashboard(org.ctxOf('fin_officer', NOW), { fiscalYearId: randomUUID() })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    const year = await prisma.fiscalYear.findFirstOrThrow({ where: { organizationId: org.organizationId, code: 'FY2569' } })
    expect(ok(await budgetDashboard(org.ctxOf('fin_officer', NOW), { fiscalYearId: year.id })).fiscalYear).toMatchObject({ code: 'FY2569', startsOn: '2026-01-01', endsOn: '2026-12-31' })
  })
})

describe('[FR-BUD-005/AC3] a movement shows on the dashboard as soon as it is committed', () => {
  it('a request sent now is in the reserved amount of the next read, with no delay', async () => {
    const before = ok(await budgetDashboard(org.ctxOf('fin_officer', NOW))).lines.find((l) => l.id === mainLine)!
    const draft = ok(await createDraft(org.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', title: 'เพิ่มทีหลัง', budgetLineId: mainLine, lines: [{ description: 'ของ', quantity: '1', uom: 'ชิ้น', unitPrice: '1234.56' }] }, key()))
    ok(await submitRequest(org.ctxOf('req_con', NOW), { requestId: draft.requestId }, key()))
    const after = ok(await budgetDashboard(org.ctxOf('fin_officer', NOW))).lines.find((l) => l.id === mainLine)!
    expect(satang(after.reserved) - satang(before.reserved)).toBe(123_456n)
    expect(satang(before.available) - satang(after.available)).toBe(123_456n)
    // Taken back again, so the other tests see the line as it was
    ok(await cancelRequest(org.ctxOf('req_con', NOW), { requestId: draft.requestId, reason: 'ทดสอบเสร็จ' }, key()))
    expect(shown(ok(await budgetDashboard(org.ctxOf('fin_officer', NOW))).lines.find((l) => l.id === mainLine)!)).toEqual(shown(before))
  })
})

describe('[FR-BUD-005/AC2] the documents behind each amount of a line, and its movements', () => {
  let detail: BudgetLineDetailDto
  beforeAll(async () => {
    detail = ok(await budgetLineDetail(org.ctxOf('fin_officer', NOW), mainLine))
  })

  it('lists the request that reserves, the PO that holds and the PO with its invoice, adding up to the line', () => {
    expect(detail.reserved.requests).toEqual([expect.objectContaining({ id: reservedRequest.id, number: reservedRequest.number, status: 'APPROVED', amount: { amount: '8000.00', currency: 'THB' }, canOpen: true })])
    expect(detail.reserved.requests[0]!.number).toMatch(/^PR-\d{4}-\d{5}$/)
    expect(detail.reserved.purchaseOrders).toEqual([])
    expect(detail.committed.purchaseOrders).toEqual([expect.objectContaining({ id: po.id, number: po.number, status: 'SENT', supplier: { th: 'ผู้ขายหนึ่ง', en: null }, amount: { amount: '13000.00', currency: 'THB' }, canOpen: true })])
    expect(detail.actual.purchaseOrders).toEqual([
      expect.objectContaining({ id: po.id, amount: { amount: '5000.00', currency: 'THB' }, invoices: [expect.objectContaining({ invoiceNo: 'INV-BUD-1', invoiceDate: '2026-10-05', amount: { amount: '5000.00', currency: 'THB' } })] }),
    ])
    // Each section adds up to the line's own amount
    expect([detail.reserved.total, detail.committed.total, detail.actual.total]).toEqual([detail.line.reserved, detail.line.committed, detail.line.actual])
    expect(detail.line).toMatchObject({ code: expect.stringMatching(/^CON-/), status: 'OPEN', fiscalYear: { code: 'FY2569' }, department: { code: 'CON' }, costCenter: { code: 'CC-CON' }, low: false })
  })

  it('lists the movements of the line newest first, each with the document that moved the money', async () => {
    const entries = await prisma.budgetLedgerEntry.findMany({ where: { budgetLineId: mainLine }, orderBy: { seq: 'desc' } })
    expect(detail.movements.total).toBe(entries.length)
    expect(detail.movements.rows.map((m) => [m.seq, m.from, m.to, m.amount.amount])).toEqual(entries.map((e) => [e.seq, e.fromBucket, e.toBucket, satangToAmount(e.amountSatang)]))
    // The invoice is shared over the PO's two lines (BR-IVC-04): two movements to actual, both naming the PO
    const actualized = detail.movements.rows.filter((m) => m.kind === 'ACTUALIZED')
    expect(actualized.reduce((sum, m) => sum + satang(m.amount), 0n)).toBe(500_000n)
    for (const m of actualized) expect(m.document).toEqual({ type: 'PURCHASE_ORDER', id: po.id, label: po.number, canOpen: true })
    expect(detail.movements.rows.at(-1)).toMatchObject({ kind: 'IMPORTED', amount: { amount: '100000.00' }, document: { type: 'IMPORT', canOpen: false } })
    expect(detail.movements.rows.filter((m) => m.kind === 'RESERVED').map((m) => m.document)).toContainEqual({ type: 'REQUEST', id: reservedRequest.id, label: reservedRequest.number, canOpen: true })
  })

  it('shows the extra a PO waiting for approval reserves above its request (BR-BUD-05)', async () => {
    const line = await flow.fundedLine(50_000n)
    const request = await flow.approvedRequest(line, [{ quantity: '10', unitPrice: '1000.00' }])
    const site = await prisma.deliverySite.create({ data: { organizationId: org.organizationId, code: `SITE-${randomUUID().slice(0, 8)}`, nameTh: 'ไซต์', address: 'ถนนทดสอบ' } })
    await prisma.request.update({ where: { id: request.id }, data: { deliverySiteId: site.id } })
    const proc = org.ctxOf('proc_officer', NOW)
    ok(await assignSupplier(proc, { requestLineIds: request.lines.map((l) => l.id), supplierId }, key()))
    const run = ok(await consolidateNow(proc, key()))
    const draft = await prisma.purchaseOrder.findFirstOrThrow({ where: { id: { in: [...run.purchaseOrderIds] }, deliverySiteId: site.id }, include: { lines: true } })
    ok(await editDraftPo(proc, { poId: draft.id, expectedVersion: draft.version, lines: [{ poLineId: draft.lines[0]!.id, unitPrice: '1100.00' }] }, key()))
    ok(await submitPo(proc, { poId: draft.id }, key()))
    const waiting = ok(await budgetLineDetail(org.ctxOf('fin_officer', NOW), line))
    expect(waiting.reserved.requests.map((r) => [r.id, r.amount.amount])).toEqual([[request.id, '10000.00']])
    expect(waiting.reserved.purchaseOrders.map((p) => [p.id, p.status, p.amount.amount])).toEqual([[draft.id, 'PENDING_APPROVAL', '1000.00']])
    expect(waiting.reserved.total).toEqual(waiting.line.reserved)
    expect(waiting.line.reserved.amount).toBe('11000.00')
  })

  it('keeps the movements of a line removed from a returned request under that request', async () => {
    const line = await flow.fundedLine(50_000n)
    const draft = ok(
      await createDraft(
        org.ctxOf('req_con', NOW),
        { requestTypeCode: 'BUY_GOODS', title: 'สองรายการ', budgetLineId: line, lines: [{ description: 'ปูน', quantity: '1', uom: 'งาน', unitPrice: '10000.00' }, { description: 'ทราย', quantity: '1', uom: 'งาน', unitPrice: '5000.00' }] },
        key(),
      ),
    )
    const sent = ok(await submitRequest(org.ctxOf('req_con', NOW), { requestId: draft.requestId }, key()))
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: draft.requestId } } } })
    const assignee = Object.entries(org.member).find(([, id]) => id === task.assigneeMemberId)![0]
    ok(await decideTask(org.ctxOf(assignee, NOW), { taskId: task.id, decision: 'RETURN', reason: 'ตัดรายการทราย' }, key()))
    ok(await editRequest(org.ctxOf('req_con', NOW), { requestId: draft.requestId, title: 'รายการเดียว', budgetLineId: line, lines: [{ description: 'ปูน', quantity: '1', uom: 'งาน', unitPrice: '10000.00' }] }, key()))
    const detail = ok(await budgetLineDetail(org.ctxOf('fin_officer', NOW), line))
    expect(detail.reserved.requests.map((r) => [r.id, r.status, r.amount.amount])).toEqual([[draft.requestId, 'RETURNED', '10000.00']])
    // The removed line's row is gone; its reservation and its release still name the request
    const released = detail.movements.rows.find((m) => m.kind === 'RESERVATION_RELEASED')!
    expect(released).toMatchObject({ amount: { amount: '5000.00' }, document: { type: 'REQUEST', id: draft.requestId, label: sent.number, canOpen: true } })
    expect(detail.movements.rows.filter((m) => m.kind === 'RESERVED').map((m) => m.document.id)).toEqual([draft.requestId, draft.requestId])
  })

  it('links a document only for a viewer who may open it, and names the requester only then', async () => {
    // BUDGET_ADMIN alone may not open requests or POs; the head of CON may open CON's requests but not its POs
    // A viewer who may not open a document sees its number, status and amount only: no title, requester or supplier
    const budgetOnly = ok(await budgetLineDetail(org.ctxOf('admin2', NOW), mainLine))
    expect(budgetOnly.reserved.requests[0]).toMatchObject({ number: reservedRequest.number, status: 'APPROVED', amount: { amount: '8000.00' }, canOpen: false, requester: null, title: null })
    expect(budgetOnly.committed.purchaseOrders[0]).toMatchObject({ number: po.number, status: 'SENT', amount: { amount: '13000.00' }, canOpen: false, supplier: null })
    expect(budgetOnly.actual.purchaseOrders[0]).toMatchObject({ canOpen: false, supplier: null, invoices: [expect.objectContaining({ invoiceNo: 'INV-BUD-1' })] })
    const head = ok(await budgetLineDetail(org.ctxOf('dm_con', NOW), mainLine))
    expect(head.reserved.requests[0]).toMatchObject({ canOpen: true, requester: { th: 'ผู้ใช้ req_con' }, title: 'วัสดุ' })
    expect(head.committed.purchaseOrders[0]).toMatchObject({ canOpen: false, supplier: null })
    expect(detail.committed.purchaseOrders[0]).toMatchObject({ canOpen: true, supplier: { th: 'ผู้ขายหนึ่ง' } })
  })

  it('lists every import behind the planned amount, even when the line has more movements than are shown', async () => {
    const line = await flow.fundedLine(10_000n)
    // 50 reservations given back again: 100 movements after the import
    const requestLineIds = Array.from({ length: 50 }, () => randomUUID())
    await throughLedger(
      requestLineIds.flatMap((id) => [
        { budgetLineId: line, run: (s: LineState) => reserve(s, [{ requestLineId: id, amount: 100n }]) },
        { budgetLineId: line, run: (s: LineState) => release(s, [id]) },
      ]),
    )
    const many = ok(await budgetLineDetail(org.ctxOf('fin_officer', NOW), line))
    expect(many.movements.total).toBe(101)
    expect(many.movements.rows).toHaveLength(BUDGET_MOVEMENT_LIMIT)
    // The import is older than the movements shown, yet the planned amount still leads to it
    expect(many.movements.rows.some((m) => m.kind === 'IMPORTED')).toBe(false)
    expect(many.planned).toMatchObject({ count: 1, total: { amount: '10000.00' }, imports: [{ fileName: null, amount: { amount: '10000.00' }, lines: [{ id: line }] }] })
    expect(many.planned.total).toEqual(many.line.planned)
    expect(many.reserved).toMatchObject({ requests: [], requestCount: 0, total: { amount: '0.00' } })
  })

  it('lists the imports behind the main line', () => {
    expect(detail.planned.imports).toEqual([expect.objectContaining({ amount: { amount: '100000.00', currency: 'THB' }, lines: [{ id: mainLine, code: detail.line.code }] })])
    expect(detail.planned.total).toEqual(detail.line.planned)
  })

  it('refuses whoever may not see the line, and a line that is not there', async () => {
    expect(await budgetLineDetail(org.ctxOf('req_con', NOW), mainLine)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await budgetLineDetail(org.ctxOf('dm_it', NOW), mainLine)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await budgetLineDetail(org.ctxOf('fin_officer', NOW), randomUUID())).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await budgetLineDetail(org.ctxOf('fin_officer', NOW), 'not-a-line')).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    // A line of another organization is not there either (tenant isolation)
    const other = await createDoaOrg()
    const otherLine = await prisma.budgetLine.findFirstOrThrow({ where: { organizationId: other.organizationId } })
    expect(await budgetLineDetail(org.ctxOf('fin_officer', NOW), otherLine.id)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })
})

describe('[FR-BUD-005/AC1] the Excel file holds what the dashboard shows', () => {
  const texts: BudgetExportTexts = {
    sheetName: 'งบประมาณ',
    heading: ['งบประมาณ ปีงบ FY2569', 'ทั้งองค์กร'],
    headers: Object.fromEntries(BUDGET_EXPORT_COLUMNS.map((c) => [c, c])) as BudgetExportTexts['headers'],
    kinds: { line: 'บรรทัดงบ', department: 'รวมแผนก', total: 'รวมทั้งหมด' },
    status: { OPEN: 'เปิดใช้', FROZEN: 'ระงับชั่วคราว', CLOSED: 'ปิดแล้ว' },
    low: 'ใกล้หมด',
    departmentName: (d) => d.nameTh,
  }

  it('each department total, then its lines, then the total, with the amounts as exact text', async () => {
    const dashboard = ok(await budgetDashboard(org.ctxOf('fin_officer', NOW)))
    const rows = budgetExportRows(dashboard, texts)
    expect(rows).toHaveLength(dashboard.departments.length + dashboard.lines.length + 1)
    expect(rows.at(-1)).toMatchObject({ kind: 'รวมทั้งหมด', planned: dashboard.total.planned.amount, available: dashboard.total.available.amount })
    const line = dashboard.lines.find((l) => l.id === mainLine)!
    expect(rows.find((r) => r.lineCode === line.code)).toMatchObject({ kind: 'บรรทัดงบ', departmentCode: 'CON', planned: '100000.00', available: '74000.00', reserved: '8000.00', committed: '13000.00', actual: '5000.00', usedPct: '18.00', heldPct: '26.00', availablePct: '74.00', low: '' })

    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(new Uint8Array(await budgetDashboardWorkbook(dashboard, texts)).buffer as ArrayBuffer)
    const sheet = workbook.getWorksheet('งบประมาณ')!
    // Every column of the row, an empty cell as ''
    const values = (r: number) => {
      const cells = (sheet.getRow(r).values as unknown[]).slice(1)
      return BUDGET_EXPORT_COLUMNS.map((_, i) => (cells[i] === undefined || cells[i] === null ? '' : cells[i]))
    }
    const header = [...Array(sheet.rowCount).keys()].map((i) => i + 1).find((r) => values(r)[0] === 'kind')!
    expect(values(header)).toEqual([...BUDGET_EXPORT_COLUMNS])
    const body = [...Array(sheet.rowCount - header).keys()].map((i) => values(header + 1 + i))
    expect(body).toEqual(rows.map((r) => BUDGET_EXPORT_COLUMNS.map((c) => r[c])))
  })
})

describe('[FR-BUD-005/AC2] the documents behind a department’s total and behind the total of everything shown', () => {
  it('a department: every section adds up to the department’s amounts on the dashboard, each document naming its line', async () => {
    const dashboard = ok(await budgetDashboard(org.ctxOf('fin_officer', NOW)))
    const con = dashboard.departments.find((d) => d.code === 'CON')!
    const conLines = new Set(dashboard.lines.filter((l) => l.departmentId === con.id).map((l) => l.id))
    const detail = ok(await budgetScopeDetail(org.ctxOf('fin_officer', NOW), { departmentId: con.id }))
    expect(detail).toMatchObject({ kind: 'DEPARTMENT', scope: 'ORG', department: { code: 'CON' }, fiscalYear: { code: 'FY2569' }, lineCount: conLines.size, departmentCount: 1 })
    expect(figuresOf(detail.figures)).toEqual(figuresOf(con))
    expect([detail.planned.total, detail.reserved.total, detail.committed.total, detail.actual.total]).toEqual([con.planned, con.reserved, con.committed, con.actual])
    // The request reserving on the main line, the PO holding it and its invoice, each naming the line
    const main = { id: mainLine, code: dashboard.lines.find((l) => l.id === mainLine)!.code }
    expect(detail.reserved.requests).toContainEqual(expect.objectContaining({ id: reservedRequest.id, amount: { amount: '8000.00', currency: 'THB' }, lines: [main] }))
    expect(detail.committed.purchaseOrders).toContainEqual(expect.objectContaining({ id: po.id, amount: { amount: '13000.00', currency: 'THB' }, lines: [main] }))
    expect(detail.actual.purchaseOrders).toContainEqual(expect.objectContaining({ id: po.id, lines: [main], invoices: [expect.objectContaining({ invoiceNo: 'INV-BUD-1' })] }))
    // Every document is listed (fewer than the limit) and they add up to each section, the largest first
    expect(detail.reserved.requests.length + detail.reserved.purchaseOrders.length).toBe(detail.reserved.requestCount + detail.reserved.purchaseOrderCount)
    expect(sumOf([...detail.reserved.requests, ...detail.reserved.purchaseOrders])).toBe(satang(detail.reserved.total))
    expect(sumOf(detail.committed.purchaseOrders)).toBe(satang(detail.committed.total))
    expect(sumOf(detail.actual.purchaseOrders)).toBe(satang(detail.actual.total))
    expect(sumOf(detail.planned.imports)).toBe(satang(detail.planned.total))
    const amounts = detail.reserved.requests.map((r) => satang(r.amount))
    expect(amounts).toEqual([...amounts].sort((a, b) => (a === b ? 0 : a > b ? -1 : 1)))
    // The movements of the department's lines only, each naming its line
    expect(detail.movements.total).toBe(await prisma.budgetLedgerEntry.count({ where: { budgetLineId: { in: [...conLines] } } }))
    for (const m of detail.movements.rows) expect(conLines.has(m.line.id), m.line.code).toBe(true)
    // IT's page holds IT's documents only
    const it = ok(await budgetScopeDetail(org.ctxOf('fin_officer', NOW), { departmentId: org.department.IT! }))
    expect(it.reserved.requests.map((r) => r.id)).not.toContain(reservedRequest.id)
    expect(it.movements.rows.every((m) => !conLines.has(m.line.id))).toBe(true)
  })

  it('the total: everything the viewer may see — the whole organization, or the departments a head heads', async () => {
    const dashboard = ok(await budgetDashboard(org.ctxOf('fin_officer', NOW)))
    const total = ok(await budgetScopeDetail(org.ctxOf('fin_officer', NOW), {}))
    expect(total).toMatchObject({ kind: 'TOTAL', scope: 'ORG', department: null, lineCount: dashboard.lines.length, departmentCount: dashboard.departments.length })
    expect(figuresOf(total.figures)).toEqual(figuresOf(dashboard.total))
    expect([total.planned.total, total.reserved.total, total.committed.total, total.actual.total]).toEqual([dashboard.total.planned, dashboard.total.reserved, dashboard.total.committed, dashboard.total.actual])
    expect(total.movements.total).toBe(await prisma.budgetLedgerEntry.count({ where: { budgetLineId: { in: dashboard.lines.map((l) => l.id) } } }))
    expect(total.reserved.requests.map((r) => r.id)).toContain(reservedRequest.id)
    // A head's total is the departments they head
    const headDashboard = ok(await budgetDashboard(org.ctxOf('dm_con', NOW)))
    const head = ok(await budgetScopeDetail(org.ctxOf('dm_con', NOW), {}))
    expect(head).toMatchObject({ kind: 'TOTAL', scope: 'DEPT', lineCount: headDashboard.lines.length })
    expect(figuresOf(head.figures)).toEqual(figuresOf(headDashboard.total))
    const headLines = new Set(headDashboard.lines.map((l) => l.id))
    for (const doc of [...head.reserved.requests, ...head.committed.purchaseOrders, ...head.actual.purchaseOrders]) for (const l of doc.lines) expect(headLines.has(l.id)).toBe(true)
  })

  it('refuses a head of another department and a requester, and finds no department or year that is not there', async () => {
    expect(await budgetScopeDetail(org.ctxOf('dm_it', NOW), { departmentId: org.department.CON! })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(ok(await budgetScopeDetail(org.ctxOf('dm_it', NOW), { departmentId: org.department.IT! }))).toMatchObject({ kind: 'DEPARTMENT', scope: 'DEPT', department: { code: 'IT' } })
    for (const input of [{ departmentId: org.department.CON! }, {}]) {
      expect(await budgetScopeDetail(org.ctxOf('req_con', NOW), input)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    }
    // Refused before anything about the input is looked at
    expect(await budgetScopeDetail(org.ctxOf('req_con', NOW), { departmentId: 'not-a-department' })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await budgetScopeDetail(org.ctxOf('fin_officer', NOW), { departmentId: randomUUID() })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await budgetScopeDetail(org.ctxOf('fin_officer', NOW), { departmentId: 'not-a-department' })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await budgetScopeDetail(org.ctxOf('fin_officer', NOW), { fiscalYearId: randomUUID() })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    // Another organization's department is not there either (tenant isolation)
    const other = await createDoaOrg()
    expect(await budgetScopeDetail(org.ctxOf('fin_officer', NOW), { departmentId: other.department.CON! })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })
})

describe('[FR-BUD-005/AC1] today, and so the fiscal year shown, is in the organization’s time zone (Organization.timezone)', () => {
  it('at 01:00 on 1 January 2027 in Bangkok, still 31 December in UTC, the dashboard shows FY2570', async () => {
    await prisma.fiscalYear.create({ data: { organizationId: org.organizationId, code: 'FY2570', startsOn: new Date('2027-01-01T00:00:00Z'), endsOn: new Date('2027-12-31T00:00:00Z') } })
    // The settings say UTC; the column that grants, delegations and holidays read says Bangkok: the column decides
    const before = (await prisma.organization.findUniqueOrThrow({ where: { id: org.organizationId }, select: { settings: true, timezone: true } })) as { settings: Record<string, unknown>; timezone: string }
    expect(before.timezone).toBe('Asia/Bangkok')
    await prisma.organization.update({ where: { id: org.organizationId }, data: { settings: { ...before.settings, timezone: 'UTC' } as object } })
    try {
      expect(ok(await budgetDashboard(org.ctxOf('fin_officer', new Date('2026-12-31T18:00:00Z')))).fiscalYear).toMatchObject({ code: 'FY2570' })
      expect(ok(await budgetDashboard(org.ctxOf('fin_officer', new Date('2026-12-31T16:59:59Z')))).fiscalYear).toMatchObject({ code: 'FY2569' })
    } finally {
      await prisma.organization.update({ where: { id: org.organizationId }, data: { settings: before.settings as object } })
    }
  })
})
