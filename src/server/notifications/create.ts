import { newId } from '@/lib/ids'
import { toJsonSafe } from '@/lib/json'
import type { TenantTx } from '@/server/db/tenant'
import type { OutboxDraft } from '@/server/events/outbox'

// notify(): Notification rows are written in the same transaction as the command (spec §4.7), so a
// notification can never drift from the real state. IMMEDIATE ones are delivered by the notification-deliver
// job via the outbox; DIGEST ones wait for the daily summary.

export interface NotificationDraft {
  readonly recipientMemberId: string
  readonly templateKey: string
  readonly data: Record<string, unknown>
  readonly urgency: 'IMMEDIATE' | 'DIGEST'
  /** Unique per organization — prevents duplicate sends when a job retries (§4.7 rule 4) */
  readonly dedupeKey: string
  readonly subjectType?: string
  readonly subjectId?: string
}

export async function createNotifications(
  tx: TenantTx,
  organizationId: string,
  drafts: readonly NotificationDraft[],
): Promise<OutboxDraft[]> {
  if (drafts.length === 0) return []
  const unique = [...new Map(drafts.map((d) => [d.dedupeKey, d])).values()]
  const existing = await tx.notification.findMany({
    where: { dedupeKey: { in: unique.map((d) => d.dedupeKey) } },
    select: { dedupeKey: true },
  })
  const seen = new Set(existing.map((e) => e.dedupeKey))
  const rows = unique
    .filter((d) => !seen.has(d.dedupeKey))
    .map((d) => ({
      id: newId(),
      organizationId,
      recipientMemberId: d.recipientMemberId,
      templateKey: d.templateKey,
      data: toJsonSafe(d.data) as object,
      urgency: d.urgency,
      dedupeKey: d.dedupeKey,
      ...(d.subjectType ? { subjectType: d.subjectType } : {}),
      ...(d.subjectId ? { subjectId: d.subjectId } : {}),
    }))
  if (rows.length) await tx.notification.createMany({ data: rows })
  return rows
    .filter((r) => r.urgency === 'IMMEDIATE')
    .map((r) => ({ eventName: 'bcs/notification.requested', payload: { notificationId: r.id, organizationId } }))
}
