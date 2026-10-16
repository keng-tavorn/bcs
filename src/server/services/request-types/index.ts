import { z } from 'zod'
import { err, ok, type Result } from '@/core/result'
import { toJsonSafe } from '@/lib/json'
import { newId } from '@/lib/ids'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import { listFormVersionRows, listRequestTypeRows, type RequestTypeRowDto } from '@/server/queries/settings'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { attachmentRulesChanged, lintAgainstCurrent, retireAndTell } from './form-builder'
import { FORM_JSON_MAX_CHARS, formChanges, parseFormJson, sameForm, storedForm, summarizeForm, type FormChangesDto, type FormProblem, type FormSummaryDto } from './form-import'

// Request types and their forms (FR-ADM-005, spec §7.9). ORG_ADMIN (admin.requestTypes) switches a type on or off and
// moves it in the catalog (AC2, event request_type.updated), and publishes a new version of its form from JSON (AC1,
// event form_version.published via ADMIN). A request keeps the form version it was created with (§6.2), so publishing
// changes only requests made afterwards (AC3). Changes of one organization's types are serialized on its row.

export { FORM_JSON_MAX_CHARS, type FormChangesDto, type FormProblem, type FormSummaryDto } from './form-import'

export type RequestTypeAdminDto = Omit<RequestTypeRowDto, 'id' | 'currentFormVersionId'>

const toAdminDto = ({ id: _id, currentFormVersionId: _current, ...rest }: RequestTypeRowDto): RequestTypeAdminDto => rest

async function allowRequestTypes(ctx: Ctx): Promise<Result<true>> {
  const allowed = await forTenant(ctx.organizationId).$transaction((tx) => authorize(tx, ctx, 'admin.requestTypes'))
  return allowed.ok ? ok(true) : err(allowed.error.code, allowed.error.message, allowed.error.details)
}

/** The request types page: every type in catalog order (admin.requestTypes). */
export async function listRequestTypesForAdmin(ctx: Ctx): Promise<Result<RequestTypeAdminDto[]>> {
  const allowed = await allowRequestTypes(ctx)
  if (!allowed.ok) return allowed
  return ok((await listRequestTypeRows(ctx)).map(toAdminDto))
}

export interface FormVersionAdminDto {
  readonly versionNo: number
  readonly publishedAt: string | null
  readonly publishedByName: string | null
  readonly requestCount: number
  /** The version new requests get */
  readonly current: boolean
}

export interface RequestTypeDetailDto {
  readonly type: RequestTypeAdminDto
  /** The form new requests use, or null before the first version */
  readonly current: { readonly versionNo: number; readonly summary: FormSummaryDto } | null
  /** Newest first */
  readonly versions: readonly FormVersionAdminDto[]
}

/** One type with its forms for /admin/request-types/[code]; NOT_FOUND for a code the organization does not have. */
export async function getRequestTypeForAdmin(ctx: Ctx, code: string): Promise<Result<RequestTypeDetailDto>> {
  const allowed = await allowRequestTypes(ctx)
  if (!allowed.ok) return allowed
  const row = (await listRequestTypeRows(ctx)).find((t) => t.code === code)
  if (!row) return err('NOT_FOUND', 'request type not found')
  const versions = await listFormVersionRows(ctx, row.id)
  const currentRow = versions.find((v) => v.id === row.currentFormVersionId)
  const currentForm = currentRow ? storedForm(currentRow.schema) : null
  return ok({
    type: toAdminDto(row),
    current: currentRow && currentForm ? { versionNo: currentRow.versionNo, summary: summarizeForm(currentForm) } : null,
    versions: versions.map((v) => ({ versionNo: v.versionNo, publishedAt: v.publishedAt, publishedByName: v.publishedByName, requestCount: v.requestCount, current: v.id === row.currentFormVersionId })),
  })
}

/** The JSON of the form in use, to edit and import again (a download; read-only). */
export async function currentFormJson(ctx: Ctx, code: string): Promise<Result<{ fileName: string; json: string }>> {
  const allowed = await allowRequestTypes(ctx)
  if (!allowed.ok) return allowed
  const row = (await listRequestTypeRows(ctx)).find((t) => t.code === code)
  if (!row || !row.currentFormVersionId) return err('NOT_FOUND', 'the request type has no published form')
  const version = (await listFormVersionRows(ctx, row.id)).find((v) => v.id === row.currentFormVersionId)!
  // The file name goes into a header: only letters, digits, dash and underscore
  return ok({ fileName: `${row.code.replace(/[^A-Za-z0-9_-]/g, '_')}-form-v${version.versionNo}.json`, json: `${JSON.stringify(version.schema, null, 2)}\n` })
}

export type FormImportCheckDto =
  | {
      readonly valid: true
      readonly summary: FormSummaryDto
      readonly changes: FormChangesDto
      /** Same as the form in use: nothing to publish */
      readonly noChange: boolean
      /** The version this import replaces (sent back with the publish so a newer one is not overwritten unseen) */
      readonly basedOnVersionNo: number | null
      readonly nextVersionNo: number
    }
  | { readonly valid: false; readonly problems: readonly FormProblem[] }

const CheckInput = z.strictObject({ code: z.string().min(1).max(50), json: z.string().max(FORM_JSON_MAX_CHARS + 1) })

/** Step 1 of an import: checks the JSON and says what it would change, without saving anything. */
export async function checkFormImport(ctx: Ctx, input: z.input<typeof CheckInput>): Promise<Result<FormImportCheckDto>> {
  const allowed = await allowRequestTypes(ctx)
  if (!allowed.ok) return allowed
  const parsedInput = CheckInput.safeParse(input)
  if (!parsedInput.success) return ok({ valid: false, problems: [{ reason: 'TOO_LARGE' }] })
  const row = (await listRequestTypeRows(ctx)).find((t) => t.code === parsedInput.data.code)
  if (!row) return err('NOT_FOUND', 'request type not found')
  const parsed = parseFormJson(parsedInput.data.json)
  if (!parsed.ok) return ok({ valid: false, problems: parsed.problems })
  const versions = await listFormVersionRows(ctx, row.id)
  const currentRow = versions.find((v) => v.id === row.currentFormVersionId) ?? null
  const current = currentRow ? storedForm(currentRow.schema) : null
  return ok({
    valid: true,
    summary: summarizeForm(parsed.form),
    changes: formChanges(current, parsed.form),
    noChange: sameForm(current, parsed.form),
    basedOnVersionNo: currentRow?.versionNo ?? null,
    nextVersionNo: (versions[0]?.versionNo ?? 0) + 1,
  })
}

const fail = (code: 'VALIDATION_FAILED' | 'NOT_FOUND' | 'CONFLICT_VERSION', message: string, details?: Record<string, unknown>) =>
  ({ ok: false, error: { code, message, ...(details ? { details } : {}) } }) as const

/** The type, locked through its organization's row: request-type changes of one organization run one at a time. */
async function lockedType(tx: TenantTx, ctx: Ctx, code: string) {
  await lockRowsForUpdate(tx, 'Organization', ctx.organizationId, [ctx.organizationId])
  return tx.requestType.findFirst({ where: { code } })
}

const PublishInput = z.strictObject({
  code: z.string().min(1).max(50),
  json: z.string().max(FORM_JSON_MAX_CHARS + 1),
  /** The version the admin checked against; null when the type had no form */
  basedOnVersionNo: z.number().int().positive().nullable(),
})

export const publishFormVersionCommand = defineCommand({
  name: 'form_version.publish',
  capability: 'admin.requestTypes',
  input: PublishInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ versionNo: number }>> {
    const allowed = await authorize(tx, ctx, 'admin.requestTypes')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    const type = await lockedType(tx, ctx, input.code)
    if (!type) return fail('NOT_FOUND', 'request type not found')
    const parsed = parseFormJson(input.json)
    if (!parsed.ok) return fail('VALIDATION_FAILED', 'the form is not valid', { field: 'json', reason: 'FORM_INVALID', problems: parsed.problems })
    const current = type.currentFormVersionId ? await tx.formVersion.findUnique({ where: { id: type.currentFormVersionId } }) : null
    // Someone published since this import was checked: check again against the newer version
    if ((current?.versionNo ?? null) !== input.basedOnVersionNo) {
      return fail('CONFLICT_VERSION', 'a newer form version was published', { currentVersionNo: current?.versionNo ?? null })
    }
    const currentForm = current ? storedForm(current.schema) : null
    if (sameForm(currentForm, parsed.form)) return fail('VALIDATION_FAILED', 'the form is the same as the one in use', { field: 'json', reason: 'NO_CHANGE' })
    // BR-FORM-09 (S6-14): an imported form passes the same lint as one edited in the builder
    const lint = await lintAgainstCurrent(tx, type, parsed.form, ctx.now)
    if (lint.length) return fail('VALIDATION_FAILED', 'the form does not pass the lint', { field: 'json', reason: 'FORM_LINT_FAILED', errors: lint })
    const rulesChanged = attachmentRulesChanged(formChanges(currentForm, parsed.form))
    const last = await tx.formVersion.findFirst({ where: { requestTypeId: type.id }, orderBy: { versionNo: 'desc' }, select: { versionNo: true } })
    const versionNo = (last?.versionNo ?? 0) + 1
    const id = newId()
    await tx.formVersion.create({
      data: {
        id,
        organizationId: ctx.organizationId,
        requestTypeId: type.id,
        versionNo,
        schema: toJsonSafe(parsed.form) as object,
        status: 'PUBLISHED',
        publishedAt: ctx.now,
        publishedById: ctx.actor.type === 'USER' ? ctx.actor.memberId : null,
      },
    })
    // The version in use retires; new requests get the new one and requests made before keep theirs (AC3); new attachment
    // rules are told to every AUDITOR at once (S6-14 · FR-INT-104 AC3 · FR-DOA-011 AC3)
    const after = await retireAndTell(tx, ctx, type, { id, versionNo }, rulesChanged)
    return {
      ok: true,
      result: { versionNo },
      events: [
        { type: 'form_version.published', aggregateType: 'FormVersion', aggregateId: id, data: { requestTypeCode: type.code, versionNo, via: 'ADMIN', attachmentRulesChanged: rulesChanged } },
        ...after.events,
      ],
      notifications: after.notifications,
    }
  },
})

/** Step 2 of an import (FR-ADM-005 AC1): publishes the checked form as the type's next version. */
export function publishFormVersion(ctx: Ctx, input: z.input<typeof PublishInput>, options: RunOptions) {
  return runCommand(ctx, publishFormVersionCommand, input, options)
}

const updated = (t: { id: string; code: string; active: boolean; sortOrder: number }, changed: Array<'active' | 'sortOrder'>): EventDraft => ({
  type: 'request_type.updated',
  aggregateType: 'RequestType',
  aggregateId: t.id,
  data: { code: t.code, changed, active: t.active, sortOrder: t.sortOrder },
})

const ActiveInput = z.strictObject({ code: z.string().min(1).max(50), active: z.boolean() })

export const setRequestTypeActiveCommand = defineCommand({
  name: 'request_type.set_active',
  capability: 'admin.requestTypes',
  input: ActiveInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ code: string; active: boolean }>> {
    const allowed = await authorize(tx, ctx, 'admin.requestTypes')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    const type = await lockedType(tx, ctx, input.code)
    if (!type) return fail('NOT_FOUND', 'request type not found')
    if (type.active === input.active) return fail('VALIDATION_FAILED', 'the type is already so', { field: 'active', reason: 'NO_CHANGE' })
    // A type in the catalog must open a form (createDraft refuses a type without one)
    if (input.active && !type.currentFormVersionId) return fail('VALIDATION_FAILED', 'the type has no published form', { field: 'active', reason: 'NO_PUBLISHED_FORM' })
    await tx.requestType.update({ where: { id: type.id }, data: { active: input.active } })
    return { ok: true, result: { code: type.code, active: input.active }, events: [updated({ ...type, active: input.active }, ['active'])] }
  },
})

/** FR-ADM-005 AC2: switches a type on or off in the catalog; requests already made do not change. */
export function setRequestTypeActive(ctx: Ctx, input: z.input<typeof ActiveInput>, options: RunOptions) {
  return runCommand(ctx, setRequestTypeActiveCommand, input, options)
}

const MoveInput = z.strictObject({ code: z.string().min(1).max(50), direction: z.enum(['UP', 'DOWN']) })

export const moveRequestTypeCommand = defineCommand({
  name: 'request_type.move',
  capability: 'admin.requestTypes',
  input: MoveInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ order: string[] }>> {
    const allowed = await authorize(tx, ctx, 'admin.requestTypes')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    await lockRowsForUpdate(tx, 'Organization', ctx.organizationId, [ctx.organizationId])
    const types = await tx.requestType.findMany({ orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }], select: { id: true, code: true, active: true, sortOrder: true } })
    const from = types.findIndex((t) => t.code === input.code)
    if (from < 0) return fail('NOT_FOUND', 'request type not found')
    const to = input.direction === 'UP' ? from - 1 : from + 1
    if (to < 0 || to >= types.length) return fail('VALIDATION_FAILED', 'the type is already at that end of the catalog', { field: 'direction', reason: 'AT_EDGE' })
    const order = [...types]
    order.splice(to, 0, ...order.splice(from, 1))
    // The catalog order is written as 1..n, so it stays a plain sequence however it was stored before
    const events: EventDraft[] = []
    for (const [i, t] of order.entries()) {
      if (t.sortOrder === i + 1) continue
      await tx.requestType.update({ where: { id: t.id }, data: { sortOrder: i + 1 } })
      events.push(updated({ ...t, sortOrder: i + 1 }, ['sortOrder']))
    }
    return { ok: true, result: { order: order.map((t) => t.code) }, events }
  },
})

/** FR-ADM-005 AC2: moves a type one place up or down in the catalog. */
export function moveRequestType(ctx: Ctx, input: z.input<typeof MoveInput>, options: RunOptions) {
  return runCommand(ctx, moveRequestTypeCommand, input, options)
}
