import { systemClock } from '@/lib/clock'
import { inngest } from '@/server/inngest'
import { runMonthlyGrant } from '@/server/services/ai'
import { activeOrganizationIds } from '@/server/services/requests/stale-drafts'

// Job `ai-credit-monthly` (BR-AI-23, OQ-143, ADR-145): every organization with the AI module gets the month's credits
// (settings.ai.monthlyCredits) at 00:05 Thai time on the 1st. It runs every day at that time and grants the month only
// where it is missing, so an organization whose AI module is switched on mid-month has its credits the next morning
// instead of waiting for the 1st. One grant per organization and month: the grant command finds the month's row and a
// unique index refuses a second; an organization without the module is skipped.
export const AI_CREDIT_MONTHLY_CRON = 'TZ=Asia/Bangkok 5 0 * * *'

export const aiCreditMonthly = inngest.createFunction({ id: 'ai-credit-monthly', triggers: [{ cron: AI_CREDIT_MONTHLY_CRON }] }, async ({ step }) => {
  const organizations = await step.run('organizations', () => activeOrganizationIds())
  let granted = 0
  for (const organizationId of organizations) {
    const r = await step.run(`grant-${organizationId}`, async () => {
      const result = await runMonthlyGrant(organizationId, systemClock.now())
      return result.ok ? result.data : { skipped: result.error.code }
    })
    if ('credits' in r) granted++
  }
  return { organizations: organizations.length, granted }
})
