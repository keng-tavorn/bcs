import type { AppError } from '@/core/result'
import { z } from 'zod'
import { amountToSatang } from '@/core/money/dto'
import { WORKFLOW_VERSION_MACHINE, transition, type WorkflowVersionState } from '@/core/state-machines'
import { lintWorkflowVersion, resolveRequestRoute, resolveReviewer, workflowConditionHolds, type ReviewInput, type WorkflowRuleSnapshot, type WorkflowVersionSnapshot } from '@/core/workflow'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { newId } from '@/lib/ids'
import { authorize } from '@/server/authz'
import { systemCtx, type Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import type { TenantTx } from '@/server/db/tenant'
import { loadOrgSnapshot, loadRoutePolicy } from '@/server/doa/policy'
import type { EventDraft } from '@/server/events/append'
import type { NotificationDraft } from '@/server/notifications/create'
import { loadRequestTypeFields, loadWorkflowVersions } from '@/server/workflow/policy'
import { ConditionJson, ReviewerJson, workflowRuleJson, workflowVersionFromRows } from '@/server/workflow/snapshot'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { startRoute } from '../approvals/route'
import { cancelWithdrawalOnEffect } from '../policy-withdrawal'
import { THAI_DATE, thaiDateStart } from '../doa/dates'
import { SLA_MAX_HOURS } from '../doa/editor'

// Workflow versions (spec §7.17 BR-WF-11 BR-WF-12, FR-WF-103, S6-04): the parallel reviewers of an organization,
// versioned like the DOA. ORG_ADMIN copies the latest version into a draft, edits its rules and test cases, runs the
// dry-run of the latest draft (current version beside the draft, through the real engine), and submits — the lint has
// no error, every warning is acknowledged, every test case passes and the dry-run ran after the last change. The
// approver of the DOA_CHANGE rule decides it with a step-up every time, on the web only (subjects/workflow-version.ts);
// it takes effect on its date and supersedes the version before it. PLATFORM_ADMIN never touches this (NG-12).

const fail = (code: 'VALIDATION_FAILED' | 'NOT_FOUND' | 'INVALID_STATE_TRANSITION' | 'CONFLICT_VERSION', message: string, details?: Record<string, unknown>) =>
  ({ ok: false, error: { code, message, ...(details ? { details } : {}) } }) as const

const actorOf = (ctx: Ctx) => (ctx.actor.type === 'USER' ? ctx.actor.memberId : null)
const Code = z.string().regex(/^[A-Z0-9][A-Z0-9_-]{0,39}$/)
const MAX_RULES = 100
const MAX_TEST_CASES = 50
const MAX_DRY_RUN = 20
const MINUTES_PER_HOUR = 60
/** A sanity bound on a reviewer's time under the SLA, as the DOA editor's */
const SLA_MAX_MINUTES = SLA_MAX_HOURS * MINUTES_PER_HOUR
const MAX_REVIEWERS = 20

const RuleInput = z.strictObject({
  code: Code,
  requestTypeCodes: z.array(Code).min(1).max(20),
  when: ConditionJson,
  reviewers: z.array(ReviewerJson).min(1).max(MAX_REVIEWERS),
  fallback: ReviewerJson.nullable(),
  mode: z.enum(['ALL', 'ANY', 'COUNT']),
  quorumCount: z.number().int().positive().max(MAX_REVIEWERS).nullable(),
  slaMinutes: z.number().int().positive().max(SLA_MAX_MINUTES),
  descriptionTh: z.string().trim().max(500).nullable().optional(),
})

/** A document of a test case or of the dry-run: what the engine reads of a request */
const DocumentInput = z.strictObject({
  requestType: Code,
  /** Baht, VAT included ($amountGross) */
  amountGross: z.string().regex(/^\d{1,13}(\.\d{1,2})?$/),
  /** Baht before VAT; the gross when left out */
  amountNet: z.string().regex(/^\d{1,13}(\.\d{1,2})?$/).optional(),
  lineCategories: z.array(z.string().min(1).max(40)).max(50).default([]),
  budgetAccountCodes: z.array(z.string().min(1).max(40)).max(50).default([]),
  fields: z.record(z.string(), z.unknown()).default({}),
})

/** A test case: the rules a document must match (BR-WF-11, as BR-DOA-08 (ง)) */
const TestCaseInput = z.strictObject({ name: z.string().trim().min(1).max(200), input: DocumentInput, expected: z.strictObject({ ruleCodes: z.array(Code).max(MAX_RULES) }) })

// ---------- what a version's rows hold ----------

type RuleInput = z.output<typeof RuleInput>

function snapshotOfInput(r: RuleInput, sortOrder: number): WorkflowRuleSnapshot {
  return { code: r.code, requestTypeCodes: r.requestTypeCodes, when: r.when, reviewers: r.reviewers, fallback: r.fallback, mode: r.mode, quorumCount: r.quorumCount, slaBusinessMinutes: r.slaMinutes, sortOrder }
}

async function writeRules(tx: TenantTx, ctx: Ctx, versionId: string, rules: ReadonlyArray<WorkflowRuleSnapshot & { readonly descriptionTh?: string | null }>) {
  for (const rule of rules) {
    const json = workflowRuleJson(rule)
    await tx.workflowRule.create({
      data: {
        organizationId: ctx.organizationId,
        workflowVersionId: versionId,
        code: rule.code,
        requestTypeCodes: [...rule.requestTypeCodes],
        when: json.when,
        reviewers: json.reviewers,
        ...(json.fallback ? { fallback: json.fallback } : {}),
        mode: rule.mode,
        quorumCount: rule.quorumCount,
        slaBusinessMinutes: rule.slaBusinessMinutes,
        descriptionTh: rule.descriptionTh ?? null,
        sortOrder: rule.sortOrder,
      },
    })
  }
}

/** The matched rule codes of one document under a version: what a test case states (BR-WF-06 without the people) */
export function matchedRuleCodes(version: WorkflowVersionSnapshot, document: z.output<typeof DocumentInput>): string[] {
  const input = reviewInputOf(document)
  return version.rules.filter((r) => r.requestTypeCodes.includes(document.requestType) && workflowConditionHolds(r.when, { ...input, requesterMemberId: '', conflictMemberIds: [], at: new Date(0), basisAmountSatang: null })).map((r) => r.code)
}

function reviewInputOf(d: z.output<typeof DocumentInput>): Omit<ReviewInput, 'requesterMemberId' | 'conflictMemberIds' | 'at' | 'basisAmountSatang'> {
  const gross = amountToSatang(d.amountGross)
  return { requestType: d.requestType, amountGross: gross, amountNet: d.amountNet ? amountToSatang(d.amountNet) : gross, lineCategories: d.lineCategories, budgetAccountCodes: d.budgetAccountCodes, fields: d.fields }
}

// ---------- draft: a copy of the latest version (FR-WF-103 AC1) ----------

const DraftInput = z.strictObject({
  /** The version to copy; the latest of the code when left out */
  sourceVersionId: z.uuid().optional(),
  /** The code of an organization's first version, which has nothing to copy */
  code: Code.optional(),
})

export const draftWorkflowCommand = defineCommand({
  name: 'workflowVersion.draft',
  capability: 'admin.workflow.draft',
  input: DraftInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ versionId: string; code: string; versionNo: number }>> {
    const allowed = await authorize(tx, ctx, 'admin.workflow.draft')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    if (!actorOf(ctx)) return { ok: false, error: { code: 'FORBIDDEN', message: 'only a member drafts a workflow version' } }
    // One draft number at a time: two drafts saved together would otherwise take the same number
    await lockRowsForUpdate(tx, 'Organization', ctx.organizationId, [ctx.organizationId])
    const source = input.sourceVersionId
      ? await tx.workflowVersion.findFirst({ where: { id: input.sourceVersionId }, include: { rules: true, testCases: true } })
      : await tx.workflowVersion.findFirst({ where: input.code ? { code: input.code } : {}, orderBy: [{ versionNo: 'desc' }], include: { rules: true, testCases: true } })
    if (input.sourceVersionId && !source) return fail('NOT_FOUND', 'workflow version not found')
    const code = source?.code ?? input.code
    if (!code) return fail('VALIDATION_FAILED', 'the first workflow version needs a code', { field: 'code', reason: 'REQUIRED' })
    const last = await tx.workflowVersion.aggregate({ where: { code }, _max: { versionNo: true } })
    const versionNo = (last._max.versionNo ?? 0) + 1
    const id = newId()
    // A draft starts as a copy; its effective time is set when it is edited and must be in the future at submit
    await tx.workflowVersion.create({ data: { id, organizationId: ctx.organizationId, code, versionNo, status: 'DRAFT', effectiveFrom: source?.effectiveFrom ?? ctx.now } })
    const rules = source ? workflowVersionFromRows(source, source.rules).rules.map((r) => ({ ...r, descriptionTh: source.rules.find((x) => x.code === r.code)?.descriptionTh ?? null })) : []
    await writeRules(tx, ctx, id, rules)
    for (const t of source?.testCases ?? []) {
      await tx.workflowTestCase.create({ data: { organizationId: ctx.organizationId, workflowVersionId: id, name: t.name, input: t.input as object, expected: t.expected as object } })
    }
    return {
      ok: true,
      result: { versionId: id, code, versionNo },
      events: [
        {
          type: 'workflow_version.drafted',
          aggregateType: 'WorkflowVersion',
          aggregateId: id,
          data: { code, versionNo, via: 'COPY', rules: rules.length, ...(source ? { fromVersionId: source.id, fromVersionNo: source.versionNo } : {}) },
        },
      ],
    }
  },
})

export function draftWorkflowVersion(ctx: Ctx, input: z.input<typeof DraftInput>, options: RunOptions) {
  return runCommand(ctx, draftWorkflowCommand, input, options)
}

// ---------- update the draft ----------

const UpdateInput = z.strictObject({
  versionId: z.uuid(),
  /** WorkflowVersion.version as the page read it (§6.1 optimistic lock) */
  version: z.number().int().nonnegative(),
  /** A Thai calendar date; the version starts at 00:00 Thai time that day */
  effectiveDate: z.string().regex(THAI_DATE),
  changeReason: z.string().trim().min(3).max(REASON_MAX_LENGTH),
  rules: z.array(RuleInput).max(MAX_RULES),
  testCases: z.array(TestCaseInput).max(MAX_TEST_CASES).default([]),
})

export const updateWorkflowCommand = defineCommand({
  name: 'workflowVersion.update',
  capability: 'admin.workflow.draft',
  input: UpdateInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ versionId: string; version: number }>> {
    const allowed = await authorize(tx, ctx, 'admin.workflow.draft')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    const [locked] = await lockRowsForUpdate(tx, 'WorkflowVersion', ctx.organizationId, [input.versionId])
    if (!locked) return fail('NOT_FOUND', 'workflow version not found')
    const row = await tx.workflowVersion.findUniqueOrThrow({ where: { id: input.versionId } })
    const moved = transition(WORKFLOW_VERSION_MACHINE, row.status as WorkflowVersionState, 'workflowVersion.update')
    if (!moved.ok) return fail('INVALID_STATE_TRANSITION', `workflowVersion.update is not allowed from ${row.status}`, { from: row.status, command: 'workflowVersion.update' })
    if (row.version !== input.version) return fail('CONFLICT_VERSION', 'the draft was changed by someone else')
    const effectiveFrom = thaiDateStart(input.effectiveDate)
    if (!effectiveFrom) return fail('VALIDATION_FAILED', 'not a calendar date', { field: 'effectiveDate', reason: 'DATE' })
    // BR-WF-12 as BR-DOA-12: never in the past
    if (effectiveFrom.getTime() < ctx.now.getTime()) return fail('VALIDATION_FAILED', 'the effective time is in the past', { field: 'effectiveDate', reason: 'EFFECTIVE_IN_PAST' })
    const seen = new Set<string>()
    for (const [i, r] of input.rules.entries()) {
      if (seen.has(r.code)) return fail('VALIDATION_FAILED', `rule code ${r.code} is used twice`, { field: `rules.${i}.code`, reason: 'DUPLICATE_RULE', rule: r.code })
      seen.add(r.code)
    }
    // Reviewers are positions held in departments of this organization, or its members
    const specs = input.rules.flatMap((r) => [...r.reviewers, ...(r.fallback ? [r.fallback] : [])])
    const positions = new Set((await tx.position.findMany({ select: { code: true } })).map((p) => p.code))
    const departments = new Set((await tx.department.findMany({ select: { code: true } })).map((d) => d.code))
    const members = new Set((await tx.member.findMany({ where: { id: { in: specs.flatMap((s) => (s.kind === 'MEMBER' ? [s.memberId] : [])) } }, select: { id: true } })).map((m) => m.id))
    for (const [i, r] of input.rules.entries()) {
      for (const s of [...r.reviewers, ...(r.fallback ? [r.fallback] : [])]) {
        const missing = s.kind === 'MEMBER' ? !members.has(s.memberId) : !positions.has(s.position) || !departments.has(s.department)
        if (missing) return fail('VALIDATION_FAILED', 'unknown reviewer', { field: `rules.${i}.reviewers`, reason: s.kind === 'MEMBER' ? 'MEMBER' : 'POSITION', rule: r.code })
      }
    }
    await tx.workflowRule.deleteMany({ where: { workflowVersionId: row.id } })
    await tx.workflowTestCase.deleteMany({ where: { workflowVersionId: row.id } })
    await writeRules(
      tx,
      ctx,
      row.id,
      input.rules.map((r, i) => ({ ...snapshotOfInput(r, i), descriptionTh: r.descriptionTh ?? null })),
    )
    for (const t of input.testCases) {
      await tx.workflowTestCase.create({ data: { organizationId: ctx.organizationId, workflowVersionId: row.id, name: t.name, input: t.input as object, expected: t.expected } })
    }
    // A change of the draft means its dry-run has to run again before it can be sent (§6.4 WorkflowVersion)
    const updated = await tx.workflowVersion.update({ where: { id: row.id }, data: { effectiveFrom, changeReason: input.changeReason, dryRunAt: null, version: { increment: 1 } } })
    return {
      ok: true,
      result: { versionId: row.id, version: updated.version },
      events: [{ type: 'workflow_version.updated', aggregateType: 'WorkflowVersion', aggregateId: row.id, data: { code: row.code, versionNo: row.versionNo, rules: input.rules.length, testCases: input.testCases.length } }],
    }
  },
})

export function updateWorkflowVersion(ctx: Ctx, input: z.input<typeof UpdateInput>, options: RunOptions) {
  return runCommand(ctx, updateWorkflowCommand, input, options)
}

// ---------- dry-run: the version in effect beside the draft (FR-WF-103 AC2) ----------

const DryRunInput = z.strictObject({
  versionId: z.uuid(),
  documents: z
    .array(DocumentInput.extend({ requesterMemberId: z.uuid(), chargedDepartmentId: z.uuid() }))
    .min(1)
    .max(MAX_DRY_RUN),
})

export interface DryRunSide {
  readonly ok: boolean
  /** The reviewers by slot: rule codes and member ids; null without a REVIEW step */
  readonly review: ReadonlyArray<{ readonly ruleCodes: readonly string[]; readonly memberIds: readonly string[] }> | null
  readonly approval: { readonly ruleCode: string; readonly memberIds: readonly string[] } | null
  readonly error: { readonly code: string; readonly details?: Readonly<Record<string, unknown>> } | null
}

export interface DryRunRow {
  readonly current: DryRunSide
  readonly draft: DryRunSide
  readonly changed: boolean
}

/**
 * FR-WF-103 AC3: the approver of a version — who holds a task on its approval route, or whom a delegate holds it for —
 * reads the version and tries documents out on it before deciding, without admin.workflow.* (read only: nothing they
 * do there changes the version)
 */
export async function holdsWorkflowTask(tx: TenantTx, ctx: Ctx, versionId: string): Promise<boolean> {
  if (ctx.actor.type !== 'USER') return false
  const me = ctx.actor.memberId
  const held = await tx.approvalTask.count({ where: { OR: [{ assigneeMemberId: me }, { principalMemberId: me }], step: { route: { subjectType: 'WORKFLOW_VERSION', subjectId: versionId } } } })
  return held > 0
}

export const dryRunWorkflowCommand = defineCommand({
  name: 'workflowVersion.dry_run',
  capability: 'admin.workflow.simulate',
  input: DryRunInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ rows: DryRunRow[] }>> {
    const allowed = await authorize(tx, ctx, 'admin.workflow.simulate')
    if (!allowed.ok && !(await holdsWorkflowTask(tx, ctx, input.versionId))) return { ok: false, error: allowed.error }
    const [locked] = await lockRowsForUpdate(tx, 'WorkflowVersion', ctx.organizationId, [input.versionId])
    if (!locked) return fail('NOT_FOUND', 'workflow version not found')
    const row = await tx.workflowVersion.findUniqueOrThrow({ where: { id: input.versionId }, include: { rules: true } })
    const draft = workflowVersionFromRows(row, row.rules)
    const [policy, workflows] = await Promise.all([loadRoutePolicy(tx), loadWorkflowVersions(tx)])
    // The draft as if it were the version in effect now, with the same holders, delegations and time
    const asInEffect: WorkflowVersionSnapshot = { ...draft, status: 'PUBLISHED', effectiveFrom: ctx.now, effectiveTo: null }
    const side = (versions: readonly WorkflowVersionSnapshot[], d: (typeof input.documents)[number]): DryRunSide => {
      const review = reviewInputOf(d)
      const result = resolveRequestRoute(
        { documentType: 'PURCHASE_REQUEST', amount: { netSatang: review.amountNet, vatSatang: review.amountGross - review.amountNet }, requesterMemberId: d.requesterMemberId, chargedDepartmentId: d.chargedDepartmentId, conflictMemberIds: [d.requesterMemberId], at: ctx.now },
        review,
        { ...policy, workflows: versions },
      )
      if (!result.ok) return { ok: false, review: null, approval: null, error: { code: result.error.code, ...(result.error.details ? { details: result.error.details } : {}) } }
      return {
        ok: true,
        review: result.data.review?.slots.map((s) => ({ ruleCodes: s.ruleCodes, memberIds: s.assignees.map((a) => a.assigneeMemberId) })) ?? null,
        approval: { ruleCode: result.data.approval.ruleCode, memberIds: result.data.approval.steps.flatMap((s) => (s.committee ? s.committee.slots.map((x) => x.assigneeMemberId) : [s.assigneeMemberId])) },
        error: null,
      }
    }
    const rows = input.documents.map((d) => {
      const current = side(workflows, d)
      const next = side([asInEffect], d)
      return { current, draft: next, changed: JSON.stringify(current) !== JSON.stringify(next) }
    })
    // Only a draft records its dry-run: submit asks that it ran after the last change
    const events: EventDraft[] = []
    if (row.status === 'DRAFT') {
      await tx.workflowVersion.update({ where: { id: row.id }, data: { dryRunAt: ctx.now } })
      events.push({ type: 'workflow_version.dry_run', aggregateType: 'WorkflowVersion', aggregateId: row.id, data: { code: row.code, versionNo: row.versionNo, documents: input.documents.length } })
    }
    return { ok: true, result: { rows }, events }
  },
})

export function dryRunWorkflowVersion(ctx: Ctx, input: z.input<typeof DryRunInput>, options: RunOptions) {
  return runCommand(ctx, dryRunWorkflowCommand, input, options)
}

// ---------- submit for publishing (FR-WF-103 AC2 AC3) ----------

const SubmitInput = z.strictObject({ versionId: z.uuid(), acknowledgedWarnings: z.array(z.string()).default([]) })

/** A warning as the sender ticks it: "WF_LINT_NO_FALLBACK:RV-03" */
export const workflowWarningKey = (w: { readonly code: string; readonly rule: string }) => `${w.code}:${w.rule}`

/** BR-WF-12 as ADR-042 item 7: a version approved for the same or a later time must be withdrawn first */
async function laterWorkflowScheduled(tx: TenantTx, version: { id: string; code: string }, effectiveFrom: Date) {
  const later = await tx.workflowVersion.findFirst({ where: { code: version.code, status: 'PUBLISHED', id: { not: version.id }, effectiveFrom: { gte: effectiveFrom } }, select: { versionNo: true } })
  return later ? fail('VALIDATION_FAILED', `version ${later.versionNo} is approved for the same or a later time`, { field: 'effectiveFrom', reason: 'LATER_VERSION_SCHEDULED', versionNo: later.versionNo }) : null
}

export const submitWorkflowCommand = defineCommand({
  name: 'workflowVersion.submit',
  capability: 'admin.workflow.submitForPublish',
  input: SubmitInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ versionId: string; routeId: string; assigneeMemberId: string }>> {
    const allowed = await authorize(tx, ctx, 'admin.workflow.submitForPublish')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    const submitter = actorOf(ctx)
    if (!submitter) return { ok: false, error: { code: 'FORBIDDEN', message: 'only a member submits' } }
    const [locked] = await lockRowsForUpdate(tx, 'WorkflowVersion', ctx.organizationId, [input.versionId])
    if (!locked) return fail('NOT_FOUND', 'workflow version not found')
    const row = await tx.workflowVersion.findUniqueOrThrow({ where: { id: input.versionId }, include: { rules: true, testCases: true } })
    const moved = transition(WORKFLOW_VERSION_MACHINE, row.status as WorkflowVersionState, 'workflowVersion.submit')
    if (!moved.ok) return fail('INVALID_STATE_TRANSITION', `workflowVersion.submit is not allowed from ${row.status}`, { from: row.status, command: 'workflowVersion.submit' })
    if (row.effectiveFrom.getTime() < ctx.now.getTime()) return fail('VALIDATION_FAILED', 'the effective time is in the past', { field: 'effectiveFrom', reason: 'EFFECTIVE_IN_PAST' })
    const later = await laterWorkflowScheduled(tx, row, row.effectiveFrom)
    if (later) return later

    // BR-WF-11: the lint against the organization as it will be on the effective date
    const version = workflowVersionFromRows(row, row.rules)
    const lint = lintWorkflowVersion(version, await loadOrgSnapshot(tx), await loadRequestTypeFields(tx), row.effectiveFrom)
    if (lint.errors.length) return { ok: false, error: { code: 'WORKFLOW_LINT_FAILED', message: 'the workflow version does not pass the lint', details: { errors: lint.errors, codes: [...new Set(lint.errors.map((e) => e.code))].join(', ') } } }
    const unacknowledged = lint.warnings.map(workflowWarningKey).filter((k) => !input.acknowledgedWarnings.includes(k))
    if (unacknowledged.length) return fail('VALIDATION_FAILED', 'every warning must be acknowledged', { reason: 'WARNINGS_NOT_ACKNOWLEDGED', warnings: unacknowledged })
    // As BR-DOA-08 (ง): every test case gives the rules it states
    const failing = row.testCases.filter((t) => {
      const parsed = TestCaseInput.safeParse({ name: t.name, input: t.input, expected: t.expected })
      return !parsed.success || JSON.stringify(matchedRuleCodes(version, parsed.data.input).sort()) !== JSON.stringify([...parsed.data.expected.ruleCodes].sort())
    })
    if (failing.length) return fail('VALIDATION_FAILED', 'a test case does not pass', { reason: 'TEST_CASES_FAILED', testCases: failing.map((t) => t.name) })
    // §6.4: the dry-run of the latest draft ran after its last change (an update clears dryRunAt)
    if (row.dryRunAt === null) return fail('VALIDATION_FAILED', 'run the dry-run of the latest draft first', { reason: 'DRY_RUN_REQUIRED' })

    // BR-WF-12: the approver of the DOA_CHANGE rule in effect, never the submitter (SoD of the subject)
    const member = await tx.member.findUniqueOrThrow({ where: { id: submitter }, select: { primaryDepartmentId: true } })
    const root = await tx.department.findFirst({ where: { parentId: null }, select: { id: true } })
    const departmentId = member.primaryDepartmentId ?? root?.id
    if (!departmentId) return fail('VALIDATION_FAILED', 'the organization has no departments', { reason: 'NO_DEPARTMENT' })
    const route = await startRoute(
      tx,
      ctx,
      { type: 'WORKFLOW_VERSION', id: row.id, label: `${row.code} ฉบับ ${row.versionNo}` },
      { documentType: 'DOA_CHANGE', requesterMemberId: submitter, chargedDepartmentId: departmentId, conflictMemberIds: [submitter], at: ctx.now },
    )
    if (!route.ok) return { ok: false, error: route.error }
    await tx.workflowVersion.update({ where: { id: row.id }, data: { status: moved.to, submittedById: submitter, submittedAt: ctx.now, version: { increment: 1 } } })
    return {
      ok: true,
      result: { versionId: row.id, routeId: route.data.routeId, assigneeMemberId: route.data.firstTask.assigneeMemberId },
      events: [
        { type: 'workflow_version.submitted', aggregateType: 'WorkflowVersion', aggregateId: row.id, data: { code: row.code, versionNo: row.versionNo, warningsAcknowledged: lint.warnings.length, routeId: route.data.routeId } },
        ...route.data.events,
      ],
      notifications: route.data.notifications,
    }
  },
})

export function submitWorkflowVersion(ctx: Ctx, input: z.input<typeof SubmitInput>, options: RunOptions) {
  return runCommand(ctx, submitWorkflowCommand, input, options)
}

// ---------- publish or reject, from the approval (subjects/workflow-version.ts) ----------

/** ORG_ADMIN and AUDITOR, and whoever holds a reviewer seat of a rule that is new, gone or changed (§10.1) */
async function authorityAudience(tx: TenantTx, before: WorkflowVersionSnapshot | null, after: WorkflowVersionSnapshot, now: Date): Promise<string[]> {
  const admins = await tx.roleAssignment.findMany({ where: { role: { in: ['ORG_ADMIN', 'AUDITOR'] }, revokedAt: null, member: { status: 'ACTIVE' } }, select: { memberId: true } })
  const key = (r: WorkflowRuleSnapshot) => JSON.stringify({ ...r, sortOrder: 0 })
  const beforeKeys = new Set((before?.rules ?? []).map(key))
  const afterKeys = new Set(after.rules.map(key))
  const moved = [...(before?.rules ?? []).filter((r) => !afterKeys.has(key(r))), ...after.rules.filter((r) => !beforeKeys.has(key(r)))]
  const org = await loadOrgSnapshot(tx)
  const reviewers = moved.flatMap((r) => r.reviewers).flatMap((s) => resolveReviewer(s, org, now)?.memberId ?? [])
  return [...new Set([...admins.map((a) => a.memberId), ...reviewers])]
}

/**
 * A version of the same code approved for the same or a later time than `effectiveFrom` (as laterVersionScheduled of a
 * DOA version, BR-DOA-12): approving this one now would end that one before it starts (workflow_version_period)
 */
export async function laterWorkflowVersionScheduled(tx: TenantTx, version: { readonly id: string; readonly code: string; readonly effectiveFrom: Date }, now: Date): Promise<AppError | null> {
  const effectiveFrom = version.effectiveFrom.getTime() < now.getTime() ? now : version.effectiveFrom
  const later = await tx.workflowVersion.findFirst({ where: { code: version.code, status: 'PUBLISHED', id: { not: version.id }, effectiveFrom: { gte: effectiveFrom } }, select: { versionNo: true } })
  return later ? { code: 'VALIDATION_FAILED', message: `version ${later.versionNo} is approved for the same or a later time`, details: { field: 'effectiveFrom', reason: 'LATER_VERSION_SCHEDULED', versionNo: later.versionNo } } : null
}

/**
 * Publishes a version whose DOA_CHANGE approval is complete, inside the approving command's transaction (as
 * publishApprovedDoaVersion): an effective time that has passed becomes the approval time; the version before it ends
 * where it starts and is SUPERSEDED once it is in effect (now, or by the job workflow-version-activate).
 */
export async function publishApprovedWorkflowVersion(tx: TenantTx, ctx: Ctx, versionId: string, approverMemberId: string): Promise<{ events: EventDraft[]; notifications: NotificationDraft[] }> {
  const row = await tx.workflowVersion.findUniqueOrThrow({ where: { id: versionId }, include: { rules: true } })
  const moved = transition(WORKFLOW_VERSION_MACHINE, row.status as WorkflowVersionState, 'workflowVersion.approve')
  if (!moved.ok) throw new Error(`workflowVersion.approve is not allowed from ${row.status}`)
  const effectiveFrom = row.effectiveFrom.getTime() < ctx.now.getTime() ? ctx.now : row.effectiveFrom
  const events: EventDraft[] = []
  const previous = await tx.workflowVersion.findMany({
    where: { code: row.code, status: 'PUBLISHED', id: { not: row.id }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: effectiveFrom } }] },
    include: { rules: true },
  })
  const inEffectNow = effectiveFrom.getTime() <= ctx.now.getTime()
  for (const p of previous) {
    // End the previous period first: published periods of one code never overlap (workflow_no_overlap)
    await tx.workflowVersion.update({ where: { id: p.id }, data: { effectiveTo: effectiveFrom, ...(inEffectNow ? { status: 'SUPERSEDED' } : {}) } })
    if (inEffectNow) events.push({ type: 'workflow_version.superseded', aggregateType: 'WorkflowVersion', aggregateId: p.id, data: { code: row.code, versionNo: p.versionNo, supersededBy: row.id } })
  }
  await tx.workflowVersion.update({ where: { id: row.id }, data: { status: moved.to, effectiveFrom, approvedById: approverMemberId, approvedAt: ctx.now, publishedAt: ctx.now, version: { increment: 1 } } })
  events.push(
    { type: 'workflow_version.approved', aggregateType: 'WorkflowVersion', aggregateId: row.id, data: { code: row.code, versionNo: row.versionNo, approvedById: approverMemberId } },
    { type: 'workflow_version.published', aggregateType: 'WorkflowVersion', aggregateId: row.id, data: { code: row.code, versionNo: row.versionNo, effectiveFrom: effectiveFrom.toISOString(), via: 'APPROVAL', rules: row.rules.length } },
  )
  const before = previous[0] ? workflowVersionFromRows(previous[0], previous[0].rules) : null
  const audience = await authorityAudience(tx, before, workflowVersionFromRows(row, row.rules), effectiveFrom)
  const notifications: NotificationDraft[] = audience.map((memberId) => ({
    recipientMemberId: memberId,
    templateKey: 'doa.authority_changed',
    data: { kind: 'WORKFLOW_VERSION', versionId: row.id, code: row.code, versionNo: row.versionNo, effectiveFrom: effectiveFrom.toISOString() },
    urgency: 'IMMEDIATE' as const,
    dedupeKey: `doa.authority_changed:${row.id}:${memberId}`,
    subjectType: 'WORKFLOW_VERSION',
    subjectId: row.id,
  }))
  if (row.submittedById) {
    notifications.push({ recipientMemberId: row.submittedById, templateKey: 'workflow_version.approved', data: { subjectId: row.id }, urgency: 'IMMEDIATE', dedupeKey: `workflow_version.decided:${row.id}`, subjectType: 'WORKFLOW_VERSION', subjectId: row.id })
  }
  return { events, notifications }
}

/** A returned or rejected version ends REJECTED: its submitter makes a new draft (§6.4 WorkflowVersion) */
export async function rejectWorkflowVersion(tx: TenantTx, versionId: string, reasonCommentId: string | null): Promise<{ events: EventDraft[]; notifications: NotificationDraft[] }> {
  const row = await tx.workflowVersion.findUniqueOrThrow({ where: { id: versionId } })
  const moved = transition(WORKFLOW_VERSION_MACHINE, row.status as WorkflowVersionState, 'workflowVersion.reject')
  if (!moved.ok) throw new Error(`workflowVersion.reject is not allowed from ${row.status}`)
  await tx.workflowVersion.update({ where: { id: row.id }, data: { status: moved.to, version: { increment: 1 } } })
  return {
    events: [{ type: 'workflow_version.rejected', aggregateType: 'WorkflowVersion', aggregateId: row.id, data: { code: row.code, versionNo: row.versionNo, reasonCommentId } }],
    notifications: row.submittedById
      ? [{ recipientMemberId: row.submittedById, templateKey: 'workflow_version.rejected', data: { subjectId: row.id }, urgency: 'IMMEDIATE', dedupeKey: `workflow_version.decided:${row.id}`, subjectType: 'WORKFLOW_VERSION', subjectId: row.id }]
      : [],
  }
}

// ---------- activation at the effective time (job workflow-version-activate) ----------

const ActivateInput = z.strictObject({ versionId: z.uuid() })

export const activateWorkflowCommand = defineCommand({
  name: 'workflowVersion.activate',
  capability: 'admin.workflow.submitForPublish',
  input: ActivateInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ superseded: number }>> {
    if (ctx.actor.type !== 'SYSTEM') return { ok: false, error: { code: 'FORBIDDEN', message: 'only the scheduled job activates versions' } }
    const version = await tx.workflowVersion.findFirst({ where: { id: input.versionId, status: 'PUBLISHED' }, select: { code: true, versionNo: true, effectiveFrom: true } })
    if (!version) return fail('NOT_FOUND', 'published version not found')
    if (version.effectiveFrom.getTime() > ctx.now.getTime()) return fail('VALIDATION_FAILED', 'not in effect yet', { reason: 'NOT_DUE' })
    // S6-07: a withdrawal still asked is cancelled with its route now that the version is in effect (ALREADY_EFFECTIVE)
    const events: EventDraft[] = await cancelWithdrawalOnEffect(tx, 'WORKFLOW_VERSION', input.versionId)
    const ended = await tx.workflowVersion.findMany({ where: { code: version.code, status: 'PUBLISHED', id: { not: input.versionId }, effectiveTo: { lte: ctx.now } }, select: { id: true, versionNo: true, status: true } })
    if (ended.length === 0 && events.length === 0) return fail('INVALID_STATE_TRANSITION', 'nothing to supersede', { reason: 'NOTHING_TO_SUPERSEDE' })
    for (const p of ended) {
      const t = transition(WORKFLOW_VERSION_MACHINE, p.status as WorkflowVersionState, 'workflowVersion.supersede')
      if (!t.ok) continue
      await tx.workflowVersion.update({ where: { id: p.id }, data: { status: t.to, version: { increment: 1 } } })
      events.push({ type: 'workflow_version.superseded', aggregateType: 'WorkflowVersion', aggregateId: p.id, data: { code: version.code, versionNo: p.versionNo, supersededBy: input.versionId } })
    }
    return { ok: true, result: { superseded: events.filter((e) => e.type === 'workflow_version.superseded').length }, events }
  },
})

/** What the job workflow-version-activate runs at the effective time; the version id is the idempotency key */
export function activateWorkflowVersion(organizationId: string, versionId: string, now: Date) {
  return runCommand(systemCtx(organizationId, now, 'workflow-version-activate'), activateWorkflowCommand, { versionId }, { idempotencyKey: `workflow-version-activate:${versionId}` })
}
