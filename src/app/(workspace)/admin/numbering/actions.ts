'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { previewNumbering } from '@/server/services/numbering/admin'
import { saveNumberingRule } from '@/server/services/numbering/save-rule'
import { toSettingsFailure, type SettingsFailure, type SettingsOutcome } from '@/ui/admin-settings/outcome'
import type { NumberDocument, NumberPreviewView, NumberReset } from '@/ui/admin-settings/numbering'
import { getSession } from '../../../_lib/session'

// Browser-facing adapters for /admin/numbering (FR-ADM-004). The preview reads only (a POST that changes nothing); the
// save goes through organization.save_settings. The services check admin.numbering every time (BR-AUTH-05).

const NO_SESSION: SettingsFailure = { ok: false, code: 'UNAUTHENTICATED' }
const submissionKey = z.uuid()

async function currentCtx() {
  return ctxFromSession(await getSession(), 'WEB', systemClock.now())
}

export async function previewNumberingAction(input: { document: NumberDocument; pattern: string; reset: NumberReset; department?: string }): Promise<{ ok: true; preview: NumberPreviewView } | SettingsFailure> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  const result = await previewNumbering(ctx, input)
  if (!result.ok) return toSettingsFailure(result.error)
  const { nextNumber, continues, department, refusal } = result.data
  return { ok: true, preview: { nextNumber, continues, department, refusal: refusal ? toSettingsFailure({ code: 'VALIDATION_FAILED', details: refusal }).refusal ?? null : null } }
}

export async function saveNumberingAction(input: { document: NumberDocument; pattern: string; reset: NumberReset }, idempotencyKey: string): Promise<SettingsOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  if (!submissionKey.safeParse(idempotencyKey).success) return { ok: false, code: 'VALIDATION_FAILED', field: 'idempotencyKey' }
  const result = await saveNumberingRule(ctx, input, { idempotencyKey })
  if (!result.ok) return toSettingsFailure(result.error)
  revalidatePath('/admin/numbering')
  return { ok: true }
}
