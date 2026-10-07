import { MS_PER_MINUTE, OUTBOX_STALL_ALERT_AFTER_MS, OUTBOX_STALL_HEALTH_MS } from '@/lib/constants'
import type { AppEnv } from '@/lib/env'

// Polling jobs on staging (ADR-054, user 2026-10-07). Staging runs on the free plans of Neon (100 CU-hours a month; the
// database sleeps after 5 idle minutes) and Inngest (50,000 executions a month). At the spec cadence (§4.6:
// outbox-sweeper every minute; consolidation, report-schedules and line-webhook-sweep every five minutes) the database
// never sleeps and a month needs about 104,000 executions. So on staging, and only there, those four jobs run every
// 30 minutes, at :00 and :30. local, preview and production keep the spec cadence.

/** How often the four polling jobs run on staging */
export const STAGING_POLL_INTERVAL_MS = 30 * MS_PER_MINUTE
const STAGING_POLL_CRON = '*/30 * * * *'
/** How often the outbox-sweeper runs at the spec cadence (§4.6) */
const SPEC_SWEEP_INTERVAL_MS = MS_PER_MINUTE

/** The cron a polling job runs on: its spec cron, except every 30 minutes on staging (a `TZ=` prefix is kept). */
export function pollingCron(specCron: string, appEnv: AppEnv): string {
  if (appEnv !== 'staging') return specCron
  const zone = /^TZ=\S+ /.exec(specCron)?.[0] ?? ''
  return zone + STAGING_POLL_CRON
}

/** The extra time an outbox row can wait for the slower sweeper on staging; 0 everywhere else */
function sweepSlackMs(appEnv: AppEnv): number {
  return appEnv === 'staging' ? STAGING_POLL_INTERVAL_MS - SPEC_SWEEP_INTERVAL_MS : 0
}

/** /api/health counts Inngest as failing when an outbox row has waited for its first delivery longer than this */
export function outboxHealthStallMs(appEnv: AppEnv): number {
  return OUTBOX_STALL_HEALTH_MS + sweepSlackMs(appEnv)
}

/** The outbox-sweeper raises its stall alert when nothing could be sent and a row has waited at least this long */
export function outboxStallAlertAfterMs(appEnv: AppEnv): number {
  return OUTBOX_STALL_ALERT_AFTER_MS + sweepSlackMs(appEnv)
}
