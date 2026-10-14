import { randomUUID } from 'node:crypto'
import { systemClock } from '@/lib/clock'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { decideTask } from '@/server/services/approvals/decide'
import { createDraft, submitRequest } from '../support/requests'
import { E2E_DB } from '../support/e2e-env'
import { lineWithRoom } from './budget-room'

// Run by tests/e2e/request-form.spec.ts against the e2e database only: a request of two lines that req_con2 sent on
// CON-CAPEX-2569 (cement 12,000.00 and sand 3,000.00 before VAT) and its approver returned for changes, so the form can
// show a returned request that keeps its reservation (§6.4). The line has room for the 15,000.00 first: other specs of the
// run spend it too, and a budget admin tops it up through the budget import when they have left less
// (tests/e2e/budget-room.ts). Prints the request id as JSON on the last line.
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the request form scene runs in the e2e database only')

const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const requester = await prisma.member.findFirstOrThrow({ where: { employeeCode: 'req_con2' }, select: { id: true, organizationId: true } })
const ctxOf = (memberId: string) => makeCtx({ organizationId: requester.organizationId, actor: { type: 'USER', memberId }, channel: 'WEB', now: systemClock.now() })
const budgetLine = await lineWithRoom(['CON-CAPEX-2569'], 1_500_000n)

const draft = await createDraft(
  ctxOf(requester.id),
  {
    requestTypeCode: 'BUY_GOODS',
    title: `วัสดุหน้างานที่ถูกตีกลับ ${randomUUID().slice(0, 4)}`,
    priceIncludesVat: false,
    budgetLineId: budgetLine.id,
    lines: [
      { description: 'ปูนซีเมนต์', quantity: '10', uom: 'ถุง', unitPrice: '1200.00' },
      { description: 'ทราย', quantity: '1', uom: 'คิว', unitPrice: '3000.00' },
    ],
  },
  key(),
)
if (!draft.ok) throw new Error(`draft failed: ${JSON.stringify(draft.error)}`)
const requestId = draft.data.requestId
const sent = await submitRequest(ctxOf(requester.id), { requestId }, key())
if (!sent.ok) throw new Error(`submit failed: ${JSON.stringify(sent.error)}`)
// Returned by whoever holds its approval task (the DM of CON for 16,050.00 baht including VAT, rule PR-01)
const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectType: 'REQUEST', subjectId: requestId } } }, select: { id: true, assigneeMemberId: true } })
const returned = await decideTask(ctxOf(task.assigneeMemberId), { taskId: task.id, decision: 'RETURN', reason: 'แยกรายการปูนออกเป็นคำขอใหม่' }, key())
if (!returned.ok) throw new Error(`return failed: ${JSON.stringify(returned.error)}`)
console.log(JSON.stringify({ requestId }))
await prisma.$disconnect()
