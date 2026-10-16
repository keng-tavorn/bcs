import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { budgetLineAvailability } from '@/server/queries/request-form'
import { decideTask } from '@/server/services/approvals/decide'
import { submitBudgetOverrun } from '@/server/services/budget/overruns'
import { previewRequest } from '@/server/services/requests/preview'
import type { DoaOrg } from '../support/doa-org'
import { createP1Org } from '../support/p1-org'
import { p2p } from '../support/p2p'
import { stepUpForTask } from '../support/pin'
import { createDraft } from '../support/requests'

// S6-16 (FR-BUD-101 · BR-BUD-14) before the requester presses "ส่งขออนุมัติ": the form's budget panel counts the earmark of
// the request's own approved over-budget approval as available to it — as the submit counts it — so the button the
// approval was asked for is not blocked; no one else's request, no other line, and no overrun past its lapsesAt counts
// it. On the phase-1 fixture: a CON line of 100,000.00 with 90,000.00 reserved by an approved request leaves 10,000.00;
// req_con's draft of 70,000.00 is 60,000.00 short, approved by the cfo under OB-02.

const NOW = new Date('2026-10-06T03:00:00Z')
const DAY = '2026-10-06'
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}

let org: DoaOrg
let con: string
let requestId: string

beforeAll(async () => {
  org = await createP1Org()
  con = await p2p(org, NOW).fundedLine(100_000n)
  await p2p(org, NOW).approvedRequest(con, [{ quantity: '1', unitPrice: '90000.00' }])
  requestId = ok(await createDraft(org.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', title: 'งานเปิดตัวโครงการ', budgetLineId: con, lines: [{ description: 'งานเปิดตัวโครงการ', quantity: '1', uom: 'งาน', unitPrice: '70000.00' }] }, key())).requestId
})

describe('[FR-BUD-101/AC2] the form counts the approved over-budget earmark of its own request', () => {
  it('10,000.00 before; 70,000.00 once the 60,000.00 is approved — and only for that request, on that line, before it lapses', async () => {
    const available = async (at = NOW, of: string | null = requestId) => (await budgetLineAvailability(org.ctxOf('req_con', at), { budgetLineId: con, day: DAY, requestId: of }))?.available.amount
    expect(await available()).toBe('10000.00')

    const asked = ok(await submitBudgetOverrun(org.ctxOf('req_con', NOW), { requestId, reason: 'งานเปิดตัวโครงการต้องจัดก่อนสิ้นเดือน' }, key()))
    // Waiting: nothing is earmarked yet
    expect(await available()).toBe('10000.00')
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: asked.overrunId } } } })
    await stepUpForTask(task.id, task.assigneeMemberId)
    ok(await decideTask(org.ctxOf('cfo', NOW), { taskId: task.id, decision: 'APPROVE' }, key()))

    expect(await available()).toBe('70000.00')
    // Another draft of the requester on the same line does not get it
    expect(await available(NOW, null)).toBe('10000.00')
    // Past its lapsesAt it is never used, so the form does not count it
    const lapsesAt = (await prisma.budgetOverrun.findUniqueOrThrow({ where: { id: asked.overrunId } })).lapsesAt!
    expect(await available(new Date(lapsesAt.getTime() + 1))).toBe('10000.00')

    // The preview the review step reads: enough, so the send button is not blocked
    const preview = ok(await previewRequest(org.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', requestId, budgetLineId: con, lines: [{ quantity: '1', unitPrice: '70000.00', vatable: true }], priceIncludesVat: false }, 'th'))
    expect(preview.budget).toMatchObject({ kind: 'LINE', enough: true, available: { amount: '70000.00' } })
  })
})
