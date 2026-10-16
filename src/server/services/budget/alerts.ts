import { z } from 'zod'
import { TZDate } from '@date-fns/tz'
import { systemCtx } from '@/server/context'
import type { EventDraft } from '@/server/events/append'
import { defineCommand, runCommand, type CommandOutcome } from '../_pipeline'
import { burnContext, burnOf } from './burn'
import { BUDGET_LINE_AMOUNTS, lineAmounts } from './dashboard'

// Budget alerts (S6-18 · FR-BUD-104 AC2 · BR-BUD-17 · OQ-113): once a day, for each open budget line of the fiscal year
// today falls in, every alert its burn has reached — use at a threshold of budget.alertThresholdsBp, or a forecast
// above the budget — is raised once: budget.alert_raised, never again for the same line, alert and fiscal year, however
// often the job runs. Who hears of it reads the daily summary (DEPT_HEAD of the line's department, BUDGET_ADMIN), which
// lists the line once with every reason (sla/digest.ts).

export const BUDGET_ALERTS_JOB = 'budget-burn-alerts'

const refuse = (message: string): CommandOutcome<never> => ({ ok: false, error: { code: 'NOT_FOUND', message } })

export const raiseBudgetAlertsCommand = defineCommand({
  name: 'budget.raise_alerts',
  capability: 'budget.view',
  input: z.strictObject({}),
  async execute(tx, _input, ctx): Promise<CommandOutcome<{ raised: number }>> {
    if (ctx.actor.type !== 'SYSTEM') return { ok: false, error: { code: 'FORBIDDEN', message: 'only the budget-burn-alerts job raises budget alerts' } }
    const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true, timezone: true } })
    const local = new TZDate(ctx.now.getTime(), org.timezone)
    const day = new Date(Date.UTC(local.getFullYear(), local.getMonth(), local.getDate()))
    const year = await tx.fiscalYear.findFirst({ where: { startsOn: { lte: day }, endsOn: { gte: day } }, select: { id: true, startsOn: true, endsOn: true } })
    if (!year) return refuse('no fiscal year covers today')
    const lines = await tx.budgetLine.findMany({ where: { fiscalYearId: year.id, status: 'OPEN' }, select: { id: true, ...BUDGET_LINE_AMOUNTS }, orderBy: { id: 'asc' } })
    const pace = burnContext(year, ctx.now, org.timezone, org.settings)
    // Raised before for this fiscal year: never again
    const seen = new Set(
      (await tx.event.findMany({ where: { type: 'budget.alert_raised', aggregateId: { in: lines.map((l) => l.id) } }, select: { aggregateId: true, data: true } }))
        .filter((e) => (e.data as { fiscalYearId: string }).fiscalYearId === year.id)
        .map((e) => `${e.aggregateId}|${(e.data as { alert: string }).alert}`),
    )
    const events: EventDraft[] = []
    for (const line of lines) {
      const burn = burnOf(lineAmounts(line), pace)
      for (const alert of burn.alerts) {
        if (seen.has(`${line.id}|${alert}`)) continue
        events.push({ type: 'budget.alert_raised', aggregateType: 'BudgetLine', aggregateId: line.id, data: { fiscalYearId: year.id, alert, usedBp: burn.usedBp!, forecastBp: burn.forecastBp } })
      }
    }
    if (events.length === 0) return refuse('no new budget alert')
    return { ok: true, result: { raised: events.length }, events }
  },
})

/** What the job budget-burn-alerts runs for one organization on one day; the day is the idempotency key */
export function runBudgetAlerts(organizationId: string, now: Date) {
  return runCommand(systemCtx(organizationId, now, BUDGET_ALERTS_JOB), raiseBudgetAlertsCommand, {}, { idempotencyKey: `${BUDGET_ALERTS_JOB}:${now.toISOString().slice(0, 10)}` })
}
