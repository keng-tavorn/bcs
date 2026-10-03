import { systemClock } from '@/lib/clock'
import { MS_PER_MINUTE, MS_PER_SECOND } from '@/lib/constants'
import { getEnv } from '@/lib/env'
import { logger } from '@/lib/logger'
import { checkBucket } from '@/integrations/storage'
import { oldestPendingOutboxAgeMs, pingDatabase } from '@/server/db/sql/health'

// /api/health (FR-PLT-008 AC1, FR-PLT-006 AC2, NFR-OBS-01): database, file storage and Inngest, each ok or fail, and
// the deployed commit. Only the status of each part is returned: no host names, versions or error text (NFR-SEC-09).

export type CheckStatus = 'ok' | 'fail'
export type HealthCheckName = 'database' | 'storage' | 'inngest'

export interface HealthReport {
  readonly status: 'ok' | 'degraded'
  readonly commit: string
  readonly checks: Readonly<Record<HealthCheckName, CheckStatus>>
}

/** Each probe gets this long before it counts as failed, so the endpoint answers within a few seconds. */
const PROBE_TIMEOUT_MS = 2 * MS_PER_SECOND
/** Outbox rows waiting longer than this mean events are not reaching Inngest (FR-PLT-012 AC3 expects 2 minutes). */
const OUTBOX_STALL_MS = 5 * MS_PER_MINUTE
const LOCAL_INNGEST_DEV_URL = 'http://localhost:8288'

export type HealthProbe = (signal: AbortSignal) => Promise<void>

/** Inngest is healthy when it is reachable (local dev server) or configured (cloud), and events leave the outbox. */
export function inngestProbeWith(oldestPendingAgeMs: () => Promise<number | null>): HealthProbe {
  return (signal) => inngestProbe(signal, oldestPendingAgeMs)
}

async function inngestProbe(signal: AbortSignal, oldestPendingAgeMs: () => Promise<number | null>): Promise<void> {
  const env = getEnv()
  if (env.INNGEST_DEV) {
    // Local: the Inngest dev server answers GET /health
    const res = await fetch(new URL('/health', env.INNGEST_BASE_URL ?? LOCAL_INNGEST_DEV_URL), { signal })
    if (!res.ok) throw new Error(`inngest dev server answered ${res.status}`)
  } else if (!env.INNGEST_EVENT_KEY || !env.INNGEST_SIGNING_KEY) {
    throw new Error('inngest keys are not configured')
  }
  // Everywhere: events must be leaving the outbox (a stalled relay means Inngest is not receiving them)
  const age = await oldestPendingAgeMs()
  if (age !== null && age > OUTBOX_STALL_MS) throw new Error('outbox has undelivered events older than the limit')
}

export const DEFAULT_PROBES: Readonly<Record<HealthCheckName, HealthProbe>> = {
  database: () => pingDatabase(),
  storage: (signal) => checkBucket(signal),
  inngest: inngestProbeWith(() => oldestPendingOutboxAgeMs(systemClock.now())),
}

async function run(name: HealthCheckName, probe: HealthProbe): Promise<CheckStatus> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error(`timed out after ${PROBE_TIMEOUT_MS} ms`))
    }, PROBE_TIMEOUT_MS)
  })
  try {
    await Promise.race([probe(controller.signal), timeout])
    return 'ok'
  } catch (error) {
    // The cause goes to the log for the team; the response only says "fail"
    logger.warn({ check: name, err: error }, 'health check failed')
    return 'fail'
  } finally {
    clearTimeout(timer)
  }
}

export async function checkHealth(probes: Readonly<Record<HealthCheckName, HealthProbe>> = DEFAULT_PROBES): Promise<HealthReport> {
  const names = Object.keys(probes) as HealthCheckName[]
  const results = await Promise.all(names.map((name) => run(name, probes[name])))
  const checks = Object.fromEntries(names.map((name, i) => [name, results[i]!])) as Record<HealthCheckName, CheckStatus>
  return {
    status: results.every((r) => r === 'ok') ? 'ok' : 'degraded',
    commit: getEnv().APP_COMMIT_SHA || 'local',
    checks,
  }
}
