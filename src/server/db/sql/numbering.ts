import { newId } from '@/lib/ids'
import type { TenantTx } from '../tenant'

// Raw SQL lives only here (spec §4.8). organizationId is always an explicit parameter.

/**
 * BR-NUM-01: takes the next value of one numbering scope inside the caller's transaction. INSERT … ON CONFLICT DO
 * UPDATE locks the scope's DocumentSequence row until the transaction ends, so concurrent issuers wait for each other
 * and every value is used once; a transaction that rolls back gives its value back, so no number is skipped
 * (INV-NUM-01). Values only grow: a cancelled document keeps its number and it is never issued again.
 */
export async function takeNextSequenceValue(tx: TenantTx, organizationId: string, documentType: string, scopeKey: string, pattern: string): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ value: number }>>`
    INSERT INTO "DocumentSequence" ("id", "organizationId", "documentType", "scopeKey", "pattern", "nextValue", "updatedAt")
    VALUES (${newId()}::uuid, ${organizationId}::uuid, ${documentType}, ${scopeKey}, ${pattern}, 2, now())
    ON CONFLICT ("organizationId", "documentType", "scopeKey")
    DO UPDATE SET "nextValue" = "DocumentSequence"."nextValue" + 1, "pattern" = EXCLUDED."pattern", "updatedAt" = now()
    RETURNING "nextValue" - 1 AS value`
  const value = rows[0]?.value
  if (value === undefined) throw new Error('DocumentSequence returned no value')
  return Number(value)
}
