'use server'

import { systemClock } from '@/lib/clock'
import { acceptInvitation } from '@/server/services/members'
import type { AcceptInvitationOutcome } from '@/ui/auth/invite-form'

// Invitation links expire on real time (security clock), like sessions. A refusal of input the service cannot read
// (VALIDATION_FAILED) names its field, the link's token or the password, so the form says which one is wrong.
export async function acceptInvitationAction(token: string, password: string): Promise<AcceptInvitationOutcome> {
  const result = await acceptInvitation({ token, password }, systemClock.now())
  if (result.ok) return { ok: true }
  const field = result.error.details?.field
  return typeof field === 'string' ? { ok: false, code: result.error.code, field } : { ok: false, code: result.error.code }
}
