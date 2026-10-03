import { z } from 'zod'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'

// Budget grants (spec FR-BUD-004 AC1, BR-BUD-04): BUDGET_ADMIN lets one department, or one member, use a budget line of
// another department for a period, and can take it back. Requests check the grant at submit (S3-05), and the approvers
// then come from the department that owns the budget (AC3).

type FailCode = 'VALIDATION_FAILED' | 'NOT_FOUND' | 'INVALID_STATE_TRANSITION'
const fail = (code: FailCode, message: string, details?: Record<string, unknown>) => ({ ok: false, error: { code, message, ...(details ? { details } : {}) } }) as const

const Instant = z.iso.datetime({ offset: true })
const CreateInput = z
  .strictObject({ budgetLineId: z.uuid(), granteeDepartmentId: z.uuid().optional(), granteeMemberId: z.uuid().optional(), validFrom: Instant, validTo: Instant.optional() })
  .refine((g) => Boolean(g.granteeDepartmentId) !== Boolean(g.granteeMemberId), { message: 'a grant goes to one department or one member', path: ['granteeDepartmentId'] })

export const createBudgetGrantCommand = defineCommand({
  name: 'budget_grant.create',
  capability: 'budgetGrant.manage',
  input: CreateInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ grantId: string }>> {
    const allowed = await authorize(tx, ctx, 'budgetGrant.manage')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    const actor = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
    if (!actor) return { ok: false, error: { code: 'FORBIDDEN', message: 'only a member grants' } }
    const line = await tx.budgetLine.findFirst({ where: { id: input.budgetLineId }, select: { id: true, departmentId: true, status: true } })
    if (!line) return fail('NOT_FOUND', 'budget line not found')
    if (line.status === 'CLOSED') return fail('VALIDATION_FAILED', 'the budget line is closed', { field: 'budgetLineId', reason: 'BUDGET_LINE_CLOSED' })
    const validFrom = new Date(input.validFrom)
    const validTo = input.validTo ? new Date(input.validTo) : null
    if (validTo && validTo <= validFrom) return fail('VALIDATION_FAILED', 'the grant ends before it starts', { field: 'validTo', reason: 'PERIOD' })
    if (input.granteeDepartmentId) {
      if (input.granteeDepartmentId === line.departmentId) return fail('VALIDATION_FAILED', 'the department owns this budget line already', { field: 'granteeDepartmentId', reason: 'OWN_DEPARTMENT' })
      if (!(await tx.department.findFirst({ where: { id: input.granteeDepartmentId, active: true }, select: { id: true } }))) {
        return fail('VALIDATION_FAILED', 'unknown department', { field: 'granteeDepartmentId', reason: 'DEPARTMENT' })
      }
    }
    if (input.granteeMemberId && !(await tx.member.findFirst({ where: { id: input.granteeMemberId, status: 'ACTIVE' }, select: { id: true } }))) {
      return fail('VALIDATION_FAILED', 'unknown or inactive member', { field: 'granteeMemberId', reason: 'MEMBER' })
    }
    const grant = await tx.budgetGrant.create({
      data: { organizationId: ctx.organizationId, budgetLineId: line.id, granteeDepartmentId: input.granteeDepartmentId ?? null, granteeMemberId: input.granteeMemberId ?? null, validFrom, validTo, grantedById: actor },
      select: { id: true },
    })
    return {
      ok: true,
      result: { grantId: grant.id },
      events: [
        {
          type: 'budget_grant.created',
          aggregateType: 'BudgetGrant',
          aggregateId: grant.id,
          data: { budgetLineId: line.id, granteeDepartmentId: input.granteeDepartmentId ?? null, granteeMemberId: input.granteeMemberId ?? null, validFrom: validFrom.toISOString(), validTo: validTo?.toISOString() ?? null },
        },
      ],
    }
  },
})

export function createBudgetGrant(ctx: Ctx, input: z.input<typeof CreateInput>, options: RunOptions) {
  return runCommand(ctx, createBudgetGrantCommand, input, options)
}

const RevokeInput = z.strictObject({ grantId: z.uuid() })

export const revokeBudgetGrantCommand = defineCommand({
  name: 'budget_grant.revoke',
  capability: 'budgetGrant.manage',
  input: RevokeInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ grantId: string }>> {
    const allowed = await authorize(tx, ctx, 'budgetGrant.manage')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    const grant = await tx.budgetGrant.findFirst({ where: { id: input.grantId }, select: { id: true, budgetLineId: true, revokedAt: true } })
    if (!grant) return fail('NOT_FOUND', 'grant not found')
    if (grant.revokedAt) return fail('INVALID_STATE_TRANSITION', 'the grant was revoked already', { from: 'REVOKED' })
    await tx.budgetGrant.update({ where: { id: grant.id }, data: { revokedAt: ctx.now } })
    // Requests submitted before keep what they reserved; new submits no longer find the grant
    return { ok: true, result: { grantId: grant.id }, events: [{ type: 'budget_grant.revoked', aggregateType: 'BudgetGrant', aggregateId: grant.id, data: { budgetLineId: grant.budgetLineId } }] }
  },
})

export function revokeBudgetGrant(ctx: Ctx, input: z.input<typeof RevokeInput>, options: RunOptions) {
  return runCommand(ctx, revokeBudgetGrantCommand, input, options)
}
