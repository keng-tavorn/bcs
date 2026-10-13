import { systemClock } from '@/lib/clock'
import { inngest } from '@/server/inngest'
import { markDueRetentions } from '@/server/services/ap/retention'

// Job retention-due (ADR-124, BR-RET-04, FR-AP-106 AC4): every morning at 08:00 Thai time, each HELD retention whose
// due date has come is marked once (retention.release_due) and FINANCE hears of it in the digest. Tests call
// markDueRetentions directly.

export const RETENTION_DUE_CRON = 'TZ=Asia/Bangkok 0 8 * * *'

export const retentionDue = inngest.createFunction({ id: 'retention-due', retries: 0, triggers: [{ cron: RETENTION_DUE_CRON }] }, async ({ step }) =>
  step.run('mark', () => markDueRetentions(systemClock.now())),
)
