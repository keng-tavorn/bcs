import { timingSafeEqual } from 'node:crypto'
import { symmetricDecrypt } from 'better-auth/crypto'
import { MS_PER_SECOND, STEP_UP_TTL_MS, TOTP_ACCEPTED_DRIFT_STEPS } from '@/lib/constants'
import { newId } from '@/lib/ids'
import { hotp, TOTP_PERIOD_SECONDS } from '@/lib/totp'
import { systemDb } from '@/server/db/system'
import type { TenantTx } from '@/server/db/tenant'
import { auth } from './auth'
import { beginLoginAttempt, settleLoginAttempt } from './lockout'

// Step-up (spec BR-DOA-15, NFR-SEC-04, FR-DOA-010 AC2): approving a DOA version or an authority change needs the second
// factor again — before S5 the authenticator code (TOTP), from S5-05 the LINE PIN. A correct code gives a grant for that
// one document, valid 5 minutes and used once by the decision. Times here are the security clock (real time), never the
// business clock that e2e tests move. Wrong codes count toward the same per-account lock as sign-in (NFR-SEC-05).

export const STEP_UP_PURPOSE = 'APPROVE_POLICY'

export type StepUpOutcome = { readonly ok: true; readonly grantId: string; readonly expiresAt: Date } | { readonly ok: false; readonly reason: 'LOCKED' | 'INVALID_CODE' | 'NO_SECOND_FACTOR' }

function sameCode(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

/** Checks a TOTP code of the member's sign-in identity against the steps around `nowMs`. */
async function totpMatches(userId: string, code: string, nowMs: number): Promise<boolean | null> {
  const row = await systemDb.twoFactor.findFirst({ where: { userId }, select: { secret: true } })
  if (!row?.secret) return null
  const key = (await auth.$context).secretConfig
  const secret = await symmetricDecrypt({ key, data: row.secret })
  const step = Math.floor(nowMs / (TOTP_PERIOD_SECONDS * MS_PER_SECOND))
  let match = false
  for (let drift = -TOTP_ACCEPTED_DRIFT_STEPS; drift <= TOTP_ACCEPTED_DRIFT_STEPS; drift++) match = sameCode(hotp(secret, step + drift), code) || match
  return match
}

/** Verifies the code and grants a step-up for one document. */
export async function grantStepUp(
  input: { readonly organizationId: string; readonly memberId: string; readonly subjectType: string; readonly subjectId: string; readonly code: string },
  now: Date,
): Promise<StepUpOutcome> {
  const member = await systemDb.member.findFirst({ where: { id: input.memberId, organizationId: input.organizationId }, select: { email: true, userId: true } })
  if (!member?.userId) return { ok: false, reason: 'NO_SECOND_FACTOR' }
  const attempt = await beginLoginAttempt(member.email, 'unknown', now)
  if (!attempt.allowed) return { ok: false, reason: 'LOCKED' }
  const matches = await totpMatches(member.userId, input.code.trim(), now.getTime())
  await settleLoginAttempt(attempt.attemptId, matches === true)
  if (matches === null) return { ok: false, reason: 'NO_SECOND_FACTOR' }
  if (!matches) return { ok: false, reason: 'INVALID_CODE' }
  const expiresAt = new Date(now.getTime() + STEP_UP_TTL_MS)
  const grantId = newId()
  await systemDb.stepUpGrant.create({
    data: { id: grantId, organizationId: input.organizationId, memberId: input.memberId, purpose: STEP_UP_PURPOSE, subjectType: input.subjectType, subjectId: input.subjectId, method: 'TOTP', grantedAt: now, expiresAt },
  })
  return { ok: true, grantId, expiresAt }
}

/**
 * Uses the member's live grant for this document inside the deciding command (once only). null when there is none: the
 * command answers STEP_UP_REQUIRED.
 */
export async function consumeStepUp(tx: TenantTx, input: { readonly memberId: string; readonly subjectType: string; readonly subjectId: string }, now: Date): Promise<string | null> {
  const grant = await tx.stepUpGrant.findFirst({
    where: { memberId: input.memberId, subjectType: input.subjectType, subjectId: input.subjectId, purpose: STEP_UP_PURPOSE, usedAt: null, expiresAt: { gt: now } },
    orderBy: { grantedAt: 'desc' },
    select: { id: true },
  })
  if (!grant) return null
  const used = await tx.stepUpGrant.updateMany({ where: { id: grant.id, usedAt: null }, data: { usedAt: now } })
  return used.count === 1 ? grant.id : null
}
