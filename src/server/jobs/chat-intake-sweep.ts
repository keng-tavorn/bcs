import { systemClock } from '@/lib/clock'
import { getEnv } from '@/lib/env'
import { inngest } from '@/server/inngest'
import { chatSweepOrganizationIds, runChatIntakeSweep } from '@/server/services/chat-intake'

// Job `chat-intake-sweep` (S17-06 · BR-LINE-10, BR-LINE-11 · OQ-161 OQ-162 · ADR-162): every hour, for every
// organization (a suspended one too: retention holds for all), chat drafts nobody used for expireHours expire, the text and
// unused photos of closed drafts are cleared after textRetentionDays, photos the image job gave up become FAILED, and
// message text nobody processed within 24 hours is deleted. The time is taken once per run, so a step Inngest tries again
// keeps its hour, which is the commands' idempotency key: a retry repeats nothing and finishes what failed.
export const CHAT_INTAKE_SWEEP_CRON = 'TZ=Asia/Bangkok 23 * * * *'
/** Staging (free Inngest plan, ADR-054; no real data, OQ-19): every three hours instead (ADR-175) */
export const CHAT_INTAKE_SWEEP_STAGING_CRON = 'TZ=Asia/Bangkok 23 */3 * * *'

export const chatIntakeSweep = inngest.createFunction(
  { id: 'chat-intake-sweep', triggers: [{ cron: getEnv().APP_ENV === 'staging' ? CHAT_INTAKE_SWEEP_STAGING_CRON : CHAT_INTAKE_SWEEP_CRON }] },
  async ({ step }) => {
    const organizations = await step.run('organizations', () => chatSweepOrganizationIds())
    const now = await step.run('now', async () => systemClock.now().toISOString())
    for (const organizationId of organizations) {
      await step.run(`sweep-${organizationId}`, () => runChatIntakeSweep(organizationId, new Date(now)))
    }
    return { organizations: organizations.length }
  },
)
