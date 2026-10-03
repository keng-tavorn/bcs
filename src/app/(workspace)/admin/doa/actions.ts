'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { systemClock } from '@/lib/clock'
import { DOA_YAML_MAX_CHARS, REASON_MAX_LENGTH } from '@/lib/constants'
import { ctxFromSession } from '@/server/auth/session'
import { importDoaDraft, submitDoaVersion } from '@/server/services/doa'
import { draftDoaCopy, type DraftCopyInput } from '@/server/services/doa/editor'
import { submitInitialPackage } from '@/server/services/doa/initial-package'
import { getDoaOverviewForAdmin } from '@/server/services/doa/view'
import type { SaveDoaDraftResult } from '@/ui/admin-doa/editor'
import type { ImportDoaResult } from '@/ui/admin-doa/import-form'
import type { PackageHolder } from '@/ui/admin-doa/initial-package-form'
import type { SubmitDoaResult } from '@/ui/admin-doa/submit-panel'
import { toActionFailure, type ActionFailure } from '@/ui/admin-org/outcome'
import { getSession } from '../../../_lib/session'

// Browser-facing adapters for /admin/doa (FR-DOA-001 AC1–AC2, FR-DOA-002 AC1 and AC3, FR-DOA-009 AC3). Each checks the
// session; the services check admin.doa.draft or admin.doa.submitForPublish, run the full lint and every rule of
// BR-DOA-08/12/19 and record the events (BR-AUTH-05). The idempotencyKey comes from the form (spec §4.3).

const NO_SESSION: ActionFailure = { ok: false, code: 'UNAUTHENTICATED' }
const BAD_KEY: ActionFailure = { ok: false, code: 'VALIDATION_FAILED', field: 'idempotencyKey' }
const BAD_INPUT: ActionFailure = { ok: false, code: 'VALIDATION_FAILED', field: '(input)' }
const submissionKey = z.uuid()
// Server actions are public endpoints (BR-AUTH-05): the shape of what arrives is checked before it is read; the
// services check the values themselves
const Text = z.string().max(REASON_MAX_LENGTH * 2)
const Acknowledged = z.array(z.string().max(200)).max(100)
const Holders = z.array(z.object({ positionCode: Text, departmentId: Text, memberId: Text })).max(500)
/**
 * The drafter's tick of the boundary table the page showed (FR-DOA-009 AC3), or null when the page showed none: the
 * service asks for the tick whenever the version has a table, and refuses the send without it
 */
const BoundaryTick = z.boolean().nullable()

async function currentCtx() {
  return ctxFromSession(await getSession(), 'WEB', systemClock.now())
}

export async function importDoaAction(formData: FormData): Promise<ImportDoaResult> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  const idempotencyKey = String(formData.get('idempotencyKey') ?? '')
  if (!submissionKey.safeParse(idempotencyKey).success) return BAD_KEY
  const file = formData.get('file')
  if (!(file instanceof File) || file.size === 0) return { ok: false, code: 'VALIDATION_FAILED', field: 'file', reason: 'FILE_MISSING' }
  // One limit, the page's: at most DOA_YAML_MAX_CHARS bytes, so never more characters than the import reads
  if (file.size > DOA_YAML_MAX_CHARS) return { ok: false, code: 'VALIDATION_FAILED', field: 'file', reason: 'FILE_TOO_LARGE' }
  const yaml = await file.text()
  const changeReason = String(formData.get('reason') ?? '').trim()
  const result = await importDoaDraft(ctx, { yaml, changeReason }, { idempotencyKey })
  if (!result.ok) return toActionFailure(result.error)
  revalidatePath('/admin/doa', 'layout')
  // Name the new drafts so the form can link to them
  const overview = await getDoaOverviewForAdmin(ctx)
  const versions = overview.ok ? overview.data.versions.filter((v) => result.data.versionIds.includes(v.id)).map((v) => ({ id: v.id, code: v.code, versionNo: v.versionNo })) : []
  return { ok: true, versions }
}

/** The editor's table saved as a new draft (FR-DOA-001 AC1); the service checks every value and runs the lint */
export async function saveDoaDraftAction(input: DraftCopyInput, idempotencyKey: string): Promise<SaveDoaDraftResult> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  if (!submissionKey.safeParse(idempotencyKey).success) return BAD_KEY
  const result = await draftDoaCopy(ctx, input, { idempotencyKey })
  if (!result.ok) return toActionFailure(result.error)
  revalidatePath('/admin/doa', 'layout')
  return { ok: true, versionId: result.data.versionId, code: result.data.code, versionNo: result.data.versionNo }
}

export async function submitDoaAction(versionId: string, acknowledgedWarnings: readonly string[], boundaryTableConfirmed: boolean | null, idempotencyKey: string): Promise<SubmitDoaResult> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  if (!submissionKey.safeParse(idempotencyKey).success) return BAD_KEY
  const id = Text.safeParse(versionId)
  const acknowledged = Acknowledged.safeParse(acknowledgedWarnings)
  const tick = BoundaryTick.safeParse(boundaryTableConfirmed)
  if (!id.success || !acknowledged.success || !tick.success) return BAD_INPUT
  const result = await submitDoaVersion(ctx, { versionId: id.data, acknowledgedWarnings: acknowledged.data, ...(tick.data === null ? {} : { boundaryTableConfirmed: tick.data }) }, { idempotencyKey })
  if (!result.ok) return toActionFailure(result.error)
  revalidatePath('/admin/doa', 'layout')
  return { ok: true, assigneeMemberId: result.data.assigneeMemberId }
}

export async function submitInitialPackageAction(
  versionId: string,
  holders: readonly PackageHolder[],
  reason: string,
  acknowledgedWarnings: readonly string[],
  boundaryTableConfirmed: boolean | null,
  idempotencyKey: string,
): Promise<SubmitDoaResult> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  if (!submissionKey.safeParse(idempotencyKey).success) return BAD_KEY
  const shape = z
    .object({ versionId: Text, holders: Holders, reason: Text, acknowledgedWarnings: Acknowledged, boundaryTableConfirmed: BoundaryTick })
    .safeParse({ versionId, holders, reason, acknowledgedWarnings, boundaryTableConfirmed })
  if (!shape.success) return BAD_INPUT
  const { boundaryTableConfirmed: tick, ...rest } = shape.data
  const result = await submitInitialPackage(ctx, { ...rest, ...(tick === null ? {} : { boundaryTableConfirmed: tick }) }, { idempotencyKey })
  if (!result.ok) return toActionFailure(result.error)
  revalidatePath('/admin/doa', 'layout')
  revalidatePath('/admin/org-authority', 'layout')
  return { ok: true, assigneeMemberId: result.data.assigneeMemberId }
}
