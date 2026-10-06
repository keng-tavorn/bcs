import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { systemCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { appendEvents } from '@/server/events/append'
import { decideTask } from '@/server/services/approvals/decide'
import { kpiDetail } from '@/server/services/reports/screens'
import { createDraft, submitRequest } from '@/server/services/requests'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// S5-12 · FR-VIS-003 AC2 (spec §9.9 every number opens its list, §11.4 G-2 (a)): the list behind "การอนุมัติที่ผิด DOA"
// holds every decision the DOA engine checked again, so a figure of 0 still opens the decisions it checked, each marked
// counted or not. The misrouted decisions it counts come first, before newer decisions made by the person the DOA
// names, so the list's cut at KPI_DETAIL_MAX never hides one of them. Real Postgres.

const MONDAY_0900 = new Date('2026-10-05T02:00:00Z')
const at = (hhmm: string) => new Date(`2026-10-05T${hhmm}:00+07:00`)
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}

let org: DoaOrg
const sent: Record<string, { requestId: string; taskId: string }> = {}

/** A purchase request of CON sent Monday 09:00, small enough for the DM, with its open task */
async function submitted(name: string, netBaht: string) {
  const budgetLineId = (await prisma.budgetLine.findFirstOrThrow({ where: { organizationId: org.organizationId, code: 'CON-OPEX-2569' } })).id
  const draft = ok(await createDraft(org.ctxOf('req_con', MONDAY_0900), { requestTypeCode: 'BUY_GOODS', title: name, budgetLineId, lines: [{ description: name, quantity: '1', uom: 'ชิ้น', unitPrice: netBaht }] }, key()))
  ok(await submitRequest(org.ctxOf('req_con', MONDAY_0900), { requestId: draft.requestId }, key()))
  const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: draft.requestId } } } })
  sent[name] = { requestId: draft.requestId, taskId: task.id }
}

beforeAll(async () => {
  org = await createDoaOrg()
  // the CEO (EXECUTIVE) reads the KPI page of the whole organization
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.ceo!, role: 'EXECUTIVE', grantedAt: MONDAY_0900 } })
  await submitted('CABINET', '5000.00')
  await submitted('CHAIR', '6000.00')
  // 10:00: a decision on the cabinet's step by the CEO, whom the DOA does not give it (as in reports.test.ts G-2 (a))
  const task = await prisma.approvalTask.findUniqueOrThrow({ where: { id: sent.CABINET!.taskId }, include: { step: { include: { route: true } } } })
  const ctx = { ...systemCtx(org.organizationId, at('10:00'), 'test'), actor: { type: 'USER' as const, memberId: org.member.ceo! } }
  const { doaVersionId, ruleCode } = task.step.route
  await forTenant(org.organizationId).$transaction(async (tx) => {
    await appendEvents(tx, ctx, [
      {
        type: 'approval_task.decided',
        aggregateType: 'ApprovalTask',
        aggregateId: task.id,
        doaVersionId,
        doaRuleCode: ruleCode,
        data: { decision: 'APPROVE', subjectType: 'REQUEST', subjectId: sent.CABINET!.requestId, doaVersionId, doaRuleCode: ruleCode, channel: 'WEB', actorMemberId: org.member.ceo!, onBehalfOfMemberId: null, reasonCommentId: null },
      },
    ])
  })
  // 11:00 and 13:00: the DM, whom the DOA gives both steps, decides them — later than the CEO's decision
  ok(await decideTask(org.ctxOf('dm_con', at('11:00'), 'LINE_CHAT'), { taskId: sent.CABINET!.taskId, decision: 'APPROVE' }, key()))
  ok(await decideTask(org.ctxOf('dm_con', at('13:00'), 'WEB'), { taskId: sent.CHAIR!.taskId, decision: 'APPROVE' }, key()))
})

describe('[FR-VIS-003/AC2] the list behind G-2 (a) holds every decision checked, the misrouted ones first', () => {
  it('a figure of 1 opens the 3 decisions checked: the CEO’s misrouted one at 10:00 before the DM’s at 13:00 and 11:00', async () => {
    const list = ok(await kpiDetail(org.ctxOf('ceo', at('17:00')), { from: '2026-10-05', to: '2026-10-05' }, 'g2a'))
    expect({ total: list.total, counted: list.counted }).toEqual({ total: 3, counted: 1 })
    expect(list.items.map((i) => ({ mark: i.mark, document: i.document?.id, at: i.at }))).toEqual([
      { mark: 'MISROUTED', document: sent.CABINET!.requestId, at: at('10:00').toISOString() },
      { mark: 'DOA_MATCHED', document: sent.CHAIR!.requestId, at: at('13:00').toISOString() },
      { mark: 'DOA_MATCHED', document: sent.CABINET!.requestId, at: at('11:00').toISOString() },
    ])
    // the other lists stay newest first
    const g2b = ok(await kpiDetail(org.ctxOf('ceo', at('17:00')), { from: '2026-10-05', to: '2026-10-05' }, 'g2b'))
    expect(g2b.items.map((i) => i.at)).toEqual([at('13:00'), at('11:00'), at('10:00')].map((d) => d.toISOString()))
  })

  it('a member who may not read the whole organization’s figures is refused the list', async () => {
    expect(await kpiDetail(org.ctxOf('dm_con', at('17:00')), { from: '2026-10-05', to: '2026-10-05' }, 'g2a')).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})
