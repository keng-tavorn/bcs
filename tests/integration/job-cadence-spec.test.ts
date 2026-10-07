import { describe, expect, it } from 'vitest'
import { getEnv } from '@/lib/env'
import { consolidationRound } from '@/server/jobs/consolidation'
import { lineWebhookSweep } from '@/server/jobs/line-webhook'
import { outboxSweeper } from '@/server/jobs/outbox-sweeper'
import { reportSchedules } from '@/server/jobs/report-schedules'

// The polling jobs as Inngest registers them outside staging (this process: APP_ENV=local): the crons of the spec §4.6
// table, written out here so that a changed constant or a job that asks for the staging cadence fails (ADR-054).
// The same jobs on staging: tests/integration/job-cadence-staging.test.ts.

describe('polling jobs outside staging run on the spec cadence (§4.6, ADR-054)', () => {
  it('[FR-PLT-012/AC3] this process is not staging', () => {
    expect(getEnv().APP_ENV).toBe('local')
  })

  it('[FR-PLT-012/AC3] outbox-sweeper runs every minute', () => {
    expect(outboxSweeper.opts).toMatchObject({ id: 'outbox-sweeper', triggers: [{ cron: '* * * * *' }] })
  })

  it('[FR-P2P-002/AC2] the consolidation check runs every five minutes in Thai time', () => {
    expect(consolidationRound.opts).toMatchObject({ id: 'consolidation', triggers: [{ cron: 'TZ=Asia/Bangkok */5 * * * *' }] })
  })

  it('[FR-VIS-002/AC1] report-schedules runs every five minutes in Thai time', () => {
    expect(reportSchedules.opts).toMatchObject({ id: 'report-schedules', triggers: [{ cron: 'TZ=Asia/Bangkok */5 * * * *' }] })
  })

  it('[FR-LINE-005/AC3] line-webhook-sweep runs every five minutes', () => {
    expect(lineWebhookSweep.opts).toMatchObject({ id: 'line-webhook-sweep', triggers: [{ cron: '*/5 * * * *' }] })
  })
})
