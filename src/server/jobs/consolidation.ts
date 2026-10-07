import { systemClock } from '@/lib/clock'
import { getEnv } from '@/lib/env'
import { pollingCron } from '@/lib/job-cadence'
import { inngest } from '@/server/inngest'
import { runScheduledConsolidation } from '@/server/services/procurement'
import { activeOrganizationIds } from '@/server/services/requests/stale-drafts'

// Job `consolidation` (FR-P2P-002 AC2, BR-CONS-01): every five minutes, for every organization, run the consolidation
// round its cron (settings consolidation.cron, OQ-13 default 10:00 and 15:00 on business days) has due, once per slot
// — the slot is the command's idempotency key and a unique index of ConsolidationRun. Every 30 minutes on staging
// (ADR-054), so a round at :00 or :30 still runs on time.
export const CONSOLIDATION_CHECK_CRON = 'TZ=Asia/Bangkok */5 * * * *'

export const consolidationRound = inngest.createFunction({ id: 'consolidation', triggers: [{ cron: pollingCron(CONSOLIDATION_CHECK_CRON, getEnv().APP_ENV) }] }, async ({ step }) => {
  const organizations = await step.run('organizations', () => activeOrganizationIds())
  for (const organizationId of organizations) {
    await step.run(`round-${organizationId}`, () => runScheduledConsolidation(organizationId, systemClock.now()))
  }
  return { organizations: organizations.length }
})
