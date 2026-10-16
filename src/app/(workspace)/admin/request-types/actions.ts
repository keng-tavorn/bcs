'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { checkFormImport, moveRequestType, publishFormVersion, setRequestTypeActive } from '@/server/services/request-types'
import { draftFormVersion, publishFormDraft, updateFormDraft } from '@/server/services/request-types/form-builder'
import type { FormCheckView } from '@/ui/admin-settings/forms'
import { toSettingsFailure, type SettingsFailure, type SettingsOutcome } from '@/ui/admin-settings/outcome'
import { getSession } from '../../../_lib/session'

// Browser-facing adapters for /admin/request-types (FR-ADM-005). Each checks the session; the services check
// admin.requestTypes and every rule (BR-AUTH-05). The check of an import only reads (a POST that changes nothing).

const NO_SESSION: SettingsFailure = { ok: false, code: 'UNAUTHENTICATED' }
const BAD_KEY: SettingsFailure = { ok: false, code: 'VALIDATION_FAILED', field: 'idempotencyKey' }
const submissionKey = z.uuid()

async function currentCtx() {
  return ctxFromSession(await getSession(), 'WEB', systemClock.now())
}

function done(result: { ok: true } | { ok: false; error: { code: string; details?: Readonly<Record<string, unknown>> } }, extra: { versionNo?: number } = {}): SettingsOutcome {
  if (!result.ok) return toSettingsFailure(result.error)
  // The list and every type's page show what changed
  revalidatePath('/admin/request-types', 'layout')
  return { ok: true, ...extra }
}

export async function setRequestTypeActiveAction(code: string, active: boolean, idempotencyKey: string): Promise<SettingsOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  if (!submissionKey.safeParse(idempotencyKey).success) return BAD_KEY
  return done(await setRequestTypeActive(ctx, { code, active }, { idempotencyKey }))
}

export async function moveRequestTypeAction(code: string, direction: 'UP' | 'DOWN', idempotencyKey: string): Promise<SettingsOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  if (!submissionKey.safeParse(idempotencyKey).success) return BAD_KEY
  return done(await moveRequestType(ctx, { code, direction }, { idempotencyKey }))
}

export async function checkFormImportAction(code: string, json: string): Promise<{ ok: true; check: FormCheckView } | SettingsFailure> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  const result = await checkFormImport(ctx, { code, json })
  if (!result.ok) return toSettingsFailure(result.error)
  const r = result.data
  return {
    ok: true,
    check: r.valid
      ? { valid: true, fields: r.summary.fields.length, rules: r.summary.rules.length, changes: r.changes, noChange: r.noChange, basedOnVersionNo: r.basedOnVersionNo, nextVersionNo: r.nextVersionNo }
      : { valid: false, problems: r.problems },
  }
}

export async function publishFormVersionAction(input: { code: string; json: string; basedOnVersionNo: number | null }, idempotencyKey: string): Promise<SettingsOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  if (!submissionKey.safeParse(idempotencyKey).success) return BAD_KEY
  const result = await publishFormVersion(ctx, input, { idempotencyKey })
  return result.ok ? done(result, { versionNo: result.data.versionNo }) : done(result)
}

// ---------- the no-code form builder (S6-14 · FR-INT-104) ----------

/** A draft of the form in use; a draft already there is opened instead (one per request type) */
export async function createFormDraftAction(code: string, idempotencyKey: string): Promise<SettingsOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  if (!submissionKey.safeParse(idempotencyKey).success) return BAD_KEY
  const result = await draftFormVersion(ctx, { code }, { idempotencyKey })
  if (!result.ok && result.error.details?.reason === 'DRAFT_EXISTS') return done({ ok: true })
  return result.ok ? done(result, { versionNo: result.data.versionNo }) : done(result)
}

/** The whole draft form saved; the service checks it as an import and lints it (BR-FORM-09) */
export async function saveFormDraftAction(versionId: string, json: string, idempotencyKey: string): Promise<SettingsOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  if (!submissionKey.safeParse(idempotencyKey).success) return BAD_KEY
  return done(await updateFormDraft(ctx, { versionId, json }, { idempotencyKey }))
}

export async function publishFormDraftAction(versionId: string, idempotencyKey: string): Promise<SettingsOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  if (!submissionKey.safeParse(idempotencyKey).success) return BAD_KEY
  const result = await publishFormDraft(ctx, { versionId }, { idempotencyKey })
  return result.ok ? done(result, { versionNo: result.data.versionNo }) : done(result)
}
