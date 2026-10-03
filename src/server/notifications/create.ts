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

/**
 * Inserts the notifications whose dedupeKey is new for the organization and returns outbox drafts for the
 * IMMEDIATE ones actually inserted. A dedupeKey that already exists, or that a concurrent command is
 * inserting right now, is skipped (INSERT … ON CONFLICT DO NOTHING) instead of failing the command.
 */
export async function createNotifications(
  tx: TenantTx,
  organizationId: string,
  drafts: readonly NotificationDraft[],
): Promise<OutboxDraft[]> {
  if (drafts.length === 0) return []
  // One row per dedupeKey, inserted in key order so concurrent commands wait on each other's keys in one order.
  const unique = [...new Map(drafts.map((d) => [d.dedupeKey, d])).values()].sort((a, b) =>
    a.dedupeKey < b.dedupeKey ? -1 : a.dedupeKey > b.dedupeKey ? 1 : 0,
  )
  const rows = unique.map((d) => ({
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
  const inserted = await tx.notification.createManyAndReturn({ data: rows, skipDuplicates: true, select: { id: true } })
  const insertedIds = new Set(inserted.map((r) => r.id))
  return rows
    .filter((r) => insertedIds.has(r.id) && r.urgency === 'IMMEDIATE')
    .map((r) => ({ eventName: 'bcs/notification.requested', payload: { notificationId: r.id, organizationId } }))
}
