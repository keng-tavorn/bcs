import { createHash } from 'node:crypto'
import { z } from 'zod'
import { lintDoaVersion } from '@/core/doa'
import { DOA_VERSION_MACHINE, transition, type DoaVersionState } from '@/core/state-machines'
import { DOA_YAML_MAX_CHARS, REASON_MAX_LENGTH } from '@/lib/constants'
import { newId } from '@/lib/ids'
import { authorize } from '@/server/authz'
import { systemCtx, type Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import type { TenantTx } from '@/server/db/tenant'
import { loadOrgSnapshot } from '@/server/doa/policy'
import { ruleJson, versionSnapshotFromRows } from '@/server/doa/snapshot'
import { parseDoaYaml } from '@/server/doa/yaml'
import type { EventDraft } from '@/server/events/append'
import { AiAssistInput, applyAiAssist } from '../ai/assist-contract'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { doaLintOptions } from './lint-options'
import { startRoute } from '../approvals/route'
import { cancelWithdrawalOnEffect } from '../policy-withdrawal'
import { boundaryTableRequired } from './boundary'
import { issueView, warningKey } from './lint-view'

export { warningKey } from './lint-view'

// DOA versions (spec §7.4, FR-DOA-001 AC2, FR-DOA-002, BR-DOA-08, BR-DOA-12): the customer's ORG_ADMIN imports a draft
// from YAML, submits it — the full lint must pass, every warning must be acknowledged one by one, the boundary table
// ticked as checked when there is one (FR-DOA-009 AC3), and the effective time may not be in the past — and the
// approver of the DOA_CHANGE rule of the version in effect decides it (with a
// step-up, S2-16). Publishing moves the effective time to the approval when it was already past and supersedes the
// previous version once the new one takes effect. PLATFORM_ADMIN never touches this (NG-12, BR-DOA-19).

const fail = (code: 'VALIDATION_FAILED' | 'NOT_FOUND' | 'INVALID_STATE_TRANSITION', message: string, details?: Record<string, unknown>) =>
  ({ ok: false, error: { code, message, ...(details ? { details } : {}) } }) as const

const actorOf = (ctx: Ctx) => (ctx.actor.type === 'USER' ? ctx.actor.memberId : null)


// ---------- import a draft (FR-DOA-001 AC2) ----------

// changeReason: why the organization changes its DOA, kept on the version for its history (FR-DOA-001 AC3)
const ImportInput = z.strictObject({
  yaml: z.string().min(1).max(DOA_YAML_MAX_CHARS),
  changeReason: z.string().trim().min(3).max(REASON_MAX_LENGTH).optional(),
  /** A draft the DOA drafter read from the regulation, every rule confirmed by the person (BR-AI-22 of S13 · assist-contract.ts) */
  aiAssist: AiAssistInput.optional(),
})

export const importDoaDraftCommand = defineCommand({
  name: 'doa.import_draft',
  capability: 'admin.doa.draft',
  input: ImportInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ versionIds: string[] }>> {
    const allowed = await authorize(tx, ctx, 'admin.doa.draft')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    const members = await tx.member.findMany({ where: { employeeCode: { not: null } }, select: { id: true, employeeCode: true } })
    const parsed = parseDoaYaml(input.yaml, new Map(members.map((m) => [m.employeeCode!, m.id])))
    if (!parsed.ok) return { ok: false, error: parsed.error }
    const versionIds: string[] = []
    const events: EventDraft[] = []
    const checksum = createHash('sha256').update(input.yaml).digest('hex')
    for (const v of parsed.data) {
      if (await tx.doaVersion.findFirst({ where: { code: v.code, versionNo: v.versionNo }, select: { id: true } })) {
        return fail('VALIDATION_FAILED', `${v.code} version ${v.versionNo} exists already`, { field: 'versions.version', reason: 'VERSION_EXISTS', doaCode: v.code, versionNo: v.versionNo })
      }
      const id = newId()
      await tx.doaVersion.create({
        data: {
          id,
          organizationId: ctx.organizationId,
          code: v.code,
          versionNo: v.versionNo,
          status: 'DRAFT',
          effectiveFrom: v.effectiveFrom,
          amountBasis: v.amountBasis,
          selfApprovalPolicy: v.selfApprovalPolicy,
          collapseDuplicateApprovers: v.collapseDuplicateApprovers,
          stepUpThresholdSatang: v.stepUpThresholdSatang,
          sodPolicy: { ...v.sodPolicy },
          changeReason: input.changeReason ?? null,
          sourceYaml: input.yaml,
          checksum,
        },
      })
      for (const rule of v.rules) {
        const json = ruleJson(rule)
        await tx.doaRule.create({ data: { organizationId: ctx.organizationId, doaVersionId: id, code: rule.code, documentType: json.documentType, priority: rule.priority, when: json.when, steps: json.steps } })
      }
      versionIds.push(id)
      events.push({
        type: 'doa_version.drafted',
        aggregateType: 'DoaVersion',
        aggregateId: id,
        data: { code: v.code, versionNo: v.versionNo, via: 'YAML', rules: v.rules.length, ...(input.aiAssist ? { agentActionId: input.aiAssist.agentActionId } : {}) },
      })
    }
    // BR-AI-17 (S13): an import from an AI draft names it, and every rule of it must be confirmed in this call
    const ai = await applyAiAssist(tx, ctx, { type: 'DOA_VERSION', id: versionIds[0]! }, input.aiAssist)
    if (!ai.ok) return ai
    return { ok: true, result: { versionIds }, events: [...events, ...ai.data] }
  },
})

export function importDoaDraft(ctx: Ctx, input: z.input<typeof ImportInput>, options: RunOptions) {
  return runCommand(ctx, importDoaDraftCommand, input, options)
}

// ---------- submit for publishing (FR-DOA-002 AC1, AC2 route, AC4 effective time) ----------

const SubmitInput = z.strictObject({
  versionId: z.uuid(),
  acknowledgedWarnings: z.array(z.string()).default([]),
  /**
   * FR-DOA-009 AC3: the drafter ticked the boundary table as checked. Required (true) whenever the version has a
   * boundary table beside the version it is compared with (boundary.ts); anything else is then refused as
   * BOUNDARY_NOT_CONFIRMED. A version without one has nothing to tick, and the value is not read.
   */
  boundaryTableConfirmed: z.boolean().optional(),
})

export const submitDoaVersionCommand = defineCommand({
  name: 'doa.submit',
  capability: 'admin.doa.submitForPublish',
  input: SubmitInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ versionId: string; routeId: string; assigneeMemberId: string }>> {
    const allowed = await authorize(tx, ctx, 'admin.doa.submitForPublish')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    const submitter = actorOf(ctx)
    if (!submitter) return { ok: false, error: { code: 'FORBIDDEN', message: 'only a member submits' } }
    // BR-DOA-24: the organization row first (as organization.set_module and initial-package.ts), so a module switched
    // on while this runs cannot leave a version waiting for approval without the rules the module needs
    await lockRowsForUpdate(tx, 'Organization', ctx.organizationId, [ctx.organizationId])
    const [locked] = await lockRowsForUpdate(tx, 'DoaVersion', ctx.organizationId, [input.versionId])
    if (!locked) return fail('NOT_FOUND', 'DOA version not found')
    const row = await tx.doaVersion.findUniqueOrThrow({ where: { id: input.versionId }, include: { rules: true } })
    const moved = transition(DOA_VERSION_MACHINE, row.status as DoaVersionState, 'doa.submit')
    if (!moved.ok) return fail('INVALID_STATE_TRANSITION', `doa.submit is not allowed from ${row.status}`, { from: row.status, command: 'doa.submit' })
    // BR-DOA-12: an effective time in the past is refused at submit
    if (row.effectiveFrom.getTime() < ctx.now.getTime()) return fail('VALIDATION_FAILED', 'the effective time is in the past', { field: 'effectiveFrom', reason: 'EFFECTIVE_IN_PAST' })
    const later = await laterVersionScheduled(tx, row, row.effectiveFrom)
    if (later) return later

    // BR-DOA-08: the full lint against the organization as it will be on the effective date, with the modules that are
    // on (BR-DOA-23); the approval runs no lint again
    const version = versionSnapshotFromRows(row, row.rules)
    const lint = lintDoaVersion(version, await loadOrgSnapshot(tx), row.effectiveFrom, await doaLintOptions(tx, row.sodPolicy))
    if (lint.errors.length) return { ok: false, error: { code: 'DOA_LINT_FAILED', message: 'the DOA version does not pass the lint', details: { errors: lint.errors.map(issueView) } } }
    const unacknowledged = lint.warnings.map(warningKey).filter((k) => !input.acknowledgedWarnings.includes(k))
    if (unacknowledged.length) return fail('VALIDATION_FAILED', 'every warning must be acknowledged', { reason: 'WARNINGS_NOT_ACKNOWLEDGED', warnings: unacknowledged })
    // FR-DOA-009 AC3: the drafter ticked the boundary table the version's page shows, whenever it has one
    if (input.boundaryTableConfirmed !== true && (await boundaryTableRequired(tx, row, ctx.now))) {
      return fail('VALIDATION_FAILED', 'the boundary table must be confirmed', { field: 'boundaryTableConfirmed', reason: 'BOUNDARY_NOT_CONFIRMED' })
    }

    // FR-DOA-002 AC2: the approver of the DOA_CHANGE rule of the version in effect now; never the submitter (GC-SOD-04)
    const member = await tx.member.findUniqueOrThrow({ where: { id: submitter }, select: { primaryDepartmentId: true } })
    const root = await tx.department.findFirst({ where: { parentId: null }, select: { id: true } })
    const departmentId = member.primaryDepartmentId ?? root?.id
    if (!departmentId) return fail('VALIDATION_FAILED', 'the organization has no departments', { reason: 'NO_DEPARTMENT' })
    const route = await startRoute(
      tx,
      ctx,
      { type: 'DOA_VERSION', id: row.id, label: `${row.code} ฉบับ ${row.versionNo}` },
      { documentType: 'DOA_CHANGE', requesterMemberId: submitter, chargedDepartmentId: departmentId, conflictMemberIds: [submitter], at: ctx.now },
    )
    if (!route.ok) return { ok: false, error: route.error }
    await tx.doaVersion.update({ where: { id: row.id }, data: { status: moved.to, submittedById: submitter, submittedAt: ctx.now, version: { increment: 1 } } })
    return {
      ok: true,
      result: { versionId: row.id, routeId: route.data.routeId, assigneeMemberId: route.data.firstTask.assigneeMemberId },
      events: [
        {
          type: 'doa_version.submitted',
          aggregateType: 'DoaVersion',
          aggregateId: row.id,
          data: { code: row.code, versionNo: row.versionNo, warningsAcknowledged: lint.warnings.length, routeId: route.data.routeId, ...(input.boundaryTableConfirmed ? { boundaryTableConfirmed: true } : {}) },
        },
        ...route.data.events,
      ],
      notifications: route.data.notifications,
    }
  },
})

export function submitDoaVersion(ctx: Ctx, input: z.input<typeof SubmitInput>, options: RunOptions) {
  return runCommand(ctx, submitDoaVersionCommand, input, options)
}

// ---------- publish an approved version (FR-DOA-002 AC4) ----------

/**
 * A version starts after every published version of its code has started (§6.3 (5) doa_no_overlap and the period
 * check): one approved for the same or a later time must be withdrawn first (BR-DOA-18, S6). Checked at submit and
 * again when the approval publishes, with the effective time it would really get.
 */
export async function laterVersionScheduled(tx: TenantTx, version: { id: string; code: string }, effectiveFrom: Date) {
  const later = await tx.doaVersion.findFirst({ where: { code: version.code, status: 'PUBLISHED', id: { not: version.id }, effectiveFrom: { gte: effectiveFrom } }, select: { versionNo: true } })
  return later ? fail('VALIDATION_FAILED', `version ${later.versionNo} is approved for the same or a later time`, { field: 'effectiveFrom', reason: 'LATER_VERSION_SCHEDULED', versionNo: later.versionNo }) : null
}

/**
 * Publishes a version whose DOA_CHANGE approval is complete, inside the approving command's transaction. BR-DOA-12: an
 * effective time that has passed becomes the approval time. The previous version of the same code ends where the new
 * one starts and is SUPERSEDED once the new one is in effect (now, or by the scheduled job when the time comes). The
 * previous version is the one whose period reaches past that start (no end yet, or a later one): a version that already
 * ends at or before it keeps its end — version 1 ending where version 2, approved for later, starts — so the periods
 * of the code still never overlap (doa_no_overlap, ADR-042 item 7).
 */
export async function publishApprovedDoaVersion(tx: TenantTx, ctx: Ctx, versionId: string, approverMemberId: string): Promise<EventDraft[]> {
  const row = await tx.doaVersion.findUniqueOrThrow({ where: { id: versionId }, include: { rules: { select: { id: true } } } })
  const moved = transition(DOA_VERSION_MACHINE, row.status as DoaVersionState, 'doa.approve')
  if (!moved.ok) throw new Error(`doa.approve is not allowed from ${row.status}`)
  const effectiveFrom = row.effectiveFrom.getTime() < ctx.now.getTime() ? ctx.now : row.effectiveFrom
  const events: EventDraft[] = []
  const previous = await tx.doaVersion.findMany({
    where: { code: row.code, status: 'PUBLISHED', id: { not: row.id }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: effectiveFrom } }] },
    select: { id: true, versionNo: true, effectiveTo: true },
  })
  for (const p of previous) {
    // End the previous period first: published periods of one code never overlap (doa_no_overlap)
    const inEffectNow = effectiveFrom.getTime() <= ctx.now.getTime()
    await tx.doaVersion.update({ where: { id: p.id }, data: { effectiveTo: effectiveFrom, ...(inEffectNow ? { status: 'SUPERSEDED' } : {}) } })
    // A version that takes effect later leaves its predecessor PUBLISHED until then: routing already picks versions by
    // their dates (versionAt), and the job doa-version-activate sets the status when the time comes (NEW-13)
    if (inEffectNow) events.push({ type: 'doa_version.superseded', aggregateType: 'DoaVersion', aggregateId: p.id, data: { code: row.code, versionNo: p.versionNo, supersededBy: row.id } })
  }
  await tx.doaVersion.update({ where: { id: row.id }, data: { status: moved.to, effectiveFrom, approvedById: approverMemberId, approvedAt: ctx.now, publishedAt: ctx.now, version: { increment: 1 } } })
  events.push({
    type: 'doa_version.published',
    aggregateType: 'DoaVersion',
    aggregateId: row.id,
    data: { code: row.code, versionNo: row.versionNo, effectiveFrom: effectiveFrom.toISOString(), via: 'APPROVAL', rules: row.rules.length },
  })
  return events
}

// ---------- activation at the effective time (job doa-version-activate, NEW-13) ----------

const ActivateInput = z.strictObject({ versionId: z.uuid() })

/**
 * When a version approved in advance takes effect, the versions of its code that ended then become SUPERSEDED and the
 * organization admins are told (spec §4.6 doa-version-activate, BR-DOA-16). Routing never waits for this: it picks
 * versions by their dates.
 */
export const activateDoaVersionCommand = defineCommand({
  name: 'doa.activate',
  capability: 'admin.doa.submitForPublish',
  input: ActivateInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ superseded: number }>> {
    if (ctx.actor.type !== 'SYSTEM') return { ok: false, error: { code: 'FORBIDDEN', message: 'only the scheduled job activates versions' } }
    const version = await tx.doaVersion.findFirst({ where: { id: input.versionId, status: 'PUBLISHED' }, select: { code: true, versionNo: true, effectiveFrom: true } })
    if (!version) return fail('NOT_FOUND', 'published version not found')
    if (version.effectiveFrom.getTime() > ctx.now.getTime()) return fail('VALIDATION_FAILED', 'not in effect yet', { reason: 'NOT_DUE' })
    // S6-07 (FR-DOA-104 AC2): a withdrawal still asked is cancelled with its route now that the version is in effect
    const events: EventDraft[] = await cancelWithdrawalOnEffect(tx, 'DOA_VERSION', input.versionId)
    const ended = await tx.doaVersion.findMany({ where: { code: version.code, status: 'PUBLISHED', id: { not: input.versionId }, effectiveTo: { lte: ctx.now } }, select: { id: true, versionNo: true } })
    if (ended.length === 0 && events.length === 0) return fail('INVALID_STATE_TRANSITION', 'nothing to supersede', { reason: 'NOTHING_TO_SUPERSEDE' })
    for (const p of ended) {
      const t = transition(DOA_VERSION_MACHINE, 'PUBLISHED', 'doa.supersede')
      await tx.doaVersion.update({ where: { id: p.id }, data: { status: t.ok ? t.to : 'SUPERSEDED', version: { increment: 1 } } })
      events.push({ type: 'doa_version.superseded', aggregateType: 'DoaVersion', aggregateId: p.id, data: { code: version.code, versionNo: p.versionNo, supersededBy: input.versionId } })
    }
    const admins = await tx.roleAssignment.findMany({ where: { role: 'ORG_ADMIN', revokedAt: null, member: { status: 'ACTIVE' } }, select: { memberId: true } })
    return {
      ok: true,
      result: { superseded: ended.length },
      events,
      notifications: [...new Set(admins.map((a) => a.memberId))].map((memberId) => ({
        recipientMemberId: memberId,
        templateKey: 'doa.authority_changed',
        data: { kind: 'DOA_VERSION', versionId: input.versionId, code: version.code, versionNo: version.versionNo },
        urgency: 'IMMEDIATE' as const,
        dedupeKey: `doa.authority_changed:${input.versionId}:${memberId}`,
        subjectType: 'DOA_VERSION',
        subjectId: input.versionId,
      })),
    }
  },
})

/** What the job doa-version-activate runs at the effective time; the version id is the idempotency key. */
export function activateDoaVersion(organizationId: string, versionId: string, now: Date) {
  return runCommand(systemCtx(organizationId, now, 'doa-version-activate'), activateDoaVersionCommand, { versionId }, { idempotencyKey: `doa-version-activate:${versionId}` })
}
