import { randomUUID } from 'node:crypto'
import { fund } from '@/core/budget'
import { applyBudget } from '@/server/budget/ledger'
import { systemCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { appendEvents } from '@/server/events/append'
import { decideTask } from '@/server/services/approvals/decide'
import { assignSupplier, consolidateNow } from '@/server/services/procurement'
import { submitPo } from '@/server/services/purchase-orders'
import { createDraft, submitRequest } from '@/server/services/requests'
import type { DoaOrg } from './doa-org'

// The purchase-to-pay steps service tests start from (spec §6.4): a funded budget line, an approved request with the
// quotations ATT-QUOTES asks above 100,000, and its lines on an approved PO of one supplier — all through the real
// services, each request on a delivery site of its own so a consolidation round takes only its lines.

const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}

export function p2p(org: DoaOrg, now: Date) {
  const codeOf = (memberId: string) => Object.entries(org.member).find(([, id]) => id === memberId)![0]

  async function fundedLine(baht: bigint): Promise<string> {
    const fy = await prisma.fiscalYear.findFirstOrThrow({ where: { organizationId: org.organizationId, code: 'FY2569' } })
    const cc = await prisma.costCenter.findFirstOrThrow({ where: { organizationId: org.organizationId, code: 'CC-CON' } })
    const line = await prisma.budgetLine.create({ data: { organizationId: org.organizationId, fiscalYearId: fy.id, departmentId: org.department.CON!, costCenterId: cc.id, code: `CON-${randomUUID().slice(0, 8)}`, nameTh: 'งบทดสอบ', plannedSatang: 0n } })
    await prisma.budgetLineBalance.create({ data: { organizationId: org.organizationId, budgetLineId: line.id } })
    const ctx = systemCtx(org.organizationId, now, 'seed')
    const importId = randomUUID()
    await forTenant(org.organizationId).$transaction(async (tx) => {
      const r = await applyBudget(tx, ctx, [{ budgetLineId: line.id, document: { type: 'IMPORT', id: importId }, run: (s) => fund(s, baht * 100n, importId) }])
      if (!r.ok) throw new Error('fund failed')
      await appendEvents(tx, ctx, r.events)
    })
    return line.id
  }

  async function approveAll(subjectId: string) {
    for (let i = 0; i < 5; i++) {
      const task = await prisma.approvalTask.findFirst({ where: { status: 'OPEN', step: { route: { subjectId } } } })
      if (!task) return
      ok(await decideTask(org.ctxOf(codeOf(task.assigneeMemberId), now), { taskId: task.id, decision: 'APPROVE' }, key()))
    }
  }

  async function approvedRequest(budgetLineId: string, lines: Array<{ quantity: string; unitPrice: string; description?: string }>) {
    const draft = ok(await createDraft(org.ctxOf('req_con', now), { requestTypeCode: 'BUY_GOODS', title: 'วัสดุ', budgetLineId, lines: lines.map((l, i) => ({ description: l.description ?? `ของ ${i + 1}`, quantity: l.quantity, uom: 'ชิ้น', unitPrice: l.unitPrice })) }, key()))
    for (let i = 0; i < 3; i++) {
      const file = await prisma.fileObject.create({ data: { organizationId: org.organizationId, storageKey: `test/${randomUUID()}.pdf`, fileName: 'q.pdf', mimeType: 'application/pdf', sizeBytes: 1, status: 'AVAILABLE', uploadedById: org.member.req_con! } })
      await prisma.fileLink.create({ data: { organizationId: org.organizationId, fileId: file.id, subjectType: 'Request', subjectId: draft.requestId, kind: 'QUOTATION' } })
    }
    ok(await submitRequest(org.ctxOf('req_con', now), { requestId: draft.requestId }, key()))
    await approveAll(draft.requestId)
    return prisma.request.findUniqueOrThrow({ where: { id: draft.requestId }, include: { lines: { orderBy: { lineNo: 'asc' } } } })
  }

  /** The request lines on one PO of `supplierId`, sent for approval by proc_officer and approved */
  async function approvedPo(requestLineIds: string[], supplierId: string) {
    const site = await prisma.deliverySite.create({ data: { organizationId: org.organizationId, code: `SITE-${randomUUID().slice(0, 8)}`, nameTh: 'ไซต์ทดสอบ', address: 'ถนนทดสอบ' } })
    await prisma.request.updateMany({ where: { lines: { some: { id: { in: requestLineIds } } } }, data: { deliverySiteId: site.id } })
    const proc = org.ctxOf('proc_officer', now)
    ok(await assignSupplier(proc, { requestLineIds, supplierId }, key()))
    const run = ok(await consolidateNow(proc, key()))
    const po = await prisma.purchaseOrder.findFirstOrThrow({ where: { id: { in: [...run.purchaseOrderIds] }, deliverySiteId: site.id } })
    ok(await submitPo(proc, { poId: po.id }, key()))
    await approveAll(po.id)
    return prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id }, include: { lines: { orderBy: { lineNo: 'asc' } } } })
  }

  return { fundedLine, approveAll, approvedRequest, approvedPo }
}
