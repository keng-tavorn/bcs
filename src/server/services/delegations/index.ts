import { z } from 'zod'
import { DOA_DOCUMENT_TYPES } from '@/core/doa'
import { validateNewDelegation } from '@/core/delegation'
import { DELEGATION_MACHINE, transition, type DelegationState } from '@/core/state-machines'
import { amountToSatang } from '@/core/money/dto'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { newId } from '@/lib/ids'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import type { TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import type { NotificationDraft } from '@/server/notifications/create'
import { loadDelegations, loadOrgSnapshot } from '@/server/doa/policy'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'

// Delegation set by the delegator (spec §7.6, FR-DOA-006, BR-DLG-01..05): who acts for them, from when until when,
// optionally for some document types and up to a cap. While it runs, new tasks of the delegator go to the delegate
// (resolveRoute, BR-DLG-04); the delegation-window job of S5-07 moves the tasks waiting for the delegator to the delegate
// when it starts and those still waiting back when it ends or is cancelled (NEW-35, ../sla/delegation-window.ts).
// ORG_ADMIN sets one for someone else only through an ORG_AUTHORITY_CHANGE of kind DELEGATION_ON_BEHALF (S2-16), never
// here.

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

/** [startsAt, endsAt): the period is over at endsAt (§6.4 Delegation ACTIVE → ENDED), whatever the stored status says yet */
const periodOver = (delegation: { readonly endsAt: Date }, now: Date) => delegation.endsAt.getTime() <= now.getTime()

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
    // The period decides as well as the stored status: the delegation-window job writes ENDED when it runs at endsAt, so a
    // delegation whose period is over has ended even while its row still says ACTIVE or SCHEDULED — there is nothing to
    // cancel, and its tasks come back through the job's end of the period (BR-DLG-04)
    if (periodOver(delegation, ctx.now)) return fail('INVALID_STATE_TRANSITION', 'the delegation has ended', { from: 'ENDED' })
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

/**
 * FR-AUTH-003 AC2: a deactivated member's delegations — given or held, scheduled or running — are revoked in the
 * deactivation's transaction, each with its event, and the other side is told.
 */
export async function revokeDelegationsOf(tx: TenantTx, ctx: Ctx, memberId: string): Promise<{ count: number; events: EventDraft[]; notifications: NotificationDraft[] }> {
  const running = await tx.delegation.findMany({
    where: { OR: [{ delegatorMemberId: memberId }, { delegateMemberId: memberId }], status: { in: ['SCHEDULED', 'ACTIVE'] } },
    orderBy: { id: 'asc' },
    select: { id: true },
  })
  const locked = await lockRowsForUpdate(
    tx,
    'Delegation',
    ctx.organizationId,
    running.map((d) => d.id),
  )
  const events: EventDraft[] = []
  const notifications: NotificationDraft[] = []
  for (const id of locked) {
    const d = await tx.delegation.findUniqueOrThrow({ where: { id } })
    if (d.status !== 'SCHEDULED' && d.status !== 'ACTIVE') continue
    await tx.delegation.update({ where: { id }, data: { status: 'REVOKED', revokedAt: ctx.now } })
    events.push({ type: 'delegation.revoked', aggregateType: 'Delegation', aggregateId: id, data: { from: d.status } })
    const other = d.delegatorMemberId === memberId ? d.delegateMemberId : d.delegatorMemberId
    notifications.push({ recipientMemberId: other, templateKey: 'delegation.revoked', data: { delegationId: id }, urgency: 'IMMEDIATE', dedupeKey: `delegation.revoked:${id}`, subjectType: 'DELEGATION', subjectId: id })
  }
  return { count: events.length, events, notifications }
}

/**
 * The stored status follows the period (§6.4 Delegation: SCHEDULED → ACTIVE at startsAt, ACTIVE → ENDED at endsAt),
 * written by the delegation-window job's commands in their transaction, which holds the delegation's row lock and
 * records delegation.started or delegation.ended (S5-07, src/server/services/sla/delegation-window.ts). An ended
 * delegation can no longer be revoked, and deactivating either side leaves it alone. Returns the new status, or null
 * when the move does not apply (ACTIVE already at its start — it was set while running — revoked, or ended).
 */
export async function markDelegationWindow(tx: TenantTx, delegationId: string, command: 'delegation.start' | 'delegation.end'): Promise<DelegationState | null> {
  const d = await tx.delegation.findUniqueOrThrow({ where: { id: delegationId }, select: { status: true } })
  const moved = transition(DELEGATION_MACHINE, d.status as DelegationState, command)
  if (!moved.ok) return null
  await tx.delegation.update({ where: { id: delegationId }, data: { status: moved.to } })
  return moved.to
}
