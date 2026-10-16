import { systemClock } from '@/lib/clock'
import { inngest } from '@/server/inngest'
import { runOverrunLapse } from '@/server/services/budget/overruns'
import { activeOrganizationIds } from '@/server/services/requests/stale-drafts'

// Job `budget-overrun-lapse` (S6-16 · FR-BUD-101 · BR-BUD-15): every hour, for every organization, an approved
// over-budget approval past its lapsesAt gives its earmark back and the shortfall leaves the budget line; one lapsing
// within two days reminds its requester once. One organization's run in one hour is one command keyed by the hour, so a
// retry repeats nothing. A submit after lapsesAt never uses the overrun even before this job runs (overrun-use.ts).
export const BUDGET_OVERRUN_LAPSE_CRON = 'TZ=Asia/Bangkok 5 * * * *'

export const budgetOverrunLapse = inngest.createFunction({ id: 'budget-overrun-lapse', triggers: [{ cron: BUDGET_OVERRUN_LAPSE_CRON }] }, async ({ step }) => {
  const organizations = await step.run('organizations', () => activeOrganizationIds())
  for (const organizationId of organizations) {
    await step.run(`lapse-${organizationId}`, async () => {
      const result = await runOverrunLapse(organizationId, systemClock.now())
      return result.ok ? result.data : { nothing: result.error.code }
    })
  }
  return { organizations: organizations.length }
})
