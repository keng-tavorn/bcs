import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { decideTask } from '@/server/services/approvals/decide'
import { createDraft, submitRequest } from '@/server/services/requests'
import type { DoaOrg } from '../support/doa-org'
import { createTwoStepOrg } from '../support/two-step-doa'

// S6-01 (docs/sub-specs/S6.md "Entity และ migration", INV-WF-01): a route stored after the S6 migration but before
// any reviewer rule is the route of before S6 — every step an APPROVAL step whose doaStepNo is its step number, every
// task slot 1 with no reviewer rule, and the second step's task the same way once the first is approved.

const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const MON_0900 = new Date('2026-10-05T02:00:00Z')
const MON_1000 = new Date('2026-10-05T03:00:00Z')

let org: DoaOrg
beforeAll(async () => {
  setDefaultOutboxSender(null)
  org = await createTwoStepOrg()
})

describe('[FR-WF-102/AC4] [INV-WF-01] routes without reviewers keep one slot per step', () => {
  it('a two-step route: APPROVAL steps numbered as resolveRoute gave them, tasks in slot 1', async () => {
    const draft = await createDraft(org.ctxOf('req_con', MON_0900), { requestTypeCode: 'BUY_GOODS', title: 'วัสดุก่อสร้าง', priceIncludesVat: true, lines: [{ description: 'ปูนซีเมนต์', quantity: '1', uom: 'งาน', unitPrice: '10000.00' }] }, key())
    if (!draft.ok) throw new Error(JSON.stringify(draft.error))
    const sent = await submitRequest(org.ctxOf('req_con', MON_0900), { requestId: draft.data.requestId }, key())
    if (!sent.ok) throw new Error(JSON.stringify(sent.error))

    const route = await prisma.approvalRoute.findFirstOrThrow({ where: { subjectId: draft.data.requestId }, include: { steps: { orderBy: { stepNo: 'asc' } } } })
    expect(route.workflowVersionId).toBeNull()
    expect(route.steps.map((s) => [s.stepNo, s.kind, s.doaStepNo, s.reviewGroups])).toEqual([
      [1, 'APPROVAL', 1, null],
      [2, 'APPROVAL', 2, null],
    ])

    const first = await prisma.approvalTask.findFirstOrThrow({ where: { stepId: route.steps[0]!.id } })
    expect([first.slotNo, first.workflowRuleCodes]).toEqual([1, []])
    const decided = await decideTask(org.ctxOf('dm_con', MON_1000), { taskId: first.id, decision: 'APPROVE' }, key())
    if (!decided.ok) throw new Error(JSON.stringify(decided.error))

    const second = await prisma.approvalTask.findFirstOrThrow({ where: { stepId: route.steps[1]!.id } })
    expect([second.slotNo, second.workflowRuleCodes, second.status]).toEqual([1, [], 'OPEN'])
  })
})
