import { describe, expect, it, vi } from 'vitest'
import { MS_PER_MINUTE } from '@/lib/constants'

// The job functions as Inngest registers them on staging (ADR-054): this process's real environment with APP_ENV=staging.
// The same functions on the spec cadence (APP_ENV=local): tests/integration/job-cadence-spec.test.ts; the stall alert of
// the job in both environments: tests/integration/outbox.test.ts.
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>()
  const staging = { ...actual.getEnv(), APP_ENV: 'staging' as const }
  return { ...actual, getEnv: () => staging }
})

const { outboxSweeper } = await import('@/server/jobs/outbox-sweeper')
const { consolidationRound } = await import('@/server/jobs/consolidation')
const { reportSchedules } = await import('@/server/jobs/report-schedules')
const { lineWebhookSweep } = await import('@/server/jobs/line-webhook')
const { dailyDigest, DAILY_DIGEST_CRON } = await import('@/server/jobs/daily-digest')
const { draftExpiry, DRAFT_EXPIRY_CRON } = await import('@/server/jobs/draft-expiry')
const { checkHealth, inngestProbeWith } = await import('@/server/services/health')

const ok = async () => {}

describe('polling jobs on staging run every 30 minutes (ADR-054)', () => {
  it('[FR-PLT-012/AC3] outbox-sweeper runs every 30 minutes on staging', () => {
    expect(outboxSweeper.opts).toMatchObject({ id: 'outbox-sweeper', retries: 0, triggers: [{ cron: '*/30 * * * *' }] })
  })

  it('[FR-P2P-002/AC2] the consolidation check runs every 30 minutes on staging in Thai time, so rounds at :00 and :30 stay on time', () => {
    expect(consolidationRound.opts).toMatchObject({ id: 'consolidation', triggers: [{ cron: 'TZ=Asia/Bangkok */30 * * * *' }] })
  })

  it('[FR-VIS-002/AC1] report-schedules runs every 30 minutes on staging in Thai time', () => {
    expect(reportSchedules.opts).toMatchObject({ id: 'report-schedules', triggers: [{ cron: 'TZ=Asia/Bangkok */30 * * * *' }] })
  })

  it('[FR-LINE-005/AC3] line-webhook-sweep runs every 30 minutes on staging', () => {
    expect(lineWebhookSweep.opts).toMatchObject({ id: 'line-webhook-sweep', retries: 0, triggers: [{ cron: '*/30 * * * *' }] })
  })

  it('[FR-PLT-012/AC3] jobs that already run once a day keep their spec schedule on staging', () => {
    expect(dailyDigest.opts).toMatchObject({ triggers: [{ cron: DAILY_DIGEST_CRON }] })
    expect(draftExpiry.opts).toMatchObject({ triggers: [{ cron: DRAFT_EXPIRY_CRON }] })
  })

  it('[FR-PLT-008/AC1] /api/health on staging allows an outbox row to wait for the 30-minute sweeper, not longer', async () => {
    const minutes = (n: number) => n * MS_PER_MINUTE
    const waiting = await checkHealth({ database: ok, storage: ok, inngest: inngestProbeWith(async () => minutes(30)) })
    expect(waiting.checks.inngest).toBe('ok')
    const stalled = await checkHealth({ database: ok, storage: ok, inngest: inngestProbeWith(async () => minutes(35)) })
    expect(stalled.checks.inngest).toBe('fail')
  })
})
