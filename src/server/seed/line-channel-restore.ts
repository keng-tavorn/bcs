import { systemDb } from '@/server/db/system'

// The LINE channel of the demo organization put back after the staging demo reset (ADR-056): the row the owner set up
// (line-demo-setup part 3) with its webhook path and rich menus, its secrets already sealed for the new organization by
// the caller (src/server/services/demo-seed). A seed write like the rest of the demo seed: local and staging only.

export interface RestoredLineChannel {
  readonly channelKey: string
  readonly providerId: string
  readonly messagingChannelId: string
  readonly channelSecretEnc: string
  readonly channelAccessTokenEnc: string
  readonly liffId: string | null
  readonly liffChannelId: string | null
  readonly richMenuLinkedId: string | null
  readonly richMenuUnlinkedId: string | null
  readonly active: boolean
}

/** Replaces the organization's LINE channel (what the seed made from LINE_* values, if anything) with the restored one */
export async function restoreLineChannelRow(organizationId: string, row: RestoredLineChannel): Promise<void> {
  await systemDb.$transaction(async (tx) => {
    const existing = await tx.lineChannelConfig.findFirst({ where: { organizationId }, select: { id: true } })
    if (existing) await tx.lineChannelConfig.update({ where: { id: existing.id }, data: row })
    else await tx.lineChannelConfig.create({ data: { organizationId, ...row } })
  })
}
