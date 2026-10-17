import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { listMyTasks } from '@/server/queries/tasks'
import { decideTask } from '@/server/services/approvals/decide'
import { budgetDashboard } from '@/server/services/budget/dashboard'
import { budgetLineDetail } from '@/server/services/budget/line-detail'
import { getBudgetTransfer, getTransferForm } from '@/server/services/budget/transfer-view'
import { cancelBudgetTransfer, createBudgetTransfer, submitBudgetTransfer } from '@/server/services/budget/transfers'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { createP1Org } from '../support/p1-org'
import { p2p } from '../support/p2p'
import { stepUpForTask } from '../support/pin'

// S6-15 (FR-BUD-103 · BR-BUD-09 to BR-BUD-11 · ADR-104 · OQ-105): budget transfers against Postgres. On the phase-1
// fixture (DOA-P1 has BT-01 DM up to 100,000.00 · BT-02 VP up to 500,000.00 · BT-03 CFO): a BUDGET_ADMIN sends
// 300,000.00 from a CON line to an IT line — the source reserves it at once, the VP of OPS approves, the money leaves
// CON and enters IT, and the dashboard tells imports, transfers and the current amount apart. A return gives the
// reservation back; the sender never approves; a department head sends only from their own department; two transfers
// at once from one line never overdraw it. On the demo fixture (no BUDGET_TRANSFER rule) a transfer is refused with
// DOA_NOT_CONFIGURED having reserved nothing, and the dashboard offers no transfer.

const NOW = new Date('2026-10-06T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}

let org: DoaOrg
let con: string
let it2: string
const balance = (id: string) => prisma.budgetLineBalance.findUniqueOrThrow({ where: { budgetLineId: id } })
const planned = async (id: string) => (await prisma.budgetLine.findUniqueOrThrow({ where: { id } })).plannedSatang

async function itLine(org: DoaOrg): Promise<string> {
  const fy = await prisma.fiscalYear.findFirstOrThrow({ where: { organizationId: org.organizationId, code: 'FY2569' } })
  const cc = await prisma.costCenter.findFirstOrThrow({ where: { organizationId: org.organizationId, code: 'CC-IT' } })
  const line = await prisma.budgetLine.create({ data: { organizationId: org.organizationId, fiscalYearId: fy.id, departmentId: org.department.IT!, costCenterId: cc.id, code: `IT-${randomUUID().slice(0, 8)}`, nameTh: 'งบไอที', plannedSatang: 0n } })
  await prisma.budgetLineBalance.create({ data: { organizationId: org.organizationId, budgetLineId: line.id } })
  return line.id
}

beforeAll(async () => {
  org = await createP1Org()
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.fin_officer!, role: 'BUDGET_ADMIN', grantedAt: NOW } })
  con = await p2p(org, NOW).fundedLine(1_000_000n)
  it2 = await itLine(org)
})

describe('[FR-BUD-103/AC1] [FR-BUD-103/AC2] a transfer is reserved at once and moves when approved (GC-BUD-08, GC-BUD-13)', () => {
  it('300,000.00 from CON to IT: reserved on submit, decided by the VP of OPS under BT-02, then out of CON and into IT', async () => {
    const draft = ok(await createBudgetTransfer(org.ctxOf('fin_officer', NOW), { kind: 'TRANSFER', fromBudgetLineId: con, toBudgetLineId: it2, amount: '300000.00', reason: 'ย้ายงบไปโครงการระบบงาน' }, key()))
    const sent = ok(await submitBudgetTransfer(org.ctxOf('fin_officer', NOW), { transferId: draft.transferId }, key()))
    expect(sent.number).toMatch(/^BT-/)
    expect(await balance(con)).toMatchObject({ availableSatang: 70_000_000n, reservedSatang: 30_000_000n })
    const route = await prisma.approvalRoute.findFirstOrThrow({ where: { subjectId: draft.transferId } })
    expect(route).toMatchObject({ subjectType: 'BUDGET_TRANSFER', ruleCode: 'BT-02', amountSatang: 30_000_000n })
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { routeId: route.id } } })
    expect(task.assigneeMemberId).toBe(org.member.vp_ops)
    // The approver's inbox names it by its BT number and the amount it moves
    const inbox = await listMyTasks(org.ctxOf('vp_ops', NOW))
    expect(inbox.items.find((i) => i.id === task.id)?.subject).toEqual({ kind: 'BUDGET_TRANSFER', number: sent.number, transferKind: 'TRANSFER', amountSatang: 30_000_000n })
    // The approver reads it (budget.view ASSIGNED); someone else of IT does not
    expect((await getBudgetTransfer(org.ctxOf('vp_ops', NOW), draft.transferId)).ok).toBe(true)
    expect(await getBudgetTransfer(org.ctxOf('dm_it', NOW), draft.transferId)).toMatchObject({ ok: true })
    expect(await getBudgetTransfer(org.ctxOf('req_con', NOW), draft.transferId)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    // 300,000.00 is above the version's step-up threshold: the PIN first (FR-AUTH-005 AC2)
    await stepUpForTask(task.id, task.assigneeMemberId)
    ok(await decideTask(org.ctxOf('vp_ops', NOW), { taskId: task.id, decision: 'APPROVE' }, key()))
    expect(await prisma.budgetTransfer.findUniqueOrThrow({ where: { id: draft.transferId } })).toMatchObject({ status: 'APPROVED' })
    expect(await balance(con)).toMatchObject({ availableSatang: 70_000_000n, reservedSatang: 0n })
    expect(await planned(con)).toBe(70_000_000n)
    expect(await balance(it2)).toMatchObject({ availableSatang: 30_000_000n })
    expect(await planned(it2)).toBe(30_000_000n)
    // INV-BUD-08: out of one line exactly what came into the other, one event each, named by the ledger rows
    const types = (await prisma.event.findMany({ where: { organizationId: org.organizationId, type: { in: ['budget.transferred_out', 'budget.transferred_in'] } }, select: { type: true, aggregateId: true, data: true } })).map((e) => [e.type, e.aggregateId, (e.data as { amountSatang: string }).amountSatang])
    expect(types).toEqual(expect.arrayContaining([['budget.transferred_out', con, '30000000'], ['budget.transferred_in', it2, '30000000']]))
    // AC3: the dashboard tells the import, the transfers and the current amount apart, to the satang
    const board = ok(await budgetDashboard(org.ctxOf('fin_officer', NOW)))
    expect(board.lines.find((l) => l.id === con)!.changes).toMatchObject({ initial: { amount: '1000000.00' }, transferredOut: { amount: '300000.00' }, increased: { amount: '0.00' } })
    expect(board.lines.find((l) => l.id === it2)!.changes).toMatchObject({ initial: { amount: '0.00' }, transferredIn: { amount: '300000.00' } })
    expect(board.can.transfer).toBe(true)
    // The drill-down's planned section adds up to the line's planned amount: the import, less the transfer out (S6-22)
    const source = ok(await budgetLineDetail(org.ctxOf('fin_officer', NOW), con))
    expect(source.planned.total.amount).toBe('700000.00')
    expect(source.planned.imports.map((d) => [d.kind, d.number, d.amount.amount])).toEqual(expect.arrayContaining([['BUDGET_TRANSFER', sent.number, '-300000.00']]))
    expect(source.planned.imports.find((d) => d.kind === 'IMPORT')?.amount.amount).toBe('1000000.00')
    // Its movements name the transfer by its number, and say money left the budget
    const out = source.movements.rows.find((m) => m.document.type === 'BUDGET_TRANSFER' && m.to === 'OUTSIDE')
    expect(out).toMatchObject({ kind: 'DEFUNDED', document: { label: sent.number, canOpen: false }, amount: { amount: '300000.00' } })
    const destination = ok(await budgetLineDetail(org.ctxOf('fin_officer', NOW), it2))
    expect(destination.planned).toMatchObject({ total: { amount: '300000.00' }, imports: [{ kind: 'BUDGET_TRANSFER', number: sent.number, amount: { amount: '300000.00' } }] })
    expect(destination.movements.rows.find((m) => m.from === 'OUTSIDE')).toMatchObject({ kind: 'FUNDED', document: { type: 'BUDGET_TRANSFER', label: sent.number } })
  })

  it('the sender never approves; a return gives the reservation back and a resubmit reserves again (GC-BUD-10)', async () => {
    // fin_officer holds no DM post; a transfer of DM size from a line of their own department would reach dm_fin. Here
    // the sender is the DM of CON, who must not decide it: the route escalates past them
    await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.dm_con!, role: 'BUDGET_ADMIN', grantedAt: NOW } })
    const draft = ok(await createBudgetTransfer(org.ctxOf('dm_con', NOW), { kind: 'DECREASE', fromBudgetLineId: con, amount: '50000.00', reason: 'คืนงบที่ไม่ใช้' }, key()))
    ok(await submitBudgetTransfer(org.ctxOf('dm_con', NOW), { transferId: draft.transferId }, key()))
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: draft.transferId } } } })
    expect(task.assigneeMemberId).not.toBe(org.member.dm_con)
    expect(await balance(con)).toMatchObject({ reservedSatang: 5_000_000n })
    const assignee = Object.entries(org.member).find(([, id]) => id === task.assigneeMemberId)![0]
    ok(await decideTask(org.ctxOf(assignee, NOW), { taskId: task.id, decision: 'RETURN', reason: 'แนบเหตุผลประกอบ' }, key()))
    expect(await prisma.budgetTransfer.findUniqueOrThrow({ where: { id: draft.transferId } })).toMatchObject({ status: 'RETURNED' })
    expect(await balance(con)).toMatchObject({ reservedSatang: 0n, availableSatang: 70_000_000n })
    ok(await submitBudgetTransfer(org.ctxOf('dm_con', NOW), { transferId: draft.transferId }, key()))
    expect(await balance(con)).toMatchObject({ reservedSatang: 5_000_000n })
    // Cancelled while it waits: the route closes and the reservation comes back
    ok(await cancelBudgetTransfer(org.ctxOf('dm_con', NOW), { transferId: draft.transferId }, key()))
    expect(await balance(con)).toMatchObject({ reservedSatang: 0n, availableSatang: 70_000_000n })
    expect(await prisma.approvalTask.count({ where: { status: 'OPEN', step: { route: { subjectId: draft.transferId } } } })).toBe(0)
  })

  it('a department head sends only from their department; others are refused; more than is left is BUDGET_INSUFFICIENT (GC-BUD-09)', async () => {
    expect(await createBudgetTransfer(org.ctxOf('req_con', NOW), { kind: 'DECREASE', fromBudgetLineId: con, amount: '1.00', reason: 'ลองโอน' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await createBudgetTransfer(org.ctxOf('dm_it', NOW), { kind: 'TRANSFER', fromBudgetLineId: con, toBudgetLineId: it2, amount: '1.00', reason: 'ลองโอน' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    // The head of IT may give from IT's line
    ok(await createBudgetTransfer(org.ctxOf('dm_it', NOW), { kind: 'TRANSFER', fromBudgetLineId: it2, toBudgetLineId: con, amount: '1.00', reason: 'คืนงบให้ก่อสร้าง' }, key()))
    const big = ok(await createBudgetTransfer(org.ctxOf('fin_officer', NOW), { kind: 'TRANSFER', fromBudgetLineId: con, toBudgetLineId: it2, amount: '700000.01', reason: 'เกินคงเหลือ' }, key()))
    expect(await submitBudgetTransfer(org.ctxOf('fin_officer', NOW), { transferId: big.transferId }, key())).toMatchObject({ ok: false, error: { code: 'BUDGET_INSUFFICIENT', details: { shortfall: '0.01' } } })
    expect(await balance(con)).toMatchObject({ reservedSatang: 0n, availableSatang: 70_000_000n })
    expect(await prisma.budgetTransfer.findUniqueOrThrow({ where: { id: big.transferId } })).toMatchObject({ status: 'DRAFT', number: null })
  })

  it('two transfers at once from one line never overdraw it (INV-BUD-05)', async () => {
    const make = async () => ok(await createBudgetTransfer(org.ctxOf('fin_officer', NOW), { kind: 'TRANSFER', fromBudgetLineId: con, toBudgetLineId: it2, amount: '400000.00', reason: 'โอนพร้อมกัน' }, key())).transferId
    const [a, b] = [await make(), await make()]
    const results = await Promise.all([submitBudgetTransfer(org.ctxOf('fin_officer', NOW), { transferId: a }, key()), submitBudgetTransfer(org.ctxOf('fin_officer', NOW), { transferId: b }, key())])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.filter((r) => !r.ok)[0]).toMatchObject({ ok: false, error: { code: 'BUDGET_INSUFFICIENT' } })
    const after = await balance(con)
    expect(after.availableSatang).toBe(30_000_000n)
    expect(after.reservedSatang).toBe(40_000_000n)
    expect(after.availableSatang + after.reservedSatang + after.committedSatang + after.actualSatang).toBe(await planned(con))
  })
})

describe('[FR-BUD-103/AC4] a DOA with no BUDGET_TRANSFER rule refuses a transfer having reserved nothing', () => {
  it('the demo fixture: DOA_NOT_CONFIGURED, no reservation, no number, and no transfer button', async () => {
    const demo = await createDoaOrg()
    await prisma.roleAssignment.create({ data: { organizationId: demo.organizationId, memberId: demo.member.fin_officer!, role: 'BUDGET_ADMIN', grantedAt: NOW } })
    const line = await p2p(demo, NOW).fundedLine(100_000n)
    const target = await itLine(demo)
    const draft = ok(await createBudgetTransfer(demo.ctxOf('fin_officer', NOW), { kind: 'TRANSFER', fromBudgetLineId: line, toBudgetLineId: target, amount: '1000.00', reason: 'ทดสอบ' }, key()))
    expect(await submitBudgetTransfer(demo.ctxOf('fin_officer', NOW), { transferId: draft.transferId }, key())).toMatchObject({ ok: false, error: { code: 'DOA_NOT_CONFIGURED' } })
    expect(await forTenant(demo.organizationId).budgetLineBalance.findUniqueOrThrow({ where: { budgetLineId: line } })).toMatchObject({ reservedSatang: 0n, availableSatang: 10_000_000n })
    expect(await prisma.budgetTransfer.findUniqueOrThrow({ where: { id: draft.transferId } })).toMatchObject({ status: 'DRAFT', number: null })
    expect(ok(await budgetDashboard(demo.ctxOf('fin_officer', NOW))).can.transfer).toBe(false)
  })
})

describe('[FR-BUD-103/AC1] the transfer form shows a balance only to whoever may view that budget (§2.4 · ADR-073 pre-review)', () => {
  it('the DM of IT sees IT\'s balance, not CON\'s; a BUDGET_ADMIN sees both', async () => {
    const asHead = ok(await getTransferForm(org.ctxOf('dm_it', NOW)))
    const of = (form: typeof asHead, id: string) => form.lines.find((l) => l.id === id)!
    expect(of(asHead, it2)).toMatchObject({ canGive: true, available: expect.objectContaining({ amount: expect.any(String) }) })
    expect(of(asHead, con)).toMatchObject({ canGive: false, available: null })
    const asAdmin = ok(await getTransferForm(org.ctxOf('fin_officer', NOW)))
    expect(of(asAdmin, con).available).not.toBeNull()
  })
})
