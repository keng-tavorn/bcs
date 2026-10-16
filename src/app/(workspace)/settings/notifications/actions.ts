'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { systemClock } from '@/lib/clock'
import { newId } from '@/lib/ids'
import { ctxFromSession } from '@/server/auth/session'
import { registerPushDevice, revokePushDevice } from '@/server/services/push-devices'
import { updateNotificationPrefs } from '@/server/services/self/notification-prefs'
import type { AppPushOutcome, DigestOutcome, RegisterDeviceOutcome, RevokeDeviceOutcome } from '@/ui/settings-notifications/types'
import { getSession } from '../../../_lib/session'

// Browser-facing adapter for /settings/notifications (FR-LINE-006 AC3, S17-10). The services check self.notificationPrefs
// and self.pushDevices — the member's own preferences and devices only — every time (BR-AUTH-05). They take the daily
// summary and push in the BCS Go app only: approval tasks and overdue work cannot be switched off (BR-NOTI-04). A
// device registers from inside the app (the service checks the APP channel, BR-APP-12).

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

const failure = (error: { code: string; details?: Record<string, unknown> }) => {
  const requestId = error.details?.requestId
  return { ok: false as const, code: error.code, ...(typeof requestId === 'string' ? { requestId } : {}) }
}

/** Turns push in the BCS Go app on or off (OQ-165); off goes back to LINE and e-mail (BR-NOTI-08) */
export async function setAppPushAction(appPush: boolean, idempotencyKey: string): Promise<AppPushOutcome> {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return { ok: false, code: 'UNAUTHENTICATED' }
  if (typeof appPush !== 'boolean' || !submissionKey.safeParse(idempotencyKey).success) return { ok: false, code: 'VALIDATION_FAILED' }
  const result = await updateNotificationPrefs(ctx, { appPush }, { idempotencyKey })
  if (!result.ok) {
    if (result.error.code === 'VALIDATION_FAILED' && result.error.details?.reason === 'NO_CHANGE') return { ok: true, appPush }
    return failure(result.error)
  }
  revalidatePath('/settings/notifications')
  return { ok: true, appPush: result.data.appPush }
}

/** Registers this phone for push, from inside the BCS Go app (FR-PLT-301 AC1) */
export async function registerPushDeviceAction(input: { token: string; platform: 'ANDROID' | 'IOS'; appVersion: string }, idempotencyKey: string): Promise<RegisterDeviceOutcome> {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return { ok: false, code: 'UNAUTHENTICATED' }
  if (!submissionKey.safeParse(idempotencyKey).success || typeof input !== 'object' || input === null) return { ok: false, code: 'VALIDATION_FAILED' }
  const result = await registerPushDevice(ctx, { token: input.token, platform: input.platform, appVersion: input.appVersion }, { idempotencyKey })
  if (!result.ok) return failure(result.error)
  revalidatePath('/settings/notifications')
  return { ok: true, deviceId: result.data.deviceId }
}

/** Ends one of the member's own devices from the settings page (FR-PLT-301 AC2) */
export async function revokePushDeviceAction(deviceId: string, idempotencyKey: string): Promise<RevokeDeviceOutcome> {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return { ok: false, code: 'UNAUTHENTICATED' }
  if (!submissionKey.safeParse(idempotencyKey).success || !z.uuid().safeParse(deviceId).success) return { ok: false, code: 'VALIDATION_FAILED' }
  const result = await revokePushDevice(ctx, { deviceId, reason: 'USER' }, { idempotencyKey })
  if (!result.ok) return failure(result.error)
  revalidatePath('/settings/notifications')
  return { ok: true }
}

/** Signing out in the app ends this phone's push device first (BR-AUTH-12 LOGOUT); a device already gone is fine */
export async function endPushDeviceOnSignOutAction(deviceId: string): Promise<void> {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx || !z.uuid().safeParse(deviceId).success) return
  await revokePushDevice(ctx, { deviceId, reason: 'LOGOUT' }, { idempotencyKey: newId() })
}
