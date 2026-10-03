import type { PrismaClient } from '../generated/client'

// Raw SQL of the outbox relay (spec §4.8; ADR-030). The relay is platform infrastructure and works across
// organizations through the system client. Every query matches the partial index outbox_due_idx
// ("nextAttemptAt", "createdAt") WHERE "sentAt" IS NULL AND "deadAt" IS NULL AND NOT "suppressed".

type RawClient = Pick<PrismaClient, '$queryRaw'>

export interface ClaimedOutboxRow {
  readonly id: string
  readonly organizationId: string
  readonly eventName: string
  readonly payload: unknown
  readonly attempts: number
  readonly createdAt: Date
}

/**
 * Claims up to `limit` due rows in index order — retries whose nextAttemptAt has passed first, then rows never
 * retried that are older than `cutoff` — and leases them until `leaseUntil`. FOR UPDATE SKIP LOCKED plus the
 * lease keep concurrent sweeper runs from sending the same row; a crashed run's rows are due again after it.
 */
export async function claimDueOutboxRows(
  db: RawClient,
  params: { now: Date; cutoff: Date; leaseUntil: Date; limit: number },
): Promise<ClaimedOutboxRow[]> {
  return db.$queryRaw<ClaimedOutboxRow[]>`
    WITH due AS (
      SELECT "id" FROM "Outbox"
      WHERE "sentAt" IS NULL AND "deadAt" IS NULL AND NOT "suppressed"
        AND (("nextAttemptAt" IS NULL AND "createdAt" <= ${params.cutoff}::timestamptz) OR "nextAttemptAt" <= ${params.now}::timestamptz)
      ORDER BY "nextAttemptAt", "createdAt"
      LIMIT ${params.limit}::int
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "Outbox" AS o SET "nextAttemptAt" = ${params.leaseUntil}::timestamptz, "updatedAt" = now()
    FROM due WHERE o."id" = due."id"
    RETURNING o."id"::text AS "id", o."organizationId"::text AS "organizationId", o."eventName" AS "eventName",
      o."payload" AS "payload", o."attempts" AS "attempts", o."createdAt" AS "createdAt"`
}

export interface OutboxRefusal {
  readonly ids: readonly string[]
  readonly now: Date
  readonly lastError: string
  readonly maxAttempts: number
  readonly retryBaseMs: number
  readonly retryMaxMs: number
}

export interface RefusedOutboxRow {
  readonly id: string
  readonly organizationId: string
  readonly eventName: string
  readonly attempts: number
  readonly dead: boolean
}

/**
 * Counts one refusal per row — Outbox.attempts counts only refusals, the failures that can kill a row — and
 * schedules the next try at now + min(base × 2^attempts, max), or marks the row dead once it has been refused
 * maxAttempts times. Rows already sent or dead are left alone.
 */
export async function recordOutboxRefusal(db: RawClient, f: OutboxRefusal): Promise<RefusedOutboxRow[]> {
  if (f.ids.length === 0) return []
  return db.$queryRaw<RefusedOutboxRow[]>`
    UPDATE "Outbox" SET
      "attempts" = "attempts" + 1,
      "lastError" = ${f.lastError},
      "deadAt" = CASE WHEN "attempts" + 1 >= ${f.maxAttempts}::int THEN ${f.now}::timestamptz END,
      "nextAttemptAt" = CASE WHEN "attempts" + 1 >= ${f.maxAttempts}::int THEN NULL
        ELSE ${f.now}::timestamptz
          + LEAST(${f.retryBaseMs}::float8 * power(2::float8, LEAST("attempts", 30)), ${f.retryMaxMs}::float8) * interval '1 millisecond'
        END,
      "updatedAt" = now()
    WHERE "id" = ANY(${[...f.ids]}::uuid[]) AND "sentAt" IS NULL AND "deadAt" IS NULL
    RETURNING "id"::text AS "id", "organizationId"::text AS "organizationId", "eventName" AS "eventName",
      "attempts" AS "attempts", ("deadAt" IS NOT NULL) AS "dead"`
}
