import { systemClock } from '@/lib/clock'
import { inngest } from '@/server/inngest'
import { runAgentActionSweep } from '@/server/services/ai'
import { listOrganizationsForPlatform } from '@/server/db/lookups'

// Job `ai-actions-expire` (docs/sub-specs/S13.md "งานเบื้องหลัง", ADR-145): every hour, for every organization — a
// suspended one too: what BR-AI-18 clears is cleared whatever the organization's status (as the chat sweep does) — a
// PENDING call past 15 minutes fails, an L1 draft nobody applied for 24 hours expires, and the content of AI results
// nobody used is cleared after its retention (BR-AI-18). The hour is the idempotency key, so a retry repeats nothing.
export const AI_ACTIONS_EXPIRE_CRON = 'TZ=Asia/Bangkok 17 * * * *'

export const aiActionsExpire = inngest.createFunction({ id: 'ai-actions-expire', triggers: [{ cron: AI_ACTIONS_EXPIRE_CRON }] }, async ({ step }) => {
  const organizations = await step.run('organizations', async () => (await listOrganizationsForPlatform()).map((o) => o.id))
  for (const organizationId of organizations) {
    await step.run(`sweep-${organizationId}`, () => runAgentActionSweep(organizationId, systemClock.now()))
  }
  return { organizations: organizations.length }
})
