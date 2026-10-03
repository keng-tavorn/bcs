import type { Ctx } from '@/server/context'
import type { TenantTx } from '@/server/db/tenant'

// Deactivating a member revokes everything that lets them act, in the same transaction (BR-AUTH-06,
// FR-AUTH-003 AC2). Sessions and pending invitations are revoked by the deactivate command itself; later
// items register their revokers here: delegations (S2), ActionTokens (S4/S5), the LINE link (S5).

export interface DeactivationTarget {
  readonly memberId: string
  readonly userId: string | null
}

export type DeactivationRevoker = (tx: TenantTx, ctx: Ctx, target: DeactivationTarget) => Promise<number>

const revokers = new Map<string, DeactivationRevoker>()

export function registerDeactivationRevoker(name: string, revoker: DeactivationRevoker): void {
  revokers.set(name, revoker)
}

export async function runDeactivationRevokers(tx: TenantTx, ctx: Ctx, target: DeactivationTarget): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (const [name, revoker] of revokers) counts[name] = await revoker(tx, ctx, target)
  return counts
}
