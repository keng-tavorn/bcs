'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { systemClock } from '@/lib/clock'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { ctxFromSession } from '@/server/auth/session'
import { draftWorkflowVersion, dryRunWorkflowVersion, submitWorkflowVersion, updateWorkflowVersion } from '@/server/services/workflow'
import type { ActionFailure } from '@/ui/admin-org/outcome'
import type { DraftWorkflowResult } from '@/ui/admin-workflow/create-draft'
import type { DryRunResult } from '@/ui/admin-workflow/dry-run'
import type { SaveInput } from '@/ui/admin-workflow/model'
import { toWorkflowFailure } from '@/ui/admin-workflow/outcome'
import type { SubmitWorkflowResult } from '@/ui/admin-workflow/submit-panel'
import type { SaveWorkflowResult } from '@/ui/admin-workflow/workbench'
import { getSession } from '../../../_lib/session'

// Browser-facing adapters for /admin/workflows (FR-WF-103 AC1 AC2, S6-06). Each checks the session and the shape of
// what arrives (server actions are public endpoints, BR-AUTH-05); the services check admin.workflow.draft, simulate
// or submitForPublish, every value, the lint of BR-WF-11 and the rules of BR-WF-12, and record the events. The
// idempotencyKey comes from the form (spec §4.3).

const NO_SESSION: ActionFailure = { ok: false, code: 'UNAUTHENTICATED' }
const BAD_KEY: ActionFailure = { ok: false, code: 'VALIDATION_FAILED', field: 'idempotencyKey' }
const BAD_INPUT: ActionFailure = { ok: false, code: 'VALIDATION_FAILED', field: '(input)' }
const submissionKey = z.uuid()
const Id = z.string().max(100)
const DraftShape = z.object({ sourceVersionId: Id.optional(), code: z.string().max(40).optional() })
const Acknowledged = z.array(z.string().max(200)).max(200)
/** The shape only: the service reads every rule, test case and document with its own strict schema */
const SaveShape = z.object({ versionId: Id, version: z.number(), effectiveDate: z.string().max(20), changeReason: z.string().max(REASON_MAX_LENGTH * 2), rules: z.array(z.unknown()).max(200), testCases: z.array(z.unknown()).max(100) })
const DryRunShape = z.object({ versionId: Id, documents: z.array(z.unknown()).min(1).max(20) })

async function currentCtx() {
  return ctxFromSession(await getSession(), 'WEB', systemClock.now())
}

export async function draftWorkflowAction(input: { sourceVersionId?: string; code?: string }, idempotencyKey: string): Promise<DraftWorkflowResult> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  if (!submissionKey.safeParse(idempotencyKey).success) return BAD_KEY
  const shape = DraftShape.safeParse(input)
  if (!shape.success) return BAD_INPUT
  const result = await draftWorkflowVersion(ctx, shape.data, { idempotencyKey })
  if (!result.ok) return toWorkflowFailure(result.error)
  revalidatePath('/admin/workflows', 'layout')
  return { ok: true, versionId: result.data.versionId, code: result.data.code, versionNo: result.data.versionNo }
}

export async function saveWorkflowAction(input: SaveInput, idempotencyKey: string): Promise<SaveWorkflowResult> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  if (!submissionKey.safeParse(idempotencyKey).success) return BAD_KEY
  if (!SaveShape.safeParse(input).success) return BAD_INPUT
  const result = await updateWorkflowVersion(ctx, input as Parameters<typeof updateWorkflowVersion>[1], { idempotencyKey })
  if (!result.ok) return toWorkflowFailure(result.error)
  revalidatePath('/admin/workflows', 'layout')
  return { ok: true, version: result.data.version }
}

export async function dryRunWorkflowAction(input: { versionId: string; documents: readonly unknown[] }, idempotencyKey: string): Promise<DryRunResult> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  if (!submissionKey.safeParse(idempotencyKey).success) return BAD_KEY
  if (!DryRunShape.safeParse(input).success) return BAD_INPUT
  const result = await dryRunWorkflowVersion(ctx, input as Parameters<typeof dryRunWorkflowVersion>[1], { idempotencyKey })
  if (!result.ok) return toWorkflowFailure(result.error)
  revalidatePath('/admin/workflows', 'layout')
  return { ok: true, rows: result.data.rows }
}

export async function submitWorkflowAction(versionId: string, acknowledgedWarnings: readonly string[], idempotencyKey: string): Promise<SubmitWorkflowResult> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  if (!submissionKey.safeParse(idempotencyKey).success) return BAD_KEY
  const id = Id.safeParse(versionId)
  const acknowledged = Acknowledged.safeParse(acknowledgedWarnings)
  if (!id.success || !acknowledged.success) return BAD_INPUT
  const result = await submitWorkflowVersion(ctx, { versionId: id.data, acknowledgedWarnings: acknowledged.data }, { idempotencyKey })
  if (!result.ok) return toWorkflowFailure(result.error)
  revalidatePath('/admin/workflows', 'layout')
  return { ok: true, assigneeMemberId: result.data.assigneeMemberId }
}
