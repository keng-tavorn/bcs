import { randomUUID } from 'node:crypto'
import { systemClock } from '@/lib/clock'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { createDraft, submitRequest } from '../support/requests'
import { amountToSatang } from '@/core/money/dto'
import { E2E_DB } from '../support/e2e-env'
import { makeRoom } from './budget-room'

// Run by tests/e2e/delegation.spec.ts against the e2e database only (the S2 demo scene of NEW-06): after dm_con has
// named asst_con as acting approver on the web, req_con submits a 10,000 baht request through the services, the way
// the request page will. Prints the number and who holds its approval task, as JSON on the last line.
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the delegation scene runs in the e2e database only')

const member = await prisma.member.findFirstOrThrow({ where: { employeeCode: 'req_con' }, select: { id: true, organizationId: true, primaryDepartment: { select: { code: true } } } })
const ctx = makeCtx({ organizationId: member.organizationId, actor: { type: 'USER', memberId: member.id }, channel: 'WEB', now: systemClock.now() })
const line = await prisma.budgetLine.findFirstOrThrow({ where: { organizationId: member.organizationId, code: `${member.primaryDepartment!.code}-OPEX-2569` }, select: { id: true, code: true } })
// the specs of a run spend the same lines: a budget admin tops this one up when they have left less (./budget-room.ts)
await makeRoom(line.code, amountToSatang('10000.00'))
const draft = await createDraft(
  ctx,
  { requestTypeCode: 'BUY_GOODS', title: 'วัสดุหน้างานระหว่างรักษาการ', priceIncludesVat: true, budgetLineId: line.id, lines: [{ description: 'วัสดุสิ้นเปลือง', quantity: '1', uom: 'งาน', unitPrice: '10000.00' }] },
  { idempotencyKey: randomUUID(), sender: null },
)
if (!draft.ok) throw new Error(`draft failed: ${JSON.stringify(draft.error)}`)
const sent = await submitRequest(ctx, { requestId: draft.data.requestId }, { idempotencyKey: randomUUID(), sender: null })
if (!sent.ok) throw new Error(`submit failed: ${JSON.stringify(sent.error)}`)
const task = await prisma.approvalTask.findFirstOrThrow({ where: { step: { route: { subjectId: draft.data.requestId } } }, select: { assigneeMemberId: true, principalMemberId: true } })
const codeOf = async (id: string | null) => (id ? (await prisma.member.findUniqueOrThrow({ where: { id }, select: { employeeCode: true } })).employeeCode : null)
console.log(JSON.stringify({ number: sent.data.number, assignee: await codeOf(task.assigneeMemberId), principal: await codeOf(task.principalMemberId) }))
await prisma.$disconnect()
