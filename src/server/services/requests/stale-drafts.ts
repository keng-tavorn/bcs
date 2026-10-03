import { z } from 'zod'
import { MS_PER_DAY } from '@/lib/constants'
import { systemCtx, type Ctx } from '@/server/context'
import { listOrganizationsForPlatform } from '@/server/db/lookups'
import type { EventDraft } from '@/server/events/append'
import type { NotificationDraft } from '@/server/notifications/create'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'

// Drafts left alone (spec FR-INT-006 AC3, NEW-07): a draft nobody edited for DRAFT_WARN_AFTER_DAYS is announced to its
// requester, and DRAFT_EXPIRE_AFTER_DAYS after the last edit — and at least DRAFT_WARNING_LEAD_DAYS after the warning —
// it is removed from the drafts: the request is cancelled by the system (§6.4 request.cancel) so its history stays.
// The job draft-expiry runs it once a day for every organization, with the business clock.

export const DRAFT_EXPIRE_AFTER_DAYS = 90
export const DRAFT_WARNING_LEAD_DAYS = 7
export const DRAFT_WARN_AFTER_DAYS = DRAFT_EXPIRE_AFTER_DAYS - DRAFT_WARNING_LEAD_DAYS

const warningKey = (requestId: string) => `request.draft_expiring:${requestId}`

export const expireStaleDraftsCommand = defineCommand({
  name: 'request.expire_stale_drafts',
  capability: 'request.cancel',
  input: z.strictObject({}),
  async execute(tx, _input, ctx): Promise<CommandOutcome<{ warned: number; removed: number }>> {
    if (ctx.actor.type !== 'SYSTEM') return { ok: false, error: { code: 'FORBIDDEN', message: 'only the scheduled job expires drafts' } }
    const warnBefore = new Date(ctx.now.getTime() - DRAFT_WARN_AFTER_DAYS * MS_PER_DAY)
    const idle = await tx.request.findMany({ where: { status: 'DRAFT', updatedAt: { lte: warnBefore } }, select: { id: true, title: true, requesterMemberId: true, updatedAt: true } })
    if (idle.length === 0) return { ok: false, error: { code: 'NOT_FOUND', message: 'no idle drafts' } }
    const warnings = await tx.notification.findMany({ where: { dedupeKey: { in: idle.map((d) => warningKey(d.id)) } }, select: { dedupeKey: true, createdAt: true } })
    const warnedAt = new Map(warnings.map((w) => [w.dedupeKey, w.createdAt]))
    const events: EventDraft[] = []
    const notifications: NotificationDraft[] = []
    let removed = 0
    for (const draft of idle) {
      const warned = warnedAt.get(warningKey(draft.id))
      const expiresAt = new Date(draft.updatedAt.getTime() + DRAFT_EXPIRE_AFTER_DAYS * MS_PER_DAY)
      if (!warned) {
        // The deletion date the requester is told: 90 days after the last edit, and never sooner than 7 days from now
        const deleteOn = new Date(Math.max(expiresAt.getTime(), ctx.now.getTime() + DRAFT_WARNING_LEAD_DAYS * MS_PER_DAY))
        events.push({ type: 'request.draft_expiry_notified', aggregateType: 'Request', aggregateId: draft.id, data: { deleteOn: deleteOn.toISOString() } })
        notifications.push({
          recipientMemberId: draft.requesterMemberId,
          templateKey: 'request.draft_expiring',
          data: { requestId: draft.id, title: draft.title, deleteOn: deleteOn.toISOString() },
          urgency: 'IMMEDIATE',
          dedupeKey: warningKey(draft.id),
          subjectType: 'REQUEST',
          subjectId: draft.id,
        })
        continue
      }
      const leadOver = warned.getTime() + DRAFT_WARNING_LEAD_DAYS * MS_PER_DAY <= ctx.now.getTime()
      if (expiresAt <= ctx.now && leadOver) {
        await tx.request.update({ where: { id: draft.id }, data: { status: 'CANCELLED', cancelledAt: ctx.now, cancelReason: 'STALE_DRAFT', version: { increment: 1 } } })
        events.push({ type: 'request.cancelled', aggregateType: 'Request', aggregateId: draft.id, data: { from: 'DRAFT', reasonCommentId: null } })
        removed++
      }
    }
    if (events.length === 0) return { ok: false, error: { code: 'NOT_FOUND', message: 'idle drafts were warned already' } }
    return { ok: true, result: { warned: notifications.length, removed }, events, notifications }
  },
})

export function expireStaleDrafts(ctx: Ctx, options: RunOptions) {
  return runCommand(ctx, expireStaleDraftsCommand, {}, options)
}

/** What the job draft-expiry runs for one organization on one day; the day is the idempotency key */
export function runDraftExpiry(organizationId: string, now: Date) {
  return expireStaleDrafts(systemCtx(organizationId, now, 'draft-expiry'), { idempotencyKey: `draft-expiry:${now.toISOString().slice(0, 10)}` })
}

/** The organizations the job runs for: every active one */
export async function activeOrganizationIds(): Promise<string[]> {
  return (await listOrganizationsForPlatform()).filter((o) => o.status === 'ACTIVE').map((o) => o.id)
}
