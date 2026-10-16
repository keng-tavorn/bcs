import { systemClock } from '@/lib/clock'
import { inngest } from '@/server/inngest'
import { runRenewalReminders } from '@/server/services/requests/repeat'
import { activeOrganizationIds } from '@/server/services/requests/stale-drafts'

// Job `renewal-reminders` (S6-12 · FR-INT-101 AC2 · BR-FORM-08): once a day, for every organization, remind the
// requester and PROCUREMENT of each service line at the milestones before it ends, once each. A day's run for one
// organization is one command whose key is the date, so a retry repeats nothing; a line reminded before is not again.
export const RENEWAL_REMINDERS_CRON = 'TZ=Asia/Bangkok 0 8 * * *'

export const renewalReminders = inngest.createFunction({ id: 'renewal-reminders', triggers: [{ cron: RENEWAL_REMINDERS_CRON }] }, async ({ step }) => {
  const organizations = await step.run('organizations', () => activeOrganizationIds())
  for (const organizationId of organizations) {
    await step.run(`remind-${organizationId}`, async () => {
      const result = await runRenewalReminders(organizationId, systemClock.now())
      return result.ok ? result.data : { nothing: result.error.code }
    })
  }
  return { organizations: organizations.length }
})
