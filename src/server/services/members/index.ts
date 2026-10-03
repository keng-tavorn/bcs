import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'
import { err, ok, type Result } from '@/core/result'
import { INVITATION_TTL_MS, PASSWORD_MIN_LENGTH, REASON_MAX_LENGTH } from '@/lib/constants'
import { newId } from '@/lib/ids'
import { makeCtx, type Ctx } from '@/server/context'
import { findInvitationByTokenHash } from '@/server/db/lookups'
import { countOtherActiveMemberships, deleteMemberSession, deleteMemberSessions, removeMemberTwoFactor } from '@/server/db/sql/identity'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { reliedOnByDoa } from '@/server/doa/policy'
import { authorize } from '@/server/authz'
import { STORED_ROLES } from '@/server/authz/permissions'
import { sendInvitationEmail } from '@/server/auth/emails'
import { upsertUserWithPassword } from '@/server/auth/provision'
import type { EventDraft } from '@/server/events/append'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { runDeactivationRevokers } from './revokers'

// Member lifecycle (FR-AUTH-001..003; the admin screens are S1-12 / FR-ADM-001). Every change goes through
// runCommand and writes events; free-text reasons are stored in Comment and referenced by id.

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const fail = (code: 'VALIDATION_FAILED' | 'NOT_FOUND' | 'INVALID_STATE_TRANSITION' | 'FORBIDDEN', message: string, details?: Record<string, unknown>) =>
  ({ ok: false, error: { code, message, ...(details ? { details } : {}) } }) as const

async function addComment(tx: TenantTx, ctx: Ctx, subjectId: string, body: string): Promise<string> {
  const id = newId()
  await tx.comment.create({
    data: { id, organizationId: ctx.organizationId, subjectType: 'Member', subjectId, authorMemberId: ctx.actor.type === 'USER' ? ctx.actor.memberId : null, body },
  })
  return id
}

async function activeOrgAdminIds(tx: TenantTx): Promise<string[]> {
  const rows = await tx.roleAssignment.findMany({ where: { role: 'ORG_ADMIN', revokedAt: null, member: { status: 'ACTIVE' } }, select: { memberId: true } })
  return [...new Set(rows.map((r) => r.memberId))]
}

// ---------- invite (FR-AUTH-001 AC1) ----------

const InviteInput = z.object({
  email: z.email().transform((e) => e.trim().toLowerCase()),
  displayNameTh: z.string().trim().min(1).max(200),
  displayNameEn: z.string().trim().max(200).optional(),
  employeeCode: z.string().trim().max(50).optional(),
  roles: z.array(z.enum(STORED_ROLES)).default([]),
  locale: z.enum(['th', 'en']).default('th'),
})

export interface InviteResult {
  readonly memberId: string
  readonly invitationId: string
  readonly expiresAt: string
  readonly tokenHash: string
}

function inviteCommand(tokenHash: string) {
  return defineCommand({
    name: 'member.invite',
    capability: 'admin.members',
    input: InviteInput,
    async execute(tx, input, ctx): Promise<CommandOutcome<InviteResult>> {
      const allowed = await authorize(tx, ctx, 'admin.members')
      if (!allowed.ok) return { ok: false, error: allowed.error }
      const existing = await tx.member.findFirst({ where: { email: input.email } })
      if (existing && existing.status !== 'INVITED') {
        return fail('VALIDATION_FAILED', 'e-mail already belongs to a member', { field: 'email', reason: 'ALREADY_MEMBER' })
      }
      const memberId = existing?.id ?? newId()
      if (!existing) {
        await tx.member.create({
          data: {
            id: memberId,
            organizationId: ctx.organizationId,
            email: input.email,
            displayNameTh: input.displayNameTh,
            ...(input.displayNameEn ? { displayNameEn: input.displayNameEn } : {}),
            ...(input.employeeCode ? { employeeCode: input.employeeCode } : {}),
            status: 'INVITED',
          },
        })
      } else {
        await lockRowsForUpdate(tx, 'Member', ctx.organizationId, [memberId])
        await tx.memberInvitation.updateMany({ where: { memberId, usedAt: null, revokedAt: null }, data: { revokedAt: ctx.now } })
      }
      const events: EventDraft[] = []
      const actorId = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
      const current = new Set((await tx.roleAssignment.findMany({ where: { memberId, revokedAt: null }, select: { role: true } })).map((r) => r.role))
      for (const role of new Set(input.roles)) {
        if (current.has(role)) continue
        await tx.roleAssignment.create({ data: { organizationId: ctx.organizationId, memberId, role, grantedById: actorId, grantedAt: ctx.now } })
        events.push({ type: 'member.role_granted', aggregateType: 'Member', aggregateId: memberId, data: { role, scopeDepartmentId: null } })
      }
      const invitationId = newId()
      const expiresAt = new Date(ctx.now.getTime() + INVITATION_TTL_MS)
      await tx.memberInvitation.create({
        data: { id: invitationId, organizationId: ctx.organizationId, memberId, tokenHash, expiresAt, createdById: actorId },
      })
      events.unshift({ type: 'member.invited', aggregateType: 'Member', aggregateId: memberId, data: { invitationId, roles: [...new Set(input.roles)], resent: Boolean(existing) } })
      return { ok: true, result: { memberId, invitationId, expiresAt: expiresAt.toISOString(), tokenHash }, events }
    },
  })
}

/** emailSent: whether the invitation e-mail went out; null for a repeat of a submission already handled, whose
 *  e-mail was sent (or not) the first time and is not sent again. */
export async function inviteMember(
  ctx: Ctx,
  input: z.input<typeof InviteInput>,
  options: RunOptions,
): Promise<Result<{ memberId: string; invitationId: string; expiresAt: string; emailSent: boolean | null }>> {
  const token = randomBytes(32).toString('base64url')
  const tokenHash = sha256(token)
  const result = await runCommand(ctx, inviteCommand(tokenHash), input, options)
  if (!result.ok) return result
  // A replay of the same command returns the stored result; its link was already e-mailed, so send nothing.
  const fresh = result.data.tokenHash === tokenHash
  let emailSent: boolean | null = null
  if (fresh) {
    const db = forTenant(ctx.organizationId)
    const org = await db.organization.findUniqueOrThrow({ where: { id: ctx.organizationId } })
    const inviter = ctx.actor.type === 'USER' ? await db.member.findUnique({ where: { id: ctx.actor.memberId } }) : null
    const parsed = InviteInput.parse(input)
    emailSent = await sendInvitationEmail({
      to: parsed.email,
      orgName: org.displayName ?? org.legalNameTh,
      inviterName: inviter?.displayNameTh ?? null,
      token,
      locale: parsed.locale,
    })
  }
  return ok({ memberId: result.data.memberId, invitationId: result.data.invitationId, expiresAt: result.data.expiresAt, emailSent })
}

// ---------- accept invitation (FR-AUTH-001 AC1–AC2) ----------

const AcceptInput = z.object({ token: z.string().min(20), password: z.string().min(PASSWORD_MIN_LENGTH).max(128) })

const acceptCommand = defineCommand({
  name: 'member.accept_invitation',
  capability: 'self.twoFactor',
  input: z.object({ invitationId: z.uuid(), userId: z.uuid() }),
  async execute(tx, input, ctx): Promise<CommandOutcome<{ memberId: string }>> {
    const invitation = await tx.memberInvitation.findUnique({ where: { id: input.invitationId } })
    if (!invitation) return fail('NOT_FOUND', 'invitation not found')
    await lockRowsForUpdate(tx, 'Member', ctx.organizationId, [invitation.memberId])
    const fresh = await tx.memberInvitation.findUniqueOrThrow({ where: { id: input.invitationId } })
    if (fresh.usedAt || fresh.revokedAt || fresh.expiresAt <= ctx.now) return fail('INVALID_STATE_TRANSITION', 'invitation no longer valid')
    const member = await tx.member.findUniqueOrThrow({ where: { id: invitation.memberId } })
    if (member.status !== 'INVITED') return fail('INVALID_STATE_TRANSITION', 'member is not waiting for activation')
    await tx.member.update({ where: { id: member.id }, data: { userId: input.userId, status: 'ACTIVE' } })
    await tx.memberInvitation.update({ where: { id: invitation.id }, data: { usedAt: ctx.now } })
    return { ok: true, result: { memberId: member.id }, events: [{ type: 'member.activated', aggregateType: 'Member', aggregateId: member.id, data: { via: 'INVITATION' } }] }
  },
})

/**
 * Public endpoint: the invitee sets a password through the one-time link. When the e-mail already has an
 * identity (a member of another organization), the link proves control of that mailbox just like a password
 * reset e-mail does, so the password is replaced and the identity's other sessions are signed out.
 */
export async function acceptInvitation(input: z.input<typeof AcceptInput>, now: Date): Promise<Result<{ memberId: string; organizationId: string }>> {
  const parsed = AcceptInput.safeParse(input)
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.join('.') || 'token'
    return err('VALIDATION_FAILED', 'invalid input', { field })
  }
  const invitation = await findInvitationByTokenHash(sha256(parsed.data.token))
  if (!invitation) return err('TOKEN_INVALID', 'unknown invitation')
  if (invitation.usedAt) return err('TOKEN_USED', 'invitation already used', { time: invitation.usedAt.toISOString() })
  if (invitation.revokedAt) return err('TOKEN_INVALID', 'invitation was replaced')
  if (invitation.expiresAt <= now) return err('TOKEN_EXPIRED', 'invitation expired')
  const userId = await upsertUserWithPassword({ email: invitation.member.email, name: invitation.member.displayNameTh, password: parsed.data.password })
  const ctx = makeCtx({ organizationId: invitation.organizationId, actor: { type: 'USER', memberId: invitation.memberId }, channel: 'WEB', now })
  const result = await runCommand(ctx, acceptCommand, { invitationId: invitation.id, userId }, { idempotencyKey: `invitation:${invitation.id}` })
  return result.ok ? ok({ memberId: result.data.memberId, organizationId: invitation.organizationId }) : result
}

// ---------- deactivate (FR-AUTH-003 AC2, BR-AUTH-06) ----------

const DeactivateInput = z.object({ memberId: z.uuid(), reason: z.string().trim().min(3).max(REASON_MAX_LENGTH) })

export const deactivateMemberCommand = defineCommand({
  name: 'member.deactivate',
  capability: 'admin.members',
  input: DeactivateInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ memberId: string; revoked: Record<string, number>; openTasks: number }>> {
    const allowed = await authorize(tx, ctx, 'admin.members')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    if (ctx.actor.type === 'USER' && ctx.actor.memberId === input.memberId) {
      return fail('VALIDATION_FAILED', 'cannot deactivate yourself', { field: 'memberId', reason: 'SELF' })
    }
    const locked = await lockRowsForUpdate(tx, 'Member', ctx.organizationId, [input.memberId])
    if (locked.length === 0) return fail('NOT_FOUND', 'member not found')
    const member = await tx.member.findUniqueOrThrow({ where: { id: input.memberId } })
    if (member.status === 'DEACTIVATED') return fail('INVALID_STATE_TRANSITION', 'member already deactivated')
    const admins = await activeOrgAdminIds(tx)
    if (admins.includes(member.id) && admins.length <= 1) {
      return fail('VALIDATION_FAILED', 'cannot deactivate the last organization admin', { field: 'memberId', reason: 'LAST_ORG_ADMIN' })
    }
    const reasonCommentId = await addComment(tx, ctx, member.id, input.reason)
    await tx.member.update({ where: { id: member.id }, data: { status: 'DEACTIVATED' } })
    const sessions = await deleteMemberSessions(tx, ctx.organizationId, member.id)
    const invitations = (await tx.memberInvitation.updateMany({ where: { memberId: member.id, usedAt: null, revokedAt: null }, data: { revokedAt: ctx.now } })).count
    const extra = await runDeactivationRevokers(tx, ctx, { memberId: member.id, userId: member.userId })
    const revoked = { sessions, invitations, ...extra.counts }
    // FR-AUTH-003 AC2 (§10.1 admin.reassign_needed): approval tasks still waiting on the member need someone else
    const openTasks = await tx.approvalTask.count({ where: { OR: [{ assigneeMemberId: member.id }, { principalMemberId: member.id }], status: { in: ['OPEN', 'INFO_REQUESTED'] } } })
    const told = openTasks ? admins.filter((id) => id !== member.id) : []
    return {
      ok: true,
      result: { memberId: member.id, revoked, openTasks },
      events: [{ type: 'member.deactivated', aggregateType: 'Member', aggregateId: member.id, data: { reasonCommentId, revoked } }, ...extra.events],
      notifications: [
        ...extra.notifications,
        ...told.map((adminId) => ({
          recipientMemberId: adminId,
          templateKey: 'admin.reassign_needed',
          data: { memberId: member.id, name: member.displayNameTh, openTasks },
          urgency: 'IMMEDIATE' as const,
          dedupeKey: `admin.reassign_needed:${reasonCommentId}:${adminId}`,
          subjectType: 'MEMBER',
          subjectId: member.id,
        })),
      ],
    }
  },
})

export function deactivateMember(ctx: Ctx, input: z.input<typeof DeactivateInput>, options: RunOptions) {
  return runCommand(ctx, deactivateMemberCommand, input, options)
}

// ---------- ORG_ADMIN resets another member's 2FA (FR-AUTH-002 AC3) ----------

const ResetTwoFactorInput = z.object({ memberId: z.uuid(), reason: z.string().trim().min(3).max(REASON_MAX_LENGTH) })

export const resetTwoFactorCommand = defineCommand({
  name: 'member.reset_two_factor',
  capability: 'admin.members',
  input: ResetTwoFactorInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ memberId: string; sessionsRevoked: number }>> {
    const allowed = await authorize(tx, ctx, 'admin.members')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    if (ctx.actor.type === 'USER' && ctx.actor.memberId === input.memberId) {
      return fail('VALIDATION_FAILED', 'reset your own 2FA from your security settings', { field: 'memberId', reason: 'SELF' })
    }
    const locked = await lockRowsForUpdate(tx, 'Member', ctx.organizationId, [input.memberId])
    if (locked.length === 0) return fail('NOT_FOUND', 'member not found')
    const member = await tx.member.findUniqueOrThrow({ where: { id: input.memberId } })
    if (!member.userId) return fail('INVALID_STATE_TRANSITION', 'member has not activated an account')
    // BR-AUTH-07 (FR-AUTH-002 AC3): a member the DOA relies on — a holder of a position a rule names, a named approver,
    // or anyone with an open approval task — is reset only through an ORG_AUTHORITY_CHANGE of kind IDENTITY_RESET
    if (await reliedOnByDoa(tx, member.id, ctx.now)) {
      return fail('FORBIDDEN', 'this member holds DOA authority: propose an IDENTITY_RESET authority change', { reason: 'USE_ORG_AUTHORITY_CHANGE', kind: 'IDENTITY_RESET' })
    }
    if ((await countOtherActiveMemberships(tx, ctx.organizationId, member.id)) > 0) {
      // The sign-in identity is shared with another organization: this organization's admin cannot change it
      return fail('FORBIDDEN', 'the account is also used by another organization', { reason: 'SHARED_IDENTITY' })
    }
    const reasonCommentId = await addComment(tx, ctx, member.id, input.reason)
    await removeMemberTwoFactor(tx, ctx.organizationId, member.id)
    const sessionsRevoked = await deleteMemberSessions(tx, ctx.organizationId, member.id)
    return {
      ok: true,
      result: { memberId: member.id, sessionsRevoked },
      events: [{ type: 'auth.2fa_reset', aggregateType: 'Auth', aggregateId: member.id, data: { reasonCommentId, sessionsRevoked } }],
      // The account owner is told by e-mail at once (§10.1 security.notice)
      notifications: [
        {
          recipientMemberId: member.id,
          templateKey: 'security.notice',
          data: { kind: 'TWO_FACTOR_RESET' },
          urgency: 'IMMEDIATE',
          dedupeKey: `security.notice:2fa_reset:${member.id}:${ctx.requestId}`,
          subjectType: 'Member',
          subjectId: member.id,
        },
      ],
    }
  },
})

export function resetMemberTwoFactor(ctx: Ctx, input: z.input<typeof ResetTwoFactorInput>, options: RunOptions) {
  return runCommand(ctx, resetTwoFactorCommand, input, options)
}

// ---------- own devices (FR-AUTH-003 AC3; the list itself is src/server/auth/sessions.ts) ----------

const RevokeSessionInput = z.object({ sessionId: z.uuid() })

const revokeOwnSessionCommand = defineCommand({
  name: 'member.revoke_own_session',
  capability: 'self.twoFactor',
  input: RevokeSessionInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ revoked: boolean }>> {
    const memberId = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
    if (!memberId) return fail('FORBIDDEN', 'members only')
    const removed = await deleteMemberSession(tx, ctx.organizationId, memberId, input.sessionId)
    if (removed === 0) return fail('NOT_FOUND', 'session not found')
    return {
      ok: true,
      result: { revoked: true },
      events: [{ type: 'member.session_revoked', aggregateType: 'Member', aggregateId: memberId, data: { sessionId: input.sessionId, self: true } }],
    }
  },
})

export function revokeOwnSession(ctx: Ctx, input: z.input<typeof RevokeSessionInput>, options: RunOptions) {
  return runCommand(ctx, revokeOwnSessionCommand, input, options)
}
