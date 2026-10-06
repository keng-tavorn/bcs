import { systemClock } from '@/lib/clock'
import { inngest } from '@/server/inngest'
import { activeOrganizationIds, runDraftExpiry } from '@/server/services/requests/stale-drafts'

// Job `draft-expiry` (FR-INT-006 AC3, NEW-07): once a day, for every organization, warn the requesters of drafts idle
// for 83 days and remove the drafts idle for 90 days that were warned at least 7 days before. A day's run for one
// organization is one command whose key is the date, so a retry repeats nothing.
export const DRAFT_EXPIRY_CRON = 'TZ=Asia/Bangkok 30 2 * * *'

export const draftExpiry = inngest.createFunction({ id: 'draft-expiry', triggers: [{ cron: DRAFT_EXPIRY_CRON }] }, async ({ step }) => {
  const organizations = await step.run('organizations', () => activeOrganizationIds())
  for (const organizationId of organizations) {
    await step.run(`expire-${organizationId}`, async () => {
      const result = await runDraftExpiry(organizationId, systemClock.now())
      return result.ok ? result.data : { nothing: result.error.code }
    })
  }
  return { organizations: organizations.length }
})
