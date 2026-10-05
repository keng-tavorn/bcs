import { lockRowsForUpdate } from '@/server/db/sql/locks'
import type { TenantTx } from '@/server/db/tenant'

// Linking a member's LINE account (S5-04, FR-LINE-001, §9.2) writes ChannelIdentity with providerKey = the channel's
// providerId, because LINE user ids differ per provider. Saving another Provider ID is refused while live identities of
// the old provider exist (settings.ts, PROVIDER_IN_USE). Both sides take the same Organization row lock, so they never
// interleave: either the link commits first and the provider change counts it, or the provider change commits first and
// the link reads the new provider. Without this lock a link could read the old provider, the change could count no
// identity and commit, and the member would end up linked under a provider the channel no longer uses.

export interface LineChannelForLinking {
  /** What ChannelIdentity.providerKey must hold for an identity linked now */
  readonly providerId: string
  /** LineChannelConfig.active: LINE is in use in this organization */
  readonly active: boolean
}

/**
 * For the link command, inside its transaction and before it locks any other row: takes the Organization row lock the
 * channel save takes, then reads the channel's provider. null when the organization has no LINE channel saved.
 */
export async function lockLineChannelForLinking(tx: TenantTx, organizationId: string): Promise<LineChannelForLinking | null> {
  await lockRowsForUpdate(tx, 'Organization', organizationId, [organizationId])
  return tx.lineChannelConfig.findFirst({ select: { providerId: true, active: true } })
}
