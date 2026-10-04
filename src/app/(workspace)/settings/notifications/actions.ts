'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { updateNotificationPrefs } from '@/server/services/self/notification-prefs'
import type { DigestOutcome } from '@/ui/settings-notifications/types'
import { getSession } from '../../../_lib/session'

// Browser-facing adapter for /settings/notifications (FR-LINE-006 AC3). The service checks self.notificationPrefs — the
// member's own preferences only — every time (BR-AUTH-05) and takes the daily summary only: approval tasks and overdue
// work cannot be switched off (BR-NOTI-04).

const submissionKey = z.uuid()

/** Turns the member's own daily summary on or off; asking for what is already in effect counts as done */
export async function setDailyDigestAction(digest: boolean, idempotencyKey: string): Promise<DigestOutcome> {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return { ok: false, code: 'UNAUTHENTICATED' }
  if (typeof digest !== 'boolean' || !submissionKey.safeParse(idempotencyKey).success) return { ok: false, code: 'VALIDATION_FAILED' }
  const result = await updateNotificationPrefs(ctx, { digest }, { idempotencyKey })
  if (!result.ok) {
    // The setting is already what the member asked for (another tab, a double tap): nothing to change, and that is fine
    if (result.error.code === 'VALIDATION_FAILED' && result.error.details?.reason === 'NO_CHANGE') return { ok: true, digest }
    const requestId = result.error.details?.requestId
    return { ok: false, code: result.error.code, ...(typeof requestId === 'string' ? { requestId } : {}) }
  }
  revalidatePath('/settings/notifications')
  return { ok: true, digest: result.data.digest }
}
