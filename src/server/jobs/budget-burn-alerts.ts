import { systemClock } from '@/lib/clock'
import { inngest } from '@/server/inngest'
import { runBudgetAlerts } from '@/server/services/budget/alerts'
import { activeOrganizationIds } from '@/server/services/requests/stale-drafts'

// Job `budget-burn-alerts` (S6-18 · FR-BUD-104 AC2 · BR-BUD-17): every day before the daily summary, for every
// organization, raise each budget alert reached once per line, alert and fiscal year. One organization's day is one
// command keyed by the date, and an alert raised before is never raised again, so a rerun raises nothing.
export const BUDGET_BURN_ALERTS_CRON = 'TZ=Asia/Bangkok 30 7 * * *'

export const budgetBurnAlerts = inngest.createFunction({ id: 'budget-burn-alerts', triggers: [{ cron: BUDGET_BURN_ALERTS_CRON }] }, async ({ step }) => {
  const organizations = await step.run('organizations', () => activeOrganizationIds())
  for (const organizationId of organizations) {
    await step.run(`alerts-${organizationId}`, async () => {
      const result = await runBudgetAlerts(organizationId, systemClock.now())
      return result.ok ? result.data : { nothing: result.error.code }
    })
  }
  return { organizations: organizations.length }
})
