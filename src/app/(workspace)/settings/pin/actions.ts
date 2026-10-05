'use server'

import { revalidatePath } from 'next/cache'
import { getLocale } from 'next-intl/server'
import { z } from 'zod'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { confirmIdentityForPin, setOwnPin } from '@/server/services/self/pin'
import { formatDateTime } from '@/ui/format'
import { toPinFailure, type PinFailure, type ProveIdentityInputView, type ProveIdentityOutcome, type SetPinOutcome } from '@/ui/settings-pin/types'
import { getSession } from '../../../_lib/session'

// Browser-facing adapters for /settings/pin (FR-AUTH-005 AC1). Each checks the session; the services check self.pin —
// the member's own PIN only — every time (BR-AUTH-05). The member whose PIN is set comes from the session, never from
// the page. Nothing here logs or returns the password, the PIN or the proof beyond the answer to the page itself.

const NO_SESSION: PinFailure = { ok: false, code: 'UNAUTHENTICATED' }
const submissionKey = z.uuid()

async function currentCtx() {
  return ctxFromSession(await getSession(), 'WEB', systemClock.now())
}

/** Step 1: the password or the authenticator code again; a proof good for a few minutes */
export async function proveIdentityForPinAction(input: ProveIdentityInputView): Promise<ProveIdentityOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  // The service parses the input itself; only the two shapes the page sends go through
  const sent = input && typeof input === 'object' ? (input.method === 'TOTP' ? { method: 'TOTP', code: input.code } : { method: 'PASSWORD', password: input.password }) : null
  const locale = await getLocale()
  const proved = await confirmIdentityForPin(ctx, sent)
  if (!proved.ok) {
    const until = typeof proved.error.details?.time === 'string' ? formatDateTime(locale, proved.error.details.time) : undefined
    return toPinFailure(proved.error, until)
  }
  return { ok: true, proofToken: proved.data.proofToken, expiresAtText: formatDateTime(locale, proved.data.expiresAt) }
}

/** Step 2: the new PIN with the proof of step 1, for the signed-in member only */
export async function setOwnPinAction(input: { pin: string; proofToken: string }, idempotencyKey: string): Promise<SetPinOutcome> {
  const ctx = await currentCtx()
  if (!ctx || ctx.actor.type !== 'USER') return NO_SESSION
  if (!submissionKey.safeParse(idempotencyKey).success) return { ok: false, code: 'VALIDATION_FAILED', field: 'idempotencyKey' }
  const result = await setOwnPin(ctx, { memberId: ctx.actor.memberId, pin: String(input?.pin ?? ''), proofToken: String(input?.proofToken ?? '') }, { idempotencyKey })
  if (!result.ok) return toPinFailure(result.error)
  revalidatePath('/settings/pin')
  return { ok: true, replaced: result.data.replaced }
}
