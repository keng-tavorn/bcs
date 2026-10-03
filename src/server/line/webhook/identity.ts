import { lockRowsForUpdate } from '@/server/db/sql/locks'
import { forTenant } from '@/server/db/tenant'
import type { RecordedLineEvent } from './types'

// Who a LINE user is in the organization (BR-TOK-02, §9.2): the member of the live ChannelIdentity for this LINE user id
// under the channel's provider (LINE user ids differ per provider). Only an ACTIVE member counts; anything else is not
// linked. The id comes from a webhook whose signature was checked, never from a browser (BR-LINE-01).

export async function findLinkedMemberId(organizationId: string, providerId: string, lineUserId: string): Promise<string | null> {
  const identity = await forTenant(organizationId).channelIdentity.findFirst({
    where: { channel: 'LINE', providerKey: providerId, externalUserId: lineUserId, unlinkedAt: null, member: { status: 'ACTIVE' } },
    select: { memberId: true },
  })
  return identity?.memberId ?? null
}

/**
 * Member.lineReachable (§4.7 rule 2, BR-LINE-08): whether a push can reach the member. Delivery bookkeeping like
 * Notification.status, read by the senders (S5-08), so it is written here without a command or an Event. True when it
 * changed. For a second signal that does not come from LINE's own follow and unfollow (a push LINE refused for good).
 */
export async function setLineReachable(organizationId: string, memberId: string, reachable: boolean): Promise<boolean> {
  const changed = await forTenant(organizationId).member.updateMany({ where: { id: memberId, lineReachable: !reachable }, data: { lineReachable: reachable } })
  return changed.count === 1
}

/** Webhook events that set or will set lineReachable: the ones not skipped and not failed */
const APPLYING = ['RECEIVED', 'QUEUED', 'PROCESSED'] as const

export type LineReachabilityChange = 'CHANGED' | 'UNCHANGED' | 'SUPERSEDED'

/**
 * Sets Member.lineReachable from a follow (true) or an unfollow (false) of the member's LINE user — unless LINE sent a
 * later follow or unfollow of that user (by LINE's timestamp, in the active mode): SUPERSEDED, nothing changes. Events
 * reach BCS in separate deliveries, LINE redelivers late ones, and the inline path and the job may handle them in any
 * order; the last one LINE sent decides. The member row is locked while this checks and writes, so two events of one
 * user never interleave: the later one, recorded before it checks, is seen by the earlier one, or writes after it.
 */
export async function applyLineReachability(organizationId: string, memberId: string, event: RecordedLineEvent, reachable: boolean): Promise<LineReachabilityChange> {
  return forTenant(organizationId).$transaction(async (tx) => {
    await lockRowsForUpdate(tx, 'Member', organizationId, [memberId])
    const { userId, occurredAt } = event.payload
    if (userId && occurredAt) {
      const later = await tx.lineWebhookEvent.findFirst({
        where: {
          id: { not: event.id },
          type: { in: ['follow', 'unfollow'] },
          status: { in: [...APPLYING] },
          AND: [{ payload: { path: ['userId'], equals: userId } }, { payload: { path: ['mode'], equals: 'active' } }, { payload: { path: ['occurredAt'], gt: occurredAt } }],
        },
        select: { id: true },
      })
      if (later) return 'SUPERSEDED'
    }
    const changed = await tx.member.updateMany({ where: { id: memberId, lineReachable: !reachable }, data: { lineReachable: reachable } })
    return changed.count === 1 ? 'CHANGED' : 'UNCHANGED'
  })
}
