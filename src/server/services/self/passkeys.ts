import { z } from 'zod'
import { err, ok, type Result } from '@/core/result'
import { systemClock } from '@/lib/clock'
import { PASSKEY_REGISTRATIONS_MAX, PASSKEY_REGISTRATION_WINDOW_MS } from '@/lib/constants'
import { checkPinChangeProof } from '@/server/auth/pin'
import { checkRegistration, RegistrationResponse, registrationOptions } from '@/server/auth/passkey'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { countRateLimited } from '@/server/db/sql/rate-limit'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import type { NotificationDraft } from '@/server/notifications/create'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'

// The member's own passkeys (S17-15, FR-PLT-301 AC4, BR-AUTH-10, BR-AUTH-11, capability self.passkeys: any member, OWN
// only), on /settings/pin beside the PIN. A passkey is a proof of step-up like the PIN, never a sign-in (OQ-168), so
// adding one takes what setting a PIN takes: a fresh proof of who the member is — the password or the authenticator
// code, from confirmIdentityForPin of ./pin.ts, good for 5 minutes — first for the options (a REGISTER challenge used
// once), then again with the new credential, which is checked against that challenge, this environment's origin and RP
// ID, and user verification (src/server/auth/passkey.ts). Too many tries in a row are RATE_LIMITED. Removing one of
// one's own passkeys needs nothing more. Both are commands (runCommand) with an event and an e-mail to the owner
// (security.notice). Nobody adds or removes another member's passkey: a reset of their identity or their deactivation
// revokes all of theirs (revokeMemberPasskeys).

/** At most this many passkeys in use per member (docs/sub-specs/S17.md, MemberPasskey) */
export const PASSKEYS_PER_MEMBER_MAX = 10
const PROOF_INPUT_MAX = 128
const LABEL_MAX = 60

const fail = (code: 'VALIDATION_FAILED' | 'NOT_FOUND' | 'STEP_UP_REQUIRED' | 'INVALID_STATE_TRANSITION' | 'RATE_LIMITED', message: string, details?: Record<string, unknown>) =>
  ({ ok: false, error: { code, message, ...(details ? { details } : {}) } }) as const

const ownMember = (ctx: Ctx) => (ctx.actor.type === 'USER' ? ctx.actor.memberId : null)

/** The proof of confirmIdentityForPin, read on the security clock against the member's PIN as it is now */
async function proofOf(tx: TenantTx, ctx: Ctx, memberId: string, proofToken: string) {
  const member = await tx.member.findUniqueOrThrow({ where: { id: memberId }, select: { transactionPinHash: true, status: true, email: true, displayNameTh: true } })
  return { member, proof: checkPinChangeProof(proofToken, { organizationId: ctx.organizationId, memberId, currentPinHash: member.transactionPinHash }, systemClock.now()) }
}

/** BR-AUTH-10: a few ceremonies a quarter of an hour per member, so a stolen session cannot try passkeys unseen */
async function withinRegistrationLimit(memberId: string): Promise<boolean> {
  return (await countRateLimited(`bcs:passkey-register:${memberId}`, PASSKEY_REGISTRATION_WINDOW_MS, PASSKEY_REGISTRATIONS_MAX, systemClock.now())).allowed
}

// ---------- the options of a new passkey ----------

const OptionsInput = z.strictObject({ proofToken: z.string().min(1).max(PROOF_INPUT_MAX) })

/**
 * The options for navigator.credentials.create (BR-AUTH-10): UV required, none of the member's passkeys again. Refused:
 * STEP_UP_REQUIRED {reason: IDENTITY_PROOF} without a fresh proof · VALIDATION_FAILED {reason: LIMIT} at 10 passkeys ·
 * RATE_LIMITED after too many tries.
 */
export async function newPasskeyOptions(ctx: Ctx, input: unknown): Promise<Result<{ readonly options: unknown }>> {
  const memberId = ownMember(ctx)
  if (!memberId) return err('FORBIDDEN', 'members only', { capability: 'self.passkeys' })
  const parsed = OptionsInput.safeParse(input)
  if (!parsed.success) return err('STEP_UP_REQUIRED', 'prove who you are again to add a passkey', { reason: 'IDENTITY_PROOF', proof: 'MALFORMED' })
  if (!(await withinRegistrationLimit(memberId))) return err('RATE_LIMITED', 'too many passkeys tried in a row', { reason: 'PASSKEY_REGISTRATION' })
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const allowed = await authorize(tx, ctx, 'self.passkeys', { ownerMemberIds: [memberId] })
    if (!allowed.ok) return allowed
    const { member, proof } = await proofOf(tx, ctx, memberId, parsed.data.proofToken)
    if (!proof.ok) return fail('STEP_UP_REQUIRED', 'prove who you are again to add a passkey', { reason: 'IDENTITY_PROOF', proof: proof.reason })
    if ((await tx.memberPasskey.count({ where: { memberId, revokedAt: null } })) >= PASSKEYS_PER_MEMBER_MAX) return fail('VALIDATION_FAILED', 'remove a passkey before adding another', { field: 'passkey', reason: 'LIMIT' })
    const options = await registrationOptions(tx, { organizationId: ctx.organizationId, memberId, email: member.email, displayName: member.displayNameTh }, systemClock.now())
    return ok({ options })
  })
}

// ---------- adding it ----------

const AddInput = z.strictObject({
  proofToken: z.string().min(1).max(PROOF_INPUT_MAX),
  /** What navigator.credentials.create answered (RegistrationResponseJSON) */
  response: RegistrationResponse,
  /** A name the member gives the device, at most 60 characters */
  deviceLabel: z.string().trim().max(LABEL_MAX).optional(),
})

export const addPasskeyCommand = defineCommand({
  name: 'self.add_passkey',
  capability: 'self.passkeys',
  input: AddInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ passkeyId: string }>> {
    const memberId = ownMember(ctx)
    if (!memberId) return { ok: false, error: { code: 'FORBIDDEN', message: 'members only' } }
    const allowed = await authorize(tx, ctx, 'self.passkeys', { ownerMemberIds: [memberId] })
    if (!allowed.ok) return { ok: false, error: allowed.error }
    // The same row lock as a PIN change: the proof is read against the PIN as it stands
    const [locked] = await lockRowsForUpdate(tx, 'Member', ctx.organizationId, [memberId])
    if (!locked) return fail('NOT_FOUND', 'member not found')
    const { member, proof } = await proofOf(tx, ctx, memberId, input.proofToken)
    if (member.status !== 'ACTIVE') return fail('INVALID_STATE_TRANSITION', 'only an active member adds a passkey')
    if (!proof.ok) return fail('STEP_UP_REQUIRED', 'prove who you are again (password or authenticator code) to add a passkey', { reason: 'IDENTITY_PROOF', proof: proof.reason })
    if ((await tx.memberPasskey.count({ where: { memberId, revokedAt: null } })) >= PASSKEYS_PER_MEMBER_MAX) return fail('VALIDATION_FAILED', 'remove a passkey before adding another', { field: 'passkey', reason: 'LIMIT' })
    const checked = await checkRegistration(tx, memberId, input.response, systemClock.now())
    if (!checked.ok) return fail('VALIDATION_FAILED', 'this passkey could not be added', { field: 'passkey', reason: checked.reason })
    if (await tx.memberPasskey.findFirst({ where: { credentialId: checked.credentialId }, select: { id: true } })) return fail('VALIDATION_FAILED', 'this passkey is added already', { field: 'passkey', reason: 'DUPLICATE' })
    // Used once, in the transaction that adds the passkey
    const spent = await tx.passkeyChallenge.updateMany({ where: { id: checked.challengeId!, usedAt: null }, data: { usedAt: systemClock.now() } })
    if (spent.count !== 1) return fail('VALIDATION_FAILED', 'this passkey could not be added', { field: 'passkey', reason: 'CHALLENGE' })
    const created = await tx.memberPasskey.create({
      data: {
        organizationId: ctx.organizationId,
        memberId,
        credentialId: checked.credentialId,
        publicKey: new Uint8Array(checked.publicKey),
        signCount: BigInt(checked.signCount),
        transports: checked.transports,
        deviceLabel: input.deviceLabel || null,
      },
      select: { id: true },
    })
    return {
      ok: true,
      result: { passkeyId: created.id },
      events: [{ type: 'auth.passkey_added', aggregateType: 'Auth', aggregateId: memberId, data: { passkeyId: created.id, proof: proof.method } }],
      notifications: [passkeyNotice(memberId, 'PASSKEY_ADDED', created.id)],
    }
  },
})

/**
 * Adds a passkey of the member's own (FR-PLT-301 AC4). Refused: STEP_UP_REQUIRED {reason: IDENTITY_PROOF} without a
 * fresh proof · VALIDATION_FAILED {field: passkey, reason: CHALLENGE | ORIGIN_MISMATCH | ATTESTATION | UV_REQUIRED |
 * DUPLICATE | LIMIT}. Too many tries in a row are refused when their options are asked for (RATE_LIMITED).
 */
export function addOwnPasskey(ctx: Ctx, input: z.input<typeof AddInput>, options: RunOptions) {
  // The tries are counted where a ceremony starts (newPasskeyOptions): a resend of the same key after a lost answer
  // gets the answer stored for it, and a new try needs new options
  return runCommand(ctx, addPasskeyCommand, input, options)
}

// ---------- removing it ----------

const RemoveInput = z.strictObject({ passkeyId: z.uuid() })

export const removePasskeyCommand = defineCommand({
  name: 'self.remove_passkey',
  capability: 'self.passkeys',
  input: RemoveInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ passkeyId: string }>> {
    const memberId = ownMember(ctx)
    if (!memberId) return { ok: false, error: { code: 'FORBIDDEN', message: 'members only' } }
    const allowed = await authorize(tx, ctx, 'self.passkeys', { ownerMemberIds: [memberId] })
    if (!allowed.ok) return { ok: false, error: allowed.error }
    // Someone else's passkey is not found, as one that does not exist
    const [locked] = await lockRowsForUpdate(tx, 'MemberPasskey', ctx.organizationId, [input.passkeyId])
    const passkey = locked ? await tx.memberPasskey.findUnique({ where: { id: input.passkeyId }, select: { memberId: true, revokedAt: true } }) : null
    if (!passkey || passkey.memberId !== memberId) return fail('NOT_FOUND', 'passkey not found')
    if (passkey.revokedAt) return fail('INVALID_STATE_TRANSITION', 'the passkey is removed already')
    await tx.memberPasskey.update({ where: { id: input.passkeyId }, data: { revokedAt: ctx.now, revokeReason: 'USER', version: { increment: 1 } } })
    return {
      ok: true,
      result: { passkeyId: input.passkeyId },
      events: [{ type: 'auth.passkey_removed', aggregateType: 'Auth', aggregateId: memberId, data: { passkeyId: input.passkeyId, by: 'SELF' } }],
      notifications: [passkeyNotice(memberId, 'PASSKEY_REMOVED', input.passkeyId)],
    }
  },
})

/** Removes one of the member's own passkeys: it confirms nothing from now on */
export function removeOwnPasskey(ctx: Ctx, input: z.input<typeof RemoveInput>, options: RunOptions) {
  return runCommand(ctx, removePasskeyCommand, input, options)
}

function passkeyNotice(memberId: string, kind: 'PASSKEY_ADDED' | 'PASSKEY_REMOVED', passkeyId: string): NotificationDraft {
  return {
    recipientMemberId: memberId,
    templateKey: 'security.notice',
    data: { kind },
    urgency: 'IMMEDIATE',
    dedupeKey: `security.notice:${kind.toLowerCase()}:${passkeyId}`,
    subjectType: 'Member',
    subjectId: memberId,
  }
}

// ---------- the list, for /settings/pin ----------

export interface PasskeyDto {
  readonly id: string
  readonly deviceLabel: string | null
  readonly addedAt: string
  readonly lastUsedAt: string | null
}

/** The member's passkeys in use, newest first (never the credential or its key) */
export async function listOwnPasskeys(ctx: Ctx): Promise<Result<readonly PasskeyDto[]>> {
  const memberId = ownMember(ctx)
  if (!memberId) return err('FORBIDDEN', 'members only', { capability: 'self.passkeys' })
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const allowed = await authorize(tx, ctx, 'self.passkeys', { ownerMemberIds: [memberId] })
    if (!allowed.ok) return allowed
    const rows = await tx.memberPasskey.findMany({ where: { memberId, revokedAt: null }, orderBy: { createdAt: 'desc' }, select: { id: true, deviceLabel: true, createdAt: true, lastUsedAt: true } })
    return ok(rows.map((r) => ({ id: r.id, deviceLabel: r.deviceLabel, addedAt: r.createdAt.toISOString(), lastUsedAt: r.lastUsedAt?.toISOString() ?? null })))
  })
}

/** Whether the member has a passkey in use (the decision pages offer it beside the PIN) */
export async function hasOwnPasskey(ctx: Ctx): Promise<boolean> {
  const memberId = ownMember(ctx)
  if (!memberId) return false
  return (await forTenant(ctx.organizationId).memberPasskey.count({ where: { memberId, revokedAt: null } })) > 0
}

// ---------- revoked with the member's identity (BR-AUTH-11) ----------

/**
 * Every passkey of the member in use stops counting, in the caller's transaction: a reset of their identity
 * (IDENTITY_RESET, BR-AUTH-07) or their deactivation (BR-AUTH-06). Returns auth.passkey_removed for each.
 */
export async function revokeMemberPasskeys(tx: TenantTx, memberId: string, reason: 'IDENTITY_RESET' | 'DEACTIVATED', now: Date): Promise<{ count: number; events: EventDraft[] }> {
  const live = await tx.memberPasskey.findMany({ where: { memberId, revokedAt: null }, select: { id: true } })
  if (live.length === 0) return { count: 0, events: [] }
  await tx.memberPasskey.updateMany({ where: { id: { in: live.map((p) => p.id) }, revokedAt: null }, data: { revokedAt: now, revokeReason: reason, version: { increment: 1 } } })
  return { count: live.length, events: live.map((p) => ({ type: 'auth.passkey_removed', aggregateType: 'Auth', aggregateId: memberId, data: { passkeyId: p.id, by: reason } })) }
}
