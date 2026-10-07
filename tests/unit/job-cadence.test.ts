import { describe, expect, it } from 'vitest'
import { MS_PER_MINUTE, OUTBOX_STALL_ALERT_AFTER_MS, OUTBOX_STALL_HEALTH_MS } from '@/lib/constants'
import type { AppEnv } from '@/lib/env'
import { outboxHealthStallMs, outboxStallAlertAfterMs, pollingCron, STAGING_POLL_INTERVAL_MS } from '@/lib/job-cadence'

// The polling jobs keep the spec cadence (§4.6) everywhere but staging, where they run every 30 minutes (ADR-054).
// tests/integration/job-cadence-staging.test.ts checks the job functions themselves with APP_ENV=staging.

const SPEC_CRONS = {
  'outbox-sweeper': '* * * * *',
  consolidation: 'TZ=Asia/Bangkok */5 * * * *',
  'report-schedules': 'TZ=Asia/Bangkok */5 * * * *',
  'line-webhook-sweep': '*/5 * * * *',
}
const SPEC_ENVS: readonly AppEnv[] = ['local', 'preview', 'production']

describe('polling jobs run on the spec cadence except on staging (ADR-054)', () => {
  it('[FR-PLT-012/AC3] local, preview and production keep every cron and outbox limit of the spec', () => {
    for (const appEnv of SPEC_ENVS) {
      for (const [job, cron] of Object.entries(SPEC_CRONS)) expect(pollingCron(cron, appEnv), `${job} on ${appEnv}`).toBe(cron)
      expect(outboxHealthStallMs(appEnv)).toBe(OUTBOX_STALL_HEALTH_MS)
      expect(outboxStallAlertAfterMs(appEnv)).toBe(OUTBOX_STALL_ALERT_AFTER_MS)
    }
    expect(OUTBOX_STALL_HEALTH_MS).toBe(5 * MS_PER_MINUTE)
    expect(OUTBOX_STALL_ALERT_AFTER_MS).toBe(10 * MS_PER_MINUTE)
  })

  it('[FR-PLT-012/AC3] staging runs every 30 minutes on :00 and :30 in the same time zone', () => {
    expect(pollingCron(SPEC_CRONS['outbox-sweeper'], 'staging')).toBe('*/30 * * * *')
    expect(pollingCron(SPEC_CRONS['line-webhook-sweep'], 'staging')).toBe('*/30 * * * *')
    expect(pollingCron(SPEC_CRONS.consolidation, 'staging')).toBe('TZ=Asia/Bangkok */30 * * * *')
    expect(pollingCron(SPEC_CRONS['report-schedules'], 'staging')).toBe('TZ=Asia/Bangkok */30 * * * *')
    expect(STAGING_POLL_INTERVAL_MS).toBe(30 * MS_PER_MINUTE)
  })

  it('[FR-PLT-012/AC3] staging outbox limits wait for the slower sweeper, so one interval is not an outage', () => {
    // A row can wait up to 29 minutes longer than at the spec cadence before the sweeper sees it
    expect(outboxHealthStallMs('staging')).toBe(OUTBOX_STALL_HEALTH_MS + 29 * MS_PER_MINUTE)
    expect(outboxStallAlertAfterMs('staging')).toBe(OUTBOX_STALL_ALERT_AFTER_MS + 29 * MS_PER_MINUTE)
    // The first sweep after a failed send sees a row at most one interval old: no alert yet, the next failing sweep raises it
    expect(outboxStallAlertAfterMs('staging')).toBeGreaterThan(STAGING_POLL_INTERVAL_MS)
    expect(outboxStallAlertAfterMs('staging')).toBeLessThan(2 * STAGING_POLL_INTERVAL_MS)
  })
})
