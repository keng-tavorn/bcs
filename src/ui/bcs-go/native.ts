'use client'

import { PUSH_REGISTRATION_TIMEOUT_MS } from '@/lib/constants'

// The BCS Go app's native side, as the web pages reach it (S17-10, ADR-163, BR-APP-01): Capacitor's bridge is in the
// WebView of the app only, and its plugins are loaded on demand from inside the app, never on a page opened in a
// browser — so a browser downloads none of this, and LIFF pages may not import it at all (bcs/liff-imports).

/** Where the app keeps the id of its push device, so signing out in the app revokes it (BR-AUTH-12) */
export const PUSH_DEVICE_STORAGE_KEY = 'bcs-go-push-device'

type Bridge = { readonly Capacitor?: { readonly isNativePlatform?: () => boolean } }

/** The page runs inside the BCS Go app (its WebView has Capacitor's bridge) */
export function inBcsGoApp(): boolean {
  return typeof window !== 'undefined' && (window as unknown as Bridge).Capacitor?.isNativePlatform?.() === true
}

/** The app's version from the mark it adds to its user agent ("BCSGo/0.1.0", mobile/bcs-go/capacitor.config.ts) */
export function appVersionOfAgent(userAgent: string): string | null {
  return /(?:^|\s)BCSGo\/(\d+\.\d+\.\d+)(?:\s|$)/.exec(userAgent)?.[1] ?? null
}

export type PushTokenResult = { readonly ok: true; readonly token: string; readonly platform: 'ANDROID' | 'IOS' } | { readonly ok: false; readonly reason: 'NOT_IN_APP' | 'DENIED' | 'UNAVAILABLE' }

/** Asks the phone for notifications and for this app's push token (FCM on Android) */
export async function requestPushToken(): Promise<PushTokenResult> {
  if (!inBcsGoApp()) return { ok: false, reason: 'NOT_IN_APP' }
  const [{ PushNotifications }, { Capacitor }] = await Promise.all([import('@capacitor/push-notifications'), import('@capacitor/core')])
  let permission = await PushNotifications.checkPermissions()
  if (permission.receive === 'prompt' || permission.receive === 'prompt-with-rationale') permission = await PushNotifications.requestPermissions()
  if (permission.receive !== 'granted') return { ok: false, reason: 'DENIED' }
  const platform = Capacitor.getPlatform() === 'ios' ? 'IOS' : 'ANDROID'
  return new Promise<PushTokenResult>((resolve) => {
    const handles: Array<Promise<{ remove: () => Promise<void> }>> = []
    const done = (result: PushTokenResult) => {
      clearTimeout(timer)
      for (const h of handles) void h.then((x) => x.remove())
      resolve(result)
    }
    const timer = setTimeout(() => done({ ok: false, reason: 'UNAVAILABLE' }), PUSH_REGISTRATION_TIMEOUT_MS)
    handles.push(PushNotifications.addListener('registration', (token) => done({ ok: true, token: token.value, platform })))
    handles.push(PushNotifications.addListener('registrationError', () => done({ ok: false, reason: 'UNAVAILABLE' })))
    void PushNotifications.register().catch(() => done({ ok: false, reason: 'UNAVAILABLE' }))
  })
}

/** A page of BCS itself: a path, never another site or a protocol-relative URL */
export function internalPath(value: unknown): string | null {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') ? value : null
}

/** Opens the page a tapped push names (data.path), inside the app; returns how to stop listening */
export async function listenForPushTaps(open: (path: string) => void): Promise<() => void> {
  if (!inBcsGoApp()) return () => undefined
  const { PushNotifications } = await import('@capacitor/push-notifications')
  const handle = await PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
    const path = internalPath((action.notification.data as Record<string, unknown> | undefined)?.path)
    if (path) open(path)
  })
  return () => void handle.remove()
}

/** The id of this app's push device, kept on the phone (null in a browser or before registration) */
export function storedPushDevice(): string | null {
  try {
    return inBcsGoApp() ? window.localStorage.getItem(PUSH_DEVICE_STORAGE_KEY) : null
  } catch {
    return null
  }
}

export function storePushDevice(deviceId: string | null): void {
  try {
    if (deviceId) window.localStorage.setItem(PUSH_DEVICE_STORAGE_KEY, deviceId)
    else window.localStorage.removeItem(PUSH_DEVICE_STORAGE_KEY)
  } catch {
    // Storage refused (private mode): signing out then leaves the device for the settings page or FCM to end
  }
}
