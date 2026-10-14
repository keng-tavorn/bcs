import { randomUUID } from 'node:crypto'
import { StepError } from 'inngest'
import { beforeAll, describe, expect, it } from 'vitest'
import { fund } from '@/core/budget'
import { ManualClock } from '@/lib/clock'
import { applyBudget } from '@/server/budget/ledger'
import { systemCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { appendEvents } from '@/server/events/append'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { DAILY_DIGEST_CRON, dailyDigest, dailyDigestHandler } from '@/server/jobs/daily-digest'
import { renderNotification } from '@/server/notifications/templates'
import { runCommand } from '@/server/services/_pipeline'
import { createDraft, submitRequest } from '../support/requests'
import { getMyNotificationPrefs, updateNotificationPrefs, updateNotificationPrefsCommand } from '@/server/services/self/notification-prefs'
import { escalateTask, remindTaskSla, runDailyDigest, type DigestData } from '@/server/services/sla'
import { sendDailyDigestCommand } from '@/server/services/sla/digest'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// The daily summary (spec §10.3, §4.6 daily-digest, FR-LINE-006, NEW-31) on the §7.4 fixture organization at 08:00 on
// Monday 5 Oct 2026. Requests of the week before: PR-1 (10,000, dm_con, due Thursday 17:00 — overdue), PR-2 (9,000,
// dm_con, due Monday 09:00) and PR-3 (50,000, vp_ops, due Monday 15:00), all charged to CON. coo is EXECUTIVE; DM and VP
// holders are department heads (§2.2). Two budget lines are low (5% of their plan available, digest.budgetLowPct 10):
// one of CON, one of IT.

const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const at = (iso: string) => new Date(iso)
/** Monday 5 Oct 2026, 08:00 Thai time */
const MON_0800 = at('2026-10-05T01:00:00Z')

let org: DoaOrg
const requests: Array<{ requestId: string; taskId: string; number: string }> = []
const lowLines: Record<string, string> = {}

async function submitted(target: DoaOrg, requester: string, grossBaht: string, when: Date) {
  const draft = await createDraft(target.ctxOf(requester, when), { requestTypeCode: 'BUY_GOODS', title: 'วัสดุสำนักงาน', priceIncludesVat: true, lines: [{ description: 'กระดาษ A4', quantity: '1', uom: 'งาน', unitPrice: grossBaht }] }, key())
  if (!draft.ok) throw new Error(`draft failed: ${JSON.stringify(draft.error)}`)
  const sent = await submitRequest(target.ctxOf(requester, when), { requestId: draft.data.requestId }, key())
  if (!sent.ok) throw new Error(`submit failed: ${JSON.stringify(sent.error)}`)
  const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: draft.data.requestId } } } })
  return { requestId: draft.data.requestId, taskId: task.id, number: sent.data.number }
}

/**
 * A budget line of the department with `plannedBaht` planned and `availableBaht` available: funding through the
 * ledger adds to the plan too, so the line starts with the rest of the plan already spent elsewhere
 */
async function budgetLine(target: DoaOrg, department: string, plannedBaht: bigint, availableBaht: bigint): Promise<string> {
  const fy = await prisma.fiscalYear.findFirstOrThrow({ where: { organizationId: target.organizationId, code: 'FY2569' } })
  const cc = await prisma.costCenter.findFirstOrThrow({ where: { organizationId: target.organizationId, code: `CC-${department}` } })
  const code = `${department}-LOW-${randomUUID().slice(0, 4)}`
  const line = await prisma.budgetLine.create({ data: { organizationId: target.organizationId, fiscalYearId: fy.id, departmentId: target.department[department]!, costCenterId: cc.id, code, nameTh: 'งบใกล้หมด', plannedSatang: (plannedBaht - availableBaht) * 100n } })
  await prisma.budgetLineBalance.create({ data: { organizationId: target.organizationId, budgetLineId: line.id } })
  const ctx = systemCtx(target.organizationId, at('2026-01-02T00:00:00Z'), 'seed')
  const importId = randomUUID()
  await forTenant(target.organizationId).$transaction(async (tx) => {
    const funded = await applyBudget(tx, ctx, [{ budgetLineId: line.id, document: { type: 'IMPORT', id: importId }, run: (s) => fund(s, availableBaht * 100n, importId) }])
    if (!funded.ok) throw new Error('fund failed')
    await appendEvents(tx, ctx, funded.events)
  })
  return code
}

beforeAll(async () => {
  setDefaultOutboxSender(null)
  org = await createDoaOrg()
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.coo!, role: 'EXECUTIVE', grantedAt: at('2026-01-01T00:00:00Z') } })
  requests.push(await submitted(org, 'req_con', '10000.00', at('2026-10-01T02:00:00Z')))
  requests.push(await submitted(org, 'req_con', '9000.00', at('2026-10-02T03:00:00Z')))
  requests.push(await submitted(org, 'req_con', '50000.00', at('2026-10-02T09:00:00Z')))
  lowLines.CON = await budgetLine(org, 'CON', 100_000n, 5_000n)
  lowLines.IT = await budgetLine(org, 'IT', 200_000n, 10_000n)
  // a line at exactly 10% left is not below the threshold
  await budgetLine(org, 'PROC', 100_000n, 10_000n)
  // A notification that waits for the summary (§4.7 rule 3): the requester hears the PO went out
  await prisma.notification.create({ data: { organizationId: org.organizationId, recipientMemberId: org.member.req_con!, templateKey: 'po.sent', data: { poId: randomUUID(), number: 'PO-2569-00001' }, urgency: 'DIGEST', dedupeKey: `po.sent:test:${randomUUID()}` } })
})

const digestOf = async (memberId: string, date = '2026-10-05') => prisma.notification.findFirst({ where: { organizationId: org.organizationId, templateKey: 'digest.daily', recipientMemberId: memberId, dedupeKey: `digest.daily:${date}:${memberId}` } })

describe('[FR-LINE-006/AC3] a member turns their own daily summary off; approval and SLA notices stay on (BR-NOTI-04)', () => {
  it('turns it off with an event, refuses a change that changes nothing, and turns it on again', async () => {
    const ctx = org.ctxOf('vp_ops', at('2026-10-04T10:00:00Z'))
    expect(await getMyNotificationPrefs(ctx)).toEqual({ ok: true, data: { digest: true, approvalsAlwaysImmediate: true } })
    expect(await updateNotificationPrefs(ctx, { digest: false }, key())).toEqual({ ok: true, data: { digest: false, approvalsAlwaysImmediate: true } })
    expect(await prisma.member.findUniqueOrThrow({ where: { id: org.member.vp_ops } })).toMatchObject({ notificationPrefs: { digest: false } })
    const events = await prisma.event.findMany({ where: { type: 'member.notification_prefs_updated', aggregateId: org.member.vp_ops } })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ actorType: 'USER', actorMemberId: org.member.vp_ops, data: { digest: false } })
    expect(await updateNotificationPrefs(ctx, { digest: false }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'NO_CHANGE' } } })
    expect(await getMyNotificationPrefs(ctx)).toMatchObject({ ok: true, data: { digest: false } })
    // stays off for the summary of the next test; asst_con shows that it turns on again
    const other = org.ctxOf('asst_con', at('2026-10-04T10:00:00Z'))
    expect(await updateNotificationPrefs(other, { digest: false }, key())).toMatchObject({ ok: true })
    expect(await updateNotificationPrefs(other, { digest: true }, key())).toMatchObject({ ok: true, data: { digest: true } })
    expect(await prisma.event.count({ where: { type: 'member.notification_prefs_updated', aggregateId: org.member.asst_con } })).toBe(2)
  })

  it('cannot silence approval or SLA notices: the command takes no such preference, and the reminder still comes', async () => {
    const ctx = org.ctxOf('dm_con', at('2026-10-04T10:00:00Z'))
    for (const input of [{ taskAssigned: false }, { digest: true, overdue: false }, { approvals: false }]) {
      expect(await updateNotificationPrefs(ctx, input as never, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    }
    // vp_ops turned the summary off, yet is still reminded of PR-3 half way through its SLA (Monday 11:00)
    const pr3 = requests[2]!
    const task = await prisma.approvalTask.findUniqueOrThrow({ where: { id: pr3.taskId } })
    expect(await remindTaskSla(org.organizationId, pr3.taskId, task.remindAt!)).toEqual({ done: true })
    expect(await prisma.notification.count({ where: { templateKey: 'task.reminder', recipientMemberId: org.member.vp_ops, subjectId: pr3.requestId } })).toBe(1)
  })

  it('only the member changes their own preferences: no system job, no deactivated member', async () => {
    expect(await runCommand(systemCtx(org.organizationId, at('2026-10-04T10:00:00Z'), 'daily-digest'), updateNotificationPrefsCommand, { digest: false }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    const gone = await prisma.member.create({ data: { organizationId: org.organizationId, displayNameTh: 'อดีตพนักงาน', email: `${randomUUID()}@test.bcs.local`, status: 'DEACTIVATED' } })
    const ctx = { ...org.ctxOf('req_con', at('2026-10-04T10:00:00Z')), actor: { type: 'USER' as const, memberId: gone.id } }
    expect(await updateNotificationPrefs(ctx, { digest: false }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await getMyNotificationPrefs(ctx)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await prisma.event.count({ where: { type: 'member.notification_prefs_updated', aggregateId: gone.id } })).toBe(0)
  })
})

describe('[FR-LINE-006/AC1] at 08:00 on a business day the approvers, department heads and executives get their summary', () => {
  it('sends each member with something to report one summary of the content of §10.3', async () => {
    expect(await runDailyDigest(org.organizationId, MON_0800)).toEqual({ date: '2026-10-05', sent: 5, reason: null })
    const [pr1, pr2, pr3] = requests as [(typeof requests)[number], (typeof requests)[number], (typeof requests)[number]]
    // dm_con: two tasks waiting, the oldest since Thursday 09:00 (8.5 + 9 business hours) and overdue; head of CON
    const dmCon = await digestOf(org.member.dm_con!)
    expect(dmCon).toMatchObject({ urgency: 'IMMEDIATE', status: 'PENDING' })
    expect(dmCon!.data as unknown as DigestData).toEqual({
      date: '2026-10-05',
      mine: {
        pending: 2,
        overdue: 1,
        oldest: [
          { taskId: pr1.taskId, subjectType: 'REQUEST', subjectId: pr1.requestId, label: pr1.number, ageMinutes: 1050, overdue: true },
          { taskId: pr2.taskId, subjectType: 'REQUEST', subjectId: pr2.requestId, label: pr2.number, ageMinutes: 450, overdue: false },
        ],
      },
      // S6-18: the lines to look at, each once with every reason (here only LOW: nothing is committed on them)
      scope: { kind: 'DEPT', pending: 3, overdue: 1, lowBudgetLines: 1, lowLineCodes: [lowLines.CON], lowPct: 10, budgetLines: 1, budgetLineFlags: [{ code: lowLines.CON, reasons: ['LOW'] }] },
      updates: 0,
    })
    // coo (EXECUTIVE): the whole organization, both low lines; no task of their own
    expect((await digestOf(org.member.coo!))!.data).toEqual({ date: '2026-10-05', mine: null, scope: { kind: 'ORG', pending: 3, overdue: 1, lowBudgetLines: 2, lowLineCodes: [lowLines.CON, lowLines.IT].sort(), lowPct: 10, budgetLines: 2, budgetLineFlags: [lowLines.CON, lowLines.IT].sort().map((code) => ({ code, reasons: ['LOW'] })) }, updates: 0 })
    // the heads of IT and of SUP (IT's parent) see the IT line
    for (const head of ['dm_it', 'vp_sup']) expect((await digestOf(org.member[head]!))!.data).toMatchObject({ mine: null, scope: { kind: 'DEPT', pending: 0, overdue: 0, lowBudgetLines: 1, lowLineCodes: [lowLines.IT] } })
    // the requester: the notification that waited for the summary, now folded in
    expect((await digestOf(org.member.req_con!))!.data).toEqual({ date: '2026-10-05', mine: null, scope: null, updates: 1 })
    expect(await prisma.notification.findFirstOrThrow({ where: { recipientMemberId: org.member.req_con, templateKey: 'po.sent' } })).toMatchObject({ status: 'SENT', sentAt: MON_0800, readAt: null })
    // one event per summary (NEW-34), on the recipient's notification box, with its counts only
    const sent = await prisma.event.findMany({ where: { organizationId: org.organizationId, type: 'notification.digest_sent' } })
    expect(sent.map((e) => e.aggregateId).sort()).toEqual([org.member.dm_con, org.member.coo, org.member.dm_it, org.member.vp_sup, org.member.req_con].sort())
    expect(sent.every((e) => e.aggregateType === 'Notification' && e.actorType === 'SYSTEM')).toBe(true)
    expect(sent.find((e) => e.aggregateId === org.member.dm_con)!.data).toEqual({ date: '2026-10-05', pending: 2, overdue: 1, scope: 'DEPT', scopePending: 3, scopeOverdue: 1, lowBudgetLines: 1, updates: 0 })
    expect(pr3).toBeDefined()
  })

  it('reads politely in Thai and English, links to the board, and carries no items, prices or files (BR-NOTI-01)', async () => {
    const dmCon = await digestOf(org.member.dm_con!)
    const th = renderNotification(dmCon!, 'th')
    const en = renderNotification(dmCon!, 'en')
    expect(th.title).toBe('สรุปประจำวัน: มีงานรอคุณพิจารณา 2 งาน')
    expect(th.body).toContain('โปรดพิจารณางานที่รออนุมัติ 2 งาน (เกินกำหนด 1 งาน)')
    expect(th.body).toContain(`คำขอ ${requests[0]!.number} รอ 17 ชม. 30 นาที เกินกำหนด`)
    expect(th.body).toContain(`บรรทัดงบที่ควรดู 1 บรรทัด: ${lowLines.CON} (เหลือต่ำกว่า 10%)`)
    expect(th.href).toBe('/board/pending')
    expect(en.title).toBe('Daily summary: 2 approvals waiting for you')
    expect(`${en.title}\n${en.body}`).not.toMatch(/[฀-๿]/)
    for (const member of ['dm_con', 'coo', 'req_con', 'dm_it', 'vp_sup']) {
      const text = JSON.stringify((await digestOf(org.member[member]!))!.data)
      expect(text).not.toContain('กระดาษ')
      expect(text).not.toContain('วัสดุสำนักงาน')
    }
    const requester = renderNotification((await digestOf(org.member.req_con!))!, 'th')
    expect(requester).toMatchObject({ title: 'สรุปประจำวัน', href: '/tasks' })
    expect(requester.body).toContain('อัปเดตอื่น 1 รายการ')
    // English counts one thing as one
    expect(renderNotification((await digestOf(org.member.req_con!))!, 'en').body).toBe('1 other update is in your notifications')
    expect(renderNotification((await digestOf(org.member.dm_it!))!, 'en').body).toBe(`In your departments: 0 approvals waiting, 0 past their due time\n1 budget line needs a look: ${lowLines.IT} (under 10% left)`)
  })

  it('names an authority change by its kind in words (it has no number), never by its code', () => {
    const data: DigestData = {
      date: '2026-10-05',
      mine: { pending: 1, overdue: 0, oldest: [{ taskId: randomUUID(), subjectType: 'ORG_AUTHORITY_CHANGE', subjectId: randomUUID(), label: null, changeKind: 'POSITION_ASSIGN', ageMinutes: 30, overdue: false }] },
      scope: null,
      updates: 0,
    }
    const n = { templateKey: 'digest.daily', data, subjectType: null, subjectId: null }
    expect(renderNotification(n, 'th').body).toBe('โปรดพิจารณางานที่รออนุมัติ 1 งาน\n• การเปลี่ยนโครงสร้างอำนาจ (แต่งตั้งผู้ดำรงตำแหน่ง) รอ 30 นาที')
    expect(renderNotification(n, 'en')).toMatchObject({ title: 'Daily summary: 1 approval waiting for you', body: '1 approval is waiting for you\n• Authority change (appointment), waiting 30 min' })
  })

  it('sends one summary a day: a retry repeats nothing', async () => {
    expect(await runDailyDigest(org.organizationId, at('2026-10-05T01:00:30Z'))).toEqual({ date: '2026-10-05', sent: 5, reason: null })
    expect(await prisma.notification.count({ where: { organizationId: org.organizationId, templateKey: 'digest.daily' } })).toBe(5)
    expect(await prisma.event.count({ where: { organizationId: org.organizationId, type: 'notification.digest_sent' } })).toBe(5)
  })

  it('counts an escalated step once: the assignee’s and the co-assignee’s tasks are one approval waiting', async () => {
    const own = await createDoaOrg()
    await prisma.roleAssignment.create({ data: { organizationId: own.organizationId, memberId: own.member.coo!, role: 'EXECUTIVE', grantedAt: at('2026-01-01T00:00:00Z') } })
    // Thursday 1 Oct 09:00, due 17:00, escalated Friday 16:00 to the VP of OPS (BR-SLA-04)
    const one = await submitted(own, 'req_con', '10000.00', at('2026-10-01T02:00:00Z'))
    expect(await escalateTask(own.organizationId, one.taskId, at('2026-10-02T09:00:00Z'))).toMatchObject({ done: true, outcome: 'CO_ASSIGNED' })
    expect(await runDailyDigest(own.organizationId, MON_0800)).toMatchObject({ sent: expect.any(Number), reason: null })
    const digest = async (code: string) => (await prisma.notification.findFirstOrThrow({ where: { organizationId: own.organizationId, templateKey: 'digest.daily', recipientMemberId: own.member[code]! } })).data as unknown as DigestData
    // The executive and the head of CON see one approval waiting, past its due time
    expect((await digest('coo')).scope).toMatchObject({ kind: 'ORG', pending: 1, overdue: 1 })
    expect((await digest('dm_con')).scope).toMatchObject({ kind: 'DEPT', pending: 1, overdue: 1 })
    // Each decider still has it in their own list
    expect((await digest('dm_con')).mine).toMatchObject({ pending: 1, overdue: 1 })
    expect((await digest('vp_ops')).mine).toMatchObject({ pending: 1, overdue: 1 })
  })

  it('one organization whose step fails after Inngest’s retries does not stop the summaries of the others', async () => {
    const failing = await createDoaOrg()
    const working = await createDoaOrg()
    await submitted(working, 'req_con', '1200.00', at('2026-10-02T03:00:00Z'))
    const runs: string[] = []
    const step = {
      run: async <T,>(id: string, fn: () => Promise<T>): Promise<T> => {
        runs.push(id)
        // The run sees only these two organizations (Inngest memoizes the list of the first step)
        if (id === 'organizations') return [failing.organizationId, working.organizationId] as unknown as T
        if (id === `digest-${failing.organizationId}`) throw new StepError(id, new Error('still busy after the retries'))
        return fn()
      },
    }
    const result = await dailyDigestHandler(new ManualClock(MON_0800))(step)
    expect(result).toMatchObject({ organizations: 2, failed: 1 })
    expect(runs).toEqual(['organizations', `digest-${failing.organizationId}`, `digest-${working.organizationId}`])
    // the DM of CON at least: the request waits for them
    expect(result.sent).toBeGreaterThan(0)
    expect(await prisma.notification.count({ where: { organizationId: working.organizationId, templateKey: 'digest.daily' } })).toBe(result.sent)
    expect(await prisma.notification.count({ where: { organizationId: working.organizationId, templateKey: 'digest.daily', recipientMemberId: working.member.dm_con } })).toBe(1)
    // Any other error is not swallowed
    const broken = { run: async <T,>(id: string): Promise<T> => (id === 'organizations' ? ([failing.organizationId] as unknown as T) : Promise.reject(new TypeError('a bug'))) }
    await expect(dailyDigestHandler(new ManualClock(MON_0800))(broken)).rejects.toThrow('a bug')
  })

  it('runs at 08:00 Thai time on weekdays; only the job sends it', async () => {
    expect(DAILY_DIGEST_CRON).toBe('TZ=Asia/Bangkok 0 8 * * 1-5')
    expect(dailyDigest.opts).toMatchObject({ id: 'daily-digest', triggers: [{ cron: DAILY_DIGEST_CRON }] })
    expect(await runCommand(org.ctxOf('coo', at('2026-10-06T01:00:00Z')), sendDailyDigestCommand, { date: '2026-10-06' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    // a system run cannot send another day's summary
    expect(await runCommand(systemCtx(org.organizationId, at('2026-10-06T01:00:00Z'), 'daily-digest'), sendDailyDigestCommand, { date: '2026-10-07' }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'NOT_TODAY' } } })
    expect(await prisma.notification.count({ where: { organizationId: org.organizationId, templateKey: 'digest.daily', dedupeKey: { startsWith: 'digest.daily:2026-10-06' } } })).toBe(0)
  })
})

describe('[FR-LINE-006/AC2] no summary on the organization’s holidays and days off, nor for anyone with nothing to report', () => {
  it('sends nothing on a holiday of the organization or a weekend, and nothing to a member who turned it off', async () => {
    // Tuesday 13 Oct is a holiday of the organization; Saturday 10 Oct is not a working day
    expect(await runDailyDigest(org.organizationId, at('2026-10-13T01:00:00Z'))).toEqual({ date: '2026-10-13', sent: 0, reason: 'HOLIDAY' })
    expect(await runDailyDigest(org.organizationId, at('2026-10-10T01:00:00Z'))).toEqual({ date: '2026-10-10', sent: 0, reason: 'NOT_BUSINESS_DAY' })
    expect(await prisma.notification.count({ where: { organizationId: org.organizationId, templateKey: 'digest.daily', dedupeKey: { in: ['2026-10-13', '2026-10-10'].flatMap((d) => Object.values(org.member).map((m) => `digest.daily:${d}:${m}`)) } } })).toBe(0)
    // FR-LINE-006 AC3: vp_ops has PR-3 waiting but turned the summary off
    expect(await digestOf(org.member.vp_ops!)).toBeNull()
    // nothing to report: the auditor, the CEO (no task of a request here) and asst_con get none
    for (const member of ['auditor', 'ceo', 'asst_con', 'dm_proc', 'admin']) expect(await digestOf(org.member[member]!)).toBeNull()
  })

  it('an organization with nothing to report sends nothing; one that switched the summary off sends nothing', async () => {
    const quiet = await createDoaOrg()
    expect(await runDailyDigest(quiet.organizationId, MON_0800)).toEqual({ date: '2026-10-05', sent: 0, reason: 'NOTHING_TO_REPORT' })
    const off = await createDoaOrg()
    await submitted(off, 'req_con', '1000.00', at('2026-10-02T03:00:00Z'))
    const settings = (await prisma.organization.findUniqueOrThrow({ where: { id: off.organizationId } })).settings as Record<string, unknown>
    await prisma.organization.update({ where: { id: off.organizationId }, data: { settings: { ...settings, digest: { enabled: false, budgetLowPct: 10 } } } })
    expect(await runDailyDigest(off.organizationId, MON_0800)).toEqual({ date: '2026-10-05', sent: 0, reason: 'DIGEST_OFF' })
    expect(await prisma.notification.count({ where: { organizationId: { in: [quiet.organizationId, off.organizationId] }, templateKey: 'digest.daily' } })).toBe(0)
  })
})
