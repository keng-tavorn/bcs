'use server'

import { randomUUID } from 'node:crypto'
import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { systemClock } from '@/lib/clock'
import { ctxFromSession, resolveSession } from '@/server/auth/session'
import { markNotificationsRead } from '@/server/services/notifications'

// The bell's two actions (FR-NOTI-001 AC1). Both POST; the service marks only the member's own notifications.

/** Only paths inside the app are followed, never another site */
const isAppPath = (href: string) => href.startsWith('/') && !href.startsWith('//') && !href.includes('\\')

/** Opens a notification: marks it read, then goes to its document */
export async function openNotificationAction(formData: FormData): Promise<void> {
  const ctx = ctxFromSession(await resolveSession(await headers()), 'WEB', systemClock.now())
  if (!ctx) redirect('/login')
  const id = String(formData.get('id') ?? '')
  const href = String(formData.get('href') ?? '')
  // An already-read notification answers NOT_FOUND; the member still goes to the document
  await markNotificationsRead(ctx, { notificationIds: [id] }, { idempotencyKey: randomUUID() })
  revalidatePath('/', 'layout')
  if (isAppPath(href)) redirect(href)
}

export async function markAllNotificationsReadAction(): Promise<void> {
  const ctx = ctxFromSession(await resolveSession(await headers()), 'WEB', systemClock.now())
  if (!ctx) redirect('/login')
  await markNotificationsRead(ctx, { all: true }, { idempotencyKey: randomUUID() })
  revalidatePath('/', 'layout')
}
