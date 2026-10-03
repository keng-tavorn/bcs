import type { PrismaClient } from '../generated/client'
import { systemDb } from '../system'

// Read-only probes for /api/health (FR-PLT-008 AC1). They run as the runtime role (DATABASE_URL), like the app.

/** One round trip to Postgres. */
export async function pingDatabase(): Promise<void> {
  await systemDb.$queryRaw`SELECT 1`
}

/**
 * Age of the oldest outbox row that is still waiting for its first delivery (not sent, not dead, not suppressed, never
 * refused); null when none. A row Inngest refused is backing off on its own schedule and gets its own dead-letter
 * alert (outbox-sweeper), so one bad message does not make the whole system look down for hours.
 */
export async function oldestPendingOutboxAgeMs(now: Date, db: Pick<PrismaClient, '$queryRaw'> = systemDb): Promise<number | null> {
  const rows = await db.$queryRaw<Array<{ oldest: Date | null }>>`
    SELECT min("createdAt") AS oldest FROM "Outbox"
    WHERE "sentAt" IS NULL AND "deadAt" IS NULL AND NOT "suppressed" AND "attempts" = 0`
  const oldest = rows[0]?.oldest
  return oldest ? now.getTime() - oldest.getTime() : null
}
