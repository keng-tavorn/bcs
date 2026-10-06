import { prisma } from '../client'

// Raw SQL lives only here (spec §4.8).

export interface RateLimitCount {
  /** This request is within the limit */
  readonly allowed: boolean
  /** Requests counted in the current window, this one included */
  readonly count: number
  /** When the current window ends and the count starts again */
  readonly resetAt: Date
}

/**
 * Counts one request under `key` in a fixed window of `windowMs` and says whether it is within `max` (NFR-SEC-05: limits
 * per user for the API). The count lives in the RateLimit table that Better Auth's own limiter keeps (storage
 * "database"), under keys that start with "bcs:" so they never meet Better Auth's (an address and a path): `count`, and
 * `lastRequest` = when the current window started (ms since 1970). One statement, so requests that arrive at the same
 * moment are all counted. It is bookkeeping of the request, like Better Auth's rows: no organization, no Event.
 */
export async function countRateLimited(key: string, windowMs: number, max: number, now: Date): Promise<RateLimitCount> {
  if (!key.startsWith('bcs:')) throw new TypeError('a BCS rate limit key starts with "bcs:"')
  const at = BigInt(now.getTime())
  const windowStartedBefore = at - BigInt(Math.max(1, Math.trunc(windowMs)))
  const rows = await prisma.$queryRaw<Array<{ count: number; started: bigint }>>`
    INSERT INTO "RateLimit" ("id", "key", "count", "lastRequest") VALUES (gen_random_uuid(), ${key}, 1, ${at})
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN "RateLimit"."lastRequest" <= ${windowStartedBefore} THEN 1 ELSE "RateLimit"."count" + 1 END,
      "lastRequest" = CASE WHEN "RateLimit"."lastRequest" <= ${windowStartedBefore} THEN ${at} ELSE "RateLimit"."lastRequest" END
    RETURNING "count", "lastRequest" AS started`
  const row = rows[0]
  if (!row) throw new Error('the rate limit count was not returned')
  return { allowed: row.count <= max, count: row.count, resetAt: new Date(Number(row.started) + windowMs) }
}
