import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { businessMinutesBetween } from '@/core/sla'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { loadBusinessCalendar } from '@/server/doa/policy'
import { decideTask } from '@/server/services/approvals/decide'
import { remindShareOf } from '@/server/services/approvals/route'
import { createDraft, submitRequest } from '@/server/services/requests'
import { createDoaOrg } from '../support/doa-org'
import { p2p } from '../support/p2p'

// BR-SLA-02 through the services (GC-SLA-07 is the engine): a new task is due after its SLA in business time and is
// reminded half way. The DOA version keeps the reminder as a share of the SLA (escalationPolicy.remindPct = 0.5,
// OQ-06); the engine takes a percent — a share passed as a percent reminded two minutes after assignment.

const NOW = new Date('2026-10-05T02:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}

describe('[FR-NOTI-003/AC1] a new approval task is reminded half way through its SLA', () => {
  it('remindAt is half the SLA in business minutes and dueAt the whole SLA, for the first step and the next', async () => {
    const org = await createDoaOrg()
    const line = await p2p(org, NOW).fundedLine(500_000n)
    // 120,000 with VAT: two steps would be needed only above the DM band; one step is enough here
    const draft = ok(await createDraft(org.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', title: 'วัสดุ', budgetLineId: line, lines: [{ description: 'ปูน', quantity: '1', uom: 'ถุง', unitPrice: '10000.00' }] }, key()))
    ok(await submitRequest(org.ctxOf('req_con', NOW), { requestId: draft.requestId }, key()))
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: draft.requestId } } }, include: { step: true } })
    const calendar = await forTenant(org.organizationId).$transaction((tx) => loadBusinessCalendar(tx, org.organizationId))
    const sla = task.step.slaBusinessMinutes
    expect(businessMinutesBetween(task.assignedAt, task.dueAt!, calendar)).toBe(sla)
    expect(businessMinutesBetween(task.assignedAt, task.remindAt!, calendar)).toBe(Math.floor((sla * 50 + 50) / 100))
    // deciding it ends the route here; the reminder of a task made by a decision uses the same share (decide.ts)
    ok(await decideTask(org.ctxOf('dm_con', NOW), { taskId: task.id, decision: 'APPROVE' }, key()))
  })

  it('reads the share of the DOA version, and falls back to half way for anything that is not a share', () => {
    expect(remindShareOf({ remindPct: 0.5 })).toBe(0.5)
    expect(remindShareOf({ remindPct: 0.25 })).toBe(0.25)
    expect(remindShareOf({})).toBe(0.5)
    expect(remindShareOf(null)).toBe(0.5)
    expect(remindShareOf({ remindPct: 50 })).toBe(0.5)
    expect(remindShareOf({ remindPct: 'x' })).toBe(0.5)
  })
})
