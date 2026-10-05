import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { decideTask } from '@/server/services/approvals/decide'
import { createDelegation } from '@/server/services/delegations'
import { assignSupplier, consolidateNow } from '@/server/services/procurement'
import { editDraftPo, submitPo } from '@/server/services/purchase-orders'
import { postGoodsReceipt } from '@/server/services/receiving'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { p2p } from '../support/p2p'

// §2.4 budget.view with BR-BUD-02, BR-BUD-05 and BR-GR-04 (FR-P2P-004 AC2, FR-P2P-007 AC3): an approval that holds
// budget — the last approval of a PO, or approving an excess the receiver kept — is refused with BUDGET_INSUFFICIENT
// when the budget line cannot hold it. What is left on the line and what is missing are budget figures: the service
// gives them only to an approver who may view the line (a budget role for the whole organization, or the head of the
// line's department), as it does when PROCUREMENT sends a PO and when a receipt is refused. Deciding a task gives no
// right to read the budget, nor does heading another department, and hiding the figures on the screen is not enough
// (BR-AUTH-05). Real Postgres, real services; a refusal writes nothing, so the same task is decided by one approver and
// then by another.

const NOW = new Date('2026-10-05T03:00:00Z') // Monday 10:00 in Bangkok
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}

let org: DoaOrg
let flow: ReturnType<typeof p2p>
let supplierId: string
const proc = () => org.ctxOf('proc_officer', NOW)

beforeAll(async () => {
  org = await createDoaOrg()
  flow = p2p(org, NOW)
  supplierId = (await prisma.supplier.create({ data: { organizationId: org.organizationId, code: 'S1', nameTh: 'ผู้ขายหนึ่ง', taxId: '0999999000012' } })).id
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.receiver_con!, role: 'RECEIVER', scopeDepartmentId: org.department.CON!, grantedAt: NOW } })
})

/** The draft a round by hand makes of what is left of a request line */
async function draftOf(requestLineId: string) {
  const run = ok(await consolidateNow(proc(), key()))
  return prisma.purchaseOrder.findFirstOrThrow({ where: { id: { in: [...run.purchaseOrderIds] }, lines: { some: { sources: { some: { requestLineId } } } } }, include: { lines: true } })
}

/** What a refusal must leave as it was: the task still open, its document waiting, the budget line untouched */
async function stateOf(taskId: string, budgetLineId: string) {
  const task = await prisma.approvalTask.findUniqueOrThrow({ where: { id: taskId }, select: { status: true, decision: true } })
  const balance = await prisma.budgetLineBalance.findUniqueOrThrow({ where: { budgetLineId }, select: { availableSatang: true, reservedSatang: true, committedSatang: true, actualSatang: true, lastSeq: true } })
  return { task, balance }
}

describe('[FR-P2P-004/AC2] approving a PO the budget line cannot hold: what is left and missing only for an approver who may view the line (§2.4 budget.view)', () => {
  // 4 × 2,500.25 = 10,001.00 reserved on a budget line of exactly 10,001.00. Ordered as 0.5 and then 3.5, each part
  // gives back its quantity × 2,500.25 rounded once (BR-BUD-05): 1,250.13 + 8,750.88 = 10,001.01, a satang more than
  // was reserved. Approving the second PO, the request gives back only the 8,750.87 it still reserves and the line,
  // used up, has nothing for the last satang: BUDGET_INSUFFICIENT with 8,750.87 available and 0.01 missing.
  // TODO(NEW-65): this satang is the only way the budget can refuse a PO's last approval today. Once the user
  // decides how a line ordered in parts ends, it may be gone: give these two tests another way to fall short, never
  // delete them.
  let budgetLineId: string
  let poId: string
  let taskId: string

  beforeAll(async () => {
    budgetLineId = await flow.fundedLine(10_001n)
    const request = await flow.approvedRequest(budgetLineId, [{ quantity: '4', unitPrice: '2500.25', description: 'เหล็กเส้น (ตัน)' }])
    const requestLineId = request.lines[0]!.id
    const site = await prisma.deliverySite.create({ data: { organizationId: org.organizationId, code: 'SITE-PO', nameTh: 'ไซต์ทดสอบ' } })
    await prisma.request.update({ where: { id: request.id }, data: { deliverySiteId: site.id } })
    ok(await assignSupplier(proc(), { requestLineIds: [requestLineId], supplierId }, key()))
    const first = await draftOf(requestLineId)
    ok(await editDraftPo(proc(), { poId: first.id, expectedVersion: first.version, lines: [{ poLineId: first.lines[0]!.id, quantity: '0.5' }] }, key()))
    ok(await submitPo(proc(), { poId: first.id }, key()))
    await flow.approveAll(first.id)
    const second = await draftOf(requestLineId)
    expect(second.lines.map((l) => [l.quantity.toString(), l.netSatang])).toEqual([['3.5', 875_088n]])
    ok(await submitPo(proc(), { poId: second.id }, key()))
    poId = second.id
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectType: 'PURCHASE_ORDER', subjectId: poId } } } })
    // PO-01: the COO, who holds no budget role here and heads no department (an organization-wide position)
    expect(task.assigneeMemberId).toBe(org.member.coo)
    taskId = task.id
  })

  it('refuses the COO without budget.view with BUDGET_INSUFFICIENT alone, and changes nothing', async () => {
    const before = await stateOf(taskId, budgetLineId)
    expect(await decideTask(org.ctxOf('coo', NOW), { taskId, decision: 'APPROVE' }, key())).toEqual({ ok: false, error: { code: 'BUDGET_INSUFFICIENT', message: expect.any(String) } })
    expect(await stateOf(taskId, budgetLineId)).toEqual(before)
    expect(before.task).toEqual({ status: 'OPEN', decision: null })
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId } })).status).toBe('PENDING_APPROVAL')
  })

  it('tells the COO as EXECUTIVE (budget.view for the whole organization) what is left and what is missing', async () => {
    const grant = await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.coo!, role: 'EXECUTIVE', grantedAt: NOW } })
    try {
      const before = await stateOf(taskId, budgetLineId)
      expect(await decideTask(org.ctxOf('coo', NOW), { taskId, decision: 'APPROVE' }, key())).toEqual({
        ok: false,
        error: { code: 'BUDGET_INSUFFICIENT', message: expect.any(String), details: { available: '8750.87', shortfall: '0.01' } },
      })
      expect(await stateOf(taskId, budgetLineId)).toEqual(before)
    } finally {
      await prisma.roleAssignment.update({ where: { id: grant.id }, data: { revokedAt: NOW } })
    }
  })
})

describe('[FR-P2P-007/AC3] approving an excess the budget line cannot hold: what is left and missing only for an approver who may view the line (§2.4 budget.view)', () => {
  // 10 × 1,100.00 on a budget line of exactly 11,000.00: once the PO holds it nothing is left, and the eleventh the
  // receiver keeps (ACCEPT_EXCESS) cannot be held — BUDGET_INSUFFICIENT with 0.00 available and 1,100.00 missing.
  // GRV-01 gives the variance to the DM of CON, who heads the line's department and has a delegate for variances,
  // asst_con, who holds no budget role and heads no department: the task is the delegate's, and either decides it
  // (BR-DLG-04).
  let budgetLineId: string
  let varianceId: string
  let taskId: string

  beforeAll(async () => {
    ok(
      await createDelegation(
        org.ctxOf('dm_con', NOW),
        { delegateMemberId: org.member.asst_con!, startsAt: '2026-10-05T00:00:00+07:00', endsAt: '2026-10-10T00:00:00+07:00', documentTypes: ['GR_VARIANCE'], reason: 'ลาพักร้อน' },
        key(),
      ),
    )
    budgetLineId = await flow.fundedLine(11_000n)
    const request = await flow.approvedRequest(budgetLineId, [{ quantity: '10', unitPrice: '1100.00', description: 'ปูนซีเมนต์' }])
    const po = await flow.approvedPo([request.lines[0]!.id], supplierId)
    expect(po.status).toBe('APPROVED')
    // S4-06 sends it by email; here it is marked SENT (as tests/integration/receiving.test.ts does)
    await prisma.purchaseOrder.update({ where: { id: po.id }, data: { status: 'SENT', sentAt: NOW } })
    const gr = ok(await postGoodsReceipt(org.ctxOf('receiver_con', NOW), { poId: po.id, lines: [{ poLineId: po.lines[0]!.id, received: '11', excessDisposition: 'ACCEPT_EXCESS' }] }, key()))
    varianceId = gr.varianceIds[0]!
    expect(await prisma.variance.findUniqueOrThrow({ where: { id: varianceId } })).toMatchObject({ status: 'PENDING_APPROVAL', disposition: 'ACCEPT_EXCESS', amountSatang: 110_000n })
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectType: 'VARIANCE', subjectId: varianceId } } } })
    expect(task).toMatchObject({ assigneeMemberId: org.member.asst_con, principalMemberId: org.member.dm_con })
    taskId = task.id
  })

  it('refuses the delegate without budget.view with BUDGET_INSUFFICIENT alone, and changes nothing', async () => {
    const before = await stateOf(taskId, budgetLineId)
    expect(await decideTask(org.ctxOf('asst_con', NOW), { taskId, decision: 'APPROVE' }, key())).toEqual({ ok: false, error: { code: 'BUDGET_INSUFFICIENT', message: expect.any(String) } })
    expect(await stateOf(taskId, budgetLineId)).toEqual(before)
    expect(before.task).toEqual({ status: 'OPEN', decision: null })
    expect((await prisma.variance.findUniqueOrThrow({ where: { id: varianceId } })).status).toBe('PENDING_APPROVAL')
  })

  it('tells the DM of CON, head of the line’s department (budget.view DEPT), what is left and what is missing', async () => {
    const before = await stateOf(taskId, budgetLineId)
    expect(await decideTask(org.ctxOf('dm_con', NOW), { taskId, decision: 'APPROVE' }, key())).toEqual({
      ok: false,
      error: { code: 'BUDGET_INSUFFICIENT', message: expect.any(String), details: { available: '0.00', shortfall: '1100.00' } },
    })
    expect(await stateOf(taskId, budgetLineId)).toEqual(before)
  })
})

describe('[FR-P2P-007/AC3] approving an excess as the head of another department: BUDGET_INSUFFICIENT without what is left and missing (§2.4 budget.view)', () => {
  // A week later, the delegation to asst_con over, the DM of CON delegates variances to the DM of PROC. He heads PROC,
  // which is neither the line's department (CON) nor above it, and holds PROC_MGR, a position of the whole organization
  // that heads nothing: a department head views the budget of the departments he heads only. The same excess as above:
  // 10 × 1,100.00 on a budget line of exactly 11,000.00, and an eleventh kept.
  const LATER = new Date('2026-10-12T03:00:00Z') // Monday 10:00 in Bangkok
  let budgetLineId: string
  let varianceId: string
  let taskId: string

  beforeAll(async () => {
    const later = p2p(org, LATER)
    ok(
      await createDelegation(
        org.ctxOf('dm_con', LATER),
        { delegateMemberId: org.member.dm_proc!, startsAt: '2026-10-12T00:00:00+07:00', endsAt: '2026-10-16T00:00:00+07:00', documentTypes: ['GR_VARIANCE'], reason: 'ไปตรวจไซต์ต่างจังหวัด' },
        key(),
      ),
    )
    budgetLineId = await later.fundedLine(11_000n)
    const request = await later.approvedRequest(budgetLineId, [{ quantity: '10', unitPrice: '1100.00', description: 'ทรายหยาบ' }])
    const po = await later.approvedPo([request.lines[0]!.id], supplierId)
    expect(po.status).toBe('APPROVED')
    await prisma.purchaseOrder.update({ where: { id: po.id }, data: { status: 'SENT', sentAt: LATER } })
    const gr = ok(await postGoodsReceipt(org.ctxOf('receiver_con', LATER), { poId: po.id, lines: [{ poLineId: po.lines[0]!.id, received: '11', excessDisposition: 'ACCEPT_EXCESS' }] }, key()))
    varianceId = gr.varianceIds[0]!
    expect(await prisma.variance.findUniqueOrThrow({ where: { id: varianceId } })).toMatchObject({ status: 'PENDING_APPROVAL', disposition: 'ACCEPT_EXCESS', amountSatang: 110_000n })
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectType: 'VARIANCE', subjectId: varianceId } } } })
    expect(task).toMatchObject({ assigneeMemberId: org.member.dm_proc, principalMemberId: org.member.dm_con })
    taskId = task.id
  })

  it('refuses the DM of PROC with BUDGET_INSUFFICIENT alone, and changes nothing', async () => {
    const before = await stateOf(taskId, budgetLineId)
    expect(await decideTask(org.ctxOf('dm_proc', LATER), { taskId, decision: 'APPROVE' }, key())).toEqual({ ok: false, error: { code: 'BUDGET_INSUFFICIENT', message: expect.any(String) } })
    expect(await stateOf(taskId, budgetLineId)).toEqual(before)
    expect(before.task).toEqual({ status: 'OPEN', decision: null })
    expect((await prisma.variance.findUniqueOrThrow({ where: { id: varianceId } })).status).toBe('PENDING_APPROVAL')
  })

  it('tells the DM of CON, who delegated the task, what is left and what is missing on the same task', async () => {
    const before = await stateOf(taskId, budgetLineId)
    expect(await decideTask(org.ctxOf('dm_con', LATER), { taskId, decision: 'APPROVE' }, key())).toEqual({
      ok: false,
      error: { code: 'BUDGET_INSUFFICIENT', message: expect.any(String), details: { available: '0.00', shortfall: '1100.00' } },
    })
    expect(await stateOf(taskId, budgetLineId)).toEqual(before)
  })
})
