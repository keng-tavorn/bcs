import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { listMyTasks } from '@/server/queries/tasks'
import { decideTask } from '@/server/services/approvals/decide'
import { budgetDashboard } from '@/server/services/budget/dashboard'
import { getBudgetOverrun, getRequestOverruns } from '@/server/services/budget/overrun-view'
import { cancelBudgetOverrun, runOverrunLapse, submitBudgetOverrun } from '@/server/services/budget/overruns'
import { assignSupplier, consolidateNow } from '@/server/services/procurement'
import { submitPo } from '@/server/services/purchase-orders'
import { computeKpis } from '@/server/services/reports/kpi'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { createP1Org } from '../support/p1-org'
import { p2p } from '../support/p2p'
import { stepUpForTask } from '../support/pin'
import { cancelRequest, createDraft, editRequest, submitRequest } from '../support/requests'

// S6-16 (FR-BUD-101 · BR-BUD-12 to BR-BUD-15, BR-BUD-18 · ADR-105 · OQ-104): over-budget approval against Postgres. On
// the phase-1 fixture (DOA-P1 has OB-01 VP up to 50,000.00 · OB-02 CFO up to 500,000.00 · OB-03 CEO): a CON line of
// 100,000.00 with 90,000.00 reserved by an approved request leaves 10,000.00. req_con's request of 70,000.00 is refused
// for budget; they ask for the 60,000.00 short, which goes to the cfo under OB-02 — the request is locked meanwhile, the
// requester never decides it, and the cfo reads the source request (and no other). Approved, the 60,000.00 is funded and
// earmarked; the submit uses it, so the budget check passes and G-4 stays 0; the request rejected afterwards takes the
// 60,000.00 back out of the line (BR-BUD-18). Approved overruns not used go back when their request is cancelled or at
// lapsesAt (with a reminder two days before). A PO line from such a request never merges another request's line. On the
// demo fixture (no OVER_BUDGET rule) no button shows and asking is DOA_NOT_CONFIGURED.

const NOW = new Date('2026-10-06T03:00:00Z')
const DAY = 86_400_000
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}

let org: DoaOrg
let con: string
let earlier: string
const balance = (id: string) => prisma.budgetLineBalance.findUniqueOrThrow({ where: { budgetLineId: id } })
const planned = async (id: string) => (await prisma.budgetLine.findUniqueOrThrow({ where: { id } })).plannedSatang
const overrun = (id: string) => prisma.budgetOverrun.findUniqueOrThrow({ where: { id } })
const openTask = (subjectId: string) => prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId } } }, include: { step: { include: { route: true } } } })

async function draft(o: DoaOrg, code: string, budgetLineId: string, unitPrice: string, title = 'งานเปิดตัวโครงการ') {
  return ok(await createDraft(o.ctxOf(code, NOW), { requestTypeCode: 'BUY_GOODS', title, budgetLineId, lines: [{ description: title, quantity: '1', uom: 'งาน', unitPrice }] }, key())).requestId
}

/** Asks for the shortfall of `requestId` and has the approver of its route approve it */
async function approvedOverrun(requestId: string, at = NOW) {
  const asked = ok(await submitBudgetOverrun(org.ctxOf('req_con', at), { requestId, reason: 'งานเร่งด่วนต้องจัดก่อนสิ้นเดือน' }, key()))
  const task = await openTask(asked.overrunId)
  const code = Object.entries(org.member).find(([, id]) => id === task.assigneeMemberId)![0]
  await stepUpForTask(task.id, task.assigneeMemberId)
  ok(await decideTask(org.ctxOf(code, at), { taskId: task.id, decision: 'APPROVE' }, key()))
  return asked
}

beforeAll(async () => {
  org = await createP1Org()
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.fin_officer!, role: 'BUDGET_ADMIN', grantedAt: NOW } })
  con = await p2p(org, NOW).fundedLine(100_000n)
  earlier = (await p2p(org, NOW).approvedRequest(con, [{ quantity: '1', unitPrice: '90000.00' }])).id
})

describe('[FR-BUD-101/AC1] [FR-BUD-101/AC2] the shortfall approved, used at submit, and taken back when the request is rejected', () => {
  it('70,000.00 on a line with 10,000.00 left: OB-02 to the cfo, earmarked, used, then back out of the line', async () => {
    const requestId = await draft(org, 'req_con', con, '70000.00')
    // The requester sees what is missing and may ask (BR-BUD-12, GC-BUD-23)
    const offer = ok(await getRequestOverruns(org.ctxOf('req_con', NOW), requestId))
    expect(offer).toMatchObject({ canAsk: true, ruleInEffect: true, need: { amount: '70000.00' }, available: { amount: '10000.00' }, shortfall: { amount: '60000.00' }, overruns: [] })
    expect(await submitRequest(org.ctxOf('req_con', NOW), { requestId }, key())).toMatchObject({ ok: false, error: { code: 'BUDGET_INSUFFICIENT' } })
    // Only the requester asks: a follower or anyone else is refused
    expect(await submitBudgetOverrun(org.ctxOf('asst_con', NOW), { requestId, reason: 'ขอแทนผู้ขอ' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    // The cfo has nothing to do with the request yet
    expect(await getRequestOverruns(org.ctxOf('cfo', NOW), requestId)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })

    const asked = ok(await submitBudgetOverrun(org.ctxOf('req_con', NOW), { requestId, reason: 'งานเปิดตัวโครงการต้องจัดก่อนสิ้นเดือน' }, key()))
    expect(asked.number).toMatch(/^OB-/)
    const task = await openTask(asked.overrunId)
    expect(task.step.route).toMatchObject({ subjectType: 'BUDGET_OVERRUN', ruleCode: 'OB-02', amountSatang: 6_000_000n })
    expect(task.assigneeMemberId).toBe(org.member.cfo)
    expect(await overrun(asked.overrunId)).toMatchObject({ status: 'PENDING_APPROVAL', requestNetSatang: 7_000_000n, shortfallSatang: 6_000_000n })
    // Nothing moved yet
    expect(await balance(con)).toMatchObject({ availableSatang: 1_000_000n, reservedSatang: 9_000_000n })
    // One live overrun per request
    expect(await submitBudgetOverrun(org.ctxOf('req_con', NOW), { requestId, reason: 'ขออีกครั้ง' }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION', details: { reason: 'OVERRUN_EXISTS' } } })
    // While it waits, the amount and the budget line stay; the title may change; the request is not sent
    const changed = await editRequest(org.ctxOf('req_con', NOW), { requestId, lines: [{ description: 'งานเปิดตัวโครงการ', quantity: '1', uom: 'งาน', unitPrice: '75000.00' }] }, key())
    expect(changed).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION', details: { reason: 'OVERRUN_PENDING' } } })
    ok(await editRequest(org.ctxOf('req_con', NOW), { requestId, title: 'งานเปิดตัวโครงการ (ไตรมาส 4)' }, key()))
    expect(await submitRequest(org.ctxOf('req_con', NOW), { requestId }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION', details: { reason: 'OVERRUN_PENDING' } } })
    // The requester never decides it
    expect((await decideTask(org.ctxOf('req_con', NOW), { taskId: task.id, decision: 'APPROVE' }, key())).ok).toBe(false)
    // The cfo's inbox names it, and the cfo reads the source request and the overrun — not another request of req_con
    const inbox = await listMyTasks(org.ctxOf('cfo', NOW))
    expect(inbox.items.find((i) => i.id === task.id)?.subject).toEqual({ kind: 'BUDGET_OVERRUN', number: asked.number, requestNumber: null, requestTitle: 'งานเปิดตัวโครงการ (ไตรมาส 4)', amountSatang: 6_000_000n })
    expect((await getRequestOverruns(org.ctxOf('cfo', NOW), requestId)).ok).toBe(true)
    expect((await getBudgetOverrun(org.ctxOf('cfo', NOW), asked.overrunId)).ok).toBe(true)
    expect(await getRequestOverruns(org.ctxOf('cfo', NOW), earlier)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await getBudgetOverrun(org.ctxOf('dm_it', NOW), asked.overrunId)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })

    // Approved: 60,000.00 funded and earmarked for the request (BR-BUD-13)
    await stepUpForTask(task.id, task.assigneeMemberId)
    ok(await decideTask(org.ctxOf('cfo', NOW), { taskId: task.id, decision: 'APPROVE' }, key()))
    expect(await overrun(asked.overrunId)).toMatchObject({ status: 'APPROVED', approvedAt: NOW, lapsesAt: new Date(NOW.getTime() + 14 * DAY) })
    expect(await balance(con)).toMatchObject({ availableSatang: 1_000_000n, reservedSatang: 15_000_000n })
    expect(await planned(con)).toBe(16_000_000n)
    expect(await prisma.notification.count({ where: { recipientMemberId: org.member.req_con, templateKey: 'budget.overrun_decided' } })).toBe(1)
    // The dashboard tells what the overrun funded apart from the import (planned = initial + overrun)
    const board = ok(await budgetDashboard(org.ctxOf('fin_officer', NOW)))
    expect(board.lines.find((l) => l.id === con)?.changes).toMatchObject({ initial: { amount: '100000.00' }, overrun: { amount: '60000.00' } })

    // Sent: the overrun is used (BR-BUD-14) and the budget check passes, so G-4 stays 0
    const sent = ok(await submitRequest(org.ctxOf('req_con', NOW), { requestId }, key()))
    expect(await overrun(asked.overrunId)).toMatchObject({ status: 'CONSUMED', usedSatang: 6_000_000n, returnedSatang: 0n, consumedAt: NOW })
    expect(await balance(con)).toMatchObject({ availableSatang: 0n, reservedSatang: 16_000_000n })
    const submitted = await prisma.event.findFirstOrThrow({ where: { type: 'request.submitted', aggregateId: requestId } })
    expect(submitted.data).toMatchObject({ budgetCheck: { budgetLineId: con, availableSatang: '7000000', reservedSatang: '7000000' }, overrunIds: [asked.overrunId] })
    const kpi = await forTenant(org.organizationId).$transaction((tx) => computeKpis(tx, org.organizationId, { from: new Date(NOW.getTime() - DAY), to: new Date(NOW.getTime() + DAY), now: NOW }, null))
    expect(kpi.g4.tasksOnFailedBudgetCheck).toBe(0)

    // Rejected after use: the 60,000.00 leaves the line in the same transaction (BR-BUD-18) — not anyone's free budget
    const prTask = await openTask(requestId)
    expect(prTask.step.route.ruleCode).toBe('PR-02')
    expect(sent.assigneeMemberId).toBe(org.member.vp_ops)
    await stepUpForTask(prTask.id, prTask.assigneeMemberId)
    ok(await decideTask(org.ctxOf('vp_ops', NOW), { taskId: prTask.id, decision: 'REJECT', reason: 'เลื่อนงานไปปีหน้า' }, key()))
    expect(await balance(con)).toMatchObject({ availableSatang: 1_000_000n, reservedSatang: 9_000_000n })
    expect(await planned(con)).toBe(10_000_000n)
    expect(await overrun(asked.overrunId)).toMatchObject({ status: 'CONSUMED', returnedAfterUseSatang: 6_000_000n })
    const types = (await prisma.event.findMany({ where: { organizationId: org.organizationId, type: { in: ['budget_overrun.unused_returned', 'budget.overrun_returned'] } }, select: { type: true, data: true } })).map((e) => [e.type, (e.data as { amountSatang: string }).amountSatang])
    expect(types).toEqual(expect.arrayContaining([['budget_overrun.unused_returned', '6000000'], ['budget.overrun_returned', '6000000']]))
    // The requester reads the whole story on the overrun
    expect(ok(await getBudgetOverrun(org.ctxOf('req_con', NOW), asked.overrunId))).toMatchObject({ status: 'CONSUMED', used: { amount: '60000.00' }, returnedAfterUse: { amount: '60000.00' }, mine: true })
  })
})

describe('[FR-BUD-101/AC1] the requester never approves their own shortfall (BR-SOD-01)', () => {
  it('vp_ops asks 30,000.00 on an OPS line: OB-01 would pick vp_ops, so the route escalates past them', async () => {
    const fy = await prisma.fiscalYear.findFirstOrThrow({ where: { organizationId: org.organizationId, code: 'FY2569' } })
    const cc = await prisma.costCenter.findFirstOrThrow({ where: { organizationId: org.organizationId, code: 'CC-CON' } })
    const ops = await prisma.budgetLine.create({ data: { organizationId: org.organizationId, fiscalYearId: fy.id, departmentId: org.department.OPS!, costCenterId: cc.id, code: `OPS-${randomUUID().slice(0, 8)}`, nameTh: 'งบสายปฏิบัติการ', plannedSatang: 0n } })
    await prisma.budgetLineBalance.create({ data: { organizationId: org.organizationId, budgetLineId: ops.id } })
    const requestId = await draft(org, 'vp_ops', ops.id, '30000.00')
    const asked = ok(await submitBudgetOverrun(org.ctxOf('vp_ops', NOW), { requestId, reason: 'ประชุมใหญ่ประจำปีของสายงาน' }, key()))
    const task = await openTask(asked.overrunId)
    expect(task.assigneeMemberId).not.toBe(org.member.vp_ops)
    expect(await decideTask(org.ctxOf('vp_ops', NOW), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: false })
  })
})

describe('[FR-BUD-101/AC2] an approved overrun not used goes back (BR-BUD-15)', () => {
  it('the request cancelled: the earmark returns and the shortfall leaves the line', async () => {
    const line = await p2p(org, NOW).fundedLine(10_000n)
    const requestId = await draft(org, 'req_con', line, '30000.00')
    const asked = await approvedOverrun(requestId)
    expect(await planned(line)).toBe(3_000_000n)
    ok(await cancelRequest(org.ctxOf('req_con', NOW), { requestId }, key()))
    expect(await overrun(asked.overrunId)).toMatchObject({ status: 'LAPSED', usedSatang: 0n, returnedSatang: 2_000_000n })
    expect(await balance(line)).toMatchObject({ availableSatang: 1_000_000n, reservedSatang: 0n })
    expect(await planned(line)).toBe(1_000_000n)
  })

  it('cancelled by the requester while it waits: its route closes and nothing moved', async () => {
    const line = await p2p(org, NOW).fundedLine(10_000n)
    const requestId = await draft(org, 'req_con', line, '30000.00')
    const asked = ok(await submitBudgetOverrun(org.ctxOf('req_con', NOW), { requestId, reason: 'ขอเกินงบเพื่องานด่วน' }, key()))
    expect(await cancelBudgetOverrun(org.ctxOf('asst_con', NOW), { overrunId: asked.overrunId }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    ok(await cancelBudgetOverrun(org.ctxOf('req_con', NOW), { overrunId: asked.overrunId }, key()))
    expect(await overrun(asked.overrunId)).toMatchObject({ status: 'CANCELLED' })
    expect(await prisma.approvalTask.count({ where: { status: 'OPEN', step: { route: { subjectId: asked.overrunId } } } })).toBe(0)
    expect(await planned(line)).toBe(1_000_000n)
    // Asking again is allowed once nothing is live
    expect((await submitBudgetOverrun(org.ctxOf('req_con', NOW), { requestId, reason: 'ขอเกินงบอีกครั้ง' }, key())).ok).toBe(true)
  })

  it('reminded two days before lapsesAt, lapsed after it; a submit after lapsesAt never uses it', async () => {
    const line = await p2p(org, NOW).fundedLine(10_000n)
    const requestId = await draft(org, 'req_con', line, '30000.00')
    const asked = await approvedOverrun(requestId)
    const reminded = ok(await runOverrunLapse(org.organizationId, new Date(NOW.getTime() + 12.5 * DAY)))
    expect(reminded).toMatchObject({ lapsed: 0 })
    expect(await prisma.notification.count({ where: { recipientMemberId: org.member.req_con, templateKey: 'budget.overrun_lapsing', subjectId: asked.overrunId } })).toBe(1)
    // Past lapsesAt, before the job: the submit lets it lapse and finds the line short again (and rolls back with it)
    expect(await submitRequest(org.ctxOf('req_con', new Date(NOW.getTime() + 14 * DAY + 60_000)), { requestId }, key())).toMatchObject({ ok: false, error: { code: 'BUDGET_INSUFFICIENT' } })
    ok(await runOverrunLapse(org.organizationId, new Date(NOW.getTime() + 14 * DAY + 3_600_000)))
    expect(await overrun(asked.overrunId)).toMatchObject({ status: 'LAPSED', returnedSatang: 2_000_000n })
    expect(await planned(line)).toBe(1_000_000n)
    expect(await balance(line)).toMatchObject({ availableSatang: 1_000_000n, reservedSatang: 0n })
  })

  it('its line left with lines of zero only: the submit lets it lapse instead of failing (S6-22 review)', async () => {
    const line = await p2p(org, NOW).fundedLine(10_000n)
    const other = await p2p(org, NOW).fundedLine(10_000n)
    const requestId = await draft(org, 'req_con', line, '30000.00')
    const asked = await approvedOverrun(requestId)
    // Edited after the approval: the line on the overrun's budget line costs nothing now, the work moved to another line
    ok(
      await editRequest(
        org.ctxOf('req_con', NOW),
        { requestId, lines: [{ description: 'ของแถมจากผู้ขาย', quantity: '1', uom: 'งาน', unitPrice: '0.00' }, { description: 'งานเปิดตัวโครงการ', quantity: '1', uom: 'งาน', unitPrice: '5000.00', budgetLineId: other }] },
        key(),
      ),
    )
    ok(await submitRequest(org.ctxOf('req_con', NOW), { requestId }, key()))
    expect(await overrun(asked.overrunId)).toMatchObject({ status: 'LAPSED', usedSatang: 0n, returnedSatang: 2_000_000n })
    expect(await balance(line)).toMatchObject({ availableSatang: 1_000_000n, reservedSatang: 0n })
    expect(await balance(other)).toMatchObject({ availableSatang: 500_000n, reservedSatang: 500_000n })
  })
})

describe('[FR-BUD-101/AC2] a PO line of a request with an overrun outstanding never merges another request (BR-BUD-18)', () => {
  it('po.submit refuses OVERRUN_LINE_NOT_MERGEABLE', async () => {
    const line = await p2p(org, NOW).fundedLine(10_000n)
    const requestId = await draft(org, 'req_con', line, '15000.00')
    await approvedOverrun(requestId)
    ok(await submitRequest(org.ctxOf('req_con', NOW), { requestId }, key()))
    await p2p(org, NOW).approveAll(requestId)
    const request = await prisma.request.findUniqueOrThrow({ where: { id: requestId }, include: { lines: true } })
    expect(request.status).toBe('APPROVED')
    const site = await prisma.deliverySite.create({ data: { organizationId: org.organizationId, code: `SITE-${randomUUID().slice(0, 8)}`, nameTh: 'ไซต์ทดสอบ', address: 'ถนนทดสอบ' } })
    await prisma.request.update({ where: { id: requestId }, data: { deliverySiteId: site.id } })
    const supplier = await prisma.supplier.create({ data: { organizationId: org.organizationId, code: `S-${randomUUID().slice(0, 6)}`, nameTh: 'ผู้ขายงานกิจกรรม', taxId: '0999999000012' } })
    const proc = org.ctxOf('proc_officer', NOW)
    ok(await assignSupplier(proc, { requestLineIds: request.lines.map((l) => l.id), supplierId: supplier.id }, key()))
    const run = ok(await consolidateNow(proc, key()))
    const po = await prisma.purchaseOrder.findFirstOrThrow({ where: { id: { in: [...run.purchaseOrderIds] }, deliverySiteId: site.id }, include: { lines: true } })
    // Another request's line put on the same PO line
    const other = await prisma.request.findUniqueOrThrow({ where: { id: earlier }, include: { lines: true } })
    await prisma.poLineSource.create({ data: { organizationId: org.organizationId, poLineId: po.lines[0]!.id, requestLineId: other.lines[0]!.id, quantity: '0.0001', releasableSatang: 0n } })
    expect(await submitPo(proc, { poId: po.id }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'lines.0', reason: 'OVERRUN_LINE_NOT_MERGEABLE' } } })
  })
})

describe('[FR-BUD-101/AC1] the demo fixture has no OVER_BUDGET rule', () => {
  it('no button, and asking is DOA_NOT_CONFIGURED with nothing kept', async () => {
    const demo = await createDoaOrg()
    const line = await p2p(demo, NOW).fundedLine(10_000n)
    const requestId = await draft(demo, 'req_con', line, '20000.00')
    expect(ok(await getRequestOverruns(demo.ctxOf('req_con', NOW), requestId))).toMatchObject({ canAsk: false, ruleInEffect: false, shortfall: { amount: '10000.00' } })
    expect(await submitBudgetOverrun(demo.ctxOf('req_con', NOW), { requestId, reason: 'ขอเกินงบ' }, key())).toMatchObject({ ok: false, error: { code: 'DOA_NOT_CONFIGURED' } })
    expect(await prisma.budgetOverrun.count({ where: { organizationId: demo.organizationId } })).toBe(0)
    expect(await planned(line)).toBe(1_000_000n)
  })

  it('a line with enough is NOT_OVER_BUDGET (GC-BUD-24)', async () => {
    const line = await p2p(org, NOW).fundedLine(50_000n)
    const requestId = await draft(org, 'req_con', line, '20000.00')
    expect(ok(await getRequestOverruns(org.ctxOf('req_con', NOW), requestId))).toMatchObject({ canAsk: false, shortfall: null })
    expect(await submitBudgetOverrun(org.ctxOf('req_con', NOW), { requestId, reason: 'ขอเกินงบ' }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'NOT_OVER_BUDGET' } } })
  })
})
