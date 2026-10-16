import { Prisma } from '../generated/client'
import type { TenantTx } from '../tenant'

// BR-AUTH-12 (S17-10): a phone receives the push of one person only. A token registered in one organization ends every
// row of the same token still in use in every other organization (the unique index PushDevice_token_in_use holds
// within one organization only), in the registering command's transaction, with push_device.revoked (REPLACED) in the
// audit of the organization that loses the device — written by the system, so the registering member learns nothing of
// the other organization. forTenant cannot reach another organization, hence SQL here.

export interface ReplacedElsewhere {
  readonly organizationId: string
  readonly deviceId: string
}

export async function revokePushTokenInOtherOrganizations(
  tx: TenantTx,
  input: { readonly organizationId: string; readonly tokenHash: string; readonly now: Date; readonly correlationId: string; readonly requestId: string },
): Promise<ReplacedElsewhere[]> {
  const rows = await tx.$queryRaw<Array<{ organizationId: string; id: string }>>(Prisma.sql`
    WITH revoked AS (
      UPDATE "PushDevice"
         SET "revokedAt" = ${input.now}, "revokeReason" = 'REPLACED'::"PushDeviceRevokeReason", "version" = "version" + 1, "updatedAt" = ${input.now}
       WHERE "tokenHash" = ${input.tokenHash} AND "revokedAt" IS NULL AND "organizationId" <> ${input.organizationId}::uuid
       RETURNING "organizationId", "id"
    ), audited AS (
      INSERT INTO "Event" ("id", "organizationId", "type", "aggregateType", "aggregateId", "occurredAt", "actorType", "channel", "correlationId", "requestId", "data", "schemaVersion")
      SELECT gen_random_uuid(), r."organizationId", 'push_device.revoked', 'PushDevice', r."id", ${input.now}, 'SYSTEM'::"ActorType", 'SYSTEM'::"Channel",
             ${input.correlationId}::uuid, ${input.requestId}, jsonb_build_object('reason', 'REPLACED'), 1
        FROM revoked r
    )
    SELECT "organizationId", "id" FROM revoked ORDER BY "organizationId", "id"
  `)
  return rows.map((r) => ({ organizationId: r.organizationId, deviceId: r.id }))
}
