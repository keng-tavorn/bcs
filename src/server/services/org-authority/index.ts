import { z } from 'zod'
import { validateNewDelegation } from '@/core/delegation'
import { DOA_DOCUMENT_TYPES, lintDoaVersion, resolveRoute, stepApprovers, versionAt, type DoaVersionSnapshot, type OrgSnapshot } from '@/core/doa'
import { amountToSatang } from '@/core/money/dto'
import { err, ok, type Result } from '@/core/result'
import { checkSod, type OrgAuthorityChangeKind } from '@/core/sod'
import { ORG_CHANGE_MACHINE, TASK_MACHINE, transition, type OrgChangeCommand, type OrgChangeState, type TaskState } from '@/core/state-machines'
import { reresolveOpenTasks } from '@/core/workflow'
import { COMMAND_TX_MAX_WAIT_MS, COMMAND_TX_TIMEOUT_MS, REASON_MAX_LENGTH } from '@/lib/constants'
import { newId } from '@/lib/ids'
import { logger } from '@/lib/logger'
import { authorize } from '@/server/authz'
import { systemCtx, type Ctx } from '@/server/context'
import { deleteMemberSessions, removeMemberTwoFactor } from '@/server/db/sql/identity'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import { setTransactionTimeouts } from '@/server/db/sql/timeouts'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { loadDelegations, loadOrgSnapshot, loadRoutePolicy } from '@/server/doa/policy'
import { describeError } from '@/server/errors/describe'
import type { EventDraft } from '@/server/events/append'
import type { NotificationDraft } from '@/server/notifications/create'
import { defineCommand, isBusyTxError, runCommand, type CommandFailure, type CommandOutcome, type RunOptions } from '../_pipeline'
import { enabledModules } from '../modules'
import { startRoute } from '../approvals/route'
import { warningKey } from '../doa/lint-view'
import { openTasksOnTree } from './reparent'

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
  version.rules.some((r) => r.steps.some((s) => stepApprovers(s).some((a) => a.kind !== 'MEMBER' && a.position === positionCode)))

/**
 * BR-WF-14: a position the workflow version in effect or waiting names as reviewer or fallback counts as one the DOA
 * names (BR-DOA-17): left without a holder, it is a warning the proposer acknowledges
 */
async function workflowNamesPosition(tx: TenantTx, positionCode: string, at: Date): Promise<boolean> {
  const versions = await tx.workflowVersion.findMany({ where: { status: 'PUBLISHED', OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }] }, select: { rules: { select: { reviewers: true, fallback: true } } } })
  const named = (spec: unknown) => (spec as { kind?: unknown; position?: unknown } | null)?.kind === 'POSITION_AT' && (spec as { position?: unknown }).position === positionCode
  return versions.some((v) => v.rules.some((r) => (Array.isArray(r.reviewers) && r.reviewers.some(named)) || named(r.fallback)))
}

/**
 * The pending approval tasks of one position slot (BR-DOA-17): open, or waiting for the requester's answer, whoever
 * holds them now — the holder, a delegate acting for the holder, or a former holder who kept them when the slot became
 * vacant. When a new holder takes the slot they all follow.
 */
const slotTasks = (positionCode: string, departmentCode: string) => ({
  status: { in: ['OPEN', 'INFO_REQUESTED'] as Array<'OPEN' | 'INFO_REQUESTED'> },
  resolvedFrom: `POSITION:${positionCode}@${departmentCode}`,
})

type SodAction = 'org_authority.propose' | 'org_authority.preview'

/**
 * BR-SOD-08: the proposer never gains from their own proposal. The refusal carries its security.sod_blocked event, so
 * every refused attempt is recorded with the rule (FR-DOA-007 AC2) — when it is sent, and when it is previewed.
 */
function sodRefusal(input: Proposal, proposer: string, action: SodAction): CommandFailure | null {
  const sod = checkSod(
    { kind: 'PROPOSE_ORG_AUTHORITY_CHANGE', changeKind: input.kind as OrgAuthorityChangeKind, actorMemberId: proposer, beneficiaryMemberId: beneficiaryOf(input) },
    { approverMayReceive: false, requesterMayReceive: true },
  )
  if (sod.ok) return null
  return {
    ok: false,
    error: { code: 'SOD_VIOLATION', message: 'separation of duties', details: { rule: sod.rule } },
    auditEvents: [{ type: 'security.sod_blocked', aggregateType: 'Security', aggregateId: proposer, data: { rule: sod.rule, action, subjectType: 'ORG_AUTHORITY_CHANGE', subjectId: proposer, actorMemberId: proposer } }],
  }
}

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

/**
 * What a change does to authority (AC1), as stored in OrgAuthorityChange.impactSummary: who gains, who loses, the
 * pending tasks of the slot that move to the new holder, and those that stay where they are because the slot becomes
 * vacant (the organization admins are told when it applies, ADR-042 item 3).
 */
type Impact = { gains: string[]; loses: string[]; openTasks: number; openTasksStay: number }

interface Assessment {
  readonly effectiveFrom: Date
  readonly beneficiary: string | null
  readonly org: OrgSnapshot
  /** Warnings the proposer must acknowledge one by one, by key (BR-DOA-17) */
  readonly warnings: readonly string[]
  readonly impact: Impact
}

type Assessed = { readonly ok: true; readonly data: Assessment } | { readonly ok: false; readonly error: CommandFailure['error']; readonly auditEvents?: CommandFailure['auditEvents'] }

/**
 * Every rule a proposal must pass, and what it would do (AC1–AC3, BR-SOD-08, BR-DOA-17). The proposal runs it before it
 * writes anything; the preview a screen shows before sending runs the same and writes nothing — only a refusal by
 * separation of duties is recorded, as for a proposal (previewOrgChange).
 */
async function assess(tx: TenantTx, ctx: Ctx, input: Proposal, proposer: string, action: SodAction): Promise<Assessed> {
  const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : ctx.now
  if (effectiveFrom.getTime() < ctx.now.getTime()) return fail('VALIDATION_FAILED', 'the effective time is in the past', { field: 'effectiveFrom', reason: 'EFFECTIVE_IN_PAST' })

  // BR-SOD-08: never the proposer's own gain
  const beneficiary = beneficiaryOf(input)
  const refused = sodRefusal(input, proposer, action)
  if (refused) return refused

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
    // One move waits at a time: two moves approved for later could close a cycle between them when both apply (the
    // proposal holds the organization lock while it checks, so two proposals never both pass)
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
  const warnings: string[] = []
  if (version) {
    // The same modules on both sides (BR-DOA-23), so only the change of holders can make a difference
    const modules = await enabledModules(tx)
    const lintBefore = lintDoaVersion(version, org, effectiveFrom, { modules })
    const lintAfter = lintDoaVersion(version, orgAfter(org, input, effectiveFrom), effectiveFrom, { modules })
    const before = new Set(lintBefore.errors.map((e) => e.rule))
    const broken = lintAfter.errors.filter((e) => e.code === 'DOA_LINT_UNRESOLVABLE_GOVERNANCE' && !before.has(e.rule))
    if (broken.length) return fail('VALIDATION_FAILED', 'nobody could approve policy changes after this change', { reason: 'GOVERNANCE_UNRESOLVABLE', rules: broken.map((e) => e.rule) })
    // BR-DOA-17: a position the DOA names left without a holder is a warning the proposer acknowledges one by one —
    // the slot itself (POSITION_VACANT:<position>@<department>), and any rule left with nobody at all (lint)
    const known = new Set(lintBefore.warnings.map(warningKey))
    warnings.push(...lintAfter.warnings.filter((w) => w.code === 'DOA_LINT_VACANT_POSITION' && !known.has(warningKey(w))).map(warningKey))
    if (input.kind === 'POSITION_END' && !input.payload.replacementMemberId && (namesPosition(version, input.payload.positionCode) || (await workflowNamesPosition(tx, input.payload.positionCode, effectiveFrom)))) {
      const department = org.departments.find((d) => d.id === input.payload.departmentId)!
      warnings.unshift(`POSITION_VACANT:${input.payload.positionCode}@${department.code}`)
    }
  }

  // AC1: the impact shown before submitting — who gains or loses authority, open tasks that follow the change
  const impact = await impactOf(tx, org, input, effectiveFrom)
  return { ok: true, data: { effectiveFrom, beneficiary, org, warnings, impact } }
}

export const proposeOrgChangeCommand = defineCommand({
  name: 'org_authority.propose',
  capability: 'admin.orgAuthority.propose',
  input: ProposeInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ changeId: string; routeId: string; assigneeMemberId: string }>> {
    const allowed = await authorize(tx, ctx, 'admin.orgAuthority.propose')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    const proposer = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
    if (!proposer) return { ok: false, error: { code: 'FORBIDDEN', message: 'only a member proposes' } }
    // Department moves are serialized on the organization row: the check for a waiting move and the new row are atomic
    if (input.kind === 'DEPARTMENT_REPARENT') await lockRowsForUpdate(tx, 'Organization', ctx.organizationId, [ctx.organizationId])
    const assessed = await assess(tx, ctx, input, proposer, 'org_authority.propose')
    if (!assessed.ok) return assessed
    const { effectiveFrom, beneficiary, org, warnings, impact } = assessed.data
    const unacknowledged = warnings.filter((k) => !input.acknowledgedWarnings.includes(k))
    if (unacknowledged.length) return fail('VALIDATION_FAILED', 'every warning must be acknowledged', { reason: 'WARNINGS_NOT_ACKNOWLEDGED', warnings: unacknowledged })

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

// ---------- the preview before sending (FR-DOA-010 AC1) ----------

export interface PreviewPerson {
  readonly id: string
  readonly nameTh: string
  readonly nameEn: string | null
}

export interface OrgChangePreview {
  readonly effectiveFrom: string
  /** Keys the proposer must acknowledge one by one before sending (POSITION_VACANT:…, DOA_LINT_VACANT_POSITION:…) */
  readonly warnings: readonly string[]
  readonly gains: readonly PreviewPerson[]
  readonly loses: readonly PreviewPerson[]
  /** Pending approval tasks of the slot that move to the new holder when the change applies */
  readonly openTasks: number
  /** Pending approval tasks that stay with whoever holds them now, because the slot becomes vacant (ADR-042 item 3) */
  readonly openTasksStay: number
  /** Who will decide: the approver of the ORG_AUTHORITY_CHANGE rule in effect now (GC-DOA-27) */
  readonly route: {
    readonly doaCode: string
    readonly versionNo: number
    readonly ruleCode: string
    readonly approvers: ReadonlyArray<PreviewPerson & { readonly onBehalfOf: PreviewPerson | null }>
  }
}

/**
 * FR-DOA-007 AC2: a preview refused by separation of duties is recorded like a refused proposal. The rule is checked
 * again here; the command never changes anything and never succeeds — it leaves the security.sod_blocked event, once
 * per idempotency key (a resend of the same attempt replays it).
 */
export const recordPreviewSodBlockCommand = defineCommand({
  name: 'org_authority.preview_sod_blocked',
  capability: 'admin.orgAuthority.propose',
  input: ProposeInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<never>> {
    const allowed = await authorize(tx, ctx, 'admin.orgAuthority.propose')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    const proposer = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
    if (!proposer) return { ok: false, error: { code: 'FORBIDDEN', message: 'only a member proposes' } }
    return sodRefusal(input, proposer, 'org_authority.preview') ?? fail('VALIDATION_FAILED', 'no separation-of-duties refusal to record', { reason: 'NO_SOD_VIOLATION' })
  },
})

const SOD_BLOCKED = Symbol('SOD_BLOCKED')

/**
 * What a proposal would do, before it is sent (AC1): the same checks as the proposal itself (SoD, the things it names,
 * the governance rules, the vacancies to acknowledge) and the route it would take. It writes nothing, except that a
 * refusal by separation of duties is recorded through recordPreviewSodBlockCommand with the form's idempotency key.
 * Needs admin.orgAuthority.propose like the proposal. An unexpected failure is answered INTERNAL with the requestId
 * only, and a busy database RATE_LIMITED, as runCommand answers them (§14.2).
 */
export async function previewOrgChange(ctx: Ctx, rawInput: z.input<typeof ProposeInput>, options: RunOptions): Promise<Result<OrgChangePreview>> {
  const parsed = ProposeInput.safeParse(rawInput)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return err('VALIDATION_FAILED', 'invalid input', { field: first?.path.length ? first.path.join('.') : '(input)' })
  }
  const input = parsed.data
  let outcome: Result<OrgChangePreview> | typeof SOD_BLOCKED
  try {
    outcome = await forTenant(ctx.organizationId).$transaction(
      async (tx): Promise<Result<OrgChangePreview> | typeof SOD_BLOCKED> => {
        await setTransactionTimeouts(tx)
        const allowed = await authorize(tx, ctx, 'admin.orgAuthority.propose')
        if (!allowed.ok) return allowed
        const proposer = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
        if (!proposer) return err('FORBIDDEN', 'only a member proposes')
        const assessed = await assess(tx, ctx, input, proposer, 'org_authority.preview')
        if (!assessed.ok) return assessed.auditEvents?.length ? SOD_BLOCKED : { ok: false, error: assessed.error }
        const { effectiveFrom, beneficiary, org, warnings, impact } = assessed.data
        const proposerMember = await tx.member.findUniqueOrThrow({ where: { id: proposer }, select: { primaryDepartmentId: true } })
        const root = org.departments.find((d) => d.parentId === null)
        const route = resolveRoute(
          { documentType: 'ORG_AUTHORITY_CHANGE', requesterMemberId: proposer, chargedDepartmentId: proposerMember.primaryDepartmentId ?? root?.id ?? '', conflictMemberIds: [proposer, ...(beneficiary ? [beneficiary] : [])], at: ctx.now },
          await loadRoutePolicy(tx),
        )
        if (!route.ok) return route
        const ids = [...impact.gains, ...impact.loses, ...route.data.steps.flatMap((s) => [s.assigneeMemberId, ...(s.principalMemberId ? [s.principalMemberId] : [])])]
        const members = await tx.member.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, displayNameTh: true, displayNameEn: true } })
        const person = (id: string): PreviewPerson => {
          const m = members.find((x) => x.id === id)
          return { id, nameTh: m?.displayNameTh ?? id, nameEn: m?.displayNameEn ?? null }
        }
        return ok({
          effectiveFrom: effectiveFrom.toISOString(),
          warnings,
          gains: impact.gains.map(person),
          loses: impact.loses.map(person),
          openTasks: impact.openTasks,
          openTasksStay: impact.openTasksStay,
          route: {
            doaCode: route.data.doaCode,
            versionNo: route.data.versionNo,
            ruleCode: route.data.ruleCode,
            approvers: route.data.steps.map((s) => ({ ...person(s.assigneeMemberId), onBehalfOf: s.principalMemberId ? person(s.principalMemberId) : null })),
          },
        })
      },
      { isolationLevel: 'ReadCommitted', maxWait: COMMAND_TX_MAX_WAIT_MS, timeout: COMMAND_TX_TIMEOUT_MS },
    )
  } catch (error) {
    if (isBusyTxError(error)) return err('RATE_LIMITED', 'busy: try again shortly', { requestId: ctx.requestId })
    // The caller gets a reference only; the log gets codes and stack frames, never the error text (FR-PLT-008 AC3)
    logger.child({ requestId: ctx.requestId, correlationId: ctx.correlationId, organizationId: ctx.organizationId, command: 'org_authority.preview' }).error({ error: describeError(error) }, 'preview failed unexpectedly')
    return err('INTERNAL', 'unexpected error', { requestId: ctx.requestId })
  }
  if (outcome !== SOD_BLOCKED) return outcome
  // The refusal is recorded once per attempt, and answered as the proposal would answer it
  const recorded = await runCommand(ctx, recordPreviewSodBlockCommand, input, options)
  return recorded.ok ? err('INTERNAL', 'the separation-of-duties refusal was not recorded', { requestId: ctx.requestId }) : { ok: false, error: recorded.error }
}

/**
 * Who holds the slot now, and its pending tasks (BR-DOA-17): they move to the new holder when the change applies, or
 * stay where they are when the slot becomes vacant. Tasks the newcomer holds already, in their own name, stay with them.
 */
async function impactOf(tx: TenantTx, org: OrgSnapshot, p: Proposal, at: Date): Promise<Impact> {
  // S6-08 (BR-WF-14): a department move moves the open tasks that land on someone else once it applies (approval and
  // review); those whose new holder is missing or conflicts stay where they are
  if (p.kind === 'DEPARTMENT_REPARENT') {
    const found = reresolveOpenTasks(await openTasksOnTree(tx), orgAfter(org, p, at), at)
    return { gains: [...new Set(found.reassign.map((r) => r.to))], loses: [], openTasks: found.reassign.length, openTasksStay: found.stuck.length }
  }
  if (p.kind !== 'POSITION_ASSIGN' && p.kind !== 'POSITION_END') return { gains: p.kind === 'DELEGATION_ON_BEHALF' ? [p.payload.delegateMemberId] : [], loses: [], openTasks: 0, openTasksStay: 0 }
  const current = org.holders.filter((h) => h.positionCode === p.payload.positionCode && h.departmentId === p.payload.departmentId && h.validTo === null).map((h) => h.memberId)
  const departmentCode = org.departments.find((d) => d.id === p.payload.departmentId)?.code ?? ''
  const newcomer = p.kind === 'POSITION_ASSIGN' ? p.payload.memberId : (p.payload.replacementMemberId ?? null)
  const pending = await tx.approvalTask.count({
    where: { ...slotTasks(p.payload.positionCode, departmentCode), ...(newcomer ? { NOT: { assigneeMemberId: newcomer, principalMemberId: null } } : {}) },
  })
  return { gains: newcomer ? [newcomer] : [], loses: current, openTasks: newcomer ? pending : 0, openTasksStay: newcomer ? 0 : pending }
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
  let reparentStuck = 0
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
  /**
   * BR-DOA-17 / FR-ADM-002 AC3: every pending task of the slot follows the new holder, with the same DOA reference —
   * open ones, and ones waiting for the requester's answer, which keep waiting (with the business time they had left)
   * and whose open question now reopens the new holder's task. The tasks are locked first (INV-PLT-03): a decision
   * running at this moment either finishes before (the task is no longer pending and stays as decided) or waits and
   * finds it reassigned. The former holder can decide none of them any more.
   */
  const moveTasks = async (positionCode: string, departmentId: string, toMember: string) => {
    const department = await tx.department.findUniqueOrThrow({ where: { id: departmentId }, select: { code: true } })
    const candidates = await tx.approvalTask.findMany({ where: slotTasks(positionCode, department.code), select: { id: true } })
    const locked = await lockRowsForUpdate(tx, 'ApprovalTask', ctx.organizationId, candidates.map((c) => c.id))
    const pending = await tx.approvalTask.findMany({ where: { id: { in: locked }, ...slotTasks(positionCode, department.code) }, orderBy: { id: 'asc' } })
    for (const task of pending) {
      if (task.assigneeMemberId === toMember && task.principalMemberId === null) continue
      await moveOne(task, toMember, task.resolvedFrom)
    }
  }
  /**
   * One pending task to another member, in the same slot and with the same DOA reference: it keeps its due times and its
   * open question; the resolvedFrom is the one the move found (a department move may find the position higher up)
   */
  async function moveOne(task: Awaited<ReturnType<typeof tx.approvalTask.findUniqueOrThrow>>, toMember: string, resolvedFrom: string) {
    const reassigned = transition(TASK_MACHINE, task.status as TaskState, 'task.reassign')
    if (!reassigned.ok) return
    await tx.approvalTask.update({ where: { id: task.id }, data: { status: reassigned.to, version: { increment: 1 } } })
    const moved = await tx.approvalTask.create({
      data: {
        organizationId: ctx.organizationId,
        stepId: task.stepId,
        // The moved task fills the same slot (BR-WF-01)
        slotNo: task.slotNo,
        workflowRuleCodes: task.workflowRuleCodes,
        assigneeMemberId: toMember,
        resolvedFrom,
        status: task.status,
        assignedAt: at,
        dueAt: task.dueAt,
        remindAt: task.remindAt,
        escalateAt: task.escalateAt,
        remainingBusinessMinutes: task.remainingBusinessMinutes,
        reassignedFromTaskId: task.id,
      },
      select: { id: true },
    })
    if (task.status === 'INFO_REQUESTED') await tx.infoRequest.updateMany({ where: { taskId: task.id, answeredAt: null }, data: { taskId: moved.id } })
    events.push({ type: 'approval_task.reassigned', aggregateType: 'ApprovalTask', aggregateId: moved.id, data: { fromTaskId: task.id, fromMemberId: task.assigneeMemberId, toMemberId: toMember, why: 'ORG_AUTHORITY_CHANGE', changeId: change.id } })
  }

  switch (change.kind) {
    case 'POSITION_ASSIGN': {
      const p = payload as { positionCode: string; departmentId: string; memberId: string }
      await end(p.positionCode, p.departmentId)
      await assign(p.positionCode, p.departmentId, p.memberId)
      await moveTasks(p.positionCode, p.departmentId, p.memberId)
      break
    }
    case 'POSITION_END': {
      const p = payload as { positionCode: string; departmentId: string; replacementMemberId?: string }
      await end(p.positionCode, p.departmentId)
      if (p.replacementMemberId) {
        await assign(p.positionCode, p.departmentId, p.replacementMemberId)
        await moveTasks(p.positionCode, p.departmentId, p.replacementMemberId)
      } else {
        // FR-ADM-002 AC3: the position is vacant; the admins are told how many pending tasks stay where they are
        const department = await tx.department.findUniqueOrThrow({ where: { id: p.departmentId }, select: { code: true } })
        vacant = { positionCode: p.positionCode, departmentId: p.departmentId, openTasks: await tx.approvalTask.count({ where: slotTasks(p.positionCode, department.code) }) }
      }
      break
    }
    case 'DEPARTMENT_REPARENT': {
      const p = payload as { departmentId: string; newParentId: string }
      const department = await tx.department.update({ where: { id: p.departmentId }, data: { parentId: p.newParentId }, select: { code: true } })
      events.push({ type: 'department.updated', aggregateType: 'Department', aggregateId: p.departmentId, data: { code: department.code, changed: ['parentId'] } })
      // S6-08 (BR-WF-14): the open tasks found from the department tree are found again; those that now land on someone
      // else move there with the same DOA reference, and both are told; one whose new holder is missing or conflicts with
      // its document stays where it is, for ORG_ADMIN to reassign (BR-DOA-17)
      const onTree = await openTasksOnTree(tx)
      const found = reresolveOpenTasks(onTree, await loadOrgSnapshot(tx), at)
      const locked = new Set(await lockRowsForUpdate(tx, 'ApprovalTask', ctx.organizationId, found.reassign.map((r) => r.task)))
      for (const r of found.reassign) {
        if (!locked.has(r.task)) continue
        const task = await tx.approvalTask.findUniqueOrThrow({ where: { id: r.task } })
        if (task.status !== 'OPEN' && task.status !== 'INFO_REQUESTED') continue
        await moveOne(task, r.to, r.resolvedFrom)
        told.add(task.assigneeMemberId).add(r.to)
      }
      if (found.stuck.length) reparentStuck = found.stuck.length
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
    templateKey: 'doa.authority_changed',
    data: { kind: 'ORG_AUTHORITY_CHANGE', changeId: change.id, changeKind: change.kind },
    urgency: 'IMMEDIATE',
    dedupeKey: `doa.authority_changed:${change.id}:${memberId}`,
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
  if (reparentStuck > 0) {
    for (const memberId of new Set(admins.map((a) => a.memberId))) {
      notifications.push({
        recipientMemberId: memberId,
        templateKey: 'admin.reparent_tasks_stay',
        data: { changeId: change.id, openTasks: reparentStuck },
        urgency: 'IMMEDIATE',
        dedupeKey: `admin.reparent_tasks_stay:${change.id}:${memberId}`,
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
