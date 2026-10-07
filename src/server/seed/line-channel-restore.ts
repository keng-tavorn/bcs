import { systemCtx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { appendEvents } from '@/server/events/append'
import { LINE_CHANNEL_SETTING_FIELDS, type LineChannelSettingField } from '@/server/events/schemas/organization'

// The LINE channel of the demo organization put back after the staging demo reset (ADR-056): the row the owner set up
// (line-demo-setup part 3) with its webhook path and rich menus, its secrets already sealed for the new organization by
// the caller (src/server/services/demo-seed). A seed write like the rest of the demo seed (local and staging only), and
// like every write of LineChannelConfig it records organization.settings_updated, naming fields and never a value.

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
export async function restoreLineChannelRow(organizationId: string, row: RestoredLineChannel, now: Date): Promise<void> {
  const ctx = systemCtx(organizationId, now, 'seed')
  const set = new Set<LineChannelSettingField>(['providerId', 'messagingChannelId', 'channelSecret', 'channelAccessToken', 'active'])
  for (const field of ['liffId', 'liffChannelId', 'richMenuLinkedId', 'richMenuUnlinkedId'] as const) if (row[field]) set.add(field)
  const changed = LINE_CHANNEL_SETTING_FIELDS.filter((f) => set.has(f))
  await forTenant(organizationId).$transaction(async (tx) => {
    const existing = await tx.lineChannelConfig.findFirst({ select: { id: true } })
    if (existing) await tx.lineChannelConfig.update({ where: { id: existing.id }, data: row })
    else await tx.lineChannelConfig.create({ data: { organizationId, ...row } })
    await appendEvents(tx, ctx, [
      { type: 'organization.settings_updated', aggregateType: 'Organization', aggregateId: organizationId, data: { section: 'lineChannel', created: !existing, changed } },
    ])
  })
}
