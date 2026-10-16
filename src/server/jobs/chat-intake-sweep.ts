import { systemClock } from '@/lib/clock'
import { inngest } from '@/server/inngest'
import { runChatIntakeSweep } from '@/server/services/chat-intake'
import { activeOrganizationIds } from '@/server/services/requests/stale-drafts'

// Job `chat-intake-sweep` (S17-06 · BR-LINE-10, BR-LINE-11 · OQ-161 OQ-162 · ADR-162): every hour, for every
// organization, chat drafts nobody used for expireHours expire, the text and unused photos of closed drafts are cleared
// after textRetentionDays, photos the image job gave up become FAILED, and message text nobody processed within 24 hours
// is deleted. The hour is the idempotency key, so a retry repeats nothing.
export const CHAT_INTAKE_SWEEP_CRON = 'TZ=Asia/Bangkok 23 * * * *'

export const chatIntakeSweep = inngest.createFunction({ id: 'chat-intake-sweep', triggers: [{ cron: CHAT_INTAKE_SWEEP_CRON }] }, async ({ step }) => {
  const organizations = await step.run('organizations', () => activeOrganizationIds())
  for (const organizationId of organizations) {
    await step.run(`sweep-${organizationId}`, () => runChatIntakeSweep(organizationId, systemClock.now()))
  }
  return { organizations: organizations.length }
})
