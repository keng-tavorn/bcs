import { randomUUID } from 'node:crypto'
import { systemClock } from '@/lib/clock'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { decideTask } from '@/server/services/approvals/decide'
import { assignSupplier } from '@/server/services/procurement'
import { submitPo } from '@/server/services/purchase-orders'
import { createDraft, submitRequest } from '@/server/services/requests'
import { E2E_DB } from '../support/e2e-env'

// Run by tests/e2e/price-reference.spec.ts against the e2e database only (S6-11 · FR-DOA-101): everything through the
// services in the demo organization, with fresh idempotency keys, from today's date. Prints one line of JSON last.
//   reference <tag>  three POs of S3 for one item of this tag ("สว่านไฟฟ้า 18V (<tag>)", ชิ้น) approved at 2,400.00,
//                    2,380.00 and 2,450.00 — each from an urgent request of req_con on the construction capex line,
//                    which choosing its supplier drafts at once (BR-CONS-02) — then a request of req_con for two of the
//                    same item at 2,700.00 sent for approval: 12.50% above the lower median of 2,400.00, HIGH against the
//                    demo's priceAlertPct of 10. Its first task's assignee (and whether they sign in with TOTP) is read
//                    from the route, whoever the DOA sends it to.
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the price reference scene runs in the e2e database only')

const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }, what: string): T => {
  if (!r.ok) throw new Error(`${what} failed: ${JSON.stringify(r.error)}`)
  return r.data
}

const org = await prisma.organization.findFirstOrThrow({ where: { code: 'DEMO' }, select: { id: true } })
const memberId = async (code: string) => (await prisma.member.findFirstOrThrow({ where: { organizationId: org.id, employeeCode: code }, select: { id: true } })).id
// The clock read at each step: the three POs are approved one after another, so the latest price is the last one's
const ctxOf = async (code: string) => makeCtx({ organizationId: org.id, actor: { type: 'USER', memberId: await memberId(code) }, channel: 'WEB', now: systemClock.now() })
const supplierId = async (code: string) => (await prisma.supplier.findFirstOrThrow({ where: { organizationId: org.id, code }, select: { id: true } })).id
const siteId = async (code: string) => (await prisma.deliverySite.findFirstOrThrow({ where: { organizationId: org.id, code }, select: { id: true } })).id

/** The budget line `preferred` when it has `netBaht` left, else `fallback` (other specs spend the same lines) */
async function budgetLine(preferred: string, fallback: string, netBaht: bigint): Promise<string> {
  for (const code of [preferred, fallback]) {
    const line = await prisma.budgetLine.findFirstOrThrow({ where: { organizationId: org.id, code }, select: { id: true } })
    const balance = await prisma.budgetLineBalance.findUniqueOrThrow({ where: { budgetLineId: line.id }, select: { availableSatang: true } })
    if (balance.availableSatang >= netBaht * 100n) return line.id
  }
  throw new Error(`no budget left on ${preferred} or ${fallback}`)
}

/** Decides every open task of a document with its assignee until none is left */
async function approveAll(subjectId: string) {
  for (let i = 0; i < 5; i++) {
    const task = await prisma.approvalTask.findFirst({ where: { status: 'OPEN', step: { route: { subjectId } } }, select: { id: true, assignee: { select: { employeeCode: true } } } })
    if (!task) return
    ok(await decideTask(await ctxOf(task.assignee.employeeCode!), { taskId: task.id, decision: 'APPROVE' }, key()), 'approve')
  }
}

/** A request of req_con for the item, sent for approval; urgent ones go to HQ-STORE so their supplier drafts a PO at once */
async function sentRequest(title: string, item: string, quantity: string, unitPrice: string, urgent: boolean) {
  const ctx = await ctxOf('req_con')
  const draft = ok(
    await createDraft(
      ctx,
      {
        requestTypeCode: 'BUY_GOODS',
        title,
        budgetLineId: await budgetLine('CON-CAPEX-2569', 'CON-OPEX-2569', 10_000n),
        deliverySiteId: await siteId('HQ-STORE'),
        urgency: urgent ? 'URGENT' : 'NORMAL',
        lines: [{ description: item, quantity, uom: 'ชิ้น', unitPrice }],
      },
      key(),
    ),
    'draft',
  )
  const sent = ok(await submitRequest(ctx, { requestId: draft.requestId }, key()), 'submit')
  return { id: draft.requestId, number: sent.number }
}

async function approvedPo(tag: string, item: string, unitPrice: string) {
  const request = await sentRequest(`เครื่องมือช่าง (${tag})`, item, '1', unitPrice, true)
  await approveAll(request.id)
  const lines = await prisma.requestLine.findMany({ where: { requestId: request.id }, select: { id: true } })
  const assigned = ok(await assignSupplier(await ctxOf('proc_officer'), { requestLineIds: lines.map((l) => l.id), supplierId: await supplierId('S3') }, key()), 'assign')
  const [poId] = assigned.purchaseOrderIds
  if (!poId || assigned.purchaseOrderIds.length !== 1) throw new Error(`expected one draft of an urgent request, got ${JSON.stringify(assigned)}`)
  ok(await submitPo(await ctxOf('proc_officer'), { poId }, key()), 'submit PO')
  await approveAll(poId)
  const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId }, select: { status: true } })
  if (po.status !== 'APPROVED') throw new Error(`PO ${poId} is ${po.status}`)
}

const [scenario, rawTag] = process.argv.slice(2)
const tag = rawTag ?? 'e2e'
let out: unknown
switch (scenario) {
  case 'reference': {
    const item = `สว่านไฟฟ้า 18V (${tag})`
    for (const price of ['2400.00', '2380.00', '2450.00']) await approvedPo(tag, item, price)
    const title = `สว่านสำหรับไซต์ (${tag})`
    const request = await sentRequest(title, item, '2', '2700.00', false)
    const task = await prisma.approvalTask.findFirstOrThrow({
      where: { status: 'OPEN', step: { route: { subjectType: 'REQUEST', subjectId: request.id } } },
      select: { id: true, assignee: { select: { employeeCode: true, user: { select: { twoFactorEnabled: true } } } } },
    })
    out = { ...request, title, item, taskId: task.id, approver: task.assignee.employeeCode, approverTotp: task.assignee.user?.twoFactorEnabled === true }
    break
  }
  default:
    throw new Error(`unknown scenario ${scenario}`)
}
await prisma.$disconnect()
console.log(JSON.stringify(out))
