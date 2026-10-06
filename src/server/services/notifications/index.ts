import { z } from 'zod'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { renderNotification, type NotificationLocale } from '@/server/notifications/templates'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'

// Marking notifications read (FR-NOTI-001 AC1, AC3): a member marks their own notifications — one they open, or all of
// them; anybody else's are untouched and look missing. One event per action (notification.read, NEW-16).

/** At most this many notifications are marked by id in one action */
const MARK_MAX = 100

const MarkReadInput = z.union([z.strictObject({ notificationIds: z.array(z.uuid()).min(1).max(MARK_MAX) }), z.strictObject({ all: z.literal(true) })])

export const markReadCommand = defineCommand({
  name: 'notification.mark_read',
  capability: 'self.notificationPrefs',
  input: MarkReadInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ marked: number }>> {
    const memberId = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
    if (!memberId) return { ok: false, error: { code: 'FORBIDDEN', message: 'members only' } }
    const allowed = await authorize(tx, ctx, 'self.notificationPrefs', { ownerMemberIds: [memberId] })
    if (!allowed.ok) return { ok: false, error: allowed.error }
    const all = 'all' in input
    const { count } = await tx.notification.updateMany({
      where: { recipientMemberId: memberId, readAt: null, ...(all ? {} : { id: { in: input.notificationIds } }) },
      data: { readAt: ctx.now },
    })
    if (count === 0) return { ok: false, error: { code: 'NOT_FOUND', message: 'no unread notification of yours' } }
    return { ok: true, result: { marked: count }, events: [{ type: 'notification.read', aggregateType: 'Notification', aggregateId: memberId, data: { count, all } }] }
  },
})

export function markNotificationsRead(ctx: Ctx, input: z.input<typeof MarkReadInput>, options: RunOptions) {
  return runCommand(ctx, markReadCommand, input, options)
}

// ---------- the bell ----------

// The bell (FR-NOTI-001 AC1, AC3): the notifications of the member who asks, newest first, in their language, with
// the page each one links to. Nobody reads another member's notifications through this query.

/** How many notifications the bell shows */
export const BELL_LIMIT = 20

export interface NotificationItemDto {
  readonly id: string
  readonly title: string
  readonly body: string | null
  readonly href: string | null
  readonly createdAt: string
  readonly unread: boolean
}

export interface MyNotificationsDto {
  readonly items: readonly NotificationItemDto[]
  /** Unread notifications in all, not only those listed */
  readonly unread: number
}

export async function listMyNotifications(ctx: Ctx, locale: NotificationLocale, limit: number = BELL_LIMIT): Promise<MyNotificationsDto> {
  if (ctx.actor.type !== 'USER') return { items: [], unread: 0 }
  const recipientMemberId = ctx.actor.memberId
  const db = forTenant(ctx.organizationId)
  const [rows, unread] = await Promise.all([
    db.notification.findMany({ where: { recipientMemberId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit }),
    db.notification.count({ where: { recipientMemberId, readAt: null } }),
  ])
  return {
    items: rows.map((n) => ({ id: n.id, ...renderNotification(n, locale), createdAt: n.createdAt.toISOString(), unread: n.readAt === null })),
    unread,
  }
}
