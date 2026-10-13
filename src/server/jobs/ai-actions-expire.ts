import { systemClock } from '@/lib/clock'
import { inngest } from '@/server/inngest'
import { runAgentActionSweep } from '@/server/services/ai'
import { activeOrganizationIds } from '@/server/services/requests/stale-drafts'

// Job `ai-actions-expire` (docs/sub-specs/S13.md "งานเบื้องหลัง", ADR-145): every hour, for every organization, a
// PENDING call past 15 minutes fails, an L1 draft nobody applied for 24 hours expires, and the content of AI results
// nobody used is cleared after its retention (BR-AI-18). The hour is the idempotency key, so a retry repeats nothing.
export const AI_ACTIONS_EXPIRE_CRON = 'TZ=Asia/Bangkok 17 * * * *'

export const aiActionsExpire = inngest.createFunction({ id: 'ai-actions-expire', triggers: [{ cron: AI_ACTIONS_EXPIRE_CRON }] }, async ({ step }) => {
  const organizations = await step.run('organizations', () => activeOrganizationIds())
  for (const organizationId of organizations) {
    await step.run(`sweep-${organizationId}`, () => runAgentActionSweep(organizationId, systemClock.now()))
  }
  return { organizations: organizations.length }
})
