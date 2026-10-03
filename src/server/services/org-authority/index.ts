import { z } from 'zod'
import { validateNewDelegation } from '@/core/delegation'
import { DOA_DOCUMENT_TYPES, lintDoaVersion, versionAt, type DoaVersionSnapshot, type OrgSnapshot } from '@/core/doa'
import { amountToSatang } from '@/core/money/dto'
import { checkSod, type OrgAuthorityChangeKind } from '@/core/sod'
import { ORG_CHANGE_MACHINE, transition, type OrgChangeCommand, type OrgChangeState } from '@/core/state-machines'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { newId } from '@/lib/ids'
import { authorize } from '@/server/authz'
import { systemCtx, type Ctx } from '@/server/context'
import { deleteMemberSessions, removeMemberTwoFactor } from '@/server/db/sql/identity'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import type { TenantTx } from '@/server/db/tenant'
import { loadDelegations, loadOrgSnapshot, loadRoutePolicy } from '@/server/doa/policy'
import type { EventDraft } from '@/server/events/append'
import type { NotificationDraft } from '@/server/notifications/create'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { startRoute } from '../approvals/route'
import { warningKey } from '../doa/lint-view'

// Changes to the authority structure (spec FR-DOA-010, BR-DOA-17, BR-SOD-08, BR-AUTH-07): ORG_ADMIN proposes one of five
// kinds with an effective time that is not in the past and a reason; the approver of the ORG_AUTHORITY_CHANGE rule
// decides with a step-up; at the effective time the change is applied — holders change, open tasks follow the new
// holder, the people concerned are told — without a deploy (EG-8). A change that would leave nobody able to approve
// DOA_CHANGE or ORG_AUTHORITY_CHANGE is refused unless it names a replacement in the same request.

const fail = (code: 'VALIDATION_FAILED' | 'NOT_FOUND' | 'INVALID_STATE_TRANSITION', message: string, details?: Record<string, unknown>) =>
  ({ ok: false, error: { code, message, ...(details ? { details } : {}) } }) as const

const Code = z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/)
const Instant = z.iso.datetime({ offset: true })

export const PayloadSchemas = {
  POSITION_ASSIGN: z.strictObject({ positionCode: Code, departmentId: z.uuid(), memberId: z.uuid() }),
  POSITION_END: z.strictObject({ positionCode: Code, departmentId: z.uuid(), replacementMemberId: z.uuid().optional() }),
  DEPARTMENT_REPARENT: z.strictObject({ departmentId: z.uuid(), newParentId: z.uuid() }),
  DELEGATION_ON_BEHALF: z.strictObject({
    delegatorMemberId: z.uuid(),
    delegateMemberId: z.uuid(),
    startsAt: Instant,
    endsAt: Instant,
    documentTypes: z.array(z.enum(DOA_DOCUMENT_TYPES)).default([]),
    maxAmount: z
      .string()
      .regex(/^\d{1,13}(\.\d{1,2})?$/)
      .optional(),
  }),
  IDENTITY_RESET: z.strictObject({ memberId: z.uuid() }),
} as const

const Reason = z.string().trim().min(3).max(REASON_MAX_LENGTH)
/** BR-DOA-17: a change that leaves a position the DOA names without a holder is a warning acknowledged by its key */
const Acknowledged = z.array(z.string()).default([])

const ProposeInput = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('POSITION_ASSIGN'), payload: PayloadSchemas.POSITION_ASSIGN, effectiveFrom: Instant, reason: Reason, acknowledgedWarnings: Acknowledged }),
  z.strictObject({ kind: z.literal('POSITION_END'), payload: PayloadSchemas.POSITION_END, effectiveFrom: Instant, reason: Reason, acknowledgedWarnings: Acknowledged }),
  z.strictObject({ kind: z.literal('DEPARTMENT_REPARENT'), payload: PayloadSchemas.DEPARTMENT_REPARENT, effectiveFrom: Instant, reason: Reason, acknowledgedWarnings: Acknowledged }),
  z.strictObject({ kind: z.literal('DELEGATION_ON_BEHALF'), payload: PayloadSchemas.DELEGATION_ON_BEHALF, effectiveFrom: Instant, reason: Reason, acknowledgedWarnings: Acknowledged }),
  // IDENTITY_RESET applies as soon as it is approved; its effective time is the proposal time
  z.strictObject({ kind: z.literal('IDENTITY_RESET'), payload: PayloadSchemas.IDENTITY_RESET, effectiveFrom: Instant.optional(), reason: Reason, acknowledgedWarnings: Acknowledged }),
])
type Proposal = z.output<typeof ProposeInput>

/** The member who would gain from the change (BR-SOD-08): new holder, delegate, or the member whose identity is reset. */
function beneficiaryOf(p: Proposal): string | null {
  switch (p.kind) {
    case 'POSITION_ASSIGN':
      return p.payload.memberId
    case 'POSITION_END':
      return p.payload.replacementMemberId ?? null
    case 'DELEGATION_ON_BEHALF':
      return p.payload.delegateMemberId
    case 'IDENTITY_RESET':
      return p.payload.memberId
    case 'DEPARTMENT_REPARENT':
      return null
  }
}

/** Whether a rule of the version names the position as approver */
const namesPosition = (version: DoaVersionSnapshot, positionCode: string) =>
  version.rules.some((r) => r.steps.some((s) => s.approver.kind !== 'MEMBER' && s.approver.position === positionCode))

/** The organization as it would be after the change, at its effective time (for the governance check of AC3). */
function orgAfter(org: OrgSnapshot, p: Proposal, at: Date): OrgSnapshot {
  const ending = (positionCode: string, departmentId: string) => (h: OrgSnapshot['holders'][number]) =>
    h.positionCode === positionCode && h.departmentId === departmentId && (h.validTo === null || h.validTo > at) ? { ...h, validTo: at } : h
  switch (p.kind) {
    case 'POSITION_ASSIGN': {
      const holders = org.holders.map(ending(p.payload.positionCode, p.payload.departmentId))
      return { ...org, holders: [...holders, { positionCode: p.payload.positionCode, departmentId: p.payload.departmentId, memberId: p.payload.memberId, validFrom: at, validTo: null }] }
    }
    case 'POSITION_END': {
      const holders = org.holders.map(ending(p.payload.positionCode, p.payload.departmentId))
      const replacement = p.payload.replacementMemberId
      return replacement
        ? { ...org, holders: [...holders, { positionCode: p.payload.positionCode, departmentId: p.payload.departmentId, memberId: replacement, validFrom: at, validTo: null }] }
        : { ...org, holders }
    }
    case 'DEPARTMENT_REPARENT':
      return { ...org, departments: org.departments.map((d) => (d.id === p.payload.departmentId ? { ...d, parentId: p.payload.newParentId } : d)) }
    case 'DELEGATION_ON_BEHALF':
    case 'IDENTITY_RESET':
      return org
  }
}

// ---------- propose and submit (FR-DOA-010 AC1–AC3) ----------

export const proposeOrgChangeCommand = defineCommand({
  name: 'org_authority.propose',
  capability: 'admin.orgAuthority.propose',
  input: ProposeInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ changeId: string; routeId: string; assigneeMemberId: string }>> {
    const allowed = await authorize(tx, ctx, 'admin.orgAuthority.propose')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    const proposer = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
    if (!proposer) return { ok: false, error: { code: 'FORBIDDEN', message: 'only a member proposes' } }
    const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : ctx.now
    if (effectiveFrom.getTime() < ctx.now.getTime()) return fail('VALIDATION_FAILED', 'the effective time is in the past', { field: 'effectiveFrom', reason: 'EFFECTIVE_IN_PAST' })

    // BR-SOD-08: never the proposer's own gain
    const beneficiary = beneficiaryOf(input)
    const sod = checkSod({ kind: 'PROPOSE_ORG_AUTHORITY_CHANGE', changeKind: input.kind as OrgAuthorityChangeKind, actorMemberId: proposer, beneficiaryMemberId: beneficiary }, { approverMayReceive: false, requesterMayReceive: true })
    if (!sod.ok) {
      return {
        ok: false,
        error: { code: 'SOD_VIOLATION', message: 'separation of duties', details: { rule: sod.rule } },
        auditEvents: [{ type: 'security.sod_blocked', aggregateType: 'Security', aggregateId: proposer, data: { rule: sod.rule, action: 'org_authority.propose', subjectType: 'ORG_AUTHORITY_CHANGE', subjectId: proposer, actorMemberId: proposer } }],
      }
    }

    // The things the payload names exist in this organization
    const org = await loadOrgSnapshot(tx)
    const known = (memberId: string | undefined) => memberId === undefined || org.members.some((m) => m.id === memberId && m.active)
    const department = (id: string) => org.departments.some((d) => d.id === id)
    const p = input.payload as Record<string, string | undefined>
    if (!known(p.memberId) || !known(p.replacementMemberId) || !known(p.delegatorMemberId) || !known(p.delegateMemberId)) return fail('VALIDATION_FAILED', 'unknown or inactive member', { field: 'payload', reason: 'MEMBER' })
    if ((p.departmentId && !department(p.departmentId)) || (p.newParentId && !department(p.newParentId))) return fail('VALIDATION_FAILED', 'unknown department', { field: 'payload', reason: 'DEPARTMENT' })
    if (input.kind === 'POSITION_ASSIGN' || input.kind === 'POSITION_END') {
      if (!(await tx.position.findFirst({ where: { code: input.payload.positionCode }, select: { id: true } }))) return fail('VALIDATION_FAILED', 'unknown position', { field: 'payload.positionCode', reason: 'POSITION' })
    }
    if (input.kind === 'DEPARTMENT_REPARENT') {
      const { departmentId, newParentId } = input.payload
      const parentOf = (id: string) => org.departments.find((d) => d.id === id)?.parentId ?? null
      if (parentOf(departmentId) === newParentId) return fail('VALIDATION_FAILED', 'the department is under this parent already', { field: 'payload.newParentId', reason: 'NO_CHANGE' })
      // FR-ADM-002 AC1: the new parent is neither the department nor one of the departments under it
      for (let at: string | null = newParentId; at; at = parentOf(at)) {
        if (at === departmentId) return fail('VALIDATION_FAILED', 'the move would make a cycle', { field: 'payload.newParentId', reason: 'CYCLE' })
      }
      // One move waits at a time: two moves approved for later could close a cycle between them when both apply
      await lockRowsForUpdate(tx, 'Organization', ctx.organizationId, [ctx.organizationId])
      const waiting = await tx.orgAuthorityChange.count({ where: { kind: 'DEPARTMENT_REPARENT', status: { in: ['PENDING_APPROVAL', 'SCHEDULED'] } } })
      if (waiting > 0) return fail('VALIDATION_FAILED', 'another department move is waiting', { reason: 'REPARENT_WAITING' })
    }
    if (input.kind === 'DELEGATION_ON_BEHALF') {
      const d = input.payload
      const refusal = validateNewDelegation(
        { delegatorMemberId: d.delegatorMemberId, delegateMemberId: d.delegateMemberId, startsAt: new Date(d.startsAt), endsAt: new Date(d.endsAt), documentTypes: d.documentTypes.length ? d.documentTypes : null, maxAmountSatang: d.maxAmount ? amountToSatang(d.maxAmount) : null },
        await loadDelegations(tx),
        org,
      )
      if (refusal) return fail('VALIDATION_FAILED', `delegation refused: ${refusal}`, { field: 'payload', reason: refusal })
    }

    // AC3: whoever approves DOA_CHANGE and ORG_AUTHORITY_CHANGE must still be found after the change
    const policy = await loadRoutePolicy(tx)
    const version = versionAt(policy.versions, effectiveFrom)
    if (version) {
      const lintBefore = lintDoaVersion(version, org, effectiveFrom)
      const lintAfter = lintDoaVersion(version, orgAfter(org, input, effectiveFrom), effectiveFrom)
      const before = new Set(lintBefore.errors.map((e) => e.rule))
      const broken = lintAfter.errors.filter((e) => e.code === 'DOA_LINT_UNRESOLVABLE_GOVERNANCE' && !before.has(e.rule))
      if (broken.length) return fail('VALIDATION_FAILED', 'nobody could approve policy changes after this change', { reason: 'GOVERNANCE_UNRESOLVABLE', rules: broken.map((e) => e.rule) })
      // BR-DOA-17: a position the DOA names left without a holder is a warning the proposer acknowledges one by one —
      // the slot itself (POSITION_VACANT:<position>@<department>), and any rule left with nobody at all (lint)
      const known = new Set(lintBefore.warnings.map(warningKey))
      const vacated = lintAfter.warnings.filter((w) => w.code === 'DOA_LINT_VACANT_POSITION' && !known.has(warningKey(w))).map(warningKey)
      if (input.kind === 'POSITION_END' && !input.payload.replacementMemberId && namesPosition(version, input.payload.positionCode)) {
        const department = org.departments.find((d) => d.id === input.payload.departmentId)!
        vacated.unshift(`POSITION_VACANT:${input.payload.positionCode}@${department.code}`)
      }
      const unacknowledged = vacated.filter((k) => !input.acknowledgedWarnings.includes(k))
      if (unacknowledged.length) return fail('VALIDATION_FAILED', 'every warning must be acknowledged', { reason: 'WARNINGS_NOT_ACKNOWLEDGED', warnings: unacknowledged })
    }

    // AC1: the impact shown before submitting — open tasks that follow the change
    const impact = await impactOf(tx, org, input)
    const id = newId()
    const root = org.departments.find((d) => d.parentId === null)
    const proposerMember = await tx.member.findUniqueOrThrow({ where: { id: proposer }, select: { primaryDepartmentId: true } })
    const route = await startRoute(
      tx,
      ctx,
      { type: 'ORG_AUTHORITY_CHANGE', id, label: input.kind },
      { documentType: 'ORG_AUTHORITY_CHANGE', requesterMemberId: proposer, chargedDepartmentId: proposerMember.primaryDepartmentId ?? root!.id, conflictMemberIds: [proposer, ...(beneficiary ? [beneficiary] : [])], at: ctx.now },
    )
    if (!route.ok) return { ok: false, error: route.error }
    await tx.orgAuthorityChange.create({
      data: {
        id,
        organizationId: ctx.organizationId,
        kind: input.kind,
        payload: input.payload as object,
        reason: input.reason,
        effectiveFrom,
        submittedById: proposer,
        routeId: route.data.routeId,
        status: 'PENDING_APPROVAL',
        impactSummary: impact,
        submittedAt: ctx.now,
      },
    })
    return {
      ok: true,
      result: { changeId: id, routeId: route.data.routeId, assigneeMemberId: route.data.firstTask.assigneeMemberId },
      events: [
        { type: 'org_authority_change.submitted', aggregateType: 'OrgAuthorityChange', aggregateId: id, data: { kind: input.kind, effectiveFrom: effectiveFrom.toISOString(), routeId: route.data.routeId } },
        ...route.data.events,
      ],
      notifications: route.data.notifications,
    }
  },
})

export function proposeOrgChange(ctx: Ctx, input: z.input<typeof ProposeInput>, options: RunOptions) {
  return runCommand(ctx, proposeOrgChangeCommand, input, options)
}

/** Who holds the position now and how many of their open tasks came from it (they move with the change). */
async function impactOf(tx: TenantTx, org: OrgSnapshot, p: Proposal): Promise<{ gains: string[]; loses: string[]; openTasks: number }> {
  if (p.kind !== 'POSITION_ASSIGN' && p.kind !== 'POSITION_END') return { gains: p.kind === 'DELEGATION_ON_BEHALF' ? [p.payload.delegateMemberId] : [], loses: [], openTasks: 0 }
  const current = org.holders.filter((h) => h.positionCode === p.payload.positionCode && h.departmentId === p.payload.departmentId && h.validTo === null).map((h) => h.memberId)
  const departmentCode = org.departments.find((d) => d.id === p.payload.departmentId)?.code ?? ''
  const openTasks = await tx.approvalTask.count({ where: { assigneeMemberId: { in: current }, status: { in: ['OPEN', 'INFO_REQUESTED'] }, resolvedFrom: `POSITION:${p.payload.positionCode}@${departmentCode}` } })
  const newcomer = p.kind === 'POSITION_ASSIGN' ? p.payload.memberId : (p.payload.replacementMemberId ?? null)
  return { gains: newcomer ? [newcomer] : [], loses: current, openTasks }
}

// ---------- approve, reject and apply (called by the approval decision, and by the job at the effective time) ----------

function moveChange(from: string, command: OrgChangeCommand) {
  const t = transition(ORG_CHANGE_MACHINE, from as OrgChangeState, command)
  if (!t.ok) throw new Error(`${command} is not allowed from ${from}`)
  return t.to
}

/** The last approval of a change: IDENTITY_RESET and changes already due are applied at once, the rest wait. */
export async function approveOrgChange(tx: TenantTx, ctx: Ctx, changeId: string): Promise<{ events: EventDraft[]; notifications: NotificationDraft[] }> {
  const change = await tx.orgAuthorityChange.findUniqueOrThrow({ where: { id: changeId } })
  const immediate = change.kind === 'IDENTITY_RESET'
  const to = moveChange(change.status, immediate ? 'org_change.approve_immediate' : 'org_change.approve')
  await tx.orgAuthorityChange.update({ where: { id: change.id }, data: { status: to, approvedAt: ctx.now, version: { increment: 1 } } })
  // The job org-authority-apply waits on this event until the effective time (spec §4.6)
  const events: EventDraft[] = [
    { type: 'org_authority_change.approved', aggregateType: 'OrgAuthorityChange', aggregateId: change.id, data: { kind: change.kind, status: to, effectiveFrom: change.effectiveFrom.toISOString() } },
  ]
  if (immediate || change.effectiveFrom.getTime() <= ctx.now.getTime()) {
    const applied = await applyChange(tx, ctx, change.id, immediate)
    return { events: [...events, ...applied.events], notifications: applied.notifications }
  }
  return { events, notifications: [] }
}

export async function rejectOrgChange(tx: TenantTx, ctx: Ctx, changeId: string): Promise<EventDraft[]> {
  const change = await tx.orgAuthorityChange.findUniqueOrThrow({ where: { id: changeId } })
  const to = moveChange(change.status, 'org_change.reject')
  await tx.orgAuthorityChange.update({ where: { id: change.id }, data: { status: to, version: { increment: 1 } } })
  return [{ type: 'org_authority_change.rejected', aggregateType: 'OrgAuthorityChange', aggregateId: change.id, data: { kind: change.kind } }]
}

/**
 * Applies an approved change (AC4, BR-DOA-16/17). Open tasks a replaced holder got from the position move to the new
 * holder; the people who gain or lose authority and the organization admins are told.
 */
export async function applyChange(tx: TenantTx, ctx: Ctx, changeId: string, alreadyApplied = false): Promise<{ events: EventDraft[]; notifications: NotificationDraft[] }> {
  await lockRowsForUpdate(tx, 'OrgAuthorityChange', ctx.organizationId, [changeId])
  const change = await tx.orgAuthorityChange.findUniqueOrThrow({ where: { id: changeId } })
  if (!alreadyApplied) moveChange(change.status, 'org_change.apply')
  const at = change.effectiveFrom.getTime() > ctx.now.getTime() ? change.effectiveFrom : ctx.now
  const events: EventDraft[] = []
  const told = new Set<string>()
  const extra: NotificationDraft[] = []
  let vacant: { positionCode: string; departmentId: string; openTasks: number } | null = null
  const payload = change.payload as Record<string, unknown>

  const assign = async (positionCode: string, departmentId: string, memberId: string) => {
    const position = await tx.position.findFirstOrThrow({ where: { code: positionCode }, select: { id: true } })
    const row = await tx.positionAssignment.create({ data: { organizationId: ctx.organizationId, positionId: position.id, departmentId, memberId, validFrom: at }, select: { id: true } })
    events.push({ type: 'position.assigned', aggregateType: 'PositionAssignment', aggregateId: row.id, data: { positionCode, departmentId, memberId, validFrom: at.toISOString(), via: 'ORG_AUTHORITY_CHANGE' } })
    told.add(memberId)
  }
  const end = async (positionCode: string, departmentId: string): Promise<string[]> => {
    const current = await tx.positionAssignment.findMany({ where: { departmentId, validTo: null, position: { code: positionCode } }, select: { id: true, memberId: true } })
    for (const h of current) {
      await tx.positionAssignment.update({ where: { id: h.id }, data: { validTo: at } })
      events.push({ type: 'position.unassigned', aggregateType: 'PositionAssignment', aggregateId: h.id, data: { positionCode, departmentId, memberId: h.memberId, validTo: at.toISOString() } })
      told.add(h.memberId)
    }
    return current.map((h) => h.memberId)
  }
  const moveTasks = async (fromMembers: string[], positionCode: string, departmentId: string, toMember: string) => {
    const department = await tx.department.findUniqueOrThrow({ where: { id: departmentId }, select: { code: true } })
    const open = await tx.approvalTask.findMany({ where: { assigneeMemberId: { in: fromMembers }, status: 'OPEN', resolvedFrom: `POSITION:${positionCode}@${department.code}` } })
    for (const task of open) {
      await tx.approvalTask.update({ where: { id: task.id }, data: { status: 'REASSIGNED' } })
      const moved = await tx.approvalTask.create({
        data: { organizationId: ctx.organizationId, stepId: task.stepId, assigneeMemberId: toMember, resolvedFrom: task.resolvedFrom, assignedAt: at, dueAt: task.dueAt, remindAt: task.remindAt, reassignedFromTaskId: task.id },
        select: { id: true },
      })
      events.push({ type: 'approval_task.reassigned', aggregateType: 'ApprovalTask', aggregateId: moved.id, data: { fromTaskId: task.id, fromMemberId: task.assigneeMemberId, toMemberId: toMember, why: 'ORG_AUTHORITY_CHANGE', changeId: change.id } })
    }
  }

  switch (change.kind) {
    case 'POSITION_ASSIGN': {
      const p = payload as { positionCode: string; departmentId: string; memberId: string }
      const previous = await end(p.positionCode, p.departmentId)
      await assign(p.positionCode, p.departmentId, p.memberId)
      await moveTasks(previous, p.positionCode, p.departmentId, p.memberId)
      break
    }
    case 'POSITION_END': {
      const p = payload as { positionCode: string; departmentId: string; replacementMemberId?: string }
      const previous = await end(p.positionCode, p.departmentId)
      if (p.replacementMemberId) {
        await assign(p.positionCode, p.departmentId, p.replacementMemberId)
        await moveTasks(previous, p.positionCode, p.departmentId, p.replacementMemberId)
      } else {
        // FR-ADM-002 AC3: the position is vacant; the admins are told how many open tasks stay with the former holder
        const department = await tx.department.findUniqueOrThrow({ where: { id: p.departmentId }, select: { code: true } })
        vacant = {
          positionCode: p.positionCode,
          departmentId: p.departmentId,
          openTasks: await tx.approvalTask.count({ where: { assigneeMemberId: { in: previous }, status: { in: ['OPEN', 'INFO_REQUESTED'] }, resolvedFrom: `POSITION:${p.positionCode}@${department.code}` } }),
        }
      }
      break
    }
    case 'DEPARTMENT_REPARENT': {
      const p = payload as { departmentId: string; newParentId: string }
      const department = await tx.department.update({ where: { id: p.departmentId }, data: { parentId: p.newParentId }, select: { code: true } })
      events.push({ type: 'department.updated', aggregateType: 'Department', aggregateId: p.departmentId, data: { code: department.code, changed: ['parentId'] } })
      break
    }
    case 'DELEGATION_ON_BEHALF': {
      const p = payload as { delegatorMemberId: string; delegateMemberId: string; startsAt: string; endsAt: string; documentTypes: string[]; maxAmount?: string }
      const id = newId()
      const startsAt = new Date(p.startsAt)
      const status = startsAt.getTime() <= ctx.now.getTime() ? 'ACTIVE' : 'SCHEDULED'
      await tx.delegation.create({
        data: {
          id,
          organizationId: ctx.organizationId,
          delegatorMemberId: p.delegatorMemberId,
          delegateMemberId: p.delegateMemberId,
          startsAt,
          endsAt: new Date(p.endsAt),
          documentTypes: p.documentTypes as never,
          maxAmountSatang: p.maxAmount ? amountToSatang(p.maxAmount) : null,
          reason: change.reason,
          status,
          createdVia: 'ORG_AUTHORITY_CHANGE',
          orgAuthorityChangeId: change.id,
        },
      })
      events.push({
        type: 'delegation.created',
        aggregateType: 'Delegation',
        aggregateId: id,
        data: { delegatorMemberId: p.delegatorMemberId, delegateMemberId: p.delegateMemberId, startsAt: startsAt.toISOString(), endsAt: new Date(p.endsAt).toISOString(), status, createdVia: 'ORG_AUTHORITY_CHANGE' },
      })
      told.add(p.delegatorMemberId).add(p.delegateMemberId)
      break
    }
    case 'IDENTITY_RESET': {
      const p = payload as { memberId: string }
      // BR-AUTH-07: the authenticator and every session of this member's sign-in identity are removed; the account owner
      // is told by e-mail at once, as for any 2FA reset (§10.1 security.notice)
      await removeMemberTwoFactor(tx, ctx.organizationId, p.memberId)
      const sessionsRevoked = await deleteMemberSessions(tx, ctx.organizationId, p.memberId)
      events.push({ type: 'auth.2fa_reset', aggregateType: 'Auth', aggregateId: p.memberId, data: { orgAuthorityChangeId: change.id, sessionsRevoked } })
      extra.push({
        recipientMemberId: p.memberId,
        templateKey: 'security.notice',
        data: { kind: 'TWO_FACTOR_RESET' },
        urgency: 'IMMEDIATE',
        dedupeKey: `security.notice:2fa_reset:${p.memberId}:${change.id}`,
        subjectType: 'Member',
        subjectId: p.memberId,
      })
      told.add(p.memberId)
      break
    }
  }

  if (!alreadyApplied) await tx.orgAuthorityChange.update({ where: { id: change.id }, data: { status: 'APPLIED', appliedAt: ctx.now, version: { increment: 1 } } })
  else await tx.orgAuthorityChange.update({ where: { id: change.id }, data: { appliedAt: ctx.now } })
  events.push({ type: 'org_authority_change.applied', aggregateType: 'OrgAuthorityChange', aggregateId: change.id, data: { kind: change.kind } })
  const admins = await tx.roleAssignment.findMany({ where: { role: 'ORG_ADMIN', revokedAt: null, member: { status: 'ACTIVE' } }, select: { memberId: true } })
  for (const a of admins) told.add(a.memberId)
  const notifications: NotificationDraft[] = [...told].map((memberId) => ({
    recipientMemberId: memberId,
    templateKey: 'org_authority_change.applied',
    data: { changeId: change.id, kind: change.kind },
    urgency: 'IMMEDIATE',
    dedupeKey: `org_authority_change.applied:${change.id}:${memberId}`,
    subjectType: 'ORG_AUTHORITY_CHANGE',
    subjectId: change.id,
  }))
  if (vacant) {
    const position = vacant
    for (const memberId of new Set(admins.map((a) => a.memberId))) {
      notifications.push({
        recipientMemberId: memberId,
        templateKey: 'position.vacant',
        data: { changeId: change.id, ...position },
        urgency: 'IMMEDIATE',
        dedupeKey: `position.vacant:${change.id}:${memberId}`,
        subjectType: 'ORG_AUTHORITY_CHANGE',
        subjectId: change.id,
      })
    }
  }
  return { events, notifications: [...notifications, ...extra] }
}

// ---------- the job at the effective time (org-authority-apply) ----------

const ApplyInput = z.strictObject({ changeId: z.uuid() })

/** Applies one scheduled change whose time has come; the job runs it for every due change (system actor). */
export const applyDueChangeCommand = defineCommand({
  name: 'org_authority.apply',
  capability: 'admin.orgAuthority.propose',
  input: ApplyInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ changeId: string; applied: boolean }>> {
    if (ctx.actor.type !== 'SYSTEM') return { ok: false, error: { code: 'FORBIDDEN', message: 'only the scheduled job applies changes' } }
    const change = await tx.orgAuthorityChange.findFirst({ where: { id: input.changeId }, select: { status: true, effectiveFrom: true } })
    if (!change) return fail('NOT_FOUND', 'change not found')
    if (change.status !== 'SCHEDULED') return fail('INVALID_STATE_TRANSITION', `org_change.apply is not allowed from ${change.status}`, { from: change.status })
    if (change.effectiveFrom.getTime() > ctx.now.getTime()) return fail('VALIDATION_FAILED', 'not due yet', { reason: 'NOT_DUE' })
    const applied = await applyChange(tx, ctx, input.changeId)
    return { ok: true, result: { changeId: input.changeId, applied: true }, events: applied.events, notifications: applied.notifications }
  },
})

export function applyDueChange(ctx: Ctx, input: z.input<typeof ApplyInput>, options: RunOptions) {
  return runCommand(ctx, applyDueChangeCommand, input, options)
}

/** What the job org-authority-apply runs at the effective time; the change id is the idempotency key, so a retry is a replay. */
export function applyScheduledChange(organizationId: string, changeId: string, now: Date) {
  return applyDueChange(systemCtx(organizationId, now, 'org-authority-apply'), { changeId }, { idempotencyKey: `org-authority-apply:${changeId}` })
}
