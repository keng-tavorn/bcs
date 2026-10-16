// Member.notificationPrefs as read outside the service that writes it (src/server/services/self/notification-prefs.ts):
// delivery reads it here, since the notification layer may not import services. Every key is optional.

/**
 * Push in the BCS Go app is off unless the member turned it on (OQ-165, BR-NOTI-05, BR-NOTI-08); another broken key
 * does not change it
 */
export function appPushEnabled(notificationPrefs: unknown): boolean {
  return Boolean(notificationPrefs && typeof notificationPrefs === 'object' && (notificationPrefs as { appPush?: unknown }).appPush === true)
}
