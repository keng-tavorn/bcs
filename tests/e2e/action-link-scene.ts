import { randomUUID } from 'node:crypto'
import { systemClock } from '@/lib/clock'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { createDraft, submitRequest } from '@/server/services/requests'
import { emailLinkSecret } from '@/server/tokens/action-tokens'
import { amountToSatang } from '@/core/money/dto'
import { E2E_DB } from '../support/e2e-env'
import { makeRoom } from './budget-room'

// Run by tests/e2e/action-link.spec.ts against the e2e database only (S4-06, FR-NOTI-002): the requester named in
// SCENE_REQUESTER submits a request of four cartridges at SCENE_UNIT_PRICE (2,000 baht unless given: 8,000 baht)
// through the services, so the DM of their department gets the task and its e-mail token. Prints the request number,
// the approver (code and name), the task and the link "<tokenId>.<secret>" as JSON on the last line — the same link the
// task e-mail carries.
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the action link scene runs in the e2e database only')

const requester = process.env.SCENE_REQUESTER ?? 'proc_officer'
const unitPrice = process.env.SCENE_UNIT_PRICE ?? '2000.00'
const member = await prisma.member.findFirstOrThrow({ where: { employeeCode: requester }, select: { id: true, organizationId: true, primaryDepartment: { select: { code: true } } } })
const ctx = makeCtx({ organizationId: member.organizationId, actor: { type: 'USER', memberId: member.id }, channel: 'WEB', now: systemClock.now() })
const line = await prisma.budgetLine.findFirstOrThrow({ where: { organizationId: member.organizationId, code: `${member.primaryDepartment!.code}-OPEX-2569` }, select: { id: true, code: true } })
// the specs of a run spend the same lines: a budget admin tops this one up when they have left less (./budget-room.ts)
// four at the unit price, with VAT on top: room for five
await makeRoom(line.code, amountToSatang(unitPrice) * 5n)
const draft = await createDraft(
  ctx,
  { requestTypeCode: 'BUY_GOODS', title: 'อุปกรณ์สำนักงาน', budgetLineId: line.id, lines: [{ description: 'หมึกพิมพ์', quantity: '4', uom: 'ตลับ', unitPrice }] },
  { idempotencyKey: randomUUID(), sender: null },
)
if (!draft.ok) throw new Error(`draft failed: ${JSON.stringify(draft.error)}`)
const sent = await submitRequest(ctx, { requestId: draft.data.requestId }, { idempotencyKey: randomUUID(), sender: null })
if (!sent.ok) throw new Error(`submit failed: ${JSON.stringify(sent.error)}`)
const task = await prisma.approvalTask.findFirstOrThrow({ where: { step: { route: { subjectId: draft.data.requestId } } }, select: { id: true, assignee: { select: { employeeCode: true, displayNameTh: true } } } })
const token = await prisma.actionToken.findFirstOrThrow({ where: { taskId: task.id, channel: 'EMAIL' }, select: { id: true } })
console.log(
  JSON.stringify({ number: sent.data.number, approver: task.assignee.employeeCode, approverName: task.assignee.displayNameTh, taskId: task.id, link: `${token.id}.${emailLinkSecret(token.id)}` }),
)
await prisma.$disconnect()
