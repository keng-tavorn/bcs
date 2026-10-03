import { z } from 'zod'
import { isPinLocked, pinAttemptsLeft, pinProblem } from '@/core/pin'
import { err, ok, type Result } from '@/core/result'
import { systemClock } from '@/lib/clock'
import { checkPinChangeProof, hashPin, type IdentityProofMethod } from '@/server/auth/pin'
import { proveIdentityForPin } from '@/server/auth/step-up'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import { forTenant } from '@/server/db/tenant'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'

// The member's own transaction PIN (spec FR-AUTH-005 AC1, NEW-30, capability self.pin: any member, OWN only). Setting or
// changing it takes two steps, on the web (/settings/pin) or in LIFF:
//   1. confirmIdentityForPin(): the member proves who they are again with the password or the authenticator code (counted
//      and recorded like a sign-in) and gets a proof, proofToken, good for 5 minutes on the security clock
//      (src/server/auth/pin.ts);
//   2. setOwnPin(): the command self.set_pin checks the proof and the PIN rule of src/core/pin, stores the argon2id hash,
//      clears the count of wrong PINs and any lock, and records auth.pin_set (never the PIN or the hash).
// Nobody sets another member's PIN: not an ORG_ADMIN and not the platform (a member who forgot the PIN sets a new one
// with their password). The screens take memberId from the session; the command refuses any other.

const PIN_INPUT_MAX = 32
const PROOF_INPUT_MAX = 128
const PASSWORD_INPUT_MAX = 256

const fail = (code: 'VALIDATION_FAILED' | 'NOT_FOUND' | 'STEP_UP_REQUIRED', message: string, details?: Record<string, unknown>) =>
  ({ ok: false, error: { code, message, ...(details ? { details } : {}) } }) as const

const ownMember = (ctx: Ctx) => (ctx.actor.type === 'USER' ? ctx.actor.memberId : null)

/** self.pin with OWN: only the member themselves, active (BR-AUTH-05: checked in the service, every time) */
async function allowedForSelf(ctx: Ctx): Promise<Result<string>> {
  const memberId = ownMember(ctx)
  if (!memberId) return err('FORBIDDEN', 'members only', { capability: 'self.pin' })
  const allowed = await forTenant(ctx.organizationId).$transaction((tx) => authorize(tx, ctx, 'self.pin', { ownerMemberIds: [memberId] }))
  return allowed.ok ? ok(memberId) : allowed
}

// ---------- 1. prove who you are ----------

const ProveInput = z.discriminatedUnion('method', [
  z.strictObject({ method: z.literal('PASSWORD'), password: z.string().min(1).max(PASSWORD_INPUT_MAX) }),
  z.strictObject({ method: z.literal('TOTP'), code: z.string().trim().regex(/^[0-9]{6}$/) }),
])

export interface PinProofDto {
  /**
   * Give it back to setOwnPin within 5 minutes; keep it in the page only, never in a URL or a log. Its name ends in
   * "token" so the logger redacts it wherever it appears as a key (NFR-SEC-09).
   */
  readonly proofToken: string
  readonly expiresAt: string
  readonly method: IdentityProofMethod
}

/**
 * Step 1 (FR-AUTH-005 AC1): the signed-in member proves who they are again, at `securityNow` (real time). A wrong
 * password or code counts toward the sign-in lock: VALIDATION_FAILED {field, reason: WRONG}, then RATE_LIMITED {reason:
 * ACCOUNT_LOCKED, time} while the account is locked. A method the member has not set up is VALIDATION_FAILED {field:
 * method, reason: NOT_AVAILABLE}.
 */
export async function confirmIdentityForPin(ctx: Ctx, input: unknown, securityNow: Date = systemClock.now()): Promise<Result<PinProofDto>> {
  const allowed = await allowedForSelf(ctx)
  if (!allowed.ok) return allowed
  const parsed = ProveInput.safeParse(input)
  if (!parsed.success) {
    // Only the field's name: the issue text could quote what was typed
    const field = parsed.error.issues[0]?.path.join('.') || 'method'
    return err('VALIDATION_FAILED', 'invalid input', { field: field === 'password' || field === 'code' ? field : 'method' })
  }
  const proved = await proveIdentityForPin({ organizationId: ctx.organizationId, memberId: allowed.data, ...parsed.data }, securityNow)
  if (proved.ok) return ok({ proofToken: proved.proofToken, expiresAt: proved.expiresAt.toISOString(), method: proved.method })
  if (proved.reason === 'LOCKED') return err('RATE_LIMITED', 'too many wrong tries for this account', { reason: 'ACCOUNT_LOCKED', time: proved.retryAt.toISOString() })
  if (proved.reason === 'INVALID') return err('VALIDATION_FAILED', 'wrong password or code', { field: parsed.data.method === 'PASSWORD' ? 'password' : 'code', reason: 'WRONG' })
  return err('VALIDATION_FAILED', 'this way of proving who you are is not set up', { field: 'method', reason: 'NOT_AVAILABLE' })
}

// ---------- 2. set the PIN ----------

const SetPinInput = z.strictObject({
  /** The member whose PIN this is: the screen sends the signed-in member, and self.pin refuses anybody else */
  memberId: z.uuid(),
  /** Checked by the PIN rule (src/core/pin) for a precise reason */
  pin: z.string().max(PIN_INPUT_MAX),
  /** The proof of step 1 (PinProofDto.proofToken) */
  proofToken: z.string().min(1).max(PROOF_INPUT_MAX),
})

export const setPinCommand = defineCommand({
  name: 'self.set_pin',
  capability: 'self.pin',
  input: SetPinInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ memberId: string; replaced: boolean }>> {
    const allowed = await authorize(tx, ctx, 'self.pin', { ownerMemberIds: [input.memberId] })
    if (!allowed.ok) return { ok: false, error: allowed.error }
    // The same row lock as a PIN check (src/server/auth/step-up.ts): a change never interleaves with a count
    const [locked] = await lockRowsForUpdate(tx, 'Member', ctx.organizationId, [input.memberId])
    if (!locked) return fail('NOT_FOUND', 'member not found')
    const member = await tx.member.findUniqueOrThrow({ where: { id: input.memberId }, select: { transactionPinHash: true, pinLockedUntil: true } })
    // The proof is read on the security clock: e2e tests move ctx.now, never this 5-minute window
    const securityNow = systemClock.now()
    const proof = checkPinChangeProof(input.proofToken, { organizationId: ctx.organizationId, memberId: input.memberId, currentPinHash: member.transactionPinHash }, securityNow)
    if (!proof.ok) return fail('STEP_UP_REQUIRED', 'prove who you are again (password or authenticator code) to set the PIN', { reason: 'IDENTITY_PROOF', proof: proof.reason })
    const problem = pinProblem(input.pin)
    if (problem) return fail('VALIDATION_FAILED', 'this PIN cannot be used', { field: 'pin', reason: problem })
    const replaced = member.transactionPinHash !== null
    const unlocked = isPinLocked(member.pinLockedUntil, securityNow)
    // A new PIN after a fresh proof of the stronger factors starts the count of wrong PINs again and ends any lock
    await tx.member.update({ where: { id: input.memberId }, data: { transactionPinHash: await hashPin(input.pin), pinFailedCount: 0, pinLockedUntil: null } })
    return {
      ok: true,
      result: { memberId: input.memberId, replaced },
      events: [{ type: 'auth.pin_set', aggregateType: 'Auth', aggregateId: input.memberId, data: { replaced, proof: proof.method, unlocked } }],
    }
  },
})

/**
 * Step 2 (FR-AUTH-005 AC1): sets or changes the member's own PIN. Refused: FORBIDDEN for anybody but the member;
 * STEP_UP_REQUIRED {reason: IDENTITY_PROOF, proof: MALFORMED | NOT_VALID | EXPIRED} without a fresh proof of step 1;
 * VALIDATION_FAILED {field: pin, reason: FORMAT | ALL_SAME | SEQUENCE | COMMON} for a PIN that is easy to guess.
 */
export function setOwnPin(ctx: Ctx, input: z.input<typeof SetPinInput>, options: RunOptions) {
  return runCommand(ctx, setPinCommand, input, options)
}

// ---------- the PIN's state, for the screens ----------

export interface PinStatusDto {
  readonly hasPin: boolean
  /** When the lock after five wrong PINs ends; null when not locked */
  readonly lockedUntil: string | null
  /** Wrong PINs still allowed before the lock */
  readonly attemptsLeft: number
}

/** Whether the signed-in member has a PIN and whether it is locked now (security clock). Never the PIN or its hash. */
export async function getOwnPinStatus(ctx: Ctx, securityNow: Date = systemClock.now()): Promise<Result<PinStatusDto>> {
  const allowed = await allowedForSelf(ctx)
  if (!allowed.ok) return allowed
  const member = await forTenant(ctx.organizationId).member.findFirst({ where: { id: allowed.data }, select: { transactionPinHash: true, pinFailedCount: true, pinLockedUntil: true } })
  if (!member) return err('NOT_FOUND', 'member not found')
  const locked = isPinLocked(member.pinLockedUntil, securityNow)
  return ok({ hasPin: member.transactionPinHash !== null, lockedUntil: locked && member.pinLockedUntil ? member.pinLockedUntil.toISOString() : null, attemptsLeft: locked ? 0 : pinAttemptsLeft(member.pinFailedCount) })
}
