import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { ManualClock } from '@/lib/clock'
import { prisma } from '@/server/db/client'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import { forTenant } from '@/server/db/tenant'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { approvalTaskSlaHandler, TIMER_MAX_WAITS, type TaskSlaRun, type TimerStep } from '@/server/jobs/approval-task-sla'
import { createDraft, submitRequest } from '@/server/services/requests'
import { markTaskOverdue, refusalOf, RetryableStepError } from '@/server/services/sla'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// The SLA job is not lost to time it cannot see coming (spec §4.6 rules 1–3, BR-SLA-01, BR-SLA-04, FR-NOTI-003): a
// time the calendar moved after the plan (a holiday imported meanwhile), a run that wakes before its time by the
// application's clock (Inngest's clock ahead), and a busy database. Each test has an organization of its own, on the
// §7.4 fixtures: a request of 10,000 baht submitted Monday 5 Oct 2026 09:00 Thai time goes to the DM of CON (PR-01,
// 8 business hours), reminded 13:00, due 17:00 and escalated Tuesday 16:00.

const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const at = (iso: string) => new Date(iso)
const MON_0900 = at('2026-10-05T02:00:00Z')

beforeAll(() => setDefaultOutboxSender(null))

async function freshOrg(): Promise<DoaOrg> {
  const org = await createDoaOrg()
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: at('2026-01-01T00:00:00Z') } })
  return org
}

async function submitted(org: DoaOrg) {
  const draft = await createDraft(org.ctxOf('req_con', MON_0900), { requestTypeCode: 'BUY_GOODS', title: 'วัสดุก่อสร้าง', priceIncludesVat: true, lines: [{ description: 'ปูนซีเมนต์', quantity: '1', uom: 'งาน', unitPrice: '10000.00' }] }, key())
  if (!draft.ok) throw new Error(`draft failed: ${JSON.stringify(draft.error)}`)
  const sent = await submitRequest(org.ctxOf('req_con', MON_0900), { requestId: draft.data.requestId }, key())
  if (!sent.ok) throw new Error(`submit failed: ${JSON.stringify(sent.error)}`)
  const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: draft.data.requestId } } } })
  return { requestId: draft.data.requestId, task }
}

const eventsOf = (type: string, aggregateId: string) => prisma.event.findMany({ where: { type, aggregateId } })

/**
 * A fake Inngest step on a fake clock. sleepUntil() wakes `early` ms before the time it was given (Inngest's clock ahead
 * of the application's); sleep() waits exactly; `hooks` act before a sleep or when a step throws (Inngest retries it).
 */
function fakeStep(clock: ManualClock, options: { early?: number; frozen?: boolean; beforeSleep?: (id: string) => Promise<void>; onThrow?: (id: string, error: unknown) => Promise<void> } = {}) {
  const sleeps: string[] = []
  const runs: string[] = []
  const thrown: string[] = []
  const step: TimerStep = {
    run: async (id, fn) => {
      runs.push(id)
      try {
        return await fn()
      } catch (error) {
        if (!options.onThrow) throw error
        thrown.push(`${id} ${error instanceof RetryableStepError ? error.code : String(error)}`)
        await options.onThrow(id, error)
        // Inngest runs the step again with backoff
        return fn()
      }
    },
    sleepUntil: async (id, until) => {
      sleeps.push(`${id} ${until}`)
      if (options.beforeSleep) await options.beforeSleep(id)
      const wake = new Date(until).getTime() - (options.early ?? 0)
      if (!options.frozen && wake > clock.now().getTime()) clock.set(new Date(wake))
    },
    sleep: async (id, ms) => {
      sleeps.push(`${id} ${ms}`)
      if (!options.frozen) clock.advance(ms)
    },
  }
  return { step, sleeps, runs, thrown }
}

describe('[FR-NOTI-003/AC2] a holiday imported before escalateAt moves the escalation; the run waits for it and escalates', () => {
  it('wakes at the planned Tuesday 16:00, hears it is due Wednesday 16:00 (Tuesday became a holiday), waits a day and escalates', async () => {
    const org = await freshOrg()
    const { task } = await submitted(org)
    const clock = new ManualClock(MON_0900)
    const { step, sleeps, runs } = fakeStep(clock, {
      beforeSleep: async (id) => {
        // While the run sleeps until escalateAt, the organization imports a holiday for Tuesday 6 Oct (BR-SLA-01)
        if (id === 'until-escalate') await prisma.holiday.create({ data: { organizationId: org.organizationId, date: at('2026-10-06T00:00:00Z'), nameTh: 'วันหยุดพิเศษ' } })
      },
    })
    const run = await approvalTaskSlaHandler(clock)({ data: { organizationId: org.organizationId, aggregateId: task.id } }, step)
    // Monday 17:00 → 17:30 is half an hour; Tuesday is off; Wednesday 08:30 + 7.5 hours = 16:00
    expect(sleeps).toEqual(['until-remind 2026-10-05T06:00:00.000Z', 'until-due 2026-10-05T10:00:00.000Z', 'until-escalate 2026-10-06T09:00:00.000Z', 'wait-escalate-1 86400000'])
    expect(runs).toEqual(['plan', 'remind', 'overdue', 'escalate', 'escalate-1'])
    expect(run).toEqual({ taskId: task.id, reminded: true, overdue: true, escalated: 'CO_ASSIGNED', stopped: null })
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ escalatedAt: at('2026-10-07T09:00:00Z'), escalateAt: at('2026-10-07T09:00:00Z') })
    expect(await eventsOf('approval_task.escalated', task.id)).toHaveLength(1)
  })
})

describe('[FR-NOTI-003/AC1] a run that wakes early by the application’s clock waits again; the waits are bounded', () => {
  it('Inngest’s clock 5 seconds ahead: each timer is told 5 seconds are left, waits them and acts once', async () => {
    const org = await freshOrg()
    const { requestId, task } = await submitted(org)
    const clock = new ManualClock(MON_0900)
    const { step, sleeps, runs } = fakeStep(clock, { early: 5_000 })
    const run = await approvalTaskSlaHandler(clock)({ data: { organizationId: org.organizationId, aggregateId: task.id } }, step)
    expect(run).toEqual({ taskId: task.id, reminded: true, overdue: true, escalated: 'CO_ASSIGNED', stopped: null })
    expect(runs).toEqual(['plan', 'remind', 'remind-1', 'overdue', 'overdue-1', 'escalate', 'escalate-1'])
    expect(sleeps.filter((s) => s.startsWith('wait-'))).toEqual(['wait-remind-1 5000', 'wait-overdue-1 5000', 'wait-escalate-1 5000'])
    // Nothing was sent early, and nothing twice
    expect(await prisma.notification.count({ where: { templateKey: 'task.reminder', subjectId: requestId } })).toBe(1)
    expect(await eventsOf('approval_task.overdue', task.id)).toHaveLength(1)
    expect((await prisma.approvalTask.findUniqueOrThrow({ where: { id: task.id } })).overdueAt).toEqual(at('2026-10-05T10:00:00Z'))
    expect(await eventsOf('approval_task.escalated', task.id)).toHaveLength(1)
  })

  it('a clock that never reaches the time: each timer waits TIMER_MAX_WAITS times, then the run ends with NOT_DUE and sends nothing', async () => {
    const org = await freshOrg()
    const { requestId, task } = await submitted(org)
    const clock = new ManualClock(MON_0900)
    const { step, runs } = fakeStep(clock, { frozen: true })
    const run = await approvalTaskSlaHandler(clock)({ data: { organizationId: org.organizationId, aggregateId: task.id } }, step)
    expect(run).toEqual({ taskId: task.id, reminded: false, overdue: false, escalated: null, stopped: 'NOT_DUE' })
    expect(TIMER_MAX_WAITS).toBe(8)
    expect(runs).toHaveLength(1 + 2 * (1 + TIMER_MAX_WAITS))
    expect(await prisma.notification.count({ where: { subjectId: requestId, templateKey: { in: ['task.reminder', 'task.overdue'] } } })).toBe(0)
  })

  it('a refusal NOT_DUE carries the time it is due; a busy database or an unexpected error is thrown, never returned', () => {
    const now = at('2026-10-05T09:59:00Z')
    expect(refusalOf({ code: 'VALIDATION_FAILED', message: 'x', details: { reason: 'NOT_DUE', at: '2026-10-05T10:00:00.000Z' } }, now)).toEqual({ done: false, code: 'VALIDATION_FAILED', reason: 'NOT_DUE', notBefore: '2026-10-05T10:00:00.000Z', waitMs: 60_000 })
    expect(refusalOf({ code: 'INVALID_STATE_TRANSITION', message: 'x', details: { reason: 'CLOSED' } }, now)).toEqual({ done: false, code: 'INVALID_STATE_TRANSITION', reason: 'CLOSED', notBefore: null, waitMs: null })
    for (const code of ['RATE_LIMITED', 'INTERNAL'] as const) {
      expect(() => refusalOf({ code, message: 'secret text that must not travel', details: { requestId: 'req-1' } }, now)).toThrow(RetryableStepError)
      try {
        refusalOf({ code, message: 'secret text that must not travel', details: { requestId: 'req-1' } }, now)
      } catch (error) {
        // The code and the request id only: the command's own message can quote personal data (NFR-SEC-09)
        expect(error).toMatchObject({ code, requestId: 'req-1' })
        expect((error as Error).message).not.toContain('secret')
      }
    }
  })
})

describe('[FR-NOTI-003/AC1] a busy database is no answer: the step throws, Inngest retries it, and the task is still marked overdue', () => {
  it('the task row is locked by another transaction at dueAt: RATE_LIMITED is thrown, the retry marks it overdue and the run goes on', async () => {
    const org = await freshOrg()
    const { task } = await submitted(org)
    let release!: () => void
    let holder: Promise<void> | null = null
    const clock = new ManualClock(MON_0900)
    const { step, runs, thrown } = fakeStep(clock, {
      beforeSleep: async (id) => {
        if (id !== 'until-due') return
        // Another command holds the task for longer than the lock timeout (3 seconds, twice)
        let locked!: () => void
        const isLocked = new Promise<void>((resolve) => (locked = resolve))
        const released = new Promise<void>((resolve) => (release = resolve))
        holder = forTenant(org.organizationId).$transaction(
          async (tx) => {
            await lockRowsForUpdate(tx, 'ApprovalTask', org.organizationId, [task.id])
            locked()
            await released
          },
          { maxWait: 5_000, timeout: 30_000 },
        )
        await isLocked
      },
      onThrow: async () => {
        // Nothing was written by the attempt that gave up
        expect(await eventsOf('approval_task.overdue', task.id)).toHaveLength(0)
        release()
        await holder
      },
    })
    let run: TaskSlaRun | undefined
    try {
      run = await approvalTaskSlaHandler(clock)({ data: { organizationId: org.organizationId, aggregateId: task.id } }, step)
    } finally {
      // whatever happened, the other transaction ends
      release?.()
      await holder
    }
    expect(thrown).toEqual(['overdue RATE_LIMITED'])
    expect(runs).toEqual(['plan', 'remind', 'overdue', 'escalate'])
    expect(run).toEqual({ taskId: task.id, reminded: true, overdue: true, escalated: 'CO_ASSIGNED', stopped: null })
    expect(await eventsOf('approval_task.overdue', task.id)).toHaveLength(1)
  })

  it('the handler itself throws RetryableStepError while the row is held, and answers once it is free', async () => {
    const org = await freshOrg()
    const { task } = await submitted(org)
    let release!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    let locked!: () => void
    const isLocked = new Promise<void>((resolve) => (locked = resolve))
    const holder = forTenant(org.organizationId).$transaction(
      async (tx) => {
        await lockRowsForUpdate(tx, 'ApprovalTask', org.organizationId, [task.id])
        locked()
        await released
      },
      { maxWait: 5_000, timeout: 30_000 },
    )
    await isLocked
    try {
      await expect(markTaskOverdue(org.organizationId, task.id, at('2026-10-05T10:00:00Z'))).rejects.toMatchObject({ name: 'RetryableStepError', code: 'RATE_LIMITED' })
    } finally {
      release()
      await holder
    }
    expect(await markTaskOverdue(org.organizationId, task.id, at('2026-10-05T10:00:30Z'))).toEqual({ done: true, escalateAt: '2026-10-06T09:00:00.000Z' })
  })
})
