import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { MS_PER_MINUTE, OUTBOX_DISPATCH_TIMEOUT_MS, OUTBOX_STALL_ALERT_AFTER_MS, OUTBOX_STALL_HEALTH_MS, OUTBOX_SWEEP_AFTER_MS } from '@/lib/constants'
import type { AppEnv } from '@/lib/env'
import { outboxHealthStallMs, outboxStallAlertAfterMs, pollingCron, STAGING_POLL_INTERVAL_MS } from '@/lib/job-cadence'

// The polling jobs keep the spec cadence (§4.6) everywhere but staging, where they run every 30 minutes (ADR-054).
// The job functions themselves: tests/integration/job-cadence-spec.test.ts (APP_ENV=local) and
// tests/integration/job-cadence-staging.test.ts (APP_ENV=staging).

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

  it('[FR-PLT-012/AC3] on staging /api/health waits for the slower sweeper: 29 minutes more than the spec limit', () => {
    // A row can wait up to 29 minutes longer than at the spec cadence before the sweeper sees it
    expect(outboxHealthStallMs('staging')).toBe(OUTBOX_STALL_HEALTH_MS + 29 * MS_PER_MINUTE)
  })

  it('[NFR-OBS-02] on staging the second sweep in a row that cannot send raises the stall alert, whenever the row was written', () => {
    const alertAt = outboxStallAlertAfterMs('staging')
    expect(alertAt).toBe(STAGING_POLL_INTERVAL_MS + OUTBOX_SWEEP_AFTER_MS)
    // Sweeps run at k × interval. A row written `offset` after a sweep, whose first send failed after `sendMs`, is due
    // OUTBOX_SWEEP_AFTER_MS later (src/server/db/sql/outbox.ts: due when nextAttemptAt <= now or createdAt <= cutoff)
    fc.assert(
      fc.property(fc.integer({ min: 0, max: STAGING_POLL_INTERVAL_MS - 1 }), fc.integer({ min: 0, max: OUTBOX_DISPATCH_TIMEOUT_MS }), (offset, sendMs) => {
        const due = offset + sendMs + OUTBOX_SWEEP_AFTER_MS
        const firstSweep = Math.ceil(due / STAGING_POLL_INTERVAL_MS) * STAGING_POLL_INTERVAL_MS
        const ageAtFirst = firstSweep - offset
        // never late: the next sweep that still cannot send raises it
        expect(ageAtFirst + STAGING_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(alertAt)
        // early by one sweep only when the row's own send took the last moments before a sweep
        expect(ageAtFirst).toBeLessThanOrEqual(alertAt + OUTBOX_DISPATCH_TIMEOUT_MS)
        // a row whose send failed at once is never early
        expect(sendMs > 0 || ageAtFirst < alertAt).toBe(true)
      }),
    )
  })
})
