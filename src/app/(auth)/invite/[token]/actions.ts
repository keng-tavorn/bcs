'use server'

import { systemClock } from '@/lib/clock'
import { acceptInvitation } from '@/server/services/members'
import type { AcceptInvitationOutcome } from '@/ui/auth/invite-form'

// Invitation links expire on real time (security clock), like sessions.
export async function acceptInvitationAction(token: string, password: string): Promise<AcceptInvitationOutcome> {
  const result = await acceptInvitation({ token, password }, systemClock.now())
  return result.ok ? { ok: true } : { ok: false, code: result.error.code }
}
