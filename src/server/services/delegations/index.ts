import { z } from 'zod'
import { DOA_DOCUMENT_TYPES } from '@/core/doa'
import { validateNewDelegation } from '@/core/delegation'
import { amountToSatang } from '@/core/money/dto'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { newId } from '@/lib/ids'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import { loadDelegations, loadOrgSnapshot } from '@/server/doa/policy'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'

// Delegation set by the delegator (spec §7.6, FR-DOA-006, BR-DLG-01..05): who acts for them, from when until when,
// optionally for some document types and up to a cap. While it runs, new tasks of the delegator go to the delegate
// (resolveRoute, BR-DLG-04). Moving open tasks when it starts and ends is a job of S5-07. ORG_ADMIN sets one for someone
// else only through an ORG_AUTHORITY_CHANGE of kind DELEGATION_ON_BEHALF (S2-16), never here.

const fail = (code: 'VALIDATION_FAILED' | 'NOT_FOUND' | 'INVALID_STATE_TRANSITION', message: string, details?: Record<string, unknown>) =>
  ({ ok: false, error: { code, message, ...(details ? { details } : {}) } }) as const

const CreateInput = z.strictObject({
  delegateMemberId: z.uuid(),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  /** Empty or absent: every document type, governance included (ADR-038 ข้อ 6) */
  documentTypes: z.array(z.enum(DOA_DOCUMENT_TYPES)).default([]),
  /** Baht with up to 2 decimals; a capped delegation never covers documents without an amount (ADR-038 ข้อ 7) */
  maxAmount: z
    .string()
    .regex(/^\d{1,13}(\.\d{1,2})?$/)
    .optional(),
  reason: z.string().trim().min(3).max(REASON_MAX_LENGTH),
})

export const createDelegationCommand = defineCommand({
  name: 'delegation.create',
  capability: 'delegation.manage',
  input: CreateInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ delegationId: string; status: 'SCHEDULED' | 'ACTIVE' }>> {
    const delegator = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
    if (!delegator) return { ok: false, error: { code: 'FORBIDDEN', message: 'only a member delegates' } }
    const allowed = await authorize(tx, ctx, 'delegation.manage', { ownerMemberIds: [delegator] })
    if (!allowed.ok) return { ok: false, error: allowed.error }
    // One delegator at a time, so two overlapping delegations cannot both pass the check (the exclusion constraint is the backstop)
    await lockRowsForUpdate(tx, 'Member', ctx.organizationId, [delegator])
    const startsAt = new Date(input.startsAt)
    const endsAt = new Date(input.endsAt)
    const maxAmountSatang = input.maxAmount === undefined ? null : amountToSatang(input.maxAmount)
    const refusal = validateNewDelegation(
      { delegatorMemberId: delegator, delegateMemberId: input.delegateMemberId, startsAt, endsAt, documentTypes: input.documentTypes.length ? input.documentTypes : null, maxAmountSatang },
      await loadDelegations(tx),
      await loadOrgSnapshot(tx),
    )
    if (refusal) return fail('VALIDATION_FAILED', `delegation refused: ${refusal}`, { reason: refusal })
    const id = newId()
    const status = startsAt.getTime() <= ctx.now.getTime() ? 'ACTIVE' : 'SCHEDULED'
    await tx.delegation.create({
      data: { id, organizationId: ctx.organizationId, delegatorMemberId: delegator, delegateMemberId: input.delegateMemberId, startsAt, endsAt, documentTypes: input.documentTypes, maxAmountSatang, reason: input.reason, status, createdVia: 'SELF' },
    })
    return {
      ok: true,
      result: { delegationId: id, status },
      events: [
        {
          type: 'delegation.created',
          aggregateType: 'Delegation',
          aggregateId: id,
          data: { delegatorMemberId: delegator, delegateMemberId: input.delegateMemberId, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), status, createdVia: 'SELF' },
        },
      ],
      notifications: [
        {
          recipientMemberId: input.delegateMemberId,
          templateKey: 'delegation.created',
          data: { delegationId: id, delegatorMemberId: delegator, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() },
          urgency: 'IMMEDIATE',
          dedupeKey: `delegation.created:${id}`,
          subjectType: 'DELEGATION',
          subjectId: id,
        },
      ],
    }
  },
})

export function createDelegation(ctx: Ctx, input: z.input<typeof CreateInput>, options: RunOptions) {
  return runCommand(ctx, createDelegationCommand, input, options)
}

const RevokeInput = z.strictObject({ delegationId: z.uuid() })

export const revokeDelegationCommand = defineCommand({
  name: 'delegation.revoke',
  capability: 'delegation.manage',
  input: RevokeInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ delegationId: string }>> {
    const [locked] = await lockRowsForUpdate(tx, 'Delegation', ctx.organizationId, [input.delegationId])
    if (!locked) return fail('NOT_FOUND', 'delegation not found')
    const delegation = await tx.delegation.findUniqueOrThrow({ where: { id: input.delegationId } })
    const allowed = await authorize(tx, ctx, 'delegation.manage', { ownerMemberIds: [delegation.delegatorMemberId] })
    if (!allowed.ok) return { ok: false, error: allowed.error }
    if (delegation.status !== 'SCHEDULED' && delegation.status !== 'ACTIVE') return fail('INVALID_STATE_TRANSITION', 'the delegation is no longer running', { from: delegation.status })
    await tx.delegation.update({ where: { id: delegation.id }, data: { status: 'REVOKED', revokedAt: ctx.now } })
    return {
      ok: true,
      result: { delegationId: delegation.id },
      events: [{ type: 'delegation.revoked', aggregateType: 'Delegation', aggregateId: delegation.id, data: { from: delegation.status } }],
      notifications: [
        {
          recipientMemberId: delegation.delegateMemberId,
          templateKey: 'delegation.revoked',
          data: { delegationId: delegation.id },
          urgency: 'IMMEDIATE',
          dedupeKey: `delegation.revoked:${delegation.id}`,
          subjectType: 'DELEGATION',
          subjectId: delegation.id,
        },
      ],
    }
  },
})

export function revokeDelegation(ctx: Ctx, input: z.input<typeof RevokeInput>, options: RunOptions) {
  return runCommand(ctx, revokeDelegationCommand, input, options)
}
