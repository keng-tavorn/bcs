import type { Ctx } from '@/server/context'
import type { TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import type { NotificationDraft } from '@/server/notifications/create'
import { revokeMemberTokens } from '@/server/tokens/action-tokens'
import { revokeDelegationsOf } from '../delegations'
import { unlinkLineOnDeactivation } from '../line-link/unlink'

// Deactivating a member revokes everything that lets them act, in the same transaction (BR-AUTH-06,
// FR-AUTH-003 AC2). Sessions and pending invitations are revoked by the deactivate command itself; the other
// things register a revoker here, with the events and notifications their revocation needs: action tokens,
// delegations and the LINE link.

export interface DeactivationTarget {
  readonly memberId: string
  readonly userId: string | null
}

export interface RevokerResult {
  readonly count: number
  readonly events?: readonly EventDraft[]
  readonly notifications?: readonly NotificationDraft[]
}

export type DeactivationRevoker = (tx: TenantTx, ctx: Ctx, target: DeactivationTarget) => Promise<RevokerResult>

const revokers = new Map<string, DeactivationRevoker>()

export function registerDeactivationRevoker(name: string, revoker: DeactivationRevoker): void {
  revokers.set(name, revoker)
}

// The member's e-mail and LINE action links (BR-TOK-01)
registerDeactivationRevoker('actionTokens', async (tx, ctx, target) => ({ count: await revokeMemberTokens(tx, ctx, target.memberId) }))
// Delegations they gave or hold, scheduled or running (BR-DLG-01)
registerDeactivationRevoker('delegations', (tx, ctx, target) => revokeDelegationsOf(tx, ctx, target.memberId))
// Their LINE link, with line.unlinked (FR-LINE-001 AC3, S5-04); the rich menu follows in job line-rich-menu
registerDeactivationRevoker('lineLink', (tx, ctx, target) => unlinkLineOnDeactivation(tx, ctx, target.memberId))

export async function runDeactivationRevokers(
  tx: TenantTx,
  ctx: Ctx,
  target: DeactivationTarget,
): Promise<{ counts: Record<string, number>; events: EventDraft[]; notifications: NotificationDraft[] }> {
  const counts: Record<string, number> = {}
  const events: EventDraft[] = []
  const notifications: NotificationDraft[] = []
  for (const [name, revoker] of revokers) {
    const r = await revoker(tx, ctx, target)
    counts[name] = r.count
    events.push(...(r.events ?? []))
    notifications.push(...(r.notifications ?? []))
  }
  return { counts, events, notifications }
}
