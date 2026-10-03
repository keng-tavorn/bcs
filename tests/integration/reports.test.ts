import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { setEmailProvider, type EmailMessage } from '@/integrations/email-provider'
import { systemCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { appendEvents } from '@/server/events/append'
import { decideTask } from '@/server/services/approvals/decide'
import { getDownloadUrl } from '@/server/services/files'
import { computeKpis } from '@/server/services/reports/kpi'
import { createReportSchedule, exportReport, runDueReportSchedules, runReport } from '@/server/services/reports'
import { createDraft, submitRequest } from '@/server/services/requests'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// S4-11 (spec §11.3, §11.4, FR-VIS-002 AC1 AC3, FR-VIS-003 AC1): the KPI view G-1 to G-5 from events, checked on data
// whose answers are known; the report framework runs it within the caller's scope, exports it with a checksum and
// emails it on a schedule.

const MONDAY_0900 = new Date('2026-10-05T02:00:00Z')
const at = (hhmm: string) => new Date(`2026-10-05T${hhmm}:00+07:00`)
const key = () => ({ idempotencyKey: randomUUID(), sender: null })

let org: DoaOrg
const sent: EmailMessage[] = []
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}
const lineOf = async (code: string) => (await prisma.budgetLine.findFirstOrThrow({ where: { organizationId: org.organizationId, code } })).id
const ids: Record<string, { requestId: string; taskId: string }> = {}

async function submitted(name: string, requester: string, budgetLine: string, netBaht: string) {
  const draft = ok(await createDraft(org.ctxOf(requester, MONDAY_0900), { requestTypeCode: 'BUY_GOODS', title: name, budgetLineId: await lineOf(budgetLine), lines: [{ description: name, quantity: '1', uom: 'ชิ้น', unitPrice: netBaht }] }, key()))
  ok(await submitRequest(org.ctxOf(requester, MONDAY_0900), { requestId: draft.requestId }, key()))
  const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: draft.requestId } } } })
  ids[name] = { requestId: draft.requestId, taskId: task.id }
}

beforeAll(async () => {
  setEmailProvider({ send: async (m) => (sent.push(m), { messageId: randomUUID() }) })
  org = await createDoaOrg()
  await prisma.roleAssignment.createMany({ data: [{ organizationId: org.organizationId, memberId: org.member.fin_officer!, role: 'FINANCE', grantedAt: MONDAY_0900 }] })
  // Monday 09:00: five requests of CON (four for the DM, one for the VP) and one of IT
  await submitted('R1', 'req_con', 'CON-OPEX-2569', '5000.00')
  await submitted('R2', 'req_con', 'CON-OPEX-2569', '6000.00')
  await submitted('R3', 'req_con', 'CON-OPEX-2569', '7000.00')
  await submitted('R4', 'req_con', 'CON-OPEX-2569', '30000.00')
  await submitted('R5', 'req_con', 'CON-OPEX-2569', '8000.00')
  await submitted('IT1', 'admin', 'IT-OPEX-2569', '9000.00')
  // decided after 1, 2, 4 and 5 business hours, on LINE chat, LIFF, the web and LINE chat
  ok(await decideTask(org.ctxOf('dm_con', at('10:00'), 'LINE_CHAT'), { taskId: ids.R1!.taskId, decision: 'APPROVE' }, key()))
  ok(await decideTask(org.ctxOf('dm_con', at('11:00'), 'LIFF'), { taskId: ids.R2!.taskId, decision: 'APPROVE' }, key()))
  ok(await decideTask(org.ctxOf('dm_con', at('13:00'), 'WEB'), { taskId: ids.R3!.taskId, decision: 'APPROVE' }, key()))
  ok(await decideTask(org.ctxOf('vp_ops', at('14:00'), 'LINE_CHAT'), { taskId: ids.R4!.taskId, decision: 'APPROVE' }, key()))
  ok(await decideTask(org.ctxOf('dm_it', at('10:00'), 'WEB'), { taskId: ids.IT1!.taskId, decision: 'APPROVE' }, key()))
  // R5 stays open past its 8 business hours
})

afterAll(() => setEmailProvider(null))

const period = { from: new Date('2026-10-05T00:00:00+07:00'), to: new Date('2026-10-06T00:00:00+07:00'), now: new Date('2026-10-06T04:00:00Z') }

describe('[FR-VIS-003/AC1] the KPI view G-1 to G-5 from events, on data whose answers are known', () => {
  it('counts decisions on LINE, decisions with their DOA reference, decision times, tasks past due and budget checks', async () => {
    const k = await forTenant(org.organizationId).$transaction((tx) => computeKpis(tx, org.organizationId, period, null))
    // G-5: R1 LINE chat, R2 LIFF, R4 LINE chat of the six decisions (R3 and IT1 on the web)
    expect(k.g5.total).toEqual({ numerator: 3, denominator: 5 })
    expect(k.g5.bySubject).toEqual({ PURCHASE_REQUEST: { numerator: 3, denominator: 5 } })
    // G-2: every decision came from the DOA engine and names its version and rule
    expect(k.g2).toEqual({ misrouted: 0, checked: 5, withDoaReference: { numerator: 5, denominator: 5 } })
    // G-3: decisions after 60, 120, 240, 300 and 60 business minutes → median 120; R5 past due, 1 of 6 tasks
    expect(k.g3).toEqual({ submitToPoMedianMinutes: null, decisionMedianMinutes: 120, pastDue: { numerator: 1, denominator: 6 } })
    // G-4: no request over budget reached an approver; G-1: no PO yet, and the denominator awaits the Express data
    expect(k.g4.tasksOnFailedBudgetCheck).toBe(0)
    expect(k.g1).toEqual({ numerator: 0, denominator: null })
  })

  it('G-2 (a) finds a decision made by someone the DOA engine would not give the task to', async () => {
    const task = await prisma.approvalTask.findUniqueOrThrow({ where: { id: ids.R3!.taskId }, include: { step: { include: { route: true } } } })
    const ctx = { ...systemCtx(org.organizationId, at('15:00'), 'test'), actor: { type: 'USER' as const, memberId: org.member.ceo! } }
    await forTenant(org.organizationId).$transaction(async (tx) => {
      await appendEvents(tx, ctx, [
        {
          type: 'approval_task.decided',
          aggregateType: 'ApprovalTask',
          aggregateId: task.id,
          doaVersionId: task.step.route.doaVersionId,
          doaRuleCode: task.step.route.ruleCode,
          data: { decision: 'APPROVE', subjectType: 'REQUEST', subjectId: ids.R3!.requestId, doaVersionId: task.step.route.doaVersionId, doaRuleCode: task.step.route.ruleCode, channel: 'WEB', actorMemberId: org.member.ceo!, onBehalfOfMemberId: null, reasonCommentId: null },
        },
      ])
    })
    const k = await forTenant(org.organizationId).$transaction((tx) => computeKpis(tx, org.organizationId, period, null))
    expect(k.g2.misrouted).toBe(1)
  })
})

describe('[FR-VIS-002/AC1] the report framework: the KPI report, its Excel export and a schedule that emails it', () => {
  it('runs, exports with a checksum, and a schedule sends the file once per slot', async () => {
    const report = ok(await runReport(org.ctxOf('fin_officer', period.now), 'KPI', { from: '2026-10-05', to: '2026-10-05' }))
    expect(report.scope).toBe('ORG')
    expect(report.rows.find((r) => r.measure === 'DECISIONS_ON_LINE_ALL')).toMatchObject({ kpi: 'G-5', numerator: '3' })
    const file = ok(await exportReport(org.ctxOf('fin_officer', period.now), { reportCode: 'KPI', params: { from: '2026-10-05', to: '2026-10-05' } }, key()))
    const url = ok(await getDownloadUrl(org.ctxOf('fin_officer', period.now), { fileId: file.fileId })).url
    expect(createHash('sha256').update(new Uint8Array(await (await fetch(url)).arrayBuffer())).digest('hex')).toBe(file.checksum)
    expect(await prisma.exportJob.findUniqueOrThrow({ where: { id: file.exportJobId } })).toMatchObject({ kind: 'REPORT', checksum: file.checksum })

    const schedule = ok(await createReportSchedule(org.ctxOf('fin_officer', period.now), { reportCode: 'KPI', cron: 'TZ=Asia/Bangkok 0 8 * * 1', recipientMemberIds: [org.member.fin_officer!, org.member.ceo!] }, key()))
    expect(await createReportSchedule(org.ctxOf('fin_officer', period.now), { reportCode: 'KPI', cron: 'every monday', recipientMemberIds: [org.member.ceo!] }, key())).toMatchObject({ ok: false, error: { details: { reason: 'CRON' } } })
    expect(await createReportSchedule(org.ctxOf('req_con', period.now), { reportCode: 'KPI', cron: 'TZ=Asia/Bangkok 0 8 * * 1', recipientMemberIds: [org.member.ceo!] }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    // the next Monday 08:00: one file to each recipient, with the report attached; the same slot again sends nothing
    const nextMonday = new Date('2026-10-12T01:05:00Z')
    expect(await runDueReportSchedules(org.organizationId, nextMonday)).toBe(2)
    expect(sent.at(-1)).toMatchObject({ attachments: [{ filename: expect.stringMatching(/^kpi-.*\.xlsx$/) }] })
    expect(await runDueReportSchedules(org.organizationId, new Date('2026-10-12T01:10:00Z'))).toBe(0)
    expect(await prisma.reportSchedule.findUniqueOrThrow({ where: { id: schedule.scheduleId } })).toMatchObject({ lastRunAt: new Date('2026-10-12T01:00:00Z') })
  })
})

describe('[FR-VIS-002/AC3] a report reads only what the caller may see', () => {
  it('the head of CON sees CON only; members without report.view see nothing', async () => {
    const head = ok(await runReport(org.ctxOf('dm_con', period.now), 'KPI', { from: '2026-10-05', to: '2026-10-05' }))
    expect(head.scope).toBe('DEPT')
    // IT1 (IT, on the web) is outside: the CON decisions are R1 to R4 and the extra one of the G-2 (a) case, 3 on LINE
    expect(head.rows.find((r) => r.measure === 'DECISIONS_ON_LINE_ALL')).toMatchObject({ numerator: '3', denominator: '5', value: '60.0' })
    const all = ok(await runReport(org.ctxOf('fin_officer', period.now), 'KPI', { from: '2026-10-05', to: '2026-10-05' }))
    expect(all.rows.find((r) => r.measure === 'DECISIONS_ON_LINE_ALL')).toMatchObject({ numerator: '3', denominator: '6' })
    for (const who of ['req_con', 'receiver_con']) expect(await runReport(org.ctxOf(who, period.now), 'KPI', { from: '2026-10-05', to: '2026-10-05' }), who).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await exportReport(org.ctxOf('req_con', period.now), { reportCode: 'KPI', params: { from: '2026-10-05', to: '2026-10-05' } }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})
