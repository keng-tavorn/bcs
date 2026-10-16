import { randomUUID } from 'node:crypto'
import { systemClock } from '@/lib/clock'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { createDraft, submitRequest } from '../support/requests'
import { E2E_DB } from '../support/e2e-env'

// Run by tests/e2e/prepare-db.ts against bcs_e2e only: a little activity for the screens that show it. Two requesters
// each submit two requests through the services, so the VP of OPS and the VP of SUP each have two approval tasks and
// two notifications in their bell (FR-NOTI-001). One approver per Playwright project, so TOTP codes never repeat.
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('e2e activity is created in the e2e database only')

const now = systemClock.now()
for (const requester of ['req_con', 'fin_officer']) {
  const member = await prisma.member.findFirstOrThrow({ where: { employeeCode: requester }, select: { id: true, organizationId: true, primaryDepartment: { select: { code: true } } } })
  const ctx = makeCtx({ organizationId: member.organizationId, actor: { type: 'USER', memberId: member.id }, channel: 'WEB', now })
  // The operating budget of the requester's department (CON also has a capital line, so the request names one)
  const line = await prisma.budgetLine.findFirstOrThrow({ where: { organizationId: member.organizationId, code: `${member.primaryDepartment!.code}-OPEX-2569` }, select: { id: true } })
  // Two different items, so the second is not a duplicate of the first (S6-13 · BR-DUP-03 asks for a reason then)
  for (const [n, gross] of [['1', '45000.00'], ['2', '50000.00']] as const) {
    const draft = await createDraft(ctx, { requestTypeCode: 'BUY_GOODS', title: 'วัสดุสำหรับงานทดสอบ', priceIncludesVat: true, budgetLineId: line.id, lines: [{ description: `วัสดุ ชุดที่ ${n}`, quantity: '1', uom: 'งาน', unitPrice: gross }] }, { idempotencyKey: randomUUID(), sender: null })
    if (!draft.ok) throw new Error(`draft failed: ${JSON.stringify(draft.error)}`)
    const sent = await submitRequest(ctx, { requestId: draft.data.requestId }, { idempotencyKey: randomUUID(), sender: null })
    if (!sent.ok) throw new Error(`submit failed: ${JSON.stringify(sent.error)}`)
  }
}
await prisma.$disconnect()
console.log('e2e activity ready')
