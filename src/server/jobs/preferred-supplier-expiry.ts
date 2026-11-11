import { systemClock } from '@/lib/clock'
import { inngest } from '@/server/inngest'
import { runPreferredSupplierExpiry } from '@/server/services/sourcing'
import { activeOrganizationIds } from '@/server/services/requests/stale-drafts'

// Job `preferred-supplier-expiry` (S10-13 · BR-RFX-14 · docs/sub-specs/S10.md "job Inngest ใหม่"): once a day, for every
// organization, warn PROCUREMENT (DIGEST) of each preferred supplier in effect that ends within 30 days, once per row and
// end. The rows themselves never change: whether one is in effect is read from the day. A day's run for one organization
// is one command whose key is the date, so a retry repeats nothing; MODULE_DISABLED (SOURCING off) and NOT_FOUND
// (nothing ends soon, or every warning was sent) are the normal answers of a quiet day.
export const PREFERRED_SUPPLIER_EXPIRY_CRON = 'TZ=Asia/Bangkok 0 7 * * *'

export const preferredSupplierExpiry = inngest.createFunction({ id: 'preferred-supplier-expiry', triggers: [{ cron: PREFERRED_SUPPLIER_EXPIRY_CRON }] }, async ({ step }) => {
  const organizations = await step.run('organizations', () => activeOrganizationIds())
  for (const organizationId of organizations) {
    await step.run(`warn-${organizationId}`, async () => {
      const result = await runPreferredSupplierExpiry(organizationId, systemClock.now())
      return result.ok ? result.data : { nothing: result.error.code }
    })
  }
  return { organizations: organizations.length }
})
