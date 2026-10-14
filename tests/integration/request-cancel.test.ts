import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { decideTask } from '@/server/services/approvals/decide'
import { assignSupplier, consolidateNow } from '@/server/services/procurement'
import { cancelRequest, createDraft, submitRequest } from '../support/requests'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// §6.4 and §2.4 request.cancel (S2 verification SM-01, SM-05): one command cancels a request — the requester before any
// PO, PROCUREMENT once the request is APPROVED and not yet ordered, with a reason. A new-supplier request follows its own
// states (DRAFT → SUBMITTED → DONE, cancelled before DONE).

const NOW = new Date('2026-10-05T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })

let org: DoaOrg
let budgetLineId: string
const codeOf = (memberId: string) => Object.entries(org.member).find(([, id]) => id === memberId)![0]
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}

beforeAll(async () => {
  org = await createDoaOrg()
  budgetLineId = (await prisma.budgetLine.findFirstOrThrow({ where: { organizationId: org.organizationId, code: 'CON-OPEX-2569' } })).id
})

async function approved(): Promise<{ id: string; lineId: string }> {
  const draft = ok(await createDraft(org.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', title: 'วัสดุ', budgetLineId, lines: [{ description: 'ปูน', quantity: '1', uom: 'ถุง', unitPrice: '1000.00' }] }, key()))
  ok(await submitRequest(org.ctxOf('req_con', NOW), { requestId: draft.requestId }, key()))
  const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: draft.requestId } } } })
  ok(await decideTask(org.ctxOf(codeOf(task.assigneeMemberId), NOW), { taskId: task.id, decision: 'APPROVE' }, key()))
  const line = await prisma.requestLine.findFirstOrThrow({ where: { requestId: draft.requestId } })
  return { id: draft.requestId, lineId: line.id }
}

describe('[FR-INT-009/AC1] cancelling a request: the requester before any PO, PROCUREMENT for an approved one with a reason', () => {
  it('PROCUREMENT cancels an APPROVED request with a reason, and the budget it reserved goes back', async () => {
    const r = await approved()
    const reserved = await prisma.budgetAllocation.findFirstOrThrow({ where: { sourceType: 'REQUEST_LINE', sourceId: r.lineId } })
    expect(reserved.reservedSatang).toBe(100_000n)
    expect(await cancelRequest(org.ctxOf('proc_officer', NOW), { requestId: r.id }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'reason' } } })
    ok(await cancelRequest(org.ctxOf('proc_officer', NOW), { requestId: r.id, reason: 'ซื้อจากสัญญาเดิมแล้ว' }, key()))
    expect(await prisma.request.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject({ status: 'CANCELLED', cancelReason: 'ซื้อจากสัญญาเดิมแล้ว' })
    expect((await prisma.budgetAllocation.findFirstOrThrow({ where: { sourceType: 'REQUEST_LINE', sourceId: r.lineId } })).reservedSatang).toBe(0n)
    expect(await prisma.event.findFirstOrThrow({ where: { aggregateId: r.id, type: 'request.cancelled' } })).toMatchObject({ data: { from: 'APPROVED' } })
  })

  it('the requester cancels their own approved request before any PO; nobody cancels one already on a PO', async () => {
    const own = await approved()
    ok(await cancelRequest(org.ctxOf('req_con', NOW), { requestId: own.id }, key()))
    expect((await prisma.request.findUniqueOrThrow({ where: { id: own.id } })).status).toBe('CANCELLED')
    const onPo = await approved()
    const supplier = await prisma.supplier.create({ data: { organizationId: org.organizationId, code: `S-${randomUUID().slice(0, 6)}`, nameTh: 'ผู้ขาย', taxId: '0999999000012', branchCode: String(Math.floor(Math.random() * 90000) + 10000) } })
    ok(await assignSupplier(org.ctxOf('proc_officer', NOW), { requestLineIds: [onPo.lineId], supplierId: supplier.id }, key()))
    ok(await consolidateNow(org.ctxOf('proc_officer', NOW), key()))
    expect(await cancelRequest(org.ctxOf('req_con', NOW), { requestId: onPo.id }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION', details: { reason: 'ON_PO' } } })
    expect(await cancelRequest(org.ctxOf('proc_officer', NOW), { requestId: onPo.id, reason: 'ไม่ต้องการแล้ว' }, key())).toMatchObject({ ok: false, error: { details: { reason: 'ON_PO' } } })
  })

  it('PROCUREMENT does not cancel a request that is not yet approved, and other members cancel nothing', async () => {
    const draft = ok(await createDraft(org.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', title: 'ร่าง', budgetLineId, lines: [{ description: 'x', quantity: '1', uom: 'ชิ้น', unitPrice: '1.00' }] }, key()))
    expect(await cancelRequest(org.ctxOf('proc_officer', NOW), { requestId: draft.requestId, reason: 'ไม่ใช่ของฉัน' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await cancelRequest(org.ctxOf('dm_con', NOW), { requestId: draft.requestId, reason: 'ไม่ใช่ของฉัน' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    ok(await cancelRequest(org.ctxOf('req_con', NOW), { requestId: draft.requestId }, key()))
  })

  it('a new-supplier request is cancelled from SUBMITTED by its requester (its own state table)', async () => {
    const draft = ok(await createDraft(org.ctxOf('req_con', NOW), { requestTypeCode: 'NEW_SUPPLIER', title: 'ขอเพิ่มผู้ขาย', formData: { supplierName: 'บริษัท ตัวอย่าง จำกัด' } }, key()))
    ok(await submitRequest(org.ctxOf('req_con', NOW), { requestId: draft.requestId }, key()))
    expect((await prisma.request.findUniqueOrThrow({ where: { id: draft.requestId } })).status).toBe('SUBMITTED')
    ok(await cancelRequest(org.ctxOf('req_con', NOW), { requestId: draft.requestId }, key()))
    expect((await prisma.request.findUniqueOrThrow({ where: { id: draft.requestId } })).status).toBe('CANCELLED')
  })
})
