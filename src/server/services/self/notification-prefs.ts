import { z } from 'zod'
import { err, ok, type Result } from '@/core/result'
import { appPushEnabled } from '@/lib/notification-prefs'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import { forTenant } from '@/server/db/tenant'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'

// A member's own notification preferences (FR-LINE-006 AC3, NEW-31): the daily summary can be turned off and on again
// (Member.notificationPrefs.digest, on unless set to false), and push in the BCS Go app (appPush, S17-10, OQ-165): on
// instead of LINE, off back to LINE and e-mail — never silence (BR-NOTI-08). Approval tasks and tasks past their SLA are
// always sent at once and cannot be turned off (BR-NOTI-04, FR-NOTI-004 AC2): this command takes no other preference,
// so a request to silence them is refused as invalid input. The rest of FR-NOTI-004 (main channel, quiet hours) comes
// with S5-10.

/** The daily summary is on unless the member turned it off */
export function digestEnabled(notificationPrefs: unknown): boolean {
  return !(notificationPrefs && typeof notificationPrefs === 'object' && (notificationPrefs as { digest?: unknown }).digest === false)
}

/**
 * Member.notificationPrefs as stored: every key optional, missing reads as its default. appPush (S17-01, OQ-165): push
 * in the BCS Go app instead of LINE, off unless the member turned it on in the app (BR-NOTI-05, BR-NOTI-08).
 */
export const StoredNotificationPrefsSchema = z.object({ digest: z.boolean().optional(), appPush: z.boolean().optional() })

/** Push in the BCS Go app is off unless the member turned it on (OQ-165): read by delivery too, from src/lib */
export { appPushEnabled }

// One preference or both, at least one
const PrefsInput = z.strictObject({ digest: z.boolean().optional(), appPush: z.boolean().optional() }).refine((p) => p.digest !== undefined || p.appPush !== undefined, { message: 'nothing to change' })

export interface NotificationPrefsDto {
  readonly digest: boolean
  readonly appPush: boolean
  /** BR-NOTI-04: shown to the member, never a switch */
  readonly approvalsAlwaysImmediate: true
}

export const updateNotificationPrefsCommand = defineCommand({
  name: 'member.update_notification_prefs',
  capability: 'self.notificationPrefs',
  input: PrefsInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<NotificationPrefsDto>> {
    const memberId = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
    if (!memberId) return { ok: false, error: { code: 'FORBIDDEN', message: 'members only' } }
    // Only the member themselves, and only while ACTIVE (an invited or deactivated member holds no capability)
    const allowed = await authorize(tx, ctx, 'self.notificationPrefs', { ownerMemberIds: [memberId] })
    if (!allowed.ok) return { ok: false, error: allowed.error }
    await lockRowsForUpdate(tx, 'Member', ctx.organizationId, [memberId])
    const member = await tx.member.findUniqueOrThrow({ where: { id: memberId }, select: { notificationPrefs: true } })
    const before = { digest: digestEnabled(member.notificationPrefs), appPush: appPushEnabled(member.notificationPrefs) }
    const changed = {
      ...(input.digest !== undefined && input.digest !== before.digest ? { digest: input.digest } : {}),
      ...(input.appPush !== undefined && input.appPush !== before.appPush ? { appPush: input.appPush } : {}),
    }
    if (Object.keys(changed).length === 0) {
      return { ok: false, error: { code: 'VALIDATION_FAILED', message: 'nothing changes', details: { field: input.digest !== undefined ? 'digest' : 'appPush', reason: 'NO_CHANGE' } } }
    }
    const current = member.notificationPrefs && typeof member.notificationPrefs === 'object' && !Array.isArray(member.notificationPrefs) ? (member.notificationPrefs as Record<string, unknown>) : {}
    await tx.member.update({ where: { id: memberId }, data: { notificationPrefs: { ...current, ...changed } } })
    return {
      ok: true,
      result: { ...before, ...changed, approvalsAlwaysImmediate: true },
      events: [{ type: 'member.notification_prefs_updated', aggregateType: 'Member', aggregateId: memberId, data: changed }],
    }
  },
})

/** Turns the member's own daily summary off or on (FR-LINE-006 AC3) */
export function updateNotificationPrefs(ctx: Ctx, input: z.input<typeof PrefsInput>, options: RunOptions) {
  return runCommand(ctx, updateNotificationPrefsCommand, input, options)
}

/** The member's own preferences, for the settings page and LIFF */
export async function getMyNotificationPrefs(ctx: Ctx): Promise<Result<NotificationPrefsDto>> {
  const memberId = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
  if (!memberId) return err('FORBIDDEN', 'members only')
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const allowed = await authorize(tx, ctx, 'self.notificationPrefs', { ownerMemberIds: [memberId] })
    if (!allowed.ok) return err(allowed.error.code, allowed.error.message, allowed.error.details)
    const member = await tx.member.findUniqueOrThrow({ where: { id: memberId }, select: { notificationPrefs: true } })
    return ok({ digest: digestEnabled(member.notificationPrefs), appPush: appPushEnabled(member.notificationPrefs), approvalsAlwaysImmediate: true as const })
  })
}
