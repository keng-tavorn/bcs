'use server'

import { randomUUID } from 'node:crypto'
import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { systemClock } from '@/lib/clock'
import { ctxFromSession, resolveSession } from '@/server/auth/session'
import { revokeOwnSession } from '@/server/services/members'

// Sign out one of my other devices (FR-AUTH-003 AC3). The service checks the session belongs to me.
export async function revokeDeviceAction(formData: FormData): Promise<void> {
  const state = await resolveSession(await headers())
  const ctx = ctxFromSession(state, 'WEB', systemClock.now())
  if (!ctx) return
  await revokeOwnSession(ctx, { sessionId: String(formData.get('sessionId') ?? '') }, { idempotencyKey: randomUUID() })
  revalidatePath('/settings/security')
}
