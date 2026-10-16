import { z } from 'zod'
import { conditionFields, lintFormVersion, type FormLintIssue } from '@/core/forms'
import { err, ok, type Result } from '@/core/result'
import { FORM_VERSION_MACHINE, transition, type FormVersionState } from '@/core/state-machines'
import { toJsonSafe } from '@/lib/json'
import { newId } from '@/lib/ids'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import type { NotificationDraft } from '@/server/notifications/create'
import { workflowVersionFromRows } from '@/server/workflow/snapshot'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { FORM_JSON_MAX_CHARS, formChanges, formShape, parseFormJson, sameForm, storedForm, summarizeForm, type FormChangesDto, type FormJson, type FormProblem, type FormSummaryDto } from './form-import'

// The no-code form builder (S6-14 · FR-INT-104 · BR-FORM-09 · OQ-115): ORG_ADMIN (admin.requestTypes) copies the form in
// use into one draft per request type, edits it as a whole (fields added, removed and moved with buttons, conditions and
// attachment rules) — each save checked like an imported form and linted — and publishes it as the type's next version:
// the one before it retires in the same transaction, requests already made keep theirs, and when the attachment rules
// changed every AUDITOR hears of it at once (audit.policy_changed). Every change of state has its event.

type FailCode = 'VALIDATION_FAILED' | 'NOT_FOUND' | 'INVALID_STATE_TRANSITION'
const fail = (code: FailCode, message: string, details?: Record<string, unknown>) => ({ ok: false, error: { code, message, ...(details ? { details } : {}) } }) as const

/** The fields the workflow versions in effect or still to come read for this request type (BR-FORM-09) */
export async function workflowReads(tx: TenantTx, requestTypeCode: string, now: Date): Promise<Array<{ code: string; fields: string[] }>> {
  const versions = await tx.workflowVersion.findMany({
    where: { status: 'PUBLISHED', OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] },
    include: { rules: true },
  })
  return versions.flatMap((v) =>
    workflowVersionFromRows(v, v.rules)
      .rules.filter((r) => r.requestTypeCodes.includes(requestTypeCode))
      .map((r) => ({ code: r.code, fields: conditionFields(r.when as never) })),
  )
}

/** BR-FORM-09 for a form against the version in use of its type */
export async function lintAgainstCurrent(tx: TenantTx, type: { readonly code: string; readonly currentFormVersionId: string | null }, form: FormJson, now: Date): Promise<FormLintIssue[]> {
  const current = type.currentFormVersionId ? await tx.formVersion.findUnique({ where: { id: type.currentFormVersionId }, select: { schema: true } }) : null
  const before = current ? storedForm(current.schema) : null
  return lintFormVersion(before, form, await workflowReads(tx, type.code, now)).errors
}

/** The attachment rules of two forms differ (FR-INT-104 AC3, FR-DOA-011 AC3) */
export const attachmentRulesChanged = (c: FormChangesDto) => c.addedRules.length + c.removedRules.length + c.changedRules.length > 0

/** BR-FORM-09 at a publish: the version in use retires, the AUDITORs hear of new attachment rules */
export async function retireAndTell(
  tx: TenantTx,
  ctx: Ctx,
  type: { readonly id: string; readonly code: string; readonly currentFormVersionId: string | null },
  published: { readonly id: string; readonly versionNo: number },
  rulesChanged: boolean,
): Promise<{ events: EventDraft[]; notifications: NotificationDraft[] }> {
  const events: EventDraft[] = []
  if (type.currentFormVersionId) {
    const current = await tx.formVersion.findUniqueOrThrow({ where: { id: type.currentFormVersionId }, select: { id: true, versionNo: true, status: true } })
    const moved = transition(FORM_VERSION_MACHINE, current.status as FormVersionState, 'formVersion.retire')
    if (moved.ok) {
      await tx.formVersion.update({ where: { id: current.id }, data: { status: moved.to } })
      events.push({ type: 'form_version.retired', aggregateType: 'FormVersion', aggregateId: current.id, data: { requestTypeCode: type.code, versionNo: current.versionNo, byVersionNo: published.versionNo } })
    }
  }
  // New requests get the new version; requests made before keep theirs (Request.formVersionId)
  await tx.requestType.update({ where: { id: type.id }, data: { currentFormVersionId: published.id } })
  const notifications: NotificationDraft[] = []
  if (rulesChanged) {
    const auditors = [...new Set((await tx.roleAssignment.findMany({ where: { role: 'AUDITOR', revokedAt: null, member: { status: 'ACTIVE' } }, select: { memberId: true } })).map((r) => r.memberId))]
    for (const recipientMemberId of auditors) {
      notifications.push({
        recipientMemberId,
        templateKey: 'audit.policy_changed',
        data: { change: 'FORM_ATTACHMENT_RULES', requestTypeCode: type.code, versionNo: published.versionNo },
        urgency: 'IMMEDIATE',
        dedupeKey: `audit.policy_changed:FORM:${published.id}:${recipientMemberId}`,
        subjectType: 'FORM_VERSION',
        subjectId: published.id,
      })
    }
  }
  return { events, notifications }
}

// ---------- the page (/admin/request-types/[code]/form) ----------

export interface FormBuilderDto {
  readonly code: string
  readonly nameTh: string
  readonly current: { readonly versionNo: number; readonly form: FormJson } | null
  readonly draft: {
    readonly id: string
    readonly versionNo: number
    readonly form: FormJson
    readonly summary: FormSummaryDto
    readonly changes: FormChangesDto
    /** Nothing differs from the version in use: there is nothing to publish */
    readonly noChange: boolean
    readonly lint: readonly FormLintIssue[]
  } | null
}

export async function getFormBuilder(ctx: Ctx, code: string): Promise<Result<FormBuilderDto>> {
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const allowed = await authorize(tx, ctx, 'admin.requestTypes')
    if (!allowed.ok) return err(allowed.error.code, allowed.error.message, allowed.error.details)
    const type = await tx.requestType.findFirst({ where: { code }, select: { code: true, nameTh: true, currentFormVersionId: true, currentFormVersion: { select: { versionNo: true, schema: true } } } })
    if (!type) return err('NOT_FOUND', 'request type not found')
    const currentForm = type.currentFormVersion ? storedForm(type.currentFormVersion.schema) : null
    const draftRow = await tx.formVersion.findFirst({ where: { requestType: { code }, status: 'DRAFT' }, select: { id: true, versionNo: true, schema: true } })
    const draftForm = draftRow ? storedForm(draftRow.schema) : null
    return ok({
      code: type.code,
      nameTh: type.nameTh,
      current: type.currentFormVersion && currentForm ? { versionNo: type.currentFormVersion.versionNo, form: currentForm } : null,
      draft:
        draftRow && draftForm
          ? {
              id: draftRow.id,
              versionNo: draftRow.versionNo,
              form: draftForm,
              summary: summarizeForm(draftForm),
              changes: formChanges(currentForm, draftForm),
              noChange: sameForm(currentForm, draftForm),
              lint: await lintAgainstCurrent(tx, type, draftForm, ctx.now),
            }
          : null,
    })
  })
}

// ---------- draft ----------

const DraftInput = z.strictObject({ code: z.string().min(1).max(50) })

export const draftFormVersionCommand = defineCommand({
  name: 'formVersion.draft',
  capability: 'admin.requestTypes',
  input: DraftInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ versionId: string; versionNo: number }>> {
    const allowed = await authorize(tx, ctx, 'admin.requestTypes')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    await lockRowsForUpdate(tx, 'Organization', ctx.organizationId, [ctx.organizationId])
    const type = await tx.requestType.findFirst({ where: { code: input.code }, select: { id: true, code: true, currentFormVersionId: true } })
    if (!type) return fail('NOT_FOUND', 'request type not found')
    // One draft per request type: a draft left is edited on, never a second one beside it
    const existing = await tx.formVersion.findFirst({ where: { requestTypeId: type.id, status: 'DRAFT' }, select: { id: true } })
    if (existing) return fail('VALIDATION_FAILED', 'the request type has a draft already', { reason: 'DRAFT_EXISTS', versionId: existing.id })
    const current = type.currentFormVersionId ? await tx.formVersion.findUnique({ where: { id: type.currentFormVersionId }, select: { versionNo: true, schema: true } }) : null
    const last = await tx.formVersion.aggregate({ where: { requestTypeId: type.id }, _max: { versionNo: true } })
    const versionNo = (last._max.versionNo ?? 0) + 1
    const id = newId()
    await tx.formVersion.create({ data: { id, organizationId: ctx.organizationId, requestTypeId: type.id, versionNo, schema: (current?.schema ?? { fields: [], visibility: [], rules: [] }) as object, status: 'DRAFT' } })
    return {
      ok: true,
      result: { versionId: id, versionNo },
      events: [{ type: 'form_version.drafted', aggregateType: 'FormVersion', aggregateId: id, data: { requestTypeCode: type.code, versionNo, via: 'ADMIN', fromVersionNo: current?.versionNo ?? null } }],
    }
  },
})

export function draftFormVersion(ctx: Ctx, input: z.input<typeof DraftInput>, options: RunOptions) {
  return runCommand(ctx, draftFormVersionCommand, input, options)
}

// ---------- edit the draft ----------

const UpdateInput = z.strictObject({ versionId: z.uuid(), json: z.string().max(FORM_JSON_MAX_CHARS + 1) })

async function lockedDraft(tx: TenantTx, ctx: Ctx, versionId: string) {
  await lockRowsForUpdate(tx, 'Organization', ctx.organizationId, [ctx.organizationId])
  return tx.formVersion.findFirst({ where: { id: versionId }, include: { requestType: { select: { id: true, code: true, currentFormVersionId: true } } } })
}

type Checked = { ok: true; form: FormJson } | { ok: false; error: { code: 'VALIDATION_FAILED'; message: string; details: Record<string, unknown> } }

async function checked(tx: TenantTx, ctx: Ctx, type: { code: string; currentFormVersionId: string | null }, json: string): Promise<Checked> {
  // The lint first: a field removed while a rule still reads it is named with its readers, not as an unknown field
  const shape = formShape(json)
  const lint = shape ? await lintAgainstCurrent(tx, type, shape, ctx.now) : []
  if (lint.length) return { ok: false, error: { code: 'VALIDATION_FAILED', message: 'the form does not pass the lint', details: { reason: 'FORM_LINT_FAILED', errors: lint } } }
  const parsed = parseFormJson(json)
  if (!parsed.ok) return { ok: false, error: { code: 'VALIDATION_FAILED', message: 'the form is not valid', details: { field: 'json', reason: 'FORM_INVALID', problems: parsed.problems as FormProblem[] } } }
  return { ok: true, form: parsed.form }
}

export const updateFormDraftCommand = defineCommand({
  name: 'formVersion.update',
  capability: 'admin.requestTypes',
  input: UpdateInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ versionId: string }>> {
    const allowed = await authorize(tx, ctx, 'admin.requestTypes')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    const row = await lockedDraft(tx, ctx, input.versionId)
    if (!row) return fail('NOT_FOUND', 'form version not found')
    const moved = transition(FORM_VERSION_MACHINE, row.status as FormVersionState, 'formVersion.update')
    if (!moved.ok) return fail('INVALID_STATE_TRANSITION', `formVersion.update is not allowed from ${row.status}`, { from: row.status, command: 'formVersion.update' })
    const form = await checked(tx, ctx, row.requestType, input.json)
    if (!form.ok) return form
    await tx.formVersion.update({ where: { id: row.id }, data: { schema: toJsonSafe(form.form) as object } })
    return {
      ok: true,
      result: { versionId: row.id },
      events: [{ type: 'form_version.updated', aggregateType: 'FormVersion', aggregateId: row.id, data: { requestTypeCode: row.requestType.code, versionNo: row.versionNo, fields: form.form.fields.length, rules: form.form.rules.length } }],
    }
  },
})

export function updateFormDraft(ctx: Ctx, input: z.input<typeof UpdateInput>, options: RunOptions) {
  return runCommand(ctx, updateFormDraftCommand, input, options)
}

// ---------- publish the draft ----------

const PublishInput = z.strictObject({ versionId: z.uuid() })

export const publishFormDraftCommand = defineCommand({
  name: 'formVersion.publish',
  capability: 'admin.requestTypes',
  input: PublishInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ versionId: string; versionNo: number }>> {
    const allowed = await authorize(tx, ctx, 'admin.requestTypes')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    const row = await lockedDraft(tx, ctx, input.versionId)
    if (!row) return fail('NOT_FOUND', 'form version not found')
    const moved = transition(FORM_VERSION_MACHINE, row.status as FormVersionState, 'formVersion.publish')
    if (!moved.ok) return fail('INVALID_STATE_TRANSITION', `formVersion.publish is not allowed from ${row.status}`, { from: row.status, command: 'formVersion.publish' })
    // The form in use may have changed since the draft was saved: check and lint again against it
    const form = await checked(tx, ctx, row.requestType, JSON.stringify(row.schema))
    if (!form.ok) return form
    const current = row.requestType.currentFormVersionId ? await tx.formVersion.findUnique({ where: { id: row.requestType.currentFormVersionId }, select: { schema: true } }) : null
    const currentForm = current ? storedForm(current.schema) : null
    if (sameForm(currentForm, form.form)) return fail('VALIDATION_FAILED', 'the draft is the same as the form in use', { reason: 'NO_CHANGE' })
    const rulesChanged = attachmentRulesChanged(formChanges(currentForm, form.form))
    await tx.formVersion.update({ where: { id: row.id }, data: { status: moved.to, publishedAt: ctx.now, publishedById: ctx.actor.type === 'USER' ? ctx.actor.memberId : null } })
    const after = await retireAndTell(tx, ctx, row.requestType, { id: row.id, versionNo: row.versionNo }, rulesChanged)
    return {
      ok: true,
      result: { versionId: row.id, versionNo: row.versionNo },
      events: [
        { type: 'form_version.published', aggregateType: 'FormVersion', aggregateId: row.id, data: { requestTypeCode: row.requestType.code, versionNo: row.versionNo, via: 'ADMIN', attachmentRulesChanged: rulesChanged } },
        ...after.events,
      ],
      notifications: after.notifications,
    }
  },
})

export function publishFormDraft(ctx: Ctx, input: z.input<typeof PublishInput>, options: RunOptions) {
  return runCommand(ctx, publishFormDraftCommand, input, options)
}
