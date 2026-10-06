import { StepError } from 'inngest'
import { systemClock, type Clock } from '@/lib/clock'
import { inngest } from '@/server/inngest'
import { runDailyDigest } from '@/server/services/sla'
import { activeOrganizationIds } from '@/server/services/requests/stale-drafts'
import type { TimerStep } from './approval-task-sla'

// Job `daily-digest` (spec §4.6, §10.3, FR-LINE-006): at 08:00 Thai time on weekdays, for every organization, the daily
// summary of each member with something to report. The handler checks the organization's own calendar, so its holidays
// and days off send nothing (AC2); the day is the command's idempotency key, so a retry sends nothing twice. Each
// organization is a step of its own: a busy database makes the handler throw and Inngest retries that step, and an
// organization whose step still fails after the retries does not stop the summaries of the others.
export const DAILY_DIGEST_CRON = 'TZ=Asia/Bangkok 0 8 * * 1-5'

export interface DailyDigestRun {
  readonly organizations: number
  readonly sent: number
  /** Organizations whose step failed after Inngest's retries */
  readonly failed: number
}

export function dailyDigestHandler(clock: Clock) {
  return async (step: Pick<TimerStep, 'run'>): Promise<DailyDigestRun> => {
    const organizations = await step.run('organizations', () => activeOrganizationIds())
    let sent = 0
    let failed = 0
    for (const organizationId of organizations) {
      try {
        sent += (await step.run(`digest-${organizationId}`, () => runDailyDigest(organizationId, clock.now()))).sent
      } catch (error) {
        if (!(error instanceof StepError)) throw error
        failed++
      }
    }
    return { organizations: organizations.length, sent, failed }
  }
}

export const dailyDigest = inngest.createFunction({ id: 'daily-digest', triggers: [{ cron: DAILY_DIGEST_CRON }] }, async ({ step }) =>
  dailyDigestHandler(systemClock)({ run: <T>(id: string, fn: () => Promise<T>) => step.run(id, fn) as Promise<T> }),
)
