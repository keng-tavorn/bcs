import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { decideTask, provideInfo, requestInfo } from '@/server/services/approvals/decide'
import { workflowReport } from '@/server/services/reports'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { createDraft, submitRequest } from '../support/requests'

// S6-20 (FR-VIS-101 · BR-RPT-03 to BR-RPT-06): the workflow reports against Postgres, on data whose answers are known.
// Monday 5 Oct 2026 09:00: req_con sends A and B (dm_con approves under PR-01); admin of IT sends C. dm_con asks about A
// at 11:00, req_con answers on Wednesday 09:30 and dm_con approves A at 10:30 — a cycle of 1,170 business minutes and a
// decision of 180 once the question's wait is taken out (GC-RPT-06, GC-RPT-07). B is still open on Friday, past its
// due time, so DM@CON is a bottleneck with B's task. A's approval falls in the heatmap's Wednesday 10:00. The CON head
// sees A and B and not C, the IT head C only, and the requester is refused (report.view).

const at = (iso: string) => new Date(iso)
const MON_0900 = at('2026-10-05T02:00:00Z')
const FRI = at('2026-10-09T03:00:00Z')
const PERIOD = { from: '2026-10-05', to: '2026-10-09' }
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}

let org: DoaOrg
const ids: Record<'A' | 'B' | 'C', string> = { A: '', B: '', C: '' }
const openTask = (requestId: string) => prisma.approvalTask.findFirstOrThrow({ where: { status: { in: ['OPEN', 'INFO_REQUESTED'] }, step: { route: { subjectId: requestId } } } })

async function sent(requester: string, unitPrice: string) {
  const draft = ok(await createDraft(org.ctxOf(requester, MON_0900), { requestTypeCode: 'BUY_GOODS', title: 'วัสดุสำนักงาน', priceIncludesVat: true, lines: [{ description: `กระดาษ ${randomUUID().slice(0, 4)}`, quantity: '1', uom: 'งาน', unitPrice }] }, key()))
  ok(await submitRequest(org.ctxOf(requester, MON_0900), { requestId: draft.requestId }, key()))
  return draft.requestId
}

beforeAll(async () => {
  org = await createDoaOrg()
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.coo!, role: 'EXECUTIVE', grantedAt: at('2026-01-01T00:00:00Z') } })
  ids.A = await sent('req_con', '10000.00')
  ids.B = await sent('req_con', '9000.00')
  ids.C = await sent('admin', '8000.00')
  const a = await openTask(ids.A)
  ok(await requestInfo(org.ctxOf('dm_con', at('2026-10-05T04:00:00Z')), { taskId: a.id, question: 'ขอรายละเอียดสเปกกระดาษ' }, key()))
  const question = await prisma.infoRequest.findFirstOrThrow({ where: { taskId: a.id } })
  ok(await provideInfo(org.ctxOf('req_con', at('2026-10-07T02:30:00Z')), { infoRequestId: question.id, answer: 'กระดาษ 80 แกรม' }, key()))
  ok(await decideTask(org.ctxOf('dm_con', at('2026-10-07T03:30:00Z')), { taskId: a.id, decision: 'APPROVE' }, key()))
}, 120_000)

describe('[FR-VIS-101/AC1] [FR-VIS-101/AC2] the workflow reports', () => {
  it('the whole organization: cycle and decision time without the question, a bottleneck, the heatmap', async () => {
    const r = ok(await workflowReport(org.ctxOf('coo', FRI), PERIOD))
    expect(r.scope).toBe('ORG')
    const a = r.cycle.requests.find((x) => x.requestId === ids.A)!
    expect(a.cycleMinutes).toBe(1170)
    expect(r.cycle.requests.find((x) => x.requestId === ids.B)!.cycleMinutes).toBeNull()
    expect(r.cycle.medianDecisionMinutes).toBe(180)
    const b = await openTask(ids.B)
    const dm = r.bottlenecks.byPosition.find((x) => x.at.startsWith('DM@CON'))!
    expect(dm.taskIds).toContain(b.id)
    expect(dm.overdue).toBeGreaterThanOrEqual(1)
    expect(r.bottlenecks.byPerson.find((x) => x.memberId === org.member.dm_con)!.taskIds).toContain(b.id)
    expect(r.heatmap.decisions).toContainEqual({ weekday: 'WED', hour: 10, count: 1 })
    // B and C are open: B on CON for 4 days (over 16 business hours), C on IT
    const con = r.heatmap.openByDepartment.find((x) => x.departmentId === org.department.CON)!
    expect(con.bands.H16_40 + con.bands.H40_PLUS).toBeGreaterThanOrEqual(1)
  })

  it('a department head reads the subtree they head only; a member without report.view is refused', async () => {
    const con = ok(await workflowReport(org.ctxOf('dm_con', FRI), PERIOD))
    expect(con.scope).toBe('DEPT')
    expect(con.cycle.requests.map((x) => x.requestId).sort()).toEqual([ids.A, ids.B].sort())
    expect(con.heatmap.openByDepartment.every((x) => x.departmentId === org.department.CON)).toBe(true)
    const it2 = ok(await workflowReport(org.ctxOf('dm_it', FRI), PERIOD))
    expect(it2.cycle.requests.map((x) => x.requestId)).toEqual([ids.C])
    expect(it2.bottlenecks.byPosition.flatMap((x) => x.taskIds)).not.toContain((await openTask(ids.B)).id)
    expect(await workflowReport(org.ctxOf('req_con', FRI), PERIOD)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})
