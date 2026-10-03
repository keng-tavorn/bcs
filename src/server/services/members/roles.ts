import { z } from 'zod'
import { authorize } from '@/server/authz'
import { STORED_ROLES, type StoredRole } from '@/server/authz/permissions'
import type { Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'

// Grant and revoke roles (FR-ADM-001 AC1–AC2). ORG_ADMIN only; nobody grants a role to themselves, and the last
// active ORG_ADMIN keeps the role. A role never makes anyone an approver (§2.2): approval comes from DOA positions.

type FailCode = 'VALIDATION_FAILED' | 'NOT_FOUND' | 'INVALID_STATE_TRANSITION' | 'FORBIDDEN'
const fail = (code: FailCode, message: string, details?: Record<string, unknown>) =>
  ({ ok: false, error: { code, message, ...(details ? { details } : {}) } }) as const

const RoleInput = z.object({ memberId: z.uuid(), role: z.enum(STORED_ROLES) })

export const grantRoleCommand = defineCommand({
  name: 'member.grant_role',
  capability: 'admin.members',
  input: RoleInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ memberId: string; role: StoredRole }>> {
    const allowed = await authorize(tx, ctx, 'admin.members')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    if (ctx.actor.type === 'USER' && ctx.actor.memberId === input.memberId) {
      return fail('FORBIDDEN', 'an administrator cannot grant a role to themselves', { reason: 'SELF_GRANT' })
    }
    const locked = await lockRowsForUpdate(tx, 'Member', ctx.organizationId, [input.memberId])
    if (locked.length === 0) return fail('NOT_FOUND', 'member not found')
    const member = await tx.member.findUniqueOrThrow({ where: { id: input.memberId }, select: { status: true } })
    if (member.status === 'DEACTIVATED') return fail('INVALID_STATE_TRANSITION', 'member is deactivated')
    if (await tx.roleAssignment.findFirst({ where: { memberId: input.memberId, role: input.role, revokedAt: null } })) {
      return fail('VALIDATION_FAILED', 'member already has this role', { field: 'role', reason: 'ALREADY_GRANTED' })
    }
    await tx.roleAssignment.create({
      data: {
        organizationId: ctx.organizationId,
        memberId: input.memberId,
        role: input.role,
        grantedById: ctx.actor.type === 'USER' ? ctx.actor.memberId : null,
        grantedAt: ctx.now,
      },
    })
    return {
      ok: true,
      result: { memberId: input.memberId, role: input.role },
      events: [{ type: 'member.role_granted', aggregateType: 'Member', aggregateId: input.memberId, data: { role: input.role, scopeDepartmentId: null } }],
    }
  },
})

export const revokeRoleCommand = defineCommand({
  name: 'member.revoke_role',
  capability: 'admin.members',
  input: RoleInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ memberId: string; role: StoredRole }>> {
    const allowed = await authorize(tx, ctx, 'admin.members')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    const locked = await lockRowsForUpdate(tx, 'Member', ctx.organizationId, [input.memberId])
    if (locked.length === 0) return fail('NOT_FOUND', 'member not found')
    const assignment = await tx.roleAssignment.findFirst({ where: { memberId: input.memberId, role: input.role, revokedAt: null }, select: { id: true } })
    if (!assignment) return fail('NOT_FOUND', 'member does not have this role', { field: 'role' })
    if (input.role === 'ORG_ADMIN') {
      const admins = await tx.roleAssignment.findMany({ where: { role: 'ORG_ADMIN', revokedAt: null, member: { status: 'ACTIVE' } }, select: { memberId: true } })
      const others = new Set(admins.map((a) => a.memberId))
      others.delete(input.memberId)
      if (others.size === 0) return fail('VALIDATION_FAILED', 'the organization must keep an active ORG_ADMIN', { field: 'role', reason: 'LAST_ORG_ADMIN' })
    }
    await tx.roleAssignment.update({ where: { id: assignment.id }, data: { revokedAt: ctx.now } })
    return {
      ok: true,
      result: { memberId: input.memberId, role: input.role },
      events: [{ type: 'member.role_revoked', aggregateType: 'Member', aggregateId: input.memberId, data: { role: input.role } }],
    }
  },
})

export function grantRole(ctx: Ctx, input: z.input<typeof RoleInput>, options: RunOptions) {
  return runCommand(ctx, grantRoleCommand, input, options)
}

export function revokeRole(ctx: Ctx, input: z.input<typeof RoleInput>, options: RunOptions) {
  return runCommand(ctx, revokeRoleCommand, input, options)
}
